"""剧本台后端：把数据目录暴露成前端能用的 REST 接口。

只用标准库。理由很实际：目标机器上是 Python 3.14，fastapi/pydantic 这类
带 C 扩展的包在新版本上随时可能装不上，而这个服务干的事就是读写 JSON
和素材文件，http.server 完全够。少一个依赖，就少一个装不上的理由。

接口形状是照着前端 Dexie 的用法反推的（见 src/core/backend.ts），
所以前端七个 store 基本不用改。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

from store import COLLECTIONS, Workspace, WorkspaceError  # noqa: E402

CONFIG_PATH = Path.home() / ".scriptstage" / "config.json"
DEFAULT_PORT = 8787

#: 前端 vite dev server
CORS_ALLOW = "*"


def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def save_config(patch: dict) -> dict:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    current = load_config()
    current.update(patch)
    CONFIG_PATH.write_text(
        json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return current


def default_data_dir() -> str:
    return str(Path.home() / "scriptstage-data")


class WorkspaceHolder:
    """运行期可切换的数据目录。"""

    def __init__(self) -> None:
        cfg = load_config()
        self.workspace = Workspace(cfg.get("dataDir") or default_data_dir())

    @property
    def ws(self) -> Workspace:
        return self.workspace

    def set_dir(self, data_dir: str) -> Workspace:
        path = Path(data_dir).expanduser()
        if not path.is_absolute():
            raise WorkspaceError("数据目录必须是绝对路径")
        path.mkdir(parents=True, exist_ok=True)
        if not path.is_dir():
            raise WorkspaceError(f"不是目录：{path}")
        ws = Workspace(path)
        ws.ensure()
        save_config({"dataDir": str(path)})
        self.workspace = ws
        return ws


HOLDER = WorkspaceHolder()


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _json_body(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise ApiError(400, f"请求体不是合法 JSON：{exc}") from exc


def _raw_body(handler: BaseHTTPRequestHandler, limit: int = 512 * 1024 * 1024) -> bytes:
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0:
        return b""
    if length > limit:
        raise ApiError(413, "文件过大")
    return handler.rfile.read(length)


# ------------------------------ 文件系统浏览 ------------------------------


def fs_roots() -> list[dict]:
    """Windows 给盘符，其它系统给 /。"""
    out: list[dict] = []
    if os.name == "nt":
        import string

        for letter in string.ascii_uppercase:
            path = Path(f"{letter}:\\")
            if path.exists():
                out.append({"name": f"{letter}:", "path": str(path)})
    if not out:
        out.append({"name": "/", "path": "/"})
    home = Path.home()
    out.insert(0, {"name": f"主目录（{home.name}）", "path": str(home)})
    return out


def fs_children(path: str) -> dict:
    base = Path(path).expanduser()
    if not base.is_dir():
        raise ApiError(404, f"目录不存在：{base}")
    dirs = []
    try:
        for entry in sorted(base.iterdir(), key=lambda p: p.name.lower()):
            if entry.name.startswith("."):
                continue
            try:
                if entry.is_dir():
                    dirs.append({"name": entry.name, "path": str(entry)})
            except OSError:
                continue
    except PermissionError as exc:
        raise ApiError(403, f"没有权限读取：{base}") from exc
    parent = base.parent
    return {
        "path": str(base),
        "parent": str(parent) if str(parent) != str(base) else None,
        "dirs": dirs,
    }


# ------------------------------ 路由实现 ------------------------------


def route_get(parts: list[str], query: dict) -> tuple[int, Any]:
    ws = HOLDER.ws

    if parts == ["health"]:
        return 200, {"ok": True, "dataDir": str(ws.root)}

    if parts == ["config"]:
        return 200, {"dataDir": str(ws.root), "default": default_data_dir()}

    if parts == ["fs", "roots"]:
        return 200, {"roots": fs_roots()}

    if parts == ["fs", "children"]:
        return 200, fs_children(query.get("path", [""])[0] or str(Path.home()))

    if len(parts) == 2 and parts[0] == "all" and parts[1] in COLLECTIONS:
        # 全库查询（前端 db.<table>.toArray() 会用到）
        out: list[dict] = []
        for row in ws.list_index():
            pid = str(row.get("id") or "")
            if pid:
                out.extend(ws.get_collection(pid, parts[1]))
        return 200, out

    if parts == ["projects"]:
        ids = [r.get("id") for r in ws.list_index()]
        out = []
        for pid in ids:
            project = ws.get_project(str(pid or ""))
            if project:
                out.append(project)
        out.sort(key=lambda p: p.get("updatedAt") or 0, reverse=True)
        return 200, out

    if len(parts) == 2 and parts[0] == "projects":
        project = ws.get_project(parts[1])
        if project is None:
            raise ApiError(404, "项目不存在")
        return 200, project

    if len(parts) == 3 and parts[0] == "projects" and parts[2] in COLLECTIONS:
        return 200, ws.get_collection(parts[1], parts[2])

    if len(parts) == 3 and parts[0] == "projects" and parts[2] == "meta":
        return 200, ws.get_meta(parts[1])

    if len(parts) == 3 and parts[0] == "projects" and parts[2] == "files":
        # 素材文件名列表。刻意不挂在 /assets 上：那个路径是 assets 集合本身
        return 200, {"files": ws.list_assets(parts[1])}

    if len(parts) == 4 and parts[0] == "projects" and parts[2] == "assets":
        path = ws.asset_path(parts[1], unquote(parts[3]))
        if not path.is_file():
            raise ApiError(404, "素材不存在")
        return 200, {"__file__": str(path)}

    if len(parts) == 3 and parts[0] == "projects" and parts[2] == "export":
        project = ws.get_project(parts[1])
        if project is None:
            raise ApiError(404, "项目不存在")
        payload = ws.export_project(parts[1], str(project.get("name") or ""))
        name = "".join(c if c not in '\\/:*?"<>|' else "_" for c in str(project.get("name") or "project"))
        return 200, {"__download__": payload, "__name__": f"{name}.剧本台项目.zip"}

    if parts == ["export-all"]:
        return 200, {"__download__": ws.export_all(), "__name__": "剧本台-全部数据.zip"}

    if parts == ["providers"]:
        return 200, ws.get_providers()

    if len(parts) == 2 and parts[0] == "kv":
        found, value = ws.get_kv(unquote(parts[1]))
        return 200, {"found": found, "value": value}

    raise ApiError(404, f"未知路径：/{'/'.join(parts)}")


def route_put(parts: list[str], body: dict) -> tuple[int, Any]:
    ws = HOLDER.ws

    if parts == ["config"]:
        data_dir = str(body.get("dataDir") or "").strip()
        if not data_dir:
            raise ApiError(400, "dataDir 不能为空")
        ws = HOLDER.set_dir(data_dir)
        return 200, {"dataDir": str(ws.root)}

    if parts == ["projects"]:
        row = body.get("row")
        if not isinstance(row, dict):
            raise ApiError(400, "缺少 row")
        ws.put_project(row)
        return 200, {"ok": True}

    if len(parts) == 3 and parts[0] == "projects" and parts[2] in COLLECTIONS:
        rows = body.get("rows")
        if not isinstance(rows, list):
            raise ApiError(400, "缺少 rows")
        ws.put_rows(parts[1], parts[2], rows)
        return 200, {"ok": True}

    if len(parts) == 3 and parts[0] == "projects" and parts[2] == "meta":
        patch = body.get("patch")
        if not isinstance(patch, dict):
            raise ApiError(400, "缺少 patch")
        ws.put_meta(parts[1], patch)
        return 200, {"ok": True}

    if parts == ["providers"]:
        rows = body.get("rows")
        if not isinstance(rows, list):
            raise ApiError(400, "缺少 rows")
        ws.put_providers(rows)
        return 200, {"ok": True}

    if len(parts) == 2 and parts[0] == "kv":
        if "value" not in body:
            raise ApiError(400, "缺少 value")
        ws.put_kv(unquote(parts[1]), body.get("value"))
        return 200, {"ok": True}

    raise ApiError(404, f"未知路径：/{'/'.join(parts)}")


def route_post(parts: list[str], query: dict, raw: bytes) -> tuple[int, Any]:
    ws = HOLDER.ws

    if len(parts) == 3 and parts[0] == "projects" and parts[2] == "assets":
        filename = query.get("filename", [""])[0]
        if not filename:
            raise ApiError(400, "缺少 filename")
        if not raw:
            raise ApiError(400, "空文件")
        name = ws.write_asset(parts[1], filename, raw)
        return 200, {"fileName": name}

    if parts == ["import"]:
        if not raw:
            raise ApiError(400, "空文件")
        mode = query.get("mode", ["new"])[0]
        if mode not in ("new", "replace"):
            mode = "new"
        try:
            result = ws.import_bytes(raw, mode=mode)
        except WorkspaceError as exc:
            raise ApiError(400, str(exc)) from exc
        return 200, result

    raise ApiError(404, f"未知路径：/{'/'.join(parts)}")


def route_delete(parts: list[str], body: dict) -> tuple[int, Any]:
    ws = HOLDER.ws

    if parts == ["projects"]:
        ids = body.get("ids")
        if not isinstance(ids, list) or not ids:
            raise ApiError(400, "缺少 ids")
        for pid in ids:
            ws.delete_project(str(pid))
        return 200, {"ok": True}

    if len(parts) == 3 and parts[0] == "projects" and parts[2] in COLLECTIONS:
        ids = body.get("ids")
        if isinstance(ids, list):
            ws.delete_rows(parts[1], parts[2], [str(i) for i in ids])
        else:
            # 不带 ids = 清空该项目的整个集合（对应 where(...).delete()）
            ws.delete_rows(
                parts[1],
                parts[2],
                [str(r.get("id")) for r in ws.get_collection(parts[1], parts[2])],
            )
        return 200, {"ok": True}

    if len(parts) == 4 and parts[0] == "projects" and parts[2] == "assets":
        ws.delete_asset(parts[1], unquote(parts[3]))
        return 200, {"ok": True}

    if len(parts) == 3 and parts[0] == "projects" and parts[2] == "meta":
        keys = body.get("keys")
        if not isinstance(keys, list):
            raise ApiError(400, "缺少 keys")
        ws.delete_meta_keys(parts[1], keys)
        return 200, {"ok": True}

    if len(parts) == 2 and parts[0] == "kv":
        ws.delete_kv(unquote(parts[1]))
        return 200, {"ok": True}

    raise ApiError(404, f"未知路径：/{'/'.join(parts)}")


# ------------------------------ Handler ------------------------------

MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".mp4": "video/mp4",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "ScriptStage/0.1"

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", CORS_ALLOW)
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _send_json(self, status: int, payload: Any) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self._cors()
        self.end_headers()
        self.wfile.write(raw)

    def _send_bytes(self, status: int, payload: bytes, content_type: str, filename: str = "") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        if filename:
            from urllib.parse import quote

            self.send_header(
                "Content-Disposition", f"attachment; filename*=UTF-8''{quote(filename)}"
            )
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

    def _send_file(self, path: Path) -> None:
        mime = MIME_BY_EXT.get(path.suffix.lower(), "application/octet-stream")
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        parts = [unquote(p) for p in parsed.path.strip("/").split("/") if p]
        if parts and parts[0] == "api":
            parts = parts[1:]
        if not parts:
            self._send_json(200, {"ok": True})
            return
        query = parse_qs(parsed.query)
        try:
            if method == "GET":
                status, result = route_get(parts, query)
            elif method == "PUT":
                status, result = route_put(parts, _json_body(self))
            elif method == "POST":
                status, result = route_post(parts, query, _raw_body(self))
            else:
                status, result = route_delete(parts, _json_body(self))

            if isinstance(result, dict) and "__file__" in result:
                self._send_file(Path(result["__file__"]))
                return
            if isinstance(result, dict) and "__download__" in result:
                self._send_bytes(
                    200,
                    result["__download__"],
                    "application/zip",
                    str(result.get("__name__") or "export.zip"),
                )
                return
            self._send_json(status, result)
        except ApiError as exc:
            self._send_json(exc.status, {"error": exc.message})
        except WorkspaceError as exc:
            self._send_json(400, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._send_json(500, {"error": f"{type(exc).__name__}: {exc}"})

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="剧本台后端")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--data-dir", default="", help="数据目录；缺省用上次配置的目录")
    args = parser.parse_args(argv)

    if args.data_dir:
        HOLDER.set_dir(args.data_dir)
    else:
        HOLDER.ws.ensure()
        save_config({"dataDir": str(HOLDER.ws.root)})

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"剧本台后端已启动: http://{args.host}:{args.port}")
    print(f"数据目录: {HOLDER.ws.root}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
