"""HTTP 面：给上层一个统一的入口，也给 OpenAI 客户端一个熟悉的形状。

路由分两层：
  * `/v1/preflight` `/v1/status` `/v1/models` —— **运行前**要看的；
  * `/v1/run` 和三个 OpenAI 兼容别名 —— 真正调用的。

为什么要 OpenAI 兼容别名：剧本台里已经有走 `/v1/chat/completions`、
`/v1/images/generations`、`/v1/audio/speech` 的客户端。让它们原样指过来，
就能把「本地模型」当成「一个模型服务」用，不用改业务代码。
"""

from __future__ import annotations

import base64
import json
import queue
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from .console import CONSOLE_HTML
from .drivers import DriverError
from .scheduler import Hub, HubError

MAX_BODY = 64 * 1024 * 1024  # 参考图 base64 会比较大，给到 64M

#: 一次编码多少原始字节再写出去。3 MiB → base64 后 4 MiB，也就是「一段」的内存上限。
#: 见 `Handler._json_stream` 的说明。
B64_CHUNK = 3 * 1024 * 1024


def _b64_len(n: int) -> int:
    """base64 编码后的长度（不真的编码就能算出来，Content-Length 要用）。"""
    return 4 * ((n + 2) // 3)


def _frag(obj: Any) -> bytes:
    """把一个小对象序列化成 JSON 片段。"""
    return json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    hub: Hub
    protocol_version = "HTTP/1.1"
    server_version = "modelhub/1.0"

    # ------------------------------------------------------------ 入口

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        self._safe(self._get)

    def do_POST(self) -> None:  # noqa: N802
        self._safe(self._post)

    def _safe(self, fn) -> None:
        try:
            fn()
        except HubError as exc:
            self._json(exc.status, {"ok": False, "error": str(exc), "detail": exc.detail})
        except DriverError as exc:
            self._json(502, {"ok": False, "error": str(exc)})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception as exc:  # noqa: BLE001
            tb = traceback.format_exc(limit=6)
            print(tb, file=sys.stderr, flush=True)
            self._json(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}", "traceback": tb})

    # ------------------------------------------------------------ GET

    def _get(self) -> None:
        u = urlparse(self.path)
        path = u.path.rstrip("/") or "/"
        q = parse_qs(u.query)

        if path == "/":
            self._redirect("/console")
            return
        if path == "/console":
            self._html(CONSOLE_HTML)
            return
        if path == "/health":
            self._json(
                200,
                {
                    "ok": True,
                    "service": "modelhub",
                    "singleCard": True,
                    "gpuIndex": self.hub.cfg.gpu.index,
                    "at": int(time.time() * 1000),
                },
            )
            return
        if path == "/v1/env":
            self._json(200, {"ok": True, **self.hub.env()})
            return
        if path == "/v1/models":
            self._json(200, {"ok": True, "models": self.hub.models()})
            return
        if path == "/v1/status":
            self._json(200, self.hub.status())
            return
        if path == "/v1/events":
            if "text/event-stream" in (self.headers.get("Accept") or ""):
                self._sse()
            else:
                since = _int(q.get("since", ["0"])[0], 0)
                limit = _int(q.get("limit", ["100"])[0], 100)
                self._json(200, {"ok": True, "events": self.hub.events(since, limit)})
            return
        if path == "/v1/preflight":
            caps = [c for c in (q.get("capabilities", [""])[0] or "").split(",") if c]
            self._json(200, self.hub.preflight(caps or None))
            return
        # /v1/models/<id>/logs
        parts = [p for p in path.split("/") if p]
        if len(parts) == 4 and parts[:2] == ["v1", "models"] and parts[3] == "logs":
            self._logs(parts[2], _int(q.get("lines", ["60"])[0], 60))
            return
        self._json(404, {"ok": False, "error": f"没有这个路由：GET {path}"})

    def _logs(self, model_id: str, lines: int) -> None:
        slot = self.hub._slots.get(model_id)  # noqa: SLF001 — 同一个进程里的只读视图
        if not slot:
            raise HubError(f"没有这个模型：{model_id}", status=404)
        loaded = slot.loaded
        if not loaded or not loaded.proc:
            self._json(
                200,
                {
                    "ok": True,
                    "model": model_id,
                    "external": bool(loaded and loaded.external),
                    "lines": [] if not loaded else ["（外部服务，日志在它自己的控制台）"],
                },
            )
            return
        text = loaded.proc.tail(max(1, min(lines, 500)))
        self._json(200, {"ok": True, "model": model_id, "path": str(loaded.proc.log_path),
                         "lines": text.splitlines()})

    # ------------------------------------------------------------ POST

    def _post(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"
        body = self._body()

        if path == "/v1/preflight":
            caps = body.get("capabilities")
            if caps is not None and not isinstance(caps, list):
                raise HubError("capabilities 必须是数组", status=400)
            models = body.get("models") or {}
            if not isinstance(models, dict):
                raise HubError("models 必须是对象（能力 → 模型 id）", status=400)
            self._json(200, self.hub.preflight(caps, models=models))
            return

        if path == "/v1/run":
            self._run(body)
            return

        if path == "/v1/unload":
            if body.get("all") or body.get("model") in (None, ""):
                self._json(200, self.hub.unload_all(force=bool(body.get("force"))))
                return
            self._json(200, self.hub.unload(str(body["model"]), force=bool(body.get("force"))))
            return

        parts = [p for p in path.split("/") if p]
        if len(parts) == 4 and parts[:2] == ["v1", "models"] and parts[3] in ("load", "unload"):
            mid = parts[2]
            if parts[3] == "load":
                self._json(200, self._load(mid))
            else:
                self._json(200, self.hub.unload(mid, force=bool(body.get("force"))))
            return

        if path == "/v1/chat/completions":
            self._chat(body)
            return
        if path == "/v1/images/generations":
            self._images(body)
            return
        if path == "/v1/audio/speech":
            self._speech(body)
            return

        self._json(404, {"ok": False, "error": f"没有这个路由：POST {path}"})

    def _load(self, model_id: str) -> dict[str, Any]:
        slot = self.hub._slots.get(model_id)  # noqa: SLF001
        if not slot:
            raise HubError(f"没有这个模型：{model_id}", status=404)
        t0 = time.monotonic()
        self.hub.acquire(slot.spec.capability, model_id)
        self.hub.release(model_id)
        return {
            "ok": True,
            "model": model_id,
            "ms": int((time.monotonic() - t0) * 1000),
            "slot": self.hub._slots[model_id].to_dict(),  # noqa: SLF001
        }

    def _run(self, body: dict[str, Any]) -> None:
        cap = str(body.get("capability") or "").strip()
        if not cap:
            raise HubError("缺 capability", status=400)
        model = body.get("model") or body.get("modelId")
        timeout = body.get("timeoutSec")
        if isinstance(body.get("input"), dict):
            payload = body["input"]
        else:
            payload = {
                k: v
                for k, v in body.items()
                if k not in ("capability", "model", "modelId", "timeoutSec", "raw")
            }
        res = self.hub.run(
            cap,
            payload,
            model_id=str(model) if model else None,
            timeout=float(timeout) if timeout else None,
        )
        raw = bool(body.get("raw"))
        if res["kind"] == "image" and raw:
            self._bytes(200, res["data"], res["mime"] or "image/png")
            return
        if res["kind"] == "audio" and raw:
            self._bytes(200, res["data"], res["mime"] or "audio/wav")
            return
        # 走到这里都是「把二进制塞进 JSON」的路径。整份 json.dumps 的写法会在内存
        # 里同时攒四份：原始字节 → base64 串 → 整份 JSON 串 → 再 encode 成 bytes。
        # 改成边编码边写，峰值只有一段（B64_CHUNK）。实测批量 8×2 MiB 的图
        # 从 +43.0 MiB 降到 +10 上下，而响应里真正有用的只有 16 MiB。
        pre = {k: res[k] for k in ("ok", "capability", "model", "kind") if k in res}
        pre["encoding"] = "base64"
        head = _frag(pre)
        if isinstance(res["data"], (bytes, bytearray)):
            # 单块：data 直接是 base64 字符串
            self._json_stream(
                200,
                [
                    head[:-1] + b',"data":"',
                    (bytes(res["data"]),),
                    b'","mime":' + _frag(res["mime"] or "") + b',"meta":'
                    + _frag(res["meta"]) + b"}",
                ],
            )
            return
        if res["kind"] == "images":
            # 批量出图：data 是一组 {key, image(bytes), mime}
            pieces: list[Any] = [head[:-1] + b',"data":[']
            for i, it in enumerate(res["data"] or []):
                if i:
                    pieces.append(b",")
                pieces.append(b'{"key":' + _frag(it.get("key")) + b',"image":"')
                pieces.append((bytes(it.get("image") or b""),))
                pieces.append(b'","mime":' + _frag(it.get("mime") or "image/png") + b"}")
            pieces.append(b'],"meta":' + _frag(res["meta"]) + b"}")
            self._json_stream(200, pieces)
            return
        self._json(200, res)

    # ------------------------------------------------------------ OpenAI 兼容

    def _chat(self, body: dict[str, Any]) -> None:
        if body.get("stream"):
            raise HubError(
                "本服务不支持流式；要流式请直连被加载模型的端口，或换非流式调用",
                status=400,
            )
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            raise HubError("messages 必须是非空数组", status=400)
        res = self.hub.run(
            "text.generate",
            {
                "messages": messages,
                "max_tokens": body.get("max_tokens"),
                "temperature": body.get("temperature", 0.7),
                "top_p": body.get("top_p", 0.95),
                "stop": body.get("stop"),
                "seed": body.get("seed"),
                "response_format": body.get("response_format"),
            },
            timeout=float(body["timeoutSec"]) if body.get("timeoutSec") else None,
        )
        out = res["data"]
        # 补上 OpenAI 要求的 id/created/model/usage（llama-server 一般自己会给）
        out.setdefault("id", f"chatcmpl-{int(time.time() * 1000)}")
        out.setdefault("object", "chat.completion")
        out.setdefault("created", int(time.time()))
        out.setdefault("model", res["model"])
        self._json(200, out)

    def _images(self, body: dict[str, Any]) -> None:
        prompt = str(body.get("prompt") or "").strip()
        if not prompt:
            raise HubError("prompt 不能为空", status=400)
        width, height = _parse_size(str(body.get("size") or ""))
        res = self.hub.run(
            "image.generate",
            {
                "prompt": prompt,
                "negative": body.get("negative"),
                "width": width,
                "height": height,
                "seed": body.get("seed"),
                "steps": body.get("steps"),
                "cfg": body.get("cfg"),
                "workflow": body.get("workflow"),
                "refs": body.get("refs"),
                "images": body.get("images"),
                "waitSec": body.get("waitSec"),
            },
            timeout=float(body["timeoutSec"]) if body.get("timeoutSec") else None,
        )
        self._json_stream(
            200,
            [
                b'{"created":' + _frag(int(time.time())) + b',"data":[{"b64_json":"',
                (bytes(res["data"]),),
                b'","revised_prompt":' + _frag(prompt) + b'}],"model":'
                + _frag(res["model"]) + b',"meta":' + _frag(res["meta"]) + b"}",
            ],
        )

    def _speech(self, body: dict[str, Any]) -> None:
        text = str(body.get("input") or "").strip()
        if not text:
            raise HubError("input 不能为空", status=400)
        instr = str(body.get("instructions") or body.get("instruction") or "").strip()
        if instr:
            # 有音色描述 = 设计音色（产出的是参考音频，不是成片配音）
            res = self.hub.run(
                "voice.design",
                {
                    "text": text,
                    "instruction": instr,
                    "seed": body.get("seed") or 0,
                    "response_format": body.get("response_format"),
                },
                timeout=float(body["timeoutSec"]) if body.get("timeoutSec") else None,
            )
        else:
            res = self.hub.run(
                "voice.synthesize",
                {"text": text, "voice": body.get("voice"), "voiceDir": body.get("voiceDir")},
                timeout=float(body["timeoutSec"]) if body.get("timeoutSec") else None,
            )
        self._bytes(200, res["data"], res["mime"] or "audio/wav")

    # ------------------------------------------------------------ 传输

    def _body(self) -> dict[str, Any]:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        if n > MAX_BODY:
            raise HubError(f"请求体太大（{n} 字节，上限 {MAX_BODY}）", status=413)
        raw = self.rfile.read(n)
        try:
            data = json.loads(raw.decode("utf-8", "replace"))
        except json.JSONDecodeError as exc:
            raise HubError(f"请求体不是合法 JSON：{exc}") from exc
        if not isinstance(data, dict):
            raise HubError("请求体必须是 JSON 对象", status=400)
        return data

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _json_stream(self, status: int, pieces: list[Any]) -> None:
        """把 JSON 分片写出去；二进制大块边编码边发。

        `pieces` 里普通 `bytes` 原样写，**tuple** `(blob,)` 是要 base64 的二进制：
        它只在这里按 `B64_CHUNK` 分段编码，峰值 = 一段，而不是整张图的好几倍。

        Content-Length 先用 `_b64_len` 算术算准，所以不用 chunked 编码 ——
        `fetch`、`urllib`、`curl` 都能吃，行为和 `_json` 一致。
        """
        total = 0
        for p in pieces:
            total += _b64_len(len(p[0])) if isinstance(p, tuple) else len(p)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(total))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        try:
            for p in pieces:
                if isinstance(p, tuple):
                    view = memoryview(p[0])
                    for i in range(0, len(view), B64_CHUNK):
                        self.wfile.write(base64.b64encode(view[i:i + B64_CHUNK]))
                else:
                    self.wfile.write(p)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _bytes(self, status: int, data: bytes, mime: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _html(self, html: str) -> None:
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _redirect(self, to: str) -> None:
        self.send_response(302)
        self.send_header("Location", to)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _sse(self) -> None:
        q = self.hub.subscribe()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self._cors()
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    ev = q.get(timeout=15.0)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                line = json.dumps(ev, ensure_ascii=False)
                self.wfile.write(f"data: {line}\n\n".encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.hub.unsubscribe(q)

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        # 默认实现每个请求往 stderr 打一行，SSE 长连接会刷屏；只在出错时打
        if str(args[1] if len(args) > 1 else "").startswith(("4", "5")):
            print(f"[http] {fmt % args}", file=sys.stderr, flush=True)


def _int(raw: Any, default: int) -> int:
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def _parse_size(size: str) -> tuple[int | None, int | None]:
    if not size or "x" not in size.lower():
        return None, None
    a, b = size.lower().split("x", 1)
    try:
        return int(a), int(b)
    except ValueError:
        return None, None


def make_server(hub: Hub, host: str | None = None, port: int | None = None) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"hub": hub})
    srv = ThreadingHTTPServer(
        (host or hub.cfg.host, int(port if port is not None else hub.cfg.port)),
        handler,
    )
    srv.daemon_threads = True
    return srv
