import type { Beat, Entity, Lang } from './types'

export type { Lang }

/* ------------------------------------------------------------------ *
 * 流水线语言
 *
 *   zh —— 阶段①~④ 全部用中文撰写，人工审阅 / 修改都不必读英文
 *   en —— 直接生成规范英文终稿，跳过本地化阶段
 *
 * 关键设计：结构锚点在中英两种语言下都保持英文原文 ——
 *   <Subject N> / (Sx) / <Picture N> / <d> / [Shot N] At 00:00.000, /
 *   Only X is in frame. / says: / speaking with / fully_preserved
 * 本地化阶段只替换「自由描述」，锚点由引擎直接拼装、不经过模型，
 * 因此结构不可能被翻译改坏，校验规则也不必按语言分叉。
 * ------------------------------------------------------------------ */

/**
 * 兜底语言。
 *
 * ★ 必须与 ProjectSettings.workLanguage 的默认值（DEFAULT_SETTINGS.workLanguage = 'zh'）一致。
 * 这两处一旦不一致，就会出现最难查的一类问题：
 * 在语言字段还没写进库的项目上，「缺字段」被兜成 en，
 * 于是中文工作稿在阶段①~④ 就满屏报「必须为英文」—— 本地化还没做，校验先炸了。
 */
export const DEFAULT_LANG: Lang = 'zh'

/** 只认显式的 'en'，其余（缺失 / 非法值）一律按默认工作语言处理 */
export function normalizeLang(v: unknown): Lang {
  return v === 'en' ? 'en' : DEFAULT_LANG
}

export function isZh(lang: Lang | undefined): boolean {
  return (lang ?? DEFAULT_LANG) === 'zh'
}

export function langOf(settings: { workLanguage?: Lang } | undefined): Lang {
  return normalizeLang(settings?.workLanguage)
}

export const LANG_LABEL: Record<Lang, string> = {
  zh: '中文（阶段①~④ 中文，阶段⑤ 转英文）',
  en: '英文（全程直接产出英文终稿）'
}

/* ------------------------------------------------------------------ *
 * 词条解析：英文模式下优先取「英文词条」，缺失则回退原文
 * 这样本地化阶段的翻译成果是逐条落库的，可人工修正、可跨段复用
 * ------------------------------------------------------------------ */

function pick(primary: string | null | undefined, fallback: string): string {
  const v = (primary ?? '').trim()
  return v || fallback
}

export function entityName(e: Entity, lang: Lang): string {
  return isZh(lang) ? e.name : pick(e.nameEn, e.name)
}

export function entityTextDesc(e: Entity, lang: Lang): string {
  return isZh(lang) ? (e.textDesc ?? '') : pick(e.textDescEn, e.textDesc ?? '')
}

/** 音色描述：必须跨段逐字一致，英文模式下取词条表的英文版 */
export function entityVoiceDesc(e: Entity, lang: Lang): string {
  return isZh(lang) ? (e.voiceDesc ?? '') : pick(e.voiceDescEn, e.voiceDesc ?? '')
}

export function beatTitle(b: Beat, lang: Lang): string {
  return isZh(lang) ? b.title : pick(b.titleEn, b.title)
}

export function beatDirection(b: Beat, lang: Lang): string {
  return isZh(lang) ? (b.direction ?? '') : pick(b.directionEn, b.direction ?? '')
}

export function beatVisualDesc(b: Beat, lang: Lang): string {
  return isZh(lang) ? (b.visualDesc ?? '') : pick(b.visualDescEn, b.visualDesc ?? '')
}

/** 常规镜头行的主体描述：画面细节优先，其次运镜，最后退回标题 */
export function beatShotText(b: Beat, lang: Lang): string {
  const desc = [beatVisualDesc(b, lang), beatDirection(b, lang)].filter(Boolean).join(' ')
  return desc || beatTitle(b, lang)
}

/* ------------------------------------------------------------------ *
 * 中英双语句式
 * 自由描述部分跟随语言，结构锚点固定英文
 * ------------------------------------------------------------------ */

/** 预备镜头：整段独占说话人，无台词 */
export function preshootText(lang: Lang, name: string): string {
  return isZh(lang)
    ? `Only ${name} is in frame. 无台词，动作极小。`
    : `Only ${name} is in frame, no dialogue, minimal motion.`
}

/** 段尾切镜：换场时切的是「新环境」，措辞要区别于人物入画 */
export function tailCutText(lang: Lang, tag: string, isScene: boolean): string {
  if (isZh(lang)) {
    return isScene ? `镜头切换到新环境，${tag}。` : `${tag} 入画。`
  }
  return isScene
    ? `The frame shifts to the new environment, ${tag}.`
    : `${tag} enters frame.`
}

/** 黑屏兜底：无法合法切镜时，保证最后一帧黑屏 */
export function blackText(lang: Lang): string {
  return isZh(lang) ? '最后一帧为黑屏。' : 'The final frame is black.'
}

/** retention_analysis 的说明尾句 */
export function retentionNote(lang: Lang, name: string, pictureN: number | null): string {
  if (pictureN != null) {
    return isZh(lang)
      ? `fully_preserved - ${name} 的特征取自 <Picture ${pictureN}>.`
      : `fully_preserved - ${name} features are retained from <Picture ${pictureN}>.`
  }
  return isZh(lang)
    ? 'retained as described in subject_definitions.（按文本描述保留）'
    : 'retained as described in subject_definitions.'
}

/* ------------------------------------------------------------------ *
 * 语言体检：本地化进度与交付门禁共用
 * ------------------------------------------------------------------ */

export const CJK_RE = /[\u4e00-\u9fff]/

const D_TAG_RE = /<d>[\s\S]*?<\/d>/g

/** 去掉 <d> 台词后是否还残留中文 */
export function hasCjkOutsideD(text: string | undefined): boolean {
  if (!text) return false
  return CJK_RE.test(text.replace(D_TAG_RE, ''))
}

/** 整段所有字段里，还有哪些字段残留了 <d> 之外的中文 */
export function cjkFields(
  schema: Array<{ key: string }>,
  fields: Record<string, string>
): string[] {
  return schema
    .map((f) => f.key)
    .filter((k) => hasCjkOutsideD(fields[k]))
}
