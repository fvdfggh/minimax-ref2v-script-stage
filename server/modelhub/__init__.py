"""单卡模型前置服务。

一句话：**一张卡、五类能力、调谁装谁。**

    from modelhub import load_config, Hub

    hub = Hub(load_config())
    hub.start()
    print(hub.preflight()["ok"])
    with hub.lease("text.generate") as (spec, loaded):
        ...  # loaded.port 就是 llama-server 的端口
    hub.close()

命令行：`python -m modelhub serve`（详见 README）
"""

from __future__ import annotations

from .config import (
    CAPABILITIES,
    CAPABILITY_KEYS,
    HubConfig,
    ModelSpec,
    estimate_vram_mb,
    load_config,
    write_example,
)
from .gpu import Gpu, GpuError
from .scheduler import Hub, HubError

__all__ = [
    "CAPABILITIES",
    "CAPABILITY_KEYS",
    "Gpu",
    "GpuError",
    "Hub",
    "HubConfig",
    "HubError",
    "ModelSpec",
    "estimate_vram_mb",
    "load_config",
    "write_example",
]
__version__ = "1.0.0"
