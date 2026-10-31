/**
 * 产物页的两个"接线"回归。
 *
 * 这两个地方错了都不会报错，只会静默给错东西：
 *   1. `packSegmentOf` 少传一个字段 ⇒ 产物页拿到的 timeline 和提交时不完全一致，
 *      段 index 就可能对到别人的缓存槽上；
 *   2. `comfySegmentClipUrl` 少带 `variant` ⇒ 二采那一列永远播一采的片子。
 */
import { describe, expect, it } from 'vitest'
import { attachmentsOf, packSegmentOf } from './packInput'
import { comfySegmentClipUrl } from '@/core/comfy'
import type { Beat, Entity, FieldSchema } from './types'

const schema: FieldSchema[] = [
  { key: 'summary', label: 'summary', order: 1, source: 'derived', editable: true, required: true, lang: 'en' },
  { key: 'subject_definitions', label: 'subject_definitions', order: 2, source: 'derived', editable: true, required: true, lang: 'en' }
]

const beat = (patch: Partial<Beat> = {}) =>
  ({
    id: 'b1',
    projectId: 'p1',
    order: 1,
    kind: 'action',
    title: '推门',
    entities: ['e1'],
    manualFrames: false,
    ...patch
  }) as Beat

const ent = (id: string): Entity => ({ id, name: id, pictureN: 1 }) as Entity

describe('packSegmentOf', () => {
  it('六段式全文按 schema 顺序拼，帧数原样带过去', () => {
    const seg = packSegmentOf(
      {
        group: { id: 'g1' },
        frames: 141,
        narrativeBeats: [beat()],
        fields: { summary: '夜里', subject_definitions: '店长' },
        refPrev: true,
        seam: { continuityFromPrev: true },
        nextSeam: { continuityToNext: false }
      },
      schema,
      new Map([['e1', ent('e1')]])
    )
    expect(seg.id).toBe('g1')
    expect(seg.frames).toBe(141)
    expect(seg.refPrev).toBe(true)
    expect(seg.continuityFromPrev).toBe(true)
    expect(seg.continuityToNext).toBe(false)
    expect(seg.prompt).toContain('summary:')
    // schema 顺序优先于对象里的 key 顺序
    expect(seg.prompt.indexOf('summary:')).toBeLessThan(seg.prompt.indexOf('subject_definitions:'))
    expect(seg.entities?.map((e) => e.id)).toEqual(['e1'])
  })

  it('缺缝合分析时按"不连续"处理，且不炸', () => {
    const seg = packSegmentOf(
      {
        group: { id: 'g2' },
        frames: 124,
        narrativeBeats: [],
        fields: {},
        refPrev: false,
        seam: null,
        nextSeam: null
      },
      schema,
      new Map()
    )
    expect(seg.continuityFromPrev).toBe(false)
    expect(seg.continuityToNext).toBe(false)
    expect(seg.entities).toEqual([])
  })

  it('实体查不到就丢掉，不会塞 undefined 进包', () => {
    const seg = packSegmentOf(
      {
        group: { id: 'g3' },
        frames: 100,
        narrativeBeats: [beat({ entities: ['missing'] })],
        fields: {},
        refPrev: false,
        seam: null,
        nextSeam: null
      },
      schema,
      new Map()
    )
    expect(seg.entities).toEqual([])
  })
})

describe('comfySegmentClipUrl', () => {
  const base = 'http://127.0.0.1:8188/'

  it('一采/二采走不同的 variant —— 否则二采那一列会播成一采', () => {
    const first = comfySegmentClipUrl(base, { nodeId: '39', workflowName: 'ep1', index: 2, pass: 'first' })
    const second = comfySegmentClipUrl(base, { nodeId: '39', workflowName: 'ep1', index: 2, pass: 'second' })
    expect(first).toContain('variant=1st')
    expect(second).toContain('variant=2nd')
    expect(first).not.toBe(second)
  })

  it('一律经后端转发（直连 8188 的跨源媒体会被浏览器拒播）', () => {
    const url = comfySegmentClipUrl(base, { nodeId: '39', workflowName: '第 01 集', index: 0, pass: 'first' })
    expect(url).toContain('/api/comfy/clip?')
    // 目标 ComfyUI 作为参数带过去，转发层据此找上游
    const q = new URLSearchParams(url.split('?')[1])
    expect(q.get('base')).toBe('http://127.0.0.1:8188/')
    expect(q.get('node_id')).toBe('39')
    expect(q.get('index')).toBe('0')
    // 中文缓存目录必须被编码（URLSearchParams 把空格编成 +，aiohttp 会解回来）
    expect(q.get('workflow_name')).toBe('第 01 集')
  })
})

describe('attachmentsOf：段内多拍的关键帧摊平', () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
  const kf = (id: string, refId: string, role: any, frameIdx?: number) =>
    ({
      id,
      projectId: 'p1',
      pictureN: 0,
      fileName: `${id}.png`,
      originalName: `${id}.png`,
      label: id,
      blob,
      kind: 'keyframe',
      refId,
      media: 'image',
      role,
      frameIdx,
      createdAt: Number(id.replace(/\D/g, '')) || 1
    }) as any

  it('第一拍首帧=段首，最后一拍尾帧=段尾，其余按拍起点换算成锚点', () => {
    const b1 = beat({ id: 'b1', manualFrames: true, estFrames: 100, entities: [] })
    const b2 = beat({ id: 'b2', manualFrames: true, estFrames: 50, entities: [] })
    const assets = [
      kf('k1', 'b1', 'start'),
      kf('k2', 'b1', 'anchor', 10),
      kf('k3', 'b2', 'start'),
      kf('k4', 'b2', 'end')
    ]
    const out = attachmentsOf([b1, b2], assets, { fps: 24 } as any)
    expect(out.keyframes.map((k) => [k.role, k.frameIdx])).toEqual([
      ['start', 0],
      ['anchor', 10],
      // b2 的"首帧"在中间拍，只能当锚点：100 是 b2 的起点
      ['anchor', 100],
      // 段尾带上真实帧位：整段 150 帧 → 149
      ['end', 149]
    ])
    expect(out.materials).toEqual([])
  })

  it('同一个拍里的音视频按媒体分开，空段返回空数组', () => {
    const b1 = beat({ id: 'b1', manualFrames: true, estFrames: 100, entities: [] })
    const mat = (id: string, media: 'audio' | 'video', frameIdx?: number) =>
      ({ ...kf(id, 'b1', undefined), kind: 'material', media, role: undefined, frameIdx }) as any
    const out = attachmentsOf([b1], [mat('m1', 'audio'), mat('m2', 'video')], undefined)
    expect(out.materials.map((m) => m.media)).toEqual(['audio', 'video'])
    expect(attachmentsOf([], [mat('m1', 'audio')])).toEqual({
      keyframes: [],
      materials: [],
      refImages: []
    })
  })

  it('音视频的作用起始帧换算成段内绝对帧位（拍起点 + 拍内偏移，越界夹住）', () => {
    const b1 = beat({ id: 'b1', manualFrames: true, estFrames: 100, entities: [] })
    const b2 = beat({ id: 'b2', manualFrames: true, estFrames: 50, entities: [] })
    const mat = (id: string, refId: string, media: 'audio' | 'video', frameIdx?: number) =>
      ({ ...kf(id, refId, undefined), kind: 'material', media, role: undefined, frameIdx }) as any
    const out = attachmentsOf(
      [b1, b2],
      [mat('m1', 'b1', 'audio', 30), mat('m2', 'b2', 'audio', 20), mat('m3', 'b2', 'video', 999)],
      { fps: 24 } as any
    )
    expect(out.materials.map((m) => [m.media, m.frameIdx])).toEqual([
      ['audio', 30],
      // b2 从第 100 帧开始，拍内第 20 帧 = 段内 120
      ['audio', 120],
      // 50 帧的拍，999 夹到 49，段内 = 149
      ['video', 149]
    ])
  })

  it('任意位置：指定帧按拍起点换算，越界夹到拍内，段尾贴最后一拍拍尾', () => {
    const b1 = beat({ id: 'b1', manualFrames: true, estFrames: 100, entities: [] })
    const b2 = beat({ id: 'b2', manualFrames: true, estFrames: 50, entities: [] })
    const at = (id: string, refId: string, frameIdx: number) =>
      ({ ...kf(id, refId, undefined), placement: 'at', role: 'anchor', frameIdx }) as any
    const assets = [
      at('k1', 'b1', 30),
      at('k2', 'b1', 999),
      at('k3', 'b2', 20),
      { ...kf('k4', 'b2', 'end'), placement: 'tail' }
    ]
    const out = attachmentsOf([b1, b2], assets, { fps: 24 } as any)
    expect(out.keyframes.map((k) => [k.role, k.frameIdx])).toEqual([
      ['anchor', 30],
      // 100 帧的拍，999 夹到 99
      ['anchor', 99],
      // b2 从第 100 帧开始，拍内第 20 帧 = 段内 120
      ['anchor', 120],
      // 段尾也带上真实帧位了（整段 150 帧 → 149），不再是 undefined
      ['end', 149]
    ])
  })

  it('中间拍的段尾降级成锚点，贴在该拍最后一帧', () => {
    const b1 = beat({ id: 'b1', manualFrames: true, estFrames: 100, entities: [] })
    const b2 = beat({ id: 'b2', manualFrames: true, estFrames: 50, entities: [] })
    const assets = [
      { ...kf('k1', 'b1', 'end'), placement: 'tail' },
      { ...kf('k2', 'b2', 'end'), placement: 'tail' }
    ]
    const out = attachmentsOf([b1, b2], assets, { fps: 24 } as any)
    expect(out.keyframes.map((k) => [k.role, k.frameIdx])).toEqual([
      ['anchor', 99],
      ['end', 149]
    ])
  })
})

describe('合并成视频段：关键帧位置随段组成动态变化', () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
  const kf = (id: string, refId: string, role: any, frameIdx?: number) =>
    ({
      id,
      projectId: 'p1',
      pictureN: 0,
      fileName: `${id}.png`,
      originalName: `${id}.png`,
      label: id,
      blob,
      kind: 'keyframe',
      refId,
      media: 'image',
      role,
      frameIdx,
      createdAt: Number(id.replace(/\D/g, '')) || 1
    }) as any

  const at = (id: string, refId: string, frameIdx: number) =>
    ({ ...kf(id, refId, undefined), placement: 'at', role: 'anchor', frameIdx }) as any

  it('同一拍单独成段 vs 与前面的拍合并，位置不一样（合并后整体后移）', () => {
    const b1 = beat({ id: 'b1', manualFrames: true, estFrames: 100, entities: [] })
    const b2 = beat({ id: 'b2', manualFrames: true, estFrames: 50, entities: [] })
    const assets = [at('k1', 'b2', 20)]

    const alone = attachmentsOf([b2], assets, { fps: 24 } as any)
    const merged = attachmentsOf([b1, b2], assets, { fps: 24 } as any)

    expect(alone.keyframes[0].frameIdx).toBe(20)
    expect(merged.keyframes[0].frameIdx).toBe(120)
  })

  it('副帧（pad）会把后面片段的关键帧一起推后', () => {
    const b1 = beat({ id: 'b1', manualFrames: true, estFrames: 100, entities: [] })
    const b2 = beat({ id: 'b2', manualFrames: true, estFrames: 50, entities: [] })
    const assets = [at('k1', 'b2', 10), at('k2', 'b1', 10)]

    const plain = attachmentsOf([b1, b2], assets, { fps: 24 } as any)
    const padded = attachmentsOf([b1, b2], assets, { fps: 24 } as any, { b1: 4 })

    // b1 自身第 10 帧不受自己的副帧影响（副帧加在拍尾）
    expect(plain.keyframes.map((k) => k.frameIdx)).toEqual([10, 110])
    // b1 多了 4 帧 → b2 的起点从 100 变 104
    expect(padded.keyframes.map((k) => k.frameIdx)).toEqual([10, 114])
  })

  it('段首插了预备镜头，第一拍的关键帧不再落在第 0 帧', () => {
    const pre = beat({
      id: 'beat_preshoot_b1',
      kind: 'preshoot',
      manualFrames: true,
      estFrames: 7,
      entities: []
    })
    const b1 = beat({ id: 'b1', manualFrames: true, estFrames: 100, entities: [] })
    const assets = [
      { ...kf('k1', 'b1', 'start'), placement: 'head' },
      at('k2', 'b1', 10)
    ]

    const out = attachmentsOf([pre, b1], assets, { fps: 24 } as any)
    // 首帧仍然兼作 startImage，但位置如实落在预备镜头之后
    expect(out.keyframes.map((k) => [k.role, k.frameIdx])).toEqual([
      ['start', 7],
      ['anchor', 17]
    ])
  })

  it('段尾接了黑屏，最后一个叙事拍的尾帧降级成锚点，不会贴到黑屏上', () => {
    const b1 = beat({ id: 'b1', manualFrames: true, estFrames: 100, entities: [] })
    const black = beat({
      id: 'beat_black_b1',
      kind: 'black',
      manualFrames: true,
      estFrames: 1,
      entities: []
    })
    const assets = [{ ...kf('k1', 'b1', 'end'), placement: 'tail' }]

    const out = attachmentsOf([b1, black], assets, { fps: 24 } as any)
    expect(out.keyframes.map((k) => [k.role, k.frameIdx])).toEqual([['anchor', 99]])
  })

  it('packSegmentOf 用素材化后的完整序列 + 副帧算位置', () => {
    const pre = beat({
      id: 'beat_preshoot_b1',
      kind: 'preshoot',
      manualFrames: true,
      estFrames: 7,
      entities: []
    })
    const b1 = beat({ id: 'b1', manualFrames: true, estFrames: 100, entities: [] })
    const b2 = beat({ id: 'b2', manualFrames: true, estFrames: 50, entities: [] })
    const assets = [at('k1', 'b2', 5)]

    const seg = packSegmentOf(
      {
        group: { id: 'g1' },
        frames: 160,
        narrativeBeats: [b1, b2],
        beats: [pre, b1, b2],
        pad: { b1: 3 },
        fields: {},
        refPrev: false,
        seam: null,
        nextSeam: null
      },
      schema,
      new Map(),
      assets,
      { fps: 24 } as any
    )
    // 7（预备镜头）+ 100 + 3（副帧）+ 5
    expect(seg.keyframes?.[0]?.frameIdx).toBe(115)
  })
})

/**
 * 作用方式决定走哪条通道：关键帧 → keyframes（换算帧位），参考图 → refImages
 * （不换算，直接带 pictureN）。这里错了不会报错，只会"图传了但没进模型"。
 */
describe('作用方式：关键帧 vs 参考图', () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
  const kf = (id: string, refId: string, patch: Record<string, unknown> = {}) =>
    ({
      id,
      projectId: 'p1',
      pictureN: 0,
      fileName: `${id}.png`,
      originalName: `${id}.png`,
      label: id,
      blob,
      kind: 'keyframe',
      refId,
      media: 'image',
      placement: 'head',
      createdAt: 1,
      ...patch
    }) as any

  it('参考方式的图不走帧位换算，直接带 pictureN 进 refImages', () => {
    const b1 = beat({ id: 'b1', manualFrames: true, estFrames: 100, entities: [] })
    const assets = [
      kf('k1', 'b1', { actAs: 'keyframe' }),
      kf('r1', 'b1', { actAs: 'reference', pictureN: 4, fileName: 'Picture4.png' })
    ]
    const out = attachmentsOf([b1], assets, { fps: 24 } as any)
    expect(out.keyframes.map((k) => k.role)).toEqual(['start'])
    expect(out.refImages).toEqual([
      { pictureN: 4, fileName: 'Picture4.png', originalName: 'r1.png', blob }
    ])
  })

  it('另一段的参考图同样会进 refImages，且不混进关键帧', () => {
    const b1 = beat({ id: 'b1', manualFrames: true, estFrames: 100, entities: [] })
    const b2 = beat({ id: 'b2', order: 2, manualFrames: true, estFrames: 50, entities: [] })
    const assets = [kf('r1', 'b2', { actAs: 'reference', pictureN: 2, fileName: 'Picture2.png' })]
    const out = attachmentsOf([b1, b2], assets, { fps: 24 } as any)
    expect(out.refImages.map((r) => [r.pictureN, r.fileName])).toEqual([[2, 'Picture2.png']])
    expect(out.keyframes).toEqual([])
  })
})
