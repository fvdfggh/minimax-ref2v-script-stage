import { describe, expect, it } from 'vitest'
import {
  MIN_STANDALONE_FRAMES,
  absorbImpact,
  deleteImpact,
  mergeImpact,
  reconcileWithGaps,
  renderHashOf,
  resultStatus,
  splitImpact
} from './insertion'
import { materializeSegment } from './seam'
import type { Beat, Group, SegmentLock } from './types'
import { DEFAULT_SETTINGS } from './types'

function beat(id: string, order: number, frames = 60, patch: Partial<Beat> = {}): Beat {
  return {
    id,
    projectId: 'p',
    order,
    kind: patch.kind ?? 'action',
    title: patch.title ?? id,
    entities: patch.entities ?? [],
    speakerId: patch.speakerId,
    focusEntityId: patch.focusEntityId,
    estFrames: frames,
    manualFrames: true,
    sceneId: patch.sceneId,
    locked: false,
    enriched: true,
    createdAt: 1,
    updatedAt: 1
  }
}

function lockOf(patch: Partial<SegmentLock> = {}): SegmentLock {
  return {
    hash: 'h1',
    slot: 0,
    frames: 60,
    beatIds: ['a'],
    at: 1,
    by: 'product',
    frozen: {
      tail: 'none',
      tailCutTargetId: null,
      continuityToNext: false,
      continuityFromPrev: false
    },
    ...patch
  }
}

describe('渲染指纹', () => {
  const base = {
    beats: [beat('a', 0)],
    pad: {},
    frames: 60,
    refPrev: false,
    continuityFromPrev: false,
    continuityToNext: false,
    text: 'summary:\n甲走进来',
    settings: DEFAULT_SETTINGS
  }

  it('同样的内容指纹稳定', () => {
    expect(renderHashOf(base)).toBe(renderHashOf({ ...base }))
  })

  it('★ 提示词、帧长、连续性、副帧、素材任何一个变了都要变', () => {
    const h = renderHashOf(base)
    expect(renderHashOf({ ...base, text: 'summary:\n甲走出去' })).not.toBe(h)
    expect(renderHashOf({ ...base, frames: 77 })).not.toBe(h)
    expect(renderHashOf({ ...base, refPrev: true })).not.toBe(h)
    expect(renderHashOf({ ...base, continuityFromPrev: true })).not.toBe(h)
    expect(renderHashOf({ ...base, continuityToNext: true })).not.toBe(h)
    expect(renderHashOf({ ...base, pad: { a: 3 } })).not.toBe(h)
    expect(
      renderHashOf({
        ...base,
        assets: [{ id: 'k1', refId: 'a', kind: 'keyframe', role: 'anchor', frameIdx: 12 }]
      })
    ).not.toBe(h)
  })

  it('多了 / 少了镜头要变，自动拼接片段也算', () => {
    const h = renderHashOf(base)
    expect(renderHashOf({ ...base, beats: [beat('a', 0), beat('preshoot', -1, 7)] })).not.toBe(h)
  })

  it('不参与提示词的标题改了不算（画面确实没变）', () => {
    const h = renderHashOf(base)
    expect(renderHashOf({ ...base, beats: [beat('a', 0, 60, { title: '换个标题' })] })).toBe(h)
  })

  it('别的段的素材不影响本段', () => {
    const h = renderHashOf(base)
    expect(
      renderHashOf({
        ...base,
        assets: [{ id: 'k9', refId: 'other', kind: 'keyframe', frameIdx: 3 }]
      })
    ).toBe(h)
  })
})

describe('结果状态', () => {
  it('没出过片 = 未出片', () => {
    const s = resultStatus({ lock: null, hash: 'h1', slot: 0, beatIds: ['a'] })
    expect(s.state).toBe('none')
  })

  it('内容一致 = 已出片', () => {
    const s = resultStatus({ lock: lockOf(), hash: 'h1', slot: 0, beatIds: ['a'] })
    expect(s.state).toBe('ready')
    expect(s.reason).toBe('')
  })

  it('★ 内容没变、只是段号后移 = 位置变了，但仍然可用（不算失效）', () => {
    const s = resultStatus({ lock: lockOf({ slot: 0 }), hash: 'h1', slot: 2, beatIds: ['a'] })
    expect(s.state).toBe('moved')
    expect(s.reason).toContain('内容没变')
  })

  it('★ 内容变了 = 待重跑，并说清楚增删了哪些镜头', () => {
    const s = resultStatus({
      lock: lockOf({ beatIds: ['a', 'b'] }),
      hash: 'h2',
      slot: 0,
      beatIds: ['a', 'c']
    })
    expect(s.state).toBe('stale')
    expect(s.added).toEqual(['c'])
    expect(s.removed).toEqual(['b'])
    expect(s.reason).toContain('新增 1 个镜头')
    expect(s.reason).toContain('删掉 1 个镜头')
  })

  it('★ 人工标失效优先于一切（旧片不能当新片用）', () => {
    const s = resultStatus({
      lock: lockOf(),
      voided: { at: 9, reason: '并入了 2 个镜头' },
      hash: 'h1',
      slot: 0,
      beatIds: ['a']
    })
    expect(s.state).toBe('voided')
    expect(s.label).toBe('已失效')
    expect(s.reason).toBe('并入了 2 个镜头')
  })
})

describe('归位：插空优先', () => {
  const settings = DEFAULT_SETTINGS
  const a = beat('a', 0)
  const b = beat('b', 1)
  const c = beat('c', 2)
  const x = beat('x', 1) // 插在 a、b 之间的新镜头
  const list = [a, { ...x }, b, c].map((item, i) => ({ ...item, order: i }))

  it('还没出过片：照旧并进相邻段，不多开段', () => {
    const groups: Group[] = [
      { id: 'g1', beatIds: ['a'] },
      { id: 'g2', beatIds: ['b', 'c'] }
    ]
    const res = reconcileWithGaps(groups, list, { settings })
    expect(res.spawned).toBe(0)
    expect(res.groups[0].beatIds).toEqual(['a', 'x'])
    expect(res.groups[1].beatIds).toEqual(['b', 'c'])
  })

  it('★ 已有段出过片：新片段插空成新段，邻居一个镜头都不动', () => {
    const groups: Group[] = [
      { id: 'g1', beatIds: ['a'], lock: lockOf({ beatIds: ['a'] }) },
      { id: 'g2', beatIds: ['b', 'c'], lock: lockOf({ slot: 1, beatIds: ['b', 'c'] }) }
    ]
    const res = reconcileWithGaps(groups, list, { settings })
    expect(res.spawned).toBe(1)
    expect(res.groups.map((g) => g.id)).toEqual(['g1', res.spawnedIds[0], 'g2'])
    expect(res.groups[0].beatIds).toEqual(['a'])
    expect(res.groups[1].beatIds).toEqual(['x'])
    expect(res.groups[1].inserted).toBe(true)
    expect(res.groups[2].beatIds).toEqual(['b', 'c'])
    // 出片记录原封不动带过去
    expect(res.groups[0].lock).toEqual(groups[0].lock)
  })

  it('★ 很短的镜头 + 前一段还没出片：并进前一段，省一次渲染', () => {
    const tiny = beat('t', 1, MIN_STANDALONE_FRAMES - 10)
    const groups: Group[] = [
      { id: 'g1', beatIds: ['a'] },
      { id: 'g2', beatIds: ['b', 'c'], lock: lockOf({ slot: 1, beatIds: ['b', 'c'] }) }
    ]
    const res = reconcileWithGaps(groups, [a, tiny, b, c].map((v, i) => ({ ...v, order: i })), {
      settings
    })
    expect(res.spawned).toBe(0)
    expect(res.groups[0].beatIds).toEqual(['a', 't'])
  })

  it('待编排的片段不会被自动塞回任何段', () => {
    const groups: Group[] = [{ id: 'g1', beatIds: ['a'] }]
    const res = reconcileWithGaps(groups, [a, x], { settings, parked: ['x'] })
    expect(res.adopted).toBe(0)
    expect(res.groups[0].beatIds).toEqual(['a'])
  })

  it('被删掉的片段从段里清掉，被抽空的段丢弃', () => {
    const groups: Group[] = [
      { id: 'g1', beatIds: ['a'] },
      { id: 'g2', beatIds: ['b'] }
    ]
    const res = reconcileWithGaps(groups, [{ ...a, order: 0 }], { settings })
    expect(res.dropped).toBe(1)
    expect(res.removedGroups).toBe(1)
    expect(res.groups.map((g) => g.id)).toEqual(['g1'])
  })
})

describe('增删的影响说明', () => {
  const groups: Group[] = [
    { id: 'g1', beatIds: ['a'], lock: lockOf() },
    { id: 'g2', beatIds: ['b'] }
  ]

  it('并入已出片的段：会失效，并说清是哪一段', () => {
    const impact = absorbImpact(groups, 'g1')
    expect(impact.invalidates).toEqual(['g1'])
    expect(impact.note).toContain('seg01')
    expect(impact.note).toContain('失效')
  })

  it('并入没出片的段：不作废任何东西', () => {
    expect(absorbImpact(groups, 'g2').invalidates).toEqual([])
  })

  it('切开已出片的段：原段作废 + 多出一段', () => {
    const impact = splitImpact(groups, 'g1')
    expect(impact.invalidates).toEqual(['g1'])
    expect(impact.spawns).toBe(1)
  })

  it('合并：只列出真出过片的段', () => {
    const impact = mergeImpact(groups, ['g1', 'g2'])
    expect(impact.invalidates).toEqual(['g1'])
    expect(impact.note).toContain('seg01')
    expect(impact.note).not.toContain('seg02')
  })

  it('删段：镜头回待编排，不作废别的段', () => {
    const impact = deleteImpact(groups, 'g1')
    expect(impact.invalidates).toEqual([])
    expect(impact.note).toContain('待编排')
  })
})

describe('接缝冻结', () => {
  const narrative = [beat('a', 0, 40, { kind: 'dialogue', speakerId: 'e1', dialogue: '走' })]

  it('legacy 策略按缝合结论加黑屏尾巴', () => {
    const seam = {
      leftGroupId: 'g1',
      rightGroupId: 'g2',
      kind: 'transition' as const,
      strength: 0 as const,
      reason: '换场',
      lastSubjectId: 'e1',
      firstSubjectId: 'e2',
      firstSpeakerId: null,
      tailCutTargetId: null,
      needsTailCut: false,
      needsPreshoot: false,
      blackFallback: true,
      continuityToNext: false,
      continuityFromPrev: false,
      leftEntities: ['e1'],
      rightEntities: ['e2'],
      leftSceneId: 's1',
      rightSceneId: 's1',
      sceneChanged: false,
      scenePriorityApplied: false,
      issues: []
    }
    const auto = materializeSegment(narrative, seam, {
      settings: { ...DEFAULT_SETTINGS, seamPolicy: 'legacy' }
    })
    expect(auto.beats.map((b) => b.kind)).toContain('black')

    // 冻结成"直接接"：邻居再变也不加黑屏，镜头序列保持不变
    const frozen = materializeSegment(narrative, seam, {
      settings: { ...DEFAULT_SETTINGS, seamPolicy: 'legacy' },
      freeze: { tail: 'none', tailCutTargetId: null }
    })
    expect(frozen.beats.map((b) => b.kind)).not.toContain('black')
  })

  it('guide 策略不插任何自动片段，但冻结快照说要黑屏就还得黑屏', () => {
    const seam = {
      leftGroupId: 'g1',
      rightGroupId: 'g2',
      kind: 'transition' as const,
      strength: 0 as const,
      reason: '换场',
      lastSubjectId: 'e1',
      firstSubjectId: 'e2',
      firstSpeakerId: 'e1',
      tailCutTargetId: null,
      needsTailCut: false,
      needsPreshoot: false,
      blackFallback: false,
      continuityToNext: false,
      continuityFromPrev: false,
      leftEntities: ['e1'],
      rightEntities: ['e2'],
      leftSceneId: 's1',
      rightSceneId: 's2',
      sceneChanged: true,
      scenePriorityApplied: false,
      issues: []
    }
    const auto = materializeSegment(narrative, seam, { settings: DEFAULT_SETTINGS })
    // 段首不再有预备镜头、段尾不再有黑屏 / 切镜
    expect(auto.beats.map((b) => b.kind)).toEqual(['dialogue'])
    expect(auto.generated).toHaveLength(0)

    // 出过片的段：快照说有黑屏，就不许因为切了策略而把尾巴改掉
    const frozen = materializeSegment(narrative, seam, {
      settings: DEFAULT_SETTINGS,
      freeze: { tail: 'black', tailCutTargetId: null }
    })
    expect(frozen.beats.map((b) => b.kind)).toContain('black')
  })
})
