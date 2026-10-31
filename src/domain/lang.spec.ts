import { describe, expect, it } from 'vitest'
import { DEFAULT_FIELD_SCHEMA, DEFAULT_SETTINGS } from './types'
import type { Beat, Entity, ProjectSettings } from './types'
import { newBeat } from './beats'
import { validateSegment } from './rules'
import { DEFAULT_LANG, deliveryFields, enOnlyKeys, hasCjkOutsideD, isZh, langOf, normalizeLang } from './lang'

/* ------------------------------------------------------------------ *
 * 语言兜底 + 「本地化之前不校验英文」
 *
 * 背景（这是一个真实踩过的坑）：
 *   workLanguage 是后加的功能，功能上线前建的项目，库里存的 settings 没有这个键。
 *   如果「缺字段」被兜成 en，中文工作稿在阶段①~③ 就会满屏报「必须为英文」，
 *   而用户根本还没做本地化。
 * ------------------------------------------------------------------ */

describe('语言兜底', () => {
  it('缺省 / 非法值都按默认工作语言（zh）处理，而不是 en', () => {
    expect(DEFAULT_LANG).toBe('zh')
    expect(normalizeLang(undefined)).toBe('zh')
    expect(normalizeLang(null)).toBe('zh')
    expect(normalizeLang('')).toBe('zh')
    expect(normalizeLang('EN')).toBe('zh')
    expect(normalizeLang(123)).toBe('zh')
  })

  it('只有显式写了 en 才算英文模式', () => {
    expect(normalizeLang('en')).toBe('en')
  })

  it('★ 兜底语言必须和 ProjectSettings 的默认值一致', () => {
    expect(DEFAULT_SETTINGS.workLanguage).toBe(DEFAULT_LANG)
  })

  it('langOf：settings 缺失或没有 workLanguage 时取 zh', () => {
    expect(langOf(undefined)).toBe('zh')
    expect(langOf({})).toBe('zh')
    expect(langOf({ workLanguage: undefined })).toBe('zh')
    expect(langOf({ workLanguage: 'zh' })).toBe('zh')
    expect(langOf({ workLanguage: 'en' })).toBe('en')
  })

  it('isZh：未指定也算中文工作稿', () => {
    expect(isZh(undefined)).toBe(true)
    expect(isZh('zh')).toBe(true)
    expect(isZh('en')).toBe(false)
  })
})

describe('hasCjkOutsideD', () => {
  it('<d> 内的中文不算残留', () => {
    expect(hasCjkOutsideD('<d>[Chinese] 我不信。</d>')).toBe(false)
    expect(hasCjkOutsideD('Only Chuci is in frame. <d>[Chinese] 我不信。</d>')).toBe(false)
  })

  it('<d> 外的中文要被抓出来', () => {
    expect(hasCjkOutsideD('洞窟内景，火光跳动。')).toBe(true)
    expect(hasCjkOutsideD('dark cave <d>[Chinese] ok</d> 还有中文')).toBe(true)
  })

  it('空值与纯英文为 false', () => {
    expect(hasCjkOutsideD('')).toBe(false)
    expect(hasCjkOutsideD(undefined)).toBe(false)
    expect(hasCjkOutsideD('The final frame is black.')).toBe(false)
  })
})

/* --------------------------- 校验门禁 --------------------------- */

function ent(patch: Partial<Entity> & { name: string }): Entity {
  return {
    id: patch.id ?? patch.name,
    projectId: 'p',
    name: patch.name,
    type: patch.type ?? 'character',
    kind: patch.kind ?? 'non_speaking',
    subjectN: patch.subjectN ?? null,
    sx: patch.sx ?? null,
    pictureN: patch.pictureN ?? null,
    voiceDesc: patch.voiceDesc ?? null,
    textDesc: patch.textDesc ?? null,
    nameEn: patch.nameEn ?? null,
    voiceDescEn: patch.voiceDescEn ?? null,
    textDescEn: patch.textDescEn ?? null,
    createdAt: 1,
    updatedAt: 1
  }
}

const hero = ent({
  name: '楚辞',
  kind: 'speaking',
  subjectN: 1,
  sx: 1,
  pictureN: 1,
  voiceDesc: 'speaking with a young male voice, tired.'
})
const byId = new Map<string, Entity>([[hero.id, hero]])

const beats: Beat[] = [
  newBeat('p', {
    title: '楚辞开口',
    kind: 'dialogue',
    dialogue: '我不信这世上没有解药。',
    entities: [hero.id],
    speakerId: hero.id,
    focusEntityId: hero.id
  })
]

/** 典型的中文工作稿：自由描述全中文，只有台词在 <d> 里 */
const ZH_FIELDS: Record<string, string> = {
  subject_definitions: '<Subject 1> is 楚辞 in <Picture 1>, details.',
  summary: '[reference generation] 楚辞站在洞口，神情疲惫。',
  retention_analysis: '<Subject 1> (appears in [Shot 1]): fully_preserved - 楚辞 的特征取自 <Picture 1>.',
  detailed_description:
    '[Shot 1] At 00:00.000, 洞窟内景，火光跳动。\n' +
    '[Shot 2] At 00:01.500, Only 楚辞 is in frame. <Subject 1> (S1) says: <d>[Chinese] 我不信这世上没有解药。</d>',
  overall_soundscape: '滴水声与远处风声。',
  non_diegetic_music: 'N/A'
}

function langIssues(settings: ProjectSettings) {
  return validateSegment(
    { beats, narrativeBeats: beats, fields: ZH_FIELDS, seam: null, nextSeam: null },
    { settings, entityById: byId, schema: DEFAULT_FIELD_SCHEMA }
  ).filter((i) => i.ruleId === 'lang:cjk' || i.ruleId === 'lang:cjk-outside-d')
}

describe('本地化之前不校验英文', () => {
  it('中文工作稿（workLanguage: zh）下不报语言错误', () => {
    expect(langIssues({ ...DEFAULT_SETTINGS, workLanguage: 'zh' })).toHaveLength(0)
  })

  it('★ 老项目 settings 里没有 workLanguage 时，同样不报语言错误', () => {
    const legacy = { ...DEFAULT_SETTINGS, workLanguage: undefined as unknown as 'zh' }
    expect(langIssues(legacy)).toHaveLength(0)
  })

  it('切到英文终稿后，漏译的中文才被门禁拦下', () => {
    const issues = langIssues({ ...DEFAULT_SETTINGS, workLanguage: 'en' })
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.some((i) => i.ruleId === 'lang:cjk')).toBe(true)
    expect(issues.some((i) => i.ruleId === 'lang:cjk-outside-d')).toBe(true)
  })

  it('英文终稿里只剩 <d> 里的中文台词时不报错', () => {
    const en = {
      subject_definitions: '<Subject 1> is Chuci in <Picture 1>, details.',
      summary: '[reference generation] ok.',
      retention_analysis: '<Subject 1> (appears in [Shot 1]): fully_preserved - features from <Picture 1>.',
      detailed_description:
        '[Shot 1] At 00:00.000, Only Chuci is in frame. <Subject 1> (S1) says: <d>[Chinese] 我不信这世上没有解药。</d>',
      overall_soundscape: 'dripping water',
      non_diegetic_music: 'N/A'
    }
    const issues = validateSegment(
      { beats, narrativeBeats: beats, fields: en, seam: null, nextSeam: null },
      {
        settings: { ...DEFAULT_SETTINGS, workLanguage: 'en' },
        entityById: byId,
        schema: DEFAULT_FIELD_SCHEMA
      }
    ).filter((i) => i.ruleId.startsWith('lang:'))
    expect(issues).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ *
 * 交付口径：显示 / 门禁 / 打包 / 导出必须看同一份字段
 *
 * 真实故障：中文工作稿模式下，中文那份是空的、英文终稿是满的。
 *   交付页「英文有内容就用英文」→ 页面上字段都填着；
 *   门禁看中文那份 → 报「字段 summary 为空」×7 段，跑不了；
 *   导演包打包看中文那份 → 真跑出去还是空的。
 * 三处各看各的，用户看到的是「明明写了却说没写」。
 * ------------------------------------------------------------------ */

describe('交付口径字段', () => {
  const zh = { summary: '中文概述', overall_soundscape: '雨声' }
  const en = { summary: '[reference generation] English', overall_soundscape: 'rain' }

  it('中文工作稿模式一律看中文那份（哪怕英文终稿是满的）', () => {
    expect(deliveryFields(zh, en, 'zh')).toEqual(zh)
  })

  it('英文终稿模式看英文那份', () => {
    expect(deliveryFields(zh, en, 'en')).toEqual(en)
  })

  it('英文整份为空时退回中文工作稿，而不是给一张白纸', () => {
    expect(deliveryFields(zh, {}, 'en')).toEqual(zh)
    expect(deliveryFields(zh, { summary: '   ' }, 'en')).toEqual(zh)
    expect(deliveryFields(zh, undefined, 'en')).toEqual(zh)
  })

  it('语言缺省按中文工作稿处理（老项目没有 workLanguage）', () => {
    expect(deliveryFields(zh, en, undefined)).toEqual(zh)
  })
})

/* ------------------------------------------------------------------ *
 * 「只有英文、没有中文」的模型字段
 *
 * 真实场景：切到英文终稿后，模型字段只写英文那一侧；再切回中文，
 * 这些字段仍是英文，界面看起来像「切不回去」。
 * ------------------------------------------------------------------ */

describe('只有英文的模型字段', () => {
  const schema = [
    { key: 'summary', source: 'llm' },
    { key: 'overall_soundscape', source: 'llm' },
    { key: 'detailed_description', source: 'derived' }
  ]

  it('中文空、英文有 → 算需要回写', () => {
    const zh = { summary: '' }
    const en = { summary: 'Rain at night', overall_soundscape: 'rain hum' }
    expect(enOnlyKeys(schema, zh, en)).toEqual(['summary', 'overall_soundscape'])
  })

  it('两侧都有内容时不算（中文是好的，英文是另一份）', () => {
    const zh = { summary: '雨夜', overall_soundscape: '雨声' }
    const en = { summary: 'Rain', overall_soundscape: 'rain' }
    expect(enOnlyKeys(schema, zh, en)).toEqual([])
  })

  it('派生字段不进来：引擎按词条各算一遍，切回中文立刻就是中文', () => {
    const zh = {}
    const en = { detailed_description: 'desc only in en' }
    expect(enOnlyKeys(schema, zh, en)).toEqual([])
  })

  it('空白不算有内容', () => {
    expect(enOnlyKeys(schema, { summary: '   ' }, { summary: 'Rain' })).toEqual(['summary'])
    expect(enOnlyKeys(schema, {}, { summary: '  ' })).toEqual([])
  })
})
