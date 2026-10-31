"""Qwen-Image-2.1 这份工作流的注入测试。

和 Krea2 那份的区别，全在「一个节点既是正向又是负向」：
`TextEncodeQwenImage21` 一口气吐出 positive / negative / latent 三路，
负向是同一节点上的 `negative_prompt` 输入。所以这里要盯死三件事：

1. 提示词必须写进 `prompt`，而不是 `text`（写错等于没注入，出图不报错）；
2. 负向写 `negative_prompt`，**不能**再新建一个编码器（新节点缺必填输入，
   ComfyUI 会直接 400）；
3. 参考图要挂在 `images.image_N` 上，且每条批量支路各挂各的。
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import imagegen  # noqa: E402


def qwen21_graph() -> dict:
    """与 ▶Qwen2.1_2步_生成与编辑.json 同构（API 格式）。"""
    return {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": "qwen_image_2.1_int8_convrot.safetensors", "weight_dtype": "default"},
        },
        "2": {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "model": ["1", 0],
                "lora_name": "Qwen-Image-2.1-sarvam-tez-2step-lora-r256.safetensors",
                "strength_model": 1.0,
            },
        },
        "3": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["2", 0], "shift": 3.0}},
        "4": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
                "type": "qwen_image",
                "device": "default",
            },
        },
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_2.1_vae_bf16.safetensors"}},
        "6": {
            "class_type": "TextEncodeQwenImage21",
            "inputs": {
                "clip": ["4", 0],
                "prompt": "原始提示词",
                "negative_prompt": "",
                "resolution": 1024,
                "vae": ["5", 0],
            },
        },
        "7": {"class_type": "EmptyLatentImage", "inputs": {"width": 1280, "height": 720, "batch_size": 1}},
        "8": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["3", 0],
                "seed": 0,
                "steps": 2,
                "cfg": 1.0,
                "sampler_name": "euler",
                "scheduler": "simple",
                "positive": ["6", 0],
                "negative": ["6", 1],
                "latent_image": ["7", 0],
                "denoise": 1.0,
            },
        },
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["5", 0]}},
        "10": {"class_type": "SaveImage", "inputs": {"images": ["9", 0], "filename_prefix": "qwen21"}},
    }


class ApplyPromptTest(unittest.TestCase):
    def test_prompt_goes_to_prompt_not_text(self):
        graph = qwen21_graph()
        report = imagegen.apply_prompt(graph, prompt="雨夜便利店", width=768, height=432, steps=2, seed=7)
        enc = graph["6"]["inputs"]
        self.assertEqual(enc["prompt"], "雨夜便利店")
        self.assertNotIn("text", enc, "Qwen-Image-2.1 的输入叫 prompt，不该凭空多一个 text")
        self.assertEqual(report["positive"], "6")
        self.assertEqual(graph["7"]["inputs"]["width"], 768)
        self.assertEqual(graph["8"]["inputs"]["steps"], 2)

    def test_negative_written_in_place_not_new_node(self):
        graph = qwen21_graph()
        before = set(graph)
        report = imagegen.apply_prompt(graph, prompt="p", negative="模糊, 塑料感")
        self.assertEqual(graph["6"]["inputs"]["negative_prompt"], "模糊, 塑料感")
        self.assertEqual(set(graph), before, "负向不该新建节点：新节点缺 prompt/resolution 会被拒")
        self.assertEqual(report["negative"], "6")

    def test_refs_attached_and_replaced(self):
        graph = qwen21_graph()
        report = imagegen.apply_prompt(graph, prompt="p", refs=["a.png", "b.png"])
        enc = graph["6"]["inputs"]
        self.assertEqual(report["refs"]["count"], 2)
        first = enc["images.image_1"][0]
        second = enc["images.image_2"][0]
        self.assertEqual(graph[first]["class_type"], "LoadImage")
        self.assertEqual(graph[first]["inputs"]["image"], "a.png")
        self.assertEqual(graph[second]["inputs"]["image"], "b.png")
        self.assertNotEqual(first, second)

        # 第二次只给一张：旧的 images.image_2 必须摘掉，否则还会贴上个任务的脸
        imagegen.apply_prompt(graph, prompt="p", refs=["c.png"])
        enc = graph["6"]["inputs"]
        self.assertEqual(enc["images.image_1"], [first, 0])
        self.assertNotIn("images.image_2", enc)
        self.assertEqual(graph[first]["inputs"]["image"], "c.png")

    def test_no_refs_means_clean_t2i(self):
        graph = qwen21_graph()
        report = imagegen.apply_prompt(graph, prompt="p")
        self.assertIsNone(report["refs"])
        self.assertFalse([k for k in graph["6"]["inputs"] if k.startswith("images.")])

    def test_ref_slots_detects_encoder_without_wired_images(self):
        # API 图里还没连过图时不会有 images.* 键，只能按类名认
        self.assertEqual(imagegen.ref_slots(qwen21_graph()["6"]), imagegen.MAX_REFS)
        self.assertEqual(imagegen.ref_slots(qwen21_graph()["8"]), 0)

    def test_refs_cap(self):
        graph = qwen21_graph()
        refs = [f"r{i}.png" for i in range(imagegen.MAX_REFS + 3)]
        report = imagegen.apply_prompt(graph, prompt="p", refs=refs)
        self.assertEqual(report["refs"]["count"], imagegen.MAX_REFS)
        self.assertTrue(any("参考图最多" in n for n in report["notes"]))


class PlanAndBatchTest(unittest.TestCase):
    def test_plan_branch(self):
        plan = imagegen.plan_branch(qwen21_graph())
        self.assertEqual(plan["sampler"], "8")
        self.assertEqual(plan["pos_text"], "6")
        self.assertEqual(plan["neg_text"], "6", "负向和正向是同一个节点")
        self.assertEqual(plan["latent"], "7")
        self.assertEqual(plan["sink"], "10")
        self.assertTrue(plan["refs"])
        self.assertNotIn("1", plan["branch"])
        self.assertNotIn("4", plan["branch"])
        self.assertNotIn("5", plan["branch"])

    def test_batch_gives_each_item_its_own_refs(self):
        items = [
            {"key": "k0", "prompt": "p0", "seed": 1, "refs": ["face_a.png"]},
            {"key": "k1", "prompt": "p1", "seed": 2, "refs": ["face_b.png", "scene.png"]},
            {"key": "k2", "prompt": "p2", "seed": 3},
        ]
        batch, branches, report = imagegen.build_batch(qwen21_graph(), items, width=1024, height=576, steps=2)
        self.assertEqual(len(branches), 3)
        self.assertEqual(len(set(batch)), len(batch), "节点 id 撞车了")
        self.assertTrue(report["refs"])

        def refs_of(branch):
            enc = batch[branch["positive"]]["inputs"]
            names = []
            for key in sorted(k for k in enc if k.startswith("images.")):
                node = batch[enc[key][0]]
                self.assertEqual(node["class_type"], "LoadImage")
                names.append(node["inputs"]["image"])
            return names

        self.assertEqual(refs_of(branches[0]), ["face_a.png"])
        self.assertEqual(refs_of(branches[1]), ["face_b.png", "scene.png"])
        self.assertEqual(refs_of(branches[2]), [], "没给参考图的段不能蹭别人的脸")

        # 每条支路的提示词都要落在自己的编码器上
        for br, item in zip(branches, items):
            self.assertEqual(batch[br["positive"]]["inputs"]["prompt"], item["prompt"])

    def test_batch_negative_stays_on_encoder(self):
        graph = qwen21_graph()
        batch, branches, report = imagegen.build_batch(
            graph, [{"key": "a", "prompt": "p"}], negative="模糊"
        )
        enc_id = branches[0]["positive"]
        self.assertEqual(batch[enc_id]["inputs"]["negative_prompt"], "模糊")
        # 16 个原始节点 + 0 新节点（负向不新建）
        self.assertEqual(len(batch), len(graph))


class LatentAlignTest(unittest.TestCase):
    """宽高必须齐到 16 —— 否则出图尺寸会被 ComfyUI 悄悄改掉。

    链路：EmptyLatentImage 出 1/8 的 4 通道 + downscale_ratio_spacial=8，
    fix_empty_latent_channels 用这个 8 把 latent 缩一半补到 64 通道（1/16），
    缩的时候是 round()：
        1032x584 -> latent 36x64      -> 实得 1024x576
        1000x562 -> latent 35x62      -> 实得  992x560
    调用方要是照着自己给的宽高写文案，图就跟文案对不上了。
    """

    def test_align_helper(self):
        f = imagegen._align_latent_side
        self.assertEqual(f(1024), 1024)
        self.assertEqual(f(576), 576)
        self.assertEqual(f(1032), 1040)   # 64.5 格 -> 65 格，.5 一律向上
        self.assertEqual(f(1000), 1008)  # 62.5 格 -> 63 格
        self.assertEqual(f(1008), 1008)
        self.assertEqual(f("768"), 768)   # 表单里常是字符串
        self.assertEqual(f(8), 16)        # 小于一步的兜到 16，别给 0

    def test_apply_prompt_aligns_and_reports(self):
        graph = qwen21_graph()
        report = imagegen.apply_prompt(graph, prompt="p", width=1032, height=584)
        self.assertEqual(graph["7"]["inputs"]["width"], 1040)
        self.assertEqual(graph["7"]["inputs"]["height"], 592)
        self.assertEqual(report["size_px"], [1040, 592])
        self.assertTrue(
            any("1032" in n and "1040" in n for n in report["notes"]),
            "对齐了就要说，别让调用方以为自己拿到了 1032：%s" % report["notes"],
        )

    def test_default_size_is_1280x720(self):
        """不传宽高就用工作流的值 —— 统一成 1280×720（92 万像素）。"""
        graph = qwen21_graph()
        report = imagegen.apply_prompt(graph, prompt="p")
        self.assertEqual(
            (graph["7"]["inputs"]["width"], graph["7"]["inputs"]["height"]), (1280, 720)
        )
        self.assertEqual(report["size_px"], [1280, 720])
        self.assertFalse([n for n in report["notes"] if "对齐" in n], "默认值本来就该是齐的")

    def test_apply_prompt_keeps_aligned_value_quiet(self):
        graph = qwen21_graph()
        report = imagegen.apply_prompt(graph, prompt="p", width=768, height=432)
        self.assertEqual((graph["7"]["inputs"]["width"], graph["7"]["inputs"]["height"]), (768, 432))
        self.assertFalse([n for n in report["notes"] if "对齐" in n], "本来就对齐的不该报警")

    def test_apply_prompt_aligns_workflow_leftover(self):
        """只给宽不给高时，工作流里那半边的原值也得对齐。"""
        graph = qwen21_graph()
        graph["7"]["inputs"]["height"] = 1000
        report = imagegen.apply_prompt(graph, prompt="p", width=1280)
        self.assertEqual(graph["7"]["inputs"]["width"], 1280)
        self.assertEqual(graph["7"]["inputs"]["height"], 1008)
        self.assertTrue(any("工作流原高" in n for n in report["notes"]))

    def test_build_batch_aligns_every_branch(self):
        graph = qwen21_graph()
        batch, branches, report = imagegen.build_batch(
            graph,
            [{"key": "a", "prompt": "p1"}, {"key": "b", "prompt": "p2"}],
            width=1032,
            height=584,
        )
        sizes = set()
        for bid in batch:
            inputs = batch[bid]["inputs"]
            if "width" in inputs and "height" in inputs:
                sizes.add((inputs["width"], inputs["height"]))
        self.assertTrue(sizes, "批量图里应当有空 latent 节点")
        self.assertEqual(sizes, {(1040, 592)}, "每条支路都得是 16 的倍数：%s" % sizes)


class ListWorkflowsTest(unittest.TestCase):
    def test_marks_ref_capability(self):
        graph = qwen21_graph()
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "user" / "default" / "workflows"
            folder.mkdir(parents=True)
            (folder / "qwen21.json").write_text(json.dumps(graph, ensure_ascii=False), encoding="utf-8")
            out = imagegen.list_workflows(tmp)
        entry = out["workflows"][0]
        self.assertEqual(entry["format"], "api")
        self.assertTrue(entry["t2i"])
        self.assertTrue(entry["edit"])
        self.assertEqual(entry["refs"], imagegen.MAX_REFS)
        self.assertEqual(entry["checkpoints"], ["qwen_image_2.1_int8_convrot.safetensors"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
