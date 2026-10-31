"""设定图拼接的单测。

拼接这件事看着简单，坏起来全是**静默**的：比例算错就把脸压扁、取整错一位
就出现 1px 白缝、槽位写反就把三视图塞进左边。这些都不会报错，只会在
出图时表现为"这个人怎么有点怪"。所以这里逐像素量：槽位边界、缩放比例、
缝的颜色、以及"绝不拉伸"这条硬线。

跑法：python server/test_sheet.py
"""

from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sheet  # noqa: E402
from PIL import Image  # noqa: E402


def png(w: int, h: int, color=(200, 200, 200), stripe: int = 0) -> bytes:
    """造一张测试图。stripe != 0 时在左右各画一条竖线，用来验"有没有裁掉边缘"。"""
    img = Image.new("RGB", (w, h), color)
    if stripe:
        for x in list(range(max(1, stripe))) + list(range(w - stripe, w)):
            for y in range(h):
                img.putpixel((x, y), (255, 0, 0))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def decode(raw: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(raw))
    img.load()
    return img.convert("RGB")


class LayoutTest(unittest.TestCase):
    def test_canvas_is_16_9_and_1376x768(self):
        self.assertEqual((sheet.CANVAS_W, sheet.CANVAS_H), (1376, 768))
        self.assertAlmostEqual(sheet.CANVAS_W / sheet.CANVAS_H, 16 / 9, delta=0.02)

    def test_head_is_about_one_third(self):
        ratio = sheet.HEAD_W / sheet.CANVAS_W
        self.assertAlmostEqual(ratio, 1 / 3, delta=0.02)
        # 两个槽位加起来必须正好是画布，不能留空也不能重叠
        self.assertEqual(sheet.HEAD_BOX[2] + sheet.VIEW_BOX[2], sheet.CANVAS_W)
        self.assertEqual(sheet.VIEW_BOX[0], sheet.HEAD_BOX[2])

    def test_slots_are_32_aligned(self):
        # 1376 / 768 / 448 / 928 都是 32 的倍数：缩放时不会落在半像素上
        for v in (sheet.CANVAS_W, sheet.CANVAS_H, sheet.HEAD_W, sheet.VIEW_W):
            self.assertEqual(v % 32, 0, f"{v} 不是 32 的倍数")

    def test_layout_endpoint_shape(self):
        data = sheet.layout()
        self.assertEqual(data["head"]["width"], 448)
        self.assertEqual(data["view"]["x"], 448)
        self.assertEqual(data["view"]["width"], 928)


class FitBoxTest(unittest.TestCase):
    def test_keeps_aspect_ratio(self):
        for src, box in [((736, 1264), (448, 768)), ((1056, 880), (928, 768)), ((300, 900), (928, 768))]:
            dw, dh = sheet.fit_box(src[0], src[1], box[0], box[1])
            self.assertAlmostEqual(dw / dh, src[0] / src[1], delta=0.01, msg=f"{src} → {(dw, dh)}")

    def test_never_exceeds_box(self):
        for src in [(736, 1264), (1056, 880), (1376, 768), (2000, 100), (100, 2000)]:
            dw, dh = sheet.fit_box(src[0], src[1], 448, 768)
            self.assertLessEqual(dw, 448)
            self.assertLessEqual(dh, 768)

    def test_at_least_one_edge_touches(self):
        # contain 的判据：至少一条边贴满，否则就是"缩太小"
        for src in [(736, 1264), (1056, 880), (1376, 768)]:
            dw, dh = sheet.fit_box(src[0], src[1], 448, 768)
            self.assertTrue(dw == 448 or dh == 768, f"{src} → {(dw, dh)} 两条边都没贴")

    def test_zero_raises(self):
        with self.assertRaises(sheet.SheetError):
            sheet.fit_box(0, 100, 448, 768)


class ComposeTest(unittest.TestCase):
    def test_output_is_1376x768(self):
        out = sheet.compose(png(736, 1264), [png(1056, 880)])
        img = decode(out)
        self.assertEqual(img.size, (1376, 768))

    def test_head_is_on_the_left_and_views_on_the_right(self):
        head = png(736, 1264, color=(255, 0, 0))
        view = png(1056, 880, color=(0, 0, 255))
        img = decode(sheet.compose(head, [view]))
        # 左区中心是头（红），右区中心是三视图（蓝）
        self.assertEqual(img.getpixel((224, 384)), (255, 0, 0))
        self.assertEqual(img.getpixel((448 + 464, 384)), (0, 0, 255))
        # 分界线两侧不能串色
        self.assertEqual(img.getpixel((447, 384)), (255, 0, 0))
        self.assertEqual(img.getpixel((449, 384)), (0, 0, 255))

    def test_no_stretch_when_ratios_match(self):
        # 源图比例和槽位一致（7:12 → 448:768），应该一个像素都不裁、不留缝
        head = png(448, 768, color=(10, 20, 30), stripe=4)
        img = decode(sheet.compose(head, [png(928, 768, color=(10, 20, 30), stripe=4)]))
        # 角落以外的底色还在原位 → 没被拉伸成别的形状，也没被裁掉
        self.assertEqual(img.getpixel((6, 6)), (10, 20, 30))
        self.assertEqual(img.getpixel((1360, 760)), (10, 20, 30))
        # 源的左右红边还在原位（宽 4px 的红条）
        self.assertEqual(img.getpixel((1, 384)), (255, 0, 0))
        self.assertEqual(img.getpixel((446, 384)), (255, 0, 0))

    def test_letterbox_uses_source_edge_color(self):
        # 头图偏方（1:1），contain 后上下留缝；缝必须和源图背景同色，不能是白条
        head = png(800, 800, color=(120, 130, 140))
        img = decode(sheet.compose(head, [png(928, 768, color=(120, 130, 140))]))
        self.assertEqual(img.getpixel((10, 10)), (120, 130, 140))
        self.assertEqual(img.getpixel((10, 700)), (120, 130, 140))

    def test_multiple_views_split_the_right_area(self):
        img = decode(
            sheet.compose(
                png(448, 768, color=(255, 0, 0)),
                [
                    png(928, 768, color=(0, 255, 0)),
                    png(928, 768, color=(0, 0, 255)),
                ],
            )
        )
        self.assertEqual(img.getpixel((448 + 100, 384)), (0, 255, 0))
        self.assertEqual(img.getpixel((448 + 800, 384)), (0, 0, 255))

    def test_no_views_raises(self):
        with self.assertRaises(sheet.SheetError):
            sheet.compose(png(448, 768), [])

    def test_broken_image_raises(self):
        with self.assertRaises(sheet.SheetError):
            sheet.compose(b"not a png", [png(928, 768)])

    def test_empty_bytes_raises(self):
        with self.assertRaises(sheet.SheetError):
            sheet.compose(b"", [png(928, 768)])

    def test_alpha_channel_preserved_on_top_of_background(self):
        # RGBA 的透明区应该露出底色，而不是变黑
        img = Image.new("RGBA", (448, 768), (0, 0, 0, 0))
        buf = io.BytesIO()
        img.save(buf, "PNG")
        out = decode(sheet.compose(buf.getvalue(), [png(928, 768, color=(200, 200, 200))]))
        self.assertGreater(out.getpixel((224, 384))[0], 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
