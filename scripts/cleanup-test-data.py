#!/usr/bin/env python3
"""清理数据目录里的「测试残留」项目。

为什么需要：`series.integration.spec.ts` 打的是**真后端 + 真数据目录**，
跑到一半挂掉（或断言失败）时 `afterAll` 的级联删除不会执行，于是每次留下
一堆「联合测试项目 / 第 01 集」，还会把后续几次运行搞红（④提升 / ⑤
episodesWithEntity 依赖纯净数据）。

判定规则（保守，只动这四类）：
  1. 名字命中测试项目名的剧集（默认：联合测试项目 / 级联删除验证 / 测试项目）
  2. 父剧集已经被 1 删掉、或父剧集本来就不存在的分集（孤儿）
  3. index.json 里有、目录已经不在的幽灵条目
  4. projects/ 下有目录、但既不在 index 也没有 project.json 的无主目录

默认保留 `--keep`（演示集 srs_demo_nightshift / epi_demo_nightshift）。

用法：
    python scripts/cleanup-test-data.py                 # 只打印计划
    python scripts/cleanup-test-data.py --yes           # 真删
    python scripts/cleanup-test-data.py --yes --keep srs_x,epi_y
    python scripts/cleanup-test-data.py --data-dir D:\\data --yes

删除走 `store.Workspace.delete_project`：真删目录 + 写回 index，删不干净会抛错，
不会留下"索引清了、目录还在"的幽灵。删前建议先跑一次不带 --yes 的预览。
"""
from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
from store import Workspace, WorkspaceError  # noqa: E402

TEST_SERIES_NAMES = {"联合测试项目", "级联删除验证", "测试项目"}
DEFAULT_KEEP = {"srs_demo_nightshift", "epi_demo_nightshift"}


def read_json(path: Path) -> object | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def plan_cleanup(root: Path, keep: set[str]) -> dict[str, list]:
    projects = root / "projects"
    index = read_json(root / "index.json")
    rows = index if isinstance(index, list) else []

    series: list[tuple[str, str]] = []
    episodes: list[tuple[str, str, str]] = []
    ghost: list[tuple[str, str]] = []

    for row in rows:
        pid = str(row.get("id") or "")
        if not pid:
            continue
        name = str(row.get("name") or "")
        data = read_json(projects / pid / "project.json")
        if not isinstance(data, dict):
            ghost.append((pid, name))
            continue
        kind = data.get("kind") or ("series" if pid.startswith("srs") else "episode")
        if kind == "series":
            series.append((pid, name))
        else:
            episodes.append((pid, name, str(data.get("seriesId") or "")))

    live_series = {pid for pid, _ in series}
    del_series = [
        (pid, name)
        for pid, name in series
        if pid not in keep and name in TEST_SERIES_NAMES
    ]
    del_series_ids = {pid for pid, _ in del_series}

    del_episodes = [
        (pid, name, sid)
        for pid, name, sid in episodes
        if pid not in keep and (sid in del_series_ids or sid not in live_series)
    ]

    planned = del_series_ids | {pid for pid, _, _ in del_episodes} | {pid for pid, _ in ghost}
    orphan_dirs: list[str] = []
    for entry in sorted(projects.iterdir()) if projects.is_dir() else []:
        if not entry.is_dir():
            continue
        if entry.name in keep or entry.name in planned:
            continue
        if any(str(r.get("id")) == entry.name for r in rows):
            continue
        orphan_dirs.append(entry.name)

    return {
        "series": del_series,
        "episodes": del_episodes,
        "ghost": ghost,
        "orphan_dirs": orphan_dirs,
        "kept": [(pid, name) for pid, name in series if pid not in del_series_ids],
    }


def print_plan(plan: dict[str, list]) -> None:
    print("保留：", ", ".join(f"{p}({n})" for p, n in plan["kept"]) or "(无)")
    for key, title in (
        ("series", "测试剧集"),
        ("episodes", "分集（属测试剧集 / 孤儿）"),
        ("ghost", "幽灵索引项（目录已不在）"),
        ("orphan_dirs", "无主目录（不在索引、无 project.json）"),
    ):
        items = plan[key]
        print(f"\n{title}（{len(items)}）：")
        for item in items:
            print("   ", *item)


def prune_kv(ws: Workspace, live_ids: set[str]) -> None:
    """把 kv 里指向已删项目的悬空引用清掉。"""
    for key in ("cacheBindingsByEpisode", "runConfigByEpisode", "workflowTemplateByEpisode"):
        found, bag = ws.get_kv(key)
        if not found or not isinstance(bag, dict):
            continue
        drop = [k for k in bag if k not in live_ids]
        if drop:
            for k in drop:
                bag.pop(k, None)
            ws.put_kv(key, bag)
            print(f"  kv.{key}: 清掉 {len(drop)} 条悬空引用")

    found, jobs = ws.get_kv("runJobs")
    if found and isinstance(jobs, list):
        kept = [j for j in jobs if str(j.get("episodeId") or "") in live_ids]
        if len(kept) != len(jobs):
            ws.put_kv("runJobs", kept)
            print(f"  kv.runJobs: 清掉 {len(jobs) - len(kept)} 条指向已删分集的任务")

    found, cur = ws.get_kv("currentSeriesId")
    if found and isinstance(cur, str) and cur and cur not in live_ids:
        replacement = "srs_demo_nightshift"
        if replacement in live_ids:
            ws.put_kv("currentSeriesId", replacement)
            print(f"  kv.currentSeriesId: {cur} 已不存在 → {replacement}")


def main() -> int:
    ap = argparse.ArgumentParser(description="清理数据目录里的测试残留项目")
    ap.add_argument("--data-dir", default="", help="数据目录；缺省读 ~/.scriptstage/config.json")
    ap.add_argument("--keep", default="", help="额外保留的项目 id，逗号分隔")
    ap.add_argument("--yes", action="store_true", help="真的删除（缺省只预览）")
    args = ap.parse_args()

    if args.data_dir:
        root = Path(args.data_dir).expanduser().resolve()
    else:
        cfg = read_json(Path.home() / ".scriptstage" / "config.json")
        data_dir = (cfg or {}).get("dataDir") if isinstance(cfg, dict) else None
        root = Path(data_dir).expanduser().resolve() if data_dir else Path.home() / "scriptstage-data"

    if not (root / "index.json").exists():
        print(f"不像数据目录：{root}")
        return 1

    keep = set(DEFAULT_KEEP)
    keep |= {s.strip() for s in args.keep.split(",") if s.strip()}
    ws = Workspace(root)

    plan = plan_cleanup(root, keep)
    print(f"数据目录：{root}\n")
    print_plan(plan)

    total = len(plan["series"]) + len(plan["episodes"]) + len(plan["ghost"]) + len(plan["orphan_dirs"])
    if not total:
        print("\n没有需要清理的东西。")
        return 0
    if not args.yes:
        print(f"\n共 {total} 项待清理。加 --yes 才真删。")
        return 0

    stamp = time.strftime("%Y%m%d-%H%M%S")
    trash = Path(__file__).resolve().parent.parent / ".cache" / "trash" / f"manual-{stamp}"
    print(f"\n删除中（无主目录移到 {trash}）…")
    ok, failed = 0, []
    for pid, _name in plan["series"] + [(p, n) for p, n, _ in plan["episodes"]] + plan["ghost"]:
        try:
            ws.delete_project(pid)
            ok += 1
        except (WorkspaceError, OSError) as exc:
            failed.append((pid, str(exc)[:120]))

    if plan["orphan_dirs"]:
        trash.mkdir(parents=True, exist_ok=True)
        for name in plan["orphan_dirs"]:
            try:
                shutil.move(str(root / "projects" / name), str(trash / name))
                ok += 1
            except OSError as exc:
                failed.append((name, str(exc)[:120]))

    live_ids = {str(r.get("id")) for r in ws.list_index() if r.get("id")}
    prune_kv(ws, live_ids)

    print(f"\n完成：删掉 {ok} 项，失败 {len(failed)} 项")
    for pid, err in failed:
        print(f"   FAIL {pid}: {err}")
    left = ws.list_index()
    print(f"剩余项目（{len(left)}）：")
    for row in left:
        print("   ", row.get("id"), row.get("name"))
    return 0 if not failed else 2


if __name__ == "__main__":
    raise SystemExit(main())
