"""Qwen-Image-2.1 二步出图：用 ComfyUI 的 python 环境跑，**不起 ComfyUI 服务**。

为什么不起 ComfyUI：
    ComfyUI 的节点是纯 python 类，`comfy.sd` 管加载、`comfy.sample` 管采样。
    生图这条链只有 6 个节点 —— 为它起一个 HTTP 服务、让服务把 prompt 再转回
    进程里执行，纯属绕路：多一个 4GB 常驻进程、多一个端口、多一次序列化，
    而显存和卡还是同一张。这里 import 同一套代码直接跑。

    `--spec`：一次性模式，跑完退出（探针、单人单图、排障用）。
    `--serve`：常驻模式，stdin/stdout 收发 JSON，模型按需装卸（默认）。

两种模式共用 `Engine`，所以「工作流长什么样」只有一处定义。

与工作流的一致性：
    步骤照抄 `user/default/workflows/▶Qwen2.1_2步_生成与编辑.json`：
        UNETLoader → LoraLoaderModelOnly(1.0) → ModelSamplingAuraFlow(3.0)
        → TextEncodeQwenImage21（positive/negative 同一节点）
        → EmptyLatentImage → KSampler(euler / simple / 2 步 / cfg 1.0)
        → VAEDecode
    改工作流就改这里，两处不要走偏。

    注意 `EmptyLatentImage` 交出来的是 1/8 的 4 通道 latent，
    `common_ksampler` 会交给 `fix_empty_latent_channels` 缩到 1/16、补到 64 通道。
    所以**不要**自己 zeros 一个 latent，否则 token 数翻 4 倍、出图尺寸翻倍。

显存（T10 16G 的硬约束，决定了下面为什么必须三段）：
    CLIP 8.8G + UNet 6.8G + VAE 0.6G = 16.2G，装不下同一时刻。
    所以顺序被显存锁死：**先把所有 prompt 全部编码完 → 卸 CLIP → 装 UNet
    把所有图采样完 → 卸 UNet → 装 VAE 全部解码**。
    这条顺序不是为了好看：TE 第 1 条要 19s（首次前向的 kernel 编译 / 权重首次调页），
    第 2 条起只要 1s；UNet 采样同理第 1 张 12s、之后每张 4.75s。
    一次只编一条就等于把 18s 和 7s 的固定成本乘以张数。

    实测（960²，GPU3 = T10）：
        冷启动 import torch+comfy      22.5s   ← 常驻进程后归零
        load_clip(8.8G)                 1.3s   ← mmap，不是瓶颈
        TE 第 1 条（带参考图）          19.5s   ← 第 2 条起 0.98s
        load_unet(6.8G)                 0.3s
        sample 第 1 张                  12.2s   ← 之后每张 4.75s
        vae.decode 每张                 4.8s

    批量采样没有吞吐红利：BATCH 2/4/6 每张都是 4.75s（T10 算力打满，compute-bound），
    所以**不需要把 N 条 cond 拼成一个 batch**，逐条采样即可 —— 省下的是
    「模型只装一次」，不是「一次算更多」。拼 batch 的复杂度换不来时间。

用法：
    python qwen21_inproc.py --spec <规格.json>
    规格：{"prompt" 或 "prompts": [...], "negative", "width", "height",
           "seed", "steps", "cfg", "out" 或 "outDir", "refs", "comfyRoot",
           "unet", "lora", "clip", "vae"}
    一次性模式：成功最后一行打印 {"ok": true, ...}；失败打印 {"ok": false, ...} 退出码 1。

    python qwen21_inproc.py --serve
    stdin 一行一个请求，stdout 一行一个响应。请求 op：
        {"op":"ping"}                      → 探活，不碰显存
        {"op":"run", "prompts": [...]}     → 出图（也接受单条 "prompt"）
        {"op":"unload"}                    → 卸模型，进程留着
        {"op":"quit"}                      → 退出
    启动成功会先输出一行 {"ok":true,"op":"ready"}，调用方据此握手。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import traceback
from pathlib import Path

#: 工作流里写死的默认值。规格里没给就用这些 —— 和 ▶Qwen2.1_2步 保持一致
DEF_UNET = "qwen_image_2.1_int8_convrot.safetensors"
DEF_LORA = "Qwen-Image-2.1-sarvam-tez-2step-lora-r256.safetensors"
DEF_CLIP = "qwen3vl_8b_int8_convrot.safetensors"
DEF_VAE = "qwen_image_2.1_vae_bf16.safetensors"
DEF_SHIFT = 3.0
DEF_STEPS = 2
DEF_CFG = 1.0

#: 空闲多久把模型请下卡（秒）。进程留着 —— 下次再装只要 1.3s，
#: 而重新起进程要付 22.5s 的 import。
DEF_IDLE_UNLOAD = 90.0


def log(msg: str) -> None:
    """进度打到 stderr：stdout 只留给协议那几行 JSON。"""
    print(f"[qwen21] {msg}", file=sys.stderr, flush=True)


def _resolve(folder_paths, kind: str, name: str) -> str:
    path = folder_paths.get_full_path(kind, name)
    if not path or not Path(path).is_file():
        raise FileNotFoundError(f"找不到模型 {kind}/{name}（ComfyUI 的 models 目录里没有）")
    return path


def _load_refs(paths: list[str], torch_mod):
    """参考图 → [1,H,W,C] 的 0..1 张量，键名 image_1、image_2 …

    尺寸不在这里改：`TextEncodeQwenImage21` 会按 resolution 把每张缩到
    32 的倍数（同一套尺寸还要喂给 VAE 编 latent），这里改一遍只会让两边不一致。
    """
    from PIL import Image  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    out = {}
    for i, p in enumerate(paths[:8], start=1):
        img = Image.open(p).convert("RGB")
        arr = np.asarray(img).astype("float32") / 255.0
        out[f"image_{i}"] = torch_mod.from_numpy(arr).unsqueeze(0)
    return out


class Engine:
    """把「三阶段 + 模型缓存」封起来，一次性模式和常驻模式共用。

    模型缓存的意义：CLIP 和 UNet 在同一张 16G 卡上互斥，但**同一批请求内**
    只各装一次。第二次请求如果模型还在卡上，装 0s。
    """

    def __init__(self, root: str):
        self.root = root
        sys.path.insert(0, root)
        os.chdir(root)

        t = time.time()
        import torch  # noqa: PLC0415

        import comfy.model_management as mm  # noqa: PLC0415
        import comfy.sd  # noqa: PLC0415
        import comfy.utils  # noqa: PLC0415
        import folder_paths  # noqa: PLC0415
        import nodes as N  # noqa: PLC0415
        from comfy_extras.nodes_model_advanced import ModelSamplingAuraFlow  # noqa: PLC0415
        from comfy_extras.nodes_qwen import TextEncodeQwenImage21  # noqa: PLC0415

        self.torch = torch
        self.mm = mm
        self.folder_paths = folder_paths
        self.N = N
        self.ModelSamplingAuraFlow = ModelSamplingAuraFlow
        self.TextEncodeQwenImage21 = TextEncodeQwenImage21
        self.import_s = time.time() - t

        self._clip = None
        self._clip_key = ""
        self._unet = None
        self._unet_key = ""
        self._vae = None
        self._vae_key = ""
        #: run() 里按请求填，encode/decode 从这里取名字
        self._clip_name = DEF_CLIP
        self._vae_name = DEF_VAE
        self._lock = threading.RLock()
        self._last_use = time.time()
        #: tiled 解码的块大小 / 重叠（像素）。tile 越小峰值显存越低、块间重叠开销越大。
        #: 实测（GPU3 = T10）960²：tile 256→7.02s、512→3.27s、1024→2.48s；
        #: 1280×720：512→4.37s、1024→2.60s、1536→2.38s。
        #: 1536 能把 960² 和 1280×720 都罩成一块，再大没收益。
        self.tile_size = int(os.environ.get("QWEN21_TILE") or 1536)
        self.tile_overlap = int(os.environ.get("QWEN21_TILE_OVERLAP") or 64)

        log(f"import 完成 {self.import_s:.1f}s，设备 {mm.get_torch_device()}，"
            f"可用 {mm.get_free_memory(mm.get_torch_device()) / 1048576:.0f} MiB")

    # ------------------------------------------------------------ 模型装卸

    def _drop(self, *names: str) -> None:
        """把指定模型请下卡。逐个置 None 再让 comfy 统一收尾。

        只置 None 不够：ComfyUI 的 `current_loaded_models` 自己攥着 ModelPatcher，
        必须走 `unload_all_models()` 才会真的把权重搬下卡。少了这一步，
        上一段的 CLIP 8.8G 会和 UNet 6.8G 叠在卡上，VAE 一解码就 OOM。
        """
        import gc  # noqa: PLC0415

        for n in names:
            if n == "unet":
                self._unet = None
                self._unet_key = ""
            elif n == "clip":
                self._clip = None
                self._clip_key = ""
            elif n == "vae":
                self._vae = None
                self._vae_key = ""
        # python 侧引用断干净，再让 comfy 卸它自己那份，最后把缓存块还给驱动
        gc.collect()
        self.mm.unload_all_models()
        gc.collect()
        self.mm.soft_empty_cache(force=True)

    def _ensure_clip(self, name: str):
        """装文本编码器。它和 UNet/VAE 互斥 —— 8.8G 装下就没地方放别的。"""
        key = name
        if self._clip is not None and self._clip_key == key:
            return self._clip
        if self._unet is not None or self._vae is not None:
            self._drop("unet", "vae")
        t = time.time()
        (self._clip,) = self.N.CLIPLoader().load_clip(name, "qwen_image", "default")
        self._clip_key = key
        log(f"装 CLIP {time.time() - t:.1f}s，可用 {self.free_mb()} MiB")
        return self._clip

    def _ensure_unet(self, name: str, lora: str, shift: float):
        key = f"{name}|{lora}|{shift}"
        if self._unet is not None and self._unet_key == key:
            return self._unet
        if self._clip is not None or self._vae is not None:
            self._drop("clip", "vae")
        t = time.time()
        (model,) = self.N.UNETLoader().load_unet(name, "default")
        (model,) = self.N.LoraLoaderModelOnly().load_lora_model_only(model, lora, 1.0)
        (model,) = self.ModelSamplingAuraFlow().patch_aura(model, shift)
        self._unet = model
        self._unet_key = key
        log(f"装 UNet+LoRA {time.time() - t:.1f}s，可用 {self.free_mb()} MiB")
        return self._unet

    def _ensure_vae(self, name: str):
        if self._vae is not None and self._vae_key == name:
            return self._vae
        if self._clip is not None or self._unet is not None:
            self._drop("clip", "unet")
        t = time.time()
        (self._vae,) = self.N.VAELoader().load_vae(name)
        self._vae_key = name
        log(f"装 VAE {time.time() - t:.1f}s，可用 {self.free_mb()} MiB")
        return self._vae

    def unload_all(self, why: str = "") -> None:
        with self._lock:
            if self._clip is None and self._unet is None and self._vae is None:
                return
            self._drop("clip", "unet", "vae")
            log(f"模型已卸载{('（' + why + '）') if why else ''}，"
                f"可用 {self.mm.get_free_memory(self.mm.get_torch_device()) / 1048576:.0f} MiB")

    def free_mb(self) -> int:
        return self.mm.get_free_memory(self.mm.get_torch_device()) // 1048576

    # ------------------------------------------------------------ 单阶段

    def encode(self, prompt: str, negative: str, refs: list[str], resolution: int):
        """一条 prompt → (positive, negative)。参考图要过 VAE 编成 latent 拼进序列。"""
        clip = self._ensure_clip(self._clip_name)
        images = {}
        vae_enc = None
        if refs:
            vae_enc = self._ensure_vae(self._vae_name)
            images = _load_refs(refs, self.torch)
        out = self.TextEncodeQwenImage21.execute(
            clip=clip,
            prompt=prompt,
            negative_prompt=negative,
            vae=vae_enc,
            resolution=resolution,
            images=images,
        )
        pos, neg, _hint = out.args
        return pos, neg

    def sample(self, pos, neg, width: int, height: int, seed: int, steps: int,
               cfg: float, sampler: str, scheduler: str):
        latent = self.N.EmptyLatentImage().generate(width, height, 1)[0]
        (out,) = self.N.common_ksampler(
            self._unet, seed, steps, cfg, sampler, scheduler, pos, neg, latent, denoise=1.0
        )
        return out

    def decode(self, sampled) -> tuple:
        """解码一张图。

        为什么直接走 tiled、不先试整图：
            Qwen-Image 的 VAE 在中高分辨率层带 self-attention，激活按 token 数
            平方涨。960² 整图解码实测要吃满 16G（OOM 时只剩 24MB），
            这不是显存没释放 —— 装 VAE 后可用 16025 MiB 是干净的。
            ComfyUI 的 `vae.decode` 会先试整图、OOM 了再退到 tiled，那一次
            失败要白扔几百毫秒还要清一次缓存；这里直接进 tiled。
        """
        vae = self._ensure_vae(self._vae_name)
        (img,) = self.N.VAEDecodeTiled().decode(
            vae=vae, samples=sampled, tile_size=self.tile_size, overlap=self.tile_overlap
        )
        arr = (img[0].detach().cpu().clamp(0, 1) * 255.0).round().to(self.torch.uint8).numpy()
        return arr

    # ------------------------------------------------------------ 批量主流程

    def run(self, req: dict) -> dict:
        """一个请求出一到多张图。

        顺序被显存锁死：全部 TE → 全部采样 → 全部解码，模型各装一次。
        中途不逐张切换模型 —— 那是把装/卸成本乘以张数。
        """
        t_all = time.time()
        root = str(req.get("comfyRoot") or "")
        if root and Path(root, "main.py").is_file() and Path(root).resolve() != Path(self.root).resolve():
            raise RuntimeError(f"常驻进程已绑定 {self.root}，不能中途换到 {root}")

        width = int(req.get("width") or 1280)
        height = int(req.get("height") or 720)
        width -= width % 16
        height -= height % 16
        steps = int(req.get("steps") or DEF_STEPS)
        cfg = float(req.get("cfg") if req.get("cfg") is not None else DEF_CFG)
        resolution = int(req.get("resolution") or 1024)
        sampler = str(req.get("sampler") or "euler")
        scheduler = str(req.get("scheduler") or "simple")
        shift = float(req.get("shift") or DEF_SHIFT)
        negative = str(req.get("negative") or "")

        self._clip_name = str(req.get("clip") or DEF_CLIP)
        self._vae_name = str(req.get("vae") or DEF_VAE)
        unet_name = str(req.get("unet") or DEF_UNET)
        lora_name = str(req.get("lora") or DEF_LORA)

        # 条目规范化：prompts[] 为主，兼容单条 prompt
        raw_items = req.get("items")
        if not isinstance(raw_items, list) or not raw_items:
            raw_items = []
            prompts = req.get("prompts")
            if isinstance(prompts, list) and prompts:
                for i, p in enumerate(prompts):
                    raw_items.append({"key": i, "prompt": p})
            else:
                raw_items.append({
                    "key": 0,
                    "prompt": req.get("prompt"),
                    "seed": req.get("seed"),
                    "refs": req.get("refs"),
                    "out": req.get("out"),
                })

        out_dir = Path(str(req.get("outDir") or ""))
        base_ts = int(time.time() * 1000)
        jobs = []
        for idx, item in enumerate(raw_items):
            if not isinstance(item, dict):
                raise ValueError(f"第 {idx + 1} 条不是对象")
            prompt = str(item.get("prompt") or req.get("prompt") or "").strip()
            if not prompt:
                raise ValueError(f"第 {idx + 1} 条 prompt 为空")
            seed = item.get("seed")
            seed = int(seed) if seed is not None else (int.from_bytes(os.urandom(4), "big") & 0x7FFFFFFF)
            refs = [str(x) for x in (item.get("refs") or req.get("refs") or []) if str(x)]
            out = item.get("out")
            if out:
                out_path = Path(str(out))
            else:
                if not str(out_dir):
                    raise ValueError("既没给 out 也没给 outDir")
                out_path = out_dir / f"qwen21-{base_ts}-{seed}-{idx}.png"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            jobs.append({
                "key": str(item.get("key") if item.get("key") is not None else idx),
                "prompt": prompt,
                "seed": seed,
                "refs": refs,
                "out": out_path,
            })

        n = len(jobs)
        log(f"批量 {n} 张 {width}×{height} {steps} 步，开始")

        # ---- 1. 全部编码（CLIP 只装一次，第 2 条起每条 ~1s） ----
        t = time.time()
        conds = []
        for j in jobs:
            conds.append(self.encode(j["prompt"], negative, j["refs"], resolution))
        te_s = time.time() - t
        log(f"编码 {n} 条完成 {te_s:.1f}s（均 {te_s / n:.1f}s）")

        # ---- 2. 全部采样（UNet 只装一次，第 2 张起每张 ~4.75s） ----
        unet = self._ensure_unet(unet_name, lora_name, shift)
        t = time.time()
        latents = []
        for j, (pos, neg) in zip(jobs, conds):
            latents.append(self.sample(pos, neg, width, height, j["seed"], steps,
                                       cfg, sampler, scheduler))
        sample_s = time.time() - t
        # cond 已经用完，别让它跟着 latent 一起占显存（latent 体积是它的百分之一）
        conds = None
        pos = neg = None
        log(f"采样 {n} 张完成 {sample_s:.1f}s（均 {sample_s / n:.1f}s）")

        # ---- 3. 全部解码（VAE 只装一次） ----
        t = time.time()
        results = []
        from PIL import Image  # noqa: PLC0415

        for j, lat in zip(jobs, latents):
            arr = self.decode(lat)
            Image.fromarray(arr).save(str(j["out"]), format="PNG")
            results.append({
                "key": j["key"],
                "path": str(j["out"]),
                "seed": j["seed"],
                "width": int(arr.shape[1]),
                "height": int(arr.shape[0]),
            })
        decode_s = time.time() - t
        log(f"解码+存图 {n} 张完成 {decode_s:.1f}s（均 {decode_s / n:.1f}s）")

        self._last_use = time.time()
        total = time.time() - t_all
        log(f"完工 {n} 张，总 {total:.1f}s（均 {total / n:.1f}s/张）")
        return {
            "ok": True,
            "images": results,
            "seconds": round(total, 2),
            "secondsPerImage": round(total / n, 2),
            "secondsText": round(te_s, 2),
            "secondsSample": round(sample_s, 2),
            "secondsDecode": round(decode_s, 2),
            "count": n,
            "width": width,
            "height": height,
            "steps": steps,
        }


# ---------------------------------------------------------------- 一次性模式


def run_once(spec: dict) -> dict:
    root = str(spec.get("comfyRoot") or os.environ.get("COMFY_ROOT") or "")
    if not root or not Path(root, "main.py").is_file():
        raise RuntimeError(f"comfyRoot 不对：{root or '（没给）'}")
    eng = Engine(root)
    out = str(spec.get("out") or "")
    if out:
        spec.setdefault("items", [{"key": 0, "prompt": spec.get("prompt"),
                                   "seed": spec.get("seed"), "refs": spec.get("refs"),
                                   "out": out}])
    res = eng.run(spec)
    eng.unload_all("一次性模式收工")
    if len(res["images"]) == 1:
        res["path"] = res["images"][0]["path"]
    return res


# ---------------------------------------------------------------- 常驻模式


def serve() -> int:
    """常驻：import 一次，之后每个请求只付模型装卸。

    stdout 只写协议 JSON；把 sys.stdout 顶到 stderr，免得 torch / comfy 的
    print 混进协议里把调用方解析弄崩。
    """
    proto = sys.stdout
    sys.stdout = sys.stderr

    def emit(obj: dict) -> None:
        proto.write(json.dumps(obj, ensure_ascii=False) + "\n")
        proto.flush()

    root = os.environ.get("QWEN21_COMFY_ROOT") or str(
        Path(__file__).resolve().parent.parent.parent / "comfyui" / "ComfyUI"
    )
    if not Path(root, "main.py").is_file():
        emit({"ok": False, "op": "ready", "error": f"comfyRoot 不对：{root}"})
        return 1
    try:
        eng = Engine(root)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        emit({"ok": False, "op": "ready", "error": f"{type(exc).__name__}: {exc}"})
        return 1

    idle = float(os.environ.get("QWEN21_IDLE_UNLOAD") or DEF_IDLE_UNLOAD)
    emit({"ok": True, "op": "ready", "importSeconds": round(eng.import_s, 2),
          "gpu": os.environ.get("CUDA_VISIBLE_DEVICES", ""), "idleUnload": idle})

    stop = threading.Event()

    def idle_watch() -> None:
        """空闲就把模型请下卡。进程留着 —— 重新装 1.3s，重新起进程 22.5s。"""
        while not stop.wait(5.0):
            if idle <= 0:
                continue
            try:
                if (eng._clip is not None or eng._unet is not None or eng._vae is not None) \
                        and time.time() - eng._last_use > idle:
                    eng.unload_all(f"空闲 {idle:.0f}s")
            except Exception:  # noqa: BLE001
                pass

    threading.Thread(target=idle_watch, daemon=True, name="qwen21-idle").start()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({"ok": False, "error": f"请求不是合法 JSON：{exc}"})
            continue
        op = str(req.get("op") or "run")
        try:
            if op == "ping":
                emit({"ok": True, "op": "ping", "freeMb": eng.free_mb(),
                      "loaded": {"clip": eng._clip is not None, "unet": eng._unet is not None,
                                 "vae": eng._vae is not None}})
            elif op == "unload":
                eng.unload_all("调用方要求")
                emit({"ok": True, "op": "unload", "freeMb": eng.free_mb()})
            elif op == "quit":
                eng.unload_all("退出")
                emit({"ok": True, "op": "quit"})
                break
            elif op == "run":
                emit(eng.run(req))
            else:
                emit({"ok": False, "error": f"不认识的 op：{op}"})
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"})

    stop.set()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Qwen-Image-2.1 二步出图（进程内，不起 ComfyUI）")
    ap.add_argument("--spec", help="规格 JSON 的绝对路径（一次性模式）")
    ap.add_argument("--serve", action="store_true", help="常驻模式，stdin/stdout 收发 JSON")
    args = ap.parse_args()

    if args.serve:
        return serve()
    if not args.spec:
        ap.error("要么给 --spec，要么给 --serve")

    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    try:
        result = run_once(spec)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
