"""命令行：开着服务时走 HTTP，没开时只做无副作用的只读动作。

为什么要分两种：
  * `load` / `unload` 会动显存。如果 CLI 自己再建一个 Hub，就会和正在跑的
    服务各拉一份模型，两个进程抢一张卡 —— 这正是本服务要消灭的事。
  * `preflight` / `status` 是只读的，服务没起时也得能看，所以允许本地算。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .config import (
    CAPABILITY_KEYS,
    CAPABILITY_TITLES,
    DEFAULT_CONFIG_PATH,
    HubConfig,
    load_config,
    write_example,
)
from .drivers import DriverError
from .scheduler import Hub, HubError

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


# ---------------------------------------------------------------- 输出


def _p(text: str = "") -> None:
    print(text, flush=True)


def _mb(v: Any) -> str:
    return f"{int(v):,} MB" if isinstance(v, (int, float)) else "-"


def _print_pre(data: dict[str, Any]) -> None:
    g = data.get("gpu") or {}
    st = g.get("stats") or {}
    head = f"单卡 GPU {g.get('index')}"
    if st.get("name"):
        head += f" · {st['name']} · {_mb(st.get('totalMb'))}"
    _p(head)
    led = data.get("ledger") or {}
    _p(
        f"  别人占 {_mb(led.get('othersMb'))} · 本服务 {_mb(led.get('hubMb'))} · "
        f"保留 {_mb(led.get('reservedMb'))} · 可用预算 {_mb(led.get('budgetMb'))}"
    )
    _p()
    for row in data.get("capabilities") or []:
        mark = "可用" if row.get("ready") else "阻断"
        state = "已加载" if row.get("loaded") else row.get("state")
        _p(f"[{mark}] {row['title']} · {row.get('modelTitle') or '（没有模型）'} · {state}")
        for c in row.get("checks") or []:
            tag = "阻断" if c["level"] == "error" else "提醒"
            _p(f"        [{tag}] {c['message']}")
            if c.get("hint"):
                _p(f"               → {c['hint']}")
        for v in row.get("willEvict") or []:
            _p(f"        [让位] 会先卸载 {v['title']}（{_mb(v['mb'])}）")
    if data.get("advice"):
        _p()
        _p("建议：")
        for a in data["advice"]:
            _p(f"  - {a}")
    _p()
    _p("结论：" + ("可以跑" if data.get("ok") else f"有 {len(data.get('blockers') or [])} 项阻断"))


def _print_status(data: dict[str, Any]) -> None:
    g = data.get("gpu") or {}
    st = g.get("stats") or {}
    _p(f"单卡 GPU {g.get('index')} · {st.get('name', '-')} · 已用 {_mb(st.get('usedMb'))} / {_mb(st.get('totalMb'))}")
    led = data.get("ledger") or {}
    _p(
        f"  别人 {_mb(led.get('othersMb'))} · 本服务 {_mb(led.get('hubMb'))} · "
        f"保留 {_mb(led.get('reservedMb'))} · 预算 {_mb(led.get('budgetMb'))}"
    )
    rot = data.get("rotation") or {}
    if rot:
        hot = "、".join(f"{h['title']}（{_mb(h['mb'])}）" for h in rot.get("hot") or []) or "空"
        mode = "严格轮转，只留一个" if rot.get("exclusive") else "共享（装得下就都留）"
        _p(f"  卡上现在 {hot} · {mode}")
        last = rot.get("last")
        if last:
            _p(
                f"  上次换人 {'、'.join(last.get('fromTitles') or [])} → {last.get('toTitle')}"
                f" · {last.get('ms')}ms · 累计 {rot.get('swaps')} 次"
            )
    _p()
    for s in data.get("slots") or []:
        vram = s.get("realVramMb") or s.get("estVramMb")
        extra = f" pid {s['runtime']['pid']}" if (s.get("runtime") or {}).get("pid") else ""
        _p(
            f"  {s['state']:<9} {s['capabilityTitle']:<5} {s['id']:<14} "
            f"{_mb(vram):>10}{extra}"
        )
    if data.get("recent"):
        _p()
        _p("最近事件：")
        for e in data["recent"][-8:]:
            bits = [str(e.get(k)) for k in ("model", "ms", "reason") if e.get(k) is not None]
            _p(f"  {e['kind']:<14} {' · '.join(bits)}")


def _print_models(data: dict[str, Any]) -> None:
    for m in data.get("models") or []:
        _p(
            f"{m['id']:<16} {m['capabilityTitle']:<5} {m['driverTitle']:<22} "
            f"port {m['port'] or '-':<6} {m['state']:<9} {m['title']}"
        )


# ---------------------------------------------------------------- HTTP


def _http(cfg: HubConfig, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"http://{cfg.host}:{cfg.port}{path}"
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method, headers={"Content-Type": "application/json"}
    )
    try:
        with _OPENER.open(req, timeout=600) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw)
            msg = payload.get("error") or raw
        except json.JSONDecodeError:
            msg = raw[:400]
        raise HubError(msg, status=exc.code) from exc
    except (urllib.error.URLError, OSError) as exc:
        raise HubError(
            f"连不上服务 {url}：{exc}。先跑 `python -m modelhub serve`", status=503
        ) from exc


def _service_up(cfg: HubConfig) -> bool:
    try:
        _http(cfg, "GET", "/health")
        return True
    except HubError:
        return False


# ---------------------------------------------------------------- 子命令


def cmd_serve(cfg: HubConfig, args: argparse.Namespace) -> int:
    from .http_api import make_server

    host = args.host or cfg.host
    port = args.port or cfg.port
    hub = Hub(cfg)
    try:
        srv = make_server(hub, host, port)
    except OSError as exc:
        _p(f"端口 {port} 起不来：{exc}")
        _p("换一个：--port 8791，或先停掉占端口的进程")
        return 2
    hub.start()
    _p(f"modelhub 在 http://{host}:{port}")
    _p(f"  控制台   http://{host}:{port}/console")
    _p(f"  单卡     GPU {cfg.gpu.index}（整份服务只用这张卡）")
    _p(f"  配置     {args.config or DEFAULT_CONFIG_PATH}")
    _p(f"  运行目录 {cfg.runtime_dir}")
    _p("  能力     " + "、".join(f"{CAPABILITY_TITLES[k]}" for k in CAPABILITY_KEYS))
    _p("Ctrl+C 退出（会卸载本服务拉起的模型）")
    try:
        srv.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        _p("\n收到中断，正在收尾…")
    finally:
        srv.server_close()
        hub.close()
    return 0


def cmd_preflight(cfg: HubConfig, args: argparse.Namespace) -> int:
    caps = [c for c in (args.capabilities or "").split(",") if c] or None
    if _service_up(cfg):
        data = _http(cfg, "POST", "/v1/preflight", {"capabilities": caps})
    else:
        hub = Hub(cfg)
        data = hub.preflight(caps)
    if args.json:
        _p(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        _print_pre(data)
    return 0 if data.get("ok") else 1


def cmd_status(cfg: HubConfig, args: argparse.Namespace) -> int:
    if _service_up(cfg):
        data = _http(cfg, "GET", "/v1/status")
    else:
        hub = Hub(cfg)
        data = hub.status()
    if args.json:
        _p(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        _print_status(data)
    return 0


def cmd_models(cfg: HubConfig, args: argparse.Namespace) -> int:
    if _service_up(cfg):
        data = _http(cfg, "GET", "/v1/models")
    else:
        hub = Hub(cfg)
        data = {"models": hub.models()}
    if args.json:
        _p(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        _print_models(data)
    return 0


def cmd_env(cfg: HubConfig, args: argparse.Namespace) -> int:
    if _service_up(cfg):
        data = _http(cfg, "GET", "/v1/env")
    else:
        hub = Hub(cfg)
        data = hub.env()
    _p(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


def cmd_load(cfg: HubConfig, args: argparse.Namespace) -> int:
    if not _service_up(cfg):
        _p("服务没起：先 `python -m modelhub serve`（加载会占显存，必须由服务统一管）")
        return 2
    data = _http(cfg, "POST", f"/v1/models/{args.model}/load", {})
    _p(f"{args.model} 已加载，用时 {data.get('ms')} ms")
    slot = data.get("slot") or {}
    if slot.get("realVramMb"):
        _p(f"实测显存 {_mb(slot['realVramMb'])}（pid {(slot.get('runtime') or {}).get('pid')}）")
    return 0


def cmd_unload(cfg: HubConfig, args: argparse.Namespace) -> int:
    if not _service_up(cfg):
        _p("服务没起：没有东西可卸")
        return 0
    body = {"all": True, "force": args.force} if args.all or not args.model else {
        "model": args.model,
        "force": args.force,
    }
    data = _http(cfg, "POST", "/v1/unload", body)
    if args.all or not args.model:
        for row in data.get("unloaded") or []:
            _p(f"已卸载 {row.get('model')}")
        for row in data.get("skipped") or []:
            _p(f"没卸 {row.get('model')}：{row.get('error')}")
    else:
        _p(f"{args.model} {'已卸载' if data.get('unloaded') else '本来就没加载'}")
    return 0


def cmd_run(cfg: HubConfig, args: argparse.Namespace) -> int:
    if not _service_up(cfg):
        _p("服务没起：先 `python -m modelhub serve`")
        return 2
    try:
        payload = json.loads(args.input)
    except json.JSONDecodeError as exc:
        _p(f"--input 不是合法 JSON：{exc}")
        return 2
    data = _http(cfg, "POST", "/v1/run", {"capability": args.capability, "input": payload})
    if isinstance(data.get("data"), str) and len(data["data"]) > 240:
        data["data"] = data["data"][:240] + "…（base64 截断）"
    _p(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


def cmd_config(cfg: HubConfig, args: argparse.Namespace) -> int:
    if args.write:
        path = write_example(args.write, cfg)
        _p(f"已写入 {path}")
    _p(json.dumps(cfg.to_dict(), ensure_ascii=False, indent=2))
    return 0


# ---------------------------------------------------------------- 入口


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--config", help=f"配置文件（默认 {DEFAULT_CONFIG_PATH}）")
    common.add_argument("--gpu", type=int, help="只用这一张卡（覆盖配置里的 gpu.index）")
    common.add_argument("--port", type=int, help="本服务端口（默认 8790）")
    common.add_argument("--runtime", help="运行目录（日志、临时服务配置）")
    common.add_argument("--json", action="store_true", help="输出原始 JSON")

    ap = argparse.ArgumentParser(
        prog="modelhub",
        description="单卡模型前置服务：生图 / 图片编辑 / 语音设计 / 语音合成 / 文本生成",
    )
    sub = ap.add_subparsers(dest="cmd")

    p = sub.add_parser("serve", parents=[common], help="起服务（含控制台）")
    p.add_argument("--host", default=None)
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("preflight", parents=[common], help="运行前体检（不加载模型）")
    p.add_argument("--capabilities", help="只查这几类，逗号分隔")
    p.set_defaults(func=cmd_preflight)

    p = sub.add_parser("status", parents=[common], help="显存账本与模型状态")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("models", parents=[common], help="列出能力与模型")
    p.set_defaults(func=cmd_models)

    p = sub.add_parser("env", parents=[common], help="环境信息")
    p.set_defaults(func=cmd_env)

    p = sub.add_parser("load", parents=[common], help="加载一个模型（需服务在跑）")
    p.add_argument("model")
    p.set_defaults(func=cmd_load)

    p = sub.add_parser("unload", parents=[common], help="卸载一个模型 / 全部")
    p.add_argument("model", nargs="?")
    p.add_argument("--all", action="store_true")
    p.add_argument("--force", action="store_true", help="有人正在用也卸")
    p.set_defaults(func=cmd_unload)

    p = sub.add_parser("run", parents=[common], help="调一次能力（需服务在跑）")
    p.add_argument("capability", help=" / ".join(CAPABILITY_KEYS))
    p.add_argument("--input", default="{}", help="JSON 参数")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("config", parents=[common], help="看/导出配置")
    p.add_argument("--write", nargs="?", const=str(DEFAULT_CONFIG_PATH),
                   help="把当前默认配置写成文件")
    p.set_defaults(func=cmd_config)
    return ap


def main(argv: list[str] | None = None) -> int:
    ap = build_parser()
    args = ap.parse_args(argv)
    if not getattr(args, "func", None):
        ap.print_help()
        return 0
    overrides: dict[str, Any] = {}
    if args.gpu is not None:
        overrides["gpu"] = {"index": args.gpu}
    try:
        cfg = load_config(args.config, overrides=overrides, runtime_dir=args.runtime)
        if args.port:
            import dataclasses

            cfg = dataclasses.replace(cfg, port=args.port)
        return int(args.func(cfg, args))
    except HubError as exc:
        _p(f"失败：{exc}")
        return 1
    except DriverError as exc:
        _p(f"失败：{exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
