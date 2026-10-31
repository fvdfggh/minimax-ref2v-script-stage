"""音色服务：qwen3 设计音色 → s2 固化音色包 → s2 合成。

为什么不把两个服务直接暴露给前端：
  * 两个引擎都用**窄字符 fopen**，路径里带中文（桌面「语音合成」）会直接失败，
    所以所有音色文件必须落在 ASCII 入口 C:/s2 下，由后端统一管路径；
  * 固化要走 s2 的命令行（--save-voice），不是 HTTP，浏览器做不了；
  * 三个动作的耗时差一个数量级（设计 3s / 固化 12s / 合成 3s），
    超时、排队、缓存都放在后端才讲得清楚。

三个动作的语义边界（别混）：
  design   —— qwen3 按描述"造"一个音色，产出参考 wav。**只是候选**，还没定型。
  fix      —— s2 把候选 wav 编码成 .s2voice 音色包。这一步之后音色才固定下来，
              以后每次合成都用它，不再依赖那段 wav。
  speak    —— 用已固定的音色包合成任意文本。段内配音就是打这个。

缓存的理由：设计/固化都是确定性的（同样的描述 + 种子 → 同样的 wav / 同一个包），
所以文件名按内容哈希命名，重复点同一个候选不会再把 3~12 秒白等一遍。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from array import array
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------- 路径与常量

# 必须是 ASCII 入口：s2 / audio.cpp 都按窄字符开文件，中文路径一律失败
S2_ROOT = Path("C:/s2")
S2_EXE = S2_ROOT / "app" / "s2.exe"
S2_MODEL = S2_ROOT / "app" / "s2-pro-q8_0.gguf"
S2_TOKENIZER = S2_ROOT / "app" / "tokenizer.json"
VOICES_DIR = S2_ROOT / "voices"
DESIGN_DIR = VOICES_DIR / "design"
PACK_DIR = VOICES_DIR / "packs"

S2_URL = "http://127.0.0.1:3030"
QWEN_URL = "http://127.0.0.1:8080"

# s2 的 cuda 设备号：没有 ModelHub 时按老办法钉死一张（第三张 T10）
CUDA_DEVICE = 2

# 设计音色时念的那句参考文本。
# 它同时是固化的 prompt_text —— s2 编码参考音频时必须拿到**逐字一致**的文本，
# 所以这句只能存在一个地方，前端不许自己拼。
DESIGN_TEXT = "这是一段用来确定音色的参考文本，请用自然的语气清晰地朗读出来。"

# 固化音色包时，s2 还会顺手合成一句占位文本（"Hello world"），
# 把它赶进临时目录，别脏了程序目录。
FIX_CWD = S2_ROOT / "output" / "fix_tmp"

_TIMEOUT_DESIGN = 120
_TIMEOUT_FIX = 300
_TIMEOUT_SPEAK = 300

# ---------------------------------------------------------------- ModelHub

#: 运行前服务（单卡，默认 8790）。它活着时，设计/合成/固化都交给它：
#: 谁在卡上、要不要先卸别人，是它的事 —— 剧本台不必再自己维护 3030/8080
#: 两份常驻服务的生死。它没起的时候退回直连，老路径不受影响。
HUB_URL = os.environ.get("SCRIPTSTAGE_HUB", "http://127.0.0.1:8790").rstrip("/")
_HUB_TTL = 8.0
_hub_cache: dict[str, Any] = {"at": 0.0, "on": False, "gpu": None, "url": HUB_URL}


def hub_info(ttl: float = _HUB_TTL) -> dict:
    """探一次 ModelHub：在不在、它管的是哪张卡。

    缓存 8 秒 —— 每个音色动作都会问一次，但用户手点出来的间隔远大于这个，
    不会把「刚起的 hub」晾在外面。
    """
    now = time.time()
    if now - float(_hub_cache.get("at") or 0) < ttl:
        return dict(_hub_cache)
    info: dict[str, Any] = {"at": now, "on": False, "gpu": None, "url": HUB_URL}
    try:
        with urllib.request.urlopen(HUB_URL + "/health", timeout=1.5) as resp:
            info["on"] = resp.status == 200
    except Exception:  # noqa: BLE001 —— 探测失败就是「没起」，不是错误
        info["on"] = False
    if info["on"]:
        try:
            with urllib.request.urlopen(HUB_URL + "/v1/status", timeout=3.0) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            raw_index = (data.get("gpu") or {}).get("index")
            info["gpu"] = int(raw_index) if raw_index is not None else None
        except Exception:  # noqa: BLE001
            info["gpu"] = None
    _hub_cache.update(info)
    return dict(info)


def _hub_audio(payload: dict, timeout: int, what: str) -> bytes:
    """打 ModelHub 的 OpenAI 风格语音接口，拿 wav 字节。"""
    body, _ct = _post_json(HUB_URL + "/v1/audio/speech", payload, timeout)
    if len(body) < 1024:
        raise VoiceError(f"{what}返回的内容不像音频（{len(body)} 字节）")
    return body


def _hub_unload(model_id: str) -> None:
    """让 hub 把某个模型从卡上撤下来。失败不致命（可能本来就没加载）。"""
    try:
        data = json.dumps({"model": model_id}).encode("utf-8")
        req = urllib.request.Request(
            HUB_URL + "/v1/unload", data=data,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read()
    except Exception:  # noqa: BLE001
        pass


class VoiceError(Exception):
    """调用音色服务失败。message 直接给用户看，所以要说人话。"""


# ---------------------------------------------------------------- 小工具


def _hash(*parts: Any) -> str:
    raw = "|".join(str(p) for p in parts).encode("utf-8")
    return hashlib.sha1(raw).hexdigest()


def _slug(text: str, limit: int = 24) -> str:
    """给文件名用的一段可读标记。只留 ASCII 字母数字，中文直接丢掉（不是路径）。"""
    keep = re.sub(r"[^A-Za-z0-9]+", "", text or "")
    return keep[:limit].lower() or "voice"


def _wav_seconds(path: Path) -> float:
    try:
        info = _wav_info(path.read_bytes())
        if info and info["rate"] and info["block"]:
            return round(info["frames"] / float(info["rate"]), 2)
    except Exception:  # noqa: BLE001 —— 时长只是展示信息，读不出就算了
        pass
    return 0.0


def _wav_info(blob: bytes) -> dict | None:
    """手解 RIFF 头。

    不用标准库 wave：s2 吐的是 **float32**（fmtTag 3），wave 模块直接抛
    "unknown format"，而这条路径恰好是最常走的（段内配音）。
    """
    if len(blob) < 44 or blob[:4] != b"RIFF" or blob[8:12] != b"WAVE":
        return None
    pos, fmt, data_off, data_len = 12, None, None, 0
    while pos + 8 <= len(blob):
        cid = blob[pos : pos + 4]
        size = int.from_bytes(blob[pos + 4 : pos + 8], "little")
        body = pos + 8
        if cid == b"fmt " and size >= 16:
            tag, ch, rate, _br, block, bits = (
                int.from_bytes(blob[body : body + 2], "little"),
                int.from_bytes(blob[body + 2 : body + 4], "little"),
                int.from_bytes(blob[body + 4 : body + 8], "little"),
                int.from_bytes(blob[body + 8 : body + 12], "little"),
                int.from_bytes(blob[body + 12 : body + 14], "little"),
                int.from_bytes(blob[body + 14 : body + 16], "little"),
            )
            fmt = {"tag": tag, "channels": ch, "rate": rate, "block": block, "bits": bits}
        elif cid == b"data":
            data_off, data_len = body, min(size, max(0, len(blob) - body))
            break
        pos = body + size + (size & 1)
    if not fmt or data_off is None:
        return None
    return {**fmt, "dataOffset": data_off, "dataLength": data_len, "frames": data_len // max(1, fmt["block"])}


def to_pcm16(blob: bytes) -> bytes:
    """把 s2 的 float32 wav 转成 PCM16。

    为什么非要转：浏览器 <audio>、ComfyUI 的参考音频、后续任何一段拼接，
    对 float32 wav 的支持都不齐（fmtTag 3 一堆播放器当未知格式）。
    PCM16 是各方都能吃的最保守格式，代价只是 4 字节 → 2 字节。
    """
    info = _wav_info(blob)
    if not info:
        return blob
    if info["tag"] == 1 and info["bits"] == 16:
        return blob
    if info["tag"] != 3 or info["bits"] != 32:
        return blob

    offset, length = info["dataOffset"], info["dataLength"]
    samples = array("f")
    samples.frombytes(blob[offset : offset + length - (length % 4)])
    out = array("h", bytes(2 * len(samples)))
    for i, value in enumerate(samples):
        clipped = -1.0 if value < -1.0 else (1.0 if value > 1.0 else value)
        out[i] = int(clipped * 32767.0)
    payload = out.tobytes()
    header = _pcm16_header(info["channels"], info["rate"], len(payload))
    return header + payload


def _pcm16_header(channels: int, rate: int, data_len: int) -> bytes:
    channels = max(1, int(channels))
    rate = max(1, int(rate))
    block = channels * 2
    return (
        b"RIFF"
        + (36 + data_len).to_bytes(4, "little")
        + b"WAVEfmt "
        + (16).to_bytes(4, "little")
        + (1).to_bytes(2, "little")
        + channels.to_bytes(2, "little")
        + rate.to_bytes(4, "little")
        + (rate * block).to_bytes(4, "little")
        + block.to_bytes(2, "little")
        + (16).to_bytes(2, "little")
        + b"data"
        + data_len.to_bytes(4, "little")
    )


def _ensure_dirs() -> None:
    for d in (DESIGN_DIR, PACK_DIR, FIX_CWD):
        d.mkdir(parents=True, exist_ok=True)


def _post_json(url: str, payload: dict, timeout: int) -> tuple[bytes, str]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read(), resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        body = b""
        try:
            body = exc.read()
        except Exception:  # noqa: BLE001
            body = b""
        detail = body[:400].decode("utf-8", "replace")
        raise VoiceError(f"音色服务返回 HTTP {exc.code}：{detail or '（无内容）'}") from exc
    except urllib.error.URLError as exc:
        raise VoiceError(f"连不上音色服务（{url}）：{exc.reason}") from exc


def _multipart(fields: dict[str, str], files: dict[str, tuple[str, bytes]]) -> tuple[bytes, str]:
    boundary = "----s2voice" + hashlib.sha1(os.urandom(8)).hexdigest()
    out = bytearray()
    for name, value in fields.items():
        out += f"--{boundary}\r\n".encode()
        out += f'Content-Disposition: form-data; name="{name}"\r\n'.encode()
        out += b"Content-Type: text/plain; charset=utf-8\r\n\r\n"
        out += str(value).encode("utf-8") + b"\r\n"
    for name, (filename, blob) in files.items():
        out += f"--{boundary}\r\n".encode()
        out += (
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
        ).encode()
        out += b"Content-Type: application/octet-stream\r\n\r\n"
        out += blob + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


# ---------------------------------------------------------------- 服务状态


def _probe(url: str, timeout: float = 2.0) -> dict:
    """探活。s2 只有 /generate，根路径 404 也算活着 —— 所以看的是"连不连得上"。"""
    started = time.time()
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            resp.read(1)
        ok = True
        detail = ""
    except urllib.error.HTTPError as exc:
        # 404 / 405：服务活着，只是没有这个路由
        ok = True
        detail = f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001
        ok = False
        detail = f"{type(exc).__name__}: {exc}"
    return {"ok": ok, "ms": int((time.time() - started) * 1000), "detail": detail}


def status() -> dict:
    _ensure_dirs()
    packs = sorted(p.stem for p in PACK_DIR.glob("*.s2voice"))
    designs = sorted(p.name for p in DESIGN_DIR.glob("*.wav"))
    hub = hub_info()
    return {
        "s2": {"url": S2_URL, **_probe(S2_URL + "/")},
        "qwen3": {"url": QWEN_URL, **_probe(QWEN_URL + "/health")},
        # 前端拿这个判断「现在是谁在提供服务」：hub 在就不用管 3030/8080 的死活
        "hub": {
            "url": HUB_URL,
            "on": hub["on"],
            "gpu": hub["gpu"],
            "engine": "modelhub" if hub["on"] else "direct",
        },
        "designText": DESIGN_TEXT,
        "packs": packs,
        "designs": len(designs),
        "dirs": {"voices": str(VOICES_DIR), "packs": str(PACK_DIR), "design": str(DESIGN_DIR)},
    }


# ---------------------------------------------------------------- 1) 设计


def design(desc: str, seed: int, text: str | None = None) -> dict:
    """用文本描述让 qwen3 造一个音色，返回参考 wav 的信息。

    同一 (描述, 种子) 永远命中同一个文件：候选列表重新渲染、页面刷新、
    换台机器回来，听到的还是那一条 —— 不然「我刚才选的是哪个」就无从谈起。
    """
    desc = (desc or "").strip()
    if not desc:
        raise VoiceError("没有音色描述：先在「声音描述」里写清这是什么声音")
    sample_text = (text or DESIGN_TEXT).strip() or DESIGN_TEXT
    seed = int(seed)
    _ensure_dirs()

    name = f"d_{_hash(desc, sample_text, seed)[:12]}_{_slug(desc)}_{seed}.wav"
    path = DESIGN_DIR / name
    hub = hub_info()
    engine = "modelhub" if hub["on"] else "direct"
    if path.is_file() and path.stat().st_size > 1024:
        return {**_design_meta(path, desc, seed, sample_text, cached=True), "engine": engine}

    if hub["on"]:
        # 走 ModelHub：它会先把 audio.cpp 播到卡上（原来是常驻在 8080 的）
        body = _hub_audio(
            {"input": sample_text, "instructions": desc, "seed": seed},
            _TIMEOUT_DESIGN,
            "设计服务",
        )
    else:
        body, _ct = _post_json(
            QWEN_URL + "/v1/audio/speech",
            {
                "model": "qwen3-vd",
                "input": sample_text,
                "instruction": desc,
                "seed": seed,
            },
            _TIMEOUT_DESIGN,
        )
        if len(body) < 1024:
            raise VoiceError(f"设计服务返回的内容不像音频（{len(body)} 字节）")
    path.write_bytes(body)
    return {**_design_meta(path, desc, seed, sample_text, cached=False), "engine": engine}


def _design_meta(path: Path, desc: str, seed: int, text: str, cached: bool) -> dict:
    return {
        "name": path.name,
        "seed": seed,
        "desc": desc,
        "text": text,
        "bytes": path.stat().st_size,
        "seconds": _wav_seconds(path),
        "cached": cached,
    }


def design_path(name: str) -> Path:
    """把前端传来的文件名收束到 design 目录内。

    只认 basename，防止 ../ 穿越 —— 这个接口会把文件内容直接吐给浏览器，
    放开路径等于开放整个磁盘。
    """
    safe = os.path.basename(name or "")
    if not safe.lower().endswith(".wav"):
        raise VoiceError("只认 .wav 候选文件")
    path = DESIGN_DIR / safe
    if not path.is_file():
        raise VoiceError("候选音频不在了，重新设计一次")
    return path


# ---------------------------------------------------------------- 2) 固定


def pack_id_for(desc: str, seed: int, text: str | None = None) -> str:
    sample_text = (text or DESIGN_TEXT).strip() or DESIGN_TEXT
    return "v_" + _hash(desc.strip(), sample_text, int(seed))[:10]


def fix(sample: str, desc: str = "", seed: int = 0, text: str | None = None, force: bool = False) -> dict:
    """把候选 wav 编码成 .s2voice 音色包（s2 --save-voice）。

    这一步是"固定音色"的真正含义：包一旦生成，后续合成就只依赖它，
    不再需要那段参考 wav，也不再跑 qwen3。
    """
    src = design_path(sample)
    sample_text = (text or DESIGN_TEXT).strip() or DESIGN_TEXT
    voice_id = pack_id_for(desc or sample, int(seed) if seed else 0, sample_text)
    out = PACK_DIR / f"{voice_id}.s2voice"

    if out.is_file() and out.stat().st_size > 512 and not force:
        return _pack_meta(out, voice_id, sample, desc, int(seed), sample_text, cached=True)

    for exe in (S2_EXE, S2_MODEL, S2_TOKENIZER):
        if not exe.is_file():
            raise VoiceError(f"找不到 {exe}：语音合成目录被挪动过？")

    hub = hub_info()
    device = hub["gpu"] if hub["on"] and hub["gpu"] is not None else CUDA_DEVICE
    if hub["on"]:
        # 固化是一次性进程，自己也要一份 5G 权重：先让 hub 把常驻的 s2 撤下来，
        # 免得两份同时抢卡；下次合成时 hub 会自己再装回去。
        _hub_unload("s2-pro")

    _ensure_dirs()
    cmd = [
        str(S2_EXE),
        "-m", str(S2_MODEL),
        "-t", str(S2_TOKENIZER),
        "-c", str(device),
        # 不跑 codec 基准（那一步要 20 秒），直接跟着主模型上同一张卡
        "--codec-follow-backend",
        "-pa", str(src),
        "-pt", sample_text,
        "--save-voice",
        "--voice", voice_id,
        "--voice-dir", str(PACK_DIR),
        "--log-level", "warn",
    ]
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(FIX_CWD),
            capture_output=True,
            timeout=_TIMEOUT_FIX,
        )
    except subprocess.TimeoutExpired as exc:
        raise VoiceError(f"固化音色超时（{_TIMEOUT_FIX}s）：s2 可能在忙，稍后重试") from exc

    if not out.is_file() or out.stat().st_size < 512:
        tail = (proc.stderr or b"")[-600:].decode("utf-8", "replace") or (
            proc.stdout or b""
        )[-600:].decode("utf-8", "replace")
        raise VoiceError(f"固化失败（s2 退出码 {proc.returncode}）：{tail.strip() or '没有产出 .s2voice'}")

    return _pack_meta(out, voice_id, sample, desc, int(seed), sample_text, cached=False)


def _pack_meta(
    out: Path, voice_id: str, sample: str, desc: str, seed: int, text: str, cached: bool
) -> dict:
    # 侧车元信息：谁设计的、用的哪段描述、念的哪句话。
    # 实体上虽然也存了一份，但包是会跨集/跨项目复用的，脱开项目也得能讲清来历。
    meta = {
        "id": voice_id,
        "desc": desc,
        "seed": seed,
        "sample": sample,
        "text": text,
        "bytes": out.stat().st_size,
        "fixedAt": int(out.stat().st_mtime * 1000),
    }
    try:
        (PACK_DIR / f"{voice_id}.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError:
        pass
    return {**meta, "cached": cached}


# ---------------------------------------------------------------- 3) 合成


def speak(voice_id: str, text: str) -> bytes:
    """用已固定的音色包合成文本，直接返回 wav 字节。

    没有 voice_id 就报错，**不**退回默认音色：默默换个人声比失败更难查。
    """
    voice_id = (voice_id or "").strip()
    text = (text or "").strip()
    if not voice_id:
        raise VoiceError("这个主体还没有固定音色：先去主体里设计并固定一个")
    if not text:
        raise VoiceError("没有要合成的文本")
    if not (PACK_DIR / f"{voice_id}.s2voice").is_file():
        raise VoiceError(f"音色包 {voice_id} 不在 {PACK_DIR}，可能被删了；重新固定一次")

    hub = hub_info()
    if hub["on"]:
        # s2 由 ModelHub 按需搬到卡上；音色包目录两边是同一个（C:/s2/voices/packs）
        audio = _hub_audio(
            {
                "input": text,
                "voice": voice_id,
                "voiceDir": str(PACK_DIR).replace("\\", "/"),
            },
            _TIMEOUT_SPEAK,
            "合成服务",
        )
        return to_pcm16(audio)

    body, ctype = _multipart(
        {
            "text": text,
            "voice": voice_id,
            "voice_dir": str(PACK_DIR).replace("\\", "/"),
            "params": json.dumps({"output_format": "wav"}),
        },
        {},
    )
    req = urllib.request.Request(
        S2_URL + "/generate", data=body, headers={"Content-Type": ctype}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SPEAK) as resp:
            audio = resp.read()
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read()[:400].decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            detail = ""
        raise VoiceError(f"s2 合成失败 HTTP {exc.code}：{detail or '（无内容）'}") from exc
    except urllib.error.URLError as exc:
        raise VoiceError(f"连不上 s2 合成服务（{S2_URL}）：{exc.reason}") from exc

    if len(audio) < 1024 or b"RIFF" not in audio[:64]:
        raise VoiceError("s2 返回的不是 wav（可能是参数被拒绝），检查日志 C:/s2/output/server.log")
    return to_pcm16(audio)


def speak_to_file(voice_id: str, text: str, folder: Path | None = None) -> Path:
    """合成并落盘（排查 / 打包用）。默认落在 s2 output 下。"""
    audio = speak(voice_id, text)
    target_dir = folder or (S2_ROOT / "output")
    target_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = target_dir / f"tts_{voice_id}_{stamp}.wav"
    path.write_bytes(audio)
    return path
