/**
 * AI 排关键帧的解析层。
 *
 * 这里守两件事：
 *   1. 模型返回的东西**一律当建议**：越界夹回段内、重复帧只留一条、超量砍掉。
 *      宁可少一张，也不要因为模型多写一条就凭空多跑一次采样。
 *   2. 只认「序号」不认 id：模型复述不透明 id 几乎必错。
 */
import { describe, expect, it } from 'vitest'
import { MAX_SHOTS_PER_BEAT, parseKeyframePlan } from './keyframePlan'
import type { ID } from './types'

const BEATS = [
  { id: 'b1' as ID, frames: 24 },
  { id: 'b2' as ID, frames: 36 }
]

describe('parseKeyframePlan', () => {
  it('按片段序号归位，帧号夹到 0..frames-1', () => {
    const rows = parseKeyframePlan(
      {
        shots: [
          { beat: 1, frame: 0, prompt: 'opening frame', reason: '开场' },
          { beat: 2, frame: 999, prompt: 'cut away', reason: '收尾' },
          { beat: 2, frame: -5, prompt: 'too early' }
        ]
      },
      BEATS
    )
    expect(rows.map((r) => r.beatId)).toEqual(['b1', 'b2'])
    expect(rows[0].shots).toEqual([{ frame: 0, prompt: 'opening frame', reason: '开场' }])
    // 越界夹回段内；同一段的两个建议会按帧排好（-5 → 0，999 → 35）
    expect(rows[1].shots.map((s) => s.frame)).toEqual([0, 35])
  })

  it('同帧只留第一条：同帧两张图在导演台里会互相覆盖', () => {
    const rows = parseKeyframePlan(
      {
        shots: [
          { beat: 1, frame: 8, prompt: 'first' },
          { beat: 1, frame: 8, prompt: 'second' }
        ]
      },
      BEATS
    )
    expect(rows[0].shots).toHaveLength(1)
    expect(rows[0].shots[0].prompt).toBe('first')
  })

  it('每段超量就砍到上限（默认 3）', () => {
    const shots = [0, 5, 10, 15, 20].map((f) => ({ beat: 1, frame: f, prompt: `f${f}` }))
    const rows = parseKeyframePlan({ shots }, BEATS)
    expect(rows[0].shots).toHaveLength(MAX_SHOTS_PER_BEAT)
    expect(rows[0].shots.map((s) => s.frame)).toEqual([0, 5, 10])
    // 上限可以覆盖
    expect(parseKeyframePlan({ shots }, BEATS, { maxPerBeat: 2 })[0].shots).toHaveLength(2)
  })

  it('缺帧号按开场处理；没提示词的条目直接丢', () => {
    const rows = parseKeyframePlan(
      {
        shots: [
          { beat: 1, prompt: 'no frame given' },
          { beat: 1, frame: 3, prompt: '   ' },
          { beat: 1, frame: 4, text: 'from text field' }
        ]
      },
      BEATS
    )
    expect(rows[0].shots.map((s) => [s.frame, s.prompt])).toEqual([
      [0, 'no frame given'],
      [4, 'from text field']
    ])
  })

  it('序号越界 / 没有 shots / 裸数组 都不炸', () => {
    expect(parseKeyframePlan({ shots: [{ beat: 9, frame: 1, prompt: 'x' }] }, BEATS)).toEqual([])
    expect(parseKeyframePlan({}, BEATS)).toEqual([])
    expect(parseKeyframePlan(null, BEATS)).toEqual([])
    // 模型有时直接给数组
    expect(parseKeyframePlan([{ beat: 2, frame: 5, prompt: 'p' }], BEATS)[0].beatId).toBe('b2')
  })

  it('没给建议的段不出现，给建议的段按传入顺序返回', () => {
    const rows = parseKeyframePlan(
      { shots: [{ beat: 2, frame: 1, prompt: 'only b2' }] },
      BEATS
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].beatId).toBe('b2')
    expect(rows[0].frames).toBe(36)
  })
})
