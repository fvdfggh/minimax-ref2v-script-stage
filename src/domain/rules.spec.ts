import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './types'
import type { Beat, Entity, FieldSchema, Lang } from './types'
import { issueScope, validateGlobal } from './rules'

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
