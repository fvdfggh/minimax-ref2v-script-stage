import { uid, now } from '@/core/id'
import { beatFrames, countHanzi, dialogueFrames } from './timing'
import type { Beat, BeatKind, ID, ProjectSettings } from './types'
import { AUTO_KINDS, DEFAULT_SETTINGS } from './types'

/* ------------------------------------------------------------------ *
 * Beat = 一个镜头，可拆分
 * 拆分场景：动作过长、对话过长
 * ------------------------------------------------------------------ */

/** 拆分阈值：单个镜头建议上限（帧） */
export const SPLIT_LIMITS = {
  /** 动作镜头建议 ≤ 3 秒 */
  action: 3 * 24,
  /** 台词镜头建议 ≤ 5 秒 */
  dialogue: 5 * 24,
  /** 其他叙事镜头建议 ≤ 3 秒 */
  other: 3 * 24
}

export function newBeat(
  projectId: ID,
  patch: Partial<Beat> & { title: string; kind: BeatKind }
): Beat {
  const ts = now()
  return {
    id: patch.id ?? uid('beat'),
    projectId,
    order: patch.order ?? 0,
    kind: patch.kind,
    title: patch.title,
    dialogue: patch.dialogue,
    entities: patch.entities ?? [],
    speakerId: patch.speakerId,
    focusEntityId: patch.focusEntityId,
    direction: patch.direction,
    visualDesc: patch.visualDesc,
    estFrames: patch.estFrames,
    manualFrames: patch.manualFrames ?? false,
    sceneId: patch.sceneId || undefined,
    derivedFrom: patch.derivedFrom,
    splitIndex: patch.splitIndex,
    locked: patch.locked ?? false,
    enriched: patch.enriched ?? false,
    note: patch.note,
    createdAt: patch.createdAt ?? ts,
    updatedAt: ts
  }
}

/* ----------------------------- 排序 ----------------------------- */

/** 按 order 字段排序——只在需要"读取当前顺序"时调用 */
export function sortBeats(beats: Beat[]): Beat[] {
  return [...beats].sort((a, b) => a.order - b.order)
}

/**
 * 按数组当前顺序重新编号。
 *
 * 注意：这里绝对不能再排序。移动/重排后的数组顺序才是真实意图，
 * 如果按旧的 order 字段再排一次，会把刚做的移动原封不动排回去，
 * 表现就是"拖动排序没反应"。
 */
export function normalizeOrders(beats: Beat[]): Beat[] {
  return beats.map((b, i) => (b.order === i ? b : { ...b, order: i }))
}

/** 按给定 id 顺序重排，未列出的排在后面 */
export function reorderBeats(beats: Beat[], orderedIds: ID[]): Beat[] {
  const index = new Map(orderedIds.map((id, i) => [id, i]))
  const sorted = [...beats].sort((a, b) => {
    const ia = index.get(a.id) ?? Number.MAX_SAFE_INTEGER
    const ib = index.get(b.id) ?? Number.MAX_SAFE_INTEGER
    if (ia !== ib) return ia - ib
    return a.order - b.order
  })
  return normalizeOrders(sorted)
}

/** 把某个 Beat 移动到目标位置 */
export function moveBeat(beats: Beat[], id: ID, targetIndex: number): Beat[] {
  const sorted = sortBeats(beats)
  const from = sorted.findIndex((b) => b.id === id)
  if (from < 0) return beats
  const [item] = sorted.splice(from, 1)
  const to = Math.max(0, Math.min(sorted.length, targetIndex))
  sorted.splice(to, 0, item)
  return normalizeOrders(sorted)
}

/** 在指定索引后插入一批 Beat */
export function insertBeats(beats: Beat[], items: Beat[], atIndex: number): Beat[] {
  const sorted = sortBeats(beats)
  sorted.splice(Math.max(0, Math.min(sorted.length, atIndex)), 0, ...items)
  return normalizeOrders(sorted)
}

export function removeBeats(beats: Beat[], ids: ID[]): Beat[] {
  const set = new Set(ids)
  return normalizeOrders(beats.filter((b) => !set.has(b.id)))
}

/* ----------------------------- 拆分 ----------------------------- */

export interface SplitPart {
  title?: string
  dialogue?: string
  frames: number
  direction?: string
  visualDesc?: string
}

/** 建议拆分份数 */
export function suggestSplitCount(beat: Beat, settings: ProjectSettings = DEFAULT_SETTINGS): number {
  if (AUTO_KINDS.includes(beat.kind)) return 1
  const limit = splitLimit(beat)
  const frames = beatFrames(beat, settings)
  return Math.max(1, Math.ceil(frames / limit))
}

function splitLimit(beat: Beat): number {
  if (beat.kind === 'dialogue') return SPLIT_LIMITS.dialogue
  if (beat.kind === 'action') return SPLIT_LIMITS.action
  return SPLIT_LIMITS.other
}

/** 判断是否需要拆分提示 */
export function needsSplit(beat: Beat, settings: ProjectSettings = DEFAULT_SETTINGS): boolean {
  return suggestSplitCount(beat, settings) > 1
}

/**
 * 按语义标点把台词均分为 count 段
 * （真正的语义拆分交给模型，这里只是确定性兜底）
 */
export function splitDialogueText(text: string, count: number): string[] {
  const clean = (text ?? '').trim()
  if (count <= 1 || !clean) return [clean]
  const pieces = clean
    .split(/(?<=[。！？!?；;…])/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (pieces.length < 2) {
    // 无标点可拆，按字数均分
    const chars = [...clean]
    const size = Math.ceil(chars.length / count)
    const out: string[] = []
    for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''))
    return out.length ? out : [clean]
  }
  // 把语义片段均衡地分配进 count 组
  const groups: string[][] = Array.from({ length: count }, () => [])
  const weights = pieces.map((p) => countHanzi(p) || 1)
  const total = weights.reduce((a, b) => a + b, 0)
  const target = total / count
  let gi = 0
  let acc = 0
  pieces.forEach((p, i) => {
    if (gi < count - 1 && acc >= target * (gi + 1)) gi++
    groups[gi].push(p)
    acc += weights[i]
  })
  return groups.map((g) => g.join('')).filter(Boolean)
}

/**
 * 把一个 Beat 拆成多个。
 * 帧数守恒：各子 Beat 帧数之和 = 原 Beat 帧数。
 */
export function splitBeat(
  beats: Beat[],
  id: ID,
  settings: ProjectSettings = DEFAULT_SETTINGS,
  parts?: SplitPart[]
): Beat[] {
  const sorted = sortBeats(beats)
  const idx = sorted.findIndex((b) => b.id === id)
  if (idx < 0) return beats
  const origin = sorted[idx]

  const pieces = parts ?? autoSplitParts(origin, settings)
  if (pieces.length <= 1) return beats

  const total = beatFrames(origin, settings)
  // 帧数按比例归一化，保证守恒且每份 ≥1
  const weights = pieces.map((p) => Math.max(1, p.frames))
  const sum = weights.reduce((a, b) => a + b, 0)
  const frames: number[] = weights.map((w) => Math.max(1, Math.round((w / sum) * total)))
  const drift = total - frames.reduce((a, b) => a + b, 0)
  frames[frames.length - 1] = Math.max(1, frames[frames.length - 1] + drift)

  const children: Beat[] = pieces.map((p, i) => ({
    ...origin,
    id: uid('beat'),
    order: origin.order + i,
    title: p.title ?? `${origin.title} (${i + 1}/${pieces.length})`,
    dialogue: p.dialogue !== undefined ? p.dialogue : origin.dialogue,
    estFrames: frames[i],
    manualFrames: true,
    direction: p.direction ?? origin.direction,
    visualDesc: p.visualDesc ?? origin.visualDesc,
    derivedFrom: origin.derivedFrom ?? origin.id,
    splitIndex: i + 1,
    locked: false,
    createdAt: now(),
    updatedAt: now()
  }))

  const out = [...sorted]
  out.splice(idx, 1, ...children)
  return normalizeOrders(out)
}

/** 自动拆分方案：台词按语义，动作按时长均分 */
export function autoSplitParts(beat: Beat, settings: ProjectSettings = DEFAULT_SETTINGS): SplitPart[] {
  const count = suggestSplitCount(beat, settings)
  if (count <= 1) return [{ frames: beatFrames(beat, settings) }]
  const total = beatFrames(beat, settings)
  const per = Math.round(total / count)

  if (beat.kind === 'dialogue') {
    const texts = splitDialogueText(beat.dialogue ?? '', count)
    return texts.map((t, i) => ({
      title: `${beat.title} (${i + 1}/${texts.length})`,
      dialogue: t,
      frames: dialogueFrames(t, settings.fps)
    }))
  }
  return Array.from({ length: count }, (_, i) => ({
    title: `${beat.title} (${i + 1}/${count})`,
    frames: per
  }))
}

/** 合并多个 Beat（撤回拆分） */
export function mergeBeats(
  beats: Beat[],
  ids: ID[],
  settings: ProjectSettings = DEFAULT_SETTINGS
): Beat[] {
  const sorted = sortBeats(beats)
  const set = new Set(ids)
  const picked = sorted.filter((b) => set.has(b.id))
  if (picked.length < 2) return beats
  const first = picked[0]

  const merged: Beat = {
    ...first,
    id: first.derivedFrom ?? uid('beat'),
    title: first.title.replace(/\s*\(\d+\/\d+\)$/, ''),
    dialogue:
      first.kind === 'dialogue'
        ? picked.map((b) => b.dialogue ?? '').filter(Boolean).join('')
        : first.dialogue,
    estFrames: picked.reduce((sum, b) => sum + beatFrames(b, settings), 0),
    manualFrames: true,
    derivedFrom: undefined,
    splitIndex: undefined,
    entities: unique(picked.flatMap((b) => entityIdsOf(b))),
    updatedAt: now()
  }

  const out = sorted.filter((b) => !set.has(b.id))
  out.splice(Math.min(first.order, out.length), 0, merged)
  return normalizeOrders(out)
}

/* --------------------------- 主体判定 --------------------------- */

/**
 * 落库前的规范化。
 * naive-ui 的多选清空时会 emit null，不处理会让 entities 变成 null，
 * 之后所有 .map / .includes / [...entities] 全线崩溃。
 * 统一在这里把可选字段收敛成稳定的形态。
 */
export function normalizeBeat(beat: Beat): Beat {
  const next: Beat = {
    ...beat,
    title: typeof beat.title === 'string' ? beat.title : '',
    entities: Array.isArray(beat.entities) ? beat.entities.filter((x) => typeof x === 'string') : [],
    speakerId: beat.speakerId ?? undefined,
    focusEntityId: beat.focusEntityId ?? undefined,
    sceneId: beat.sceneId || undefined,
    derivedFrom: beat.derivedFrom ?? undefined,
    splitIndex: typeof beat.splitIndex === 'number' ? beat.splitIndex : undefined,
    dialogue: beat.dialogue ?? undefined,
    direction: beat.direction ?? undefined,
    visualDesc: beat.visualDesc ?? undefined,
    note: beat.note ?? undefined,
    estFrames:
      typeof beat.estFrames === 'number' && Number.isFinite(beat.estFrames)
        ? Math.max(1, Math.round(beat.estFrames))
        : undefined,
    order: Number.isFinite(beat.order) ? beat.order : 0
  }
  // 非台词片段不允许保留说话人
  if (next.kind !== 'dialogue') next.speakerId = undefined
  // 场景由 sceneId 单独承载，不能同时混在主体列表里
  if (next.sceneId) next.entities = next.entities.filter((id) => id !== next.sceneId)
  // 说话人必须有绑定，否则会被判定为脏数据
  if (next.speakerId && !next.entities.includes(next.speakerId)) {
    next.entities = [...next.entities, next.speakerId]
  }
  // 聚焦主体必须来自"其他主体"或场景
  if (
    next.focusEntityId &&
    !next.entities.includes(next.focusEntityId) &&
    next.focusEntityId !== next.sceneId
  ) {
    next.focusEntityId = undefined
  }
  return next
}

/** 非场景主体（角色 / 道具 / 界面 / 其他），永远返回数组 */
export function entityIdsOf(beat: Beat): ID[] {
  return Array.isArray(beat.entities) ? beat.entities : []
}

/** 本片段的场景（必填项，缺失时为 null） */
export function sceneIdOf(beat: Beat): ID | null {
  return beat.sceneId ? beat.sceneId : null
}

/**
 * 一个 Beat 涉及的全部实体 = 其他主体 + 说话人 + 场景。
 * subject_definitions、编号分配、出场判定都用这个。
 */
export function allEntityIdsOf(beat: Beat): ID[] {
  return unique([...entityIdsOf(beat), ...(beat.speakerId ? [beat.speakerId] : []), ...(beat.sceneId ? [beat.sceneId] : [])])
}

/**
 * 一个 Beat 的"镜头主体"——用于缝合判定与 Only X is in frame
 * 优先级：说话人 > 聚焦主体 > 唯一其他主体 > 第一个其他主体 > 场景
 * 纯场景镜（没有角色）会退回场景，这样缝合判定仍然有主体可用。
 */
export function resolveSubjectId(beat: Beat): ID | null {
  if (beat.kind === 'dialogue' && beat.speakerId) return beat.speakerId
  if (beat.focusEntityId) return beat.focusEntityId
  const list = entityIdsOf(beat)
  if (list.length >= 1) return list[0]
  return sceneIdOf(beat)
}

/**
 * 该 Beat 是否能参与组合。
 * 综合判断：场景必填，其他主体可选；台词额外要求说话人。
 */
export function isComposable(beat: Beat): boolean {
  if (AUTO_KINDS.includes(beat.kind)) return true
  if (!sceneIdOf(beat)) return false
  if (beat.kind === 'dialogue' && !beat.speakerId) return false
  return true
}

/** 未就绪的原因，用于卡片上的提示 */
export function beatIssueLabel(beat: Beat): string | null {
  if (AUTO_KINDS.includes(beat.kind)) return null
  if (!sceneIdOf(beat)) return '未指定场景'
  if (beat.kind === 'dialogue' && !beat.speakerId) return '台词未指定说话人'
  return null
}

/* --------------------------- 辅助 --------------------------- */

export function unique<T>(list: T[]): T[] {
  return Array.from(new Set(list))
}

/** 收集一批 Beat 涉及的全部实体 id（含场景与说话人） */
export function collectEntities(beats: Beat[]): ID[] {
  return unique(beats.flatMap((b) => allEntityIdsOf(b)))
}

/** 收集一批 Beat 涉及的全部场景 id（按出现顺序去重） */
export function collectScenes(beats: Beat[]): ID[] {
  const out: ID[] = []
  for (const b of beats) {
    const s = sceneIdOf(b)
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/** 一批 Beat 的主场景：出现次数最多的那个 */
export function dominantScene(beats: Beat[]): ID | null {
  const count = new Map<ID, number>()
  for (const b of beats) {
    const s = sceneIdOf(b)
    if (s) count.set(s, (count.get(s) ?? 0) + 1)
  }
  let best: ID | null = null
  let bestN = 0
  for (const [id, n] of count) {
    if (n > bestN) {
      best = id
      bestN = n
    }
  }
  return best
}

/** 本批 Beat 是否发生了换场 */
export function hasSceneChange(beats: Beat[]): boolean {
  const scenes = collectScenes(beats)
  return scenes.length > 1
}

/** 一批 Beat 中，首个说话人（用于预备镜头判定） */
export function firstSpeakerId(beats: Beat[]): ID | null {
  for (const b of beats) if (b.kind === 'dialogue' && b.speakerId) return b.speakerId
  return null
}

/** 首个有主体的 Beat */
export function firstNarrativeBeat(beats: Beat[]): Beat | null {
  for (const b of beats) if (!AUTO_KINDS.includes(b.kind)) return b
  return beats[0] ?? null
}

/** 最后一个有主体的 Beat */
export function lastNarrativeBeat(beats: Beat[]): Beat | null {
  for (let i = beats.length - 1; i >= 0; i--) {
    if (!AUTO_KINDS.includes(beats[i].kind)) return beats[i]
  }
  return beats[beats.length - 1] ?? null
}

export function sceneOf(beat: Beat): ID | null {
  return beat.sceneId ?? null
}

export const BEAT_KIND_LABEL: Record<BeatKind, string> = {
  dialogue: '台词',
  action: '动作',
  scene_switch: '换场',
  establishing: '铺垫',
  reaction: '反应',
  insert: '特写',
  preshoot: '预备镜头',
  tail_cut: '尾帧切镜',
  black: '黑屏'
}

export const BEAT_KIND_COLOR: Record<BeatKind, string> = {
  dialogue: '#2f9e6f',
  action: '#3b7dd8',
  scene_switch: '#b06a12',
  establishing: '#6b6f76',
  reaction: '#7b5cc4',
  insert: '#0f8a9c',
  preshoot: '#c0392b',
  tail_cut: '#c0392b',
  black: '#111111'
}
