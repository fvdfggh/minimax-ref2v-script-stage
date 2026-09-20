import { describe, expect, it } from 'vitest'
import { DEFAULT_FIELD_SCHEMA, DEFAULT_SETTINGS, isSceneEntity } from './types'
import type { Beat, Entity } from './types'
import { newBeat } from './beats'
import { computeNumbering, groupEntitiesByLayer } from './registry'
import { analyzeSeam } from './seam'
import { deriveSubjectDefinitions } from './derive'
import { validateSegment } from './rules'
import { assemble, defaultStrategy } from './assembler'

const S = DEFAULT_SETTINGS

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
    textDesc: patch.textDesc ?? 'details from the reference',
    createdAt: patch.createdAt ?? 1,
    updatedAt: 1
  }
}

const chuci = ent({
  id: 'e_chuci',
  name: '楚辞',
  kind: 'speaking',
  pictureN: 1,
  voiceDesc: 'speaking with a young male voice, tired but determined.',
  createdAt: 1
})
const panel = ent({
  id: 'e_panel',
  name: '系统面板',
  type: 'ui',
  kind: 'speaking',
  pictureN: 7,
  voiceDesc: 'speaking with a neutral synthesized voice.',
  createdAt: 2
})
const sword = ent({ id: 'e_sword', name: '毒剑', type: 'prop', pictureN: 8, createdAt: 3 })
const cave = ent({ id: 'e_cave', name: '九幽毒渊', type: 'scene', pictureN: 5, createdAt: 4 })
const world = ent({ id: 'e_world', name: '新世界', type: 'scene', pictureN: 6, createdAt: 5 })

const ALL = [chuci, panel, sword, cave, world]
const byId = new Map(ALL.map((e) => [e.id, e]))

function beat(patch: Partial<Beat> & { title: string; kind: Beat['kind'] }): Beat {
  return newBeat('p', { sceneId: 'e_cave', ...patch })
}

describe('场景分层', () => {
  it('isSceneEntity 按 type 判定', () => {
    expect(isSceneEntity(cave)).toBe(true)
    expect(isSceneEntity(chuci)).toBe(false)
    expect(isSceneEntity(sword)).toBe(false)
  })

  it('编号顺序：会说话的角色 → 主体 → 场景', () => {
    const beats = [
      beat({ title: 'a', kind: 'action', entities: ['e_chuci'], focusEntityId: 'e_chuci', order: 0 }),
      beat({ title: 'b', kind: 'dialogue', dialogue: '一', speakerId: 'e_chuci', entities: ['e_chuci'], order: 1 })
    ]
    const map = computeNumbering(ALL, beats)
    // 说话角色：楚辞先发声 -> 1；系统面板没在这批片段里发声 -> 2
    expect(map.get('e_chuci')!.subjectN).toBe(1)
    expect(map.get('e_panel')!.subjectN).toBe(2)
    // 不说话的主体排在场景之前
    expect(map.get('e_sword')!.subjectN).toBe(3)
    // 场景排在最后
    expect(map.get('e_cave')!.subjectN).toBe(4)
    expect(map.get('e_world')!.subjectN).toBe(5)
    // 场景同样拿到 Subject，但没有 (Sx)
    expect(map.get('e_cave')!.sx).toBeNull()
  })

  it('groupEntitiesByLayer 分出三层', () => {
    const withN = ALL.map((e) => {
      const n = { e_chuci: 1, e_panel: 2, e_sword: 3, e_cave: 4, e_world: 5 } as Record<string, number>
      return { ...e, subjectN: n[e.id] ?? null }
    })
    const layers = groupEntitiesByLayer(withN)
    expect(layers.speaking.map((e) => e.name)).toEqual(['楚辞', '系统面板'])
    expect(layers.subjects.map((e) => e.name)).toEqual(['毒剑'])
    expect(layers.scenes.map((e) => e.name)).toEqual(['九幽毒渊', '新世界'])
  })

  it('场景会进 subject_definitions，与主体一起占 Subject 编号', () => {
    const withN = ALL.map((e) => {
      const n = { e_chuci: 1, e_panel: 2, e_sword: 3, e_cave: 4, e_world: 5 } as Record<string, number>
      return { ...e, subjectN: n[e.id] ?? null, sx: e.kind === 'speaking' ? (n[e.id] ?? null) : null }
    })
    const map = new Map(withN.map((e) => [e.id, e]))
    const beats = [beat({ title: '空镜', kind: 'establishing', entities: [] })]
    const text = deriveSubjectDefinitions(beats, { settings: S, entityById: map })
    expect(text).toContain('<Subject 4> is 九幽毒渊 in <Picture 5>')
    expect(text).not.toContain('speaking with')
  })
})

describe('缝合：场景综合判断', () => {
  const left = [
    beat({ title: 'l1', kind: 'action', entities: ['e_chuci'], focusEntityId: 'e_chuci', order: 0 })
  ]

  it('换场时尾帧切镜目标取新场景，而不是说话人', () => {
    const right = [
      beat({
        title: 'r1',
        kind: 'dialogue',
        dialogue: '这里是哪。',
        speakerId: 'e_chuci',
        entities: ['e_chuci'],
        sceneId: 'e_world',
        order: 1
      })
    ]
    const seam = analyzeSeam(left, right, { settings: S })
    expect(seam.leftSceneId).toBe('e_cave')
    expect(seam.rightSceneId).toBe('e_world')
    expect(seam.sceneChanged).toBe(true)
    expect(seam.scenePriorityApplied).toBe(true)
    // 关键：切的是新环境，不是楚辞
    expect(seam.needsTailCut).toBe(true)
    expect(seam.tailCutTargetId).toBe('e_world')
    expect(seam.firstSpeakerId).toBe('e_chuci')
    // 换场不做重叠帧
    expect(seam.continuityToNext).toBe(false)
    expect(seam.continuityFromPrev).toBe(false)
    expect(seam.issues.some((i) => i.code === 'seam:scene-transition')).toBe(true)
    // 换场后首拍就是台词 -> 新环境未建立
    expect(seam.issues.some((i) => i.code === 'seam:scene-change-no-establish')).toBe(true)
  })

  it('关闭场景优先后，换场仍按说话人判定并给出提醒', () => {
    const settings = { ...S, scenePriorityOnSeam: false }
    const right = [
      beat({
        title: 'r1',
        kind: 'dialogue',
        dialogue: '喂。',
        speakerId: 'e_chuci',
        entities: ['e_chuci'],
        sceneId: 'e_world',
        order: 1
      })
    ]
    const seam = analyzeSeam(left, right, { settings })
    expect(seam.sceneChanged).toBe(true)
    expect(seam.scenePriorityApplied).toBe(false)
    // 左段末帧主体就是说话人 -> 顺接
    expect(seam.needsTailCut).toBe(false)
    expect(seam.issues.some((i) => i.code === 'seam:scene-change-ignored')).toBe(true)
  })

  it('同一场景内按原有主体规则判定', () => {
    const right = [
      beat({
        title: 'r1',
        kind: 'dialogue',
        dialogue: '喂。',
        speakerId: 'e_chuci',
        entities: ['e_chuci'],
        sceneId: 'e_cave',
        order: 1
      })
    ]
    const seam = analyzeSeam(left, right, { settings: S })
    expect(seam.sceneChanged).toBe(false)
    expect(seam.scenePriorityApplied).toBe(false)
    expect(seam.needsTailCut).toBe(false)
    expect(seam.continuityToNext).toBe(true)
  })
})

describe('场景必填校验', () => {
  const fields = {
    subject_definitions: '<Subject 1> is 楚辞 in <Picture 1>, details.',
    summary: '[reference generation] ok.',
    retention_analysis: '<Subject 1> (appears in [Shot 1]): fully_preserved - x.',
    detailed_description: '[Shot 1] At 00:00.000, dark cavern.',
    overall_soundscape: 'dripping water',
    non_diegetic_music: 'N/A'
  }

  function validate(beats: Beat[]) {
    return validateSegment(
      { beats, narrativeBeats: beats, fields, seam: null, nextSeam: null },
      { settings: S, entityById: byId, schema: DEFAULT_FIELD_SCHEMA }
    )
  }

  it('片段缺场景会报 scene:missing', () => {
    const noScene = newBeat('p', { title: '缺场景', kind: 'action' })
    const issues = validate([noScene])
    expect(issues.some((i) => i.ruleId === 'scene:missing')).toBe(true)
  })

  it('场景类型不对会报 scene:not-scene', () => {
    const wrongType = beat({ title: 'x', kind: 'action', sceneId: 'e_chuci', entities: [] })
    const issues = validate([wrongType])
    expect(issues.some((i) => i.ruleId === 'scene:not-scene')).toBe(true)
  })

  it('纯场景镜不会因为"没绑主体"报错', () => {
    const pure = beat({
      title: '空镜',
      kind: 'establishing',
      entities: [],
      focusEntityId: 'e_cave'
    })
    const issues = validate([pure])
    expect(issues.some((i) => i.ruleId === 'beat:no-entity')).toBe(false)
    expect(issues.some((i) => i.ruleId === 'scene:missing')).toBe(false)
  })

  it('一段跨多场景但没有换场片段时给提醒', () => {
    const cross = [
      beat({ title: 'a', kind: 'action', entities: [], sceneId: 'e_cave', order: 0 }),
      beat({ title: 'b', kind: 'action', entities: [], sceneId: 'e_world', order: 1 })
    ]
    const issues = validate(cross)
    expect(issues.some((i) => i.ruleId === 'scene:multiple')).toBe(true)
  })
})

describe('组合：场景参与边界代价', () => {
  it('优先在换场处切分', () => {
    // 6 个同场片段 + 场景切换 + 6 个新场片段
    const beats: Beat[] = []
    for (let i = 0; i < 6; i++) {
      beats.push(
        beat({
          title: `a${i}`,
          kind: 'action',
          entities: ['e_chuci'],
          focusEntityId: 'e_chuci',
          sceneId: 'e_cave',
          order: i
        })
      )
    }
    for (let i = 0; i < 6; i++) {
      beats.push(
        beat({
          title: `b${i}`,
          kind: 'action',
          entities: ['e_chuci'],
          focusEntityId: 'e_chuci',
          sceneId: 'e_world',
          order: 6 + i
        })
      )
    }
    const report = assemble(beats, defaultStrategy(S, 'scene_first'), {
      settings: S,
      entityById: byId
    })
    const byIdMap = new Map(beats.map((b) => [b.id, b]))
    // 至少切了一刀，且存在一个切点正好落在场景分界处
    expect(report.groups.length).toBeGreaterThanOrEqual(2)
    const boundaries = report.groups.slice(0, -1).map((g) => {
      const last = byIdMap.get(g.beatIds[g.beatIds.length - 1])!
      const nextId = report.groups[report.groups.indexOf(g) + 1].beatIds[0]
      const next = byIdMap.get(nextId)!
      return last.sceneId !== next.sceneId
    })
    expect(boundaries.some(Boolean)).toBe(true)
  })
})
