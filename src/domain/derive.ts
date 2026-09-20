import { beatFrames } from './timing'
import { paddedBeatFrames } from './frames'
import { beatShotLine } from './seam'
import { collectEntities, resolveSubjectId } from './beats'
import { buildSubjectDefinitions, hasPicture, subjectTag, sxTag } from './registry'
import { DEFAULT_LANG, entityName, langOf, retentionNote } from './lang'
import type {
  Beat,
  Entity,
  FieldSchema,
  Group,
  ID,
  Lang,
  ProjectSettings,
  SeamAnalysis
} from './types'
import { AUTO_KINDS, DEFAULT_SETTINGS } from './types'

/* ------------------------------------------------------------------ *
 * 字段派生 —— 字段 Schema 数据驱动
 * 新增/删除/改序字段只需改 Schema，不必动这里的代码
 * ------------------------------------------------------------------ */

export interface DeriveContext {
  settings: ProjectSettings
  entityById: Map<ID, Entity>
  seeder?: SeederFns
  /** 额外副帧：beatId -> 追加帧数。影响 detailed_description 的时间戳累加 */
  pad?: Record<ID, number> | null
}

export interface SeederFns {
  nameOf(id: ID | null | undefined): string
  subjectTagOf(id: ID | null | undefined): string
  sxTagOf(id: ID | null | undefined): string
}

export function makeSeeders(
  entityById: Map<ID, Entity>,
  lang: Lang = DEFAULT_LANG
): SeederFns {
  const get = (id: ID | null | undefined) => (id ? entityById.get(id) : undefined)
  return {
    nameOf: (id) => {
      const e = get(id)
      return e ? entityName(e, lang) : 'Unknown'
    },
    subjectTagOf: (id) => {
      const e = get(id)
      return e ? subjectTag(e) : '<Subject ?>'
    },
    sxTagOf: (id) => {
      const e = get(id)
      return e ? sxTag(e) : ''
    }
  }
}

/* --------------------- subject_definitions --------------------- */

export function deriveSubjectDefinitions(beats: Beat[], ctx: DeriveContext): string {
  const ids = collectEntities(beats.filter((b) => !AUTO_KINDS.includes(b.kind)))
  const entities = ids
    .map((id) => ctx.entityById.get(id))
    .filter((e): e is Entity => !!e)
  return buildSubjectDefinitions(entities, langOf(ctx.settings))
}

/* ---------------------- retention_analysis ---------------------- */

export function deriveRetentionAnalysis(beats: Beat[], ctx: DeriveContext): string {
  const seeder = ctx.seeder ?? makeSeeders(ctx.entityById)
  const shotsOf = new Map<ID, number[]>()

  let shotNo = 0
  for (const b of beats) {
    shotNo++
    const focus = resolveSubjectId(b)
    if (!focus) continue
    const list = shotsOf.get(focus) ?? []
    list.push(shotNo)
    shotsOf.set(focus, list)
    if (b.kind === 'dialogue') {
      // 台词镜头同时也体现说话人
      const speaker = b.speakerId
      if (speaker && speaker !== focus) {
        const l2 = shotsOf.get(speaker) ?? []
        l2.push(shotNo)
        shotsOf.set(speaker, l2)
      }
    }
  }

  const lang = langOf(ctx.settings)
  const lines: string[] = []
  for (const [id, shots] of shotsOf) {
    const e = ctx.entityById.get(id)
    if (!e) continue
    const shotList = shots.map((n) => `[Shot ${n}]`).join(', ')
    const note = retentionNote(lang, seeder.nameOf(id), hasPicture(e) ? e.pictureN : null)
    lines.push(`${subjectTag(e)} (appears in ${shotList}): ${note}`)
  }
  return lines.join('\n')
}

/* --------------------- detailed_description --------------------- */

export function deriveDetailedDescription(beats: Beat[], ctx: DeriveContext): string {
  const seeder = ctx.seeder ?? makeSeeders(ctx.entityById)
  const lines: string[] = []
  let cursor = 0
  beats.forEach((b, i) => {
    lines.push(
      beatShotLine(b, i + 1, cursor, { settings: ctx.settings }, seeder.nameOf, seeder.subjectTagOf, seeder.sxTagOf)
    )
    // 副帧一并计入，保证时间戳和实际段时长对得上
    cursor += paddedBeatFrames(b, ctx.settings, ctx.pad)
  })
  return lines.join('\n')
}

/* --------------------------- 总入口 --------------------------- */

export const DERIVERS: Record<string, (beats: Beat[], ctx: DeriveContext) => string> = {
  subject_definitions: deriveSubjectDefinitions,
  retention_analysis: deriveRetentionAnalysis,
  detailed_description: deriveDetailedDescription
}

/**
 * 只派生 source === 'derived' 的字段。
 * `existing` 里存在的 key 视为「人工锁定」，不再自动覆盖
 * （通过「重置派生字段」移除锁定后即可恢复自动派生）。
 */
export function deriveFields(
  schema: FieldSchema[],
  beats: Beat[],
  existing: Record<string, string>,
  ctx: DeriveContext
): Record<string, string> {
  const out: Record<string, string> = { ...existing }
  for (const f of schema) {
    if (f.source !== 'derived' || !f.deriveKey) continue
    if (Object.prototype.hasOwnProperty.call(existing, f.key)) continue
    const fn = DERIVERS[f.deriveKey]
    if (!fn) continue
    out[f.key] = fn(beats, ctx)
  }
  return out
}

/* --------------------------- 交付文本 --------------------------- */

/** 拼装成最终可交付的文本块（按 Schema 顺序） */
export function composeSegmentText(
  schema: FieldSchema[],
  fields: Record<string, string>
): string {
  return [...schema]
    .sort((a, b) => a.order - b.order)
    .map((f) => `${f.key}:\n${(fields[f.key] ?? '').trim()}`)
    .join('\n\n')
}

/** 按 Schema 生成给模型的 JSON 输出约束 */
export function fieldsJsonContract(schema: FieldSchema[]): string {
  const keys = [...schema].sort((a, b) => a.order - b.order).map((f) => f.key)
  return JSON.stringify({ fields: Object.fromEntries(keys.map((k) => [k, ''])) }, null, 2)
}

export function segmentFrames(
  beats: Beat[],
  settings: ProjectSettings = DEFAULT_SETTINGS,
  pad?: Record<ID, number> | null
): number {
  return beats.reduce((s, b) => s + paddedBeatFrames(b, settings, pad), 0)
}

export interface SegmentPlan {
  group: Group
  beats: Beat[]
  frames: number
  over: boolean
  seam: SeamAnalysis | null
}

export function planSegments(
  groups: Group[],
  beats: Beat[],
  settings: ProjectSettings = DEFAULT_SETTINGS
): SegmentPlan[] {
  const byId = new Map(beats.map((b) => [b.id, b]))
  return groups.map((g) => {
    const bs = g.beatIds.map((id) => byId.get(id)).filter(Boolean) as Beat[]
    const frames = segmentFrames(bs, settings)
    return { group: g, beats: bs, frames, over: frames > settings.maxSegmentFrames, seam: null }
  })
}
