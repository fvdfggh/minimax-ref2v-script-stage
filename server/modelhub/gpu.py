"""单卡显存账本。

只用 nvidia-smi，不引 pynvml：这台机器上 Python 3.13 + 无依赖能跑起来，是这份
服务第一位的约束（和剧本台后端同一个理由）。代价是只能 1 秒级采样，够用 ——
我们要判断的是「装得下/装不下」，不是每帧占用。
"""

from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

_CSV = "csv,noheader,nounits"


class GpuError(RuntimeError):
    """nvidia-smi 不可用或这张卡不存在。"""


@dataclass(frozen=True)
class GpuStats:
    index: int
    name: str
    total_mb: int
    used_mb: int
    free_mb: int
    uuid: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "index": self.index,
            "name": self.name,
            "totalMb": self.total_mb,
            "usedMb": self.used_mb,
            "freeMb": self.free_mb,
            "uuid": self.uuid,
        }


@dataclass(frozen=True)
class GpuProc:
    pid: int
    used_mb: int
    uuid: str = ""


def find_smi() -> str | None:
    """找到 nvidia-smi。PATH 里没有就试 System32 —— 在 Git Bash 里跑服务时
    常出现 PATH 被裁掉的情况，这一条省掉一次「明明有卡却说没卡」。"""
    import shutil

    for cand in (
        shutil.which("nvidia-smi"),
        shutil.which("nvidia-smi.exe"),
        r"C:\Windows\System32\nvidia-smi.exe",
        "/usr/bin/nvidia-smi",
    ):
        if cand and Path(cand).is_file():
            return str(cand)
    return None


class Gpu:
    """只描述一张卡。index 之外的一律不看、不报、不管。"""

    def __init__(self, index: int, smi: str | None = None, timeout: float = 8.0):
        self.index = int(index)
        self._smi = smi if smi is not None else find_smi()
        self._timeout = timeout

    # ------------------------------------------------------------ 基础查询

    @property
    def available(self) -> bool:
        return bool(self._smi)

    def _run(self, *args: str) -> str:
        if not self._smi:
            raise GpuError(
                "找不到 nvidia-smi：要么这台机器没有 NVIDIA 显卡，要么驱动没装。"
                "只跑语音/生图这类外部服务时可以忽略；要跑 llama.cpp 就得先装驱动。"
            )
        cmd = [self._smi, *args]
        try:
            out = subprocess.run(
                cmd,
                capture_output=True,
                timeout=self._timeout,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise GpuError(f"nvidia-smi 跑不起来：{exc}") from exc
        text = (out.stdout or b"").decode("utf-8", "replace").strip()
        if out.returncode != 0:
            err = (out.stderr or b"").decode("utf-8", "replace").strip()
            raise GpuError(f"nvidia-smi 返回 {out.returncode}：{err or text or '（无输出）'}")
        return text

    def list_indices(self) -> list[int]:
        text = self._run("--query-gpu=index", f"--format={_CSV}")
        return [int(x) for x in text.replace("\r", "").splitlines() if x.strip().isdigit()]

    def stats(self) -> GpuStats | None:
        """读目标卡。驱动不支持/没有卡时返回 None，由上层降级。"""
        try:
            text = self._run(
                "--query-gpu=index,name,memory.total,memory.used,memory.free,uuid",
                f"--format={_CSV}",
            )
        except GpuError:
            return None
        for line in text.replace("\r", "").splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 5:
                continue
            try:
                idx = int(parts[0])
            except ValueError:
                continue
            if idx != self.index:
                continue
            try:
                total, used, free = int(float(parts[2])), int(float(parts[3])), int(float(parts[4]))
            except ValueError:
                continue
            return GpuStats(
                index=idx,
                name=parts[1],
                total_mb=total,
                used_mb=used,
                free_mb=free,
                uuid=parts[5] if len(parts) > 5 else "",
            )
        cards = []
        try:
            cards = self.list_indices()
        except GpuError:
            pass
        raise GpuError(
            f"没有 {self.index} 号卡"
            + (f"；这台机器上是 {cards}" if cards else "")
            + "。改 gpu.index（或环境变量 MODELHUB_GPU）选对卡。"
        )

    def processes(self) -> list[GpuProc]:
        text = self._run(
            "--query-compute-apps=pid,used_memory,gpu_uuid",
            f"--format={_CSV}",
        )
        out: list[GpuProc] = []
        for line in text.replace("\r", "").splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 2 or not parts[0].isdigit():
                continue
            try:
                out.append(GpuProc(int(parts[0]), int(float(parts[1])), parts[2] if len(parts) > 2 else ""))
            except ValueError:
                continue
        return out

    def procs_on_mine(self, stats: GpuStats | None = None) -> list[GpuProc]:
        st = stats or self.stats()
        if st is None:
            return []
        if st.uuid:
            return [p for p in self.processes() if p.uuid == st.uuid]
        return self.processes()

    def mb_of_pid(self, pid: int, stats: GpuStats | None = None) -> int:
        """某个进程在这张卡上占了多少。不在卡上就是 0。"""
        for p in self.procs_on_mine(stats):
            if p.pid == pid:
                return p.used_mb
        return 0

    def pid_on_mine(self, pid: int, stats: GpuStats | None = None) -> bool:
        return any(p.pid == pid for p in self.procs_on_mine(stats))

    # ------------------------------------------------------------ 等待与让位

    def used_by_others(self, own_pids: set[int], stats: GpuStats | None = None) -> int:
        """卡上不属于本服务的占用。这部分是「动不了」的底噪。"""
        return sum(p.used_mb for p in self.procs_on_mine(stats) if p.pid not in own_pids)

    def wait_free(
        self,
        need_mb: int,
        *,
        timeout: float = 45.0,
        own_pids: set[int] | None = None,
        poll: float = 0.6,
    ) -> tuple[bool, GpuStats | None]:
        """等到卡上能腾出 need_mb。

        卸载是异步的（进程退了，驱动释放显存还要几百毫秒），所以「停完就装」
        会偶发 OOM。这里统一等一个水位，装不上再报错也有据可查。
        """
        own = own_pids or set()
        deadline = time.monotonic() + timeout
        last: GpuStats | None = None
        while True:
            try:
                last = self.stats()
            except GpuError:
                return False, last
            if last is not None:
                others = self.used_by_others(own, last)
                if last.total_mb - others >= need_mb:
                    return True, last
            if time.monotonic() >= deadline:
                return False, last
            time.sleep(poll)

    def to_dict(self) -> dict[str, object]:
        out: dict[str, object] = {
            "index": self.index,
            "available": self.available,
            "smi": self._smi,
            "singleCard": True,
        }
        try:
            st = self.stats()
        except GpuError as exc:
            out["stats"] = None
            out["error"] = str(exc)
        else:
            out["stats"] = st.to_dict() if st else None
        return out


def visible_devices_env(index: int) -> dict[str, str]:
    """单卡硬约束：子进程只看得见这一张卡。

    s2 不吃这套（它的 -c 是绝对卡号，传了反而越界），所以驱动可以选择不注入。
    """
    return {
        "CUDA_VISIBLE_DEVICES": str(index),
        "NVIDIA_VISIBLE_DEVICES": str(index),
    }


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                capture_output=True,
                timeout=6,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            text = (out.stdout or b"").decode("utf-8", "replace")
            return str(pid) in text
        except (OSError, subprocess.SubprocessError):
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False
