/* ------------------------------------------------------------------ *
 * 交付字段的模块分组
 *
 * 交付页的字段是可以自定义的（字段配置弹窗里能加），所以分组不能写死成
 * 「六个字段三张卡」。这里按 key 里的语义关键词归组，认不出来的落到
 * 「其他字段」——宁可多一张杂项卡，也不要因为加了个字段就整个不见了。
 *
 * 为什么放在 domain：分组是纯函数，界面（交付页 / 以后的导出预览）
 * 都该用同一套口径。两边各写一份，迟早出现"页面上一共 6 个字段、
 * 目录里只有 5 个"。
 * ------------------------------------------------------------------ */

import type { FieldSchema } from './types'

export type FieldGroupTone = 'blue' | 'violet' | 'teal' | 'amber' | 'slate'

export interface FieldGroupRule {
  id: string
  label: string
  /** 卡头上的灰字说明：一句话说清这组字段是干什么的 */
  hint: string
  tone: FieldGroupTone
  /** 命中 key 的正则（不区分大小写，调用方负责） */
  test: RegExp
}

/**
 * 顺序即展示顺序。
 *
 * 规则写的是"关键词"而不是"具体字段名"：字段配置里改名、加同义字段
 * （比如 custom_visual_style）也应该落在正确的组里。
 */
export const FIELD_GROUP_RULES: FieldGroupRule[] = [
  {
    id: 'subject',
    label: '主体与一致性',
    hint: '画面里有谁、参考图对应谁',
    tone: 'blue',
    test: /subject|entity|character|cast|reference|identity/i
  },
  {
    id: 'narrative',
    label: '叙事',
    hint: '这一段发生了什么、为什么留人',
    tone: 'violet',
    test: /summary|retention|narrative|story|plot|beat/i
  },
  {
    id: 'visual',
    label: '画面',
    hint: '镜头、动作、光线与质感',
    tone: 'teal',
    test: /descri|visual|shot|camera|lens|light|scene|action|motion/i
  },
  {
    id: 'audio',
    label: '声音',
    hint: '环境声、动作声与配乐',
    tone: 'amber',
    test: /sound|music|audio|voice|dialog|speech|ambien/i
  }
]

export interface FieldGroup {
  id: string
  label: string
  hint: string
  tone: FieldGroupTone
  fields: FieldSchema[]
}

const OTHER: Omit<FieldGroupRule, 'test'> = {
  id: 'other',
  label: '其他字段',
  hint: '自定义字段：没有归到上面几类',
  tone: 'slate'
}

/**
 * 按语义把字段分组成模块。
 *
 * - 保持 schema 里的相对顺序（字段配置里排的序就是页面上的序）；
 * - 空组不返回（不留一张空卡）；
 * - 同一字段只进第一个命中的组，不会重复出现。
 */
export function groupFields(schema: FieldSchema[]): FieldGroup[] {
  const buckets = new Map<string, FieldGroup>()
  for (const rule of FIELD_GROUP_RULES) {
    buckets.set(rule.id, { ...rule, fields: [] })
  }
  const other: FieldGroup = { ...OTHER, fields: [] }

  for (const field of schema) {
    const key = String(field.key ?? '')
    const hit = FIELD_GROUP_RULES.find((r) => r.test.test(key))
    const bucket = hit ? buckets.get(hit.id) : other
    bucket?.fields.push(field)
  }

  const out = FIELD_GROUP_RULES.map((r) => buckets.get(r.id)!).filter((g) => g.fields.length > 0)
  if (other.fields.length) out.push(other)
  return out
}
