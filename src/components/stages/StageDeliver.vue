<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NCheckbox,
  NInput,
  NInputNumber,
  NModal,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSwitch,
  NTag,
  useMessage
} from 'naive-ui'
import { useRouter } from 'vue-router'
import FieldRow from '@/components/FieldRow.vue'
import { fieldHint, fieldLabel } from '@/domain/fieldLabels'
import { deliveryFields, hasCjkOutsideD, langOf } from '@/domain/lang'
import { useProjectStore } from '@/stores/project'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { useAssemblyStore } from '@/stores/assembly'
import { usePipelineStore } from '@/stores/pipeline'
import { useProviderStore } from '@/stores/provider'
import { useGateStore } from '@/stores/gate'
import SeamPanel from '@/components/SeamPanel.vue'
import SegmentOutput from '@/components/deliver/SegmentOutput.vue'
import { useSegmentProducts } from '@/composables/useSegmentProducts'
import { EXPORT_MODE_OPTIONS, EXPORT_SOURCE_OPTIONS, type ExportSource } from '@/domain/segmentOps'
import { segProductHint } from '@/domain/productDisplay'
import {
  DEFAULT_COMFY_URL,
  SECOND_SEED_FIXED,
  SECOND_STAGE_OPTIONS,
  secondStageOf,
  type SecondStage
} from '@/domain/run'
import { CANVAS_RATIOS, canvasMegapixels } from '@/domain/pipelineParams'
import { MEGAPIXEL_PIXELS, sigmasStepCount } from '@/domain/secondPass'
import SectionNav, { type SectionNavItem } from '@/components/SectionNav.vue'
import StageAdvice from '@/components/StageAdvice.vue'
import FixIssuesDialog from '@/components/FixIssuesDialog.vue'
import { splitIssuesByScope } from '@/domain/rules'
import { groupFields } from '@/domain/fieldGroups'
import type { FixPatch } from '@/core/llm/prompts'
import { deepClone } from '@/core/plain'
import { composeSegmentText } from '@/domain/derive'
import { isComposable } from '@/domain/beats'
import { packSegmentOf } from '@/domain/packInput'
import {
  buildDirectorPack,
  buildDirectorPackZip,
  CANVAS_MULTIPLE,
  DEFAULT_OUTPUT_HEIGHT,
  DEFAULT_OUTPUT_WIDTH,
  preferredDurationSecFromFrames,
  snapCanvas,
  type PackBuildInput
} from '@/domain/pack'
import { secondsFromFrames } from '@/domain/timing'
import { formatPad } from '@/domain/frames'
import type { Entity, FieldSchema, ID, ProjectSettings } from '@/domain/types'
import type { SegmentView } from '@/stores/assembly'
import InfoTip from '@/components/common/InfoTip.vue'
import AiWrite from '@/components/common/AiWrite.vue'

const props = defineProps<{
  /** 只在真正处于交付页时才去探产物缓存（组件是 v-show 常驻的） */
  active?: boolean
}>()

const router = useRouter()
const project = useProjectStore()
const beats = useBeatStore()
const registry = useRegistryStore()
const assembly = useAssemblyStore()
const pipeline = usePipelineStore()
const provider = useProviderStore()
const gate = useGateStore()
const message = useMessage()

/**
 * 段的产物（一采/二采）与段级操作（只跑这段、导出这段）。
 *
 * 产物不单独开一页：它属于"这一段"，所以能力都挂在这一页上 —— 段列表里看得见
 * 每段有没有片，段详情里直接能播、能重跑、能导出。
 */
const {
  rows: prodRows,
  loading: prodLoading,
  error: prodError,
  firstCount: prodFirstCount,
  secondCount: prodSecondCount,
  staleCount: prodStaleCount,
  timelineSource,
  baseUrl,
  workflowName,
  refresh: refreshProducts,
  picked,
  pickedSecond,
  submitPicks,
  isPicked,
  togglePick,
  linked,
  chains,
  hasChains,
  chainTag,
  chainOf,
  pickedChains,
  allPicked,
  pickAll,
  clearPick,
  pickSummary,
  pickedLabels,
  pickedFrames,
  pickedSeconds,
  showRun,
  submitting,
  pipe,
  pipeSummary,
  pipeReady,
  setPipe,
  cardList,
  cardPicked,
  cardsUnknown,
  visibleCardCount,
  cardsReading,
  refreshCards,
  toggleCardPipe,
  clearCards,
  pipeMegapixels,
  pipeRatio,
  setPipeMegapixels,
  setPipeRatio,
  secondStage,
  secondStageOptions,
  secondSamplerOptions,
  secondSize,
  secondSigmasWired,
  runStage,
  taskTypeOptions,
  samplerOptions,
  schedulerOptions,
  runModelOptions,
  secondRunModelOptions,
  submitTarget,
  submitLabels,
  submitSummary,
  submitFrames,
  submitSeconds,
  openRun,
  doRun,
  showExport: showSegExport,
  exportMode,
  exportSource,
  exportPicked,
  exportPickedFrames,
  exportPickedSeconds,
  exportPickSummary,
  exportPickedChains,
  secondProbing,
  secondProbedAt,
  secondError,
  probeSecond,
  isPickedFor,
  pickableFor,
  prunePickable,
  secondPickableCount,
  toggleExportPickFor,
  pickAllFor,
  clearPickFor,
  openExport: openSegExport,
  doExport: doSegExport,
  exportUrl,
  pickWithClips,
  exportResult: segExportResult,
  exportError: segExportError,
  exporting: segExporting,
  films,
  redoing,
  redoFilm,
  latestJob,
  latestBusy,
  rebuildable,
  runRoute,
  cfg: runCfg,
  lastJob,
  binding,
  bindingText,
  bindingOrigin,
  bindingReady,
  scanCaches,
  bindCache,
  unbindCache,
  cacheScanning,
  cacheCandidates,
  cacheScanError,
  clearCacheCandidates,
  passLabel,
  passTone,
  poster,
  jobPct,
  at
} = useSegmentProducts(computed(() => props.active ?? true))

/* ------------------------------ 画布：像素密度 ------------------------------ */

/**
 * 画布不再用"固定档位"选：档位永远填不满（宽高得是 32 的倍数），
 * 而"这一段用 0.12 MP 试跑"是连续的。这里给一个密度输入 + 比例，宽高由它们算。
 */
const mpValue = computed(() => Math.round(pipeMegapixels.value * 1000) / 1000)

/** 当前比例落在哪个档上；对不上就是「自定义」 */
const ratioValue = computed(() => {
  const hit = CANVAS_RATIOS.find((r) => Math.abs(r.value - pipeRatio.value) < 0.02)
  return hit ? String(hit.value) : 'custom'
})

const ratioOptions = computed(() => [
  ...CANVAS_RATIOS.map((r) => ({ label: r.label, value: String(r.value) })),
  { label: `自定义 ${pipeRatio.value.toFixed(3)}`, value: 'custom' }
])

function applyRatio(v: string) {
  if (v === 'custom') return
  setPipeRatio(Number(v))
}

/** 二采：三态标签 + 提示 */
const secondStageText = computed(
  () =>
    secondStageOptions.value.find(
      (o: { value: SecondStage; label: string; hint: string }) =>
        o.value === pipe.value.secondStage
    )?.label ?? '仅一采'
)
const secondStageHint = computed(
  () =>
    secondStageOptions.value.find(
      (o: { value: SecondStage; label: string; hint: string }) =>
        o.value === pipe.value.secondStage
    )?.hint ?? ''
)
/**
 * 二采的「像素密度」框：面板上只留这一个输入（其余三档挪到运行页的节点控制台）。
 *
 * 老配置如果是 p 档 / 倍率 / 指定尺寸，框里显示的是**当前目标尺寸换算出来的密度**
 * ——填的是"结果有多重"，而不是把原来的档位偷偷改成像素量；一旦用户动手改，才
 * 落成像素量档（否则改了没反应，比不改更糟）。
 */
/**
 * 二采步数：节点上就是 sigmas 条数 − 1。
 *
 * 面板的 sigmas 留空 = 「用图上现有接线」，这时步数得看**那条线上写的是什么**：
 * 写死 3 步会和图上接的 `ManualSigmas`（常常 2 条 = 1 步）对不上 ——
 * 用户按 3 步做预期、实际跑 1 步，是最难自查的一类错。
 * 线上也不是 ManualSigmas（交给 BasicScheduler 之类）时，才退回节点默认的 3 步。
 */
const secondSteps = computed(() => {
  const own = pipe.value.secondSigmas.trim()
  if (own) return sigmasStepCount(own)
  const wired = sigmasStepCount(secondSigmasWired.value)
  return wired > 0 ? wired : 3
})

const secondMegapixelsShown = computed(() => {
  if (pipe.value.secondUpscaleMode === 'megapixels') return pipe.value.secondMegapixels
  const { width, height } = secondSize.value
  return Math.round(((width * height) / MEGAPIXEL_PIXELS) * 100) / 100
})

function setSecondMegapixels(mp: number | null) {
  if (!mp || mp <= 0) return
  setPipe({
    secondUpscaleMode: 'megapixels',
    secondMegapixels: Math.round(mp * 100) / 100
  })
}

const activeSegment = ref(0)
/** 参考图本体是否已经补回内存（后端只回元数据，不回 blob） */
const assetsReady = ref(false)

onMounted(async () => {
  await registry.hydrateAssetBlobs()
  assetsReady.value = true
})
const showSchema = ref(false)
const showFix = ref(false)
const schemaDraft = ref<FieldSchema[]>([])

const settings = computed<ProjectSettings>(() => project.settings)
const schema = computed(() => project.fieldSchema)
const list = computed(() => beats.ordered)
const current = computed(() => assembly.current)

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

const active = computed(() => views.value[activeSegment.value] ?? null)

/**
 * 交付看的那一份：跟着工作语言走（见 `domain/lang` 的 deliveryFields）。
 *
 * 以前这里是「英文有内容就用英文」，不看 workLanguage —— 中文工作稿模式下
 * 页面显示英文终稿、门禁看的却是中文那份，于是「字段明明填着，却报 21 处为空」。
 * 现在显示 / 门禁 / 打包 / 导出都走同一个函数，不存在两套说法。
 */
function finalFieldsOf(v: SegmentView | null): Record<string, string> {
  if (!v) return {}
  return v.delivery
}

/** 是否已经切到英文终稿（阶段⑤ 完成） */
const finalMode = computed(() => settings.value.workLanguage === 'en')

/** 模型字段基于旧内容生成、现在已不可信的段数 */
const staleCount = computed(() => views.value.filter((v) => v.stale).length)

/**
 * 过期的是哪几段。
 *
 * 只说「有 7 段过期」，用户得自己一段段翻；这里给出段号，点一下就切到那一段。
 */
const staleRows = computed(() =>
  views.value.map((v, i) => ({ v, i })).filter(({ v }) => v.stale)
)

/** 过期的原因（优先说具体是哪一拍 / 哪个主体变了） */
function staleWhyText(v: SegmentView): string {
  const why = v.staleWhy
  if (!why || why.unknown) return '内容与生成时不一致'
  const bits: string[] = []
  if (why.beats.length) bits.push(`${why.beats.length} 拍改过`)
  if (why.removed.length) bits.push(`少掉 ${why.removed.length} 拍`)
  if (why.entities.length) {
    const names = why.entities
      .slice(0, 2)
      .map((id) => registry.entityById.get(id)?.name ?? '主体')
      .join('、')
    bits.push(`主体 ${names}${why.entities.length > 2 ? ' 等' : ''}的词条变过`)
  }
  return bits.length ? bits.join(' · ') : '内容与生成时不一致'
}

/**
 * 不在任何段里的片段：它们不会出现在交付结果里。
 * 只数「可组合」的片段 —— 缺绑定的片段单独用 unboundCount 提示，
 * 两者的修复路径不同（并入相邻段 vs 补实体绑定），混在一起会误导。
 */
const orphanCount = computed(() => {
  const asm = current.value
  if (!asm) return 0
  const assigned = new Set(asm.groups.flatMap((g) => g.beatIds))
  return list.value.filter((b) => isComposable(b) && !assigned.has(b.id)).length
})

/** 缺场景/说话人绑定的片段：组合时被跳过（或带着校验错误进组），交付前必须补上 */
const unboundCount = computed(() => list.value.filter((b) => !isComposable(b)).length)

/** 还在中文工作稿里、但已经混进英文的字段（本地化没做干净的信号） */
const cjkFields = computed(() => {
  const out: string[] = []
  if (!finalMode.value) return out
  for (const v of views.value) {
    for (const f of project.fieldSchema) {
      if (hasCjkOutsideD(finalFieldsOf(v)[f.key])) out.push(`${f.key}@${v.group.id}`)
    }
  }
  return out
})

const globalIssues = computed(() => {
  if (!views.value.length) return []
  return assembly.globalIssues(
    views.value,
    registry.entities,
    list.value,
    settings.value,
    registry.entityById,
    project.fieldSchema
  )
})

const stats = computed(() => {
  const errors = views.value.reduce((s, v) => s + v.issues.filter((i) => i.level === 'error').length, 0)
  const warns = views.value.reduce((s, v) => s + v.issues.filter((i) => i.level === 'warn').length, 0)
  return {
    errors: errors + globalIssues.value.filter((i) => i.level === 'error').length,
    warns: warns + globalIssues.value.filter((i) => i.level === 'warn').length
  }
})

/** 本段（含全片级）里能靠改写字段修掉的问题数 */
const fixableCount = computed(() => {
  if (!active.value) return 0
  return splitIssuesByScope([...active.value.issues, ...globalIssues.value]).field.length
})

/**
 * 侧边目录：段概览 + 按模块分组的字段 + 检查区块。
 *
 * 目录必须和页面用同一套分组（都来自 fieldGroups），否则会出现
 * 「页面上一共四组、目录里字段平铺成一串」—— 找字段还是得从头扫一遍。
 */
const fieldNav = computed<SectionNavItem[]>(() => {
  const v = active.value
  if (!v) return []
  const out: SectionNavItem[] = [
    { id: 'dl-overview', label: '段概览' },
    { id: 'dl-output', label: '本段产物' }
  ]
  for (const g of fieldGroups.value) {
    out.push({ id: `dl-g-${g.id}`, label: g.label, heading: true })
    for (const f of g.fields) {
      const empty = !fieldValue(f.key).trim()
      out.push({
        id: `dl-f-${f.key}`,
        label: f.label || f.key,
        hint: empty ? '空' : undefined,
        tone: empty ? 'err' : 'default'
      })
    }
  }
  if (v.issues.length) out.push({ id: 'dl-seg-check', label: '本段检查', hint: `${v.issues.length}`, tone: 'err' })
  if (globalIssues.value.length)
    out.push({ id: 'dl-global-check', label: '全片检查', hint: `${globalIssues.value.length}`, tone: 'warn' })
  return out
})

/**
 * 当前段的产物行。
 *
 * 段数对不上（本地拆/并过、或历史时间线拿不到）时给 null，让区块说清"对不上"，
 * 不要拿相邻的槽位凑一个画面出来。
 */
const activeProduct = computed(() => prodRows.value[activeSegment.value] ?? null)

/** 探不到这一段时的原因，直接说给人听 */
const prodHint = computed(() => {
  if (!prodRows.value.length) {
    if (!views.value.length) return '这一集还没有可交付的段'
    return '这一集还没生成过：跑一次之后，产物会自动挂到每一段上'
  }
  // 整集一段成片都没有、但缓存目录是绑着的：多半是有任务被中断/失败过，
  // 节点在提交时就把段位表改成了新哈希（文件没写出来），旧缓存于是"看不见"了。
  if (prodFirstCount.value === 0 && prodSecondCount.value === 0 && binding.value) {
    return '整集都没探到成片：若有任务中途失败/被中断，段位表可能被它改写了 —— 点「整片成片 → 重出整片」会按上次配方重跑（缓存命中，通常几十秒）'
  }
  if (activeSegment.value >= prodRows.value.length) {
    return `缓存里只有 ${prodRows.value.length} 段，当前是第 ${activeSegment.value + 1} 段`
  }
  return ''
})

/* ---------------- 远程缓存绑定 ---------------- */

const showBind = ref(false)
/** 弹窗里可编辑的 ComfyUI 地址（不直接改运行配置，避免"只是看看"就把配置改了） */
const bindBase = ref('')

/** 段表是从哪来的：绑定 / 上次提交 / 本地现编 —— 决定"这个段位准不准" */
const timelineSourceLabel = computed(
  () =>
    ({
      binding: '绑定的缓存目录',
      job: '上次提交的时间线',
      local: '本地按当前段现编'
    })[timelineSource.value] ?? '本地现编'
)

/**
 * 打开缓存详情。
 *
 * **不再自动扫 history**：绑定在生成时就自动落好了，这个弹窗是"看/纠偏"用的，
 * 不是必经步骤。扫一次要拉十几 MB，没必要因为点开看一眼就付这个代价。
 */
function openBind() {
  bindBase.value = baseUrl.value || runCfg.value?.baseUrl || DEFAULT_COMFY_URL
  showBind.value = true
}

function doBind(c: (typeof cacheCandidates.value)[number]) {
  bindCache(c, bindBase.value)
  showBind.value = false
}

/** 候选的结局标签（缓存可不可信，一眼能看出来） */
const CACHE_STATUS: Record<string, { text: string; tone: 'success' | 'warning' | 'default' }> = {
  success: { text: '出片成功', tone: 'success' },
  error: { text: '失败 · 可能留有一采缓存', tone: 'warning' },
  unknown: { text: '状态未知', tone: 'default' }
}

function cacheStatus(status: string) {
  return CACHE_STATUS[status] ?? CACHE_STATUS.unknown
}

/** 这一条是不是当前绑定的那个目录 */
function isBound(c: (typeof cacheCandidates.value)[number]): boolean {
  const b = binding.value
  return !!b && b.workflowName === c.workflowName && b.nodeId === c.nodeId
}



/** 段列表每行的产物小结 */
function productHint(i: number) {
  const r = prodRows.value.find((x) => x.index === i) ?? prodRows.value[i]
  if (!r) return { text: '—', tone: 'default' as const }
  return segProductHint(r.first, r.second)
}

/**
 * 导出弹窗里每段的状态：**只按当前选的来源看**。
 *
 * 段列表那边显示的是"这段有没有片"（一采/二采合并），而导出必须说清
 * "在一采下有没有片"——只有二采的段，切到一采导出就是空的，这个差别
 * 得在选择的时候看得见，而不是导出完发现少了段。
 */
function sourceStateOf(i: number) {
  const r = prodRows.value.find((x) => x.index === i)
  if (!r) return { tone: 'default' as const, text: '无缓存' }
  const second = exportSource.value === 'second'
  // 二采还没问过节点：这时候显示"未渲染"是错的，会让人以为这段没做二采
  if (second && (secondDetecting.value || !secondProbedAt.value)) {
    return { tone: 'default' as const, text: secondDetecting.value ? '检测中…' : '待检测' }
  }
  const p = second ? r.second : r.first
  if (p.hasClip) return { tone: 'success' as const, text: p.stale ? '旧片' : '有片' }
  if (p.hasFrames) return { tone: 'warning' as const, text: '有帧' }
  if (p.hasLatent) return { tone: 'warning' as const, text: '仅 latent' }
  /*
   * 二采说"未渲染"是错的：它压根没进过这次的生成规程。分开讲才看得懂
   * —— "待跑二采"是能做还没做（一采 latent 在），"无一采 latent"是想跑也跑不了。
   * 这正是二采能不能选中的依据：不是"这次有没有生成"，而是"有没有一采 latent"。
   */
  if (second) {
    return r.canSecondSample
      ? { tone: 'warning' as const, text: '待跑二采' }
      : { tone: 'default' as const, text: '无一采 latent' }
  }
  return { tone: 'default' as const, text: '未渲染' }
}

/** 这一段在当前来源下能不能勾（一采都行；二采要先有一采 latent） */
function selectableAt(i: number): boolean {
  return pickableFor(exportSource.value, i)
}

/**
 * 点导出弹窗里的一段。
 *
 * 除了"勾/取消"，还要挡住**不可勾**的段并说清原因：二采没有一采 latent 时，
 * 勾上去也只能导出 0 个文件，不如当场告诉他缺什么。
 */
function toggleExportSeg(i: number): void {
  if (exportKind.value !== 'clips') return
  // 导出不按链：按链展开会让「只导这两段」做不到（整集一条链时点一下就是 0 或全部）
  const ok = toggleExportPickFor(exportSource.value, i)
  if (ok) return
  if (exportSource.value === 'second' && !selectableAt(i)) {
    message.warning(
      `seg${String(i + 1).padStart(2, '0')} 勾不上：这一段没有一采 latent，二采要先有一采 latent 才能跑`,
      { duration: 6000 }
    )
  }
}

/**
 * 二采的「提前检测」。
 *
 * 一采的选择完全由前端说了算：段表就是我们提交出去的那份，有没有片看本地缓存槽
 * 就够了。二采不行——它可能在另一轮任务、另一台机器，甚至 ComfyUI 界面上手动
 * 产出，前端收不到任何通知。所以每次进二采都现问一次节点，问回来再按结果勾选。
 */
const SECOND_PROBE_TTL = 90_000
const secondDetecting = ref(false)

/** 二采状态是什么时候问回来的（给界面一句"刚检过"的凭据） */
const secondProbedText = computed(() => {
  if (!secondProbedAt.value) return '还没检测'
  const d = new Date(secondProbedAt.value)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss} 检测`
})

/** 这次检测的结果：有几段真有二采成片（检测失败时是 null） */
const secondClipCount = computed(() =>
  prodRows.value.filter((r) => r.second.hasClip).length
)

async function detectSecond(force = false) {
  if (secondDetecting.value || exportSource.value !== 'second') return
  const fresh =
    !!secondProbedAt.value && Date.now() - secondProbedAt.value < SECOND_PROBE_TTL
  if (force || !fresh) {
    secondDetecting.value = true
    try {
      await probeSecond()
    } finally {
      secondDetecting.value = false
    }
  }
  /*
   * 检测回来才知道哪段有一采 latent：把不可勾的段从二采勾选里摘掉。
   * 留着它们会让主按钮写「导出二采 4 段」，实际却 0 个文件。
   */
  const kept = prunePickable('second')
  // 只补一次：用户自己调整过的勾选不能被检测结果覆盖
  if (!kept.length) pickWithClips('second')
}

// 切到二采就检一次；切回一采不动（一采那份勾选是用户刚才亲手挑的）
watch(exportSource, (src) => {
  if (src === 'second' && showSegExport.value) void detectSecond()
})

/** 当前勾选里，按当前来源真的有片的段数（导出按钮上直接说清楚） */
const pickedClipCount = computed(
  () => exportPicked.value.filter((i) => sourceStateOf(i).tone === 'success').length
)

/** 另一个来源勾了几段（两份互不影响，要让用户看得见） */
const exportOtherCount = computed(() => {
  const other: number[] = exportSource.value === 'second' ? picked.value : pickedSecond.value
  return other.length
})

/** 一采覆盖情况（没探测到缓存时别显示成「0/4 段有一采」，那是假话） */
const clipSummary = computed(() => {
  if (!prodRows.value.length) return `${views.value.length} 段 · 还没探测到缓存`
  return `${prodFirstCount.value}/${prodRows.value.length} 段有一采`
})

/** 来源按钮上的计数；没探测到缓存时不编数字 */
function sourceLabel(src: { value: ExportSource; label: string }) {
  if (!prodRows.value.length) return src.label
  if (src.value === 'second') {
    // 没问过就是没问过：写「0/4」等于替对面断言"一段都没做二采"
    if (secondDetecting.value) return `${src.label}（检测中…）`
    if (!secondProbedAt.value) return src.label
    return `${src.label}（${prodSecondCount.value}/${prodRows.value.length}）`
  }
  return `${src.label}（${prodFirstCount.value}/${prodRows.value.length}）`
}

/** 导出目录一键复制：用户下一步多半要去文件管理器里看这些片 */
async function copyExportDir() {
  const dir = segExportResult.value?.exportDir
  if (!dir) return
  try {
    await navigator.clipboard.writeText(dir)
    message.success('已复制导出目录')
  } catch {
    message.warning('剪贴板不可用，请手动复制')
  }
}

/** 整片弹窗 */
const showFilm = ref(false)

/** 段字段的权威值（终稿那一份） */
function fieldValue(key: string): string {
  return finalFieldsOf(active.value)[key] ?? ''
}

/* ------------------------------------------------------------------ *
 * 草稿式编辑：失焦才写库
 *
 * 为什么要带「基线」：段字段在别处也能改 —— ④ 补全页生成、AI 修复、
 * 另一个窗口里手改。只存"我输入的值"不够，提交时分不清"库里的值变了"
 * 是别人改的、还是我自己上一次提交的结果。基线 = 开始编辑那一刻库里的值，
 * 三者一对比就知道有没有人插进来。
 * ------------------------------------------------------------------ */

interface FieldDraft {
  value: string
  /** 开始编辑时库里的值 */
  base: string
}

const drafts = ref<Record<string, FieldDraft>>({})
const draftKey = (groupId: ID, key: string) => `${groupId}|${key}`

/** 库里的权威值（不是草稿） */
function libValue(key: string): string {
  return finalFieldsOf(active.value)[key] ?? ''
}

function draftOf(groupId: ID, key: string): string {
  const k = draftKey(groupId, key)
  const d = drafts.value[k]
  if (d) return d.value
  return libValue(key)
}

function onDraft(groupId: ID, key: string, value: string) {
  const k = draftKey(groupId, key)
  const prev = drafts.value[k]
  drafts.value = {
    ...drafts.value,
    [k]: { value, base: prev?.base ?? libValue(key) }
  }
}

/**
 * 这个字段是否有"别人先改了"的冲突：
 * 我动过它（value ≠ base），而库里的值也变了（≠ base 且 ≠ 我的输入）。
 */
function draftConflict(groupId: ID, key: string): boolean {
  const d = drafts.value[draftKey(groupId, key)]
  if (!d || d.value === d.base) return false
  const lib = libValue(key)
  return lib !== d.base && lib !== d.value
}

/** 放弃自己的输入，换成库里（别处写入）的值 */
function adoptLibValue(groupId: ID, key: string) {
  const k = draftKey(groupId, key)
  const next = { ...drafts.value }
  delete next[k]
  drafts.value = next
}

async function commitField(groupId: ID, key: string) {
  const k = draftKey(groupId, key)
  const d = drafts.value[k]
  if (!d) return
  const next = { ...drafts.value }
  delete next[k]
  drafts.value = next

  const pid = project.currentId
  if (!pid) return

  const lib = libValue(key)
  // 值没变就没有写库的必要（也避免无谓地把别人的改动时间戳刷掉）
  if (d.value === lib) return
  const conflicted = d.value !== d.base && lib !== d.base

  /*
   * 写到**当前工作语言**那一侧：中文工作稿模式下写 zh、英文终稿模式下写 en。
   * 以前 summary 写死 'en'，中文工作稿里点一次「AI 写」就把英文终稿覆盖成中文，
   * 而且页面上还看不出变化（显示的是另一侧）。
   */
  const side = langOf(settings.value)
  if (key === 'summary') await assembly.setSummary(pid, groupId, d.value, side)
  else await assembly.setField(pid, groupId, key, d.value, side)

  if (conflicted) {
    message.warning(
      `${key} 在别处被改过，已按你这里的版本保存；想用对方的值请点字段上的「采用新值」`,
      { duration: 6000 }
    )
  }
}

/** 切换段 / 切走 tab 之前把未提交的草稿落库 */
async function commitAll() {
  const v = active.value
  if (!v) return
  const prefix = `${v.group.id}|`
  const pending = Object.keys(drafts.value).filter((k) => k.startsWith(prefix))
  for (const k of pending) {
    await commitField(v.group.id, k.slice(prefix.length))
  }
}

watch(
  () => active.value?.group.id,
  async (_next, prev) => {
    if (prev) await commitAll()
  }
)

/**
 * 离开交付 tab（组件是 v-show 常驻的，不会卸载）也要落库。
 * 不落的话输入框里的内容停在草稿里，切回来看着还在、实际没存进后端，
 * 另一个窗口读到的就是旧值 —— 这就是"两处数据不一样"的来源。
 */
watch(
  () => props.active,
  async (now, before) => {
    if (before && !now) await commitAll()
  }
)

/** 切项目 / 离开工作台会把组件卸载掉，草稿得抢在之前发出去 */
onBeforeUnmount(() => {
  void commitAll()
})

/* ---------------- 锁定状态 ---------------- */

const lockedSet = computed(() => {
  const v = active.value
  if (!v) return new Set<string>()
  return new Set(assembly.lockedKeys(v.group.id))
})

async function unlockField(key: string) {
  const v = active.value
  if (!v || !project.currentId) return
  if (key === 'summary') await assembly.clearSummary(project.currentId, v.group.id)
  else await assembly.clearFields(project.currentId, v.group.id, [key])

  const k = draftKey(v.group.id, key)
  const next = { ...drafts.value }
  delete next[k]
  drafts.value = next
  message.success(`${key} 已恢复自动生成`)
}

async function unlockAll() {
  const v = active.value
  if (!v || !project.currentId) return
  await assembly.clearFields(project.currentId, v.group.id, schema.value.map((f) => f.key))
  await assembly.clearSummary(project.currentId, v.group.id)
  drafts.value = {}
  message.success('本段全部字段已恢复自动生成')
}

function rowsFor(groupId: ID, key: string) {
  const text = draftOf(groupId, key)
  return Math.min(18, Math.max(2, text.split('\n').length || 1))
}

/* ---------------- AI 修复 ---------------- */

async function applyPatches(patches: FixPatch[]) {
  const v = active.value
  const pid = project.currentId
  if (!v || !pid) return

  for (const p of patches) {
    // 修复写回当前工作语言那一侧（和页面上显示的、门禁看的保持同一份）
    const side = langOf(settings.value)
    if (p.field === 'summary') await assembly.setSummary(pid, v.group.id, p.value, side)
    else await assembly.setField(pid, v.group.id, p.field, p.value, side)
  }

  // 清掉本段未提交的草稿，否则旧草稿会在失焦时把刚写入的值盖回去
  const prefix = `${v.group.id}|`
  const next = { ...drafts.value }
  for (const k of Object.keys(next)) if (k.startsWith(prefix)) delete next[k]
  drafts.value = next

  message.success(`已应用 ${patches.length} 项修复`)
}

const SOURCE_LABEL: Record<string, string> = {
  derived: '引擎派生',
  llm: '模型生成',
  manual: '人工填写'
}

/**
 * 字段来源对应的胶囊样式。
 * 原来是 script 里硬编码的两个色值（#eaf0ff / #e9f7ef），和全站令牌是两套；
 * 现在统一成 .chip 变体：派生=信息蓝、模型=通过绿、人工=中性灰。
 */
const SOURCE_CHIP: Record<string, string> = {
  derived: 'info',
  llm: 'ok',
  manual: 'mute'
}

/**
 * 字段分组（主体 / 叙事 / 画面 / 声音 / 其他）。
 *
 * 分组是纯函数（domain/fieldGroups），这里只负责把 schema 喂进去 ——
 * 目录、导出预览以后要分组时用同一套口径，别各写一份。
 */
const fieldGroups = computed(() => groupFields(schema.value))

/** 这一组里还空着几个字段：卡头上直接说"这组还缺 2 个" */
function groupEmptyCount(g: { fields: FieldSchema[] }): number {
  return g.fields.filter((f) => !fieldValue(f.key).trim()).length
}

/** 检查卡头上的计数（错误 / 警告分开数，别混成一个数字） */
function countLevel(list: Array<{ level: string }>, level: 'error' | 'warn'): number {
  return list.filter((i) => i.level === level).length
}

/** 调阶段三的同一个补全流程：模型补全 llm 字段，写回本页可继续手工微调 */
async function fillSegments(targets: typeof views.value) {
  // 与 ④ 页同一条门禁：③ 有结构错误时补出来的字段，修完段又全过期
  if (!gate.gates.assemble.passed) {
    message.error(`还不能生成字段：${gate.gates.assemble.errors[0] ?? ''}`, { duration: 8000 })
    return
  }
  if (!provider.ready) {
    message.warning('请先配置模型供应商')
    return
  }
  if (!targets.length || !project.currentId) return

  const tasks = targets.map((v) => ({
    id: v.group.id,
    schema: schema.value,
    beats: v.beats,
    entities: registry.entities,
    seamFromPrev: v.seam,
    nextSeam: v.nextSeam,
    // 上下文用交付口径那份：en 模式下让模型看到的是英文终稿，不是空的中文稿
    existing: {
      ...v.delivery,
      summary: assembly.getSummary(v.group.id, langOf(settings.value)) || v.delivery.summary || ''
    },
    frames: v.frames,
    index: views.value.findIndex((x) => x.group.id === v.group.id)
  }))

  const res = await pipeline.fillSegments(
    tasks,
    settings.value,
    async (taskId, fields, err) => {
      if (err) return
      const summary = fields.summary
      const rest: Record<string, string> = { ...fields }
      delete rest.summary
      // 与单段生成同一条：写当前工作语言那一侧
      const side = langOf(settings.value)
      if (summary) await assembly.setSummary(project.currentId!, taskId, summary, side)
      if (Object.keys(rest).length) await assembly.setFields(project.currentId!, taskId, rest, side)
    },
    2
  )

  if (res.failed) message.warning(`成功 ${res.ok} 段，失败 ${res.failed} 段`)
  else message.success(`${res.ok} 段已补全`)
}

function genSummary() {
  if (active.value) void fillSegments([active.value])
}

function genAllSummaries() {
  void fillSegments(views.value)
}

/* ------------------------------------------------------------------ *
 * 单字段 AI
 *
 * 整段补全（段头那颗）是"这段我还没写，先铺一版"；这里这颗是
 * "六段里只有声景不满意，重写这一段这一项"。两者都得有 ——
 * 前者一次六字段会顺手改掉已经调好的两句，后者才敢反复点。
 *
 * 实现上复用同一条补全流程（同一份提示词、同一套字段规则），
 * 只是把 schema 收窄到这一个字段：模型看到的上下文完全一样，
 * 所以不会出现"单独生成"和"整段生成"两种口径。
 * ------------------------------------------------------------------ */

/** 正在生成哪一格：`groupId|fieldKey` */
const aiField = ref('')

const AI_FIELD_PRESETS: Record<string, string[]> = {
  summary: ['别重复台词', '点明主体保留自哪张参考图'],
  retention_analysis: ['说明悬念落在哪一拍', '别用夸张的宣传语'],
  detailed_description: ['逐拍写，不要概括', '补上光线与质感', '台词拍别写动作'],
  overall_soundscape: ['补上环境底噪', '别写配乐', '台词段：留出说话的气口'],
  non_diegetic_music: ['这段不要配乐，填 N/A', '给一段克制的弦乐']
}

async function genField(f: FieldSchema, brief = '') {
  const v = active.value
  if (!v || !project.currentId || f.source !== 'llm') return
  if (!gate.gates.assemble.passed) {
    message.error(`还不能生成字段：${gate.gates.assemble.errors[0] ?? ''}`, { duration: 8000 })
    return
  }
  if (!provider.ready) {
    message.warning('请先配置模型供应商')
    return
  }

  const busyKey = `${v.group.id}|${f.key}`
  aiField.value = busyKey
  try {
    const fields = await pipeline.runSegmentFill(
      {
        schema: [f],
        groupBeats: v.beats,
        entities: registry.entities,
        seamFromPrev: v.seam,
        nextSeam: v.nextSeam,
        existing: {
          ...v.delivery,
          summary: assembly.getSummary(v.group.id, langOf(settings.value)) || v.delivery.summary || ''
        },
        segmentIndex: views.value.findIndex((x) => x.group.id === v.group.id),
        segmentTotal: views.value.length,
        frames: v.frames,
        requirement: brief.trim() || undefined
      },
      settings.value
    )
    const value = (fields[f.key] ?? '').trim()
    if (!value) throw new Error('模型没有返回这一项内容')
    // 走草稿 → 提交：和手打一样落库，"采用新值 / 外部已更新"那套标记也跟着对
    onDraft(v.group.id, f.key, value)
    await commitField(v.group.id, f.key)
    message.success(`${fieldLabel(f)} 已生成`)
  } catch (e) {
    message.error((e as Error).message || '生成失败', { duration: 8000 })
  } finally {
    aiField.value = ''
  }
}

function copyText(text: string) {
  navigator.clipboard.writeText(text)
  message.success('已复制')
}

function exportJson() {
  return assembly.exportAssembly(views.value, schema.value, settings.value)
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function download() {
  downloadBlob(
    new Blob([exportJson()], { type: 'application/json' }),
    `${project.current?.name ?? 'segments'}-deliverable.json`
  )
  message.success('已导出')
}

/* ---------------- 导出弹窗（选类型 + 选段，都在弹窗里） ---------------- */

type ExportKind = 'clips' | 'pack'

/**
 * 导出是一个独立的弹窗：先选"导什么"，再在里面选"哪几段"。
 *
 * 以前是两条路——顶部「导出」只出导演包、且段是写死的全片；「分段导出」要
 * 先回左侧列表勾选。同一件事被拆成两处，用户很容易在左侧勾了半天、
 * 又点了顶部那个（它根本不管勾选），或者反过来。
 */
const exportKind = ref<ExportKind>('clips')

function openExportDialog(kind: ExportKind = exportKind.value, pick: 'all' | 'keep' = 'all') {
  exportKind.value = kind
  openSegExport(undefined, pick)
  // 上次停在二采：这次打开同样要先检一遍，不能拿上一批旧结果让人挑
  if (showSegExport.value && exportSource.value === 'second') void detectSecond()
}

/** 段详情里的「导出这段」：带上这一段的链，打开同一个弹窗 */
function openExportOne(index: number) {
  exportKind.value = 'clips'
  openSegExport([index], 'keep')
  if (showSegExport.value && exportSource.value === 'second') void detectSecond()
}

/* ---------------- 导演包导出 ---------------- */

const packWidth = ref(DEFAULT_OUTPUT_WIDTH)
const packHeight = ref(DEFAULT_OUTPUT_HEIGHT)
const packBusy = ref(false)

watch(
  () => [settings.value.outputWidth, settings.value.outputHeight],
  ([w, h]) => {
    packWidth.value = Number(w) || DEFAULT_OUTPUT_WIDTH
    packHeight.value = Number(h) || DEFAULT_OUTPUT_HEIGHT
  },
  { immediate: true }
)

const packInput = computed<PackBuildInput>(() => ({
  projectName: project.current?.name ?? '',
  settings: settings.value,
  // 段级参考素材（关键帧 / 音视频）也在这里摊平，与运行台共用同一份实现
  segments: views.value.map((v) =>
    packSegmentOf(v, schema.value, registry.entityById, registry.assets, settings.value)
  ),
  assets: registry.assets,
  width: packWidth.value,
  height: packHeight.value
}))

/** 导出前就把问题摆出来，别等导入端静默清空槽位才发现 */
const packWarnings = computed(() => {
  if (!views.value.length) return []
  // 图片本体还没补回来时算出来的警告是假的（会误报"没有上传任何素材"）
  if (!assetsReady.value) return []
  try {
    return buildDirectorPack(packInput.value).warnings
  } catch {
    return []
  }
})

/** 每段对面会显示的秒数（24fps 重算后的帧数要能对上） */
const packTotalSec = computed(() =>
  views.value.reduce((s, v) => s + preferredDurationSecFromFrames(v.frames), 0)
)

/* ---------------- 导出门禁：error 级问题不再静默放行 ---------------- */

/** 当前交付页上全部 error 级问题（段级 + 全片级） */
const exportErrors = computed(() => {
  const out: Array<{ ruleId: string; message: string }> = []
  for (const v of views.value)
    for (const i of v.issues) if (i.level === 'error') out.push(i)
  for (const i of globalIssues.value) if (i.level === 'error') out.push(i)
  return out
})

const showPackConfirm = ref(false)

async function exportPack() {
  if (!views.value.length) return
  if (exportErrors.value.length) {
    showPackConfirm.value = true
    return
  }
  await doExportPack()
}

async function doExportPack() {
  packBusy.value = true
  try {
    const w = snapCanvas(packWidth.value, DEFAULT_OUTPUT_WIDTH)
    const h = snapCanvas(packHeight.value, DEFAULT_OUTPUT_HEIGHT)
    packWidth.value = w
    packHeight.value = h
    if (project.currentId) await project.updateSettings({ outputWidth: w, outputHeight: h })

    const res = await buildDirectorPackZip({ ...packInput.value, width: w, height: h })
    downloadBlob(res.blob, res.filename)
    message.success(res.warnings.length ? `导演包已导出（${res.warnings.length} 条提醒）` : '导演包已导出')
  } catch (err) {
    message.error(`导演包导出失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    packBusy.value = false
  }
}

function openSchema() {
  // project.fieldSchema 是响应式数组（Proxy），structuredClone 会抛 DataCloneError
  schemaDraft.value = deepClone(schema.value)
  showSchema.value = true
}

async function saveSchema() {
  await project.updateFieldSchema(schemaDraft.value)
  showSchema.value = false
  message.success('字段 Schema 已保存')
}

function addSchemaRow() {
  schemaDraft.value.push({
    key: `field_${schemaDraft.value.length + 1}`,
    label: '',
    order: schemaDraft.value.length + 1,
    source: 'manual',
    editable: true,
    required: false,
    lang: 'any'
  })
}

function moveSchema(idx: number, dir: -1 | 1) {
  const to = idx + dir
  if (to < 0 || to >= schemaDraft.value.length) return
  const arr = schemaDraft.value
  ;[arr[idx], arr[to]] = [arr[to], arr[idx]]
}
</script>

<template>
  <div style="height: 100%; display: flex; flex-direction: column">
    <div class="panel-head dl-head" style="border-radius: 0">
      <div class="row" style="gap: 10px; flex-wrap: wrap; min-width: 0">
        <span>交付</span>
        <n-tag size="small" :bordered="false">{{ views.length }} 段</n-tag>
        <n-tag v-if="!finalMode" size="small" type="warning" :bordered="false">中文工作稿</n-tag>
        <n-tag v-else size="small" type="success" :bordered="false">英文终稿</n-tag>
        <n-tag v-if="stats.errors" size="small" type="error" :bordered="false">
          {{ stats.errors }} 个错误
        </n-tag>
        <n-tag v-if="stats.warns" size="small" type="warning" :bordered="false">
          {{ stats.warns }} 个警告
        </n-tag>
        <n-tag v-if="prodRows.length" size="small" type="success" :bordered="false">
          一采 {{ prodFirstCount }}/{{ prodRows.length }}
        </n-tag>
        <n-tag v-if="prodRows.length" size="small" type="info" :bordered="false">
          二采 {{ prodSecondCount }}/{{ prodRows.length }}
        </n-tag>
        <n-tag v-if="prodStaleCount" size="small" type="warning" :bordered="false">
          {{ prodStaleCount }} 段缓存在旧内容上
        </n-tag>
      </div>
      <div class="row" style="gap: 8px; flex-wrap: wrap; justify-content: flex-end; margin-left: auto">
        <n-button
          size="small"
          quaternary
          title="这一集的产物缓存目录：生成时自动绑定，剧集改名也不换目录"
          @click="openBind"
        >
          缓存目录
          <span class="tag-chip bind-chip" :class="{ ok: bindingReady }" style="margin-left: 6px">
            {{ bindingText }}
          </span>
        </n-button>
        <n-button
          size="small"
          quaternary
          :loading="prodLoading"
          title="重新读一遍 ComfyUI 缓存：段号与缓存槽是否还对得上"
          @click="refreshProducts"
        >
          重新探测
        </n-button>
        <n-button size="small" quaternary :disabled="!films.length" @click="showFilm = true">
          整片成片
          <span v-if="films.length" class="tag-chip" style="margin-left: 6px">{{ films.length }}</span>
        </n-button>
        <n-button size="small" quaternary @click="openSchema">字段配置</n-button>
        <n-button
          size="small"
          type="warning"
          ghost
          :disabled="!active || !fixableCount || !provider.ready"
          @click="showFix = true"
        >
          AI 修复问题{{ fixableCount ? `（${fixableCount}）` : '' }}
        </n-button>
        <n-button size="small" :disabled="!views.length || !provider.ready" @click="genAllSummaries">
          全部段 AI 生成
        </n-button>
        <n-button
          size="small"
          type="primary"
          :disabled="!views.length"
          :title="
            views.length
              ? `打开导出弹窗：选类型（分段成片 / 导演包）与要导出的段，共 ${views.length} 段`
              : '还没有可交付的段：先去「③ 组合与缝合」生成方案'
          "
          @click="openExportDialog()"
        >
          导出
        </n-button>
      </div>
    </div>

    <!-- 统一运行参数：一条通栏，作用于本集所有段（不是"这一次运行"的草稿） -->
    <details v-if="views.length" class="pipe-bar">
      <summary class="pipe-head">
        <span class="pipe-title">统一运行参数</span>
        <span class="tag-chip pipe-chip" :class="{ ok: pipeReady }">{{ pipeSummary }}</span>
        <span class="muted pipe-hint">本集所有段共用一套 · 改完立即写回运行配置</span>
        <span class="pipe-toggle"></span>
      </summary>

      <div class="pipe-groups">
        <!-- 一采：一次采样的全部旋钮，按「模型与采样 / 调度 / 画布」三段收进来 -->
        <section class="mod mod-first mod-tall">
          <header class="mod-head">
            <span class="mod-tag">1</span>
            <span class="mod-title">一采参数</span>
            <InfoTip size="sm" :width="280" text="三个运行按钮都要先走这一段。" />
            <span class="mod-meta mono">{{ pipe.width }} × {{ pipe.height }}</span>
          </header>
          <div class="mod-body">
            <div class="fieldset">
              <div class="fieldset-head">模型与采样</div>
              <div class="pipe-grid">
                <label class="param">
                  <span>模型口</span>
                  <n-select
                    size="small"
                    :value="pipe.runModel"
                    :options="runModelOptions.map((s) => ({ label: s, value: s }))"
                    @update:value="(v: string) => setPipe({ runModel: v })"
                  />
                </label>
                <label class="param">
                  <span>种子</span>
                  <n-input-number
                    size="small"
                    :show-button="false"
                    :value="pipe.seed"
                    :disabled="pipe.randomSeed"
                    @update:value="(v: number | null) => setPipe({ seed: v ?? 0 })"
                  />
                </label>
                <label class="param">
                  <span>随机种子</span>
                  <n-switch
                    size="small"
                    :value="pipe.randomSeed"
                    @update:value="(v: boolean) => setPipe({ randomSeed: v })"
                  />
                </label>
                <label class="param">
                  <span>步数</span>
                  <n-input-number
                    size="small"
                    :min="1"
                    :max="200"
                    :value="pipe.steps"
                    @update:value="(v: number | null) => setPipe({ steps: v ?? 1 })"
                  />
                </label>
                <label class="param">
                  <span>CFG</span>
                  <n-input-number
                    size="small"
                    :min="0"
                    :max="30"
                    :step="0.05"
                    :value="pipe.cfg"
                    @update:value="(v: number | null) => setPipe({ cfg: v ?? 1 })"
                  />
                </label>
                <label class="param">
                  <span>采样器</span>
                  <n-select
                    size="small"
                    filterable
                    :value="pipe.sampler"
                    :options="samplerOptions.map((s) => ({ label: s, value: s }))"
                    @update:value="(v: string) => setPipe({ sampler: v })"
                  />
                </label>
                <label class="param">
                  <span>调度器</span>
                  <n-select
                    size="small"
                    filterable
                    :value="pipe.scheduler"
                    :options="schedulerOptions.map((s) => ({ label: s, value: s }))"
                    @update:value="(v: string) => setPipe({ scheduler: v })"
                  />
                </label>
              </div>
            </div>

            <div class="fieldset">
              <div class="fieldset-head">调度曲线</div>
              <div class="pipe-grid">
                <label class="param">
                  <span>shift 视频</span>
                  <n-input-number
                    size="small"
                    :min="0.01"
                    :max="100"
                    :step="0.5"
                    :value="pipe.shiftVideo"
                    @update:value="(v: number | null) => setPipe({ shiftVideo: v ?? 12 })"
                  />
                </label>
                <label class="param">
                  <span>shift 音频</span>
                  <n-input-number
                    size="small"
                    :min="0.01"
                    :max="100"
                    :step="0.5"
                    :value="pipe.shiftAudio"
                    @update:value="(v: number | null) => setPipe({ shiftAudio: v ?? 3 })"
                  />
                </label>
                <label class="param">
                  <span>用 sigmas</span>
                  <n-switch
                    size="small"
                    :value="pipe.useSigmas"
                    @update:value="(v: boolean) => setPipe({ useSigmas: v })"
                  />
                </label>
                <label class="param param-wide">
                  <span>sigmas</span>
                  <n-input
                    size="small"
                    :value="pipe.sigmas"
                    placeholder="留空 = 不动图上现有调度；例：0.85, 0.5（1 步）"
                    @update:value="(v: string) => setPipe({ sigmas: v })"
                  />
                </label>
                <div v-if="pipe.sigmas.trim()" class="param-hint">
                  接了 sigmas 之后步数 = 条数 − 1 =
                  <b>{{ sigmasStepCount(pipe.sigmas) }}</b> 步，上面那个「步数」不再参与调度。
                </div>
              </div>
            </div>

            <div class="fieldset">
              <div class="fieldset-head">
                画布与任务
                <InfoTip
                  size="sm"
                  :width="340"
                  text="宽高由「密度 ÷ 比例」反解并按 32 取整（导演包会 snap 到 32）；改比例保持密度不变。&#10;帧率 / 总帧数 / 参考图上限在运行页。"
                />
              </div>
              <div class="pipe-grid">
                <label class="param param-wide">
                  <span>任务类型</span>
                  <n-select
                    size="small"
                    :value="pipe.taskType"
                    :options="taskTypeOptions"
                    @update:value="(v: string) => setPipe({ taskType: v })"
                  />
                </label>
                <!-- 画布就在一采里：只给一个密度，右边直接读出分辨率 -->
                <label class="param param-wide canvas-line">
                  <span>像素密度</span>
                  <div class="canvas-row">
                    <n-input-number
                      size="small"
                      class="canvas-mp"
                      :min="0.01"
                      :max="16"
                      :step="0.01"
                      :value="mpValue"
                      @update:value="(v: number | null) => setPipeMegapixels(v)"
                    />
                    <span class="canvas-unit">MP</span>
                    <span class="canvas-arrow">→</span>
                    <span class="canvas-out mono">{{ pipe.width }} × {{ pipe.height }}</span>
                    <n-select
                      size="small"
                      class="canvas-ratio"
                      :value="ratioValue"
                      :options="ratioOptions"
                      @update:value="(v: string) => applyRatio(v)"
                    />
                  </div>
                </label>
              </div>
            </div>
          </div>
        </section>

        <!-- 二采：节点上只有模型口 / 种子 / 采样器 / sigmas / 放大尺寸这几样，所以只给这几样 -->
        <section class="mod mod-second">
          <header class="mod-head">
            <span class="mod-tag">2</span>
            <span class="mod-title">二采参数</span>
            <InfoTip
              size="sm"
              :width="400"
              :text="
                '跑不跑由底部三个运行按钮决定。\n\n' +
                `种子是节点内置的固定值（${SECOND_SEED_FIXED}），不跟一采的随机种子。调度器不参与 —— 二采恒走显式 sigmas，σ 的形状就是那串 sigmas 本身（换采样器只换解法，不改 σ）。\n\n` +
                `密度写在放大节点上，1.0 MP = 1024²（一采 ${pipe.width}×${pipe.height} → 二采 ${secondSize.width}×${secondSize.height}）；要精确 720p / 按倍率 / 指定尺寸，到工作流控制台改同一个放大节点。`
              "
            />
            <span class="mod-meta mono">
              {{ secondSize.width }} × {{ secondSize.height }}
            </span>
          </header>
          <div class="mod-body">
            <div class="fieldset">
              <div class="fieldset-head">模型与采样</div>
              <div class="pipe-grid">
                <label class="param">
                  <span>模型口</span>
                  <n-select
                    size="small"
                    :value="pipe.secondRunModel"
                    :options="secondRunModelOptions.map((s) => ({ label: s, value: s }))"
                    @update:value="(v: string) => setPipe({ secondRunModel: v })"
                  />
                </label>
                <label class="param">
                  <span>种子</span>
                  <n-input-number
                    size="small"
                    :min="0"
                    :step="1"
                    :value="pipe.secondSeed"
                    title="二采固定种子（节点内置 20240）：走自己的噪声场，不跟一采的种子，也不跟一采的「随机种子」"
                    @update:value="(v: number | null) => setPipe({ secondSeed: v ?? SECOND_SEED_FIXED })"
                  />
                </label>
                <label class="param">
                  <span>采样器</span>
                  <n-select
                    size="small"
                    :value="pipe.secondSampler"
                    :options="secondSamplerOptions"
                    title="二采自己的求解器。选「跟随一采」= 与一次采样同一个；节点未接 second_sigmas 时跟的是海螺二采默认的 euler"
                    @update:value="(v: string) => setPipe({ secondSampler: v })"
                  />
                </label>
                <!-- 二采没有步数输入：步数就是 sigmas 条数 − 1，这里只把它显示出来 -->
                <div class="param">
                  <span>步数</span>
                  <span class="readout mono" title="步数 = sigmas 条数 − 1">
                    {{ secondSteps }} 步
                  </span>
                </div>
              </div>
            </div>

            <div class="fieldset">
              <div class="fieldset-head">σ 与放大</div>
              <div class="pipe-grid">
                <label class="param param-wide">
                  <span>sigmas</span>
                  <n-input
                    size="small"
                    :value="pipe.secondSigmas"
                    placeholder="留空 = 用图上现有接线；例：0.85, 0.5（1 步）"
                    @update:value="(v: string) => setPipe({ secondSigmas: v })"
                  />
                </label>
                <!-- 二采的画布同理：一个密度，右边给放大后的分辨率 -->
                <label class="param param-wide canvas-line">
                  <span>像素密度</span>
                  <div class="canvas-row">
                    <n-input-number
                      size="small"
                      class="canvas-mp"
                      :min="0.1"
                      :max="16"
                      :step="0.01"
                      :value="secondMegapixelsShown"
                      @update:value="(v: number | null) => setSecondMegapixels(v)"
                    />
                    <span class="canvas-unit">MP</span>
                    <span class="canvas-arrow">→</span>
                    <span class="canvas-out mono">
                      {{ secondSize.width }} × {{ secondSize.height }}
                    </span>
                    <span class="canvas-times">×{{ secondSize.scale }}</span>
                  </div>
                </label>
              </div>
            </div>
          </div>
        </section>

        <!-- 选卡：右列第二块（二采下面）。多卡只有复制型，没有可调的切分 -->
        <section class="mod mod-cards mod-right2">
          <header class="mod-head">
            <span class="mod-tag">3</span>
            <span class="mod-title">选卡</span>
            <InfoTip
              size="sm"
              :width="380"
              :text="
                '复制型：每张卡装一份完整模型。\n勾几张就走几张，段按「段 n → 卡 n % 卡数」轮流落卡并走波前 —— 没有可调的切分。\n清缓存 = 提交前清掉本集这一跑的缓存（换 TE kernel / 量化后必清）。' +
                (cardsUnknown ? '\n当前没读到 ComfyUI 的可见卡数，勾选仍会原样写进 pipeline_cards。' : '')
              "
            />
            <span class="mod-meta mono">
              {{ cardPicked.length ? `${cardPicked.length} 张` : '单卡' }}
            </span>
          </header>
          <div class="mod-body">
            <div class="fieldset">
              <div class="fieldset-head">用哪几张</div>
              <div class="card-picks">
                <n-checkbox
                  v-for="c in cardList"
                  :key="c"
                  size="small"
                  :checked="cardPicked.includes(c)"
                  @update:checked="() => toggleCardPipe(c)"
                >
                  卡 {{ c }}
                  <!-- 配置里存着、但 ComfyUI 这次看不见：提交会被拦，先标出来 -->
                  <span v-if="visibleCardCount > 0 && c >= visibleCardCount" class="card-unseen">
                    不可见
                  </span>
                </n-checkbox>
                <!-- ComfyUI 没连上时读不到可见卡数：给个手填口，别让这一项变成死路 -->
                <n-input
                  v-if="!cardList.length"
                  size="small"
                  style="width: 140px"
                  :value="pipe.cards"
                  placeholder="0,1,2 或 关闭"
                  @update:value="(v: string) => setPipe({ cards: v })"
                />
                <span v-if="!cardList.length" class="card-empty">
                  {{
                    cardsReading
                      ? '正在读可见卡…'
                      : '没读到可见卡（ComfyUI 没连上）：点右边「重新读取」，或直接手填'
                  }}
                </span>
                <!-- 动作贴着勾选行右端，不另起一行（另起一行会空出一条假分隔） -->
                <span class="card-actions">
                  <n-button size="tiny" quaternary :loading="cardsReading" @click="refreshCards">
                    重新读取
                  </n-button>
                  <n-button size="tiny" quaternary :disabled="!cardPicked.length" @click="clearCards">
                    全不选（单卡）
                  </n-button>
                </span>
              </div>
            </div>

            <div class="fieldset">
              <div class="pipe-grid">
                <label class="param">
                  <span>当前</span>
                  <span class="readout mono">
                    {{ cardPicked.length ? '卡 ' + cardPicked.join(',') : '关闭（单卡原样）' }}
                  </span>
                </label>
                <label class="param">
                  <span>清缓存</span>
                  <n-switch
                    size="small"
                    :value="pipe.clearCacheOnSubmit"
                    @update:value="(v: boolean) => setPipe({ clearCacheOnSubmit: v })"
                  />
                </label>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div class="pipe-foot" style="display: flex; align-items: center; gap: 4px">
        <span>模型文件 / LoRA / 加速在工作流控制台里配</span>
        <InfoTip
          :width="420"
          :text="
            '选段后「批量进流水线」就是一次提交：勾中的段在同一份时间线里依次生成，未勾选的段缓存原样保留。\n' +
            '带「引用上段」的段在一采可以单段跑（上游不跑时沿用上次末帧），二采才按整条链补齐。' +
            (runCfg ? `参数写入「${runCfg.name}」。\n` : '\n') +
            '导演台剩下那批冷门参数（global_prompt、各种开关）在运行页的「导演台其余参数」里。'
          "
        />
        <n-button size="tiny" text type="primary" @click="router.push('/run')">运行页 →</n-button>
      </div>
    </details>

    <div v-if="!views.length" class="empty" style="flex: 1">
      <div>还没有可交付的段，先到「阶段三 · 组合与缝合」生成方案</div>
    </div>

    <div v-else style="flex: 1; min-height: 0; display: flex">
      <!-- 段列表 + 批量条（竖排：列表自己滚，批量条钉在底部） -->
      <div class="seg-rail">
      <div class="seg-rail-list">
        <div
          v-for="(v, i) in views"
          :key="v.group.id"
          class="panel seg-item"
          :class="{ on: activeSegment === i, picked: isPicked(i) }"
          @click="activeSegment = i"
        >
          <div class="row-between">
            <div class="row" style="gap: 6px; min-width: 0">
              <n-checkbox
                :checked="isPicked(i)"
                size="small"
                @click.stop
                @update:checked="togglePick(i)"
              />
              <span style="font-weight: 600">seg{{ String(i + 1).padStart(2, '0') }}</span>
              <span
                v-if="i > 0 && linked[i]"
                class="seg-ref"
                :title="`引用上段：生成时用 seg${String(i).padStart(2, '0')} 的末帧当参考，两段同属一条链`"
              >
                ↳ 引用上段
              </span>
            </div>
            <span class="muted mono" style="font-size: 11px">{{ v.frames }}f</span>
          </div>
          <div class="row" style="gap: 4px; margin-top: 4px; flex-wrap: wrap">
            <span v-if="v.over" class="tag-chip err">超限</span>
            <span
              v-else-if="v.nextSeam?.kind === 'transition'"
              class="tag-chip warn"
            >
              {{ v.nextSeam.blackFallback ? '黑屏' : '转场' }}
            </span>
            <span
              v-if="v.issues.some((x) => x.level === 'error')"
              class="tag-chip"
              style="background: var(--err-soft); color: var(--err-ink)"
            >
              {{ v.issues.filter((x) => x.level === 'error').length }} 错
            </span>
            <span
              v-if="chainTag(i)"
              class="tag-chip seg-chain"
              :title="`引用上段：本段和 ${chainTag(i)} 同属一条链。一采可以只跑这一段，二采要整条链一起跑`"
            >
              链 {{ chainTag(i) }}
            </span>
            <span class="tag-chip seg-prod" :class="productHint(i).tone">
              {{ productHint(i).text }}
            </span>
          </div>
        </div>
      </div>

      <!-- 批量条：统一参数 + 选段进流水线。参数是常驻的，不是"这一次的草稿" -->
      <div v-if="prodRows.length" class="bulk-bar">
        <div class="row" style="gap: 6px; flex-wrap: wrap">
          <n-checkbox
            :checked="allPicked"
            @update:checked="(val: boolean) => (val ? pickAll() : clearPick())"
          >
            <span style="font-size: 12px">全选</span>
          </n-checkbox>
          <span class="muted" style="font-size: 11.5px">{{ pickSummary }}</span>
        </div>

        <div v-if="picked.length" class="muted" style="font-size: 11px; line-height: 1.6">
          {{ pickedLabels }} · {{ pickedFrames }}f · {{ pickedSeconds.toFixed(1) }}s
        </div>
        <div v-if="hasChains" class="muted seg-chain-hint">
          引用上段成链<template v-if="picked.length">（当前勾选覆盖 {{ pickedChains }} 条链）</template>
          <InfoTip
            size="sm"
            :width="330"
            text="一采勾哪段跑哪段（上游不跑时沿用上次末帧）· 二采自动按整条链补齐。"
          />
        </div>
        <div class="row" style="gap: 6px; flex-wrap: wrap">
          <n-button
            size="tiny"
            :title="
              picked.length
                ? `打开导出弹窗，已按当前勾选带入 ${picked.length} 段`
                : '打开导出弹窗：在里面直接选段'
            "
            @click="openExportDialog('clips', 'keep')"
          >
            分段导出
          </n-button>
          <n-button
            v-for="o in secondStageOptions"
            :key="o.value"
            size="tiny"
            :type="o.value === 'off' ? 'default' : 'primary'"
            :secondary="o.value === 'off'"
            :title="`${o.label}：${o.hint}`"
            :disabled="!picked.length || !pipeReady"
            :loading="submitting && pipe.secondStage === o.value"
            @click="runStage(o.value)"
          >
            {{ o.label }}
          </n-button>
        </div>
      </div>
      </div>

      <!-- 字段编辑 -->
      <div style="flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column">
        <div style="flex: 1; min-height: 0; position: relative; display: flex">
        <div class="scroll-pane" id="dl-fields" style="flex: 1; padding: 16px">
        <n-alert v-if="orphanCount" type="error" :bordered="false" style="margin-bottom: 12px">
          有 {{ orphanCount }} 个片段不在任何段里，不会出现在交付结果里。
          <InfoTip :width="300" text="去「③ 组合与缝合」把它们并入相邻段。" />
        </n-alert>
        <n-alert v-if="unboundCount" type="error" :bordered="false" style="margin-bottom: 12px">
          有 {{ unboundCount }} 个片段缺场景 / 说话人绑定，交付结果不可信。
          <InfoTip
            :width="360"
            text="组合时这些片段会被跳过，或带着「未指定场景」错误留在段里。&#10;回「② 细节填充」补好绑定，再回「③」重新组合。"
          />
        </n-alert>
        <div v-if="staleCount" class="stale-box">
          <div class="stale-line">
            <b>{{ staleCount }} 段模型字段已过期</b>
            <InfoTip
              size="sm"
              :width="340"
              text="上游片段或主体改过，这些段的字段是在旧内容上生成的。&#10;回「③ 组合与缝合」下面那块，点「补空缺 + 重生成过期」。"
            />
          </div>
          <div class="stale-chips">
            <button
              v-for="s in staleRows"
              :key="s.v.group.id"
              class="tag-chip warn stale-chip"
              :title="`${staleWhyText(s.v)}（点击切到这一段）`"
              @click="activeSegment = s.i"
            >
              seg{{ String(s.i + 1).padStart(2, '0') }}
            </button>
          </div>
        </div>
        <div v-if="!finalMode" class="dl-mini">
          中文工作稿
          <InfoTip
            :width="380"
            text="交付前请到「④ 中英本地化」做一次转换：派生字段会由引擎用英文词条重新渲染，模型字段（summary / overall_soundscape / non_diegetic_music）需要翻译一遍。"
          />
        </div>
        <div v-else-if="cjkFields.length" class="dl-mini is-err">
          已切英文终稿，但仍有 {{ cjkFields.length }} 处字段残留中文
          <InfoTip
            :width="320"
            text="多半是词条表没翻全。回「④ 中英本地化」补翻词条后再看。"
          />
        </div>

        <n-alert
          v-if="active && active.issues.filter((i) => i.level === 'error').length"
          type="error"
          :bordered="false"
          style="margin-bottom: 12px"
        >
          <div class="row-between">
            <span>
              {{ active.issues.filter((i) => i.level === 'error').length }} 个错误需要处理
              <span v-if="fixableCount" class="muted">· 其中 {{ fixableCount }} 个可交给 AI 修</span>
            </span>
            <n-button
              size="tiny"
              type="warning"
              ghost
              :disabled="!fixableCount || !provider.ready"
              @click="showFix = true"
            >
              AI 修复
            </n-button>
          </div>
        </n-alert>

        <template v-if="active">
          <div id="dl-overview" class="panel dl-block">
            <div class="panel-head">
              <div class="row" style="gap: 8px">
                <span class="mono" style="font-weight: 600">
                  seg{{ String(activeSegment + 1).padStart(2, '0') }}
                </span>
                <span class="mono" style="font-size: 12px; color: var(--label)">
                  {{ active.rawFrames }}
                  <span
                    v-if="active.padTotal"
                    :style="{ color: active.padTotal > 0 ? 'var(--warn-ink)' : 'var(--accent-ink)' }"
                  >
                    {{ formatPad(active.padTotal) }}
                  </span>
                  = {{ active.frames }} 帧
                </span>
                <span class="muted mono" style="font-size: 12px">
                  {{ secondsFromFrames(active.frames, settings.fps).toFixed(3) }}s ·
                  {{ active.beats.length }} 拍
                </span>
                <span class="chip" :class="active.aligned ? 'ok' : 'err'">
                  {{ active.refPrev ? '17k · 引用上段' : '5+17k · 不引用' }}
                </span>
                <span
                  v-if="chainTag(activeSegment)"
                  class="tag-chip seg-chain"
                  :title="`这一段引用上段，和 ${chainTag(activeSegment)} 是一条链。一采可以只跑这一段（沿用上次末帧），二采要整条链一起跑`"
                >
                  链 {{ chainTag(activeSegment) }}
                </span>
                <span v-if="active.over" class="chip err">超限</span>
              </div>
              <div class="row" style="gap: 8px">
                <n-button
                  size="tiny"
                  quaternary
                  :disabled="lockedSet.size === 0"
                  @click="unlockAll"
                >
                  全部恢复自动
                </n-button>
                <n-button size="tiny" :disabled="!provider.ready" @click="genSummary">
                  AI 补全本段字段
                </n-button>
                <n-button
                  size="tiny"
                  quaternary
                  @click="copyText(composeSegmentText(schema, active.fields))"
                >
                  复制全文
                </n-button>
              </div>
            </div>
            <div v-if="active.seam" class="panel-body">
              <SeamPanel
                :seam="active.seam"
                :index="activeSegment"
                :entity-by-id="registry.entityById"
              />
            </div>
          </div>

          <n-alert v-if="prodError" type="warning" :bordered="false" style="margin-bottom: 12px">
            {{ prodError }}
          </n-alert>

          <!-- 这一段的产物就长在这一段上：一采/二采 + 只作用于这段的两个动作 -->
          <SegmentOutput
            id="dl-output"
            :row="activeProduct"
            :loading="prodLoading"
            :hint="prodHint"
            :result="active?.result ?? null"
            @run="openRun([activeSegment])"
            @export="openExportOne(activeSegment)"
          />

          <!--
            字段按语义分组。
            六个字段一路平铺时，人只能用「第几个」来记位置；分组之后每个模块
            有自己的颜色身份和一句说明，「这段还缺什么」变成「哪个模块还空着」。
          -->
          <section
            v-for="g in fieldGroups"
            :key="g.id"
            :id="'dl-g-' + g.id"
            class="dl-mod"
            :class="`tone-${g.tone}`"
          >
            <header class="dl-mod-head">
              <span class="dl-mod-bar" aria-hidden="true" />
              <span class="dl-mod-title">{{ g.label }}</span>
              <span class="chip mute mono">{{ g.fields.length }}</span>
              <span class="dl-mod-hint">{{ g.hint }}</span>
              <span v-if="groupEmptyCount(g) > 0" class="chip warn" style="margin-left: auto">
                {{ groupEmptyCount(g) }} 个空
              </span>
            </header>

            <div class="dl-mod-body">
              <FieldRow
                v-for="f in g.fields"
                :key="f.key"
                :id="'dl-f-' + f.key"
                class="dl-field"
                :label="fieldLabel(f)"
                :field-key="f.key"
                :tone="
                  !fieldValue(f.key).trim()
                    ? 'empty'
                    : draftConflict(active.group.id, f.key)
                      ? 'warn'
                      : 'plain'
                "
              >
                <div class="dl-field-meta">
                  <span class="mono dl-field-key">{{ f.key }}</span>
                  <span class="chip" :class="SOURCE_CHIP[f.source] ?? 'mute'">
                    {{ SOURCE_LABEL[f.source] ?? f.source }}
                  </span>
                  <span
                    v-if="lockedSet.has(f.key)"
                    class="chip warn"
                    title="已手改锁定，引擎不再自动派生这个字段"
                  >
                    手改锁定
                  </span>
                  <span v-if="!fieldValue(f.key).trim()" class="chip err">空</span>
                  <span
                    v-if="draftConflict(active.group.id, f.key)"
                    class="chip warn"
                    title="你改这个字段的同时，别处也改过它"
                  >
                    外部已更新
                  </span>
                  <span class="dl-field-spacer" />
                  <AiWrite
                    v-if="f.source === 'llm'"
                    :title="`生成「${fieldLabel(f)}」`"
                    :hint="fieldHint(f) || f.promptHint || '只重写这一项，其余字段不动。'"
                    :presets="AI_FIELD_PRESETS[f.key] ?? ['换个写法', '别堆形容词，写具体']"
                    :busy="aiField === `${active.group.id}|${f.key}`"
                    :disabled="
                      !provider.ready ||
                      (!!aiField && aiField !== `${active.group.id}|${f.key}`)
                    "
                    :disabled-reason="provider.ready ? '另一个字段正在生成' : '还没配置文本模型'"
                    variant="chip"
                    label="AI 写"
                    :placement="'bottom-end'"
                    @run="(brief: string) => genField(f, brief)"
                  />
                  <button
                    v-if="draftConflict(active.group.id, f.key)"
                    class="dl-mini"
                    @click="adoptLibValue(active.group.id, f.key)"
                  >
                    采用新值
                  </button>
                  <button
                    v-if="lockedSet.has(f.key)"
                    class="dl-mini"
                    @click="unlockField(f.key)"
                  >
                    恢复自动
                  </button>
                  <button class="dl-mini" @click="copyText(fieldValue(f.key))">复制</button>
                </div>
                <textarea
                  class="dl-field-input"
                  :rows="rowsFor(active.group.id, f.key)"
                  :value="draftOf(active.group.id, f.key)"
                  :placeholder="f.promptHint ?? ''"
                  @input="onDraft(active.group.id, f.key, ($event.target as HTMLTextAreaElement).value)"
                  @blur="commitField(active.group.id, f.key)"
                />
              </FieldRow>
            </div>
          </section>

          <section v-if="active.issues.length" id="dl-seg-check" class="dl-check">
            <header class="dl-check-head">
              <span class="dl-check-bar warn" aria-hidden="true" />
              <span class="dl-check-title">本段检查</span>
              <span v-if="countLevel(active.issues, 'error')" class="chip err">
                {{ countLevel(active.issues, 'error') }} 错
              </span>
              <span v-if="countLevel(active.issues, 'warn')" class="chip warn">
                {{ countLevel(active.issues, 'warn') }} 警告
              </span>
              <span class="dl-mod-hint">这一段自己的问题，改字段就能修</span>
            </header>
            <div class="dl-check-body">
              <div
                v-for="(i, k) in active.issues"
                :key="k"
                class="issue"
                :class="i.level"
              >
                <span class="mono" style="opacity: 0.7">{{ i.ruleId }}</span>
                <span>{{ i.message }}</span>
              </div>
            </div>
          </section>
        </template>

        <section v-if="globalIssues.length" id="dl-global-check" class="dl-check">
          <header class="dl-check-head">
            <span class="dl-check-bar" aria-hidden="true" />
            <span class="dl-check-title">全片检查</span>
            <span v-if="countLevel(globalIssues, 'error')" class="chip err">
              {{ countLevel(globalIssues, 'error') }} 错
            </span>
            <span v-if="countLevel(globalIssues, 'warn')" class="chip warn">
              {{ countLevel(globalIssues, 'warn') }} 警告
            </span>
            <span class="dl-mod-hint">跨段的问题：主体、参考图、衔接</span>
          </header>
          <div class="dl-check-body">
            <div v-for="(i, k) in globalIssues" :key="k" class="issue" :class="i.level">
              <span class="mono" style="opacity: 0.7">{{ i.ruleId }}</span>
              <span>{{ i.message }}</span>
            </div>
          </div>
        </section>
        </div>
        <SectionNav v-if="fieldNav.length >= 2" title="本段字段" container="#dl-fields" :items="fieldNav" />
        </div>
      </div>
    </div>

    <StageAdvice
      stage="deliver"
      :presets="['这几个校验错误帮我修掉', '整体节奏太拖，帮我压缩一下', '检查一遍有没有中文残留']"
    />

    <n-modal
      v-model:show="showPackConfirm"
      preset="card"
      title="交付页还有校验错误"
      style="max-width: 640px"
    >
      <n-alert type="error" :bordered="false" style="margin-bottom: 12px">
        有 {{ exportErrors.length }} 个 error 级问题（帧数超限 / 未对齐 / 参考图缺失等）
        <InfoTip
          :width="330"
          text="直接导出的话，MiniMax 导入端可能静默降级：参考图槽位被清空、段退化成 t2v。"
        />
      </n-alert>
      <div style="max-height: 240px; overflow: auto">
        <div
          v-for="(i, k) in exportErrors.slice(0, 10)"
          :key="k"
          class="issue error"
        >
          <span class="mono" style="opacity: 0.7">{{ i.ruleId }}</span>
          <span>{{ i.message }}</span>
        </div>
        <div v-if="exportErrors.length > 10" class="muted" style="font-size: 12px; margin-top: 4px">
          … 还有 {{ exportErrors.length - 10 }} 条
        </div>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end; gap: 8px">
          <n-button @click="showPackConfirm = false">返回修复</n-button>
          <n-button
            type="warning"
            :loading="packBusy"
            @click="
              showPackConfirm = false;
              doExportPack()
            "
          >
            仍然导出
          </n-button>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="showSchema" preset="card" title="字段配置" style="max-width: 820px">
      <div class="dl-mini">
        字段可随意增删改序
        <InfoTip
          :width="330"
          text="派生字段由引擎自动生成，模型生成字段由大模型补全，人工字段只由你填写。"
        />
      </div>
      <div
        v-for="(f, i) in schemaDraft"
        :key="i"
        class="panel"
        style="padding: 10px; margin-bottom: 8px"
      >
        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <n-input
            size="small"
            style="width: 180px"
            :value="f.key"
            placeholder="key"
            @update:value="(v: string) => (schemaDraft[i].key = v)"
          />
          <n-select
            size="small"
            style="width: 120px"
            :value="f.source"
            :options="[
              { label: '引擎派生', value: 'derived' },
              { label: '模型生成', value: 'llm' },
              { label: '人工填写', value: 'manual' }
            ]"
            @update:value="(v: string) => (schemaDraft[i].source = v as FieldSchema['source'])"
          />
          <n-input
            size="small"
            style="flex: 1; min-width: 180px"
            :value="f.promptHint ?? ''"
            placeholder="给模型的说明 / 占位提示"
            @update:value="(v: string) => (schemaDraft[i].promptHint = v)"
          />
          <n-button size="tiny" quaternary @click="moveSchema(i, -1)">↑</n-button>
          <n-button size="tiny" quaternary @click="moveSchema(i, 1)">↓</n-button>
          <n-button size="tiny" quaternary type="error" @click="schemaDraft.splice(i, 1)">
            删除
          </n-button>
        </div>
      </div>
      <n-button size="small" dashed block @click="addSchemaRow">+ 新增字段</n-button>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button @click="showSchema = false">取消</n-button>
          <n-button type="primary" @click="saveSchema">保存</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 缓存目录：这一集的产物落在对面哪个目录（生成时自动绑定，这里只用于查看/纠偏） -->
    <n-modal
      v-model:show="showBind"
      preset="card"
      title="缓存目录（生成时自动绑定）"
      style="width: 760px; max-width: calc(100vw - 40px)"
    >
      <div class="dlg">
        <div class="kv wide">
          <span>
            当前目录
            <span v-if="binding" class="tag-chip bind-chip ok">{{ bindingText }}</span>
            <span v-else class="tag-chip">待生成</span>
          </span>
          <n-button v-if="binding" size="tiny" quaternary @click="unbindCache">解除跟随</n-button>
        </div>
        <div v-if="binding" class="muted" style="font-size: 11.5px">
          {{ bindingOrigin }} ·
          <span class="mono">{{ binding.workflowName || '默认目录' }}</span>
          <span v-if="binding.segmentTotal"> · {{ binding.segmentTotal }} 段</span>
          <span v-if="binding.boundAt"> · {{ at(binding.boundAt) }}</span>
        </div>
        <div v-if="binding" class="muted mono" style="font-size: 11px; overflow-wrap: anywhere">
          {{ binding.baseUrl }} · 节点 {{ binding.nodeId }} · 提交
          {{ binding.promptId.slice(0, 8) }} · 段表 {{ timelineSourceLabel }}
        </div>
        <n-alert
          v-if="binding && !bindingReady"
          type="warning"
          :show-icon="false"
          style="font-size: 12px"
        >
          这条绑定没带时间线，段位对不上，预览会退回「上次提交 / 本地现编」的段表。
          <InfoTip :width="260" text="在下面改绑一次即可拿到时间线。" />
        </n-alert>

        <div class="dl-mini" style="margin-bottom: 0">
          绑定是生成时自动落下的，改名不会换目录
          <InfoTip
            :width="400"
            text="这一集第一次跑成功，缓存目录就跟着记下来，之后预览、分段导出、「批量进流水线」都写回同一个目录。&#10;目录名钉在这条记录里，对面磁盘上的缓存不会「消失」—— 只有想主动换一个目录时，才需要在下面改绑。"
          />
        </div>

        <details class="bind-more">
          <summary>改绑到别的目录（不常用）</summary>
          <div class="bind-scan" style="margin-top: 10px">
            <n-input
              v-model:value="bindBase"
              size="small"
              placeholder="ComfyUI 地址，如 http://127.0.0.1:8188"
            />
            <n-button size="small" :loading="cacheScanning" @click="scanCaches(bindBase)">
              扫描远程缓存
            </n-button>
          </div>
          <div class="muted" style="font-size: 11.5px">
            扫描读的是对面的 <span class="mono">/history</span>
            <InfoTip
              size="sm"
              :width="330"
              text="每份 prompt 里的导演节点都带着缓存目录（workflow_name）与当时那份时间线，所以换台机器、换浏览器都能认出来。"
            />
          </div>

          <n-alert v-if="cacheScanError" type="warning" :show-icon="false" style="font-size: 12px">
            {{ cacheScanError }}
          </n-alert>

          <div v-if="cacheCandidates.length" class="cand-list">
            <div v-for="c in cacheCandidates" :key="`${c.workflowName}|${c.nodeId}`" class="cand">
              <div class="cand-main">
                <div class="row" style="gap: 6px; flex-wrap: wrap">
                  <span class="mono" style="font-weight: 600">{{ c.workflowName || '默认目录' }}</span>
                  <span class="tag-chip" :class="cacheStatus(c.status).tone">
                    {{ cacheStatus(c.status).text }}
                  </span>
                  <span class="tag-chip">{{ c.segmentTotal }} 段</span>
                  <span v-if="isBound(c)" class="tag-chip bind-chip ok">当前目录</span>
                </div>
                <div class="muted" style="font-size: 11px; margin-top: 3px">
                  节点 {{ c.nodeId }} · {{ c.outputCount }} 个产物 · 提交
                  {{ c.promptId.slice(0, 8) }}<span v-if="c.at"> · {{ at(c.at) }}</span>
                </div>
              </div>
              <n-button size="tiny" :disabled="isBound(c)" @click="doBind(c)">
                {{ isBound(c) ? '已是当前' : '改绑到这里' }}
              </n-button>
            </div>
          </div>
          <div v-else-if="!cacheScanning && !cacheScanError" class="muted" style="font-size: 12px">
            还没扫到缓存目录。
          </div>
        </details>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end; gap: 8px">
          <n-button size="small" quaternary @click="clearCacheCandidates">清空列表</n-button>
          <n-button size="small" @click="showBind = false">关闭</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 批量进流水线：一次提交，勾中的段在同一条流水线里依次生成 -->
    <n-modal
      v-model:show="showRun"
      preset="card"
      :title="`批量进流水线 · ${secondStageText}`"
      style="width: 640px; max-width: calc(100vw - 40px)"
    >
        <div class="dlg">
        <div class="kv">
          <span>这一次跑</span>
          <span>{{ secondStageText }}</span>
        </div>
        <div class="kv">
          <span></span>
          <span class="muted" style="font-size: 11.5px; line-height: 1.6">{{ secondStageHint }}</span>
        </div>
        <div class="kv">
          <span>进入流水线</span>
          <span class="mono">{{ submitLabels }}</span>
        </div>
        <div class="kv">
          <span>规模</span>
          <span>{{ submitSummary }} · {{ submitFrames }} 帧 · {{ submitSeconds.toFixed(1) }}s</span>
        </div>
        <div class="kv">
          <span>统一参数</span>
          <span>
            <span class="muted" style="font-size: 11px">本集所有段共用一套</span>
            <span class="mono">{{ pipeSummary }}</span>
          </span>
        </div>
        <div class="kv">
          <span>来源</span>
          <span>
            {{ binding ? '本集缓存目录' : lastJob ? '本机任务' : '本地配置' }} ·
            段表 {{ timelineSourceLabel }}
          </span>
        </div>

        <template v-if="runRoute === 'rebuild'">
          <div class="kv">
            <span>运行配置</span>
            <span>{{ runCfg?.name || '（无）' }}</span>
          </div>
          <div class="kv">
            <span>目标</span>
            <span class="mono" style="overflow-wrap: anywhere">
              {{ submitTarget.baseUrl || '—' }} · {{ submitTarget.dir }}
              <span v-if="submitTarget.fromBinding" class="tag-chip bind-chip ok">本集目录</span>
            </span>
          </div>
          <div class="dl-mini" style="margin: 2px 0 4px">
            <template v-if="submitPicks.length > picked.length">
              勾中的 {{ picked.length }} 段按「引用上段」补到
              <b>{{ submitPicks.length }} 段</b>走同一条流水线（二采半条链跑不了）
            </template>
            <template v-else>
              勾中的 {{ submitPicks.length }} 段走同一条流水线（一次提交 / 一份时间线 / 一套参数）
            </template>
            <InfoTip
              :width="400"
              :text="
                '节点按顺序逐段生成，未勾选的段缓存原样保留。导演包按当前段内容现编，所以段落里改过的文字会生效。' +
                (submitPicks.length > picked.length
                  ? `\n当前档位是二采：半条链跑不了，已按「引用上段」补到 ${submitPicks.length} 段一起跑。`
                  : hasChains
                    ? '\n其中「引用上段」的段，上游这次没一起勾时会沿用上一次留下的末帧作参考。'
                    : '')
              "
            />
          </div>
          <div class="muted" style="font-size: 11px">
            要改参数回交付页的「统一运行参数」
            <InfoTip size="sm" :width="280" text="改完这里跟着变 —— 不在弹窗里另设一套。" />
          </div>
        </template>
        <template v-else-if="runRoute === 'replay'">
          <div class="kv">
            <span>沿用配方</span>
            <span class="mono">{{ lastJob?.promptId.slice(0, 8) }} · {{ lastJob?.configName }}</span>
          </div>
          <div class="kv">
            <span>目标</span>
            <span class="mono" style="overflow-wrap: anywhere">
              {{ submitTarget.baseUrl || '—' }} · {{ submitTarget.dir }}
              <span v-if="submitTarget.fromBinding" class="tag-chip bind-chip ok">本集目录</span>
            </span>
          </div>
          <div class="dl-mini" style="margin: 2px 0 4px">
            段内容不在本地（只剩缓存）：沿用上次提交的原始请求
            <InfoTip
              :width="400"
              text="没法现编导演包，所以模型、参考图、时间线照旧；种子 / 步数 / CFG / 采样器 / 调度器 / shift / 画布 / 帧率 / 选卡都按本集统一参数重打，选择运行改成勾中的这几段。&#10;想用当前内容重跑，请先回到「③ 组合与缝合」。"
            />
          </div>
        </template>
        <div v-else class="dl-mini is-err" style="margin: 2px 0 4px">
          没有本地段，也没有可对的历史提交，跑不了
          <InfoTip :width="280" text="先在「③ 组合与缝合」生成方案，再去「运行」提交一次。" />
        </div>
        <n-alert v-if="latestBusy" type="warning" :show-icon="false" style="font-size: 12px">
          最近一次提交还在跑（{{ latestJob?.progress.phaseLabel || '排队中' }}·{{ jobPct(latestJob!) }}%）：
          现在再提交会和它抢同一份缓存目录与显存，建议等它跑完。
        </n-alert>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end; gap: 8px">
          <n-button size="small" quaternary @click="showRun = false">取消</n-button>
          <n-button
            size="small"
            type="primary"
            :loading="submitting"
            :disabled="runRoute === 'none'"
            @click="doRun"
          >
            开始生成 {{ submitPicks.length }} 段
          </n-button>
        </div>
      </template>
    </n-modal>

    <!--
      导出弹窗：先选"导什么"，再选"哪几段"，都在这里完成。
      以前分成两个弹窗——顶部「导出」只管导演包、段写死全片；「分段导出」要先回
      左侧列表勾选。同一件事拆成两处，勾选状态还互相影响，很难猜到该点哪个。
    -->
    <n-modal
      v-model:show="showSegExport"
      preset="card"
      title="导出"
      style="width: 920px; max-width: calc(100vw - 40px)"
    >
      <div class="dlg ex-dlg">
        <!-- ① 导什么 -->
        <div class="ex-kinds">
          <button
            type="button"
            class="ex-kind"
            :class="{ on: exportKind === 'clips' }"
            @click="exportKind = 'clips'"
          >
            <span class="ex-kind-top">
              <span class="ex-kind-name">分段成片</span>
              <span class="tag-chip">{{ clipSummary }}</span>
            </span>
            <span class="ex-kind-hint">
              缓存成片复制出来
              <InfoTip size="sm" :width="260" text="不重新渲染、不占队列。" />
            </span>
          </button>
          <button
            type="button"
            class="ex-kind"
            :class="{ on: exportKind === 'pack' }"
            @click="exportKind = 'pack'"
          >
            <span class="ex-kind-top">
              <span class="ex-kind-name">导演包</span>
              <span class="tag-chip">{{ views.length }} 段 · 约 {{ packTotalSec.toFixed(1) }}s</span>
            </span>
            <span class="ex-kind-hint">
              MiniMax H3 Director「导入导演包」用：zip；或给人看的 JSON
            </span>
          </button>
        </div>

        <!-- ② 哪几段 -->
        <div class="ex-section">
          <div class="ex-sec-head">
            <span class="ex-sec-title">导出哪些段</span>
            <div class="row" style="gap: 6px; flex-wrap: wrap; align-items: center">
              <span class="muted mono" style="font-size: 11px">{{ exportPickSummary }}</span>
              <template v-if="exportKind === 'clips'">
                <n-button size="tiny" @click="pickAllFor(exportSource)">全选</n-button>
                <n-button size="tiny" @click="pickWithClips(exportSource)">只选有成片的</n-button>
                <n-button
                  size="tiny"
                  quaternary
                  :disabled="!exportPicked.length"
                  @click="clearPickFor(exportSource)"
                >
                  清空
                </n-button>
              </template>
            </div>
          </div>

          <div class="ex-grid" :class="{ locked: exportKind === 'pack' }">
            <button
              v-for="(v, i) in views"
              :key="v.group.id"
              type="button"
              class="ex-seg"
              :class="{
                on: isPickedFor(exportSource, i) && exportKind === 'clips',
                off: exportKind === 'clips' && !selectableAt(i)
              }"
              :title="
                exportKind === 'clips' && !selectableAt(i)
                  ? `seg${String(i + 1).padStart(2, '0')} · ${v.frames}f · 没有一采 latent，二采跑不了`
                  : `seg${String(i + 1).padStart(2, '0')} · ${v.frames}f · ${productHint(i).text}`
              "
              @click="toggleExportSeg(i)"
            >
              <span class="ex-seg-no mono">seg{{ String(i + 1).padStart(2, '0') }}</span>
              <span v-if="i > 0 && linked[i]" class="ex-seg-ref" title="引用上段（属于同一条链）">↳</span>
              <span class="ex-seg-frames mono">{{ v.frames }}f</span>
              <span class="ex-seg-state" :class="`s-${sourceStateOf(i).tone}`">
                {{ sourceStateOf(i).text }}
              </span>
            </button>
          </div>

          <div v-if="exportKind === 'pack'" class="dl-mini">
            导演包总是导出全部 {{ views.length }} 段
            <InfoTip :width="300" text="段号必须连续，导入端按顺序铺时间线 —— 这里的勾选只作用于「分段成片」。" />
          </div>
          <div v-else-if="exportSource === 'second'" class="dl-mini">
            二采要先有一采 latent（本集 {{ secondPickableCount }}/{{ views.length }} 段可跑）
            <InfoTip
              :width="360"
              :text="
                '没有 latent 的段是灰的、勾不上（二采是拿一采那份 latent 再采一遍，不是重新生成）。' +
                '\n导出按单段勾选：已成片直接复制，不需要「引用上段」的整条链 —— 勾哪段导哪段。'
              "
            />
          </div>
          <div v-else-if="hasChains" class="dl-mini">
            一采按单段勾选（当前覆盖 {{ exportPickedChains }} 条链）
            <InfoTip :width="340" text="「引用上段」只在跑二采时才按整条链补齐 —— 导出读的是已成片，不牵扯上游末帧。" />
          </div>
          <div v-else class="dl-mini">点一段即选中；勾中有 {{ pickedClipCount }} / {{ exportPicked.length }} 段真的有片</div>
        </div>

        <!-- ③ 类型专属选项 -->
        <div v-if="exportKind === 'clips'" class="ex-section">
          <div class="kv">
            <span>模式</span>
            <n-radio-group v-model:value="exportMode" size="small">
              <n-radio-button
                v-for="m in EXPORT_MODE_OPTIONS"
                :key="m.value"
                :value="m.value"
                :label="m.label"
              />
            </n-radio-group>
          </div>
          <div class="muted" style="font-size: 11.5px; margin-left: 76px">
            {{ EXPORT_MODE_OPTIONS.find((m) => m.value === exportMode)?.hint }}
          </div>
          <div class="kv" style="margin-top: 8px">
            <span>来源</span>
            <div class="row" style="gap: 8px; flex-wrap: wrap; align-items: center">
              <n-radio-group v-model:value="exportSource" size="small">
                <n-radio-button
                  v-for="src in EXPORT_SOURCE_OPTIONS"
                  :key="src.value"
                  :value="src.value"
                  :label="sourceLabel(src)"
                />
              </n-radio-group>
              <template v-if="exportSource === 'second'">
                <span class="muted mono" style="font-size: 11px">
                  {{ secondDetecting ? '正在问节点…' : secondProbedText }}
                </span>
                <n-button
                  size="tiny"
                  quaternary
                  :loading="secondDetecting"
                  title="二采可能是别处产出的，重新问一次 ComfyUI"
                  @click="detectSecond(true)"
                >
                  重新检测
                </n-button>
              </template>
            </div>
          </div>
          <div class="muted" style="font-size: 11.5px; margin-left: 76px">
            两份勾选各记各的（{{ exportSource === 'second' ? '一采' : '二采' }}已勾
            {{ exportOtherCount }} 段，不受这里影响）
            <InfoTip
              size="sm"
              :width="340"
              :text="
                exportSource === 'second'
                  ? '二采不在这次生成的规程里，可能来自另一轮任务或另一台机器 —— 切到二采时会现检一次。'
                  : '一采直接用本地已探测的结果，不重复请求节点。'
              "
            />
          </div>
          <n-alert
            v-if="secondError && exportSource === 'second'"
            type="error"
            :show-icon="false"
            style="font-size: 12px; margin-top: 8px"
          >
            {{ secondError }}（下面的状态不可信，可点「重新检测」再试）
          </n-alert>
          <n-alert
            v-else-if="!secondDetecting && !pickedClipCount"
            type="warning"
            :show-icon="false"
            style="font-size: 12px; margin-top: 8px"
          >
            勾中的段在「{{ exportSource === 'second' ? '二采' : '一采' }}」下都没有成片，导出来会是空的。
            <template v-if="exportSource === 'second'">
              这次检测到 {{ secondClipCount }} 段有二采成片：点「只选有成片的」，或先把这些段跑二采。
            </template>
            <template v-else>换来源、点「只选有成片的」，或先把这些段跑出来。</template>
          </n-alert>
          <n-alert v-else type="info" :show-icon="false" style="font-size: 12px; margin-top: 8px">
            导出只是把缓存里的成片写到
            <span class="mono">output/minimax_segment_export/&lt;节点&gt;</span>，不会重新渲染
            <InfoTip
              :width="300"
              text="不占队列；只有 latent 的段会先解码再编码，可能慢一点。"
            />
          </n-alert>
        </div>

        <div v-else class="ex-section">
          <div class="dl-mini">
            导演包 zip 给 MiniMax H3 Director 的「导入导演包」用
            <InfoTip :width="280" text="下面的 JSON 只是给人看的自检文本。" />
            <span v-if="!finalMode" style="color: var(--warn-ink)">· 当前仍是中文工作稿</span>
          </div>
          <div class="row" style="gap: 10px; margin-bottom: 10px; flex-wrap: wrap; align-items: center">
            <span class="muted" style="font-size: 12.5px">输出分辨率（{{ CANVAS_MULTIPLE }} 的倍数）</span>
            <n-input-number
              v-model:value="packWidth"
              size="small"
              :min="CANVAS_MULTIPLE"
              :step="CANVAS_MULTIPLE"
              style="width: 120px"
            />
            <span class="muted">×</span>
            <n-input-number
              v-model:value="packHeight"
              size="small"
              :min="CANVAS_MULTIPLE"
              :step="CANVAS_MULTIPLE"
              style="width: 120px"
            />
          </div>
          <n-alert
            v-if="packWarnings.length"
            type="warning"
            :bordered="false"
            style="margin-bottom: 10px"
          >
            <div v-for="(w, i) in packWarnings" :key="i" style="margin-bottom: 2px">· {{ w }}</div>
          </n-alert>
          <div class="row-between" style="margin-bottom: 8px">
            <span class="muted" style="font-size: 12px">
              JSON 自检
              <InfoTip size="sm" :width="260" text="含每段帧数、连续性参数、接缝判定、字段全文。" />
            </span>
            <div class="row" style="gap: 8px">
              <n-button size="small" @click="copyText(exportJson())">复制 JSON</n-button>
              <n-button size="small" :disabled="!views.length" @click="download">下载 JSON</n-button>
            </div>
          </div>
          <textarea
            readonly
            :value="exportJson()"
            class="ex-json"
          />
        </div>

        <!-- ④ 结果 -->
        <div v-if="exportKind === 'clips' && segExportResult" class="exp-result">
          <div class="row" style="justify-content: space-between; gap: 8px; flex-wrap: wrap">
            <span style="font-size: 12.5px">
              已导出 {{ segExportResult.files.length }} 个 ·
              跳过 {{ segExportResult.skipped.length }} 段
            </span>
            <n-button size="tiny" quaternary @click="copyExportDir">复制目录</n-button>
          </div>
          <div class="muted mono" style="font-size: 11px; overflow-wrap: anywhere">
            {{ segExportResult.exportDir }}
          </div>
          <div v-for="(f, k) in segExportResult.files" :key="k" class="exp-file">
            <video
              v-if="exportUrl(f)"
              :src="poster(exportUrl(f))"
              controls
              playsinline
              preload="metadata"
            />
            <div class="film-name">
              <span :title="f.path">{{ f.filename }}</span>
              <a v-if="exportUrl(f)" :href="exportUrl(f)" target="_blank" rel="noreferrer">打开</a>
            </div>
          </div>
          <div v-for="(sk, k) in segExportResult.skipped" :key="`s${k}`" class="exp-skip">
            第 {{ sk.index + 1 }} 段未导出：{{ sk.reason }}
          </div>
        </div>
        <n-alert
          v-if="exportKind === 'clips' && segExportError"
          type="error"
          :show-icon="false"
          style="font-size: 12px"
        >
          {{ segExportError }}
        </n-alert>
      </div>

      <template #footer>
        <div class="row" style="justify-content: space-between; gap: 8px; flex-wrap: wrap">
          <span class="muted" style="font-size: 11.5px">
            {{
              exportKind === 'clips'
                ? `${exportSource === 'second' ? '二采' : '一采'} · 选中 ${exportPicked.length} 段 · ${exportPickedFrames}f · ${exportPickedSeconds.toFixed(1)}s`
                : `${views.length} 段 · 约 ${packTotalSec.toFixed(1)}s`
            }}
          </span>
          <div class="row" style="gap: 8px">
            <n-button size="small" quaternary @click="showSegExport = false">关闭</n-button>
            <n-button
              v-if="exportKind === 'clips'"
              size="small"
              type="primary"
              :loading="segExporting || (exportSource === 'second' && secondDetecting)"
              :disabled="!exportPicked.length || (exportSource === 'second' && secondDetecting)"
              @click="doSegExport"
            >
              {{
                exportSource === 'second' && secondDetecting
                  ? '检测二采…'
                  : segExporting
                    ? '正在导出…'
                    : `导出${exportSource === 'second' ? '二采' : '选中'} ${exportPicked.length} 段`
              }}
            </n-button>
            <n-button
              v-else
              size="small"
              type="primary"
              :loading="packBusy"
              :disabled="!views.length"
              @click="exportPack"
            >
              下载导演包 zip
            </n-button>
          </div>
        </div>
      </template>
    </n-modal>

    <!-- 整片成片：不属于任何一段，所以放在这里，从头部进 -->
    <n-modal v-model:show="showFilm" preset="card" title="整片成片" style="max-width: 980px">
      <div class="row" style="gap: 10px; margin-bottom: 10px; flex-wrap: wrap">
        <span class="muted" style="font-size: 12.5px">最近 3 次运行</span>
        <n-button
          size="tiny"
          :loading="redoing"
          :disabled="!lastJob || latestBusy"
          title="沿用上次的配方重跑全段：段与采样都命中缓存，只重做解码与合成"
          @click="redoFilm"
        >
          重出整片
        </n-button>
        <n-button size="tiny" quaternary @click="router.push('/run')">去运行台</n-button>
      </div>
      <div v-if="!films.length" class="muted" style="font-size: 12.5px">
        还没有跑出过整片。去「运行」提交一次，或先在这里勾段「批量进流水线」。
      </div>
      <div v-for="f in films" :key="f.id" class="film-row">
        <div class="film-meta">
          <span class="mono">{{ f.promptId.slice(0, 8) }}</span>
          <span class="muted">{{ at(f.at) }}</span>
          <span class="muted">{{ f.configName }}</span>
        </div>
        <div class="film-outs">
          <div v-for="(o, k) in f.outputs" :key="k" class="film-out">
            <video :src="poster(o.url)" controls playsinline preload="metadata" />
            <div class="film-name">
              <span :title="o.filename">{{ o.filename }}</span>
              <a :href="o.url" target="_blank" rel="noreferrer">打开</a>
            </div>
          </div>
        </div>
      </div>
    </n-modal>

    <FixIssuesDialog
      v-model:show="showFix"
      :view="active"
      :segment-index="activeSegment"
      :segment-total="views.length"
      :schema="schema"
      :settings="settings"
      :entities="registry.entities"
      :global-issues="globalIssues"
      @apply="applyPatches"
    />
  </div>
</template>

<style scoped>
/*
 * 顶部操作条：窄窗口（≤1100px）时右侧按钮组必须能换行。
 * 原来这一行是 nowrap，按钮多了以后「导出」会被挤出视口右侧 —— 既看不见也点不到，
 * document.scrollWidth 还等于视口宽，连横向滚动都滚不过去。
 */
.dl-head {
  flex-wrap: wrap;
  row-gap: 8px;
}

/* 交付页里的"块"统一间距：概览 / 产物 / 字段模块 / 检查 之间不再各写一个 margin */
.dl-block {
  margin-bottom: 12px;
}

/* ------------------------------------------------------------------ *
 * 字段模块
 *
 * 一格 = 一组语义相关的字段（主体 / 叙事 / 画面 / 声音）。
 * 每个模块一个颜色身份：卡头左侧 3px 竖条 + 同色标题短横，
 * 和「统一运行参数」那边的 mod-head 是同一套语言，不另起一套。
 * ------------------------------------------------------------------ */
.dl-mod {
  --mod: var(--m-blue);
  --mod-soft: var(--m-blue-soft);
  --mod-line: var(--m-blue-line);
  --mod-ink: var(--m-blue-ink);

  margin-bottom: 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--panel);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}
.dl-mod.tone-violet {
  --mod: var(--m-violet);
  --mod-soft: var(--m-violet-soft);
  --mod-line: var(--m-violet-line);
  --mod-ink: var(--m-violet-ink);
}
.dl-mod.tone-teal {
  --mod: var(--m-teal);
  --mod-soft: var(--m-teal-soft);
  --mod-line: var(--m-teal-line);
  --mod-ink: var(--m-teal-ink);
}
.dl-mod.tone-amber {
  --mod: var(--m-amber);
  --mod-soft: var(--m-amber-soft);
  --mod-line: var(--m-amber-line);
  --mod-ink: var(--m-amber-ink);
}
.dl-mod.tone-slate {
  --mod: var(--m-slate);
  --mod-soft: var(--m-slate-soft);
  --mod-line: var(--m-slate-line);
  --mod-ink: var(--m-slate-ink);
}

.dl-mod-head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 12px 8px 14px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--line);
}
/* 竖条用绝对定位贴边，卡头就不用为了它多留内距 */
.dl-mod-bar {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--mod);
  opacity: 0.9;
}
.dl-mod-title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--mod-ink);
  min-width: 0;
}
.dl-mod-hint {
  font-size: var(--fs-xs);
  color: var(--muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dl-mod-body {
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 模块里的字段：和其他页同一个写法 —— 名字徽章 + 正文条。
   条内第一行是给导出对的 key、来源、状态，下面是可编辑的 textarea。 */
.dl-field-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 3px;
}
.dl-field-key {
  font-size: 10.5px;
  letter-spacing: -0.2px;
  color: var(--muted);
}
.dl-field-spacer {
  flex: 1;
}
.dl-mini {
  padding: 0 2px;
  border: 0;
  background: none;
  font: inherit;
  font-size: 11px;
  color: var(--accent);
  cursor: pointer;
}
.dl-mini:hover {
  text-decoration: underline;
}
.dl-field-input {
  display: block;
  width: 100%;
  border: 0;
  outline: none;
  resize: vertical;
  background: transparent;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text);
}

/* ------------------------------------------------------------------ *
 * 检查模块
 *
 * 原来「本段检查 / 全片检查」是两个裸标题 + 一串 issue 行，和上面的模块卡
 * 不是一套东西。这里给它们同样的卡壳，计数放在卡头 —— 不翻到底就知道有几条。
 * ------------------------------------------------------------------ */
.dl-check {
  margin-top: 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--panel);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}
.dl-check-head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 12px 8px 14px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--line);
}
.dl-check-bar {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--m-slate);
  opacity: 0.9;
}
.dl-check-bar.warn {
  background: var(--warn);
}
.dl-check-title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text);
}
.dl-check-body {
  padding: 8px 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* 段列表：列表自己滚，批量条钉在底部（宽度固定 220px，别被内容撑开） */
.seg-rail {
  width: 220px;
  flex: 0 0 220px;
  min-height: 0;
  border-right: 1px solid var(--line);
  background: var(--panel);
  display: flex;
  flex-direction: column;
}
.seg-rail-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 10px;
}
.seg-item {
  padding: 8px 10px;
  margin-bottom: 6px;
  cursor: pointer;
}
/* 当前编辑的段：左边一条实线；勾选的段：虚线圈 */
.seg-item.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.seg-item.picked {
  /* 勾选是"这次要跑/要导出"的标记，和"正在编辑"要能一眼分开：给左侧色条 */
  box-shadow: inset 3px 0 0 var(--accent);
  border-color: var(--accent);
}
.seg-prod.success {
  background: var(--ok-soft);
  color: var(--ok-ink);
}
.seg-prod.warning {
  background: var(--warn-soft);
  color: var(--warn-ink);
}
.seg-prod.default {
  background: var(--panel-3);
  color: var(--label);
}
/* 引用上段：段名旁边的箭头，说清"这一段要吃上一段的末帧" */
.seg-ref {
  font-size: 10.5px;
  color: var(--warn-ink);
  background: var(--warn-soft);
  border: 1px solid var(--warn-line);
  border-radius: 999px;
  padding: 0 6px;
  line-height: 16px;
  white-space: nowrap;
}
/* 链：同一条引用链的段，勾选是联动的 */
.seg-chain {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.seg-chain-hint {
  font-size: 11px;
  line-height: 1.5;
  color: var(--accent-ink);
}
/* 过期提示：段号可以直接点，点了切到那一段 —— 只报个总数等于叫人自己去翻 */
.stale-box {
  border: 1px solid var(--warn-line);
  background: var(--warn-soft);
  border-radius: 10px;
  padding: 9px 12px;
  margin-bottom: 12px;
}
.stale-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--warn-ink);
}
.stale-chips {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 7px;
}
.stale-chip {
  border: 1px solid var(--warn-line);
  cursor: pointer;
  font-family: var(--mono);
  font-size: 11px;
  background: var(--panel);
  color: var(--warn-ink);
}
.stale-chip:hover {
  border-color: var(--warn);
  background: var(--panel-3);
}
.bulk-bar {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid var(--line);
  padding: 8px 10px;
  background: var(--panel);
}

/* 弹窗 */
.dlg {
  display: grid;
  gap: 8px;
}
.kv {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  font-size: 12.5px;
}
.kv > span:first-child {
  color: var(--muted);
  font-size: 12px;
}
.kv.wide {
  grid-template-columns: minmax(0, 1fr) auto;
}
.kv.wide > span:first-child {
  display: flex;
  gap: 6px;
  align-items: baseline;
  flex-wrap: wrap;
  color: var(--text);
  font-size: 12.5px;
}

/* ---------------- 导出弹窗 ---------------- */
/* 内容会随类型变长（导演包带 460px 的 JSON），整块自己滚，footer 始终露在下面 */
.ex-dlg {
  max-height: calc(100vh - 220px);
  overflow-y: auto;
  gap: 12px;
  padding-right: 4px;
}
.ex-kinds {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
@media (max-width: 720px) {
  .ex-kinds {
    grid-template-columns: 1fr;
  }
}
/* 两张卡片本身就是选择器：选中态用主色边框 + 浅底，别用 radio 再套一层 */
.ex-kind {
  display: grid;
  gap: 6px;
  text-align: left;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  transition: border-color 0.15s, background 0.15s;
}
.ex-kind:hover {
  border-color: var(--accent-line);
}
.ex-kind.on {
  border-color: var(--accent-hover);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent-hover);
}
.ex-kind-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ex-kind-name {
  font-size: 13.5px;
  font-weight: 600;
}
.ex-kind-hint {
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.55;
}
.ex-section {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
  display: grid;
  gap: 8px;
}
.ex-sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.ex-sec-title {
  font-size: 12.5px;
  font-weight: 600;
}
/* 段选择网格：一段一个 chip，状态色点直接说明"在当前来源下能不能出片" */
.ex-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 6px;
  max-height: 196px;
  overflow-y: auto;
}
.ex-seg {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  transition: border-color 0.12s, background 0.12s;
}
.ex-seg:hover {
  border-color: var(--accent-line);
}
.ex-seg.on {
  border-color: var(--accent-hover);
  background: var(--accent-soft);
}
/* 不可勾的段（二采没有一采 latent）：虚线 + 变淡，但仍是可点的 ——
   点了要给出"为什么勾不上"的提示，直接 disabled 会连提示都没有 */
.ex-seg.off {
  opacity: 0.45;
  border-style: dashed;
  cursor: not-allowed;
}
.ex-seg.off:hover {
  border-color: var(--line);
}
.ex-grid.locked .ex-seg {
  cursor: default;
  opacity: 0.72;
}
.ex-grid.locked .ex-seg:hover {
  border-color: var(--line);
}
.ex-seg-no {
  font-weight: 600;
  font-size: 11.5px;
}
.ex-seg-ref {
  color: var(--accent-hover);
  font-size: 11px;
}
.ex-seg-frames {
  color: var(--muted);
  font-size: 10.5px;
  margin-left: auto;
}
.ex-seg-state {
  font-size: 10.5px;
  padding: 0 5px;
  border-radius: 999px;
  white-space: nowrap;
}
.ex-seg-state.s-success {
  background: var(--ok-soft);
  color: var(--ok-ink);
}
.ex-seg-state.s-warning {
  background: var(--warn-soft);
  color: var(--warn-ink);
}
.ex-seg-state.s-default {
  background: var(--panel-3);
  color: var(--muted);
}
.ex-json {
  width: 100%;
  height: 320px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
}

/* 缓存绑定的 chip：绑到能预览的目录才变绿，别让"绑了个空目录"也看着成功 */
.bind-chip {
  background: var(--panel-3);
  color: var(--label);
}
.bind-chip.ok {
  background: var(--ok-soft);
  color: var(--ok-ink);
}
/* 改绑区默认收起：绑定是自动的，正常路径下没人需要展开它 */
.bind-more > summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--muted, var(--muted));
  padding: 4px 0;
  user-select: none;
}
.bind-more[open] > summary {
  color: var(--text);
}
.bind-scan {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}
.cand-list {
  display: grid;
  gap: 6px;
  max-height: 40vh;
  overflow-y: auto;
}
.cand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.cand-main {
  flex: 1 1 auto;
  min-width: 0;
}

/* 运行参数：两列小表单，不把弹窗撑成一面墙 */
.param-head {
  margin-top: 4px;
  font-size: 12.5px;
  font-weight: 600;
}
/* ------------------------------------------------------------------ *
 * 统一运行参数：三张模块卡（一采 / 二采 / 选卡）
 *
 * 每个模块一套色，只改 --mod 系列变量就能换肤；模块内部再切成
 * fieldset 小段（fieldset-head 前面那道短色条就是分段标记）。
 * 加新参数时只往对应的 fieldset 里塞 .param，别往一条通铺网格里堆。
 * ------------------------------------------------------------------ */
.pipe-bar {
  flex: 0 0 auto;
  padding: 8px 12px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-2, var(--panel-2));
}
.pipe-bar > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  list-style: none;
  cursor: pointer;
  padding: 2px 0;
  font-size: 12px;
  color: var(--text);
}
.pipe-bar > summary::-webkit-details-marker {
  display: none;
}
.pipe-bar > summary:hover .pipe-title {
  color: var(--accent);
}
.pipe-title {
  font-weight: 700;
  font-size: 12.5px;
  letter-spacing: 0.2px;
}
.pipe-hint {
  font-size: 11px;
}
.pipe-toggle {
  margin-left: auto;
  font-size: 11px;
  color: var(--accent);
  padding: 0 8px;
  border: 1px solid currentColor;
  border-radius: 999px;
  line-height: 16px;
  opacity: 0.8;
}
.pipe-toggle::after {
  content: '展开';
}
.pipe-bar[open] .pipe-toggle::after {
  content: '收起';
}
.pipe-bar[open] .pipe-toggle {
  color: var(--muted);
}
.pipe-bar[open] .pipe-hint,
.pipe-bar[open] .pipe-chip {
  display: none;
}
.pipe-chip {
  background: var(--panel-3);
  color: var(--label);
}
.pipe-chip.ok {
  background: var(--accent-soft);
  color: var(--accent-hover);
}

/* 版面：左一采（跨两行）/ 右上二采 / 右下选卡 */
.pipe-groups {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  /* 右边两块叠起来不必和一采等高，别撑出半空盒子 */
  align-items: start;
  gap: 12px 14px;
  margin-top: 10px;
}
@media (max-width: 1080px) {
  .pipe-groups {
    grid-template-columns: minmax(0, 1fr);
  }
  /* 单列时没有"右列"可言，按源码顺序往下堆 */
  .mod-tall,
  .mod-right2 {
    grid-row: auto;
    grid-column: auto;
  }
}
.mod-tall {
  grid-row: 1 / span 2;
  /* 右列两块叠起来比一采高，撑到同一条底边，别在左下留个豁口 */
  align-self: stretch;
}
.mod-right2 {
  grid-column: 2;
  grid-row: 2;
}

/* ---- 模块卡 + 色系 ---- */
.mod {
  --mod: var(--accent);
  --mod-soft: var(--accent-soft);
  --mod-line: var(--accent-line);
  --mod-ink: var(--accent-ink);
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--mod-line);
  border-radius: 10px;
  background: var(--panel, #fff);
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
.mod-second {
  --mod: var(--m-violet);
  --mod-soft: var(--m-violet-soft);
  --mod-line: var(--m-violet-line);
  --mod-ink: var(--m-violet-ink);
}
.mod-cards {
  --mod: var(--m-teal);
  --mod-soft: var(--m-teal-soft);
  --mod-line: var(--ok-line);
  --mod-ink: var(--m-teal-ink);
}
.mod-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 6px 12px;
  background: var(--mod-soft);
  border-bottom: 1px solid var(--mod-line);
  /* 左侧那道 3px 色条：扫一眼就知道这是哪个模块 */
  box-shadow: inset 3px 0 0 var(--mod);
}
.mod-tag {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  border-radius: 5px;
  background: var(--mod);
  color: #fff;
  font-size: 10.5px;
  font-weight: 700;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.mod-title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--mod-ink);
  letter-spacing: 0.2px;
  white-space: nowrap;
}
.mod-meta {
  margin-left: auto;
  flex: 0 0 auto;
  padding: 0 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.75);
  border: 1px solid var(--mod-line);
  color: var(--mod-ink);
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
}
.mod-body {
  /* 撑满卡身：一采被拉伸时，多出来的高度才有地方摊（见 .mod-tall） */
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 8px 10px 10px;
}

/* 一采撑到与右列同高后，多出来的高度摊到三段之间 —— 堆在卡底会像没写完 */
.mod-tall .mod-body {
  justify-content: space-between;
}

/* ---- 模块内部的小分段 ---- */
.fieldset {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.fieldset + .fieldset {
  border-top: 1px dashed var(--line);
  padding-top: 8px;
}
.fieldset-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--mod-ink);
  opacity: 0.85;
}
.fieldset-head::before {
  content: '';
  width: 14px;
  height: 3px;
  border-radius: 2px;
  background: var(--mod);
  opacity: 0.8;
}
/* 说明文字：贴模块色的细线，不再当成第 N 个字段混在网格里 */
.mod-note {
  margin: 0;
  padding-left: 8px;
  border-left: 2px solid var(--mod-line);
  font-size: 10.8px;
  line-height: 1.6;
  color: var(--muted);
}

/* ---- 字段网格 ---- */
.pipe-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px 10px;
}
.param {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  min-width: 0;
  font-size: 12.5px;
}
.param > span {
  color: var(--label);
  font-size: 11.5px;
  line-height: 1.25;
}
/* 跨满整行：下拉 / 长输入 / 画布行，挤在半列里会截断 */
.param-wide {
  grid-column: 1 / -1;
}
/* 只读值（二采步数 / 当前选卡）：给个浅底胶囊，和可编辑框区分开 */
.readout {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  min-width: 0;
  padding: 0 8px;
  border-radius: 6px;
  background: var(--mod-soft);
  border: 1px solid var(--mod-line);
  color: var(--mod-ink);
  font-size: 11.5px;
  line-height: 20px;
}
/* sigmas 生效时的提示条 */
.param-hint {
  grid-column: 1 / -1;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--mod-soft);
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted);
}
.param-hint b {
  color: var(--mod-ink);
}

/* ---- 画布行：密度 → 分辨率（比例） ---- */
.canvas-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}
.canvas-mp {
  width: 92px;
  flex: 0 0 auto;
}
.canvas-unit,
.canvas-arrow,
.canvas-times {
  color: var(--muted);
  font-size: 11.5px;
}
.canvas-out {
  padding: 0 8px;
  border-radius: 6px;
  background: var(--mod-soft);
  border: 1px solid var(--mod-line);
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  color: var(--mod-ink);
  letter-spacing: 0.2px;
  white-space: nowrap;
}
.canvas-ratio {
  width: 132px;
  flex: 0 0 auto;
  /* 紧跟在分辨率后面：这一行读起来是「密度 → 分辨率（比例）」一件事 */
  margin-left: 4px;
}

/* ---- 选卡 ---- */
.card-picks {
  display: flex;
  align-items: center;
  gap: 6px 12px;
  flex-wrap: wrap;
  min-height: 24px;
}
.card-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.card-empty {
  font-size: 11.5px;
  color: var(--muted);
}
/* 勾了 ComfyUI 看不见的卡：节点会直接报错，先在列表里标出来 */
.card-unseen {
  margin-left: 3px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--err-soft);
  color: var(--err, var(--err-ink));
  font-size: 10.5px;
  line-height: 15px;
}

/* ---- 底部说明 ---- */
.pipe-foot {
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.6);
  font-size: 11px;
  color: var(--muted);
  line-height: 1.6;
}
.exp-result {
  margin-top: 4px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  display: grid;
  gap: 6px;
  max-height: 46vh;
  overflow-y: auto;
}
.exp-file video {
  display: block;
  width: auto;
  max-width: 100%;
  max-height: 220px;
  margin: 0 auto;
  object-fit: contain;
  background: #000;
  border: 1px solid var(--line);
  border-radius: 6px;
}
.exp-skip {
  font-size: 11.5px;
  color: var(--warn);
}
.film-row {
  border-top: 1px solid var(--line);
  padding-top: 8px;
  margin-top: 8px;
}
.film-meta {
  display: flex;
  gap: 10px;
  font-size: 11.5px;
  color: var(--muted);
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.film-outs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px;
}
.film-out video {
  display: block;
  width: auto;
  max-width: 100%;
  max-height: 320px;
  margin: 0 auto;
  object-fit: contain;
  background: #000;
  border: 1px solid var(--line);
  border-radius: 6px;
}
.film-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--muted);
}
.film-name span {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.film-name a {
  color: var(--accent);
  text-decoration: none;
}

/* 原来是一条两行的大 alert。规则要留，占位不该占 —— 收成一行，解释挂问号 */
.dl-mini {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-bottom: 10px;
  padding: 5px 10px;
  border-radius: 6px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.5;
}
.dl-mini.is-err {
  border-color: var(--err-soft);
  color: var(--err-ink);
  background: var(--err-soft);
}
</style>
