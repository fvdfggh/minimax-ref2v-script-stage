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

import json
import os
import re
import shutil
import tempfile
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
EXPORT_VERSION = 1
#: 前端 db/index.ts 的 exportBackup 产出的老格式，导入时一并认
LEGACY_FORMAT = "scriptstage-backup"

CONFIG_NAME = "config.json"
INDEX_NAME = "index.json"
PROVIDERS_NAME = "providers.json"


class WorkspaceError(Exception):
    """数据目录层面的可预期错误（id 非法、数据损坏、zip 不认）。"""


def _stamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


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


class Workspace:
    def __init__(self, root: str | Path):
        self.root = Path(root)

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
        """
        pid = self._pid(project_id)
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
        kept = [r for r in self.get_collection(project_id, name) if str(r.get("id")) not in drop]
        _atomic_write_json(self._collection_path(project_id, name), kept)

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

    def export_project(self, project_id: str, project_name: str = "") -> bytes:
        """把单个项目打成 zip：JSON + 素材文件。"""
        pid = self._pid(project_id)
        project = self.get_project(pid)
        if project is None:
            raise WorkspaceError(f"项目不存在：{pid}")

        manifest = {
            "format": EXPORT_FORMAT,
            "version": EXPORT_VERSION,
            "exportedAt": _stamp(),
            "projectId": pid,
            "projectName": project_name or project.get("name") or "",
        }
        buf = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
        buf.close()
        try:
            with zipfile.ZipFile(buf.name, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
                zf.writestr(
                    "project.json", json.dumps(project, ensure_ascii=False, indent=2)
                )
                for name in COLLECTIONS:
                    rows = self.get_collection(pid, name)
                    zf.writestr(f"{name}.json", json.dumps(rows, ensure_ascii=False, indent=2))
                zf.writestr("meta.json", json.dumps(self.get_meta(pid), ensure_ascii=False, indent=2))
                for fname in self.list_assets(pid):
                    zf.write(self.asset_path(pid, fname), f"assets/{fname}")
            return Path(buf.name).read_bytes()
        finally:
            try:
                os.unlink(buf.name)
            except OSError:
                pass

    def export_all(self) -> bytes:
        """整库导出：所有项目 + 供应商设置。"""
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
                for row in self.list_index():
                    pid = str(row.get("id") or "")
                    if not pid:
                        continue
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

        if fmt == EXPORT_FORMAT and "project.json" in names:
            return self._import_single(zf, manifest, mode)
        if fmt == EXPORT_FORMAT and manifest.get("scope") == "workspace":
            return self._import_workspace(zf)
        if fmt == LEGACY_FORMAT or "projects" in names:
            return self._import_legacy(zf, mode)
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
            _atomic_write_json(self.project_dir(pid) / f"{name}.json", _rows_of(rows))
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
        return {"projectId": pid, "name": project.get("name") or "", "assets": restored}

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
        return {"projects": imported}

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
