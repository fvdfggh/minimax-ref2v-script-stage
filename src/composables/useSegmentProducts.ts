/**
 * 段产物：把 ComfyUI 缓存里的一采 / 二采，挂到**交付的每一段**上。
 *
 * 产物不是独立的一摊东西 —— 它的主语是"这一段"。所以这里不提供页面，只提供
 * 交付页要用的那几件事：
 *   · 探：段（i）↔ 缓存槽（index i）对不对得上，一采/二采各有没有成片；
 *   · 跑：只跑某几段（时间线 `runSelectEnabled` / `runSelection`）；
 *   · 导：把这几段的成片写到磁盘（`segment_export`，逐段/连段、一采/二采）。
 * 后两件都是导演节点的原生能力，不是剧本台另发明一套。
 *
 * 索引对齐有个前提：**探测/操作用的 timeline 必须和提交时那份一致**。节点按
 * index 找槽，时间线一改，第 3 段就可能落到别的位置上。所以优先用 `history`
 * 里提交时那份 `timeline_data`，拿不到才用 `domain/packInput` 现算（同一个
 * buildDirectorPack，与运行台提交路径同源）。
 */
import { computed, ref, watch, type Ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useRegistryStore } from '@/stores/registry'
import { useBeatStore } from '@/stores/beats'
import { useAssemblyStore } from '@/stores/assembly'
import { useWorkflowStore } from '@/stores/workflow'
import { useRunStore } from '@/stores/run'
import { useOutputsStore, type SegmentPlanLite } from '@/stores/outputs'
import { useCacheBindStore } from '@/stores/cacheBind'
import { useDirectorStore } from '@/stores/director'
import { packSegmentOf } from '@/domain/packInput'
import {
  buildDirectorPack,
  buildDirectorPackZip,
  DEFAULT_OUTPUT_HEIGHT,
  DEFAULT_OUTPUT_WIDTH
} from '@/domain/pack'
import {
  CARD_OFF,
  RUN_MODEL_CHOICES,
  SAMPLERS,
  SCHEDULERS,
  directorNodeId,
  parseCardList,
  resolveWorkflowName,
  secondStageOf,
  type RunConfig,
  type SecondStage
} from '@/domain/run'
import {
  SECOND_SAMPLER_FOLLOW,
  SECOND_STAGE_OPTIONS,
  secondTargetSize,
  wiredSigmasText
} from '@/domain/secondPass'
import { comfyPromptTimeline, comfyViewUrl } from '@/core/comfy'
import {
  chainLabel,
  chainOfIndex,
  expandPicksFor,
  normalizeIndices,
  pickedChainCount,
  pickSpanFor,
  segmentChains,
  selectionSummary,
  timelineSegmentCount,
  type ExportMode,
  type ExportSource
} from '@/domain/segmentOps'
import { passLabelText, passToneOf, posterUrl, secondSelectable } from '@/domain/productDisplay'
import {
  canvasFromMegapixels,
  canvasMegapixels,
  canvasRatio,
  pipelineParamsFromConfig,
  pipelineParamsPatch,
  pipelinePromptInputs,
  pipelineSummary,
  toggleCard,
  type PipelineParams
} from '@/domain/pipelineParams'
import {
  bindingOriginText,
  bindingSummary,
  bindingUsable,
  normalizeBaseUrl,
  type RemoteCacheCandidate
} from '@/domain/cacheBind'

export function useSegmentProducts(active: Ref<boolean>) {
  const project = useProjectStore()
  const registry = useRegistryStore()
  const beats = useBeatStore()
  const assembly = useAssemblyStore()
  const workflow = useWorkflowStore()
  const run = useRunStore()
  const outputs = useOutputsStore()
  const cacheBind = useCacheBindStore()
  const director = useDirectorStore()
  const message = useMessage()

  const booted = ref(false)
  const timelineSource = ref<'binding' | 'job' | 'local'>('local')

  /* ------------------------------ 段计划 ------------------------------ */

  /** 与交付页同一份派生：段顺序、帧数、镜头数都从这儿来 */
  const views = computed(() => {
    const cur = assembly.current
    if (!cur) return []
    return assembly.buildSegmentViews(
      cur,
      beats.ordered,
      project.settings,
      registry.entityById,
      project.fieldSchema,
      registry.assets
    )
  })

  const plan = computed<SegmentPlanLite[]>(() =>
    views.value.map((v, i) => ({
      frames: v.frames,
      beatCount: v.beats.length,
      // 第 0 段没有上一段可引用：强制 false，避免脏数据把链算歪
      refPrev: i > 0 && !!v.refPrev
    }))
  )

  /* ------------------------------ 上下文 ------------------------------ */

  const episodeId = computed(() => project.current?.id ?? '')

  /** 该集绑定的运行配置（没绑就走当前选中的） */
  const cfg = computed(
    () => (episodeId.value ? run.configForEpisode(episodeId.value) : null) ?? run.active
  )

  /**
   * 该集绑定到的**远程缓存**。
   *
   * 优先级排在任务列表之前：任务列表只反映"这个浏览器提交过什么"，
   * 换台机器就空了；显式绑定是用户亲口说的"这集的片在对面的 ep1 里"。
   */
  const binding = computed(() => cacheBind.forEpisode(episodeId.value))

  /** 最近一次真正提交过的任务：它的缓存目录/节点 id 才是产物真正落的地方 */
  const lastJob = computed(
    () => run.jobs.find((j) => j.episodeId === episodeId.value && j.directorNodeId) ?? null
  )

  const baseUrl = computed(
    () => binding.value?.baseUrl || lastJob.value?.baseUrl || cfg.value?.baseUrl || ''
  )
  /**
   * 缓存目录名。
   *
   * 绑定的目录名可能是空串（节点自己的默认目录），所以必须按"有没有绑定"分支，
   * 不能写成 `binding?.workflowName || ...` —— 那会把空串当成没绑定。
   */
  const workflowName = computed(() => {
    if (binding.value) return binding.value.workflowName
    if (lastJob.value?.workflowName) return lastJob.value.workflowName
    return cfg.value ? resolveWorkflowName(cfg.value, project.current?.name ?? '') : ''
  })

  const template = computed(
    () =>
      workflow.templateForEpisode(episodeId.value) ??
      workflow.templates.find((t) => t.id === workflow.activeId) ??
      null
  )

  const nodeId = computed(() => {
    if (binding.value?.nodeId) return binding.value.nodeId
    return lastJob.value?.directorNodeId || directorNodeId(template.value?.api) || ''
  })

  const canvas = computed(() => ({
    width: cfg.value?.width ?? DEFAULT_OUTPUT_WIDTH,
    height: cfg.value?.height ?? DEFAULT_OUTPUT_HEIGHT
  }))

  /**
   * 现算一份 timeline（只取它，不打 zip）。
   * 失败不抛：没有 timeline 就退化成"探测不了"，页面不能白屏。
   */
  function buildTimeline(): Record<string, unknown> | null {
    if (!views.value.length) return null
    try {
      const res = buildDirectorPack({
        projectName: project.current?.name ?? '',
        settings: project.settings,
        segments: views.value.map((v) =>
          packSegmentOf(
            v,
            project.fieldSchema,
            registry.entityById,
            registry.assets,
            project.settings
          )
        ),
        assets: registry.assets,
        width: canvas.value.width,
        height: canvas.value.height
      })
      return res.timeline
    } catch {
      return null
    }
  }

  interface ResolvedTimeline {
    timeline: Record<string, unknown> | null
    source: 'binding' | 'job' | 'local'
  }

  /**
   * 段表从哪来。
   *
   * 顺序是「绑定 → 上次提交 → 本地重算」，越靠前越权威：
   *
   *   1. **绑定**：用户已经把这一集指到对面的某个缓存目录，它带着当时那份
   *      时间线（段位、帧数都是那次真正渲染用的），换台机器、换浏览器都还在；
   *   2. 上次提交：本机跑过就翻 `history` 里的 `timeline_data`；
   *   3. 本地重算：只是"还没跑过"时的预览，段被拆并过就会错位，页面上会标明。
   *
   * 缓存槽是按 timeline 的**位置**放的，所以这三条都必须拿到"当时那份"，
   * 拿"现在的段"去问会把第 3 段指到第 2 段上。
   */
  async function resolveTimeline(): Promise<ResolvedTimeline> {
    if (binding.value?.timeline) {
      return { timeline: binding.value.timeline, source: 'binding' }
    }
    const job = lastJob.value
    if (job?.promptId && nodeId.value) {
      try {
        const tl = await comfyPromptTimeline(job.baseUrl || baseUrl.value, job.promptId, nodeId.value)
        if (tl) return { timeline: tl, source: 'job' }
      } catch {
        /* history 拿不到：走本地兜底 */
      }
    }
    return { timeline: buildTimeline(), source: 'local' }
  }

  /** 从 timeline 的 segments 里读段表（帧数/秒数/段 id 都在里面） */
  function planFromTimeline(tl: Record<string, unknown> | null): SegmentPlanLite[] {
    const segs = Array.isArray(tl?.segments) ? (tl?.segments as Array<Record<string, unknown>>) : []
    // 只有段数对得上才敢借本地的"镜头数"：段被拆/并过之后，第 i 段已经不是同一段了
    const sameShape = plan.value.length === segs.length
    return segs.map((s, i) => ({
      label: typeof s.id === 'string' && s.id ? s.id : `seg${String(i + 1).padStart(2, '0')}`,
      frames: Number(s.frameCount ?? s.length ?? 0) || 0,
      beatCount: sameShape ? plan.value[i].beatCount : 0,
      seconds: Number(s.durationSec) > 0 ? Number(s.durationSec) : undefined,
      // 时间线里只有 `continuityFromPrev`（接缝重叠），和「引用上段」不是一回事：
      // 段表同形时以本地段的 refPrev 为准，拿不到才退化成时间线那个字段。
      refPrev:
        i > 0 &&
        (sameShape ? !!plan.value[i].refPrev : !!s.continuityFromPrev)
    }))
  }

  /* ------------------------------ 探测 ------------------------------ */

  async function refresh() {
    const resolved = await resolveTimeline()
    timelineSource.value = resolved.source
    const fromTimeline = planFromTimeline(resolved.timeline)
    // 段表以 timeline 为准；本地有段但 timeline 拿不到时，退回本地计划
    const rows = fromTimeline.length ? fromTimeline : plan.value
    await outputs.load(
      {
        baseUrl: baseUrl.value,
        nodeId: nodeId.value,
        workflowName: workflowName.value,
        timelineSource: resolved.source,
        timeline: resolved.timeline,
        fps: Number(project.settings.fps) || 24
      },
      rows
    )
    // 段数可能变了（拆/并/清空）：勾选要跟着收缩，别留下指向不存在槽位的 index。
    // 一采只收缩、不按链补（勾了哪段就是哪段）；二采仍要补齐 —— 刷新后
    // 不能留下半条链，那是二采唯一不能妥协的地方。
    picked.value = normalizeIndices(picked.value, segCount.value)
    pickedSecond.value = expandPicksFor('second', pickedSecond.value, linked.value, segCount.value)

    /*
     * 探测结果是"这一段出片了"最权威的信号，顺手记进段的台账。
     *
     * 记台账是为了后面的增删：有出片记录的段才谈得上"动它就作废"，
     * 也才谈得上"插空时躲开它"。节点说"没过期"就是内容确实有片 ——
     * 所以即使段号因为插空往后挪了，这里也不会把它误判成失效。
     */
    if (assembly.current && views.value.length === outputs.rows.length) {
      await assembly.sealProduced(assembly.current.id, views.value, outputs.rows)
    }
  }

  let loadedOnce = false

  /**
   * 老数据补绑：本机跑过、但还没落绑定的集，打开页面就顺手补上。
   *
   * 绑定本来是在提交成功那一刻自动写的（`run.submit` 里）。这条只是兼容
   * "绑定功能上线之前跑过的集" —— 不该让用户为了看回放再去点一次扫描。
   *
   * 返回是否真落了新绑定（落了的话，boundAt 的 watch 会自己重探，不必再来一次）。
   */
  async function adoptLastJob(): Promise<boolean> {
    const ep = episodeId.value
    const job = lastJob.value
    if (!ep || binding.value || !job?.promptId || !job.directorNodeId) return false
    try {
      const tl = await comfyPromptTimeline(job.baseUrl, job.promptId, job.directorNodeId)
      if (!tl) return false
      const b = cacheBind.autoBind(ep, {
        baseUrl: job.baseUrl,
        // 空串是节点自己的默认目录，也是合法目标
        workflowName: job.workflowName ?? '',
        nodeId: job.directorNodeId,
        promptId: job.promptId,
        segmentTotal: timelineSegmentCount(tl),
        timeline: tl
      })
      return !!b
    } catch {
      // 对面 history 被清过：保持未绑定，resolveTimeline 会退回本地现编
      return false
    }
  }

  async function ensureLoaded() {
    if (loadedOnce) return
    loadedOnce = true
    // 工作台只加载了 project/registry/beats/assembly；工作流、运行配置与缓存绑定要另外拉
    await Promise.all([workflow.load(), run.load(), cacheBind.load()])
    const adopted = await adoptLastJob()
    if (!adopted) await refresh()
    booted.value = true
  }

  // 交付页是 v-show 常驻的：别在别的阶段就发三个探测请求
  watch(
    active,
    (on) => {
      if (on) void ensureLoaded()
    },
    { immediate: true }
  )

  // 换集就重新探（顺便给这一集补绑）
  watch(episodeId, () => {
    picked.value = []
    pickedSecond.value = []
    // 还没进过交付页就不必探（进去时 ensureLoaded 会做）
    if (loadedOnce) {
      void (async () => {
        if (!(await adoptLastJob())) await refresh()
      })()
    }
  })

  // 绑定/解绑会换掉地址、目录与时间线：必须重探，否则页面还挂着上一个目录的段
  watch(
    () => binding.value?.boundAt ?? 0,
    () => {
      if (loadedOnce) void refresh()
    }
  )

  // 这一集的任务跑完之后，缓存就变了：自动重探一次，别让用户对着旧状态点"导出"
  watch(
    () => lastJob.value?.status,
    (now, before) => {
      if (now === 'done' && before !== 'done') void refresh()
    }
  )

  /* ------------------------------ 选段 ------------------------------ */

  /**
   * 每段是否「引用上段」。
   *
   * 引用上段的段，生成时要拿**上一段的末帧**当参考 ⇒ 它们在内容上连着一条链。
   * 但链**不是**勾选的最小单位：一采可以只勾一段（见 `togglePickFor`），
   * 只有二采才必须整条链一起走。
   *
   * 来源优先级：本地段（当前这一版交付）→ 缓存段表。本地段还在时它才是
   * "现在这版内容"的真相；本地段被清掉（只剩缓存可回放）时才看探测行。
   */
  const linked = computed<boolean[]>(() => {
    const rows = outputs.rows
    /*
     * 段表为空（还没探过 ComfyUI、或三个状态端点都没结果）时不能跟着空：
     * 那不是"形状不一致"，只是还没探测到片子，本地段仍然是唯一的真相。
     * 跟着空会让"引用上段"的箭头整排消失，而「③ 组合与缝合」上明明写着"是"。
     */
    if (views.value.length > 0 && (rows.length === 0 || views.value.length === rows.length)) {
      return views.value.map((v, i) => i > 0 && !!v.refPrev)
    }
    return rows.map((r, i) => i > 0 && !!r.refPrev)
  })

  /** 全部链（连续区间），给界面标"这一段属于哪条链" */
  const chains = computed(() => segmentChains(linked.value))

  /** 这一集有没有"引用上段"的链（没有就不必在界面上解释联动） */
  const hasChains = computed(() => chains.value.some((c) => c.length > 1))

  /** 第 i 段所在的整条链 */
  function chainOf(index: number): number[] {
    return chainOfIndex(linked.value, index)
  }

  /** 第 i 段所在链的标签；单段返回空串（不是链，不必显示） */
  function chainTag(index: number): string {
    const c = chainOf(index)
    return c.length > 1 ? chainLabel(c) : ''
  }

  /** 勾选的段索引。空 = 没选（不做事），不是"全选" */
  const picked = ref<number[]>([])

  /**
   * 二采自己那份勾选。
   *
   * 一采那份还兼着「这次跑哪几段」（批量进流水线）和左侧段列表的勾选框 ——
   * 如果导出二采时改的是同一份，用户回头一点"开始生成"就会少跑几段，
   * 而且从界面上完全看不出是什么时候被改的。所以两个来源各记一份。
   */
  const pickedSecond = ref<number[]>([])

  function pickedOf(source: ExportSource): number[] {
    return source === 'second' ? pickedSecond.value : picked.value
  }

  function setPicked(source: ExportSource, next: number[]): void {
    if (source === 'second') pickedSecond.value = next
    else picked.value = next
  }

  /**
   * 可选段的上界。
   *
   * 不能只看 `outputs.rows`：那是**ComfyUI 缓存探测**的结果，ComfyUI 没开、
   * 或这一集还没跑过，rows 就是空的。可交付的段来自本地组合（views），
   * 这时候"选中"仍然必须成立——以前按 rows 判长度，导致左侧勾选框点了没反应、
   * 「全选」也勾不上，看起来像界面坏了。
   */
  const segCount = computed(() => Math.max(outputs.rows.length, views.value.length))

  function isPicked(index: number): boolean {
    return picked.value.includes(index)
  }

  function isPickedFor(source: ExportSource, index: number): boolean {
    return pickedOf(source).includes(index)
  }

  /**
   * 这一段在当前来源下**能不能勾**。
   *
   * 一采：能。段表就是我们自己提交的那份，本地就有，没什么前提。
   * 二采：看一采 latent —— 二采是拿一采那份 latent 再采一遍，latent 不在就
   *       跑不起来（见 `domain/productDisplay.secondSelectable`）。已经出过二采
   *       缓存的段例外：导出是读磁盘，不需要 latent。
   *
   * 没探测到行（ComfyUI 没开 / 还没探过）时不拦：那时前端只有本地段表，
   * 一刀切禁掉会让整页二采都点不动，用户连"试试"都做不到。
   */
  function pickableFor(source: ExportSource, index: number): boolean {
    if (source !== 'second') return true
    const r = outputs.rows.find((x) => x.index === index)
    if (!r) return true
    return secondSelectable(r)
  }

  /** 二采下可勾的段数（几段有一采 latent 或已经有二采缓存） */
  const secondPickableCount = computed(
    () => Array.from({ length: segCount.value }, (_, i) => i).filter((i) => pickableFor('second', i)).length
  )

  /**
   * 把不可勾的段从当前勾选里摘掉。
   *
   * 用在**二采检测回来之后**：检测之前不知道哪段有 latent，勾选里可能留着
   * 上次会话选的段；检测完发现某段根本没一采 latent，还留着它只会让
   * "导出 N 段"变成一句空话。
   */
  function prunePickable(source: ExportSource): number[] {
    const before = pickedOf(source)
    const kept = before.filter((i) => pickableFor(source, i))
    if (kept.length !== before.length) setPicked(source, kept)
    return kept
  }

  /**
   * 勾一段。
   *
   * **一采（first）不按链**：勾哪段就是哪段。局部重跑是日常操作 —— 改一句台词
   * 只想重出这一段，若强制整条链，一勾就是七段一起跑（几十分钟），
   * 用户要的"只跑这一段"根本做不到。节点侧 `runSelection` 支持任意子集，
   * 上游没一起跑时，下游段会沿用上一次留在缓存里的那张末帧。
   *
   * **二采（second）按链**：二采是拿一采 latent 放大重采样，半条链进来时
   * 前后段接不上，拼片会断。这条约束只对二采成立。
   */
  function togglePickFor(source: ExportSource, index: number): boolean {
    if (index < 0 || index >= segCount.value) return false
    /*
     * 这一段自己不可勾（二采没有一采 latent）时直接拦住：
     * 勾一条缺了中间段的链，导出来还是缺段，不如当场拦住并让调用方说原因。
     */
    if (!pickableFor(source, index)) return false
    const chain = pickSpanFor(source, linked.value, index)
    if (!chain.length) return false
    const on = chain.every((i) => isPickedFor(source, i))
    if (on) {
      setPicked(
        source,
        pickedOf(source).filter((i) => !chain.includes(i))
      )
      return true
    }
    const next = new Set(pickedOf(source))
    for (const i of chain) if (i < segCount.value && pickableFor(source, i)) next.add(i)
    setPicked(
      source,
      [...next].sort((a, b) => a - b)
    )
    return true
  }

  function togglePick(index: number) {
    togglePickFor('first', index)
  }

  /*
   * 导出弹窗里的勾选：**不按链**。
   *
   * 二采"必须整条链"这条约束是给**跑**用的（采样要拿上一段的 x0 接缝）；
   * 导出只是把磁盘上早已成片的文件复制出去，不采样、不碰上游末帧 ——
   * 半条链导出不会"拼片断"，只会少两段。
   *
   * 反过来按链展开的代价却是实打实的：整集只有一条链时，点一下就在
   * "0 段"和"全部"之间跳，用户根本没法只导 seg02 + seg03。
   */
  function toggleExportPickFor(source: ExportSource, index: number): boolean {
    if (index < 0 || index >= segCount.value) return false
    if (!pickableFor(source, index)) return false
    const before = pickedOf(source)
    const next = before.includes(index)
      ? before.filter((i) => i !== index)
      : [...before, index].sort((a, b) => a - b)
    setPicked(source, next)
    return true
  }

  const allPicked = computed(
    () => segCount.value > 0 && picked.value.length >= segCount.value
  )

  function pickAllFor(source: ExportSource) {
    // 二采的「全选」只选得动可勾的段：没有一采 latent 的段选了也是白勾
    setPicked(
      source,
      Array.from({ length: segCount.value }, (_, i) => i).filter((i) => pickableFor(source, i))
    )
  }

  function pickAll() {
    pickAllFor('first')
  }

  function clearPickFor(source: ExportSource) {
    setPicked(source, [])
  }

  function clearPick() {
    clearPickFor('first')
  }

  const pickedRows = computed(() => outputs.rows.filter((r) => picked.value.includes(r.index)))
  const pickedFrames = computed(() => pickedRows.value.reduce((s, r) => s + r.frames, 0))
  const pickedSeconds = computed(() => pickedRows.value.reduce((s, r) => s + r.seconds, 0))
  const pickedLabels = computed(() => pickedRows.value.map((r) => r.label).join('、'))
  /** 勾选覆盖了几条引用链（"这 3 段其实是 1 条链"） */
  const pickedChains = computed(() => pickedChainCount(linked.value, picked.value))
  const pickSummary = computed(() => {
    const base = selectionSummary(outputs.rows.length, picked.value)
    if (!picked.value.length || picked.value.length >= outputs.rows.length) return base
    return pickedChains.value > 1 ? `${base} · ${pickedChains.value} 条链` : base
  })

  /* ------------------------------ 远程缓存绑定 ------------------------------ */

  /** 当前绑定的一句话摘要（页头 chip） */
  const bindingText = computed(() => bindingSummary(binding.value))
  /** 这条绑定怎么来的（弹窗里说明"不用你绑"） */
  const bindingOrigin = computed(() => bindingOriginText(binding.value))
  /** 绑定拿到了时间线才谈得上预览 */
  const bindingReady = computed(() => bindingUsable(binding.value))

  /** 扫描：把对面 history 里跑过的缓存目录列出来 */
  async function scanCaches(base: string) {
    return cacheBind.scan(normalizeBaseUrl(base || baseUrl.value))
  }

  /** 把某个远程目录改绑到**当前这一集**（只在自动绑定指错时才需要） */
  function bindCache(candidate: RemoteCacheCandidate, base: string) {
    if (!episodeId.value) {
      message.warning('先选中一集再绑定缓存')
      return null
    }
    const b = cacheBind.bind(candidate, episodeId.value, normalizeBaseUrl(base || baseUrl.value))
    message.success(
      `已改绑到「${b.workflowName || '默认目录'}」（${b.segmentTotal} 段），之后改名也不会换目录`
    )
    return b
  }

  function unbindCache() {
    if (!episodeId.value) return
    cacheBind.unbind(episodeId.value)
    message.success('已解除跟随：下次生成时会按那一跑重新自动绑定')
  }

  /* --------------------------- 统一参数 + 批量进流水线 --------------------------- */

  /**
   * 跑段 = 一次普通提交，时间线里带上「选择运行」的勾选。
   *
   * 勾几段就一次提交几段：它们进的是**同一条流水线**，节点按顺序逐段生成、
   * 未勾选的段缓存原样保留。不是"每段单独点一次"。
   *
   * 提交语义与运行台完全一样 —— 同一个 buildDirectorPack / 同一个 RunConfig /
   * 同一条 run.submit 路径，选择只是多带一个 `onlySegments`。
   */
  const showRun = ref(false)
  const submitting = ref(false)

  /**
   * 统一运行参数 = 运行配置里那一套。
   *
   * 不设草稿、不搞"仅本次"：参数是这一集的属性，改了立刻写回运行配置。
   * 于是"重跑这一段"、"批量跑 4 段"、"整片重出"用的必然是同一套数值 ——
   * 否则同一集里各段参数飘来飘去，拼成整片时根本对不上。
   */
  const pipe = computed<PipelineParams>(() => pipelineParamsFromConfig(cfg.value))
  const pipeSummary = computed(() => pipelineSummary(pipe.value))
  const pipeReady = computed(() => !!cfg.value)

  /**
   * 真正提交上去的段。
   *
   * 一采：就是勾选本身 —— 勾哪段跑哪段，勾一段跑一段。
   * 二采：按「引用上段」补齐整条链。二采是拿一采 latent 放大重采样，
   *       半条链进来时前后段接不上，拼片会断。
   *
   * 补齐只发生在**提交这一步**，勾选框本身不动 —— 用户"我想跑这段"的意图
   * 原样留着，改为在下单前显式告诉他"二采会连带跑成 N 段"，而不是悄悄改勾选。
   */
  const submitPicks = computed(() => {
    const stage = pipe.value.secondStage
    const source: ExportSource = stage === 'off' ? 'first' : 'second'
    return expandPicksFor(source, picked.value, linked.value, segCount.value)
  })

  /**
   * 弹窗里「真正要跑」的那几段 = `submitPicks`（二采按「引用上段」补齐之后）。
   *
   * 弹窗以前显示的是 `picked`：二采只勾 1 段时写着「开始生成 1 段」，
   * 实际提交的却是补齐后的 7 段 —— 耗时、显存、以及"会重跑别的段"这件事
   * 全被藏起来了。这里按实际提交的段算标签/帧数/秒数。
   */
  const submitRows = computed(() => {
    const fps = Number(project.settings.fps) || 24
    const out: Array<{ index: number; label: string; frames: number; seconds: number }> = []
    for (const i of submitPicks.value) {
      const row = outputs.rows.find((r) => r.index === i)
      if (row) {
        out.push({ index: i, label: row.label, frames: row.frames, seconds: row.seconds })
        continue
      }
      const v = views.value[i]
      if (!v) continue
      const frames = v.frames || 0
      out.push({
        index: i,
        label: `seg${String(i + 1).padStart(2, '0')}`,
        frames,
        seconds: frames / fps
      })
    }
    return out
  })
  const submitLabels = computed(() => submitRows.value.map((r) => r.label).join('、'))
  const submitFrames = computed(() => submitRows.value.reduce((s, r) => s + r.frames, 0))
  const submitSeconds = computed(() => submitRows.value.reduce((s, r) => s + r.seconds, 0))
  const submitSummary = computed(() =>
    selectionSummary(Math.max(outputs.rows.length, views.value.length), submitPicks.value)
  )

  /** 面板上任何一处改动都落到运行配置（run.patch 内部会防抖持久化） */
  function setPipe(patch: Partial<PipelineParams>) {
    const c = cfg.value
    if (!c) {
      message.warning('这一集还没绑定运行配置：先去「运行」建一个')
      return
    }
    const mapped = pipelineParamsPatch(patch)
    if (!Object.keys(mapped).length) return
    run.patch(c.id, mapped)
  }

  /**
   * 选卡：**可勾的卡**（0..可见数-1）。
   *
   * 以前是个下拉，候选是 `allCardSubsets()` 枚举出来的 15 种组合 —— 选项越多
   * 越难找，"就要 0 和 2 两张"得在一堆 `0,1,2` / `0,1,3` 里翻。改成打勾之后
   * 候选就是卡本身，勾几张就是几张。
   *
   * 可见数拿不到（ComfyUI 没连上 / 还没探）时，按当前已选的最高位兜底，至少
   * 让用户能看见自己选了什么，不至于一组空复选框。
   */
  const cardList = computed(() => {
    const visible = run.visibleCards ?? 0
    const picked = parseCardList(pipe.value.cards)
    const top = Math.max(visible, picked.length ? Math.max(...picked) + 1 : 0)
    return Array.from({ length: top }, (_, i) => i)
  })
  const cardPicked = computed(() => parseCardList(pipe.value.cards))
  const cardsUnknown = computed(() => (run.visibleCards ?? 0) <= 0)
  /**
   * ComfyUI 此刻能看见几张卡（0 = 没读到）。
   *
   * 勾选框的候选比它多是有意的：配置里存的卡号不该因为 ComfyUI 少开几张就消失
   * （那样用户看不见自己在用什么、也不知道该改哪里）。但**多出来的那些节点会直接
   * 报错**，所以页面上要标出来，而不是让人提交时才被拦。
   */
  const visibleCardCount = computed(() => run.visibleCards ?? 0)
  function toggleCardPipe(card: number) {
    setPipe({ cards: toggleCard(pipe.value.cards, card) })
  }
  function clearCards() {
    setPipe({ cards: CARD_OFF })
  }

  /* -------------------- 画布：像素密度 ↔ 宽高 -------------------- */

  /** 当前画布的像素密度（百万像素，按实际宽高算，不是配置里那个"目标"） */
  const pipeMegapixels = computed(() => canvasMegapixels(pipe.value.width, pipe.value.height))
  const pipeRatio = computed(() => canvasRatio(pipe.value.width, pipe.value.height))

  /**
   * 改像素密度：保持当前比例，反解宽高（都是 32 的倍数）。
   *
   * 为什么改成"输密度"而不是选档位：档位只有 8 个，而"这一段我想用 0.12 MP 试跑"
   * 这种需求是连续的；而且宽高本来就得是 32 的倍数，档位表永远填不满。
   */
  function setPipeMegapixels(mp: number | null) {
    if (!mp || mp <= 0) return
    const { width, height } = canvasFromMegapixels(mp, pipeRatio.value)
    setPipe({ width, height })
  }

  /** 改比例：保持当前像素密度，重算宽高 */
  function setPipeRatio(ratio: number) {
    if (!ratio || ratio <= 0) return
    const { width, height } = canvasFromMegapixels(pipeMegapixels.value, ratio)
    setPipe({ width, height })
  }

  /* -------------------- 二采：一套跟一采并排的旋钮 -------------------- */

  const secondStageOptions = computed(() => SECOND_STAGE_OPTIONS)
  const secondStage = computed(() => secondStageOf(cfg.value))

  /** 二采最终尺寸（按放大节点的公式算，与节点逐字一致） */
  const secondSize = computed(() =>
    secondTargetSize(pipe.value.width, pipe.value.height, {
      mode: pipe.value.secondUpscaleMode,
      megapixels: pipe.value.secondMegapixels,
      p: pipe.value.secondPTier,
      scale: pipe.value.secondScale,
      width: pipe.value.secondWidth,
      height: pipe.value.secondHeight,
      align: pipe.value.secondAlign
    })
  )

  /**
   * 图上 `second_sigmas` 口实际接到的 sigmas 文本（只读）。
   *
   * 面板「sigmas 留空 = 用图上现有接线」时，步数只能从这条线上算 ——
   * 写死 3 步会和图上接的 `ManualSigmas`（常常只有 2 条 = 1 步）对不上。
   */
  const secondSigmasWired = computed(() =>
    wiredSigmasText(template.value?.api, nodeId.value, 'second_sigmas')
  )

  /**
   * 三个运行按钮：先把"跑哪一档"写进配置，再打开确认框。
   *
   * 为什么要分三个而不是一个开关：这三档在节点上是**三条不同的路径**
   * （直接出一采 / 一采 latent 接二采 / 只跑二采），代价差一倍以上，
   * 而"这次要点哪个"是按下按钮那一刻才决定的，不该藏在二级开关里。
   *
   * 档位一写进配置，`submitPicks` 就跟着变：点「仅一采」= 勾了哪段跑哪段，
   * 点后两档 = 按「引用上段」补齐整条链。勾选框本身不动，弹窗里会说补到几段。
   */
  function runStage(stage: SecondStage) {
    const c = cfg.value
    if (!c) {
      message.warning('这一集还没绑定运行配置：先去「运行」建一个')
      return
    }
    setPipe({ secondStage: stage })
    void openRun()
  }

  /**
   * 任务类型的候选：取工作流里导演节点的真实枚举（跟「运行」页同一个来源）。
   *
   * 拿不到枚举时退化成"只有当前值"的一项 —— 绝不能让下拉变成空的，否则
   * 用户点开发现没得选，还以为这一项坏了。
   */
  const taskTypeOptions = computed(() => {
    const fromNode = director.specFor('task_type')?.options
    if (fromNode?.length) return fromNode.map((v) => ({ label: v, value: v }))
    const api = template.value?.api
    const id = directorNodeId(api)
    const raw = id ? api?.[id]?.inputs?.task_type : undefined
    if (Array.isArray(raw) && raw.length) {
      return raw.map((v) => ({ label: String(v), value: String(v) }))
    }
    const cur = pipe.value.taskType
    return cur ? [{ label: cur, value: cur }] : []
  })

  /**
   * 枚举类旋钮的候选：**优先 ComfyUI 此刻真实的 object_info**，取不到才回退常量。
   *
   * 常量表只有"常见子集"（13 个采样器），而节点上装了多少就是多少 —— 用户说
   * "选项不够"时，缺的往往正是这些没被写进常量的值（比如 dpmpp_3m_sde_gpu、
   * 自定义模型口）。与「运行」页同源，一处取 spec 两处都用。
   */
  function comboOptions(name: string, fallback: readonly string[]): string[] {
    const opts = director.specFor(name)?.options
    return opts?.length ? opts : [...fallback]
  }

  /**
   * 二采采样器：第一个固定是「跟随一采」（空串 = 不写，交给节点自己决定）。
   *
   * 节点侧是新加的 `second_sampler` widget：未接 `second_sigmas` 时"跟随一采"
   * 实际跟的是海螺二采默认的 euler，接了就是与一采同一个。老节点还没有这个键，
   * 写进去会被 ComfyUI 当未知输入忽略（不报错、也不生效）—— 重启 ComfyUI 即可。
   */
  const secondSamplerOptions = computed(() => [
    { label: SECOND_SAMPLER_FOLLOW, value: '' },
    ...comboOptions('second_sampler', SAMPLERS)
      .filter((v) => v && v !== SECOND_SAMPLER_FOLLOW)
      .map((v) => ({ label: v, value: v }))
  ])

  const samplerOptions = computed(() => comboOptions('sampler', SAMPLERS))
  const schedulerOptions = computed(() => comboOptions('scheduler', SCHEDULERS))
  const runModelOptions = computed(() => comboOptions('run_model', RUN_MODEL_CHOICES))
  const secondRunModelOptions = computed(() => comboOptions('second_run_model', RUN_MODEL_CHOICES))

  /**
   * 重新读一次 ComfyUI（顺带把"可见卡"填满勾选框）。
   *
   * 可见卡数只有一个来源：`system_stats.devices.length`，也就是 ComfyUI 启动时
   * `--cuda-device` 给了几张。不探一次，勾选框就是空的 —— 而这正是用户在交付页
   * 想干的第一件事，没道理让他先去「运行」页点一下「重新读取」。
   */
  const cardsReading = ref(false)
  async function refreshCards() {
    const url = cfg.value?.baseUrl
    if (!url) {
      message.warning('还没配 ComfyUI 地址（到「运行」页填一台）')
      return false
    }
    cardsReading.value = true
    try {
      const ok = await run.probe(url)
      if (!ok) message.warning(`没连上 ComfyUI：${run.onlineDetail || '无响应'}，可以手填卡号`)
      else if ((run.visibleCards ?? 0) > 0) message.success(`读到 ${run.visibleCards} 张可见卡`)
      else message.warning('连上了，但 system_stats 没报设备：手填卡号即可')
      return ok
    } finally {
      cardsReading.value = false
    }
  }

  /**
   * 导演节点规格（枚举 + 提示）与可见卡：进交付页时取一次。
   *
   * 规格照旧只要地址就取；探活（探卡）只在**这一页真的显示着**才发 —— 交付页是
   * v-show 常驻的，别的阶段没必要去敲 ComfyUI。
   *
   * 闸门记的是"探过哪个地址"而不是布尔：换了机器就该重探。探失败也算探过，
   * 否则 ComfyUI 后启动的话这里会一直等着 —— 那种情况点「重新读取」。
   */
  let cardsProbedUrl = ''
  watch(
    [() => cfg.value?.baseUrl, () => active.value] as const,
    ([url, on]) => {
      if (!url) return
      void director.loadSpec(url)
      if (on && url !== cardsProbedUrl) {
        cardsProbedUrl = url
        void refreshCards()
      }
    },
    { immediate: true }
  )

  /**
   * 这次提交会打到哪台机器、哪个缓存目录。
   *
   * 绑定优先：绑定就是"这一集生成时落在哪"，所以「批量进流水线」也必须写回同一个
   * 目录 —— 否则会跑到运行配置里那台默认机器上，缓存分家，回来又说找不到产物。
   */
  const submitTarget = computed(() => {
    const b = binding.value
    if (b) {
      return { baseUrl: b.baseUrl, dir: b.workflowName || '默认目录', fromBinding: true }
    }
    if (runRoute.value === 'replay') {
      return {
        baseUrl: lastJob.value?.baseUrl ?? '',
        dir: workflowName.value || '默认目录',
        fromBinding: false
      }
    }
    return {
      baseUrl: cfg.value?.baseUrl ?? '',
      dir: workflowName.value || '默认目录',
      fromBinding: false
    }
  })

  /**
   * 绑定存在时只改地址；**目录名交给 `run.submit` 统一钉死**。
   *
   * 两边各算一遍迟早会算出两个名字（一个 slug 过、一个没 slug），
   * 那就成了"绑的是 A 目录、写进了 B"。
   */
  function configForSubmit(rc: RunConfig): RunConfig {
    const b = binding.value
    if (!b?.baseUrl) return rc
    return { ...rc, baseUrl: b.baseUrl }
  }

  /**
   * 这一集能不能"按当前段重建导演包"。
   *
   * 不能的情况很常见：段被清空/重排过，本地只剩缓存。这时**绝不能**拿空的
   * local segments 去编包 —— 那会提交一个"0 段"的任务，跑出来是个莫名其妙的
   * 单段视频，还会把缓存覆盖掉。改成沿用上次提交的 prompt 原文重跑。
   */
  const rebuildable = computed(
    () => views.value.length > 0 && views.value.length === outputs.rows.length
  )

  /** rebuild = 按当前段重建；replay = 沿用上次提交的配方 */
  const runRoute = computed<'rebuild' | 'replay' | 'none'>(() =>
    rebuildable.value ? 'rebuild' : lastJob.value ? 'replay' : 'none'
  )

  /**
   * 单段入口落勾选（段详情「重跑这段」、产物区的重跑键）。
   *
   * 只勾这几段，**不扩链**：一采重跑单段是常规操作，扩链等于把"重跑这一段"
   * 悄悄变成"整集重跑"。引用了上段却没带上游时给一句提示 —— 它用的是上一次
   * 留在缓存里的末帧，这是预期行为，不是跑错了。
   * 二采按链的规则只在 `togglePickFor('second')` / 导出弹窗里，不在这里。
   */
  function pickForRun(indices: number[]): void {
    const wanted = [...new Set(indices)]
      .filter((i) => Number.isInteger(i) && i >= 0 && i < segCount.value)
      .sort((a, b) => a - b)
    if (!wanted.length) return
    picked.value = wanted
    const orphans = wanted.filter((i) => linked.value[i] && !wanted.includes(i - 1))
    if (orphans.length) {
      const names = orphans.map((i) => `seg${String(i + 1).padStart(2, '0')}`).join('、')
      message.info(`${names} 引用上段：上游这次不跑，会沿用上一次留下的末帧当参考`)
    }
  }

  /**
   * 打开"批量进流水线"的确认框。
   *
   * 注意这里**不重置任何参数** —— 参数是常驻的统一那套，弹窗只是确认
   * "哪几段、打哪儿、现在什么参数"。以前每次 openRun 都把草稿刷成配置值，
   * 于是用户在面板上改完、一开弹窗又被打回去，看起来就像"参数不生效"。
   */
  async function openRun(indices?: number[]) {
    if (indices?.length) pickForRun(indices)
    if (!picked.value.length) {
      message.warning('先勾选要跑的段')
      return
    }
    showRun.value = true
  }

  async function doRun() {
    if (!episodeId.value) return
    const rc = cfg.value
    if (!rc) {
      message.warning('这一集还没绑定运行配置：先去「运行」建一个')
      return
    }
    submitting.value = true
    try {
      let job
      if (rebuildable.value) {
        job = await submitWithLocalSegments(configForSubmit(rc))
      } else if (lastJob.value) {
        // 本地段不在了：沿用那次提交的模型/参考图/时间线，参数仍用统一那套
        job = await run.resubmit(lastJob.value, {
          onlySegments: submitPicks.value,
          secondOnly: pipe.value.secondStage === 'pair',
          inputs: pipelinePromptInputs(pipe.value),
          // 二采分辨率在放大节点、sigmas 在 ManualSigmas —— 都不在导演节点上，
          // 只能把整份配置交给 resubmit，让它按图去改
          secondPass: configForSubmit(rc)
        })
      } else {
        throw new Error(
          '这一集既没有本地段、也没有可对的历史提交 —— 先在「③ 组合与缝合」生成方案再跑一次'
        )
      }
      showRun.value = false
      const ran = submitPicks.value.length
      const extra = ran > picked.value.length ? `，二采按链补到 ${ran} 段` : ''
      message.success(
        `已加入流水线：${pickSummary.value}${extra}（同一套参数）· ${job.promptId.slice(0, 8)}…`
      )
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err), { duration: 9000 })
    } finally {
      submitting.value = false
    }
  }

  /** 正常路径：按当前段现编导演包再提交（会带上最新的内容改动） */
  async function submitWithLocalSegments(rc: RunConfig) {
    const tpl = template.value
    if (!tpl?.api) {
      throw new Error('这一集还没绑定可用的工作流模板：去「工作流控制台」导入 API 工作流')
    }
    // 参考图本体不在内存里的话，pack 会静默丢掉每一张图（对面退化成 t2v），
    // 所以提交前必须补齐 —— 与运行台同一条规矩。
    await registry.hydrateAssetBlobs()
    const input = {
      projectName: project.current?.name ?? '',
      settings: project.settings,
      segments: views.value.map((v) =>
        packSegmentOf(v, project.fieldSchema, registry.entityById, registry.assets, project.settings)
      ),
      assets: registry.assets,
      width: canvas.value.width,
      height: canvas.value.height
    }
    // 只有走 pack 导入时才需要真打 zip（打 zip 要压参考图，几百毫秒起）
    const built = rc.usePackImport
      ? await buildDirectorPackZip(input)
      : { blob: null, filename: '', timeline: buildDirectorPack(input).timeline }
    return run.submit({
      episodeId: episodeId.value,
      episodeName: project.current?.name ?? '',
      templateName: tpl.name,
      api: tpl.api,
      values: tpl.values,
      timeline: built.timeline,
      packBlob: rc.usePackImport ? built.blob : null,
      packFilename: built.filename,
      config: rc,
      onlySegments: submitPicks.value
    })
  }

  /* ------------------------------ 分段导出 ------------------------------ */

  const showExport = ref(false)
  const exportMode = ref<ExportMode>('piecewise')
  const exportSource = ref<ExportSource>('first')

  /** 当前来源下真正要导出的那几段（一采/二采各一份，互不影响） */
  const exportPicked = computed(() => pickedOf(exportSource.value))
  /*
   * 帧数/秒数优先取探测行；没有探测结果（ComfyUI 没开、还没探过）时退回本地段。
   * 不能只认 rows —— 那样"选中 4 段 · 0f · 0.0s"会在弹窗里挂一路。
   */
  const exportPickedFrames = computed(() =>
    exportPicked.value.reduce(
      (s, i) => s + (outputs.rows.find((r) => r.index === i)?.frames ?? views.value[i]?.frames ?? 0),
      0
    )
  )
  const exportPickedSeconds = computed(() => {
    const fps = Number(project.settings.fps) || 24
    return exportPicked.value.reduce((s, i) => {
      const row = outputs.rows.find((r) => r.index === i)
      if (row) return s + row.seconds
      const f = views.value[i]?.frames ?? 0
      return s + (f > 0 ? f / fps : 0)
    }, 0)
  })
  const exportPickSummary = computed(() =>
    selectionSummary(Math.max(outputs.rows.length, views.value.length), exportPicked.value)
  )
  const exportPickedChains = computed(() =>
    pickedChainCount(linked.value, exportPicked.value)
  )

  /** 二采：检测状态与入口（一步透传，页面别直接摸 store） */
  const secondProbing = computed(() => outputs.secondProbing)
  const secondProbedAt = computed(() => outputs.secondProbedAt)
  const secondError = computed(() => outputs.secondError)
  async function probeSecond(): Promise<number> {
    const n = await outputs.probeSecond()
    if (n < 0) message.warning(outputs.secondError || '二采状态没取到')
    return n
  }

  /**
   * 只勾"所选来源下真的有片"的段。
   * 导出弹窗里的「只选有成片的」用：比全选再逐段看状态省事。
   * 导出不按链（见 `toggleExportPickFor`）：有片的就是要导的，不再往两边补。
   */
  function pickWithClips(source: ExportSource = exportSource.value): number[] {
    const has = (i: number) => {
      const row = outputs.rows.find((r) => r.index === i)
      if (!row) return false
      return source === 'second' ? row.second.hasClip : row.first.hasClip
    }
    const wanted = Array.from({ length: segCount.value }, (_, i) => i).filter(has)
    const next = wanted.filter((i) => pickableFor(source, i) && i < segCount.value)
    setPicked(source, next)
    return next
  }

  /** 打开前把上一次的导出结果清掉：别让上一批文件混在这次的选择下面 */
  function resetExportResult() {
    outputs.exportResult = null
    outputs.exportError = ''
  }

  /**
   * 打开导出弹窗。
   *
   * `pick` 决定"没勾选时怎么办"：
   * - `all`  → 全选（顶部「导出」按钮：用户只是要导出，没表达"哪几段"）
   * - `keep` → 保持现有勾选，空了才全选（从左侧或段详情进来的，尊重用户的选择）
   * - `none` → 不补（严格的"必须先选"入口）
   */
  function openExport(indices?: number[], pick: 'all' | 'keep' | 'none' = 'keep') {
    const src = exportSource.value
    if (indices?.length) {
      const wanted = [...indices].sort((a, b) => a - b)
      // 二采按链补齐，一采只落这几段（和勾选框同一套规则）
      const filled = expandPicksFor(src, wanted, linked.value, segCount.value)
      setPicked(
        src,
        filled.filter((i) => pickableFor(src, i))
      )
    }
    if (!pickedOf(src).length) {
      if (pick === 'none') {
        message.warning('先勾选要导出的段')
        return
      }
      /*
       * 二采不在这里"全选"：哪几段真有二采成片，得等检测回来才知道。
       * 先按全选填上，检测完就分不清"用户选的"和"我们猜的"了 ——
       * 交给页面在检测完成后按结果勾（见 ensureSecondPicked）。
       */
      if (src !== 'second') pickAllFor(src)
    }
    resetExportResult()
    showExport.value = true
  }

  /** 选中的来源下已经有几段成片 —— 提示"导出来是空的"要在点之前说 */
  const sourceClipCount = computed(() =>
    exportSource.value === 'second' ? outputs.secondCount : outputs.firstCount
  )

  async function doExport() {
    const indices = exportPicked.value
    if (!indices.length) {
      message.warning('先勾选要导出的段')
      return
    }
    try {
      const res = await outputs.exportSegments(indices, exportMode.value, exportSource.value)
      if (res.files.length) {
        message.success(`已导出 ${res.files.length} 个文件到 ${res.exportDir || '输出目录'}`)
      } else {
        message.warning('一段都没导出来：这些段在所选来源下没有可导出的缓存')
      }
      if (res.skipped.length) {
        message.warning(`${res.skipped.length} 段被跳过（见导出结果）`, { duration: 8000 })
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err), { duration: 9000 })
    }
  }

  /** 导出文件的播放地址：`/api/comfy/view` 只认 output 下的相对 subfolder */
  function exportUrl(file: { filename: string; subfolder: string }): string {
    if (!file.subfolder) return ''
    return comfyViewUrl(baseUrl.value, file.filename, file.subfolder, 'output')
  }

  /* ------------------------------ 整片成片 ------------------------------ */

  /** 该集所有跑完的任务里，取最近几条有产物的 */
  const films = computed(() =>
    run.jobs
      .filter((j) => j.episodeId === episodeId.value && j.outputs.length)
      .slice(0, 3)
      .map((j) => ({
        id: j.id,
        promptId: j.promptId,
        at: j.endedAt ?? j.submittedAt,
        configName: j.configName,
        outputs: j.outputs.filter((o) => o.kind === 'video')
      }))
      .filter((f) => f.outputs.length)
  )

  /**
   * 重出整片。
   *
   * 为什么需要它：老版本提交时把 `CreateVideo` 留成了原生节点，导演节点的
   * uint8 帧被 `(frame * 255)` 整数回绕 ⇒ 整片是**负片**（段片段正常）。
   * 那段采样已经全在缓存里，重跑会逐段命中，只重做解码/合成，不用重新采样。
   */
  const redoing = ref(false)

  async function redoFilm() {
    const src = lastJob.value
    if (!src) {
      message.error('找不到上一次提交：先在「运行」里跑一次')
      return
    }
    redoing.value = true
    try {
      // 不传 onlySegments ⇒ 时间线里没有 runSelection ⇒ 全段重出
      const job = await run.resubmit(src, {})
      message.success(`已提交整片重出：${job.promptId.slice(0, 8)}…（段缓存命中，不重新采样）`, {
        duration: 6000
      })
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err), { duration: 9000 })
    } finally {
      redoing.value = false
    }
  }

  /** 最近那条任务：提交完之后用户要能看见"跑起来了 / 跑到几成" */
  const latestJob = computed(() => run.jobs.find((j) => j.episodeId === episodeId.value) ?? null)

  function jobPct(job: { progress: { value: number; max: number } }): number {
    if (!job.progress.max) return 0
    return Math.min(100, Math.round((job.progress.value / job.progress.max) * 100))
  }

  const latestBusy = computed(
    () =>
      !!latestJob.value && ['submitting', 'queued', 'running'].includes(latestJob.value.status)
  )

  /* ------------------------------ 展示辅助 ------------------------------ */

  const passLabel = passLabelText
  const passTone = passToneOf
  const poster = posterUrl

  function at(ts: number): string {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false })
  }

  return {
    // 状态
    booted,
    timelineSource,
    rows: computed(() => outputs.rows),
    loading: computed(() => outputs.loading),
    error: computed(() => outputs.error),
    firstCount: computed(() => outputs.firstCount),
    secondCount: computed(() => outputs.secondCount),
    staleCount: computed(() => outputs.staleCount),
    baseUrl,
    workflowName,
    cfg,
    lastJob,
    latestJob,
    latestBusy,
    rebuildable,
    runRoute,
    films,
    // 探测
    refresh,
    // 选段（一采勾哪段跑哪段；二采提交时按「引用上段」的链补齐，见 submitPicks）
    linked,
    chains,
    hasChains,
    chainOf,
    chainTag,
    pickedChains,
    picked,
    pickedSecond,
    submitPicks,
    isPicked,
    isPickedFor,
    pickableFor,
    prunePickable,
    secondPickableCount,
    togglePick,
    togglePickFor,
    toggleExportPickFor,
    allPicked,
    pickAll,
    pickAllFor,
    clearPick,
    clearPickFor,
    pickSummary,
    pickedLabels,
    pickedFrames,
    pickedSeconds,
    // 远程缓存绑定
    binding,
    bindingText,
    bindingOrigin,
    bindingReady,
    scanCaches,
    bindCache,
    unbindCache,
    cacheScanning: computed(() => cacheBind.scanning),
    cacheCandidates: computed(() => cacheBind.candidates),
    cacheScanError: computed(() => cacheBind.scanError),
    cacheScannedBase: computed(() => cacheBind.scannedBase),
    clearCacheCandidates: cacheBind.clearCandidates,
    // 运行（统一参数 + 批量进流水线）
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
    // 导出
    showExport,
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
    openExport,
    doExport,
    exportUrl,
    sourceClipCount,
    segCount,
    pickWithClips,
    resetExportResult,
    exportResult: computed(() => outputs.exportResult),
    exportError: computed(() => outputs.exportError),
    exporting: computed(() => outputs.exporting),
    // 整片
    redoing,
    redoFilm,
    // 展示
    passLabel,
    passTone,
    poster,
    jobPct,
    at
  }
}
