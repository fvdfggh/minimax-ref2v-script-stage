"""四类引擎的适配器。

为什么要适配而不是统一：这四样东西根本不是一回事。
  * ComfyUI 是**别人常驻**的服务，我们只能问它活着没、让它吐模型；
  * audio.cpp 和 s2 是「一个 exe 带一个 gguf」的独立服务，参数各写各的；
  * llama.cpp 是「一个 exe、一个端口、OpenAI 兼容」的标准件。
对上层只暴露 start / stop / health / invoke 四件事，差异全关在这里。
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import HubConfig, ModelSpec, estimate_vram_mb
from .gpu import Gpu, GpuError, visible_devices_env
from .procs import ManagedProc, ProcError, http_status, port_open, port_owner

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

#: 服务器目录，用来复用剧本台现成的 imagegen（工作流 UI→API 转换很啰嗦，
#: 抄一份必然走样）
_SERVER_DIR = Path(__file__).resolve().parent.parent

#: 托管 ComfyUI 的必需参数（这台机器上实测）：
#: T10 没有 CUDA memory pool，ComfyUI 默认开的 cudaMallocAsync 一用就
#: 「operation not supported」，所以必须 --disable-cuda-malloc。
_COMFY_DEFAULT_ARGS = ["--disable-cuda-malloc"]


class DriverError(RuntimeError):
    """调用引擎失败。message 要能直接贴给人看。"""


@dataclass
class Issue:
    level: str  # 'error' | 'warn'
    code: str
    message: str
    hint: str = ""

    def to_dict(self) -> dict[str, str]:
        out = {"level": self.level, "code": self.code, "message": self.message}
        if self.hint:
            out["hint"] = self.hint
        return out


@dataclass
class Loaded:
    """一个已加载模型在运行期的事实。"""

    pid: int = 0
    port: int = 0
    proc: ManagedProc | None = None
    external: bool = False
    meta: dict[str, Any] = field(default_factory=dict)
    #: 加载后实测显存（MiB），用于校准估算
    real_vram_mb: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "pid": self.pid,
            "port": self.port,
            "external": self.external,
            "meta": self.meta,
            "realVramMb": self.real_vram_mb,
        }


@dataclass
class InvokeResult:
    kind: str  # 'json' | 'image' | 'audio'
    data: Any
    mime: str = ""
    meta: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------- HTTP 小工具


def _norm(base: str) -> str:
    return (base or "").rstrip("/")


def _post_json(url: str, payload: dict[str, Any], timeout: float = 120.0) -> tuple[bytes, str]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            return resp.read(), resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read()[:600].decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            pass
        raise DriverError(f"{url} 返回 HTTP {exc.code}：{detail or '（无内容）'}") from exc
    except (urllib.error.URLError, OSError) as exc:
        raise DriverError(f"连不上 {url}：{exc}") from exc


def _get_json(url: str, timeout: float = 8.0) -> dict[str, Any]:
    try:
        with _OPENER.open(url, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        raise DriverError(f"{url} 返回 HTTP {exc.code}") from exc
    except (urllib.error.URLError, OSError) as exc:
        raise DriverError(f"连不上 {url}：{exc}") from exc
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except json.JSONDecodeError as exc:
        raise DriverError(f"{url} 返回的不是 JSON") from exc


def _multipart(fields: dict[str, str]) -> tuple[bytes, str]:
    boundary = "----modelhub" + base64.b16encode(os.urandom(8)).decode().lower()
    chunks: list[bytes] = []
    for key, value in fields.items():
        chunks.append(
            (
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n"
                f"{value}\r\n"
            ).encode("utf-8")
        )
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _gguf_ok(path: str | None) -> tuple[bool, str]:
    """看一眼文件头。14G 的文件也只读 4 字节，但能挡住「下到一半的模型」。"""
    if not path:
        return False, "没配模型文件"
    p = Path(path)
    if not p.is_file():
        return False, f"文件不存在：{path}"
    try:
        with open(p, "rb") as fh:
            head = fh.read(4)
    except OSError as exc:
        return False, f"读不了：{exc}"
    if head != b"GGUF":
        return False, f"不是 GGUF（文件头是 {head!r}）—— 可能下坏了或是别的格式"
    return True, ""


def _pick_workflow(entries: list[dict[str, Any]], kind: str) -> tuple[str, str]:
    """从 ComfyUI 工作流里挑一个能用的。

    返回 (名字, 说明)。挑不到就返回空名 —— 让 preflight 报错时能说清
    「目录里有 N 个，但都不带参考图输入」这种话。

    排序有讲究：
      * API 格式优先 —— UI 格式每次都要现转一遍，慢且更容易踩到动态节点；
      * 生图优先「不要求参考图」的（纯文生图），权重相等的才看名字；
      * 编辑优先参考图槽位多的。
    """
    usable = [e for e in entries if e.get("format") in ("api", "ui") and not e.get("error")]
    if kind == "edit":
        cands = [e for e in usable if e.get("edit") and e.get("refs")]
        key = lambda e: (0 if e.get("format") == "api" else 1, -int(e.get("refs") or 0), str(e.get("name") or ""))
    else:
        cands = [e for e in usable if e.get("t2i")]
        key = lambda e: (
            0 if e.get("format") == "api" else 1,
            1 if e.get("edit") else 0,
            int(e.get("refs") or 0),
            str(e.get("name") or ""),
        )
    if not cands:
        return "", ""
    cands.sort(key=key)
    first = cands[0]
    return str(first.get("name") or ""), f"自动选中（{len(cands)} 个候选）"


# ---------------------------------------------------------------- 基类


class Driver:
    name = ""
    #: 是否由本服务拉起进程。False = 外部常驻（ComfyUI）
    manages_process = True
    #: 是否需要吃显存（参与单卡账本）
    uses_gpu = True

    def check(self, spec: ModelSpec, cfg: HubConfig, gpu: Gpu) -> list[Issue]:
        return []

    def start(self, spec: ModelSpec, cfg: HubConfig, gpu: Gpu) -> Loaded:
        raise NotImplementedError

    def stop(self, spec: ModelSpec, loaded: Loaded, cfg: HubConfig, gpu: Gpu) -> None:
        if loaded.proc:
            loaded.proc.stop()

    def health(self, spec: ModelSpec, loaded: Loaded, cfg: HubConfig) -> tuple[bool, str]:
        if not loaded.port:
            return True, ""
        st = http_status(f"http://127.0.0.1:{loaded.port}{spec.health}", timeout=3.0)
        if st == 200:
            return True, f"HTTP 200"
        if st is None:
            return False, "端口不通"
        return False, f"HTTP {st}"

    def invoke(
        self, spec: ModelSpec, loaded: Loaded, payload: dict[str, Any], cfg: HubConfig
    ) -> InvokeResult:
        raise NotImplementedError

    # ------------------------------------------------------------ 共用

    def _env(self, spec: ModelSpec, cfg: HubConfig, *, allow_cvd: bool = True) -> dict[str, str]:
        env = os.environ.copy()
        env.update(spec.env)
        if allow_cvd and cfg.gpu.pin_env:
            env.update(visible_devices_env(cfg.gpu.index))
        return env

    def _log_path(self, spec: ModelSpec, cfg: HubConfig) -> Path:
        return Path(cfg.runtime_dir) / "logs" / f"{spec.id}.log"

    def _port_busy(self, spec: ModelSpec) -> Issue | None:
        if spec.port <= 0:
            return None
        if not port_open(spec.port):
            return None
        owner = port_owner(spec.port)
        return Issue(
            "error",
            "port.busy",
            f"端口 {spec.port} 已被占用"
            + (f"（pid {owner}）" if owner else "")
            + f"，{spec.title} 起不来",
            "换一个端口：配置里改这个模型的 port；或先停掉占端口的进程",
        )


# ---------------------------------------------------------------- llama.cpp


class LlamaDriver(Driver):
    name = "llama"
    manages_process = True

    def check(self, spec: ModelSpec, cfg: HubConfig, gpu: Gpu) -> list[Issue]:
        issues: list[Issue] = []
        if not spec.exe or not Path(spec.exe).is_file():
            issues.append(
                Issue("error", "exe.missing", f"找不到 llama-server：{spec.exe or '（没配）'}",
                      "在配置里把 models[].exe 指到 llama-server.exe")
            )
        ok, why = _gguf_ok(spec.model)
        if not ok:
            issues.append(Issue("error", "model.missing", f"文本模型不可用：{why}",
                                "gguf 放在 Desktop/gguf 下，或配置 models[].model"))
        if not gpu.available:
            issues.append(Issue("warn", "gpu.none", "没有 nvidia-smi，llama.cpp 会用 CPU 跑（很慢）"))
        # 端口是私有的，但被别的进程占了就是起不来
        busy = self._port_busy(spec)
        if busy:
            issues.append(busy)
        return issues

    def start(self, spec: ModelSpec, cfg: HubConfig, gpu: Gpu) -> Loaded:
        assert spec.exe and spec.model
        ctx = int(spec.extra.get("ctx") or 16384)
        cmd = [
            spec.exe,
            "-m",
            spec.model,
            "--host",
            "127.0.0.1",
            "--port",
            str(spec.port),
            "-c",
            str(ctx),
            "--alias",
            spec.id,
            *spec.args,
        ]
        proc = ManagedProc(
            f"llama:{spec.id}",
            cmd,
            cwd=str(Path(spec.exe).parent),
            env=self._env(spec, cfg),
            log_path=self._log_path(spec, cfg),
            port=spec.port,
            health="/health",
        )
        proc.start()
        proc.wait_ready(spec.startup_timeout)
        return Loaded(pid=proc.pid, port=spec.port, proc=proc, meta={"ctx": ctx, "cmd": cmd[1:]})

    def health(self, spec: ModelSpec, loaded: Loaded, cfg: HubConfig) -> tuple[bool, str]:
        st = http_status(f"http://127.0.0.1:{loaded.port}/health", timeout=3.0)
        if st == 200:
            return True, "HTTP 200"
        if st == 503:
            return False, "正在加载模型（503）"
        return False, f"HTTP {st}" if st else "端口不通"

    def invoke(
        self, spec: ModelSpec, loaded: Loaded, payload: dict[str, Any], cfg: HubConfig
    ) -> InvokeResult:
        if payload.get("stream"):
            raise DriverError("这里不支持流式：单卡上流式会把一个模型长时间钉在卡上，"
                              "需要流式请直连 llama-server 的端口")
        base = f"http://127.0.0.1:{loaded.port}"
        messages = payload.get("messages")
        timeout = float(payload.get("timeoutSec") or 300.0)
        if messages:
            body = {
                "model": spec.id,
                "messages": messages,
                # 默认给足：剧本台要的是一次吐完整份 JSON（十来个片段／六段式字段），
                # 1024 那种小上限会把 JSON 拦腰截断，前端只会看到「无法解析为 JSON」
                "max_tokens": int(payload.get("max_tokens") or payload.get("maxTokens") or 8192),
                "temperature": float(payload.get("temperature", 0.7)),
                "top_p": float(payload.get("top_p", 0.95)),
                "stream": False,
            }
            for key in ("stop", "seed", "response_format", "presence_penalty", "frequency_penalty"):
                if payload.get(key) is not None:
                    body[key] = payload[key]
            raw, _ct = _post_json(f"{base}/v1/chat/completions", body, timeout)
        else:
            prompt = str(payload.get("prompt") or "").strip()
            if not prompt:
                raise DriverError("text.generate 需要 messages 或 prompt")
            body = {
                "model": spec.id,
                "prompt": prompt,
                "max_tokens": int(payload.get("max_tokens") or 512),
                "temperature": float(payload.get("temperature", 0.7)),
                "stream": False,
            }
            if payload.get("stop") is not None:
                body["stop"] = payload["stop"]
            raw, _ct = _post_json(f"{base}/v1/completions", body, timeout)
        try:
            data = json.loads(raw.decode("utf-8", "replace"))
        except json.JSONDecodeError as exc:
            raise DriverError("llama-server 返回的不是 JSON") from exc
        return InvokeResult("json", data, "application/json")


# ---------------------------------------------------------------- audio.cpp


class AudiocppDriver(Driver):
    name = "audiocpp"

    def check(self, spec: ModelSpec, cfg: HubConfig, gpu: Gpu) -> list[Issue]:
        issues: list[Issue] = []
        if not spec.exe or not Path(spec.exe).is_file():
            issues.append(
                Issue("error", "exe.missing", f"找不到 audiocpp_server：{spec.exe or '（没配）'}",
                      "走 ASCII 入口 C:/a-tts/audio-cuda13.3/audiocpp_server.exe")
            )
        ok, why = _gguf_ok(spec.model)
        if not ok:
            issues.append(Issue("error", "model.missing", f"设计音色模型不可用：{why}",
                                "qwen3-tts voicedesign 的 gguf 放在 C:/a-tts/models"))
        if not gpu.available:
            issues.append(Issue("error", "gpu.none", "语音设计要 CUDA，找不到 nvidia-smi"))
        busy = self._port_busy(spec)
        if busy:
            issues.append(busy)
        return issues

    def start(self, spec: ModelSpec, cfg: HubConfig, gpu: Gpu) -> Loaded:
        assert spec.exe and spec.model
        runtime = Path(cfg.runtime_dir)
        runtime.mkdir(parents=True, exist_ok=True)
        conf_path = runtime / f"{spec.id}.server.json"
        conf = {
            "host": "127.0.0.1",
            "port": spec.port,
            "backend": "cuda",
            # audio.cpp 的 device 是绝对卡号（和它自带的 server_qwen3.json 一致），
            # 所以这个进程**不能**再注入 CUDA_VISIBLE_DEVICES，否则编号会越界
            "device": gpu.index,
            "threads": int(spec.extra.get("threads") or 1),
            # 默认在启动时就加载：lazy 模式下进程起来了却不占显存，
            # 「加载完成」和「真的占了卡」变成两件事，单卡账本会对不上
            "lazy_load": bool(spec.extra.get("lazyLoad", False)),
            "max_loaded_models": 1,
            "min_free_memory_mb": int(spec.extra.get("minFreeMemoryMb") or 512),
            "models": [
                {
                    "id": str(spec.extra.get("modelId") or spec.id),
                    "family": str(spec.extra.get("family") or "qwen3_tts"),
                    "path": spec.model,
                    "task": str(spec.extra.get("task") or "vdes"),
                    "mode": "offline",
                }
            ],
        }
        conf_path.write_text(json.dumps(conf, ensure_ascii=False, indent=2), encoding="utf-8")
        cmd = [
            spec.exe,
            "--config",
            str(conf_path),
            "--no-ui",
            "--log",
            "--host",
            "127.0.0.1",
            "--port",
            str(spec.port),
            "--backend",
            "cuda",
            "--device",
            str(gpu.index),
            *spec.args,
        ]
        proc = ManagedProc(
            f"audiocpp:{spec.id}",
            cmd,
            cwd=str(Path(spec.exe).parent),
            env=self._env(spec, cfg, allow_cvd=False),
            log_path=self._log_path(spec, cfg),
            port=spec.port,
            health="/health",
        )
        proc.start()
        proc.wait_ready(spec.startup_timeout)
        return Loaded(
            pid=proc.pid,
            port=spec.port,
            proc=proc,
            meta={"config": str(conf_path), "modelId": conf["models"][0]["id"], "cmd": cmd[1:]},
        )

    def invoke(
        self, spec: ModelSpec, loaded: Loaded, payload: dict[str, Any], cfg: HubConfig
    ) -> InvokeResult:
        text = str(payload.get("text") or payload.get("input") or "").strip()
        desc = str(payload.get("instruction") or payload.get("desc") or "").strip()
        if not text:
            raise DriverError("voice.design 需要 text（要念的那句话）")
        if not desc:
            raise DriverError("voice.design 需要 instruction（音色描述：性别、年龄、语气、质感）")
        body = {
            "model": str(loaded.meta.get("modelId") or spec.id),
            "input": text,
            "instruction": desc,
            "seed": int(payload.get("seed") or 0),
        }
        if payload.get("response_format"):
            body["response_format"] = str(payload["response_format"])
        raw, ctype = _post_json(
            f"http://127.0.0.1:{loaded.port}/v1/audio/speech",
            body,
            float(payload.get("timeoutSec") or 180.0),
        )
        if len(raw) < 1024:
            raise DriverError(f"设计服务返回的内容不像音频（{len(raw)} 字节）")
        return InvokeResult(
            "audio",
            raw,
            ctype or "audio/wav",
            {"seed": body["seed"], "bytes": len(raw)},
        )


# ---------------------------------------------------------------- s2.cpp


class S2Driver(Driver):
    name = "s2"

    def check(self, spec: ModelSpec, cfg: HubConfig, gpu: Gpu) -> list[Issue]:
        issues: list[Issue] = []
        if not spec.exe or not Path(spec.exe).is_file():
            issues.append(
                Issue("error", "exe.missing", f"找不到 s2.exe：{spec.exe or '（没配）'}",
                      "走 ASCII 入口 C:/s2/app/s2.exe（中文路径它打不开）")
            )
        ok, why = _gguf_ok(spec.model)
        if not ok:
            issues.append(Issue("error", "model.missing", f"合成模型不可用：{why}"))
        tok = spec.extra.get("tokenizer")
        if not tok or not Path(str(tok)).is_file():
            issues.append(
                Issue("error", "tokenizer.missing", f"缺 tokenizer.json：{tok or '（没配）'}",
                      "s2-pro 必须带 tokenizer.json，路径在 C:/s2/app")
            )
        if not gpu.available:
            issues.append(Issue("warn", "gpu.none", "没有 nvidia-smi，s2 会退回 CPU（RTF 会很难看）"))
        busy = self._port_busy(spec)
        if busy:
            issues.append(busy)
        return issues

    def start(self, spec: ModelSpec, cfg: HubConfig, gpu: Gpu) -> Loaded:
        assert spec.exe and spec.model
        tok = str(spec.extra.get("tokenizer") or "")
        cmd = [
            spec.exe,
            "-m",
            spec.model,
            "-t",
            tok,
            # s2 的 -c 是绝对 CUDA 卡号，不是 ctx-size；它也不认 CUDA_VISIBLE_DEVICES
            "-c",
            str(gpu.index),
            # 少了这条每次启动都要跑一遍 codec 基准，30s 起步
            "--codec-follow-backend",
            "--server",
            "--host",
            "127.0.0.1",
            "--port",
            str(spec.port),
            *spec.args,
        ]
        proc = ManagedProc(
            f"s2:{spec.id}",
            cmd,
            cwd=str(Path(spec.exe).parent),
            env=self._env(spec, cfg, allow_cvd=False),
            log_path=self._log_path(spec, cfg),
            port=spec.port,
            health="/",
        )
        proc.start()
        proc.wait_ready(spec.startup_timeout)
        return Loaded(pid=proc.pid, port=spec.port, proc=proc, meta={"cmd": cmd[1:]})

    def health(self, spec: ModelSpec, loaded: Loaded, cfg: HubConfig) -> tuple[bool, str]:
        # s2 对 / 和 /health 都回 404，端口通就是活
        if port_open(loaded.port):
            return True, "端口通"
        return False, "端口不通"

    def invoke(
        self, spec: ModelSpec, loaded: Loaded, payload: dict[str, Any], cfg: HubConfig
    ) -> InvokeResult:
        text = str(payload.get("text") or "").strip()
        voice = str(payload.get("voice") or payload.get("voiceId") or "").strip()
        if not text:
            raise DriverError("voice.synthesize 需要 text")
        if not voice:
            raise DriverError(
                "voice.synthesize 需要 voice（已固定的音色包 id）；不会悄悄用默认音色"
            )
        voice_dir = str(payload.get("voiceDir") or spec.extra.get("voiceDir") or "")
        if not voice_dir:
            raise DriverError("没配音色目录（voiceDir）")
        pack = Path(voice_dir) / f"{voice}.s2voice"
        if not pack.is_file():
            raise DriverError(
                f"音色包 {pack} 不在；可能还没固定，或名字写错"
            )
        body, ctype = _multipart(
            {
                "text": text,
                "voice": voice,
                "voice_dir": voice_dir.replace("\\", "/"),
                "params": json.dumps({"output_format": "wav"}),
            }
        )
        req = urllib.request.Request(
            f"http://127.0.0.1:{loaded.port}/generate",
            data=body,
            headers={"Content-Type": ctype},
            method="POST",
        )
        try:
            with _OPENER.open(req, timeout=float(payload.get("timeoutSec") or 300.0)) as resp:
                raw = resp.read()
                ctype_out = resp.headers.get("Content-Type", "audio/wav")
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read()[:400].decode("utf-8", "replace")
            except Exception:  # noqa: BLE001
                pass
            raise DriverError(f"s2 合成失败 HTTP {exc.code}：{detail or '（无内容）'}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise DriverError(f"连不上 s2 合成服务：{exc}") from exc
        if len(raw) < 1024:
            raise DriverError(f"s2 返回的内容不像音频（{len(raw)} 字节）")
        return InvokeResult("audio", raw, ctype_out, {"voice": voice, "bytes": len(raw)})


# ---------------------------------------------------------------- ComfyUI


class ComfyDriver(Driver):
    """生图 / 图片编辑。

    两种形态，按配置里有没有 `extra.python` + `extra.main` 决定：

    * **托管**（默认，本机就有 python_embeded）：轮到生图时由本服务把 ComfyUI
      拉起到这张卡上（`CUDA_VISIBLE_DEVICES` 钉住 + 私有端口），切到别的模型
      就整进程停掉 —— 这才是「用到谁就把谁搬到卡上」。
    * **借用**（外部常驻，比如用户自己在 8188 跑的那份）：只认它活着没，
      并让它 `/free` 吐显存。这种情况它不在本卡上就不会和本卡的模型互斥。

    为什么不去改 ComfyUI 的模型选择：模型写在每份工作流里（UNETLoader /
    CLIPLoader 的 widget），换模型等于换工作流，外面伸手只会两边打架。
    """

    name = "comfy"
    manages_process = True
    uses_gpu = True
    #: 外借形态下"卸载"= 让它把模型吐出来，不是重启它
    release_endpoint = "/free"

    def _base(self, spec: ModelSpec) -> str:
        return _norm(str(spec.extra.get("base") or "http://127.0.0.1:8188"))

    def _root(self, spec: ModelSpec) -> str:
        return str(spec.extra.get("root") or "")

    def _managed(self, spec: ModelSpec) -> bool:
        return bool(
            spec.extra.get("managed")
            and spec.extra.get("python")
            and spec.extra.get("main")
            and Path(str(spec.extra["python"])).is_file()
            and Path(str(spec.extra["main"])).is_file()
        )

    def _port(self, spec: ModelSpec) -> int:
        return int(spec.extra.get("port") or 17804)

    def _launch(self, spec: ModelSpec, cfg: HubConfig) -> ManagedProc:
        py = str(spec.extra["python"])
        main = str(spec.extra["main"])
        port = self._port(spec)
        work = Path(cfg.runtime_dir) / "comfy"
        cmd = [
            py,
            main,
            "--port",
            str(port),
            "--listen",
            "127.0.0.1",
            "--disable-auto-launch",
            # 输出/临时目录挪到运行目录：和用户自己那份实例互不干扰
            "--output-directory",
            str(work / "output"),
            "--temp-directory",
            str(work / "temp"),
            # T10 没有 CUDA memory pool，cudaMallocAsync 会直接
            # 「operation not supported」；这条是这台机器的必需项
            *[str(a) for a in (spec.extra.get("args") or _COMFY_DEFAULT_ARGS)],
        ]
        env = self._env(spec, cfg)
        env.update({str(k): str(v) for k, v in (spec.extra.get("env") or {}).items()})
        proc = ManagedProc(
            f"comfy:{spec.id}",
            cmd,
            cwd=str(Path(main).parent),
            env=env,
            log_path=self._log_path(spec, cfg),
            port=port,
            health="/system_stats",
        )
        proc.start()
        proc.wait_ready(spec.startup_timeout)
        return proc

    def check(self, spec: ModelSpec, cfg: HubConfig, gpu: Gpu) -> list[Issue]:
        issues: list[Issue] = []
        base = self._base(spec)
        managed = self._managed(spec)
        st = http_status(f"{base}/system_stats", timeout=3.0)
        if st != 200:
            if managed:
                # 托管形态：没在跑是正常的，加载时会拉起来；只要解释器和入口在
                issues.append(
                    Issue(
                        "info",
                        "comfy.cold",
                        f"ComfyUI 现在没起，轮到生图时会自动拉到 {base}（约 1 分钟）",
                    )
                )
            else:
                issues.append(
                    Issue(
                        "error",
                        "comfy.down",
                        f"ComfyUI 不在 {base}（HTTP {st}）",
                        "要么让它常驻，要么在配置里给出 extra.python/extra.main 交给本服务托管",
                    )
                )
                return issues
        elif managed:
            owner = port_owner(self._port(spec))
            issues.append(
                Issue(
                    "info",
                    "comfy.warm",
                    f"ComfyUI 已在 {base} 上跑着（pid {owner or '?'}），直接复用",
                )
            )
        root = self._root(spec)
        if not root or not Path(root).is_dir():
            issues.append(
                Issue("error", "comfy.root", f"ComfyUI 目录不对：{root or '（没配）'}",
                      "配置 models[].extra.root 指向 ComfyUI 目录（含 user/default/workflows）")
            )
            return issues
        wf = str(spec.extra.get("workflow") or "")
        kind = str(spec.extra.get("kind") or ("edit" if spec.capability == "image.edit" else "t2i"))
        if wf:
            path = Path(root) / "user" / "default" / "workflows" / f"{wf}.json"
            if not path.is_file():
                issues.append(
                    Issue("error", "comfy.workflow", f"工作流不存在：{wf}",
                          f"去 {path.parent} 里看有哪些")
                )
        else:
            # 没指定就算自动挑；挑不到是硬错
            try:
                import imagegen  # noqa: PLC0415

                listing = imagegen.list_workflows(root)
                picked, why = _pick_workflow(listing.get("workflows") or [], kind)
                if not picked:
                    issues.append(
                        Issue(
                            "error",
                            "comfy.no_workflow",
                            f"ComfyUI 工作流目录里没有{'带参考图输入' if kind == 'edit' else '能出图'}的工作流",
                            f"目录：{listing.get('dir')}",
                        )
                    )
            except Exception as exc:  # noqa: BLE001
                issues.append(
                    Issue("warn", "comfy.list_failed", f"列工作流失败：{exc}",
                          "启动时会再试一次；也可以直接在工作流名字里写死 extra.workflow")
                )
        # 单卡策略的边界要说明白：借来的 ComfyUI 不在本卡上就不参与互斥
        if not managed:
            try:
                stats = gpu.stats()
                mine = gpu.procs_on_mine(stats) if stats else []
                comfy_pid = _find_comfy_pid(base)
                if stats and comfy_pid and not any(p.pid == comfy_pid for p in mine):
                    issues.append(
                        Issue(
                            "warn",
                            "comfy.other_card",
                            f"外借的 ComfyUI（pid {comfy_pid}）不在 {gpu.index} 号卡上，"
                            "生图期间不会和本卡的模型互斥 —— 也就谈不上「搬到这张卡」",
                            "删掉配置里的 extra.managed=false，让它由本服务托管，就会钉在本卡",
                        )
                    )
            except GpuError:
                pass
        return issues

    def start(self, spec: ModelSpec, cfg: HubConfig, gpu: Gpu) -> Loaded:
        base = self._base(spec)
        st = http_status(f"{base}/system_stats", timeout=3.0)
        proc: ManagedProc | None = None
        if st != 200:
            if not self._managed(spec):
                raise DriverError(
                    f"ComfyUI 不可达（{base}，HTTP {st}）。它是外部服务，"
                    "本服务没拿到 python/main 路径，不能替你启动它"
                )
            port = self._port(spec)
            if port_open(port):
                owner = port_owner(port)
                raise DriverError(
                    f"端口 {port} 已被 pid {owner or '?'} 占着，但 ComfyUI 没应答 —— 先把它清掉"
                )
            proc = self._launch(spec, cfg)
        port_used = self._port(spec) if (proc or self._managed(spec)) else 0
        pid = proc.pid if proc else (_find_comfy_pid(base) or 0)
        meta: dict[str, Any] = {
            "base": base,
            "root": self._root(spec),
            "workflow": "",
            "managed": bool(proc),
        }
        kind = str(spec.extra.get("kind") or ("edit" if spec.capability == "image.edit" else "t2i"))
        wf = str(spec.extra.get("workflow") or "")
        if not wf:
            try:
                import imagegen  # noqa: PLC0415

                listing = imagegen.list_workflows(self._root(spec))
                wf, why = _pick_workflow(listing.get("workflows") or [], kind)
                if wf:
                    meta["workflowPicked"] = why
            except Exception:  # noqa: BLE001
                wf = ""
        if not wf:
            if proc:
                proc.stop()
            raise DriverError(
                f"没有可用的{'图片编辑' if kind == 'edit' else '生图'}工作流，"
                "在配置里指定 extra.workflow（工作流名，不带 .json）"
            )
        meta["workflow"] = wf
        # 记一下这张卡上 ComfyUI 的占用，给出「要腾多少」的依据
        try:
            meta["vramMb"] = gpu.mb_of_pid(pid) if pid else 0
        except GpuError:
            meta["vramMb"] = 0
        return Loaded(
            pid=pid,
            port=port_used,
            proc=proc,
            external=proc is None,
            meta=meta,
            real_vram_mb=int(meta["vramMb"]),
        )

    def stop(self, spec: ModelSpec, loaded: Loaded, cfg: HubConfig, gpu: Gpu) -> None:
        """托管形态直接把进程停掉（卡真的空出来）；外借形态只能让它吐模型。"""
        if loaded.proc:
            loaded.proc.stop()
            return
        if not spec.extra.get("freeOnRelease", True):
            return
        try:
            _post_json(
                f"{self._base(spec)}/free",
                {"unload_models": True, "free_memory": True},
                timeout=20.0,
            )
        except DriverError:
            # 释放失败不算致命：显存等不到就当「装不下」报给调用方
            pass

    def health(self, spec: ModelSpec, loaded: Loaded, cfg: HubConfig) -> tuple[bool, str]:
        st = http_status(f"{self._base(spec)}/system_stats", timeout=3.0)
        return (st == 200), (f"HTTP {st}" if st else "连不上")

    def invoke(
        self, spec: ModelSpec, loaded: Loaded, payload: dict[str, Any], cfg: HubConfig
    ) -> InvokeResult:
        sys.path.insert(0, str(_SERVER_DIR))
        try:
            import imagegen  # noqa: PLC0415
        except ImportError as exc:
            raise DriverError(
                "找不到 imagegen 模块：它和本服务在同一台的 server/ 目录下，"
                "单独拷走 modelhub 时要把 imagegen.py 一起带上"
            ) from exc

        root = self._root(spec)
        base = self._base(spec)
        workflow = str(payload.get("workflow") or loaded.meta.get("workflow") or "")
        if not workflow:
            raise DriverError("没有工作流：payload.workflow 和配置 extra.workflow 都是空的")

        # ---------------- 批量：一次提交、共用一套加载器 ----------------
        # 一张一张调用是最坏的做法：文本编码器 8.9G + UNet 7.2G 在 16G 卡上
        # 装不下两套，每换一张图 ComfyUI 就要把两者互相挤下去再装回来，
        # 单张的采样只要 21 秒，装/卸却要 70 秒。
        # 所以 items 一进来就走 imagegen 的批量图：N 条支路共用同一对加载器。
        items_in = payload.get("items")
        if isinstance(items_in, list) and items_in:
            batch_items: list[dict[str, Any]] = []
            for idx, item in enumerate(items_in):
                if not isinstance(item, dict):
                    raise DriverError(f"第 {idx + 1} 条格式不对")
                one_refs = [str(x) for x in (item.get("refs") or [])]
                one_images = item.get("images") or []
                if one_images:
                    if not isinstance(one_images, list):
                        raise DriverError(f"第 {idx + 1} 条的 images 必须是数组")
                    for j, im in enumerate(one_images):
                        raw = _decode_image(im)
                        one_refs.append(
                            imagegen.upload_image(
                                base,
                                name=f"hub-{spec.id}-{idx}-{j}-{int(time.time())}.png",
                                data=raw,
                            )
                        )
                        # ★ 传完就把这条 base64 从 payload 里摘掉。
                        #   这个请求接着还要在 ComfyUI 里跑几分钟到十几分钟，
                        #   而 payload 被 `_run` 的栈帧攥着 —— 一张 24 MiB 的参考图
                        #   base64 之后是 32 MiB 字符串，一直挂着纯属白占。
                        one_images[j] = None
                batch_items.append(
                    {
                        "key": str(item.get("key") if item.get("key") is not None else idx),
                        "prompt": str(item.get("prompt") or ""),
                        "seed": _opt_int(item.get("seed")),
                        "refs": one_refs,
                    }
                )
            try:
                result = imagegen.generate_batch(
                    base,
                    root,
                    workflow=workflow,
                    items=batch_items,
                    negative=payload.get("negative"),
                    width=_opt_int(payload.get("width")),
                    height=_opt_int(payload.get("height")),
                    steps=_opt_int(payload.get("steps")),
                    cfg=_opt_float(payload.get("cfg")),
                    wait_sec=float(payload.get("waitSec") or max(900.0, 120.0 * len(batch_items))),
                )
            except imagegen.ImageGenError as exc:
                raise DriverError(str(exc)) from exc
            images = [
                {
                    "key": str(img.get("key")),
                    "image": img.get("image") or b"",
                    "mime": img.get("mime") or "image/png",
                }
                for img in (result.get("images") or [])
            ]
            seconds = float(result.get("seconds") or 0.0)
            meta = {
                "workflow": workflow,
                "promptId": result.get("promptId"),
                "seconds": result.get("seconds"),
                "report": result.get("report"),
                "count": len(images),
                # 一张一张摊下来的时间才是"这张图多贵"的真实口径
                "secondsPerImage": round(seconds / len(images), 2) if images else None,
            }
            return InvokeResult("images", images, "image/png", meta)

        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            raise DriverError("没有提示词（prompt）")

        refs: list[str] = [str(x) for x in (payload.get("refs") or [])]
        images = payload.get("images") or []
        if images:
            if not isinstance(images, list):
                raise DriverError("images 必须是数组（base64 或 data URL）")
            for idx, item in enumerate(images):
                raw = _decode_image(item)
                name = imagegen.upload_image(
                    base, name=f"hub-{spec.id}-{idx}-{int(time.time())}.png", data=raw
                )
                refs.append(name)
                # 同上：上传完就放手，别让它在整段采样期间一直挂着
                images[idx] = None

        if spec.capability == "image.edit" and not refs:
            raise DriverError("图片编辑需要至少一张参考图（refs 或 images）")

        try:
            result = imagegen.generate(
                base,
                root,
                workflow=workflow,
                prompt=prompt,
                negative=payload.get("negative"),
                width=_opt_int(payload.get("width")),
                height=_opt_int(payload.get("height")),
                seed=_opt_int(payload.get("seed")),
                steps=_opt_int(payload.get("steps")),
                cfg=_opt_float(payload.get("cfg")),
                refs=refs or None,
                wait_sec=float(payload.get("waitSec") or 300.0),
            )
        except imagegen.ImageGenError as exc:
            raise DriverError(str(exc)) from exc
        meta = {
            "workflow": workflow,
            "promptId": result.get("promptId"),
            "seconds": result.get("seconds"),
            "report": result.get("report"),
            "refs": refs,
        }
        return InvokeResult("image", result.get("image") or b"", result.get("mime") or "image/png", meta)


class Qwen21InprocDriver(Driver):
    """Qwen-Image-2.1 生图：用 ComfyUI 的 python 环境跑，**不起 ComfyUI**。

    为什么不起 ComfyUI：
        ComfyUI 的节点是纯 python 类（`comfy.sd` 加载、`comfy.sample` 采样），
        生图这条链只有 6 个节点。为它起一个 HTTP 服务、再把 prompt 转回进程里跑，
        等于多一个常驻进程（4G 上下）、多一个端口、多一次序列化 —— 卡还是同一张。

    为什么是**常驻** worker 而不是一次一个进程：
        实测冷启动 `import torch` + `import comfy` 要 22.5s，而真正出图的那部分
        （960² 两张）只要 30s 上下。一次一进程等于每张白扔 22s —— 这就是
        「生图很慢」的主因，不是模型慢。所以起一个 worker 常驻，用
        stdin/stdout 收发一行 JSON；空闲 90s 它自己把模型请下卡（进程留着，
        重新装 1.3s，重新起进程 22.5s）。

    批量（payload.items）：
        N 条 prompt 走同一个 worker、同一批模型：全部编码 → 全部采样 → 全部解码。
        这个顺序是显存锁死的（CLIP 8.8G 与 UNet 6.8G 在 16G 卡上不能共存），
        不是风格选择。而「全部编码」才有收益：TE 第 1 条 19s（首次前向），
        第 2 条起 0.98s。采样逐条即可 —— 实测 batch 2/4/6 每张都是 4.75s，
        T10 是 compute-bound，拼 batch 换不来时间，反而要 pad 到等长
        （Qwen-Image-2.1 的 forward 不认 attention_mask，pad 会污染结果）。

    和 ComfyDriver 的区别：
        * 没有 port（走 stdio），health 看进程还在不在；
        * `Loaded.pid` 是 worker 的真 pid，账本按 `spec.vram_mb` 估；
        * invoke 直接吃 prompt/尺寸/seed/items，不经过工作流 JSON（工作流那份在
          `server/qwen21_inproc.py` 里照抄成调用序列，两处要一起改）。

    GPU 由 `_env()` 钉住（`CUDA_VISIBLE_DEVICES` 取自配置的 `gpu.index`），
    所以「聚合服务跑一张卡」是环境变量层面保证的，不是靠人记得加参数。
    """

    name = "qwen21"
    #: 常驻一个 worker 进程：import torch+comfy 要 22.5s，不能每张重付
    manages_process = True
    uses_gpu = True

    def __init__(self) -> None:
        #: 常驻 worker（stdin/stdout 的 JSON 行协议）；单卡不能并发，用锁串行化
        self._popen: subprocess.Popen[str] | None = None
        self._worker_key = ""
        self._logf: Any = None
        self._rpc_lock = threading.Lock()

    def _py(self, spec: ModelSpec) -> str:
        return str(spec.extra.get("python") or "")

    def _script(self, spec: ModelSpec) -> str:
        return str(spec.extra.get("script") or "")

    def _comfy_root(self, spec: ModelSpec) -> str:
        return str(spec.extra.get("comfyRoot") or "")

    def _models(self, spec: ModelSpec) -> dict[str, str]:
        return {
            "unet": str(spec.extra.get("unet") or ""),
            "lora": str(spec.extra.get("lora") or ""),
            "clip": str(spec.extra.get("clip") or ""),
            "vae": str(spec.extra.get("vae") or ""),
        }

    def check(self, spec: ModelSpec, cfg: HubConfig, gpu: Gpu) -> list[Issue]:
        out: list[Issue] = []
        py, script, root = self._py(spec), self._script(spec), self._comfy_root(spec)
        if not Path(py).is_file():
            out.append(Issue("error", "qwen21.python", f"找不到 python：{py or '（没配）'}",
                             "配置 extra.python 指向 ComfyUI 的 python_embeded/python.exe"))
        if not Path(script).is_file():
            out.append(Issue("error", "qwen21.script", f"找不到执行器：{script or '（没配）'}",
                             "配置 extra.script 指向剧本台的 server/qwen21_inproc.py"))
        if not Path(root, "main.py").is_file():
            out.append(Issue("error", "qwen21.root", f"ComfyUI 目录不对：{root or '（没配）'}"))
        else:
            mdir = Path(root) / "models"
            for kind, name in (
                ("diffusion_models", self._models(spec)["unet"]),
                ("loras", self._models(spec)["lora"]),
                ("text_encoders", self._models(spec)["clip"]),
                ("vae", self._models(spec)["vae"]),
            ):
                if name and not (mdir / kind / name).is_file():
                    out.append(Issue("error", f"qwen21.{kind}", f"模型不在：models/{kind}/{name}",
                                     "改配置 extra 或把模型放进去"))
        return out

    def start(self, spec: ModelSpec, cfg: HubConfig, gpu: Gpu) -> Loaded:
        """把 worker 拉起来（首次要等 22s 的 import），此后常驻。"""
        with self._rpc_lock:
            proc = self._ensure_worker(spec, cfg)
        return Loaded(
            pid=proc.pid,
            port=0,
            proc=None,
            external=False,
            meta={"mode": "inproc-serve", "script": self._script(spec), **self._models(spec)},
            real_vram_mb=int(spec.vram_mb or 0),
        )

    def stop(self, spec: ModelSpec, loaded: Loaded, cfg: HubConfig, gpu: Gpu) -> None:
        with self._rpc_lock:
            self._shutdown("停止模型")

    def health(self, spec: ModelSpec, loaded: Loaded, cfg: HubConfig) -> tuple[bool, str]:
        proc = self._popen
        if proc is None:
            return True, "未拉起（首个请求时启动）"
        code = proc.poll()
        if code is None:
            return True, "worker 存活"
        return False, f"worker 已退出（{code}）"

    # ------------------------------------------------------------ worker 进程

    def _spawn(self, spec: ModelSpec, cfg: HubConfig) -> subprocess.Popen[str]:
        py, script, root = self._py(spec), self._script(spec), self._comfy_root(spec)
        if not Path(py).is_file():
            raise DriverError(f"找不到 python：{py or '（没配 extra.python）'}")
        if not Path(script).is_file():
            raise DriverError(f"找不到执行器：{script or '（没配 extra.script）'}")
        if not Path(root, "main.py").is_file():
            raise DriverError(f"ComfyUI 目录不对：{root or '（没配 extra.comfyRoot）'}")

        env = self._env(spec, cfg)
        env.update({
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
            "QWEN21_COMFY_ROOT": root,
        })
        env.update({str(k): str(v) for k, v in (spec.extra.get("env") or {}).items()})

        log_path = self._log_path(spec, cfg)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        logf = open(log_path, "ab")  # noqa: SIM115 —— 进程活多久就开多久
        self._logf = logf
        logf.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} 起 worker\n".encode("utf-8"))
        logf.flush()

        popen = subprocess.Popen(
            [py, "-s", script, "--serve"],
            cwd=root,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=logf,
            bufsize=1,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        timeout = float(spec.extra.get("startupSec") or 180.0)
        line = _read_line(popen, timeout)
        if line is None:
            popen.kill()
            raise DriverError(f"worker 启动超时（{timeout:.0f}s），看 {log_path}")
        if not line:
            code = popen.poll()
            raise DriverError(f"worker 启动即退出（{code}），看 {log_path}")
        try:
            hello = json.loads(line)
        except json.JSONDecodeError as exc:
            popen.kill()
            raise DriverError(f"worker 握手不是 JSON：{line[:200]}") from exc
        if not hello.get("ok"):
            popen.kill()
            raise DriverError(f"worker 起不来：{hello.get('error') or line[:200]}（看 {log_path}）")
        print(
            f"[qwen21] worker 就绪：import {float(hello.get('importSeconds') or 0):.1f}s，"
            f"GPU {hello.get('gpu') or '?'}，空闲 {hello.get('idleUnload')}s 卸模型",
            file=sys.stderr, flush=True,
        )
        return popen
    def _ensure_worker(self, spec: ModelSpec, cfg: HubConfig) -> subprocess.Popen[str]:
        """拿到一个活着的 worker。配置变了或进程死了就重起。"""
        key = "|".join([
            self._py(spec), self._script(spec), self._comfy_root(spec),
            str(cfg.gpu.index), *(self._models(spec)[k] for k in ("unet", "lora", "clip", "vae")),
        ])
        proc = self._popen
        if proc is not None and proc.poll() is None and self._worker_key == key:
            return proc
        if proc is not None:
            self._shutdown("配置变了/进程已死")
        self._popen = self._spawn(spec, cfg)
        self._worker_key = key
        return self._popen

    def _shutdown(self, why: str) -> None:
        proc = self._popen
        self._popen = None
        self._worker_key = ""
        if proc is None:
            return
        try:
            if proc.poll() is None:
                try:
                    self._rpc(proc, {"op": "quit"}, 30.0)
                except Exception:  # noqa: BLE001
                    pass
                proc.wait(timeout=20)
        except Exception:  # noqa: BLE001
            pass
        finally:
            if proc.poll() is None:
                proc.kill()
                try:
                    proc.wait(timeout=10)
                except Exception:  # noqa: BLE001
                    pass
            for stream in (proc.stdin, proc.stdout):
                try:
                    if stream:
                        stream.close()
                except Exception:  # noqa: BLE001
                    pass
            logf = getattr(self, "_logf", None)
            if logf is not None:
                try:
                    logf.write(f"=== {time.strftime('%H:%M:%S')} 停 worker（{why}）\n".encode("utf-8"))
                    logf.close()
                except Exception:  # noqa: BLE001
                    pass
                self._logf = None

    def _rpc(self, proc: subprocess.Popen[str], req: dict[str, Any], timeout: float) -> dict[str, Any]:
        """一行请求、一行响应。超时就把进程杀掉 —— 卡住的 worker 不能留。"""
        if not proc.stdin or not proc.stdout:
            raise DriverError("worker 管道断了")
        try:
            proc.stdin.write(json.dumps(req, ensure_ascii=False) + "\n")
            proc.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise DriverError("worker 写不进去（进程已死）") from exc

        line = _read_line(proc, timeout)
        if line is None:
            proc.kill()
            raise DriverError(f"worker 超过 {timeout:.0f}s 没响应，已杀掉")
        if not line:
            code = proc.poll()
            raise DriverError(f"worker 中途退出（{code}）")
        try:
            return json.loads(line)
        except json.JSONDecodeError as exc:
            raise DriverError(f"worker 响应不是 JSON：{line[:200]}") from exc

    def invoke(
        self, spec: ModelSpec, loaded: Loaded, payload: dict[str, Any], cfg: HubConfig
    ) -> InvokeResult:
        """出图。payload 里有 items 就是批量：一次请求、一套模型出 N 张。

        批量必须走这条路而不是让上层循环调用 —— 每次调用都要把 CLIP → UNet → VAE
        轮一遍，那就是把装卸成本乘以张数。
        """
        items_in = payload.get("items")
        batch = isinstance(items_in, list) and bool(items_in)
        if spec.capability == "image.edit" and not (
            payload.get("refs") or payload.get("images")
            or (batch and any(it.get("refs") or it.get("images") for it in items_in if isinstance(it, dict)))
        ):
            # 编辑 = 文生图 + 参考图；不拦的话会安静地出一张不相干的图
            raise DriverError("图片编辑需要至少一张参考图（refs 或 images）")

        width = _opt_int(payload.get("width")) or 1280
        height = _opt_int(payload.get("height")) or 720
        steps = _opt_int(payload.get("steps")) or int(spec.extra.get("steps") or 2)
        cfg_v = _opt_float(payload.get("cfg"))
        cfg_v = float(spec.extra.get("cfg") or 1.0) if cfg_v is None else cfg_v

        outdir = Path(cfg.runtime_dir) / "images"
        outdir.mkdir(parents=True, exist_ok=True)
        stamp = f"{int(time.time() * 1000)}"
        tmp_refs: list[str] = []

        def _refs_of(one: dict[str, Any], idx: int) -> list[str]:
            """参考图：base64 落成临时文件；refs 是 ComfyUI input 目录里的文件名。

            执行器只认本地绝对路径 —— 它不在 ComfyUI 的节点里跑。
            """
            out: list[str] = []
            for j, raw in enumerate(one.get("images") or []):
                if not raw:
                    continue
                p = outdir / f"qwen21-ref-{stamp}-{idx}-{j}.png"
                p.write_bytes(_decode_image(raw))
                tmp_refs.append(str(p))
                out.append(str(p))
            for name in one.get("refs") or []:
                nm = str(name or "").strip()
                if not nm:
                    continue
                cand = Path(self._comfy_root(spec)) / "input" / nm
                if cand.is_file():
                    out.append(str(cand))
            return out

        raw_items: list[Any] = items_in if batch else [{
            "key": 0,
            "prompt": payload.get("prompt"),
            "seed": payload.get("seed"),
            "refs": payload.get("refs"),
            "images": payload.get("images"),
        }]
        jobs: list[dict[str, Any]] = []
        for idx, one in enumerate(raw_items):
            if not isinstance(one, dict):
                raise DriverError(f"第 {idx + 1} 条格式不对")
            prompt = str(one.get("prompt") or payload.get("prompt") or "").strip()
            if not prompt:
                raise DriverError(f"第 {idx + 1} 条没有提示词（prompt）")
            seed = _opt_int(one.get("seed"))
            if seed is None:
                seed = int.from_bytes(os.urandom(4), "big") & 0x7FFFFFFF
            jobs.append({
                "key": str(one.get("key") if one.get("key") is not None else idx),
                "prompt": prompt,
                "seed": seed,
                "refs": _refs_of(one, idx),
                "out": str(outdir / f"qwen21-{stamp}-{idx}-{seed}.png"),
            })

        req = {
            "op": "run",
            "items": jobs,
            "negative": str(payload.get("negative") or ""),
            "width": width,
            "height": height,
            "steps": steps,
            "cfg": cfg_v,
            "shift": float(spec.extra.get("shift") or 3.0),
            "resolution": int(spec.extra.get("resolution") or 1024),
            "comfyRoot": self._comfy_root(spec),
            **self._models(spec),
        }
        # 批量按张数放大超时：默认 1800s 对 30 张不够
        timeout = max(
            float(payload.get("waitSec") or spec.extra.get("timeoutSec") or 1800.0),
            120.0 * len(jobs) + 300.0,
        )
        t0 = time.monotonic()
        # 单卡：并发请求在锁上排队，别让两个批次同时抢显存互相 OOM
        with self._rpc_lock:
            proc = self._ensure_worker(spec, cfg)
            result = self._rpc(proc, req, timeout)
        elapsed = time.monotonic() - t0

        try:
            if not result.get("ok"):
                raise DriverError(
                    f"出图失败：{result.get('error') or '看日志'}（{self._log_path(spec, cfg)}）"
                )
            imgs = result.get("images") or []
            if len(imgs) != len(jobs):
                raise DriverError(f"worker 出了 {len(imgs)} 张，请求的是 {len(jobs)} 张")

            meta: dict[str, Any] = {
                "engine": "qwen21-inproc",
                "width": result.get("width") or width,
                "height": result.get("height") or height,
                "steps": steps,
                "seconds": round(elapsed, 2),
                "secondsPerImage": round(elapsed / len(jobs), 2),
                "secondsText": result.get("secondsText"),
                "secondsSample": result.get("secondsSample"),
                "secondsDecode": result.get("secondsDecode"),
                "gpu": cfg.gpu.index,
                "count": len(jobs),
            }
            if len(jobs) > 1:
                return InvokeResult(
                    "images",
                    [
                        {
                            "key": it.get("key"),
                            "image": Path(str(it["path"])).read_bytes(),
                            "mime": "image/png",
                        }
                        for it in imgs
                    ],
                    "image/png",
                    meta,
                )
            img = imgs[0]
            meta["seed"] = img.get("seed") or jobs[0]["seed"]
            meta["refs"] = len(jobs[0]["refs"])
            return InvokeResult("image", Path(str(img["path"])).read_bytes(), "image/png", meta)
        finally:
            # 参考图只是这一趟的输入，留着只会让运行目录越滚越大
            for rp in tmp_refs:
                try:
                    Path(rp).unlink(missing_ok=True)
                except OSError:
                    pass


def _read_line(proc: "subprocess.Popen[str]", timeout: float) -> str | None:
    """读 worker 的一行输出，带超时。

    返回 None = 超时（调用方负责杀掉进程），"" = 管道关了（进程已经走）。
    readline 本身不支持超时，只能扔到线程里等。
    """
    box: dict[str, Any] = {}

    def reader() -> None:
        try:
            box["line"] = proc.stdout.readline() if proc.stdout else ""
        except Exception as exc:  # noqa: BLE001
            box["err"] = exc

    th = threading.Thread(target=reader, daemon=True, name="qwen21-read")
    th.start()
    th.join(timeout)
    if th.is_alive():
        return None
    if "err" in box:
        raise DriverError(f"读 worker 输出失败：{box['err']}")
    return str(box.get("line") or "")


def _opt_int(raw: Any) -> int | None:
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError) as exc:
        raise DriverError(f"不是整数：{raw!r}") from exc


def _opt_float(raw: Any) -> float | None:
    if raw is None or raw == "":
        return None
    try:
        return float(raw)
    except (TypeError, ValueError) as exc:
        raise DriverError(f"不是数字：{raw!r}") from exc


def _decode_image(item: Any) -> bytes:
    if isinstance(item, bytes):
        return item
    text = str(item or "")
    if text.startswith("data:"):
        text = text.split(",", 1)[-1]
    try:
        return base64.b64decode(text, validate=False)
    except (ValueError, TypeError) as exc:
        raise DriverError("images 里有不是合法 base64 的项") from exc


def _find_comfy_pid(base: str) -> int | None:
    """猜 ComfyUI 的 pid：从 URL 端口反查监听者。查不到不影响功能。"""
    m = re.search(r":(\d+)", base or "")
    if not m:
        return None
    return port_owner(int(m.group(1)))


DRIVERS: dict[str, Driver] = {
    "llama": LlamaDriver(),
    "audiocpp": AudiocppDriver(),
    "s2": S2Driver(),
    "comfy": ComfyDriver(),
    # 进程内出图：用 ComfyUI 的 python 环境跑，不启 ComfyUI 服务
    "qwen21": Qwen21InprocDriver(),
}


def get_driver(name: str) -> Driver:
    drv = DRIVERS.get(name)
    if not drv:
        raise DriverError(f"不认识的驱动 {name!r}；可用：{', '.join(sorted(DRIVERS))}")
    return drv
