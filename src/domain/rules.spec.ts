import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './types'
import type { Beat, Entity, FieldSchema, Lang } from './types'
import { issueScope, validateGlobal, validateSegment } from './rules'

/**
 * 锁住 #8 的修复：英文终稿下「出场的实体缺 nameEn」必须报 error，
 * 且归到 registry scope（要回注册表/词条表修，不是 AI 改字段）。
 * 这条校验补的是「模型字段检查覆盖不到的盲区」。
 */
function ent(id: string, patch: Partial<Entity> = {}): Entity {
  return {
    id,
    projectId: 'p',
    name: patch.name ?? id,
    type: patch.type ?? 'character',
    kind: patch.kind ?? 'non_speaking',
    subjectN: patch.subjectN ?? null,
    sx: patch.sx ?? null,
    pictureN: patch.pictureN ?? null,
    voiceDesc: patch.voiceDesc ?? null,
    textDesc: patch.textDesc ?? null,
    createdAt: 1,
    updatedAt: 1,
    ...patch
  }
}

function beat(id: string, order: number, patch: Partial<Beat> = {}): Beat {
  return {
    id,
    projectId: 'p',
    order,
    kind: patch.kind ?? 'action',
    title: patch.title ?? id,
    entities: patch.entities ?? [],
    sceneId: patch.sceneId,
    manualFrames: false,
    locked: false,
    enriched: true,
    createdAt: 1,
    updatedAt: 1,
    ...patch
  }
}

// 出场：hero 作为主体、cave 作为场景；ghost 完全不出现
const hero = ent('hero', { name: '楚辞' })
const cave = ent('cave', { name: '九幽毒渊', type: 'scene' })
const ghost = ent('ghost', { name: '幽灵', nameEn: 'Ghost' })

const usedBeat = beat('b1', 0, { entities: ['hero'], sceneId: 'cave' })
const segments = [{ beats: [usedBeat], fields: {} }]

const baseCtx = (lang: Lang) => ({
  settings: DEFAULT_SETTINGS,
  entityById: new Map([hero, cave, ghost].map((e) => [e.id, e])),
  schema: [] as FieldSchema[],
  lang
})

function glossaryIssues(lang: Lang, input = { entities: [hero, cave, ghost], beats: [usedBeat], segments }) {
  return validateGlobal(input, baseCtx(lang)).filter((i) => i.ruleId === 'lang:glossary-missing')
}

describe('英文终稿词条缺失校验（lang:glossary-missing）', () => {
  it('en 下出场的实体缺 nameEn 逐条报 error', () => {
    const issues = glossaryIssues('en')
    expect(issues).toHaveLength(2) // hero + cave
    expect(issues.every((i) => i.level === 'error')).toBe(true)
    const msgs = issues.map((i) => i.message).join('|')
    expect(msgs).toContain('楚辞')
    expect(msgs).toContain('九幽毒渊')
  })

  it('不出场的实体即使缺 nameEn 也不报错', () => {
    // ghost 缺不缺都无所谓：它没出现在任何段里
    const ghostNoName = { ...ghost, nameEn: null }
    const issues = glossaryIssues('en', { entities: [hero, cave, ghostNoName], beats: [usedBeat], segments })
    expect(issues.map((i) => i.message).join('|')).not.toContain('幽灵')
  })

  it('出场实体补齐 nameEn 后不再报错', () => {
    const fixed = {
      entities: [
        { ...hero, nameEn: 'Chuci' },
        { ...cave, nameEn: 'Poison Abyss' },
        ghost
      ],
      beats: [usedBeat],
      segments
    }
    expect(glossaryIssues('en', fixed)).toEqual([])
  })

  it('zh 工作阶段不做该校验', () => {
    expect(glossaryIssues('zh')).toEqual([])
  })

  it('缺 nameEn 也只在「英文」下算 error，中文下静默', () => {
    // 同一份数据，换语言，结论翻转
    expect(glossaryIssues('zh')).toHaveLength(0)
    expect(glossaryIssues('en')).toHaveLength(2)
  })

  it('该问题归 registry scope（回注册表修，不由 AI 改字段）', () => {
    const issue = glossaryIssues('en')[0]
    expect(issueScope(issue)).toBe('registry')
  })
})

/**
 * 中文工作稿里模型字段写成英文 = 本地化还没做，内容却已经是终稿。
 * 这种段落"看起来做完了"，其实是旧版规则 / 桩模型留下的，必须能被指出来。
 */
function langIssuesOf(fields: Record<string, string>, lang?: Lang) {
  const b = beat('b1', 0, { entities: ['hero'], sceneId: 'cave' })
  return validateSegment(
    { beats: [b], narrativeBeats: [b], fields, seam: null, nextSeam: null },
    { settings: DEFAULT_SETTINGS, entityById: new Map([[hero.id, hero]]), schema: [], lang }
  ).filter((i) => i.ruleId === 'lang:not-zh')
}

describe('中文工作稿的英文字段校验（lang:not-zh）', () => {
  const ZH_FIELDS = {
    summary: '[reference generation] 雨夜，楚辞在九幽毒渊入口停下，抬头看了一眼。',
    overall_soundscape: '雨点敲在石面上，远处有低沉的闷响。',
    non_diegetic_music: 'N/A'
  }

  it('中文工作稿里三个模型字段都是中文 => 不报', () => {
    expect(langIssuesOf(ZH_FIELDS, 'zh')).toEqual([])
  })

  it('summary / soundscape / music 是英文时逐条报 warn', () => {
    const issues = langIssuesOf(
      {
        summary: '[reference generation] Chuci stops at the entrance of the abyss.',
        overall_soundscape: 'Rain on stone, a low rumble far away.',
        non_diegetic_music: 'Sparse solo piano.'
      },
      'zh'
    )
    expect(issues.map((i) => i.field)).toEqual(['summary', 'overall_soundscape', 'non_diegetic_music'])
    expect(issues.every((i) => i.level === 'warn')).toBe(true)
    expect(issues[0].message).toContain('本地化之前')
  })

  it('只有部分字段是英文时只报那一条', () => {
    const issues = langIssuesOf({ ...ZH_FIELDS, overall_soundscape: 'Rain on stone.' }, 'zh')
    expect(issues).toHaveLength(1)
    expect(issues[0].field).toBe('overall_soundscape')
  })

  it('N/A（无配乐）是结构字面量，不算漏写中文', () => {
    const issues = langIssuesOf({ ...ZH_FIELDS, non_diegetic_music: 'N/A' }, 'zh')
    expect(issues).toEqual([])
  })

  it('英文终稿（lang = en）下不跑这条：那时英文才是对的', () => {
    const issues = langIssuesOf(
      {
        summary: '[reference generation] Chuci stops at the entrance.',
        overall_soundscape: 'Rain on stone.',
        non_diegetic_music: 'N/A'
      },
      'en'
    )
    expect(issues).toEqual([])
  })

  it('该问题可由 AI 改写字段修（field scope），不是结构问题', () => {
    const issue = langIssuesOf({ ...ZH_FIELDS, summary: 'Chuci waits in the rain.' }, 'zh')[0]
    expect(issueScope(issue)).toBe('field')
  })
})

/**
 * 段长上限现在是可调的（组合与缝合页顶部「最长段」）。
 * 调低之后报错必须说清是「设定值」超了还是「该帧长家族」超了 ——
 * 原来的写法是"超过该模式下限 90 帧（上限 90 帧）"，自己跟自己打架。
 */
describe('段长上限可调时的超限提示', () => {
  function frameLimitIssue(frames: number, refPrev: boolean, max: number) {
    const b = beat('b1', 0, {
      entities: ['hero'],
      sceneId: 'cave',
      kind: 'action',
      manualFrames: true,
      estFrames: frames
    })
    const issues = validateSegment(
      { beats: [b], narrativeBeats: [b], fields: {}, seam: null, refPrev },
      { ...baseCtx('zh'), settings: { ...DEFAULT_SETTINGS, maxSegmentFrames: max } }
    )
    return issues.find((i) => i.ruleId === 'frames:limit')
  }

  it('设定值就是上限时只说一个数字', () => {
    const issue = frameLimitIssue(124, false, 90)
    expect(issue?.message).toBe('本段所需 124 帧，超过上限 90 帧，必须拆段')
  })

  it('网格上限低于设定值时，两个数都说出来', () => {
    // 引用上段家族只能到 85（17k），而设定是 90
    const issue = frameLimitIssue(100, true, 90)
    expect(issue?.message).toContain('上限 85 帧')
    expect(issue?.message).toContain('设定上限 90 帧')
  })

  it('正好卡在 141 不报，再多一格就要拆段', () => {
    const issue = frameLimitIssue(141, false, 141)
    expect(issue).toBeUndefined() // 正好卡在上限，合法
    const over = frameLimitIssue(158, false, 141)
    expect(over?.message).toContain('超过上限 141 帧')
  })
})
