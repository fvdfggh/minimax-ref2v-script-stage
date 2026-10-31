"""数据目录：项目 JSON 与素材文件的唯一真相源。

浏览器里的 IndexedDB 会随清缓存一起消失，这个模块把同一份数据落到
用户自己挑的文件夹里，一眼能看见、能备份、能进版本管理。

落盘规则（都是踩过才知道要定的）：

* ``id`` 必须匹配 ``SAFE_ID_RE``，文件名必须匹配 ``SAFE_FILE_RE`` ——
  项目 id 直接参与拼路径，不做校验就是一个目录穿越漏洞；
* JSON 一律原子写（临时文件 + ``os.replace``），写到一半崩了不会留下半个文件；
* 读不到文件 = 没有数据，返回默认；读得到但解析失败 = 数据坏了，
  必须抛错，绝不能静默当成空数据把用户内容"抹掉"。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import threading
import time
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SAFE_FILE_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

#: 每个项目一份的集合文件。
#: ``assets`` 存的是素材元数据（编号/标签/文件名），图片本体在同级 assets/ 目录里。
COLLECTIONS = ("entities", "beats", "assemblies", "assets")

EXPORT_FORMAT = "scriptstage-project"
#: 1 = 只打一个 project 目录（老格式，导入仍然认）
#: 2 = 项目树（项目 + 各集）+ 素材 + 音色包，换设备能直接接着用
EXPORT_VERSION = 2
#: 前端 db/index.ts 的 exportBackup 产出的老格式，导入时一并认
LEGACY_FORMAT = "scriptstage-backup"

CONFIG_NAME = "config.json"
INDEX_NAME = "index.json"
PROVIDERS_NAME = "providers.json"


class WorkspaceError(Exception):
    """数据目录层面的可预期错误（id 非法、数据损坏、zip 不认）。"""


def _stamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


_WRITE_LOCK = threading.Lock()


def _atomic_write_json(path: Path, data: Any) -> None:
    """
    原子写 JSON（临时文件 + os.replace），写到一半崩了不会留下半个文件。

    ★ Windows 上 ``os.replace`` 会偶发 ``PermissionError: [WinError 5]``：
    目标文件正被别的句柄开着（另一个线程在读、杀毒/索引器在扫）时，
    Windows 不允许替换，而 POSIX 上同一操作是允许的。本机是
    ThreadingHTTPServer（并发请求）+ 中文目录，实测必现。
    所以这里做三件事：
      1. 全局锁：不让两个线程同时改同一个文件；
      2. 重试 + 退避：让"短暂被占用"自己过去；
      3. 兜底直写：实在换不动就直接覆盖，总比让整条提交链崩掉强。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, indent=2) + "\n"

    with _WRITE_LOCK:
        last: OSError | None = None
        for attempt in range(12):
            tmp_name = ""
            try:
                fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    fh.write(payload)
                os.replace(tmp_name, path)
                return
            except PermissionError as exc:
                last = exc
                if tmp_name:
                    try:
                        os.unlink(tmp_name)
                    except OSError:
                        pass
                time.sleep(0.02 * (attempt + 1))
            except OSError as exc:
                last = exc
                if tmp_name:
                    try:
                        os.unlink(tmp_name)
                    except OSError:
                        pass
                break
            except BaseException:
                if tmp_name:
                    try:
                        os.unlink(tmp_name)
                    except OSError:
                        pass
                raise

        # 兜底：直写。不是原子的，但 Windows 上"写不进去"比"偶尔半截文件"更致命。
        try:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(payload)
            return
        except OSError:
            raise last if last is not None else RuntimeError(f"写不进 {path}")


def _read_json(path: Path, default: Any) -> Any:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return default
    except OSError as exc:
        raise WorkspaceError(f"读取失败 {path.name}: {exc}") from exc
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise WorkspaceError(f"{path.name} 已损坏，无法解析：{exc}") from exc


def _rows_of(value: Any) -> list[dict]:
    return value if isinstance(value, list) else []


def _sha256(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def _bundle_readme(manifest: dict) -> str:
    """zip 里那张给人看的说明。换设备时先看它，比翻文档快。"""
    st = manifest.get("stats") or {}
    packs = manifest.get("voicePacks") or []
    missing = (manifest.get("missing") or {}).get("voicePacks") or []
    lines = [
        f"剧本台项目包：{manifest.get('rootName') or ''}",
        "=" * 40,
        f"导出于 {manifest.get('exportedAt') or ''}",
        f"内容：{st.get('projects', 0)} 个项目目录、{st.get('assets', 0)} 个素材"
        f"（{round((st.get('assetsBytes') or 0) / 1048576, 1)} MB）、"
        f"{len(packs)} 个音色包",
        "",
        "在新设备上用：",
        "1) 装好剧本台，启动后端：python server/app.py",
        "2) 打开首页 →「导入项目」，选这个 zip（也可在 存储 → 导入备份 里导入）",
        "3) 导入是「新建一份」，不会覆盖本机已有项目；项目和各集的 id 会重新分配",
        "4) 音色包会被放进本机音色目录（默认 C:/s2/voices/packs），已存在的同名包不覆盖",
        "5) 想重新配音/合成，本机还要有语音服务（qwen3 设计 + s2 合成，见语音合成目录 README）",
        "",
        "包里没有：API Key / 供应商设置（与设备绑定）、ComfyUI 工作流模板、生成中的临时文件。",
    ]
    if missing:
        lines += [
            "",
            "注意：导出时本机就找不到下面这些音色包，接收端也不会有：",
            *[f"  - {m.get('id')}（{m.get('entity') or '?'}）" for m in missing],
        ]
    return "\n".join(lines) + "\n"


class Workspace:
    def __init__(self, root: str | Path, pack_dir: str | Path | None = None):
        self.root = Path(root)
        #: 音色包目录（.s2voice）。不在数据目录里 —— 它是两个语音引擎共用的资产，
        #: 所以由外面（app.py 从 voice.py 取）传进来；不传就只导出 JSON 和素材。
        self.pack_dir = Path(pack_dir) if pack_dir else None

    # ------------------------------ 基础 ------------------------------

    def ensure(self) -> None:
        (self.root / "projects").mkdir(parents=True, exist_ok=True)
        if not (self.root / INDEX_NAME).exists():
            _atomic_write_json(self.root / INDEX_NAME, [])

    def _pid(self, project_id: str) -> str:
        if not SAFE_ID_RE.match(str(project_id or "")):
            raise WorkspaceError(f"非法项目 id：{project_id!r}")
        return str(project_id)

    def _fname(self, filename: str) -> str:
        name = str(filename or "")
        if not SAFE_FILE_RE.match(name) or ".." in name:
            raise WorkspaceError(f"非法素材文件名：{filename!r}")
        return name

    def project_dir(self, project_id: str) -> Path:
        return self.root / "projects" / self._pid(project_id)

    def assets_dir(self, project_id: str) -> Path:
        return self.project_dir(project_id) / "assets"

    # ------------------------------ 索引 ------------------------------

    def list_index(self) -> list[dict]:
        return _rows_of(_read_json(self.root / INDEX_NAME, []))

    def _write_index(self, rows: list[dict]) -> None:
        _atomic_write_json(self.root / INDEX_NAME, rows)

    def _reindex_project(self, project: dict) -> None:
        rows = self.list_index()
        summary = {
            "id": project.get("id"),
            "name": project.get("name") or "未命名项目",
            "stage": project.get("stage") or "split",
            "updatedAt": project.get("updatedAt") or 0,
            "createdAt": project.get("createdAt") or 0,
        }
        for i, row in enumerate(rows):
            if row.get("id") == summary["id"]:
                rows[i] = summary
                break
        else:
            rows.append(summary)
        self._write_index(rows)

    # ------------------------------ 项目 ------------------------------

    def get_project(self, project_id: str) -> dict | None:
        data = _read_json(self.project_dir(project_id) / "project.json", None)
        return data if isinstance(data, dict) else None

    def put_project(self, project: dict) -> None:
        pid = self._pid(str(project.get("id") or ""))
        self.project_dir(pid).mkdir(parents=True, exist_ok=True)
        _atomic_write_json(self.project_dir(pid) / "project.json", project)
        self._reindex_project(project)

    def delete_project(self, project_id: str) -> None:
        """删除项目目录。

        必须"真删干净才算数"：先反复 rmtree（Windows 上文件句柄/占用
        会短暂锁住目录），确认目录彻底消失后才更新索引。删不掉就抛错，
        绝不"索引清了、目录留着"——那会留下幽灵项目（列表里没了，
        磁盘还占着，``GET /projects/<id>`` 还能 200 读回）。

        删系列时**连带把它的集删掉**：集的归属只写在 ``seriesId`` 里，
        系列没了它就成了库里的孤儿（列表里查无此根、删也删不到）。
        前端走的是把 id 一起传上来的删除，但任何直接调 API 的人都不该
        因为少传几个 id 就在磁盘上留下一堆没人认领的目录。
        """
        pid = self._pid(project_id)
        project = self.get_project(pid)
        children = [str(x) for x in (project or {}).get("episodeIds") or []]
        for child in children:
            if child != pid and SAFE_ID_RE.match(child) and self.get_project(child) is not None:
                self.delete_project(child)

        target = self.project_dir(pid)
        last_err: Exception | None = None
        for attempt in range(5):
            try:
                shutil.rmtree(target)
                last_err = None
                break
            except OSError as exc:
                last_err = exc
                if not target.exists():
                    break
                time.sleep(0.1 * (attempt + 1))
        if target.exists():
            raise WorkspaceError(
                f"无法彻底删除项目 {pid}（目录被占用）：{last_err}"
            )
        self._write_index([r for r in self.list_index() if r.get("id") != pid])

    # ------------------------------ 集合 ------------------------------

    def _collection_path(self, project_id: str, name: str) -> Path:
        if name not in COLLECTIONS:
            raise WorkspaceError(f"未知集合：{name}")
        return self.project_dir(project_id) / f"{name}.json"

    def get_collection(self, project_id: str, name: str) -> list[dict]:
        return _rows_of(_read_json(self._collection_path(project_id, name), []))

    def put_rows(self, project_id: str, name: str, rows: Iterable[dict]) -> None:
        """按 id 做 upsert，未提及的行保持不动。"""
        incoming = [r for r in rows if isinstance(r, dict) and r.get("id")]
        if not incoming:
            return
        current = self.get_collection(project_id, name)
        by_id = {str(r.get("id")): r for r in current}
        for row in incoming:
            by_id[str(row.get("id"))] = row
        _atomic_write_json(self._collection_path(project_id, name), list(by_id.values()))

    def delete_rows(self, project_id: str, name: str, ids: Iterable[str]) -> None:
        drop = {str(i) for i in ids}
        if not drop:
            return
        rows = self.get_collection(project_id, name)
        removed = [r for r in rows if str(r.get("id")) in drop]
        kept = [r for r in rows if str(r.get("id")) not in drop]
        _atomic_write_json(self._collection_path(project_id, name), kept)
        # 素材行删了，文件也要跟着删：否则"移除参考图"只是在库里消失，
        # 磁盘上还留着一份，换图换几次就攒出一堆没人引用的文件。
        if name == "assets":
            for r in removed:
                fname = str(r.get("fileName") or "")
                if fname:
                    try:
                        self.delete_asset(project_id, fname)
                    except OSError:
                        pass

    # ------------------------------ 变更指纹 ------------------------------

    def collection_revs(self, project_id: str) -> dict[str, str]:
        """每个数据文件的内容指纹（mtime_ns:size），给前端做"别处改过没有"的比对。

        为什么用指纹而不是「修订号」：写入口有 PUT 集合 / DELETE / meta / 项目本身
        好几条，逐条去 bump 一个计数器容易漏（漏了就是「改了但没人知道」）。
        直接看盘上的文件，写入口怎么变都不会失真。

        用 mtime_ns 而不是 mtime：同一秒里连改两次（AI 修复一次改多段）在秒级
        精度下看起来完全一样。原子写用的是 os.replace，新文件的时间戳一定是新的。
        """
        d = self.project_dir(project_id)
        names = {"project": d / "project.json", "meta": d / "meta.json"}
        for name in COLLECTIONS:
            names[name] = d / f"{name}.json"
        out: dict[str, str] = {}
        for name, path in names.items():
            try:
                st = path.stat()
            except OSError:
                out[name] = "0:0"
                continue
            out[name] = f"{st.st_mtime_ns}:{st.st_size}"
        return out

    # ------------------------------ kv / meta ------------------------------

    def get_meta(self, project_id: str) -> dict:
        data = _read_json(self.project_dir(project_id) / "meta.json", {})
        return data if isinstance(data, dict) else {}

    def put_meta(self, project_id: str, patch: dict) -> None:
        merged = {**self.get_meta(project_id), **patch}
        _atomic_write_json(self.project_dir(project_id) / "meta.json", merged)

    def delete_meta_keys(self, project_id: str, keys: Iterable[str]) -> None:
        meta = self.get_meta(project_id)
        for k in keys:
            meta.pop(k, None)
        _atomic_write_json(self.project_dir(project_id) / "meta.json", meta)

    # ------------------------------ 全局 kv ------------------------------

    def get_kv(self, key: str) -> tuple[bool, Any]:
        """不属于任何项目的零散键（当前项目 id、当前供应商 id）。"""
        data = _read_json(self.root / "kv.json", {})
        bag = data if isinstance(data, dict) else {}
        return (key in bag), bag.get(key)

    def put_kv(self, key: str, value: Any) -> None:
        data = _read_json(self.root / "kv.json", {})
        bag = data if isinstance(data, dict) else {}
        bag[key] = value
        _atomic_write_json(self.root / "kv.json", bag)

    def delete_kv(self, key: str) -> None:
        data = _read_json(self.root / "kv.json", {})
        bag = data if isinstance(data, dict) else {}
        if key in bag:
            del bag[key]
            _atomic_write_json(self.root / "kv.json", bag)

    # ------------------------------ 供应商 ------------------------------

    def get_providers(self) -> list[dict]:
        return _rows_of(_read_json(self.root / PROVIDERS_NAME, []))

    def put_providers(self, rows: list[dict]) -> None:
        _atomic_write_json(self.root / PROVIDERS_NAME, rows)

    # ------------------------------ 素材 ------------------------------

    def list_assets(self, project_id: str) -> list[str]:
        d = self.assets_dir(project_id)
        if not d.is_dir():
            return []
        return sorted(p.name for p in d.iterdir() if p.is_file())

    def asset_path(self, project_id: str, filename: str) -> Path:
        return self.assets_dir(project_id) / self._fname(filename)

    def write_asset(self, project_id: str, filename: str, payload: bytes) -> str:
        name = self._fname(filename)
        target = self.assets_dir(project_id)
        target.mkdir(parents=True, exist_ok=True)
        (target / name).write_bytes(payload)
        return name

    def delete_asset(self, project_id: str, filename: str) -> None:
        path = self.asset_path(project_id, filename)
        if path.is_file():
            path.unlink()

    # ------------------------------ 导出 ------------------------------

    def _bundle_ids(self, project_id: str) -> list[str]:
        """一个「项目」到底包含哪些目录：项目自身 + 它下面的每一集（有序）。

        集是独立项目目录（epi_*），只打 srs_* 那个目录的话，换台设备打开就是空壳。
        """
        pid = self._pid(project_id)
        project = self.get_project(pid) or {}
        ids = [pid]
        if project.get("kind") == "series":
            for eid in project.get("episodeIds") or []:
                if (
                    isinstance(eid, str)
                    and eid != pid
                    and SAFE_ID_RE.match(eid)
                    and self.get_project(eid) is not None
                ):
                    ids.append(eid)
        return ids

    def _pack_path(self, voice_id: str) -> Path | None:
        if self.pack_dir is None or not SAFE_ID_RE.match(voice_id):
            return None
        return self.pack_dir / f"{voice_id}.s2voice"

    def bundle_manifest(self, project_id: str) -> dict:
        """项目的「装箱单」：不打包，只说清楚里面有什么、缺什么。

        前端拿它先给用户看一眼（几个集 / 多少素材 / 多少音色包 / 哪些包在本机就没了），
        导出 zip 用的是同一份，避免"提示说 3 个包、实际只装了 2 个"。
        """
        pid = self._pid(project_id)
        project = self.get_project(pid)
        if project is None:
            raise WorkspaceError(f"项目不存在：{pid}")

        projects: list[dict] = []
        stats = {"projects": 0, "assets": 0, "assetsBytes": 0, "beats": 0, "entities": 0}
        packs: dict[str, dict | None] = {}
        missing: list[dict] = []

        for child in self._bundle_ids(pid):
            row = self.get_project(child) or {}
            projects.append(
                {
                    "id": child,
                    "name": str(row.get("name") or ""),
                    "kind": str(row.get("kind") or "episode"),
                }
            )
            stats["projects"] += 1
            entities = self.get_collection(child, "entities")
            stats["entities"] += len(entities)
            stats["beats"] += len(self.get_collection(child, "beats"))

            for ent in entities:
                pack = ent.get("voicePack")
                vid = str((pack or {}).get("id") or "") if isinstance(pack, dict) else ""
                if not vid or vid in packs:
                    continue
                path = self._pack_path(vid)
                if path is None or not path.is_file():
                    packs[vid] = None
                    missing.append(
                        {"id": vid, "entity": str(ent.get("name") or ""), "projectId": child}
                    )
                    continue
                blob = path.read_bytes()
                packs[vid] = {
                    "id": vid,
                    "file": f"{vid}.s2voice",
                    "bytes": len(blob),
                    "sha256": _sha256(blob),
                    "desc": str(ent.get("voiceDesc") or ""),
                    "seed": pack.get("seed"),
                }

            for fname in self.list_assets(child):
                stats["assets"] += 1
                try:
                    stats["assetsBytes"] += self.asset_path(child, fname).stat().st_size
                except OSError:
                    pass

        voice_rows = [v for v in packs.values() if v]
        stats["voicePacks"] = len(voice_rows)
        stats["voicePacksBytes"] = sum(int(r.get("bytes") or 0) for r in voice_rows)
        stats["bytes"] = stats["assetsBytes"] + stats["voicePacksBytes"]

        return {
            "format": EXPORT_FORMAT,
            "version": EXPORT_VERSION,
            "scope": "project",
            "exportedAt": _stamp(),
            "rootId": pid,
            "rootName": str(project.get("name") or ""),
            "projects": projects,
            "voicePacks": voice_rows,
            "missing": {"voicePacks": missing},
            "stats": stats,
        }

    def _write_project_tree(self, zf: zipfile.ZipFile, ids: Iterable[str]) -> None:
        for pid in ids:
            project = self.get_project(pid)
            if project is None:
                continue
            base = f"projects/{pid}"
            zf.writestr(f"{base}/project.json", json.dumps(project, ensure_ascii=False, indent=2))
            for name in COLLECTIONS:
                rows = self.get_collection(pid, name)
                zf.writestr(f"{base}/{name}.json", json.dumps(rows, ensure_ascii=False, indent=2))
            zf.writestr(f"{base}/meta.json", json.dumps(self.get_meta(pid), ensure_ascii=False, indent=2))
            for fname in self.list_assets(pid):
                zf.write(self.asset_path(pid, fname), f"{base}/assets/{fname}")

    def _write_packs(self, zf: zipfile.ZipFile, voice_ids: Iterable[str] | None) -> None:
        """写音色包。voice_ids=None 表示整库导出，把目录里所有包都带上。"""
        if self.pack_dir is None or not self.pack_dir.is_dir():
            return
        if voice_ids is None:
            ids = sorted(p.stem for p in self.pack_dir.glob("*.s2voice"))
        else:
            ids = sorted({v for v in voice_ids if SAFE_ID_RE.match(str(v))})
        for vid in ids:
            # 包本体 + 同名 .json（描述/种子/来历）。缺 json 也能用，只是丢了"当初怎么设计的"。
            for suffix in (".s2voice", ".json"):
                path = self.pack_dir / f"{vid}{suffix}"
                if path.is_file():
                    zf.write(path, f"voices/packs/{path.name}")

    def export_project(self, project_id: str, project_name: str = "") -> bytes:
        """项目级导出：项目树（项目 + 各集）+ 素材文件 + 用到的音色包。

        这是"换台设备接着干"的那份。api key 之类设备相关的东西一律不进包。
        """
        pid = self._pid(project_id)
        project = self.get_project(pid)
        if project is None:
            raise WorkspaceError(f"项目不存在：{pid}")

        manifest = self.bundle_manifest(pid)
        if project_name:
            manifest["rootName"] = project_name
        ids = [row["id"] for row in manifest["projects"]]

        buf = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
        buf.close()
        try:
            with zipfile.ZipFile(buf.name, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
                zf.writestr("README.txt", _bundle_readme(manifest))
                self._write_project_tree(zf, ids)
                self._write_packs(zf, [row["id"] for row in manifest["voicePacks"]])
            return Path(buf.name).read_bytes()
        finally:
            try:
                os.unlink(buf.name)
            except OSError:
                pass

    def export_all(self) -> bytes:
        """整库导出：所有项目 + 供应商设置 + 全部音色包。"""
        manifest = {
            "format": EXPORT_FORMAT,
            "version": EXPORT_VERSION,
            "exportedAt": _stamp(),
            "scope": "workspace",
        }
        buf = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
        buf.close()
        try:
            with zipfile.ZipFile(buf.name, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
                zf.writestr("index.json", json.dumps(self.list_index(), ensure_ascii=False, indent=2))
                zf.writestr(
                    "providers.json",
                    json.dumps(self.get_providers(), ensure_ascii=False, indent=2),
                )
                ids = [str(r.get("id") or "") for r in self.list_index() if r.get("id")]
                self._write_project_tree(zf, ids)
                self._write_packs(zf, None)
            return Path(buf.name).read_bytes()
        finally:
            try:
                os.unlink(buf.name)
            except OSError:
                pass

    # ------------------------------ 导入 ------------------------------

    def import_bytes(self, payload: bytes, *, mode: str = "new") -> dict:
        """导入 zip。mode=``new`` 总建新 id；``replace`` 覆盖同 id 项目。"""
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
        tmp.write(payload)
        tmp.close()
        try:
            with zipfile.ZipFile(tmp.name) as zf:
                return self._import_zip(zf, mode)
        except zipfile.BadZipFile as exc:
            raise WorkspaceError(f"不是有效的 zip：{exc}") from exc
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass

    def _import_zip(self, zf: zipfile.ZipFile, mode: str) -> dict:
        names = set(zf.namelist())
        manifest = {}
        if "manifest.json" in names:
            manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
        fmt = str(manifest.get("format") or "")

        # v2 项目包：projects/<pid>/... 的树。先认它 —— 否则会掉进 v1 的单项目分支，
        # 导入后只剩"根项目"，各集全丢。
        if fmt == EXPORT_FORMAT and manifest.get("scope") == "project" and any(
            n.startswith("projects/") for n in names
        ):
            return self._import_bundle(zf, manifest, mode)
        if fmt == EXPORT_FORMAT and manifest.get("scope") == "workspace":
            return self._import_workspace(zf)
        if fmt == LEGACY_FORMAT or "projects" in names:
            return self._import_legacy(zf, mode)
        if fmt == EXPORT_FORMAT and "project.json" in names:
            return self._import_single(zf, manifest, mode)
        if "project.json" in names:
            return self._import_single(zf, manifest, mode)
        raise WorkspaceError("不认识的备份文件格式")

    def _read_zip_json(self, zf: zipfile.ZipFile, name: str, default: Any) -> Any:
        try:
            return json.loads(zf.read(name).decode("utf-8"))
        except KeyError:
            return default

    def _import_single(self, zf: zipfile.ZipFile, manifest: dict, mode: str) -> dict:
        project = self._read_zip_json(zf, "project.json", None)
        if not isinstance(project, dict) or not project.get("id"):
            raise WorkspaceError("project.json 无效")

        if mode == "replace" and self.get_project(str(project["id"])) is not None:
            pid = self._pid(str(project["id"]))
        else:
            pid = self._new_project_id()

        project = {**project, "id": pid}
        self.project_dir(pid).mkdir(parents=True, exist_ok=True)
        _atomic_write_json(self.project_dir(pid) / "project.json", project)
        for name in COLLECTIONS:
            rows = self._read_zip_json(zf, f"{name}.json", [])
            # ★ 行的 projectId 必须跟着改：前端的每一处查询都按 projectId 过滤，
            #   不改就是"项目导进来了，但里面一集/一个镜头都看不见"。
            rows = [{**r, "projectId": pid} for r in _rows_of(rows)]
            _atomic_write_json(self.project_dir(pid) / f"{name}.json", rows)
        meta = self._read_zip_json(zf, "meta.json", {})
        _atomic_write_json(self.project_dir(pid) / "meta.json", meta if isinstance(meta, dict) else {})

        restored = 0
        for info in zf.infolist():
            if not info.filename.startswith("assets/") or info.is_dir():
                continue
            fname = Path(info.filename).name
            if not SAFE_FILE_RE.match(fname):
                continue
            target = self.assets_dir(pid)
            target.mkdir(parents=True, exist_ok=True)
            (target / fname).write_bytes(zf.read(info))
            restored += 1

        self._reindex_project(project)
        packs = self._restore_packs(zf)
        return {
            "projectId": pid,
            "name": project.get("name") or "",
            "projects": 1,
            "assets": restored,
            "voicePacks": packs,
            "missingPacks": self._missing_packs([pid]),
        }

    def _import_bundle(self, zf: zipfile.ZipFile, manifest: dict, mode: str) -> dict:
        """项目树导入：项目 + 各集一起进来，id 全部重新分配（mode=replace 则沿用原 id）。

        id 重映射是整件事的核心：项目行的 id、集的 seriesId / episodeIds、以及每个集合里
        每行的 projectId 必须一起改。漏改任何一处，导入结果就是"看着在、点开全空"。
        """
        seen: dict[str, dict] = {}
        for info in zf.infolist():
            if info.is_dir():
                continue
            parts = info.filename.split("/")
            if len(parts) < 3 or parts[0] != "projects" or not SAFE_ID_RE.match(parts[1]):
                continue
            old = parts[1]
            if old in seen:
                continue
            project = self._read_zip_json(zf, f"projects/{old}/project.json", None)
            if isinstance(project, dict) and project.get("id"):
                seen[old] = project
        if not seen:
            raise WorkspaceError("项目包里没有可导入的项目")

        if mode == "replace":
            remap = {old: old for old in seen}
        else:
            remap = {old: self._new_id(str(p.get("kind") or "episode")) for old, p in seen.items()}

        assets = 0
        for old, raw in seen.items():
            pid = remap[old]
            project = dict(raw)
            project["id"] = pid
            if "seriesId" in project:
                sid = str(project.get("seriesId") or "")
                # 母项目不在包里（只导了某一集）时保留原值，前端找不到会按"独立集"处理
                project["seriesId"] = remap.get(sid, sid)
            if isinstance(project.get("episodeIds"), list):
                project["episodeIds"] = [
                    remap[e] for e in project["episodeIds"] if isinstance(e, str) and e in remap
                ]

            self.project_dir(pid).mkdir(parents=True, exist_ok=True)
            _atomic_write_json(self.project_dir(pid) / "project.json", project)
            for name in COLLECTIONS:
                rows = self._read_zip_json(zf, f"projects/{old}/{name}.json", [])
                rows = [{**r, "projectId": pid} for r in _rows_of(rows)]
                _atomic_write_json(self.project_dir(pid) / f"{name}.json", rows)
            meta = self._read_zip_json(zf, f"projects/{old}/meta.json", {})
            _atomic_write_json(
                self.project_dir(pid) / "meta.json", meta if isinstance(meta, dict) else {}
            )

            prefix = f"projects/{old}/assets/"
            for info in zf.infolist():
                if info.is_dir() or not info.filename.startswith(prefix):
                    continue
                fname = Path(info.filename).name
                if not SAFE_FILE_RE.match(fname):
                    continue
                target = self.assets_dir(pid)
                target.mkdir(parents=True, exist_ok=True)
                (target / fname).write_bytes(zf.read(info))
                assets += 1

            self._reindex_project(project)

        packs = self._restore_packs(zf)
        root_old = str(manifest.get("rootId") or "")
        root_new = remap.get(root_old) or remap[list(seen)[0]]
        imported = list(remap.values())
        return {
            "projectId": root_new,
            "name": str((seen.get(root_old) or {}).get("name") or ""),
            "projects": len(remap),
            "episodes": max(0, len(remap) - 1),
            "assets": assets,
            "voicePacks": packs,
            "missingPacks": self._missing_packs(imported),
        }

    def _restore_packs(self, zf: zipfile.ZipFile) -> dict:
        """把 zip 里的音色包落到本机音色目录。

        规则：同名同内容 = 跳过（kept）；同名不同内容 = **不覆盖**，报 conflict
        （两个项目用了同一个 id 却是两种音色，覆盖谁都是错的，交给人判断）；
        本机没有 = 写入（restored）。
        """
        result: dict[str, Any] = {"restored": [], "kept": [], "conflict": [], "dir": ""}
        if self.pack_dir is None:
            result["skipped"] = "没有配置音色包目录"
            return result
        try:
            self.pack_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            result["error"] = f"建不了音色包目录 {self.pack_dir}：{exc}"
            return result
        result["dir"] = str(self.pack_dir)

        for info in zf.infolist():
            if info.is_dir() or not info.filename.startswith("voices/packs/"):
                continue
            name = Path(info.filename).name
            if not SAFE_FILE_RE.match(name) or ".." in name:
                continue
            voice_id = name.split(".")[0]
            if not SAFE_ID_RE.match(voice_id):
                continue
            payload = zf.read(info)
            target = self.pack_dir / name
            if target.exists():
                if name.endswith(".s2voice"):
                    try:
                        same = _sha256(target.read_bytes()) == _sha256(payload)
                    except OSError:
                        same = False
                    result["kept" if same else "conflict"].append(voice_id)
                continue
            target.write_bytes(payload)
            if name.endswith(".s2voice"):
                result["restored"].append(voice_id)
        for key in ("restored", "kept", "conflict"):
            result[key] = sorted(set(result[key]))
        return result

    def _missing_packs(self, project_ids: Iterable[str]) -> list[dict]:
        """导入后回扫：实体引用的音色包，本机到底有没有。没有的列出来让人重新固定。"""
        have: set[str] = set()
        if self.pack_dir is not None and self.pack_dir.is_dir():
            have = {p.stem for p in self.pack_dir.glob("*.s2voice")}
        out: list[dict] = []
        for pid in project_ids:
            project = self.get_project(pid) or {}
            for ent in self.get_collection(pid, "entities"):
                pack = ent.get("voicePack")
                vid = str((pack or {}).get("id") or "") if isinstance(pack, dict) else ""
                if vid and vid not in have:
                    out.append(
                        {
                            "id": vid,
                            "entity": str(ent.get("name") or ""),
                            "entityId": ent.get("id"),
                            "projectId": pid,
                            "projectName": str(project.get("name") or ""),
                        }
                    )
        return out

    def _import_workspace(self, zf: zipfile.ZipFile) -> dict:
        imported = 0
        for info in zf.infolist():
            parts = info.filename.split("/")
            if len(parts) < 3 or parts[0] != "projects":
                continue
            pid = parts[1]
            if not SAFE_ID_RE.match(pid):
                continue
            if parts[-1] == "assets" or info.is_dir():
                continue
            target_dir = self.project_dir(pid)
            target_dir.mkdir(parents=True, exist_ok=True)
            if len(parts) >= 4 and parts[2] == "assets":
                assets = self.assets_dir(pid)
                assets.mkdir(parents=True, exist_ok=True)
                (assets / Path(info.filename).name).write_bytes(zf.read(info))
            else:
                (target_dir / parts[-1]).write_bytes(zf.read(info))
        # 索引按磁盘上真实存在的 project.json 重建，而不是照抄 zip 里的
        # index.json —— 后者可能指向一个根本没打包进来的项目，照抄会让列表
        # 里出现打不开的幽灵条目。
        projects_root = self.root / "projects"
        if projects_root.is_dir():
            for entry in sorted(projects_root.iterdir()):
                if not entry.is_dir():
                    continue
                project = _read_json(entry / "project.json", None)
                if isinstance(project, dict) and project.get("id"):
                    self._reindex_project(project)
                    imported += 1

        providers = self._read_zip_json(zf, "providers.json", None)
        if isinstance(providers, list):
            merged = {str(p.get("id")): p for p in self.get_providers()}
            for p in providers:
                if isinstance(p, dict) and p.get("id"):
                    merged[str(p["id"])] = p
            self.put_providers(list(merged.values()))
        packs = self._restore_packs(zf)
        return {"projects": imported, "voicePacks": packs}

    def _import_legacy(self, zf: zipfile.ZipFile, mode: str) -> dict:
        """前端旧备份（一个 JSON，assets 里没有图片本体）。"""
        data = self._read_zip_json(zf, "backup.json", None)
        if data is None:
            for name in zf.namelist():
                if name.endswith(".json") and name != "manifest.json":
                    data = self._read_zip_json(zf, name, None)
                    if isinstance(data, dict) and "projects" in data:
                        break
        if not isinstance(data, dict) or not isinstance(data.get("projects"), list):
            raise WorkspaceError("旧备份里没有 projects")

        count = 0
        last = {}
        for project in data["projects"]:
            if not isinstance(project, dict) or not project.get("id"):
                continue
            pid = str(project["id"])
            if mode != "replace":
                pid = self._new_project_id()
            elif not SAFE_ID_RE.match(pid):
                pid = self._new_project_id()
            project = {**project, "id": pid}
            self.project_dir(pid).mkdir(parents=True, exist_ok=True)
            _atomic_write_json(self.project_dir(pid) / "project.json", project)

            def pick(key: str) -> list[dict]:
                rows = data.get(key)
                return [r for r in rows if isinstance(r, dict) and r.get("projectId") == project.get("id")] if isinstance(rows, list) else []

            for name in COLLECTIONS:
                rows = pick(name)
                rows = [{**r, "projectId": pid} for r in rows]
                _atomic_write_json(self.project_dir(pid) / f"{name}.json", rows)
            _atomic_write_json(self.project_dir(pid) / "meta.json", {})
            self._reindex_project(project)
            count += 1
            last = {"projectId": pid, "name": project.get("name") or "", "assets": 0}
        return {"projects": count, "last": last}

    def _new_project_id(self) -> str:
        import uuid

        return f"prj_{uuid.uuid4().hex[:12]}"

    def _new_id(self, kind: str) -> str:
        """按层级给新 id：项目 srs_ / 集 epi_。前缀不是装饰，前端和日志都靠它一眼分辨。"""
        import uuid

        prefix = "srs" if kind == "series" else "epi" if kind == "episode" else "prj"
        return f"{prefix}_{uuid.uuid4().hex[:12]}"
