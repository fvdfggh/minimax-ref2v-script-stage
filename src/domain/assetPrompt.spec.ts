import { describe, expect, it } from 'vitest'
import {
  REF_SECTION_TITLE,
  composeMaterialPrompt,
  promptBodyOf,
  promptRefsOf,
  referenceSection,
  stripReferenceSection,
  unnumberedRefs
} from './assetPrompt'
import type { Asset, Entity, ID } from './types'

const ent = (id: string, name: string, desc: string, pictureN = 1, nameEn?: string): Entity =>
  ({
    id: id as ID,
    projectId: 'p' as ID,
    name,
    nameEn: nameEn ?? null,
    type: 'character',
    kind: 'speaking',
    subjectN: 1,
    sx: 1,
    pictureN,
    voiceDesc: null,
    textDesc: desc,
    createdAt: 0,
    updatedAt: 0
  }) as Entity

const pic = (id: string, pictureN: number, entityId: string | null, label = ''): Asset =>
  ({
    id: id as ID,
    projectId: 'p' as ID,
    pictureN,
    fileName: `${id}.png`,
    originalName: `${id}.png`,
    label: label || id,
    kind: 'subject',
    refId: (entityId ?? undefined) as ID | undefined,
    createdAt: 0
  }) as Asset

function lookup(entities: Entity[], assets: Asset[]) {
  const em = new Map(entities.map((e) => [e.id, e]))
  const am = new Map(assets.map((a) => [a.id, a]))
  return { assetOf: (id: ID) => am.get(id), entityOf: (id: ID) => em.get(id) }
}

const chen = ent('e1', '陈默', '三十岁出头，短发，深灰工装外套', 3, 'Chen Mo')
const ctx = lookup([chen], [pic('a1', 3, 'e1')])

describe('引用段：参考方式写 <Picture N>，关键帧方式只写名字', () => {
  it('参考方式：编号 + 名字 + 外观描述', () => {
    const p = composeMaterialPrompt(
      { prompt: 'Rainy alley at night', refAssetIds: ['a1' as ID], actAs: 'reference', kind: 'keyframe' },
      ctx
    )
    expect(p).toContain('Rainy alley at night')
    expect(p).toContain(`${REF_SECTION_TITLE}`)
    expect(p).toContain('<Picture 3> Chen Mo — 三十岁出头，短发，深灰工装外套')
  })

  it('关键帧方式：不带 <Picture N>（kfImages 通道按帧位，不认编号）', () => {
    const p = composeMaterialPrompt(
      { prompt: 'Rainy alley at night', refAssetIds: ['a1' as ID], actAs: 'keyframe', kind: 'keyframe' },
      ctx
    )
    expect(p).not.toContain('<Picture 3>')
    expect(p).toContain('Chen Mo — 三十岁出头')
  })

  it('没有引用图时只返回正文，不留一个空表头', () => {
    const p = composeMaterialPrompt({ prompt: 'Just a street', refAssetIds: [] }, ctx)
    expect(p).toBe('Just a street')
    expect(p).not.toContain(REF_SECTION_TITLE)
  })
})

describe('幂等：重复拼不会叠出两段引用', () => {
  it('compose 两次结果一致', () => {
    const a = { prompt: 'A quiet room', refAssetIds: ['a1' as ID], actAs: 'reference' as const }
    const once = composeMaterialPrompt(a, ctx)
    const twice = composeMaterialPrompt({ ...a, prompt: once }, ctx)
    expect(twice).toBe(once)
    expect(twice.split(REF_SECTION_TITLE).length - 1).toBe(1)
  })

  it('换了引用图，旧的那一行不会留在正文里', () => {
    const other = ent('e2', '林岚', '长发，米色风衣', 4, 'Lin Lan')
    const ctx2 = lookup([chen, other], [pic('a1', 3, 'e1'), pic('a2', 4, 'e2')])
    const first = composeMaterialPrompt(
      { prompt: 'Two people', refAssetIds: ['a1' as ID], actAs: 'reference' },
      ctx2
    )
    const second = composeMaterialPrompt(
      { prompt: first, refAssetIds: ['a2' as ID], actAs: 'reference' },
      ctx2
    )
    expect(second).toContain('Lin Lan')
    expect(second).not.toContain('Chen Mo')
    expect(second.split(REF_SECTION_TITLE).length - 1).toBe(1)
  })

  it('正文里自己写了同名字样，不在末尾，不会被剥掉', () => {
    const body = `${REF_SECTION_TITLE} is written on a wall in the shot.`
    expect(stripReferenceSection(body)).toBe(body)
  })
})

describe('引用行：去重与缺编号', () => {
  it('同一个槽被两张图抢，只写一次', () => {
    const dup = [pic('a1', 3, 'e1'), pic('a9', 3, 'e1')]
    const ctx3 = lookup([chen], dup)
    const refs = promptRefsOf({ refAssetIds: ['a1' as ID, 'a9' as ID] }, ctx3)
    expect(refs).toHaveLength(1)
  })

  it('没有 Picture 编号的图能写进提示词，但会被标出来', () => {
    const scene = { ...pic('s1', 0, null, '雨巷'), desc: '湿漉漉的青石板' } as Asset
    const ctx3 = lookup([], [scene])
    const refs = promptRefsOf({ refAssetIds: ['s1' as ID] }, ctx3)
    expect(unnumberedRefs(refs)).toHaveLength(1)
    const sec = referenceSection(refs, true)
    expect(sec).toContain('雨巷 — 湿漉漉的青石板')
    expect(sec).not.toContain('<Picture 0>')
  })

  it('顺序跟着 refAssetIds，不跟着 pictureN', () => {
    const other = ent('e2', '林岚', '米色风衣', 4, 'Lin Lan')
    const ctx4 = lookup([chen, other], [pic('a1', 3, 'e1'), pic('a2', 4, 'e2')])
    const p = composeMaterialPrompt(
      { prompt: 'x', refAssetIds: ['a2' as ID, 'a1' as ID], actAs: 'reference' },
      ctx4
    )
    expect(p.indexOf('Lin Lan')).toBeLessThan(p.indexOf('Chen Mo'))
  })

  it('素材被删掉了：引用行自动消失，不报错', () => {
    const p = composeMaterialPrompt(
      { prompt: 'x', refAssetIds: ['gone' as ID], actAs: 'reference' },
      ctx
    )
    expect(p).toBe('x')
  })
})

describe('promptBodyOf', () => {
  it('只取正文，不含引用段', () => {
    const full = composeMaterialPrompt(
      { prompt: 'A room', refAssetIds: ['a1' as ID], actAs: 'reference' },
      ctx
    )
    expect(promptBodyOf({ prompt: full })).toBe('A room')
  })
})
