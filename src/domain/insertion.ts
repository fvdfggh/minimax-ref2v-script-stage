/**
 * 段的增删机制。
 *
 * 组合 + 缝合之后，段往往已经出片了。这时候再增删内容只有两条正路：
 *
 *   1. **插空**：新建一段，别碰已有的段。已有的段 id、镜头序列、接缝判定都不变；
 *      导演节点的缓存按**内容哈希**寻址（位置由它自己的槽位表管），所以位置往后
 *      挪一段也照样命中旧片，不用重跑。
 *   2. **不得不动**（把镜头并进去 / 从中间切开 / 合并两段）：那一段的成片立刻
 *      作废，写进台账并标成「待重跑」，别让人拿着旧片当新片交。
 *
 * 本文件只放纯计算：什么算"内容变了"、新片段该插哪儿、并进去会废掉谁。
 * 不碰 store、不碰 UI —— 这样这些规则能被单测钉住，也能被导出/交付复用。
 */
import { uid } from '@/core/id'
import { fingerprint } from './cascade'
import { beatFrames } from './timing'
import type { Assembly, Beat, Group, ID, ProjectSettings, SegmentLock } from './types'
import { DEFAULT_SETTINGS } from './types'

/** H3 最小网格：5 + 17 = 22 帧。比它还短的独立段只能靠补副帧撑起来 */
export const MIN_STANDALONE_FRAMES = 22

/* ------------------------------------------------------------------ *
 * 渲染指纹：这一段"画出来是什么"
 * ------------------------------------------------------------------ */

/** 一条要计入指纹的素材（关键帧 / 参考音视频） */
export interface RenderAssetSig {
  id: ID
  refId?: ID
  kind?: string
  media?: string
  role?: string
  placement?: string
  frameIdx?: number
}

export interface RenderHashInput {
  /** 素材化后的片段序列（含 preshoot / tail_cut / black） */
  beats: Beat[]
  /** 副帧表 */
  pad?: Record<ID, number> | null
  /** 段总帧数（含副帧） */
  frames: number
  refPrev: boolean
  continuityFromPrev: boolean
  continuityToNext: boolean
  /** 实际提交的提示词（composeSegmentText 的结果） */
  text: string
  /** 挂在这一段片段上的素材 */
  assets?: RenderAssetSig[]
  settings?: ProjectSettings
}

/**
 * 只收"会改变画面"的因素，和导演节点自己的指纹口径对齐：
 * 提示词、时长、连续性、参考素材、以及哪些片段（含自动拼接片段）占了多少帧。
 *
 * 刻意**不**收 beat 的标题 / 台词 / 运镜 —— 它们是通过派生字段进提示词的，
 * 提示词没变就等于画面没变；把它们算进来会让"改了个不参与提示词的标题"也报失效。
 */
export function renderHashOf(input: RenderHashInput): string {
  const settings = input.settings ?? DEFAULT_SETTINGS
  const pad = input.pad ?? {}
  const parts: string[] = ['r1']

  for (const b of input.beats) {
    const frames = beatFrames(b, settings) + Math.round(pad[b.id] ?? 0)
    parts.push([b.id, b.kind, String(frames)].join('\u0001'))
  }

  parts.push(
    [
      `f=${Math.round(input.frames)}`,
      `prev=${input.refPrev ? 1 : 0}`,
      `cin=${input.continuityFromPrev ? 1 : 0}`,
      `cout=${input.continuityToNext ? 1 : 0}`
    ].join('\u0001')
  )
  parts.push(input.text)

  const beatIds = new Set(input.beats.map((b) => b.id))
  const assets = (input.assets ?? [])
    .filter((a) => (a.refId ? beatIds.has(a.refId) : false))
    .map((a) =>
      [a.id, a.kind ?? '', a.media ?? '', a.role ?? '', a.placement ?? '', String(a.frameIdx ?? 0)].join(
        ':'
      )
    )
    .sort()
  if (assets.length) parts.push(assets.join('\u0002'))

  return fingerprint(parts.join('\u0003'))
}

/* ------------------------------------------------------------------ *
 * 结果状态
 * ------------------------------------------------------------------ */

export type ResultState = 'none' | 'ready' | 'moved' | 'stale' | 'voided'

export interface ResultStatus {
  state: ResultState
  /** 界面上那个小徽章的文案 */
  label: string
  /** 为什么（空串 = 没什么好说的） */
  reason: string
  /** 相比出片时新增 / 删掉的镜头 */
  added: ID[]
  removed: ID[]
  /** 出片时的段序号（0 基） */
  slotThen: number | null
}

export interface ResultStatusInput {
  lock?: SegmentLock | null
  voided?: { at: number; reason: string } | null
  hash: string
  slot: number
  beatIds: ID[]
}

/**
 * 这一段现在还算不算数。
 *
 * `moved` 是有意和 `stale` 分开的：内容没变、只是段号往后挪了，节点的缓存按内容
 * 寻址，成片还能用 —— 这正好是"插空不废已有段"的依据。
 */
export function resultStatus(input: ResultStatusInput): ResultStatus {
  const { lock, voided, hash, slot, beatIds } = input
  const added: ID[] = []
  const removed: ID[] = []
  if (lock) {
    const now = new Set(beatIds)
    const then = new Set(lock.beatIds)
    for (const id of beatIds) if (!then.has(id)) added.push(id)
    for (const id of lock.beatIds) if (!now.has(id)) removed.push(id)
  }

  if (voided) {
    return {
      state: 'voided',
      label: '已失效',
      reason: voided.reason,
      added,
      removed,
      slotThen: lock?.slot ?? null
    }
  }
  if (!lock) {
    return { state: 'none', label: '未出片', reason: '', added, removed, slotThen: null }
  }
  if (lock.hash !== hash) {
    const bits: string[] = []
    if (added.length) bits.push(`新增 ${added.length} 个镜头`)
    if (removed.length) bits.push(`删掉 ${removed.length} 个镜头`)
    if (!bits.length) bits.push('帧长 / 接缝 / 素材变了')
    return {
      state: 'stale',
      label: '待重跑',
      reason: `内容已改：${bits.join('，')}`,
      added,
      removed,
      slotThen: lock.slot
    }
  }
  if (lock.slot !== slot) {
    return {
      state: 'moved',
      label: '已出片 · 位置变了',
      reason: `第 ${lock.slot + 1} 段 → 第 ${slot + 1} 段；内容没变，成片按内容复用`,
      added,
      removed,
      slotThen: lock.slot
    }
  }
  return { state: 'ready', label: '已出片', reason: '', added, removed, slotThen: lock.slot }
}

/** 已经出过片的段：动它就要标失效 */
export function isProduced(g: Group): boolean {
  return !!g.lock
}

/* ------------------------------------------------------------------ *
 * 归位：新片段默认插空，不再偷塞进别人段里
 * ------------------------------------------------------------------ */

export interface GapReconcileOptions {
  settings?: ProjectSettings
  /** 待编排片段：用户主动放在一边的，不算孤立片段 */
  parked?: ID[]
}

export interface GapReconcileResult {
  groups: Group[]
  /** 新纳入分组的片段数（含被吸收的） */
  adopted: number
  /** 因片段被删而从分组里清掉的引用数 */
  dropped: number
  /** 被抽空后丢弃的段数 */
  removedGroups: number
  /** 新开的段数 */
  spawned: number
  /** 新开的段 id */
  spawnedIds: ID[]
  changed: boolean
}

/**
 * 分组归位（插空优先版）。
 *
 * 和 `cascade.reconcileGroups` 的差别只有一条，但很关键：
 * **只要这个方案里有段出过片，新片段就绝不再并进相邻段**，而是自己开一段插在
 * 那个位置。代价是段数变多（多一次渲染），换来的是已出的片一张都不作废。
 *
 * 还没出过片的方案照旧合并 —— 那时没有"已有结果"要保护，合并更省渲染。
 */
export function reconcileWithGaps(
  groups: Group[],
  beats: Beat[],
  options: GapReconcileOptions = {}
): GapReconcileResult {
  const settings = options.settings ?? DEFAULT_SETTINGS
  const parked = new Set(options.parked ?? [])
  const ordered = [...beats].sort((a, b) => a.order - b.order)
  const liveIds = new Set(ordered.map((b) => b.id))
  const orderOf = new Map(ordered.map((b, i) => [b.id, i]))

  let dropped = 0
  const kept: Group[] = []
  for (const g of groups) {
    const ids = g.beatIds.filter((id) => liveIds.has(id))
    dropped += g.beatIds.length - ids.length
    if (ids.length) kept.push({ ...g, beatIds: ids })
  }
  const removedGroups = groups.length - kept.length

  let out = kept.map((g) => ({ ...g, beatIds: [...g.beatIds] }))
  const assigned = new Set(out.flatMap((g) => g.beatIds))
  const orphans = ordered.filter((b) => !assigned.has(b.id) && !parked.has(b.id))

  if (!orphans.length) {
    return {
      groups: out,
      adopted: 0,
      dropped,
      removedGroups,
      spawned: 0,
      spawnedIds: [],
      changed: dropped > 0 || removedGroups > 0
    }
  }

  // 连续的新片段算一段：一次插空插一整块，不要一个镜头开一段
  const runs: Beat[][] = []
  for (const b of orphans) {
    const last = runs[runs.length - 1]
    const lastBeat = last?.[last.length - 1]
    if (last && lastBeat && orderOf.get(b.id) === (orderOf.get(lastBeat.id) ?? -9) + 1) last.push(b)
    else runs.push([b])
  }

  const anyProduced = out.some(isProduced)
  const spawnedIds: ID[] = []

  for (const run of runs) {
    const at = orderOf.get(run[0].id) ?? 0
    const runFrames = run.reduce((s, b) => s + beatFrames(b, settings), 0)
    const short = runFrames < MIN_STANDALONE_FRAMES

    // 前/后最近的、已经入组的片段
    let prevIdx = -1
    let prevBeatId: ID | null = null
    for (let i = at - 1; i >= 0; i--) {
      const k = out.findIndex((g) => g.beatIds.includes(ordered[i].id))
      if (k >= 0) {
        prevIdx = k
        prevBeatId = ordered[i].id
        break
      }
    }
    let nextIdx = -1
    for (let i = at + run.length; i < ordered.length; i++) {
      const k = out.findIndex((g) => g.beatIds.includes(ordered[i].id))
      if (k >= 0) {
        nextIdx = k
        break
      }
    }

    const prev = prevIdx >= 0 ? out[prevIdx] : null
    const next = nextIdx >= 0 ? out[nextIdx] : null

    // 没出过片：照旧并进相邻段，省一次渲染
    if (!anyProduced) {
      if (prev) {
        const pos = prevBeatId ? prev.beatIds.indexOf(prevBeatId) : -1
        prev.beatIds.splice(pos >= 0 ? pos + 1 : prev.beatIds.length, 0, ...run.map((b) => b.id))
      } else if (next) {
        next.beatIds.unshift(...run.map((b) => b.id))
      } else {
        const g: Group = { id: uid('grp'), beatIds: run.map((b) => b.id), inserted: true }
        out = [g]
        spawnedIds.push(g.id)
      }
      continue
    }

    // 出过片：短块优先塞进**还没出片**的邻居（并了也不作废任何东西）
    if (short && prev && !isProduced(prev)) {
      const pos = prevBeatId ? prev.beatIds.indexOf(prevBeatId) : -1
      prev.beatIds.splice(pos >= 0 ? pos + 1 : prev.beatIds.length, 0, ...run.map((b) => b.id))
      continue
    }
    if (short && next && !isProduced(next)) {
      next.beatIds.unshift(...run.map((b) => b.id))
      continue
    }

    // 其余一律插空：新开一段，谁也不动
    const g: Group = { id: uid('grp'), beatIds: run.map((b) => b.id), inserted: true }
    const insertAt = prevIdx >= 0 ? prevIdx + 1 : nextIdx >= 0 ? nextIdx : out.length
    out.splice(insertAt, 0, g)
    spawnedIds.push(g.id)
  }

  return {
    groups: out,
    adopted: orphans.length,
    dropped,
    removedGroups,
    spawned: spawnedIds.length,
    spawnedIds,
    changed: true
  }
}

/* ------------------------------------------------------------------ *
 * 增删的"会伤到谁"
 * ------------------------------------------------------------------ */

export type EditKind = 'insert-gap' | 'absorb' | 'split' | 'merge' | 'delete'

export interface EditImpact {
  /** 会被作废、需要重跑的段 */
  invalidates: ID[]
  /** 新开的段数 */
  spawns: number
  /** 一句人话，直接能放按钮旁边 */
  note: string
}

function groupLabel(groups: Group[], id: ID): string {
  const i = groups.findIndex((g) => g.id === id)
  return i >= 0 ? `seg${String(i + 1).padStart(2, '0')}` : '这一段'
}

/** 把镜头并进某一段，会发生什么 */
export function absorbImpact(groups: Group[], groupId: ID): EditImpact {
  const g = groups.find((x) => x.id === groupId)
  if (!g) return { invalidates: [], spawns: 0, note: '目标段不存在' }
  const name = groupLabel(groups, groupId)
  if (!g.lock) {
    return { invalidates: [], spawns: 0, note: `${name} 还没出片，并进去不会作废任何东西` }
  }
  return {
    invalidates: [groupId],
    spawns: 0,
    note: `${name} 已出片，并进去会让它的成片失效（之后只需重跑这一段）`
  }
}

/** 从某一段中间切开，会发生什么 */
export function splitImpact(groups: Group[], groupId: ID): EditImpact {
  const g = groups.find((x) => x.id === groupId)
  if (!g) return { invalidates: [], spawns: 1, note: '目标段不存在' }
  const name = groupLabel(groups, groupId)
  if (!g.lock) return { invalidates: [], spawns: 1, note: `${name} 还没出片，切开不影响已有结果` }
  return {
    invalidates: [groupId],
    spawns: 1,
    note: `${name} 已出片，切开后原成片作废；切出来的后半段是全新的一段`
  }
}

/** 合并两段，会发生什么 */
export function mergeImpact(groups: Group[], groupIds: ID[]): EditImpact {
  const hit = groups.filter((g) => groupIds.includes(g.id) && !!g.lock)
  const names = hit.map((g) => groupLabel(groups, g.id)).join('、')
  return {
    invalidates: hit.map((g) => g.id),
    spawns: 1,
    note: hit.length
      ? `${names} 已出片，合并后这些成片全部作废，合并成的新段要重跑`
      : '这些段还没出片，合并不影响已有结果'
  }
}

/** 删掉一段，会发生什么 */
export function deleteImpact(groups: Group[], groupId: ID): EditImpact {
  const g = groups.find((x) => x.id === groupId)
  if (!g) return { invalidates: [], spawns: 0, note: '目标段不存在' }
  const name = groupLabel(groups, groupId)
  return {
    invalidates: [],
    spawns: 0,
    note: `删除 ${name}，它的 ${g.beatIds.length} 个镜头会回到「待编排」，不会被删掉${
      g.lock ? '；这一段已出的成片不再被引用' : ''
    }`
  }
}

/** 当前方案里所有"动不得"的段（出过片） */
export function producedGroupIds(assembly: Assembly | null): ID[] {
  return assembly ? assembly.groups.filter(isProduced).map((g) => g.id) : []
}
