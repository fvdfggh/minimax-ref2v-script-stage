import type { Beat, Entity, ID, Lang, ProjectSettings } from './types'
import { DEFAULT_SETTINGS, isSceneEntity } from './types'
import { allEntityIdsOf } from './beats'
import {
  DEFAULT_LANG,
  entityName,
  entityTextDesc,
  entityVoiceDesc
} from './lang'

/* ------------------------------------------------------------------ *
 * 实体注册表 —— 全片唯一真相源
 *
 * 规范：
 *  - 会说话的角色按全片首次发声顺序分配编号，排在前面
 *  - 不说话的角色排在后面
 *  - <Subject N> 与 (Sx) 严格对应
 *  - 音色描述只在 subject_definitions 中定义一次，跨段逐字复用
 * ------------------------------------------------------------------ */

/** 去掉音色描述末尾的 (Sx)，避免同一信息存两份造成漂移 */
export function stripSxSuffix(voiceDesc: string): string {
  return voiceDesc.replace(/\s*\(S\d+\)\s*$/, '').trim()
}

/** 保证音色描述以句号结尾，供拼接 (Sx) 使用 */
export function normalizeVoiceDesc(voiceDesc: string): string {
  const base = stripSxSuffix(voiceDesc)
  if (!base) return ''
  return /[.!?]$/.test(base) ? base : `${base}.`
}

/** 该实体首次发声的 Beat 索引；不发声返回 Infinity */
export function firstSpeechIndex(entity: Entity, beats: Beat[]): number {
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i]
    if (b.kind === 'dialogue' && b.speakerId === entity.id) return i
  }
  return Number.POSITIVE_INFINITY
}

/** 该实体首次出现的 Beat 索引（含场景） */
export function firstAppearIndex(entity: Entity, beats: Beat[]): number {
  for (let i = 0; i < beats.length; i++) {
    if (allEntityIdsOf(beats[i]).includes(entity.id)) return i
  }
  return Number.POSITIVE_INFINITY
}

export interface NumberAssignment {
  subjectN: number
  sx: number | null
}

/**
 * 重新分配全片编号。
 * 顺序：会说话的角色（按首次发声）→ 不说话的主体（按首次出现）→ 场景（按首次出现）。
 * 场景虽然也占 <Subject N>，但排在最后，和主体分段呈现，便于人工核对。
 * 返回 id -> 编号 的映射，不修改原对象（由调用方写库）。
 */
export function computeNumbering(entities: Entity[], beats: Beat[]): Map<ID, NumberAssignment> {
  const scenes = entities.filter(isSceneEntity)
  const others = entities.filter((e) => !isSceneEntity(e))
  const speaking = others.filter((e) => e.kind === 'speaking')
  const silent = others.filter((e) => e.kind !== 'speaking')

  const byAppear = (list: Entity[]) =>
    [...list].sort((a, b) => {
      const ia = firstAppearIndex(a, beats)
      const ib = firstAppearIndex(b, beats)
      if (ia !== ib) return ia - ib
      return a.createdAt - b.createdAt
    })

  const bySpeech = [...speaking].sort((a, b) => {
    const ia = firstSpeechIndex(a, beats)
    const ib = firstSpeechIndex(b, beats)
    if (ia !== ib) return ia - ib
    const aa = firstAppearIndex(a, beats)
    const ab = firstAppearIndex(b, beats)
    if (aa !== ab) return aa - ab
    return a.createdAt - b.createdAt
  })

  const result = new Map<ID, NumberAssignment>()
  let n = 1
  for (const e of bySpeech) {
    result.set(e.id, { subjectN: n, sx: n })
    n++
  }
  for (const e of byAppear(silent)) {
    result.set(e.id, { subjectN: n, sx: null })
    n++
  }
  for (const e of byAppear(scenes)) {
    result.set(e.id, { subjectN: n, sx: null })
    n++
  }
  return result
}

/** 按编号排好序的三层结构，供 UI 分组展示 */
export function groupEntitiesByLayer(entities: Entity[]): {
  speaking: Entity[]
  subjects: Entity[]
  scenes: Entity[]
} {
  const sorted = [...entities].sort((a, b) => (a.subjectN ?? 9999) - (b.subjectN ?? 9999))
  return {
    speaking: sorted.filter((e) => !isSceneEntity(e) && e.kind === 'speaking'),
    subjects: sorted.filter((e) => !isSceneEntity(e) && e.kind !== 'speaking'),
    scenes: sorted.filter(isSceneEntity)
  }
}

/** 把编号写回实体；仅在发生变化时返回新对象 */
export function applyNumbering(entities: Entity[], map: Map<ID, NumberAssignment>): Entity[] {
  return entities.map((e) => {
    const a = map.get(e.id)
    if (!a) return e
    if (e.subjectN === a.subjectN && e.sx === a.sx) return e
    return { ...e, subjectN: a.subjectN, sx: a.sx, updatedAt: Date.now() }
  })
}

/** 编号是否与当前 Beats 一致 */
export function numberingIsStale(entities: Entity[], beats: Beat[]): boolean {
  const map = computeNumbering(entities, beats)
  return entities.some((e) => {
    const a = map.get(e.id)
    if (!a) return false
    return e.subjectN !== a.subjectN || e.sx !== a.sx
  })
}

/* ----------------------------- 标签 ----------------------------- */

export function subjectTag(entity: Entity): string {
  return `<Subject ${entity.subjectN ?? '?'}>`
}

export function sxTag(entity: Entity): string {
  return entity.sx == null ? '' : `(S${entity.sx})`
}

export function pictureTag(entity: Entity): string {
  return entity.pictureN == null ? '' : `<Picture ${entity.pictureN}>`
}

export function hasPicture(entity: Entity): boolean {
  return entity.pictureN != null
}

/* ------------------- subject_definitions 生成 ------------------- */

/**
 * 会说话角色：
 *   <Subject N> is [角色] in <Picture N>, [视觉描述], speaking with [音色描述]. (Sx)
 * 不说话角色（有图）：
 *   <Subject N> is [实体] in <Picture N>, [视觉描述].
 * 无图片实体：
 *   <Subject N> is [实体], [纯文本视觉描述].
 *
 * is / in / speaking with 是结构锚点，两种语言都保留英文；
 * 只有实体名、外观描述、音色描述跟随 workLanguage。
 */
export function buildSubjectDefinition(entity: Entity, lang: Lang = DEFAULT_LANG): string {
  // 中文描述可能以。结尾，一并去掉，避免出现 "。" 后再接锚点
  const visual = entityTextDesc(entity, lang).trim().replace(/[.。]?$/, '')
  const name = entityName(entity, lang)
  const subj = `<Subject ${entity.subjectN ?? '?'}>`

  if (hasPicture(entity)) {
    const pic = `<Picture ${entity.pictureN}>`
    if (entity.kind === 'speaking' && entity.voiceDesc) {
      const voice = normalizeVoiceDesc(entityVoiceDesc(entity, lang))
      return `${subj} is ${name} in ${pic}, ${visual}, speaking with ${voice} ${sxTag(entity)}`
    }
    return `${subj} is ${name} in ${pic}, ${visual}.`
  }

  if (entity.kind === 'speaking' && entity.voiceDesc) {
    const voice = normalizeVoiceDesc(entityVoiceDesc(entity, lang))
    return `${subj} is ${name}, ${visual}, speaking with ${voice} ${sxTag(entity)}`
  }
  return `${subj} is ${name}, ${visual}.`
}

/** 按编号顺序生成本段 subject_definitions（只包含本段出场实体） */
export function buildSubjectDefinitions(
  entitiesInSegment: Entity[],
  lang: Lang = DEFAULT_LANG
): string {
  return [...entitiesInSegment]
    .sort((a, b) => (a.subjectN ?? 999) - (b.subjectN ?? 999))
    .map((e) => buildSubjectDefinition(e, lang))
    .join('\n')
}

/* --------------------------- 声明语句 --------------------------- */

/** 台词行：说话人 ID 在 <d> 标签外 */
export function buildDialogueLine(speaker: Entity, text: string): string {
  return `${subjectTag(speaker)} ${sxTag(speaker)} says: <d>[Chinese] ${text.trim()}</d>`
}

export function newEntity(
  projectId: ID,
  patch: Partial<Entity> & { name: string }
): Entity {
  const ts = Date.now()
  return {
    id: patch.id ?? '',
    projectId,
    name: patch.name,
    type: patch.type ?? 'character',
    kind: patch.kind ?? 'non_speaking',
    subjectN: patch.subjectN ?? null,
    sx: patch.sx ?? null,
    pictureN: patch.pictureN ?? null,
    voiceDesc: patch.voiceDesc ?? null,
    textDesc: patch.textDesc ?? null,
    note: patch.note,
    createdAt: patch.createdAt ?? ts,
    updatedAt: ts
  }
}

export const ENTITY_TYPE_LABEL: Record<Entity['type'], string> = {
  character: '角色',
  scene: '场景',
  prop: '道具',
  ui: '界面',
  other: '其他'
}

export const SETTINGS_FALLBACK: ProjectSettings = DEFAULT_SETTINGS
