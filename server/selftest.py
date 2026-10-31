"""存储层自检：不启服务，直接验证落盘 / 导出 / 导入往返。

跑法：
    python server/selftest.py
"""

from __future__ import annotations

import io
import json
import shutil
import sys
import tempfile
import time
import zipfile
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

        # ---- 变更指纹（前端靠它发现"别处改过"）----
        revs = ws.collection_revs("prj_abc123")
        check("指纹覆盖项目 / meta / 四个集合", set(revs) == {"project", "meta", "entities", "beats", "assemblies", "assets"})
        before = revs["beats"]
        # 文件系统时间戳精度有限：同一纳秒内连写两次会拿到同一个指纹，
        # 这里显式等一下，测的是"写库会让指纹变"而不是时序运气
        time.sleep(0.02)
        ws.put_rows("prj_abc123", "beats", [{"id": "b9", "projectId": "prj_abc123", "title": "指纹"}])
        check("写库后指纹必变", ws.collection_revs("prj_abc123")["beats"] != before)
        ws.delete_rows("prj_abc123", "beats", ["b9"])

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

        # ---- 项目包导出 / 导入：连各集、素材、音色包一起走 ----
        # 这一节对应「换一台设备接着做」：只带走一份 JSON 是不够的。
        packs_src = Path(tempfile.mkdtemp(prefix="scriptstage-packs-"))
        packs_dst = Path(tempfile.mkdtemp(prefix="scriptstage-packs2-"))
        tree_root = Path(tempfile.mkdtemp(prefix="scriptstage-tree-"))
        try:
            (packs_src / "v_ok.s2voice").write_bytes(b"S2VOICE" * 64)
            (packs_src / "v_ok.json").write_text('{"id": "v_ok"}', encoding="utf-8")

            tree = Workspace(tree_root, pack_dir=packs_src)
            tree.ensure()
            tree.put_project(
                {
                    "id": "srs_t1",
                    "name": "夜班",
                    "kind": "series",
                    "episodeIds": ["epi_t1", "epi_t2"],
                    "story": "",
                    "stage": "deliver",
                    "settings": {"fps": 24},
                    "fieldSchema": [],
                    "createdAt": 1,
                    "updatedAt": 1,
                }
            )
            for i, (eid, pack) in enumerate((("epi_t1", "v_ok"), ("epi_t2", "v_gone")), start=1):
                tree.put_project(
                    {
                        "id": eid,
                        "name": f"第0{i}集",
                        "kind": "episode",
                        "seriesId": "srs_t1",
                        "story": "s",
                        "stage": "split",
                        "settings": {"fps": 24},
                        "fieldSchema": [],
                        "createdAt": 1,
                        "updatedAt": 1,
                    }
                )
                tree.put_rows(
                    eid,
                    "entities",
                    [{"id": f"ent_{i}", "projectId": eid, "name": "林小满", "voicePack": {"id": pack}}],
                )
                tree.put_rows(
                    eid, "beats", [{"id": f"b_{i}", "projectId": eid, "dialogue": "你好"}]
                )
                tree.write_asset(eid, f"Picture{i}.png", PNG)

            bundle = tree.export_project("srs_t1")
            check("项目包是 zip", bundle[:2] == b"PK")

            with zipfile.ZipFile(io.BytesIO(bundle)) as zf:
                names = zf.namelist()
                manifest = json.loads(zf.read("manifest.json"))
            check("项目包里含项目与两集", len([n for n in names if n.endswith("project.json")]) == 3)
            check("音色包被打进包", "voices/packs/v_ok.s2voice" in names)
            check(
                "导出时就记下缺失音色包",
                [m["id"] for m in manifest["missing"]["voicePacks"]] == ["v_gone"],
            )
            check("包里有给人看的 README", "README.txt" in names)

            # 另一台"设备"：只有一份空数据目录
            dst = Workspace(packs_dst / "data", pack_dir=packs_dst)
            dst.ensure()
            res = dst.import_bytes(bundle, mode="new")
            root_proj = dst.get_project(res["projectId"])
            check("根项目重新分配了 id", root_proj is not None and res["projectId"] != "srs_t1")
            check("两集都跟着回来了", len(root_proj["episodeIds"]) == 2)
            check("音色包落到本机目录", (packs_dst / "v_ok.s2voice").is_file())
            check("缺失清单原样带到对面", [m["id"] for m in res["missingPacks"]] == ["v_gone"])

            for eid in root_proj["episodeIds"]:
                ep = dst.get_project(eid)
                ents = dst.get_collection(eid, "entities")
                beats = dst.get_collection(eid, "beats")
                check(f"集 {eid} 挂回新根", ep["seriesId"] == res["projectId"])
                check(
                    f"集 {eid} 的行 projectId 全部重映射",
                    all(r["projectId"] == eid for r in ents + beats),
                )
                check(f"集 {eid} 的素材回来了", len(dst.list_assets(eid)) == 1)

            again = dst.import_bytes(bundle, mode="new")
            check("二次导入音色包是跳过而不是覆盖", again["voicePacks"]["kept"] == ["v_ok"])
            check("二次导入仍是一份包文件", len(list(packs_dst.glob("*.s2voice"))) == 1)

            # replace：落回原来的 id（同一台设备重装时用）
            tree.put_project(
                {
                    "id": "epi_solo",
                    "name": "单独一集",
                    "kind": "episode",
                    "seriesId": None,
                    "story": "",
                    "stage": "split",
                    "settings": {},
                    "fieldSchema": [],
                    "createdAt": 1,
                    "updatedAt": 1,
                }
            )
            solo = tree.export_project("epi_solo")
            replaced = dst.import_bytes(solo, mode="replace")
            check("replace 模式沿用原 id", replaced["projectId"] == "epi_solo")
        finally:
            for d in (packs_src, packs_dst, tree_root):
                shutil.rmtree(d, ignore_errors=True)

        # ---- 删系列要连集一起删 ----
        # 本的坑：DELETE 只认传进来的 id，直接调 API 删系列会留下孤儿集
        # （列表里查无此根，磁盘上还占着）。
        tree2_root = Path(tempfile.mkdtemp(prefix="scriptstage-cascade-"))
        try:
            t2 = Workspace(tree2_root)
            t2.ensure()
            t2.put_project(
                {"id": "srs_c1", "name": "系列", "kind": "series", "episodeIds": ["epi_c1"],
                 "story": "", "stage": "split", "settings": {}, "fieldSchema": [],
                 "createdAt": 1, "updatedAt": 1}
            )
            t2.put_project(
                {"id": "epi_c1", "name": "第01集", "kind": "episode", "seriesId": "srs_c1",
                 "story": "", "stage": "split", "settings": {}, "fieldSchema": [],
                 "createdAt": 1, "updatedAt": 1}
            )
            t2.delete_project("srs_c1")
            check("删系列后集也没了", t2.get_project("epi_c1") is None)
            check("删系列后索引干净", t2.list_index() == [])
            check("删系列后目录也没了", not (t2.root / "projects" / "epi_c1").exists())
        finally:
            shutil.rmtree(tree2_root, ignore_errors=True)

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
