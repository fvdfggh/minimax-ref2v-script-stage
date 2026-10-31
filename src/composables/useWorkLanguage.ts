import { computed, type ComputedRef } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useAssemblyStore, type SegmentView } from '@/stores/assembly'
import { usePipelineStore } from '@/stores/pipeline'
import { useProviderStore } from '@/stores/provider'
import { useRegistryStore } from '@/stores/registry'
import { enOnlyKeys, isZh } from '@/domain/lang'
import { fieldName } from '@/domain/fieldLabels'
import type { ID } from '@/domain/types'

/* ------------------------------------------------------------------ *
 * 工作语言：现在是不是英文终稿模式、切回中文要补哪些字段
 *
 * 为什么单独抽出来：以前「切回中文工作稿」只改一个开关，
 * 而模型字段的英文已经落在英文那一侧、中文那一侧是空的 ——
 * 切回去以后 ③ 组合与缝合 里那几项**还是英文**，看起来像按钮坏了。
 * 现在切回之前先算清楚「哪些字段只有英文」，由页面把选择摆在明面上：
 *   只切语言（英文留着，字段仍是英文）
 *   或顺手回写中文（en → zh，补齐中文那一侧）
 * ------------------------------------------------------------------ */

export interface LangGap {
  groupId: ID
  /** 段号，1 起 */
  segNo: number
  /** 只有英文的字段 key */
  keys: string[]
  /** 中文名，用于跟用户说清楚是哪些字段 */
  labels: string[]
}

export function useWorkLanguage(views: ComputedRef<SegmentView[]>) {
  const project = useProjectStore()
  const assembly = useAssemblyStore()
  const pipeline = usePipelineStore()
  const provider = useProviderStore()
  const registry = useRegistryStore()

  /** 英文终稿模式：③ 显示的是英文那一份 */
  const finalMode = computed(() => !isZh(project.settings.workLanguage))

  /** 哪些段的哪些模型字段只有英文 */
  const gaps = computed<LangGap[]>(() => {
    const schema = project.fieldSchema
    const out: LangGap[] = []
    views.value.forEach((v, i) => {
      const keys = enOnlyKeys(schema, v.fields, v.fieldsEn)
      if (!keys.length) return
      out.push({
        groupId: v.group.id,
        segNo: i + 1,
        keys,
        labels: keys.map((k) => fieldName(k))
      })
    })
    return out
  })

  /** 只有英文的字段总条数（段 × 字段） */
  const gapCount = computed(() => gaps.value.reduce((n, g) => n + g.keys.length, 0))

  /** 只有英文的字段名（去重，用于一句话说明） */
  const gapLabelText = computed(() => {
    const set = new Set<string>()
    for (const g of gaps.value) for (const l of g.labels) set.add(l)
    return [...set].join(' / ')
  })

  /** 中文名 → 英文名 */
  function entityNameMap(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const e of registry.entities) {
      if (e.nameEn?.trim()) out[e.name] = e.nameEn.trim()
    }
    return out
  }

  /** summary 有独立存储位，必须单独写 */
  async function writeZh(pid: ID, groupId: ID, fields: Record<string, string>) {
    const summary = fields.summary
    const rest: Record<string, string> = { ...fields }
    delete rest.summary
    if (summary) await assembly.setSummary(pid, groupId, summary, 'zh')
    if (Object.keys(rest).length) await assembly.setFields(pid, groupId, rest, 'zh')
  }

  /**
   * 切回中文工作稿。
   *
   * writeBack = true 时，先把「只有英文」的模型字段按 en→zh 回写中文，
   * 再切语言 —— 这样切过去看到的就是中文，而不是英文残影。
   */
  async function backToChinese(
    opts: { writeBack?: boolean; onProgress?: (text: string) => void } = {}
  ): Promise<{ translated: number; failed: string[] }> {
    const pid = project.currentId
    const failed: string[] = []
    let translated = 0
    if (!pid) return { translated, failed }

    if (opts.writeBack && gapCount.value) {
      const total = views.value.length
      for (const g of gaps.value) {
        const v = views.value.find((x) => x.group.id === g.groupId)
        if (!v) continue
        const tag = `seg${String(g.segNo).padStart(2, '0')}`
        opts.onProgress?.(`${tag} 回写中文…`)
        try {
          const out = await pipeline.runLocalizeOne(
            {
              id: g.groupId,
              schema: project.fieldSchema,
              beats: v.beats,
              entities: registry.entities,
              fields: { ...v.fieldsEn },
              index: g.segNo - 1,
              total,
              frames: v.frames,
              direction: 'en2zh'
            },
            project.settings,
            entityNameMap()
          )
          const picked: Record<string, string> = {}
          for (const k of g.keys) if ((out[k] ?? '').trim()) picked[k] = out[k]
          if (!Object.keys(picked).length) continue
          await writeZh(pid, g.groupId, picked)
          // 刚回写的内容与英文是同源的，别让它立刻被标成「待同步」
          await assembly.markSynced(pid, g.groupId, v.hash, Object.keys(picked))
          translated += Object.keys(picked).length
        } catch (e) {
          failed.push(`${tag}: ${(e as Error).message}`)
        }
      }
      opts.onProgress?.('')
    }

    await project.updateSettings({ workLanguage: 'zh' })
    return { translated, failed }
  }

  return {
    finalMode,
    gaps,
    gapCount,
    gapLabelText,
    backToChinese,
    provider
  }
}
