/**
 * 把两种来源的节点定义归一成同一套 ParamSpec。
 *
 * 为什么要归一：ComfyUI 的 `/object_info` 只在进程活着时给得出，而用户的大半
 * 时间是"先配参数、待会儿再起服务"。所以又加了从节点包源码静态抽的一条路。
 * 两条路的原始结构完全不同，UI 不该关心它拿到的是哪一份 —— 归一之后，
 * 参数中心在两种状态下长得一样，只是标注一下来源和覆盖程度。
 *
 * 参数键统一是 `class_type#序号.参数名`，和模板的键完全一致：
 * 这样在"全部参数"里配好的值，导入工作流后能被 applyTemplateToApi 直接命中，
 * 不需要任何迁移。
 */

import type { NodeGroup, ParamKind, ParamSpec, ParamValue } from './workflow'

export interface NodeSchema {
  /** class_type。模板键的前半段就是它。 */
  type: string
  display: string
  category: string
  group: NodeGroup
  params: ParamSpec[]
  source: 'object_info' | 'source'
}

/** object_info 里单个参数的原始形态：`[类型或候选数组, 配置]` */
type RawInput = [unknown, Record<string, unknown>?] | unknown

interface RawNodeInfo {
  input?: { required?: Record<string, RawInput>; optional?: Record<string, RawInput> }
  display_name?: string
  category?: string
  description?: string
}

const SCALAR_KINDS: Record<string, ParamKind> = {
  INT: 'int',
  FLOAT: 'float',
  STRING: 'text',
  BOOLEAN: 'bool',
  COMBO: 'enum'
}

/** object_info 的 category → 本项目的分组。匹配不上就落 other。 */
const CATEGORY_GROUPS: Array<{ test: RegExp; group: NodeGroup }> = [
  { test: /lora|adapter/i, group: 'lora' },
  { test: /model|loader|unet|checkpoint|diffusion/i, group: 'model' },
  { test: /sampl|sigmas|scheduler|guid/i, group: 'sample' },
  { test: /upscal|second|refine/i, group: 'second' },
  { test: /accel|speed|chunk|offload|memory|cache|multigpu|pipeline/i, group: 'accel' },
  { test: /video|audio|save|output|export/i, group: 'output' },
  { test: /preview|image[-_ ]?show|display|view/i, group: 'preview' }
]

export function groupOf(type: string, category: string): NodeGroup {
  const hay = `${type} ${category}`
  if (/director|timeline/i.test(hay)) return 'sample'
  for (const c of CATEGORY_GROUPS) if (c.test.test(hay)) return c.group
  return 'other'
}

function toParamValue(v: unknown): ParamValue | null {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  return null
}

function normalizeOne(name: string, raw: RawInput, section: 'required' | 'optional'): ParamSpec | null {
  if (!Array.isArray(raw)) return null
  const [typeOrList, opts = {}] = raw as [unknown, Record<string, unknown>]

  // 候选数组直接当枚举（ComfyUI 的 COMBO 就这么表示）
  if (Array.isArray(typeOrList)) {
    const options = typeOrList
      .map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : null))
      .filter((x): x is string => x !== null)
    if (!options.length) return null
    const def = toParamValue(opts.default) ?? options[0]
    return {
      key: name,
      label: name,
      kind: 'enum',
      default: def,
      options,
      hint: typeof opts.tooltip === 'string' ? opts.tooltip : ''
    }
  }

  const kind = SCALAR_KINDS[String(typeOrList).toUpperCase()]
  // 其它类型名（MODEL / CLIP / LATENT …）都是连线，值来自上游，不给手填入口
  if (!kind) return null

  const spec: ParamSpec = {
    key: name,
    label: name,
    kind,
    default: toParamValue(opts.default) ?? defaultOf(kind),
    hint: typeof opts.tooltip === 'string' ? opts.tooltip : ''
  }
  if (kind === 'int' || kind === 'float') {
    for (const k of ['min', 'max', 'step'] as const) {
      const v = opts[k]
      if (typeof v === 'number' && Number.isFinite(v)) spec[k] = v
    }
  }
  if (section === 'optional') spec.hint = spec.hint ? `${spec.hint}（可选）` : '（可选）'
  return spec
}

function defaultOf(kind: ParamKind): ParamValue {
  if (kind === 'int' || kind === 'float') return 0
  if (kind === 'bool') return false
  return ''
}

/**
 * `/object_info` 的完整响应 → NodeSchema 列表。
 *
 * 只保留带参数的类型：接线类节点（Note / Reroute 之类）没有可配输入，
 * 列出来只会让列表变长。
 */
export function normalizeObjectInfo(doc: unknown): NodeSchema[] {
  if (!doc || typeof doc !== 'object') return []
  const out: NodeSchema[] = []
  for (const [type, info] of Object.entries(doc as Record<string, RawNodeInfo>)) {
    if (!info || typeof info !== 'object') continue
    const params: ParamSpec[] = []
    for (const section of ['required', 'optional'] as const) {
      const block = info.input?.[section]
      if (!block || typeof block !== 'object') continue
      for (const [name, raw] of Object.entries(block)) {
        const spec = normalizeOne(name, raw, section)
        // 同名只保留一份（optional 里重复定义时以 required 为准）
        if (spec && !params.some((p) => p.key === name)) params.push(spec)
      }
    }
    if (!params.length) continue
    const category = String(info.category ?? '')
    out.push({
      type,
      display: String(info.display_name || type),
      category,
      group: groupOf(type, category),
      params,
      source: 'object_info'
    })
  }
  return out
}

/** 后端 `?kind=nodes` 的返回 → NodeSchema 列表（离线兜底） */
export function normalizeSourceScan(doc: unknown): NodeSchema[] {
  if (!doc || typeof doc !== 'object') return []
  const nodes = (doc as { nodes?: Record<string, unknown> }).nodes
  if (!nodes || typeof nodes !== 'object') return []
  const out: NodeSchema[] = []
  for (const [type, raw] of Object.entries(nodes as Record<string, Record<string, unknown>>)) {
    const list = Array.isArray(raw?.params) ? raw.params : []
    const params: ParamSpec[] = []
    for (const p of list) {
      if (!p || typeof p !== 'object') continue
      const name = String((p as { name?: unknown }).name ?? '')
      const kind = String((p as { kind?: unknown }).kind ?? '')
      if (!name || !['int', 'float', 'bool', 'text', 'enum'].includes(kind)) continue
      const spec: ParamSpec = {
        key: name,
        label: name,
        kind: kind as ParamKind,
        default: toParamValue((p as { default?: unknown }).default) ?? defaultOf(kind as ParamKind),
        hint: String((p as { tooltip?: unknown }).tooltip ?? '')
      }
      if (kind === 'int' || kind === 'float') {
        for (const k of ['min', 'max', 'step'] as const) {
          const v = (p as Record<string, unknown>)[k]
          if (typeof v === 'number' && Number.isFinite(v)) spec[k] = v
        }
      }
      const options = (p as { options?: unknown }).options
      if (Array.isArray(options)) spec.options = options.map(String)
      params.push(spec)
    }
    if (!params.length) continue
    const category = String((raw as { category?: unknown })?.category ?? '')
    out.push({
      type,
      display: String((raw as { display?: unknown })?.display ?? type),
      category,
      group: groupOf(type, category),
      params,
      source: 'source'
    })
  }
  return out
}

/**
 * 合并两源：在线优先。
 *
 * 在线那份是 ComfyUI 自己报的，连枚举候选都给全；静态那份是源码猜的，
 * 动态构造的 INPUT_TYPES 会漏参数。所以**只用来补缺失的类型**，
 * 不拿它覆盖在线结果。
 */
export function mergeSchemas(online: NodeSchema[], offline: NodeSchema[]): NodeSchema[] {
  const map = new Map<string, NodeSchema>()
  for (const n of offline) map.set(n.type, n)
  for (const n of online) map.set(n.type, n)
  return [...map.values()].sort((a, b) => a.type.localeCompare(b.type))
}
