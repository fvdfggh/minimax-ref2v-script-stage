"""单卡调度：同一时刻，这张卡上只服务一类模型。

为什么必须这样：一张 16G 卡装不下 14.3G 的 LLM 和生图模型和两个 TTS。
如果让它们各自常驻，结果是轮流 OOM，而 OOM 现场（谁的显存、还剩多少）
在报错里根本看不出来。所以本服务主动做三件事：

  1. **租约**：要跑某个模型，先拿到它；并发请求同一个模型共享引用计数。
  2. **让位**：装新的之前，按 LRU 卸旧的；有人正在用的不卸，直接报 409
     并说清是谁在占。
  3. **对账**：装完拿 nvidia-smi 实测显存，而不是相信估算。估算只用于
     「能不能装」的决策，实测用于「还要腾多少」的决策。

`preflight` 是这个类最有价值的方法：它在**不加载**的前提下，把「现在能跑
哪几类、跑某一类要先卸谁、卸完够不够」全算出来。上层在真正开跑之前问它。
"""

from __future__ import annotations

import json
import queue
import threading
import time
import traceback
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from .config import (
    CAPABILITY_KEYS,
    CAPABILITY_TITLES,
    HubConfig,
    ModelSpec,
    estimate_vram_mb,
)
from .drivers import InvokeResult, Issue, Loaded, get_driver
from .gpu import Gpu, GpuError
from .procs import port_open, port_owner


class HubError(RuntimeError):
    """给 HTTP 层用的错：自带状态码，message 直接给人看。"""

    def __init__(self, message: str, *, status: int = 400, detail: dict[str, Any] | None = None):
        super().__init__(message)
        self.status = status
        self.detail = detail or {}


@dataclass
class Slot:
    spec: ModelSpec
    state: str = "idle"  # idle | loading | ready | unloading | error
    loaded: Loaded | None = None
    refs: int = 0
    last_used: float = 0.0
    loaded_at: float = 0.0
    error: str = ""
    est_mb: int = 0
    real_mb: int = 0

    def __post_init__(self) -> None:
        if not self.est_mb:
            self.est_mb = estimate_vram_mb(self.spec)

    def to_dict(self) -> dict[str, Any]:
        try:
            manages = get_driver(self.spec.driver).manages_process
        except Exception:  # noqa: BLE001
            manages = True
        return {
            **self.spec.to_dict(),
            "state": self.state,
            "refs": self.refs,
            "estVramMb": self.est_mb,
            "realVramMb": self.real_mb,
            "loadedAt": int(self.loaded_at * 1000) if self.loaded_at else 0,
            "lastUsedAt": int(self.last_used * 1000) if self.last_used else 0,
            "idleSec": int(time.monotonic() - self.last_used) if self.last_used else 0,
            "error": self.error,
            "managesProcess": manages,
            "runtime": self.loaded.to_dict() if self.loaded else None,
        }


class Hub:
    def __init__(
        self,
        cfg: HubConfig,
        *,
        gpu: Gpu | None = None,
        drivers: dict[str, Any] | None = None,
    ):
        self.cfg = cfg
        self.gpu = gpu or Gpu(cfg.gpu.index)
        self._drivers = drivers or {}
        self._slots: dict[str, Slot] = {
            m.id: Slot(m) for m in cfg.models
        }
        self._cond = threading.Condition(threading.RLock())
        self._load_lock = threading.Lock()
        self._events: deque[dict[str, Any]] = deque(maxlen=cfg.event_limit)
        self._subs: list[queue.Queue] = []
        self._stop_flag = threading.Event()
        self._gc_thread: threading.Thread | None = None
        self._seq = 0
        self._started_at = time.time()
        #: 换人记录（谁下谁上、花了多久），控制台直接读
        self._swaps: deque[dict[str, Any]] = deque(maxlen=40)
        self._swap_count = 0
        self._last_swap: dict[str, Any] | None = None
        self._load_calibration()

    def driver(self, spec: ModelSpec):
        return self._drivers.get(spec.driver) or get_driver(spec.driver)

    # ------------------------------------------------------------ 生命周期

    def start(self) -> None:
        Path(self.cfg.runtime_dir).mkdir(parents=True, exist_ok=True)
        (Path(self.cfg.runtime_dir) / "logs").mkdir(exist_ok=True)
        self._cleanup_orphans()
        self._emit("hub.start", gpu=self.cfg.gpu.index, models=len(self._slots))
        if self.cfg.gc_interval > 0 and not self._gc_thread:
            self._gc_thread = threading.Thread(
                target=self._gc_loop, name="modelhub-gc", daemon=True
            )
            self._gc_thread.start()

    def close(self) -> None:
        self._stop_flag.set()
        with self._cond:
            ids = [sid for sid, s in self._slots.items() if s.loaded]
        for sid in ids:
            try:
                self.unload(sid, force=True, reason="服务退出")
            except Exception:  # noqa: BLE001
                pass
        self._save_state()
        self._emit("hub.stop")

    def _gc_loop(self) -> None:
        while not self._stop_flag.wait(self.cfg.gc_interval):
            try:
                self.gc()
            except Exception:  # noqa: BLE001
                self._emit("gc.error", error=traceback.format_exc(limit=2))

    # ------------------------------------------------------------ 事件

    def _emit(self, kind: str, **data: Any) -> None:
        with self._cond:
            self._seq += 1
            ev = {"seq": self._seq, "at": int(time.time() * 1000), "kind": kind, **data}
            self._events.append(ev)
            for q in list(self._subs):
                try:
                    q.put_nowait(ev)
                except queue.Full:
                    pass
        if kind not in ("slot.tick",):
            bits = " ".join(f"{k}={v}" for k, v in data.items() if k in ("model", "capability", "ms", "reason"))
            print(f"[hub] {kind} {bits}".rstrip(), flush=True)

    def events(self, since: int = 0, limit: int = 100) -> list[dict[str, Any]]:
        with self._cond:
            rows = [e for e in self._events if e["seq"] > since]
        return rows[-limit:]

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=256)
        with self._cond:
            self._subs.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._cond:
            if q in self._subs:
                self._subs.remove(q)

    # ------------------------------------------------------------ 视图

    def env(self) -> dict[str, Any]:
        gpu_info: dict[str, Any] = {"index": self.cfg.gpu.index, "singleCard": True}
        try:
            stats = self.gpu.stats()
            if stats:
                gpu_info.update(stats.to_dict())
            else:
                gpu_info["error"] = "读不到显存（没有 nvidia-smi 或驱动异常）"
        except GpuError as exc:
            gpu_info["error"] = str(exc)
        return {
            "service": "modelhub",
            "version": "1.0.0",
            "uptimeSec": int(time.time() - self._started_at),
            "host": self.cfg.host,
            "port": self.cfg.port,
            "runtimeDir": self.cfg.runtime_dir,
            "gpu": {**self.cfg.gpu.to_dict(), **gpu_info},
            "capabilities": [
                {"key": k, "title": CAPABILITY_TITLES[k]} for k in CAPABILITY_KEYS
            ],
            "python": self._python_version(),
        }

    @staticmethod
    def _python_version() -> str:
        import platform

        return platform.python_version()

    def models(self) -> list[dict[str, Any]]:
        with self._cond:
            return [s.to_dict() for s in self._slots.values()]

    def ledger(self, stats: Any | None = None) -> dict[str, Any]:
        """这张卡的账：谁的、多少、还剩。"""
        try:
            st = stats or self.gpu.stats()
        except GpuError:
            st = None
        with self._cond:
            own = {
                s.loaded.pid
                for s in self._slots.values()
                if s.loaded and s.loaded.pid
            }
            hub_mb = sum(
                s.real_mb or s.est_mb
                for s in self._slots.values()
                if s.loaded and s.state == "ready"
            )
            resident = [
                {
                    "id": s.spec.id,
                    "capability": s.spec.capability,
                    "estMb": s.est_mb,
                    "realMb": s.real_mb,
                    "refs": s.refs,
                    "external": bool(s.loaded and s.loaded.external),
                }
                for s in self._slots.values()
                if s.loaded and s.state in ("ready", "loading")
            ]
        if st is None:
            return {
                "known": False,
                "totalMb": self.cfg.gpu.total_mb or 0,
                "reservedMb": self.cfg.gpu.reserve_mb,
                "hubMb": hub_mb,
                "resident": resident,
                "budgetMb": 0,
            }
        try:
            others = self.gpu.used_by_others(own, st)
        except GpuError:
            others = max(0, st.used_mb - hub_mb)
        budget = max(0, st.total_mb - others - self.cfg.gpu.reserve_mb)
        return {
            "known": True,
            "totalMb": st.total_mb,
            "usedMb": st.used_mb,
            "othersMb": others,
            "reservedMb": self.cfg.gpu.reserve_mb,
            "hubMb": hub_mb,
            "budgetMb": budget,
            "freeForHubMb": max(0, budget - hub_mb),
            "resident": resident,
        }

    def status(self) -> dict[str, Any]:
        with self._cond:
            slots = [s.to_dict() for s in self._slots.values()]
            resident = [
                {"id": s.spec.id, "capability": s.spec.capability, "refs": s.refs}
                for s in self._slots.values()
                if s.state in ("ready", "loading")
            ]
            hot = [
                {
                    "id": s.spec.id,
                    "title": s.spec.title,
                    "capability": s.spec.capability,
                    "capabilityTitle": CAPABILITY_TITLES.get(s.spec.capability, s.spec.capability),
                    "mb": s.real_mb or s.est_mb,
                    "refs": s.refs,
                    "busy": s.refs > 0,
                    "external": bool(s.loaded and s.loaded.external),
                }
                for s in self._slots.values()
                if s.state == "ready" and s.loaded
            ]
            rotation = {
                "exclusive": self.cfg.gpu.exclusive,
                "swapWaitSec": self.cfg.gpu.swap_wait,
                "swaps": self._swap_count,
                "last": self._last_swap,
                "recent": list(self._swaps)[-6:],
                # 卡上现在是谁。严格轮转下最多一个（生图/图片编辑共用一个进程）
                "hot": hot,
            }
        try:
            stats = self.gpu.stats()
        except GpuError:
            stats = None
        return {
            "ok": True,
            "gpu": {
                **self.cfg.gpu.to_dict(),
                **({"stats": stats.to_dict()} if stats else {}),
                "singleCard": True,
            },
            "ledger": self.ledger(stats),
            "resident": resident,
            "rotation": rotation,
            "slots": slots,
            "recent": self.events(limit=30),
        }

    # ------------------------------------------------------------ 体检

    def preflight(
        self,
        capabilities: list[str] | None = None,
        *,
        models: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """运行前体检：不加载任何模型，把「能不能跑」问清楚。

        models 可以把某个能力指定到具体模型 id（一个能力有多个模型时）。
        """
        wanted = capabilities or list(CAPABILITY_KEYS)
        bad_caps = [c for c in wanted if c not in CAPABILITY_KEYS]
        if bad_caps:
            raise HubError(
                f"不认识的能力：{', '.join(bad_caps)}；可用：{', '.join(CAPABILITY_KEYS)}",
                status=400,
            )
        try:
            stats = self.gpu.stats()
        except GpuError as exc:
            stats = None
            gpu_error = str(exc)
        else:
            gpu_error = "" if stats else "没有 nvidia-smi，无法判断显存"

        rows: list[dict[str, Any]] = []
        blockers: list[dict[str, Any]] = []
        warnings: list[dict[str, Any]] = []
        advice: list[str] = []

        for cap in wanted:
            try:
                spec = self._pick(cap, (models or {}).get(cap))
            except HubError as exc:
                checks = [Issue("error", "model.unknown", str(exc))]
                rows.append(self._cap_row(cap, None, checks, None))
                blockers.extend(self._as_blockers(cap, checks))
                continue
            checks = []
            if spec is None:
                checks.append(
                    Issue("error", "model.none", f"没有为 {cap}（{CAPABILITY_TITLES[cap]}）配置模型",
                          "在配置文件的 models 里加一条")
                )
                rows.append(self._cap_row(cap, None, checks, None))
                blockers.extend(self._as_blockers(cap, checks))
                continue
            # 驱动自检（文件/端口/外部服务）
            try:
                checks.extend(self.driver(spec).check(spec, self.cfg, self.gpu))
            except Exception as exc:  # noqa: BLE001
                checks.append(Issue("error", "driver.check_failed", f"驱动自检失败：{exc}"))

            with self._cond:
                slot = self._slots[spec.id]
                state = slot.state
                real = slot.real_mb
                refs = slot.refs
            # 已经加载的模型当然占着自己的端口 —— 那是它，不是冲突
            if state == "ready" and slot.loaded:
                checks = [c for c in checks if c.code != "port.busy"]

            plan = self._plan_for(spec, stats)
            checks.extend(plan["checks"])
            if plan.get("evict"):
                names = "、".join(x["title"] for x in plan["evict"])
                advice.append(
                    f"要跑「{CAPABILITY_TITLES[cap]}」，会先卸载 {names}"
                )
            if plan.get("needCtx"):
                advice.append(
                    f"{spec.id} 按当前 ctx={spec.extra.get('ctx')} 估 {plan['estMb']}MB，"
                    f"这张卡的可用预算只有 {plan.get('budgetMb')}MB；"
                    "可以调小 ctx 或换更小的量化再试"
                )
            rows.append(self._cap_row(cap, spec, checks, plan, state=state, real=real, refs=refs))
            blockers.extend(self._as_blockers(cap, checks))
            warnings.extend(self._as_warnings(cap, checks))

        if gpu_error:
            # 不是所有能力都需要卡（ComfyUI 可能在别的卡上），所以只提醒
            warnings.append({"capability": "*", "code": "gpu.unknown", "message": gpu_error})

        ok = not blockers
        return {
            "ok": ok,
            "checkedAt": int(time.time() * 1000),
            "gpu": {
                **self.cfg.gpu.to_dict(),
                **({"stats": stats.to_dict()} if stats else {}),
                "error": gpu_error,
            },
            "ledger": self.ledger(stats),
            "capabilities": rows,
            "blockers": blockers,
            "warnings": warnings,
            "advice": advice,
        }

    def _cap_row(
        self,
        cap: str,
        spec: ModelSpec | None,
        checks: list[Issue],
        plan: dict[str, Any] | None,
        *,
        state: str = "idle",
        real: int = 0,
        refs: int = 0,
    ) -> dict[str, Any]:
        errors = [c for c in checks if c.level == "error"]
        return {
            "capability": cap,
            "title": CAPABILITY_TITLES[cap],
            "model": spec.id if spec else None,
            "modelTitle": spec.title if spec else None,
            "driver": spec.driver if spec else None,
            "state": state,
            "refs": refs,
            "estVramMb": plan["estMb"] if plan else (spec and estimate_vram_mb(spec)) or 0,
            "realVramMb": real,
            "loaded": state == "ready",
            "ready": not errors,
            "checks": [c.to_dict() for c in checks],
            "willEvict": (plan or {}).get("evict") or [],
            "budgetMb": (plan or {}).get("budgetMb"),
        }

    @staticmethod
    def _as_blockers(cap: str, checks: list[Issue]) -> list[dict[str, Any]]:
        return [
            {"capability": cap, **c.to_dict()} for c in checks if c.level == "error"
        ]

    @staticmethod
    def _as_warnings(cap: str, checks: list[Issue]) -> list[dict[str, Any]]:
        return [
            {"capability": cap, **c.to_dict()} for c in checks if c.level == "warn"
        ]

    def _plan_for(self, spec: ModelSpec, stats: Any | None) -> dict[str, Any]:
        """不加载，算出「装它要卸谁」。"""
        est = estimate_vram_mb(spec)
        with self._cond:
            slot = self._slots[spec.id]
            if slot.state == "ready":
                return {"estMb": est, "budgetMb": None, "evict": [], "checks": [], "needCtx": False}
            own = {s.loaded.pid for s in self._slots.values() if s.loaded and s.loaded.pid}
            ready = [
                s
                for s in self._slots.values()
                if s.state == "ready" and s.loaded and s.spec.id != spec.id
            ]
            hub_mb = sum(s.real_mb or s.est_mb for s in ready)
            busy = [s for s in ready if s.refs > 0]

        checks: list[Issue] = []
        if stats is None:
            return {
                "estMb": est,
                "budgetMb": 0,
                "evict": [],
                "checks": [
                    Issue("warn", "vram.unknown", "读不到显存：装不装得下只能等加载时才知道")
                ],
                "needCtx": False,
            }
        try:
            others = self.gpu.used_by_others(own, stats)
        except GpuError:
            others = 0
        # 只有真的占着这张卡的模型才进「让位」名单；别的卡上的 ComfyUI 与本卡无关
        ready = [s for s in ready if self._on_card(s, stats)]
        # 同组的（音频两兄弟、生图↔编辑）本来就是一起用的，不算"别人"
        ready = [s for s in ready if not self._same_group(s.spec, spec)]
        # 共用同一个上游进程的两个能力（生图 ↔ 图片编辑）不算"别人"
        ready = [s for s in ready if not self._same_upstream(s.spec, spec)]
        hub_mb = sum(s.real_mb or s.est_mb for s in ready)
        busy = [s for s in ready if s.refs > 0]
        budget = max(0, stats.total_mb - others - self.cfg.gpu.reserve_mb)
        free_now = max(0, budget - hub_mb)

        # 严格轮转：轮到它就把卡清干净，装得下也清
        evict: list[dict[str, Any]] = []
        if self.cfg.gpu.exclusive:
            for cand in sorted(ready, key=lambda s: (s.refs > 0, s.last_used or 0)):
                if cand.refs > 0:
                    continue
                free_now += cand.real_mb or cand.est_mb
                evict.append(
                    {
                        "id": cand.spec.id,
                        "title": cand.spec.title,
                        "mb": cand.real_mb or cand.est_mb,
                        "external": bool(cand.loaded and cand.loaded.external),
                    }
                )
            if evict:
                checks.append(
                    Issue(
                        "info",
                        "swap.plan",
                        f"严格轮转：开跑前先把卡上的「{'、'.join(x['title'] for x in evict)}」"
                        f"撤下来，再把 {spec.title} 搬上去",
                    )
                )
        else:
            pool = sorted(ready, key=lambda s: (s.refs > 0, s.last_used or 0))
            for cand in pool:
                if free_now >= est + self.cfg.gpu.min_free_mb:
                    break
                if cand.refs > 0:
                    continue
                free_now += cand.real_mb or cand.est_mb
                evict.append(
                    {
                        "id": cand.spec.id,
                        "title": cand.spec.title,
                        "mb": cand.real_mb or cand.est_mb,
                        "external": bool(cand.loaded and cand.loaded.external),
                    }
                )
        need_ctx = False
        if free_now < est + self.cfg.gpu.min_free_mb:
            need_ctx = bool(spec.driver == "llama")
            msg = (
                f"这张卡装不下：{spec.title} 约需 {est}MB，"
                f"可用 {free_now}MB（总 {stats.total_mb}，别人占 {others}，保留 {self.cfg.gpu.reserve_mb}）"
            )
            if busy:
                who = "、".join(f"{s.spec.title}（{s.refs} 个请求在用）" for s in busy)
                msg += f"；{who} 正在用，不能卸"
                checks.append(Issue("error", "vram.busy", msg, "等这些请求结束，或把它们停掉"))
            else:
                checks.append(
                    Issue("error", "vram.insufficient", msg,
                          "调小 llama 的 ctx、换更小量化，或让开这张卡上别人的进程")
                )
        else:
            gap = free_now - est
            if est > 0 and gap < est * 0.06:
                checks.append(
                    Issue(
                        "warn",
                        "vram.tight",
                        f"装得下，但只剩 {gap}MB 余量（约 {gap * 100 // max(1, est)}%）"
                        f"；加载时若 OOM，就把 llama 的 ctx 调小一档",
                    )
                )
        return {
            "estMb": est,
            "budgetMb": budget,
            "evict": evict,
            "checks": checks,
            "needCtx": need_ctx,
        }

    # ------------------------------------------------------------ 租约

    def _pick(self, capability: str, model_id: str | None = None) -> ModelSpec | None:
        if capability not in CAPABILITY_KEYS:
            raise HubError(
                f"不认识的能力：{capability}；可用：{', '.join(CAPABILITY_KEYS)}", status=400
            )
        if model_id:
            spec = self._slots.get(model_id).spec if model_id in self._slots else None
            if not spec:
                raise HubError(f"没有这个模型：{model_id}", status=404)
            if spec.capability != capability:
                raise HubError(
                    f"{model_id} 是 {CAPABILITY_TITLES[spec.capability]} 的模型，"
                    f"不能当 {CAPABILITY_TITLES[capability]} 用",
                    status=400,
                )
            return spec
        return self.cfg.default_for(capability)

    def acquire(self, capability: str, model_id: str | None = None, timeout: float | None = None) -> Loaded:
        spec = self._pick(capability, model_id)
        if spec is None:
            raise HubError(
                f"没有为「{CAPABILITY_TITLES[capability]}」配置模型", status=503,
                detail={"capability": capability},
            )
        limit = float(timeout if timeout is not None else self.cfg.load_timeout)
        deadline = time.monotonic() + limit
        with self._cond:
            slot = self._slots[spec.id]
            while True:
                if slot.state == "ready" and slot.loaded:
                    slot.refs += 1
                    slot.last_used = time.monotonic()
                    return slot.loaded
                if slot.state == "loading":
                    remain = deadline - time.monotonic()
                    if remain <= 0:
                        raise HubError(
                            f"{spec.title} 还在加载（{slot.state}），等了 {limit:.0f}s 没起来",
                            status=503,
                        )
                    self._cond.wait(min(remain, 1.0))
                    continue
                if slot.state == "unloading":
                    self._cond.wait(0.3)
                    continue
                # idle 或 error：由本请求负责把它拉起来
                slot.state = "loading"
                slot.error = ""
                break
        try:
            loaded = self._bring_up(spec, deadline)
        except HubError as exc:
            # 让位被拒（409）、腾不出显存（503）也算这次加载失败：
            # 状态必须从 loading 退出来，否则后面的请求会一直等一个不会来的结果
            with self._cond:
                slot.state = "error"
                slot.error = str(exc)
                slot.loaded = None
                slot.refs = 0
                self._cond.notify_all()
            self._emit("load.error", model=spec.id, error=str(exc)[:500])
            raise
        except Exception as exc:  # noqa: BLE001
            with self._cond:
                slot.state = "error"
                slot.error = str(exc)
                slot.loaded = None
                slot.refs = 0
                self._cond.notify_all()
            self._emit("load.error", model=spec.id, error=str(exc)[:500])
            raise HubError(f"{spec.title} 加载失败：{exc}", status=503) from exc
        with self._cond:
            slot.state = "ready"
            slot.loaded = loaded
            slot.refs = 1
            slot.loaded_at = slot.last_used = time.monotonic()
            slot.real_mb = loaded.real_vram_mb or slot.est_mb
            slot.error = ""
            self._save_state_locked()
            self._cond.notify_all()
        self._emit("load.ready", model=spec.id, pid=loaded.pid, vramMb=slot.real_mb)
        self._remember_vram(spec.id, loaded.real_vram_mb)
        return loaded

    def release(self, model_id: str) -> None:
        with self._cond:
            slot = self._slots.get(model_id)
            if not slot:
                return
            slot.refs = max(0, slot.refs - 1)
            slot.last_used = time.monotonic()
            self._cond.notify_all()

    @contextmanager
    def lease(
        self, capability: str, model_id: str | None = None, timeout: float | None = None
    ) -> Iterator[tuple[ModelSpec, Loaded]]:
        spec = self._pick(capability, model_id)
        if spec is None:
            raise HubError(f"没有为「{CAPABILITY_TITLES[capability]}」配置模型", status=503)
        loaded = self.acquire(capability, spec.id, timeout)
        try:
            yield spec, loaded
        finally:
            self.release(spec.id)

    # ------------------------------------------------------------ 加载 / 卸载

    def _bring_up(self, spec: ModelSpec, deadline: float) -> Loaded:
        with self._load_lock:
            self._emit("load.start", model=spec.id, capability=spec.capability)
            t0 = time.monotonic()
            # 端口被别的进程占着时，起进程会失败；但更坏的情况是它**没失败** ——
            # 我们的探活连上了别人的服务，还以为自己加载好了。所以先拦。
            if spec.port and port_open(spec.port):
                owner = port_owner(spec.port)
                raise HubError(
                    f"端口 {spec.port} 已被 pid {owner or '?'} 占着，{spec.title} 起不来",
                    status=409,
                    detail={"port": spec.port, "pid": owner},
                )
            self._evict_for(spec, deadline)
            need = estimate_vram_mb(spec)
            if self.gpu.available:
                ok, stats = self.gpu.wait_free(
                    need,
                    timeout=min(self.cfg.gpu.release_timeout, max(5.0, deadline - time.monotonic())),
                    own_pids=self._own_pids(exclude=spec.id),
                )
                if not ok:
                    free = stats.free_mb if stats else 0
                    raise HubError(
                        f"腾不出显存：需要 {need}MB，卡上只剩 {free}MB。"
                        "有别的进程占着这张卡，或者刚卸的模型还没吐干净",
                        status=503,
                    )
            drv = self.driver(spec)
            loaded = drv.start(spec, self.cfg, self.gpu)
            # 实测：估算只用于决策，真实占用才是账本
            if loaded.pid and self.gpu.available:
                time.sleep(0.6)
                try:
                    loaded.real_vram_mb = self.gpu.mb_of_pid(loaded.pid)
                except GpuError:
                    loaded.real_vram_mb = 0
            elapsed = int((time.monotonic() - t0) * 1000)
            self._emit(
                "load.done",
                model=spec.id,
                ms=elapsed,
                vramMb=loaded.real_vram_mb or need,
                pid=loaded.pid,
            )
            return loaded

    def _own_pids(self, exclude: str | None = None) -> set[int]:
        with self._cond:
            return {
                s.loaded.pid
                for s in self._slots.values()
                if s.loaded and s.loaded.pid and s.spec.id != exclude
            }

    def _on_card(self, slot: Slot, stats: Any | None) -> bool:
        """这个模型是不是真的占着目标卡。

        自己拉起的进程不必查：驱动已经用 CUDA_VISIBLE_DEVICES / --device 钉住了。
        外部服务（ComfyUI）必须查 —— 它可能在别的卡上跑，别人卡上的显存
        跟本卡的单卡策略无关，不该被算进「让位」候选。
        """
        if not slot.loaded:
            return False
        if not slot.loaded.external:
            return True
        pid = slot.loaded.pid
        if not pid or stats is None:
            return False
        try:
            return self.gpu.pid_on_mine(pid, stats)
        except GpuError:
            return False

    def _evict_for(self, target: ModelSpec, deadline: float) -> None:
        """轮到 target 了：把卡上别人撤下来。

        严格轮转时不是「装不下才卸」，而是「轮到谁就只留谁」。前一个请求还在
        跑就等它一小会儿（`gpu.swapWaitSec`）—— 上层是流水线，前后两次调用
        常常挨着，直接 409 会逼调用方自己写重试。
        """
        evicted: list[dict[str, Any]] = []
        tried: set[str] = set()
        t0 = time.monotonic()
        warned = False
        while True:
            with self._cond:
                victims, blocking = self._victims(target)
            if blocking:
                remain = min(
                    self.cfg.gpu.swap_wait - (time.monotonic() - t0),
                    deadline - time.monotonic(),
                )
                if remain <= 0:
                    names = "、".join(
                        f"{b['title']}（{b['refs']} 个请求在用）" for b in blocking
                    )
                    raise HubError(
                        f"{names} 正在被调用，还占着这张卡，轮到 {target.title} 得等它跑完"
                        f"（已等 {int(time.monotonic() - t0)}s）",
                        status=409,
                        detail={"busy": blocking, "swap": True},
                    )
                if not warned:
                    self._emit(
                        "swap.wait",
                        model=target.id,
                        busy=[b["id"] for b in blocking],
                        waitSec=round(remain, 1),
                    )
                    warned = True
                with self._cond:
                    self._cond.wait(min(0.5, remain))
                continue
            todo = [v for v in victims if v["id"] not in tried]
            if not todo:
                break
            if not evicted:
                self._emit(
                    "swap.begin",
                    model=target.id,
                    from_=[v["id"] for v in todo],
                    exclusive=self.cfg.gpu.exclusive,
                )
            for v in todo:
                tried.add(v["id"])
                self._stop_slot(v["id"], reason=f"轮到 {target.title}")
                evicted.append(v)
            # 进程退出到显存真正回落之间有间隙，给一点时间再复查
            time.sleep(0.2)
            if time.monotonic() > deadline:
                raise HubError(
                    f"换模型超时：卸完「{'、'.join(v['title'] for v in evicted)}」"
                    f"显存还没回落，{target.title} 起不来",
                    status=503,
                )
        if evicted:
            ms = int((time.monotonic() - t0) * 1000)
            self._emit(
                "swap.done", model=target.id, from_=[v["id"] for v in evicted], ms=ms
            )
            self._record_swap(target, evicted, ms)

    def _record_swap(self, target: ModelSpec, evicted: list[dict[str, Any]], ms: int) -> None:
        row = {
            "to": target.id,
            "toTitle": target.title,
            "from": [v["id"] for v in evicted],
            "fromTitles": [v["title"] for v in evicted],
            "ms": ms,
            "at": int(time.time() * 1000),
            "exclusive": self.cfg.gpu.exclusive,
        }
        with self._cond:
            self._swap_count += 1
            self._last_swap = row
            self._swaps.append(row)

    @staticmethod
    def _same_upstream(a: ModelSpec, b: ModelSpec) -> bool:
        """两个能力是不是踩在同一个进程上。

        生图与图片编辑共用同一份 ComfyUI：卸掉它等于卸掉自己，不能算「别人」。
        """
        if a.id == b.id:
            return True
        if a.driver != b.driver:
            return False
        if a.driver != "comfy":
            return False
        return str((a.extra or {}).get("base") or "") == str((b.extra or {}).get("base") or "")

    @staticmethod
    def _same_group(a: ModelSpec, b: ModelSpec) -> bool:
        """两个能力是不是同一类任务。

        同一类的请求连续来时**不卸载**：卡片上的权重留着，下一次直接算。
        这是这套服务的主要成本差 —— ComfyUI 的 TE 8.9G + DiT 7.2G 在 16G 卡上
        搬一次要 20 s 上下，而一次采样只要 3.5 s。

        分组见 ``config.GROUP_OF``：音频两兄弟（设计 / 合成）同组，生图与编辑
        同组（它们本来共用一个进程），文本生成自成一组。
        """
        return a.group_key == b.group_key

    def _victims(self, target: ModelSpec) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """返回 (要卸的, 拦路的)。拦路 = 在用、必须先等它跑完才能卸。"""
        try:
            stats = self.gpu.stats()
        except GpuError:
            stats = None
        if stats is None:
            return [], []
        own = self._own_pids(exclude=target.id)
        try:
            others = self.gpu.used_by_others(own, stats)
        except GpuError:
            others = 0
        ready = [
            s
            for s in self._slots.values()
            if s.state == "ready" and s.loaded and s.spec.id != target.id
        ]
        # 只有在目标卡上占着显存的才值得卸；别的卡上跑着的东西跟本卡无关
        ready = [s for s in ready if self._on_card(s, stats)]
        # 同组的不卸：音频的两个引擎要一起在卡上（设计音色 → 立刻合成），
        # 中间插一次 21 s 的卸载只会把一次任务拖成两次冷启动。
        ready = [s for s in ready if not self._same_group(s.spec, target)]
        # 共用同一个上游进程的不算"别人"（生图 ↔ 图片编辑）
        ready = [s for s in ready if not self._same_upstream(s.spec, target)]

        # 严格轮转：**跨组**时卡上只留本组的。装得下也换 —— 用户要的是
        # 「轮到谁就把谁搬上来」，不是「能塞就都塞进去」。
        if self.cfg.gpu.exclusive:
            victims: list[dict[str, Any]] = []
            blocking: list[dict[str, Any]] = []
            for cand in sorted(ready, key=lambda s: (s.refs > 0, s.last_used or 0)):
                item = {
                    "id": cand.spec.id,
                    "title": cand.spec.title,
                    "mb": cand.real_mb or cand.est_mb,
                }
                if cand.refs > 0:
                    blocking.append({**item, "refs": cand.refs})
                else:
                    victims.append(item)
            return victims, blocking

        # 关键：`others` 把「自己已加载的」排除了，所以这里必须再把它们减掉。
        # 否则会把已占的显存当成空闲 —— 于是「空间够」直接不卸，然后加载 OOM。
        hub_mb = sum(s.real_mb or s.est_mb for s in ready)
        free_now = max(0, stats.total_mb - others - self.cfg.gpu.reserve_mb - hub_mb)
        if free_now >= estimate_vram_mb(target) + self.cfg.gpu.min_free_mb:
            return [], []
        pool = sorted(ready, key=lambda s: (s.refs > 0, s.last_used or 0))
        victims = []
        blocking = []
        for cand in pool:
            if free_now >= estimate_vram_mb(target) + self.cfg.gpu.min_free_mb:
                break
            if cand.refs > 0:
                blocking.append({"id": cand.spec.id, "title": cand.spec.title, "refs": cand.refs})
                continue
            free_now += cand.real_mb or cand.est_mb
            victims.append({"id": cand.spec.id, "title": cand.spec.title})
        return victims, blocking

    def _stop_slot(self, model_id: str, *, reason: str) -> None:
        with self._cond:
            slot = self._slots.get(model_id)
            if not slot or not slot.loaded:
                return
            slot.state = "unloading"
            loaded = slot.loaded
        drv = self.driver(slot.spec)
        t0 = time.monotonic()
        try:
            drv.stop(slot.spec, loaded, self.cfg, self.gpu)
        except Exception as exc:  # noqa: BLE001
            self._emit("unload.error", model=model_id, error=str(exc)[:300])
        with self._cond:
            slot.loaded = None
            slot.state = "idle"
            slot.real_mb = 0
            slot.loaded_at = 0
            self._save_state_locked()
            self._cond.notify_all()
        self._emit(
            "unload.done",
            model=model_id,
            ms=int((time.monotonic() - t0) * 1000),
            reason=reason,
        )

    def unload(self, model_id: str, *, force: bool = False, reason: str = "手动") -> dict[str, Any]:
        with self._cond:
            slot = self._slots.get(model_id)
            if not slot:
                raise HubError(f"没有这个模型：{model_id}", status=404)
            if not slot.loaded:
                return {"ok": True, "model": model_id, "unloaded": False, "reason": "本来就没加载"}
            if slot.refs > 0 and not force:
                raise HubError(
                    f"{slot.spec.title} 有 {slot.refs} 个请求在用，不能卸",
                    status=409,
                    detail={"refs": slot.refs},
                )
        self._stop_slot(model_id, reason=reason)
        return {"ok": True, "model": model_id, "unloaded": True}

    def unload_all(self, *, force: bool = False) -> dict[str, Any]:
        done, skipped = [], []
        with self._cond:
            ids = [s.spec.id for s in self._slots.values() if s.loaded]
        for sid in ids:
            try:
                res = self.unload(sid, force=force, reason="全部卸载")
                done.append(res)
            except HubError as exc:
                skipped.append({"model": sid, "error": str(exc)})
        return {"ok": not skipped, "unloaded": done, "skipped": skipped}

    def gc(self) -> list[str]:
        """空闲回收。只收自己拉起的进程；外部常驻的（ComfyUI）不碰。"""
        now = time.monotonic()
        victims: list[str] = []
        with self._cond:
            for slot in self._slots.values():
                ttl = slot.spec.idle_ttl
                if not slot.loaded or ttl <= 0 or slot.refs > 0 or slot.state != "ready":
                    continue
                if slot.loaded.external:
                    continue
                if slot.last_used and now - slot.last_used >= ttl:
                    victims.append(slot.spec.id)
        for sid in victims:
            self._stop_slot(sid, reason=f"空闲超过 {int(self._slots[sid].spec.idle_ttl)}s")
        return victims

    # ------------------------------------------------------------ 调用

    def run(
        self,
        capability: str,
        payload: dict[str, Any],
        *,
        model_id: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """加载（必要时）→ 调用 → 释放引用。不卸载：留给下一个请求复用。"""
        if not isinstance(payload, dict):
            raise HubError("payload 必须是对象", status=400)
        t0 = time.monotonic()
        swaps_before = self._swap_count
        with self.lease(capability, model_id, timeout) as (spec, loaded):
            wait_ms = int((time.monotonic() - t0) * 1000)
            drv = self.driver(spec)
            try:
                res: InvokeResult = drv.invoke(spec, loaded, payload, self.cfg)
            except HubError:
                raise
            except Exception as exc:  # noqa: BLE001
                self._emit("invoke.error", model=spec.id, error=str(exc)[:300])
                raise HubError(f"{spec.title} 调用失败：{exc}", status=502) from exc
            # 跑完再量一次显存：ComfyUI 是「跑起来才把模型搬进去」，启动那一刻
            # 只有个 CUDA context，账本按那个数就少记一整个模型
            self._refresh_vram(spec, loaded)
        total_ms = int((time.monotonic() - t0) * 1000)
        self._emit(
            "invoke.done",
            model=spec.id,
            capability=capability,
            ms=total_ms,
            loadMs=wait_ms,
        )
        meta = {**res.meta, "loadMs": wait_ms, "totalMs": total_ms}
        if self._swap_count != swaps_before and self._last_swap:
            # 这次调用顺手换了卡上的人，让调用方知道刚才多花的那几十秒去哪了
            meta["swap"] = self._last_swap
        return {
            "ok": True,
            "capability": capability,
            "model": spec.id,
            "kind": res.kind,
            "data": res.data,
            "mime": res.mime,
            "meta": meta,
        }

    def _refresh_vram(self, spec: ModelSpec, loaded: Loaded) -> None:
        if not loaded.pid or not self.gpu.available:
            return
        try:
            mb = self.gpu.mb_of_pid(loaded.pid)
        except GpuError:
            return
        if mb <= 0:
            return
        with self._cond:
            slot = self._slots.get(spec.id)
            if slot and slot.loaded is loaded and slot.state == "ready" and slot.real_mb != mb:
                slot.real_mb = mb
                self._remember_vram(spec.id, mb)

    # ------------------------------------------------------------ 孤儿与状态

    def _state_path(self) -> Path:
        return Path(self.cfg.runtime_dir) / "state.json"

    def _calib_path(self) -> Path:
        return Path(self.cfg.runtime_dir) / "vram.json"

    def _load_calibration(self) -> None:
        """用上次的实测值修正估算。

        估算靠文件大小，Safetensors 和 gguf 差得远、量化方式也影响很大；
        实测一次之后就没必要再猜同一个模型了。留 5% 余量防止边界抖动。
        """
        p = self._calib_path()
        if not p.is_file():
            return
        try:
            rows = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if not isinstance(rows, dict):
            return
        for mid, mb in rows.items():
            slot = self._slots.get(str(mid))
            if not slot or not isinstance(mb, (int, float)) or mb <= 0:
                continue
            # ComfyUI 的占用随工作流变（512 vs 1080p、带不带 refiner），
            # 拿某个工作流的实测值当估算是误导
            if slot.spec.driver == "comfy":
                continue
            slot.est_mb = int(mb * 1.05)

    def _remember_vram(self, model_id: str, mb: int) -> None:
        if mb <= 0:
            return
        slot = self._slots.get(model_id)
        if slot and slot.spec.driver == "comfy":
            return
        p = self._calib_path()
        rows: dict[str, int] = {}
        try:
            if p.is_file():
                raw = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    rows = {str(k): int(v) for k, v in raw.items() if isinstance(v, (int, float))}
        except (OSError, json.JSONDecodeError, ValueError):
            rows = {}
        rows[model_id] = int(mb)
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass

    def _save_state(self) -> None:
        with self._cond:
            self._save_state_locked()

    def _save_state_locked(self) -> None:
        rows = {
            sid: {
                "pid": s.loaded.pid if s.loaded else 0,
                "port": s.loaded.port if s.loaded else 0,
                "state": s.state,
                "at": int(time.time()),
            }
            for sid, s in self._slots.items()
            if s.loaded and s.loaded.pid
        }
        try:
            p = self._state_path()
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass

    def _cleanup_orphans(self) -> None:
        """上次服务被杀，子进程可能还活着并占着卡。只清我们自己记过账的 pid。"""
        p = self._state_path()
        if not p.is_file():
            return
        try:
            rows = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        from .procs import kill_tree, port_open

        killed = []
        for sid, info in (rows or {}).items():
            if not isinstance(info, dict):
                continue
            pid = int(info.get("pid") or 0)
            port = int(info.get("port") or 0)
            if pid <= 0:
                continue
            # 双条件：pid 还活着 **且** 它记的端口在听 —— 防 pid 被别人复用后误杀
            if port and port_open(port) and kill_tree(pid, timeout=5):
                killed.append(sid)
        if killed:
            self._emit("hub.orphans", models=killed)
        try:
            p.unlink()
        except OSError:
            pass
