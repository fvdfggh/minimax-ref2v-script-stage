"""子进程：起得来、等得到、停得干净。

三个引擎的脾气不一样，这里只做共同的那部分：
  * 都要一个自己的日志文件（出错时 last_error 里会贴尾 40 行，不贴没法查）；
  * 都要「进程还活着但服务没好」的区分 —— 加载 14G 模型要几十秒，期间
    端口是通不了的，不能当成挂了；
  * Windows 上 terminate 杀不掉进程树（llama-server 会带子线程/dll 宿主），
    统一走 taskkill /T /F。
"""

from __future__ import annotations

import os
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_NEW_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)


class ProcError(RuntimeError):
    """进程起不来 / 起一半死了 / 停不掉。"""


def port_open(port: int, host: str = "127.0.0.1", timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def http_status(url: str, timeout: float = 2.0) -> int | None:
    """拿状态码。连不上返回 None；4xx/5xx 也算拿到了（服务在）。"""
    try:
        with _OPENER.open(url, timeout=timeout) as resp:
            return int(resp.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)
    except (urllib.error.URLError, OSError, ValueError):
        return None


def port_owner(port: int) -> int | None:
    """哪个进程在听这个端口。Windows 用 netstat；查不到返回 None。"""
    if os.name != "nt":
        return None
    try:
        out = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"],
            capture_output=True,
            timeout=8,
            check=False,
            creationflags=_NO_WINDOW,
        )
        text = (out.stdout or b"").decode("utf-8", "replace")
    except (OSError, subprocess.SubprocessError):
        return None
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[3] != "LISTENING":
            continue
        local = parts[1]
        if local.rsplit(":", 1)[-1] == str(port):
            try:
                return int(parts[4])
            except ValueError:
                continue
    return None


def kill_tree(pid: int, timeout: float = 8.0) -> bool:
    """杀掉整个进程树。返回是否确认没了。"""
    if pid <= 0:
        return True
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                timeout=timeout,
                check=False,
                creationflags=_NO_WINDOW,
            )
        except (OSError, subprocess.SubprocessError):
            pass
    else:
        try:
            os.kill(pid, 15)
        except OSError:
            return True
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _alive(pid):
            return True
        time.sleep(0.15)
    if os.name != "nt":
        try:
            os.kill(pid, 9)
        except OSError:
            return True
    return not _alive(pid)


def _alive(pid: int) -> bool:
    if os.name == "nt":
        try:
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                capture_output=True,
                timeout=6,
                check=False,
                creationflags=_NO_WINDOW,
            )
            return str(pid) in (out.stdout or b"").decode("utf-8", "replace")
        except (OSError, subprocess.SubprocessError):
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class ManagedProc:
    """一个由本服务拉起的子进程 + 它的日志。"""

    def __init__(
        self,
        name: str,
        cmd: list[str],
        *,
        cwd: str | Path | None,
        env: dict[str, str],
        log_path: str | Path,
        port: int = 0,
        health: str = "",
        host: str = "127.0.0.1",
        log_max_bytes: int = 32 * 1024 * 1024,
    ):
        self.name = name
        self.cmd = cmd
        self.cwd = str(cwd) if cwd else None
        self.env = env
        self.log_path = Path(log_path)
        self.port = port
        self.health = health
        self.host = host
        #: 单个日志文件的上限，超了就在下次启动时轮转成 `.1`
        self.log_max_bytes = int(log_max_bytes)
        self.pid = 0
        self.started_at = 0.0
        self._log = None

    # ------------------------------------------------------------ 启动

    def start(self) -> int:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._rotate_log()
        self._log = open(self.log_path, "ab", buffering=0)
        self._log.write(
            f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} {self.name}\n"
            f"$ {' '.join(self.cmd)}\n".encode("utf-8")
        )
        try:
            proc = subprocess.Popen(
                self.cmd,
                cwd=self.cwd,
                env=self.env,
                stdin=subprocess.DEVNULL,
                stdout=self._log,
                stderr=subprocess.STDOUT,
                creationflags=_NO_WINDOW | _NEW_GROUP,
            )
        except OSError as exc:
            self._close_log()
            raise ProcError(f"{self.name} 起不来：{exc}（命令 {self.cmd[0]}）") from exc
        self.pid = int(proc.pid or 0)
        self.started_at = time.monotonic()
        # 把 Popen 留在 self 上：被 GC 回收会关掉它持有的句柄
        self._popen = proc
        return self.pid

    def wait_ready(self, timeout: float, *, poll: float = 0.5) -> None:
        """等到能服务。

        判定顺序很重要：先看进程死没死，再看端口通不通，最后看 health。
        health 的 503 是「在加载」，不是失败；404/200 都算就绪（s2 对任何
        路径都回 404，它没有 health 路由）。
        """
        deadline = time.monotonic() + timeout
        last_status: int | None = None
        while True:
            if self.pid and not _alive(self.pid):
                tail = self.tail(40)
                self.stop()
                raise ProcError(
                    f"{self.name} 启动过程中退出了（pid {self.pid}）。日志尾：\n{tail}"
                )
            if self.port and port_open(self.port, self.host):
                if not self.health:
                    return
                status = http_status(f"http://{self.host}:{self.port}{self.health}")
                last_status = status
                if status is not None and status != 503:
                    # 等第一次真正可服务：health 200 通常就位；404 说明路由不同
                    if status == 200 or status == 404:
                        return
            if time.monotonic() >= deadline:
                tail = self.tail(40)
                where = f"端口 {self.port}" if self.port else "进程"
                # 超时的进程必须收掉：它可能已经绑了端口但还没能服务，
                # 留着会让下一次加载撞自己的端口
                self.stop()
                raise ProcError(
                    f"{self.name} 在 {timeout:.0f}s 内没就绪（{where}，"
                    f"最后状态 {last_status}）。日志尾：\n{tail}"
                )
            time.sleep(poll)

    # ------------------------------------------------------------ 停止

    def stop(self, grace: float = 8.0) -> bool:
        pid = self.pid
        if pid <= 0:
            self._close_log()
            return True
        ok = kill_tree(pid, timeout=grace)
        self._close_log()
        self.pid = 0
        return ok

    def alive(self) -> bool:
        return bool(self.pid) and _alive(self.pid)

    # ------------------------------------------------------------ 日志

    def tail(self, lines: int = 40, *, chunk: int = 64 * 1024, limit: int = 4 * 1024 * 1024) -> str:
        """最后 `lines` 行。

        **只读文件尾部**，从后往前一块一块读，凑够行数就停，最多读 `limit`。

        为什么不能整份读：这份日志是引擎自己 `--log` 直接追加的，跑一天就能到
        上百 MB。老写法是 `read_bytes()` → decode → splitlines，2026-10-27 实测
        在 128 MiB 的日志上把工作集从 31.8 MiB 顶到 **517.4 MiB**（+486）——
        因为每一行都是一个独立的 str 对象，光对象头就比正文还大。而这里真正
        要用到的只有最后几十行，seek 到尾部就够了。
        """
        lines = max(1, int(lines))
        try:
            with open(self.log_path, "rb") as fh:
                fh.seek(0, os.SEEK_END)
                pos = fh.tell()
                pieces: list[bytes] = []
                seen = 0
                while pos > 0 and seen <= lines and sum(len(p) for p in pieces) < limit:
                    step = min(chunk, pos)
                    pos -= step
                    fh.seek(pos)
                    piece = fh.read(step)
                    pieces.append(piece)
                    seen += piece.count(b"\n")
                buf = b"".join(reversed(pieces))
        except OSError:
            return "（没有日志）"
        text = buf.decode("utf-8", "replace")
        rows = [r for r in text.replace("\r\n", "\n").split("\n") if r.strip()]
        if pos > 0 and len(rows) > 1:
            # 从中间截断的：第一行是半截，丢掉，免得看起来像日志坏了
            rows = rows[1:]
        return "\n".join(rows[-lines:]) if rows else "（日志是空的）"

    def _rotate_log(self) -> None:
        """日志超过上限就改名留一份 ``.1``。

        只能在这里做：只有启动这一刻没有别的句柄在写这个文件，改名一定成功。
        不设上限的日志不只是磁盘问题 —— 任何一次 `tail()` 都要去读它。
        """
        try:
            size = self.log_path.stat().st_size
        except OSError:
            return
        if size <= self.log_max_bytes:
            return
        prev = self.log_path.with_name(self.log_path.name + ".1")
        try:
            if prev.exists():
                prev.unlink()
            self.log_path.rename(prev)
        except OSError:
            pass                                     # 转不了就继续追加，不影响功能

    def _close_log(self) -> None:
        try:
            if self._log:
                self._log.flush()
                self._log.close()
        except OSError:
            pass
        self._log = None
