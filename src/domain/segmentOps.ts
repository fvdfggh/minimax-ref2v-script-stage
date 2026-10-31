/**
 * 段级操作：选段运行 / 分段导出。
 *
 * 这两件事在 ComfyUI 里都是导演节点的原生能力，但入口分在两个地方：
 *   - **选段运行**不是端点，而是时间线 JSON 上的两个键（`runSelectEnabled`
 *     + `runSelection`）。节点在 `parse_run_selection()` 里读它们，勾了哪几段
 *     就只采样哪几段；全选或没勾等于"全跑"。
 *   - **分段导出**是 `POST /minimax/director_opt/segment_export`，只要
 *     `indices`（**数组**，不是逗号串）+ `mode` + `source`。它是纯磁盘操作，
 *     不进队列、不重新渲染。
 *
 * 这里只放纯函数：别让"勾了哪几段"这件事散落在三个组件里各写一遍 ——
 * 索引错一位就是把第 3 段渲到第 2 段的位置上，还看不出错。
 */

import { deepClone } from '@/core/plain'

/** 一遍缓存：一采 / 二采（节点侧叫 1st / 2nd） */
export type ExportSource = 'first' | 'second'

/** 分段导出的两种模式（与节点 `normalize_segment_export_mode` 对齐） */
export type ExportMode = 'piecewise' | 'continuous'

export const EXPORT_MODE_OPTIONS: Array<{
  value: ExportMode
  label: string
  hint: string
}> = [
  {
    value: 'piecewise',
    label: '逐段',
    hint: '每段一个 mp4，直接复制缓存里的成片（不重编码、不失真）'
  },
  {
    value: 'continuous',
    label: '连段',
    hint: '时间线上相邻的选中段接成一个 mp4；孤立的段仍单独出'
  }
]

export const EXPORT_SOURCE_OPTIONS: Array<{ value: ExportSource; label: string }> = [
  { value: 'first', label: '一采' },
  { value: 'second', label: '二采' }
]

/** 时间线里的段数（选段运行的合法范围由它决定） */
export function timelineSegmentCount(timeline: Record<string, unknown> | null): number {
  const segs = timeline?.segments
  return Array.isArray(segs) ? segs.length : 0
}

/**
 * 把任意来源的勾选规范化成合法索引：去重、排序、丢掉越界的。
 *
 * 越界的静默丢弃是刻意的 —— 段被拆并过之后，用户手上那份勾选就可能指到
 * 不存在的槽位；宁可少跑一段并在计数上看得见，也不要让节点抛
 * "index 越界"把整次提交拦下来。
 */
export function normalizeIndices(raw: unknown, count: number): number[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'number' ? [raw] : []
  const out = new Set<number>()
  for (const v of list) {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0) continue
    if (count > 0 && n >= count) continue
    out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

/* ------------------------- 引用上段 = 同一条链 ------------------------- */

/**
 * 「引用上段」把这些段串成一条链。
 *
 * `linked[i]` = 第 i 段生成时要拿**第 i-1 段的末帧**当参考（17k 家族）。
 * 漏掉上游那段，下游就拿着上一代的旧末帧当参考 —— 画面接不上，而且从结果上
 * 根本看不出来是为什么。
 *
 * 但链**不是**勾选的最小单位，按来源分叉（见 `pickSpanFor`）：
 *   · 一采：勾哪段跑哪段。局部重跑是日常操作，上游不跑时沿用缓存里那张末帧；
 *   · 二采：整条链。二采拿一采 latent 放大重采样，中间少一段就接不上。
 *
 * 断链只看 `linked[i]`：第 0 段天然断开；某段不引用上段 ⇒ 它起一条新链。
 * 返回的是连续索引区间，顺序即时间线顺序。
 */
export function segmentChains(linked: boolean[]): number[][] {
  const out: number[][] = []
  let cur: number[] = []
  for (let i = 0; i < linked.length; i++) {
    if (i === 0 || !linked[i]) {
      if (cur.length) out.push(cur)
      cur = [i]
    } else {
      cur.push(i)
    }
  }
  if (cur.length) out.push(cur)
  return out
}

/** 第 i 段所属的整条链（越界就只返回它自己，别让调用方拿到空数组） */
export function chainOfIndex(linked: boolean[], index: number): number[] {
  if (index < 0) return []
  if (index >= linked.length) return [index]
  return segmentChains(linked).find((c) => c.includes(index)) ?? [index]
}

/**
 * 按链补齐勾选：勾中任意一段 ⇒ 整条链都进来。
 *
 * 只给**二采**用（见 `expandPicksFor`）—— 二采拿一采 latent 放大重采样，
 * 半条链进来前后段接不上，拼片会断。
 */
export function expandChainSelection(indices: unknown, linked: boolean[]): number[] {
  const out = new Set<number>()
  for (const i of normalizeIndices(indices, linked.length)) {
    for (const j of chainOfIndex(linked, i)) out.add(j)
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * 勾一段时实际要带上的段。
 *
 * - **一采**：只它自己。改一句台词只想重出这一段，扩链等于把"重跑一段"
 *   悄悄变成"整集重跑"；节点侧 `runSelection` 支持任意子集，上游没跑时
 *   下游段沿用上一次留在缓存里的末帧。
 * - **二采**：整条链。二采读的是一采 latent，中间少一段就接不上。
 *
 * 这条分叉只写在这里，别在组件里各写一遍 —— 一采二采的勾选混在一起，
 * 下一次改动必然漏掉其中一处。
 */
export function pickSpanFor(
  source: ExportSource,
  linked: boolean[],
  index: number
): number[] {
  return source === 'second' ? chainOfIndex(linked, index) : [index]
}

/**
 * 按来源把勾选补成"实际要跑 / 要导的段"。
 *
 * 一采原样返回（只做规范化），二采按链补齐。`count` 用来挡掉越界槽位：
 * 段被拆并过之后，旧勾选可能指到不存在的位置。
 */
export function expandPicksFor(
  source: ExportSource,
  indices: unknown,
  linked: boolean[],
  count = linked.length
): number[] {
  const base = normalizeIndices(indices, count)
  if (source !== 'second') return base
  return expandChainSelection(base, linked).filter((i) => count <= 0 || i < count)
}

/** 勾选覆盖了几条链（提交前告诉用户"这 3 段其实是 1 条链"） */
export function pickedChainCount(linked: boolean[], picked: number[]): number {
  if (!picked.length) return 0
  const set = new Set(picked)
  return segmentChains(linked).filter((c) => c.some((i) => set.has(i))).length
}

/** 链的短标签：单段 `seg02`，多段 `seg02–seg04` */
export function chainLabel(chain: number[]): string {
  if (!chain.length) return ''
  const name = (i: number) => `seg${String(i + 1).padStart(2, '0')}`
  return chain.length === 1 ? name(chain[0]) : `${name(chain[0])}–${name(chain[chain.length - 1])}`
}

/**
 * 往时间线里写「选择运行」。
 *
 * 语义与节点保持一致：勾满（或一个都没勾）就等于全跑 ⇒ 把开关关掉，
 * 别留一个 `runSelectEnabled: true` + 全选的组合在缓存里 —— 以后段时间线
 * 一改、段数一多，这份"全选"就默默变成了"只跑前面那几段"。
 *
 * 返回新对象（不原地改）：调用方拿到的可能是 history 里那份，改它会让
 * "上次提交的时间线"跟着变，而它本该是只读的历史。
 */
export function applyRunSelection(
  timeline: Record<string, unknown>,
  indices: unknown
): Record<string, unknown> {
  const count = timelineSegmentCount(timeline)
  const picked = normalizeIndices(indices, count)
  const all = count > 0 && picked.length >= count
  if (!picked.length || all) {
    return { ...timeline, runSelectEnabled: false, runSelection: [] }
  }
  return { ...timeline, runSelectEnabled: true, runSelection: picked }
}

/** 这次提交是"全跑"还是"只跑这几段"（给日志/任务卡片用） */
export function selectionSummary(count: number, picked: number[]): string {
  if (!count) return '无段'
  if (!picked.length || picked.length >= count) return `全部 ${count} 段`
  return `选中 ${picked.length}/${count} 段`
}

/**
 * 把「选择运行」打进一份**已经提交过的 prompt**（复现上次配方时用）。
 *
 * 为什么需要这条路：产物页看到的是**缓存**，而缓存可能比本地段活得更久 ——
 * 段被清空/重排之后，本地已经编不出当初那份导演包了，但"只想重跑第 3 段"
 * 这个诉求依然成立。这时唯一可靠的输入就是 history 里那份 prompt 原文：
 * 它带着当时的模型、步数、种子、参考图路径和完整时间线。
 *
 * 返回深拷贝（绝不改 history 里那份），找不到节点/时间线就抛 —— 猜一个
 * 默认值提交出去，等于悄悄换了一套参数跑，比报错糟得多。
 */
export function patchPromptTimeline(
  api: Record<string, unknown>,
  nodeId: string,
  indices: unknown
): Record<string, unknown> {
  const next = deepClone(api) as Record<string, unknown>
  const node = next[nodeId] as { inputs?: Record<string, unknown> } | undefined
  if (!node) throw new Error(`这份提交里没有导演节点 ${nodeId}，无法沿用它的配方重跑`)
  const inputs = node.inputs ?? (node.inputs = {})
  const raw = inputs.timeline_data
  let timeline: Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      timeline = JSON.parse(raw) as Record<string, unknown>
    } catch {
      throw new Error('这份提交里的时间线不是合法 JSON，无法沿用')
    }
  } else if (raw && typeof raw === 'object') {
    timeline = raw as Record<string, unknown>
  } else {
    throw new Error('这份提交里没有时间线，无法按段重跑')
  }
  inputs.timeline_data = JSON.stringify(applyRunSelection(timeline, indices))
  return next
}

/**
 * 改一份已提交 prompt 里导演节点的若干输入（沿用配方时改"二采只出"这类开关）。
 *
 * 只在该节点上动手，别的一律不碰 —— 这份 prompt 是历史产物，随手改别的键
 * 就等于用今天的参数跑昨天的任务，出片和缓存对不上还查不出来。
 */
export function patchPromptInputs(
  api: Record<string, unknown>,
  nodeId: string,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const next = deepClone(api) as Record<string, unknown>
  const node = next[nodeId] as { inputs?: Record<string, unknown> } | undefined
  if (!node) throw new Error(`这份提交里没有导演节点 ${nodeId}`)
  node.inputs = { ...(node.inputs ?? {}), ...patch }
  return next
}

/* ------------------------------ 分段导出 ------------------------------ */

export interface ExportedFile {
  /** ComfyUI 机器上的绝对路径（原样，给"复制路径"用） */
  path: string
  /** 能经剧本台后端播放的文件名 */
  filename: string
  /** `output/` 下的相对目录，交给 /api/comfy/view 的 subfolder */
  subfolder: string
}

export interface SegmentExportResult {
  files: ExportedFile[]
  skipped: Array<{ index: number; reason: string }>
  /** 导出目录（ComfyUI 机器上的路径） */
  exportDir: string
  mode: string
  source: string
}

/**
 * 导出文件的绝对路径 → `/api/comfy/view` 认识的三元组。
 *
 * 导出的 mp4 落在 `output/minimax_segment_export/<node>/`，而 `/view` 只认
 * "相对 output 的 subfolder + 文件名"。切不出这个前缀（用户配了自定义输出
 * 目录）就返回 null —— 那就只显示路径，别拼一个必然 404 的链接出来。
 */
export function splitExportedPath(path: string): { filename: string; subfolder: string } | null {
  const norm = String(path || '').replace(/\\/g, '/')
  const marker = '/output/'
  const at = norm.lastIndexOf(marker)
  if (at < 0) return null
  const rel = norm.slice(at + marker.length)
  const slash = rel.lastIndexOf('/')
  if (slash < 0) return null
  const filename = rel.slice(slash + 1)
  if (!filename) return null
  return { filename, subfolder: rel.slice(0, slash) }
}

/**
 * 解析 `segment_export` 的响应。
 *
 * 节点返回 `{ files: string[], skipped: [{index, reason}], export_dir, mode, source }`；
 * 失败的段不是异常，而是列在 `skipped` 里 —— 千万别当成功一笔带过，
 * 否则用户以为导了 4 段，实际只出了 2 段。
 */
export function parseExportResult(json: unknown): SegmentExportResult {
  const root = (json ?? {}) as Record<string, unknown>
  if (typeof root.error === 'string' && root.error) throw new Error(root.error)
  const files = Array.isArray(root.files) ? root.files.map((f) => String(f)) : []
  const skippedRaw = Array.isArray(root.skipped) ? root.skipped : []
  const skipped = skippedRaw.map((s) => {
    const row = (s ?? {}) as Record<string, unknown>
    return {
      index: Number(row.index ?? -1),
      reason: String(row.reason ?? '未知原因')
    }
  })
  return {
    files: files.map((path) => {
      const tail = splitExportedPath(path)
      return {
        path,
        filename: tail?.filename ?? path,
        subfolder: tail?.subfolder ?? ''
      }
    }),
    skipped,
    exportDir: String(root.export_dir ?? ''),
    mode: String(root.mode ?? ''),
    source: String(root.source ?? '')
  }
}
