import { describe, expect, it } from 'vitest'
import {
  actAsOf,
  autoFrameOf,
  beatRefSummary,
  beatTrackOf,
  clampFrame,
  extOf,
  frameConflicts,
  frameLabel,
  frameOf,
  innerFramesOf,
  isRefMaterial,
  isSegmentAsset,
  keyframePlan,
  keyframesOf,
  layoutKeyframes,
  materialFrameOf,
  materialsOf,
  mediaFileSupported,
  mediaKindOf,
  placementOf,
  placementOfRole,
  refClause,
  refImagesOf,
  refMaterialsOf,
  onTimelineOf,
  roleOfPlacement,
  startFrameLabel,
  STRENGTH_HARD,
  STRENGTH_REF,
  subjectPictureGaps,
  subjectPicturesOf,
  suggestPlacement,
  strengthOf,
  usageOfStrength,
  visualNoiseAugOf
} from './references'
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

function ent(id: string, pictureN: number | null, name = id): Entity {
  return {
    id: id as ID,
    projectId: 'p1' as ID,
    name,
    type: 'character',
    kind: 'non_speaking',
    subjectN: 1,
    sx: null,
    pictureN,
    voiceDesc: null,
    textDesc: null,
    createdAt: 0,
    updatedAt: 0
  } as Entity
}

describe('mediaKindOf', () => {
  it('MIME 优先，扩展名兜底', () => {
    expect(mediaKindOf('a.bin', 'video/mp4')).toBe('video')
    expect(mediaKindOf('a.bin', 'audio/wav')).toBe('audio')
    expect(mediaKindOf('a.bin', 'image/png')).toBe('image')
    expect(mediaKindOf('ref.MOV')).toBe('video')
    expect(mediaKindOf('voice.m4a')).toBe('audio')
    expect(mediaKindOf('shot.jpeg')).toBe('image')
  })

  it('认不出来按图片处理（老数据只有图片）', () => {
    expect(mediaKindOf('mystery')).toBe('image')
    expect(mediaKindOf('')).toBe('image')
  })

  it('extOf 只取短扩展名', () => {
    expect(extOf('a.PNG')).toBe('png')
    expect(extOf('a.verylongextension')).toBe('')
    expect(extOf('noext')).toBe('')
  })
})

describe('mediaFileSupported', () => {
  it('导演台认的容器放行（MTS / OPUS 也算）', () => {
    expect(mediaFileSupported('a.mp3')).toBe(true)
    expect(mediaFileSupported('a.WAV')).toBe(true)
    expect(mediaFileSupported('REF.mov')).toBe(true)
    expect(mediaFileSupported('cam.mts')).toBe(true)
    expect(mediaFileSupported('voice.opus')).toBe(true)
    expect(mediaFileSupported('shot.webp')).toBe(true)
  })

  it('认不出的容器挡在门口，别等导入时才静默丢掉', () => {
    expect(mediaFileSupported('notes.txt')).toBe(false)
    expect(mediaFileSupported('clip.3gp')).toBe(false)
    expect(mediaFileSupported('track.mid')).toBe(false)
  })
})

describe('isSegmentAsset', () => {
  it('关键帧与音视频素材都属于段，不占 Picture N', () => {
    expect(isSegmentAsset(asset({ kind: 'keyframe' }))).toBe(true)
    expect(isSegmentAsset(asset({ kind: 'material' }))).toBe(true)
    expect(isSegmentAsset(asset({ kind: 'subject', pictureN: 1 }))).toBe(false)
    expect(isSegmentAsset(asset({ kind: 'scene' }))).toBe(false)
  })
})

describe('keyframesOf / materialsOf', () => {
  const b1 = 'b1' as ID
  const b2 = 'b2' as ID
  const list = [
    asset({ id: 'end', kind: 'keyframe', refId: b1, role: 'end', createdAt: 3 }),
    asset({ id: 'anchor', kind: 'keyframe', refId: b1, role: 'anchor', frameIdx: 40, createdAt: 2 }),
    asset({ id: 'start', kind: 'keyframe', refId: b1, role: 'start', createdAt: 1 }),
    asset({ id: 'other', kind: 'keyframe', refId: b2, role: 'start' }),
    asset({ id: 'subject', kind: 'subject', refId: b1, pictureN: 1 }),
    asset({ id: 'mat', kind: 'material', refId: b1, media: 'audio' })
  ]

  it('只取本段、按 首帧→中间→尾帧 排', () => {
    expect(keyframesOf(list, b1).map((a) => a.id)).toEqual(['start', 'anchor', 'end'])
    expect(keyframesOf(list, b2).map((a) => a.id)).toEqual(['other'])
  })

  it('素材先音频后视频', () => {
    const mats = [
      asset({ id: 'v', kind: 'material', refId: b1, media: 'video', createdAt: 1 }),
      asset({ id: 'a', kind: 'material', refId: b1, media: 'audio', createdAt: 2 })
    ]
    expect(materialsOf(mats, b1).map((a) => a.id)).toEqual(['a', 'v'])
  })

  it('音视频按作用起始帧排（第 0 帧上场的排前面），同帧再分音 / 视频', () => {
    const mats = [
      asset({ id: 'v40', kind: 'material', refId: b1, media: 'video', frameIdx: 40 }),
      asset({ id: 'a0', kind: 'material', refId: b1, media: 'audio', frameIdx: 0 }),
      asset({ id: 'v0', kind: 'material', refId: b1, media: 'video', frameIdx: 0 })
    ]
    expect(materialsOf(mats, b1).map((a) => a.id)).toEqual(['a0', 'v0', 'v40'])
  })
})

describe('音视频的作用起始帧', () => {
  const b1 = 'b1' as ID

  it('起始帧可以是任意帧，越界夹到段内', () => {
    expect(materialFrameOf({ frameIdx: 37 }, 141)).toBe(37)
    expect(materialFrameOf({ frameIdx: 999 }, 141)).toBe(140)
    expect(materialFrameOf({ frameIdx: -5 }, 141)).toBe(0)
    expect(materialFrameOf({}, 141)).toBe(0)
    // 没有段长信息时原样返回（渲染前也能显示）
    expect(materialFrameOf({ frameIdx: 37 }, 0)).toBe(37)
  })

  it('界面文案区分"段首起"与"第 N 帧起"', () => {
    expect(startFrameLabel({ frameIdx: 0 }, 141)).toBe('段首起')
    expect(startFrameLabel({ frameIdx: 12 }, 141)).toBe('第 12 帧起')
  })

  it('轨道把图片与音视频按帧混排：同帧时图片在前', () => {
    const list = [
      asset({ id: 'audio20', kind: 'material', refId: b1, media: 'audio', frameIdx: 20 }),
      asset({ id: 'kf20', kind: 'keyframe', refId: b1, role: 'anchor', frameIdx: 20, createdAt: 1 }),
      asset({ id: 'kfHead', kind: 'keyframe', refId: b1, role: 'start', createdAt: 9 }),
      asset({ id: 'video5', kind: 'material', refId: b1, media: 'video', frameIdx: 5 })
    ]
    expect(beatTrackOf(list, b1, 141).map((a) => a.id)).toEqual([
      'kfHead',
      'video5',
      'kf20',
      'audio20'
    ])
  })
})

describe('keyframePlan', () => {
  it('首帧 / 尾帧 / 中间各自落位', () => {
    const list = [
      asset({ id: 's', kind: 'keyframe', role: 'start' }),
      asset({ id: 'a', kind: 'keyframe', role: 'anchor', frameIdx: 30 }),
      asset({ id: 'e', kind: 'keyframe', role: 'end' })
    ]
    const plan = keyframePlan(list, 100)
    expect(plan.start?.id).toBe('s')
    expect(plan.end?.id).toBe('e')
    expect(plan.anchors.map((x) => [x.asset.id, x.frameIdx])).toEqual([['a', 30]])
  })

  it('同角色重复时，多余的降级成中间锚点（不静默丢掉）', () => {
    const list = [
      asset({ id: 's1', kind: 'keyframe', role: 'start' }),
      asset({ id: 's2', kind: 'keyframe', role: 'start', frameIdx: 12 })
    ]
    const plan = keyframePlan(list, 50)
    expect(plan.start?.id).toBe('s1')
    expect(plan.anchors.map((x) => x.asset.id)).toEqual(['s2'])
  })

  it('没有标首帧时不硬提升锚点（位置本身就是信息）', () => {
    const plan = keyframePlan(
      [asset({ id: 'only', kind: 'keyframe', role: 'anchor', frameIdx: 30 })],
      50
    )
    expect(plan.start).toBeNull()
    expect(plan.anchors.map((x) => x.frameIdx)).toEqual([30])
  })

  it('frameIdx 夹到段内，负数归零', () => {
    const plan = keyframePlan(
      [
        asset({ id: 's', kind: 'keyframe', role: 'start' }),
        asset({ id: 'a', kind: 'keyframe', role: 'anchor', frameIdx: 999 })
      ],
      24
    )
    expect(plan.anchors[0].frameIdx).toBe(23)
    expect(clampFrame(-5, 24)).toBe(0)
    expect(clampFrame(undefined, 0)).toBe(0)
    expect(clampFrame(17, 0)).toBe(17)
  })
})

describe('放置（placement）：关键帧可以放在任意位置', () => {
  it('placementOf 兼容老数据：只有 role 时折回对应的放置', () => {
    expect(placementOfRole('start')).toBe('head')
    expect(placementOfRole('end')).toBe('tail')
    expect(placementOfRole('anchor')).toBe('at')
    expect(placementOfRole(undefined)).toBe('at')
    expect(roleOfPlacement('head')).toBe('start')
    expect(roleOfPlacement('at')).toBe('anchor')

    // 老数据只有 role
    expect(placementOf(asset({ kind: 'keyframe', role: 'start' }))).toBe('head')
    // placement 优先（两条字段打架时以 placement 为准）
    expect(placementOf(asset({ kind: 'keyframe', role: 'start', placement: 'at', frameIdx: 9 }))).toBe(
      'at'
    )
  })

  it('frameOf：段首恒 0、段尾跟着段长、指定帧夹到段内', () => {
    const head = asset({ kind: 'keyframe', placement: 'head', frameIdx: 99 })
    const tail = asset({ kind: 'keyframe', placement: 'tail' })
    const at = asset({ kind: 'keyframe', placement: 'at', frameIdx: 30 })
    expect(frameOf(head, 100)).toBe(0)
    expect(frameOf(tail, 100)).toBe(99)
    expect(frameOf(tail, 0)).toBe(0)
    expect(frameOf(at, 100)).toBe(30)
    expect(frameOf(asset({ kind: 'keyframe', placement: 'at', frameIdx: 999 }), 24)).toBe(23)
    expect(frameLabel(at, 100)).toBe('第 30 帧')
    expect(frameLabel(tail, 100)).toBe('段尾')
  })

  it('keyframePlan 按放置判定，段首 / 段尾各只认一张', () => {
    const list = [
      asset({ id: 'h1', kind: 'keyframe', placement: 'head' }),
      asset({ id: 'h2', kind: 'keyframe', placement: 'head', frameIdx: 40 }),
      asset({ id: 'a', kind: 'keyframe', placement: 'at', frameIdx: 12 }),
      asset({ id: 't', kind: 'keyframe', placement: 'tail' })
    ]
    const plan = keyframePlan(list, 100)
    expect(plan.start?.id).toBe('h1')
    expect(plan.end?.id).toBe('t')
    // 重复的段首不丢，降级成同帧锚点，界面上还能看见、能删
    expect(plan.anchors.map((x) => [x.asset.id, x.frameIdx])).toEqual([
      ['h2', 40],
      ['a', 12]
    ])
  })

  it('layoutKeyframes：首尾优先 / 均匀铺开 / 手动', () => {
    const list = [
      asset({ id: 'k1', kind: 'keyframe', placement: 'at', frameIdx: 3 }),
      asset({ id: 'k2', kind: 'keyframe', placement: 'at', frameIdx: 8 }),
      asset({ id: 'k3', kind: 'keyframe', placement: 'at', frameIdx: 11 })
    ]
    expect(layoutKeyframes(list, 101, 'head_tail')).toEqual([
      { id: 'k1', placement: 'head' },
      { id: 'k2', placement: 'at', frameIdx: 50 },
      { id: 'k3', placement: 'tail' }
    ])
    expect(layoutKeyframes(list, 101, 'even').map((x) => [x.placement, x.frameIdx])).toEqual([
      ['at', 0],
      ['at', 50],
      ['at', 100]
    ])
    // 手动不动任何人
    expect(layoutKeyframes(list, 101, 'manual').map((x) => x.frameIdx)).toEqual([3, 8, 11])
    // 一张就放段首；两张分首尾
    expect(layoutKeyframes([list[0]], 101, 'head_tail')).toEqual([{ id: 'k1', placement: 'head' }])
    expect(
      layoutKeyframes([list[0], list[1]], 101, 'head_tail').map((x) => x.placement)
    ).toEqual(['head', 'tail'])
  })

  it('suggestPlacement：只给新图找空位，不动已有的', () => {
    const frames = 101
    expect(suggestPlacement([], frames, 'head_tail')).toEqual({ placement: 'head' })
    const withHead = [asset({ kind: 'keyframe', placement: 'head' })]
    expect(suggestPlacement(withHead, frames, 'head_tail')).toEqual({ placement: 'tail' })
    const both = [
      asset({ kind: 'keyframe', placement: 'head' }),
      asset({ kind: 'keyframe', placement: 'tail' })
    ]
    // 段首段尾都被占了，新图落在离两边最远的中段
    expect(suggestPlacement(both, frames, 'head_tail')).toEqual({ placement: 'at', frameIdx: 50 })
    // even 不看首尾身份，直接等分
    expect(suggestPlacement([], frames, 'even')).toEqual({ placement: 'at', frameIdx: 0 })
    // 空段时给段首
    expect(suggestPlacement([], frames, 'manual')).toEqual({ placement: 'head' })
  })

  it('innerFramesOf：均匀铺在段内但不碰首尾', () => {
    // n = 1 落在中点
    expect(innerFramesOf(101, 1)).toEqual([50])
    // n = 2 落在三分点，而不是 0 / 100
    expect(innerFramesOf(101, 2)).toEqual([33, 67])
    expect(innerFramesOf(101, 4)).toEqual([20, 40, 60, 80])
    // 一张都没有 / 段长未知时不要凭空造位置
    expect(innerFramesOf(101, 0)).toEqual([])
    expect(innerFramesOf(0, 2)).toEqual([0, 0])
    // 任何一张都不会被挤到 last 之外
    for (const f of innerFramesOf(7, 9)) expect(f).toBeLessThanOrEqual(6)
  })

  it('autoFrameOf：默认中点，中点被占了就贴着它找空格', () => {
    const frames = 101
    expect(autoFrameOf([], frames)).toBe(50)
    // 中点已经有一张 → 挨着中点找，不跳到段首 / 段尾去抢另一种身份
    const mid = [asset({ kind: 'keyframe', placement: 'at', frameIdx: 50 })]
    expect(autoFrameOf(mid, frames)).toBe(49)
    const cluster = [49, 50, 51].map((f) =>
      asset({ kind: 'keyframe', placement: 'at', frameIdx: f })
    )
    expect(autoFrameOf(cluster, frames)).toBe(48)
    // 段首 / 段尾贴着放不影响：中点是空的就用中点
    const edges = [
      asset({ kind: 'keyframe', placement: 'head' }),
      asset({ kind: 'keyframe', placement: 'tail' })
    ]
    expect(autoFrameOf(edges, frames)).toBe(50)
    // 段长未知时给 0，别抛错
    expect(autoFrameOf([], 0)).toBe(0)
  })

  it('frameConflicts 标出撞在同一帧的关键帧', () => {
    const list = [
      asset({ id: 'h', kind: 'keyframe', placement: 'head' }),
      asset({ id: 'x', kind: 'keyframe', placement: 'at', frameIdx: 0 }),
      asset({ id: 'y', kind: 'keyframe', placement: 'at', frameIdx: 7 })
    ]
    expect([...frameConflicts(list, 50)]).toEqual(['h', 'x'])
    expect([...frameConflicts([list[2]], 50)]).toEqual([])
  })
})

describe('subjectPicturesOf', () => {
  const entityById = new Map<ID, Entity>([
    ['c1' as ID, ent('c1', 1, '楚辞')],
    ['c2' as ID, ent('c2', 3, '毒尊')],
    ['s1' as ID, ent('s1', 2, '深渊')],
    ['noimg' as ID, ent('noimg', null)]
  ])
  const assets = [
    asset({ pictureN: 1, kind: 'subject' }),
    asset({ pictureN: 2, kind: 'subject' }),
    asset({ pictureN: 3, kind: 'subject' })
  ]

  it('包含场景实体、按 Picture 编号排序、去重', () => {
    const b = beat({ entities: ['c2', 'c1', 'c1', 'noimg'] as ID[], sceneId: 's1' as ID })
    const out = subjectPicturesOf(b, entityById, assets)
    expect(out.map((x) => x.pictureN)).toEqual([1, 2, 3])
    expect(out.map((x) => x.entity.name)).toEqual(['楚辞', '深渊', '毒尊'])
  })

  it('注册表里没有对应图片的实体跳过', () => {
    const out = subjectPicturesOf(beat({ entities: ['c1'] as ID[] }), entityById, [])
    expect(out).toEqual([])
  })

  it('参考图跟着主体走：段里绑了主体就自动出现，不需要段级素材', () => {
    const b = beat({ entities: ['c2'] as ID[], sceneId: 's1' as ID })
    // 段级素材（关键帧）跟这个查询无关 —— 参考图只由「绑了谁」决定
    const withKf = [...assets, asset({ kind: 'keyframe', refId: b.id, role: 'start' })]
    expect(subjectPicturesOf(b, entityById, withKf).map((x) => x.pictureN)).toEqual([2, 3])
    expect(subjectPicturesOf(beat({ entities: ['c2'] as ID[] }), entityById, assets).map((x) => x.pictureN)).toEqual([3])
  })
})

describe('subjectPictureGaps', () => {
  const entityById = new Map<ID, Entity>([
    ['c1' as ID, ent('c1', 1, '楚辞')],
    ['c2' as ID, ent('c2', 3, '毒尊')],
    ['noimg' as ID, ent('noimg', null)]
  ])
  const assets = [asset({ pictureN: 1, kind: 'subject' }), asset({ pictureN: 3, kind: 'subject' })]

  it('列出绑定了但没有参考图的主体（含编号存在但素材缺失）', () => {
    const b = beat({ entities: ['c1', 'c2', 'noimg'] as ID[] })
    expect(subjectPictureGaps(b, entityById, assets).map((e) => e.id)).toEqual(['noimg'])
    // c2 编号是 3，但把素材拿掉就成缺口 —— 界面要能提示"编号指向了不存在的图"
    const noAsset = [asset({ pictureN: 1, kind: 'subject' })]
    expect(subjectPictureGaps(b, entityById, noAsset).map((e) => e.id)).toEqual(['c2', 'noimg'])
  })

  it('都有图时为空；没绑主体时也为空', () => {
    expect(subjectPictureGaps(beat({ entities: ['c1'] as ID[] }), entityById, assets)).toEqual([])
    expect(subjectPictureGaps(beat(), entityById, assets)).toEqual([])
  })
})

describe('beatRefSummary', () => {
  const entityById = new Map<ID, Entity>([['c1' as ID, ent('c1', 1, '楚辞')]])
  const assets = [
    asset({ pictureN: 1, kind: 'subject' }),
    asset({ kind: 'keyframe', refId: 'b1' as ID, role: 'start' }),
    asset({ kind: 'keyframe', refId: 'b1' as ID, role: 'anchor', frameIdx: 10 }),
    asset({ kind: 'material', refId: 'b1' as ID, media: 'audio' })
  ]

  it('三类分别计数，摘要能看出区别', () => {
    const s = beatRefSummary(beat({ entities: ['c1'] as ID[] }), entityById, assets)
    expect(s.keyframes).toBe(2)
    expect(s.audio).toBe(1)
    expect(s.video).toBe(0)
    expect(s.subjects).toBe(1)
    expect(s.any).toBe(true)
    expect(s.text).toBe('关键帧 2 · 音频 1 · 主体 P1')
  })

  it('什么都没有时 any = false', () => {
    const s = beatRefSummary(beat(), new Map(), [])
    expect(s.any).toBe(false)
    expect(s.text).toBe('')
  })
})

describe('素材强度（和起始帧正交）', () => {
  it('缺省按本体推：图片满强度、音视频 30（老数据行为不变）', () => {
    expect(strengthOf(asset({ kind: 'keyframe' }))).toBe(100)
    expect(strengthOf(asset({ kind: 'material', media: 'audio' }))).toBe(30)
    expect(strengthOf(asset({ kind: 'material', media: 'video' }))).toBe(30)
    // 没有 kind / media 的历史图片数据也不能被判成软参考
    expect(strengthOf({} as Pick<Asset, 'media' | 'strength' | 'usage' | 'kind'>)).toBe(100)
  })

  it('老数据的 usage 折算成强度', () => {
    expect(strengthOf(asset({ kind: 'keyframe', usage: 'ref' }))).toBe(30)
    expect(strengthOf(asset({ kind: 'material', media: 'audio', usage: 'force' }))).toBe(100)
  })

  it('显式强度优先，并夹到 0..100', () => {
    expect(strengthOf(asset({ kind: 'keyframe', strength: 55 }))).toBe(55)
    expect(strengthOf(asset({ kind: 'keyframe', strength: 240 }))).toBe(100)
    expect(strengthOf(asset({ kind: 'keyframe', strength: -3 }))).toBe(0)
  })

  it('强度换算成 visual_noise_aug：满强度 0.999，半强度约 0.5', () => {
    expect(visualNoiseAugOf(100)).toBe(0.999)
    expect(visualNoiseAugOf(50)).toBe(0.5)
    expect(visualNoiseAugOf(0)).toBe(0)
  })

  it('档位只看是不是满强度：100 强制，其余（含 0）都是参考', () => {
    expect(usageOfStrength(STRENGTH_HARD)).toBe('force')
    expect(usageOfStrength(STRENGTH_REF)).toBe('ref')
    expect(usageOfStrength(95)).toBe('ref')
    expect(usageOfStrength(0)).toBe('ref')
    // 越界值先夹再判，和 strengthOf 用的是同一套规则
    expect(usageOfStrength(180)).toBe('force')
  })

  it('参考档落在 30：不是 0，还能借到三成线索', () => {
    expect(STRENGTH_REF).toBe(30)
    expect(visualNoiseAugOf(STRENGTH_REF)).toBeCloseTo(0.3, 3)
  })

  it('强度不改变图片的首尾身份：调软的段首仍是 start', () => {
    const list = [
      asset({ kind: 'keyframe', refId: 'b1' as ID, role: 'start', strength: 30 }),
      asset({ kind: 'keyframe', refId: 'b1' as ID, role: 'anchor', frameIdx: 40 })
    ]
    const plan = keyframePlan(list, 141)
    expect(plan.start).not.toBeNull()
    expect(plan.anchors.map((a) => a.frameIdx)).toEqual([40])
  })
})

/**
 * 参考图点名：模型只看得到 <image1>…<imageN> 这些占位，
 * 不告诉它哪个编号是谁，两个人就会换脸 —— 这段文本是编辑能用起来的前提。
 */
describe('refClause', () => {
  it('没有参考图就一个字都不加，纯文生图不该被塞噪声', () => {
    expect(refClause([])).toBe('')
  })

  it('按顺序编号，编号必须和传入顺序（= 后端挂图的顺序）一致', () => {
    const s = refClause([{ label: '林岚' }, { label: '周野' }])
    expect(s).toContain('<image1> is 林岚')
    expect(s).toContain('<image2> is 周野')
    expect(s.indexOf('<image1>')).toBeLessThan(s.indexOf('<image2>'))
  })

  it('只给一张时不会冒出 <image2>', () => {
    const s = refClause([{ label: '林岚' }])
    expect(s).toContain('<image1> is 林岚')
    expect(s).not.toContain('<image2>')
  })

  it('明确要求保持脸 / 发型 / 服装，别互换身份', () => {
    const s = refClause([{ label: 'A' }, { label: 'B' }])
    expect(s).toMatch(/face/i)
    expect(s).toMatch(/outfit/i)
    expect(s).toMatch(/identit/i)
  })

  it('场景图只说借光线氛围，不许把构图也搬过来', () => {
    const s = refClause([{ label: '林岚' }, { label: '场景图', kind: 'scene' }])
    expect(s).toContain('<image2> is this shot')
    expect(s).toMatch(/do not copy its composition/i)
  })

  it('整段只有场景图时，不写"别互换身份"这种没头没脑的话', () => {
    const s = refClause([{ label: '场景图', kind: 'scene' }])
    expect(s).not.toMatch(/identit/i)
    expect(s).not.toMatch(/face/i)
  })
})

/**
 * 作用方式：同一张段内图片，是"这一帧就该长这样"（关键帧）还是
 * "这个人长这样"（参考图）。两条通道互斥，不能既进 kfImages 又占 Picture 槽。
 */
describe('作用方式 actAs', () => {
  it('缺省按关键帧算 —— 老数据里段内图片一直是关键帧，不能静默变成参考图', () => {
    expect(actAsOf(asset({ kind: 'keyframe' }))).toBe('keyframe')
    expect(actAsOf(asset({ kind: 'keyframe', actAs: 'reference' }))).toBe('reference')
  })

  it('参考方式的图不进关键帧列表，也不上帧轨道', () => {
    const assets = [
      asset({ id: 'k1', kind: 'keyframe', refId: 'b1', placement: 'head' }),
      asset({ id: 'r1', kind: 'keyframe', refId: 'b1', actAs: 'reference', pictureN: 3 })
    ]
    expect(keyframesOf(assets, 'b1').map((a) => a.id)).toEqual(['k1'])
    expect(beatTrackOf(assets, 'b1', 100).map((a) => a.id)).toEqual(['k1'])
    expect(refImagesOf(assets, 'b1').map((a) => a.id)).toEqual(['r1'])
  })

  it('参考方式单独计数，摘要里能和关键帧分开看', () => {
    const assets = [
      asset({ id: 'k1', kind: 'keyframe', refId: 'b1', placement: 'head' }),
      asset({ id: 'r1', kind: 'keyframe', refId: 'b1', actAs: 'reference', pictureN: 3 })
    ]
    const s = beatRefSummary({ id: 'b1' as ID, entities: [] }, new Map(), assets)
    expect(s.keyframes).toBe(1)
    expect(s.references).toBe(1)
    expect(s.text).toContain('关键帧 1')
    expect(s.text).toContain('参考图 1')
  })

  it('参考方式按 pictureN 排，和 refs 的顺序对得上', () => {
    const assets = [
      asset({ id: 'r2', kind: 'keyframe', refId: 'b1', actAs: 'reference', pictureN: 7 }),
      asset({ id: 'r1', kind: 'keyframe', refId: 'b1', actAs: 'reference', pictureN: 2 })
    ]
    expect(refImagesOf(assets, 'b1').map((a) => a.pictureN)).toEqual([2, 7])
  })

  it('音视频同样有作用方式：参考的只借音色 / 动作，不占时间轴', () => {
    const assets = [
      asset({ id: 'v1', kind: 'material', refId: 'b1', media: 'audio', frameIdx: 0 }),
      asset({
        id: 'v2',
        kind: 'material',
        refId: 'b1',
        media: 'audio',
        frameIdx: 0,
        actAs: 'reference',
        strength: 100
      })
    ]
    // 参考素材单独一列，关键帧轨道上只剩"这一段自己的内容"
    expect(refMaterialsOf(assets, 'b1').map((a) => a.id)).toEqual(['v2'])
    expect(materialsOf(assets, 'b1').map((a) => a.id)).toEqual(['v1', 'v2'])
    expect(onTimelineOf(assets[0])).toBe(true)
    expect(onTimelineOf(assets[1])).toBe(false)
    // 强度调满也不改作用方式：通道由 actAs 定，不由强度定
    expect(isRefMaterial(assets[1])).toBe(true)
  })
})
