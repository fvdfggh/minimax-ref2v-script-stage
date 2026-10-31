"""剧本台后端：把数据目录暴露成前端能用的 REST 接口。

只用标准库。理由很实际：目标机器上是 Python 3.14，fastapi/pydantic 这类
带 C 扩展的包在新版本上随时可能装不上，而这个服务干的事就是读写 JSON
和素材文件，http.server 完全够。少一个依赖，就少一个装不上的理由。

接口形状是照着前端 Dexie 的用法反推的（见 src/core/backend.ts），
所以前端七个 store 基本不用改。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlencode, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

from store import COLLECTIONS, Workspace, WorkspaceError  # noqa: E402
import auth as auth_service  # noqa: E402
import imagegen as image_service  # noqa: E402
import sheet as sheet_service  # noqa: E402
import voice as voice_service  # noqa: E402

CONFIG_DIR = Path(os.environ.get("SCRIPTSTAGE_HOME") or (Path.home() / ".scriptstage"))
CONFIG_PATH = CONFIG_DIR / "config.json"
DEFAULT_PORT = 8787
#: 前端构建产物（`npm run build` 的输出）。存在就由本服务一起托管 ——
#: 这样"前后台一起起"是一个进程一个端口，不用再开 vite。
DEFAULT_STATIC_DIR = Path(__file__).resolve().parent.parent / "dist"

#: 会话 cookie 名。用 cookie 而不是只认 Authorization 头，是为了让
#: `<img src>` / `<video src>` 这些浏览器直连的地址也能过鉴权 ——
#: 前端有几十处素材是直接塞进标签的，改造成 fetch+blob 得不偿失。
SESSION_COOKIE = "ss_session"

#: 全局鉴权开关。``--no-auth`` 只给集成测试和本机排障用。
AUTH_REQUIRED = True

#: 实际生效的静态目录（main 里按 --static-dir 覆盖）
STATIC_DIR: Path | None = DEFAULT_STATIC_DIR


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
        # 音色包不在数据目录里（两个语音引擎共用 C:/s2/voices/packs），
        # 导出要把它一起打进去，导入要往这里落 —— 所以显式传进去。
        self.workspace = Workspace(
            cfg.get("dataDir") or default_data_dir(), pack_dir=voice_service.PACK_DIR
        )

    @property
    def ws(self) -> Workspace:
        return self.workspace

    def set_dir(self, data_dir: str, *, persist: bool = True) -> Workspace:
        """切换数据目录。

        ``persist=False`` 用于 ``--data-dir`` 这种**一次性覆盖**：
        命令行参数只对本次进程生效，写进全局配置会让下次不带参数启动
        的后端也跑到那个目录上（集成测试用临时目录时就踩过：跑完测试，
        用户再启动后端看到的是空库）。
        """
        path = Path(data_dir).expanduser()
        if not path.is_absolute():
            raise WorkspaceError("数据目录必须是绝对路径")
        path.mkdir(parents=True, exist_ok=True)
        if not path.is_dir():
            raise WorkspaceError(f"不是目录：{path}")
        ws = Workspace(path, pack_dir=voice_service.PACK_DIR)
        ws.ensure()
        if persist:
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


def _session_cookie(token: str, max_age: int) -> str:
    """会话 cookie。

    HttpOnly：JS 读不到，XSS 也偷不走。
    SameSite=Lax：跨站 POST 不带 cookie，顺手挡掉 CSRF；同站（含不同端口）的
    `<img>` / `<video>` 直连照常带，素材才显示得出来。
    """
    return f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}"


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


# ------------------------------ ComfyUI 转发 ------------------------------

DEFAULT_COMFY = "http://127.0.0.1:8188"
_COMFY_TIMEOUT = 30.0

# ★ 本机设了 HTTPS_PROXY=127.0.0.1:60155，urllib 默认会读环境变量，
#   把 127.0.0.1 的请求也送去代理 → 502。这里显式挂一个空代理的 opener。
_COMFY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def comfy_base(raw: str) -> str:
    base = (raw or DEFAULT_COMFY).strip().rstrip("/")
    if not base.lower().startswith(("http://", "https://")):
        base = "http://" + base
    return base


def comfy_call(
    base: str,
    method: str,
    path: str,
    *,
    body: Any = None,
    raw: bytes | None = None,
    content_type: str | None = None,
    timeout: float = _COMFY_TIMEOUT,
) -> tuple[int, str, bytes]:
    """转发一次请求到 ComfyUI，返回 `(status, content_type, payload)`。

    HTTPError 不是异常场景 —— ComfyUI 用它报"队列已满""节点校验失败"，
    状态码和响应体都要原样带回给前端，否则用户只看到一句 502。
    """
    url = comfy_base(base) + (path if path.startswith(("/")) else "/" + path)
    headers: dict[str, str] = {}
    data: bytes | None = None
    if raw is not None:
        data = raw
        headers["Content-Type"] = content_type or "application/octet-stream"
    elif body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with _COMFY_OPENER.open(req, timeout=timeout) as resp:
            return resp.status, resp.headers.get("Content-Type", "application/octet-stream"), resp.read()
    except urllib.error.HTTPError as exc:
        ct = ""
        try:
            ct = exc.headers.get("Content-Type", "") or ""
        except Exception:  # noqa: BLE001
            ct = ""
        payload = b""
        try:
            payload = exc.read()
        except Exception:  # noqa: BLE001
            payload = b""
        return exc.code, ct or "application/json", payload
    except Exception as exc:  # noqa: BLE001
        # URL cannot be reached / DNS / timeout —— 这些都归到 502，前端据此提示"ComfyUI 没起"
        raise ApiError(502, f"连不上 ComfyUI（{url}）：{type(exc).__name__}: {exc}") from exc


def _comfy_json_result(status: int, ct: str, payload: bytes) -> dict:
    text = payload.decode("utf-8", "replace")
    out: dict = {"status": status, "ok": 200 <= status < 400, "contentType": ct, "text": text}
    try:
        out["json"] = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        pass
    return out


# ------------------------------ 运行前服务（ModelHub） ------------------------------

#: 运行前服务。它把生图/图片编辑/语音设计/合成/文本生成收在一张卡上按需加载，
#: 剧本台只当客户端 —— 谁来服务、要不要先卸别人，都由它决定。
HUB_URL = os.environ.get("SCRIPTSTAGE_HUB", "http://127.0.0.1:8790").rstrip("/")
_HUB_STATE: dict[str, Any] = {"at": 0.0, "on": False}


def hub_online(ttl: float = 5.0) -> bool:
    """探一下 ModelHub 活没活。缓存 5 秒：一次页面刷新会打十几个生图请求。"""
    import time

    now = time.time()
    if now - float(_HUB_STATE.get("at") or 0) >= ttl:
        ok = False
        try:
            with _COMFY_OPENER.open(HUB_URL + "/health", timeout=1.5) as resp:
                ok = resp.status == 200
        except Exception:  # noqa: BLE001
            ok = False
        _HUB_STATE.update({"at": now, "on": ok})
    return bool(_HUB_STATE.get("on"))


def image_via_hub() -> bool:
    """生图/图片编辑是否交给运行前服务。

    配置里 ``imageEngine: "direct"`` 可以退回直连 ComfyUI（排查用）；
    默认交给 hub —— 这样运行前只占一张卡，运行阶段那三张才腾得出来。
    """
    if str(load_config().get("imageEngine") or "").lower() == "direct":
        return False
    return hub_online()


def hub_call(path: str, payload: dict, *, timeout: float = 300.0) -> dict:
    """POST 一次 /v1/*。HTTPError 里的 detail 原样带出来 —— 那才是原因。"""
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        HUB_URL + path, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with _COMFY_OPENER.open(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read()[:600].decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            detail = ""
        raise ApiError(400, f"运行前服务拒绝（HTTP {exc.code}）：{detail or '（无内容）'}") from exc
    except Exception as exc:  # noqa: BLE001
        raise ApiError(
            502, f"连不上运行前服务（{HUB_URL}）：{type(exc).__name__}: {exc}"
        ) from exc


def hub_image_input(ws, body: dict) -> dict:
    """把前端的生图请求翻成 ModelHub 的入参。

    参考图有两种来源，到了 hub 那边都变成 `images`（base64）：
      * `{projectId, fileName}` —— 后端从数据目录直接读，省一趟浏览器；
      * `{name, data}` —— 浏览器里刚截的、还没落库的临时图。
    已经是 ComfyUI 文件名的字符串原样当 `refs` 传：hub 的托管实例和运行阶段那份
    用同一个 input 目录，文件名通用。
    """
    refs: list[str] = []
    images: list[str] = []
    for ref in body.get("refs") or []:
        if isinstance(ref, str):
            name = ref.strip()
            if name:
                refs.append(name)
            continue
        if not isinstance(ref, dict):
            raise ApiError(400, "参考图格式不对")
        project_id = str(ref.get("projectId") or "").strip()
        file_name = str(ref.get("fileName") or "").strip()
        if project_id and file_name:
            try:
                path = ws.asset_path(project_id, file_name)
            except Exception as exc:  # noqa: BLE001
                raise ApiError(400, f"找不到参考图：{exc}") from exc
            if not path.is_file():
                raise ApiError(400, f"参考图文件不在了：{path.name}")
            images.append(base64.b64encode(path.read_bytes()).decode("ascii"))
            continue
        data = str(ref.get("data") or "")
        if data.strip().lower().startswith("data:") and "," in data:
            data = data.split(",", 1)[1]
        if not data:
            raise ApiError(400, "参考图既没有 projectId/fileName，也没有 data")
        images.append(data)

    payload: dict[str, Any] = {
        "prompt": str(body.get("prompt") or ""),
        "negative": body.get("negative"),
        "width": body.get("width"),
        "height": body.get("height"),
        "seed": body.get("seed"),
        "steps": body.get("steps"),
        "cfg": body.get("cfg"),
        "workflow": body.get("workflow"),
        "waitSec": body.get("waitSec"),
    }
    if refs:
        payload["refs"] = refs
    if images:
        payload["images"] = images
    return payload


def hub_image_result(out: dict, prompt: str = "") -> dict:
    """把 /v1/run 的返回摊成前端 comfyImageRun 认识的样子。"""
    meta = out.get("meta") or {}
    seconds = meta.get("seconds")
    if seconds in (None, ""):
        seconds = round(float(out.get("ms") or 0) / 1000.0, 2)
    return {
        "image": out.get("data") or "",
        "mime": out.get("mime") or "image/png",
        "promptId": str(meta.get("promptId") or ""),
        "seconds": seconds,
        "filename": "",
        "report": meta.get("report") or {},
        "engine": "modelhub",
        "model": out.get("model"),
        "prompt": prompt,
    }


# ------------------------------ 本机目录扫描 ------------------------------

# 模型子目录 → 逻辑类别。多个子目录可以归到同一类别（前端下拉会合并），
# 因为自定义节点常常自己开一个目录（latent_upscale_models 就是 H3 自己加的）。
MODEL_DIR_KINDS: dict[str, str] = {
    "checkpoints": "model",
    "unet": "model",
    "diffusion_models": "model",
    "loras": "lora",
    "vae": "vae",
    "clip": "clip",
    "text_encoders": "clip",
    "clip_vision": "clip_vision",
    "latent_upscale_models": "upscale",
    "upscale_models": "upscale",
    "controlnet": "controlnet",
    "model_patches": "patch",
    "audio_encoders": "audio",
    "moss_transcribe_diarize": "audio",
}

MODEL_EXTS = {".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".onnx"}

# 常见安装位置。用户没填 root 时按这个顺序探测，命中第一个存在的即可。
COMFY_ROOT_HINTS = [
    "C:/Users/于玉宇/Desktop/comfyui/ComfyUI",
    "C:/Users/于玉宇/Desktop/ComfyUI",
    "D:/ComfyUI",
    "C:/ComfyUI",
]


def guess_comfy_root() -> str:
    for p in COMFY_ROOT_HINTS:
        if Path(p).is_dir():
            return p
    return ""


#: 参考图上传缓存：(base, 绝对路径) → (mtime+size, ComfyUI 里的文件名)。
#: 同一张主体图在批量出图里会被反复引用，不缓存就是每张都重传一遍。
_REF_CACHE: dict[str, tuple[str, str]] = {}


def resolve_comfy_ref(ws, base: str, ref: Any) -> str:
    """把一条「参考图」变成 ComfyUI input 目录里的文件名。

    认三种写法：
      "already.png"                     —— 已经是 ComfyUI 里的文件名，原样用；
      {"projectId","fileName"}          —— 项目素材，后端直接从数据目录读，省一趟 base64；
      {"name","data"(base64)}           —— 临时图（浏览器里刚截的、还没落库的）。
    """
    if isinstance(ref, str):
        name = ref.strip()
        if not name:
            raise image_service.ImageGenError("参考图名字是空的")
        return name
    if not isinstance(ref, dict):
        raise image_service.ImageGenError("参考图格式不对")

    project_id = str(ref.get("projectId") or "").strip()
    file_name = str(ref.get("fileName") or "").strip()
    if project_id and file_name:
        try:
            path = ws.asset_path(project_id, file_name)
        except Exception as exc:  # noqa: BLE001
            raise image_service.ImageGenError(f"找不到参考图：{exc}") from exc
        if not path.is_file():
            raise image_service.ImageGenError(f"参考图文件不在了：{path.name}")
        st = path.stat()
        stamp = f"{int(st.st_mtime)}:{st.st_size}"
        key = f"{base}|{path}"
        hit = _REF_CACHE.get(key)
        if hit and hit[0] == stamp:
            return hit[1]
        name = image_service.upload_image(
            base, name=f"ref_{project_id[-6:]}_{path.name}", data=path.read_bytes()
        )
        _REF_CACHE[key] = (stamp, name)
        return name

    data = str(ref.get("data") or "")
    if data:
        if "," in data and data.strip().lower().startswith("data:"):
            data = data.split(",", 1)[1]
        try:
            raw_bytes = base64.b64decode(data, validate=False)
        except Exception as exc:  # noqa: BLE001
            raise image_service.ImageGenError(f"参考图不是合法 base64：{exc}") from exc
        return image_service.upload_image(
            base, name=str(ref.get("name") or "ref.png"), data=raw_bytes
        )

    raise image_service.ImageGenError("参考图既没有 projectId/fileName，也没有 data")


def resolve_refs(ws, base: str, refs: Any) -> list[str]:
    """一次解析一组参考图。坏了就整体报错 —— 少传一张脸比报错难查得多。"""
    if not refs:
        return []
    if not isinstance(refs, list):
        raise image_service.ImageGenError("refs 必须是数组")
    return [resolve_comfy_ref(ws, base, item) for item in refs]


def _safe_under(root: Path, target: Path) -> bool:
    """target 必须在 root 之内 —— 这个接口会读盘上的任意 json，不能让人传绝对路径。"""
    try:
        target.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def local_models(root_raw: str) -> dict:
    raw = (root_raw or "").strip()
    if not raw:
        raw = guess_comfy_root()
    root = Path(raw)
    exists = root.is_dir()
    if not exists:
        return {
            "ok": False,
            "root": str(root),
            "exists": False,
            "reason": f"目录不存在：{root}",
            "dirs": {},
            "counts": {},
        }

    mdir = root / "models"
    dirs: dict[str, list[str]] = {}
    if mdir.is_dir():
        for child in sorted(mdir.iterdir()):
            if not child.is_dir():
                continue
            kind = MODEL_DIR_KINDS.get(child.name)
            if not kind:
                continue
            bucket = dirs.setdefault(kind, [])
            for f in sorted(child.rglob("*")):
                if f.is_file() and f.suffix.lower() in MODEL_EXTS:
                    # 相对 models/ 的路径，节点里填的就是这种（含子目录）
                    bucket.append(str(f.relative_to(mdir)).replace("\\", "/"))

    return {
        "ok": True,
        "root": str(root),
        "exists": True,
        "dirs": dirs,
        "counts": {k: len(v) for k, v in sorted(dirs.items())},
    }


def _workflow_format(doc: Any) -> str:
    """区分界面格式和 API 格式。

    界面格式顶层有 `nodes`（list）和 `links`；API 格式是 `{id: {class_type, inputs}}`。
    这个判断必须准 —— 用界面格式去注入参数会整体错位。
    """
    if isinstance(doc, dict):
        if isinstance(doc.get("nodes"), list):
            return "ui"
        if doc and all(isinstance(v, dict) and "class_type" in v for v in doc.values()):
            return "api"
    return "unknown"


def local_workflows(root_raw: str) -> dict:
    root = Path((root_raw or "").strip() or guess_comfy_root())
    if not root.is_dir():
        return {"ok": False, "root": str(root), "exists": False, "items": []}

    wdir = root / "user" / "default" / "workflows"
    items = []
    if wdir.is_dir():
        for f in sorted(wdir.rglob("*.json")):
            fmt = "unknown"
            nodes = 0
            try:
                doc = json.loads(f.read_text(encoding="utf-8", errors="replace"))
                fmt = _workflow_format(doc)
                nodes = len(doc) if fmt == "api" else len(doc.get("nodes", []))
            except (json.JSONDecodeError, ValueError, OSError):
                fmt = "broken"
            items.append(
                {
                    "name": f.stem,
                    "path": str(f.relative_to(root)).replace("\\", "/"),
                    "abs": str(f),
                    "format": fmt,
                    "nodes": nodes,
                    "size": f.stat().st_size,
                }
            )
    return {"ok": True, "root": str(root), "exists": True, "dir": str(wdir), "items": items}


def local_read(root_raw: str, rel: str) -> dict:
    root = Path((root_raw or "").strip() or guess_comfy_root())
    if not root.is_dir():
        raise ApiError(400, f"根目录不存在：{root}")
    target = (root / rel).resolve()
    if not _safe_under(root, target):
        raise ApiError(403, "只能读 ComfyUI 根目录内的文件")
    if not target.is_file():
        raise ApiError(404, f"文件不存在：{target}")
    if target.stat().st_size > 32 * 1024 * 1024:
        raise ApiError(413, "文件超过 32MB，不像工作流")
    return {"ok": True, "path": rel, "text": target.read_text(encoding="utf-8", errors="replace")}


# ------------------------------ 显卡 ------------------------------

#: 导演节点的两个历史 class_type —— 选卡枚举挂在其中之一上
_DIRECTOR_NODE_TYPES = ("ComfyMiniMaxH3DirectorOpt", "MiniMaxH3DirectorOpt")


def local_gpus() -> dict:
    """本机物理卡（nvidia-smi 直读）。

    ComfyUI 没起也给得出来 —— 用户是先想好"我要用哪几张卡"，才去起
    ComfyUI 的。所以这一半必须独立于 ComfyUI 进程。
    """
    import shutil
    import subprocess

    out: dict[str, Any] = {"ok": False, "gpus": [], "reason": ""}
    exe = shutil.which("nvidia-smi")
    if not exe:
        out["reason"] = "PATH 里找不到 nvidia-smi，读不到显卡列表"
        return out
    try:
        proc = subprocess.run(
            [
                exe,
                "--query-gpu=index,name,memory.total,memory.used,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except Exception as exc:  # noqa: BLE001 - 探测失败要如实报，不能让前端白等
        out["reason"] = f"nvidia-smi 执行失败：{exc}"
        return out
    if proc.returncode != 0:
        out["reason"] = (proc.stderr or proc.stdout or "nvidia-smi 返回非零").strip()[:300]
        return out

    gpus = []
    for line in (proc.stdout or "").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 5:
            continue
        try:
            gpus.append(
                {
                    "index": int(parts[0]),
                    "name": parts[1],
                    "memoryTotal": int(float(parts[2])),
                    "memoryUsed": int(float(parts[3])),
                    "util": int(float(parts[4])),
                }
            )
        except ValueError:
            continue
    out["ok"] = True
    out["gpus"] = gpus
    if not gpus:
        out["reason"] = "nvidia-smi 没列出任何显卡"
    return out


def comfy_gpu_view(base: str) -> dict:
    """ComfyUI 侧：可见了几张卡，以及节点此刻真实的选卡枚举。

    枚举是从 ``/object_info`` 现取的，不是前端猜的固定预设 —— 节点那边用
    ``itertools.combinations`` 枚举可见卡的全部子集，所以可见 4 张就是
    ``关闭 + 15 种组合``。ComfyUI 没起时返回 online=False，前端退化成自由输入。
    """
    info: dict[str, Any] = {"online": False, "visible": 0, "options": [], "devices": []}
    try:
        status, _, data = comfy_call(base, "GET", "/system_stats", timeout=8)
    except Exception:  # noqa: BLE001
        return info
    if status >= 400:
        return info
    try:
        stats = json.loads(data.decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        stats = {}
    devices = stats.get("devices") or []
    info["online"] = True
    info["devices"] = [
        {
            "index": i,
            "name": str(d.get("name") or ""),
            "vramTotal": int(d.get("vram_total") or 0),
        }
        for i, d in enumerate(devices)
    ]
    info["visible"] = len(devices)

    for node_type in _DIRECTOR_NODE_TYPES:
        try:
            status, _, data = comfy_call(
                base, "GET", f"/object_info/{node_type}", timeout=25
            )
        except Exception:  # noqa: BLE001
            continue
        if status >= 400:
            continue
        try:
            node = json.loads(data.decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001
            continue
        node = (node or {}).get(node_type) or {}
        inputs = node.get("input") or {}
        for bucket in ("optional", "required"):
            entry = (inputs.get(bucket) or {}).get("pipeline_cards")
            if not entry:
                continue
            opts = entry[0] if isinstance(entry, (list, tuple)) and entry else None
            if isinstance(opts, list) and opts:
                info["options"] = [str(o) for o in opts]
                return info
    return info


# ------------------------------ 节点源码扫描（带缓存） ------------------------------

_NODE_SCAN_CACHE: dict[str, tuple[float, dict]] = {}
_NODE_SCAN_TTL = 300.0


def cached_node_scan(root_raw: str) -> dict:
    import time

    from nodes_scan import scan_node_sources

    raw = (root_raw or "").strip() or guess_comfy_root()
    now = time.time()
    hit = _NODE_SCAN_CACHE.get(raw)
    if hit and now - hit[0] < _NODE_SCAN_TTL:
        out = dict(hit[1])
        out["cached"] = True
        return out
    result = scan_node_sources(raw)
    result["cached"] = False
    _NODE_SCAN_CACHE[raw] = (now, result)
    return result


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

    if len(parts) == 3 and parts[0] == "projects" and parts[2] == "revs":
        # 变更指纹：前端每几秒比一次，别处（另一个窗口 / 另一个人）改过就同步。
        # 只 stat 文件、不读内容，几十字节的响应，轮询也压得住。
        if ws.get_project(parts[1]) is None:
            raise ApiError(404, "项目不存在")
        return 200, ws.collection_revs(parts[1])

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
        # dry=1：只回装箱单（有几个集 / 多少素材 / 几个音色包 / 哪些包本机就没有），
        # 前端先把它摆给用户看，再决定要不要真的下载一个几百兆的包。
        if query.get("dry", [""])[0] in ("1", "true", "yes"):
            try:
                return 200, ws.bundle_manifest(parts[1])
            except WorkspaceError as exc:
                raise ApiError(400, str(exc)) from exc
        try:
            payload = ws.export_project(parts[1], str(project.get("name") or ""))
        except WorkspaceError as exc:
            raise ApiError(400, str(exc)) from exc
        name = "".join(c if c not in '\\/:*?"<>|' else "_" for c in str(project.get("name") or "project"))
        return 200, {"__download__": payload, "__name__": f"{name}.剧本台项目.zip"}

    if parts == ["export-all"]:
        return 200, {"__download__": ws.export_all(), "__name__": "剧本台-全部数据.zip"}

    if parts == ["providers"]:
        return 200, ws.get_providers()

    if len(parts) == 2 and parts[0] == "kv":
        found, value = ws.get_kv(unquote(parts[1]))
        return 200, {"found": found, "value": value}

    if parts == ["imagegen", "workflows"]:
        # 哪些工作流能拿来出关键帧。列表里顺带标了格式与「像不像文生图」，
        # 前端据此排序，用户不用先去 ComfyUI 里认一遍文件名。
        root = query.get("root", [""])[0].strip() or guess_comfy_root()
        base = comfy_base(query.get("base", [""])[0])
        out = image_service.list_workflows(root)
        out["root"] = root
        out["base"] = base
        if query.get("refresh", [""])[0] in ("1", "true", "yes"):
            try:
                image_service.object_info(base, force=True)
                out["objectInfo"] = True
            except image_service.ImageGenError as exc:
                out["objectInfo"] = False
                out["objectInfoError"] = str(exc)
        return 200, out

    if parts == ["voice", "status"]:
        # 两个引擎是否活着、音色包目录在哪、设计用的参考文本是什么。
        # 前端拿它决定"能不能点设计"，也拿 designText 保证固化时文本逐字一致。
        return 200, voice_service.status()

    if parts == ["voice", "wav"]:
        # 候选音色的试听：<audio src> 直接挂这个 URL。
        # 只认 design 目录里的文件名，不接受任意路径。
        path = voice_service.design_path(query.get("name", [""])[0])
        return 200, {"__raw__": path.read_bytes(), "__type__": "audio/wav"}

    if parts == ["comfy", "local"]:
        # 本机扫描：模型目录 / 工作流文件 / 读文件内容 / 节点源码。
        # 这一组不碰 ComfyUI 进程 —— ComfyUI 没起时模型和参数也该能看见。
        root = query.get("root", [""])[0]
        kind = query.get("kind", ["models"])[0]
        if kind == "workflows":
            return 200, local_workflows(root)
        if kind == "read":
            rel = query.get("path", [""])[0]
            if not rel:
                raise ApiError(400, "缺少 path")
            return 200, local_read(root, unquote(rel))
        if kind == "guess":
            return 200, {"root": guess_comfy_root()}
        if kind == "nodes":
            # 静态扫节点源码。一次要 5~6 秒，必须缓存，否则前端每翻一页都卡一下。
            return 200, cached_node_scan(root)
        return 200, local_models(root)

    if parts == ["comfy", "gpus"]:
        # 选卡：本机物理卡（nvidia-smi）+ ComfyUI 此刻可见的卡与节点枚举。
        # 三者给全，前端才能让用户**任意**勾卡，并在不可选时说清楚为什么。
        base = comfy_base(query.get("base", [""])[0])
        payload = local_gpus()
        payload["comfy"] = comfy_gpu_view(base)
        payload["base"] = base
        return 200, payload

    if parts == ["comfy", "view"]:
        # 产物回收：图片/视频直接透传，前端 <img>/<video> 可以挂这个 URL
        base = comfy_base(query.get("base", [""])[0])
        qs = urlencode(
            {k: query.get(k, [""])[0] for k in ("filename", "subfolder", "type") if query.get(k)}
        )
        status, ct, data = comfy_call(base, "GET", "/view?" + qs, timeout=60)
        if status >= 400:
            raise ApiError(502, f"ComfyUI 取回产物失败（HTTP {status}）")
        return 200, {"__raw__": data, "__type__": ct}

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

    # 设定图拼接：组头 + 三视图 → 1376×768 的 16:9 参考图（直接回 PNG 字节）
    #
    # 为什么不回 JSON：这张图马上要作为 <Picture N> 落进项目素材，前端接到
    # Blob 走 updateAsset 就完事；转 base64 只是让 700KB 的图多绕一圈。
    if parts == ["sheet", "compose"]:
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, f"请求体不是合法 JSON：{exc}") from exc
        if not isinstance(body, dict):
            raise ApiError(400, "请求体必须是一个 JSON 对象")

        pid = str(body.get("projectId") or "")
        head = str(body.get("head") or "")
        views = body.get("views")
        if not pid:
            raise ApiError(400, "缺少 projectId")
        if not head:
            raise ApiError(400, "缺少组头 head")
        if not isinstance(views, list) or not views:
            raise ApiError(400, "缺少三视图 views（至少一张）")

        def _asset_bytes(name: str) -> bytes:
            path = ws.asset_path(pid, str(name))
            if not path.is_file():
                raise ApiError(404, f"素材不存在：{name}")
            return path.read_bytes()

        try:
            png = sheet_service.compose(_asset_bytes(head), [_asset_bytes(v) for v in views])
        except sheet_service.SheetError as exc:
            raise ApiError(400, str(exc)) from exc
        return 200, {"__raw__": png, "__type__": "image/png"}

    if parts == ["sheet", "layout"]:
        return 200, sheet_service.layout()

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

    # ---- 音色：设计 → 固定 → 合成 ----
    #
    # 三个动作都很慢（3s / 12s / 3s），而且失败原因大多是"服务没起"，
    # 所以统一把 VoiceError 翻成 400 + 人话，别让前端只看到 500。

    if parts == ["voice", "design"]:
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, f"请求体不是合法 JSON：{exc}") from exc
        try:
            return 200, voice_service.design(
                str(body.get("desc") or ""),
                int(body.get("seed") or 0),
                body.get("text"),
            )
        except voice_service.VoiceError as exc:
            raise ApiError(400, str(exc)) from exc

    if parts == ["voice", "fix"]:
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, f"请求体不是合法 JSON：{exc}") from exc
        try:
            return 200, voice_service.fix(
                str(body.get("sample") or ""),
                str(body.get("desc") or ""),
                int(body.get("seed") or 0),
                body.get("text"),
                force=bool(body.get("force")),
            )
        except voice_service.VoiceError as exc:
            raise ApiError(400, str(exc)) from exc

    if parts == ["imagegen", "upload"]:
        # 把一张参考图放进 ComfyUI 的 input 目录，拿回 LoadImage 能用的文件名。
        #
        # 两种来源：① 项目里的素材（projectId + fileName），后端直接从数据目录读，
        # 前端不用把几 MB 图片转 base64 再发一遍；② 临时图（name + data）。
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, f"请求体不是合法 JSON：{exc}") from exc
        if not isinstance(body, dict):
            raise ApiError(400, "请求体必须是一个 JSON 对象")
        base = comfy_base(str(body.get("base") or ""))
        try:
            name = resolve_comfy_ref(ws, base, body)
        except image_service.ImageGenError as exc:
            raise ApiError(400, str(exc)) from exc
        return 200, {"name": name}

    if parts == ["imagegen", "run"]:
        # 跑一份本地文生图工作流，直接把图当 base64 带回去。
        #
        # 为什么不在后端直接写进 assets：图片落库要跟 assets 行一起写，
        # 那件事前端（registry.addGeneratedKeyframe）本来就做了 —— 后端只负责
        # 「prompt 进去、图出来」，两边的职责不就串了。
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, f"请求体不是合法 JSON：{exc}") from exc
        if not isinstance(body, dict):
            raise ApiError(400, "请求体必须是一个 JSON 对象")

        def _num(key: str, cast):
            raw_value = body.get(key)
            if raw_value is None or raw_value == "":
                return None
            try:
                return cast(raw_value)
            except (TypeError, ValueError) as exc:
                raise ApiError(400, f"{key} 不是合法数字：{raw_value}") from exc

        if image_via_hub():
            # 运行前服务接管：它会先把生图模型搬到卡上（切走时卸掉），
            # 这里不用管 ComfyUI 在哪、有没有起。
            hub_input = hub_image_input(ws, body)
            wait = float(_num("waitSec", float) or 300.0)
            out = hub_call(
                "/v1/run",
                {"capability": "image.generate", "input": hub_input, "timeoutSec": wait},
                timeout=wait + 180.0,
            )
            return 200, hub_image_result(out, str(body.get("prompt") or ""))

        try:
            refs = resolve_refs(ws, comfy_base(str(body.get("base") or "")), body.get("refs"))
        except image_service.ImageGenError as exc:
            raise ApiError(400, str(exc)) from exc

        try:
            result = image_service.generate(
                comfy_base(str(body.get("base") or "")),
                str(body.get("root") or "").strip() or guess_comfy_root(),
                workflow=str(body.get("workflow") or ""),
                prompt=str(body.get("prompt") or ""),
                negative=body.get("negative"),
                width=_num("width", int),
                height=_num("height", int),
                seed=_num("seed", int),
                steps=_num("steps", int),
                cfg=_num("cfg", float),
                refs=refs,
                wait_sec=float(_num("waitSec", float) or 300.0),
            )
        except image_service.ImageGenError as exc:
            raise ApiError(400, str(exc)) from exc

        return 200, {
            "image": base64.b64encode(result["image"]).decode("ascii"),
            "mime": result["mime"],
            "promptId": result["promptId"],
            "seconds": result["seconds"],
            "filename": result.get("filename"),
            "from": result.get("from"),
            "report": result["report"],
        }

    if parts == ["imagegen", "batch"]:
        # 批量出图：N 条提示词做成一张图提交，加载器与文本编码器只走一遍。
        # 每条要带 key —— 回来时靠它把图对回"哪一段"，顺序不能靠猜。
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, f"请求体不是合法 JSON：{exc}") from exc
        if not isinstance(body, dict):
            raise ApiError(400, "请求体必须是一个 JSON 对象")
        raw_items = body.get("items")
        if not isinstance(raw_items, list) or not raw_items:
            raise ApiError(400, "items 不能为空：每条要带 key 和 prompt")
        if image_via_hub():
            # 整批一次交给运行前服务：N 条支路塞进同一张 ComfyUI 图里，共用一套
            # 文本编码器 + UNet。逐张调用看着"简单"，实际每换一张就要把 8.9G 的
            # 编码器和 7.2G 的 UNet 互相挤下卡再装回来 —— 采样 21 秒、装卸 70 秒。
            hub_items: list[dict] = []
            for idx, item in enumerate(raw_items):
                if not isinstance(item, dict):
                    raise ApiError(400, f"第 {idx + 1} 条格式不对")
                one = hub_image_input(
                    ws,
                    {
                        "prompt": item.get("prompt"),
                        "width": body.get("width"),
                        "height": body.get("height"),
                        "seed": item.get("seed"),
                        "steps": body.get("steps"),
                        "cfg": body.get("cfg"),
                        "workflow": body.get("workflow"),
                        "refs": item.get("refs"),
                    },
                )
                one["key"] = str(item.get("key") if item.get("key") is not None else idx)
                hub_items.append(one)

            wait = float(body.get("waitSec") or max(900.0, 90.0 * len(hub_items)))
            out = hub_call(
                "/v1/run",
                {
                    "capability": "image.generate",
                    "input": {
                        "items": hub_items,
                        "workflow": body.get("workflow"),
                        "negative": body.get("negative"),
                        "width": body.get("width"),
                        "height": body.get("height"),
                        "steps": body.get("steps"),
                        "cfg": body.get("cfg"),
                        "waitSec": wait,
                    },
                    "timeoutSec": wait,
                },
                timeout=wait + 180.0,
            )
            meta = out.get("meta") or {}
            return 200, {
                "images": [
                    {
                        "key": it.get("key"),
                        "image": it.get("image") or "",
                        "mime": it.get("mime") or "image/png",
                        "filename": "",
                    }
                    for it in (out.get("data") or [])
                ],
                "promptId": str(meta.get("promptId") or ""),
                "seconds": meta.get("seconds"),
                "secondsPerImage": meta.get("secondsPerImage"),
                "report": meta.get("report") or {},
                "engine": "modelhub",
            }

        items = []
        base = comfy_base(str(body.get("base") or ""))
        for idx, item in enumerate(raw_items):
            if not isinstance(item, dict):
                raise ApiError(400, f"第 {idx + 1} 条格式不对")
            seed = item.get("seed")
            try:
                item_refs = resolve_refs(ws, base, item.get("refs"))
            except image_service.ImageGenError as exc:
                raise ApiError(400, f"第 {idx + 1} 条的参考图：{exc}") from exc
            items.append(
                {
                    "key": str(item.get("key") or idx),
                    "prompt": str(item.get("prompt") or ""),
                    "seed": int(seed) if seed not in (None, "") else None,
                    "refs": item_refs,
                }
            )

        def _num(key: str, cast):
            raw_value = body.get(key)
            if raw_value is None or raw_value == "":
                return None
            try:
                return cast(raw_value)
            except (TypeError, ValueError) as exc:
                raise ApiError(400, f"{key} 不是合法数字：{raw_value}") from exc

        try:
            result = image_service.generate_batch(
                comfy_base(str(body.get("base") or "")),
                str(body.get("root") or "").strip() or guess_comfy_root(),
                workflow=str(body.get("workflow") or ""),
                items=items,
                negative=body.get("negative"),
                width=_num("width", int),
                height=_num("height", int),
                steps=_num("steps", int),
                cfg=_num("cfg", float),
                wait_sec=float(_num("waitSec", float) or max(900.0, 120.0 * len(items))),
            )
        except image_service.ImageGenError as exc:
            raise ApiError(400, str(exc)) from exc

        return 200, {
            "images": [
                {
                    "key": img["key"],
                    "image": base64.b64encode(img["image"]).decode("ascii"),
                    "mime": img["mime"],
                    "filename": img.get("filename"),
                }
                for img in result["images"]
            ],
            "promptId": result["promptId"],
            "seconds": result["seconds"],
            "report": result["report"],
        }

    if parts == ["voice", "speak"]:
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, f"请求体不是合法 JSON：{exc}") from exc
        try:
            audio = voice_service.speak(str(body.get("voiceId") or ""), str(body.get("text") or ""))
        except voice_service.VoiceError as exc:
            raise ApiError(400, str(exc)) from exc
        return 200, {"__raw__": audio, "__type__": "audio/wav"}

    # ---- ComfyUI 转发 ----

    if parts == ["comfy", "proxy"]:
        # 通用 JSON 转发：/system_stats、/queue、/history、/prompt、/interrupt、
        # /minimax/director_opt/* 全走这一条，前端不必为每个接口加后端代码。
        #
        # 注意：POST 分支拿到的是原始字节（素材上传和 pack 导入需要字节流），
        # 所以这里自己解一次 JSON，不能复用只走 JSON 的那些分支。
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, f"请求体不是合法 JSON：{exc}") from exc
        if not isinstance(body, dict):
            raise ApiError(400, "请求体必须是一个 JSON 对象")
        method = str(body.get("method") or "GET").upper()
        if method not in ("GET", "POST", "PUT", "DELETE"):
            raise ApiError(400, f"不支持的方法：{method}")
        path = str(body.get("path") or "/")
        base = comfy_base(str(body.get("base") or ""))
        try:
            timeout = float(body.get("timeout") or _COMFY_TIMEOUT)
        except (TypeError, ValueError):
            timeout = _COMFY_TIMEOUT
        status, ct, data = comfy_call(
            base, method, path, body=body.get("body"), timeout=timeout
        )
        return 200, _comfy_json_result(status, ct, data)

    if parts == ["comfy", "import_pack"]:
        # pack.zip 必须以 multipart 字段名 `pack` 提交，这里自己拼一次 multipart
        base = comfy_base(query.get("base", [""])[0])
        filename = query.get("filename", [""])[0] or "pack.zip"
        if not raw:
            raise ApiError(400, "空的 pack 文件")
        boundary = "----scriptstage" + uuid.uuid4().hex
        head = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="pack"; filename="{filename}"\r\n'
            f"Content-Type: application/zip\r\n\r\n"
        ).encode("utf-8")
        tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
        status, ct, data = comfy_call(
            base,
            "POST",
            "/minimax/director_opt/import_pack",
            raw=head + raw + tail,
            content_type=f"multipart/form-data; boundary={boundary}",
            timeout=120,
        )
        return 200, _comfy_json_result(status, ct, data)

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
    # 前端构建产物
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
}


def _origin_allowed(origin: str, host_header: str) -> bool:
    """回显 Origin 前的白名单。

    带 ``Allow-Credentials: true`` 时**绝不能**回 ``*``：那等于允许任意网站
    拿着用户的 cookie 读剧本台的数据。这里只放行两类来源 ——
    与请求 Host 同主机（含局域网 IP 直接访问），以及本机回环别名
    （localhost / 127.0.0.1 混用是开发时的常态）。
    """
    try:
        origin_host = urlparse(origin).netloc.rsplit(":", 1)[0].strip("[]")
    except ValueError:
        return False
    if not origin_host:
        return False
    host = (host_header or "").rsplit(":", 1)[0].strip("[]")
    if origin_host == host:
        return True
    return origin_host in {"127.0.0.1", "localhost", "::1"} and host in {
        "127.0.0.1",
        "localhost",
        "::1",
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "ScriptStage/0.1"

    def _cors(self) -> None:
        origin = self.headers.get("Origin") or ""
        if origin and _origin_allowed(origin, self.headers.get("Host") or ""):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "86400")

    def _send_json(self, status: int, payload: Any) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        for cookie in getattr(self, "_cookies", []):
            self.send_header("Set-Cookie", cookie)
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

    # --------------------------- 前端静态托管 ---------------------------

    def _serve_static(self, path: str) -> bool:
        """把 dist/ 吐给浏览器（前后台共用一个端口）。

        返回 False 表示没启用静态托管，交给调用方回 404。
        """
        root = STATIC_DIR
        if root is None or not (root / "index.html").is_file():
            return False
        rel = unquote(path).lstrip("/")
        target = (root / rel).resolve() if rel else (root / "index.html").resolve()
        try:
            target.relative_to(root.resolve())
        except ValueError:
            # 目录穿越（../..）一律当没找到
            return False
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            # 前端用的是 hash 路由，正常情况下不会命中这里；兜底回首页
            target = root / "index.html"
            if not target.is_file():
                return False
        try:
            data = target.read_bytes()
        except OSError:
            return False

        suffix = target.suffix.lower()
        self.send_response(200)
        self.send_header("Content-Type", MIME_BY_EXT.get(suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        # vite 产物里 assets/ 下带内容哈希，可以长缓存；
        # index.html 必须每次回源，否则改完前端刷新看到的还是旧包。
        if "/assets/" in target.as_posix():
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)
        return True

    # ------------------------------ 鉴权 ------------------------------

    def _client_ip(self) -> str:
        return self.client_address[0] if self.client_address else ""

    def _token(self) -> str:
        raw = self.headers.get("Cookie") or ""
        if raw:
            jar = SimpleCookie()
            try:
                jar.load(raw)
            except CookieError:
                jar = None  # type: ignore[assignment]
            morsel = jar.get(SESSION_COOKIE) if jar else None
            if morsel:
                return morsel.value
        header = self.headers.get("Authorization") or ""
        if header.lower().startswith("bearer "):
            return header[7:].strip()
        return ""

    def _resolve_user(self) -> str | None:
        if not AUTH_REQUIRED:
            return None
        token = self._token()
        return auth_service.verify_token(token) if token else None

    def _route_auth(self, method: str, parts: list[str]) -> tuple[int, Any]:
        if method == "GET" and parts == ["auth", "me"]:
            if not AUTH_REQUIRED:
                # --no-auth 排障模式下没有"是谁"，但前端得能进得去，
                # 否则会一直卡在登录页（登录接口又真的会校验账号）。
                return 200, {"user": {"username": "local", "displayName": "本机（免登录）"}}
            name = self._resolve_user()
            return 200, {"user": auth_service.get_user(name) if name else None}

        if method == "POST" and parts == ["auth", "login"]:
            body = _json_body(self)
            user, token = auth_service.login(
                str(body.get("username") or ""),
                str(body.get("password") or ""),
                self._client_ip(),
            )
            self._cookies.append(_session_cookie(token, auth_service.TOKEN_TTL))
            return 200, {"user": user, "expiresIn": auth_service.TOKEN_TTL}

        if method == "POST" and parts == ["auth", "logout"]:
            self._cookies.append(_session_cookie("", 0))
            return 200, {"ok": True}

        if method == "POST" and parts == ["auth", "password"]:
            name = self._resolve_user()
            if not name:
                raise auth_service.AuthError(401, "未登录")
            body = _json_body(self)
            token = auth_service.change_password(
                name,
                str(body.get("oldPassword") or ""),
                str(body.get("newPassword") or ""),
                self._client_ip(),
            )
            self._cookies.append(_session_cookie(token, auth_service.TOKEN_TTL))
            return 200, {"ok": True}

        raise ApiError(404, "未知的鉴权接口")

    def _proxy_comfy_media(self, query: dict[str, list[str]]) -> None:
        """把 ComfyUI 的 `/view`（整片/图片产物）流式转给浏览器。"""
        base = comfy_base(query.get("base", [""])[0])
        qs = urlencode(
            {k: query.get(k, [""])[0] for k in ("filename", "subfolder", "type") if query.get(k)}
        )
        self._stream_from_comfy(f"{base}/view?{qs}")

    def _proxy_comfy_clip(self, query: dict[str, list[str]]) -> None:
        """导演台的「段片段」转发（`/minimax/director_opt/segment_clip`）。

        为什么不能像以前那样让 `<video>` 直连 8188：跨源媒体在页面里会被浏览器
        直接判 `MEDIA_ERR_SRC_NOT_SUPPORTED`（ComfyUI 默认不带 CORS 头），
        地址栏单独打开却是好的 —— 表现为"链接能播、页面上是黑块"。整片产物
        早就走后端转发了，段片段也得走同一条路。
        """
        base = comfy_base(query.get("base", [""])[0])
        qs = urlencode(
            {
                k: query.get(k, [""])[0]
                for k in ("node_id", "workflow_name", "index", "variant")
                if query.get(k)
            }
        )
        self._stream_from_comfy(f"{base}/minimax/director_opt/segment_clip?{qs}")

    def _stream_from_comfy(self, url: str) -> None:
        """把 ComfyUI 的媒体流式转给浏览器，并原样透传 Range。

        为什么要专门做这一层（而不是走通用 ``comfy_call``）：那条路会把整个
        响应体读进内存再一次性吐出，并且**丢掉 Range / Accept-Ranges**。结果是
        ``<video>`` 拿不到分段响应 —— 不能拖进度、不能边下边播，某些浏览器
        （Chrome）连首帧都不放，表现为"产物认出来了但播不了"。

        这里改成边读边写：支持 206、Content-Range、Accept-Ranges，
        文件多大都不占后端内存。
        """
        headers: dict[str, str] = {}
        want_range = self.headers.get("Range")
        if want_range:
            headers["Range"] = want_range

        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            resp = _COMFY_OPENER.open(req, timeout=60)
        except urllib.error.HTTPError as exc:
            # 404 / 416 这类要原样回传状态码：416 是"你请求的区间不存在"，
            # 浏览器据此重新协商，伪装成 200 反而会把它带进死路。
            body = b""
            try:
                body = exc.read()
            except Exception:  # noqa: BLE001
                body = b""
            self.send_response(exc.code)
            self.send_header("Content-Type", exc.headers.get("Content-Type") or "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)
            return
        except Exception as exc:  # noqa: BLE001
            self._send_json(502, {"error": f"连不上 ComfyUI（{url}）：{type(exc).__name__}: {exc}"})
            return

        with resp:
            self.send_response(resp.status)
            self.send_header("Content-Type", resp.headers.get("Content-Type") or "application/octet-stream")
            for name in ("Content-Length", "Content-Range", "Last-Modified", "ETag"):
                value = resp.headers.get(name)
                if value:
                    self.send_header(name, value)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "private, max-age=60")
            self._cors()
            self.end_headers()
            try:
                while True:
                    chunk = resp.read(256 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                # 用户拖进度条会主动断开上一个请求，这是正常现象，不是错误
                pass

    def _dispatch(self, method: str) -> None:
        self._cookies = []
        parsed = urlparse(self.path)
        head = [unquote(p) for p in parsed.path.strip("/").split("/") if p]
        is_api = bool(head) and head[0] == "api"
        parts = head[1:] if is_api else head

        # 非 /api 一律当静态资源：前端构建产物就挂在同一个端口上
        if not is_api:
            if method == "GET" and self._serve_static(parsed.path):
                return
            self._send_json(
                404,
                {
                    "error": "没有前端构建产物（dist/）。开发用 `npm run dev`，"
                    "或者先 `npm run build` 再启动。"
                },
            )
            return

        if not parts:
            self._send_json(200, {"ok": True})
            return

        query = parse_qs(parsed.query)

        # 探活免登录：前端要靠它判断"后端起没起"，登录页本身也要用。
        if method == "GET" and parts == ["health"]:
            user = self._resolve_user()
            # --no-auth 下等同于"永远已登录"，否则存储探测拿不到数据目录
            authenticated = bool(user) or not AUTH_REQUIRED
            payload: dict[str, Any] = {
                "ok": True,
                "authRequired": AUTH_REQUIRED,
                "authenticated": authenticated,
            }
            if authenticated:
                payload["dataDir"] = str(HOLDER.ws.root)
                if user:
                    payload["user"] = auth_service.get_user(user)
            self._send_json(200, payload)
            return

        if parts[0] == "auth":
            try:
                status, result = self._route_auth(method, parts)
            except auth_service.AuthError as exc:
                self._send_json(exc.status, {"error": exc.message})
                return
            except ApiError as exc:
                self._send_json(exc.status, {"error": exc.message})
                return
            except Exception as exc:  # noqa: BLE001
                self._send_json(500, {"error": f"{type(exc).__name__}: {exc}"})
                return
            self._send_json(status, result)
            return

        if AUTH_REQUIRED and not self._resolve_user():
            # 前端收到 401 就跳登录页；带上 authRequired 让登录页知道要弹框
            self._send_json(401, {"error": "未登录或登录已过期", "authRequired": True})
            return

        # 产物（图/视频）走专用转发：要支持 Range 分段，通用路由做不到
        if method == "GET" and parts[:2] == ["comfy", "view"]:
            self._proxy_comfy_media(query)
            return
        # 导演台的段片段（一采/二采）同样要流式 + Range
        if method == "GET" and parts[:2] == ["comfy", "clip"]:
            self._proxy_comfy_clip(query)
            return
        try:
            if method == "GET":
                status, result = route_get(parts, query)
            elif method == "PUT":
                status, result = route_put(parts, _json_body(self))
            elif method == "POST":
                status, result = route_post(parts, query, _raw_body(self))
            else:
                status, result = route_delete(parts, _json_body(self))

            if isinstance(result, dict) and "__raw__" in result:
                self._send_bytes(200, result["__raw__"], str(result.get("__type__") or "application/octet-stream"))
                return
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


class _Server(ThreadingHTTPServer):
    """
    ``request_queue_size`` 默认是 5 —— 前端一次刷新会并发打过来十几个请求，
    队列打满后内核直接拒绝连接，前端就报「连不上后端」。
    这里放大到 128；daemon_threads 保证 Ctrl-C 时工作线程不拖住退出。
    """

    daemon_threads = True
    request_queue_size = 128


def _cli_users(argv: list[str]) -> int:
    """`python server/app.py user ...` —— 账号只能从这里创建。

    没有注册入口是有意的：这是工作台，不是网站。加人要管理员在本机命令行做。
    """
    parser = argparse.ArgumentParser(
        prog="app.py user", description="剧本台账号管理（本系统不提供注册）"
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_add = sub.add_parser("add", help="新建账号")
    p_add.add_argument("username")
    p_add.add_argument("--password", default="", help="留空则随机生成并打印")
    p_add.add_argument("--display", default="", help="显示名")

    p_pw = sub.add_parser("passwd", help="重置密码")
    p_pw.add_argument("username")
    p_pw.add_argument("--password", default="", help="留空则随机生成并打印")

    p_del = sub.add_parser("del", help="删除账号")
    p_del.add_argument("username")

    sub.add_parser("list", help="列出账号")

    args = parser.parse_args(argv)
    try:
        if args.cmd == "add":
            user, plain = auth_service.create_user(args.username, args.password or None, args.display)
            print(f"已创建账号 {user['username']}（{user['displayName']}）")
            print(f"密码：{plain}")
            print("请把密码交给本人，登录后可在右上角用户菜单里改掉。")
        elif args.cmd == "passwd":
            user, plain = auth_service.set_password(args.username, args.password or None)
            print(f"已重置 {user['username']} 的密码")
            print(f"新密码：{plain}")
        elif args.cmd == "del":
            auth_service.delete_user(args.username)
            print(f"已删除账号 {args.username}")
        else:
            users = auth_service.list_users()
            if not users:
                print("还没有任何账号。")
            for u in users:
                last = (
                    time.strftime("%Y-%m-%d %H:%M", time.localtime(u["lastLoginAt"]))
                    if u.get("lastLoginAt")
                    else "从未登录"
                )
                print(f"  {u['username']:<20} {u['displayName']:<12} 最近登录：{last}")
    except auth_service.AuthError as exc:
        print(f"失败：{exc.message}")
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    global AUTH_REQUIRED, STATIC_DIR

    # 行缓冲：启动横幅里有「首次启动的初始密码」，被 stdout 缓冲吞掉的话
    # 用户就永远看不到它（双击 bat 时父进程不是终端就会这样）。
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass

    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "user":
        return _cli_users(argv[1:])

    parser = argparse.ArgumentParser(description="剧本台后端")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--data-dir", default="", help="数据目录；缺省用上次配置的目录")
    parser.add_argument(
        "--static-dir",
        default=str(DEFAULT_STATIC_DIR),
        help="前端构建产物目录；存在就一起托管（默认 ./dist）",
    )
    parser.add_argument(
        "--no-auth",
        action="store_true",
        help="关闭登录校验。只给集成测试和本机排障用，别在共用机器上这么起",
    )
    args = parser.parse_args(argv)

    AUTH_REQUIRED = not args.no_auth
    STATIC_DIR = Path(args.static_dir).expanduser() if args.static_dir else None

    if args.data_dir:
        # 一次性覆盖：不写全局配置，免得临时目录（集成测试用）被记住
        HOLDER.set_dir(args.data_dir, persist=False)
    else:
        HOLDER.ws.ensure()
        save_config({"dataDir": str(HOLDER.ws.root)})

    first = None
    if AUTH_REQUIRED:
        try:
            first = auth_service.ensure_initial_account()
        except auth_service.AuthError as exc:
            print(f"账号库初始化失败：{exc.message}")

    server = _Server((args.host, args.port), Handler)
    print(f"剧本台已启动: http://{args.host}:{args.port}")
    if STATIC_DIR and (STATIC_DIR / "index.html").is_file():
        print(f"前端: 已托管 {STATIC_DIR}（浏览器直接打开上面这个地址）")
    else:
        print(f"前端: 没找到 {STATIC_DIR}/index.html —— 先 `npm run build`，或开发时用 `npm run dev`")
    print(f"数据目录: {HOLDER.ws.root}")
    if not sheet_service.has_pillow():
        # 不阻断启动：只有"把一组设定图拼成参考图"用得到它，其它功能都是标准库
        print(
            "⚠ 没装 Pillow：设定图拼接（/api/sheet/compose）不可用。"
            "装一下就好：python -m pip install -r server/requirements.txt"
        )
    if not AUTH_REQUIRED:
        print("⚠ 已关闭登录校验（--no-auth）")
    elif first:
        user, plain = first
        print("")
        print("=" * 46)
        print("  首次启动，已创建管理员账号")
        print(f"  用户名：{user['username']}")
        print(f"  密  码：{plain}")
        print(f"（也写在 {auth_service.INITIAL_ACCOUNT_PATH}）")
        print("=" * 46)
        print("")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
