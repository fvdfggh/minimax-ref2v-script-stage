import { describe, expect, it } from 'vitest'
import { chunkBy, splitParagraphs, splitStory } from './chunk'

describe('分批：原文切分', () => {
  it('按空行切自然段，忽略多余空白', () => {
    const story = '第一段。\n\n第二段。\n\n\n第三段。\n'
    expect(splitParagraphs(story)).toEqual(['第一段。', '第二段。', '第三段。'])
  })

  it('兼容 CRLF', () => {
    expect(splitParagraphs('甲\r\n\r\n乙')).toEqual(['甲', '乙'])
  })

  it('空原文返回空数组', () => {
    expect(splitParagraphs('   \n\n  ')).toEqual([])
    expect(splitStory('', 1000)).toEqual([])
  })

  it('超长段落按句末标点再切，且不丢标点', () => {
    const sentence = '这是一个足够长的句子用来把段落的长度撑起来。'
    const long = sentence.repeat(60)
    const parts = splitParagraphs(long)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(600)
    // 每个片段都以句末标点收尾，说明没有从句子中间劈开
    for (const p of parts) expect(p.endsWith('。')).toBe(true)
    expect(parts.join('')).toBe(long)
  })
})

describe('分批：按长度聚合', () => {
  // 每段约 40 字，12 段约 500 字 —— 用 200 字粒度切会得到多批
  const PARA = '楚辞站在洞窟口，火光在他脸上跳动，映出一道陈年旧伤。'
  const story = Array.from({ length: 12 }, (_, i) => `第${i + 1}段：${PARA}`).join('\n\n')

  it('短于阈值时只有一批', () => {
    const chunks = splitStory(story, 100000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].paraFrom).toBe(1)
    expect(chunks[0].paraTo).toBe(12)
    expect(chunks[0].paragraphs).toBe(12)
  })

  it('★ 切分不丢内容：各批拼回来等于原文', () => {
    const chunks = splitStory(story, 200)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((c) => c.text).join('\n\n')).toBe(story)
  })

  it('★ 段落编号连续且完整覆盖，不重不漏', () => {
    const chunks = splitStory(story, 200)
    expect(chunks[0].paraFrom).toBe(1)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].paraFrom).toBe(chunks[i - 1].paraTo + 1)
    }
    expect(chunks[chunks.length - 1].paraTo).toBe(12)
    // 段落总数守恒
    const sum = chunks.reduce((s, c) => s + c.paragraphs, 0)
    expect(sum).toBe(12)
  })

  it('批序号从 0 连续递增', () => {
    const chunks = splitStory(story, 200)
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i))
  })

  it('每批长度接近阈值，但不会为了凑数把段落切开', () => {
    const chunks = splitStory(story, 200)
    // 除最后一批外，每批都达到了阈值（或只剩一个段落）
    for (const c of chunks.slice(0, -1)) {
      expect(c.text.length).toBeGreaterThanOrEqual(200)
    }
    // 单个段落绝不会被拆到两批里
    const allParagraphs = chunks.flatMap((c) => c.text.split('\n\n'))
    expect(allParagraphs).toEqual(splitParagraphs(story))
  })

  it('单段超长时自己单独成批', () => {
    const longPara = '很长的一段。'.repeat(200)
    const chunks = splitStory(`短段。\n\n${longPara}\n\n另一段。`, 300)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // 短段不会被硬塞进超长段所在的批
    const first = chunks[0]
    expect(first.text).toBe('短段。')
  })

  it('阈值有下限保护，避免切得过碎', () => {
    const chunks = splitStory(story, 1)
    expect(chunks.length).toBeGreaterThan(0)
    for (const c of chunks) expect(c.paragraphs).toBeGreaterThan(0)
  })
})

describe('分批：列表切分', () => {
  it('按固定大小切，尾部不足一批也保留', () => {
    expect(chunkBy([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('不足一批时原样返回', () => {
    expect(chunkBy([1, 2], 10)).toEqual([[1, 2]])
  })

  it('空列表返回空数组，不会返回 [[]]', () => {
    expect(chunkBy([], 5)).toEqual([])
  })

  it('★ 列表切分不丢元素、不改顺序', () => {
    const list = Array.from({ length: 37 }, (_, i) => i)
    const batches = chunkBy(list, 8)
    expect(batches.flat()).toEqual(list)
    expect(batches.map((b) => b.length)).toEqual([8, 8, 8, 8, 5])
  })

  it('非法批大小会被收敛到 1', () => {
    expect(chunkBy([1, 2, 3], 0)).toEqual([[1], [2], [3]])
    expect(chunkBy([1, 2, 3], -5)).toEqual([[1], [2], [3]])
  })
})
