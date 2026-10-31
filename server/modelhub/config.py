"""运行前服务：把「一张卡上的五类本地能力」收成一个进程。

它解决的问题很具体：
  * 这机器上有四张卡，但业务只该吃一张 —— 否则模型各自往别的卡上跑，
    显存账算不清，「运行前体检」就成了摆设。所以本服务**只认一张卡**。
  * 一张 16G 卡装不下 14G 的 LLM 加生图加两个 TTS。所以模型不常驻，
    调哪类就装哪类，装新的之前先卸旧的（动态加载）。
  * 生图/图片编辑的引擎是常驻的 ComfyUI，它自有模型管理；语音设计和合成
    是两个独立可执行文件；文本生成是 llama.cpp。这四种东西的启停、探活、
    调用形状完全不同，上层不该逐个去记 —— 这里收成一套 `/v1/*`。

五个能力（capability）：
    image.generate     生图        ComfyUI（外部常驻）
    image.edit         图片编辑    ComfyUI（外部常驻）
    voice.design       语音设计    audio.cpp / qwen3-tts voicedesign
    voice.synthesize   语音合成    s2.cpp
    text.generate      文本生成    llama.cpp + gguf

对上层只有一个约定：**要跑之前先问 `/v1/preflight`，跑的时候走 `/v1/run`**。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------- 能力与驱动

#: 能力的固定排序。体检、清单、控制台都按这个序，别用 set/dict 顺序。
CAPABILITIES: tuple[tuple[str, str], ...] = (
    ("image.generate", "生图"),
    ("image.edit", "图片编辑"),
    ("voice.design", "语音设计"),
    ("voice.synthesize", "语音合成"),
    ("text.generate", "文本生成"),
)

CAPABILITY_KEYS = tuple(k for k, _ in CAPABILITIES)
CAPABILITY_TITLES = dict(CAPABILITIES)

#: 能力 → 显存分组。同组可以同时驻留，跨组则「轮到谁就只留谁」。
#:
#: 这条只在单卡上才有意义，而单卡正是本服务的场景：
#: * 音频两个（设计音色 + 合成）是**一次任务的两步**，中间不该插一次卸载；
#: * 图片的生图/编辑共用同一个 ComfyUI 进程，物理上也不可能分开；
#: * 文本生成是独立的 llama-server，进来就意味着把卡腾给它。
GROUP_OF: dict[str, str] = {
    "image.generate": "image",
    "image.edit": "image",
    "voice.design": "audio",
    "voice.synthesize": "audio",
    "text.generate": "llm",
}

#: 驱动名 → 由 drivers.py 解释
DRIVER_TITLES = {
    "comfy": "ComfyUI（常驻外部进程）",
    "audiocpp": "audio.cpp server",
    "s2": "s2.cpp server",
    "llama": "llama.cpp server",
}

DEFAULT_CONFIG_PATH = Path.home() / ".scriptstage" / "modelhub.json"
DEFAULT_RUNTIME_DIR = Path.home() / ".scriptstage" / "modelhub"
DEFAULT_PORT = 8790
#: 托管 ComfyUI 的私有端口。不用 8188：那是用户自己那份常驻实例
COMFY_PORT = 17804


class ConfigError(ValueError):
    """配置本身不成立（不是运行时错误）。message 直接给人看。"""


# ---------------------------------------------------------------- 模型条目


@dataclass(frozen=True)
class ModelSpec:
    """一类能力背后的一个具体模型。

    一个能力可以有多个模型（比如两档生图工作流），默认取 `default` 的那个。
    """

    id: str
    capability: str
    driver: str
    title: str
    #: 可执行文件。comfy 不需要（它是常驻服务，不归本服务启动）
    exe: str | None = None
    #: 模型文件 / ComfyUI 工作流名
    model: str | None = None
    #: 给子进程的端口。comfy 用它做上游地址
    port: int = 0
    #: 显存估算（MiB）。0 = 按文件大小推
    vram_mb: int = 0
    #: 额外命令行参数（驱动自己会拼必需的那些）
    args: tuple[str, ...] = ()
    #: 额外环境变量
    env: dict[str, str] = field(default_factory=dict)
    #: 就绪探针路径
    health: str = "/health"
    #: 从 start 到能服务的最长等待（秒）
    startup_timeout: float = 240.0
    #: 空闲多久自动卸载（秒）。0 = 不自动卸，只在整个换组（换任务类型）时让位。
    #:
    #: 默认 0 是刻意的：这套服务的调用节奏是「一个任务连着来一串」——
    #: 先写词、再配音、再出图。按时间卸会在两次请求之间白白重付一次冷启动
    #: （ComfyUI 40 s、llama 57 s），而真正的切换信号是「来了别的类型」，
    #: 不是「过了几分钟」。要按时间卸的地方（比如多人共用的常驻服务）显式配。
    idle_ttl: float = 0.0
    #: 同组的能力共用这张卡、互不驱逐（缺省按 capability 推断，见 GROUP_OF）
    group: str = ""
    #: 驱动专用配置（ComfyUI 的 root/workflow、s2 的 tokenizer 与音色目录等）
    extra: dict[str, Any] = field(default_factory=dict)
    #: 是否允许在没有 nvidia-smi 的机器上跑（仅调试用）
    optional_gpu: bool = False

    @property
    def group_key(self) -> str:
        """这张卡上「谁可以让位给谁」的分组键。

        音频的两个引擎（文本设计音色 audiocpp / 固定音色合成 s2）是一起用的：
        设计完音色马上要合成，中间隔一次 21 s 的装载毫无意义，所以同组常驻。
        图片的生图与编辑共用一个 ComfyUI 进程，本来就是一伙的。
        """
        return self.group or GROUP_OF.get(self.capability, self.capability)

    def with_(self, **kw: Any) -> ModelSpec:
        return replace(self, **kw)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "capability": self.capability,
            "capabilityTitle": CAPABILITY_TITLES.get(self.capability, self.capability),
            "driver": self.driver,
            "driverTitle": DRIVER_TITLES.get(self.driver, self.driver),
            "title": self.title,
            "exe": self.exe,
            "model": self.model,
            "port": self.port,
            "vramMb": self.vram_mb,
            "health": self.health,
            "idleTtlSec": self.idle_ttl,
            "group": self.group_key,
            "extra": self.extra,
        }


@dataclass(frozen=True)
class GpuConfig:
    """单卡策略。整份配置只描述一张卡。"""

    #: 卡号（nvidia-smi 的 index）。默认 2：这台机器 0/1 已被占，2/3 空
    index: int = 2
    #: 总显存（MiB）。0 = 问 nvidia-smi
    total_mb: int = 0
    #: 给系统/显示/碎片留的余量；账本里永远不算给模型
    reserve_mb: int = 768
    #: 加载完成后至少要留这么多空闲，否则拒绝加载（软保护）
    min_free_mb: int = 384
    #: 等显存回落的超时（卸载/让位时用）
    release_timeout: float = 45.0
    #: 是否强制给子进程注入 CUDA_VISIBLE_DEVICES（单卡硬约束）
    pin_env: bool = True
    #: 严格轮转：卡上任何时刻只服务一个模型，轮到谁就把谁搬上来。
    #: 关掉之后才退化成「装得下就都留着」的共享模式。
    exclusive: bool = True
    #: 换模型时，前一个请求还在跑就等它这么久（秒）；0 = 不等，直接拒绝
    swap_wait: float = 45.0

    def to_dict(self, stats: dict[str, Any] | None = None) -> dict[str, Any]:
        out = {
            "index": self.index,
            "totalMb": self.total_mb,
            "reserveMb": self.reserve_mb,
            "minFreeMb": self.min_free_mb,
            "pinEnv": self.pin_env,
            "exclusive": self.exclusive,
            "swapWaitSec": self.swap_wait,
            "singleCard": True,
        }
        if stats:
            out.update(stats)
        return out


@dataclass(frozen=True)
class HubConfig:
    gpu: GpuConfig
    models: tuple[ModelSpec, ...]
    port: int = DEFAULT_PORT
    host: str = "127.0.0.1"
    runtime_dir: str = str(DEFAULT_RUNTIME_DIR)
    #: 没人用的时候多久扫一次空闲模型
    gc_interval: float = 15.0
    #: 同时只允许一个加载动作（单卡本来就是串行）
    load_timeout: float = 300.0
    #: 事件环形缓冲条数
    event_limit: int = 400

    def model(self, model_id: str) -> ModelSpec | None:
        for m in self.models:
            if m.id == model_id:
                return m
        return None

    def for_capability(self, capability: str) -> list[ModelSpec]:
        return [m for m in self.models if m.capability == capability]

    def default_for(self, capability: str) -> ModelSpec | None:
        models = self.for_capability(capability)
        return models[0] if models else None

    def to_dict(self) -> dict[str, Any]:
        return {
            "host": self.host,
            "port": self.port,
            "runtimeDir": self.runtime_dir,
            "gpu": self.gpu.to_dict(),
            "gcIntervalSec": self.gc_interval,
            "models": [m.to_dict() for m in self.models],
        }


# ---------------------------------------------------------------- 路径探测


def _home() -> Path:
    return Path.home()


def _desktop() -> Path:
    return _home() / "Desktop"


def _first(paths: list[Path]) -> Path | None:
    for p in paths:
        try:
            if p.is_file():
                return p
        except OSError:
            continue
    return None


def _first_dir(paths: list[Path]) -> Path | None:
    for p in paths:
        try:
            if p.is_dir():
                return p
        except OSError:
            continue
    return None


def _gguf_in(folder: Path, *needles: str) -> Path | None:
    """在目录里找一个名字含关键字的 gguf（取最大的那个）。"""
    try:
        if not folder.is_dir():
            return None
        items = [
            p
            for p in folder.iterdir()
            if p.is_file() and p.suffix.lower() == ".gguf" and all(
                n.lower() in p.name.lower() for n in needles
            )
        ]
    except OSError:
        return None
    if not items:
        return None
    items.sort(key=lambda p: p.stat().st_size, reverse=True)
    return items[0]


def _mb(path: str | None) -> int:
    try:
        return int(Path(path).stat().st_size // (1024 * 1024)) if path else 0
    except OSError:
        return 0


def _guess_exe(*candidates: str) -> str | None:
    for raw in candidates:
        p = Path(raw)
        if p.is_file():
            return str(p)
    return None


def default_models(gpu_index: int = 2) -> tuple[ModelSpec, ...]:
    """按这台机器上实际存在的文件，给出一份能直接跑的注册表。

    探测全部「有就用，没有就留 None」——缺件不算配置错误，preflight 会把它
    列成阻断项，并说清缺的是哪个文件、去哪个目录找。
    """
    desktop = _desktop()
    gguf_dir = desktop / "gguf"
    llama_dir = desktop / "llama"
    # 中文路径进不了这些窄字符可执行文件，成品都留了 ASCII 入口
    s2_root = Path("C:/s2")
    a_tts_root = Path("C:/a-tts")
    comfy_root = _first_dir(
        [
            desktop / "comfyui" / "ComfyUI",
            desktop / "ComfyUI",
            desktop / "comfyui",
        ]
    )
    # ComfyUI 也可以在需要时由本服务自己拉起来（钉在这张卡上，切走就停）。
    # 找得到 Python 解释器 + main.py 才算能托管；否则退回「借用外部实例」。
    comfy_py = _first(
        [
            comfy_root.parent / "python_embeded" / "python.exe",
            comfy_root / "venv" / "Scripts" / "python.exe",
            comfy_root / ".venv" / "Scripts" / "python.exe",
        ]
    ) if comfy_root else None
    comfy_main = comfy_root / "main.py" if comfy_root else None
    comfy_managed = bool(comfy_py and comfy_main and comfy_main.is_file())

    llama_exe = _guess_exe(
        str(llama_dir / "llama-server.exe"),
        "C:/llama/llama-server.exe",
    )
    llama_model = _gguf_in(gguf_dir) or _gguf_in(desktop / "models")

    audiocpp_exe = _guess_exe(
        str(a_tts_root / "audio-cuda13.3" / "audiocpp_server.exe"),
        str(desktop / "语音合成" / "audio-tts" / "audio-cuda13.3" / "audiocpp_server.exe"),
    )
    design_model = (
        _gguf_in(a_tts_root / "models", "voicedesign")
        or _gguf_in(desktop / "语音合成" / "audio-tts" / "models", "voicedesign")
        or _gguf_in(a_tts_root / "models")
    )

    s2_exe = _guess_exe(
        str(s2_root / "app" / "s2.exe"),
        str(desktop / "语音合成" / "app" / "s2.exe"),
    )
    s2_model = _guess_exe(
        str(s2_root / "app" / "s2-pro-q8_0.gguf"),
        str(desktop / "语音合成" / "app" / "s2-pro-q8_0.gguf"),
    )
    s2_tokenizer = _guess_exe(
        str(s2_root / "app" / "tokenizer.json"),
        str(desktop / "语音合成" / "app" / "tokenizer.json"),
    )

    # 端口从 17801 起：躲开 llama 默认 8080、ComfyUI 8188、s2 3030、
    # 剧本台后端 8787 —— 这几个在本机都被人占着
    # 生图与编辑统一走同一份「两步」工作流：Qwen2.1 的生成与编辑本来就是一图两用，
    # 分成两套只会让同一张脸在两条链上跑出两种风格。要换就换这一个名字，
    # 或者用环境变量 MODELHUB_COMFY_WORKFLOW 临时盖掉。
    # 名字写错时当没配（退回"自动挑一个"），不让服务因为一个错别字起不来。
    default_comfy_workflow = (
        os.environ.get("MODELHUB_COMFY_WORKFLOW") or "▶Qwen2.1_2步_生成与编辑"
    ).strip()
    if default_comfy_workflow and comfy_root:
        wf_file = Path(comfy_root) / "user" / "default" / "workflows" / f"{default_comfy_workflow}.json"
        if not wf_file.is_file():
            default_comfy_workflow = ""

    def _qwen21_extra() -> dict[str, Any]:
        """生图：进程内跑 qwen-image 2.1，不启 ComfyUI。

        为什么不像图片编辑那样借/托一个 ComfyUI：
            生图这条链是固定的 6 个节点（加载 → 2 步采样 → 解码），没有分支，
            也不需要用户改图。为它起一个服务、再把 prompt 转回进程里执行，
            只是多一层壳。执行器见 `server/qwen21_inproc.py`，模型名和步骤
            写在这里，跟着工作流文件一起改。
        """
        server_dir = Path(__file__).resolve().parent.parent
        return {
            "python": str(comfy_py) if comfy_py else "",
            "script": str(server_dir / "qwen21_inproc.py"),
            "comfyRoot": str(comfy_root or ""),
            "unet": "qwen_image_2.1_int8_convrot.safetensors",
            "lora": "Qwen-Image-2.1-sarvam-tez-2step-lora-r256.safetensors",
            "clip": "qwen3vl_8b_int8_convrot.safetensors",
            "vae": "qwen_image_2.1_vae_bf16.safetensors",
            "steps": 2,
            "cfg": 1.0,
            "shift": 3.0,
            "timeoutSec": 1800.0,
            "env": {"PYTORCH_CUDA_ALLOC_CONF": "garbage_collection_threshold:0.3"},
        }

    def _comfy_extra(kind: str) -> dict[str, Any]:
        """生图/图片编辑的公共配置。两者共用同一个 ComfyUI 进程、同一份工作流。"""
        return {
            "base": f"http://127.0.0.1:{COMFY_PORT}",
            "root": str(comfy_root or ""),
            # 空 = 工作流目录里第一个合适的（仅当上面那份找不到时才会走到这）
            "workflow": default_comfy_workflow,
            "kind": kind,
            # 托管：生图时由本服务把 ComfyUI 拉起到本卡上，切到别的模型就停掉
            "managed": comfy_managed,
            "python": str(comfy_py) if comfy_py else "",
            "main": str(comfy_main) if comfy_main else "",
            "port": COMFY_PORT,
            # T10 没有 CUDA memory pool：cudaMallocAsync 一用就
            # "operation not supported"，必须关掉（用户自己那份实例也这么启的）
            "args": ["--disable-cuda-malloc"],
            "env": {"PYTORCH_CUDA_ALLOC_CONF": "garbage_collection_threshold:0.3"},
        }

    specs: list[ModelSpec] = [
        ModelSpec(
            id="comfy-image",
            capability="image.generate",
            # 生图不走 ComfyUI：用 ComfyUI 的 python 环境进程内跑一次（qwen21 驱动）。
            # id 沿用旧名，免得前端/调用方按 id 选模型的地方要跟着改。
            driver="qwen21",
            title="Qwen-Image 2.1 · 2 步（进程内）",
            port=0,
            model="qwen_image_2.1_int8_convrot.safetensors",
            health="",
            vram_mb=9000,
            startup_timeout=60.0,
            idle_ttl=0.0,  # 常驻到换组
            extra=_qwen21_extra(),
        ),
        ModelSpec(
            id="comfy-edit",
            capability="image.edit",
            # 编辑和生图是同一份工作流：给了参考图就是编辑（Qwen2.1 一图两用），
            # 所以同样走进程内，不再为它留一个 ComfyUI。
            driver="qwen21",
            title="Qwen-Image 2.1 图片编辑（进程内）",
            port=0,
            model="qwen_image_2.1_int8_convrot.safetensors",
            health="",
            vram_mb=9000,
            startup_timeout=60.0,
            idle_ttl=0.0,  # 常驻到换组
            extra=_qwen21_extra(),
        ),
        ModelSpec(
            id="qwen3-tts-vd",
            capability="voice.design",
            driver="audiocpp",
            title="qwen3-tts 文本设计音色",
            exe=audiocpp_exe,
            model=str(design_model) if design_model else None,
            port=17802,
            startup_timeout=180.0,
            idle_ttl=0.0,  # 常驻到换组
            extra={
                "family": "qwen3_tts",
                "task": "vdes",
                "modelId": "qwen3-vd",
                # audio.cpp 的 --device 是绝对卡号（和 server_qwen3.json 一致）
                "deviceAbsolute": True,
                # 启动即加载：lazy 会让「进程起来了」和「显存占了」脱节
                "lazyLoad": False,
            },
        ),
        ModelSpec(
            id="s2-pro",
            capability="voice.synthesize",
            driver="s2",
            title="s2-pro 固定音色合成",
            exe=s2_exe,
            model=s2_model,
            port=17803,
            startup_timeout=180.0,
            idle_ttl=0.0,  # 常驻到换组
            extra={
                "tokenizer": s2_tokenizer,
                "voiceDir": str(s2_root / "voices" / "packs"),
                "designDir": str(s2_root / "voices" / "design"),
                # s2 的 -c 是绝对卡号，且它自己不走 CUDA_VISIBLE_DEVICES
                "deviceArg": True,
            },
        ),
        ModelSpec(
            id="llama-qwen",
            capability="text.generate",
            driver="llama",
            title="llama.cpp · Qwen3.6-35B-A3B",
            exe=llama_exe,
            model=str(llama_model) if llama_model else None,
            port=17801,
            # 14.3G 权重 + 16k ctx 的 KV，留一点余量
            vram_mb=0,
            startup_timeout=300.0,
            idle_ttl=0.0,  # 常驻到换组
            # ctx 由驱动按 extra.ctx 统一拼；这里再写 -c 会重复（llama.cpp 只认最后一个）
            #
            # `--reasoning off` 是必须的：这个 gguf 是带思考的 Qwen3.6，默认会把
            # 几千 token 全用在 reasoning_content 上，正文 content 是空的 ——
            # 剧本台要的是 JSON，不是推理过程，开着思考只会让每次调用慢十倍、
            # 还因为 finish_reason=length 拿到空串。
            args=("-ngl", "99", "-fa", "auto", "--jinja", "--reasoning", "off"),
            extra={"ctx": 16384},
        ),
    ]
    return tuple(specs)


# ---------------------------------------------------------------- 显存估算


def estimate_vram_mb(spec: ModelSpec) -> int:
    """粗估一个模型占多少显存。

    估算只用来「决定能不能装」，装完会拿 nvidia-smi 的实测值校准。宁可估得
    略高一点（多留余量），但不能把实际能跑的模型判死 —— 所以系数按实测经验
    取，不用最坏情况：

      * llama.cpp：权重 ×1.05（CUDA context + 计算缓冲），KV 按 0.02 MiB/token
        （35B 的 MoE 模型 KV 很小，16k ctx 约 320MB）；
      * s2 / audio.cpp：权重 ×1.1，再留几百兆给编解码。
    """
    if spec.vram_mb > 0:
        return spec.vram_mb
    # ComfyUI 的模型不在我们手里，占用只能实测（它的 pid 在卡上多少就是多少）
    if spec.driver == "comfy":
        return 0
    size_mb = _mb(spec.model)
    if size_mb <= 0:
        # 没文件也没写死：给个下限，preflight 会因为它缺件而先报错
        return 512
    if spec.driver == "llama":
        ctx = int(spec.extra.get("ctx") or 16384)
        kv_mb = max(64, int(ctx * 0.02))
        return int(size_mb * 1.05) + kv_mb
    if spec.driver == "s2":
        return int(size_mb * 1.10) + 256
    if spec.driver == "audiocpp":
        return int(size_mb * 1.08) + 320
    return int(size_mb * 1.05)


# ---------------------------------------------------------------- 配置合并


def _as_list(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, (list, tuple)):
        return [str(x) for x in raw]
    raise ConfigError(f"参数列表只能是字符串或数组，收到 {type(raw).__name__}")


def _spec_from_dict(base: ModelSpec | None, raw: dict[str, Any]) -> ModelSpec:
    if not isinstance(raw, dict):
        raise ConfigError("models 里每一项都得是对象")
    mid = str(raw.get("id") or "").strip()
    if not mid:
        raise ConfigError("模型条目缺 id")
    if base is None:
        cap = str(raw.get("capability") or "").strip()
        if cap not in CAPABILITY_KEYS:
            raise ConfigError(
                f"{mid}: capability 必须是 {'/'.join(CAPABILITY_KEYS)} 之一，收到 {cap!r}"
            )
        base = ModelSpec(
            id=mid,
            capability=cap,
            driver=str(raw.get("driver") or "").strip(),
            title=str(raw.get("title") or mid),
        )
    patch: dict[str, Any] = {"id": mid}
    if "title" in raw:
        patch["title"] = str(raw["title"])
    if "exe" in raw:
        patch["exe"] = str(raw["exe"]).replace("\\", "/") if raw["exe"] else None
    if "model" in raw:
        patch["model"] = str(raw["model"]).replace("\\", "/") if raw["model"] else None
    if "port" in raw:
        patch["port"] = int(raw["port"])
    if "vramMb" in raw:
        patch["vram_mb"] = int(raw["vramMb"])
    if "health" in raw:
        patch["health"] = str(raw["health"])
    if "args" in raw:
        patch["args"] = tuple(_as_list(raw["args"]))
    if "env" in raw:
        if not isinstance(raw["env"], dict):
            raise ConfigError(f"{mid}: env 必须是对象")
        patch["env"] = {str(k): str(v) for k, v in raw["env"].items()}
    if "startupTimeoutSec" in raw:
        patch["startup_timeout"] = float(raw["startupTimeoutSec"])
    if "idleTtlSec" in raw:
        patch["idle_ttl"] = float(raw["idleTtlSec"])
    if "extra" in raw:
        if not isinstance(raw["extra"], dict):
            raise ConfigError(f"{mid}: extra 必须是对象")
        patch["extra"] = {**base.extra, **raw["extra"]}
    return base.with_(**patch)


def load_config(
    path: str | Path | None = None,
    *,
    overrides: dict[str, Any] | None = None,
    runtime_dir: str | None = None,
) -> HubConfig:
    """读配置。优先级：默认探测 < 配置文件 < overrides（CLI/环境变量）。

    配置文件不存在不算错：全默认也能起来，这正是「开箱体检」该有的样子。
    """
    cfg_path = Path(path) if path else DEFAULT_CONFIG_PATH
    raw: dict[str, Any] = {}
    if cfg_path.is_file():
        try:
            raw = json.loads(cfg_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ConfigError(f"配置文件读不了：{cfg_path}（{exc}）") from exc
        if not isinstance(raw, dict):
            raise ConfigError(f"配置文件顶层必须是对象：{cfg_path}")
    if overrides:
        raw = {**raw, **overrides}

    gpu_raw = raw.get("gpu") or {}
    if not isinstance(gpu_raw, dict):
        raise ConfigError("gpu 必须是对象")
    gpu_index = int(os.environ.get("MODELHUB_GPU", gpu_raw.get("index", 2)))
    gpu = GpuConfig(
        index=gpu_index,
        total_mb=int(gpu_raw.get("totalMb") or 0),
        reserve_mb=int(gpu_raw.get("reserveMb") or 768),
        min_free_mb=int(gpu_raw.get("minFreeMb") or 384),
        release_timeout=float(gpu_raw.get("releaseTimeoutSec") or 45.0),
        pin_env=bool(gpu_raw.get("pinEnv", True)),
        exclusive=bool(gpu_raw.get("exclusive", True)),
        swap_wait=float(gpu_raw.get("swapWaitSec", 45.0)),
    )

    defaults = list(default_models(gpu.index))
    by_id = {m.id: m for m in defaults}

    models_raw = raw.get("models")
    if models_raw is None:
        models = defaults
    else:
        if not isinstance(models_raw, list):
            raise ConfigError("models 必须是数组")
        # 配置里的条目：id 命中就覆盖默认，没命中就是新增；再加 "remove": true 删掉
        merged: dict[str, ModelSpec] = dict(by_id)
        for item in models_raw:
            if not isinstance(item, dict):
                raise ConfigError("models 里的条目必须是对象")
            mid = str(item.get("id") or "").strip()
            if not mid:
                raise ConfigError("models 里有一条缺 id")
            if item.get("remove"):
                merged.pop(mid, None)
                continue
            merged[mid] = _spec_from_dict(merged.get(mid), item)
        models = tuple(merged.values())

    # 端口撞车会在启动时变成「第二个起不来」，提前拦住，报错里指出两个模型
    used: dict[int, str] = {}
    for m in models:
        if m.port <= 0:
            continue
        if m.port in used:
            raise ConfigError(
                f"端口 {m.port} 被 {used[m.port]} 和 {m.id} 同时占了；模型端口必须互不相同"
            )
        used[m.port] = m.id

    port = int(os.environ.get("MODELHUB_PORT", raw.get("port", DEFAULT_PORT)))
    host = str(raw.get("host") or "127.0.0.1")
    return HubConfig(
        gpu=gpu,
        models=models,
        port=port,
        host=host,
        runtime_dir=str(runtime_dir or os.environ.get("MODELHUB_RUNTIME") or DEFAULT_RUNTIME_DIR),
        gc_interval=float(raw.get("gcIntervalSec") or 15.0),
        load_timeout=float(raw.get("loadTimeoutSec") or 300.0),
        event_limit=int(raw.get("eventLimit") or 400),
    )


def write_example(path: str | Path, cfg: HubConfig | None = None) -> Path:
    """把当前（含探测结果）配置落成一份可编辑的 JSON，方便改路径/端口。"""
    cfg = cfg or load_config()
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    body = cfg.to_dict()
    body["_说明"] = (
        "这份文件是 modelhub 的默认配置快照。改完重启服务生效。"
        "models 里的条目按 id 合并：写同名 id 就是覆盖，没写过的是新增，"
        "带 \"remove\": true 是删掉。gpu.index 决定整份服务只用哪一张卡。"
    )
    p.write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
    return p
