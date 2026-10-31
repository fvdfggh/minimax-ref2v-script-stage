"""imagegen 的单测：转换、注入、路径安全。

重点不是"能不能跑通"，而是**值有没有落到对的节点上** —— 这类转换一旦错位
（比如 steps 吃到了 sampler 的名字），出图不会报错，只会静默变差，
线上根本看不出来。所以这里对着真实工作流的节点结构逐项断言。
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import imagegen  # noqa: E402


# ---------------------------------------------------------------- 真实结构样本

# 取自 ComfyUI 实际保存的 "Krea2简易生成.json"（UI 格式），保留节点 id、连线、
# widgets_values 的原始形状 —— 换了 id 就测不出转换对不对了。
UI_WORKFLOW = {
    "nodes": [
        {"id": 8, "type": "ConditioningZeroOut", "widgets_values": None,
         "inputs": [{"name": "conditioning", "type": "CONDITIONING", "link": 12}],
         "outputs": [{"name": "CONDITIONING", "type": "CONDITIONING", "links": [8]}]},
        {"id": 3, "type": "VAEDecode", "widgets_values": None,
         "inputs": [{"name": "samples", "type": "LATENT", "link": 2},
                    {"name": "vae", "type": "VAE", "link": 3}],
         "outputs": [{"name": "IMAGE", "type": "IMAGE", "links": [4]}]},
        {"id": 14, "type": "Note", "widgets_values": ["说明文字"], "inputs": [], "outputs": []},
        {"id": 13, "type": "CLIPLoader",
         "widgets_values": ["qwen3vl_4b_int8_convrot.safetensors", "krea2", "default"],
         "inputs": [{"name": "clip_name", "type": "COMBO", "link": None},
                    {"name": "type", "type": "COMBO", "link": None},
                    {"name": "device", "type": "COMBO", "link": None}],
         "outputs": [{"name": "CLIP", "type": "CLIP", "links": [14]}]},
        {"id": 6, "type": "CLIPTextEncode", "widgets_values": ["原始提示词"],
         "inputs": [{"name": "clip", "type": "CLIP", "link": 14},
                    {"name": "text", "type": "STRING", "link": None}],
         "outputs": [{"name": "CONDITIONING", "type": "CONDITIONING", "links": [5, 12]}]},
        {"id": 4, "type": "VAELoader", "widgets_values": ["qwen_image_vae.safetensors"],
         "inputs": [{"name": "vae_name", "type": "COMBO", "link": None}],
         "outputs": [{"name": "VAE", "type": "VAE", "links": [3]}]},
        {"id": 2, "type": "KSampler", "widgets_values": [0, "fixed", 8, 1, "er_sde", "simple", 1],
         "inputs": [{"name": "model", "type": "MODEL", "link": 24},
                    {"name": "positive", "type": "CONDITIONING", "link": 5},
                    {"name": "negative", "type": "CONDITIONING", "link": 8},
                    {"name": "latent_image", "type": "LATENT", "link": 11},
                    {"name": "seed", "type": "INT", "link": None},
                    {"name": "steps", "type": "INT", "link": None},
                    {"name": "cfg", "type": "FLOAT", "link": None},
                    {"name": "sampler_name", "type": "COMBO", "link": None},
                    {"name": "scheduler", "type": "COMBO", "link": None},
                    {"name": "denoise", "type": "FLOAT", "link": None}],
         "outputs": [{"name": "LATENT", "type": "LATENT", "links": [2]}]},
        {"id": 5, "type": "PreviewImage", "widgets_values": [],
         "inputs": [{"name": "images", "type": "IMAGE", "link": 4}], "outputs": []},
        {"id": 1, "type": "UNETLoader",
         "widgets_values": ["krea2_turbo_int8_convrot.safetensors", "default"],
         "inputs": [{"name": "unet_name", "type": "COMBO", "link": None},
                    {"name": "weight_dtype", "type": "COMBO", "link": None}],
         "outputs": [{"name": "MODEL", "type": "MODEL", "links": [20, 24]}]},
        {"id": 10, "type": "EmptyLatentImage", "widgets_values": [1280, 720, 1],
         "inputs": [{"name": "width", "type": "INT", "link": None},
                    {"name": "height", "type": "INT", "link": None},
                    {"name": "batch_size", "type": "INT", "link": None}],
         "outputs": [{"name": "LATENT", "type": "LATENT", "links": [11]}]},
    ],
    "links": [
        [2, 2, 0, 3, 0, "LATENT"], [3, 4, 0, 3, 1, "VAE"], [4, 3, 0, 5, 0, "IMAGE"],
        [5, 6, 0, 2, 1, "CONDITIONING"], [8, 8, 0, 2, 2, "CONDITIONING"],
        [11, 10, 0, 2, 3, "LATENT"], [12, 6, 0, 8, 0, "CONDITIONING"],
        [14, 13, 0, 6, 0, "CLIP"], [24, 1, 0, 2, 0, "MODEL"],
    ],
}

# /object_info 的等价切片。KSampler 的 seed 带 control_after_generate —— 这是
# widgets_values 里那个 'fixed' 从哪来的唯一线索。
OBJECT_INFO = {
    "KSampler": {
        "input": {
            "required": {
                "model": ["MODEL"],
                "seed": ["INT", {"default": 0, "control_after_generate": True}],
                "steps": ["INT", {"default": 20}],
                "cfg": ["FLOAT", {"default": 8.0}],
                "sampler_name": [["euler", "er_sde", "dpmpp_2m"]],
                "scheduler": [["simple", "normal", "karras"]],
                "positive": ["CONDITIONING"],
                "negative": ["CONDITIONING"],
                "latent_image": ["LATENT"],
                "denoise": ["FLOAT", {"default": 1.0}],
            }
        }
    },
    "CLIPTextEncode": {"input": {"required": {"clip": ["CLIP"], "text": ["STRING", {"multiline": True}]}}},
    "EmptyLatentImage": {
        "input": {"required": {"width": ["INT", {"default": 512}], "height": ["INT", {"default": 512}], "batch_size": ["INT", {"default": 1}]}}
    },
    "CLIPLoader": {"input": {"required": {"clip_name": [["a.safetensors"]], "type": [["krea2"]], "device": [["default"]]}}},
    "VAELoader": {"input": {"required": {"vae_name": [["qwen_image_vae.safetensors"]]}}},
    "UNETLoader": {"input": {"required": {"unet_name": [["krea2_turbo_int8_convrot.safetensors"]], "weight_dtype": [["default"]]}}},
    "VAEDecode": {"input": {"required": {"samples": ["LATENT"], "vae": ["VAE"]}}},
    "PreviewImage": {"input": {"required": {"images": ["IMAGE"]}}},
    "ConditioningZeroOut": {"input": {"required": {"conditioning": ["CONDITIONING"]}}},
}


def _convert() -> dict:
    return imagegen.ui_to_api(UI_WORKFLOW, OBJECT_INFO)[0]


class UiToApiTest(unittest.TestCase):
    def test_skips_ui_only_nodes(self):
        graph = _convert()
        self.assertNotIn("14", graph, "Note 节点不该被提交")
        self.assertEqual(len(graph), 9)

    def test_widget_values_land_on_right_inputs(self):
        ks = _convert()["2"]
        self.assertEqual(ks["class_type"], "KSampler")
        self.assertEqual(ks["inputs"]["seed"], 0)
        self.assertEqual(ks["inputs"]["steps"], 8, "steps 不能吃到骰子值 'fixed'")
        self.assertEqual(ks["inputs"]["cfg"], 1)
        self.assertEqual(ks["inputs"]["sampler_name"], "er_sde")
        self.assertEqual(ks["inputs"]["scheduler"], "simple")
        self.assertEqual(ks["inputs"]["denoise"], 1)
        self.assertNotIn("control_after_generate", ks["inputs"])

    def test_links_become_pairs(self):
        graph = _convert()
        self.assertEqual(graph["2"]["inputs"]["positive"], ["6", 0])
        self.assertEqual(graph["2"]["inputs"]["negative"], ["8", 0])
        self.assertEqual(graph["2"]["inputs"]["latent_image"], ["10", 0])
        self.assertEqual(graph["6"]["inputs"]["clip"], ["13", 0])
        self.assertEqual(graph["6"]["inputs"]["text"], "原始提示词")
        self.assertEqual(graph["10"]["inputs"]["width"], 1280)

    def test_control_after_generate_as_standalone_entry(self):
        info = json.loads(json.dumps(OBJECT_INFO))
        seed = info["KSampler"]["input"]["required"]["seed"]
        seed[1] = {"default": 0}  # 老版本：种子后面没有骰子标记
        info["KSampler"]["input"]["required"] = {
            "model": ["MODEL"],
            "seed": seed,
            "control_after_generate": [["fixed", "increment", "decrement", "randomize"]],
            "steps": info["KSampler"]["input"]["required"]["steps"],
            "cfg": info["KSampler"]["input"]["required"]["cfg"],
            "sampler_name": info["KSampler"]["input"]["required"]["sampler_name"],
            "scheduler": info["KSampler"]["input"]["required"]["scheduler"],
            "positive": ["CONDITIONING"],
            "negative": ["CONDITIONING"],
            "latent_image": ["LATENT"],
            "denoise": info["KSampler"]["input"]["required"]["denoise"],
        }
        graph = imagegen.ui_to_api(UI_WORKFLOW, info)[0]
        self.assertEqual(graph["2"]["inputs"]["seed"], 0)
        self.assertEqual(graph["2"]["inputs"]["control_after_generate"], "fixed")
        self.assertEqual(graph["2"]["inputs"]["steps"], 8)

    def test_reroute_is_followed_not_submitted(self):
        data = {
            "nodes": [
                {"id": 1, "type": "CLIPLoader", "widgets_values": ["a", "b", "c"], "inputs": [],
                 "outputs": [{"name": "CLIP", "type": "CLIP", "links": [1]}]},
                {"id": 2, "type": "Reroute", "inputs": [{"name": "", "type": "*", "link": 1}],
                 "outputs": [{"name": "", "type": "CLIP", "links": [2]}]},
                {"id": 3, "type": "CLIPTextEncode", "widgets_values": ["hi"],
                 "inputs": [{"name": "clip", "type": "CLIP", "link": 2}], "outputs": []},
            ],
            "links": [[1, 1, 0, 2, 0, "CLIP"], [2, 2, 0, 3, 0, "CLIP"]],
        }
        graph = imagegen.ui_to_api(data, OBJECT_INFO)[0]
        self.assertNotIn("2", graph)
        self.assertEqual(graph["3"]["inputs"]["clip"], ["1", 0])

    def test_primitive_node_becomes_literal(self):
        data = {
            "nodes": [
                {"id": 1, "type": "EmptyLatentImage", "widgets_values": [512, 512, 1],
                 "inputs": [{"name": "width", "type": "INT", "link": 9},
                            {"name": "height", "type": "INT", "link": None},
                            {"name": "batch_size", "type": "INT", "link": None}], "outputs": []},
                {"id": 2, "type": "PrimitiveNode", "widgets_values": [832], "inputs": [], "outputs": []},
            ],
            "links": [[9, 2, 0, 1, 0, "INT"]],
        }
        graph = imagegen.ui_to_api(data, OBJECT_INFO)[0]
        self.assertEqual(graph["1"]["inputs"]["width"], 832)

    def test_unknown_format_is_rejected(self):
        self.assertEqual(imagegen._as_graph({"hello": "world"})[0], "unknown")
        self.assertEqual(imagegen._as_graph({"prompt": {"1": {"class_type": "X", "inputs": {}}}})[0], "api")


class InjectTest(unittest.TestCase):
    def test_prompt_size_seed_steps(self):
        graph = _convert()
        report = imagegen.apply_prompt(
            graph, prompt="雨夜霓虹街道", negative="blurry", width=1024, height=576, seed=42, steps=6
        )
        self.assertEqual(graph["6"]["inputs"]["text"], "雨夜霓虹街道")
        self.assertEqual(graph["10"]["inputs"]["width"], 1024)
        self.assertEqual(graph["10"]["inputs"]["height"], 576)
        self.assertEqual(graph["2"]["inputs"]["seed"], 42)
        self.assertEqual(graph["2"]["inputs"]["steps"], 6)
        self.assertEqual(report["positive"], "6")
        self.assertEqual(report["size"], "10")

        # 负向：原来和正向共用节点 6，必须新建而不是改 6
        neg_id = report["negative"]
        self.assertIsNotNone(neg_id)
        self.assertNotEqual(neg_id, "6")
        self.assertEqual(graph[neg_id]["inputs"]["text"], "blurry")
        self.assertEqual(graph[neg_id]["inputs"]["clip"], ["13", 0])
        self.assertEqual(graph["2"]["inputs"]["negative"], [neg_id, 0])
        self.assertEqual(graph["6"]["inputs"]["text"], "雨夜霓虹街道", "正向不能被负向串改")

    def test_no_negative_leaves_zeroout_alone(self):
        graph = _convert()
        report = imagegen.apply_prompt(graph, prompt="x")
        self.assertIsNone(report["negative"])
        self.assertEqual(graph["2"]["inputs"]["negative"], ["8", 0])

    def test_separate_negative_node_is_edited_in_place(self):
        data = json.loads(json.dumps(UI_WORKFLOW))
        data["nodes"].append(
            {"id": 20, "type": "CLIPTextEncode", "widgets_values": ["bad"],
             "inputs": [{"name": "clip", "type": "CLIP", "link": 30},
                        {"name": "text", "type": "STRING", "link": None}], "outputs": []}
        )
        data["links"].append([30, 13, 0, 20, 0, "CLIP"])
        data["links"].append([31, 20, 0, 2, 2, "CONDITIONING"])
        for node in data["nodes"]:
            if node["id"] == 2:
                node["inputs"] = [
                    i if i["name"] != "negative" else {"name": "negative", "type": "CONDITIONING", "link": 31}
                    for i in node["inputs"]
                ]
        graph = imagegen.ui_to_api(data, OBJECT_INFO)[0]
        report = imagegen.apply_prompt(graph, prompt="p", negative="ugly")
        self.assertEqual(report["negative"], "20")
        self.assertEqual(graph["20"]["inputs"]["text"], "ugly")
        self.assertEqual(len([n for n in graph if n == "20"]), 1)

    def test_workflow_without_text_node_fails_loudly(self):
        graph = {"1": {"class_type": "KSampler", "inputs": {"positive": ["2", 0], "negative": ["2", 0]}},
                 "2": {"class_type": "ConditioningZeroOut", "inputs": {}}}
        with self.assertRaises(imagegen.ImageGenError):
            imagegen.apply_prompt(graph, prompt="x")


class WorkflowFileTest(unittest.TestCase):
    def test_workflow_name_cannot_escape_workflows_dir(self):
        with self.assertRaises(imagegen.ImageGenError):
            imagegen.load_workflow(str(Path.home()), "../../etc/passwd")

    def test_list_workflows_on_missing_root(self):
        out = imagegen.list_workflows(str(Path.home() / "__no_such_comfy__"))
        self.assertFalse(out["exists"])
        self.assertEqual(out["workflows"], [])


def _upstream(graph: dict, nid: str) -> set[str]:
    """从某节点往上游能摸到的所有节点。"""
    seen: set[str] = set()
    stack = [nid]
    while stack:
        cur = stack.pop()
        for value in (graph.get(cur, {}).get("inputs") or {}).values():
            if isinstance(value, list) and len(value) == 2 and str(value[0]) in graph:
                src = str(value[0])
                if src not in seen:
                    seen.add(src)
                    stack.append(src)
    return seen


class BatchTest(unittest.TestCase):
    ITEMS = [
        {"key": "b1", "prompt": "雨夜便利店", "seed": 11},
        {"key": "b2", "prompt": "清晨车站", "seed": 22},
        {"key": "b3", "prompt": "午后教室", "seed": 33},
    ]

    def _build(self, **kw):
        graph = _convert()
        return graph, imagegen.build_batch(graph, self.ITEMS, **kw)

    def test_one_branch_per_item_sharing_loaders(self):
        _graph, (batch, branches, report) = self._build(width=1024, height=576, steps=6)
        self.assertEqual(len(branches), 3)
        self.assertEqual([b["key"] for b in branches], ["b1", "b2", "b3"])
        # 加载器只留一份：批量之所以省时间，全在这三行上
        for nid in ("1", "13", "4"):
            self.assertEqual(sum(1 for k in batch if k == nid), 1, f"节点 {nid} 被复制了")
        self.assertEqual(sorted(report["shared"], key=int), ["1", "4", "13"])
        # 每条支路各有一个采样器 / 文本编码器 / 出口
        self.assertEqual(len([n for n in batch.values() if n["class_type"] == "KSampler"]), 3)
        self.assertEqual(len([n for n in batch.values() if n["class_type"] == "PreviewImage"]), 3)
        # 节点 id 不能撞车（撞了 ComfyUI 会静默丢掉一条支路）
        self.assertEqual(len(set(batch)), len(batch))

    def test_prompt_seed_size_per_branch(self):
        _graph, (batch, branches, _report) = self._build(width=1024, height=576, steps=6)
        for br, item in zip(branches, self.ITEMS):
            pos = batch[br["positive"]]
            self.assertEqual(pos["inputs"]["text"], item["prompt"])
            s_in = batch[br["sampler"]]["inputs"]
            self.assertEqual(s_in["seed"], item["seed"])
            self.assertEqual(s_in["steps"], 6)
            # 尺寸改在支路自己的空 latent 上，不能指到别人的
            latent_id = str(s_in["latent_image"][0])
            self.assertEqual(batch[latent_id]["inputs"]["width"], 1024)
            self.assertEqual(batch[latent_id]["inputs"]["height"], 576)
        # 三条支路的 latent 互不相同
        self.assertEqual(len({str(batch[b["sampler"]]["inputs"]["latent_image"][0]) for b in branches}), 3)

    def test_barrier_makes_every_sampler_wait_for_every_encoder(self):
        _graph, (batch, branches, report) = self._build()
        self.assertIsNotNone(report["barrier"], "三条支路应该加编码屏障")
        text_nodes = {br["positive"] for br in branches}
        for br in branches:
            up = _upstream(batch, br["sampler"])
            missing = text_nodes - up
            self.assertFalse(
                missing,
                f"采样器 {br['sampler']} 没等编码器 {missing}：这条支路会先采再编码",
            )
        # 屏障本身不能改画面：strength 必须正好是 1.0（输出 == conditioning_to）
        avgs = [n for n in batch if batch[n]["class_type"] == "ConditioningAverage"]
        self.assertTrue(avgs)
        for nid in avgs:
            self.assertEqual(batch[nid]["inputs"]["conditioning_to_strength"], 1.0)

    def test_barrier_also_covers_negative_encoders(self):
        """负向也是编码产物：漏在采样阶段编码，CLIP 可能已经被挤掉了。"""
        _graph, (batch, branches, report) = self._build(negative="blurry")
        self.assertIsNotNone(report["barrier"])
        negs = {str(batch[b["sampler"]]["inputs"]["negative"][0]) for b in branches}
        for br in branches:
            up = _upstream(batch, br["sampler"])
            self.assertFalse(
                negs - up,
                f"采样器 {br['sampler']} 没等负向编码器 {negs - up}",
            )

    def test_no_barrier_when_disabled(self):
        _graph, (batch, branches, report) = self._build(encode_barrier=False)
        self.assertIsNone(report["barrier"])
        self.assertEqual(
            len([n for n in batch.values() if n["class_type"] == "ConditioningAverage"]), 0
        )
        # 关掉屏障后采样器直接吃编码器
        self.assertEqual(batch[branches[0]["sampler"]]["inputs"]["positive"], [branches[0]["positive"], 0])

    def test_negative_gets_its_own_encoder_per_branch(self):
        _graph, (batch, branches, _r) = self._build(negative="blurry, low quality")
        neg_refs = set()
        for br in branches:
            ref = batch[br["sampler"]]["inputs"]["negative"]
            self.assertIsInstance(ref, list)
            neg_id = str(ref[0])
            self.assertNotEqual(neg_id, br["positive"], "负向不能用正向的节点")
            self.assertEqual(batch[neg_id]["inputs"]["text"], "blurry, low quality")
            neg_refs.add(neg_id)
        self.assertEqual(len(neg_refs), 3, "每条支路要有自己的负向编码器")

    def test_many_items_with_negative_get_unique_ids(self):
        """六条 + 负向是踩过的坑：按"支路号*1000"发号会在第 6 条撞上负向编码器。

        撞了不会报错，只会让两个节点互相覆盖，出图莫名其妙 ——
        真机上表现为 ComfyUI 回 "Return type mismatch between linked nodes"。
        """
        graph = _convert()
        items = [
            {"key": f"k{i}", "prompt": f"p{i}", "seed": 100 + i} for i in range(6)
        ]
        batch, branches, report = imagegen.build_batch(
            graph, items, negative="blurry", width=768, height=448, steps=4
        )
        self.assertEqual(len(branches), 6)
        self.assertEqual(len(set(batch)), len(batch), "节点 id 撞车了")
        # 每条支路的采样器都要能追到 6 个正向 + 6 个负向编码结果
        for br in branches:
            up = _upstream(batch, br["sampler"])
            for other in branches:
                self.assertIn(other["positive"], up)
                neg_ref = str(batch[other["sampler"]]["inputs"]["negative"][0])
                self.assertIn(neg_ref, up)

    def test_single_item_equals_plain_run(self):
        graph = _convert()
        batch, branches, report = imagegen.build_batch(graph, [self.ITEMS[0]], width=1024, height=576)
        self.assertEqual(len(branches), 1)
        self.assertIsNone(report["barrier"], "一条支路不需要屏障")
        self.assertEqual(batch["6"]["inputs"]["text"], "雨夜便利店")
        self.assertEqual(batch["10"]["inputs"]["width"], 1024)

    def test_plan_branch_keeps_model_untouched(self):
        graph = _convert()
        plan = imagegen.plan_branch(graph)
        self.assertEqual(plan["sampler"], "2")
        self.assertEqual(plan["pos_text"], "6")
        self.assertEqual(plan["latent"], "10")
        self.assertEqual(plan["sink"], "5")
        self.assertNotIn("1", plan["branch"], "UNETLoader 不能进支路")
        self.assertNotIn("13", plan["branch"], "CLIPLoader 不能进支路")
        self.assertIn("8", plan["branch"], "ConditioningZeroOut 属于支路，要跟着复制")


if __name__ == "__main__":
    unittest.main(verbosity=2)
