import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, saveMany } from '@/db'
import { now } from '@/core/id'
import {
  autoSplitParts,
  insertBeats,
  mergeBeats as mergeBeatsFn,
  moveBeat as moveBeatFn,
  newBeat,
  normalizeBeat,
  normalizeOrders,
  removeBeats as removeBeatsFn,
  reorderBeats as reorderBeatsFn,
  sortBeats,
  splitBeat as splitBeatFn,
  suggestSplitCount,
  needsSplit,
  type SplitPart
} from '@/domain/beats'
import type { Beat, BeatKind, ID, ProjectSettings } from '@/domain/types'
import { AUTO_KINDS, DEFAULT_SETTINGS } from '@/domain/types'
import type { Stage1Beat } from '@/core/llm/prompts'

export const useBeatStore = defineStore('beats', () => {
  const beats = ref<Beat[]>([])
  const loading = ref(false)
  const generating = ref(false)

  const ordered = computed(() => sortBeats(beats.value))
  const narrativeBeats = computed(() => ordered.value.filter((b) => !AUTO_KINDS.includes(b.kind)))
  const beatById = computed(() => new Map(beats.value.map((b) => [b.id, b])))

  async function load(projectId: ID) {
    loading.value = true
    try {
      const rows = await db.beats.where('projectId').equals(projectId).toArray()
      beats.value = sortBeats(rows)
    } finally {
      loading.value = false
    }
  }

  function reset() {
    beats.value = []
  }

  function settingsFor(s?: ProjectSettings): ProjectSettings {
    return s ?? DEFAULT_SETTINGS
  }

  /**
   * 中文原文一改，之前译好的英文词条就过期了。
   * 在唯一的写库出口统一失效，避免「英文终稿」长期停留在旧译文上而没人发现。
   */
  function invalidateTranslations(prev: Beat | undefined, next: Beat): Beat {
    if (!prev) return next
    let out = next
    const drop = (enKey: 'titleEn' | 'directionEn' | 'visualDescEn') => {
      if (out[enKey] === undefined) return
      out = { ...out, [enKey]: undefined }
    }
    if (next.title !== prev.title) drop('titleEn')
    if (next.direction !== prev.direction) drop('directionEn')
    if (next.visualDesc !== prev.visualDesc) drop('visualDescEn')
    return out
  }

  async function persist(list: Beat[]) {
    const prevById = new Map(beats.value.map((b) => [b.id, b]))
    // 统一规范化：把 null / undefined / NaN 收敛掉，避免脏数据在后续流程里炸开
    const normalized = normalizeOrders(
      list.map((b) => normalizeBeat(invalidateTranslations(prevById.get(b.id), b)))
    )
    await saveMany(db.beats, normalized)
    const ids = new Set(normalized.map((b) => b.id))
    const removed = beats.value.filter((b) => !ids.has(b.id)).map((b) => b.id)
    if (removed.length) await db.beats.bulkDelete(removed)
    beats.value = normalized
    return normalized
  }

  /* ---------------------- 阶段一：拆解结果入库 ---------------------- */

  async function replaceAll(projectId: ID, drafts: Stage1Beat[]) {
    await db.beats.where('projectId').equals(projectId).delete()
    const list = drafts.map((d, i) =>
      newBeat(projectId, {
        order: i,
        kind: normalizeKind(d.kind),
        title: d.title,
        dialogue: d.kind === 'dialogue' ? (d.dialogue ?? '').trim() : undefined,
        entities: [],
        enriched: false
      })
    )
    beats.value = sortBeats(list)
    await saveMany(db.beats, beats.value)
    return beats.value
  }

  async function appendDrafts(projectId: ID, drafts: Stage1Beat[], atIndex?: number) {
    const start = atIndex ?? beats.value.length
    const list = drafts.map((d, i) =>
      newBeat(projectId, {
        order: start + i,
        kind: normalizeKind(d.kind),
        title: d.title,
        dialogue: d.kind === 'dialogue' ? (d.dialogue ?? '').trim() : undefined,
        entities: [],
        enriched: false
      })
    )
    return persist(insertBeats(beats.value, list, start))
  }

  function normalizeKind(kind: string): BeatKind {
    const allowed: BeatKind[] = [
      'dialogue',
      'action',
      'scene_switch',
      'establishing',
      'reaction',
      'insert'
    ]
    return (allowed.includes(kind as BeatKind) ? kind : 'action') as BeatKind
  }

  /* ------------------------ 阶段二：细节填充 ------------------------ */

  async function applyDetails(
    projectId: ID,
    details: Array<{
      id: string
      entities?: string[]
      speaker?: string
      focus?: string
      scene?: string
      direction?: string
      visualDesc?: string
    }>,
    resolveEntityId: (name: string) => ID | undefined
  ) {
    const copy = [...beats.value]
    let touched = 0
    for (const d of details) {
      const idx = copy.findIndex((b) => b.id === d.id)
      if (idx < 0) continue
      const b = copy[idx]
      const ids = (d.entities ?? []).map(resolveEntityId).filter((x): x is ID => !!x)
      const speakerId = d.speaker ? resolveEntityId(d.speaker) : undefined
      const focusId = d.focus ? resolveEntityId(d.focus) : undefined
      const sceneId = d.scene ? resolveEntityId(d.scene) : undefined
      copy[idx] = {
        ...b,
        entities: ids.length ? ids : b.entities,
        speakerId: speakerId ?? b.speakerId,
        focusEntityId: focusId ?? b.focusEntityId,
        sceneId: sceneId ?? b.sceneId,
        direction: d.direction ?? b.direction,
        visualDesc: d.visualDesc ?? b.visualDesc,
        enriched: true,
        updatedAt: now()
      }
      touched++
    }
    await persist(copy)
    return touched
  }

  /**
   * 阶段一：把模型给出的实体名直接绑定到片段上。
   * 场景与主体分开处理：sceneId 单独承载，entities 只放其他主体。
   * 传入 name -> id 的解析器，未登记的实体会被忽略。
   */
  async function bindEntityNames(
    mapping: Record<ID, { scene?: string; entities?: string[]; speaker?: string }>,
    resolve: (name: string) => ID | undefined
  ) {
    const copy = beats.value.map((b) => {
      const m = mapping[b.id]
      if (!m) return b
      const sceneId = m.scene ? resolve(m.scene) : undefined
      const ids = (m.entities ?? [])
        .map(resolve)
        .filter((x): x is ID => !!x && x !== sceneId)
      const speakerId = m.speaker ? resolve(m.speaker) : undefined
      return {
        ...b,
        sceneId: sceneId ?? b.sceneId,
        entities: ids.length ? ids : b.entities,
        speakerId: speakerId ?? b.speakerId,
        focusEntityId: ids.length
          ? ids.length === 1
            ? ids[0]
            : b.focusEntityId
          : (sceneId ?? b.focusEntityId)
      }
    })
    await persist(copy)
    return copy.filter((b) => !!b.sceneId || b.entities.length).length
  }

  /* --------------------------- 增删改排 --------------------------- */

  async function addBeat(projectId: ID, patch: Partial<Beat> & { title: string; kind: BeatKind }, atIndex?: number) {
    const b = newBeat(projectId, { ...patch, order: atIndex ?? beats.value.length })
    return persist(insertBeats(beats.value, [b], atIndex ?? beats.value.length))
  }

  async function updateBeat(id: ID, patch: Partial<Beat>) {
    const idx = beats.value.findIndex((b) => b.id === id)
    if (idx < 0) return
    const copy = [...beats.value]
    copy[idx] = { ...copy[idx], ...patch, updatedAt: now() }
    await persist(copy)
  }

  async function updateMany(ids: ID[], patch: Partial<Beat>) {
    const set = new Set(ids)
    const copy = beats.value.map((b) => (set.has(b.id) ? { ...b, ...patch, updatedAt: now() } : b))
    await persist(copy)
  }

  /** 每个 Beat 写各自的 patch（阶段五词条回写用） */
  async function patchBeats(patches: Array<{ id: ID; patch: Partial<Beat> }>) {
    const byId = new Map(patches.map((p) => [p.id, p.patch]))
    if (!byId.size) return beats.value
    const copy = beats.value.map((b) => {
      const patch = byId.get(b.id)
      return patch ? { ...b, ...patch, updatedAt: now() } : b
    })
    return persist(copy)
  }

  async function removeBeats(ids: ID[]) {
    return persist(removeBeatsFn(beats.value, ids))
  }

  async function moveBeat(id: ID, targetIndex: number) {
    return persist(moveBeatFn(beats.value, id, targetIndex))
  }

  async function reorder(ids: ID[]) {
    return persist(reorderBeatsFn(beats.value, ids))
  }

  async function split(
    id: ID,
    settings: ProjectSettings = DEFAULT_SETTINGS,
    parts?: SplitPart[]
  ) {
    const before = beats.value.length
    const next = splitBeatFn(beats.value, id, settings, parts)
    if (next.length === before) return false
    await persist(next)
    return true
  }

  async function splitAuto(id: ID, settings: ProjectSettings = DEFAULT_SETTINGS) {
    const beat = beats.value.find((b) => b.id === id)
    if (!beat) return false
    return split(id, settings, autoSplitParts(beat, settings))
  }

  async function merge(ids: ID[], settings: ProjectSettings = DEFAULT_SETTINGS) {
    if (ids.length < 2) return false
    const next = mergeBeatsFn(beats.value, ids, settings)
    if (next.length === beats.value.length) return false
    await persist(next)
    return true
  }

  function suggestSplit(id: ID, settings: ProjectSettings = DEFAULT_SETTINGS) {
    const beat = beats.value.find((b) => b.id === id)
    if (!beat) return 1
    return suggestSplitCount(beat, settings)
  }

  function shouldSplit(id: ID, settings: ProjectSettings = DEFAULT_SETTINGS) {
    const beat = beats.value.find((b) => b.id === id)
    if (!beat) return false
    return needsSplit(beat, settings)
  }

  async function clearAll(projectId: ID) {
    await db.beats.where('projectId').equals(projectId).delete()
    beats.value = []
  }

  return {
    beats,
    ordered,
    narrativeBeats,
    beatById,
    loading,
    generating,
    load,
    reset,
    persist,
    replaceAll,
    appendDrafts,
    applyDetails,
    bindEntityNames,
    addBeat,
    updateBeat,
    updateMany,
    patchBeats,
    removeBeats,
    moveBeat,
    reorder,
    split,
    splitAuto,
    merge,
    suggestSplit,
    shouldSplit,
    clearAll,
    settingsFor
  }
})
