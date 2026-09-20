import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './types'
import type { Beat, ProjectSettings } from './types'
import { newBeat } from './beats'
import { beatFrames } from './timing'
import {
  FRAME_STEP,
  NON_REF_OFFSET,
  alignedOptions,
  buildPad,
  defaultRefPrev,
  distributePad,
  fitSegmentFrames,
  isAligned,
  isNonRefAligned,
  isRefAligned,
  maxAlignedFrames,
  minFramesOf,
  padTotalOf,
  paddedBeatFrames,
  resolveRefPrev,
  snapNearest,
  snapUp,
  sumPaddedFrames
} from './frames'

const S: ProjectSettings = { ...DEFAULT_SETTINGS }

function beat(patch: Partial<Beat> & { title: string; kind: Beat['kind'] }): Beat {
  return newBeat('p', { sceneId: 'e_cave', ...patch })
}

describe('帧长度家族', () => {
  it('141 = 5 + 17×8，136 = 17×8 —— 正好卡住原来的上限', () => {
    expect(NON_REF_OFFSET + FRAME_STEP * 8).toBe(141)
    expect(FRAME_STEP * 8).toBe(136)
  })

  it('引用上段：17k', () => {
    for (const f of [17, 34, 51, 68, 85, 102, 119, 136]) expect(isRefAligned(f)).toBe(true)
    for (const f of [5, 16, 18, 140, 141, 0]) expect(isRefAligned(f)).toBe(false)
  })

  it('不引用上段：5 + 17k', () => {
    for (const f of [5, 22, 39, 56, 73, 90, 107, 124, 141]) expect(isNonRefAligned(f)).toBe(true)
    for (const f of [17, 21, 23, 136, 140, 0]) expect(isNonRefAligned(f)).toBe(false)
  })

  it('isAligned 按模式分派', () => {
    expect(isAligned(136, true)).toBe(true)
    expect(isAligned(136, false)).toBe(false)
    expect(isAligned(141, false)).toBe(true)
    expect(isAligned(141, true)).toBe(false)
  })

  it('各模式的上限：不引用 141，引用 136', () => {
    expect(maxAlignedFrames(false, 141)).toBe(141)
    expect(maxAlignedFrames(true, 141)).toBe(136)
  })

  it('alignedOptions 列出合法值', () => {
    expect(alignedOptions(false, 141)).toEqual([5, 22, 39, 56, 73, 90, 107, 124, 141])
    expect(alignedOptions(true, 141)).toEqual([17, 34, 51, 68, 85, 102, 119, 136])
  })
})

describe('最近取整', () => {
  it('离哪边近就取哪边', () => {
    // 引用家族 119 / 136
    expect(snapNearest(120, true)).toBe(119)
    expect(snapNearest(130, true)).toBe(136)
    expect(snapNearest(136, true)).toBe(136)
    // 不引用家族 107 / 124
    expect(snapNearest(110, false)).toBe(107)
    expect(snapNearest(120, false)).toBe(124)
    expect(snapNearest(141, false)).toBe(141)
  })

  it('距离相同时向上取，避免把内容压得太紧', () => {
    // 引用家族 119 / 136，中点 127.5 -> 128 更近 136
    expect(snapNearest(127, true)).toBe(119)
    expect(snapNearest(128, true)).toBe(136)
  })

  it('snapUp 仍然是不小于 raw 的语义', () => {
    expect(snapUp(120, true)).toBe(136)
    expect(snapUp(120, false)).toBe(124)
    expect(snapUp(136, true)).toBe(136)
  })

  it('下限优先：不会压到下限以下', () => {
    // 台词需要 120 帧，最近的合法值是 107，低于下限 -> 抬到 124
    expect(snapNearest(110, false, 120)).toBe(124)
    expect(snapNearest(110, true, 120)).toBe(136)
  })
})

describe('帧长度补正', () => {
  it('补正方向随最近的合法值走', () => {
    expect(fitSegmentFrames(133, true, 141).target).toBe(136)
    expect(fitSegmentFrames(133, true, 141).padTotal).toBe(3)
    expect(fitSegmentFrames(133, true, 141).compressing).toBe(false)

    expect(fitSegmentFrames(126, true, 141).target).toBe(119)
    expect(fitSegmentFrames(126, true, 141).padTotal).toBe(-7)
    expect(fitSegmentFrames(126, true, 141).compressing).toBe(true)
  })

  it('已经对齐时不需要副帧', () => {
    expect(fitSegmentFrames(136, true, 141).padTotal).toBe(0)
    expect(fitSegmentFrames(141, false, 141).padTotal).toBe(0)
    expect(fitSegmentFrames(124, false, 141).padTotal).toBe(0)
  })

  it('超出该模式上限时标记 overLimit', () => {
    // 引用上段：145 距离 153 更近 -> 153 > 136 上限
    const fit = fitSegmentFrames(145, true, 141)
    expect(fit.target).toBe(153)
    expect(fit.overLimit).toBe(true)
    expect(fit.cap).toBe(136)
  })

  it('刚好压得下就不算超限', () => {
    // 137 距离 136 只有 1 帧 -> 压缩即可
    const fit = fitSegmentFrames(137, true, 141)
    expect(fit.target).toBe(136)
    expect(fit.overLimit).toBe(false)
    expect(fit.padTotal).toBe(-1)
  })
})

describe('副帧分摊', () => {
  const beats = [
    beat({ title: 'a', kind: 'action', estFrames: 36, manualFrames: true, order: 0 }),
    beat({ title: 'b', kind: 'action', estFrames: 24, manualFrames: true, order: 1 }),
    beat({ title: 'c', kind: 'action', estFrames: 12, manualFrames: true, order: 2 })
  ]

  it('追加：按占比分摊，合计严格等于总量', () => {
    const pad = distributePad(beats, 10, S)
    expect(padTotalOf(pad)).toBe(10)
    expect(pad[beats[0].id]).toBeGreaterThanOrEqual(pad[beats[1].id])
    expect(pad[beats[1].id]).toBeGreaterThanOrEqual(pad[beats[2].id])
  })

  it('追加：余数逐个 +1，不会丢帧', () => {
    for (const total of [1, 2, 3, 7, 13, 40]) {
      expect(padTotalOf(distributePad(beats, total, S))).toBe(total)
    }
  })

  it('压缩：按占比削减，合计严格等于总量', () => {
    const pad = distributePad(beats, -10, S)
    expect(padTotalOf(pad)).toBe(-10)
    expect(pad[beats[0].id]).toBeLessThan(0)
    expect(pad[beats[1].id]).toBeLessThan(0)
    expect(pad[beats[2].id]).toBeLessThan(0)
  })

  it('压缩：单个片段不会被压到 1 帧以下', () => {
    // 总量 72，最多压到 3 帧（每段留 1 帧）
    const pad = distributePad(beats, -200, S)
    expect(padTotalOf(pad)).toBe(-69)
    for (const b of beats) {
      expect(beatFrames(b, S) + pad[b.id]).toBeGreaterThanOrEqual(1)
    }
  })

  it('压缩：台词不能短于它自己的台词时长', () => {
    const all = [
      beat({ title: '空镜', kind: 'establishing', estFrames: 24, manualFrames: true, order: 0 }),
      beat({
        title: '台词',
        kind: 'dialogue',
        dialogue: '我不信这世上没有解药。',
        speakerId: 'e_chuci',
        entities: ['e_chuci'],
        order: 1
      }),
      beat({ title: '动作', kind: 'action', estFrames: 36, manualFrames: true, order: 2 })
    ]
    const pad = distributePad(all, -10, S)
    expect(padTotalOf(pad)).toBe(-10)
    // 台词帧数 = 48，minFrames = 48 -> 容量 0，一点都压不了
    expect(pad[all[1].id]).toBe(0)
    expect(pad[all[0].id]).toBeLessThan(0)
    expect(pad[all[2].id]).toBeLessThan(0)
  })

  it('压缩容量不足时合计小于请求量（由调用方检出）', () => {
    const only = [
      beat({
        title: '台词',
        kind: 'dialogue',
        dialogue: '短。',
        speakerId: 'e_chuci',
        entities: ['e_chuci'],
        order: 0
      })
    ]
    expect(minFramesOf(only[0], S)).toBe(beatFrames(only[0], S))
    expect(padTotalOf(distributePad(only, -5, S))).toBe(0)
  })

  it('自动生成的拼接片段同样参与分摊', () => {
    const all = [
      beat({ title: '预备', kind: 'preshoot', estFrames: 7, manualFrames: true, order: 0 }),
      beat({ title: 'a', kind: 'action', estFrames: 36, manualFrames: true, order: 1 }),
      beat({ title: '尾切', kind: 'tail_cut', estFrames: 7, manualFrames: true, order: 2 })
    ]
    const pad = distributePad(all, 10, S)
    expect(padTotalOf(pad)).toBe(10)
    expect(pad[all[0].id]).toBeGreaterThan(0)
    expect(pad[all[2].id]).toBeGreaterThan(0)
  })

  it('补正后总帧数正好落在目标上', () => {
    const raw = beats.reduce((s, b) => s + beatFrames(b, S), 0)
    const fit = fitSegmentFrames(raw, false, 141)
    const pad = distributePad(beats, fit.padTotal, S)
    expect(sumPaddedFrames(beats, S, pad)).toBe(fit.target)
    expect(isAligned(sumPaddedFrames(beats, S, pad), false)).toBe(true)
  })

  it('副帧独立于片段自身帧长度', () => {
    const pad = distributePad(beats, 10, S)
    expect(beats.map((b) => beatFrames(b, S))).toEqual([36, 24, 12])
    expect(paddedBeatFrames(beats[0], S, pad)).toBe(36 + pad[beats[0].id])
    expect(paddedBeatFrames(beats[0], S, null)).toBe(36)
  })

  it('每个片段都在表里有值，便于 UI 直接编辑', () => {
    const pad = distributePad(beats, 5, S)
    for (const b of beats) expect(typeof pad[b.id]).toBe('number')
  })

  it('没有片段或总量为 0 都是安全的', () => {
    expect(distributePad([], 10, S)).toEqual({})
    expect(padTotalOf(distributePad(beats, 0, S))).toBe(0)
    expect(padTotalOf(null)).toBe(0)
    expect(padTotalOf(undefined)).toBe(0)
  })
})

describe('buildPad：手工覆盖 + 差额补偿', () => {
  const all = [
    beat({ title: '预', kind: 'preshoot', estFrames: 7, manualFrames: true, order: 0 }),
    beat({ title: 'a', kind: 'action', estFrames: 36, manualFrames: true, order: 1 }),
    beat({ title: 'b', kind: 'action', estFrames: 24, manualFrames: true, order: 2 })
  ]

  it('没有覆盖时等价于纯自动分摊', () => {
    const pad = buildPad({ all, padTotal: 10, settings: S })
    expect(padTotalOf(pad)).toBe(10)
  })

  it('手工覆盖会被保留，差额被其他片段吸收', () => {
    const base = buildPad({ all, padTotal: 10, settings: S })
    const overrides = { [all[1].id]: 1 }
    const pad = buildPad({ all, overrides, padTotal: 10, settings: S })
    expect(pad[all[1].id]).toBe(1)
    expect(padTotalOf(pad)).toBe(10)
    expect(base[all[1].id]).not.toBe(1)
  })

  it('覆盖值在压缩方向同样成立', () => {
    const overrides = { [all[1].id]: -2 }
    const pad = buildPad({ all, overrides, padTotal: -6, settings: S })
    expect(pad[all[1].id]).toBe(-2)
    expect(padTotalOf(pad)).toBe(-6)
  })

  it('覆盖了不存在的片段 id 会被忽略', () => {
    const pad = buildPad({ all, overrides: { ghost: 99 }, padTotal: 10, settings: S })
    expect(pad.ghost).toBeUndefined()
    expect(padTotalOf(pad)).toBe(10)
  })
})

describe('引用上段默认值', () => {
  it('第一个默认不引用，其余默认引用', () => {
    expect(defaultRefPrev(0)).toBe(false)
    expect(defaultRefPrev(1)).toBe(true)
    expect(defaultRefPrev(5)).toBe(true)
  })

  it('显式设置优先于默认', () => {
    expect(resolveRefPrev({}, 0)).toBe(false)
    expect(resolveRefPrev({}, 3)).toBe(true)
    expect(resolveRefPrev({ refPrev: true }, 0)).toBe(true)
    expect(resolveRefPrev({ refPrev: false }, 3)).toBe(false)
  })
})
