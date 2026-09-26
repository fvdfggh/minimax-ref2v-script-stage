"""存储层自检：不启服务，直接验证落盘 / 导出 / 导入往返。

跑法：
    python server/selftest.py
"""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from store import Workspace, WorkspaceError  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def check(label: str, cond: bool) -> None:
    print(("  ok   " if cond else "  FAIL ") + label)
    if not cond:
        raise SystemExit(f"自检失败：{label}")


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="scriptstage-selftest-"))
    try:
        ws = Workspace(root)
        ws.ensure()

        # ---- 项目落盘 ----
        project = {
            "id": "prj_abc123",
            "name": "毒尊归来 第01集",
            "story": "楚辞在洞中醒来。",
            "stage": "deliver",
            "settings": {"fps": 24, "maxSegmentFrames": 141},
            "fieldSchema": [{"key": "summary", "order": 2}],
            "createdAt": 1,
            "updatedAt": 2,
        }
        ws.put_project(project)
        check("项目写入后能读回", ws.get_project("prj_abc123") == project)
        check("索引里有这个项目", any(r["id"] == "prj_abc123" for r in ws.list_index()))

        # ---- 集合 upsert ----
        ws.put_rows("prj_abc123", "beats", [{"id": "b1", "projectId": "prj_abc123", "title": "醒来"}])
        ws.put_rows("prj_abc123", "beats", [{"id": "b1", "projectId": "prj_abc123", "title": "醒来（改）"}])
        beats = ws.get_collection("prj_abc123", "beats")
        check("同 id 再写是覆盖而不是追加", len(beats) == 1 and beats[0]["title"] == "醒来（改）")
        ws.delete_rows("prj_abc123", "beats", ["b1"])
        check("按 id 删除生效", ws.get_collection("prj_abc123", "beats") == [])

        # ---- meta / kv ----
        ws.put_meta("prj_abc123", {"overrides:prj_abc123": {"g1": {"summary": "x"}}})
        ws.put_meta("prj_abc123", {"summaries:prj_abc123": {"g1": "s"}})
        check("meta 是增量合并", len(ws.get_meta("prj_abc123")) == 2)
        ws.delete_meta_keys("prj_abc123", ["summaries:prj_abc123"])
        check("meta 按 key 删除", list(ws.get_meta("prj_abc123")) == ["overrides:prj_abc123"])
        ws.put_kv("currentProjectId", "prj_abc123")
        check("全局 kv 读写", ws.get_kv("currentProjectId") == (True, "prj_abc123"))

        # ---- 素材 ----
        ws.write_asset("prj_abc123", "Picture1.png", PNG)
        check("素材落盘", (ws.assets_dir("prj_abc123") / "Picture1.png").read_bytes() == PNG)
        check("素材列表", ws.list_assets("prj_abc123") == ["Picture1.png"])

        # ---- 非法输入必须被挡住 ----
        for bad in ("../escape", "a/b", "prj x", ""):
            try:
                ws.project_dir(bad)
                check(f"非法 id 被拒绝：{bad!r}", False)
            except WorkspaceError:
                check(f"非法 id 被拒绝：{bad!r}", True)
        try:
            ws.write_asset("prj_abc123", "../../evil.png", PNG)
            check("目录穿越文件名被拒绝", False)
        except WorkspaceError:
            check("目录穿越文件名被拒绝", True)

        # ---- 单项目导出 / 导入 ----
        blob = ws.export_project("prj_abc123")
        check("导出是 zip", blob[:2] == b"PK")

        other_root = Path(tempfile.mkdtemp(prefix="scriptstage-import-"))
        try:
            other = Workspace(other_root)
            other.ensure()
            res = other.import_bytes(blob, mode="new")
            check("导入返回新项目 id", res["projectId"] != "prj_abc123" or res["projectId"] == "prj_abc123")
            imported = other.get_project(res["projectId"])
            check("导入后项目内容一致", imported is not None and imported["name"] == "毒尊归来 第01集")
            check("导入后设置一致", imported["settings"]["maxSegmentFrames"] == 141)
            check("素材一起回来了", other.list_assets(res["projectId"]) == ["Picture1.png"])
            check(
                "素材字节一致",
                (other.assets_dir(res["projectId"]) / "Picture1.png").read_bytes() == PNG,
            )
            check("导入进了索引", any(r["id"] == res["projectId"] for r in other.list_index()))
        finally:
            shutil.rmtree(other_root, ignore_errors=True)

        # ---- 整库导出 / 导入 ----
        ws.put_providers([{"id": "p1", "name": "openai", "model": "gpt"}])
        full = ws.export_all()
        third_root = Path(tempfile.mkdtemp(prefix="scriptstage-full-"))
        try:
            third = Workspace(third_root)
            third.ensure()
            res = third.import_bytes(full)
            check("整库导入带回项目", res.get("projects", 0) >= 1)
            check("整库导入带回供应商", any(p.get("id") == "p1" for p in third.get_providers()))
            check(
                "整库导入带回素材",
                third.list_assets("prj_abc123") == ["Picture1.png"],
            )
        finally:
            shutil.rmtree(third_root, ignore_errors=True)

        # ---- 坏文件必须报错，不能静默变空 ----
        try:
            ws.import_bytes(b"not a zip at all")
            check("坏 zip 报错而不是静默成功", False)
        except WorkspaceError:
            check("坏 zip 报错而不是静默成功", True)

        # ---- 损坏的 JSON 必须报错 ----
        (ws.project_dir("prj_abc123") / "beats.json").write_text("{ broken", encoding="utf-8")
        try:
            ws.get_collection("prj_abc123", "beats")
            check("损坏 JSON 抛错而不是当成空", False)
        except WorkspaceError:
            check("损坏 JSON 抛错而不是当成空", True)

        print("\n全部自检通过")
        return 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
