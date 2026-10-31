"""从 ComfyUI 节点包的**源码**里静态抽出 INPUT_TYPES。

为什么要有这条路：
    /object_info 是权威来源（连枚举候选都给全），但它要求 ComfyUI 进程活着。
    用户经常是"先把参数配好，等下再起服务"，那时 ComfyUI 没跑，参数一栏
    就是空的。模型同理 —— 参数定义也只是磁盘上的 Python 源码。

为什么用 ast 而不是 import：
    节点包一 import 就要拉 torch / transformers，几秒到几十秒不等，且版本
    不匹配会直接 ImportError。静态解析不需要装依赖，也不会执行任何代码
    （绝不 eval，只认字面量与模块级常量）。

代价要说清楚：动态构造的 INPUT_TYPES（列表推导、函数调用、跨模块常量）
抽不出来，这类参数会缺席。所以在线时一律以 /object_info 为准，
这里只是"ComfyUI 没起也能配"的兜底。
"""

from __future__ import annotations

import ast
import os
import re
from pathlib import Path

# 只扫这些目录：内置节点 + 自定义节点包。
# custom_nodes 排第一：它是用户真正关心的，且文件数上限截断时先保住它。
SCAN_SUBDIRS = ["custom_nodes", "nodes", "comfy_extras"]

# 跳过的目录：依赖、缓存、示例
SKIP_DIR_NAMES = {
    "__pycache__", ".git", ".venv", "venv", "env", "site-packages",
    "node_modules", ".idea", ".vscode", "build", "dist", "docs", "tests",
}

MAX_FILES = 6000
MAX_FILE_BYTES = 1_500_000

# 输入类型 → 内部 kind。ComfyUI 的 forceInput 是 "INT" 之类前面加星号或
# 直接是类型名，连线参数一律跳过（它们的值来自上游节点，不能手填）。
TYPE_KINDS = {
    "INT": "int",
    "FLOAT": "float",
    "STRING": "text",
    "BOOLEAN": "bool",
    "COMBO": "enum",
}


def _literal(node: ast.AST, consts: dict[str, object] | None = None, depth: int = 0):
    """把 AST 节点尽量还原成 Python 值；还原不了返回 None。

    只在 depth 限制内递归，避免恶意/异常深层结构把解析拖死。
    """
    if depth > 6:
        return None
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Dict):
        out: dict = {}
        for k, v in zip(node.keys, node.values):
            if k is None:
                # `**some_dict` 展开 —— 不处理就整段丢掉
                vv = _literal(v, consts, depth + 1)
                if isinstance(vv, dict):
                    out.update(vv)
                continue
            kk = _literal(k, consts, depth + 1)
            vv = _literal(v, consts, depth + 1)
            if isinstance(kk, (str, int, float, bool)):
                out[kk] = vv
        return out
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return [_literal(e, consts, depth + 1) for e in node.elts]
    if isinstance(node, ast.Name) and consts is not None:
        return consts.get(node.id)
    if isinstance(node, ast.Call):
        # 形如 `director_timeline_required_inputs()` —— 同文件里的工具函数，
        # 返回一份字面量 dict。这类写法在 H3 的包里用得很多，不求值会丢掉
        # 一大半参数（实测 Director 只能抽出 7/29）。
        # 只认"无参数调用"且已预求出返回值的函数，宁可漏也不能猜错。
        if node.args or node.keywords:
            return None
        if isinstance(node.func, ast.Name) and consts is not None:
            v = consts.get(node.func.id)
            if isinstance(v, dict):
                return v
        return None
    if isinstance(node, ast.Attribute):
        # io.INT / IO.INT —— 取最后一段
        return node.attr
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        v = _literal(node.operand, consts, depth + 1)
        return -v if isinstance(v, (int, float)) else None
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Mult)):
        # 少量包会写 "a" + "b" 之类的常量拼接
        left = _literal(node.left, consts, depth + 1)
        right = _literal(node.right, consts, depth + 1)
        if isinstance(left, str) and isinstance(right, str):
            return left + right
        if isinstance(left, (int, float)) and isinstance(right, (int, float)):
            return left + right if isinstance(node.op, ast.Add) else left * right
    return None


def _module_consts(tree: ast.Module) -> dict[str, object]:
    """收集模块级字面量常量 + 无参工具函数的返回值。

    后者是关键：H3 的包把一整组输入写进 `def director_timeline_required_inputs()`
    这类函数里，INPUT_TYPES 再去调用它。不预求这些函数的返回值，Director
    节点就只能抽出 7 个参数（实测），其余全丢。
    """
    out: dict[str, object] = {}
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign):
            for t in stmt.targets:
                if isinstance(t, ast.Name):
                    v = _literal(stmt.value, None)
                    if v is not None and isinstance(v, (str, int, float, bool, list, tuple)):
                        out[t.id] = v
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
            v = _literal(stmt.value, None) if stmt.value is not None else None
            if v is not None:
                out[stmt.target.id] = v

    # 无参函数 → 其返回的 dict。有必需参数的一律跳过（猜出来的值更危险）。
    for stmt in tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if stmt.args.args or stmt.args.posonlyargs or stmt.args.kwonlyargs:
                continue
            if stmt.args.vararg or stmt.args.kwarg:
                continue
            for sub in ast.walk(stmt):
                if isinstance(sub, ast.Return) and sub.value is not None:
                    v = _literal(sub.value, out)
                    if isinstance(v, dict):
                        out[stmt.name] = v
                    break
    return out


def _type_and_opts(raw, consts: dict[str, object]):
    """把 `("INT", {...})` 拆成 (类型名, 配置 dict)。"""
    if isinstance(raw, (list, tuple)):
        t = raw[0] if raw else None
        opts = raw[1] if len(raw) > 1 and isinstance(raw[1], dict) else {}
        return t, opts
    return raw, {}


def _params_from_input_types(doc, consts: dict[str, object]) -> list[dict]:
    if not isinstance(doc, dict):
        return []
    out: list[dict] = []
    # required / optional / hidden。hidden 一般是 prompt、unique_id 之类，跳过。
    for section in ("required", "optional"):
        block = doc.get(section)
        if not isinstance(block, dict):
            continue
        for name, raw in block.items():
            t, opts = _type_and_opts(raw, consts)
            # 枚举：类型位直接是 list
            if isinstance(t, (list, tuple)):
                values = [str(v) for v in t if isinstance(v, (str, int, float, bool))]
                out.append(
                    {
                        "name": str(name),
                        "kind": "enum",
                        "options": values,
                        "default": _as_default(opts.get("default")),
                        "tooltip": opts.get("tooltip") if isinstance(opts.get("tooltip"), str) else "",
                        "section": section,
                        "forceInput": False,
                    }
                )
                continue
            tname = str(t) if t is not None else ""
            # forceInput：ComfyUI 用 "INT" 之外的任意类型名（如 "MODEL"），
            # 或带 * 前缀。这些值来自上游连线，不提供手填入口。
            base = tname.lstrip("*")
            kind = TYPE_KINDS.get(base.upper())
            if kind is None:
                continue
            p: dict = {
                "name": str(name),
                "kind": kind,
                "default": _as_default(opts.get("default")),
                "section": section,
                "forceInput": tname.startswith("*"),
                "tooltip": opts.get("tooltip") if isinstance(opts.get("tooltip"), str) else "",
            }
            if kind in ("int", "float"):
                for k in ("min", "max", "step", "round"):
                    v = opts.get(k)
                    if isinstance(v, (int, float)):
                        p[k] = v
            if opts.get("multiline") is True:
                p["multiline"] = True
            if opts.get("control_after_generate") is True:
                p["controlAfterGenerate"] = True
            out.append(p)
    return out


def _as_default(v) -> object:
    if v is None:
        return None
    if isinstance(v, (str, int, float, bool)):
        return v
    return None


def _class_inputs(tree: ast.Module, consts: dict[str, object]) -> dict[str, dict]:
    """类名 → {display, category, params}"""
    out: dict[str, dict] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        display = ""
        category = ""
        params: list[dict] = []
        for item in node.body:
            # CATEGORY / DISPLAY_NAME 之类
            if isinstance(item, ast.Assign):
                for t in item.targets:
                    if isinstance(t, ast.Name) and t.id in ("CATEGORY", "CATEGORY_NAME", "DISPLAY_NAME"):
                        v = _literal(item.value, consts)
                        if isinstance(v, str):
                            if t.id.startswith("DISPLAY"):
                                display = v
                            else:
                                category = v
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == "INPUT_TYPES":
                # 函数内的局部变量也要收（`required = {...}; return {"required": required}`）
                local = dict(consts)
                for sub in ast.walk(item):
                    if isinstance(sub, ast.Assign):
                        for t in sub.targets:
                            if isinstance(t, ast.Name):
                                v = _literal(sub.value, local)
                                if v is not None:
                                    local[t.id] = v
                for sub in ast.walk(item):
                    if isinstance(sub, ast.Return) and sub.value is not None:
                        doc = _literal(sub.value, local)
                        params = _params_from_input_types(doc, local)
                        break
        if params:
            out[node.name] = {"display": display, "category": category, "params": params}
    return out


def _dict_of_class_names(node: ast.AST) -> dict[str, str]:
    """解析 `NODE_CLASS_MAPPINGS = {"X": SomeClass}`。

    值几乎都是**类引用**（ast.Name / ast.Attribute），不是字符串 —— 第一版用
    通用 `_literal` 解析，Name 还原不出来，结果 mapped 恒为 0，所有 class_type
    都变成了类名。这里单独处理引用。
    """
    out: dict[str, str] = {}
    if not isinstance(node, ast.Dict):
        return out
    for k, v in zip(node.keys, node.values):
        if k is None:
            continue
        kk = _literal(k, None)
        if not isinstance(kk, str):
            continue
        if isinstance(v, ast.Name):
            out[kk] = v.id
        elif isinstance(v, ast.Attribute):
            out[kk] = v.attr
        else:
            vv = _literal(v, None)
            if isinstance(vv, str):
                out[kk] = vv
    return out


def _mappings(tree: ast.Module) -> dict[str, str]:
    """NODE_CLASS_MAPPINGS：class_type → 类名。"""
    out: dict[str, str] = {}
    for stmt in ast.walk(tree):
        if isinstance(stmt, ast.Assign):
            for t in stmt.targets:
                if isinstance(t, ast.Name) and t.id == "NODE_CLASS_MAPPINGS":
                    out.update(_dict_of_class_names(stmt.value))
        elif isinstance(stmt, ast.Call) and isinstance(stmt.func, ast.Attribute):
            # `NODE_CLASS_MAPPINGS.update({...})` 这类增量写法
            if stmt.func.attr == "update" and isinstance(stmt.func.value, ast.Name):
                if stmt.func.value.id == "NODE_CLASS_MAPPINGS":
                    for arg in stmt.args:
                        out.update(_dict_of_class_names(arg))
    return out


# 每个包单独的文件配额。ComfyUI-Manager / Easy-Use 这种包有上千个 py，
# 不给单包配额的话它们会吃光总预算，排在字母序后面的 H3 节点包就一个都扫不到。
PER_PACKAGE_FILES = 500
TOTAL_FILES = 12000


def _walk_limited(base: Path, limit: int):
    count = 0
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIR_NAMES and not d.startswith(".")]
        for fn in sorted(filenames):
            if not fn.endswith(".py"):
                continue
            if count >= limit:
                return
            count += 1
            yield Path(dirpath) / fn


def _iter_py_files(root: Path):
    seen = 0
    for sub in SCAN_SUBDIRS:
        base = root / sub
        if not base.is_dir():
            continue
        if sub == "custom_nodes":
            # 每个包独立配额
            for pkg in sorted((p for p in base.iterdir() if p.is_dir()), key=lambda p: p.name):
                for p in _walk_limited(pkg, PER_PACKAGE_FILES):
                    if seen >= TOTAL_FILES:
                        return
                    seen += 1
                    yield p
            for p in sorted(base.glob("*.py")):
                if seen >= TOTAL_FILES:
                    return
                seen += 1
                yield p
        else:
            for p in _walk_limited(base, PER_PACKAGE_FILES * 3):
                if seen >= TOTAL_FILES:
                    return
                seen += 1
                yield p


def scan_node_sources(root_raw: str) -> dict:
    """扫一个 ComfyUI 根目录，返回 {class_type: {display, category, params}}。

    结果按"文件里定义了类 + 该文件有 NODE_CLASS_MAPPINGS"配对；映射不到的类
    就直接用类名当 class_type —— 多数包这两者一致，宁可多给也不能漏。
    """
    raw = (root_raw or "").strip()
    if not raw:
        return {"ok": False, "reason": "未指定根目录", "nodes": {}, "stats": {}}
    root = Path(raw)
    if not root.is_dir():
        return {"ok": False, "reason": f"目录不存在：{root}", "nodes": {}, "stats": {}}

    nodes: dict[str, dict] = {}
    files = 0
    mapped = 0
    # 类名 → 类信息（跨文件累积，__init__.py 常常引用子模块里定义的类）
    classes_by_name: dict[str, dict] = {}
    # 所有文件里的 NODE_CLASS_MAPPINGS（class_type → 类名）
    all_mappings: dict[str, str] = {}

    # ---- 第一阶段：全量收集。必须两阶段 —— os.walk 先扫到 __init__.py，
    #      那时 nodes/director.py 的类还没收集到，单阶段配对会全部落空。
    for path in _iter_py_files(root):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        # 快速预判，省掉大量 ast.parse。
        # ★ NODE_CLASS_MAPPINGS 必须一起判断：包的 __init__.py 通常只有映射、
        #   没有 INPUT_TYPES，漏掉它 class_type 就永远配不上类名。
        if "INPUT_TYPES" not in text and "NODE_CLASS_MAPPINGS" not in text:
            continue
        files += 1
        try:
            tree = ast.parse(text)
        except SyntaxError:
            continue
        consts = _module_consts(tree)
        for cname, info in _class_inputs(tree, consts).items():
            info["source"] = str(path.relative_to(root)).replace("\\", "/")
            # 同名的以参数多的一份为准
            prev = classes_by_name.get(cname)
            if prev is None or len(info["params"]) > len(prev.get("params", [])):
                classes_by_name[cname] = info
        for ctype, cname in _mappings(tree).items():
            all_mappings.setdefault(ctype, cname)

    # ---- 第二阶段：配对 class_type → 类
    for ctype, cname in all_mappings.items():
        info = classes_by_name.get(cname)
        if not info:
            continue
        mapped += 1
        prev = nodes.get(ctype)
        if prev is None or len(info["params"]) > len(prev.get("params", [])):
            nodes[ctype] = dict(info)

    # 没进映射的类也列出来（用类名当 class_type），保证"扫得到就配得了"
    for cname, info in classes_by_name.items():
        nodes.setdefault(cname, dict(info))

    for v in nodes.values():
        v.pop("_class", None)

    return {
        "ok": True,
        "root": str(root),
        "nodes": nodes,
        "stats": {"files": files, "classes": len(classes_by_name), "mapped": mapped, "types": len(nodes)},
    }
