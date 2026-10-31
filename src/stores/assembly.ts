import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, kvDelete, kvGet, kvSet, saveOne } from '@/db'
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
import { speechFitOf } from '@/domain/audioFrames'
import {
  buildPad,
  fitSegmentFrames,
  isAligned,
  padTotalOf,
  refPrevOfStrength,
  resolveRefPrev,
  sumPaddedFrames
} from '@/domain/frames'
import { deriveFields, makeSeeders, composeSegmentText } from '@/domain/derive'
import {
  FINGERPRINT_VERSION,
  legacySegmentSourceHashes,
  segmentSourceHash,
  segmentSourceParts,
  staleDiffOf,
  type SourceDiff
} from '@/domain/cascade'
import { deliveryFields, langOf } from '@/domain/lang'
import { baselineOf, migrateLegacyPairs, syncOf, withSide } from '@/domain/pairs'
import {
  reconcileWithGaps,
  renderHashOf,
  resultStatus,
  type ResultStatus
} from '@/domain/insertion'
import type {
  Assembly,
  AssemblyMode,
  Asset,
  Beat,
  Entity,
  FieldPair,
  FieldPairMap,
  FieldSchema,
  FieldSync,
  FrozenSeam,
  Group,
  ID,
  Lang,
  ProjectSettings,
  SeamAnalysis,
  Segment,
  SegmentLock,
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
  /**
   * 中文工作稿（③ 里那块字段补全只认这一份）。
   *
   * ★ 英文终稿放在 fieldsEn 里，**绝不回退**到这份 —— 本地化之前这一页
   *   就该是中文，拿英文顶上来会让人以为中文稿已经写好了。
   */
  fields: Record<string, string>
  /** 英文终稿（⑤ 本地化写入的目标；未本地化时这里是空的） */
  fieldsEn: Record<string, string>
  /**
   * **交付口径**：跟工作语言走的那一份（`domain/lang.deliveryFields`）。
   *
   * ③ 的字段补全、⑤ 的字段面板、本段检查、门禁、导演包提示词、导出 —— 全都读它。
   * 以前各读各的（页面读英文、门禁读中文），才会出现「字段明明写着，却报为空」。
   */
  delivery: Record<string, string>
  /** 每个字段两侧的同步状态：哪一边落后了，界面标红 */
  fieldSync: Record<string, FieldSync>
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
  /**
   * 生成字段时的段帧数（老记录没有这一项 → null）。
   *
   * 帧数不进内容指纹（改副帧不是改内容），但字段正文里带着「X 帧 = Y 秒」，
   * 所以补帧之后要单独提示「秒数需复核」。
   */
  generatedFrames?: number | null
  /** 补帧之后段帧数变了：字段里写死的时长已经对不上现在这一段 */
  framesChanged?: boolean
  /** 生成时的片段 id 序列；用于说明"上游动了哪些片段" */
  generatedBeatIds: ID[] | null
  /** 上游相对生成时新增的片段 */
  addedBeats: ID[]
  /** 上游相对生成时被删掉的片段 */
  removedBeats: ID[]
  /**
   * 过期的具体原因：哪几拍 / 哪几个主体的内容跟生成时不一样了。
   *
   * 只说「上游改过」等于让用户自己翻整集去找 —— 这里把 id 带出来，
   * 界面直接点名（老记录没有逐项指纹时 unknown=true，改用保守说法）。
   */
  staleWhy: SourceDiff | null

  /* ---------------- 出片台账 / 增删 ---------------- */
  /** 出片判定用的渲染指纹（提示词 + 帧长 + 连续性 + 素材） */
  renderHash: string
  /** 这一段现在还算不算数：未出片 / 已出片 / 位置变了 / 待重跑 / 已失效 */
  result: ResultStatus
  /** 出片记录（null = 没出过片） */
  lock: SegmentLock | null
  /** 尾接缝沿用出片时的快照，不随邻居变化 */
  seamFrozen: boolean
  /** 实际喂给打包的入向连续性（冻结时来自台账） */
  continuityFromPrev: boolean
  /** 实际喂给打包的出向连续性（冻结时来自台账） */
  continuityToNext: boolean
}

export const useAssemblyStore = defineStore('assembly', () => {
  const assemblies = ref<Assembly[]>([])
  const currentId = ref<ID | null>(null)
  const loading = ref(false)

  /**
   * 字段：一段一包，每包里每个字段存中英两份。
   *
   * ★ 为什么必须两份：本地化是"把中文翻成英文"，不是"把中文改成英文"。
   *   以前只有一份，⑤ 一跑中文原文就被顶掉了，④ 再也回不到中文稿，
   *   而且改了中文也没法告诉英文"你已经过期了"。现在靠 zh / en 各自的
   *   修改时间判断谁落后，落后的一侧标红。
   */
  const fieldPairs = ref<FieldPairMap>({})
  /** 段字段的生成记录：判断上游改过之后哪些段需要重新生成 */
  const segmentMeta = ref<Record<ID, SegmentMeta>>({})

  /** 中文侧投影：只看中文的老逻辑（手改锁定、导出兜底）继续用它 */
  const fieldOverrides = computed(() => {
    const out: Record<string, Record<string, string>> = {}
    for (const [gid, bag] of Object.entries(fieldPairs.value)) {
      const one: Record<string, string> = {}
      for (const [k, p] of Object.entries(bag)) if (p.zh?.v) one[k] = p.zh.v
      if (Object.keys(one).length) out[gid] = one
    }
    return out
  })

  const summaries = computed(() => {
    const out: Record<string, string> = {}
    for (const [gid, bag] of Object.entries(fieldPairs.value)) {
      const v = bag.summary?.zh?.v
      if (v) out[gid] = v
    }
    return out
  })

  const current = computed(() => assemblies.value.find((a) => a.id === currentId.value) ?? null)

  async function load(projectId: ID) {
    loading.value = true
    try {
      const keep = currentId.value
      assemblies.value = await db.assemblies.where('projectId').equals(projectId).toArray()
      // 重新加载（切换项目、别处改动后同步）不该把「正在看哪个方案」重置掉：
      // 方案还在就留在原处，只有它真的没了才退回第一个。
      currentId.value =
        keep && assemblies.value.some((a) => a.id === keep)
          ? keep
          : (assemblies.value[0]?.id ?? null)

      const stored = await kvGet<FieldPairMap | null>(`pairs:${projectId}`, null)
      if (stored) {
        fieldPairs.value = stored
      } else {
        const legacyOv =
          (await kvGet<Record<string, Record<string, string>> | null>(`overrides:${projectId}`, null)) ?? {}
        const legacySm =
          (await kvGet<Record<string, string> | null>(`summaries:${projectId}`, null)) ?? {}
        fieldPairs.value = migrateLegacyPairs(legacyOv, legacySm)
        if (Object.keys(fieldPairs.value).length) await kvSet(`pairs:${projectId}`, fieldPairs.value)
      }

      segmentMeta.value =
        (await kvGet<Record<ID, SegmentMeta> | null>(`segmeta:${projectId}`, null)) ?? {}
    } finally {
      loading.value = false
    }
  }

  function reset() {
    assemblies.value = []
    currentId.value = null
    fieldPairs.value = {}
    segmentMeta.value = {}
  }

  async function persistOverrides(projectId: ID) {
    await kvSet(`pairs:${projectId}`, fieldPairs.value)
    await kvSet(`segmeta:${projectId}`, segmentMeta.value)
  }

  /* --------------------------- 双语读写 --------------------------- */

  /** 取某个段某种语言的字段包（只含有值的那几个） */
  function bagOf(groupId: ID, lang: Lang): Record<string, string> {
    const bag = fieldPairs.value[groupId] ?? {}
    const out: Record<string, string> = {}
    for (const [key, p] of Object.entries(bag)) {
      const side = lang === 'zh' ? p.zh : p.en
      if (side?.v) out[key] = side.v
    }
    return out
  }

  function writeSide(_projectId: ID, groupId: ID, key: string, value: string, lang: Lang) {
    const bag = fieldPairs.value[groupId] ?? {}
    const pair = withSide(bag[key], lang, value, now())
    fieldPairs.value = { ...fieldPairs.value, [groupId]: { ...bag, [key]: pair } }
  }

  /* --------------------------- 级联 --------------------------- */

  /**
   * 记下这一段的模型字段是「基于哪份内容」生成的。
   * 之后每次渲染都会重算指纹，不一致就说明上游改过、这段得重新生成。
   *
   * `frames` 是生成时这一段的帧数（含副帧）。它**不进指纹**：改副帧不是改内容，
   * 不该把字段判成过期；但字段正文里写着「X 帧 = Y 秒」，帧数一变那段文字就旧了，
   * 所以单存一份，界面拿它提示「秒数需复核」。
   */
  async function markGenerated(
    projectId: ID,
    groupId: ID,
    beats: Beat[],
    entities: Iterable<Entity>,
    frames?: number
  ) {
    const list = [...entities]
    // 逐项指纹一起存：过期时才能指出「哪一拍 / 哪个主体」变了，而不是只报个总数
    const prints = segmentSourceParts(beats, list)
    segmentMeta.value = {
      ...segmentMeta.value,
      [groupId]: {
        llmHash: prints.hash,
        // 写清是按哪一版口径算的：以后升级口径时，界面和排障都能对上号
        hashVersion: FINGERPRINT_VERSION,
        beatIds: beats.map((b) => b.id),
        beatHashes: prints.beats,
        entityHashes: prints.entities,
        // 帧数口径一起记下：之后补帧就能一眼看出「这段文字是按多长生成的」
        ...(frames != null ? { frames } : {}),
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
   *
   * ★ 出过片的方案走「插空」路线：新片段自己开一段，不并进相邻段 ——
   *   并进去会让那一段的成片失效，而插空不会（节点的缓存按内容寻址，
   *   段号往后挪也照样命中）。没出过片的方案照旧合并，省一次渲染。
   */
  async function reconcile(
    assemblyId: ID,
    beats: Beat[],
    settings: ProjectSettings = DEFAULT_SETTINGS
  ): Promise<{ ok: boolean; adopted: number; dropped: number; spawned: number }> {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return { ok: false, adopted: 0, dropped: 0, spawned: 0 }
    const res = reconcileWithGaps(asm.groups, beats, { settings, parked: asm.parked })

    // 待编排列表里可能残留早就删掉的片段
    const liveIds = new Set(beats.map((b) => b.id))
    const parked = (asm.parked ?? []).filter((id) => liveIds.has(id))
    if (res.changed || parked.length !== (asm.parked ?? []).length) {
      await setGroups(assemblyId, res.groups, { parked })
    }

    // 段被并掉之后，它的生成记录留着也没用
    const liveGroups = new Set(res.groups.map((g) => g.id))
    let dirty = false
    const nextMeta: Record<ID, SegmentMeta> = {}
    for (const [id, meta] of Object.entries(segmentMeta.value)) {
      if (liveGroups.has(id)) nextMeta[id] = meta
      else dirty = true
    }
    if (dirty) segmentMeta.value = nextMeta

    return { ok: true, adopted: res.adopted, dropped: res.dropped, spawned: res.spawned }
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
    // 重新组合把所有片段重新分配了一遍：原来"待编排"的内容已经被吸进新段了
    const next = { ...asm, groups: report.groups, parked: [], updatedAt: now() }
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

  async function setGroups(
    assemblyId: ID,
    groups: Group[],
    patch: { parked?: ID[] } = {}
  ) {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const next = {
      ...asm,
      groups,
      ...(patch.parked !== undefined ? { parked: patch.parked } : {}),
      updatedAt: now()
    }
    await saveOne(db.assemblies, next)
    assemblies.value = assemblies.value.map((a) => (a.id === assemblyId ? next : a))
  }

  /* ------------------------- 手工增删段 ------------------------- */

  /*
   * 增删的三条铁律（对应 domain/insertion.ts 的判定）：
   *
   *   1. **能插空就插空**：新建一段，不碰已有段的镜头序列和接缝快照 ——
   *      节点的缓存按内容寻址，段号往后挪不会让旧片失效。
   *   2. **动了就作废**：并镜头 / 切开 / 合并，只要那一段出过片，就写 `voided`
   *      并保留原 `lock`，界面上明确显示「已失效 · 需重跑」。
   *   3. **删段不删内容**：镜头退到 `parked`（待编排），既不会被自动归位又塞回去，
   *      也不会凭空消失。
   */

  /** 所有已经归位的片段 id */
  function assignedIds(groups: Group[]): Set<ID> {
    return new Set(groups.flatMap((g) => g.beatIds))
  }

  /** 从各段与待编排里摘掉这些片段（插入前先清场，避免一镜两段） */
  function detach(groups: Group[], parked: ID[], beatIds: ID[]): { groups: Group[]; parked: ID[] } {
    const drop = new Set(beatIds)
    return {
      groups: groups
        .map((g) =>
          g.beatIds.some((id) => drop.has(id))
            ? { ...g, beatIds: g.beatIds.filter((id) => !drop.has(id)) }
            : g
        )
        .filter((g) => g.beatIds.length > 0),
      parked: parked.filter((id) => !drop.has(id))
    }
  }

  /**
   * 插空新建一段。
   * `atIndex` 是插在**第几段之前**（0 = 最前，groups.length = 最后）。
   */
  async function insertGroupAt(
    assemblyId: ID,
    atIndex: number,
    beatIds: ID[]
  ): Promise<Group | null> {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return null
    const clean = [...new Set(beatIds)].filter(Boolean)
    if (!clean.length) return null
    const cleared = detach(asm.groups, asm.parked ?? [], clean)
    const g: Group = { id: uid('grp'), beatIds: clean, inserted: true }
    const groups = [...cleared.groups]
    groups.splice(Math.max(0, Math.min(atIndex, groups.length)), 0, g)
    await setGroups(assemblyId, groups, { parked: cleared.parked })
    return g
  }

  /**
   * 把镜头并进某一段。
   * 这一段出过片的话，就地标失效（成片不会自动重出，但没人会再拿它当新片）。
   */
  async function absorbBeats(
    assemblyId: ID,
    groupId: ID,
    beatIds: ID[],
    side: 'head' | 'tail' = 'tail'
  ): Promise<boolean> {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return false
    const target = asm.groups.find((g) => g.id === groupId)
    if (!target) return false
    const clean = [...new Set(beatIds)].filter(Boolean)
    if (!clean.length) return false
    const cleared = detach(asm.groups, asm.parked ?? [], clean)
    const groups = cleared.groups.map((g) => {
      if (g.id !== groupId) return g
      const merged =
        side === 'head' ? [...clean, ...g.beatIds] : [...g.beatIds, ...clean]
      return {
        ...g,
        beatIds: merged,
        // 出过片 ⇒ 内容动了，成片作废
        voided: g.lock
          ? { at: now(), reason: `并入了 ${clean.length} 个镜头，原成片作废` }
          : g.voided
      }
    })
    await setGroups(assemblyId, groups, { parked: cleared.parked })
    return true
  }

  /** 从某一段里把部分镜头抽出来单独成一段（原段 id 不变，内容变少 ⇒ 会失效） */
  async function extractBeatsToGroup(
    assemblyId: ID,
    groupId: ID,
    beatIds: ID[],
    atIndex?: number
  ): Promise<Group | null> {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return null
    const idx = asm.groups.findIndex((g) => g.id === groupId)
    if (idx < 0) return null
    const source = asm.groups[idx]
    const take = new Set(beatIds)
    const left = source.beatIds.filter((id) => !take.has(id))
    const moved = source.beatIds.filter((id) => take.has(id))
    if (!moved.length) return null
    const kept: Group = {
      ...source,
      beatIds: left,
      voided: source.lock
        ? { at: now(), reason: '抽走了镜头，原成片作废' }
        : source.voided
    }
    const g: Group = { id: uid('grp'), beatIds: moved, inserted: true }
    const groups = [...asm.groups]
    groups.splice(idx, 1, ...(left.length ? [kept] : []), g)
    void atIndex
    await setGroups(assemblyId, groups)
    return g
  }

  /** 删除一段：镜头退到待编排，内容不删 */
  async function removeGroupToParked(assemblyId: ID, groupId: ID): Promise<ID[]> {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return []
    const g = asm.groups.find((x) => x.id === groupId)
    if (!g) return []
    const groups = asm.groups.filter((x) => x.id !== groupId)
    const parked = [...new Set([...(asm.parked ?? []), ...g.beatIds])]
    await setGroups(assemblyId, groups, { parked })
    clearMeta(groupId)
    return g.beatIds
  }

  /** 待编排区：把镜头拿出来 / 放回去 */
  async function parkBeats(assemblyId: ID, beatIds: ID[]): Promise<void> {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const cleared = detach(asm.groups, asm.parked ?? [], beatIds)
    const parked = [...new Set([...cleared.parked, ...beatIds])]
    await setGroups(assemblyId, cleared.groups, { parked })
  }

  async function unparkBeats(assemblyId: ID, beatIds: ID[]): Promise<void> {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const drop = new Set(beatIds)
    await setGroups(assemblyId, asm.groups, {
      parked: (asm.parked ?? []).filter((id) => !drop.has(id))
    })
  }

  /* ------------------------- 失效 / 冻结 ------------------------- */

  /** 人工标失效（不动内容，只让"这段的成片不算数"这件事显式存在） */
  async function voidGroup(assemblyId: ID, groupId: ID, reason: string): Promise<void> {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const groups = asm.groups.map((g) =>
      g.id === groupId ? { ...g, voided: { at: now(), reason } } : g
    )
    await setGroups(assemblyId, groups)
  }

  /** 解除失效（重新跑过之后，或确认旧片还能用） */
  async function clearVoid(assemblyId: ID, groupId: ID): Promise<void> {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const groups = asm.groups.map((g) => {
      if (g.id !== groupId) return g
      const next = { ...g }
      delete next.voided
      return next
    })
    await setGroups(assemblyId, groups)
  }

  /**
   * 解冻接缝：之后按当前邻居实时重算。
   * 插了新段又希望它真的接上时用 —— 代价是本段要重跑。
   */
  async function releaseSeam(assemblyId: ID, groupId: ID): Promise<void> {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const groups = asm.groups.map((g) => (g.id === groupId ? { ...g, seamLive: true } : g))
    await setGroups(assemblyId, groups)
  }

  function slotOf(asm: Assembly, groupId: ID): number {
    return asm.groups.findIndex((g) => g.id === groupId)
  }

  /**
   * 记「这一段出片了」。
   * `by` 说明是谁确认的：字段生成 / 产物探测 / 人工。
   */
  async function sealGroup(assemblyId: ID, view: SegmentView, by: SegmentLock['by']): Promise<void> {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const slot = slotOf(asm, view.group.id)
    if (slot < 0) return
    const frozen: FrozenSeam = view.seamFrozen && view.lock
      ? view.lock.frozen
      : {
          tail: view.nextSeam?.blackFallback
            ? 'black'
            : view.nextSeam?.needsTailCut
              ? 'cut'
              : 'none',
          tailCutTargetId: view.nextSeam?.needsTailCut
            ? (view.nextSeam.tailCutTargetId ?? null)
            : null,
          preshoot: view.beats.some((b) => b.kind === 'preshoot'),
          continuityToNext: view.nextSeam?.continuityToNext ?? false,
          continuityFromPrev: view.seam?.continuityFromPrev ?? false
        }
    const groups = asm.groups.map((g) => {
      if (g.id !== view.group.id) return g
      const next: Group = {
        ...g,
        lock: {
          hash: view.renderHash,
          slot,
          frames: view.frames,
          beatIds: view.beats.map((b) => b.id),
          at: now(),
          by,
          frozen
        }
      }
      delete next.voided
      return next
    })
    await setGroups(assemblyId, groups)
  }

  /**
   * 产物探测回来之后对账：有片段且有片（且节点没说是旧渲染）的段，记成已出片。
   *
   * 以节点为准：它按内容指纹存缓存，说"没过期"就是这段内容确实有片。
   * 这样"插空导致段号后移"不会被误判成失效 —— 位置归槽位表管，内容没变就还是那张片。
   */
  async function sealProduced(
    assemblyId: ID,
    views: SegmentView[],
    rows: Array<{ index: number; first: { hasClip: boolean; stale: boolean }; second: { hasClip: boolean; stale: boolean } }>
  ): Promise<ID[]> {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm || views.length !== rows.length) return []
    const sealed: ID[] = []
    let groups = asm.groups
    let dirty = false
    for (const row of rows) {
      const v = views[row.index]
      if (!v) continue
      const hasClip = row.first.hasClip || row.second.hasClip
      const isStale = row.first.stale || row.second.stale
      if (!hasClip || isStale) continue
      /*
       * 已出片、内容也一致：不再重写台账。
       * `moved` 故意留着 —— 它说的是"成片是插空之前那一版、段号变了，但内容没变"，
       * 这是给人看的信息，不是待办；重跑过这一段（re-seal）才会把槽位刷新。
       */
      if (v.result.state === 'ready' || v.result.state === 'moved') continue
      const slot = slotOf(asm, v.group.id)
      if (slot < 0) continue
      const prev = groups[slot]
      if (!prev || prev.id !== v.group.id) continue
      const frozen: FrozenSeam = v.seamFrozen && v.lock
        ? v.lock.frozen
        : {
            tail: v.nextSeam?.blackFallback ? 'black' : v.nextSeam?.needsTailCut ? 'cut' : 'none',
            tailCutTargetId: v.nextSeam?.needsTailCut ? (v.nextSeam.tailCutTargetId ?? null) : null,
            continuityToNext: v.nextSeam?.continuityToNext ?? false,
            continuityFromPrev: v.seam?.continuityFromPrev ?? false
          }
      groups = groups.map((g) => {
        if (g.id !== v.group.id) return g
        const next: Group = {
          ...g,
          lock: {
            hash: v.renderHash,
            slot,
            frames: v.frames,
            beatIds: v.beats.map((b) => b.id),
            at: now(),
            by: 'product',
            frozen
          }
        }
        delete next.voided
        return next
      })
      sealed.push(v.group.id)
      dirty = true
    }
    if (dirty) await setGroups(assemblyId, groups)
    return sealed
  }

  /* ------------------------- 拆分 / 合并 ------------------------- */

  async function splitGroupAt(assemblyId: ID, groupId: ID, atIndex: number, beats: Beat[]) {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const idx = asm.groups.findIndex((g) => g.id === groupId)
    if (idx < 0) return
    const g = asm.groups[idx]
    if (atIndex <= 0 || atIndex >= g.beatIds.length) return
    const left: Group = {
      ...g,
      beatIds: g.beatIds.slice(0, atIndex),
      // 出过片 ⇒ 切开后原成片作废（后半段是全新的）
      voided: g.lock ? { at: now(), reason: '在此切开，原成片作废' } : g.voided
    }
    const right: Group = { id: uid('grp'), beatIds: g.beatIds.slice(atIndex), inserted: true }
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
    const touched = indexes.map((i) => asm.groups[i])
    const produced = touched.filter((g) => !!g.lock)
    const merged: Group = {
      id: uid('grp'),
      beatIds: indexes.flatMap((i) => asm.groups[i].beatIds),
      inserted: true,
      // 合并出来的是全新的一段：原来那些成片都不作数了，明确写出来
      ...(produced.length
        ? { voided: { at: now(), reason: `合并了 ${produced.length} 段已出片的内容，新段需要重跑` } }
        : {})
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

  /** 把一个 Beat 移出分组：退到待编排，且这一段作废（镜头少了一个） */
  async function removeBeatFromGroup(assemblyId: ID, groupId: ID, beatId: ID) {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const target = asm.groups.find((g) => g.id === groupId)
    if (!target) return
    const groups = asm.groups
      .map((g) =>
        g.id === groupId
          ? {
              ...g,
              beatIds: g.beatIds.filter((b) => b !== beatId),
              voided: g.lock ? { at: now(), reason: '移出了一个镜头，原成片作废' } : g.voided
            }
          : g
      )
      .filter((g) => g.beatIds.length > 0)
    const parked = [...new Set([...(asm.parked ?? []), beatId])]
    await setGroups(assemblyId, groups, { parked })
  }

  /* ---------------------- 帧长度补正 ---------------------- */

  /**
   * 切换「引用上一段」。家族一变，已存的副帧就失效了，一并清掉让它重新分摊。
   */
  async function setGroupRefPrev(assemblyId: ID, groupId: ID, refPrev: boolean) {
    const asm = assemblies.value.find((a) => a.id === assemblyId)
    if (!asm) return
    const groups = asm.groups.map((g) =>
      g.id === groupId ? { ...g, refPrev, refPrevManual: true, pad: undefined } : g
    )
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
    schema: FieldSchema[],
    assets: Asset[] = []
  ): SegmentView[] {
    const byId = new Map(beats.map((b) => [b.id, b]))
    // ★ 必须带上语言：漏传会走 DEFAULT_LANG，实体名按英文词条取。
    // 中文工作稿里只要有一个实体翻过 nameEn，派生字段就会中英混排。
    const seederZh = makeSeeders(entityById, 'zh')
    const seederEn = makeSeeders(entityById, 'en')

    /** 配音测出来的真实帧长；没有配音返回 0（调用方退回按字数估） */
    const voicedFramesOf = (beat: Beat): number => {
      const fit = speechFitOf(beat, assets, settings)
      return fit ? fit.frames : 0
    }

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
        : analyzeSeam(rawGroups[i - 1].narrative, x.narrative, {
          settings,
          entityById,
          override: rawGroups[i - 1].group.seamToNext
        })
    )

    return rawGroups.map((x, i) => {
      const seam = seams[i]
      const nextSeam = i + 1 < seams.length ? seams[i + 1] : null

      /* ---- 出片台账：冻结的接缝快照 ---- */
      const lock = x.group.lock ?? null
      const frozen = lock && !x.group.seamLive ? lock.frozen : null
      const continuityFromPrev = frozen
        ? frozen.continuityFromPrev
        : (seam?.continuityFromPrev ?? false)
      const continuityToNext = frozen ? frozen.continuityToNext : (nextSeam?.continuityToNext ?? false)

      // 材料化：本段是否需要黑屏/尾帧切镜取决于"与下一段"的缝合结论；
      // 出过片的段照出片时的快照复现，插了新段也不改动它。
      const material = materializeSegment(x.narrative, nextSeam, {
        settings,
        entityById,
        freeze: frozen
          ? {
              tail: frozen.tail,
              tailCutTargetId: frozen.tailCutTargetId,
              preshoot: frozen.preshoot
            }
          : undefined
      })

      // ★ 中英各取一份：④ 只认中文包，⑤ 只写英文包，谁也不覆盖谁
      const bagZh = bagOf(x.group.id, 'zh')
      const bagEn = bagOf(x.group.id, 'en')

      // ---- 帧长度补正：17k / 5+17k，差额作为独立副帧按占比分摊（可为负=压缩） ----
      // 家族由接缝决定：转场段不引用上段，落在 5+17k；镜切 / 顺接引用，落在 17k
      const refPrev =
        (settings.seamPolicy ?? 'guide') === 'legacy'
          ? resolveRefPrev(x.group, i)
          : x.group.refPrevManual
            ? (x.group.refPrev ?? false)
            : i === 0
              ? false
              : refPrevOfStrength(seam?.strength ?? 0)
      /*
       * 压缩下限：有配音的片段以配音真实长度为准。
       * 只按台词字数算是不够的 —— 慢语速会把片段压到比音频还短，
       * 组合器再切一下，台词尾巴就没了，而界面上看不出任何异常。
       */
      const floorFrames = x.narrative
        .filter((b) => b.kind === 'dialogue')
        .reduce(
          (s, b) => s + (voicedFramesOf(b) || dialogueFrames(b.dialogue, settings.fps)),
          0
        )
      const fit = fitSegmentFrames(material.frames, refPrev, settings.maxSegmentFrames, floorFrames)
      const storedPad = x.group.pad
      const padAuto = !storedPad
      // 片段级压缩容量也要认配音：否则段级守住了、片段级照样被压扁
      const floors: Record<ID, number> = {}
      for (const b of material.beats) {
        const f = voicedFramesOf(b)
        if (f > 0) floors[b.id] = f
      }
      // 预备镜头 / 尾帧切镜 / 黑屏 也参与分摊
      const pad = buildPad({
        all: material.beats,
        overrides: storedPad,
        padTotal: fit.padTotal,
        settings,
        floors
      })
      const frames = sumPaddedFrames(material.beats, settings, pad)

      /*
       * 派生字段要按语言各算一遍：主体名、留人分析里的称呼都取词条，
       * 中英两份不可能是同一串字。两份都从同一段内容算出，所以天然同步。
       */
      const derivedZh = deriveFields(schema, material.beats, bagZh, {
        settings: { ...settings, workLanguage: 'zh' },
        entityById,
        seeder: seederZh,
        pad
      })
      const derivedEn = deriveFields(schema, material.beats, bagEn, {
        settings: { ...settings, workLanguage: 'en' },
        entityById,
        seeder: seederEn,
        pad
      })

      // 校验看的也是「要交付的那份」：en 模式校验英文终稿，zh 模式校验中文工作稿
      const delivery = deliveryFields(derivedZh, derivedEn, langOf(settings))
      const issues = validateSegment(
        {
          beats: material.beats,
          narrativeBeats: x.narrative,
          fields: delivery,
          seam,
          nextSeam,
          refPrev,
          pad
        },
        { settings, entityById, schema }
      )

      // ---- 级联：模型字段是「基于哪份内容」生成的 ----
      const allEntities = [...entityById.values()]
      const hash = segmentSourceHash(material.beats, allEntities)
      const meta = segmentMeta.value[x.group.id]
      const hasModelFields = schema.some(
        (f) => f.source === 'llm' && ((derivedZh[f.key] ?? '').trim() || (derivedEn[f.key] ?? '').trim())
      )
      /*
       * 过期 = 这段的模型字段不是按「现在这份内容」写的。
       *
       * 历史口径也要放行：指纹口径升过级（字段增减）时，同一份内容会算出不同
       * 的串，不放行就会把所有老记录一次性判死。内容没变就不该报警 ——
       * 口径不一致是引擎的事，不是用户改了什么。
       */
      const hitLegacy =
        !!meta &&
        meta.llmHash !== hash &&
        legacySegmentSourceHashes(material.beats, allEntities).includes(meta.llmHash)
      const stale =
        hasModelFields && (!meta || (meta.llmHash !== hash && !hitLegacy))
      /*
       * 帧数改过：补帧 / 压缩之后这一段变长变短了。
       *
       * 字段正文里写着「X 帧 = Y 秒」，变了就该说一声"秒数需复核"；
       * 但它**不算过期** —— 内容一个字没改，重生成多半得到同样的字，
       * 真正要人做的是核对一下文字里提到的时长。
       */
      const generatedFrames = meta?.frames ?? null
      const framesChanged =
        hasModelFields && generatedFrames != null && generatedFrames !== frames
      // 过期的"哪里变了"：逐项比对生成时的指纹（老记录只能给 unknown）
      const staleWhy = stale ? staleDiffOf(meta, material.beats, allEntities) : null

      const currentIds = new Set(material.beats.map((b) => b.id))
      const prevIds = new Set(meta?.beatIds ?? [])
      const addedBeats = meta ? material.beats.filter((b) => !prevIds.has(b.id)).map((b) => b.id) : []
      const removedBeats = meta ? meta.beatIds.filter((id) => !currentIds.has(id)) : []

      /* ---- 出片台账：这一段现在还算不算数 ---- */
      // 出片喂的是终稿：英文有内容就用英文，没有才退回中文工作稿
      const outFields = schema.some((f) => f.source === 'llm' && (derivedEn[f.key] ?? '').trim())
        ? derivedEn
        : derivedZh
      // 每个字段两侧谁落后：④ 用它把"英文待重译"标红
      const pairBag = fieldPairs.value[x.group.id] ?? {}
      const fieldSync: Record<string, FieldSync> = {}
      for (const f of schema) {
        const pair = pairBag[f.key]
        fieldSync[f.key] = pair
          ? // 带上段指纹：上游片段/实体改过时，两侧一起变成 src-newer
            syncOf(pair, hash)
          : (derivedZh[f.key] ?? '').trim() || (derivedEn[f.key] ?? '').trim()
            ? 'both'
            : 'empty'
      }

      const renderHash = renderHashOf({
        beats: material.beats,
        pad,
        frames,
        refPrev,
        continuityFromPrev,
        continuityToNext,
        text: composeSegmentText(schema, outFields),
        assets,
        settings
      })
      const result = resultStatus({
        lock,
        voided: x.group.voided ?? null,
        hash: renderHash,
        slot: i,
        beatIds: material.beats.map((b) => b.id)
      })

      return {
        group: x.group,
        narrativeBeats: x.narrative,
        beats: material.beats,
        frames,
        over: fit.overLimit || frames > settings.maxSegmentFrames,
        seam,
        nextSeam,
        fields: derivedZh,
        fieldsEn: derivedEn,
        delivery,
        fieldSync,
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
        staleWhy,
        generatedFrames,
        framesChanged,
        generatedBeatIds: meta?.beatIds ?? null,
        addedBeats,
        removedBeats,
        renderHash,
        result,
        lock,
        seamFrozen: !!frozen,
        continuityFromPrev,
        continuityToNext
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

  /**
   * 写入某一段、某一份语言的内容。
   *
   * lang 默认 'zh'：④ 的手改和重生成写的都是中文工作稿；
   * ⑤ 本地化必须显式传 'en'，否则会再次把中文覆盖掉 —— 这正是之前的老毛病。
   */
  async function setField(projectId: ID, groupId: ID, key: string, value: string, lang: Lang = 'zh') {
    writeSide(projectId, groupId, key, value, lang)
    await persistOverrides(projectId)
  }

  async function setFields(
    projectId: ID,
    groupId: ID,
    values: Record<string, string>,
    lang: Lang = 'zh'
  ) {
    for (const [k, v] of Object.entries(values)) writeSide(projectId, groupId, k, v, lang)
    await persistOverrides(projectId)
  }

  async function setSummary(projectId: ID, groupId: ID, value: string, lang: Lang = 'zh') {
    writeSide(projectId, groupId, 'summary', value, lang)
    await persistOverrides(projectId)
  }

  /** 清除某些字段的人工锁定，恢复自动派生（只清指定语言那一侧） */
  async function clearFields(
    projectId: ID,
    groupId: ID,
    keys: string[],
    lang: Lang = 'zh'
  ) {
    const bag = { ...(fieldPairs.value[groupId] ?? {}) }
    for (const k of keys) {
      const pair = bag[k]
      if (!pair) continue
      const next: FieldPair = { ...pair }
      delete next[lang]
      if (!next.zh && !next.en) delete bag[k]
      else bag[k] = next
    }
    fieldPairs.value = { ...fieldPairs.value, [groupId]: bag }
    await persistOverrides(projectId)
  }

  /**
   * 记下「这两份此刻已经对齐」。
   *
   * srcHash 用这一段当前的引用指纹（segmentSourceHash）。以后引用再变，
   * 状态会立刻变成 src-newer —— 不必等下一次生成。
   *
   * keys 不传就是整段所有字段：翻译和同步都是按段一次性处理完的。
   */
  async function markSynced(projectId: ID, groupId: ID, srcHash: string, keys?: string[]) {
    const bag = { ...(fieldPairs.value[groupId] ?? {}) }
    const targets = keys ?? Object.keys(bag)
    const at = now()
    let touched = false
    for (const k of targets) {
      const pair = bag[k]
      if (!pair) continue
      bag[k] = { ...pair, synced: baselineOf(pair, srcHash, at) }
      touched = true
    }
    if (!touched) return
    fieldPairs.value = { ...fieldPairs.value, [groupId]: bag }
    await persistOverrides(projectId)
  }

  /** 单独清除 summary（指定语言那一侧） */
  async function clearSummary(projectId: ID, groupId: ID, lang: Lang = 'zh') {
    await clearFields(projectId, groupId, ['summary'], lang)
  }

  function getSummary(groupId: ID, lang: Lang = 'zh'): string {
    return bagOf(groupId, lang).summary ?? ''
  }

  /** 某个字段是否被人工改动锁定（锁定后引擎不再自动派生） */
  function isFieldLocked(groupId: ID, key: string, lang: Lang = 'zh'): boolean {
    return !!fieldPairs.value[groupId]?.[key]?.[lang]?.v
  }

  function lockedKeys(groupId: ID, lang: Lang = 'zh'): string[] {
    const bag = fieldPairs.value[groupId] ?? {}
    return Object.entries(bag)
      .filter(([, p]) => !!p[lang]?.v)
      .map(([k]) => k)
  }

  function exportAssembly(
    views: SegmentView[],
    schema: FieldSchema[],
    settings: ProjectSettings = DEFAULT_SETTINGS
  ): string {
    const segments = views.map((v, i) => {
      // 导出跟交付页、门禁同一口径：en 模式导出英文终稿，zh 模式导出中文工作稿
      const fields = { ...deliveryFields(v.fields, v.fieldsEn, langOf(settings)) }
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
        seamKind: v.nextSeam?.kind ?? null,
        seamStrength: v.nextSeam?.strength ?? null,
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
    await kvDelete(`pairs:${projectId}`)
    await kvDelete(`overrides:${projectId}`)
    await kvDelete(`summaries:${projectId}`)
    fieldPairs.value = {}
  }

  return {
    assemblies,
    currentId,
    current,
    loading,
    fieldPairs,
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
    insertGroupAt,
    absorbBeats,
    extractBeatsToGroup,
    removeGroupToParked,
    parkBeats,
    unparkBeats,
    voidGroup,
    clearVoid,
    releaseSeam,
    sealGroup,
    sealProduced,
    setGroupRefPrev,
    setGroupPad,
    clearGroupPad,
    clearAllPads,
    buildSegmentViews,
    globalIssues,
    markSynced,
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
