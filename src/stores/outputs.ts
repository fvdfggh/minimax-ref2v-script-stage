/**
 * 分段产物（一采 / 二采）。
 *
 * 剧本台的段 → ComfyUI 缓存里的段，靠 **index** 对齐：导演节点按时间线里的
 * 位置找缓存槽（`seg_*` / `seg2_*`），所以这里必须拿**和提交时同一份**
 * timeline 去问节点，index 才不会对到别人身上。
 *
 * 为什么不在前端自己猜：缓存是节点的私有布局（还会因为改段时间线把旧组
 * 顶成 `stale`），只有节点自己的 `segment_export_status` 知道"这段到底有没有
 * 成片、这份成片是不是旧渲染"。前端最多只能 `HEAD` 一下 URL 猜 404。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  comfySecondSampleStatus,
  comfySegmentClipUrl,
  comfySegmentExport,
  comfySegmentExportStatus,
  type SecondSampleRow,
  type SegmentExportRow
} from '@/core/comfy'
import {
  parseExportResult,
  type ExportMode,
  type ExportSource,
  type SegmentExportResult
} from '@/domain/segmentOps'
import { canSecondSampleOf } from '@/domain/productDisplay'

/** 一遍（一采 / 二采）在某一段上的状态 */
export interface PassOutput {
  /** 有现成的 mp4 片段，能直接播 */
  hasClip: boolean
  /** 张量帧还在（能导出，但没编码成片段） */
  hasFrames: boolean
  /** 只剩 latent（要重新 VAE 解码才能出片段） */
  hasLatent: boolean
  /** 这份缓存属于被顶掉的旧组 ⇒ 段内容改过了，画面是旧的 */
  stale: boolean
}

export interface SegmentProduct {
  index: number
  /** 段的显示名（timeline 里的 id，如 seg01）；本地计划回退时是 "seg01" */
  label: string
  /** 这一段的目标帧数（来自 timeline / 段计划，不是缓存里的） */
  frames: number
  seconds: number
  beatCount: number
  /**
   * 这一段是否「引用上段」（生成时拿上一段末帧当参考）。
   *
   * 二采的勾选要按它成链——见 `domain/segmentOps.segmentChains` / `pickSpanFor`。
   * 一采不受它约束（可以单段重跑）。缓存槽里没有
   * 这个信息，只能从"当时提交的时间线 / 本地段"带下来。
   */
  refPrev: boolean
  first: PassOutput
  second: PassOutput
  firstUrl: string
  secondUrl: string
  /** 一采 latent 在场 ⇒ 可以跑二采（前提，见 `domain/productDisplay.canSecondSampleOf`） */
  canSecondSample: boolean
}

export interface ProductContext {
  baseUrl: string
  nodeId: string
  workflowName: string
  /** 这份 timeline 从哪来：绑定的远程缓存 / 提交时的 history / 本地按当前段重算 */
  timelineSource: 'binding' | 'job' | 'local'
  /** 提交时那份 timeline（对象形式） */
  timeline: Record<string, unknown> | null
  fps: number
}

/** 一段的目标帧数/镜头数/显示名，由调用方（timeline 或段的交付计划）提供 */
export interface SegmentPlanLite {
  frames: number
  beatCount: number
  label?: string
  /** timeline 里已经给了秒数就直接用（省得按 fps 反算） */
  seconds?: number
  /** 这一段是否引用上段（决定它和上一段是不是同一条链） */
  refPrev?: boolean
}

function emptyPass(): PassOutput {
  return { hasClip: false, hasFrames: false, hasLatent: false, stale: false }
}

function fromExportRow(row: SegmentExportRow | undefined): PassOutput {
  if (!row) return emptyPass()
  return {
    hasClip: !!row.hasClip,
    hasFrames: !!row.hasFrames,
    hasLatent: !!row.hasLatent,
    stale: !!row.stale
  }
}

export const useOutputsStore = defineStore('outputs', () => {
  const rows = ref<SegmentProduct[]>([])
  const loading = ref(false)
  const error = ref('')
  const loadedAt = ref(0)
  /** 这次探测用的上下文（排查"为什么全空"时要能看见它） */
  const ctx = ref<ProductContext | null>(null)
  /** 探测是否真的问到了 ComfyUI（false ⇒ 下面的状态都不可信） */
  const probed = ref(false)
  /** 上次探测用的段表 —— 导出/刷新要拿它重建，不能每次重算（段表得同源） */
  const lastPlan = ref<SegmentPlanLite[]>([])

  /** 分段导出的状态：进行中 / 最近一次结果 / 错误 */
  const exporting = ref(false)
  const exportResult = ref<SegmentExportResult | null>(null)
  const exportError = ref('')

  /**
   * 二采的单独探测状态。
   *
   * 一采是"这一次生成"的直接产物，段表 + 缓存槽前端手上就有；二采不是 ——
   * 它可能在另一轮任务、另一台机器，甚至是在 ComfyUI 上手动点出来的。
   * 所以在让人挑二采之前，必须现问一次节点，而不是拿页面加载时那份旧结果。
   */
  const secondProbing = ref(false)
  const secondProbedAt = ref(0)
  const secondError = ref('')

  const firstCount = computed(() => rows.value.filter((r) => r.first.hasClip).length)
  const secondCount = computed(() => rows.value.filter((r) => r.second.hasClip).length)
  const staleCount = computed(
    () => rows.value.filter((r) => r.first.stale || r.second.stale).length
  )

  function blank(plan: SegmentPlanLite[], c: ProductContext): SegmentProduct[] {
    return plan.map((p, i) => ({
      index: i,
      label: p.label || `seg${String(i + 1).padStart(2, '0')}`,
      frames: p.frames,
      seconds: p.seconds ?? (p.frames > 0 && c.fps > 0 ? p.frames / c.fps : 0),
      beatCount: p.beatCount,
      refPrev: i > 0 && !!p.refPrev,
      first: emptyPass(),
      second: emptyPass(),
      firstUrl: c.nodeId ? comfySegmentClipUrl(c.baseUrl, { nodeId: c.nodeId, workflowName: c.workflowName, index: i, pass: 'first' }) : '',
      secondUrl: c.nodeId ? comfySegmentClipUrl(c.baseUrl, { nodeId: c.nodeId, workflowName: c.workflowName, index: i, pass: 'second' }) : '',
      canSecondSample: false
    }))
  }

  /**
   * 探一次。`plan` 是剧本台自己的段计划，长度决定显示几段。
   *
   * 三个状态端点并发；任何一个失败都不该让整页空白 —— 失败的那一遍按
   * "没有" 处理，并把原因写进 `error`，其余照常显示。
   */
  async function load(c: ProductContext, plan: SegmentPlanLite[]): Promise<void> {
    ctx.value = c
    probed.value = false
    error.value = ''
    secondProbedAt.value = 0
    secondError.value = ''
    rows.value = blank(plan, c)
    lastPlan.value = plan
    if (!plan.length) return
    if (!c.baseUrl) {
      error.value = '没有可用的 ComfyUI 地址：先到「运行」建一个运行配置。'
      return
    }
    if (!c.nodeId) {
      error.value = '当前工作流里没有导演节点（MiniMaxH3DirectorOpt），不知道产物该找谁要。'
      return
    }
    if (!c.timeline) {
      error.value = '还没生成导演包时间线：先在「运行」里提交过一次，或确认交付页有段。'
      return
    }

    loading.value = true
    const body = {
      node_id: c.nodeId,
      workflow_name: c.workflowName,
      timeline_data: JSON.stringify(c.timeline)
    }
    const errors: string[] = []
    const [firstRes, secondRes, sampleRes] = await Promise.all([
      comfySegmentExportStatus(c.baseUrl, body, 'first').catch((err: unknown) => {
        errors.push(`一采状态：${err instanceof Error ? err.message : String(err)}`)
        return [] as SegmentExportRow[]
      }),
      comfySegmentExportStatus(c.baseUrl, body, 'second').catch((err: unknown) => {
        errors.push(`二采状态：${err instanceof Error ? err.message : String(err)}`)
        return [] as SegmentExportRow[]
      }),
      comfySecondSampleStatus(c.baseUrl, body).catch((err: unknown) => {
        errors.push(`二采可用性：${err instanceof Error ? err.message : String(err)}`)
        return [] as SecondSampleRow[]
      })
    ])

    const byFirst = new Map(firstRes.map((r) => [Number(r.index), r]))
    const bySecond = new Map(secondRes.map((r) => [Number(r.index), r]))
    const bySample = new Map(sampleRes.map((r) => [Number(r.index), r]))

    rows.value = blank(plan, c).map((row) => {
      const f = fromExportRow(byFirst.get(row.index))
      const s = fromExportRow(bySecond.get(row.index))
      const sample = bySample.get(row.index)
      return {
        ...row,
        first: f,
        // 二采："有 seg2 latent" 也算做过（还没编码成片段时也让它显示出来）
        second: {
          ...s,
          hasLatent: s.hasLatent || !!sample?.hasSecondLatent
        },
        // 二采能不能跑，**看一采 latent**：节点那一份只是补充条件，不是依据
        canSecondSample: canSecondSampleOf(f, sample)
      }
    })
    // 三个都挂了才算彻底失败；部分失败仍然给用户看到的那部分
    if (errors.length === 3) error.value = errors.join('；')
    else if (errors.length) error.value = `部分状态没取到：${errors.join('；')}`
    probed.value = errors.length < 3
    // 整探也算把二采问到了：进二采时不必立刻再问一次
    if (!errors.some((e) => e.startsWith('二采状态'))) secondProbedAt.value = Date.now()
    loadedAt.value = Date.now()
    loading.value = false
  }

  /**
   * 只重探二采（一采不动）。
   *
   * 为什么单独一条：一采的选择完全由前端决定（段表就是我们自己提交的那份），
   * 二采却可能随时被外部改变 —— 别的机器跑完二采、在 ComfyUI 上手动补跑一段，
   * 前端都不会收到通知。所以"进二采导出"这个动作前要现检一次。
   *
   * 复用的是 `load()` 记下的上下文（同一份 timeline），否则 index 会指到
   * 别的段上 —— 这就不是"检测"，是"猜"。
   *
   * 返回这次探到的二采成片段数；失败时返回 -1（调用方据此提示，别把空当成"没有"）。
   */
  async function probeSecond(): Promise<number> {
    const c = ctx.value
    if (!lastPlan.value.length) return -1
    if (!c?.baseUrl || !c.nodeId || !c.timeline) {
      secondError.value = '还没有可用的缓存上下文：先在交付页探测一次产物'
      return -1
    }
    if (secondProbing.value) return secondCount.value
    secondProbing.value = true
    secondError.value = ''
    try {
      const body = {
        node_id: c.nodeId,
        workflow_name: c.workflowName,
        timeline_data: JSON.stringify(c.timeline)
      }
      const [secondRes, sampleRes] = await Promise.all([
        comfySegmentExportStatus(c.baseUrl, body, 'second'),
        comfySecondSampleStatus(c.baseUrl, body)
      ])
      const bySecond = new Map(secondRes.map((r) => [Number(r.index), r]))
      const bySample = new Map(sampleRes.map((r) => [Number(r.index), r]))
      rows.value = rows.value.map((row) => {
        const s = fromExportRow(bySecond.get(row.index))
        const sample = bySample.get(row.index)
        return {
          ...row,
          second: {
            ...s,
            hasLatent: s.hasLatent || !!sample?.hasSecondLatent
          },
          // 同 load()：一采 latent 是二采的前提。这里的一采状态不重探（一采由前端说了算），
          // 所以拿 `second_sample_status` 现问回来的 `hasLatent` 兜底。
          canSecondSample: canSecondSampleOf(row.first, sample)
        }
      })
      secondProbedAt.value = Date.now()
      return secondCount.value
    } catch (err) {
      secondError.value = `二采状态没取到：${err instanceof Error ? err.message : String(err)}`
      return -1
    } finally {
      secondProbing.value = false
    }
  }

  /**
   * 分段导出。
   *
   * 直接打导演节点的 `segment_export`：它是**纯磁盘操作**（把缓存里的成片
   * 复制/拼接出去），不进 ComfyUI 队列、不重新渲染，所以不需要等队列空闲，
   * 也不会把正在跑的任务挤掉。
   *
   * 段索引与时间线必须来自同一次探测（`ctx` 里那份），否则导出的可能是
   * 别的段 —— 这就是为什么这里不接受调用方传 timeline。
   */
  async function exportSegments(
    indices: number[],
    mode: ExportMode,
    source: ExportSource
  ): Promise<SegmentExportResult> {
    const c = ctx.value
    if (!c?.baseUrl) throw new Error('没有可用的 ComfyUI 地址')
    if (!c.nodeId) throw new Error('当前工作流里没有导演节点')
    if (!c.timeline) throw new Error('没有可用的时间线，先跑一次再导出')
    if (!indices.length) throw new Error('没勾选任何段')
    exporting.value = true
    exportError.value = ''
    try {
      const raw = await comfySegmentExport(c.baseUrl, {
        node_id: c.nodeId,
        workflow_name: c.workflowName,
        timeline_data: JSON.stringify(c.timeline),
        indices: [...indices].sort((a, b) => a - b),
        mode,
        source: source === 'second' ? '2nd' : '1st'
      })
      const result = parseExportResult(raw)
      exportResult.value = result
      return result
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      exportError.value = text
      throw err
    } finally {
      exporting.value = false
    }
  }

  /** 按上次的段表与上下文重探一次（导出后、或手动刷新） */
  async function reload(): Promise<void> {
    if (!ctx.value || !lastPlan.value.length) return
    await load(ctx.value, lastPlan.value)
  }

  function reset(): void {
    rows.value = []
    error.value = ''
    probed.value = false
    loading.value = false
    ctx.value = null
    loadedAt.value = 0
    lastPlan.value = []
    exporting.value = false
    exportResult.value = null
    exportError.value = ''
    secondProbing.value = false
    secondProbedAt.value = 0
    secondError.value = ''
  }

  return {
    rows,
    loading,
    error,
    probed,
    ctx,
    lastPlan,
    loadedAt,
    exporting,
    exportResult,
    exportError,
    secondProbing,
    secondProbedAt,
    secondError,
    firstCount,
    secondCount,
    staleCount,
    load,
    reload,
    probeSecond,
    exportSegments,
    reset
  }
})
