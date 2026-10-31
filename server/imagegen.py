"""关键帧出图：把本地 ComfyUI 的文生图工作流当成本地生图 API。

为什么不是「再写一个生图客户端」：
    剧本台里**已经有**一条生图链路（OpenAI 兼容 /images/generations、/images/edits），
    关键帧的提示词拼装（keyframePrompt）、落库（attachBeatKeyframe）、
    图生图底图都是现成的。这里只补一件事：**同一个 prompt，换成用本地
    ComfyUI 的工作流出图**。所以后端也只做「跑一份工作流、还一张图」。

为什么不要求用户先导出「API 格式」：
    ComfyUI 的保存按钮默认存的是 UI 格式（nodes + links），而 /prompt 只吃
    API 格式（节点 id → class_type + inputs）。让用户每次改完工作流都记得
    另存一份，迟早会拿到旧图。这里用 /object_info 把 UI 格式现转一次，
    转不动（动态节点 / 找不到定义）才让人去导 API 格式 —— 报错里会说清。

三个动作的边界：
    list_workflows  —— 列 ComfyUI 工作流目录里能跑的东西（顺带标出像文生图的）
    build_prompt    —— 把工作流转成 API 图，并注入提示词 / 尺寸 / 种子 / 步数
    run             —— 提交、等 history、取回图片字节

注入只改**必要的几个值**，其余节点原样不动：这份工作流的模型、LoRA、
采样器、VAE 都是用户自己调的，重排一遍只会把出图风格弄跑。
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

# 本机设了 HTTPS_PROXY，urllib 默认会把 127.0.0.1 也送去代理 → 502。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# 只有界面意义、/prompt 不认识的节点。转换时必须跳过，否则 ComfyUI 直接
# 回 node_errors: unknown node type。
UI_ONLY_TYPES = {"Note", "MarkdownNote", "Reroute", "PrimitiveNode", "Comment"}

# 能承载提示词文本的节点。判据放在 _is_text_node 里（看输入里有 text/prompt + clip），
# 这里只列常见类名，用于在多个候选里优先挑。
#
# TextEncodeQwenImage21 是 Qwen-Image-2.1 专用的编码器：它一个节点同时产出
# 正向、负向、空 latent 三路，负向是**同一个节点上的第二个输入**（negative_prompt），
# 不是另一个节点 —— 所以下面注入逻辑要按"输入名"找，不能按"节点"找。
TEXT_CLASSES = (
    "CLIPTextEncode",
    "CLIPTextEncodeSDXL",
    "CLIPTextEncodeFlux",
    "T5TextEncode",
    "TextEncodeQwenImageEdit",
    "TextEncodeQwenImageEditPlus",
    "TextEncodeQwenImage21",
)

#: 提示词输入名，按优先级排。有的编码器叫 text，Qwen-Image-2.1 叫 prompt。
_PROMPT_KEYS = ("text", "prompt")
#: 负向输入名。Qwen-Image-2.1 把负向做成同一节点上的另一个字符串输入。
_NEGATIVE_KEYS = ("negative_prompt", "negative")

#: 参考图输入的公共前缀。Qwen-Image-2.1 的 images 是 Autogrow，展开成
#: images.image_1 / images.image_2 …（ComfyUI 的 _expand_schema_for_dynamic）。
_REF_PREFIX = "images."

#: 一份工作流最多挂多少张参考图（ComfyUI 那边上限是 16）
MAX_REFS = 8

#: 空闲多久丢掉节点定义缓存（滑动计时：用过就续期）
_OBJECT_INFO_TTL = 300.0
#: 最多留几份。一份解析后 14.6 MiB（2045 个节点），留多了纯占内存
_OBJECT_INFO_MAX = 2
_object_info_cache: dict[str, tuple[float, dict]] = {}


class ImageGenError(Exception):
    """直接给用户看的人话错误。"""


# ---------------------------------------------------------------- HTTP 小工具


def _get_json(url: str, timeout: float) -> Any:
    req = urllib.request.Request(url, method="GET")
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read()[:300].decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            detail = ""
        raise ImageGenError(f"ComfyUI 返回 HTTP {exc.code}：{detail or '（无内容）'}") from exc
    except urllib.error.URLError as exc:
        raise ImageGenError(f"连不上 ComfyUI（{url}）：{exc.reason}") from exc
    except (json.JSONDecodeError, ValueError) as exc:
        raise ImageGenError(f"ComfyUI 返回的不是 JSON（{url}）：{exc}") from exc


def _post_json(url: str, payload: dict, timeout: float) -> tuple[int, Any]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            body = resp.read()
            try:
                return resp.status, json.loads(body.decode("utf-8", "replace"))
            except (json.JSONDecodeError, ValueError):
                return resp.status, body
    except urllib.error.HTTPError as exc:
        body = b""
        try:
            body = exc.read()
        except Exception:  # noqa: BLE001
            body = b""
        try:
            return exc.code, json.loads(body.decode("utf-8", "replace"))
        except (json.JSONDecodeError, ValueError):
            return exc.code, body[:400].decode("utf-8", "replace")
    except urllib.error.URLError as exc:
        raise ImageGenError(f"连不上 ComfyUI（{url}）：{exc.reason}") from exc


def _norm_base(raw: str) -> str:
    base = (raw or "http://127.0.0.1:8188").strip().rstrip("/")
    if not base.lower().startswith(("http://", "https://")):
        base = "http://" + base
    return base


def _client_id() -> str:
    return "scriptstage-" + hashlib.sha1(str(time.time()).encode()).hexdigest()[:10]


# ---------------------------------------------------------------- 工作流目录


def workflows_dir(root: str) -> Path:
    """ComfyUI 的工作流目录。root 是 ComfyUI 安装目录（含 user/ 的那层）。"""
    base = Path((root or "").strip())
    if not base:
        raise ImageGenError("没找到 ComfyUI 安装目录：先在运行设置里填好 ComfyUI 路径")
    return base / "user" / "default" / "workflows"


def list_workflows(root: str) -> dict:
    """列出工作流文件。读不动 JSON 的也列出来 —— 让人知道它坏了，而不是凭空消失。"""
    folder = workflows_dir(root)
    if not folder.is_dir():
        return {"dir": str(folder), "exists": False, "workflows": []}
    items: list[dict] = []
    for path in sorted(folder.rglob("*.json")):
        rel = path.relative_to(folder).as_posix()
        # `.index.json` 之类是 ComfyUI 自己的索引/缓存，不是能跑的工作流
        if any(part.startswith(".") for part in Path(rel).parts):
            continue
        name = rel[:-5] if rel.lower().endswith(".json") else rel
        entry: dict[str, Any] = {
            "name": name,
            "bytes": path.stat().st_size,
            "mtime": int(path.stat().st_mtime * 1000),
        }
        try:
            data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        except Exception as exc:  # noqa: BLE001
            entry.update({"format": "broken", "error": f"{type(exc).__name__}: {exc}"})
            items.append(entry)
            continue
        fmt, graph = _as_graph(data)
        entry["format"] = fmt
        classes: set[str] = set()
        if fmt == "api":
            classes = {str(n.get("class_type") or "") for n in graph.values()}
            entry["nodes"] = len(graph)
        elif fmt == "ui":
            nodes = [n for n in (data.get("nodes") or []) if isinstance(n, dict)]
            classes = {str(n.get("type") or "") for n in nodes}
            entry["nodes"] = len([n for n in nodes if str(n.get("type") or "") not in UI_ONLY_TYPES])
        if classes:
            entry["t2i"] = any(c.startswith("KSampler") for c in classes) and any(
                "Latent" in c for c in classes
            )
            found = sorted(
                filter(
                    None,
                    (
                        str((n.get("inputs") or {}).get("ckpt_name") or "")
                        or str((n.get("inputs") or {}).get("unet_name") or "")
                        for n in graph.values()
                    ),
                )
            )
            if not found and fmt == "ui":
                # UI 格式没有 inputs 名，模型名在 widgets_values 的第一个位置
                for n in data.get("nodes") or []:
                    if str(n.get("type") or "") in ("CheckpointLoaderSimple", "UNETLoader"):
                        vals = n.get("widgets_values") or []
                        if vals and isinstance(vals[0], str):
                            found.append(vals[0])
            entry["checkpoints"] = found[:3]
            # 能不能吃参考图：能的话前端就摆出「参考图」那一排
            if fmt == "api":
                entry["refs"] = max(
                    (ref_slots(n) for n in graph.values() if _is_text_node(n)), default=0
                )
            else:
                entry["refs"] = (
                    MAX_REFS
                    if classes
                    & {
                        "TextEncodeQwenImage21",
                        "TextEncodeQwenImageEdit",
                        "TextEncodeQwenImageEditPlus",
                    }
                    else 0
                )
            entry["edit"] = entry["refs"] > 0
        items.append(entry)
    items.sort(key=lambda x: (not x.get("t2i"), x["name"]))
    return {"dir": str(folder), "exists": True, "workflows": items}


def load_workflow(root: str, name: str) -> Any:
    """按名字读工作流。只认 workflows 目录内的文件，挡 ../ 穿越。"""
    folder = workflows_dir(root)
    raw = (name or "").strip()
    if not raw:
        raise ImageGenError("没选工作流")
    rel = raw if raw.lower().endswith(".json") else raw + ".json"
    target = (folder / rel).resolve()
    try:
        target.relative_to(folder.resolve())
    except ValueError as exc:
        raise ImageGenError("工作流只能从 ComfyUI 的 workflows 目录里选") from exc
    if not target.is_file():
        raise ImageGenError(f"工作流文件不在了：{target}")
    try:
        return json.loads(target.read_text(encoding="utf-8", errors="replace"))
    except Exception as exc:  # noqa: BLE001
        raise ImageGenError(f"工作流不是合法 JSON：{exc}") from exc


# ---------------------------------------------------------------- UI → API 转换


def _as_graph(data: Any) -> tuple[str, dict]:
    """返回 (格式, API 图)。API 格式直接用；UI 格式这里只做识别，转换要 object_info。"""
    if isinstance(data, dict) and data and all(
        isinstance(v, dict) and "class_type" in v for v in data.values()
    ):
        return "api", data
    if isinstance(data, dict) and isinstance(data.get("nodes"), list):
        return "ui", {}
    if isinstance(data, dict) and isinstance(data.get("prompt"), dict):
        # 有些人存的是 {"prompt": {...}, "client_id": ...} 的提交体
        return "api", data["prompt"]
    return "unknown", {}


def object_info(base: str, force: bool = False) -> dict:
    """ComfyUI 的节点定义。转换 UI 格式要靠它把 widgets_values 对回输入名。

    缓存：一份工作流转换要读几百个节点定义，每次重拉是好几百 KB（这台机器上
    `/object_info` 实测 3.93 MiB / 2045 个节点）。装了新节点 / 重启 ComfyUI
    之后下拉里点「刷新」会带 force。

    **TTL 是滑动的，而且会淘汰**：老实现只管「多久重拉」，从不释放 ——
    解析后这份字典实测常驻 14.6 MiB，换过 base 的进程还会一份一份往上叠。
    现在按「最后一次用到」计时，空闲超过 `_OBJECT_INFO_TTL` 就丢，最多留
    `_OBJECT_INFO_MAX` 份。
    """
    key = _norm_base(base)
    now = time.time()
    _prune_object_info(now)
    hit = _object_info_cache.get(key)
    if hit and not force and now - hit[0] < _OBJECT_INFO_TTL:
        _object_info_cache[key] = (now, hit[1])       # 滑动：用过就续期
        return hit[1]
    info = _get_json(key + "/object_info", 60.0)
    if not isinstance(info, dict):
        raise ImageGenError("ComfyUI 的 /object_info 返回格式不对")
    _object_info_cache[key] = (now, info)
    _prune_object_info(now)
    return info


def _prune_object_info(now: float | None = None) -> int:
    """丢掉空闲太久的、以及超出上限的最旧几份。返回丢了几份。"""
    now = time.time() if now is None else now
    gone = 0
    for k, (at, _info) in list(_object_info_cache.items()):
        if now - at >= _OBJECT_INFO_TTL:
            del _object_info_cache[k]
            gone += 1
    extra = len(_object_info_cache) - _OBJECT_INFO_MAX
    if extra > 0:
        for k, _v in sorted(_object_info_cache.items(), key=lambda kv: kv[1][0])[:extra]:
            del _object_info_cache[k]
            gone += 1
    return gone


def ui_to_api(data: dict, info: dict) -> tuple[dict, list[str]]:
    """把 UI 格式（nodes + links）转成 /prompt 吃的 API 格式。

    做法就是 ComfyUI 前端提交时那一步的简化版：
      1) 有连线的输入 → [上游节点 id, 上游输出槽]
      2) 其余输入按 object_info 里声明的顺序依次吃 widgets_values
      3) Note / Reroute / PrimitiveNode 不提交；Reroute 顺藤摸瓜接上去
    """
    nodes = data.get("nodes") or []
    links_raw = data.get("links") or []
    notes: list[str] = []

    node_by_id: dict[int, dict] = {}
    for node in nodes:
        try:
            node_by_id[int(node.get("id"))] = node
        except (TypeError, ValueError):
            continue

    links: dict[int, list] = {}
    for link in links_raw:
        if isinstance(link, list) and len(link) >= 5:
            links[int(link[0])] = link

    def origin_of(link_id: int | None, depth: int = 0) -> Any:
        """顺着 link 找上游；遇到 Reroute 继续往前，遇到 PrimitiveNode 取字面值。"""
        if link_id is None or depth > 24:
            return None
        link = links.get(int(link_id))
        if not link:
            return None
        origin_id, origin_slot = int(link[1]), int(link[2])
        onode = node_by_id.get(origin_id)
        if onode is None:
            return None
        ctype = str(onode.get("type") or "")
        if ctype == "Reroute":
            for inp in onode.get("inputs") or []:
                if inp.get("link") is not None:
                    return origin_of(inp["link"], depth + 1)
            return None
        if ctype == "PrimitiveNode":
            vals = onode.get("widgets_values") or []
            return _scalar(vals[0]) if vals else None
        return [str(origin_id), origin_slot]

    graph: dict[str, dict] = {}
    for node in nodes:
        ctype = str(node.get("type") or "")
        if not ctype or ctype in UI_ONLY_TYPES:
            continue
        inputs: dict[str, Any] = {}

        for inp in node.get("inputs") or []:
            name = inp.get("name")
            if not name or inp.get("link") is None:
                continue
            value = origin_of(inp["link"])
            if value is not None:
                inputs[str(name)] = value

        spec = (info.get(ctype) or {}).get("input") or {}
        order = list((spec.get("required") or {}).items()) + list((spec.get("optional") or {}).items())
        widgets = node.get("widgets_values")
        if isinstance(widgets, dict):
            for k, v in widgets.items():
                if str(k) not in inputs:
                    inputs[str(k)] = _scalar(v)
        elif isinstance(widgets, list):
            idx = 0
            for name, is_control in _widget_plan(order):
                if idx >= len(widgets):
                    break
                if is_control or str(name) in inputs:
                    # 骰子按钮那种「控制值」要吃掉一个位置，但它不是节点输入
                    idx += 1
                    continue
                inputs[str(name)] = _scalar(widgets[idx])
                idx += 1
        graph[str(int(node.get("id")))] = {"class_type": ctype, "inputs": inputs}

    if not graph:
        raise ImageGenError("这份工作流里没有可提交的节点")
    if any(n.get("class_type") == "Note" for n in graph.values()):
        notes.append("工作流里有 Note 节点，已跳过")
    return graph, notes


def _scalar(value: Any) -> Any:
    """新版前端的 widget 值可能是 {value: ..} / {content: ..}，拆回字面值。"""
    if isinstance(value, dict):
        for key in ("value", "content", "text"):
            if key in value:
                return value[key]
        return value
    return value


def _is_widget(decl: Any) -> bool:
    """object_info 里这个输入是不是「前端画成控件」的那种（而不是连线口）。"""
    if not isinstance(decl, (list, tuple)) or not decl:
        return False
    head = decl[0]
    if isinstance(head, (list, tuple)):
        return True  # COMBO：候选列表
    return isinstance(head, str) and head.upper() in ("INT", "FLOAT", "STRING", "BOOLEAN")


def _widget_plan(order: list[tuple[str, Any]]) -> list[tuple[str, bool]]:
    """按 object_info 的声明顺序排出「widgets_values 每一位对应什么」。

    坑在 seed 上：前端会在种子后面多画一颗骰子（control_after_generate），
    它占 widgets_values 的一个位置，却不是节点输入。有的版本把它列成独立
    条目，有的只在 seed 的选项里写 `control_after_generate: true` —— 两种都认，
    否则 KSampler 的 steps 会吃到字符串 'fixed'，整份参数直接错位。
    """
    names = {str(n) for n, _ in order}
    plan: list[tuple[str, bool]] = []
    for name, decl in order:
        if not _is_widget(decl):
            continue
        plan.append((str(name), False))
        opts = decl[1] if isinstance(decl, (list, tuple)) and len(decl) > 1 else None
        if (
            isinstance(opts, dict)
            and opts.get("control_after_generate")
            and "control_after_generate" not in names
        ):
            plan.append(("control_after_generate", True))
    return plan


# ---------------------------------------------------------------- 注入


def _key_of(node: dict, keys: tuple[str, ...]) -> str | None:
    """节点上第一个存在的这类输入名（提示词 / 负向）。"""
    inputs = node.get("inputs") or {}
    for key in keys:
        if key in inputs:
            return key
    return None


def _prompt_key(node: dict) -> str | None:
    return _key_of(node, _PROMPT_KEYS)


def _negative_key(node: dict) -> str | None:
    return _key_of(node, _NEGATIVE_KEYS)


def _ref_keys(node: dict) -> list[str]:
    """节点上所有已连的参考图输入名（images.image_1 …），按序号排。"""
    inputs = node.get("inputs") or {}
    keys = [k for k in inputs if k.startswith(_REF_PREFIX)]
    return sorted(keys, key=lambda k: (len(k), k))


def _is_text_node(node: dict) -> bool:
    inputs = node.get("inputs") or {}
    cls = str(node.get("class_type") or "")
    if cls in TEXT_CLASSES:
        return True
    # 其它编码器：既吃 clip 又吃文本，就按提示词节点处理
    if _prompt_key(node) is None:
        return False
    return any(k in inputs for k in ("clip", "clip_l", "clip_g"))


def _find_sampler(graph: dict) -> str | None:
    """挑主采样器。KSampler 优先；SamplerCustom 之类退而求其次。"""
    ks = [nid for nid, n in graph.items() if str(n.get("class_type") or "").startswith("KSampler")]
    if ks:
        return ks[0]
    for nid, n in graph.items():
        inputs = n.get("inputs") or {}
        if "positive" in inputs and "negative" in inputs:
            return nid
    return None


def _text_node_behind(graph: dict, ref: Any) -> str | None:
    """顺着 conditioning 往上找到真正的提示词节点（可能隔着一个 ZeroOut）。"""
    seen: set[str] = set()
    nid = ref[0] if isinstance(ref, (list, tuple)) and ref else None
    while nid is not None and str(nid) not in seen:
        seen.add(str(nid))
        node = graph.get(str(nid))
        if not node:
            return None
        if _is_text_node(node):
            return str(nid)
        inputs = node.get("inputs") or {}
        up = inputs.get("conditioning") or inputs.get("positive") or inputs.get("text")
        if not isinstance(up, (list, tuple)) or not up:
            return None
        nid = up[0]
    return None


def _max_node_id(graph: dict) -> int:
    ids = []
    for nid in graph:
        try:
            ids.append(int(nid))
        except (TypeError, ValueError):
            continue
    return max(ids) if ids else 0


def _empty_latent_behind(graph: dict, sampler: str | None) -> str | None:
    """采样器的 latent 来自哪个空 latent 节点 —— 改尺寸只改它，别的不动。"""
    if sampler:
        inputs = graph[sampler].get("inputs") or {}
        up = inputs.get("latent_image")
        if isinstance(up, (list, tuple)) and up:
            node = graph.get(str(up[0]))
            if node and _has_size(node):
                return str(up[0])
    sized = [nid for nid, n in graph.items() if _has_size(n)]
    return sized[0] if sized else None


def _has_size(node: dict) -> bool:
    inputs = node.get("inputs") or {}
    return "width" in inputs and "height" in inputs


LATENT_STEP = 16
DEFAULT_W, DEFAULT_H = 1280, 720
"""统一出图尺寸：16:9、921,600 像素。

比例可以换（方图 / 竖屏 / 超宽都行），但像素量级锁在这一个数上 ——
2 步采样真正吃时间的是 token 数（≈ 像素数 / 16²），跟宽高比无关。
前端 `src/domain/imageSize.ts` 里是同一份预算（PIXEL_BUDGET）。
"""
"""Qwen-Image-2.1 的 latent 是 1/16 下采样、64 通道。

`EmptyLatentImage` 交出来的是 1/8 的 4 通道，靠 `downscale_ratio_spacial=8` 让
`fix_empty_latent_channels` 再缩一半补到 64 通道（comfy/sample.py:53-56）。
这一步用的是 `round()`，所以**宽高不是 16 的倍数就会被悄悄改小**：
    要 1032x584 -> latent 36x64 -> 实得 1024x576
    要 1000x562 -> latent 35x62 -> 实得  992x560
调用方以为自己拿到了对数，实际没有。所以注入前先对齐，别让 ComfyUI 替我们决定。
"""


def _align_latent_side(value: int | float | str) -> int:
    """把宽或高对齐到 latent 步长的整数倍（最小 16）。

    舍入方向必须写死成「.5 向上」，别用内置 `round()` —— Python 的 round 是
    银行家舍入（round(64.5) == 64），JS 的 Math.round 是四舍五入向上（65）。
    前端 `imageSize.ts` 的 alignSide 用的是后者，两边口径不一样就会出现
    "界面显示 1040、日志里 1024"这种对不上的账。
    """
    try:
        v = int(float(value))
    except (TypeError, ValueError):
        return LATENT_STEP
    if v < LATENT_STEP:
        return LATENT_STEP
    return int(v / LATENT_STEP + 0.5) * LATENT_STEP


def apply_prompt(
    graph: dict,
    *,
    prompt: str,
    negative: str | None = None,
    width: int | None = None,
    height: int | None = None,
    seed: int | None = None,
    steps: int | None = None,
    cfg: float | None = None,
    refs: list[str] | None = None,
) -> dict:
    """把用户的值注进工作流，返回注入报告（改了哪些节点）。

    只改能确定的地方；找不到就明确说没改，而不是瞎猜一个节点塞进去。
    """
    report: dict[str, Any] = {
        "notes": [],
        "positive": None,
        "negative": None,
        "size": None,
        "seed": None,
        "steps": None,
        "refs": None,
    }
    sampler = _find_sampler(graph)
    report["sampler"] = sampler

    pos_node = neg_node = None
    if sampler:
        s_in = graph[sampler].get("inputs") or {}
        pos_node = _text_node_behind(graph, s_in.get("positive"))
        neg_node = _text_node_behind(graph, s_in.get("negative"))

    if pos_node is None:
        candidates = [nid for nid, n in graph.items() if _is_text_node(n)]
        pos_node = candidates[0] if candidates else None
        if pos_node and sampler:
            report["notes"].append("没从采样器追到提示词节点，改用了工作流里的第一个文本编码器")

    if pos_node is None:
        raise ImageGenError("这份工作流里找不到提示词节点（CLIPTextEncode）：确认它是文生图工作流")
    pos_key = _prompt_key(graph[pos_node])
    if pos_key is None:
        raise ImageGenError(
            f"提示词节点 {graph[pos_node].get('class_type')} 上没有 text / prompt 输入，注入不了"
        )
    graph[pos_node]["inputs"][pos_key] = prompt
    report["positive"] = pos_node

    # 负向：三条路，按可靠性排
    #   ① 同一个节点上就有 negative_prompt（Qwen-Image-2.1）：直接写它，
    #      采样器的 negative 本来就是这一节点的第二路输出，改完即生效；
    #   ② 采样器的 negative 指向另一个文本节点：就地改它；
    #   ③ 负向被 ConditioningZeroOut 零化 / 与正向共用同一个 text 输入：
    #      新建一个编码器接上去，原节点一个字节都不动。
    want_neg = (negative or "").strip()
    if want_neg and sampler:
        s_in = graph[sampler]["inputs"]
        own_neg_key = _negative_key(graph[pos_node])
        if own_neg_key and (neg_node in (None, pos_node)):
            graph[pos_node]["inputs"][own_neg_key] = want_neg
            report["negative"] = pos_node
            # 负向输出是同一节点的另一路；采样器若没连上（比如被 ZeroOut 了），
            # 就按输出序号猜不对，只能记一笔让人知道没生效
            neg_ref = s_in.get("negative")
            if not (isinstance(neg_ref, (list, tuple)) and str(neg_ref[0]) == str(pos_node)):
                report["notes"].append(
                    "负向写进了编码器的 negative_prompt，但采样器的 negative 没接在这路输出上"
                )
        elif neg_node and neg_node != pos_node:
            neg_key = _negative_key(graph[neg_node])
            if neg_key:
                graph[neg_node]["inputs"][neg_key] = want_neg
                report["negative"] = neg_node
            else:
                graph[neg_node]["inputs"]["text"] = want_neg
                report["negative"] = neg_node
        else:
            new_id = str(_max_node_id(graph) + 1)
            clip_ref = graph[pos_node]["inputs"].get("clip")
            if clip_ref is None:
                report["notes"].append("找不到 CLIP 输入，负向没接")
            else:
                graph[new_id] = {
                    "class_type": graph[pos_node].get("class_type") or "CLIPTextEncode",
                    "inputs": {"clip": clip_ref, "text": want_neg},
                }
                s_in["negative"] = [new_id, 0]
                report["negative"] = new_id
                if neg_node and neg_node == pos_node:
                    report["notes"].append("原本正负向共用同一个文本节点，已为负向单独接了一个")

    size_node = _empty_latent_behind(graph, sampler)
    if size_node:
        s_in = graph[size_node]["inputs"]
        raw_w = int(float(s_in.get("width") or DEFAULT_W))
        raw_h = int(float(s_in.get("height") or DEFAULT_H))
        want_w = _align_latent_side(width) if width else _align_latent_side(raw_w)
        want_h = _align_latent_side(height) if height else _align_latent_side(raw_h)
        s_in["width"] = want_w
        s_in["height"] = want_h
        s_in["batch_size"] = int(s_in.get("batch_size") or 1)
        report["size"] = size_node
        # 无论用不用得上，都把真正会出多大写出来：调用方不必去猜 EmptyLatentImage 的取整
        report["size_px"] = [want_w, want_h]
        if width and want_w != int(float(width)):
            report["notes"].append(
                f"宽度 {int(float(width))} 已对齐到 {want_w}：latent 1/16 下采样，非 16 倍数会被 EmptyLatentImage 静默改掉"
            )
        if height and want_h != int(float(height)):
            report["notes"].append(
                f"高度 {int(float(height))} 已对齐到 {want_h}：latent 1/16 下采样，非 16 倍数会被 EmptyLatentImage 静默改掉"
            )
        if not width and raw_w != want_w:
            report["notes"].append(f"工作流原宽 {raw_w} 不是 16 的倍数，已对齐到 {want_w}")
        if not height and raw_h != want_h:
            report["notes"].append(f"工作流原高 {raw_h} 不是 16 的倍数，已对齐到 {want_h}")
    elif width or height:
        report["notes"].append("工作流里没有空 latent 节点，尺寸没改")

    if sampler:
        s_in = graph[sampler]["inputs"]
        if seed is not None:
            if "seed" in s_in:
                s_in["seed"] = int(seed)
                report["seed"] = sampler
            elif "noise_seed" in s_in:
                s_in["noise_seed"] = int(seed)
                report["seed"] = sampler
            else:
                noise = s_in.get("noise")
                if isinstance(noise, (list, tuple)) and noise:
                    node = graph.get(str(noise[0]))
                    if node and ("noise_seed" in (node.get("inputs") or {})):
                        node["inputs"]["noise_seed"] = int(seed)
                        report["seed"] = str(noise[0])
        if steps is not None and "steps" in s_in:
            s_in["steps"] = int(steps)
            report["steps"] = sampler
        if cfg is not None and "cfg" in s_in:
            s_in["cfg"] = float(cfg)

    if refs:
        report["refs"] = wire_refs(graph, pos_node, refs, report["notes"])

    return report


def ref_slots(node: dict) -> int:
    """这个编码器能挂几张参考图（没有 images.* 输入就是 0）。"""
    inputs = node.get("inputs") or {}
    if any(k.startswith(_REF_PREFIX) for k in inputs):
        return MAX_REFS
    # 还没连过任何参考图的 Autogrow 节点在 API 图里不会出现 images.* 键，
    # 只能按类名认：这些编码器天生吃参考图。
    if str(node.get("class_type") or "") in (
        "TextEncodeQwenImage21",
        "TextEncodeQwenImageEdit",
        "TextEncodeQwenImageEditPlus",
    ):
        return MAX_REFS
    return 0


def wire_refs(graph: dict, enc: str, refs: list[str], notes: list[str] | None = None) -> dict:
    """把参考图挂到编码器上：每张图一个 LoadImage，接到 images.image_1..N。

    为什么图不能在文件里写死：ComfyUI 校验**整份图**（不只是要执行的节点），
    LoadImage 指向一个不存在的文件名就整份 400。所以图只能在提交前按当次
    的实际文件生成。

    为什么尽量复用旧节点：同一份图可能被注入多次（单张 → 批量 → 再单张），
    每次都新建就会在图上堆一串没人用的 LoadImage —— 它们照样参与校验，
    等于把自己坑回去。能复用就复用，多出来的顺手删掉。
    """
    notes = notes if notes is not None else []
    if not enc or enc not in graph:
        notes.append("找不到编码器，参考图没挂")
        return {"count": 0, "nodes": []}
    inputs = graph[enc]["inputs"]
    old_ids = [
        str(inputs[key][0])
        for key in _ref_keys(graph[enc])
        if isinstance(inputs.get(key), (list, tuple)) and inputs[key]
    ]
    for key in _ref_keys(graph[enc]):
        inputs.pop(key, None)

    take = [str(r).strip() for r in (refs or []) if str(r or "").strip()][:MAX_REFS]
    if not take:
        _drop_orphan_loaders(graph, old_ids)
        return {"count": 0, "nodes": []}
    if not ref_slots(graph[enc]):
        _drop_orphan_loaders(graph, old_ids)
        notes.append("这份工作流的编码器不吃参考图，图没挂上")
        return {"count": 0, "nodes": []}

    used: list[str] = []
    next_id = _max_node_id(graph) + 1
    for i, name in enumerate(take, 1):
        if i <= len(old_ids) and old_ids[i - 1] in graph:
            nid = old_ids[i - 1]
            graph[nid]["inputs"]["image"] = name
        else:
            nid = str(next_id)
            next_id += 1
            graph[nid] = {"class_type": "LoadImage", "inputs": {"image": name}}
        inputs[f"{_REF_PREFIX}image_{i}"] = [nid, 0]
        used.append(nid)
    _drop_orphan_loaders(graph, [nid for nid in old_ids if nid not in used])
    if len(refs) > len(take):
        notes.append(f"参考图最多 {MAX_REFS} 张，多出来的 {len(refs) - len(take)} 张没用上")
    return {"count": len(used), "nodes": used}


def _drop_orphan_loaders(graph: dict, ids: list[str]) -> None:
    """删掉没人引用的 LoadImage —— 留着的悬空节点照样会被 ComfyUI 校验。"""
    if not ids:
        return
    alive = {
        str(value[0])
        for node in graph.values()
        for value in (node.get("inputs") or {}).values()
        if isinstance(value, (list, tuple)) and value
    }
    for nid in ids:
        node = graph.get(nid)
        if not node or str(node.get("class_type")) != "LoadImage":
            continue
        if nid not in alive:
            graph.pop(nid, None)


def upload_image(base: str, *, name: str, data: bytes) -> str:
    """把一张图放进 ComfyUI 的 input 目录，返回 LoadImage 用的文件名。

    走 ComfyUI 自己的 /upload/image：这样不用知道它的 input 目录在哪，
    远程 ComfyUI 也一样能用。
    """
    if not data:
        raise ImageGenError("参考图是空的")
    safe = "".join(ch if (ch.isalnum() or ch in "._-") else "_" for ch in (name or "ref.png"))
    if not safe.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
        safe += ".png"
    boundary = "----scriptstage" + hashlib.sha1(str(time.time()).encode()).hexdigest()[:16]
    parts: list[bytes] = []

    def field(key: str, value: str) -> bytes:
        return (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n"
        ).encode()

    parts.append(field("overwrite", "true"))
    parts.append(field("type", "input"))
    parts.append(
        (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; "
            f"filename=\"{safe}\"\r\nContent-Type: image/png\r\n\r\n"
        ).encode()
    )
    parts.append(data)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)
    url = _norm_base(base) + "/upload/image"
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with _OPENER.open(req, timeout=120.0) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        raise ImageGenError(f"传参考图失败 HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise ImageGenError(f"连不上 ComfyUI：{exc.reason}") from exc
    try:
        payload = json.loads(raw.decode("utf-8", "replace") or "{}")
    except json.JSONDecodeError:
        payload = {}
    sub = str(payload.get("subfolder") or "").strip()
    got = str(payload.get("name") or safe)
    return f"{sub}/{got}" if sub else got


# ---------------------------------------------------------------- 提交与取图


def _outputs_images(entry: dict) -> list[dict]:
    out: list[dict] = []
    for value in (entry.get("outputs") or {}).values():
        for img in (value or {}).get("images") or []:
            if isinstance(img, dict) and img.get("filename"):
                out.append(img)
    return out


def _history_error(entry: dict) -> str:
    status = entry.get("status") or {}
    if str(status.get("status_str") or "") != "error":
        return ""
    msgs = status.get("messages") or []
    detail = ""
    for msg in msgs:
        if isinstance(msg, (list, tuple)) and len(msg) >= 2 and msg[0] == "execution_error":
            info = msg[1] if isinstance(msg[1], dict) else {}
            detail = str(info.get("exception_message") or info.get("exception_type") or "")
            break
    return detail or "工作流执行失败（ComfyUI 没给原因）"


def _submit(base: str, graph: dict) -> str:
    """提交一份图，返回 prompt_id。错误信息尽量翻成人话。"""
    status, body = _post_json(
        base + "/prompt", {"prompt": graph, "client_id": _client_id()}, 60.0
    )
    if status >= 400 or not isinstance(body, dict) or not body.get("prompt_id"):
        detail = ""
        if isinstance(body, dict):
            err = body.get("error")
            if isinstance(err, dict):
                detail = str(err.get("message") or err.get("type") or "")
            node_errors = body.get("node_errors")
            if node_errors:
                bits = []
                for nid, info in list(node_errors.items())[:3]:
                    if isinstance(info, dict):
                        errs = info.get("errors") or []
                        msg = "; ".join(
                            str((e or {}).get("message") or "") for e in errs if isinstance(e, dict)
                        )
                        bits.append(f"节点 {nid}：{msg or info.get('class_type') or '校验失败'}")
                detail = (detail + "；" if detail else "") + "；".join(bits)
        if not detail:
            detail = str(body)[:300] if isinstance(body, dict) else str(body)[:300]
        raise ImageGenError(f"ComfyUI 拒绝了这份工作流（HTTP {status}）：{detail or '没有说明'}")
    return str(body["prompt_id"])


def _wait(base: str, prompt_id: str, wait_sec: float, poll_sec: float) -> tuple[dict, float]:
    """等 history 出现产物。返回 (entry, 耗时秒)。"""
    started = time.time()
    entry: dict | None = None
    # 连续多少次"既不在队列、也没有记录"才认定被中断。
    #
    # 只判一次会误杀快任务：4 步小图 3 秒左右就能跑完，而 ComfyUI 把任务从
    # queue 摘下来、history 写进去之间有一个很短的窗口 —— 正好在这个窗口里
    # 查一次，就会把"刚刚跑完"读成"被中断"。
    miss = 0
    while time.time() - started < wait_sec:
        time.sleep(poll_sec)
        hist = _get_json(f"{base}/history/{urllib.parse.quote(prompt_id)}", 20.0)
        if isinstance(hist, dict) and hist.get(prompt_id):
            entry = hist[prompt_id]
            if _outputs_images(entry) or _history_error(entry):
                break
            # 有记录但还没产物：可能还在跑，继续等
            miss = 0
        if time.time() - started > 3:
            # 既不在队列也没记录 → 被中断 / 崩了，别傻等到超时
            try:
                q = _get_json(base + "/queue", 10.0)
                running = q.get("queue_running") or []
                pending = q.get("queue_pending") or []
                ids = {
                    str(item[1])
                    for item in running + pending
                    if isinstance(item, list) and len(item) > 1
                }
                if entry is None and prompt_id not in ids:
                    miss += 1
                    if miss >= 3:
                        raise ImageGenError("任务既不在队列也没有结果：可能被中断了")
                else:
                    miss = 0
            except ImageGenError:
                raise
            except Exception:  # noqa: BLE001
                pass

    if entry is None:
        raise ImageGenError(
            f"等了 {int(wait_sec)} 秒还没出图：ComfyUI 可能在忙，或工作流卡住了"
        )
    err = _history_error(entry)
    if err:
        raise ImageGenError(f"工作流执行失败：{err}")
    return entry, round(time.time() - started, 1)


def _fetch_image(base: str, img: dict) -> tuple[bytes, str]:
    """按历史里的 filename 把图取回来。"""
    query = urllib.parse.urlencode(
        {
            "filename": str(img.get("filename") or ""),
            "subfolder": str(img.get("subfolder") or ""),
            "type": str(img.get("type") or "output"),
        }
    )
    try:
        with _OPENER.open(f"{base}/view?{query}", timeout=60.0) as resp:
            payload = resp.read()
            ctype = resp.headers.get("Content-Type", "image/png")
    except urllib.error.HTTPError as exc:
        raise ImageGenError(f"取图失败 HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise ImageGenError(f"取图失败：{exc.reason}") from exc
    if not payload:
        raise ImageGenError("取回来的图片是空的")
    return payload, (ctype.split(";")[0].strip() or "image/png")


def _best_image(images: list[dict]) -> dict:
    """SaveImage（type=output）优先于 PreviewImage（type=temp）。"""
    images = sorted(images, key=lambda i: 0 if str(i.get("type") or "output") == "output" else 1)
    return images[0]


def run(
    base: str,
    *,
    graph: dict,
    wait_sec: float = 300.0,
    poll_sec: float = 0.8,
) -> dict:
    """提交并等结果。返回 {image(字节), mime, promptId, seconds, queued}。"""
    base = _norm_base(base)
    prompt_id = _submit(base, graph)
    entry, seconds = _wait(base, prompt_id, wait_sec, poll_sec)

    images = _outputs_images(entry)
    if not images:
        raise ImageGenError("工作流跑完了但没有图片输出：确认它带了 SaveImage / PreviewImage")

    img = _best_image(images)
    payload, mime = _fetch_image(base, img)
    return {
        "image": payload,
        "mime": mime,
        "promptId": prompt_id,
        "seconds": seconds,
        "filename": str(img.get("filename") or ""),
        "from": str(img.get("type") or "output"),
    }


def generate(
    base: str,
    root: str,
    *,
    workflow: str,
    prompt: str,
    negative: str | None = None,
    width: int | None = None,
    height: int | None = None,
    seed: int | None = None,
    steps: int | None = None,
    cfg: float | None = None,
    refs: list[str] | None = None,
    wait_sec: float = 300.0,
) -> dict:
    """一步到位：读工作流 → 转 API 图 → 注入 → 提交 → 取图。"""
    text = (prompt or "").strip()
    if not text:
        raise ImageGenError("没有提示词")
    data = load_workflow(root, workflow)
    fmt, graph = _as_graph(data)
    notes: list[str] = []
    if fmt == "ui":
        info = object_info(base)
        graph, notes = ui_to_api(data, info)
    elif fmt != "api":
        raise ImageGenError("认不出这份工作流：既不是 UI 格式（nodes）也不是 API 格式")

    report = apply_prompt(
        graph,
        prompt=text,
        negative=negative,
        width=width,
        height=height,
        seed=seed,
        steps=steps,
        cfg=cfg,
        refs=refs,
    )
    report["notes"] = notes + list(report.get("notes") or [])
    report["format"] = fmt
    report["workflow"] = workflow

    result = run(base, graph=graph, wait_sec=wait_sec)
    return {**result, "report": report, "prompt": graph}


# ---------------------------------------------------------------- 批量出图
#
# 为什么不是「循环调 N 次 run」：
#     那样每张都是一个独立任务，ComfyUI 每次都要重新走一遍加载（模型常驻还好，
#     文本编码器被采样挤掉 VRAM 时就会反复加载 qwen3vl 这类几 GB 的编码器）。
#     批量模式把 N 条提示词做成**一张图**一起提交：加载器节点只有一份，
#     编码器 N 个共用同一份 CLIP —— 编码一次加载、模型一次加载，然后逐支采样。
#
# 怎么从一份工作流长出 N 条支路：
#     一条「支路」= 采样器 + 它的下游（解码 / 保存）+ 它专属的上游（提示词编码、
#     空 latent）。共享的东西（UNETLoader / CLIPLoader / VAELoader / 模型补丁）
#     原样只留一份，被所有支路指同一个节点。判定边界落在「文本节点」和
#     「Loader 类节点」上 —— 往上走到这两类就停，绝不复制模型。
#
# 「先统一编码，再统一采样」怎么保证：
#     ComfyUI 是按依赖顺序执行的，光把 N 条支路摆在一起，它仍会一条条
#     编码 → 采样 → 出图。所以要真的让所有采样器**等**所有编码器：
#     借 ConditioningAverage（strength=1.0 时输出就等于 conditioning_to）
#     串一道屏障，见 _add_encode_barrier。节点 id 只求唯一，顺序不靠 id。


def _links(node: dict) -> list[tuple[str, str]]:
    """节点输入里的连线：[(输入名, 上游节点 id)]。"""
    out: list[tuple[str, str]] = []
    for name, value in (node.get("inputs") or {}).items():
        if isinstance(value, (list, tuple)) and len(value) == 2 and isinstance(value[0], (str, int)):
            out.append((str(name), str(value[0])))
    return out


def _downstream(graph: dict, roots: set[str]) -> set[str]:
    """从这些节点出发，往下游能走到的所有节点（含 roots 自己）。"""
    children: dict[str, set[str]] = {}
    for nid, node in graph.items():
        for _, src in _links(node):
            children.setdefault(src, set()).add(nid)
    seen = set(roots)
    stack = list(roots)
    while stack:
        nid = stack.pop()
        for child in children.get(nid, ()):
            if child not in seen:
                seen.add(child)
                stack.append(child)
    return seen


# 这些输入名说明节点在「加载资源」（模型 / CLIP / VAE / LoRA…）。
# 批量时它必须共享，不能每个支路复制一份 —— 复制就是 N 次加载，还不如不批量。
_RESOURCE_KEYS = (
    "ckpt_name",
    "clip_name",
    "vae_name",
    "unet_name",
    "lora_name",
    "control_net_name",
    "style_model_name",
    "clip_vision_name",
    "vae_name",
    "model_name",
    "upscale_model",
)


def _is_resource_node(node: dict) -> bool:
    cls = str(node.get("class_type") or "")
    inputs = node.get("inputs") or {}
    if any(key in inputs for key in _RESOURCE_KEYS):
        return True
    return "Loader" in cls


def _chain_to_text(graph: dict, ref: Any) -> set[str]:
    """从采样器的某个输入往上游收「这条支路专属」的节点。

    遇到文本编码器：收下就停（它的 clip 是共享资源，不能顺着走）。
    遇到 Loader：收下就停 —— 但 Loader 本身属于共享，所以直接跳过不收。
    """
    out: set[str] = set()
    stack = [str(ref[0])] if isinstance(ref, (list, tuple)) and ref else []
    guard = 0
    while stack and guard < 4096:
        guard += 1
        nid = stack.pop()
        if nid in out or nid not in graph:
            continue
        if _is_resource_node(graph[nid]):
            continue
        out.add(nid)
        if _is_text_node(graph[nid]):
            continue
        for _, src in _links(graph[nid]):
            stack.append(src)
    return out


def plan_branch(graph: dict) -> dict:
    """认清「一份提示词 → 一张图」那条支路，以及支路与共享部分的分界。"""
    sampler = _find_sampler(graph)
    if sampler is None:
        raise ImageGenError("这份工作流里没有采样器，没法批量出图")
    s_in = graph[sampler].get("inputs") or {}
    pos = _text_node_behind(graph, s_in.get("positive"))
    neg = _text_node_behind(graph, s_in.get("negative"))
    latent = _empty_latent_behind(graph, sampler)
    if pos is None:
        raise ImageGenError("找不到提示词节点（CLIPTextEncode）：确认它是文生图工作流")

    branch = {sampler} | _downstream(graph, {sampler})
    for key in ("positive", "negative", "latent_image"):
        ref = s_in.get(key)
        if isinstance(ref, (list, tuple)) and ref:
            branch |= _chain_to_text(graph, ref)

    # 支路里可能既有 SaveImage 又有 PreviewImage：优先 SaveImage（正式产物）
    texts = {nid for nid in branch if _is_text_node(graph[nid])}
    sink = _pick_sink(graph, branch)
    return {
        "sampler": sampler,
        "pos_text": pos,
        "neg_text": neg,
        "latent": latent,
        "text_nodes": texts,
        "branch": branch,
        "sink": sink,
        "size": _has_size(graph[latent]) if latent else False,
        # 编码器能不能吃参考图：批量时每条支路各自挂自己的图
        "refs": ref_slots(graph[pos]) > 0,
    }


def _pick_sink(graph: dict, branch: set[str]) -> str:
    """支路的出口节点。ComfyUI 只执行通向出口的节点，出口选错等于白跑。"""
    children: dict[str, set[str]] = {}
    for nid, node in graph.items():
        for _, src in _links(node):
            children.setdefault(src, set()).add(nid)
    leaves = [nid for nid in branch if not children.get(nid)]
    if not leaves:
        raise ImageGenError("这份工作流的采样器后面没有出口节点（SaveImage / PreviewImage）")
    ranked = sorted(
        leaves,
        key=lambda nid: (
            0 if "SaveImage" in str(graph[nid].get("class_type")) else 1,
            0 if "Image" in str(graph[nid].get("class_type")) else 1,
            nid,
        ),
    )
    return ranked[0]


def _branch_rank(nid: str, plan: dict) -> int:
    if nid in plan["text_nodes"]:
        return 0
    if nid == plan["latent"]:
        return 1
    if nid == plan["sampler"]:
        return 2
    return 3


def build_batch(
    graph: dict,
    items: list[dict],
    *,
    negative: str | None = None,
    width: int | None = None,
    height: int | None = None,
    steps: int | None = None,
    cfg: float | None = None,
    encode_barrier: bool = True,
) -> tuple[dict, list[dict], dict]:
    """把一份工作流改造成「N 条支路共用一套加载器」的批量图。

    items: [{key, prompt, seed?}] —— key 原样带回，用来对上"哪张图属于哪一段"。
    返回 (批量图, 每支路的出口信息, 报告)。
    """
    if not items:
        raise ImageGenError("没有要出的内容")
    plan = plan_branch(graph)
    batch = {
        nid: {"class_type": node.get("class_type"), "inputs": dict(node.get("inputs") or {})}
        for nid, node in graph.items()
    }
    notes: list[str] = []
    want_neg = (negative or "").strip()
    branches: list[dict] = []

    # 新节点 id 统一从一个计数器发：以前按"支路号 * 1000"错开，条数一多
    # （第 6 条就是 5000 段）就会和负向编码器的号撞上 —— 撞了不会报错，
    # 只会让两个节点互相覆盖，出图莫名其妙。
    next_id = _max_node_id(graph) + 1

    def take_id() -> str:
        nonlocal next_id
        nid = str(next_id)
        next_id += 1
        return nid

    for idx, item in enumerate(items):
        text = str(item.get("prompt") or "").strip()
        if not text:
            raise ImageGenError(f"第 {idx + 1} 条没有提示词")
        if idx == 0:
            # 第一条直接复用工作流原有的节点 id，少复制一份
            mapping = {nid: nid for nid in plan["branch"]}
        else:
            # 同一支路里文本 → latent → 采样 → 下游 依次发号：
            # ComfyUI 按 id 取就绪节点时，编码器天然排在采样器前面。
            mapping = {}
            for nid in sorted(plan["branch"], key=lambda n: (_branch_rank(n, plan), int(n))):
                mapping[nid] = take_id()
            for nid, new_id in mapping.items():
                node = graph[nid]
                inputs = {}
                for name, value in (node.get("inputs") or {}).items():
                    if (
                        isinstance(value, (list, tuple))
                        and len(value) == 2
                        and str(value[0]) in mapping
                    ):
                        inputs[name] = [mapping[str(value[0])], value[1]]
                    else:
                        inputs[name] = value
                batch[new_id] = {"class_type": node.get("class_type"), "inputs": inputs}

        pos_id = mapping[plan["pos_text"]]
        pos_key = _prompt_key(batch[pos_id]) or "text"
        batch[pos_id]["inputs"][pos_key] = text

        # 参考图：每条支路各挂各的 —— 同一批里各段可能绑不同主体，
        # 共用一套 LoadImage 会把 A 段的脸贴到 B 段上。
        enc_inputs = batch[pos_id]["inputs"]
        for key in [k for k in enc_inputs if k.startswith(_REF_PREFIX)]:
            enc_inputs.pop(key, None)
        item_refs = [str(r).strip() for r in (item.get("refs") or []) if str(r or "").strip()]
        if item_refs:
            if not plan.get("refs"):
                notes.append("这份工作流的编码器不吃参考图，本批的参考图没用上")
            else:
                for i, name in enumerate(item_refs[:MAX_REFS], 1):
                    rid = take_id()
                    batch[rid] = {"class_type": "LoadImage", "inputs": {"image": name}}
                    enc_inputs[f"{_REF_PREFIX}image_{i}"] = [rid, 0]

        neg_id = mapping.get(plan["neg_text"]) if plan["neg_text"] else None
        neg_ref: list | None = None
        own_neg_key = _negative_key(batch[pos_id])
        if want_neg and own_neg_key and neg_id in (None, pos_id):
            # 负向就长在编码器自己身上（Qwen-Image-2.1）：就地写，
            # 采样器的 negative 本来就是这一节点的第二路输出
            batch[pos_id]["inputs"][own_neg_key] = want_neg
            neg_ref = batch[mapping[plan["sampler"]]]["inputs"].get("negative")
            if not (
                isinstance(neg_ref, (list, tuple)) and str(neg_ref[0]) == str(pos_id)
            ):
                neg_ref = None
        elif want_neg and neg_id and neg_id != pos_id:
            batch[neg_id]["inputs"]["text"] = want_neg
            neg_ref = [neg_id, 0]
        elif want_neg and (neg_id is None or neg_id == pos_id):
            # 正负共用文本节点（或被 ZeroOut 掉了）：给这条支路单独接一个负向编码器
            new_id = take_id()
            batch[new_id] = {
                "class_type": batch[pos_id].get("class_type") or "CLIPTextEncode",
                "inputs": {
                    "clip": batch[pos_id]["inputs"].get("clip"),
                    "text": want_neg,
                },
            }
            batch[mapping[plan["sampler"]]]["inputs"]["negative"] = [new_id, 0]
            neg_ref = [new_id, 0]
        elif not want_neg:
            # 沿用工作流自带的负向（可能是 ZeroOut）：它也是编码产物，
            # 一并纳入编码屏障，免得采样中途又得把 CLIP 装回来
            neg_ref = batch[mapping[plan["sampler"]]]["inputs"].get("negative")

        latent_id = mapping.get(plan["latent"]) if plan["latent"] else None
        if latent_id:
            lin = batch[latent_id]["inputs"]
            # 宽高必须齐到 16：EmptyLatentImage 先 //8、再由 downscale_ratio_spacial
            # 缩一半，非 16 倍数会被 round 掉（1032 -> 1024），出图尺寸悄悄变小。
            # 没给的那一边也要拿原值对齐，否则工作流里留着 1000 一样会被改。
            lin["width"] = _align_latent_side(width if width else (lin.get("width") or DEFAULT_W))
            lin["height"] = _align_latent_side(height if height else (lin.get("height") or DEFAULT_H))
            lin["batch_size"] = 1
        elif width or height:
            notes.append("工作流里没有空 latent 节点，尺寸没改")

        s_id = mapping[plan["sampler"]]
        s_in = batch[s_id]["inputs"]
        seed = item.get("seed")
        if seed is not None:
            if "seed" in s_in:
                s_in["seed"] = int(seed)
            elif "noise_seed" in s_in:
                s_in["noise_seed"] = int(seed)
        if steps is not None and "steps" in s_in:
            s_in["steps"] = int(steps)
        if cfg is not None and "cfg" in s_in:
            s_in["cfg"] = float(cfg)

        branches.append(
            {
                "key": str(item.get("key") or idx),
                "sink": mapping[plan["sink"]],
                "sampler": s_id,
                "positive": pos_id,
                # 采样器此刻吃的 conditioning（可能是支路里的某个中间节点，
                # 比如 SetArea）—— 加屏障时要包住它，不能换成文本节点本身
                "positive_ref": batch[s_id]["inputs"].get("positive"),
                "negative_ref": neg_ref,
            }
        )

    barrier = (
        _add_encode_barrier(batch, branches, take_id) if encode_barrier else None
    )
    if encode_barrier and barrier is None and len(branches) > 1:
        notes.append("没加编码屏障（缺少 ConditioningAverage 节点），各支路按需编码")

    if not plan["size"] and (width or height):
        notes.append("工作流里的 latent 没有宽高输入")
    size_px = None
    if plan["size"] and plan["latent"]:
        s_in = graph[plan["latent"]].get("inputs") or {}
        size_px = [
            _align_latent_side(width if width else (s_in.get("width") or DEFAULT_W)),
            _align_latent_side(height if height else (s_in.get("height") or DEFAULT_H)),
        ]
    report = {
        "count": len(branches),
        "shared": sorted(set(graph) - plan["branch"], key=lambda n: int(n) if str(n).isdigit() else 0),
        "copyPerItem": sorted(plan["branch"], key=lambda n: int(n) if str(n).isdigit() else 0),
        "sink": plan["sink"],
        "nodes": len(batch),
        "barrier": barrier,
        "refs": plan.get("refs", False),
        "sizePx": size_px,
        "notes": notes,
    }
    return batch, branches, report


def _add_encode_barrier(batch: dict, branches: list[dict], take_id) -> str | None:
    """让「所有采样器都依赖所有编码器」—— 于是 N 条提示词先统一编码完，才开始采样。

    做法是借 ConditioningAverage 当"等号"：strength=1.0 时它的输出**就是**
    conditioning_to 本身，但图里留下了一条到 conditioning_from 的依赖。
      · rail 串：rail_1 = avg(pos_2, pos_1)，rail_2 = avg(pos_3, rail_1)…
        走到头就依赖了全部支路的编码结果；
      · 每条支路再套一层 gate = avg(pos_i, rail, 1.0)，采样器吃 gate。
    条件张量本身没变，变的只有执行顺序 —— 编码器最后能一次性放掉，
    不会出现"采到一半为了腾显存把 CLIP 卸了、下一张再装回来"。
    """
    if len(branches) < 2:
        return None
    refs = [br.get("positive_ref") for br in branches]
    if not all(isinstance(r, (list, tuple)) and r for r in refs):
        return None

    # rail 要串起**所有编码产物**：正向 N 条 + 负向 N 条。
    # 只串正向的话，负向编码会掉到采样阶段去做 —— CLIP 那时可能已经被挤掉了。
    chain: list[list] = []
    for br in branches:
        chain.append(br["positive_ref"])
        neg = br.get("negative_ref")
        if isinstance(neg, (list, tuple)) and neg and list(neg) != list(br["positive_ref"]):
            chain.append(list(neg))

    rail: str | None = None
    prev: list = chain[0]
    for i in range(1, len(chain)):
        rail = take_id()
        batch[rail] = {
            "class_type": "ConditioningAverage",
            "inputs": {
                "conditioning_to": chain[i],
                "conditioning_from": prev,
                "conditioning_to_strength": 1.0,
            },
        }
        prev = [rail, 0]
    if rail is None:
        return None

    for i, br in enumerate(branches):
        gate = take_id()
        batch[gate] = {
            "class_type": "ConditioningAverage",
            "inputs": {
                "conditioning_to": refs[i],
                "conditioning_from": [rail, 0],
                "conditioning_to_strength": 1.0,
            },
        }
        batch[br["sampler"]]["inputs"]["positive"] = [gate, 0]
    return rail


def run_batch(
    base: str,
    *,
    graph: dict,
    branches: list[dict],
    wait_sec: float = 900.0,
    poll_sec: float = 1.0,
) -> tuple[list[dict], str, float]:
    """提交一次，按支路出口把 N 张图都取回来。"""
    base = _norm_base(base)
    prompt_id = _submit(base, graph)
    entry, seconds = _wait(base, prompt_id, wait_sec, poll_sec)
    outputs = entry.get("outputs") or {}
    out: list[dict] = []
    for i, br in enumerate(branches):
        images = (outputs.get(br["sink"]) or {}).get("images") or []
        images = [im for im in images if isinstance(im, dict) and im.get("filename")]
        if not images:
            raise ImageGenError(f"第 {i + 1} 张没有产物（节点 {br['sink']} 没输出图片）")
        img = _best_image(images)
        payload, mime = _fetch_image(base, img)
        out.append(
            {
                "key": br["key"],
                "image": payload,
                "mime": mime,
                "filename": str(img.get("filename") or ""),
            }
        )
    return out, prompt_id, seconds


def generate_batch(
    base: str,
    root: str,
    *,
    workflow: str,
    items: list[dict],
    negative: str | None = None,
    width: int | None = None,
    height: int | None = None,
    steps: int | None = None,
    cfg: float | None = None,
    wait_sec: float = 900.0,
) -> dict:
    """批量出图：读一次工作流、转一次、提交一次，回来 N 张。"""
    data = load_workflow(root, workflow)
    fmt, graph = _as_graph(data)
    notes: list[str] = []
    if fmt == "ui":
        info = object_info(base)
        graph, notes = ui_to_api(data, info)
    elif fmt != "api":
        raise ImageGenError("认不出这份工作流：既不是 UI 格式（nodes）也不是 API 格式")

    # 编码屏障靠 ConditioningAverage 兜底当"等号"；节点不在就老实地逐支路跑
    try:
        has_barrier_node = "ConditioningAverage" in object_info(base)
    except ImageGenError:
        has_barrier_node = False

    batch, branches, report = build_batch(
        graph,
        items,
        negative=negative,
        width=width,
        height=height,
        steps=steps,
        cfg=cfg,
        encode_barrier=has_barrier_node,
    )
    report["notes"] = notes + list(report.get("notes") or [])
    report["format"] = fmt
    report["workflow"] = workflow

    images, prompt_id, seconds = run_batch(base, graph=batch, branches=branches, wait_sec=wait_sec)
    return {
        "images": images,
        "promptId": prompt_id,
        "seconds": seconds,
        "report": report,
    }
