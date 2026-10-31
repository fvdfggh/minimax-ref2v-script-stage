"""设定图拼接：把「组头」和「三视图」拼成一张 16:9 的参考图。

版式是需求里定死的 —— 左边约 1/3 放头，右边约 2/3 放三视图：

    1376 × 768（16:9）
    ├── 0   .. 448    组头：正面头肩，头颈完整可见
    └── 448 .. 1376   三视图：正 / 侧 / 背 三个全身并排

448 / 1376 = 32.6%，928 / 1376 = 67.4%，两个数都是 32 的倍数 —— 1376 和 768
本身就是 32 的倍数，槽位不需要再对齐，缩图时也不会落在半像素上。

**为什么在服务端拼，而不是浏览器 canvas**：
  * 素材本来就在服务端磁盘上（`projects/<id>/assets/`），不用为拼一次
    把几百 KB 图 base64 来回搬；
  * 只有一份实现。前端要是也写一套，两边的边距、取整、采样方式迟早漂移，
    而这张图是喂给模型的 —— 差几像素没人看得见，差一个比例就全歪；
  * 服务端能选 LANCZOS 重采样。浏览器 `drawImage` 的缩小质量随版本变。

★ **绝不拉伸**：源图比例和槽位不一致时按 contain 等比缩放、居中，
  剩下的缝用**源图自己的背景色**补（见 `_edge_color`）。宁可留一条同色缝，
  也不能把人脸压扁 —— 拉变形的脸再喂回模型，出图会一路歪到底。

★ 尺寸常量与前端 `src/domain/refSheet.ts` 的 `SHEET_LAYOUT` /
  `HEAD_GEN_SIZE` / `VIEW_GEN_SIZE` 必须一致，前端测试会扫本文件核对。
"""

from __future__ import annotations

import io
from typing import Sequence

try:  # Pillow 是唯一的第三方依赖，装不上就明确报错，别让 500 冒出来
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    Image = None  # type: ignore[assignment]
    ImageDraw = None  # type: ignore[assignment]


#: 成品画布 1376×768 = 16:9。这个尺寸是需求指定的，不能按比例缩。
CANVAS_W, CANVAS_H = 1376, 768
#: 左侧头图的宽度。448 = 14×32，占 32.6%，视觉上就是"约 1/3"。
HEAD_W = 448
#: 右侧三视图的起点与宽度（928 = 29×32，占 67.4%）
VIEW_X = HEAD_W
VIEW_W = CANVAS_W - HEAD_W

HEAD_BOX = (0, 0, HEAD_W, CANVAS_H)
VIEW_BOX = (VIEW_X, 0, VIEW_W, CANVAS_H)

#: 兜底色。只在源图读不出边角色时用，正常情况每个槽位都会被自己的边角色填满。
FALLBACK_BG = (244, 244, 244)


class SheetError(Exception):
    """拼接失败（图读不动 / 缺 Pillow / 少了三视图）。调用方翻成 400。"""


def has_pillow() -> bool:
    """Pillow 装没装。启动横幅用它决定要不要打一行提示 —— 不装也能起服务。"""
    return Image is not None


def layout() -> dict:
    """布局常量。前端联调时可以直接对一下，省得两边各猜一份。"""
    return {
        "width": CANVAS_W,
        "height": CANVAS_H,
        "aspect": "16:9",
        "head": {"x": HEAD_BOX[0], "y": HEAD_BOX[1], "width": HEAD_BOX[2], "height": HEAD_BOX[3]},
        "view": {"x": VIEW_BOX[0], "y": VIEW_BOX[1], "width": VIEW_BOX[2], "height": VIEW_BOX[3]},
    }


def fit_box(src_w: int, src_h: int, box_w: int, box_h: int) -> tuple[int, int]:
    """等比缩放到"装得进 box 的最大尺寸"。

    取两个方向比例的**小**值：小的那个方向刚好贴边，大的那个方向留缝。
    用大的那个就是 cover（要裁），那是另一套语义，这里不用 —— 用户要求
    "拼接不能拉伸"，而裁剪会把头顶或脚切掉，比留一条同色缝糟得多。

    允许放大：源图比槽位小时（用户上传的小图）也拉到贴边，版式才统一。
    """
    if src_w <= 0 or src_h <= 0 or box_w <= 0 or box_h <= 0:
        raise SheetError("图片或槽位尺寸为 0")
    scale = min(box_w / src_w, box_h / src_h)
    return max(1, round(src_w * scale)), max(1, round(src_h * scale))


def _edge_color(img: "Image.Image") -> tuple[int, int, int]:
    """左上角一小块的平均色，当补缝的底色。

    设定图提示词要求"中性浅灰无缝背景"，所以这块色基本就是背景本身，
    补出来的缝和原图分不出来。取平均而不是取单个像素，是为了躲开
    挂在角上的噪点或水印。
    """
    w, h = img.size
    cw = max(1, min(8, w // 8 or 1))
    ch = max(1, min(8, h // 8 or 1))
    patch = img.crop((0, 0, cw, ch)).convert("RGBA")
    # 丢掉全透明的像素：透明区的 RGB 是 (0,0,0)，直接平均会拼出一条黑边
    pixels = [p for p in patch.getdata() if p[3] > 8]
    n = len(pixels)
    if not n:
        return FALLBACK_BG
    return (
        round(sum(p[0] for p in pixels) / n),
        round(sum(p[1] for p in pixels) / n),
        round(sum(p[2] for p in pixels) / n),
    )


def _open(raw: bytes, what: str) -> "Image.Image":
    if Image is None:  # pragma: no cover
        raise SheetError("服务端缺 Pillow：`pip install pillow` 后重启后端")
    if not raw:
        raise SheetError(f"{what}是空文件")
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception as exc:  # noqa: BLE001 - PIL 的异常类型随版本变
        raise SheetError(f"{what}读不动：{exc}") from exc
    return img


def _paste_contain(canvas: "Image.Image", src: "Image.Image", box: tuple[int, int, int, int]) -> None:
    """把一个槽位先铺自己的底色，再等比缩放居中贴上去。"""
    x, y, bw, bh = box
    ImageDraw.Draw(canvas).rectangle([x, y, x + bw - 1, y + bh - 1], fill=_edge_color(src))
    dw, dh = fit_box(src.width, src.height, bw, bh)
    img = src.resize((dw, dh), Image.LANCZOS) if (dw, dh) != src.size else src.copy()
    dx = x + (bw - dw) // 2
    dy = y + (bh - dh) // 2
    if img.mode == "RGBA":
        canvas.paste(img, (dx, dy), img)
    else:
        canvas.paste(img.convert("RGB"), (dx, dy))


def compose(head: bytes, views: Sequence[bytes]) -> bytes:
    """组头 + N 张三视图 → 一张 1376×768 的 PNG。

    多张三视图时右区横向等分（每张占 1/N）。正常只传一张 —— 三视图本身
    已经是"正 / 侧 / 背"并排的一张图，再并就是六个小人，脸更小。
    """
    if Image is None:  # pragma: no cover
        raise SheetError("服务端缺 Pillow：`pip install pillow` 后重启后端")
    if not views:
        raise SheetError("至少要有一张三视图才能拼")

    head_img = _open(head, "组头")
    canvas = Image.new("RGB", (CANVAS_W, CANVAS_H), FALLBACK_BG)
    _paste_contain(canvas, head_img, HEAD_BOX)

    n = len(views)
    for i, raw in enumerate(views):
        x0 = VIEW_X + round(VIEW_W * i / n)
        x1 = VIEW_X + round(VIEW_W * (i + 1) / n)
        _paste_contain(canvas, _open(raw, "三视图"), (x0, 0, x1 - x0, CANVAS_H))

    out = io.BytesIO()
    canvas.save(out, "PNG", optimize=True)
    return out.getvalue()
