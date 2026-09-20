import { describe, expect, it } from 'vitest'
import { fingerprint, reconcileGroups, segmentSourceHash } from './cascade'
import type { Beat, Entity, Group } from './types'

function beat(id: string, order: number, patch: Partial<Beat> = {}): Beat {
  return {
    id,
    projectId: 'p',
    order,
    kind: patch.kind ?? 'action',
    title: patch.title ?? id,
    dialogue: patch.dialogue,
    entities: patch.entities ?? [],
    speakerId: patch.speakerId,
    focusEntityId: patch.focusEntityId,
    direction: patch.direction,
    visualDesc: patch.visualDesc,
    manualFrames: false,
    sceneId: patch.sceneId,
    locked: false,
    enriched: true,
    createdAt: 1,
    updatedAt: 1
  }
}

function entity(id: string, patch: Partial<Entity> = {}): Entity {
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
    updatedAt: 1
  }
}

describe('级联：分组归位', () => {
  const beats = ['a', 'b', 'c', 'd', 'e'].map((id, i) => beat(id, i))

  it('★ 上游新增的片段会被自动吸收，不会静默消失', () => {
    const groups: Group[] = [
      { id: 'g1', beatIds: ['a', 'b'] },
      { id: 'g2', beatIds: ['c', 'd', 'e'] }
    ]
    // 在 b 和 c 之间插了一个新片段
    const withNew = [...beats.slice(0, 2), beat('x', 2), ...beats.slice(2)].map((b, i) => ({
      ...b,
      order: i
    }))

    const res = reconcileGroups(groups, withNew)
    expect(res.adopted).toBe(1)
    // 全部片段都必须出现在某个段里
    const assigned = res.groups.flatMap((g) => g.beatIds)
    expect(assigned.sort()).toEqual(withNew.map((b) => b.id).sort())
  })

  it('新增片段插在「它前一个片段」所在的段里，紧跟其后', () => {
    const groups: Group[] = [
      { id: 'g1', beatIds: ['a', 'b'] },
      { id: 'g2', beatIds: ['c', 'd', 'e'] }
    ]
    const withNew = [
      beats[0],
      beats[1],
      beat('x', 2),
      { ...beats[2], order: 3 },
      { ...beats[3], order: 4 },
      { ...beats[4], order: 5 }
    ]

    const res = reconcileGroups(groups, withNew)
    expect(res.groups[0].beatIds).toEqual(['a', 'b', 'x'])
    expect(res.groups[1].beatIds).toEqual(['c', 'd', 'e'])
  })

  it('插在最前面的片段挂到第一段开头', () => {
    const groups: Group[] = [{ id: 'g1', beatIds: ['a', 'b'] }]
    const withNew = [beat('z', 0), { ...beats[0], order: 1 }, { ...beats[1], order: 2 }]

    const res = reconcileGroups(groups, withNew)
    expect(res.groups[0].beatIds).toEqual(['z', 'a', 'b'])
  })

  it('片段被删掉后，分组里的引用一并清掉', () => {
    const groups: Group[] = [
      { id: 'g1', beatIds: ['a', 'b'] },
      { id: 'g2', beatIds: ['c', 'd'] }
    ]
    const after = [beats[0], beats[2], beats[3]].map((b, i) => ({ ...b, order: i }))

    const res = reconcileGroups(groups, after)
    expect(res.dropped).toBe(1)
    expect(res.groups[0].beatIds).toEqual(['a'])
    expect(res.groups[1].beatIds).toEqual(['c', 'd'])
  })

  it('被抽空的段直接丢弃', () => {
    const groups: Group[] = [
      { id: 'g1', beatIds: ['a'] },
      { id: 'g2', beatIds: ['b'] }
    ]
    const res = reconcileGroups(groups, [beats[1]])
    expect(res.groups).toHaveLength(1)
    expect(res.groups[0].id).toBe('g2')
    expect(res.removedGroups).toBe(1)
  })

  it('一段都没有时，会为孤立片段新建一段', () => {
    const res = reconcileGroups([], [beats[0], beats[1]])
    expect(res.groups).toHaveLength(1)
    expect(res.groups[0].beatIds).toEqual(['a', 'b'])
  })

  it('没有变化时 changed 为 false，不产生无谓写库', () => {
    const groups: Group[] = [{ id: 'g1', beatIds: ['a', 'b', 'c', 'd', 'e'] }]
    const res = reconcileGroups(groups, beats)
    expect(res.changed).toBe(false)
    expect(res.groups[0].beatIds).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('★ 归位不会打乱段内既有片段的顺序', () => {
    const groups: Group[] = [
      { id: 'g1', beatIds: ['a', 'b'] },
      { id: 'g2', beatIds: ['c', 'd', 'e'] }
    ]
    const res = reconcileGroups(groups, beats)
    for (const g of res.groups) {
      const orders = g.beatIds.map((id) => beats.findIndex((b) => b.id === id))
      expect(orders).toEqual([...orders].sort((x, y) => x - y))
    }
  })

  it('连续新增多个片段也能全部吸收', () => {
    const groups: Group[] = [{ id: 'g1', beatIds: ['a', 'b'] }]
    const many = [beats[0], beats[1], beat('x', 2), beat('y', 3), beat('z', 4)]
    const res = reconcileGroups(groups, many)
    expect(res.adopted).toBe(3)
    expect(res.groups.flatMap((g) => g.beatIds).sort()).toEqual(['a', 'b', 'x', 'y', 'z'])
  })
})

describe('级联：段内容指纹', () => {
  const ents = [entity('e1', { name: '楚辞', voiceDesc: '青年男声', pictureN: 1 })]
  const base = [beat('a', 0, { title: '动作', sceneId: 'e1', entities: ['e1'] })]

  it('同样的输入指纹稳定', () => {
    expect(segmentSourceHash(base, ents)).toBe(segmentSourceHash(base, ents))
  })

  it('★ 片段任何一处内容变了，指纹都要跟着变', () => {
    const h = segmentSourceHash(base, ents)
    const variants: Array<[string, Beat[]]> = [
      ['标题', [{ ...base[0], title: '别的动作' }]],
      ['台词', [{ ...base[0], dialogue: '我不信。' }]],
      ['运镜', [{ ...base[0], direction: '中景推近' }]],
      ['画面', [{ ...base[0], visualDesc: '火光跳动' }]],
      ['类型', [{ ...base[0], kind: 'dialogue' }]],
      ['场景', [{ ...base[0], sceneId: 'e2' }]],
      ['主体', [{ ...base[0], entities: ['e2'] }]]
    ]
    for (const [label, list] of variants) {
      expect(segmentSourceHash(list, ents), `${label} 改了但指纹没变`).not.toBe(h)
    }
  })

  it('★ 实体词条变了也算内容变了（音色 / 外观 / 参考图）', () => {
    const h = segmentSourceHash(base, ents)
    expect(segmentSourceHash(base, [{ ...ents[0], voiceDesc: '老者声音' }])).not.toBe(h)
    expect(segmentSourceHash(base, [{ ...ents[0], textDesc: '深色长袍' }])).not.toBe(h)
    expect(segmentSourceHash(base, [{ ...ents[0], pictureN: 9 }])).not.toBe(h)
    expect(segmentSourceHash(base, [{ ...ents[0], name: 'Chuci' }])).not.toBe(h)
  })

  it('片段顺序变了也算变了', () => {
    const two = [beat('a', 0), beat('b', 1)]
    expect(segmentSourceHash(two, ents)).not.toBe(segmentSourceHash([...two].reverse(), ents))
  })

  it('无关实体的变化不影响指纹', () => {
    const h = segmentSourceHash(base, ents)
    const noise = [...ents, entity('e9', { name: '路人' })]
    expect(segmentSourceHash(base, noise)).toBe(h)
  })

  it('指纹是短串，不会把整份内容存进 kv', () => {
    const h = segmentSourceHash(base, ents)
    expect(h.length).toBeLessThan(20)
    expect(h).toMatch(/^[0-9a-z]+$/)
  })

  it('fingerprint 对不同输入给出不同结果', () => {
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'))
    expect(fingerprint('')).toBe(fingerprint(''))
  })
})
