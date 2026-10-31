"""单卡调度与配置的单测。不碰真显卡、不拉真进程。

跑法（在 server/ 下）：
    python -m unittest discover -s modelhub/tests -t .
或：
    python -m unittest modelhub.tests.test_hub
"""

from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

from modelhub.config import (
    GpuConfig,
    HubConfig,
    ModelSpec,
    estimate_vram_mb,
    load_config,
)
from modelhub.drivers import InvokeResult, Loaded
from modelhub.gpu import GpuProc, GpuStats
from modelhub.scheduler import Hub, HubError


# ---------------------------------------------------------------- 假件


class FakeGpu:
    """只实现调度器用得到的那几个方法。"""

    def __init__(self, total: int = 16384, others: int = 0, index: int = 0):
        self.index = index
        self.total = total
        self.others = others
        self.pids: dict[int, int] = {}
        self.available = True
        self.on_card: set[int] = set()

    def stats(self) -> GpuStats:
        used = self.others + sum(self.pids.values())
        return GpuStats(self.index, "Fake T10", self.total, used, self.total - used, "fake-uuid")

    def processes(self) -> list[GpuProc]:
        return [GpuProc(pid, mb, "fake-uuid") for pid, mb in self.pids.items()]

    def procs_on_mine(self, stats: GpuStats | None = None) -> list[GpuProc]:
        return self.processes()

    def used_by_others(self, own_pids: set[int], stats: GpuStats | None = None) -> int:
        return self.others

    def pid_on_mine(self, pid: int, stats: GpuStats | None = None) -> bool:
        return pid in self.pids

    def mb_of_pid(self, pid: int, stats: GpuStats | None = None) -> int:
        return self.pids.get(pid, 0)

    def wait_free(self, need: int, *, timeout: float = 45.0, own_pids=None, poll: float = 0.6):
        return True, self.stats()

    def to_dict(self):
        return {"index": self.index, "singleCard": True}


class FakeDriver:
    name = "fake"
    manages_process = True
    uses_gpu = True

    def __init__(self, gpu: FakeGpu, fail: str | None = None):
        self.gpu = gpu
        self.fail = fail
        self.started: list[str] = []
        self.stopped: list[str] = []
        self.invoked: list[tuple[str, dict]] = []
        self._pid = 1000

    def check(self, spec, cfg, gpu):
        return []

    def start(self, spec, cfg, gpu):
        if self.fail:
            raise RuntimeError(self.fail)
        self._pid += 1
        mb = estimate_vram_mb(spec)
        self.gpu.pids[self._pid] = mb
        self.started.append(spec.id)
        return Loaded(pid=self._pid, port=spec.port, meta={}, real_vram_mb=mb)

    def stop(self, spec, loaded, cfg, gpu):
        self.stopped.append(spec.id)
        self.gpu.pids.pop(loaded.pid, None)

    def health(self, spec, loaded, cfg):
        return True, "fake"

    def invoke(self, spec, loaded, payload, cfg):
        self.invoked.append((spec.id, payload))
        return InvokeResult("json", {"echo": payload, "model": spec.id})


def make_spec(
    mid: str, cap: str = "text.generate", *, vram: int = 4000, ttl: float = 900, group: str | None = None
) -> ModelSpec:
    # 假模型默认**各自成组**：这些用例测的是「换类型就驱逐」，而真实配置里
    # 同 capability 的两档（比如两个生图工作流）本来就同组、不该互斥。
    # 要测同组共存的用例显式传同一个 group。
    return ModelSpec(
        id=mid,
        capability=cap,
        driver="fake",
        title=f"模型 {mid}",
        port=0,
        vram_mb=vram,
        idle_ttl=ttl,
        group=group if group is not None else mid,
    )


def make_hub(
    specs: list[ModelSpec], gpu: FakeGpu, tmp: str, *, exclusive: bool = True, swap_wait: float = 0.0
) -> tuple[Hub, FakeDriver]:
    cfg = HubConfig(
        gpu=GpuConfig(
            index=0, reserve_mb=768, min_free_mb=384, exclusive=exclusive, swap_wait=swap_wait
        ),
        models=tuple(specs),
        runtime_dir=tmp,
        gc_interval=0,
    )
    drv = FakeDriver(gpu)
    hub = Hub(cfg, gpu=gpu, drivers={"fake": drv})
    hub.start()
    return hub, drv


# ---------------------------------------------------------------- 估算


class EstimateTest(unittest.TestCase):
    def test_explicit_wins(self):
        spec = make_spec("a", vram=1234)
        self.assertEqual(estimate_vram_mb(spec), 1234)

    def test_comfy_is_zero(self):
        spec = ModelSpec(id="c", capability="image.generate", driver="comfy", title="c")
        self.assertEqual(estimate_vram_mb(spec), 0)

    def test_gguf_size_drives_llama(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "m.gguf"
            p.write_bytes(b"x" * (100 * 1024 * 1024))
            spec = ModelSpec(
                id="l", capability="text.generate", driver="llama", title="l",
                exe=str(p), model=str(p), extra={"ctx": 16384},
            )
            est = estimate_vram_mb(spec)
            # 100MB × 1.05 + 16k ctx 的 KV（约 327MB）
            self.assertGreater(est, 100)
            self.assertLess(est, 600)

    def test_missing_file_has_floor(self):
        spec = ModelSpec(id="x", capability="text.generate", driver="llama", title="x", model="")
        self.assertEqual(estimate_vram_mb(spec), 512)


# ---------------------------------------------------------------- 配置


class ConfigTest(unittest.TestCase):
    def test_defaults_have_five_capabilities(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = load_config(Path(d) / "nope.json", overrides={"gpu": {"index": 2}})
            caps = {m.capability for m in cfg.models}
            self.assertEqual(
                caps,
                {"image.generate", "image.edit", "voice.design", "voice.synthesize", "text.generate"},
            )
            self.assertEqual(cfg.gpu.index, 2)

    def test_port_conflict_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            conf = Path(d) / "c.json"
            conf.write_text(
                json.dumps(
                    {
                        "models": [
                            {"id": "a", "capability": "voice.design", "driver": "audiocpp",
                             "title": "a", "port": 17900},
                            {"id": "b", "capability": "voice.synthesize", "driver": "s2",
                             "title": "b", "port": 17900},
                        ]
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaises(Exception) as ctx:
                load_config(conf)
            self.assertIn("端口", str(ctx.exception))

    def test_patch_and_remove(self):
        with tempfile.TemporaryDirectory() as d:
            conf = Path(d) / "c.json"
            conf.write_text(
                json.dumps(
                    {
                        "models": [
                            {"id": "llama-qwen", "vramMb": 9999, "port": 17811},
                            {"id": "s2-pro", "remove": True},
                        ]
                    }
                ),
                encoding="utf-8",
            )
            cfg = load_config(conf)
            llama = cfg.model("llama-qwen")
            self.assertEqual(llama.vram_mb, 9999)
            self.assertEqual(llama.port, 17811)
            # 其余字段没被抹掉
            self.assertTrue(llama.capability == "text.generate")
            self.assertIsNone(cfg.model("s2-pro"))

    def test_bad_capability(self):
        with tempfile.TemporaryDirectory() as d:
            conf = Path(d) / "c.json"
            conf.write_text(
                json.dumps({"models": [{"id": "x", "capability": "画图", "driver": "comfy"}]}),
                encoding="utf-8",
            )
            with self.assertRaises(Exception) as ctx:
                load_config(conf)
            self.assertIn("capability", str(ctx.exception))


# ---------------------------------------------------------------- 调度


class SchedulerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="modelhub-test-")
        self.gpu = FakeGpu()
        self.a = make_spec("a", vram=8000)
        self.b = make_spec("b", vram=9000)
        self.hub, self.drv = make_hub([self.a, self.b], self.gpu, self.tmp)

    def tearDown(self):
        self.hub.close()

    def test_single_card_evicts_lru(self):
        self.hub.acquire("text.generate", "a")
        self.hub.release("a")
        self.assertEqual(self.drv.started, ["a"])
        # b 装不下 → 必须把 a 卸掉
        self.hub.acquire("text.generate", "b")
        self.hub.release("b")
        self.assertEqual(self.drv.stopped, ["a"])
        self.assertEqual(self.drv.started, ["a", "b"])
        self.assertEqual(self.hub._slots["a"].state, "idle")  # noqa: SLF001
        self.assertEqual(self.hub._slots["b"].state, "ready")  # noqa: SLF001

    def test_shared_refs(self):
        loaded1 = self.hub.acquire("text.generate", "a")
        loaded2 = self.hub.acquire("text.generate", "a")
        self.assertIs(loaded1, loaded2)
        self.assertEqual(self.drv.started, ["a"])
        self.assertEqual(self.hub._slots["a"].refs, 2)  # noqa: SLF001
        self.hub.release("a")
        self.assertEqual(self.hub._slots["a"].refs, 1)  # noqa: SLF001
        with self.assertRaises(HubError) as ctx:
            self.hub.unload("a")
        self.assertEqual(ctx.exception.status, 409)
        self.hub.release("a")
        self.hub.unload("a")
        self.assertEqual(self.drv.stopped, ["a"])

    def test_busy_model_blocks_new_load(self):
        # a 占 8000，b 要 9000，总 16384-768：卸了 a 也才 15616-? 够；但 a 在用
        self.hub.acquire("text.generate", "a")
        with self.assertRaises(HubError) as ctx:
            self.hub.acquire("text.generate", "b")
        self.assertEqual(ctx.exception.status, 409)
        self.assertIn("正在被调用", str(ctx.exception))
        self.assertEqual(self.hub._slots["b"].state, "error")  # noqa: SLF001

    def test_idle_gc(self):
        short = make_spec("c", vram=1000, ttl=0.01)
        hub, drv = make_hub([short], FakeGpu(), tempfile.mkdtemp(prefix="modelhub-gc-"))
        try:
            hub.acquire("text.generate", "c")
            hub.release("c")
            time.sleep(0.05)
            victims = hub.gc()
            self.assertEqual(victims, ["c"])
            self.assertEqual(drv.stopped, ["c"])
        finally:
            hub.close()

    def test_load_failure_marks_error_and_retries(self):
        spec = make_spec("d", vram=1000)
        gpu = FakeGpu()
        cfg = HubConfig(
            gpu=GpuConfig(index=0), models=(spec,), runtime_dir=self.tmp, gc_interval=0
        )
        drv = FakeDriver(gpu, fail="显存炸了")
        hub = Hub(cfg, gpu=gpu, drivers={"fake": drv})
        hub.start()
        try:
            with self.assertRaises(HubError) as ctx:
                hub.acquire("text.generate", "d")
            self.assertIn("显存炸了", str(ctx.exception))
            self.assertEqual(hub._slots["d"].state, "error")  # noqa: SLF001
            # 修好之后能重试
            drv.fail = None
            hub.acquire("text.generate", "d")
            self.assertEqual(hub._slots["d"].state, "ready")  # noqa: SLF001
        finally:
            hub.close()

    def test_run_invokes_and_returns(self):
        res = self.hub.run("text.generate", {"prompt": "hi"})
        self.assertTrue(res["ok"])
        self.assertEqual(res["model"], "a")
        self.assertEqual(res["data"]["echo"], {"prompt": "hi"})
        self.assertEqual(res["kind"], "json")

    def test_unknown_model_or_capability(self):
        with self.assertRaises(HubError) as ctx:
            self.hub.acquire("image.generate", "a")  # a 是文本模型
        self.assertEqual(ctx.exception.status, 400)
        with self.assertRaises(HubError) as ctx:
            self.hub.acquire("voice.unknown")
        self.assertEqual(ctx.exception.status, 400)
        with self.assertRaises(HubError) as ctx:
            self.hub.acquire("text.generate", "nope")
        self.assertEqual(ctx.exception.status, 404)


# ---------------------------------------------------------------- 体检


class PreflightTest(unittest.TestCase):
    def test_ok_when_it_fits(self):
        gpu = FakeGpu(total=16384)
        hub, _ = make_hub([make_spec("a", vram=4000)], gpu, tempfile.mkdtemp())
        try:
            out = hub.preflight(["text.generate"])
            self.assertTrue(out["ok"], out)
            self.assertEqual(out["gpu"]["index"], 0)
        finally:
            hub.close()

    def test_blocked_when_too_big(self):
        gpu = FakeGpu(total=4096)
        hub, _ = make_hub([make_spec("a", vram=8000)], gpu, tempfile.mkdtemp())
        try:
            out = hub.preflight(["text.generate"])
            self.assertFalse(out["ok"])
            codes = [b["code"] for b in out["blockers"]]
            self.assertIn("vram.insufficient", codes)
        finally:
            hub.close()

    def test_missing_binary_blocks(self):
        gpu = FakeGpu()
        spec = ModelSpec(
            id="l", capability="text.generate", driver="llama", title="l",
            exe="C:/definitely/not/here/llama-server.exe",
            model="C:/definitely/not/here/m.gguf",
        )
        hub, _ = make_hub([spec], gpu, tempfile.mkdtemp())
        try:
            out = hub.preflight(["text.generate"])
            self.assertFalse(out["ok"])
            codes = {b["code"] for b in out["blockers"]}
            self.assertIn("exe.missing", codes)
            self.assertIn("model.missing", codes)
        finally:
            hub.close()

    def test_no_model_for_capability(self):
        gpu = FakeGpu()
        hub, _ = make_hub([make_spec("a", "text.generate", vram=1000)], gpu, tempfile.mkdtemp())
        try:
            out = hub.preflight(["image.generate"])
            self.assertFalse(out["ok"])
            self.assertEqual(out["blockers"][0]["code"], "model.none")
        finally:
            hub.close()

    def test_will_evict_plan(self):
        gpu = FakeGpu()
        hub, drv = make_hub(
            [make_spec("a", vram=8000), make_spec("b", vram=9000)], gpu, tempfile.mkdtemp()
        )
        try:
            hub.acquire("text.generate", "a")
            hub.release("a")
            out = hub.preflight(["text.generate"], models={"text.generate": "b"})
            row = out["capabilities"][0]
            self.assertEqual([x["id"] for x in row["willEvict"]], ["a"])
            self.assertTrue(out["ok"], out)
        finally:
            hub.close()


# ---------------------------------------------------------------- 轮转


class RotationTest(unittest.TestCase):
    """「轮流使用」：轮到谁就把谁搬到卡上，卡上只留一个。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="modelhub-rot-")
        self.gpu = FakeGpu()
        # 两个都能装进 16G（2000 + 5000 ≪ 15616）—— 共享模式会都留着
        self.a = make_spec("a", "voice.design", vram=2000)
        self.b = make_spec("b", "voice.synthesize", vram=5000)

    def test_only_one_stays_even_when_both_fit(self):
        hub, drv = make_hub([self.a, self.b], self.gpu, self.tmp)
        try:
            hub.acquire("voice.design", "a")
            hub.release("a")
            hub.acquire("voice.synthesize", "b")
            hub.release("b")
            self.assertEqual(drv.stopped, ["a"])
            st = hub.status()
            self.assertEqual([h["id"] for h in st["rotation"]["hot"]], ["b"])
            self.assertEqual(st["rotation"]["swaps"], 1)
            self.assertEqual(st["rotation"]["last"]["from"], ["a"])
            self.assertEqual(st["rotation"]["last"]["to"], "b")
            self.assertEqual(hub._slots["a"].state, "idle")  # noqa: SLF001
        finally:
            hub.close()

    def test_shared_mode_keeps_both(self):
        hub, drv = make_hub([self.a, self.b], FakeGpu(), tempfile.mkdtemp(), exclusive=False)
        try:
            hub.acquire("voice.design", "a")
            hub.release("a")
            hub.acquire("voice.synthesize", "b")
            hub.release("b")
            self.assertEqual(drv.stopped, [])
            self.assertEqual(len(hub.status()["rotation"]["hot"]), 2)
        finally:
            hub.close()

    def test_waits_for_busy_then_refuses(self):
        hub, _ = make_hub([self.a, self.b], FakeGpu(), tempfile.mkdtemp(), swap_wait=0.4)
        try:
            hub.acquire("voice.design", "a")
            t0 = time.monotonic()
            with self.assertRaises(HubError) as ctx:
                hub.acquire("voice.synthesize", "b")
            waited = time.monotonic() - t0
            self.assertEqual(ctx.exception.status, 409)
            self.assertIn("正在被调用", str(ctx.exception))
            # 先等一会儿再拒，而不是立刻把调用方踢回去
            self.assertGreaterEqual(waited, 0.35)
            hub.release("a")
        finally:
            hub.close()

    def test_same_comfy_process_is_not_evicted(self):
        """生图和图片编辑共用一份 ComfyUI，不能互相卸。"""
        specs = [
            ModelSpec(
                id="ci", capability="image.generate", driver="comfy", title="生图",
                extra={"base": "http://127.0.0.1:17804"},
            ),
            ModelSpec(
                id="ce", capability="image.edit", driver="comfy", title="图片编辑",
                extra={"base": "http://127.0.0.1:17804"},
            ),
        ]
        gpu = FakeGpu()
        cfg = HubConfig(
            gpu=GpuConfig(index=0, exclusive=True, swap_wait=0),
            models=tuple(specs),
            runtime_dir=tempfile.mkdtemp(),
            gc_interval=0,
        )
        drv = FakeDriver(gpu)
        hub = Hub(cfg, gpu=gpu, drivers={"comfy": drv})
        hub.start()
        try:
            hub.acquire("image.generate", "ci")
            hub.release("ci")
            hub.acquire("image.edit", "ce")
            hub.release("ce")
            self.assertEqual(drv.stopped, [])
            self.assertEqual(len(hub.status()["rotation"]["hot"]), 2)
        finally:
            hub.close()

    def test_preflight_predicts_the_swap(self):
        hub, _ = make_hub([self.a, self.b], self.gpu, tempfile.mkdtemp())
        try:
            hub.acquire("voice.design", "a")
            hub.release("a")
            out = hub.preflight(["voice.synthesize"])
            row = out["capabilities"][0]
            self.assertEqual([x["id"] for x in row["willEvict"]], ["a"])
            # 严格轮转下"要卸谁"不是显存不够才出现，而是必然发生
            self.assertTrue(any(c["code"] == "swap.plan" for c in row["checks"]))
        finally:
            hub.close()


# ---------------------------------------------------------------- 内存：日志尾


class TailTest(unittest.TestCase):
    """`ManagedProc.tail` 只读尾部。

    这条不是小事：老实现 `read_bytes()` 整份读，128 MiB 的日志上实测把工作集
    从 31.8 MiB 顶到 517.4 MiB。跑一天的 llama-server 日志轻松上百 MB，
    而这里只要最后几十行。
    """

    def _proc(self, path: Path) -> "object":
        from modelhub.procs import ManagedProc

        return ManagedProc("t", ["x"], cwd=None, env={}, log_path=path)

    def test_returns_last_lines_of_a_big_file(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "big.log"
            with open(p, "wb") as fh:
                for i in range(200000):
                    fh.write(f"line {i}\n".encode())
            proc = self._proc(p)
            got = proc.tail(40).splitlines()
            self.assertEqual(len(got), 40)
            self.assertEqual(got[-1], "line 199999")
            self.assertEqual(got[0], "line 199960")

    def test_small_file_is_returned_whole(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "s.log"
            p.write_text("a\nb\nc\n", encoding="utf-8")
            self.assertEqual(self._proc(p).tail(40), "a\nb\nc")

    def test_drops_the_half_line_at_the_seam(self):
        """从中间截断时，第一行是半截，不能当真日志给人看。"""
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "s.log"
            p.write_text("x" * 5000 + "\nlast-1\nlast-2\n", encoding="utf-8")
            got = self._proc(p).tail(2, chunk=64).splitlines()
            self.assertEqual(got, ["last-1", "last-2"])

    def test_missing_file_does_not_raise(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(self._proc(Path(td) / "nope.log").tail(5), "（没有日志）")

    def test_rotation_moves_oversized_log_aside(self):
        with tempfile.TemporaryDirectory() as td:
            from modelhub.procs import ManagedProc

            p = Path(td) / "a.log"
            p.write_bytes(b"x" * 4096)
            proc = ManagedProc(
                "t", ["x"], cwd=None, env={}, log_path=p, log_max_bytes=1024
            )
            proc._rotate_log()
            self.assertFalse(p.exists())
            self.assertTrue((Path(td) / "a.log.1").exists())

    def test_rotation_leaves_small_log_alone(self):
        with tempfile.TemporaryDirectory() as td:
            from modelhub.procs import ManagedProc

            p = Path(td) / "a.log"
            p.write_bytes(b"x" * 10)
            proc = ManagedProc(
                "t", ["x"], cwd=None, env={}, log_path=p, log_max_bytes=1024
            )
            proc._rotate_log()
            self.assertEqual(p.stat().st_size, 10)
            self.assertFalse((Path(td) / "a.log.1").exists())


# ---------------------------------------------------------------- 内存：流式响应


class StreamedJsonTest(unittest.TestCase):
    """`_json_stream` 拼出来的必须是合法 JSON，长度也必须算准。

    这条路径是为了少复制两份大 buffer（整份 json.dumps 再 encode），但
    Content-Length 要靠算术算 —— 算错就是「客户端一直等剩下的字节」，
    比费内存更难查。所以形状和长度都得钉住。
    """

    def _handler(self):
        from modelhub.http_api import Handler

        sent: dict[str, object] = {}

        class Sink:
            def __init__(self) -> None:
                self.buf = bytearray()

            def write(self, data) -> None:
                self.buf += data

        class H(Handler):
            def send_response(self, code, message=None):  # noqa: D102
                sent["status"] = code

            def send_header(self, key, value):  # noqa: D102
                sent[str(key).lower()] = value

            def end_headers(self):  # noqa: D102
                pass

            def _cors(self):  # noqa: D102
                pass

            def log_message(self, *a):  # noqa: D102
                pass

        h = H.__new__(H)
        h.wfile = Sink()
        return h, sent

    def test_single_blob_shape_and_length(self):
        import base64

        from modelhub.http_api import B64_CHUNK, _b64_len, _frag

        h, sent = self._handler()
        blob = bytes(range(256)) * 90000                     # 23 MiB，跨多个 chunk
        self.assertGreater(len(blob), B64_CHUNK)
        head = _frag({"ok": True, "kind": "image", "encoding": "base64"})
        h._json_stream(
            200,
            [head[:-1] + b',"data":"', (blob,),
             b'","mime":"image/png","meta":{"a":1}}'],
        )
        raw = bytes(h.wfile.buf)
        self.assertEqual(sent["status"], 200)
        # Content-Length 必须等于实际写出去的字节数
        self.assertEqual(int(sent["content-length"]), len(raw))
        doc = json.loads(raw)
        self.assertEqual(base64.b64decode(doc["data"]), blob)
        self.assertEqual(doc["encoding"], "base64")
        self.assertEqual(doc["meta"], {"a": 1})

    def test_blob_list_shape(self):
        import base64

        from modelhub.http_api import _frag

        h, sent = self._handler()
        items = [(str(i), (b"\x89PNG" + bytes([i]) * 1000)) for i in range(3)]
        pieces = [b'{"ok":true,"encoding":"base64","data":[']
        for i, (key, blob) in enumerate(items):
            if i:
                pieces.append(b",")
            pieces.append(b'{"key":' + _frag(key) + b',"image":"')
            pieces.append((blob,))
            pieces.append(b'","mime":"image/png"}')
        pieces.append(b'],"meta":{}}')
        h._json_stream(200, pieces)
        raw = bytes(h.wfile.buf)
        self.assertEqual(int(sent["content-length"]), len(raw))
        doc = json.loads(raw)
        self.assertEqual([r["key"] for r in doc["data"]], ["0", "1", "2"])
        for row, (key, blob) in zip(doc["data"], items):
            self.assertEqual(base64.b64decode(row["image"]), blob)

    def test_empty_blob_is_still_valid_json(self):
        from modelhub.http_api import _frag

        h, sent = self._handler()
        head = _frag({"ok": True})
        h._json_stream(200, [head[:-1] + b',"data":"', (b"",), b'"}'])
        raw = bytes(h.wfile.buf)
        self.assertEqual(int(sent["content-length"]), len(raw))
        self.assertEqual(json.loads(raw), {"ok": True, "data": ""})


# ---------------------------------------------------------------- 内存：节点定义缓存


class ObjectInfoCacheTest(unittest.TestCase):
    """`object_info` 的缓存要会淘汰。

    一份解析后 14.6 MiB（2045 个节点，实测）。老实现只看 TTL 决定「要不要重拉」，
    从不释放 —— 换过 base 的进程就一份一份往上叠。
    """

    def setUp(self):
        import imagegen

        self.ig = imagegen
        self._saved = dict(imagegen._object_info_cache)
        imagegen._object_info_cache.clear()

    def tearDown(self):
        self.ig._object_info_cache.clear()
        self.ig._object_info_cache.update(self._saved)

    def test_idle_entries_are_dropped(self):
        now = 1_000_000.0
        self.ig._object_info_cache["a"] = (now - 10, {"n": 1})
        self.ig._object_info_cache["b"] = (now - self.ig._OBJECT_INFO_TTL - 1, {"n": 2})
        gone = self.ig._prune_object_info(now)
        self.assertEqual(gone, 1)
        self.assertEqual(list(self.ig._object_info_cache), ["a"])

    def test_keeps_only_the_newest_n(self):
        now = 1_000_000.0
        for i in range(5):
            self.ig._object_info_cache[f"k{i}"] = (now - i * 10, {"n": i})
        self.ig._prune_object_info(now)
        self.assertEqual(len(self.ig._object_info_cache), self.ig._OBJECT_INFO_MAX)
        # 留下的是最近的（k0 最新、k1 次新）
        self.assertEqual(
            sorted(self.ig._object_info_cache), ["k0", "k1"][: self.ig._OBJECT_INFO_MAX]
        )


# ---------------------------------------------------------------- 内存：端到端响应


class RunStreamedResponseTest(unittest.TestCase):
    """真起一个 HTTP 服务，走完整的 `_run` / `_images`，验返回的 JSON。

    单元测试只验 `_json_stream` 本身；这里验的是**拼装**（`_run` 里那些
    `head[:-1] + b',"data":"'` 之类的片段）—— 拼错一个引号，前端拿到的是
    「无法解析为 JSON」，而那是最难反过来定位到这一行的一类错。
    """

    PNG = b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 400

    def _serve(self, result: dict):
        import threading

        from modelhub.http_api import make_server

        class Stub:
            def run(self, cap, payload, *, model_id=None, timeout=None):
                return dict(result, capability=cap, model=model_id or "m", ok=True)

        srv = make_server(Stub(), "127.0.0.1", 0)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        # LIFO：先 shutdown 停循环，再 server_close 关监听 socket
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        return srv.server_address[1]

    def _post(self, port: int, path: str, body: dict) -> dict:
        import urllib.request

        req = urllib.request.Request(
            f"http://127.0.0.1:{port}{path}",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())

    def test_single_image(self):
        import base64

        port = self._serve(
            {"kind": "image", "data": self.PNG, "mime": "image/png",
             "meta": {"seconds": 1.5, "workflow": "w"}}
        )
        doc = self._post(port, "/v1/run", {"capability": "image.generate",
                                           "input": {"prompt": "猫"}})
        self.assertEqual(doc["encoding"], "base64")
        self.assertEqual(base64.b64decode(doc["data"]), self.PNG)
        self.assertEqual(doc["meta"]["workflow"], "w")
        self.assertEqual(doc["kind"], "image")

    def test_batch_images(self):
        import base64

        blobs = [self.PNG + bytes([i]) for i in range(3)]
        port = self._serve(
            {
                "kind": "images",
                "data": [
                    {"key": str(i), "image": b, "mime": "image/png"}
                    for i, b in enumerate(blobs)
                ],
                "mime": "image/png",
                "meta": {"count": 3},
            }
        )
        doc = self._post(port, "/v1/run", {"capability": "image.generate",
                                           "input": {"prompt": "猫"}})
        self.assertEqual([r["key"] for r in doc["data"]], ["0", "1", "2"])
        for row, blob in zip(doc["data"], blobs):
            self.assertEqual(base64.b64decode(row["image"]), blob)
        self.assertEqual(doc["meta"]["count"], 3)

    def test_openai_images_alias(self):
        import base64

        port = self._serve(
            {"kind": "image", "data": self.PNG, "mime": "image/png", "meta": {}}
        )
        doc = self._post(port, "/v1/images/generations", {"prompt": "猫"})
        self.assertEqual(base64.b64decode(doc["data"][0]["b64_json"]), self.PNG)
        self.assertEqual(doc["data"][0]["revised_prompt"], "猫")

    def test_raw_flag_returns_the_bytes_untouched(self):
        """raw=true 是不编码的那条路：字节必须一模一样。"""
        import urllib.request

        port = self._serve(
            {"kind": "image", "data": self.PNG, "mime": "image/png", "meta": {}}
        )
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/v1/run",
            data=json.dumps({"capability": "image.generate", "raw": True,
                             "input": {"prompt": "x"}}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            self.assertEqual(resp.read(), self.PNG)
            self.assertEqual(resp.headers.get("Content-Type"), "image/png")


# ---------------------------------------------------------------- 内存：参考图不滞留


class ComfyRefImageReleaseTest(unittest.TestCase):
    """参考图上传完就必须从 payload 里摘掉。

    一张 24 MiB 的参考图 base64 之后是 32 MiB 字符串。`_run` 的栈帧在整个
    生成期间（几十秒到十几分钟）都攥着 `payload`，不摘掉就等于白占 32 MiB×N。
    """

    def setUp(self):
        import sys as _sys
        import types as _types

        self._sys = _sys
        self._saved = _sys.modules.get("imagegen")
        fake = _types.ModuleType("imagegen")
        fake.ImageGenError = RuntimeError
        fake.uploaded: list[tuple[str, bytes]] = []

        def upload_image(base, *, name, data):
            fake.uploaded.append((name, data))
            return f"up-{len(fake.uploaded)}.png"

        fake.upload_image = upload_image
        fake.generate = lambda *a, **k: {
            "image": b"OUT", "mime": "image/png", "promptId": "p", "seconds": 1.0
        }
        fake.generate_batch = lambda *a, **k: {
            "images": [], "promptId": "p", "seconds": 1.0
        }
        fake.list_workflows = lambda root: {"workflows": [], "dir": root}
        self.fake = fake
        _sys.modules["imagegen"] = fake

    def tearDown(self):
        if self._saved is not None:
            self._sys.modules["imagegen"] = self._saved
        else:
            self._sys.modules.pop("imagegen", None)

    def _spec(self):
        from modelhub.config import ModelSpec

        return ModelSpec(
            id="comfy-image",
            capability="image.generate",
            driver="comfy",
            title="t",
            extra={"base": "http://127.0.0.1:9", "root": "/tmp", "workflow": "w"},
        )

    def test_single_reference_is_dropped_after_upload(self):
        import base64

        from modelhub.config import HubConfig, GpuConfig
        from modelhub.drivers import ComfyDriver, Loaded

        raw = b"\x89PNG" + b"x" * 5000
        payload = {
            "workflow": "w",
            "prompt": "改成水彩风",
            "images": [base64.b64encode(raw).decode("ascii")],
        }
        cfg = HubConfig(gpu=GpuConfig(index=0), models=(self._spec(),))
        res = ComfyDriver().invoke(self._spec(), Loaded(port=17804, meta={}), payload, cfg)
        self.assertEqual(res.kind, "image")
        self.assertEqual(self.fake.uploaded[0][1], raw)
        self.assertIsNone(payload["images"][0], "参考图 base64 还留在 payload 里")
        self.assertEqual(res.meta["refs"], ["up-1.png"])

    def test_batch_references_are_dropped_after_upload(self):
        import base64

        from modelhub.config import HubConfig, GpuConfig
        from modelhub.drivers import ComfyDriver, Loaded

        raw = b"\x89PNG" + b"y" * 4000
        payload = {
            "workflow": "w",
            "items": [
                {"key": "0", "prompt": "a", "images": [base64.b64encode(raw).decode("ascii")]},
                {"key": "1", "prompt": "b"},
            ],
        }
        cfg = HubConfig(gpu=GpuConfig(index=0), models=(self._spec(),))
        ComfyDriver().invoke(self._spec(), Loaded(port=17804, meta={}), payload, cfg)
        self.assertIsNone(payload["items"][0]["images"][0])
        self.assertEqual(self.fake.uploaded[0][1], raw)


class TaskGroupTest(unittest.TestCase):
    """换任务类型才卸载；同组常驻；空闲不按时间卸。"""

    def setUp(self):
        self.gpu = FakeGpu()
        self.vd = make_spec("qwen3-tts-vd", "voice.design", vram=4000, ttl=0, group="audio")
        self.s2 = make_spec("s2-pro", "voice.synthesize", vram=1500, ttl=0, group="audio")
        self.t2i = make_spec("qwen-t2i", "image.generate", vram=9000, ttl=0, group="image")
        self.llm = make_spec("llama", "text.generate", vram=14000, ttl=0, group="llm")

    def test_audio_pair_stays_resident(self):
        """设计音色 → 立刻合成：两个引擎都在卡上，中间不许插一次卸载。"""
        hub, drv = make_hub([self.vd, self.s2], self.gpu, tempfile.mkdtemp())
        try:
            hub.acquire("voice.design", "qwen3-tts-vd")
            hub.release("qwen3-tts-vd")
            hub.acquire("voice.synthesize", "s2-pro")
            hub.release("s2-pro")
            self.assertEqual(drv.stopped, [])
            self.assertEqual(hub._slots["qwen3-tts-vd"].state, "ready")  # noqa: SLF001
            self.assertEqual(hub._slots["s2-pro"].state, "ready")  # noqa: SLF001
        finally:
            hub.close()

    def test_cross_group_evicts_immediately(self):
        """来了别的类型，上一组直接让位（不等空闲计时）。"""
        hub, drv = make_hub([self.vd, self.t2i], self.gpu, tempfile.mkdtemp())
        try:
            hub.acquire("voice.design", "qwen3-tts-vd")
            hub.release("qwen3-tts-vd")
            hub.acquire("image.generate", "qwen-t2i")
            hub.release("qwen-t2i")
            self.assertEqual(drv.stopped, ["qwen3-tts-vd"])
        finally:
            hub.close()

    def test_same_capability_never_reloads(self):
        """同一类型连着来：只起一次，权重一直留在卡上。"""
        hub, drv = make_hub([self.t2i], self.gpu, tempfile.mkdtemp())
        try:
            for _ in range(3):
                hub.acquire("image.generate", "qwen-t2i")
                hub.release("qwen-t2i")
            self.assertEqual(drv.started, ["qwen-t2i"])
            self.assertEqual(drv.stopped, [])
        finally:
            hub.close()

    def test_gc_does_not_unload_by_time(self):
        """idle_ttl=0：空了多久都不卸 —— 卸不卸只看「有没有别类型进来」。"""
        hub, drv = make_hub([self.llm], self.gpu, tempfile.mkdtemp())
        try:
            hub.acquire("text.generate", "llama")
            hub.release("llama")
            hub._slots["llama"].last_used = 0.0  # noqa: SLF001
            self.assertEqual(hub.gc(), [])
            self.assertEqual(drv.stopped, [])
        finally:
            hub.close()

    def test_default_groups(self):
        self.assertEqual(self.vd.group_key, self.s2.group_key)
        self.assertEqual(self.t2i.group_key, "image")
        self.assertNotEqual(self.t2i.group_key, self.llm.group_key)

    def test_config_defaults_are_persistent(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = load_config(Path(d) / "nope.json", overrides={"gpu": {"index": 0}})
            self.assertTrue(all(m.idle_ttl == 0 for m in cfg.models), [m.idle_ttl for m in cfg.models])
            g = {m.capability: m.group_key for m in cfg.models}
            self.assertEqual(g["voice.design"], g["voice.synthesize"])
            self.assertEqual(g["image.generate"], g["image.edit"])
            self.assertNotEqual(g["image.generate"], g["text.generate"])


if __name__ == "__main__":
    unittest.main()
