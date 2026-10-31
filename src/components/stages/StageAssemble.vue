<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NInput,
  NModal,
  NPopconfirm,
  NSelect,
  NSlider,
  NSwitch,
  NTag,
  useMessage
} from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { useAssemblyStore, type SegmentView } from '@/stores/assembly'
import { useProviderStore } from '@/stores/provider'
import SeamPanel from '@/components/SeamPanel.vue'
import SectionNav, { type SectionNavItem } from '@/components/SectionNav.vue'
import StageAdvice from '@/components/StageAdvice.vue'
import SegmentDetailModal from '@/components/SegmentDetailModal.vue'
import SegmentFields from '@/components/stages/SegmentFields.vue'
import { useSegmentFields, type FieldFilter } from '@/composables/useSegmentFields'
import { useWorkLanguage } from '@/composables/useWorkLanguage'
import { useAssembleFocus } from '@/composables/useAssembleFocus'
import { BEAT_KIND_COLOR, BEAT_KIND_LABEL, collectScenes, resolveSubjectId } from '@/domain/beats'
import { keyframesOf, placementOf } from '@/domain/references'
import type { SeamPolicy } from '@/domain/types'
import { beatFrames, secondsFromFrames } from '@/domain/timing'
import { alignedOptions, formatPad, maxAlignedFrames } from '@/domain/frames'
import { absorbImpact, deleteImpact, mergeImpact, splitImpact } from '@/domain/insertion'
import type { AssemblyMode, Beat, BeatKind, ID } from '@/domain/types'
import { AUTO_KINDS } from '@/domain/types'
import InfoTip from '@/components/common/InfoTip.vue'

const project = useProjectStore()
const beats = useBeatStore()
const registry = useRegistryStore()
const assembly = useAssemblyStore()
const provider = useProviderStore()
const message = useMessage()
/** 别处点「字段补全」时留下来的落点标记 */
const focus = useAssembleFocus()

const showCreate = ref(false)
const newName = ref('')
const newMode = ref<AssemblyMode>('scene_first')

const settings = computed(() => project.settings)
const list = computed(() => beats.ordered)
const current = computed(() => assembly.current)

/* --------------------------- 最长段帧 --------------------------- */

/**
 * 段总帧数必须落在 5+17k / 17k 两条网格上（H3 的帧长家族），
 * 所以「最长段」只有这几个值是有意义的：填 100 实际也只能到 90 / 85，
 * 与其让输入框接受一个会被悄悄改写的数字，不如直接列合法值。
 *
 * 141 是 H3 单段硬上限（5.875 秒），不往上开。
 */
const MAX_FRAMES_CEIL = 141

const maxFramesOptions = computed(() =>
  alignedOptions(false, MAX_FRAMES_CEIL)
    .filter((f) => f >= 22)
    .map((f) => ({
      label: `${f} 帧 · ${secondsFromFrames(f, settings.value.fps).toFixed(2)}s`,
      value: f
    }))
)

/** 该方案下两种帧长家族各自的实际上限：不引用上段 = 设定值，引用上段 = 设定值 - 5 */
const nonRefCap = computed(() => maxAlignedFrames(false, settings.value.maxSegmentFrames))
const refCap = computed(() => maxAlignedFrames(true, settings.value.maxSegmentFrames))
const capOf = (refPrev: boolean) => (refPrev ? refCap.value : nonRefCap.value)

/** 改上限不改已有分组：段是存下来的，只有「重新组合」才会按新上限重排 */
async function setMaxFrames(v: number) {
  if (!v || v === settings.value.maxSegmentFrames) return
  await project.updateSettings({ maxSegmentFrames: v })
  const over = views.value.filter((x) => x.frames > capOf(x.refPrev)).length
  if (over) {
    message.warning(`已有 ${over} 段超过新上限，点「重新组合」才会按新上限重排`)
  }
}

const views = computed(() => {
  if (!current.value) return []
  return assembly.buildSegmentViews(
    current.value,
    list.value,
    settings.value,
    registry.entityById,
    project.fieldSchema,
    registry.assets
  )
})

/**
 * 段字段的口径（缺几项 / 能不能生成 / 现在筛哪一类）统一走这一个实例。
 *
 * ★ 不能让别人各调一次 useSegmentFields：那是另一份 running / failed / 筛选状态。
 *   卡片和工具条必须看同一份，否则"工具条说 3 段缺字段、卡片说已补全"。
 */
const sf = useSegmentFields(views)

/*
 * 工作语言：英文终稿模式下这一页显示的是英文那份。
 * 以前这一页对模式只字不提，人看到的就是「补充出来的字段怎么全是英文」。
 */
const { finalMode, gapCount, gapLabelText, backToChinese } = useWorkLanguage(views)
const switchingLang = ref(false)

async function onBackToZh(writeBack: boolean) {
  if (writeBack && !provider.ready) {
    message.warning('回写中文要调模型，请先在模型设置里配好供应商')
    return
  }
  switchingLang.value = true
  try {
    const res = await backToChinese({ writeBack })
    if (res.failed.length) {
      message.warning(`已切回中文，但有 ${res.failed.length} 段没回写成功：${res.failed[0]}`)
    } else if (writeBack) {
      message.success(`已切回中文工作稿，并回写 ${res.translated} 项字段`)
    } else {
      message.info('已切回中文工作稿（已经译成英文的模型字段保持英文）')
    }
  } finally {
    switchingLang.value = false
  }
}

/*
 * 字段侧的值"提"成顶层绑定：composable 返回的是 ref，模板只解引用顶层的 ref，
 * 留在 sf 里就得写 sf.xxx.value。写操作一律走下面两个函数 —— 别在模板里赋值。
 */
const fieldLlm = sf.llmFields
const fieldDerived = sf.derivedFields
const fieldStats = sf.stats
const fieldTargets = sf.targetsToFill
const fieldCounts = sf.filterCounts
const fieldRunning = sf.running
const fieldFailed = sf.failed
const fieldFilters = sf.filters
const fieldExpandAll = sf.expandAll
const fieldFilterKey = computed(() => sf.listFilter.value)
const fieldConcurrency = sf.concurrency

function setFieldConcurrency(n: number) {
  sf.concurrency.value = n
}

function setFieldFilter(k: FieldFilter) {
  sf.listFilter.value = k
}

function toggleFieldsExpand() {
  sf.expandAll.value = !sf.expandAll.value
}

/**
 * 从工作台的「字段补全」问题条点进来：不切页，直接筛出要补的段并滚到字段工具条。
 * 只切页不滚的话，人会停在组合方案那屏，以为点了没反应。
 */
watch(
  () => focus.pending.value,
  (kind) => {
    if (!kind) return
    sf.listFilter.value = kind
    focus.pending.value = null
    void nextTick(() => {
      document.getElementById('as-fieldbar')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  },
  // 别处先写了标记、本页后挂载：immediate 才能在挂载时读到它（不是每次切页都重新挂）
  { immediate: true }
)

/* --------------------------- 视频段详情 --------------------------- */

const detailGroupId = ref<ID | null>(null)
const detailView = computed(() => views.value.find((v) => v.group.id === detailGroupId.value) ?? null)
const detailIndex = computed(() => views.value.findIndex((v) => v.group.id === detailGroupId.value))

async function onDetailPatch(id: ID, patch: Partial<Beat>) {
  await beats.updateBeat(id, patch)
}

/* --------------------------- 镜头编排（副帧 / 切分） --------------------------- */

/*
 * 镜头清单直接铺在段卡片里：这个页面要回答的问题就是"每一段由哪几个镜头拼成、
 * 各占多少帧"，藏进弹窗等于每段都要点开一次才看得见。
 * 形态是**卡片横排的泳道**：一张卡一个镜头（类型/帧数/标题/台词/主体），
 * 卡下一行 − [副帧] + 就地改，两张卡之间「在此切开」。
 * 不要改成一行一镜的表格 —— 表格能塞更多，但扫读时看不出镜头是"块"。
 */

/* --------------------------- 级联：分组归位 --------------------------- */

/** 不在任何段里的片段（含待编排）。上游新增的片段如果不归位，会从后面所有阶段里静默消失 */
const orphanIds = computed(() => {
  if (!current.value) return []
  const assigned = new Set(current.value.groups.flatMap((g) => g.beatIds))
  return list.value.filter((b) => !assigned.has(b.id)).map((b) => b.id)
})

/** 待编排：用户主动放在一边的（删掉的段 / 抽出来的镜头），不算"漏掉的内容" */
const parkedIds = computed(() => {
  const parked = new Set(current.value?.parked ?? [])
  return orphanIds.value.filter((id) => parked.has(id))
})

/** 真正还没安顿的片段 */
const looseIds = computed(() => orphanIds.value.filter((id) => !parkedIds.value.includes(id)))

/** 这个方案有没有段出过片：有的话增删一律走"插空 + 动谁废谁"，不再自动并段 */
const hasProduced = computed(() => views.value.some((v) => !!v.lock))

const aligning = ref(false)

async function align(notify = true) {
  if (!current.value) return
  const loose = looseIds.value.length
  if (!loose) return
  aligning.value = true
  try {
    const res = await assembly.reconcile(current.value.id, list.value, settings.value)
    if (notify) {
      const bits: string[] = []
      if (res.spawned) bits.push(`新开了 ${res.spawned} 段（插空，未改动已有段）`)
      if (res.adopted && !res.spawned) bits.push(`${res.adopted} 个新片段已并入相邻段`)
      if (res.dropped) bits.push(`${res.dropped} 个已删片段的引用已清掉`)
      message.success(bits.join('，') || '已重新对齐')
    }
  } finally {
    aligning.value = false
  }
}

/*
 * 自动归位只在"还没出过片"时做。
 * 一旦有段出片，新片段该插空还是该并进去、并进去要废掉哪一段 —— 这些得人来定。
 * 悄悄替人决定，代价可能是几十分钟的重新渲染。
 */
onMounted(() => {
  if (looseIds.value.length && !hasProduced.value) void align(false)
})

watch(
  () => looseIds.value.length,
  async (n) => {
    if (n && !hasProduced.value) await align(false)
  }
)

/* --------------------------- 插空 / 并入 --------------------------- */

const showInsert = ref(false)
/** 插在第几段之前（0 = 最前，views.length = 最后） */
const insertAt = ref(0)
const insertPick = ref<ID[]>([])
const insertMode = ref<'gap' | 'prev' | 'next'>('gap')
const newShotTitle = ref('')

/** 弹窗里可选的镜头：当前所有没归位的（新片段 + 待编排） */
const insertCandidates = computed(() => list.value.filter((b) => !assignedSet.value.has(b.id)))

const assignedSet = computed(() => {
  const set = new Set<ID>()
  for (const g of current.value?.groups ?? []) for (const id of g.beatIds) set.add(id)
  return set
})

function openInsert(atIndex: number, preselect?: ID[]) {
  insertAt.value = Math.max(0, Math.min(atIndex, views.value.length))
  insertPick.value = preselect?.length ? [...preselect] : insertCandidates.value.map((b) => b.id)
  insertMode.value = 'gap'
  newShotTitle.value = ''
  showInsert.value = true
}

const insertPositionLabel = computed(() => {
  if (!views.value.length) return '作为第一段'
  if (insertAt.value <= 0) return `插在 seg01 之前`
  if (insertAt.value >= views.value.length) return `插在最后一段之后`
  return `插在 seg${String(insertAt.value).padStart(2, '0')} 与 seg${String(insertAt.value + 1).padStart(2, '0')} 之间`
})

/** 并入目标：前一段 / 后一段 */
const insertNeighbor = computed(() => {
  if (insertMode.value === 'prev') return views.value[insertAt.value - 1] ?? null
  if (insertMode.value === 'next') return views.value[insertAt.value] ?? null
  return null
})

const insertImpactNote = computed(() => {
  const asm = current.value
  if (!asm) return ''
  if (insertMode.value === 'gap') {
    return '已有段一个都不动：镜头序列、帧长、接缝快照全部保留，已出的片继续有效'
  }
  const target = insertNeighbor.value
  if (!target) return '这个位置没有可并入的段，会退回插空'
  return absorbImpact(asm.groups, target.group.id).note
})

const insertWillVoid = computed(() => {
  const asm = current.value
  const target = insertNeighbor.value
  if (!asm || !target || insertMode.value === 'gap') return []
  return absorbImpact(asm.groups, target.group.id).invalidates
})

async function confirmInsert() {
  const asm = current.value
  if (!asm) return
  if (!insertPick.value.length) {
    message.warning('先勾选要插入的镜头')
    return
  }
  if (insertMode.value === 'gap' || !insertNeighbor.value) {
    await assembly.insertGroupAt(asm.id, insertAt.value, insertPick.value)
    message.success(`已插空新增 1 段（${insertPick.value.length} 个镜头），已有段不受影响`)
  } else {
    const target = insertNeighbor.value
    await assembly.absorbBeats(
      asm.id,
      target.group.id,
      insertPick.value,
      insertMode.value === 'prev' ? 'tail' : 'head'
    )
    message.success(
      target.lock ? '已并入，该段成片已标为失效（只需重跑这一段）' : '已并入，该段还没出片，不用重跑'
    )
  }
  showInsert.value = false
}

/** 在弹窗里就地新建一个镜头，省得退回上一阶段 */
async function createAndPick() {
  const pid = project.currentId
  if (!pid) return
  const title = newShotTitle.value.trim() || '新镜头'
  await beats.addBeat(pid, { title, kind: 'action' as BeatKind, entities: [], enriched: false })
  newShotTitle.value = ''
  // addBeat 之后 list 会重算，把新镜头自动勾上
  await nextTick()
  const added = insertCandidates.value.find((b) => b.title === title && !insertPick.value.includes(b.id))
  if (added) insertPick.value = [...insertPick.value, added.id]
}

function toggleInsert(id: ID) {
  insertPick.value = insertPick.value.includes(id)
    ? insertPick.value.filter((x) => x !== id)
    : [...insertPick.value, id]
}

function segNameAt(index: number): string {
  return index >= 0 && index < views.value.length ? `seg${String(index + 1).padStart(2, '0')}` : ''
}

/* --------------------------- 失效处理 --------------------------- */

const resealing = ref<ID | null>(null)

async function reseal(v: SegmentView) {
  if (!current.value) return
  resealing.value = v.group.id
  try {
    await assembly.sealGroup(current.value.id, v, 'manual')
    message.success('已记为「已出片」：之后按现在的内容比对')
  } finally {
    resealing.value = null
  }
}

async function releaseSeam(v: SegmentView) {
  if (!current.value) return
  await assembly.releaseSeam(current.value.id, v.group.id)
  message.warning('已解冻：接缝按当前邻居重算，这一段会标成待重跑')
}

async function removeSegment(v: SegmentView) {
  if (!current.value) return
  const n = await assembly.removeGroupToParked(current.value.id, v.group.id)
  message.success(`已删除这一段，${n.length} 个镜头退到「待编排」`)
}

/** 从某个片段之前归位的段号：用来决定孤立片段该插在哪儿 */
function insertIndexFor(beatId: ID): number {
  const order = list.value.map((b) => b.id)
  const at = order.indexOf(beatId)
  for (let i = at - 1; i >= 0; i--) {
    const k = current.value?.groups.findIndex((g) => g.beatIds.includes(order[i])) ?? -1
    if (k >= 0) return k + 1
  }
  return 0
}

const totals = computed(() => {
  const frames = views.value.reduce((s, v) => s + v.frames, 0)
  // guide 下没有黑屏兜底，统计口径换成接缝三态；legacy 项目仍可能出黑屏
  const black = views.value.filter((v) => v.nextSeam?.blackFallback).length
  const transition = views.value.filter((v) => v.nextSeam?.kind === 'transition').length
  const cut = views.value.filter((v) => v.nextSeam?.kind === 'cut').length
  const over = views.value.filter((v) => v.over).length
  const errors = views.value.reduce(
    (s, v) => s + v.issues.filter((i) => i.level === 'error').length,
    0
  )
  return { frames, black, transition, cut, over, errors }
})

/** 侧边目录：逐段定位，超限标红、黑屏兜底标黄 */
const segNav = computed<SectionNavItem[]>(() =>
  views.value.map((v, i) => ({
    id: `as-g-${v.group.id}`,
    label: `seg${String(i + 1).padStart(2, '0')}`,
    hint: `${v.frames}f`,
    tone: v.over ? 'err' : v.nextSeam?.kind === 'transition' ? 'warn' : 'default'
  }))
)

/**
 * 接缝策略。默认 guide：段间用上一段尾帧引导，段内不再塞预备镜头 / 尾帧切镜。
 * legacy 是逃生阀 —— 已经习惯旧节奏的项目可以切回去，行为与改造前一致。
 */
const seamPolicy = computed<SeamPolicy>(() => settings.value.seamPolicy ?? 'guide')
const seamPolicyOptions = [
  { label: '段间引导（推荐）', value: 'guide' as SeamPolicy },
  { label: '旧：预备镜头 + 尾帧切镜', value: 'legacy' as SeamPolicy }
]

const modeOptions: Array<{ label: string; value: AssemblyMode; desc: string }> = [
  { label: '按场景优先', value: 'scene_first', desc: '同场景尽量合并，场景切换处强制拆' },
  { label: '填满优先', value: 'fill_max', desc: '贪心累加到接近上限再拆，段数最少' },
  { label: '按说话人拆', value: 'speaker_split', desc: '说话人变化就拆，音色更集中' },
  { label: '全手工', value: 'manual', desc: '先合成一段，由你手工切' }
]

watch(
  () => assembly.currentId,
  () => {
    /* views 会自动重算 */
  }
)

async function create() {
  if (!newName.value.trim()) {
    message.warning('给方案起个名字')
    return
  }
  const report = await assembly.createAssembly(
    project.currentId!,
    newName.value.trim(),
    newMode.value,
    list.value,
    settings.value,
    registry.entityById
  )
  showCreate.value = false
  newName.value = ''
  message.success(`已生成 ${report.groups.length} 段`)
  if (report.skipped.length) {
    const names = report.skipped.slice(0, 4).map((b) => b.title).join('、')
    message.warning(
      `${report.skipped.length} 个片段因缺场景/说话人绑定被跳过，不会进入任何段${
        report.skipped.length > 4 ? '…' : ''
      }：${names}。回「② 细节填充」补好绑定后重新组合。`
    )
  }
  if (report.blackFallbacks) {
    message.warning(`有 ${report.blackFallbacks} 个缝合点需要黑屏兜底`)
  } else if (report.transitions) {
    message.info(
      `${report.transitions} 处转场：这些段不引用上段，是各自那条链的起点，各需要一张起始图（去「素材」按场景总图编辑最稳）`
    )
  }
}

async function regenerate() {
  if (!current.value) return
  const report = await assembly.regenerate(
    current.value.id,
    list.value,
    settings.value,
    registry.entityById
  )
  if (report) {
    message.success(`已重新组合为 ${report.groups.length} 段`)
  }
}

async function updateStrategy(patch: Record<string, unknown>) {
  if (!current.value) return
  await assembly.updateStrategy(current.value.id, patch)
}

async function splitAt(groupId: ID, atIndex: number) {
  if (!current.value) return
  await assembly.splitGroupAt(current.value.id, groupId, atIndex, list.value)
  message.success('已在此处切开')
}

async function mergeWithNext(groupId: ID) {
  if (!current.value) return
  const idx = current.value.groups.findIndex((g) => g.id === groupId)
  if (idx < 0 || idx >= current.value.groups.length - 1) return
  const res = await assembly.mergeGroups(
    current.value.id,
    [groupId, current.value.groups[idx + 1].id],
    list.value,
    settings.value
  )
  if (res.ok && res.frames > settings.value.maxSegmentFrames) {
    message.warning(`合并后 ${res.frames} 帧，超过上限了`)
  } else if (res.ok) {
    message.success('已合并')
  }
}

function beatById(id: ID) {
  return beats.beatById.get(id)
}

function subjectName(id: ID | null) {
  if (!id) return '—'
  const e = registry.entityById.get(id)
  return e ? `${e.name}${e.subjectN != null ? ` S${e.subjectN}` : ''}` : id
}

function barClass(frames: number, refPrev = false) {
  const cap = capOf(refPrev)
  if (frames > cap) return 'is-over'
  if (frames > cap * 0.9) return 'is-warn'
  return ''
}

/** 本段涉及的所有场景，按出现顺序 */
function groupScenes(v: SegmentView) {
  return collectScenes(v.narrativeBeats).map((id) => ({
    id,
    name: registry.entityById.get(id)?.name ?? id
  }))
}

/* ---------------------- 帧长度补正 ---------------------- */

/**
 * 只保留叙事片段的副帧。
 * 预备镜头 / 尾帧切镜 / 黑屏每次重建都是新对象，存下来也会失配，
 * 它们始终按占比自动分摊，由差额补偿机制吸收手工改动。
 */
function narrativePad(v: SegmentView): Record<ID, number> {
  const ids = new Set(v.narrativeBeats.map((b) => b.id))
  const out: Record<ID, number> = {}
  for (const [id, n] of Object.entries(v.pad)) {
    if (ids.has(id)) out[id] = n
  }
  return out
}

/** 把当前（可能是自动分摊的）副帧固定下来，之后可以逐拍微调 */
async function pinPad(v: SegmentView) {
  if (!current.value) return
  await assembly.setGroupPad(current.value.id, v.group.id, narrativePad(v))
  message.success('副帧已固定，可逐拍调整')
}

/** 逐拍增减副帧（允许负数压缩） */
async function bumpPad(v: SegmentView, beatId: ID, delta: number) {
  if (!current.value) return
  const next = narrativePad(v)
  next[beatId] = (next[beatId] ?? 0) + delta
  await assembly.setGroupPad(current.value.id, v.group.id, next)
}

/** 直接填副帧数：一格一格点太慢，知道要补几帧的人应该能一次填完 */
async function setPad(v: SegmentView, beatId: ID, value: number) {
  if (!current.value) return
  const next = narrativePad(v)
  if (value === 0) delete next[beatId]
  else next[beatId] = Math.round(value)
  await assembly.setGroupPad(current.value.id, v.group.id, next)
}

function onPadInput(v: SegmentView, beatId: ID, ev: Event) {
  const el = ev.target as HTMLInputElement
  const raw = el.value.replace(/[^\d-]/g, '')
  const n = Number.parseInt(raw || '0', 10)
  if (!Number.isFinite(n) || n === (v.pad[beatId] ?? 0)) {
    el.value = formatPad(v.pad[beatId] ?? 0)
    return
  }
  void setPad(v, beatId, n)
}

async function toggleRefPrev(v: SegmentView, value: boolean) {
  if (!current.value) return
  await assembly.setGroupRefPrev(current.value.id, v.group.id, value)
  message.info(value ? '已改为引用上段（帧长需为 17k）' : '已改为不引用上段（帧长需为 5+17k）')
}

function familyTag(v: SegmentView) {
  return v.refPrev ? '17k' : '5+17k'
}

/** 引擎自动生成的拼接片段不参与副帧分摊 */
function isAutoBeat(b: Beat) {
  return AUTO_KINDS.includes(b.kind)
}

/** 副帧小芯片的配色：加帧偏暖、压缩偏冷、零值灰（与卡片右上角帧数保持一致） */
function padClass(pad: number) {
  if (!pad) return 'is-zero'
  return pad > 0 ? 'is-plus' : 'is-minus'
}

/* ---------------------- 补帧的代价：关键帧帧位 ---------------------- */

/**
 * 补帧 / 压缩之后，钉在「第 N 帧」上的关键帧可能已经跑出这个镜头了。
 *
 * 打包时会把它夹回末帧（见 domain/packInput.ts 的 withinOf），所以不会崩、
 * 也不会报错 —— 但用户挑的那一帧被悄悄换掉，画面跟他的本意不是一回事。
 * 这种"安静降级"比报错更麻烦，所以在这里点名，并给一个明确的修法。
 */
interface StrayFrame {
  assetId: ID
  beatTitle: string
  frameIdx: number
  /** 这个镜头现在实际有几帧（含副帧） */
  limit: number
}

function strayOf(v: SegmentView): StrayFrame[] {
  const out: StrayFrame[] = []
  for (const b of v.beats) {
    if (isAutoBeat(b)) continue
    const limit = Math.max(1, beatFrames(b, settings.value) + (v.pad[b.id] ?? 0))
    for (const a of keyframesOf(registry.assets, b.id)) {
      if (placementOf(a) !== 'at') continue
      const f = a.frameIdx ?? 0
      if (f > limit - 1) {
        out.push({ assetId: a.id, beatTitle: b.title || '未命名镜头', frameIdx: f, limit })
      }
    }
  }
  return out
}

/** 每段一份越界清单：段卡里直接读，不在模板里反复扫素材 */
const strayMap = computed(() => {
  const map = new Map<ID, StrayFrame[]>()
  for (const v of views.value) map.set(v.group.id, strayOf(v))
  return map
})

function straysOf(v: SegmentView): StrayFrame[] {
  return strayMap.value.get(v.group.id) ?? []
}

/** 把越界的关键帧挪到这个镜头的末帧（它原本想要的"最后那一帧"仍然成立） */
async function fixStrays(v: SegmentView) {
  const list = straysOf(v)
  if (!list.length) return
  for (const s of list) await registry.setAssetFrameAt(s.assetId, s.limit - 1, s.limit)
  message.success(`已把 ${list.length} 张关键帧挪到镜头末帧`)
}
</script>

<template>
  <div style="height: 100%; display: flex; flex-direction: column">
    <div class="panel-head" style="border-radius: 0">
      <div class="row" style="gap: 10px">
        <span>组合方案</span>
        <n-select
          v-if="assembly.assemblies.length"
          size="small"
          style="width: 200px"
          :value="assembly.currentId"
          :options="assembly.assemblies.map((a) => ({ label: a.name, value: a.id }))"
          @update:value="(v: string) => (assembly.currentId = v)"
        />
        <n-tag size="small" :bordered="false">{{ views.length }} 段</n-tag>
        <n-tag size="small" :bordered="false">{{ totals.frames }} 帧</n-tag>
        <n-tag v-if="totals.transition" size="small" type="warning" :bordered="false">
          {{ totals.transition }} 处转场
        </n-tag>
        <n-tag v-if="totals.cut" size="small" type="info" :bordered="false">
          {{ totals.cut }} 处镜切
        </n-tag>
        <n-tag v-if="totals.black" size="small" type="warning" :bordered="false">
          {{ totals.black }} 处黑屏兜底
        </n-tag>
        <n-tag v-if="totals.over" size="small" type="error" :bordered="false">
          {{ totals.over }} 段超限
        </n-tag>
      </div>
      <div class="row" style="gap: 8px">
        <n-popconfirm v-if="current" @positive-click="regenerate">
          <template #trigger>
            <n-button size="small">重新组合</n-button>
          </template>
          重新组合会按策略重排所有段：已出的成片不会从磁盘删掉，但分段结果会全部重建，
          现有段的出片记录随之作废。确定？
        </n-popconfirm>
        <n-popconfirm
          v-if="current"
          @positive-click="assembly.removeAssembly(current!.id)"
        >
          <template #trigger>
            <n-button size="small" quaternary type="error">删除方案</n-button>
          </template>
          删除这个组合方案？
        </n-popconfirm>
        <n-button size="small" type="primary" @click="showCreate = true">新建方案</n-button>
      </div>
    </div>

    <div
      v-if="current"
      style="
        padding: 10px 16px;
        background: var(--panel);
        border-bottom: 1px solid var(--line);
        display: flex;
        gap: 24px;
        align-items: center;
        flex-wrap: wrap;
      "
    >
      <div class="row" style="gap: 8px">
        <span class="muted" style="font-size: 12.5px">策略</span>
        <n-select
          size="small"
          style="width: 130px"
          :value="current.strategy.mode"
          :options="modeOptions.map((m) => ({ label: m.label, value: m.value }))"
          @update:value="(v: string) => updateStrategy({ mode: v as AssemblyMode })"
        />
      </div>
      <!--
        最长段帧放在策略旁边：它决定"一段能装多少"，是同一层的组合参数。
        只列合法值 —— 帧长必须落在 5+17k / 17k 网格上，其余数字会被悄悄改写。
      -->
      <div class="row" style="gap: 8px">
        <span class="muted" style="font-size: 12.5px; white-space: nowrap">最长段</span>
        <n-select
          size="small"
          style="width: 132px"
          :value="settings.maxSegmentFrames"
          :options="maxFramesOptions"
          @update:value="(v: number) => setMaxFrames(v)"
        />
        <span class="muted" style="font-size: 12.5px; white-space: nowrap">
          引用上段 {{ refCap }} 帧
        </span>
        <InfoTip
          :width="360"
          text="一段最多能装多少帧。改动只影响之后的分段：段是存下来的，要点「重新组合」才会按新上限重排。&#10;帧长必须落在 5+17k（不引用上段）/ 17k（引用上段）两条网格上，所以只有这几个值；141 帧是 H3 单段上限（5.875 秒），不往上开。&#10;调小 → 段更多更短，单段要重拍的代价更小；调大 → 段更少，但一段废掉就得重跑更长。"
        />
      </div>
      <div class="row" style="gap: 8px; min-width: 220px; flex: 1">
        <span class="muted" style="font-size: 12.5px; white-space: nowrap">
          场景切分权重 {{ current.strategy.weights.scene }}
        </span>
        <n-slider
          style="flex: 1; min-width: 120px"
          :value="current.strategy.weights.scene"
          :min="0"
          :max="30"
          :step="1"
          @update:value="(v: number) => updateStrategy({ weights: { ...current!.strategy.weights, scene: v } })"
        />
      </div>
      <div class="row" style="gap: 8px; min-width: 220px; flex: 1">
        <span class="muted" style="font-size: 12.5px; white-space: nowrap">
          填满权重 {{ current.strategy.weights.waste }}
        </span>
        <n-slider
          style="flex: 1; min-width: 120px"
          :value="current.strategy.weights.waste"
          :min="0"
          :max="2"
          :step="0.05"
          @update:value="(v: number) => updateStrategy({ weights: { ...current!.strategy.weights, waste: v } })"
        />
      </div>
      <div class="row" style="gap: 8px">
        <n-select
          size="small"
          style="width: 150px"
          :value="seamPolicy"
          :options="seamPolicyOptions"
          @update:value="(v: SeamPolicy) => project.updateSettings({ seamPolicy: v })"
        />
        <span class="muted" style="font-size: 12.5px; white-space: nowrap">
          {{ seamPolicy === 'guide' ? '段间引导 · 段内无额外镜头' : '旧行为 · 段首预备镜头' }}
        </span>
      </div>
      <!-- 场景优先只影响旧行为：guide 下换场直接不引导，没有"切给场景"这回事 -->
      <div v-if="seamPolicy === 'legacy'" class="row" style="gap: 8px">
        <n-switch
          size="small"
          :value="settings.scenePriorityOnSeam"
          @update:value="(v: boolean) => project.updateSettings({ scenePriorityOnSeam: v })"
        />
        <span class="muted" style="font-size: 12.5px; white-space: nowrap">
          换场时场景优先切镜
        </span>
      </div>
    </div>

    <div v-if="current && looseIds.length" style="padding: 12px 16px 0">
      <n-alert type="warning" :bordered="false">
        有 {{ looseIds.length }} 个镜头还没进任何段
        <InfoTip
          :width="380"
          :text="
            '上游新增的片段不会自己消失。' +
            (hasProduced
              ? '\n这个方案已经有段出过片：插空可以完全不动已有段，并进相邻段则会让那一段的成片失效。'
              : '')
          "
        />
        <n-button
          size="tiny"
          type="primary"
          ghost
          style="margin-left: 8px"
          @click="openInsert(insertIndexFor(looseIds[0]), looseIds)"
        >
          插空成新段
        </n-button>
        <n-button size="tiny" quaternary :loading="aligning" style="margin-left: 6px" @click="align()">
          自动归位（插空优先）
        </n-button>
      </n-alert>
    </div>

    <StageAdvice
      v-if="current"
      stage="assemble"
      scope="groups"
      :presets="[
        '某段太长了，帮我从台词那里切开',
        '这两段应该合成一段',
        '这几段的缝合总要走黑屏，调整一下边界'
      ]"
    />

    <div style="flex: 1; min-height: 0; position: relative; display: flex">
    <div class="scroll-pane" id="as-list" style="flex: 1; padding: 16px">
      <div v-if="!assembly.assemblies.length" class="empty">
        <div style="font-size: 15px; margin-bottom: 6px">还没有组合方案</div>
        <div>
          新建后引擎把片段切成 ≤{{ settings.maxSegmentFrames }} 帧的段
          <InfoTip size="sm" :width="300" text="并自动判定每处缝合：镜切 / 转场 / 黑屏兜底。" />
        </div>
        <!-- 上限也会决定第一次组合怎么切，所以没有方案时就得能设 -->
        <div class="row" style="gap: 8px; justify-content: center; margin-top: 12px">
          <span class="muted" style="font-size: 12.5px">最长段</span>
          <n-select
            size="small"
            style="width: 132px"
            :value="settings.maxSegmentFrames"
            :options="maxFramesOptions"
            @update:value="(v: number) => setMaxFrames(v)"
          />
          <span class="muted" style="font-size: 12.5px">引用上段 {{ refCap }} 帧</span>
        </div>
        <div style="margin-top: 14px">
          <n-button type="primary" @click="showCreate = true">新建方案</n-button>
        </div>
      </div>

      <template v-else>
        <!--
          段字段的整页口径：多少段齐、缺几项、筛哪一类、怎么批量补。
          这些不进卡片 —— 卡片只管"这一段"，够不够 / 批量补 / 筛选是整页的事。
          吸顶是为了翻到第十一段时那两颗批量按钮还在眼前。
        -->
        <!--
          英文终稿模式：③ 这一页显示的就是要交付的那份英文。
          不把模式标出来，人会以为「补充出来的字段怎么全是英文」；
          切回时也得说清「已经译成英文的模型字段不会自己变回中文」。
        -->
        <div v-if="finalMode" class="langbar">
          <span class="langbar-tag">英文终稿模式</span>
          <span class="langbar-text">
            阶段①~③ 直接产出英文，这里显示的就是交付稿。
            <b v-if="gapCount">其中 {{ gapCount }} 项（{{ gapLabelText }}）只有英文。</b>
            <i v-else>中英两份都有。</i>
          </span>
          <InfoTip
            :width="400"
            text="英文终稿模式是「不写中文、直接写英文」。切回中文工作稿只改语言开关：已经译成英文的模型字段（段落概述 / 环境声 / 配乐）不会自动变回中文。'切回并回写中文' 会先让模型把这几项译回中文，再切语言。英文那份一直留着，随时能再切回来。"
          />
          <span class="langbar-spacer" />
          <n-button size="tiny" :loading="switchingLang" @click="onBackToZh(false)">
            切回中文
          </n-button>
          <n-button
            v-if="gapCount"
            size="tiny"
            type="primary"
            :loading="switchingLang"
            @click="onBackToZh(true)"
          >
            切回并回写中文
          </n-button>
        </div>

        <div v-if="views.length" id="as-fieldbar" class="sfbar">
          <div class="sfbar-l">
            <span class="sfbar-t">段字段</span>
            <span class="sfbar-fact">{{ fieldStats.done }}/{{ views.length }} 段齐</span>
            <span v-if="fieldStats.stale" class="sfbar-fact err">
              {{ fieldStats.stale }} 段待重生成
            </span>
            <span v-if="fieldStats.missingFields" class="sfbar-fact warn">
              缺 {{ fieldStats.missingFields }} 项
            </span>
            <span
              v-if="fieldStats.reframe"
              class="sfbar-fact warn"
              title="补帧 / 压缩之后段长变了：字段里写的时长要复核（不算过期）"
            >
              {{ fieldStats.reframe }} 段帧数改过
            </span>
          </div>
          <div class="sfbar-chips">
            <button
              v-for="f in fieldFilters"
              :key="f.key"
              type="button"
              class="sfbar-chip"
              :class="[f.tone ? 't-' + f.tone : '', { on: fieldFilterKey === f.key }]"
              :disabled="!fieldCounts[f.key] && f.key !== 'all'"
              :title="`只看「${f.label}」的段`"
              @click="setFieldFilter(f.key)"
            >
              {{ f.label }}<b>{{ fieldCounts[f.key] }}</b>
            </button>
          </div>
        <StageAdvice
          inline
          stage="complete"
          scope="segments"
          :presets="['段落概述里不要重复台词原文', '某段的配乐不合适', '某段的环境声写太空了']"
        />
        <span class="sfbar-spacer" />
          <div class="sfbar-acts">
            <span class="muted" style="font-size: 11.5px">并发</span>
            <n-select
              size="tiny"
              style="width: 56px"
              :value="fieldConcurrency"
              :options="[1, 2, 3, 4].map((n) => ({ label: String(n), value: n }))"
              @update:value="setFieldConcurrency"
            />
            <button type="button" class="sfbar-link" @click="toggleFieldsExpand()">
              {{ fieldExpandAll ? '全部收起' : '全部展开' }}
            </button>
            <n-button
              size="tiny"
              type="primary"
              :disabled="!fieldTargets.length || !provider.ready"
              :loading="fieldRunning"
              :title="provider.ready ? '' : '先在模型设置里配置供应商'"
              @click="sf.fillMissing()"
            >
              {{
                fieldStats.stale
                  ? `补空缺 + 重生成过期（${fieldTargets.length}）`
                  : `补全空缺（${fieldStats.missingFields}）`
              }}
            </n-button>
            <n-button
              size="tiny"
              quaternary
              :disabled="!views.length || !provider.ready"
              :loading="fieldRunning"
              @click="sf.regenerateAll()"
            >
              全部重生成
            </n-button>
          </div>
        </div>

        <div class="seg-slot is-first">
          <button type="button" class="seg-slot-btn" @click="openInsert(0)">
            ＋ 在最前面新增视频段
          </button>
        </div>
        <template v-for="(v, i) in views" :key="v.group.id">
        <div v-if="!sf.hidden(v)" :id="'as-g-' + v.group.id" style="margin-bottom: 6px">
          <div v-if="v.seam" style="margin-bottom: 2px">
            <!-- 段间只留一行"怎么缝"；六个明细字段挪进「详情」，列表里不再重复 -->
            <SeamPanel :seam="v.seam" :index="i" :entity-by-id="registry.entityById" compact />
          </div>

          <div class="group-box" :class="{ 'is-over': v.over }">
            <div class="row-between">
              <div class="row" style="gap: 8px">
                <span style="font-weight: 600">seg{{ String(i + 1).padStart(2, '0') }}</span>
                <span
                  class="seg-state"
                  :class="'is-' + v.result.state"
                  :title="v.result.reason || v.result.label"
                >
                  {{ v.result.label }}
                </span>
                <span
                  v-if="v.seamFrozen"
                  class="seg-state is-frozen"
                  title="尾帧去向沿用出片时的判定：插新段不会改到它。要让它接上新邻居，得解冻重跑"
                >
                  接缝已冻结
                </span>
                <button
                  v-if="v.seamFrozen"
                  type="button"
                  class="seg-link"
                  title="按当前邻居重算接缝（这一段会标成待重跑）"
                  @click="releaseSeam(v)"
                >
                  解冻
                </button>
                <n-switch
                  size="small"
                  :value="v.refPrev"
                  @update:value="(val: boolean) => toggleRefPrev(v, val)"
                />
                <span
                  class="muted"
                  style="font-size: 12px"
                  :title="
                    v.refPrev
                      ? '链内：首帧由上一段尾帧引导，不需要自己出起始图'
                      : '链头：这一段要一张起始图（在「素材」里按场景总图编辑出来）'
                  "
                >
                  引用上段{{ v.refPrev ? '' : ' · 链头' }}
                </span>
                <span class="mono" style="font-size: 12px">
                  {{ v.rawFrames }}
                  <span
                    v-if="v.padTotal"
                    :style="{ color: v.padTotal > 0 ? 'var(--warn-ink)' : 'var(--accent-ink)' }"
                  >
                    {{ formatPad(v.padTotal) }}
                  </span>
                  = {{ v.frames }} 帧
                  <span class="muted" style="font-weight: 400">/ {{ capOf(v.refPrev) }}</span>
                </span>
                <span
                  v-if="v.padTotal < 0"
                  class="tag-chip"
                  style="background: var(--accent-soft); color: var(--accent-ink)"
                >
                  压缩 {{ -v.padTotal }}
                </span>
                <span
                  class="tag-chip"
                  :style="
                    v.aligned
                      ? { background: 'var(--ok-soft)', color: 'var(--ok-ink)' }
                      : { background: 'var(--err-soft)', color: 'var(--err-ink)' }
                  "
                >
                  {{ familyTag(v) }}
                </span>
                <span class="muted mono" style="font-size: 12px">
                  {{ secondsFromFrames(v.frames, settings.fps).toFixed(3) }}s
                </span>
                <span
                  v-for="s in groupScenes(v)"
                  :key="s.id"
                  class="tag-chip ok"
                >
                  ▣ {{ s.name }}
                </span>
                <span
                  v-if="!groupScenes(v).length"
                  class="tag-chip err"
                >
                  未指定场景
                </span>
                <n-tag v-if="v.over" size="tiny" type="error" :bordered="false">超限</n-tag>
                <!-- 缝合状态不在这里重复：两段之间那条「缝合点 N → N+1」已经说了怎么缝 -->
              </div>
              <div class="row" style="gap: 6px">
                <n-button size="tiny" type="primary" ghost @click="detailGroupId = v.group.id">
                  详情
                </n-button>
                <n-button
                  size="tiny"
                  quaternary
                  :disabled="i >= views.length - 1"
                  :title="
                    i < views.length - 1
                      ? mergeImpact(current!.groups, [v.group.id, views[i + 1].group.id]).note
                      : ''
                  "
                  @click="mergeWithNext(v.group.id)"
                >
                  与下一段合并
                </n-button>
                <n-popconfirm @positive-click="removeSegment(v)">
                  <template #trigger>
                    <n-button
                      size="tiny"
                      quaternary
                      type="error"
                      :title="deleteImpact(current!.groups, v.group.id).note"
                    >
                      删除本段
                    </n-button>
                  </template>
                  {{ deleteImpact(current!.groups, v.group.id).note }}
                </n-popconfirm>
              </div>
            </div>

            <!-- 失效说明：为什么会待重跑、动过什么，就地给出来，不用去别处查 -->
            <div
              v-if="v.result.state === 'stale' || v.result.state === 'voided'"
              class="seg-invalid"
            >
              <span class="seg-invalid-txt">
                <b>{{ v.result.label }}</b>
                <template v-if="v.result.reason"> · {{ v.result.reason }}</template>
              </span>
              <button
                type="button"
                class="seg-invalid-btn"
                :disabled="resealing === v.group.id"
                title="重跑完之后点这里，把当前内容记为已出片"
                @click="reseal(v)"
              >
                已重跑，记为已出片
              </button>
              <button
                v-if="v.result.state === 'voided'"
                type="button"
                class="seg-invalid-btn"
                @click="assembly.clearVoid(current!.id, v.group.id)"
              >
                解除失效
              </button>
            </div>

            <div
              class="frame-bar"
              :class="barClass(v.frames, v.refPrev)"
              :title="`本段 ${v.frames} 帧 / 上限 ${capOf(v.refPrev)} 帧`"
              style="margin: 8px 0"
            >
              <i :style="{ width: Math.min(100, (v.frames / capOf(v.refPrev)) * 100) + '%' }" />
            </div>

            <!--
              这一段由哪些镜头拼成：卡片横排（横向可滚），一眼看完全段；
              卡片下方就地调副帧（−/填数字/＋），两张卡之间「在此切开」。
            -->
            <div class="shot-lane-wrap">
              <div class="shot-legend">
                <b class="mono">{{ v.beats.length }} 个镜头</b>
                <span class="mono">副帧合计 {{ formatPad(v.padTotal) }}</span>
                <span v-if="v.padAuto" class="shot-legend-hint">
                  按占比自动分摊，改动任意一格即固定
                </span>
                <span v-else class="shot-legend-hint">已手动固定，点「恢复自动」交回引擎</span>
                <span class="shot-legend-tip" title="段总帧数要保持 H3 网格，改动会摊到本段其他镜头上">
                  帧数 = 自身 + 副帧
                </span>
                <!--
                  固定 / 恢复自动贴着「副帧合计」放：它们改的就是这个数字。
                  放到段头那排按钮里，隔着半张卡，"这颗按钮管什么"要猜。
                -->
                <span class="shot-legend-spacer" />
                <button
                  type="button"
                  class="shot-padact"
                  :disabled="!v.padAuto"
                  title="把现在（自动分摊）的副帧固定下来，之后可逐镜头微调"
                  @click="pinPad(v)"
                >
                  固定副帧
                </button>
                <button
                  type="button"
                  class="shot-padact"
                  :disabled="v.padAuto"
                  title="清掉手工副帧，交回引擎按占比自动分摊"
                  @click="assembly.clearGroupPad(current!.id, v.group.id)"
                >
                  恢复自动
                </button>
              </div>

              <!-- 补帧的代价之一：钉在越界帧上的关键帧，出片时会被悄悄夹到末帧 -->
              <p v-if="straysOf(v).length" class="shot-stray">
                <b>{{ straysOf(v).length }} 张关键帧跑出镜头了</b>
                <span>
                  {{ straysOf(v)[0].beatTitle }} 钉在第 {{ straysOf(v)[0].frameIdx }} 帧，这个镜头现在只有
                  {{ straysOf(v)[0].limit }} 帧 —— 出片时会被夹到末帧，跟他挑的不是同一格
                </span>
                <button type="button" class="shot-padact" @click="fixStrays(v)">挪到末帧</button>
              </p>

              <div class="shot-lane">
                <div
                  v-for="(b, k) in v.beats"
                  :key="b.id"
                  class="shot-cell"
                  :data-frames="beatFrames(b, settings)"
                  :data-pad="v.pad[b.id] ?? 0"
                  :data-beat="b.id"
                >
                  <div
                    class="shot-card"
                    :class="{ 'is-auto': isAutoBeat(b) }"
                    :style="{ borderLeftColor: BEAT_KIND_COLOR[b.kind] }"
                  >
                    <div class="shot-card-top">
                      <span
                        class="shot-kind"
                        :style="{
                          background: BEAT_KIND_COLOR[b.kind] + '18',
                          color: BEAT_KIND_COLOR[b.kind]
                        }"
                      >
                        {{ BEAT_KIND_LABEL[b.kind] }}
                      </span>
                      <span class="shot-idx mono">{{ String(k + 1).padStart(2, '0') }}</span>
                      <span class="shot-dur mono" :title="`本镜头 ${beatFrames(b, settings)} 帧 + 副帧`">
                        {{ beatFrames(b, settings) }}<em v-if="v.pad[b.id]">{{ formatPad(v.pad[b.id]) }}</em
                        >f
                      </span>
                    </div>
                    <div class="shot-title" :title="b.title">{{ b.title || '（未命名）' }}</div>
                    <div v-if="b.dialogue" class="shot-line mono" :title="b.dialogue">
                      「{{ b.dialogue }}」
                    </div>
                    <div class="shot-sub muted">{{ subjectName(resolveSubjectId(b)) }}</div>
                  </div>

                  <!-- 副帧：− / 直接填 / ＋；自动片段不参与分摊 -->
                  <div v-if="!isAutoBeat(b)" class="shot-step">
                    <button type="button" title="减 1 帧" @click="bumpPad(v, b.id, -1)">−</button>
                    <label class="shot-padbox" :class="padClass(v.pad[b.id] ?? 0)">
                      <span class="shot-pad-lb">副帧</span>
                      <input
                        class="shot-pad mono"
                        :value="formatPad(v.pad[b.id] ?? 0)"
                        title="副帧：可直接填数字（负数表示压缩）"
                        @change="onPadInput(v, b.id, $event)"
                        @keydown.enter="($event.target as HTMLInputElement).blur()"
                      />
                    </label>
                    <button type="button" title="加 1 帧" @click="bumpPad(v, b.id, 1)">+</button>
                  </div>
                  <div v-else class="shot-step is-auto">
                    <span class="shot-auto">自动填入</span>
                  </div>

                  <button
                    v-if="k > 0"
                    type="button"
                    class="shot-cut"
                    :title="`从「${b.title}」开始拆成两段 · ${splitImpact(current!.groups, v.group.id).note}`"
                    @click="splitAt(v.group.id, k)"
                  >
                    ✂ 在此切开
                  </button>
                  <span v-else class="shot-cut is-empty" />
                </div>
              </div>
            </div>

            <!--
              第三层：整段字段。
              上面是"这一段怎么拼"（镜头 + 帧数），这里是"这一段在说什么"。
              改上面的东西不该让下面的字重写，反之亦然 —— 所以是两层，不是一排。
            -->
            <SegmentFields
              :view="v"
              :llm-fields="fieldLlm"
              :derived-fields="fieldDerived"
              :state="sf.segState(v)"
              :expand-all="fieldExpandAll"
              :running="fieldRunning"
              :failed-text="fieldFailed[v.group.id]"
              @generate="sf.regenerateOne(v)"
            />
          </div>

          <!-- 段间插空口：新增内容默认落在这里，已有段一个不动 -->
          <div class="seg-slot">
            <button type="button" class="seg-slot-btn" @click="openInsert(i + 1)">
              ＋ 在 seg{{ String(i + 1).padStart(2, '0') }} 之后新增视频段
            </button>
          </div>
          </div>
        </template>

        <!-- 待编排：删掉的段 / 抽出来的镜头，既不会消失，也不会被自动塞回某段 -->
        <div v-if="parkedIds.length" class="parked-box">
          <div class="parked-head">
            <b>待编排 {{ parkedIds.length }} 个镜头</b>
            <span class="muted row" style="gap: 0; align-items: center">
              被删掉的段、抽出来的镜头
              <InfoTip size="sm" :width="260" text="放在这里不会被自动并进任何段。" />
            </span>
          </div>
          <div class="parked-chips">
            <span v-for="id in parkedIds" :key="id" class="tag-chip parked-chip">
              {{ beatById(id)?.title || id }}
            </span>
          </div>
          <div class="row" style="gap: 6px; margin-top: 8px">
            <n-button size="tiny" type="primary" ghost @click="openInsert(views.length, parkedIds)">
              插空成新段
            </n-button>
            <InfoTip
              size="sm"
              :width="300"
              text="想并进某一段，用上面段卡里的「＋ 在该段之后新增」再选并入。"
            />
          </div>
        </div>
      </template>

    </div>
    <SectionNav v-if="views.length >= 2" title="视频段" container="#as-list" :items="segNav" />
    </div>

    <n-modal v-model:show="showCreate" preset="card" title="新建组合方案" style="max-width: 520px">
      <div class="stack">
        <div>
          <div class="muted" style="margin-bottom: 6px">方案名称</div>
          <n-input v-model:value="newName" placeholder="例如：方案A-按场景 / 快剪版" />
        </div>
        <div>
          <div class="muted" style="margin-bottom: 6px">组合策略</div>
          <div class="stack" style="gap: 6px">
            <div
              v-for="m in modeOptions"
              :key="m.value"
              class="panel"
              :style="{
                padding: '8px 12px',
                cursor: 'pointer',
                borderColor: newMode === m.value ? 'var(--accent)' : 'var(--line)',
                background: newMode === m.value ? 'var(--accent-soft)' : 'var(--panel)'
              }"
              @click="newMode = m.value"
            >
              <div style="font-weight: 500; font-size: 13.5px">{{ m.label }}</div>
              <div class="muted" style="font-size: 12px">{{ m.desc }}</div>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button @click="showCreate = false">取消</n-button>
          <n-button type="primary" @click="create">生成方案</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="showInsert" preset="card" title="新增视频段" style="max-width: 640px">
      <div class="stack">
        <div class="insert-pos">
          <span class="tag-chip" style="background: var(--accent-soft); color: var(--accent)">
            {{ insertPositionLabel }}
          </span>
          <InfoTip
            size="sm"
            :width="280"
            text="插空不会改动已有段；并进去会让那一段的成片失效。"
          />
        </div>

        <div>
          <div class="muted" style="font-size: 12px; margin-bottom: 6px">
            要插入的镜头（{{ insertPick.length }} / {{ insertCandidates.length }}）
          </div>
          <div v-if="!insertCandidates.length" class="empty" style="padding: 14px">
            没有未归位的镜头。可以在下面新建一个，或先去「② 细节填充」加镜头。
          </div>
          <div v-else class="insert-list">
            <label v-for="b in insertCandidates" :key="b.id" class="insert-row">
              <input
                type="checkbox"
                :checked="insertPick.includes(b.id)"
                @change="toggleInsert(b.id)"
              />
              <span
                class="tag-chip"
                :style="{
                  background: BEAT_KIND_COLOR[b.kind] + '18',
                  color: BEAT_KIND_COLOR[b.kind]
                }"
              >
                {{ BEAT_KIND_LABEL[b.kind] }}
              </span>
              <span class="insert-title">{{ b.title || '（未命名）' }}</span>
              <span v-if="parkedIds.includes(b.id)" class="tag-chip insert-parked">待编排</span>
              <span class="muted mono" style="font-size: 11px">{{ beatFrames(b, settings) }}f</span>
            </label>
          </div>
          <div class="row" style="gap: 6px; margin-top: 8px">
            <n-input
              v-model:value="newShotTitle"
              size="small"
              placeholder="新镜头标题，例如：陈默回头"
              style="flex: 1"
            />
            <n-button size="small" @click="createAndPick">＋ 新建镜头</n-button>
          </div>
        </div>

        <div>
          <div class="muted" style="font-size: 12px; margin-bottom: 6px">插入方式</div>
          <div class="stack" style="gap: 6px">
            <label class="insert-mode" :class="{ 'is-on': insertMode === 'gap' }">
              <input v-model="insertMode" type="radio" value="gap" />
              <div>
                <div class="insert-mode-t">插空新建一段（推荐）</div>
                <div class="insert-mode-d">已有段原样保留；成片按内容复用，不用重跑</div>
              </div>
            </label>
            <label
              v-if="insertAt > 0"
              class="insert-mode"
              :class="{ 'is-on': insertMode === 'prev' }"
            >
              <input v-model="insertMode" type="radio" value="prev" />
              <div>
                <div class="insert-mode-t">并进前一段 {{ segNameAt(insertAt - 1) }}</div>
                <div class="insert-mode-d">{{ absorbImpact(current!.groups, views[insertAt - 1].group.id).note }}</div>
              </div>
            </label>
            <label
              v-if="insertAt < views.length"
              class="insert-mode"
              :class="{ 'is-on': insertMode === 'next' }"
            >
              <input v-model="insertMode" type="radio" value="next" />
              <div>
                <div class="insert-mode-t">并进后一段 {{ segNameAt(insertAt) }}</div>
                <div class="insert-mode-d">{{ absorbImpact(current!.groups, views[insertAt].group.id).note }}</div>
              </div>
            </label>
          </div>
        </div>

        <n-alert :type="insertWillVoid.length ? 'warning' : 'info'" :bordered="false">
          {{ insertImpactNote }}
        </n-alert>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end; gap: 8px">
          <n-button @click="showInsert = false">取消</n-button>
          <n-button type="primary" :disabled="!insertPick.length" @click="confirmInsert">
            {{ insertMode === 'gap' ? '插空新增' : '并入并标失效' }}
          </n-button>
        </div>
      </template>
    </n-modal>

    <SegmentDetailModal
      :show="detailGroupId !== null"
      :view="detailView"
      :index="detailIndex"
      :settings="settings"
      :entities="registry.entities"
      :entity-by-id="registry.entityById"
      :schema="project.fieldSchema"
      :assets="registry.assets"
      @patch="onDetailPatch"
      @update:show="detailGroupId = null"
    />
  </div>
</template>

<style scoped>
/* 镜头卡片泳道：一张卡一个镜头，横排一行看完；副帧就地在卡下调，不点弹窗 */
.shot-lane-wrap {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--line);
}
.shot-legend {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 2px 6px;
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}
.shot-legend b {
  font-weight: 600;
  color: var(--text);
}
.shot-legend-hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.shot-legend-tip {
  flex: none;
  margin-left: auto;
  padding: 0 6px;
  font-size: 10.5px;
  line-height: 16px;
  color: var(--muted);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 4px;
  cursor: help;
}
.shot-lane {
  display: flex;
  gap: 8px;
  align-items: stretch;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 2px 2px 4px;
}
.shot-lane::-webkit-scrollbar {
  height: 6px;
}
/*
 * 每段镜头数不一样：5 张就撑不满一行、7 张刚好排满。
 * 给一点弹性（只长不缩，且封顶 260）：少的时候不留大片空白，
 * 多的时候保持 176 起步、超出就横向滚动，不会被压窄。
 */
.shot-cell {
  flex: 1 0 176px;
  max-width: 260px;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.shot-card {
  flex: 1;
  min-height: 78px;
  padding: 6px 8px 7px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  transition: box-shadow 0.15s, border-color 0.15s;
}
.shot-card:hover {
  box-shadow: var(--shadow);
}
.shot-card.is-auto {
  opacity: 0.72;
}
.shot-card-top {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.shot-idx {
  font-size: 10.5px;
  color: var(--muted);
}
.shot-kind {
  flex: none;
  padding: 0 4px;
  font-size: 10.5px;
  line-height: 16px;
  border-radius: 4px;
  white-space: nowrap;
}
.shot-dur {
  flex: none;
  margin-left: auto;
  font-size: 11px;
  white-space: nowrap;
}
.shot-dur em {
  margin-left: 1px;
  font-style: normal;
  font-size: 10.5px;
  color: var(--warn-ink);
}
.shot-title {
  margin-top: 4px;
  font-size: 12.5px;
  font-weight: 550;
  line-height: 17px;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.shot-line {
  margin-top: 2px;
  font-size: 11px;
  line-height: 15px;
  color: var(--ok-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.shot-sub {
  margin-top: 2px;
  font-size: 10.5px;
  line-height: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.shot-step {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 24px;
  margin-top: 4px;
}
.shot-step button {
  width: 20px;
  height: 20px;
  padding: 0;
  font-size: 13px;
  line-height: 1;
  color: var(--muted);
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 4px;
  cursor: pointer;
}
.shot-step button:hover {
  color: var(--accent);
  border-color: var(--accent);
}
/* 副帧芯片：加帧偏暖 / 压缩偏冷 / 零值灰，和卡片右上角的帧数同一套语义 */
.shot-padbox {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 20px;
  padding: 0 4px;
  font-size: 10.5px;
  border: 1px solid var(--line);
  border-radius: 5px;
  cursor: text;
}
.shot-pad-lb {
  opacity: 0.75;
}
.shot-padbox.is-zero {
  color: var(--muted-2);
  background: var(--panel-2);
}
.shot-padbox.is-plus {
  color: var(--warn-ink);
  background: var(--warn-soft);
  border-color: var(--warn-line);
}
.shot-padbox.is-minus {
  color: var(--accent-ink);
  background: var(--accent-soft);
  border-color: var(--accent-line);
}
.shot-padbox:focus-within {
  border-color: var(--accent);
}
.shot-pad {
  width: 24px;
  padding: 0;
  font-size: 11px;
  text-align: center;
  color: inherit;
  background: transparent;
  border: 0;
}
.shot-pad:focus {
  outline: none;
}
.shot-auto {
  padding: 0 6px;
  font-size: 10.5px;
  line-height: 18px;
  color: var(--muted-2);
  background: var(--panel-2);
  border-radius: 5px;
}
/* 切分入口：平时压低存在感，指到这一段才提亮，免得一排全是按钮 */
.shot-cut {
  flex: none;
  height: 15px;
  margin-top: 2px;
  padding: 0;
  font-size: 10.5px;
  line-height: 15px;
  text-align: center;
  color: var(--muted);
  background: transparent;
  border: 0;
  border-radius: 4px;
  opacity: 0.4;
  cursor: pointer;
}
.shot-cell:hover .shot-cut {
  opacity: 1;
}
.shot-cut:hover {
  color: var(--accent);
  background: var(--panel-2);
}
.shot-cut.is-empty {
  opacity: 0;
  cursor: default;
}

/* ---------------- 段状态徽章：出片 / 待重跑 / 已失效 / 位置变了 ---------------- */
.seg-state {
  flex: none;
  padding: 0 5px;
  font-size: 10.5px;
  line-height: 16px;
  border-radius: 4px;
  white-space: nowrap;
  cursor: help;
}
.seg-state.is-none {
  color: var(--muted-2);
  background: var(--panel-3);
}
.seg-state.is-ready {
  color: var(--ok-ink);
  background: var(--ok-soft);
}
.seg-state.is-moved {
  color: var(--accent-ink);
  background: var(--accent-soft);
}
.seg-state.is-stale {
  color: var(--warn-ink);
  background: var(--warn-soft);
}
.seg-state.is-voided {
  color: var(--err-ink);
  background: var(--err-soft);
}
.seg-state.is-frozen {
  color: var(--label);
  background: var(--hover);
}
.seg-link {
  padding: 0;
  font-size: 10.5px;
  color: var(--accent);
  background: transparent;
  border: 0;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
/* 失效说明条：为什么废了 + 一个"我重跑过了"的确认口 */
.seg-invalid {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding: 5px 8px;
  font-size: 11.5px;
  line-height: 16px;
  color: var(--err-ink);
  background: var(--err-soft);
  border: 1px solid var(--err-line);
  border-radius: 6px;
}
.seg-invalid-txt {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.seg-invalid-btn {
  flex: none;
  padding: 0 7px;
  font-size: 10.5px;
  line-height: 18px;
  color: var(--err-ink);
  background: #fff;
  border: 1px solid var(--err-line);
  border-radius: 4px;
  cursor: pointer;
}
.seg-invalid-btn:hover {
  border-color: var(--err-line);
}

/* ---------------- 段间插空口 ---------------- */
.seg-slot {
  display: flex;
  justify-content: center;
  height: 22px;
  margin: 2px 0;
}
.seg-slot.is-first {
  height: 26px;
  margin-bottom: 4px;
}
.seg-slot-btn {
  flex: none;
  padding: 0 10px;
  font-size: 11px;
  line-height: 20px;
  color: var(--muted);
  background: transparent;
  border: 1px dashed var(--line);
  border-radius: 10px;
  opacity: 0.42;
  cursor: pointer;
  transition: opacity 0.15s, color 0.15s, border-color 0.15s;
}
.seg-slot:hover .seg-slot-btn,
.seg-slot:focus-within .seg-slot-btn,
.seg-slot.is-first .seg-slot-btn {
  opacity: 1;
}
.seg-slot-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* ---------------- 待编排片段 ---------------- */
.parked-box {
  margin-top: 10px;
  padding: 10px 12px;
  background: var(--panel-2);
  border: 1px dashed var(--line);
  border-radius: 8px;
}
.parked-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12.5px;
}
.parked-head .muted {
  font-size: 11.5px;
}
.parked-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 7px;
}
.parked-chip {
  background: #fff;
  color: var(--text);
  border: 1px solid var(--line);
}

/* ---------------- 新增段弹窗 ---------------- */
.insert-pos {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.insert-list {
  max-height: 260px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
}
.insert-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
}
.insert-row:last-child {
  border-bottom: 0;
}
.insert-row:hover {
  background: var(--panel-2);
}
.insert-title {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.insert-parked {
  background: var(--hover);
  color: var(--label);
}
.insert-mode {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  cursor: pointer;
}
.insert-mode.is-on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.insert-mode input {
  margin-top: 2px;
}
.insert-mode-t {
  font-size: 12.5px;
  font-weight: 550;
}
.insert-mode-d {
  margin-top: 1px;
  font-size: 11.5px;
  color: var(--muted);
  line-height: 16px;
}

/* ------------------------------------------------------------------ *
 * 段字段工具条
 *
 * 吸顶在列表里：翻到第十一段时，"还缺几项 / 补全空缺"仍然在眼前。
 * 形态是一条淡淡的横条，不是一张卡片 —— 它管的是整页，不该比段卡更重。
 * ------------------------------------------------------------------ */
/* 英文终稿模式提示条：说清"为什么满屏英文"，并给出切回入口 */
.langbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-2, var(--panel));
  font-size: 12.5px;
}

.langbar-tag {
  flex: none;
  padding: 1px 7px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--warn, #c98a00) 16%, transparent);
  color: var(--warn, #c98a00);
  font-weight: 600;
}

.langbar-text {
  color: var(--muted);
  min-width: 0;
}

.langbar-text b {
  color: var(--text);
  font-weight: 600;
}

.langbar-text i {
  font-style: normal;
}

.langbar-spacer {
  flex: 1;
}

.sfbar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
  padding: 6px 0 7px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
}

.sfbar-l {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.sfbar-t {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

/* 统计：纯文字，只有"要你处理"的才上色 */
.sfbar-fact {
  font-size: 11.5px;
  color: var(--muted);
}

.sfbar-fact.err {
  color: var(--err-ink);
  font-weight: 600;
}

.sfbar-fact.warn {
  color: var(--warn-ink);
}

.sfbar-chips {
  display: flex;
  gap: 2px;
  flex: 0 0 auto;
}

/* 筛选：未选中是纯文字，选中才有一块浅底 */
.sfbar-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: none;
  color: var(--muted);
  font-family: inherit;
  font-size: 11.5px;
  line-height: 18px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.sfbar-chip b {
  margin-left: 5px;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 600;
}

.sfbar-chip:hover:not(:disabled) {
  color: var(--text);
  background: var(--panel-3);
}

.sfbar-chip:disabled {
  opacity: 0.35;
  cursor: default;
}

.sfbar-chip.on {
  border-color: var(--line-strong);
  background: var(--panel-3);
  color: var(--text);
  font-weight: 600;
}

.sfbar-chip.t-warn.on {
  color: var(--warn-ink);
}

.sfbar-spacer {
  flex: 1 1 0;
  min-width: 0;
}

.sfbar-acts {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.sfbar-link {
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: 11.5px;
  color: var(--accent);
  cursor: pointer;
}

.sfbar-link:hover {
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* 副帧旁边的动作：和副帧输入框同一档大小，不抢镜 */
.shot-legend-spacer {
  flex: 1 1 0;
  min-width: 0;
}

.shot-padact {
  padding: 0 6px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel);
  color: var(--label);
  font-family: inherit;
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
}

.shot-padact:hover:not(:disabled) {
  border-color: var(--accent-line);
  color: var(--accent);
}

.shot-padact:disabled {
  opacity: 0.35;
  cursor: default;
}

/* 越界的关键帧：一行小字说清"钉在第几帧、镜头只有几帧" */
.shot-stray {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0 0 6px;
  padding: 0 2px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--warn-ink);
}

.shot-stray b {
  font-weight: 600;
}
</style>
