import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  buildEntityExtractMessages,
  buildFixMessages,
  buildGlossaryMessages,
  buildLocalizeFieldsMessages,
  buildSegmentFillMessages,
  buildStage1Messages,
  buildStage2Messages
} from '@/core/llm/prompts'
import { buildAdviceMessages } from '@/core/llm/advice'
import { chunkBy, splitStory } from '@/domain/chunk'
import { useProviderStore } from './provider'
import type {
  AdviceBeatPatch,
  AdviceEntityPatch,
  AdviceFieldPatch,
  AdviceGroupPatch,
  AdviceInput,
  StageAdvice
} from '@/core/llm/advice'
import type { EntityKind, EntityType } from '@/domain/types'
import type {
  Beat,
  Entity,
  FieldSchema,
  ProjectSettings,
  SeamAnalysis
} from '@/domain/types'
import type {
  FixInput,
  FixPatch,
  GlossaryBeatPatch,
  GlossaryEntityPatch,
  LocalizeFieldsInput,
  SegmentFillInput,
  Stage1Beat,
  Stage1NewEntity,
  Stage2BeatDetail
} from '@/core/llm/prompts'

export interface FixResult {
  patches: FixPatch[]
  unfixable: string[]
  notes: string
}

/** 阶段三的单段补全任务 */
export interface SegmentFillTask {
  id: string
  schema: FieldSchema[]
  beats: Beat[]
  entities: Entity[]
  seamFromPrev: SeamAnalysis | null
  nextSeam: SeamAnalysis | null
  /** 已算好的字段（含派生字段），交给模型当只读上下文 */
  existing: Record<string, string>
  frames: number
  index: number
}

/** 阶段五的单段本地化任务 */
export interface SegmentLocalizeTask {
  id: string
  schema: FieldSchema[]
  beats: Beat[]
  entities: Entity[]
  /** 中文原稿（含派生字段，作为只读上下文） */
  fields: Record<string, string>
  index: number
  total: number
  frames: number
}

/** 词条表翻译结果 */
export interface LocalizeGlossaryResult {
  beats: GlossaryBeatPatch[]
  entities: GlossaryEntityPatch[]
}

export interface Stage1Result {
  beats: Stage1Beat[]
  newEntities: EntityProposal[]
}

export interface EntityProposal extends Stage1NewEntity {
  accepted: boolean
  /** 已存在于注册表，不可重复创建 */
  exists: boolean
  /** 本批片段里实际被引用了几次 */
  refCount: number
}

/**
 * 分批之后一轮里的请求数成倍增加，偶发的网络抖动 / 限流不该让整轮白跑。
 * 单批失败先重试一次再向上抛 —— 成本远低于让用户重跑全部批次。
 */
async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    return await fn()
  }
}

const BEAT_OPS = new Set(['update', 'insert', 'delete'])
const GROUP_OPS = new Set(['split', 'merge', 'refPrev'])
const ENTITY_TYPES = new Set(['character', 'scene', 'prop', 'ui', 'other'])

function str(v: unknown): string | undefined {
  const s = v == null ? '' : String(v).trim()
  return s || undefined
}

function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : undefined
}

/**
 * 清洗模型返回的补丁：丢掉 op 非法、定位缺失、内容全空的条目。
 * 宁可少应用几条，也不要让半截补丁写进库。
 */
function normalizeAdvice(raw: StageAdvice | undefined): StageAdvice {
  const src = raw ?? {}

  const beats: AdviceBeatPatch[] = []
  for (const p of Array.isArray(src.beats) ? src.beats : []) {
    const op = str(p?.op) as AdviceBeatPatch['op'] | undefined
    if (!op || !BEAT_OPS.has(op)) continue
    const index = num(p?.index)
    if (op !== 'insert' && (!index || index < 1)) continue
    const patch: AdviceBeatPatch = {
      op,
      index,
      afterIndex: num(p?.afterIndex),
      title: str(p?.title),
      kind: str(p?.kind),
      dialogue: p?.dialogue == null ? undefined : String(p.dialogue),
      direction: str(p?.direction),
      visualDesc: str(p?.visualDesc),
      scene: str(p?.scene),
      entities: Array.isArray(p?.entities)
        ? p.entities.map((x) => String(x).trim()).filter(Boolean)
        : undefined,
      speaker: str(p?.speaker),
      focus: str(p?.focus),
      titleEn: str(p?.titleEn),
      directionEn: str(p?.directionEn),
      visualDescEn: str(p?.visualDescEn),
      reason: str(p?.reason)
    }
    const touched = [
      patch.title,
      patch.kind,
      patch.dialogue,
      patch.direction,
      patch.visualDesc,
      patch.scene,
      patch.speaker,
      patch.focus,
      patch.titleEn,
      patch.directionEn,
      patch.visualDescEn
    ].some((v) => v !== undefined)
    if (op === 'update' && !touched && !patch.entities) continue
    if (op === 'insert' && !patch.title) continue
    beats.push(patch)
  }

  const entities: AdviceEntityPatch[] = []
  for (const p of Array.isArray(src.entities) ? src.entities : []) {
    const op = str(p?.op) as AdviceEntityPatch['op'] | undefined
    const name = str(p?.name)
    if (!op || !BEAT_OPS.has(op) || !name) continue
    const kind = str(p?.kind)
    entities.push({
      op,
      name,
      type: ENTITY_TYPES.has(String(p?.type)) ? str(p?.type) : undefined,
      kind: kind === 'speaking' || kind === 'non_speaking' ? kind : undefined,
      voiceDesc: str(p?.voiceDesc),
      textDesc: str(p?.textDesc),
      nameEn: str(p?.nameEn),
      voiceDescEn: str(p?.voiceDescEn),
      textDescEn: str(p?.textDescEn),
      reason: str(p?.reason)
    })
  }

  const groups: AdviceGroupPatch[] = []
  for (const p of Array.isArray(src.groups) ? src.groups : []) {
    const op = str(p?.op) as AdviceGroupPatch['op'] | undefined
    if (!op || !GROUP_OPS.has(op)) continue
    const patch: AdviceGroupPatch = {
      op,
      atBeatIndex: num(p?.atBeatIndex),
      fromSegment: num(p?.fromSegment),
      toSegment: num(p?.toSegment),
      segment: num(p?.segment),
      refPrev: typeof p?.refPrev === 'boolean' ? p.refPrev : undefined,
      reason: str(p?.reason)
    }
    if (op === 'split' && (!patch.atBeatIndex || patch.atBeatIndex < 1)) continue
    if (op === 'merge' && (!patch.fromSegment || !patch.toSegment)) continue
    if (op === 'refPrev' && !patch.segment) continue
    groups.push(patch)
  }

  const fields: AdviceFieldPatch[] = []
  for (const p of Array.isArray(src.fields) ? src.fields : []) {
    const segment = num(p?.segment)
    const key = str(p?.key)
    if (!segment || segment < 1 || !key) continue
    fields.push({
      segment,
      key,
      value: p?.value == null ? '' : String(p.value),
      reason: str(p?.reason)
    })
  }

  return {
    summary: str(src.summary),
    beats,
    entities,
    groups,
    fields,
    notes: str(src.notes)
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => !!x)
}

const TYPE_SET: EntityType[] = ['character', 'scene', 'prop', 'ui', 'other']

/** 清理模型返回的实体草案：去重、过滤已知实体、补默认值 */
function normalizeProposals(
  raw: unknown,
  known: Set<string>,
  beats: Stage1Beat[]
): EntityProposal[] {
  const list = Array.isArray(raw) ? (raw as Stage1NewEntity[]) : []
  const refCount = new Map<string, number>()
  const sceneNames = new Set<string>()
  for (const b of beats) {
    for (const name of [...(b.entities ?? []), ...(b.speaker ? [b.speaker] : [])]) {
      refCount.set(name, (refCount.get(name) ?? 0) + 1)
    }
    if (b.scene) {
      refCount.set(b.scene, (refCount.get(b.scene) ?? 0) + 1)
      sceneNames.add(b.scene)
    }
  }

  const seen = new Set<string>()
  const out: EntityProposal[] = []
  for (const item of list) {
    const name = String(item?.name ?? '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const exists = known.has(name)
    // 被当成场景引用的名字，类型强制归正为 scene
    const forceScene = sceneNames.has(name)
    const kind: EntityKind = forceScene
      ? 'non_speaking'
      : item?.kind === 'speaking'
        ? 'speaking'
        : 'non_speaking'
    const type: EntityType = forceScene
      ? 'scene'
      : TYPE_SET.includes(item?.type as EntityType)
        ? (item.type as EntityType)
        : 'character'
    out.push({
      name,
      type,
      kind,
      voiceDesc: kind === 'speaking' ? String(item?.voiceDesc ?? '').trim() : '',
      textDesc: String(item?.textDesc ?? '').trim(),
      note: String(item?.note ?? '').trim(),
      firstAppear: item?.firstAppear ? String(item.firstAppear).trim() : '',
      accepted: !exists,
      exists,
      refCount: refCount.get(name) ?? 0
    })
  }

  // 模型漏登记但被片段引用的名字，也补进草案，避免绑定悬空
  for (const [name, count] of refCount) {
    if (known.has(name) || seen.has(name)) continue
    seen.add(name)
    const isScene = sceneNames.has(name)
    const isSpeaker = !isScene && beats.some((b) => b.speaker === name)
    out.push({
      name,
      type: isScene ? 'scene' : 'character',
      kind: isSpeaker ? 'speaking' : 'non_speaking',
      voiceDesc: '',
      textDesc: '',
      note: isScene ? '模型未登记的场景，由片段引用反推' : '模型未登记，由片段引用反推',
      firstAppear: '',
      accepted: true,
      exists: false,
      refCount: count
    })
  }

  return out
}

export const usePipelineStore = defineStore('pipeline', () => {
  const running = ref(false)
  const progress = ref('')
  const error = ref<string | null>(null)

  function requireProvider() {
    const provider = useProviderStore()
    const hasKey = provider.providers.some((p) => p.baseUrl && p.model)
    if (!hasKey) throw new Error('请先在设置中配置模型供应商')
    return provider
  }

  /* --------------------------- 阶段一 --------------------------- */

  async function runStage1(
    story: string,
    entityNames: string[],
    settings: ProjectSettings
  ): Promise<Stage1Result> {
    const provider = requireProvider()
    running.value = true
    error.value = null
    try {
      const chunks = splitStory(story, settings.storyChunkChars)
      if (!chunks.length) throw new Error('故事原文是空的')

      const rawBeats: Stage1Beat[] = []
      const rawEntities: Stage1NewEntity[] = []
      // 后续批次必须复用同一套命名，所以本批登记的实体立刻进入"已知"清单
      const known = new Set(entityNames)

      for (const [i, chunk] of chunks.entries()) {
        progress.value =
          chunks.length > 1
            ? `阶段一：正在拆解第 ${i + 1}/${chunks.length} 批（第 ${chunk.paraFrom}~${chunk.paraTo} 段）…`
            : '阶段一：正在拆解分镜并登记实体…'

        const data = await retryOnce(() =>
          provider.callJson<{
            beats?: Stage1Beat[]
            newEntities?: Stage1NewEntity[]
          }>(
            buildStage1Messages(chunk.text, [...known], {
              language: settings.workLanguage,
              batch: {
                index: i + 1,
                total: chunks.length,
                paraFrom: chunk.paraFrom,
                paraTo: chunk.paraTo,
                paragraphCount: chunk.paragraphs,
                contextTitles: rawBeats
                  .slice(-6)
                  .map((b) => String(b?.title ?? '').trim())
                  .filter(Boolean)
              }
            }),
            { temperature: 0.35 }
          )
        )

        const batchBeats = Array.isArray(data?.beats) ? data.beats : []
        if (!batchBeats.length) {
          throw new Error(
            `第 ${i + 1}/${chunks.length} 批没有返回任何片段（原文第 ${chunk.paraFrom}~${chunk.paraTo} 段），已拆出的部分不会入库`
          )
        }
        rawBeats.push(...batchBeats)

        for (const e of Array.isArray(data?.newEntities) ? data.newEntities : []) {
          rawEntities.push(e)
          const n = String(e?.name ?? '').trim()
          if (n) known.add(n)
        }
      }

      const beats = rawBeats.map((b) => ({
        title: String(b.title ?? '').trim() || '未命名片段',
        kind: String(b.kind ?? 'action').trim(),
        dialogue: b.dialogue != null ? String(b.dialogue).trim() : undefined,
        scene: b.scene ? String(b.scene).trim() : undefined,
        entities: toStringArray(b.entities),
        speaker: b.speaker ? String(b.speaker).trim() : undefined
      }))

      // 跨批累积后统一归一化，refCount 才是全片的真实次数
      const newEntities = normalizeProposals(rawEntities, new Set(entityNames), beats)

      return { beats, newEntities }
    } catch (e) {
      error.value = (e as Error).message
      throw e
    } finally {
      running.value = false
      progress.value = ''
    }
  }

  /** 只梳理实体，不拆片段。按原文长度分批，逐批累积已知实体 */
  async function runEntityExtract(
    story: string,
    entityNames: string[],
    settings: ProjectSettings
  ): Promise<EntityProposal[]> {
    const provider = requireProvider()
    running.value = true
    error.value = null
    try {
      const chunks = splitStory(story, settings.storyChunkChars)
      if (!chunks.length) throw new Error('故事原文是空的')

      const known = new Set(entityNames)
      const raw: Stage1NewEntity[] = []

      for (const [i, chunk] of chunks.entries()) {
        progress.value =
          chunks.length > 1
            ? `正在梳理实体：第 ${i + 1}/${chunks.length} 批（第 ${chunk.paraFrom}~${chunk.paraTo} 段）…`
            : '正在梳理实体…'

        const data = await retryOnce(() =>
          provider.callJson<{ newEntities?: Stage1NewEntity[] }>(
            buildEntityExtractMessages(chunk.text, [...known], { language: settings.workLanguage }),
            { temperature: 0.35 }
          )
        )

        for (const e of Array.isArray(data?.newEntities) ? data.newEntities : []) {
          raw.push(e)
          const n = String(e?.name ?? '').trim()
          if (n) known.add(n)
        }
      }

      return normalizeProposals(raw, new Set(entityNames), [])
    } catch (e) {
      error.value = (e as Error).message
      throw e
    } finally {
      running.value = false
      progress.value = ''
    }
  }

  /* --------------------------- 阶段二 --------------------------- */

  async function runStage2(
    beats: Beat[],
    entities: Entity[],
    settings: ProjectSettings
  ): Promise<Stage2BeatDetail[]> {
    const provider = requireProvider()
    running.value = true
    error.value = null
    try {
      if (!beats.length) throw new Error('没有需要填充的片段')
      const batches = chunkBy(beats, settings.beatBatchSize)
      const out: Stage2BeatDetail[] = []

      for (const [i, batch] of batches.entries()) {
        progress.value =
          batches.length > 1
            ? `阶段二：正在填充第 ${i + 1}/${batches.length} 批（已完成 ${out.length}/${beats.length} 个片段）…`
            : `阶段二：正在填充 ${beats.length} 个片段的细节…`

        const data = await retryOnce(() =>
          provider.callJson<{ details?: Stage2BeatDetail[] }>(
            buildStage2Messages(batch, entities, {
              language: settings.workLanguage,
              batch: { index: i + 1, total: batches.length },
              // 只带最后几条，够对齐措辞风格就行，不要把上文越滚越长
              contextDetails: out.slice(-3)
            }),
            { temperature: 0.4 }
          )
        )

        const details = Array.isArray(data?.details) ? data.details : []
        if (!details.length) {
          throw new Error(`第 ${i + 1}/${batches.length} 批没有返回任何细节`)
        }
        out.push(...details)
      }

      if (!out.length) throw new Error('模型没有返回任何细节')
      return out
    } catch (e) {
      error.value = (e as Error).message
      throw e
    } finally {
      running.value = false
      progress.value = ''
    }
  }

  /* --------------------------- 阶段三 --------------------------- */

  /**
   * 阶段三：为单个视频段补全所有需要模型填写的字段。
   * 返回 { 字段名: 内容 }，由调用方决定怎么写回 store。
   */
  async function runSegmentFill(
    input: Omit<SegmentFillInput, 'fps'> & { fps?: number },
    settings: ProjectSettings
  ): Promise<Record<string, string>> {
    const provider = requireProvider()
    const data = await provider.callJson<Record<string, unknown>>(
      buildSegmentFillMessages({
        ...input,
        fps: input.fps ?? settings.fps,
        language: input.language ?? settings.workLanguage
      }),
      { temperature: 0.5 }
    )

    const targets = input.schema.filter((f) => f.source === 'llm')
    const out: Record<string, string> = {}
    for (const f of targets) {
      const value = data?.[f.key]
      if (value == null) continue
      const text = typeof value === 'string' ? value.trim() : String(value).trim()
      if (text) out[f.key] = text
    }
    if (!Object.keys(out).length) {
      throw new Error('模型没有返回任何可用的字段内容')
    }
    return out
  }

  /**
   * 批量补全。并发受控，逐段回调，单段失败不影响其他段。
   */
  async function fillSegments(
    tasks: SegmentFillTask[],
    settings: ProjectSettings,
    onOne: (taskId: string, fields: Record<string, string>, err?: string) => void | Promise<void>,
    concurrency = 2
  ): Promise<{ ok: number; failed: number }> {
    running.value = true
    error.value = null

    const total = tasks.length
    let cursor = 0
    let ok = 0
    let failed = 0
    let finished = 0

    async function worker() {
      for (;;) {
        const i = cursor++
        if (i >= total) return
        const task = tasks[i]
        progress.value = `阶段三：正在补全 ${finished + 1}/${total} 段…`
        try {
          const fields = await runSegmentFill(
            {
              schema: task.schema,
              groupBeats: task.beats,
              entities: task.entities,
              seamFromPrev: task.seamFromPrev,
              nextSeam: task.nextSeam,
              existing: task.existing,
              segmentIndex: task.index,
              segmentTotal: total,
              frames: task.frames
            },
            settings
          )
          await onOne(task.id, fields)
          ok++
        } catch (e) {
          failed++
          await onOne(task.id, {}, (e as Error).message)
        }
        finished++
        progress.value = `阶段三：已完成 ${finished}/${total} 段…`
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, () => worker()))
    } finally {
      running.value = false
      progress.value = ''
    }

    if (failed) error.value = `${failed} 段补全失败，详见列表标记`
    return { ok, failed }
  }

  /* --------------------------- 阶段五：本地化 --------------------------- */

  /**
   * 第一步：词条表翻译（全片一次）。
   * 实体名 / 音色 / 外观 + 片段标题 / 运镜 / 画面 统一译成英文并落库，
   * 之后派生字段由引擎用英文词条重新渲染 —— 结构锚点不经过模型，改不坏。
   */
  async function runGlossary(
    beats: Beat[],
    entities: Entity[],
    settings: ProjectSettings
  ): Promise<LocalizeGlossaryResult> {
    const provider = requireProvider()
    running.value = true
    error.value = null

    const size = settings.glossaryBatchSize
    const entBatches = chunkBy(entities, size)
    const beatBatches = chunkBy(beats, size)
    const total = entBatches.length + beatBatches.length
    if (!total) {
      running.value = false
      throw new Error('没有需要翻译的词条')
    }

    const entityById = new Map(entities.map((e) => [e.id, e]))
    const beatIds = new Set(beats.map((b) => b.id))
    const entityIds = new Set(entities.map((e) => e.id))

    const outB: GlossaryBeatPatch[] = []
    const outE: GlossaryEntityPatch[] = []
    /** 已定稿译名：实体批先跑，后面所有批次都必须复用 */
    const fixedNames: Record<string, string> = {}
    let done = 0

    const call = async (input: Parameters<typeof buildGlossaryMessages>[0], label: string) => {
      progress.value =
        total > 1 ? `本地化：正在翻译词条 ${done + 1}/${total} 批（${label}）…` : `本地化：正在翻译词条（${label}）…`
      const data = await retryOnce(() =>
        provider.callJson<{
          entities?: GlossaryEntityPatch[]
          beats?: GlossaryBeatPatch[]
        }>(buildGlossaryMessages(input), { temperature: 0.2 })
      )
      done++
      return data
    }

    try {
      // ① 实体批：先把实体名定死，片段批才能拿到稳定的译名对照表
      for (const [i, batch] of entBatches.entries()) {
        const data = await call(
          { beats: [], entities: batch, fixedNames, scopeLabel: `实体词条 ${i + 1} / ${entBatches.length}` },
          `实体词条 ${i + 1}/${entBatches.length}`
        )
        for (const raw of Array.isArray(data?.entities) ? data.entities : []) {
          const id = String(raw?.id ?? '').trim()
          if (!id || !entityIds.has(id)) continue
          const patch: GlossaryEntityPatch = {
            id,
            name: String(raw?.name ?? '').trim(),
            voiceDesc: String(raw?.voiceDesc ?? '').trim(),
            textDesc: String(raw?.textDesc ?? '').trim()
          }
          outE.push(patch)
          const src = entityById.get(id)?.name
          if (src && patch.name) fixedNames[src] = patch.name
        }
      }

      // ② 片段批：带上前面积累的译名，保证跨批一致
      for (const [i, batch] of beatBatches.entries()) {
        const data = await call(
          { beats: batch, entities: [], fixedNames, scopeLabel: `片段词条 ${i + 1} / ${beatBatches.length}` },
          `片段词条 ${i + 1}/${beatBatches.length}`
        )
        for (const raw of Array.isArray(data?.beats) ? data.beats : []) {
          const id = String(raw?.id ?? '').trim()
          if (!id || !beatIds.has(id)) continue
          outB.push({
            id,
            title: String(raw?.title ?? '').trim(),
            direction: String(raw?.direction ?? '').trim(),
            visualDesc: String(raw?.visualDesc ?? '').trim()
          })
        }
      }

      if (!outB.length && !outE.length) throw new Error('模型没有返回任何词条')
      return { beats: outB, entities: outE }
    } catch (e) {
      error.value = (e as Error).message
      throw e
    } finally {
      running.value = false
      progress.value = ''
    }
  }

  /**
   * 第二步：单段的模型字段中译英。
   * 引擎派生字段（subject_definitions / retention_analysis / detailed_description）
   * 不在这里翻译 —— 它们由引擎用英文词条重新渲染。
   */
  async function runLocalizeOne(
    task: SegmentLocalizeTask,
    settings: ProjectSettings,
    entityNameMap: Record<string, string>
  ): Promise<Record<string, string>> {
    const provider = requireProvider()
    const input: LocalizeFieldsInput = {
      schema: task.schema,
      fields: task.fields,
      groupBeats: task.beats,
      entities: task.entities,
      segmentIndex: task.index,
      segmentTotal: task.total,
      frames: task.frames,
      fps: settings.fps,
      entityNameMap
    }
    const data = await provider.callJson<Record<string, unknown>>(
      buildLocalizeFieldsMessages(input),
      { temperature: 0.2 }
    )

    const targets = task.schema.filter((f) => f.source === 'llm')
    const out: Record<string, string> = {}
    for (const f of targets) {
      const value = data?.[f.key]
      if (value == null) continue
      const text = typeof value === 'string' ? value.trim() : String(value).trim()
      if (text) out[f.key] = text
    }
    return out
  }

  /** 批量本地化各段的模型字段，单段失败不影响其他段 */
  async function localizeSegments(
    tasks: SegmentLocalizeTask[],
    settings: ProjectSettings,
    entityNameMap: Record<string, string>,
    onOne: (taskId: string, fields: Record<string, string>, err?: string) => void | Promise<void>,
    concurrency = 2
  ): Promise<{ ok: number; failed: number }> {
    running.value = true
    error.value = null

    const total = tasks.length
    let cursor = 0
    let ok = 0
    let failed = 0
    let finished = 0

    async function worker() {
      for (;;) {
        const i = cursor++
        if (i >= total) return
        const task = tasks[i]
        progress.value = `本地化：正在翻译 ${finished + 1}/${total} 段…`
        try {
          const fields = await runLocalizeOne(task, settings, entityNameMap)
          await onOne(task.id, fields)
          ok++
        } catch (e) {
          failed++
          await onOne(task.id, {}, (e as Error).message)
        }
        finished++
        progress.value = `本地化：已完成 ${finished}/${total} 段…`
      }
    }

    try {
      const n = Math.min(concurrency, Math.max(1, total))
      await Promise.all(Array.from({ length: n }, () => worker()))
    } finally {
      running.value = false
      progress.value = ''
    }

    if (failed) error.value = `${failed} 段本地化失败，详见列表标记`
    return { ok, failed }
  }

  /* --------------------------- 阶段意见 --------------------------- */

  /**
   * 把用户的自然语言意见交给模型，换回结构化补丁。
   * 这里只负责"取回并清洗"，不改任何数据 —— 由调用方弹审查框，用户确认后才应用。
   */
  async function runAdvice(input: AdviceInput): Promise<StageAdvice> {
    const provider = requireProvider()
    running.value = true
    error.value = null
    progress.value = '正在分析你的意见…'
    try {
      const data = await provider.callJson<StageAdvice>(buildAdviceMessages(input), {
        temperature: 0.2
      })
      return normalizeAdvice(data)
    } catch (e) {
      error.value = (e as Error).message
      throw e
    } finally {
      running.value = false
      progress.value = ''
    }
  }

  /* --------------------------- 错误修复 --------------------------- */

  /**
   * 交付前修复：把校验出的问题交给模型，返回需要改写的字段。
   * 只接收 scope === 'field' 的问题，结构性问题由调用方拦在外面。
   */
  async function runFix(
    input: Omit<FixInput, 'fps'> & { fps?: number },
    settings: ProjectSettings
  ): Promise<FixResult> {
    const provider = requireProvider()
    running.value = true
    error.value = null
    progress.value = '正在修复校验问题…'
    try {
      const data = await provider.callJson<{
        patches?: unknown
        unfixable?: unknown
        notes?: unknown
      }>(buildFixMessages({ ...input, fps: input.fps ?? settings.fps }), { temperature: 0.25 })

      const validKeys = new Set(input.schema.map((f) => f.key))
      const patches: FixPatch[] = []
      if (Array.isArray(data?.patches)) {
        for (const raw of data.patches as Array<Record<string, unknown>>) {
          const field = String(raw?.field ?? '').trim()
          if (!field || !validKeys.has(field)) continue
          const value = typeof raw?.value === 'string' ? raw.value : ''
          if (!value.trim()) continue
          patches.push({
            field,
            value,
            reason: String(raw?.reason ?? '').trim()
          })
        }
      }

      const unfixable = Array.isArray(data?.unfixable)
        ? (data.unfixable as unknown[]).map((x) => String(x)).filter(Boolean)
        : []
      const notes = String(data?.notes ?? '').trim()

      if (!patches.length && !unfixable.length) {
        throw new Error('模型没有给出任何修改')
      }
      return { patches, unfixable, notes }
    } catch (e) {
      error.value = (e as Error).message
      throw e
    } finally {
      running.value = false
      progress.value = ''
    }
  }

  function reset() {
    running.value = false
    progress.value = ''
    error.value = null
  }

  return {
    running,
    progress,
    error,
    runStage1,
    runEntityExtract,
    runStage2,
    runSegmentFill,
    fillSegments,
    runGlossary,
    runLocalizeOne,
    localizeSegments,
    runAdvice,
    runFix,
    reset
  }
})
