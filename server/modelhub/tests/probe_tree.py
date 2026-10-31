"""采整棵进程树的内存：modelhub + 它拉起来的每一个引擎进程。

为什么必须看整棵树：`modelhub` 自己只有 30 MB 级，真正的模型全在子进程里 ——
llama-server 的 gguf、s2 的权重、ComfyUI 的 safetensors。只看父进程等于没量。

两个数分开记（Windows 上差别巨大，混着说会得出相反的结论）：

  * **WorkingSet** —— 含 mmap 的文件页。llama-server 的 13.6 GB 里 13.3 GB 是
    这个（gguf 直接映射进来的），系统一有压力就回收，不是真占用；
  * **Private**  —— 进程独占的提交量（页文件）。这个才杀不掉、才决定要不要加内存。

用法（需要服务先起着）：

    python -m modelhub.tests.probe_tree                  # 自动找 8790 的进程，跑 10 分钟
    python -m modelhub.tests.probe_tree --seconds 1800 --out tree.csv
    python -m modelhub.tests.probe_tree --pid 12345      # 指到别的进程上

采样期间去调 `/v1/run` 触发各种能力，结束后看 PEAK 那两行。
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import time

kernel32 = ctypes.windll.kernel32
psapi = ctypes.windll.psapi

TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
GIB = float(1 << 30)


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD),
        ("cntUsage", wt.DWORD),
        ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wt.DWORD),
        ("cntThreads", wt.DWORD),
        ("th32ParentProcessID", wt.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wt.DWORD),
        ("szExeFile", ctypes.c_char * 260),
    ]


class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
    _fields_ = [
        ("cb", wt.DWORD),
        ("PageFaultCount", wt.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
        ("PrivateUsage", ctypes.c_size_t),
    ]


def snapshot() -> list[tuple[int, int, str]]:
    """当前所有进程的 (pid, ppid, 名字)。"""
    h = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if h == -1:
        return []
    rows: list[tuple[int, int, str]] = []
    e = PROCESSENTRY32()
    e.dwSize = ctypes.sizeof(PROCESSENTRY32)
    ok = kernel32.Process32First(h, ctypes.byref(e))
    while ok:
        rows.append((e.th32ProcessID, e.th32ParentProcessID,
                     e.szExeFile.decode("mbcs", "replace")))
        ok = kernel32.Process32Next(h, ctypes.byref(e))
    kernel32.CloseHandle(h)
    return rows


def mem(pid: int) -> tuple[int, int]:
    """(working_set, private) 字节；进程已死或权限不够时 (0, 0)。"""
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return 0, 0
    pmc = PROCESS_MEMORY_COUNTERS_EX()
    pmc.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS_EX)
    ws = pv = 0
    if psapi.GetProcessMemoryInfo(h, ctypes.byref(pmc), pmc.cb):
        ws, pv = pmc.WorkingSetSize, pmc.PrivateUsage
    kernel32.CloseHandle(h)
    return ws, pv


def tree(root: int) -> list[tuple[int, str]]:
    rows = snapshot()
    kids: dict[int, list[int]] = {}
    names: dict[int, str] = {}
    for pid, ppid, name in rows:
        kids.setdefault(ppid, []).append(pid)
        names[pid] = name
    out, stack = [], [root]
    while stack:
        pid = stack.pop()
        out.append((pid, names.get(pid, "?")))
        stack.extend(kids.get(pid, []))
    return out


def find_root(port: int = 8790) -> int:
    """找监听该端口的进程 —— 也就是 modelhub 自己。"""
    import socket
    import subprocess

    s = socket.socket()
    if s.connect_ex(("127.0.0.1", port)) != 0:
        raise SystemExit(f"端口 {port} 没人在听：先把 `python -m modelhub serve` 起着")
    s.close()
    out = subprocess.run(
        ["netstat", "-ano", "-p", "TCP"],
        capture_output=True, text=True, errors="replace",
    ).stdout
    for line in out.splitlines():
        f = line.split()
        if len(f) >= 5 and f[1].endswith(f":{port}") and f[3] == "LISTENING":
            return int(f[4])
    raise SystemExit(f"听 {port} 的进程没找到")


def main() -> None:
    ap = argparse.ArgumentParser(description="采 modelhub 整棵进程树的内存")
    ap.add_argument("--pid", type=int, default=0, help="根进程；不给就找 8790")
    ap.add_argument("--seconds", type=float, default=600.0)
    ap.add_argument("--out", default="tree_mem.csv")
    ap.add_argument("--interval", type=float, default=1.0)
    args = ap.parse_args()

    root = args.pid or find_root()
    print(f"根进程 {root}；采 {args.seconds:.0f}s，每 {args.interval:g}s 一次 → {args.out}")

    t0 = time.time()
    lines = ["t,procs,ws_gb,priv_gb,detail"]
    peak_ws = peak_pv = 0.0
    peak_pid: dict[int, tuple[float, float, str]] = {}
    last = 0.0
    try:
        while time.time() - t0 < args.seconds:
            t = time.time() - t0
            rows = tree(root)
            ws = pv = 0
            parts = []
            for pid, name in rows:
                a, b = mem(pid)
                if a <= 0 and b <= 0:
                    continue
                ws += a
                pv += b
                prev = peak_pid.get(pid)
                if not prev or b > prev[1]:
                    peak_pid[pid] = (a / GIB, b / GIB, name)
                if a > 100 * 1048576:                     # 明细只留过 100 MB 的
                    parts.append(f"{name}:{pid}:{a / GIB:.2f}/{b / GIB:.2f}")
            ws_gb, pv_gb = ws / GIB, pv / GIB
            peak_ws = max(peak_ws, ws_gb)
            peak_pv = max(peak_pv, pv_gb)
            lines.append(f"{t:.1f},{len(rows)},{ws_gb:.3f},{pv_gb:.3f},{' '.join(parts)}")
            if t - last >= 15:
                print(f"{t:7.1f}s  {len(rows)} 进程  WS {ws_gb:6.2f} GB  私有 {pv_gb:6.2f} GB"
                      f"  {' '.join(parts[:3])}", flush=True)
                last = t
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n（手工中断，照样落盘）")
    finally:
        elapsed = time.time() - t0
        with open(args.out, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        print(f"\n【整棵树峰值】WS {peak_ws:.2f} GB   私有 {peak_pv:.2f} GB"
              f"   采了 {elapsed:.0f}s → {args.out}")
        for pid, (a, b, name) in sorted(peak_pid.items(), key=lambda kv: -kv[1][1]):
            print(f"   {name:<22} pid {pid:<7} 峰值 WS {a:5.2f} GB  私有 {b:5.2f} GB")


if __name__ == "__main__":
    main()
