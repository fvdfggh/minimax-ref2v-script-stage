"""量内存的探针（不是单测，不会被 discover 收走）。

为什么要它：这份服务的「内存占用」在日志里看不见 —— 它不常驻模型，平时只有
几十 MB，但**一次大请求就能把工作集推到几百 MB，而且落回来很慢**（大块走的是
malloc，CPython 不一定把页还给系统）。想知道是「请求体三份副本」还是「响应里
base64 又 json 又 encode」还是「tail() 整份读日志」，只能一个场景一个场景量。

跑法（在 server/ 下）：

    python -m modelhub.tests.probe_mem            # 全部场景
    python -m modelhub.tests.probe_mem body       # 只跑某一个

每个场景都报三个数：基线工作集、**采样峰值**、结束后的工作集。峰值是另起一个
10 ms 采样线程取的 —— 请求中途的瞬时尖峰在场景结束时早就还回去了。
"""

from __future__ import annotations

import ctypes
import gc
import json
import os
import sys
import tempfile
import threading
import time
import urllib.request
from ctypes import wintypes
from pathlib import Path
from typing import Any, Callable

MIB = 1 << 20


# ---------------------------------------------------------------- 工作集

class _PMC(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("PageFaultCount", wintypes.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


def _bind() -> tuple[Any, Any]:
    """把 K32/psapi 的签名钉死。

    不声明 restype 的话 `GetCurrentProcess()` 按 32 位 int 返回 -1，传下去就成了
    0x00000000FFFFFFFF —— 不是那块伪句柄（0xFFFFFFFFFFFFFFFF），于是
    GetProcessMemoryInfo 直接返回 0，量出来永远是 0.0 MiB。
    """
    k32 = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi
    k32.GetCurrentProcess.restype = wintypes.HANDLE
    k32.GetCurrentProcess.argtypes = []
    psapi.GetProcessMemoryInfo.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(_PMC),
        wintypes.DWORD,
    ]
    psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
    return k32, psapi


_K32, _PSAPI = _bind() if os.name == "nt" else (None, None)


def rss_mib() -> float:
    """当前进程的工作集（MiB）。Windows 专用 —— 这份服务本来也只在 Windows 上跑。"""
    if os.name != "nt":
        return 0.0
    pmc = _PMC()
    pmc.cb = ctypes.sizeof(_PMC)
    handle = _K32.GetCurrentProcess()
    if not _PSAPI.GetProcessMemoryInfo(handle, ctypes.byref(pmc), ctypes.sizeof(_PMC)):
        raise OSError(f"GetProcessMemoryInfo 失败：{ctypes.GetLastError()}")
    return pmc.WorkingSetSize / MIB


class Peak:
    """10 ms 采样工作集，记峰值。用 with。"""

    def __init__(self, interval: float = 0.01):
        self.interval = interval
        self.peak = rss_mib()
        self.base = self.peak
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def __enter__(self) -> "Peak":
        self.base = rss_mib()
        self.peak = self.base

        def loop() -> None:
            while not self._stop.is_set():
                v = rss_mib()
                if v > self.peak:
                    self.peak = v
                time.sleep(self.interval)

        self._thread = threading.Thread(target=loop, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.0)


def _row(label: str, base: float, peak: float, after: float, note: str = "") -> str:
    return (
        f"{label:<34} 基线 {base:7.1f}  峰值 {peak:7.1f}  "
        f"涨 {peak - base:7.1f}  之后 {after:7.1f}  {note}"
    )


def measure(label: str, fn: Callable[[], Any], *, note: str = "") -> dict[str, float]:
    gc.collect()
    with Peak() as p:
        out = fn()
    after = rss_mib()
    print(_row(label, p.base, p.peak, after, note), flush=True)
    del out
    gc.collect()
    return {"base": p.base, "peak": p.peak, "after": after}


# ---------------------------------------------------------------- 场景


def case_object_info() -> None:
    """ComfyUI /object_info 解析后常驻多少。

    这份缓存是 `imagegen._object_info_cache`，TTL 只管「多久重拉」，**从不淘汰** ——
    2045 个节点的定义解析完就是一坨常驻字典。
    """
    raw_path = Path(tempfile.gettempdir()) / "modelhub_object_info.json"
    if not raw_path.is_file():
        print(f"  跳过：没有样本 {raw_path}（先跑 tests/fetch_object_info.py 或手工存一份）")
        return
    raw = raw_path.read_bytes()
    print(f"  样本 {len(raw) / MIB:.2f} MiB / {len(raw)} 字节")

    def run() -> dict:
        return json.loads(raw)

    measure("object_info 解析一次", run, note="解析后约 15 MiB；靠 _prune_object_info 淘汰")


def case_tail() -> None:
    """tail(40) 在多大的日志上会吃掉多少。

    `ManagedProc.tail` 是 `log_path.read_bytes()` 整份读 —— 一个跑了半天的
    llama-server 日志上几十 MB，这一下就是「读全份 + decode + splitlines」三份。
    """
    from modelhub.procs import ManagedProc

    size_mb = 128
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "big.log"
        line = "slot launch_model_with_ms: n_tokens = 128, batch = 512, time = 12.3 ms\n"
        reps = size_mb * MIB // len(line)
        with open(p, "wb") as fh:
            fh.write(line.encode() * reps)
        real = p.stat().st_size / MIB
        print(f"  日志 {real:.1f} MiB")

        # wait_ready 失败时、/v1/models/{id}/logs 每次都会走这里
        proc = ManagedProc("fake", ["x"], cwd=None, env={}, log_path=p)

        def run() -> str:
            return proc.tail(40)

        measure(f"tail(40) @ {real:.0f} MiB 日志", run, note="只读尾部 ≈ 64 KiB/块")


def case_body() -> None:
    """请求体的三份副本。

    `Handler._body` 现在是：
        raw = self.rfile.read(n)      # ① n 字节
        data = json.loads(raw.decode())  # ② decode 出一份 str，③ 再解析成对象
    一张 24 MB 的参考图（base64 后 32 MB）同时存在三份。
    """
    img = os.urandom(24 * MIB)
    import base64

    body_mb = float(os.environ.get("PROBE_BODY_MB", "0") or 0)
    if body_mb:
        # 直接按「整个请求体 N MiB」造：用 base64 塞满，形状和真请求一致
        raw_len = int(body_mb * MIB * 3 / 4) - 4096
        pad = base64.b64encode(os.urandom(raw_len)).decode("ascii")
        body = json.dumps(
            {"capability": "image.edit", "input": {"prompt": "x", "images": [pad]}}
        ).encode("utf-8")
        print(f"  请求体 {len(body) / MIB:.2f} MiB（按 PROBE_BODY_MB 造）")
        del pad
    else:
        b64 = base64.b64encode(img).decode("ascii")
        body = json.dumps(
            {"capability": "image.edit", "input": {"prompt": "x", "images": [b64]}}
        ).encode("utf-8")
        print(f"  请求体 {len(body) / MIB:.2f} MiB（参考图 24 MiB → base64 {len(b64) / MIB:.2f} MiB）")
        del b64
    del img

    def old() -> Any:
        raw = body
        text = raw.decode("utf-8", "replace")
        return json.loads(text)

    measure("_body 现在（read + decode + parse）", old, note="峰值 ≈ 2× 请求体（协议决定的）")

    gc.collect()

    def new() -> Any:
        # 曾经想「json.loads 直接吃 bytes 省一份 str」—— 实测**没用**：
        # 它内部照样 decode 出一份临时 str，峰值一模一样（+64.0 对 +64.0）。
        # 写在这里是为了别让下一个人再试一遍。
        return json.loads(body)

    measure("json.loads(bytes) 直吃（实测无收益）", new, note="别改，白费劲")

    # 解析完立刻把 base64 扔掉（模拟「解码成 bytes 后马上释放字符串」）
    gc.collect()

    def free_early() -> Any:
        d = json.loads(body)
        b = base64.b64decode(d["input"]["images"][0])
        d["input"]["images"] = None
        return b

    measure("解码后立刻释放 base64", free_early, note="稳态只留 bytes")


def case_http_image() -> None:
    """端到端：一次生图请求，响应里那张图被复制了几份。"""
    from modelhub.config import GpuConfig, HubConfig, ModelSpec
    from modelhub.drivers import InvokeResult, Loaded
    from modelhub.http_api import make_server
    from modelhub.scheduler import Hub

    img_mb = 2
    count = int(os.environ.get("PROBE_BATCH", "1"))
    payload_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * (img_mb * MIB - 8)

    class Gpu:
        index = 0
        available = True

        def stats(self):
            from modelhub.gpu import GpuStats

            return GpuStats(0, "probe", 16384, 0, 16384, "u")

        def processes(self):
            return []

        def procs_on_mine(self, stats=None):
            return []

        def used_by_others(self, own, stats=None):
            return 0

        def pid_on_mine(self, pid, stats=None):
            return True

        def mb_of_pid(self, pid, stats=None):
            return 1024

        def wait_free(self, need, *, timeout=45.0, own_pids=None, poll=0.6):
            return True, self.stats()

    class Drv:
        name = "probe"
        manages_process = True
        uses_gpu = True

        def check(self, *a, **k):
            return []

        def start(self, spec, cfg, gpu):
            return Loaded(pid=4242, port=0, external=False, meta={}, real_vram_mb=1024)

        def stop(self, *a, **k):
            return None

        def health(self, *a, **k):
            return True, ""

        def invoke(self, spec, loaded, payload, cfg):
            if count > 1:
                items = [
                    {"key": str(i), "image": payload_bytes, "mime": "image/png"}
                    for i in range(count)
                ]
                return InvokeResult("images", items, "image/png", {})
            return InvokeResult("image", payload_bytes, "image/png", {})

    spec = ModelSpec(
        id="probe", capability="image.generate", driver="probe", title="探针",
        idle_ttl=0,
    )
    cfg = HubConfig(
        gpu=GpuConfig(index=0, total_mb=16384),
        models=(spec,),
        port=0,
        runtime_dir=tempfile.mkdtemp(prefix="modelhub-probe-"),
    )
    hub = Hub(cfg, gpu=Gpu(), drivers={"probe": Drv()})
    srv = make_server(hub, "127.0.0.1", 0)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    body = json.dumps(
        {"capability": "image.generate", "input": {"prompt": "猫"}}
    ).encode()
    label = (
        f"HTTP 出图 {count}×{img_mb} MiB（json+b64）"
        if count > 1 else f"HTTP 出图 {img_mb} MiB（json+b64）"
    )

    def run() -> int:
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/v1/run",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        # 只读不解析：客户端和服务端在同一个进程里，解析出来的对象会算进峰值，
        # 那就量不准服务端了。JSON 的正确性由 test_hub 的流式响应用例守。
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
            declared = int(resp.headers.get("Content-Length") or -1)
        assert declared == len(raw), (declared, len(raw))
        return len(raw)

    measure(label, run, note="边编码边写，服务端峰值 ≈ 一段")
    srv.shutdown()
    hub.close()


def case_polling() -> None:
    """控制台每 8 秒一次 /v1/status，跑 100 次看会不会爬。"""
    from modelhub.config import GpuConfig, HubConfig, ModelSpec
    from modelhub.scheduler import Hub

    class Gpu:
        index = 2
        available = True

        def stats(self):
            from modelhub.gpu import GpuStats

            return GpuStats(2, "probe", 16384, 0, 16384, "u")

        def processes(self):
            return []

        def procs_on_mine(self, stats=None):
            return []

        def used_by_others(self, own, stats=None):
            return 0

        def pid_on_mine(self, pid, stats=None):
            return True

        def mb_of_pid(self, pid, stats=None):
            return 0

        def wait_free(self, need, *, timeout=45.0, own_pids=None, poll=0.6):
            return True, self.stats()

        def to_dict(self):
            return {"index": 2, "singleCard": True}

    spec = ModelSpec(id="probe", capability="image.generate", driver="probe", title="探针")
    cfg = HubConfig(
        gpu=GpuConfig(index=2, total_mb=16384),
        models=(spec,),
        runtime_dir=tempfile.mkdtemp(prefix="modelhub-probe-"),
    )
    hub = Hub(cfg, gpu=Gpu(), drivers={})

    def run() -> int:
        n = 0
        for _ in range(100):
            hub.status()
            n += 1
        return n

    measure("/v1/status ×100（控制台 8s 轮询）", run)


def case_soak() -> None:
    """反复请求 60 次，看 RSS 是「涨完就落」还是「一次比一次高」。

    瞬时尖峰可以靠少复制来压；但如果是泄漏（每请求留一点），压峰值没用 ——
    得先把它找出来。这里每 10 次打一个点。
    """
    from modelhub.config import GpuConfig, HubConfig, ModelSpec
    from modelhub.drivers import InvokeResult, Loaded
    from modelhub.http_api import make_server
    from modelhub.scheduler import Hub

    payload_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * (2 * MIB - 8)

    class Gpu:
        index = 0
        available = True

        def stats(self):
            from modelhub.gpu import GpuStats

            return GpuStats(0, "probe", 16384, 0, 16384, "u")

        def processes(self):
            return []

        def procs_on_mine(self, stats=None):
            return []

        def used_by_others(self, own, stats=None):
            return 0

        def pid_on_mine(self, pid, stats=None):
            return True

        def mb_of_pid(self, pid, stats=None):
            return 1024

        def wait_free(self, need, *, timeout=45.0, own_pids=None, poll=0.6):
            return True, self.stats()

    class Drv:
        name = "probe"
        manages_process = True
        uses_gpu = True

        def check(self, *a, **k):
            return []

        def start(self, spec, cfg, gpu):
            return Loaded(pid=4242, port=0, external=False, meta={}, real_vram_mb=1024)

        def stop(self, *a, **k):
            return None

        def health(self, *a, **k):
            return True, ""

        def invoke(self, spec, loaded, payload, cfg):
            return InvokeResult("image", payload_bytes, "image/png", {})

    spec = ModelSpec(id="probe", capability="image.generate", driver="probe", title="探针", idle_ttl=0)
    cfg = HubConfig(
        gpu=GpuConfig(index=0, total_mb=16384),
        models=(spec,),
        runtime_dir=tempfile.mkdtemp(prefix="modelhub-probe-"),
    )
    hub = Hub(cfg, gpu=Gpu(), drivers={"probe": Drv()})
    srv = make_server(hub, "127.0.0.1", 0)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    body = json.dumps({"capability": "image.generate", "input": {"prompt": "x"}}).encode()
    print(f"  {'第几次':>6}  {'工作集 MiB':>10}")
    for i in range(1, 61):
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/v1/run", data=body,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            resp.read()
        if i % 10 == 0:
            gc.collect()
            print(f"  {i:>6}  {rss_mib():>10.1f}", flush=True)
    srv.shutdown()
    hub.close()


CASES = {
    "object_info": case_object_info,
    "tail": case_tail,
    "body": case_body,
    "image": case_http_image,
    "soak": case_soak,
    "poll": case_polling,
}


def main(argv: list[str]) -> int:
    if os.name != "nt":
        print("这个探针读 Windows 工作集，别的平台跑不出数")
        return 2
    want = argv[1:] or list(CASES)
    print(f"进程起始工作集 {rss_mib():.1f} MiB；Python {sys.version.split()[0]}")
    for name in want:
        fn = CASES.get(name)
        if not fn:
            print(f"没有这个场景：{name}（可选 {', '.join(CASES)}）")
            continue
        print(f"\n== {name} ==", flush=True)
        try:
            fn()
        except Exception as exc:  # noqa: BLE001
            import traceback

            traceback.print_exc()
            print(f"  场景 {name} 出错：{exc!r}")
    print(f"\n结束工作集 {rss_mib():.1f} MiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
