/**
 * 二采（二级采样）在"那张图"上真正要动的三样东西。
 *
 * 导演节点自己的输入里，二采只有**四个旋钮**：`second_run_model`、`second_seed`、
 * `second_only`，加上两个**连线口** `second_sigmas`（SIGMAS）和 `upscale_model`
 * （LATENT_UPSCALE_MODEL）。所以二采的"步数 / 分辨率 / 自定义 sigmas"根本不在
 * 导演节点上：
 *
 *   · **分辨率**在放大节点 `MiniMaxH3LatentUpscaleModelOpt` 上（`mode` +
 *     `mode.<子键>` + `align`），导演节点只是把它的输出接到 `upscale_model`；
 *   · **sigmas** 在 `ManualSigmas` 节点的 `sigmas` 字符串上，接进 `sigmas`
 *     （一采）或 `second_sigmas`（二采）。节点侧没有这两个口，就回退到默认调度；
 *   · **步数** = sigmas 条数 − 1（接了 sigmas 时），否则用节点自带的
 *     `DEFAULT_SECOND_SIGMAS`（3 步）。
 *
 * 这个模块就是把这些"图上的活"收成纯函数：改节点、接线、给时间线打 `secondSample`。
 * 全部是深拷贝后改，绝不碰调用方手上那份（模板是共享的）。
 */
import { P_LEVELS, pixelsForP } from './imageSize'

/** 放大节点（二采专用，导演节点的 `upscale_model` 口接它） */
export const UPSCALE_NODE_TYPE = 'MiniMaxH3LatentUpscaleModelOpt'

/* ------------------------------------------------------------------ *
 * 这一次跑哪几档
 * ------------------------------------------------------------------ */

/**
 * 三态。放这里而不是 `domain/run.ts`：`run.ts` 要 import 本模块去改图，
 * 反过来的话就成了循环依赖。
 */
export type SecondStage = 'off' | 'pair' | 'direct'

export const SECOND_STAGE_OPTIONS: Array<{
  value: SecondStage
  label: string
  hint: string
}> = [
  {
    value: 'off',
    label: '仅一采',
    hint: '只跑一采：采样并解码出片，二采完全不动。最快，也是绝大多数试跑要的。'
  },
  {
    value: 'pair',
    label: '一采+二采',
    hint:
      '同一次运行里「连着」先一采后二采：一采只采样不解码，二采拿它的 latent 放大 + 重采样出片。' +
      '成片全部来自二采，一采不再产生可导出的像素。'
  },
  {
    // ★ 这里原来叫「二采直出」。「直出」被读成"一采直出到二采"，跟上一档
    //   「一采+二采」几乎分不开，实际语义却正好相反：**不跑一采**。
    //   已经因此真的点错过，改成直白的「仅二采」。
    value: 'direct',
    label: '仅二采',
    hint:
      '「跳过一采」，只用磁盘上已有的一采缓存 latent 放大 + 重采样出片。' +
      '要求这些段的一采 latent 已经跑过，否则节点会报「没有可用的缓存段」。'
  }
]

/** 三态 → 两个老布尔（仍然写进配置，别的页面还在读） */
export function stageFlags(stage: SecondStage): { secondEnabled: boolean; secondOnly: boolean } {
  return { secondEnabled: stage !== 'off', secondOnly: stage === 'pair' }
}

/** 手填 sigmas 的节点（`sigmas` 是一个 "0.85, 0.5" 这样的字符串） */
export const SIGMAS_NODE_TYPE = 'ManualSigmas'

/** API format 里的节点：只关心类型与输入，其余原样带过 */
export interface NodeLike {
  class_type?: string
  inputs?: Record<string, unknown>
  _meta?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * 放大节点的尺寸模式。
 *
 * ★ 字符串必须与 `lib/latent_upscaler_3d.py` 的 `MODE_*` **逐字一致**
 * （`scale by multiplier` 中间是空格）。写错了 DynamicCombo 匹配不到分支，
 * 会静默退回默认值 —— 用户改了没反应，还查不出原因。
 */
export const SECOND_UPSCALE_MODES = [
  'megapixels',
  'p',
  'scale by multiplier',
  'target dimensions'
] as const

export type SecondUpscaleMode = (typeof SECOND_UPSCALE_MODES)[number]

export const SECOND_UPSCALE_MODE_LABELS: Record<string, string> = {
  megapixels: '按像素量（1.0 = 1024²）',
  p: '按 p 档（480 / 720 / 1080）',
  'scale by multiplier': '按倍率缩放',
  'target dimensions': '指定目标尺寸'
}

/** 二采 `megapixels` 档自己的 1.0：1024²（不是 720p 的 921,600） */
export const MEGAPIXEL_PIXELS = 1024 * 1024

/**
 * 二采的固定种子 —— 与节点里的 `SECOND_SEED_FIXED` 逐字一致
 * （`director/second_sampling_support.py:44`，值 20240）。
 *
 * 二采用自己独立的全局噪声场：**不跟一采的 seed，也不跟一采的「随机种子」**。
 * 节点注释写得很明白："二采专属固定种子：不暴露给用户调整，始终用同一个全局噪声场"。
 */
export const SECOND_SEED_FIXED = 20240

/**
 * 早期从一份工作流里抄进来的二采种子，从来没人主动选过它。
 * 读配置时把它当"没设过"处理，避免面板显示 20240、提交却仍旧写这个老值。
 */
/**
 * 二采采样器的「跟随一采」哨兵 —— 与节点 widget 里的同名选项逐字一致。
 * 节点侧未接 `second_sigmas` 时，跟随的其实是海螺二采默认的 euler。
 */
export const SECOND_SAMPLER_FOLLOW = '跟随一采'

/** 二采采样器：把节点的「跟随一采」归一成空串（空 = 不写，交给节点决定） */
export function secondSamplerOf(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  return s === SECOND_SAMPLER_FOLLOW ? '' : s
}

const LEGACY_SECOND_SEED = 156680013701846

/** 二采种子：老默认值 / 空值一律归到固定值 */
export function secondSeedOf(cfg: { secondSeed?: unknown } | null | undefined): number {
  const v = cfg?.secondSeed
  if (typeof v !== 'number' || !Number.isFinite(v)) return SECOND_SEED_FIXED
  return v === LEGACY_SECOND_SEED ? SECOND_SEED_FIXED : v
}

/** VAE 下采样倍数：最终宽高必须是它的整数倍（16） */
export const VAE_DOWNSAMPLE = 16

/** p 档位的候选（与 `lib/latent_upscaler_3d.py` 的 P_TABLE 同一张表） */
export const SECOND_P_LEVELS: readonly number[] = P_LEVELS

export interface UpscaleRequest {
  mode: string
  megapixels: number
  p: number
  scale: number
  width: number
  height: number
  align: number
}

/**
 * 一采画布 → 二采最终像素尺寸。
 *
 * 逐字照抄 `lib/latent_upscaler_3d.py:target_final_pixels()`：**这是唯一真相源**，
 * 导演台在 arm 之前也用它算显存预算。这里自己算一遍会让"面板上写着 1376×768、
 * 实际出 1280×704"——分辨率对不上，分段素材的尺寸探测也跟着错位。
 */
export function secondTargetSize(
  baseWidth: number,
  baseHeight: number,
  req: Partial<UpscaleRequest>
): { width: number; height: number; scale: number } {
  const wIn = Math.max(1, Math.round(baseWidth || 0))
  const hIn = Math.max(1, Math.round(baseHeight || 0))
  const mode = String(req.mode ?? 'megapixels')

  let wTarget = wIn
  let hTarget = hIn
  let scale = 1

  if (mode === 'target dimensions') {
    wTarget = Number(req.width ?? wIn) || wIn
    hTarget = Number(req.height ?? hIn) || hIn
    scale = (wTarget / wIn + hTarget / hIn) / 2
  } else if (mode === 'scale by multiplier') {
    scale = Number(req.scale ?? 2) || 2
    wTarget = wIn * scale
    hTarget = hIn * scale
  } else {
    const total =
      mode === 'p'
        ? pixelsForP(Number(req.p ?? 720) || 720)
        : (Number(req.megapixels ?? 1) || 1) * MEGAPIXEL_PIXELS
    const aspect = wIn / hIn
    hTarget = Math.sqrt(total / aspect)
    wTarget = hTarget * aspect
    scale = (wTarget / wIn + hTarget / hIn) / 2
  }

  // p 档的坐标本身按 16 定义（720 = 45×16），套 32 网格会把 720 抹成 704
  const align = mode === 'p' ? 16 : Math.max(1, Math.round(Number(req.align ?? 32) || 32))
  const ds = VAE_DOWNSAMPLE
  const w = Math.max(ds, Math.round(Math.round(wTarget / align) * align / ds) * ds)
  const h = Math.max(ds, Math.round(Math.round(hTarget / align) * align / ds) * ds)
  return { width: w, height: h, scale: Math.round(scale * 1000) / 1000 }
}

/** 放大节点在哪：优先顺着导演节点的 `upscale_model` 连线找，找不到再按类型找 */
export function upscaleNodeId(
  api: Record<string, NodeLike>,
  directorId?: string | null
): string | null {
  const linked = directorId ? api[directorId]?.inputs?.upscale_model : undefined
  if (Array.isArray(linked) && typeof linked[0] === 'string' && api[linked[0]]) return linked[0]
  for (const [id, node] of Object.entries(api)) {
    if (node?.class_type === UPSCALE_NODE_TYPE) return id
  }
  return null
}

/**
 * 把二采尺寸写进放大节点。
 *
 * `mode` 是 `COMFY_DYNAMICCOMBO_V3`：主键放选中字符串，子参数平铺成
 * `mode.<子键>`。**不能**塞整个 dict —— 那会让节点以为 `mode` 没传，
 * 跑到二采才炸，而一采已经跑完了。
 */
export function applyUpscaleToApi(
  api: Record<string, NodeLike>,
  req: UpscaleRequest,
  directorId?: string | null
): { nodeId: string | null; applied: string[] } {
  const nodeId = upscaleNodeId(api, directorId)
  if (!nodeId) return { nodeId: null, applied: [] }
  const inputs = api[nodeId].inputs ?? (api[nodeId].inputs = {})
  const mode = String(req.mode || 'megapixels')
  const applied: string[] = []

  for (const key of Object.keys(inputs)) if (key.startsWith('mode.')) delete inputs[key]
  inputs.mode = mode
  applied.push('upscale.mode')

  if (mode === 'scale by multiplier') {
    inputs['mode.scale'] = Number(req.scale ?? 2) || 2
    applied.push('upscale.scale')
  } else if (mode === 'target dimensions') {
    inputs['mode.width'] = Math.round(Number(req.width ?? 1280) || 1280)
    inputs['mode.height'] = Math.round(Number(req.height ?? 704) || 704)
    applied.push('upscale.width', 'upscale.height')
  } else if (mode === 'p') {
    inputs['mode.p'] = Math.round(Number(req.p ?? 720) || 720)
    applied.push('upscale.p')
  } else {
    inputs['mode.megapixels'] = Number(req.megapixels ?? 1) || 1
    applied.push('upscale.megapixels')
  }

  // p 档内部固定按 16 对齐，align 这一项它不看；照写会让面板和实际对不上，
  // 所以只在别的模式写。
  if (mode !== 'p') {
    inputs.align = Math.max(1, Math.round(Number(req.align ?? 32) || 32))
    applied.push('upscale.align')
  }
  return { nodeId, applied }
}

/** 新节点 id：取现有数字 id 的最大值 +1（ComfyUI 的 id 就是字符串） */
function nextNodeId(api: Record<string, unknown>): string {
  let max = 0
  for (const key of Object.keys(api)) {
    const n = Number(key)
    if (Number.isFinite(n) && n > max) max = n
  }
  return String(Math.floor(max) + 1)
}

/**
 * 把一段 sigmas 文本写进 `ManualSigmas`，并接到导演节点对应的 SIGMAS 口。
 *
 * 空文本 = **什么都不改**（沿用图上现有的接线或节点默认调度）。这样"没填"
 * 和"填了空"不会产生两种行为。
 *
 * 目标口上本来接着别的节点（比如 BasicScheduler）时，**不动它** —— 用户在图里
 * 自己接的调度器优先级更高，前端只能填 ManualSigmas 自己创建的那个。
 */
export function applySigmasText(
  api: Record<string, NodeLike>,
  directorId: string | null | undefined,
  which: 'sigmas' | 'second_sigmas',
  text: string
): { nodeId: string | null; created: boolean; applied: boolean } {
  const value = String(text ?? '').trim()
  if (!directorId || !api[directorId] || !value) return { nodeId: null, created: false, applied: false }
  const inputs = api[directorId].inputs ?? (api[directorId].inputs = {})

  const linked = inputs[which]
  const linkedId = Array.isArray(linked) && typeof linked[0] === 'string' ? linked[0] : null
  if (linkedId && api[linkedId]) {
    if (api[linkedId].class_type !== SIGMAS_NODE_TYPE) {
      // 接的是别的调度节点：尊重图上的接法
      return { nodeId: linkedId, created: false, applied: false }
    }
    api[linkedId].inputs = { ...(api[linkedId].inputs ?? {}), sigmas: value }
    return { nodeId: linkedId, created: false, applied: true }
  }

  const id = nextNodeId(api)
  api[id] = {
    class_type: SIGMAS_NODE_TYPE,
    inputs: { sigmas: value },
    _meta: { title: which === 'sigmas' ? '自定义 Sigmas（一采）' : '自定义 Sigmas（二采）' }
  }
  inputs[which] = [id, 0]
  return { nodeId: id, created: true, applied: true }
}

/**
 * 图上 `second_sigmas` 口**实际接到**的 sigmas 文本（只读，不改图）。
 *
 * 面板上「sigmas 留空 = 用图上现有接线」是刻意的：空不写就等于交给图。
 * 但那样一来「步数」就没得算了 —— 只能写死「3 步」，而图上接的
 * `ManualSigmas` 常常是 2 条（1 步）。用户看到 3 步、实际跑 1 步，
 * 想改步数还会以为自己填错了。所以留空时把线上的文本读出来算。
 *
 * 接的不是 `ManualSigmas`（比如 BasicScheduler）⇒ 返回 ''：调度交给那个节点，
 * 前端不猜。
 */
export function wiredSigmasText(
  api: Record<string, NodeLike> | null | undefined,
  directorId: string | null | undefined,
  which: 'sigmas' | 'second_sigmas'
): string {
  if (!api || !directorId || !api[directorId]) return ''
  const linked = api[directorId].inputs?.[which]
  const linkedId = Array.isArray(linked) && typeof linked[0] === 'string' ? linked[0] : null
  if (!linkedId || !api[linkedId]) return ''
  if (api[linkedId].class_type !== SIGMAS_NODE_TYPE) return ''
  const value = api[linkedId].inputs?.sigmas
  return typeof value === 'string' ? value : ''
}

/** sigmas 文本 → 步数（节点侧：步数 = len(sigmas) − 1） */
export function sigmasStepCount(text: string): number {  const nums = String(text ?? '')
    .split(/[,\s;]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n))
  return nums.length > 1 ? nums.length - 1 : 0
}

/**
 * 时间线里的「二次采样」块。
 *
 * `enabled` 是**一次性触发**：节点看到它就**跳过一采**，直接对已有缓存 latent
 * 做「放大 + 重采样 + 出片」。所以它只对应「二采直出」，不是"一采+二采"
 * （后者靠 `second_only`）。这一点反直觉，写错就是白跑一次一采。
 */
export function applySecondSample(
  timeline: Record<string, unknown>,
  opts: { enabled: boolean; indices: number[] }
): Record<string, unknown> {  const next = { ...timeline }
  const output =
    next.output && typeof next.output === 'object'
      ? { ...(next.output as Record<string, unknown>) }
      : null
  // 两处都清一遍：导入的包/历史时间线可能只写了其中一个位置
  delete next.secondSample
  if (output) {
    delete output.secondSample
    delete output.second_sample
  }
  if (opts.enabled && opts.indices.length) {
    next.secondSample = { enabled: true, indices: [...opts.indices].sort((a, b) => a - b) }
  }
  if (output) next.output = output
  return next
}

/** 按三态算出 `secondSample` 的入参：只有「二采直出」才触发 */
export function secondSampleFor(
  stage: SecondStage,
  picks: number[],
  total: number
): { enabled: boolean; indices: number[] } {
  if (stage !== 'direct') return { enabled: false, indices: [] }
  const idx = picks.length ? [...picks] : Array.from({ length: Math.max(0, total) }, (_, i) => i)
  return { enabled: idx.length > 0, indices: idx }
}
