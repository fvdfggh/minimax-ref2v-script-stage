"""按 object_info 重建 API 图里的 widget 值，修掉「界面格式按位置存值」的错位。

背景（这次真踩到了）：
界面格式的工作流只存 `widgets_values` 一个**按位置**的数组。ComfyUI 前端导出
API 格式时，是拿运行时的 `node.widgets` 列表去套值的；而这个列表是节点**保存
时**的样子。一旦节点后来新增/删减了参数（实测 H3TextEncoderAccel 多了
dispose_after_encode / release_after_encode 两个 BOOL），后面的值就整体错位，
导出成 `on_oom=True`、`mlp_chunk='fallback'` 这种一眼假的东西。

所以与其信前端那次转换，不如直接拿权威的 `/object_info` 参数顺序，把界面格式
里的 `widgets_values` 重新按位分配一遍。数量对不上就报告出来让人看，不猜。
"""
import json
import sys
from pathlib import Path

ROOT = Path("C:/Users/于玉宇/Desktop/minimax-ref2v-script-stage")
UI = Path("C:/Users/于玉宇/Desktop/comfyui/ComfyUI/user/default/workflows/测试用工作流1_段1-192_一采.json")
API = ROOT / "scripts/_exported_api.json"
OI = Path("C:/Users/于玉宇/AppData/Local/Temp/object_info.json")
OUT = ROOT / "scripts/_exported_api_fixed.json"

WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "BOOL"}
# seed 类 widget 后面会跟一个 control_after_generate，值也进了 widgets_values
CONTROL_VALUES = {"randomize", "increment", "decrement", "fixed"}


def widget_params(spec):
    """按 ComfyUI 的 widget 顺序返回 [(name, kind, config)]，link 类型跳过。"""
    out = []
    for section in ("required", "optional"):
        for name, cfg in (spec.get(section) or {}).items():
            if not isinstance(cfg, list) or not cfg:
                continue
            t = cfg[0]
            if isinstance(t, list):
                out.append((name, "combo", cfg))
            elif t in WIDGET_TYPES:
                out.append((name, t, cfg))
            # 其它（CLIP/MODEL/VAE/...）都是连线，不占 widgets_values
    return out


def coerce(kind, cfg, value):
    """能转就转，转不了返回 None（调用方决定退回原值）。"""
    if kind == "combo":
        choices = cfg[0]
        if value in choices:
            return value
        return None
    if kind == "INT":
        try:
            return int(value)
        except (TypeError, ValueError):
            return None
    if kind == "FLOAT":
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
    if kind == "BOOLEAN":
        if isinstance(value, bool):
            return value
        return None
    # STRING
    return value if isinstance(value, str) else None


def main():
    # 只修点名的节点。
    #
    # 为什么不能整图重建：节点定义会**重排**参数顺序（实测
    # MiniMaxH3ActivationChunkStar7 的 disable_dynamic_prefetch 被插到了
    # qkv_chunk_tokens 前面），所以 object_info 的顺序只代表"现在"，而界面格式
    # 里的 widgets_values 是"保存时"的顺序。整图按 object_info 重建会把本来
    # 正确的 qkv/out_proj 改坏。因此只修服务端校验明确报错的节点。
    only = set()
    for arg in sys.argv[1:]:
        if arg.startswith("--only="):
            only = set(arg.split("=", 1)[1].split(","))
        if arg.startswith("--out="):
            globals()["OUT"] = Path(arg.split("=", 1)[1])

    ui = json.loads(UI.read_text(encoding="utf-8"))
    api = json.loads(API.read_text(encoding="utf-8"))
    oi = json.loads(OI.read_text(encoding="utf-8"))

    ui_by_id = {str(n["id"]): n for n in ui.get("nodes", [])}
    report = []

    for node_id, node in api.items():
        ctype = node["class_type"]
        if only and node_id not in only:
            continue
        spec = (oi.get(ctype) or {}).get("input") or {}
        params = widget_params(spec)
        if not params:
            continue
        ui_node = ui_by_id.get(node_id)
        if not ui_node:
            report.append(f"{node_id} {ctype}: 界面图里找不到同名节点，跳过")
            continue
        values = list(ui_node.get("widgets_values") or [])
        # 去掉 control_after_generate 这类附加 widget 的值
        values = [v for v in values if not (isinstance(v, str) and v in CONTROL_VALUES)]

        if len(values) != len(params):
            report.append(
                f"{node_id} {ctype}: 值 {len(values)} 个 / 参数 {len(params)} 个 —— 数量不符，保留原值"
            )
            continue

        fixed = {}
        changed = []
        for (name, kind, cfg), v in zip(params, values):
            cv = coerce(kind, cfg, v)
            if cv is None:
                cv = cfg[1].get("default") if isinstance(cfg[1], dict) else None
                changed.append(f"{name}: {v!r}→默认 {cv!r}")
            old = node["inputs"].get(name)
            if old != cv:
                changed.append(f"{name}: {old!r}→{cv!r}")
            fixed[name] = cv

        # 连线输入原样保留
        for k, v in node["inputs"].items():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                fixed[k] = v
        node["inputs"] = fixed
        if changed:
            report.append(f"{node_id} {ctype}: " + "; ".join(changed[:6]))

    OUT.write_text(json.dumps(api, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已写出 {OUT}")
    print("--- 修正明细")
    for line in report:
        print(" ", line)


if __name__ == "__main__":
    main()
