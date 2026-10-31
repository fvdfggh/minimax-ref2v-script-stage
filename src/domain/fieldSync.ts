import type { FieldSync, ID, Lang } from './types'

/* ------------------------------------------------------------------ *
 * 同步清单
 *
 * 中英两份字段互为备份，任何一方或它引用的内容动了，另一方就落后了。
 * 这里只回答两件事：
 *   1. 谁是变化点（谁刚被改过）—— 它是这次同步的依据；
 *   2. 谁该向谁对齐（非变化点向变化点对齐）。
 *
 * 不做任何写入，也不调模型。页面按 action 决定是重译、回译还是重生成。
 * ------------------------------------------------------------------ */

/** 同步一步要做的事 */
export type SyncAction =
  /** 中文变化 → 把英文重译成中文的样子 */
  | 'translate'
  /** 英文变化 → 把中文按英文回写 */
  | 'backtranslate'
  /** 引用变化 → 中文按新素材重生成 */
  | 'regen'

export interface SyncItem {
  /** groupId + fieldKey，用作列表 key */
  id: string
  groupId: ID
  /** 第几段（1 起），界面上只认这个 */
  segNo: number
  fieldKey: string
  /** 中文字段名 */
  label: string
  /** 变化点：中文 / 英文 / 引用 */
  changed: 'zh' | 'en' | 'src'
  /** 非变化点：这一次要对齐的一侧 */
  align: Lang | 'both'
  /** 依次要执行的动作 */
  steps: SyncAction[]
  /** 一句话说清"谁变了、谁向谁对齐" */
  reason: string
  /** 两侧都被改过：无法自动判断该听谁的，只能人来定 */
  needsManual: boolean
}

export interface SyncSegmentInput {
  groupId: ID
  /** 段号，1 起 */
  segNo: number
  /** 中文字段 */
  zh: Record<string, string>
  /** 英文字段 */
  en: Record<string, string>
  /** 每个字段两侧的状态（domain/pairs.ts 的 syncOf） */
  sync: Record<string, FieldSync>
  /** 这一段引用的片段/实体变过（段级过期） */
  stale: boolean
  /**
   * 引用确实变了。
   *
   * 段级 stale 只能说明"跟上次生成时不一致"，老数据没有逐字段基线时，
   * 它既可能来自引用变化、也可能来自口径升级。这里由调用方显式给出结论：
   * 两份都有内容却又引用了变了，就都该重做 —— 谁对齐谁都没意义。
   */
  srcChanged?: boolean
  /** 引用变化的说明，例如「第 2 拍的画面描述改了」，可为空 */
  srcNote?: string
}

export interface SyncFieldMeta {
  key: string
  label: string
  /** 只有模型字段需要同步；派生字段由引擎按词条各算一遍，天然对齐 */
  source: 'llm' | 'derived'
}

const ACTION_TEXT: Record<SyncAction, string> = {
  translate: '重译英文',
  backtranslate: '回写中文',
  regen: '重生成中文'
}

export function actionText(a: SyncAction): string {
  return ACTION_TEXT[a]
}

/** 变化点的说法 */
export function changedText(item: SyncItem): string {
  if (item.changed === 'src') return '引用变了'
  return item.changed === 'zh' ? '中文改了' : '英文改了'
}

/** 对齐方向的说法：非变化点 → 变化点 */
export function alignText(item: SyncItem): string {
  if (item.align === 'both') return '两份都按新素材重做'
  if (item.align === 'en') return '英文对齐中文'
  return '中文对齐英文'
}

function item(
  seg: SyncSegmentInput,
  f: SyncFieldMeta,
  state: FieldSync,
  srcNote: string | undefined
): SyncItem | null {
  const base = {
    id: `${seg.groupId}:${f.key}`,
    groupId: seg.groupId,
    segNo: seg.segNo,
    fieldKey: f.key,
    label: f.label
  }

  switch (state) {
    case 'src-newer':
      return {
        ...base,
        changed: 'src',
        align: 'both',
        steps: ['regen', 'translate'],
        reason: srcNote || '引用的片段或主体改过',
        needsManual: false
      }

    case 'zh-newer':
    case 'zh-only':
      return {
        ...base,
        changed: 'zh',
        align: 'en',
        steps: ['translate'],
        reason: state === 'zh-only' ? '英文还没有' : '英文还是旧版',
        needsManual: false
      }

    case 'en-newer':
    case 'en-only':
      return {
        ...base,
        changed: 'en',
        align: 'zh',
        steps: ['backtranslate'],
        reason: state === 'en-only' ? '中文还没有' : '中文还是旧版',
        needsManual: false
      }

    case 'conflict':
      return {
        ...base,
        changed: 'zh',
        align: 'both',
        steps: [],
        reason: '两份都改过，没有唯一的变化点',
        needsManual: true
      }

    default:
      return null
  }
}

/**
 * 收集所有待同步项。
 *
 * 只收模型字段：派生字段（主体定义 / 留人分析 / 详细描述）由引擎按当段素材
 * 现算，中英各渲染一遍，不存在"一份落后于另一份"。
 */
export function collectSyncItems(
  segs: SyncSegmentInput[],
  fields: SyncFieldMeta[]
): SyncItem[] {
  const out: SyncItem[] = []
  for (const seg of segs) {
    for (const f of fields) {
      if (f.source !== 'llm') continue
      // 引用变了就逐字段补齐；没有逐字段状态时退回段级 stale
      const zh = (seg.zh[f.key] ?? '').trim()
      const en = (seg.en[f.key] ?? '').trim()
      let derived: FieldSync | undefined = seg.sync[f.key]

      /*
       * 引用变了 → 内容本身就是旧的，跟"哪一侧更新"无关。
       * 哪怕只有一侧有内容，也不能拿旧的英文回写中文：回写出来的仍然是
       * 没包含新片段的那一版。所以一律整段重做。
       */
      if (seg.srcChanged && (zh || en)) derived = 'src-newer'

      // 没有逐字段状态时，段级过期是唯一的线索
      if (!derived && seg.stale && (zh || en)) derived = 'src-newer'

      if (!derived) continue
      const it = item(seg, f, derived, seg.srcNote)
      if (it) out.push(it)
    }
  }
  // 段号升序、段内保持字段声明顺序
  const order = new Map(fields.map((f, i) => [f.key, i]))
  return out.sort(
    (a, b) => a.segNo - b.segNo || (order.get(a.fieldKey) ?? 0) - (order.get(b.fieldKey) ?? 0)
  )
}

/** 归类统计：页面顶部那行数字 */
export interface SyncStats {
  total: number
  /** 需要人来定的 */
  manual: number
  /** 涉及几段 */
  segments: number
  byChanged: Record<'zh' | 'en' | 'src', number>
}

export function statsOf(items: SyncItem[]): SyncStats {
  const byChanged = { zh: 0, en: 0, src: 0 }
  const segs = new Set<ID>()
  let manual = 0
  for (const i of items) {
    byChanged[i.changed]++
    segs.add(i.groupId)
    if (i.needsManual) manual++
  }
  return { total: items.length, manual, segments: segs.size, byChanged }
}

/**
 * 把同步项压成「每段要做什么」。
 *
 * 模型是按段调用的，逐字段调用等于同一段要跑好几遍 —— 同一段里
 * 多个字段的同步合并成一次请求，省时也更一致。
 */
export interface SyncBatch {
  groupId: ID
  segNo: number
  keys: string[]
  steps: SyncAction[]
  items: SyncItem[]
}

export function batchOf(items: SyncItem[]): SyncBatch[] {
  const map = new Map<ID, SyncBatch>()
  for (const it of items) {
    if (it.needsManual) continue
    let b = map.get(it.groupId)
    if (!b) {
      b = { groupId: it.groupId, segNo: it.segNo, keys: [], steps: [], items: [] }
      map.set(it.groupId, b)
    }
    if (!b.keys.includes(it.fieldKey)) b.keys.push(it.fieldKey)
    for (const s of it.steps) if (!b.steps.includes(s)) b.steps.push(s)
    b.items.push(it)
  }
  // 先重生成再翻译：引用变了的段，英文要基于新的中文重译
  const order: SyncAction[] = ['regen', 'backtranslate', 'translate']
  return [...map.values()].sort((a, b) => a.segNo - b.segNo).map((b) => ({
    ...b,
    steps: order.filter((s) => b.steps.includes(s))
  }))
}
