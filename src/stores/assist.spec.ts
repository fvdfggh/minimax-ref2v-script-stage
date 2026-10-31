import { describe, expect, it } from 'vitest'
import { cleanSingle, normalizeSplitParts } from './pipeline'

describe('单字段结果的清洗', () => {
  it('去掉模型自带的前缀、引号与代码块围栏', () => {
    expect(cleanSingle('镜头描述：中景，缓推')).toBe('中景，缓推')
    expect(cleanSingle('```\n固定机位\n```')).toBe('固定机位')
    expect(cleanSingle('“他抬手挡住雨”')).toBe('他抬手挡住雨')
    expect(cleanSingle('Shot: medium shot, push in')).toBe('medium shot, push in')
  })

  it('多行压成一行：字段只有一段，换行会带进提示词', () => {
    expect(cleanSingle('她抬头\n\n看向门口')).toBe('她抬头 看向门口')
  })

  it('只去掉成对的引号，句中的引号不动', () => {
    expect(cleanSingle('他喊了一声「走」')).toBe('他喊了一声「走」')
  })

  it('空串仍然空：调用方据此报错，不要静默写空', () => {
    expect(cleanSingle('   ')).toBe('')
  })
})

describe('拆拍结果的归一', () => {
  it('丢掉没有标题的条目，weight 夹在 1~3', () => {
    const parts = normalizeSplitParts([
      { title: '抬头', kind: 'action', weight: 0 },
      { title: '', kind: 'action', weight: 2 },
      { title: '把硬币推回去', kind: 'action', weight: 9 }
    ])
    expect(parts).toHaveLength(2)
    expect(parts[0].weight).toBe(1)
    expect(parts[1].weight).toBe(3)
  })

  it('kind 不在白名单的落回 action（拆分是切现有的拍，不造转场）', () => {
    const parts = normalizeSplitParts([{ title: '切到门外', kind: 'scene_switch', weight: 2 }])
    expect(parts[0].kind).toBe('action')
  })

  it('dialogue 拍必须带台词，否则这条不能落库', () => {
    const parts = normalizeSplitParts([
      { title: '林晚回答', kind: 'dialogue', dialogue: '  ' },
      { title: '林晚回答', kind: 'dialogue', dialogue: '你每次都这么说' }
    ])
    expect(parts).toHaveLength(1)
    expect(parts[0].dialogue).toBe('你每次都这么说')
  })

  it('非台词拍即使带了 dialogue 也清掉：那会让一句台词出现两次', () => {
    const parts = normalizeSplitParts([
      { title: '抬头', kind: 'action', dialogue: '你每次都这么说', weight: 1 }
    ])
    expect(parts[0].dialogue).toBeUndefined()
  })

  it('不是数组时返回空：由调用方提示"没拆出多拍"', () => {
    expect(normalizeSplitParts(undefined)).toEqual([])
    expect(normalizeSplitParts({ beats: [] })).toEqual([])
  })
})
