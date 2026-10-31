import { describe, expect, it } from 'vitest'
import {
  PLATE_HEIGHT,
  PLATE_WIDTH,
  cameraSideOf,
  castOfScene,
  charactersOfScene,
  cropNoteOf,
  cropRectPx,
  defaultScaleOf,
  focusOfBeat,
  groupByScene,
  layoutSlots,
  moveRect,
  parseScale,
  parseTilt,
  planSceneShots,
  plateEditPromptOf,
  platePromptOf,
  plateRefClause,
  propsOfScene,
  resizeRect,
  sameRect,
  shotAspectOf,
  spreadViewports,
  tiltOfBeat,
  viewportFor
} from './plate'
import type { Beat, Entity, ID } from './types'

let seq = 0

function beat(p: Partial<Beat> = {}): Beat {
  seq += 1
  return {
    id: (p.id ?? `b${seq}`) as ID,
    projectId: 'p1' as ID,
    order: seq,
    kind: 'action',
    title: `第 ${seq} 段`,
    entities: [],
    manualFrames: false,
    locked: false,
    enriched: false,
    createdAt: seq,
    updatedAt: seq,
    ...p
  } as Beat
}

function ent(p: Partial<Entity> & { id: string; name: string }): Entity {
  return {
    projectId: 'p1' as ID,
    type: 'character',
    kind: 'non_speaking',
    subjectN: null,
    sx: null,
    pictureN: null,
    voiceDesc: null,
    textDesc: null,
    createdAt: 1,
    updatedAt: 1,
    ...p
  } as Entity
}

function entityMap(list: Entity[]): Map<ID, Entity> {
  return new Map(list.map((e) => [e.id as ID, e]))
}

describe('景别识别', () => {
  it('从中文运镜里认出景别（长写法优先）', () => {
    expect(parseScale('大特写，手部为主')).toBe('xcu')
    expect(parseScale('特写，固定')).toBe('ecu')
    expect(parseScale('近景，微仰角')).toBe('cu')
    expect(parseScale('中近景，带手部指向')).toBe('mcu')
    expect(parseScale('中景，固定')).toBe('ms')
    expect(parseScale('固定全景，硬切')).toBe('fs')
    expect(parseScale('过肩中景，随开门动作轻微后拉')).toBe('ms')
    expect(parseScale('大远景，固定')).toBe('ews')
  })

  it('英文也认，认不出返回 null', () => {
    expect(parseScale('medium close-up, slow push in')).toBe('mcu')
    expect(parseScale('extreme close-up of the hands')).toBe('xcu')
    expect(parseScale('wide shot, static')).toBe('ws')
    expect(parseScale('固定机位，缓慢推近')).toBeNull()
  })

  it('运镜没写景别时按片段类型兜底', () => {
    expect(defaultScaleOf(beat({ kind: 'insert', direction: '' }))).toBe('ecu')
    expect(defaultScaleOf(beat({ kind: 'reaction' }))).toBe('cu')
    expect(defaultScaleOf(beat({ kind: 'establishing' }))).toBe('ws')
    expect(defaultScaleOf(beat({ kind: 'dialogue' }))).toBe('mcu')
    expect(defaultScaleOf(beat({ kind: 'action' }))).toBe('ms')
    // 写了就以文字为准，不被 kind 覆盖
    expect(defaultScaleOf(beat({ kind: 'insert', direction: '大远景，固定' }))).toBe('ews')
  })

  it('中文写「近景」时不会被英文的 close-up 抢成特写', () => {
    // 中英两段必须分开判：拼成一句会因为英文 close-up 先命中"特写"规则，
    // 把近景整段裁小一号（22% vs 32%）
    const b = beat({
      kind: 'dialogue',
      direction: '近景，微仰角',
      directionEn: 'close-up, slight low angle'
    })
    expect(defaultScaleOf(b)).toBe('cu')
    expect(tiltOfBeat(b)).toBe('low')
    // 只有英文时照常认英文
    expect(defaultScaleOf(beat({ kind: 'action', directionEn: 'medium close-up' }))).toBe('mcu')
  })

  it('俯仰角认仰拍 / 俯视，其余是人眼高度', () => {
    expect(parseTilt('近景，微仰角')).toBe('low')
    expect(parseTilt('略俯视')).toBe('high')
    expect(parseTilt('近景，正面')).toBe('eye')
    expect(parseTilt('low angle, handheld')).toBe('low')
  })
})

describe('取景框几何', () => {
  const aspect = 16 / 9

  it('落在图内，且保持成片高宽比', () => {
    for (const scale of ['ews', 'ws', 'fs', 'ms', 'mcu', 'cu', 'ecu', 'xcu'] as const) {
      for (const anchor of [0, 0.24, 0.5, 0.76, 1]) {
        const r = viewportFor({
          scale,
          anchorX: anchor,
          plateWidth: PLATE_WIDTH,
          plateHeight: PLATE_HEIGHT,
          shotAspect: aspect
        })
        expect(r.x).toBeGreaterThanOrEqual(0)
        expect(r.y).toBeGreaterThanOrEqual(0)
        expect(r.x + r.w).toBeLessThanOrEqual(1.0001)
        expect(r.y + r.h).toBeLessThanOrEqual(1.0001)
        // 裁出来的像素框必须是 16:9
        const px = cropRectPx(r, PLATE_WIDTH, PLATE_HEIGHT)
        expect(Math.abs(px.sw / px.sh - aspect)).toBeLessThan(0.02)
      }
    }
  })

  it('景别越大框越大；超宽占位图上远景被高度夹住', () => {
    const w = (scale: 'fs' | 'ms' | 'cu') =>
      viewportFor({ scale, plateWidth: PLATE_WIDTH, plateHeight: PLATE_HEIGHT }).w
    expect(w('fs')).toBeGreaterThan(w('ms'))
    expect(w('ms')).toBeGreaterThan(w('cu'))
    const ews = viewportFor({ scale: 'ews', plateWidth: PLATE_WIDTH, plateHeight: PLATE_HEIGHT })
    expect(ews.h).toBeCloseTo(1, 5)
    expect(ews.w).toBeLessThan(1)
  })

  it('锚点靠左时框也靠左，靠边时被夹回图内', () => {
    const left = viewportFor({ scale: 'cu', anchorX: 0.24, plateWidth: PLATE_WIDTH, plateHeight: PLATE_HEIGHT })
    const right = viewportFor({ scale: 'cu', anchorX: 0.76, plateWidth: PLATE_WIDTH, plateHeight: PLATE_HEIGHT })
    expect(left.x).toBeLessThan(right.x)
    const edge = viewportFor({ scale: 'cu', anchorX: 0, plateWidth: PLATE_WIDTH, plateHeight: PLATE_HEIGHT })
    expect(edge.x).toBe(0)
  })

  it('仰角把框压低一点，俯视抬高一点', () => {
    const eye = viewportFor({ scale: 'cu', tilt: 'eye', plateWidth: PLATE_WIDTH, plateHeight: PLATE_HEIGHT })
    const low = viewportFor({ scale: 'cu', tilt: 'low', plateWidth: PLATE_WIDTH, plateHeight: PLATE_HEIGHT })
    const high = viewportFor({ scale: 'cu', tilt: 'high', plateWidth: PLATE_WIDTH, plateHeight: PLATE_HEIGHT })
    expect(low.y).toBeGreaterThan(eye.y)
    expect(high.y).toBeLessThan(eye.y)
  })

  it('拖框：平移不出界，改大小锁比例', () => {
    const base = { x: 0.4, y: 0.2, w: 0.3, h: 0.4 }
    expect(moveRect(base, 10, 10)).toMatchObject({ x: 0.7, y: 0.6 })
    expect(moveRect(base, -10, -10)).toMatchObject({ x: 0, y: 0 })
    const bigger = resizeRect(base, 0.2, PLATE_WIDTH, PLATE_HEIGHT, aspect)
    const px = cropRectPx(bigger, PLATE_WIDTH, PLATE_HEIGHT)
    expect(Math.abs(px.sw / px.sh - aspect)).toBeLessThan(0.02)
    expect(bigger.w).toBeGreaterThan(base.w)
    // 缩到最小也留得下一块
    const tiny = resizeRect(base, -1, PLATE_WIDTH, PLATE_HEIGHT, aspect)
    expect(tiny.w).toBeGreaterThanOrEqual(0.06)
  })

  it('撞在一起的框会被错开，不撞的不动', () => {
    const a = { rect: { x: 0.35, y: 0.3, w: 0.3, h: 0.4 } }
    const b = { rect: { x: 0.35, y: 0.3, w: 0.3, h: 0.4 } }
    const c = { rect: { x: 0.05, y: 0.1, w: 0.6, h: 0.8 } }
    const out = spreadViewports([a, b, c])
    expect(sameRect(out[0].rect, out[1].rect)).toBe(false)
    expect(out[2].rect).toEqual(c.rect)
    // 方向对称：一个往左一个往右
    expect(out[0].rect.x).toBeLessThan(0.35)
    expect(out[1].rect.x).toBeGreaterThan(0.35)
  })

  it('出片比例跟着项目设置走，坏值退回 16:9', () => {
    expect(shotAspectOf({ outputWidth: 864, outputHeight: 480 })).toBeCloseTo(1.8)
    expect(shotAspectOf({ outputWidth: 0, outputHeight: 0 })).toBeCloseTo(16 / 9)
  })
})

describe('站位与分组', () => {
  it('站位均匀，单人居中', () => {
    expect(layoutSlots(0)).toEqual([])
    expect(layoutSlots(1)).toEqual([0.5])
    expect(layoutSlots(2)).toEqual([0.33, 0.67])
    expect(layoutSlots(3)).toEqual([0.24, 0.5, 0.76])
  })

  it('按场景分组时保持片序，没绑场景的单独一组', () => {
    const list = [
      beat({ id: 'b1' as ID, sceneId: 's1' as ID }),
      beat({ id: 'b2' as ID, sceneId: 's2' as ID }),
      beat({ id: 'b3' as ID, sceneId: 's1' as ID }),
      beat({ id: 'b4' as ID })
    ]
    const groups = groupByScene(list, entityMap([ent({ id: 's1', name: '便利店', type: 'scene' })]))
    expect(groups.map((g) => g.sceneId)).toEqual(['s1', 's2', ''])
    expect(groups[0].beats.map((b) => b.id)).toEqual(['b1', 'b3'])
    expect(groups[0].name).toBe('便利店')
    expect(groups[1].name).toBe('（未绑定场景）')
    expect(groups[1].scene).toBeNull()
  })

  it('出场主体按首次出场排，场景自己不进站位', () => {
    const lin = ent({ id: 'lin', name: '林晚' })
    const chen = ent({ id: 'chen', name: '陈默' })
    const scene = ent({ id: 's1', name: '便利店', type: 'scene' })
    const beats = [
      beat({ entities: ['chen' as ID, 's1' as ID] }),
      beat({ entities: ['lin' as ID, 'chen' as ID] })
    ]
    const cast = castOfScene(beats, entityMap([lin, chen, scene]))
    expect(cast.map((c) => c.name)).toEqual(['陈默', '林晚'])
  })

  it('只有角色占站位，道具不进 Blocking', () => {
    const lin = ent({ id: 'lin', name: '林晚' })
    const ticket = ent({ id: 'ticket', name: '旧车票', type: 'prop' })
    const beats = [beat({ entities: ['ticket' as ID, 'lin' as ID] })]
    const map = entityMap([lin, ticket])
    expect(charactersOfScene(beats, map).map((e) => e.name)).toEqual(['林晚'])
    expect(propsOfScene(beats, map).map((e) => e.name)).toEqual(['旧车票'])
  })

  it('镜头给谁：focus > 说话人 > 第一个出场主体', () => {
    const lin = ent({ id: 'lin', name: '林晚' })
    const chen = ent({ id: 'chen', name: '陈默' })
    const cast = [lin, chen]
    expect(focusOfBeat(beat({ focusEntityId: 'chen' as ID, entities: ['lin' as ID] }), cast)?.id).toBe('chen')
    expect(focusOfBeat(beat({ speakerId: 'chen' as ID, entities: ['lin' as ID] }), cast)?.id).toBe('chen')
    expect(focusOfBeat(beat({ entities: ['lin' as ID, 'chen' as ID] }), cast)?.id).toBe('lin')
    // focus 指向本场没出场的人 → 退回按出场顺序，不能给出一个站位表里没有的锚点
    expect(focusOfBeat(beat({ focusEntityId: 'ghost' as ID, entities: ['chen' as ID] }), cast)?.id).toBe('chen')
    expect(focusOfBeat(beat({ entities: [] }), cast)).toBeNull()
  })
})

describe('占位图提示词', () => {
  it('把地点、站位、裁切要求都写进去', () => {
    const p = platePromptOf({
      sceneName: 'Night convenience store',
      sceneDesc: 'rain-soaked glass front, fluorescent light',
      slots: [
        { name: '林晚', desc: 'clerk uniform', x: 0.33 },
        { name: '陈默', x: 0.67 }
      ],
      width: 1536,
      height: 640
    })
    expect(p).toContain('ultra-wide 21:9 framing')
    expect(p).toContain('Setting: Night convenience store')
    expect(p).toContain('林晚 (clerk uniform) at the left third')
    expect(p).toContain('陈默 at the right third')
    expect(p).toContain('full body')
    expect(p).toContain('cropped into a 16:9 shot')
  })

  it('参考图点名：地点说"借建筑别抄构图"，人物要保脸', () => {
    const s = plateRefClause([
      { label: '场景·便利店', role: 'set' },
      { label: '林晚', role: 'cast' }
    ])
    expect(s).toContain('<image1> is this location')
    expect(s).toContain('widen the framing')
    expect(s).toContain('<image2> is 林晚')
    expect(s).toContain('do not swap their identities')
    // 只有地点时不该出现"保脸"那句废话
    expect(plateRefClause([{ label: '场景', role: 'set' }])).not.toContain('face')
    expect(plateRefClause([])).toBe('')
  })

  it('裁出来的图记得住"从哪儿裁的"', () => {
    const note = cropNoteOf({
      sceneName: '便利店门面',
      scale: 'cu',
      tilt: 'low',
      rect: { x: 0.32, y: 0.18, w: 0.3, h: 0.4 },
      plateWidth: 1536,
      plateHeight: 640
    })
    expect(note).toContain('[场景占位] 便利店门面')
    expect(note).toContain('近景')
    expect(note).toContain('微仰角')
    expect(note).toContain('x32%')
    expect(note).toContain('1536×640')
  })
})

describe('镜头机位（从总图编辑各镜）', () => {
  const lin = ent({ id: 'lin', name: '林晚', textDesc: 'clerk uniform' })
  const chen = ent({ id: 'chen', name: '陈默' })
  const store = ent({ id: 'store', name: '便利店', type: 'scene' })
  const map = entityMap([lin, chen, store])

  function shot(p: Partial<Beat>): Beat {
    return beat({ sceneId: 'store' as ID, ...p })
  }

  it('人在画面左侧 → 机位在右；右侧 → 机位在左（守 180 度轴）', () => {
    expect(cameraSideOf(0.24)).toBe('right')
    expect(cameraSideOf(0.76)).toBe('left')
    expect(cameraSideOf(0.5)).toBe('front')
  })

  it('对话对切：两个人交替，机位跟着左右翻，但每人都只在一侧拍', () => {
    const beats = [
      shot({ kind: 'dialogue', entities: ['lin', 'chen'] as ID[], speakerId: 'lin' as ID, dialogue: '欢迎光临' }),
      shot({ kind: 'dialogue', entities: ['lin', 'chen'] as ID[], speakerId: 'chen' as ID, dialogue: '这么晚' }),
      shot({ kind: 'dialogue', entities: ['lin', 'chen'] as ID[], speakerId: 'lin' as ID, dialogue: '嗯' })
    ]
    const plans = planSceneShots(beats, map)
    expect(plans.map((p) => p.subject?.id)).toEqual(['lin', 'chen', 'lin'])
    // 林晚在左位 → 右机位；陈默在右位 → 左机位。视线始终相对，不越轴
    expect(plans.map((p) => p.side)).toEqual(['right', 'left', 'right'])
    expect(plans.every((p) => p.scale === 'mcu')).toBe(true)
    // 对话的对象要能被写成"看向画外那个人"
    expect(plans[0].other?.id).toBe('chen')
  })

  it('同一主体连着两拍：第二拍转成四分之三侧并推近一档，不会出两张一样的图', () => {
    const beats = [
      shot({ kind: 'dialogue', entities: ['lin'] as ID[], speakerId: 'lin' as ID }),
      shot({ kind: 'dialogue', entities: ['lin'] as ID[], speakerId: 'lin' as ID }),
      shot({ kind: 'dialogue', entities: ['lin'] as ID[], speakerId: 'lin' as ID })
    ]
    const plans = planSceneShots(beats, map)
    expect(plans[0].turn).toBe('front')
    expect(plans[1].turn).toBe('three-quarter')
    expect(plans[1].scale).toBe('cu')
    expect(plans[2].turn).toBe('profile')
    // 景别封顶在近景：连拍三拍也不该变成大特写
    expect(plans[2].scale).toBe('cu')
  })

  it('本来就比近景更紧的景别，不会被"推近一档"变成拉远', () => {
    const beats = [
      shot({ kind: 'insert', entities: ['lin'] as ID[] }),
      shot({ kind: 'insert', entities: ['lin'] as ID[] })
    ]
    const plans = planSceneShots(beats, map)
    expect(plans[0].scale).toBe('ecu')
    expect(plans[1].scale).toBe('ecu')
    // 变的是角度，不是景别
    expect(plans[1].turn).toBe('three-quarter')
  })

  it('全景说的是"整个场地"，不是"某个人的远景"', () => {
    const p = plateEditPromptOf({
      sceneName: '便利店',
      subjectName: '陈默',
      otherName: '林晚',
      scale: 'ws',
      tilt: 'eye',
      side: 'right',
      turn: 'front'
    })
    expect(p).toContain('wide shot of the whole location')
    expect(p).not.toContain('wide shot of 陈默')
    // 全景里不指定"看向谁"：那时候两个人都该在画面里
    expect(p).not.toContain('looks toward')
  })

  it('编辑提示词：只改机位，场景与人一律沿用总图', () => {    const p = plateEditPromptOf({
      sceneName: 'Night convenience store',
      sceneDesc: 'rain on the glass',
      subjectName: '林晚',
      otherName: '陈默',
      scale: 'mcu',
      tilt: 'eye',
      side: 'right',
      turn: 'three-quarter',
      action: 'she looks up from the register',
      dialogue: '欢迎光临',
      cast: ['林晚', '陈默']
    })
    expect(p).toContain('Edit <image1> into one shot of this same scene')
    expect(p).toContain('Keep exactly')
    expect(p).toContain('do not add or remove anyone')
    expect(p).toContain('Camera: medium close-up of 林晚')
    expect(p).toContain("camera moved round to 林晚's right")
    expect(p).toContain('three-quarter view')
    expect(p).toContain('looks toward 陈默')
    expect(p).toContain('is speaking to 陈默')
    expect(p).toContain('Only these people are in the scene: 林晚, 陈默')
    expect(p).toContain('16:9')
  })
})
