/**
 * 工作流参数中心的数据模型。
 *
 * 为什么要单独一层，而不是直接把 ComfyUI 的 widgets_values 搬过来：
 *
 * 1. **UI 工作流的 widgets_values 是位置数组**，前端控件增删/折叠组/派生控件
 *    都会让它整体移位。节点作者在 tools/run_director_direct.py 头部记录了四种
 *    位置对齐方式全部失败的实测（timeline_data 拿到 2186、run_model 拿到时间线
 *    JSON）。所以这里**只认 API format 的命名 inputs**。
 *
 * 2. **参数键不能用节点 id**。同一套参数换一个工作流，节点 id 就变了（当前工作流
 *    放大节点是 41，换个图可能是 12）。这里统一用 `class_type#序号.参数名` 做键，
 *    模板才能跨工作流复用；提交时再解析回真实 node id。
 *
 * 3. **放大节点（MiniMaxH3LatentUpscaleModelOpt）要手写**。它是 DynamicCombo：
 *    三个模式各自的子参数不在同一个扁平结构里，自动推断只能猜出 `mode` 一个字符串，
 *    拼不出 `{mode, scale, width, height, megapixels}`。所以给它一份精确 spec。
 */

import { secondTargetSize } from './secondPass'

/** 参数值的原子类型。对象/数组是连线或复合输入，不在这里出现。 */
export type ParamValue = string | number | boolean
export type ParamKind = 'int' | 'float' | 'bool' | 'text' | 'enum'

export type NodeGroup =
  | 'model'
  | 'lora'
  | 'sample'
  | 'second'
  | 'accel'
  | 'output'
  | 'preview'
  | 'other'

export interface ParamSpec {
  /** inputs 里的键名，必须与 API format 完全一致 */
  key: string
  label: string
  kind: ParamKind
  default: ParamValue
  min?: number
  max?: number
  step?: number
  options?: string[]
  hint?: string
  /** 仅当另一参数取到给定值时显示（放大节点的模式联动靠它） */
  visibleWhen?: { key: string; in: ParamValue[] }
}

export interface NodeSpec {
  /** `class_type#序号` —— 与具体工作流的节点 id 解耦 */
  key: string
  type: string
  title: string
  group: NodeGroup
  params: ParamSpec[]
  /** 有专用面板时，弹窗改用该面板而不是通用表单 */
  panel?: 'upscale'
  /** 该节点是否出现在 API 基线里（没出现就只能看，不能改） */
  present: boolean
}

export type ApiNode = {
  class_type?: string
  inputs?: Record<string, unknown>
  _meta?: { title?: string }
}

export type ApiWorkflow = Record<string, ApiNode>

export interface WorkflowTemplate {
  id: string
  name: string
  desc: string
  /** `class_type#序号.参数名` → 值 */
  values: Record<string, ParamValue>
  /** 导入的 API format 基线；没有它就只能编辑放大节点 */
  api: ApiWorkflow | null
  createdAt: number
  updatedAt: number
}

/* ------------------------------------------------------------------ *
 * 分组
 * ------------------------------------------------------------------ */

export const GROUP_LABELS: Record<NodeGroup, string> = {
  model: '模型',
  lora: 'LoRA',
  sample: '采样',
  second: '二采与放大',
  accel: '加速与多卡',
  output: '输出',
  preview: '预览',
  other: '其他'
}

export const GROUP_ORDER: NodeGroup[] = [
  'second',
  'model',
  'lora',
  'sample',
  'accel',
  'output',
  'preview',
  'other'
]

/** 节点类型 → 分组。没列到的进 other，不会被丢掉。 */
const GROUP_BY_TYPE: Record<string, NodeGroup> = {
  MiniMaxH3LatentUpscaleModelOpt: 'second',
  ManualSigmas: 'sample',
  CLIPLoader: 'model',
  VAELoader: 'model',
  MiniMaxH3FP16LoaderStar7: 'model',
  LoraLoaderModelOnly: 'lora',
  MiniMaxH3ActivationChunkStar7: 'accel',
  TESpeedMiniMaxH3: 'accel',
  H3TextEncoderAccel: 'accel',
  MiniMaxH3FastVideoVAEOpt: 'accel',
  H3MultiGPUPatchModel: 'accel',
  MiniMaxH3CreateVideoU8Opt: 'output',
  SaveVideo: 'output',
  PreviewAny: 'preview'
}

/** 这些节点不出现在参数卡片里：导演节点自己就是一个工作台，其余是纯连线节点。 */
const HIDDEN_TYPES = new Set(['ComfyMiniMaxH3DirectorOpt', 'MiniMaxH3DirectorOpt'])

/* ------------------------------------------------------------------ *
 * 放大节点：精确参数（照抄 nodes/latent_upscaler_3d.py）
 * ------------------------------------------------------------------ */

/**
 * 三个模式的实际枚举值。
 * 注意 `scale by multiplier` 中间是**空格**，不是下划线 —— 源码
 * lib/latent_upscaler_3d.py:86 就是这么写的，改成 scale_by 会导致
 * 后端 DynamicCombo 匹配不到分支、静默退回默认值。
 */
export const UPSCALE_MODES = [
  'scale by multiplier',
  'target dimensions',
  'megapixels',
  'p'
] as const

export const UPSCALE_MODE_LABELS: Record<string, string> = {
  'scale by multiplier': '按倍率缩放',
  'target dimensions': '指定目标尺寸',
  megapixels: '按目标像素量',
  p: '按 p 档（精确 720p）'
}

/** 当前工作流实测可用的放大模型。导入 API 后会被真实值覆盖。 */
export const UPSCALE_MODEL_FALLBACK = [
  'minimax_h3_latent_upscaler_3d_fp16.safetensors'
]

export function upscaleParamSpecs(): ParamSpec[] {
  return [
    {
      key: 'model_name',
      label: '放大模型',
      kind: 'enum',
      default: UPSCALE_MODEL_FALLBACK[0],
      options: UPSCALE_MODEL_FALLBACK,
      hint: 'MiniMax H3 Latent Upscaler (3D)。二采必须先有这个模型，没接会直接报错。'
    },
    {
      key: 'mode',
      label: '尺寸模式',
      kind: 'enum',
      default: 'megapixels',
      options: [...UPSCALE_MODES],
      hint: '决定目标尺寸怎么算。四种模式互斥，切换后下面只显示对应的一项。'
    },
    {
      key: 'scale',
      label: '放大倍率',
      kind: 'float',
      default: 2,
      min: 1,
      max: 4,
      step: 0.05,
      visibleWhen: { key: 'mode', in: ['scale by multiplier'] }
    },
    {
      key: 'width',
      label: '目标宽度',
      kind: 'int',
      default: 1280,
      min: 64,
      max: 8192,
      step: 8,
      visibleWhen: { key: 'mode', in: ['target dimensions'] }
    },
    {
      key: 'height',
      label: '目标高度',
      kind: 'int',
      default: 704,
      min: 64,
      max: 8192,
      step: 8,
      visibleWhen: { key: 'mode', in: ['target dimensions'] }
    },
    {
      key: 'megapixels',
      label: '目标像素量',
      kind: 'float',
      default: 1,
      min: 0.1,
      max: 16,
      step: 0.1,
      hint: '二采自己的 1.0 = 1024²（1,048,576 px）：一采 864×480 会得到 1376×768。',
      visibleWhen: { key: 'mode', in: ['megapixels'] }
    },
    {
      key: 'p',
      label: 'p 档',
      kind: 'int',
      default: 720,
      min: 240,
      max: 2160,
      step: 8,
      hint: '按短边查表：480p = 864×480、720p = 1280×720、1080p = 1920×1088。这一档内部按 16 对齐。',
      visibleWhen: { key: 'mode', in: ['p'] }
    },
    {
      key: 'align',
      label: '像素对齐',
      kind: 'int',
      default: 32,
      min: 1,
      max: 512,
      step: 1,
      hint: '32 是官方强烈建议值。改小会产生接缝，改大没有收益。p 档不看这一项（内部固定 16）。'
    },
    {
      key: 'enable_temporal_chunking',
      label: '时序分块',
      kind: 'bool',
      default: true,
      hint: '长视频省显存，同时修掉尾帧闪烁。关掉会在长片上吃满显存。'
    },
    {
      key: 'force_unload',
      label: '用完卸载到 CPU',
      kind: 'bool',
      default: true,
      hint: '每次推理后释放显存给后续节点。反复调用这个节点时关掉可以省加载开销。'
    },
    {
      key: 'device',
      label: '设备',
      kind: 'enum',
      default: 'cuda',
      options: ['cuda', 'rocm', 'cpu']
    },
    {
      key: 'precision',
      label: '精度',
      kind: 'enum',
      default: 'fp16',
      options: ['fp32', 'fp16', 'bf16'],
      hint: 'fp16 是默认；fp32 更稳但显存翻倍，bf16 在 T10（sm75）上没有原生支持。'
    }
  ]
}

/**
 * 把扁平值组装成放大节点真正吃的 `mode` 结构。
 *
 * 源码 execute 里是 `if not isinstance(mode, dict): mode = {"mode": mode}`
 * 之后再取 scale/width/height/megapixels —— 也就是说模式子参数必须**和模式
 * 一起**放进同一个 dict，单独塞 `megapixels=1` 到 inputs 顶层会被忽略。
 */
/**
 * 把放大模式写回节点的 inputs。
 *
 * ★ `mode` 是 `COMFY_DYNAMICCOMBO_V3`，**不是**一个能塞整个 dict 的参数。
 * 它的 API 序列化是：主键 `mode` 放**选中的字符串**，子参数各自平铺成
 * `mode.<子键>`（实测导出图里就是 `"mode": "megapixels"` + `"mode.megapixels": 1`）。
 *
 * 早期版本把整组值塞成一个 dict（`{mode: 'megapixels', megapixels: 1}`），
 * ComfyUI 那边 DYNAMICCOMBO 认不出来，直接把 `mode` 当成没传 ——
 * 于是跑到二采时才炸 `execute() missing 1 required positional argument: 'mode'`，
 * 而一采二十分钟已经白跑了。
 *
 * 顺带清掉上一次留下的 `mode.*`（切模式时会残留旧子键）。
 */
export function applyUpscaleMode(
  inputs: Record<string, unknown>,
  values: Record<string, ParamValue>
): void {
  const mode = String(values.mode ?? inputs.mode ?? 'megapixels')
  for (const k of Object.keys(inputs)) {
    if (k.startsWith('mode.')) delete inputs[k]
  }
  inputs.mode = mode
  if (mode === 'scale by multiplier') inputs['mode.scale'] = Number(values.scale ?? 2)
  else if (mode === 'target dimensions') {
    inputs['mode.width'] = Number(values.width ?? 1280)
    inputs['mode.height'] = Number(values.height ?? 704)
  } else if (mode === 'p') inputs['mode.p'] = Number(values.p ?? 720)
  else inputs['mode.megapixels'] = Number(values.megapixels ?? 1)
}

/** 只用于面板上的预览/试算，不参与提交。 */
export function buildUpscaleMode(values: Record<string, ParamValue>): Record<string, ParamValue> {
  const mode = String(values.mode ?? 'megapixels')
  const out: Record<string, ParamValue> = { mode }
  if (mode === 'scale by multiplier') out.scale = Number(values.scale ?? 2)
  else if (mode === 'target dimensions') {
    out.width = Number(values.width ?? 1280)
    out.height = Number(values.height ?? 704)
  } else if (mode === 'p') out.p = Number(values.p ?? 720)
  else out.megapixels = Number(values.megapixels ?? 1)
  return out
}

/**
 * 由画布尺寸 + 参数推算二采输出尺寸，用于面板上的实时预览。
 *
 * 直接调 `secondTargetSize`（与 `lib/latent_upscaler_3d.py` 逐字对齐的那份）：
 * 以前这里自己写了一遍换算，`megapixels` 用的是 1e6 而不是二采自己的 1024²，
 * 于是面板说 1344×736、实际出 1376×768 —— 尺寸对不上，分段素材的探测也跟着错位。
 */
export function estimateUpscaleSize(
  baseWidth: number,
  baseHeight: number,
  values: Record<string, ParamValue>
): { width: number; height: number; megapixels: number } {
  const r = secondTargetSize(baseWidth, baseHeight, {
    mode: String(values.mode ?? 'megapixels'),
    megapixels: Number(values.megapixels ?? 1) || 1,
    p: Number(values.p ?? 720) || 720,
    scale: Number(values.scale ?? 2) || 2,
    width: Number(values.width ?? baseWidth) || baseWidth,
    height: Number(values.height ?? baseHeight) || baseHeight,
    align: Number(values.align ?? 32) || 32
  })
  return {
    width: r.width,
    height: r.height,
    megapixels: Math.round(((r.width * r.height) / 1_000_000) * 100) / 100
  }
}

/* ------------------------------------------------------------------ *
 * API format 解析
 * ------------------------------------------------------------------ */

function isLink(value: unknown): boolean {
  // 连线在 API format 里是 [上游节点 id, 输出序号]
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string'
}

/**
 * 遍历节点 id 的固定顺序：按数值升序，非数字 id 排后面。
 *
 * 为什么不能直接用 `Object.keys` 的顺序：那是 JSON 文件里的插入顺序，用户在
 * ComfyUI 里新增/删除节点后重新导出，同一个 VAELoader 可能从第 2 位变成第 1 位。
 * 而序号参与参数键（`VAELoader#1.vae_name`），顺序一变，模板里三个 VAE 的值
 * 就会互相串位 —— 这种错误跑起来不报错，只是 VAE 用错了文件。
 */
function orderedNodeIds(api: ApiWorkflow): string[] {
  return Object.keys(api).sort((a, b) => {
    const na = Number(a)
    const nb = Number(b)
    const aNum = Number.isFinite(na)
    const bNum = Number.isFinite(nb)
    if (aNum && bNum) return na - nb
    if (aNum) return -1
    if (bNum) return 1
    return a.localeCompare(b)
  })
}

/** 类型 → 该类型的节点 id 列表，顺序与 :func:`orderedNodeIds` 一致。 */
function nodesByType(api: ApiWorkflow): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const nodeId of orderedNodeIds(api)) {
    const type = String(api[nodeId]?.class_type ?? '')
    if (!type) continue
    const list = out.get(type) ?? []
    list.push(nodeId)
    out.set(type, list)
  }
  return out
}

function inferSpec(key: string, value: unknown): ParamSpec | null {
  if (isLink(value)) return null
  if (value === null || typeof value === 'object') return null

  if (typeof value === 'boolean') {
    return { key, label: key, kind: 'bool', default: value }
  }
  if (typeof value === 'number') {
    const isInt = Number.isInteger(value)
    return {
      key,
      label: key,
      kind: isInt ? 'int' : 'float',
      default: value,
      step: isInt ? 1 : 0.01
    }
  }
  const text = String(value)
  return {
    key,
    label: key,
    kind: 'text',
    default: text,
    hint: text.length > 60 ? `当前值较长（${text.length} 字符）` : undefined
  }
}

/** 自动生成的参数名是英文键名，这里补一层常见语义的中文标签。 */
const LABEL_OVERRIDES: Record<string, string> = {
  model_name: '模型文件',
  lora_name: 'LoRA 文件',
  strength_model: '模型强度',
  strength_clip: 'CLIP 强度',
  clip_name: 'CLIP 模型',
  vae_name: 'VAE 文件',
  unet_name: 'UNET 文件',
  mode: '模式',
  align: '对齐',
  device: '设备',
  precision: '精度',
  steps: '步数',
  cfg: 'CFG',
  seed: '种子',
  sampler: '采样器',
  scheduler: '调度器',
  filename_prefix: '文件名前缀',
  format: '格式',
  codec: '编码',
  fps: '帧率'
}

/**
 * 从 API format 生成节点表。
 *
 * 只认「值不是数组/对象」的 input —— 数组是连线，对象是复合输入，两类都不该
 * 在通用表单里出现（硬塞进去只会在提交时把图改坏）。
 */
export function parseApiWorkflow(api: ApiWorkflow | null | undefined): NodeSpec[] {
  if (!api) return []

  const counters = new Map<string, number>()
  const specs: NodeSpec[] = []

  for (const nodeId of orderedNodeIds(api)) {
    const node = api[nodeId]
    const type = String(node?.class_type ?? '')
    if (!type || HIDDEN_TYPES.has(type)) continue

    const ordinal = counters.get(type) ?? 0
    counters.set(type, ordinal + 1)

    const params: ParamSpec[] = []
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      const spec = inferSpec(key, value)
      if (!spec) continue
      const label = LABEL_OVERRIDES[key]
      params.push(label ? { ...spec, label } : spec)
    }

    specs.push({
      key: `${type}#${ordinal}`,
      type,
      title: node._meta?.title || type,
      group: GROUP_BY_TYPE[type] ?? 'other',
      panel: type === 'MiniMaxH3LatentUpscaleModelOpt' ? 'upscale' : undefined,
      params,
      present: true
    })
  }

  return specs.sort((a, b) => {
    const ga = GROUP_ORDER.indexOf(a.group)
    const gb = GROUP_ORDER.indexOf(b.group)
    return ga === gb ? a.title.localeCompare(b.title) : ga - gb
  })
}

/** 没导入 API 基线时，控制台仍然要能编辑放大节点。 */
export function fallbackNodeSpecs(): NodeSpec[] {
  return [
    {
      key: 'MiniMaxH3LatentUpscaleModelOpt#0',
      type: 'MiniMaxH3LatentUpscaleModelOpt',
      title: '二采放大（Latent Upscaler 3D）',
      group: 'second',
      panel: 'upscale',
      params: upscaleParamSpecs(),
      present: false
    }
  ]
}

/* ------------------------------------------------------------------ *
 * 值 <-> API
 * ------------------------------------------------------------------ */

/** 从 API 基线抽出所有可配参数的初始值。 */
export function valuesFromApi(api: ApiWorkflow | null | undefined): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  const counters = new Map<string, number>()
  if (!api) return out

  for (const nodeId of orderedNodeIds(api)) {
    const node = api[nodeId]
    const type = String(node?.class_type ?? '')
    if (!type || HIDDEN_TYPES.has(type)) continue
    const ordinal = counters.get(type) ?? 0
    counters.set(type, ordinal + 1)

    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (isLink(value) || value === null || typeof value === 'object') continue
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        out[`${type}#${ordinal}.${key}`] = value
      }
    }
  }
  return out
}

/** 放大节点的值单独取，因为它的 mode 是个嵌套结构。 */
export function upscaleValuesFromApi(
  api: ApiWorkflow | null | undefined
): Record<string, ParamValue> | null {
  if (!api) return null
  for (const nodeId of Object.keys(api)) {
    const node = api[nodeId]
    if (node?.class_type !== 'MiniMaxH3LatentUpscaleModelOpt') continue
    const inputs = (node.inputs ?? {}) as Record<string, unknown>
    const modeRaw = inputs.mode
    const mode = typeof modeRaw === 'object' && modeRaw !== null
      ? (modeRaw as Record<string, unknown>)
      : { mode: typeof modeRaw === 'string' ? modeRaw : undefined }
    // 三种写法都要认：旧版 dict（mode.megapixels 在 dict 里）、扁平键
    // （inputs['mode.megapixels']，真实导出就是这个）、以及兜底的裸 inputs[k]。
    const pick = (k: string, fallback: ParamValue): ParamValue => {
      const v = mode[k] ?? inputs[k] ?? inputs[`mode.${k}`]
      return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : fallback
    }
    return {
      model_name: pick('model_name', UPSCALE_MODEL_FALLBACK[0]),
      mode: pick('mode', 'megapixels'),
      scale: pick('scale', 2),
      width: pick('width', 1280),
      height: pick('height', 704),
      megapixels: pick('megapixels', 1),
      align: pick('align', 32),
      enable_temporal_chunking: pick('enable_temporal_chunking', true),
      force_unload: pick('force_unload', true),
      device: pick('device', 'cuda'),
      precision: pick('precision', 'fp16')
    }
  }
  return null
}

/**
 * 把模板值写回 API 工作流（深拷贝，不改原对象）。
 *
 * 返回 `{ api, applied, skipped }`：
 * - `applied` 实际写入的参数个数
 * - `skipped` 在工作流里找不到对应节点/键的参数（换工作流后会出现，要如实报出来，
 *   不能静默丢弃 —— 静默丢弃意味着用户以为生效了但跑的是默认值）
 */
export function applyTemplateToApi(
  api: ApiWorkflow,
  values: Record<string, ParamValue>
): { api: ApiWorkflow; applied: number; skipped: string[] } {
  const next: ApiWorkflow = JSON.parse(JSON.stringify(api))
  const byType = nodesByType(next)

  const upscaleBuckets = new Map<string, Record<string, ParamValue>>()
  let applied = 0
  const skipped: string[] = []

  for (const [fullKey, value] of Object.entries(values)) {
    const dot = fullKey.indexOf('.')
    if (dot < 0) {
      skipped.push(fullKey)
      continue
    }
    const nodeKey = fullKey.slice(0, dot)
    const param = fullKey.slice(dot + 1)
    const hash = nodeKey.lastIndexOf('#')
    if (hash < 0) {
      skipped.push(fullKey)
      continue
    }
    const type = nodeKey.slice(0, hash)
    const ordinal = Number(nodeKey.slice(hash + 1))
    const nodeId = byType.get(type)?.[ordinal]
    if (!nodeId) {
      skipped.push(fullKey)
      continue
    }

    if (type === 'MiniMaxH3LatentUpscaleModelOpt') {
      const bucket = upscaleBuckets.get(nodeId) ?? {}
      bucket[param] = value
      upscaleBuckets.set(nodeId, bucket)
      continue
    }

    const inputs = next[nodeId].inputs ?? (next[nodeId].inputs = {})
    if (!(param in inputs)) {
      skipped.push(fullKey)
      continue
    }
    inputs[param] = value
    applied += 1
  }

  for (const [nodeId, bucket] of upscaleBuckets) {
    const inputs = next[nodeId].inputs ?? (next[nodeId].inputs = {})
    if (bucket.mode !== undefined || 'mode' in inputs) {
      applyUpscaleMode(inputs, bucket)
      applied += 1
    }
    for (const [k, v] of Object.entries(bucket)) {
      // mode 与它的子键（mode.*）以及三套子参数都已由 applyUpscaleMode 处理；
      // 这里再写一遍会把切模式前残留的旧子键带回来。
      if (
        k === 'mode' ||
        k.startsWith('mode.') ||
        k === 'scale' ||
        k === 'width' ||
        k === 'height' ||
        k === 'megapixels'
      ) {
        continue
      }
      inputs[k] = v
      applied += 1
    }
  }

  return { api: next, applied, skipped }
}

/* ------------------------------------------------------------------ *
 * 导演节点的 IMAGE 出口是 uint8 —— 原生 CreateVideo 会把整片做成负片
 * ------------------------------------------------------------------ */

/** 接受 uint8 [0,255] 帧的建视频节点（H3 包自带，参数与原生完全兼容） */
export const UINT8_CREATE_VIDEO = 'MiniMaxH3CreateVideoU8Opt'

const DIRECTOR_TYPES = ['ComfyMiniMaxH3DirectorOpt', 'MiniMaxH3DirectorOpt']

/**
 * 把 `CreateVideo` 换成 `MiniMaxH3CreateVideoU8Opt`。
 *
 * 为什么必须换：导演节点的 `images` 出口自 r360-cp 起是 **uint8 [0,255]**
 * （省 3/4 内存，19 段从 25.8 GiB 降到 6.6 GiB）。ComfyUI 原生 `CreateVideo`
 * 假定输入是 float32 [0,1]，写帧时执行 `(frame * 255).byte()` —— 对 uint8
 * 就是整数回绕：`x * 255 mod 256 == 256 - x`，**整片正好变成负片**（白↔黑、
 * 暖↔冷），而写进缓存的段 clip 走的是另一条编码路径（识别 uint8），完全正常。
 * 结果就是"四段片段和合成完全不一致"。
 *
 * U8 版节点认 uint8 直接把字节交给编码器，float32 输入也照样处理，所以是
 * drop-in。只有模板里有导演节点时才动 —— 别的图里的 CreateVideo 没这个前提。
 */
export function upgradeUint8CreateVideo(api: ApiWorkflow): {
  api: ApiWorkflow
  upgraded: number
} {
  const hasDirector = Object.values(api).some(
    (n) => typeof n?.class_type === 'string' && DIRECTOR_TYPES.includes(n.class_type)
  )
  if (!hasDirector) return { api, upgraded: 0 }

  let upgraded = 0
  const next: ApiWorkflow = JSON.parse(JSON.stringify(api))
  for (const node of Object.values(next)) {
    if (!node || node.class_type !== 'CreateVideo') continue
    node.class_type = UINT8_CREATE_VIDEO
    const inputs = (node.inputs ??= {})
    // U8 节点的 bit_depth 是字符串枚举（"8" / "10"），原生是 auto/8/10；
    // 直接透传数字 8 会被 ComfyUI 的 combo 校验拒掉。
    const depth = inputs.bit_depth
    inputs.bit_depth = depth === 10 || depth === '10' ? '10' : '8'
    upgraded += 1
  }
  return { api: next, upgraded }
}
