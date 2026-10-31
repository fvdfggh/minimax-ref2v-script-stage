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
import {
  buildBeatSplitMessages,
  buildBeatWriteMessages,
  buildEntityWriteMessages
} from '@/core/llm/assist'
import type {
  BeatSplitInput,
  BeatSplitPart,
  BeatWriteInput,
  EntityWriteInput
} from '@/core/llm/assist'
import { chunkBy, splitStory } from '@/domain/chunk'
import { splitCostumeOf } from '@/domain/refSheet'
import { useProviderStore } from './provider'
import { useRegistryStore } from './registry'
import type {
  AdviceBeatPatch,
  AdviceEntityPatch,
  AdviceFieldPatch,
  AdviceGroupPatch,
  AdviceInput,
  StageAdvice
} from '@/core/llm/advice'
import type { EntityKind, EntityType } from '@/domain/types'
import { ENTITY_TYPES as ENTITY_TYPES_LIST, normalizeEntityType } from '@/domain/types'
import type {
  Beat,
  Entity,
  FieldSchema,
  ID,
  ProjectSettings,
  SeamAnalysis
} from '@/domain/types'
import type {
  FixInput,
  FixPatch,
  GlossaryBeatPatch,
  GlossaryEntityPatch,
  LocalizeFieldsInput,
  LocalizeDirection,
  ProjectSubjectBrief,
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

/** 阶段四的单段本地化任务 */
export interface SegmentLocalizeTask {
  id: string
  schema: FieldSchema[]
  beats: Beat[]
  entities: Entity[]
  /** 源稿（含派生字段，作为只读上下文） */
  fields: Record<string, string>
  /**
   * 翻译方向。缺省 zh2en（本地化的常规方向）；
   * 同步页在"英文改过、中文落后"时传 en2zh。
   */
  direction?: LocalizeDirection
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
  /** 已存在于本集注册表，不可重复创建 */
  exists: boolean
  /**
   * 外部项目（系列）母版里已有同名主体：
   * 确认后从项目取用到本集（带 sourceId 溯源），而不是在本集新建一份。
   * 这是跨集「不重复定义」的关键 —— 名字 / 类型 / 设定都以母版为准。
   */
  inProject: boolean
  /** 命中的项目层母版实体 id（inProject 时给出） */
  projectEntityId?: ID
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
const ENTITY_TYPES = new Set<string>(ENTITY_TYPES_LIST)

function str(v: unknown): string | undefined {
  const s = v == null ? '' : String(v).trim()
  return s || undefined
}

/**
 * 补丁文本的三种状态：
 *   undefined / "" → 不改（"" 是兜底：模型想"填满模板"时会留空串，不能当成清空）
 *   null           → 清空
 *   有值           → 改成这个值
 */
function textPatch(v: unknown): string | null | undefined {
  if (v === null) return null
  if (v === undefined) return undefined
  const s = String(v).trim()
  return s || undefined
}

function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : undefined
}

/**
 * 单字段助手返回的正文：模型偶尔会自带"镜头描述："前缀、引号或代码块围栏。
 * 这些字符进了提示词就是噪音（下游会原样发给图像 / 视频模型），落库前清掉。
 */
export function cleanSingle(raw: string): string {
  let t = (raw ?? '').trim()
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim()
  t = t.replace(
    /^(镜头描述|画面描述|长相|服装与身形|音色|描述|direction|visual\s*desc(?:ription)?|shot|prompt)\s*[:：]\s*/i,
    ''
  )
  if (t.length > 1 && /^["'“”‘’「」]/.test(t) && /["'“”‘’「」]$/.test(t)) t = t.slice(1, -1).trim()
  return t.replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim()
}

/** 拆拍的 kind 只认这四种：拆分是"切现有的拍"，不该凭空造出转场 / 空镜 */
const SPLIT_KINDS = new Set(['action', 'dialogue', 'reaction', 'insert'])

/**
 * 归一拆拍结果。
 *
 * 权重统一夹在 1~3：模型常给出 0、5、0.5 这类值，直接拿去算帧数会把
 * 总时长算歪（帧数守恒是按比例分的，权重只该表达"谁长谁短"）。
 */
export function normalizeSplitParts(raw: unknown): BeatSplitPart[] {
  if (!Array.isArray(raw)) return []
  const out: BeatSplitPart[] = []
  for (const item of raw as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') continue
    const title = String(item.title ?? '').trim()
    if (!title) continue
    const kind = SPLIT_KINDS.has(String(item.kind ?? '')) ? String(item.kind) : 'action'
    const dialogue = kind === 'dialogue' ? String(item.dialogue ?? '').trim() : ''
    if (kind === 'dialogue' && !dialogue) continue
    const w = Math.round(Number(item.weight))
    out.push({
      title,
      kind,
      dialogue: dialogue || undefined,
      direction: String(item.direction ?? '').trim() || undefined,
      visualDesc: String(item.visualDesc ?? '').trim() || undefined,
      weight: Number.isFinite(w) ? Math.min(3, Math.max(1, w)) : 2
    })
  }
  return out
}


/**
 * 清洗模型返回的补丁：丢掉 op 非法、定位缺失、内容全空的条目。
 * 宁可少应用几条，也不要让半截补丁写进库。
 *
 * ★ 这里也是「部分补丁」的安全闸门：
 *   模型即使把模板填满、每个字段都回一个 ""，也会被归一成「不改」，
 *   不会把整个片段的内容洗成空。
 */
export function normalizeAdvice(raw: StageAdvice | undefined): StageAdvice {
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
      title: textPatch(p?.title),
      kind: str(p?.kind),
      dialogue: textPatch(p?.dialogue),
      direction: textPatch(p?.direction),
      visualDesc: textPatch(p?.visualDesc),
      scene: textPatch(p?.scene),
      entities: Array.isArray(p?.entities)
        ? p.entities.map((x) => String(x).trim()).filter(Boolean)
        : undefined,
      speaker: textPatch(p?.speaker),
      focus: textPatch(p?.focus),
      titleEn: textPatch(p?.titleEn),
      directionEn: textPatch(p?.directionEn),
      visualDescEn: textPatch(p?.visualDescEn),
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
      type: p?.type ? (ENTITY_TYPES.has(String(p.type)) ? str(p.type) : normalizeEntityType(p.type)) : undefined,
      kind: kind === 'speaking' || kind === 'non_speaking' ? kind : undefined,
      voiceDesc: textPatch(p?.voiceDesc),
      textDesc: textPatch(p?.textDesc),
      costumeDesc: textPatch(p?.costumeDesc),
      nameEn: textPatch(p?.nameEn),
      voiceDescEn: textPatch(p?.voiceDescEn),
      textDescEn: textPatch(p?.textDescEn),
      costumeDescEn: textPatch(p?.costumeDescEn),
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

/** 清理模型返回的实体草案：去重、过滤已知实体、补默认值 */
function normalizeProposals(
  raw: unknown,
  known: Set<string>,
  beats: Stage1Beat[],
  projectSubjects: ProjectSubjectBrief[] = []
): EntityProposal[] {
  const list = Array.isArray(raw) ? (raw as Stage1NewEntity[]) : []
  // 项目层母版：同名一律视为「已有」，类型 / 设定以母版为准
  const masters = new Map(projectSubjects.map((e) => [e.name, e]))
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
    // 本集已有优先：本集那份才是这一集的当前状态（可能在本集里改过），
    // 不能再从母版取一份同名副本进来。本集没有、母版有的才走「项目取用」。
    const exists = known.has(name)
    const master = exists ? undefined : masters.get(name)
    // 被当成场景引用的名字，类型强制归正为 scene（母版类型优先，母版是真相源）
    const forceScene = sceneNames.has(name)
    const kind: EntityKind = master
      ? master.kind
      : forceScene
        ? 'non_speaking'
        : item?.kind === 'speaking'
          ? 'speaking'
          : 'non_speaking'
    // 模型偶尔还会吐出 ui / other：统一收进口径里的三类，认不出按道具算（模型自己拿不准的十有八九是道具）
    const type: EntityType = master
      ? master.type
      : forceScene
        ? 'scene'
        : item?.type
          ? normalizeEntityType(item.type)
          : 'character'
    // 模型常把"穿着"混进长相（textDesc），这里当场拆成两个字段：
    // 用户只在界面上点几下，没有义务回头手工拆；拆完的草案直接就是对的
    const split = splitCostumeOf(type, item?.textDesc, item?.costumeDesc)
    out.push({
      name,
      type,
      kind,
      // 母版有设定就用母版（同一角色跨集必须长得一样）；母版还空着才先用模型给的
      voiceDesc: kind === 'speaking' ? (master?.voiceDesc ?? String(item?.voiceDesc ?? '').trim()) : '',
      textDesc: master?.textDesc ?? split.textDesc,
      costumeDesc: master?.costumeDesc ?? split.costumeDesc,
      note: master?.note ?? String(item?.note ?? '').trim(),
      firstAppear: item?.firstAppear ? String(item.firstAppear).trim() : '',
      accepted: master ? true : !exists,
      exists,
      inProject: !!master,
      projectEntityId: master?.id,
      refCount: refCount.get(name) ?? 0
    })
  }

  // 模型漏登记但被片段引用的名字，也补进草案，避免绑定悬空
  for (const [name, count] of refCount) {
    if (known.has(name) || seen.has(name)) continue
    seen.add(name)
    const master = masters.get(name)
    const isScene = sceneNames.has(name)
    const isSpeaker = !isScene && beats.some((b) => b.speaker === name)
    out.push({
      name,
      type: master ? master.type : isScene ? 'scene' : 'character',
      kind: master ? master.kind : isSpeaker ? 'speaking' : 'non_speaking',
      voiceDesc: master?.voiceDesc ?? '',
      textDesc: master?.textDesc ?? '',
      costumeDesc: master?.costumeDesc ?? '',
      note: master
        ? '项目主体，由片段引用自动取用'
        : isScene
          ? '模型未登记的场景，由片段引用反推'
          : '模型未登记，由片段引用反推',
      firstAppear: '',
      accepted: true,
      exists: false,
      inProject: !!master,
      projectEntityId: master?.id,
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
    settings: ProjectSettings,
    opts: { projectSubjects?: ProjectSubjectBrief[] } = {}
  ): Promise<Stage1Result> {
    const provider = requireProvider()
    running.value = true
    error.value = null
    try {
      const chunks = splitStory(story, settings.storyChunkChars)
      if (!chunks.length) throw new Error('故事原文是空的')

      const rawBeats: Stage1Beat[] = []
      const rawEntities: Stage1NewEntity[] = []
      // 后续批次必须复用同一套命名，所以本批登记的实体立刻进入"已知"清单。
      // 项目层母版不放进这里 —— 它在提示词里有独立的清单块，
      // 混进"本集已有"会让模型以为本集真的已经有这些实体。
      const projectSubjects = opts.projectSubjects ?? []
      const known = new Set(entityNames)

      for (const [i, chunk] of chunks.entries()) {
        progress.value =
          chunks.length > 1
            ? `阶段一：正在拆解第 ${i + 1}/${chunks.length} 批（第 ${chunk.paraFrom}~${chunk.paraTo} 段）…`
            : '阶段一：正在拆解分镜（顺带登记新实体）…'

        /** 跑一次子批：解析 beats / 登记实体 / 累积到 known。空结果直接抛错 */
        const collectBatch = async (text: string, paraFrom: number, paraTo: number): Promise<void> => {
          const data = await retryOnce(() =>
            provider.callJson<{
              beats?: Stage1Beat[]
              newEntities?: Stage1NewEntity[]
            }>(
              buildStage1Messages(text, [...known], {
                language: settings.workLanguage,
                projectSubjects,
                batch: {
                  index: i + 1,
                  total: chunks.length,
                  paraFrom,
                  paraTo,
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
              `第 ${i + 1}/${chunks.length} 批没有返回任何片段（原文第 ${paraFrom}~${paraTo} 段），已拆出的部分不会入库`
            )
          }
          rawBeats.push(...batchBeats)

          for (const e of Array.isArray(data?.newEntities) ? data.newEntities : []) {
            rawEntities.push(e)
            const n = String(e?.name ?? '').trim()
            if (n) known.add(n)
          }
        }

        try {
          await collectBatch(chunk.text, chunk.paraFrom, chunk.paraTo)
        } catch (e) {
          // 批次太大导致模型截断/返空时，对半再拆一次（只拆一层，不再递归），
          // 把「整轮白跑」压缩到「只剩失败的那一小段要重跑」。
          // 子批的段落号无法精确对回原文，沿用本批范围（只用于提示与上下文标签）。
          const halves = splitStory(chunk.text, Math.max(300, Math.round(settings.storyChunkChars / 2)))
          if (halves.length < 2) throw e
          for (const h of halves) {
            await collectBatch(h.text, chunk.paraFrom, chunk.paraTo)
          }
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
      const newEntities = normalizeProposals(rawEntities, new Set(entityNames), beats, projectSubjects)

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
    settings: ProjectSettings,
    opts: { projectSubjects?: ProjectSubjectBrief[] } = {}
  ): Promise<EntityProposal[]> {
    const provider = requireProvider()
    running.value = true
    error.value = null
    try {
      const chunks = splitStory(story, settings.storyChunkChars)
      if (!chunks.length) throw new Error('故事原文是空的')

      const projectSubjects = opts.projectSubjects ?? []
      const known = new Set(entityNames)
      const raw: Stage1NewEntity[] = []

      for (const [i, chunk] of chunks.entries()) {
        progress.value =
          chunks.length > 1
            ? `正在梳理实体：第 ${i + 1}/${chunks.length} 批（第 ${chunk.paraFrom}~${chunk.paraTo} 段）…`
            : '正在梳理实体…'

        const data = await retryOnce(() =>
          provider.callJson<{ newEntities?: Stage1NewEntity[] }>(
            buildEntityExtractMessages(chunk.text, [...known], {
              language: settings.workLanguage,
              projectSubjects
            }),
            { temperature: 0.35 }
          )
        )

        for (const e of Array.isArray(data?.newEntities) ? data.newEntities : []) {
          raw.push(e)
          const n = String(e?.name ?? '').trim()
          if (n) known.add(n)
        }
      }

      return normalizeProposals(raw, new Set(entityNames), [], projectSubjects)
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
              contextDetails: out.slice(-3),
              // 参考图 / 参考音频的 desc 作为只读上下文交给模型（不进最终提示词）
              assets: useRegistryStore().assets
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
        language: input.language ?? settings.workLanguage,
        // 参考图 / 参考音频的 desc 作为只读上下文交给模型（不进最终提示词）
        assets: useRegistryStore().assets
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

  /* --------------------------- 阶段四：本地化 --------------------------- */

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
          // 翻译同样过一遍拆字段：模型偶尔把 "wearing a uniform" 塞进 textDescEn
          const split = splitCostumeOf(
            entityById.get(id)?.type,
            raw?.textDesc,
            raw?.costumeDesc
          )
          const patch: GlossaryEntityPatch = {
            id,
            name: String(raw?.name ?? '').trim(),
            voiceDesc: String(raw?.voiceDesc ?? '').trim(),
            textDesc: split.textDesc,
            costumeDesc: split.costumeDesc
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
      entityNameMap,
      direction: task.direction
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
      }>(
        buildFixMessages({
          ...input,
          fps: input.fps ?? settings.fps,
          // 参考图 / 参考音频的 desc 作为只读上下文交给模型（不进最终提示词）
          assets: useRegistryStore().assets
        }),
        { temperature: 0.25 }
      )

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

  /* --------------------------- 单点助手 --------------------------- */

  /**
   * 单点助手不走 `running`：那是整批流水线的闸（按钮转圈、页面锁住）。
   * 单点只在它自己那颗按钮上转圈 —— 用户经常是"补这一拍的同时还在看上一拍"，
   * 一锁就等于把上下文也一起冻住了。
   */

  /** 只写一拍的镜头 / 画面描述 */
  async function writeBeatField(input: BeatWriteInput): Promise<string> {
    const provider = requireProvider()
    const text = await retryOnce(() => provider.callText(buildBeatWriteMessages(input), { temperature: 0.5 }))
    const clean = cleanSingle(text)
    if (!clean) throw new Error('模型没有返回内容')
    return clean
  }

  /**
   * 把一拍拆细。返回的是"建议的几拍"，落库由调用方决定
   * —— 拆拍会换掉这一拍的 id，必须让人先看一眼再点确认。
   */
  async function splitBeatByAi(input: BeatSplitInput): Promise<BeatSplitPart[]> {
    const provider = requireProvider()
    const data = await retryOnce(() =>
      provider.callJson<{ beats?: unknown }>(buildBeatSplitMessages(input), { temperature: 0.4 })
    )
    const parts = normalizeSplitParts(data?.beats)
    if (parts.length < 2) throw new Error('模型没有拆出多拍：可以补一句要求再试')
    return parts
  }

  /** 只写主体的一个描述字段（长相 / 服装 / 音色） */
  async function writeEntityDesc(input: EntityWriteInput): Promise<string> {
    const provider = requireProvider()
    const text = await retryOnce(() => provider.callText(buildEntityWriteMessages(input), { temperature: 0.55 }))
    const clean = cleanSingle(text)
    if (!clean) throw new Error('模型没有返回内容')
    return clean
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
    writeBeatField,
    splitBeatByAi,
    writeEntityDesc,
    reset
  }
})
