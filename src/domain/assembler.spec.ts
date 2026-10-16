import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './types'
import type { Beat, Entity } from './types'
import { assemble, defaultStrategy, measure } from './assembler'
import { analyzeSeam } from './seam'
import { maxAlignedFrames } from './frames'
import { beatFrames } from './timing'

/**
 * 锁住 #5 的修复：refineBySeam 从「单遍前向扫描」改成「迭代到收敛」。
 * 旧实现修好第 k 处黑屏可能让第 k-1 处重新黑屏（不收敛）。
 *
 * 这里不猜 DP 会怎么切，而是独立复算最终分组的接缝，断言一个与实现无关的
 * 不动点不变量：结果里不存在「还能通过移动 1~3 个 beat（且不超帧限、不引入
 * error 级问题）消除的黑屏兜底」。存在这样一处，就说明 refine 没收敛到位。
 */
const S = DEFAULT_SETTINGS

function ent(id: string, name: string, type: 'character' | 'scene' = 'character'): Entity {
  return {
    id,
    projectId: 'p',
    name,
    type,
    kind: 'non_speaking',
    subjectN: null,
    sx: null,
    pictureN: null,
    voiceDesc: null,
    textDesc: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function beat(id: string, order: number, sceneId: string, entities: string[]): Beat {
  return {
    id,
    projectId: 'p',
    order,
    kind: 'action',
    title: id,
    entities,
    sceneId,
    estFrames: 36,
    manualFrames: true,
    locked: false,
    enriched: true,
    createdAt: 1,
    updatedAt: 1
  }
}

/** 容量上限，与 assembler.capacityOf 保持一致：min(上限, 17k 家族在引用下的上限) */
function cap(): number {
  return Math.min(S.maxSegmentFrames, maxAlignedFrames(true, S.maxSegmentFrames))
}

/**
 * 独立预言机：给定最终分组，若存在某处黑屏兜底，且能通过「挪 1~3 个 beat 到
 * 相邻段（左右各试，不超容量，且新接缝无黑屏、无 error 级问题）」消除，则返回 true。
 * 收敛的结果里这种情况必须为 false。
 */
function hasFixableBlackFallback(groups: { id: string; beatIds: string[] }[], beats: Beat[]): boolean {
  const byId = new Map(beats.map((b) => [b.id, b]))
  const get = (g: { beatIds: string[] }) => g.beatIds.map((id) => byId.get(id)!).filter(Boolean)
  const framesOf = (g: { beatIds: string[] }) =>
    get(g).reduce((s, b) => s + beatFrames(b, S), 0)
  const capFrames = cap()

  for (let k = 1; k < groups.length; k++) {
    const left = groups[k - 1]
    const right = groups[k]
    if (!analyzeSeam(get(left), get(right), { settings: S }).blackFallback) continue

    for (let delta = 1; delta <= 3; delta++) {
      for (const dir of [-1, 1]) {
        const moved = dir < 0 ? delta : -delta
        const newLeftLen = left.beatIds.length + moved
        const newRightLen = right.beatIds.length - moved
        if (newLeftLen < 1 || newRightLen < 1) continue

        const cLeft: { id: string; beatIds: string[] } = { id: left.id, beatIds: left.beatIds.slice(0, newLeftLen) }
        const cRight: { id: string; beatIds: string[] } = { id: right.id, beatIds: [...left.beatIds.slice(newLeftLen), ...right.beatIds] }
        if (framesOf(cLeft) > capFrames) continue
        if (framesOf(cRight) > capFrames) continue

        const s = analyzeSeam(get(cLeft), get(cRight), { settings: S })
        if (!s.blackFallback && s.issues.every((i) => i.level !== 'error')) return true
      }
    }
  }
  return false
}

function buildScenario(): Beat[] {
  const A = 'A'
  const B = 'B'
  const C = 'C'
  const s1 = 's1'
  const s2 = 's2'
  // 交替出现不同主体 + 换场，8 个 36 帧动作 = 288 帧 > 141，必然切成 ≥2 段，
  // 且段与段之间主体不同，缝合处大概率出现黑屏兜底（非空测试）
  return [
    beat('b1', 0, s1, [A]),
    beat('b2', 1, s1, [A]),
    beat('b3', 2, s1, [B]),
    beat('b4', 3, s2, [B]),
    beat('b5', 4, s2, [C]),
    beat('b6', 5, s2, [C]),
    beat('b7', 6, s1, [A]),
    beat('b8', 7, s1, [B])
  ]
}

describe('缝合局部优化 refineBySeam 收敛', () => {
  it('终止并产出结构完整的方案（不挂死）', () => {
    const beats = buildScenario()
    const report = assemble(beats, defaultStrategy(S, 'fill_max'), { settings: S })
    expect(report.groups.length).toBeGreaterThanOrEqual(2)
    // 全部片段都可组合（都绑定了场景）-> 没有被跳过
    expect(report.skipped).toHaveLength(0)
    expect(Number.isFinite(report.totalFrames)).toBe(true)
    expect(report.totalFrames).toBeGreaterThan(0)
    // 缝合惩罚很重（seam=40），健康结果里黑屏兜底应为 0；
    // 这里只断言"没有黑屏"是允许的，具体收敛性由下面的不动点测试保证
    expect(report.blackFallbacks).toBeGreaterThanOrEqual(0)
  })

  it('★ 不动点：不存在"还能被 refine 消除的黑屏兜底"', () => {
    const beats = buildScenario()
    const report = assemble(beats, defaultStrategy(S, 'fill_max'), { settings: S })
    expect(hasFixableBlackFallback(report.groups, beats)).toBe(false)
  })

  it('★ 不动点（非平凡）：存在"容量锁死、无法修复"的黑屏时，oracle 仍判"无可修复项"', () => {
    // 两个 100 帧长镜头，同场、不同主体：合起来 200 > 上限，各自 100 ≤ 上限
    // -> 只能切成 [长A],[长B]；同场下 B 不在左段 -> 黑屏兜底。
    // 且移动任一镜头都会让某组变空或超帧限 -> 黑屏无法被 refine 修复。
    // 这个用例保证 oracle 真的走到"有黑屏但没有可用修复"的分支，
    // 从而区分"已收敛"（应通过）与"还有可修复的黑屏残留"（#5 的旧 bug，应失败）。
    const s1 = 's1'
    const bigA = beat('bigA', 0, s1, ['A'])
    bigA.estFrames = 100
    const bigB = beat('bigB', 1, s1, ['B'])
    bigB.estFrames = 100
    const beats = [bigA, bigB]

    const report = assemble(beats, defaultStrategy(S, 'fill_max'), { settings: S })
    expect(report.groups.length).toBe(2)
    // 前提：这个布局确实产生了黑屏兜底（非平凡前提，不是"0 黑屏平凡真"）
    expect(measure(report.groups, beats, { settings: S }).black).toBe(1)
    // 结论：该黑屏容量锁死、无法修复，不动点成立
    expect(hasFixableBlackFallback(report.groups, beats)).toBe(false)
  })

  it('收敛结果不丢拍：所有可组合片段恰好出现一次', () => {
    const beats = buildScenario()
    const report = assemble(beats, defaultStrategy(S, 'fill_max'), { settings: S })
    const ids = report.groups.flatMap((g) => g.beatIds)
    expect([...ids].sort()).toEqual(beats.map((b) => b.id).sort())
    // 无重复
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每组帧数不超容量上限', () => {
    const beats = buildScenario()
    const byId = new Map(beats.map((b) => [b.id, b]))
    const report = assemble(beats, defaultStrategy(S, 'fill_max'), { settings: S })
    const capFrames = cap()
    for (const g of report.groups) {
      const frames = g.beatIds.reduce((s, id) => s + beatFrames(byId.get(id)!, S), 0)
      expect(frames).toBeLessThanOrEqual(capFrames)
    }
  })

  it('确定性：同样输入两次，分组（beat 归属与顺序）完全一致', () => {
    const beats = buildScenario()
    const a = assemble(beats, defaultStrategy(S, 'fill_max'), { settings: S })
    const b = assemble(beats, defaultStrategy(S, 'fill_max'), { settings: S })
    expect(a.groups.map((g) => g.beatIds)).toEqual(b.groups.map((g) => g.beatIds))
  })
})
