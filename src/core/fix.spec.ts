import { describe, expect, it } from 'vitest'
import { buildFixMessages } from './llm/prompts'
import { splitIssuesByScope, issueScope, FIELD_FIXABLE_RULES, type RuleIssue } from '@/domain/rules'
import { diffLines, diffStat } from './diff'
import { DEFAULT_FIELD_SCHEMA, DEFAULT_SETTINGS } from '@/domain/types'
import type { Beat, Entity } from '@/domain/types'

/* ------------------------- 问题归属分类 ------------------------- */

function issue(ruleId: string, field?: string): RuleIssue {
  return { ruleId, level: 'error', message: `${ruleId} 触发了`, field }
}

describe('问题归属：哪些能交给 AI 改字段', () => {
  it('字段级问题归类为 field', () => {
    for (const id of [
      'field:missing',
      'voice:verbatim-mismatch',
      'voice:sx-missing',
      'dialogue:format',
      'dialogue:id-inside-d',
      'shot:no-only',
      'shot:reverse-narrative',
      'shot:timecode',
      'lang:cjk-outside-d',
      'music:empty',
      'sound:repeat-dialogue',
      'seam:tail-cut-required',
      'seam:black-required'
    ]) {
      expect(issueScope(issue(id))).toBe('field')
    }
  })

  it('结构性问题不能被改字段修掉', () => {
    // 帧数超限、缺预备镜头、台词超时长 —— 必须回组合页或片段页
    expect(issueScope(issue('frames:limit'))).toBe('structure')
    expect(issueScope(issue('frames:dialogue-overflow'))).toBe('structure')
    expect(issueScope(issue('dialogue:too-tight'))).toBe('structure')
    expect(issueScope(issue('shot:missing-preshoot'))).toBe('structure')
    expect(issueScope(issue('beat:no-entity'))).toBe('structure')
    expect(issueScope(issue('beat:no-speaker'))).toBe('structure')
  })

  it('注册表问题单独归类', () => {
    expect(issueScope(issue('registry:no-number'))).toBe('registry')
    expect(issueScope(issue('registry:stale-number'))).toBe('registry')
    expect(issueScope(issue('registry:sx-mismatch'))).toBe('registry')
  })

  it('splitIssuesByScope 能把一次校验结果分干净', () => {
    const list = [
      issue('frames:limit'),
      issue('field:missing', 'summary'),
      issue('registry:voice-missing'),
      issue('shot:no-only'),
      issue('beat:no-entity')
    ]
    const g = splitIssuesByScope(list)
    expect(g.field.map((i) => i.ruleId)).toEqual(['field:missing', 'shot:no-only'])
    expect(g.structure.map((i) => i.ruleId)).toEqual(['frames:limit', 'beat:no-entity'])
    expect(g.registry.map((i) => i.ruleId)).toEqual(['registry:voice-missing'])
    expect(g.field.length + g.structure.length + g.registry.length).toBe(list.length)
  })

  it('可修复规则集合里不应该出现结构性问题', () => {
    for (const id of FIELD_FIXABLE_RULES) {
      expect(issueScope(issue(id))).toBe('field')
    }
  })
})

/* --------------------------- 修复提示词 --------------------------- */

const chuci: Entity = {
  id: 'e1',
  projectId: 'p',
  name: '楚辞',
  type: 'character',
  kind: 'speaking',
  subjectN: 1,
  sx: 1,
  pictureN: 1,
  voiceDesc: 'speaking with a young male voice, tired but determined.',
  textDesc: 'dark robe',
  createdAt: 1,
  updatedAt: 1
}

const BEATS: Beat[] = [
  {
    id: 'b1',
    projectId: 'p',
    order: 0,
    kind: 'dialogue',
    title: '台词',
    dialogue: '我不信这世上没有解药。',
    entities: ['e1'],
    speakerId: 'e1',
    focusEntityId: 'e1',
    manualFrames: false,
    locked: false,
    enriched: true,
    createdAt: 1,
    updatedAt: 1
  }
]

const FIELDS = {
  subject_definitions: '<Subject 1> is 楚辞 in <Picture 1>, dark robe, speaking with a wrong voice (S1)',
  summary: '',
  detailed_description: '[Shot 1] At 00:00.000, 楚辞 说话',
  overall_soundscape: '',
  non_diegetic_music: ''
}

function build(instruction?: string) {
  return buildFixMessages({
    schema: DEFAULT_FIELD_SCHEMA,
    fields: FIELDS,
    issues: [
      { ruleId: 'voice:verbatim-mismatch', level: 'error', message: '音色与注册表不一致', field: 'subject_definitions' },
      { ruleId: 'lang:cjk-outside-d', level: 'error', message: '画面描述里出现了中文', field: 'detailed_description' }
    ],
    groupBeats: BEATS,
    entities: [chuci],
    seamFromPrev: null,
    nextSeam: null,
    segmentIndex: 0,
    segmentTotal: 3,
    frames: 48,
    fps: DEFAULT_SETTINGS.fps,
    instruction
  })
}

describe('错误修复提示词', () => {
  it('把问题清单按规则 ID 和字段交给模型', () => {
    const [system, user] = build()
    expect(user.content).toContain('[voice:verbatim-mismatch]')
    expect(user.content).toContain('字段 subject_definitions')
    expect(user.content).toContain('[lang:cjk-outside-d]')
    expect(user.content).toContain('音色与注册表不一致')
    expect(system.content).toContain('交付前错误修复')
  })

  it('要求返回完整字段内容而不是 diff', () => {
    const [system] = build()
    expect(system.content).toContain('该字段修正后的完整内容')
    expect(system.content).toContain('不是补丁片段，也不是 diff')
    expect(system.content).toContain('"patches"')
    expect(system.content).toContain('"unfixable"')
  })

  it('明确要求逐字保留 <d> 里的中文台词', () => {
    const [system] = build()
    expect(system.content).toContain('<d> 标签内的中文台词必须逐字保留')
  })

  it('带上了当前字段内容、空字段清单与镜头序列', () => {
    const [, user] = build()
    expect(user.content).toContain('【subject_definitions】')
    expect(user.content).toContain('<Subject 1> is 楚辞 in <Picture 1>')
    expect(user.content).toContain(
      '需要按规则补出来：summary、retention_analysis、overall_soundscape、non_diegetic_music'
    )
    expect(user.content).toContain('[台词] 楚辞')
    expect(user.content).toContain('我不信这世上没有解药。')
  })

  it('附加要求会被带进去', () => {
    const [, user] = build('把烟气统一写成 purple mist')
    expect(user.content).toContain('【附加要求】')
    expect(user.content).toContain('把烟气统一写成 purple mist')
  })
})

/* ----------------------------- diff ----------------------------- */

describe('行级 diff', () => {
  it('标出新增与删除的行', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc')
    expect(d.filter((x) => x.op === 'same').map((x) => x.text)).toEqual(['a', 'c'])
    expect(d.filter((x) => x.op === 'del').map((x) => x.text)).toEqual(['b'])
    expect(d.filter((x) => x.op === 'add').map((x) => x.text)).toEqual(['B'])
    expect(diffStat(d)).toEqual({ added: 1, removed: 1, changed: true })
  })

  it('完全相同的内容没有变更', () => {
    const d = diffLines('same\ntext', 'same\ntext')
    expect(diffStat(d).changed).toBe(false)
  })

  it('超长文本退化为整段替换，不会卡住', () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const d = diffLines(big, `${big}\nextra`)
    expect(d.filter((x) => x.op === 'del').length).toBe(500)
    expect(d.filter((x) => x.op === 'add').length).toBe(501)
  })
})
