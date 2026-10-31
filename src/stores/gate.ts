/**
 * 门禁数据源 —— 把散在各 store 里的东西拼成 `domain/gate` 要的输入。
 *
 * 为什么单独一层：
 *
 * `domain/gate` 是纯函数，不认识 pinia；而判定需要 6 个 store 的数据（片段、
 * 实体、素材、设置、字段、方案）。如果让导航页和各个「生成」按钮各拼一次，
 * 拼错的概率远大于写错的概率 —— 少传 assets，关键帧就会全被判成缺失。
 *
 * 所以：**输入怎么拼、结果怎么算，只在这里做一次**。导航读 `gates/blockers`，
 * 生成按钮读 `guard(action)`，两边不可能不一致。
 */
import { computed } from 'vue'
import { defineStore } from 'pinia'
import { useProjectStore } from './project'
import { useRegistryStore } from './registry'
import { useBeatStore } from './beats'
import { useAssemblyStore } from './assembly'
import {
  GATE_ORDER,
  blockersOf,
  evaluateGates,
  generationBlockers,
  type GateInput,
  type GateStage,
  type GenerationAction,
  type StageGate
} from '@/domain/gate'

export const useGateStore = defineStore('gate', () => {
  const project = useProjectStore()
  const registry = useRegistryStore()
  const beats = useBeatStore()
  const assembly = useAssemblyStore()

  /** 段视图：门禁必须和 ③④⑤ 各页看到的是同一份 */
  const views = computed(() => {
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

  const input = computed<GateInput>(() => ({
    beats: beats.ordered,
    entities: registry.entities,
    assets: registry.assets,
    entityById: registry.entityById,
    settings: project.settings,
    schema: project.fieldSchema,
    assembly: assembly.current,
    // beatIds 是"链"判定要用的：链是段级的，素材卡片是 beat 级的
    /*
     * 门禁看的是**要交付的那份**：en 模式看英文终稿，zh 模式看中文工作稿。
     * 跟 ⑤ 交付页显示、导演包提示词、导出用的是同一个函数 —— 三者必须一致，
     * 否则就会出现「页面上明明写着，门禁却报字段为空」。
     */
    segments: views.value.map((v) => ({
      ...v,
      fields: v.delivery,
      beatIds: v.group.beatIds,
      refPrev: v.refPrev
    })),
    globalIssues: assembly.current
      ? assembly.globalIssues(
          views.value,
          registry.entities,
          beats.ordered,
          project.settings,
          registry.entityById,
          project.fieldSchema
        )
      : []
  }))

  const gates = computed(() => evaluateGates(input.value))

  /** 每个阶段被哪些「上游没做完」挡住。一次算全，7 个 tab 共用。 */
  const blockers = computed(() => {
    const out = {} as Record<GateStage, StageGate[]>
    for (const k of GATE_ORDER) out[k] = blockersOf(gates.value, k)
    return out
  })

  /**
   * 生成前的拦截清单。空数组才允许提交。
   *
   * 用函数而不是 computed：它带 action 参数，两个动作要的关不一样
   * （出片比出关键帧多要方案、字段、关键帧齐）。
   */
  function guard(action: GenerationAction): string[] {
    return generationBlockers(action, input.value)
  }

  return { views, input, gates, blockers, guard }
})
