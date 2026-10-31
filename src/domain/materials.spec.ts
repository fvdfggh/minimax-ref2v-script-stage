import { describe, expect, it } from 'vitest'
import { beatMaterialsOf, chainHeadsOf, materialsCoverage } from './materials'
import { VOICEOVER_LABEL } from './voiceover'
import { DEFAULT_SETTINGS } from './types'
import type { Asset, Beat, Entity, ID } from './types'

let seq = 0
function asset(p: Partial<Asset> & { id?: string }): Asset {
  seq += 1
  return {
    id: (p.id ?? `a${seq}`) as ID,
    projectId: 'p1' as ID,
    pictureN: 0,
    fileName: 'x.png',
    originalName: 'x.png',
    label: '',
    createdAt: p.createdAt ?? seq,
    ...p
  } as Asset
}

function beat(p: Partial<Beat> = {}): Beat {
  return {
    id: 'b1' as ID,
    projectId: 'p1' as ID,
    order: 0,
    kind: 'action',
    title: 't',
    entities: [],
    manualFrames: false,
    locked: false,
    enriched: false,
    createdAt: 0,
    updatedAt: 0,
    ...p
  } as Beat
}

function person(id: string, withVoice: boolean): Entity {
  return {
    id: id as ID,
    projectId: 'p1' as ID,
    name: id,
    type: 'character',
    kind: 'speaking',
    subjectN: 1,
    sx: null,
    pictureN: 1,
    voiceDesc: null,
    textDesc: null,
    voicePack: withVoice ? { id: `v-${id}`, desc: 'd', packName: 'p' } : null,
    createdAt: 0,
    updatedAt: 0
  } as Entity
}

/** 一张段内关键帧 */
function kf(beatId: string, n = 0): Asset {
  return asset({ kind: 'keyframe', refId: beatId as ID, placement: 'at', frameIdx: n })
}

/** 一条台词配音 */
function voice(beatId: string): Asset {
  return asset({
    kind: 'material',
    media: 'audio',
    refId: beatId as ID,
    label: VOICEOVER_LABEL,
    originalName: 'voice_v1.wav'
  })
}

const S = DEFAULT_SETTINGS

describe('beatMaterialsOf', () => {
  it('一张图都没有：仍然算齐（首帧可选，没有图就用文字起画）', () => {
    const b = beat({ id: 'b1' })
    const m = beatMaterialsOf(b, [], new Map(), S, 3)
    expect(m.images).toBe(0)
    expect(m.needImage).toBe(true)
    expect(m.ready).toBe(true)
    expect(m.index).toBe(3)
    expect(m.frames).toBeGreaterThan(0)
  })

  it('有图 + 非台词镜头 = 齐（不该硬要它配音）', () => {
    const b = beat({ id: 'b1', kind: 'action' })
    const m = beatMaterialsOf(b, [kf('b1')], new Map(), S, 1)
    expect(m.voice).toBe('none')
    expect(m.ready).toBe(true)
  })

  it('台词镜头：有台词、说话人有音色、还没配 = todo（缺一口，但不是阻塞）', () => {
    const b = beat({ id: 'b1', kind: 'dialogue', dialogue: '你来了', speakerId: 'e1' as ID })
    const m = beatMaterialsOf(b, [kf('b1')], new Map([['e1' as ID, person('e1', true)]]), S, 1)
    expect(m.voice).toBe('todo')
    expect(m.voiceNote).toContain('还没配音')
    expect(m.ready).toBe(false)
  })

  it('配过音就不再是缺口', () => {
    const b = beat({ id: 'b1', kind: 'dialogue', dialogue: '你来了', speakerId: 'e1' as ID })
    const assets = [kf('b1'), voice('b1')]
    const m = beatMaterialsOf(b, assets, new Map([['e1' as ID, person('e1', true)]]), S, 1)
    expect(m.voice).toBe('done')
    expect(m.audios).toBe(1)
    expect(m.ready).toBe(true)
  })

  it('说话人没固定音色 = blocked，原因要能指向「主体」', () => {
    const b = beat({ id: 'b1', kind: 'dialogue', dialogue: '你来了', speakerId: 'e1' as ID })
    const m = beatMaterialsOf(b, [kf('b1')], new Map([['e1' as ID, person('e1', false)]]), S, 1)
    expect(m.voice).toBe('blocked')
    expect(m.voiceNote).toContain('音色')
    expect(m.ready).toBe(false)
  })

  it('台词镜头但台词空着 = blocked（要回拆解补台词）', () => {
    const b = beat({ id: 'b1', kind: 'dialogue', dialogue: '  ', speakerId: 'e1' as ID })
    const m = beatMaterialsOf(b, [kf('b1')], new Map([['e1' as ID, person('e1', true)]]), S, 1)
    expect(m.voice).toBe('blocked')
    expect(m.ready).toBe(false)
  })

  it('段内多条关键帧按张数算，音视频素材不混进图里', () => {
    const b = beat({ id: 'b1' })
    const assets = [
      kf('b1', 0),
      kf('b1', 10),
      asset({ kind: 'material', media: 'audio', refId: 'b1' as ID, label: '环境声' }),
      // 别的段的图不能算进来
      kf('b2')
    ]
    const m = beatMaterialsOf(b, assets, new Map(), S, 1)
    expect(m.images).toBe(2)
    expect(m.audios).toBe(1)
  })
})

describe('materialsCoverage', () => {
  it('逐段统计缺图 / 缺音 / 齐备，总数能对得上', () => {
    const list = [
      beat({ id: 'b1', kind: 'action' }), // 缺图
      beat({ id: 'b2', kind: 'action' }), // 齐
      beat({ id: 'b3', kind: 'dialogue', dialogue: '嗯', speakerId: 'e1' as ID }), // 有图缺音
      beat({ id: 'b4', kind: 'dialogue', dialogue: '走吧', speakerId: 'e1' as ID }) // 有图有音
    ]
    const assets = [
      kf('b2'),
      kf('b3'),
      kf('b4'),
      voice('b4'),
      asset({ kind: 'material', media: 'audio', refId: 'b4' as ID, label: '环境声' })
    ]
    const c = materialsCoverage(list, assets, new Map([['e1' as ID, person('e1', true)]]), S)
    expect(c.total).toBe(4)
    expect(c.withImage).toBe(3)
    expect(c.missingImage).toBe(1)
    expect(c.voiceTodo).toBe(1)
    expect(c.voiceDone).toBe(1)
    // 首帧可选：b1 没图也算齐，只有 b3 因为缺音不齐
    expect(c.ready).toBe(3)
    expect(c.notReady).toBe(1)
    expect(c.rows.map((r) => r.index)).toEqual([1, 2, 3, 4])
  })

  it('空列表不炸，统计全 0', () => {
    const c = materialsCoverage([], [], new Map(), S)
    expect(c.total).toBe(0)
    expect(c.notReady).toBe(0)
    expect(c.rows).toEqual([])
  })
})

/**
 * 链：段与段靠「引用上段」串起来，上游尾帧喂给下游当首帧引导。
 * 所以一条链只有链头要一张起始图 —— 这是这一版把出图挪到缝合之后的原因。
 */
describe('materialsCoverage · 按链要图', () => {
  const twoSegs = [
    { beatIds: ['b1' as ID], refPrev: false },
    { beatIds: ['b2' as ID], refPrev: true }
  ]

  it('链内段没有图也算齐（首帧由上一段尾帧引导）', () => {
    const list = [beat({ id: 'b1' }), beat({ id: 'b2' })]
    const c = materialsCoverage(list, [kf('b1')], new Map(), S, twoSegs)
    expect(c.chains).toBe(1)
    expect(c.missingImage).toBe(0)
    expect(c.rows[0].chainHead).toBe(true)
    expect(c.rows[1].chainHead).toBe(false)
    expect(c.rows[1].needImage).toBe(false)
    expect(c.ready).toBe(2)
  })

  it('链头缺图才算"没起始图"：整条链一张图都没有 = 缺 1 条，但不再算不齐', () => {
    const list = [beat({ id: 'b1' }), beat({ id: 'b2' })]
    const c = materialsCoverage(list, [], new Map(), S, twoSegs)
    expect(c.chains).toBe(1)
    expect(c.missingImage).toBe(1)
    // 首帧可选：缺图只提示，不扣齐备度
    expect(c.notReady).toBe(0)
  })

  it('一个段里多个 beat：只有第一个要起始图', () => {
    const list = [beat({ id: 'b1' }), beat({ id: 'b2' }), beat({ id: 'b3' })]
    const segments = [
      { beatIds: ['b1' as ID, 'b2' as ID], refPrev: false },
      { beatIds: ['b3' as ID], refPrev: false }
    ]
    const heads = chainHeadsOf(list, segments)
    expect(heads).toEqual([true, false, true])
  })

  it('没有段信息时退回逐段要求（保守方向）', () => {
    const list = [beat({ id: 'b1' }), beat({ id: 'b2' })]
    const c = materialsCoverage(list, [], new Map(), S)
    expect(c.chains).toBe(2)
    expect(c.missingImage).toBe(2)
  })

  it('段信息里漏掉的 beat 按链头算，不会悄无声息地缺图', () => {
    const list = [beat({ id: 'b1' }), beat({ id: 'b9' })]
    const heads = chainHeadsOf(list, [{ beatIds: ['b1' as ID], refPrev: false }])
    expect(heads).toEqual([true, true])
  })
})

/**
 * 参考方式的图不占帧位，所以它不能算"这一段的起始图"。
 * 但首帧本身是可选的 —— 所以这里只断言统计口径，不再断言"不齐"。
 */
describe('作用方式：参考图不算起始图', () => {
  it('只有参考方式素材的链头：算没有起始图，但齐备度不受影响', () => {
    const list = [beat({ id: 'b1' })]
    const assets = [
      asset({ id: 'r1', kind: 'keyframe', refId: 'b1' as ID, actAs: 'reference', pictureN: 2 })
    ]
    const c = materialsCoverage(list, assets, new Map(), S)
    expect(c.rows[0].refImages).toBe(1)
    expect(c.rows[0].images).toBe(0)
    expect(c.missingImage).toBe(1)
    expect(c.rows[0].ready).toBe(true)
    expect(c.withRef).toBe(1)
  })

  it('关键帧 + 参考图同时存在时，各算各的', () => {
    const list = [beat({ id: 'b1' })]
    const assets = [
      asset({ id: 'k1', kind: 'keyframe', refId: 'b1' as ID, placement: 'head' }),
      asset({ id: 'r1', kind: 'keyframe', refId: 'b1' as ID, actAs: 'reference', pictureN: 2 })
    ]
    const c = materialsCoverage(list, assets, new Map(), S)
    expect(c.rows[0].images).toBe(1)
    expect(c.rows[0].refImages).toBe(1)
    expect(c.missingImage).toBe(0)
    expect(c.withImage).toBe(1)
    expect(c.withRef).toBe(1)
  })
})
