import { describe, expect, it } from 'vitest'
import {
  applyRunSelection,
  chainLabel,
  chainOfIndex,
  expandChainSelection,
  expandPicksFor,
  normalizeIndices,
  parseExportResult,
  patchPromptInputs,
  patchPromptTimeline,
  pickSpanFor,
  pickedChainCount,
  segmentChains,
  selectionSummary,
  splitExportedPath,
  timelineSegmentCount
} from './segmentOps'

const tl = (n: number) => ({
  segments: Array.from({ length: n }, (_, i) => ({ id: `seg${i + 1}` }))
})

describe('timelineSegmentCount', () => {
  it('数 segments，脏数据当 0', () => {
    expect(timelineSegmentCount(tl(4))).toBe(4)
    expect(timelineSegmentCount({ segments: 'x' } as never)).toBe(0)
    expect(timelineSegmentCount(null)).toBe(0)
  })
})

describe('normalizeIndices', () => {
  it('去重、排序、丢越界与非整数', () => {
    expect(normalizeIndices([3, 1, 3, -1, 9, 1.5, '2'], 4)).toEqual([1, 2, 3])
  })
  it('count 为 0 时不按上限过滤（段表未知）', () => {
    expect(normalizeIndices([0, 5], 0)).toEqual([0, 5])
  })
  it('非数组当空', () => {
    expect(normalizeIndices(undefined, 4)).toEqual([])
  })
})

describe('applyRunSelection', () => {
  it('部分勾选 → 打开开关并写入排好序的索引', () => {
    const out = applyRunSelection(tl(4), [3, 1])
    expect(out.runSelectEnabled).toBe(true)
    expect(out.runSelection).toEqual([1, 3])
  })

  it('勾满 → 关掉开关（等价全跑，别把"全选"存成快照）', () => {
    const out = applyRunSelection(tl(3), [0, 1, 2])
    expect(out.runSelectEnabled).toBe(false)
    expect(out.runSelection).toEqual([])
  })

  it('一个没勾 → 关掉开关', () => {
    const out = applyRunSelection(tl(3), [])
    expect(out.runSelectEnabled).toBe(false)
  })

  it('清掉上一次留下的勾选（全跑不该继承历史选择）', () => {
    const prev = { ...tl(4), runSelectEnabled: true, runSelection: [1] }
    const out = applyRunSelection(prev, [])
    expect(out.runSelectEnabled).toBe(false)
  })

  it('不原地改传进来的时间线（history 那份是历史，不能动）', () => {
    const src = tl(4)
    const out = applyRunSelection(src, [2])
    expect(src).not.toHaveProperty('runSelectEnabled')
    expect(out).not.toBe(src)
  })

  it('越界的勾选被丢掉；丢光等于全跑', () => {
    const out = applyRunSelection(tl(2), [7])
    expect(out.runSelectEnabled).toBe(false)
  })
})

describe('patchPromptTimeline（沿用上次配方重跑）', () => {
  const prompt = () => ({
    '3': { class_type: 'KSampler', inputs: { seed: 1 } },
    '39': {
      class_type: 'ComfyMiniMaxH3DirectorOpt',
      inputs: { seed: 7, timeline_data: JSON.stringify(tl(4)) }
    }
  })

  it('把选择写进那份 prompt 的时间线', () => {
    const out = patchPromptTimeline(prompt(), '39', [2])
    const tlOut = JSON.parse(String((out['39'] as { inputs: Record<string, unknown> }).inputs.timeline_data))
    expect(tlOut.runSelectEnabled).toBe(true)
    expect(tlOut.runSelection).toEqual([2])
    expect(tlOut.segments).toHaveLength(4)
  })

  it('其余参数原样保留（模型/种子/步数不能在重跑时被改掉）', () => {
    const out = patchPromptTimeline(prompt(), '39', [0])
    const inputs = (out['39'] as { inputs: Record<string, unknown> }).inputs
    expect(inputs.seed).toBe(7)
    expect((out['3'] as { inputs: Record<string, unknown> }).inputs.seed).toBe(1)
  })

  it('不改原对象（history 那份是历史）', () => {
    const src = prompt()
    const before = (src['39'] as { inputs: Record<string, unknown> }).inputs.timeline_data
    patchPromptTimeline(src, '39', [1])
    expect((src['39'] as { inputs: Record<string, unknown> }).inputs.timeline_data).toBe(before)
  })

  it('节点不在 / 没有时间线 / 时间线是坏 JSON 都抛错，不猜默认值', () => {
    expect(() => patchPromptTimeline(prompt(), '99', [0])).toThrow('没有导演节点')
    const noTl = { '39': { inputs: {} } }
    expect(() => patchPromptTimeline(noTl, '39', [0])).toThrow('没有时间线')
    const bad = { '39': { inputs: { timeline_data: '{oops' } } }
    expect(() => patchPromptTimeline(bad, '39', [0])).toThrow('不是合法 JSON')
  })
})

describe('patchPromptInputs', () => {
  it('只改指定节点的指定键，其余原样', () => {
    const src = {
      '3': { inputs: { seed: 1, second_only: false } },
      '39': { inputs: { second_only: true, steps: 25 } }
    }
    const out = patchPromptInputs(src, '39', { second_only: false })
    expect((out['39'] as { inputs: Record<string, unknown> }).inputs.second_only).toBe(false)
    expect((out['39'] as { inputs: Record<string, unknown> }).inputs.steps).toBe(25)
    expect((out['3'] as { inputs: Record<string, unknown> }).inputs.second_only).toBe(false)
    expect(src['39'].inputs.second_only).toBe(true) // 原对象没动
  })

  it('节点不在就抛', () => {
    expect(() => patchPromptInputs({ '3': { inputs: {} } }, '39', { a: 1 })).toThrow('没有导演节点')
  })
})

describe('selectionSummary', () => {  it('全跑 / 部分 / 无段', () => {
    expect(selectionSummary(4, [])).toBe('全部 4 段')
    expect(selectionSummary(4, [0, 1])).toBe('选中 2/4 段')
    expect(selectionSummary(0, [])).toBe('无段')
  })
})

describe('splitExportedPath', () => {
  it('Windows 绝对路径 → filename + subfolder', () => {
    expect(
      splitExportedPath(
        'C:\\ComfyUI\\output\\minimax_segment_export\\39\\segment_export_seg_01_ab12.mp4'
      )
    ).toEqual({ filename: 'segment_export_seg_01_ab12.mp4', subfolder: 'minimax_segment_export/39' })
  })

  it('二采导出目录（second_pass 多一层）', () => {
    expect(
      splitExportedPath('/opt/ComfyUI/output/minimax_segment_export/second_pass/39/seg_AA-BB_1.mp4')
    ).toEqual({ filename: 'seg_AA-BB_1.mp4', subfolder: 'minimax_segment_export/second_pass/39' })
  })

  it('没有 output 前缀（自定义输出目录）→ null，别拼一个必然 404 的链接', () => {
    expect(splitExportedPath('D:\\exports\\39\\x.mp4')).toBeNull()
  })

  it('只到 output 根、没有子目录 → null', () => {
    expect(splitExportedPath('/ComfyUI/output/x.mp4')).toBeNull()
  })
})

describe('parseExportResult', () => {
  it('files / skipped / export_dir 全部映射出来', () => {
    const r = parseExportResult({
      files: ['C:\\ComfyUI\\output\\minimax_segment_export\\39\\a.mp4'],
      skipped: [{ index: 2, reason: 'no exportable cache' }],
      export_dir: 'C:\\ComfyUI\\output\\minimax_segment_export\\39',
      mode: 'piecewise',
      source: '1st'
    })
    expect(r.files).toHaveLength(1)
    expect(r.files[0].filename).toBe('a.mp4')
    expect(r.files[0].subfolder).toBe('minimax_segment_export/39')
    expect(r.files[0].path).toContain('a.mp4')
    expect(r.skipped).toEqual([{ index: 2, reason: 'no exportable cache' }])
    expect(r.exportDir).toContain('minimax_segment_export')
  })

  it('节点用 error 字段报错 → 抛异常（不能当"导出了 0 个"混过去）', () => {
    expect(() => parseExportResult({ error: 'No segment indices selected.' })).toThrow(
      'No segment indices selected.'
    )
  })

  it('空响应不炸', () => {
    const r = parseExportResult(null)
    expect(r.files).toEqual([])
    expect(r.skipped).toEqual([])
    expect(r.exportDir).toBe('')
  })

  it('skipped 缺字段时有兜底', () => {
    const r = parseExportResult({ skipped: [{}] })
    expect(r.skipped[0].reason).toBe('未知原因')
    expect(r.skipped[0].index).toBe(-1)
  })
})

describe('segmentChains（引用上段 = 同一条链）', () => {
  it('全都不引用 ⇒ 每段自己一条链', () => {
    expect(segmentChains([false, false, false])).toEqual([[0], [1], [2]])
  })

  it('连续引用 ⇒ 合成一条链', () => {
    // seg01 起链，seg02/seg03 引用上段
    expect(segmentChains([false, true, true])).toEqual([[0, 1, 2]])
  })

  it('中间断开 ⇒ 断点起新链', () => {
    expect(segmentChains([false, true, false, true])).toEqual([
      [0, 1],
      [2, 3]
    ])
  })

  it('第 0 段的 linked 标记被忽略（没有"上一段"可引用）', () => {
    expect(segmentChains([true, false])).toEqual([[0], [1]])
  })

  it('空表不炸', () => {
    expect(segmentChains([])).toEqual([])
  })
})

describe('chainOfIndex', () => {
  const linked = [false, true, true, false, true]

  it('取整条链，不只是当前这一段', () => {
    expect(chainOfIndex(linked, 2)).toEqual([0, 1, 2])
    expect(chainOfIndex(linked, 3)).toEqual([3, 4])
  })

  it('越界只返回自己', () => {
    expect(chainOfIndex(linked, 9)).toEqual([9])
    expect(chainOfIndex(linked, -1)).toEqual([])
  })
})

describe('expandChainSelection', () => {
  const linked = [false, true, true, false, true]

  it('勾一段 ⇒ 补齐全链', () => {
    expect(expandChainSelection([1], linked)).toEqual([0, 1, 2])
  })

  it('勾末段 ⇒ 上游一起进来', () => {
    expect(expandChainSelection([4], linked)).toEqual([3, 4])
  })

  it('多段 / 重复 / 越界混在一起也能归一', () => {
    expect(expandChainSelection([2, 2, 3, 99], linked)).toEqual([0, 1, 2, 3, 4])
  })

  it('空勾选仍是空（空 ≠ 全选）', () => {
    expect(expandChainSelection([], linked)).toEqual([])
    expect(expandChainSelection(undefined, linked)).toEqual([])
  })

  it('补齐后送进时间线：必须是"整链"而不是半条', () => {
    const picked = expandChainSelection([2], linked)
    const out = applyRunSelection(tl(5), picked)
    expect(out.runSelection).toEqual([0, 1, 2])
    expect(out.runSelectEnabled).toBe(true)
  })
})

describe('pickedChainCount / chainLabel', () => {
  const linked = [false, true, true, false, true]

  it('按链计数（3 段其实是 1 条链）', () => {
    expect(pickedChainCount(linked, [0, 1, 2])).toBe(1)
    expect(pickedChainCount(linked, [0, 1, 2, 4])).toBe(2)
    expect(pickedChainCount(linked, [])).toBe(0)
  })

  it('标签：单段直写，多段给区间', () => {
    expect(chainLabel([1])).toBe('seg02')
    expect(chainLabel([0, 1, 2])).toBe('seg01–seg03')
    expect(chainLabel([])).toBe('')
  })
})

describe('pickSpanFor / expandPicksFor：一采单段，二采整链', () => {
  // 链：seg01–seg03 一条，seg04–seg05 一条
  const linked = [false, true, true, false, true]

  it('一采勾哪段就是哪段，不扩链', () => {
    expect(pickSpanFor('first', linked, 2)).toEqual([2])
    expect(expandPicksFor('first', [2], linked, 5)).toEqual([2])
  })

  it('二采按整条链补齐', () => {
    expect(pickSpanFor('second', linked, 2)).toEqual([0, 1, 2])
    expect(expandPicksFor('second', [2], linked, 5)).toEqual([0, 1, 2])
  })

  it('一采多选就是这几段，不去凑链', () => {
    expect(expandPicksFor('first', [1, 4], linked, 5)).toEqual([1, 4])
  })

  it('越界槽位一律丢掉（段被拆并过之后）', () => {
    expect(expandPicksFor('first', [1, 9], linked, 5)).toEqual([1])
    expect(expandPicksFor('second', [9], linked, 5)).toEqual([])
  })

  it('空选择仍是空，不会因为二采变成整链', () => {
    expect(expandPicksFor('second', [], linked, 5)).toEqual([])
  })
})
