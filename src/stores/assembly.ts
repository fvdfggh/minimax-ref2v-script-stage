import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, kvSet, saveOne } from '@/db'
import { uid, now } from '@/core/id'
import {
  assemble,
  defaultStrategy,
  makeGroup,
  newAssembly,
  type AssembleReport
} from '@/domain/assembler'
import { analyzeSeam, materializeSegment } from '@/domain/seam'
import { beatFrames, dialogueFrames } from '@/domain/timing'
import {
  buildPad,
  fitSegmentFrames,
  isAligned,
  padTotalOf,
  resolveRefPrev,
  sumPaddedFrames
} from '@/domain/frames'
import { deriveFields, makeSeeders, composeSegmentText } from '@/domain/derive'
import { reconcileGroups, segmentSourceHash } from '@/domain/cascade'
import type {
  Assembly,
  AssemblyMode,
  Beat,
  Entity,
  FieldSchema,
  Group,
  ID,
  ProjectSettings,
  SeamAnalysis,
  Segment,
  SegmentMeta
} from '@/domain/types'
import { AUTO_KINDS, DEFAULT_SETTINGS } from '@/domain/types'
import { validateSegment, validateGlobal, type RuleIssue } from '@/domain/rules'

export interface SegmentView {
  group: Group
  /** 纯叙事片段 */
  narrativeBeats: Beat[]
  /** 素材化后的片段（含 preshoot / tail_cut / black） */
  beats: Beat[]
  /** 含副帧的实际段时长 */
  frames: number
  over: boolean
  seam: SeamAnalysis | null
  nextSeam: SeamAnalysis | null
  fields: Record<string, string>
  issues: RuleIssue[]

  /* ---------------- 帧长度补正 ---------------- */
  /** 是否引用上一段 */
  refPrev: boolean
  /** 片段自身占用（不含副帧） */
  rawFrames: number
  /** 补正后的目标帧数 */
  targetFrames: number
  /** 额外副帧：beatId -> 追加帧数 */
  pad: Record<ID, number>
  /** 副帧是否为按占比自动分摊（false 表示已手工调整） */
  padAuto: boolean
  /** 副帧合计 */
  padTotal: number
  /** 目标超出该模式上限，必须拆段 */
  overLimit: boolean
  /** 该模式允许的最大帧数 */
  cap: number
  /** 帧数是否已对齐 */
  aligned: boolean

  /* ---------------- 级联 ---------------- */
  /** 当前段内容指纹 */
  hash: string
  /** 模型字段是否已经过期（上游片段/实体改过） */
  stale: boolean
  /** 生成时的片段 id 序列；用于说明"上游动了哪些片段" */
  generatedBeatIds: ID[] | null
  /** 上游相对生成时新增的片段 */
  addedBeats: ID[]
  /** 上游相对生成时被删掉的片段 */
  removedBeats: ID[]
}

export const useAssemblyStore = defineStore('assembly', () => {
  const assemblies = ref<Assembly[]>([])
  const currentId = ref<ID | null>(null)
  const loading = ref(false)

  /** 各方案的组级手工编辑覆盖 */
  const fieldOverrides = ref<Record<string, Record<string, string>>>({})
  const summaries = ref<Record<string, string>>({})
  /** 段字段的生成记录：判断上游改过之后哪些段需要重新生成 */
  const segmentMeta = ref<Record<ID, SegmentMeta>>({})

  const current = computed(() => assemblies.value.find((a) => a.id === currentId.value) ?? null)

  async function load(projectId: ID) {
    loading.value = true
    try {
      assemblies.value = await db.assemblies.where('projectId').equals(projectId).toArray()
      currentId.value = assemblies.value[0]?.id ?? null
      const kv = await db.kv.get(`overrides:${projectId}`)
      fieldOverrides.value = (kv?.value as Record<string, Record<string, string>>) ?? {}
      const kv2 = await db.kv.get(`summaries:${projectId}`)
      summaries.value = (kv2?.value as Record<string, string>) ?? {}
      const kv3 = await db.kv.get(`segmeta:${projectId}`)
      segmentMeta.value = (kv3?.value as Record<ID, SegmentMeta>) ?? {}
    } finally {
      loading.value = false
    }
  }

  function reset() {
    assemblies.value = []
    currentId.value = null
    fieldOverrides.value = {}
    summaries.value = {}
    segmentMeta.value = {}
  }

  async function persistOverrides(projectId: ID) {
    await kvSet(`overrides:${projectId}`, fieldOverrides.value)
    await kvSet(`summaries:${projectId}`, summaries.value)
    await kvSet(`segmeta:${projectId}`, segmentMeta.value)
  }

  /* --------------------------- 级联 --------------------------- */

  /**
   * 记下这一段的模型字段是「基于哪份内容」生成的。
   * 之后每次渲染都会重算指纹，不一致就说明上游改过、这段得重新生成。
   */
  async function markGenerated(
    projectId: ID,
    groupId: ID,
    beats: Beat[],
    entities: Iterable<Entity>
  ) {
    segmentMeta.value = {
      ...segmentMeta.value,
      [groupId]: {
        llmHash: segmentSourceHash(beats, [...entities]),
        beatIds: beats.map((b) => b.id),
        updatedAt: now()
      }
    }
    await persistOverrides(projectId)
  }

  function clearMeta(groupId: ID) {
    const next = { ...segmentMeta.value }
    delete next[groupId]
    segmentMeta.value = next
  }

  /**
   * 分组归位：把上游新增/删除的片段同步进分组。
   * 不做这一步，新片段不会出现在任何段里，等于静默丢内容。
   */
  async function reconcile(assemblyId: ID, beats: Beat[]): Promise<{ ok: boolean; adopted: number; dropped: number }> {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return { ok: false, adopted: 0, dropped: 0 }
    const res = reconcileGroups(asm.groups, beats)
    if (res.changed) await setGroups(assemblyId, res.groups)

    // 段被并掉之后，它的生成记录留着也没用
    const liveGroups = new Set(res.groups.map((g) => g.id))
    let dirty = false
    const nextMeta: Record<ID, SegmentMeta> = {}
    for (const [id, meta] of Object.entries(segmentMeta.value)) {
      if (liveGroups.has(id)) nextMeta[id] = meta
      else dirty = true
    }
    if (dirty) segmentMeta.value = nextMeta

    return { ok: true, adopted: res.adopted, dropped: res.dropped }
  }

  /* --------------------------- 方案管理 --------------------------- */

  async function createAssembly(
    projectId: ID,
    name: string,
    mode: AssemblyMode,
    beats: Beat[],
    settings: ProjectSettings = DEFAULT_SETTINGS,
    entityById?: Map<ID, Entity>
  ): Promise<AssembleReport & { assembly: Assembly }> {
    const cfg = defaultStrategy(settings, mode)
    const report = assemble(beats, cfg, { settings, entityById })
    const assembly = newAssembly(projectId, name, report.groups, cfg)
    await saveOne(db.assemblies, assembly)
    assemblies.value = [...assemblies.value, assembly]
    currentId.value = assembly.id
    return { ...report, assembly }
  }

  async function regenerate(
    assemblyId: ID,
    beats: Beat[],
    settings: ProjectSettings = DEFAULT_SETTINGS,
    entityById?: Map<ID, Entity>
  ) {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return null
    const report = assemble(beats, asm.strategy, { settings, entityById })
    const next = { ...asm, groups: report.groups, updatedAt: now() }
    await saveOne(db.assemblies, next)
    assemblies.value = assemblies.value.map((a) => (a.id === assemblyId ? next : a))
    return report
  }

  async function updateStrategy(assemblyId: ID, patch: Partial<Assembly['strategy']>) {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const next = {
      ...asm,
      strategy: { ...asm.strategy, ...patch, weights: { ...asm.strategy.weights, ...(patch.weights ?? {}) } },
      updatedAt: now()
    }
    await saveOne(db.assemblies, next)
    assemblies.value = assemblies.value.map((a) => (a.id === assemblyId ? next : a))
  }

  async function renameAssembly(assemblyId: ID, name: string) {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const next = { ...asm, name, updatedAt: now() }
    await saveOne(db.assemblies, next)
    assemblies.value = assemblies.value.map((a) => (a.id === assemblyId ? next : a))
  }

  async function removeAssembly(assemblyId: ID) {
    await db.assemblies.delete(assemblyId)
    assemblies.value = assemblies.value.filter((a) => a.id !== assemblyId)
    if (currentId.value === assemblyId) currentId.value = assemblies.value[0]?.id ?? null
  }

  async function setGroups(assemblyId: ID, groups: Group[]) {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const next = { ...asm, groups, updatedAt: now() }
    await saveOne(db.assemblies, next)
    assemblies.value = assemblies.value.map((a) => (a.id === assemblyId ? next : a))
  }

  /* ------------------------- 手工调整分组 ------------------------- */

  async function splitGroupAt(assemblyId: ID, groupId: ID, atIndex: number, beats: Beat[]) {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const idx = asm.groups.findIndex((g) => g.id === groupId)
    if (idx < 0) return
    const g = asm.groups[idx]
    if (atIndex <= 0 || atIndex >= g.beatIds.length) return
    const left: Group = { ...g, beatIds: g.beatIds.slice(0, atIndex) }
    const right: Group = { id: uid('grp'), beatIds: g.beatIds.slice(atIndex) }
    const groups = [...asm.groups]
    groups.splice(idx, 1, left, right)
    await setGroups(assemblyId, groups)
    void beats
  }

  async function mergeGroups(
    assemblyId: ID,
    groupIds: ID[],
    beats: Beat[],
    settings: ProjectSettings = DEFAULT_SETTINGS
  ) {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return { ok: false, frames: 0 }
    const indexes = groupIds
      .map((id) => asm.groups.findIndex((g) => g.id === id))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)
    if (indexes.length < 2) return { ok: false, frames: 0 }
    const merged: Group = {
      id: uid('grp'),
      beatIds: indexes.flatMap((i) => asm.groups[i].beatIds)
    }
    const groups = [...asm.groups]
    groups.splice(indexes[0], indexes.length, merged)
    await setGroups(assemblyId, groups)
    return { ok: true, frames: countFramesFromIds(merged.beatIds, beats, settings) }
  }

  function countFramesFromIds(ids: ID[], beats: Beat[], settings: ProjectSettings) {
    const byId = new Map(beats.map((b) => [b.id, b]))
    return ids.reduce((sum, id) => {
      const b = byId.get(id)
      return sum + (b ? beatFrames(b, settings) : 0)
    }, 0)
  }

  /** 把一个 Beat 移出分组（删除） */
  async function removeBeatFromGroup(assemblyId: ID, groupId: ID, beatId: ID) {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const groups = asm.groups
      .map((g) => (g.id === groupId ? { ...g, beatIds: g.beatIds.filter((b) => b !== beatId) } : g))
      .filter((g) => g.beatIds.length > 0)
    await setGroups(assemblyId, groups)
  }

  /* ---------------------- 帧长度补正 ---------------------- */

  /**
   * 切换「引用上一段」。家族一变，已存的副帧就失效了，一并清掉让它重新分摊。
   */
  async function setGroupRefPrev(assemblyId: ID, groupId: ID, refPrev: boolean) {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const groups = asm.groups.map((g) => (g.id === groupId ? { ...g, refPrev, pad: undefined } : g))
    await setGroups(assemblyId, groups)
  }

  /** 写入副帧（从此成为手工值，不再自动分摊）。允许负数表示压缩 */
  async function setGroupPad(assemblyId: ID, groupId: ID, pad: Record<ID, number>) {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const clean: Record<ID, number> = {}
    for (const [k, v] of Object.entries(pad)) {
      const n = Math.round(v || 0)
      if (n !== 0) clean[k] = n
    }
    const groups = asm.groups.map((g) => (g.id === groupId ? { ...g, pad: clean } : g))
    await setGroups(assemblyId, groups)
  }

  /** 清除副帧，恢复按各片段占比自动分摊 */
  async function clearGroupPad(assemblyId: ID, groupId: ID) {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const groups = asm.groups.map((g) => (g.id === groupId ? { ...g, pad: undefined } : g))
    await setGroups(assemblyId, groups)
  }

  /** 全部段恢复自动补正 */
  async function clearAllPads(assemblyId: ID) {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const groups = asm.groups.map((g) => ({ ...g, pad: undefined }))
    await setGroups(assemblyId, groups)
  }

  /* --------------------------- 段视图派生 --------------------------- */

  function buildSegmentViews(
    assembly: Assembly,
    beats: Beat[],
    settings: ProjectSettings,
    entityById: Map<ID, Entity>,
    schema: FieldSchema[]
  ): SegmentView[] {
    const byId = new Map(beats.map((b) => [b.id, b]))
    const seeder = makeSeeders(entityById)

    const rawGroups = assembly.groups
      .map((g) => ({
        group: g,
        narrative: g.beatIds.map((id) => byId.get(id)).filter(Boolean) as Beat[]
      }))
      .filter((x) => x.narrative.length > 0)

    // 先算全部缝合点
    const seams: Array<SeamAnalysis | null> = rawGroups.map((x, i) =>
      i === 0
        ? null
        : analyzeSeam(rawGroups[i - 1].narrative, x.narrative, { settings, entityById })
    )

    return rawGroups.map((x, i) => {
      const seam = seams[i]
      const nextSeam = i + 1 < seams.length ? seams[i + 1] : null

      // 材料化：本段是否需要黑屏/尾帧切镜取决于"与下一段"的缝合结论
      const material = materializeSegment(x.narrative, nextSeam, { settings, entityById })

      // ★ summary 存在独立的 summaries 表里，必须合并进字段包，
      //   否则校验会一直报"summary 为空"，导出也拿不到。
      const bag: Record<string, string> = { ...(fieldOverrides.value[x.group.id] ?? {}) }
      const summary = summaries.value[x.group.id]
      if (summary) bag.summary = summary

      // ---- 帧长度补正：17k / 5+17k，差额作为独立副帧按占比分摊（可为负=压缩） ----
      const refPrev = resolveRefPrev(x.group, i)
      // 压缩下限：台词不能短于它自己的台词时长
      const floorFrames = x.narrative
        .filter((b) => b.kind === 'dialogue')
        .reduce((s, b) => s + dialogueFrames(b.dialogue, settings.fps), 0)
      const fit = fitSegmentFrames(material.frames, refPrev, settings.maxSegmentFrames, floorFrames)
      const storedPad = x.group.pad
      const padAuto = !storedPad
      // 预备镜头 / 尾帧切镜 / 黑屏 也参与分摊
      const pad = buildPad({
        all: material.beats,
        overrides: storedPad,
        padTotal: fit.padTotal,
        settings
      })
      const frames = sumPaddedFrames(material.beats, settings, pad)

      const derived = deriveFields(schema, material.beats, bag, {
        settings,
        entityById,
        seeder,
        pad
      })

      const issues = validateSegment(
        {
          beats: material.beats,
          narrativeBeats: x.narrative,
          fields: derived,
          seam,
          nextSeam,
          refPrev,
          pad
        },
        { settings, entityById, schema }
      )

      // ---- 级联：模型字段是「基于哪份内容」生成的 ----
      const hash = segmentSourceHash(material.beats, [...entityById.values()])
      const meta = segmentMeta.value[x.group.id]
      const hasModelFields = schema.some((f) => f.source === 'llm' && (derived[f.key] ?? '').trim())
      const stale = hasModelFields && (!meta || meta.llmHash !== hash)

      const currentIds = new Set(material.beats.map((b) => b.id))
      const prevIds = new Set(meta?.beatIds ?? [])
      const addedBeats = meta ? material.beats.filter((b) => !prevIds.has(b.id)).map((b) => b.id) : []
      const removedBeats = meta ? meta.beatIds.filter((id) => !currentIds.has(id)) : []

      return {
        group: x.group,
        narrativeBeats: x.narrative,
        beats: material.beats,
        frames,
        over: fit.overLimit || frames > settings.maxSegmentFrames,
        seam,
        nextSeam,
        fields: derived,
        issues,
        refPrev,
        rawFrames: material.frames,
        targetFrames: fit.target,
        pad,
        padAuto,
        padTotal: padTotalOf(pad),
        overLimit: fit.overLimit,
        cap: fit.cap,
        aligned: isAligned(frames, refPrev),
        hash,
        stale,
        generatedBeatIds: meta?.beatIds ?? null,
        addedBeats,
        removedBeats
      }
    })
  }

  function globalIssues(
    views: SegmentView[],
    entities: Entity[],
    beats: Beat[],
    settings: ProjectSettings,
    entityById: Map<ID, Entity>,
    schema: FieldSchema[]
  ) {
    return validateGlobal(
      {
        entities,
        beats,
        segments: views.map((v) => ({ beats: v.beats, fields: v.fields }))
      },
      { settings, entityById, schema }
    )
  }

  /* --------------------------- 字段编辑 --------------------------- */

  async function setField(projectId: ID, groupId: ID, key: string, value: string) {
    if (!fieldOverrides.value[groupId]) fieldOverrides.value[groupId] = {}
    fieldOverrides.value[groupId][key] = value
    await persistOverrides(projectId)
  }

  async function setFields(projectId: ID, groupId: ID, values: Record<string, string>) {
    fieldOverrides.value[groupId] = { ...(fieldOverrides.value[groupId] ?? {}), ...values }
    await persistOverrides(projectId)
  }

  async function setSummary(projectId: ID, groupId: ID, value: string) {
    summaries.value[groupId] = value
    await persistOverrides(projectId)
  }

  /** 清除某些字段的人工锁定，恢复自动派生 */
  async function clearFields(projectId: ID, groupId: ID, keys: string[]) {
    const bag = fieldOverrides.value[groupId]
    if (bag) {
      for (const k of keys) delete bag[k]
      if (!Object.keys(bag).length) delete fieldOverrides.value[groupId]
    }
    await persistOverrides(projectId)
  }

  /** 单独清除 summary */
  async function clearSummary(projectId: ID, groupId: ID) {
    delete summaries.value[groupId]
    await persistOverrides(projectId)
  }

  function getSummary(groupId: ID): string {
    return summaries.value[groupId] ?? ''
  }

  /** 某个字段是否被人工改动锁定（锁定后引擎不再自动派生） */
  function isFieldLocked(groupId: ID, key: string): boolean {
    if (key === 'summary') return !!summaries.value[groupId]
    const bag = fieldOverrides.value[groupId]
    return !!bag && Object.prototype.hasOwnProperty.call(bag, key)
  }

  function lockedKeys(groupId: ID): string[] {
    const keys = Object.keys(fieldOverrides.value[groupId] ?? {})
    if (summaries.value[groupId]) keys.push('summary')
    return keys
  }

  function exportAssembly(
    views: SegmentView[],
    schema: FieldSchema[],
    settings: ProjectSettings = DEFAULT_SETTINGS
  ): string {
    const segments = views.map((v, i) => {
      const fields = { ...v.fields }
      const summary = summaries.value[v.group.id]
      if (summary) fields.summary = summary
      return {
        index: i + 1,
        refPrev: v.refPrev,
        frames: v.frames,
        rawFrames: v.rawFrames,
        padFrames: v.padTotal,
        aligned: v.aligned,
        duration: Number((v.frames / settings.fps).toFixed(3)),
        continuityFromPrev: v.seam?.continuityFromPrev ?? false,
        continuityToNext: v.nextSeam?.continuityToNext ?? false,
        blackFallback: v.nextSeam?.blackFallback ?? false,
        tailCutTo: v.nextSeam?.needsTailCut ? v.nextSeam.tailCutTargetId : null,
        beats: v.beats.map((b) => ({
          kind: b.kind,
          title: b.title,
          entities: b.entities,
          speakerId: b.speakerId ?? null,
          frames: beatFrames(b, settings),
          padFrames: v.pad[b.id] ?? 0
        })),
        fields,
        text: composeSegmentText(schema, fields)
      }
    })
    return JSON.stringify({ segments }, null, 2)
  }

  async function clearSegments(projectId: ID) {
    await db.kv.delete(`overrides:${projectId}`)
    await db.kv.delete(`summaries:${projectId}`)
    fieldOverrides.value = {}
    summaries.value = {}
  }

  return {
    assemblies,
    currentId,
    current,
    loading,
    fieldOverrides,
    summaries,
    segmentMeta,
    load,
    reset,
    markGenerated,
    clearMeta,
    reconcile,
    createAssembly,
    regenerate,
    updateStrategy,
    renameAssembly,
    removeAssembly,
    setGroups,
    splitGroupAt,
    mergeGroups,
    removeBeatFromGroup,
    setGroupRefPrev,
    setGroupPad,
    clearGroupPad,
    clearAllPads,
    buildSegmentViews,
    globalIssues,
    setField,
    setFields,
    setSummary,
    clearFields,
    clearSummary,
    getSummary,
    isFieldLocked,
    lockedKeys,
    exportAssembly,
    clearSegments,
    countFramesFromIds
  }
})
