import { describe, expect, it } from 'vitest'
import { countMentions, pendingSubjects } from './subjectScan'
import type { Entity, EntityType } from './types'

/** 只填用得到的字段，其余按空值兜底 —— 这些测试只关心「谁是候选、排第几」 */
function ent(partial: Partial<Entity> & { id: string; name: string }): Entity {
  const type: EntityType = partial.type ?? 'character'
  return {
    projectId: 'p1',
    order: 0,
    type,
    kind: 'non_speaking',
    subjectN: null,
    pictureN: null,
    textDesc: null,
    voiceDesc: null,
    createdAt: 0,
    updatedAt: 0,
    ...partial
  } as Entity
}

describe('countMentions', () => {
  it('数出现次数，重叠位置也算', () => {
    expect(countMentions('张三走了，张三又回来', '张三')).toBe(2)
    expect(countMentions('aaaa', 'aa')).toBe(2)
  })

  it('名字里的正则元字符按字面处理，不会炸也不会误匹配', () => {
    expect(countMentions('价格是 9.9 元', '9.9')).toBe(1)
    expect(countMentions('a(1) b', 'a(1)')).toBe(1)
    expect(countMentions('x*y', 'x*y')).toBe(1)
  })

  it('空原文 / 空名字返回 0', () => {
    expect(countMentions('', '张三')).toBe(0)
    expect(countMentions('张三', '   ')).toBe(0)
  })
})

describe('pendingSubjects', () => {
  const story = '天台上，陈默把伞收起来。陈默说：灯还亮着。老周在楼下喊陈默。'

  it('原文提到的母版排前面，一次没提的沉后面', () => {
    const list = pendingSubjects({
      locals: [],
      masters: [
        ent({ id: 'm1', name: '老周', textDesc: '中年男人' }),
        ent({ id: 'm2', name: '陈默', textDesc: '年轻人' }),
        ent({ id: 'm3', name: '医院走廊', type: 'scene' })
      ],
      story
    })
    expect(list.map((p) => p.name)).toEqual(['陈默', '老周', '医院走廊'])
    expect(list[0].mentions).toBe(3)
    expect(list[0].source).toBe('master')
    expect(list[0].masterId).toBe('m2')
  })

  it('本集已登记的不再当候选（同名 / 已取用过两道都判）', () => {
    const list = pendingSubjects({
      locals: [
        ent({ id: 'l1', name: '陈默', sourceId: 'm2' }),
        ent({ id: 'l2', name: '老周' })
      ],
      masters: [
        ent({ id: 'm2', name: '陈默' }),
        ent({ id: 'm3', name: '老周' }),
        ent({ id: 'm4', name: '阿九' })
      ],
      story
    })
    expect(list.map((p) => p.name)).toEqual(['阿九'])
  })

  it('模型候选合进来，只在原文出现的标 model，光有名字的标 text', () => {
    const list = pendingSubjects({
      locals: [],
      masters: [],
      story,
      presets: [
        { name: '陈默', type: 'character', kind: 'speaking', voiceDesc: 'young male' },
        { name: '收起的伞' }
      ]
    })
    const chen = list.find((p) => p.name === '陈默')!
    expect(chen.source).toBe('model')
    expect(chen.kind).toBe('speaking')
    expect(chen.voiceDesc).toBe('young male')
    const umbrella = list.find((p) => p.name === '收起的伞')!
    expect(umbrella.source).toBe('text')
    expect(umbrella.type).toBe('character')
  })

  it('母版与本集同名时不重复出现两条', () => {
    const list = pendingSubjects({
      locals: [],
      masters: [ent({ id: 'm1', name: '陈默', pictureN: 3 })],
      story,
      presets: [{ name: '陈默', type: 'character' }]
    })
    expect(list).toHaveLength(1)
    expect(list[0].source).toBe('master')
    expect(list[0].hasPicture).toBe(true)
  })
})
