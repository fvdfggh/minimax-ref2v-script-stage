/* ------------------------------------------------------------------ *
 * 字段的中文名
 *
 * 字段的 `key` 是给节点 / 提示词 / 导出包用的**英文标识**，不能翻译 ——
 * 一改 key，导出的 JSON、导演包的槽位名全对不上。
 *
 * 但界面上直接铺 `overall_soundscape` 这种东西，等于让人对着变量名工作。
 * 所以：key 照旧（界面上缩成灰色小标，供对照），**主标题一律用中文**。
 *
 * 为什么不复用 `FieldSchema.label`：历史数据里 label 就是 key 的拷贝，
 * 用户在「字段配置」里改的 label 才是有意义的自定义名。这里的规则是
 * `自定义 label 优先，其次查表，最后退回 key`。
 * ------------------------------------------------------------------ */

export interface FieldLike {
  key: string
  label?: string
}

interface FieldMeta {
  /** 中文名：界面上当主标题用 */
  name: string
  /** 一句话说明这个字段该写什么（给用户看的，不是给模型） */
  hint: string
}

/** 默认 schema 的六个字段；自定义字段查不到就退回 key */
export const FIELD_META: Record<string, FieldMeta> = {
  subject_definitions: {
    name: '主体定义',
    hint: '这一段画面里有谁、各自对应哪张参考图'
  },
  summary: {
    name: '段落概述',
    hint: '这段讲什么，需以 [reference generation] 开头'
  },
  retention_analysis: {
    name: '留人分析',
    hint: '观众为什么要继续看下去'
  },
  detailed_description: {
    name: '详细画面描述',
    hint: '逐拍的镜头、动作、光线与质感'
  },
  overall_soundscape: {
    name: '整体声景',
    hint: '环境声与动作声，不重复对白'
  },
  non_diegetic_music: {
    name: '非叙事配乐',
    hint: '配乐的乐器与情绪走向；没有配乐填 N/A'
  }
}

/**
 * 界面显示用中文名。
 *
 * 自定义 label（和 key 不同）优先 —— 那是用户在字段配置里自己起的名字。
 */
export function fieldLabel(field: FieldLike): string {
  const custom = (field.label ?? '').trim()
  if (custom && custom !== field.key) return custom
  return FIELD_META[field.key]?.name ?? field.key
}

/** 字段的一句话说明；查不到返回空串 */
export function fieldHint(field: FieldLike): string {
  return FIELD_META[field.key]?.hint ?? ''
}

/** 只要中文名的简写，给门禁报错这种纯文本场景用 */
export function fieldName(key: string): string {
  return FIELD_META[key]?.name ?? key
}
