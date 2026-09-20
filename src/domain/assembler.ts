import { uid, now } from '@/core/id'
import { analyzeSeam } from './seam'
import { beatFrames } from './timing'
import {
  defaultRefPrev,
  fitSegmentFrames,
  maxAlignedFrames,
  resolveRefPrev
} from './frames'
import { collectEntities, isComposable, resolveSubjectId, sceneOf } from './beats'
import type {
  Assembly,
  AssemblyMode,
  Beat,
  Entity,
  Group,
  ID,
  ProjectSettings,
  StrategyConfig,
  StrategyWeights
} from './types'
import { DEFAULT_SETTINGS } from './types'

/* ------------------------------------------------------------------ *
 * 组合引擎 —— 把 Beat 序列切成若干 ≤141 帧的段
 *
 * 内置四种策略，代价函数加权：
 *   waste   : 剩余帧浪费
 *   scene   : 在场景内部切一刀
 *   speaker : 同段内说话人混杂 / 同一说话人台词被切断
 *   seam    : 缝合处需要黑屏兜底（重罚）
 *   cut     : 缝合处需要尾帧切镜（轻罚）
 * ------------------------------------------------------------------ */

export const DEFAULT_WEIGHTS: Record<AssemblyMode, StrategyWeights> = {
  fill_max: { waste: 0.35, scene: 6, speaker: 3, seam: 40, cut: 1 },
  scene_first: { waste: 0.2, scene: 14, speaker: 4, seam: 40, cut: 1 },
  speaker_split: { waste: 0.25, scene: 6, speaker: 12, seam: 40, cut: 1.5 },
  manual: { waste: 0, scene: 0, speaker: 0, seam: 0, cut: 0 }
}

export function defaultStrategy(
  settings: ProjectSettings = DEFAULT_SETTINGS,
  mode: AssemblyMode = 'scene_first'
): StrategyConfig {
  return {
    mode,
    maxFrames: settings.maxSegmentFrames,
    weights: { ...DEFAULT_WEIGHTS[mode] }
  }
}

export interface AssembleContext {
  settings: ProjectSettings
  entityById?: Map<ID, Entity>
}

/**
 * 组合时的容量上限。
 * 取两个帧长度家族里更紧的那个（17k 的上限），保证补正后不会越界。
 */
function capacityOf(cfg: StrategyConfig, ctx: AssembleContext): number {
  return Math.min(cfg.maxFrames, maxAlignedFrames(true, ctx.settings.maxSegmentFrames))
}

/* --------------------------- 边界代价 --------------------------- */

function boundaryCost(beats: Beat[], i: number, cfg: StrategyConfig, ctx: AssembleContext): number {
  const prev = beats[i - 1]
  const cur = beats[i]
  if (!prev || !cur) return 0
  const w = cfg.weights
  let cost = 0

  // 场景综合判断：换场处切分最优，同场内切分要罚
  const prevScene = sceneOf(prev)
  const curScene = sceneOf(cur)

  if (prevScene && curScene && prevScene !== curScene) {
    cost -= w.scene * 0.8
  } else if (prevScene && curScene && prevScene === curScene) {
    cost += w.scene
  } else if (prevScene && !curScene) {
    // 一头没有场景，属于数据不完整，轻微惩罚避免把脏数据凑到边界
    cost += w.scene * 0.3
  }

  if (prev.kind === 'dialogue' && cur.kind === 'dialogue' && prev.speakerId && prev.speakerId === cur.speakerId) {
    cost += w.speaker
  }

  // 近似缝合代价：只看边界两侧相邻片段
  const seam = analyzeSeam([prev], [cur], ctx)
  if (seam.blackFallback) cost += w.seam
  else if (seam.needsTailCut) cost += w.cut

  return cost
}

/* ----------------------------- DP ----------------------------- */

function dpSegmentation(beats: Beat[], cfg: StrategyConfig, ctx: AssembleContext): number[] {
  const n = beats.length
  const cap = capacityOf(cfg, ctx)
  const dp = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY)
  const prev = new Array<number>(n + 1).fill(-1)
  dp[0] = 0

  for (let j = 1; j <= n; j++) {
    let frames = 0
    for (let i = j - 1; i >= 0; i--) {
      frames += beatFrames(beats[i], ctx.settings)
      if (frames > cap) break
      if (dp[i] === Number.POSITIVE_INFINITY) continue
      const waste = (cap - frames) * cfg.weights.waste
      const bc = i === 0 ? 0 : boundaryCost(beats, i, cfg, ctx)
      const total = dp[i] + waste + bc
      if (total < dp[j]) {
        dp[j] = total
        prev[j] = i
      }
    }
  }

  if (prev[n] === -1) {
    // 兜底：单个 Beat 就超限，逐段硬切
    const cuts: number[] = []
    let frames = 0
    for (let i = 0; i < n; i++) {
      const f = beatFrames(beats[i], ctx.settings)
      if (frames + f > cap && frames > 0) {
        cuts.push(i)
        frames = 0
      }
      frames += f
    }
    cuts.unshift(0)
    cuts.push(n)
    return cuts
  }

  const cuts: number[] = []
  let cur = n
  while (cur > 0) {
    cuts.unshift(cur)
    cur = prev[cur]
  }
  cuts.unshift(0)
  return cuts
}

/* --------------------------- 组合入口 --------------------------- */

export interface AssembleReport {
  groups: Group[]
  /** 被排除、不参与组合的 Beat（未绑定实体） */
  skipped: Beat[]
  seamIssues: number
  blackFallbacks: number
  totalFrames: number
}

export function assemble(
  allBeats: Beat[],
  cfg: StrategyConfig,
  ctx: AssembleContext = { settings: DEFAULT_SETTINGS }
): AssembleReport {
  const settings = ctx.settings
  const composable = allBeats.filter(isComposable)
  const skipped = allBeats.filter((b) => !isComposable(b))

  if (composable.length === 0) {
    return { groups: [], skipped, seamIssues: 0, blackFallbacks: 0, totalFrames: 0 }
  }

  let groups: Group[]

  if (cfg.mode === 'manual') {
    groups = [{ id: uid('grp'), beatIds: composable.map((b) => b.id) }]
  } else {
    const cuts = dpSegmentation(composable, cfg, ctx)
    groups = []
    for (let k = 0; k < cuts.length - 1; k++) {
      const slice = composable.slice(cuts[k], cuts[k + 1])
      if (slice.length === 0) continue
      groups.push({ id: uid('grp'), beatIds: slice.map((b) => b.id) })
    }
  }
  // 引用上段：首段不引用，其余默认引用
  groups.forEach((g, i) => {
    g.refPrev = defaultRefPrev(i)
  })

  const refined = refineBySeam(groups, composable, cfg, ctx)
  const stats = measure(refined, composable, ctx)

  return {
    groups: refined,
    skipped,
    seamIssues: stats.issues,
    blackFallbacks: stats.black,
    totalFrames: stats.total
  }
}

/**
 * 局部优化：若某缝合处需要黑屏兜底，
 * 尝试把边界左右挪 1~3 个 Beat，看能否消除兜底且不超帧限。
 */
function refineBySeam(
  groups: Group[],
  beats: Beat[],
  cfg: StrategyConfig,
  ctx: AssembleContext
): Group[] {
  const cap = capacityOf(cfg, ctx)
  const byId = new Map(beats.map((b) => [b.id, b]))
  const getBeats = (g: Group) => g.beatIds.map((id) => byId.get(id)!).filter(Boolean)
  const framesOf = (g: Group) => getBeats(g).reduce((s, b) => s + beatFrames(b, ctx.settings), 0)

  const out = groups.map((g) => ({ ...g, beatIds: [...g.beatIds] }))

  for (let k = 1; k < out.length; k++) {
    const left = out[k - 1]
    const right = out[k]

    let seam = analyzeSeam(getBeats(left), getBeats(right), ctx)
    if (!seam.blackFallback) continue

    let fixed = false
    for (let delta = 1; delta <= 3 && !fixed; delta++) {
      for (const dir of [-1, 1]) {
        const moved = dir < 0 ? delta : -delta
        const newLeftLen = left.beatIds.length + moved
        const newRightLen = right.beatIds.length - moved
        if (newLeftLen < 1 || newRightLen < 1) continue

        const candidateLeft: Group = {
          id: left.id,
          beatIds: left.beatIds.slice(0, newLeftLen)
        }
        const candidateRight: Group = {
          id: right.id,
          beatIds: [...left.beatIds.slice(newLeftLen), ...right.beatIds]
        }
        if (framesOf(candidateLeft) > cap) continue
        if (framesOf(candidateRight) > cap) continue

        const s = analyzeSeam(getBeats(candidateLeft), getBeats(candidateRight), ctx)
        if (!s.blackFallback && s.issues.every((i) => i.level !== 'error')) {
          left.beatIds = candidateLeft.beatIds
          right.beatIds = candidateRight.beatIds
          seam = s
          fixed = true
          break
        }
      }
    }
  }
  return out
}

/* ----------------------------- 度量 ----------------------------- */

export interface MeasureResult {
  issues: number
  black: number
  cut: number
  total: number
  perGroup: Array<{
    frames: number
    target: number
    padTotal: number
    refPrev: boolean
    over: boolean
    seam: ReturnType<typeof analyzeSeam> | null
  }>
}

export function measure(
  groups: Group[],
  beats: Beat[],
  ctx: AssembleContext = { settings: DEFAULT_SETTINGS }
): MeasureResult {
  const byId = new Map(beats.map((b) => [b.id, b]))
  const list = groups.map((g) => g.beatIds.map((id) => byId.get(id)!).filter(Boolean))

  let issues = 0
  let black = 0
  let cut = 0
  let total = 0

  const perGroup = list.map((bs, i) => {
    const frames = bs.reduce((s, b) => s + beatFrames(b, ctx.settings), 0)
    const refPrev = resolveRefPrev(groups[i] ?? {}, i)
    const fit = fitSegmentFrames(frames, refPrev, ctx.settings.maxSegmentFrames)
    total += fit.target
    const seam = i > 0 ? analyzeSeam(list[i - 1], bs, ctx) : null
    if (seam) {
      if (seam.blackFallback) black++
      if (seam.needsTailCut) cut++
      issues += seam.issues.filter((x) => x.level !== 'info').length
    }
    return {
      frames,
      target: fit.target,
      padTotal: fit.padTotal,
      refPrev,
      over: fit.overLimit,
      seam
    }
  })

  return { issues, black, cut, total, perGroup }
}

export function newAssembly(
  projectId: ID,
  name: string,
  groups: Group[],
  cfg: StrategyConfig
): Assembly {
  const ts = now()
  return {
    id: uid('asm'),
    projectId,
    name,
    strategy: cfg,
    groups,
    createdAt: ts,
    updatedAt: ts
  }
}

/** 把一批 Beat 作为一个手工组加入方案 */
export function makeGroup(beatIds: ID[]): Group {
  return { id: uid('grp'), beatIds: [...beatIds] }
}

/** 界面用：某组的实体并集 */
export function groupEntities(group: Group, beats: Beat[]): ID[] {
  const byId = new Map(beats.map((b) => [b.id, b]))
  const list = group.beatIds.map((id) => byId.get(id)).filter(Boolean) as Beat[]
  return collectEntities(list)
}

export function groupSubjectChain(group: Group, beats: Beat[]): ID[] {
  const byId = new Map(beats.map((b) => [b.id, b]))
  return group.beatIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((b) => resolveSubjectId(b!))
    .filter((x): x is ID => !!x)
}
