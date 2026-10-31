/**
 * 整段字段（模型字段）的批量动作 + 筛选。
 *
 * 为什么单开一份：这些逻辑原来挂在「④ 字段补全」那一页上，按段渲染一整个列表。
 * 现在字段并进了 ③ 的段卡片里 —— 页面上的工具条和卡片本身的字段块都要问
 * 同一批问题（这段缺几项、能不能生成、现在筛的是哪一类），各写一份必然走偏：
 * 「已补全」在工具条里算 done、在卡片里算 partial，人就会两边都不信。
 *
 * 所以口径只在这里：
 *   · 状态判定（待生成 / 缺 N 项 / 已补全 / 上游已改）
 *   · 批量目标（缺字段 + 过期）
 *   · 一次生成怎么落库、落完记什么指纹
 *
 * 视图本身由调用方传进来 —— ③ 页的 views 还带着接缝、出片台账、副帧，
 * 属于那一页的事，不在这里重算。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useRegistryStore } from '@/stores/registry'
import { useAssemblyStore, type SegmentView } from '@/stores/assembly'
import { usePipelineStore, type SegmentFillTask } from '@/stores/pipeline'
import { useProviderStore } from '@/stores/provider'
import { useGateStore } from '@/stores/gate'
import { fieldLabel } from '@/domain/fieldLabels'
import { langOf } from '@/domain/lang'
import type { FieldSchema } from '@/domain/types'

/** 列表筛选：全部 / 未补全 / 上游已改 / 已完成 */
export type FieldFilter = 'all' | 'incomplete' | 'stale' | 'done'

export interface SegFieldState {
  tone: 'ok' | 'warn' | 'err' | 'todo'
  label: string
}

export function useSegmentFields(views: ComputedRef<SegmentView[]> | Ref<SegmentView[]>) {
  const project = useProjectStore()
  const registry = useRegistryStore()
  const assembly = useAssemblyStore()
  const pipeline = usePipelineStore()
  const provider = useProviderStore()
  const gate = useGateStore()
  const message = useMessage()

  const concurrency = ref(2)
  const failed = ref<Record<string, string>>({})
  const running = ref(false)
  /** 一键展开所有段的字段（核对时不用一张张点） */
  const expandAll = ref(false)

  const schema = computed(() => project.fieldSchema)
  /** 需要（重新）生成的字段 */
  const llmFields = computed(() => schema.value.filter((f) => f.source === 'llm'))
  /** 派生字段：引擎按片段现算，用户改不了，排在最后并默认收起 */
  const derivedFields = computed(() => schema.value.filter((f) => f.source !== 'llm'))

  /** 字段值一律读交付口径（跟 ⑤ 面板、门禁、打包同一份） */
  function valueOf(v: SegmentView, key: string): string {
    return v.delivery[key] ?? ''
  }

  function missingOf(v: SegmentView): string[] {
    return llmFields.value.filter((f) => !valueOf(v, f.key).trim()).map((f) => f.key)
  }

  /** 缺的字段中文名，直接摆在段头上：`缺 2 项：整体声景、非叙事配乐` */
  function missingLabelOf(v: SegmentView): string {
    return llmFields.value
      .filter((f) => !valueOf(v, f.key).trim())
      .map((f) => fieldLabel(f))
      .join('、')
  }

  function fieldFilled(v: SegmentView, f: FieldSchema): boolean {
    return !!valueOf(v, f.key).trim()
  }

  function filledLlmOf(v: SegmentView): number {
    return llmFields.value.filter((f) => valueOf(v, f.key).trim()).length
  }

  function statusOf(v: SegmentView): 'empty' | 'partial' | 'done' {
    if (!llmFields.value.length) return 'done'
    const missing = missingOf(v).length
    if (missing === 0) return 'done'
    if (missing === llmFields.value.length) return 'empty'
    return 'partial'
  }

  /**
   * 段头上那一个状态胶囊 —— 颜色即结论：
   * 红 = 上游改过（内容不可信）、黄 = 缺字段、灰 = 还没生成、绿 = 齐了。
   */
  function segState(v: SegmentView): SegFieldState {
    if (failed.value[v.group.id]) return { tone: 'err', label: '生成失败' }
    const st = statusOf(v)
    if (v.stale) {
      return { tone: 'err', label: st === 'done' ? '上游已改' : `上游已改 · 缺 ${missingOf(v).length}` }
    }
    if (st === 'empty') return { tone: 'todo', label: '待生成' }
    if (st === 'partial') return { tone: 'warn', label: `缺 ${missingOf(v).length} 项` }
    return { tone: 'ok', label: '已补全' }
  }

  const stats = computed(() => {
    let done = 0
    let partial = 0
    let empty = 0
    for (const v of views.value) {
      const s = statusOf(v)
      if (s === 'done') done++
      else if (s === 'partial') partial++
      else empty++
    }
    const missingFields = views.value.reduce((sum, v) => sum + missingOf(v).length, 0)
    // 上游改过、内容已不可信的段
    const stale = views.value.filter((v) => v.stale).length
    // 补过帧、字段里的秒数可能对不上（不算过期，但要复核）
    const reframe = views.value.filter((v) => v.framesChanged).length
    return { done, partial, empty, missingFields, stale, reframe, total: views.value.length }
  })

  /** 需要（重新）生成的目标：字段空缺的 + 上游改过已过期的 */
  const targetsToFill = computed(() => views.value.filter((v) => missingOf(v).length > 0 || v.stale))

  const progressPercent = computed(() => {
    if (!views.value.length) return 0
    return Math.round((stats.value.done / views.value.length) * 100)
  })

  /* ------------------------------ 生成 ------------------------------ */

  async function writeBack(groupId: string, fields: Record<string, string>) {
    const pid = project.currentId
    if (!pid) return
    /*
     * 写到**当前工作语言**那一侧：中文工作稿写 zh、英文终稿写 en。
     * 以前写死 zh：英文终稿模式下重新生成，内容全落在中文那份里，
     * 页面上（显示的是英文那份）看不出任何变化，用户会以为「点了没反应」。
     */
    const side = langOf(project.settings)
    const summary = fields.summary
    const rest: Record<string, string> = { ...fields }
    delete rest.summary
    if (summary) await assembly.setSummary(pid, groupId, summary, side)
    if (Object.keys(rest).length) await assembly.setFields(pid, groupId, rest, side)

    // ★ 记下这次生成是基于哪份内容、多长的段。之后上游一改 / 补一帧，比对就知道要不要复核
    const v = views.value.find((x) => x.group.id === groupId)
    if (v) await assembly.markGenerated(pid, groupId, v.beats, registry.entities, v.frames)
  }

  function tasksFor(targets: SegmentView[]): SegmentFillTask[] {
    return targets.map((v) => ({
      id: v.group.id,
      schema: schema.value,
      beats: v.beats,
      entities: registry.entities,
      seamFromPrev: v.seam,
      nextSeam: v.nextSeam,
      existing: { ...v.fields },
      frames: v.frames,
      index: views.value.findIndex((x) => x.group.id === v.group.id)
    }))
  }

  async function run(targets: SegmentView[], label: string) {
    /*
     * 生成字段是花钱的动作，而且生成完的内容会被写回段里。
     * 组合还没通过（段超限 / 段级错误）时先生成，等修完段又全变成过期内容 ——
     * 所以先拦，别让用户白等一轮。
     */
    if (!gate.gates.assemble.passed) {
      message.error(`还不能生成字段：${gate.gates.assemble.errors[0] ?? ''}`, { duration: 8000 })
      return
    }
    if (!provider.ready) {
      message.warning('请先在模型设置里配置好供应商')
      return
    }
    if (!targets.length) {
      message.info('没有需要生成的段')
      return
    }
    if (!llmFields.value.length) {
      message.warning('当前字段配置里没有「模型生成」类型的字段')
      return
    }

    failed.value = {}
    running.value = true
    try {
      const result = await pipeline.fillSegments(
        tasksFor(targets),
        project.settings,
        async (taskId, fields, err) => {
          if (err) {
            failed.value = { ...failed.value, [taskId]: err }
            return
          }
          await writeBack(taskId, fields)
        },
        concurrency.value
      )
      if (result.failed) {
        message.warning(`${label}：成功 ${result.ok} 段，失败 ${result.failed} 段`)
      } else {
        message.success(`${label}：${result.ok} 段已补全`)
      }
    } finally {
      running.value = false
    }
  }

  function fillMissing() {
    run(targetsToFill.value, stats.value.stale ? '补空缺 + 重新生成过期段' : '补全空缺')
  }

  function regenerateAll() {
    run(views.value, '全部重生成')
  }

  function regenerateOne(v: SegmentView) {
    run([v], 'seg 重生成')
  }

  /* ------------------------------ 筛选 ------------------------------ */

  const listFilter = ref<FieldFilter>('all')

  const filterCounts = computed(() => ({
    all: views.value.length,
    incomplete: views.value.filter((v) => !v.stale && missingOf(v).length > 0).length,
    stale: views.value.filter((v) => v.stale).length,
    done: views.value.filter((v) => !v.stale && statusOf(v) === 'done').length
  }))

  const filters: Array<{ key: FieldFilter; label: string; tone: '' | 'warn' | 'ok' }> = [
    { key: 'all', label: '全部', tone: '' },
    { key: 'incomplete', label: '未补全', tone: '' },
    { key: 'stale', label: '上游已改', tone: 'warn' },
    { key: 'done', label: '已完成', tone: 'ok' }
  ]

  /** 这一段在当前筛选下要不要显示（段卡和它后面的插空口一起隐藏） */
  function hidden(v: SegmentView): boolean {
    if (listFilter.value === 'all') return false
    if (listFilter.value === 'stale') return !v.stale
    if (listFilter.value === 'incomplete') return v.stale || missingOf(v).length === 0
    return v.stale || missingOf(v).length > 0
  }

  return {
    // 口径
    llmFields,
    derivedFields,
    valueOf,
    fieldFilled,
    filledLlmOf,
    missingOf,
    missingLabelOf,
    statusOf,
    segState,
    stats,
    targetsToFill,
    progressPercent,
    // 生成
    concurrency,
    failed,
    running,
    fillMissing,
    regenerateAll,
    regenerateOne,
    // 筛选与展开
    listFilter,
    filterCounts,
    filters,
    hidden,
    expandAll
  }
}
