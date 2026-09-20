import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './types'
import type { Beat, Entity } from './types'
import { beatFrames, countHanzi, dialogueFrames, timecode } from './timing'
import { buildSubjectDefinition, computeNumbering, normalizeVoiceDesc } from './registry'
import {
  allEntityIdsOf,
  autoSplitParts,
  entityIdsOf,
  isComposable,
  mergeBeats,
  newBeat,
  normalizeBeat,
  resolveSubjectId,
  splitBeat
} from './beats'
import { analyzeSeam } from './seam'
import { assemble, defaultStrategy } from './assembler'
import { deriveDetailedDescription, deriveSubjectDefinitions, makeSeeders } from './derive'

/* ------------------------------ 夹具 ------------------------------ */

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
    textDesc: patch.textDesc ?? 'dark robe, pale skin',
    createdAt: patch.createdAt ?? 1,
    updatedAt: 1
  }
}

const chuci = ent({
  id: 'e_chuci',
  name: '楚辞',
  kind: 'speaking',
  pictureN: 1,
  voiceDesc: 'speaking with a young male voice, slightly hoarse, tired but determined.',
  createdAt: 1
})
const panel = ent({
  id: 'e_panel',
  name: '系统面板',
  type: 'ui',
  kind: 'speaking',
  pictureN: 7,
  voiceDesc: 'speaking with a neutral synthesized voice, crisp and rhythmic.',
  createdAt: 2
})
const cave = ent({ id: 'e_cave', name: '九幽毒渊', type: 'scene', pictureN: 5, createdAt: 3 })
const newWorld = ent({ id: 'e_world', name: '新世界', type: 'scene', pictureN: 6, createdAt: 4 })

const ALL = [chuci, panel, cave, newWorld]

/** 默认落在九幽毒渊（场景必填，测试夹具统一给一个） */
function beat(patch: Partial<Beat> & { title: string; kind: Beat['kind'] }): Beat {
  return newBeat('p', { sceneId: 'e_cave', ...patch })
}

/* ------------------------------ 时长 ------------------------------ */

describe('时长与帧', () => {
  it('汉字计数忽略标点与英文', () => {
    expect(countHanzi('我不信这世上没有解药。')).toBe(10)
    expect(countHanzi('hello 世界!')).toBe(2)
    expect(countHanzi('')).toBe(0)
  })

  it('台词时长 = 汉字数 ÷ 5 秒', () => {
    // 10 字 -> 2 秒 -> 48 帧
    expect(dialogueFrames('我不信这世上没有解药。')).toBe(48)
  })

  it('141 帧等于 5.875 秒', () => {
    expect(timecode(141)).toBe('00:05.875')
  })

  it('台词片段帧数由台词自动推算', () => {
    const b = beat({ title: 't', kind: 'dialogue', dialogue: '我不信这世上没有解药。' })
    expect(beatFrames(b, S)).toBe(48)
  })

  it('手动帧数优先于自动推算', () => {
    const b = beat({ title: 't', kind: 'action', estFrames: 99, manualFrames: true })
    expect(beatFrames(b, S)).toBe(99)
  })
})

/* ------------------------------ 编号 ------------------------------ */

describe('全局编号分配', () => {
  it('会说话角色按首次发声顺序在前，不说话的在后', () => {
    const beats = [
      beat({ title: 'a', kind: 'establishing', entities: ['e_cave'], order: 0 }),
      beat({ title: 'b', kind: 'dialogue', dialogue: '一', speakerId: 'e_chuci', entities: ['e_chuci'], order: 1 }),
      beat({ title: 'c', kind: 'scene_switch', entities: ['e_world'], order: 2 }),
      beat({ title: 'd', kind: 'dialogue', dialogue: '二', speakerId: 'e_panel', entities: ['e_panel'], order: 3 })
    ]
    const map = computeNumbering(ALL, beats)
    expect(map.get('e_chuci')!.subjectN).toBe(1)
    expect(map.get('e_panel')!.subjectN).toBe(2)
    // 不说话：场景按首次出现顺序，九幽毒渊(s0) 在新世界(s2) 之前
    expect(map.get('e_cave')!.subjectN).toBe(3)
    expect(map.get('e_world')!.subjectN).toBe(4)
    // (Sx) 只给说话角色，且与 subjectN 相等
    expect(map.get('e_chuci')!.sx).toBe(1)
    expect(map.get('e_cave')!.sx).toBeNull()
  })

  it('音色描述末尾的 (Sx) 会被剥离，避免与编号漂移', () => {
    expect(normalizeVoiceDesc('speaking with a calm voice. (S3)')).toBe('speaking with a calm voice.')
    expect(normalizeVoiceDesc('speaking with a calm voice')).toBe('speaking with a calm voice.')
  })

  it('subject_definitions 行的 Sx 与 Subject N 严格对应', () => {
    const e = { ...chuci, subjectN: 4, sx: 4 }
    const line = buildSubjectDefinition(e)
    expect(line).toContain('<Subject 4>')
    expect(line).toContain('(S4)')
    expect(line).toContain('<Picture 1>')
  })

  it('无图片实体使用纯文本描述，不出现 Picture', () => {
    const e = { ...cave, pictureN: null, subjectN: 6, textDesc: '毒雾弥漫的洞窟' }
    const line = buildSubjectDefinition(e)
    expect(line).toBe('<Subject 6> is 九幽毒渊, 毒雾弥漫的洞窟.')
  })
})

/* ------------------------------ 拆分 ------------------------------ */

describe('片段拆分', () => {
  it('超长动作被建议拆分，且拆分后帧数守恒', () => {
    const b = beat({ title: '追逐', kind: 'action', estFrames: 150, manualFrames: true })
    const parts = autoSplitParts(b, S)
    expect(parts.length).toBeGreaterThan(1)

    const next = splitBeat([b], b.id, S, parts)
    expect(next.length).toBe(parts.length)
    expect(next.reduce((s, x) => s + beatFrames(x, S), 0)).toBe(150)
    // 血缘字段记录来源，便于撤回
    expect(next.every((x) => x.derivedFrom === b.id)).toBe(true)
  })

  it('超长台词按语义标点拆分', () => {
    const text = '我不信。这世上没有解药！毒尊，你错了？那就试试吧。'
    const b = beat({ title: '长台词', kind: 'dialogue', dialogue: text, manualFrames: true, estFrames: 200 })
    const next = splitBeat([b], b.id, S)
    expect(next.length).toBeGreaterThan(1)
    expect(next.map((x) => x.dialogue).join('')).toBe(text)
  })

  it('合并可撤回拆分', () => {
    const b = beat({ title: '动作', kind: 'action', estFrames: 100, manualFrames: true })
    const parts = autoSplitParts(b, S)
    const split = splitBeat([b], b.id, S, parts)
    const merged = mergeBeats(split, split.map((x) => x.id), S)
    expect(merged.length).toBe(1)
    expect(beatFrames(merged[0], S)).toBe(100)
  })

  it('场景必填、其他主体可选', () => {
    // 有场景、没有其他主体 —— 纯场景镜，允许
    expect(isComposable(beat({ title: '空镜', kind: 'action', entities: [] }))).toBe(true)
    // 没有场景 —— 不允许参与组合
    expect(isComposable(newBeat('p', { title: 'x', kind: 'action' }))).toBe(false)
    expect(
      isComposable(newBeat('p', { title: 'x', kind: 'action', entities: ['e_chuci'] }))
    ).toBe(false)
    // 台词除了场景，还必须给说话人
    expect(isComposable(beat({ title: 'x', kind: 'dialogue', dialogue: '啊', entities: [] }))).toBe(
      false
    )
    expect(
      isComposable(
        beat({ title: 'x', kind: 'dialogue', dialogue: '啊', speakerId: 'e_chuci', entities: [] })
      )
    ).toBe(true)
  })

  it('纯场景镜的镜头主体退回场景', () => {
    const b = beat({ title: '空镜', kind: 'establishing', entities: [] })
    expect(resolveSubjectId(b)).toBe('e_cave')
  })

  it('场景不会被混进主体列表', () => {
    const b = newBeat('p', { title: 'x', kind: 'action', sceneId: 'e_cave', entities: ['e_cave', 'e_chuci'] })
    const normalized = normalizeBeat(b)
    expect(normalized.entities).toEqual(['e_chuci'])
    expect(entityIdsOf(normalized)).toEqual(['e_chuci'])
    expect(allEntityIdsOf(normalized)).toEqual(['e_chuci', 'e_cave'])
  })

  it('镜头主体优先级：说话人 > 聚焦主体 > 唯一实体', () => {
    const b = beat({
      title: 'x',
      kind: 'dialogue',
      dialogue: '啊',
      entities: ['e_chuci', 'e_cave'],
      speakerId: 'e_chuci',
      focusEntityId: 'e_cave'
    })
    expect(resolveSubjectId(b)).toBe('e_chuci')
  })
})

/* ------------------------------ 缝合 ------------------------------ */

describe('缝合引擎', () => {
  const left = [
    beat({ title: 'l1', kind: 'action', entities: ['e_chuci'], focusEntityId: 'e_chuci', order: 0 }),
    beat({ title: 'l2', kind: 'dialogue', dialogue: '我不信。', speakerId: 'e_chuci', entities: ['e_chuci'], order: 1 })
  ]

  it('右段首位说话人已在左段出现 -> 尾帧最后 0.3s 切镜到该说话人', () => {
    const right = [
      beat({ title: 'r1', kind: 'action', entities: ['e_cave'], focusEntityId: 'e_cave', order: 4 }),
      beat({ title: 'r2', kind: 'dialogue', dialogue: '检测到宿主。', speakerId: 'e_panel', entities: ['e_panel'], order: 5 })
    ]
    // 左段中途出现过 e_panel，但末帧是 e_chuci
    const withPanel = [
      ...left,
      beat({ title: 'l3', kind: 'insert', entities: ['e_panel'], focusEntityId: 'e_panel', order: 2 }),
      beat({ title: 'l4', kind: 'action', entities: ['e_chuci'], focusEntityId: 'e_chuci', order: 3 })
    ]
    const seam = analyzeSeam(withPanel, right, { settings: S })
    expect(seam.lastSubjectId).toBe('e_chuci')
    expect(seam.firstSpeakerId).toBe('e_panel')
    expect(seam.needsTailCut).toBe(true)
    expect(seam.tailCutTargetId).toBe('e_panel')
    expect(seam.needsPreshoot).toBe(true)
    expect(seam.blackFallback).toBe(false)
    expect(seam.continuityToNext).toBe(true)
  })

  it('左段末帧主体就是右段说话人 -> 不需要切镜', () => {
    const right = [
      beat({ title: 'r', kind: 'dialogue', dialogue: '我不信。', speakerId: 'e_chuci', entities: ['e_chuci'], order: 2 })
    ]
    const seam = analyzeSeam(left, right, { settings: S })
    expect(seam.lastSubjectId).toBe('e_chuci')
    expect(seam.needsTailCut).toBe(false)
    expect(seam.needsPreshoot).toBe(true)
    expect(seam.continuityToNext).toBe(true)
  })

  it('左段完全没有右段说话人 -> 黑屏兜底，连续性一律 false', () => {
    const right = [
      beat({ title: 'r', kind: 'dialogue', dialogue: '检测到宿主。', speakerId: 'e_panel', entities: ['e_panel'], order: 2 })
    ]
    const seam = analyzeSeam(left, right, { settings: S })
    expect(seam.blackFallback).toBe(true)
    expect(seam.needsTailCut).toBe(false)
    expect(seam.continuityToNext).toBe(false)
    expect(seam.continuityFromPrev).toBe(false)
    expect(seam.issues.some((i) => i.code === 'seam:black-fallback')).toBe(true)
  })

  it('右段无台词时不要求预备镜头，只按主体判定切镜', () => {
    const right = [
      beat({ title: 'r', kind: 'establishing', entities: ['e_cave'], focusEntityId: 'e_cave', order: 3 })
    ]
    const leftWithCave = [
      beat({ title: 'c', kind: 'establishing', entities: ['e_cave'], focusEntityId: 'e_cave', order: 0 }),
      ...left
    ]
    const seam = analyzeSeam(leftWithCave, right, { settings: S })
    expect(seam.needsPreshoot).toBe(false)
    expect(seam.lastSubjectId).toBe('e_chuci')
    expect(seam.needsTailCut).toBe(true)
    expect(seam.tailCutTargetId).toBe('e_cave')
  })
})

/* ------------------------------ 组合 ------------------------------ */

describe('组合引擎', () => {
  function build(beats: Beat[]) {
    return assemble(beats, defaultStrategy(S, 'fill_max'), { settings: S })
  }

  it('每一组都不超过 141 帧', () => {
    const beats: Beat[] = []
    for (let i = 0; i < 12; i++) {
      beats.push(
        beat({ title: `a${i}`, kind: 'action', entities: ['e_chuci'], focusEntityId: 'e_chuci', order: i })
      )
    }
    const report = build(beats)
    const byId = new Map(beats.map((b) => [b.id, b]))
    for (const g of report.groups) {
      const frames = g.beatIds.reduce((s, id) => s + beatFrames(byId.get(id)!, S), 0)
      expect(frames).toBeLessThanOrEqual(S.maxSegmentFrames)
    }
    expect(report.groups.length).toBeGreaterThan(1)
  })

  it('没有场景的片段被跳过，纯场景镜参与组合', () => {
    const pureScene = beat({
      title: '空镜',
      kind: 'establishing',
      entities: [],
      focusEntityId: 'e_cave',
      order: 0
    })
    const noScene = newBeat('p', { title: '缺场景', kind: 'action', order: 1 })

    const report = build([pureScene, noScene])
    expect(report.skipped.length).toBe(1)
    expect(report.skipped[0].id).toBe(noScene.id)
    const included = report.groups.flatMap((g) => g.beatIds)
    expect(included).toContain(pureScene.id)
    expect(included).not.toContain(noScene.id)
  })

  it('单个片段就超限时仍能产出结果', () => {
    const big = beat({
      title: 'big',
      kind: 'action',
      entities: ['e_cave'],
      focusEntityId: 'e_cave',
      estFrames: 400,
      manualFrames: true,
      order: 0
    })
    const report = build([big])
    expect(report.groups.length).toBe(1)
  })
})

/* ------------------------------ 派生 ------------------------------ */

describe('字段派生', () => {
  const entityById = new Map(ALL.map((e) => [e.id, e]))

  it('subject_definitions 只包含本段出场实体，并按编号排序', () => {
    const entities = ALL.map((e) => ({ ...e, subjectN: e.id === 'e_chuci' ? 1 : e.id === 'e_panel' ? 2 : 5, sx: e.kind === 'speaking' ? (e.id === 'e_chuci' ? 1 : 2) : null }))
    const map = new Map(entities.map((e) => [e.id, e]))
    const beats = [
      beat({ title: 'a', kind: 'action', entities: ['e_cave'], focusEntityId: 'e_cave' }),
      beat({ title: 'b', kind: 'dialogue', dialogue: '我不信。', speakerId: 'e_chuci', entities: ['e_chuci'] })
    ]
    const text = deriveSubjectDefinitions(beats, { settings: S, entityById: map })
    expect(text).toContain('<Subject 1>')
    expect(text).toContain('speaking with')
    expect(text).toContain('<Picture 5>')
    expect(text).not.toContain('系统面板')
  })

  it('detailed_description 生成合法时间戳与台词格式，说话人 ID 在 <d> 外', () => {
    const entities = ALL.map((e) => ({ ...e, subjectN: e.id === 'e_chuci' ? 1 : 2, sx: e.kind === 'speaking' ? 1 : null }))
    const map = new Map(entities.map((e) => [e.id, e]))
    const beats = [
      beat({ title: '预备', kind: 'preshoot', entities: ['e_chuci'], focusEntityId: 'e_chuci' }),
      beat({ title: '台词', kind: 'dialogue', dialogue: '我不信这世上没有解药。', speakerId: 'e_chuci', entities: ['e_chuci'] }),
      beat({ title: '黑屏', kind: 'black' })
    ]
    const text = deriveDetailedDescription(beats, {
      settings: S,
      entityById: map,
      seeder: makeSeeders(map)
    })
    const lines = text.split('\n')
    expect(lines.length).toBe(3)
    for (const line of lines) expect(line).toMatch(/\[Shot \d+\] At \d{2}:\d{2}\.\d{3},/)

    const dialogueLine = lines[1]
    const dIdx = dialogueLine.indexOf('<d>')
    expect(dIdx).toBeGreaterThan(-1)
    expect(dialogueLine.slice(dIdx)).not.toContain('<Subject')
    expect(dialogueLine).toContain('<Subject 1> (S1) says: <d>[Chinese] 我不信这世上没有解药。</d>')
    expect(lines[0]).toContain('Only 楚辞 is in frame')
    // 自动生成的片段措辞跟随工作语言，但 [Shot N] / 时间码 / <Subject N> 等锚点始终是英文
    expect(lines[2]).toContain(S.workLanguage === 'zh' ? '最后一帧为黑屏。' : 'The final frame is black.')
  })

  it('中英两种工作语言下，结构锚点与中文台词逐字一致（本地化改不坏结构）', () => {
    const entities = ALL.map((e) => ({
      ...e,
      subjectN: e.id === 'e_chuci' ? 1 : 2,
      sx: e.kind === 'speaking' ? 1 : null,
      nameEn: e.id === 'e_chuci' ? 'Chuci' : `${e.id}-EN`,
      textDescEn: 'dark robe, pale skin',
      voiceDescEn: 'a young male voice, slightly hoarse'
    }))
    const map = new Map(entities.map((e) => [e.id, e]))
    const beats = [
      beat({ title: '预备', kind: 'preshoot', entities: ['e_chuci'], focusEntityId: 'e_chuci' }),
      beat({
        title: '台词',
        kind: 'dialogue',
        dialogue: '我不信这世上没有解药。',
        speakerId: 'e_chuci',
        entities: ['e_chuci']
      }),
      beat({ title: '黑屏', kind: 'black' })
    ]

    const zh = deriveDetailedDescription(beats, {
      settings: { ...S, workLanguage: 'zh' },
      entityById: map,
      seeder: makeSeeders(map, 'zh')
    })
    const en = deriveDetailedDescription(beats, {
      settings: { ...S, workLanguage: 'en' },
      entityById: map,
      seeder: makeSeeders(map, 'en')
    })

    /** 结构锚点：本地化只允许改自由描述，这些必须一模一样 */
    const anchors = (t: string) => ({
      shots: [...t.matchAll(/\[Shot \d+\] At \d{2}:\d{2}\.\d{3},/g)].map((m) => m[0]),
      subjects: [...t.matchAll(/<Subject \d+>/g)].map((m) => m[0]),
      sx: [...t.matchAll(/\(S\d+\)/g)].map((m) => m[0]),
      dialogue: [...t.matchAll(/<d>([\s\S]*?)<\/d>/g)].map((m) => m[1])
    })
    expect(anchors(en)).toEqual(anchors(zh))

    expect(zh).toContain('Only 楚辞 is in frame')
    expect(zh).toContain('最后一帧为黑屏。')
    expect(zh).toContain('我不信这世上没有解药。')

    expect(en).toContain('Only Chuci is in frame')
    expect(en).toContain('The final frame is black.')
    // 中文只允许出现在 <d> 标签里
    expect(en.replace(/<d>[\s\S]*?<\/d>/g, '')).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('subject_definitions 用英文词条渲染，且不含 <d> 之外的任何中文', () => {
    const entities = ALL.map((e) => ({
      ...e,
      subjectN: e.id === 'e_chuci' ? 1 : 2,
      nameEn: e.id === 'e_chuci' ? 'Chuci' : `${e.id}-EN`,
      textDescEn: 'dark robe, pale skin',
      voiceDescEn: 'a young male voice, slightly hoarse'
    }))
    const map = new Map(entities.map((e) => [e.id, e]))
    const beats = [beat({ title: 'a', kind: 'action', entities: ['e_cave', 'e_chuci'] })]

    const en = deriveSubjectDefinitions(beats, {
      settings: { ...S, workLanguage: 'en' },
      entityById: map
    })
    // is / in / speaking with 是结构锚点，翻译不会动它们
    expect(en).toContain(' is Chuci in <Picture')
    expect(en).toContain('speaking with')
    expect(en).not.toMatch(/[\u4e00-\u9fff]/)

    const zh = deriveSubjectDefinitions(beats, {
      settings: { ...S, workLanguage: 'zh' },
      entityById: map
    })
    expect(zh).toMatch(/[\u4e00-\u9fff]/)
    expect(zh).toContain('speaking with')
  })
})
