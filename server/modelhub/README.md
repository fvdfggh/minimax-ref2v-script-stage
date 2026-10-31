# ModelHub · 单卡模型前置服务

把「生图、图片编辑、语音设计、语音合成、文本生成」这五类本地能力收进一个进程，
并且**只用一张卡**。模型不常驻：调谁装谁，装新的先把旧的卸掉。

```
              ┌──────────── modelhub :8790 ────────────┐
  上层 / 剧本台 │  /v1/preflight   /v1/status   /v1/run  │
              │        └──── 单卡租约 + 显存账本 ────┘   │
              └──┬────────┬─────────┬─────────┬────────┘
                 │        │         │         │
          ComfyUI    audio.cpp    s2.cpp   llama.cpp
          :8188       :17802      :17803    :17801
        （外部常驻）  （按需拉起） （按需拉起）（按需拉起）
```

## 为什么要有这一层

一台机器上四张卡，业务却只该吃一张。模型各自往别的卡上跑，显存账就算不清，
「运行前体检」也就成了摆设。而一张 16G 卡装不下 14.3G 的 LLM 加生图加两个 TTS，
所以只能**同一时刻驻留一类**，靠动态加载切换。

这一层负责的就是这三件事：**只用一张卡、按需加载、把账算清**。

## 快速开始

在 `server/` 目录下：

```bash
# 起火（控制台在 http://127.0.0.1:8790/console）
python -m modelhub serve

# 运行前体检：不加载任何模型，告诉你能不能跑、跑之前要卸谁
python -m modelhub preflight

# 显存账本
python -m modelhub status
```

Windows 上可以直接双击 `server/start-modelhub.bat`。

## 五个能力

| capability | 引擎 | 默认端口 | 说明 |
|---|---|---|---|
| `image.generate` | ComfyUI | 8188 | 文生图。ComfyUI 是**外部常驻**，本服务不启动它，只在需要时让它 `/free` |
| `image.edit` | ComfyUI | 8188 | 图片编辑。必须带参考图，工作流要能吃参考图输入 |
| `voice.design` | audio.cpp server | 17802 | qwen3-tts voicedesign，按文字描述造音色，产出参考 wav |
| `voice.synthesize` | s2.cpp | 17803 | 用已固定的音色包合成，产出成品 wav |
| `text.generate` | llama.cpp | 17801 | llama-server + gguf，OpenAI 兼容 |

端口从 17801 起，是为了躲开本机已被占用的 8080（llama）、8188（ComfyUI）、
3030（s2）、8787（剧本台后端）。

## 单卡策略

`gpu.index` 决定整份服务用哪张卡（默认 `2`，这台机器 0/1 已被别的工作占着）。

三条保证：

1. **子进程只看得到这张卡**。llama.cpp 启动时注入 `CUDA_VISIBLE_DEVICES=<index>`，
   `-ngl 99` 只会往这张卡上放。
2. **例外写在明处**。`s2.exe` 的 `-c` 是绝对卡号且不认 `CUDA_VISIBLE_DEVICES`，
   `audio.cpp` 的 `--device` 同理 —— 这两个驱动用绝对卡号启动，**不注入**环境变量，
   否则编号会越界。
3. **启动后对账**。加载完成拿 `nvidia-smi --query-compute-apps` 按 pid 查实际占用，
   写进账本，并记到 `~/.scriptstage/modelhub/vram.json` 供下次估算校准。

ComfyUI 默认由本服务**托管**：生图时用 `python_embeded\python.exe main.py` 起一份钉在
本卡上的实例（私有端口 17804、`--disable-cuda-malloc`），切到别的模型就整进程停掉。
找不到 Python/main.py 时退回「借用外部实例」，这时候 `preflight` 会明说它不在本卡、
不参与互斥。

## 调度：按任务类型换人，不按时间

`gpu.exclusive`（默认开）现在管的是**组之间**，不是单个模型之间。组见
`config.GROUP_OF`：

| 组 | 能力 | 能同时在卡上 |
|---|---|---|
| `image` | 生图、图片编辑 | 是（本来就共用一个 ComfyUI 进程） |
| `audio` | 语音设计（audiocpp）、语音合成（s2） | 是（一次任务的两步） |
| `llm` | 文本生成（llama-server） | 自成一档 |

```
同一组再来一个请求        ──► 权重就在卡上，直接算（load=0）
另一组进来                ──► 立刻把上一组全部撤下（在跑？等它最多 swapWaitSec 秒）
                            └─► 装新的（ComfyUI 连进程一起停/起）
```

**不按空闲时间卸**（`idle_ttl` 默认 0）。原因是这里的调用节奏是
「一个任务连着来一串」——先写词、再配音、再出图。按时间卸会在两次请求之间
白付一次冷启动：ComfyUI 40–95 s、llama 37 s、audiocpp 31 s。真正的切换信号是
「来了别的类型」，不是「过了几分钟」。

- 换人有记录：`/v1/status` → `rotation.last`（谁下、谁上、花了多久），事件流里是
  `swap.begin` / `swap.wait` / `swap.done`，`/v1/run` 的 `meta.swap` 也会带上这一次的换人。
- 同组只是「不互相驱逐」，**装不下仍然会挡**：账本照旧按真实显存算，两个音频引擎
  才 5.1 GB，图片那组 16.7 GB 才是紧的那一档。
- 想退回「卡上只留一个」的老行为：配置 `"gpu": {"exclusive": false}`，或用
  `models[].group` 把每个模型单独分组。

### 批量：一次提交 N 条

`/v1/run` 的 `input.items` 是数组时，**一次提交、N 条支路**（`imagegen.generate_batch`）：

```
UNETLoader ─┬─► 支路1 编码 ─┐
            ├─► 支路2 编码 ─┤   ← 所有 TextEncode 先在 TE 在卡上时跑完
            ├─► 支路3 编码 ─┤
CLIPLoader ─┘               └─► 屏障 ─► KSampler×N（DiT 在卡上）─► VAEDecode×N
```

编码屏障（`ConditioningAverage` 当等号）保证 N 个提示词**一次性**交给 TE，
再让 N 个采样一次性交给 DiT。这张卡只有 16 GB，TE 8.9 + DiT 7.2 + VAE 1.3
装不下，所以「换一次装载、干完一批活」是唯一不亏的顺序 —— 逐张提交等于每张
都搬一遍 16.7 GB。

实测（Qwen-Image-2.1 两步，同一台机器、每轮都换提示词）：

| 提交方式 | 每张 | 显存峰值 |
|---|---|---|
| 单张逐次（N 次请求） | 25.6 s | 15.6 GB |
| **批量 4 条** | **9.2 s** | 15.7 GB |
| 批量 4 条（提示词完全相同，编码被缓存） | 4.0 s | 15.4 GB |

第三行是给「同一句话出多张」用的；生产里提示词都不同，看第二行。


## 动态加载怎么工作

```
请求 → 取租约
        ├─ 已就绪：引用计数 +1，直接调
        ├─ 在加载：等它（同一个模型并发请求共享一次加载）
        └─ 未加载：严格轮转 → 先撤下卡上那个（在跑就等 swapWaitSec）
                   然后再看显存：够就装，不够就报「谁在抢卡」
```

- **引用计数**：同一模型被并发使用时只加载一次；有引用时 `unload` 会拒绝。
- **不按时间回收**：`idleTtlSec` 默认 0（不自动卸），换人只看「有没有别组进来」。
  真要按空闲卸（多人共用一台机器时才有意义），显式配 `idleTtlSec`，
  比如 `"idleTtlSec": 1800`。
- **实测校准**：估算只用于「能不能装」，装完以 `nvidia-smi` 实测为准；
  下次启动直接拿实测值当估算（留 5% 余量）。ComfyUI 不参与校准 —— 它随工作流变。
- **失败可重试**：加载失败会停在 `error` 并保留日志尾，下一次请求自动重试。

## API

### 运行前

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 服务活着没 |
| GET | `/v1/env` | 单卡信息、显存、运行目录 |
| GET | `/v1/models` | 五类能力与模型清单（含状态、估算/实测显存） |
| GET | `/v1/status` | 账本 + 各槽位状态 + 最近事件 |
| POST | `/v1/preflight` | **体检**：`{"capabilities":[...], "models":{"text.generate":"llama-qwen"}}` |
| GET | `/v1/events` | 事件（`Accept: text/event-stream` 走 SSE） |

`preflight` 返回里最有用的是 `willEvict`（跑这个要卸谁）和 `advice`（为什么装不下）。

### 运行

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/run` | `{"capability":"...", "input":{...}}`，图片/音频返回 base64，加 `"raw":true` 直接回二进制 |
| POST | `/v1/models/{id}/load` | 只加载，不调用 |
| POST | `/v1/models/{id}/unload` | 卸载（有人用则 409，`{"force":true}` 强卸） |
| POST | `/v1/unload` | `{"all":true}` 全卸 |
| GET | `/v1/models/{id}/logs` | 日志尾部 |

### OpenAI 兼容别名

| 路径 | 转到 |
|---|---|
| `POST /v1/chat/completions` | `text.generate`（不支持 stream） |
| `POST /v1/images/generations` | `image.generate`，回 `b64_json` |
| `POST /v1/audio/speech` | 有 `instructions` → `voice.design`，否则 `voice.synthesize` |

## 调用示例

```bash
# 体检
curl -s -X POST localhost:8790/v1/preflight -d '{}' -H 'Content-Type: application/json'

# 文本
curl -s -X POST localhost:8790/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"你好"}],"max_tokens":128}'

# 设计音色
curl -s -X POST localhost:8790/v1/run -H 'Content-Type: application/json' \
  -d '{"capability":"voice.design","input":{"text":"参考文本","instruction":"温柔的中年女声","seed":42}}'

# 合成（voice 是已固定的音色包 id）
curl -s -X POST localhost:8790/v1/run -H 'Content-Type: application/json' \
  -d '{"capability":"voice.synthesize","input":{"text":"要念的话","voice":"v_ad1947d838"}}'

# 生图（raw=1 直接拿 PNG）
curl -s -o out.png -X POST 'localhost:8790/v1/run' -H 'Content-Type: application/json' \
  -d '{"capability":"image.generate","raw":true,"input":{"prompt":"窗台上的橘猫","width":512,"height":512}}'
```

## 配置

默认值全部按本机实际路径探测（`Desktop/llama`、`Desktop/gguf`、
`C:/s2`、`C:/a-tts`、`Desktop/comfyui/ComfyUI`）。要改就写
`~/.scriptstage/modelhub.json`：

```json
{
  "gpu": {
    "index": 2, "reserveMb": 768, "minFreeMb": 384,
    "exclusive": true,
    "swapWaitSec": 45
  },
  "models": [
    { "id": "llama-qwen", "extra": { "ctx": 8192 }, "idleTtlSec": 1800 },
    { "id": "s2-pro", "remove": true }
  ]
}
```

- `gpu.exclusive`：严格轮转（默认 `true`）。`false` = 装得下就都留着。
- `gpu.swapWaitSec`：换人时前一个请求还在跑，等它多久；`0` = 立刻 409。

`models` 按 `id` 合并：写同名 id 是覆盖，没写过的是新增，`"remove": true` 是删掉。
环境变量 `MODELHUB_GPU` / `MODELHUB_PORT` / `MODELHUB_RUNTIME` 也能覆盖。

导出当前探测结果作为起点：

```bash
python -m modelhub config --write
```

## 命令行

```
serve      起服务（含控制台）
preflight  运行前体检（服务没起时本地算，不加载）
status     显存账本与槽位状态
models     能力与模型清单
env        环境信息（显卡、路径）
load <id>  加载（必须服务在跑：加载会占显存，只能有一个进程管）
unload     卸载一个 / --all
run <cap>  调一次：--input '{"prompt":"..."}'
config     看配置 / --write 导出
```

## 内存

分两层看，混着说会得出相反的结论。

### 整棵树：壳 + 它拉起的引擎

单卡同时只驻留一个能力（见下面"切换不叠加"）。2026-10-27 实测，全部用真模型
跑通，`python -m modelhub.tests.probe_tree` 每秒采一次整棵进程树：

| 能力 | 引擎进程 | 工作集峰值 | 私有峰值 | 稳态 |
|---|---|---|---|---|
| `image.edit` | ComfyUI | 19.4 GB | **24.5 GB** | 19.0 GB |
| `image.edit`（冷启动只跑它） | ComfyUI | 18.7 GB | 23.8 GB | 20.3 GB |
| `image.generate` | ComfyUI | 13.5 GB | 17.9 GB | 16.9 GB |
| `text.generate` | llama-server | 13.7 GB | **1.2 GB** | 1.2 GB |
| `voice.design` | audiocpp_server | 3.8 GB | 1.9 GB | 1.9 GB |
| `voice.synthesize` | s2.exe | 1.3 GB | 2.4 GB | 2.4 GB |
| 壳自己 | python | 0.04 GB | 0.03 GB | 0.03 GB |

所以**这个服务的内存峰值是 24.5 GB 私有 / 19.4 GB 工作集**，全部来自 ComfyUI
的图片编辑（19 GB 的 `qwen_image_edit_2511_int8`）。语音与文本加起来不到 4 GB。

两条最容易读错的地方：

1. **工作集大不等于吃内存**。llama-server 的 13.7 GB 里有 13.3 GB 是 gguf 的
   mmap 文件页 —— 权重已经上了显卡，这些页是干净的、可随时丢弃的，私有只有
   1.2 GB。反过来 s2 是私有（2.4 GB）大于工作集（1.3 GB），说明它在往页文件里
   压。要比"要不要加内存条"，只看**私有**列。
2. **切换不叠加**。`_evict_for` 是「`kill_tree` 且等进程真的退出 → 再起下一个」
   （实测换模型 1.8–3.2 s），所以峰值永远是单个能力的，不是两个之和。

### 壳自己

空闲 **34 MiB 工作集、6 个线程**，不驻留模型 —— 所以"占几 GB"只可能来自两处：
请求体/响应体的瞬时副本，和日志。

壳自己的峰值都是可量化的，`python -m modelhub.tests.probe_mem` 会把这些场景各跑
一遍（假驱动 + 真 HTTP，不碰显卡）：

| 场景 | 峰值增量 | 说明 |
|---|---|---|
| `tail(40)` @ 128 MiB 日志 | **+485.6 → +0.0 MiB** | 老实现整份 `read_bytes()`；现在从尾部 seek |
| 批量出图 8×2 MiB | **+43.0 → +21.7 MiB** | 后者几乎全是客户端自己攥着那份响应 |
| 单张出图 2 MiB | **+5.6 → +2.9 MiB** | 同上 |
| 64 MiB 请求体（`MAX_BODY`） | +128 MiB | **2× 是协议决定的**（base64 必须解成对象） |
| `object_info` 解析后 | +14.6 MiB | 现在是**滑动 TTL + 最多 2 份**，空闲 5 分钟释放 |
| `/v1/status` ×100 | +0.0 MiB | 控制台 8 秒轮询不会爬 |

四条规矩（改之前先看）：

1. **日志只读尾部**。`ManagedProc.tail` 从后往前按 64 KiB 块读，凑够行数就停
   （上限 4 MiB）。整份读的代价不是线性的：128 MiB 的日志会产生一百多万个
   str 对象，光对象头就比正文大。
2. **日志上限 32 MiB，超了在下次启动时轮转成 `.1`**。只能在 `start()` 里做 ——
   只有那一刻没有别的句柄在写。`ManagedProc(log_max_bytes=...)` 可调。
3. **大块一边编码一边写**。`Handler._json_stream` 按 `B64_CHUNK`（3 MiB 原始
   字节 → 4 MiB base64）分段，`Content-Length` 用 `_b64_len` 算术算准，所以
   不用 chunked。别退回"整份 `json.dumps` 再 encode"——那是四份同时在场。
4. **参考图上传完就从 payload 里摘掉**。`_run` 的栈帧在整个生成期间攥着
   `payload`，一张 24 MiB 的参考图 base64 之后是 32 MiB 字符串，不摘就是
   白占几十秒到十几分钟。

`MAX_BODY` 是 64 MiB，没有改：它决定了「一次最多带多少参考图」，调小会开始
拒掉合法请求。要再压这个峰值只能换掉 base64 这条协议（比如走临时文件），
收益不值。

## 已知边界

- **不支持流式**。单卡上流式会把一个模型长时间钉在卡上，把别的能力全挡住；
  要流式就直连被加载模型的端口。
- **ComfyUI 的模型不归本服务管**。它的模型写在每份工作流里，外面去改只会两边打架；
  本服务只决定「要不要让它在卡上」。- **显存估算不是精确值**。首次靠文件大小 + 经验系数，实测一次后自动校准。
  `preflight` 的 `vram.tight` 提醒就是「装得下但余量小」。
- **llama.cpp 的 reasoning 模型**会把内容放在 `reasoning_content`，
  `content` 可能为空 —— 这是模型行为，本服务原样透传。
