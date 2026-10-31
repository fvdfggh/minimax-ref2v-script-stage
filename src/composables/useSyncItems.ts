import { computed } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { useAssemblyStore, type SegmentView } from '@/stores/assembly'
import { fieldLabel } from '@/domain/fieldLabels'
import { collectSyncItems, statsOf } from '@/domain/fieldSync'
import type { ID } from '@/domain/types'

/**
 * 待同步清单：中英两份字段 + 它们引用的内容，哪里对不上了。
 *
 * 抽成 composable 是因为有两个地方要这份数据：
 *   · 「同步」页自己列清单；
 *   · 工作台的 tab 上要显示「有几项待同步」—— 不能只有点进去才知道。
 *
 * 判定全在 domain/fieldSync（纯函数）；这里只负责把 store 的数据摊成它认识的形状。
 */
export function useSyncItems() {
  const project = useProjectStore()
  const beats = useBeatStore()
  const registry = useRegistryStore()
  const assembly = useAssemblyStore()

  const views = computed<SegmentView[]>(() => {
    const asm = assembly.current
    if (!asm) return []
    return assembly.buildSegmentViews(
      asm,
      beats.ordered,
      project.settings,
      registry.entityById,
      project.fieldSchema,
      registry.assets
    )
  })

  const fieldMetas = computed(() =>
    project.fieldSchema.map((f) => ({
      key: f.key,
      label: fieldLabel(f),
      source: (f.source === 'llm' ? 'llm' : 'derived') as 'llm' | 'derived'
    }))
  )

  /**
   * 引用了什么变了 —— 段级过期原因压成一句短话。
   *
   * 只说「上游改过」等于让用户自己去翻整集；这里把变了几拍、几个主体带出来，
   * 同步页那一行才知道自己为什么要重做。
   */
  function srcNoteOf(v: SegmentView): string | undefined {
    if (!v.stale) return undefined
    const why = v.staleWhy
    if (!why) return '本段引用的内容改过'
    const bits: string[] = []
    if (why.beats.length) bits.push(`${why.beats.length} 拍的字段改了`)
    if (why.removed.length) bits.push(`少掉 ${why.removed.length} 拍`)
    if (why.entities.length) bits.push(`${why.entities.length} 个主体词条改了`)
    return bits.length ? bits.join('、') : undefined
  }

  const items = computed(() =>
    collectSyncItems(
      views.value.map((v, i) => ({
        groupId: v.group.id,
        segNo: i + 1,
        zh: v.fields,
        en: v.fieldsEn,
        sync: v.fieldSync,
        stale: v.stale,
        // 段级过期就是"引用的东西变了"；没有逐字段基线时靠它兜底
        srcChanged: v.stale,
        srcNote: srcNoteOf(v)
      })),
      fieldMetas.value
    )
  )

  const stats = computed(() => statsOf(items.value))
  const itemsOfGroup = computed(() => {
    const map = new Map<ID, number>()
    for (const i of items.value) map.set(i.groupId, (map.get(i.groupId) ?? 0) + 1)
    return map
  })

  return { views, fieldMetas, items, stats, itemsOfGroup }
}
