import { describe, expect, it } from 'vitest'
import {
  bindingFromCandidate,
  bindingFromSubmit,
  bindingOriginText,
  bindingSummary,
  bindingUsable,
  cacheDirLabel,
  candidateLabel,
  collectRemoteCaches,
  normalizeBaseUrl,
  type HistoryLikeEntry
} from './cacheBind'

const DIRECTOR = 'ComfyMiniMaxH3DirectorOpt'

function timeline(segs: number): string {
  return JSON.stringify({
    segments: Array.from({ length: segs }, (_, i) => ({ id: `seg0${i + 1}`, frameCount: 100 }))
  })
}

/** 一份最小可用的 history 条目：导演节点 39 + 给定目录/段数/时间/状态 */
function entry(opts: {
  name?: string
  segs?: number
  status?: string
  at?: number
  outputs?: number
  nodeId?: string
  classType?: string
} = {}): HistoryLikeEntry {
  const nodeId = opts.nodeId ?? '39'
  const api: Record<string, unknown> = {
    [nodeId]: {
      class_type: opts.classType ?? DIRECTOR,
      inputs: {
        workflow_name: opts.name ?? 'ep1',
        timeline_data: timeline(opts.segs ?? 4),
        seed: 1
      }
    },
    '14': { class_type: 'SaveVideo', inputs: {} }
  }
  const outputs: Record<string, unknown> = {}
  for (let i = 0; i < (opts.outputs ?? 1); i++) outputs[`n${i}`] = { text: ['24'] }
  return {
    prompt: [1, 'pid', api, {}, outputs],
    outputs,
    status: {
      status_str: opts.status ?? 'success',
      messages: [['execution_start', { timestamp: opts.at ?? 1000 }]]
    }
  }
}

describe('collectRemoteCaches', () => {
  it('没有导演节点的图直接跳过（比如单独的存图任务）', () => {
    const history: Record<string, HistoryLikeEntry> = {
      a: { prompt: [1, 'a', { '1': { class_type: 'SaveImage', inputs: {} } }, {}, {}] },
      b: entry({ name: 'ep1' })
    }
    const out = collectRemoteCaches(history)
    expect(out).toHaveLength(1)
    expect(out[0].workflowName).toBe('ep1')
  })

  it('同一目录只留一条，且优先成功的那次（它的时间线才对应落盘的缓存）', () => {
    const history: Record<string, HistoryLikeEntry> = {
      ok: entry({ name: 'ep1', segs: 4, status: 'success', at: 1000 }),
      bad: entry({ name: 'ep1', segs: 1, status: 'error', at: 9000 })
    }
    const out = collectRemoteCaches(history)
    expect(out).toHaveLength(1)
    expect(out[0].promptId).toBe('ok')
    expect(out[0].segmentTotal).toBe(4)
    expect(out[0].status).toBe('success')
  })

  it('全是失败时退回最新的一次 —— 失败也可能留下了一采缓存', () => {
    const history: Record<string, HistoryLikeEntry> = {
      old: entry({ name: 'ep2', status: 'error', at: 100 }),
      fresh: entry({ name: 'ep2', status: 'error', at: 500 })
    }
    const out = collectRemoteCaches(history)
    expect(out).toHaveLength(1)
    expect(out[0].promptId).toBe('fresh')
  })

  it('不同目录 / 不同节点都各算一条，成功的排在前面', () => {
    const history: Record<string, HistoryLikeEntry> = {
      a: entry({ name: 'ep1', status: 'error', at: 5000 }),
      b: entry({ name: 'ep2', status: 'success', at: 1000 }),
      c: entry({ name: 'ep2', nodeId: '77', status: 'unknown', at: 2000 })
    }
    const out = collectRemoteCaches(history)
    expect(out.map((c) => `${c.workflowName}@${c.nodeId}`)).toEqual(['ep2@39', 'ep2@77', 'ep1@39'])
  })

  it('宽泛匹配导演节点类型（历史上有两个 class_type）', () => {
    const history: Record<string, HistoryLikeEntry> = {
      a: entry({ name: 'x', classType: 'MiniMaxH3DirectorOpt' })
    }
    expect(collectRemoteCaches(history)).toHaveLength(1)
  })

  it('时间线是对象形态也要认（部分客户端不序列化）', () => {
    const history: Record<string, HistoryLikeEntry> = {
      a: {
        prompt: [
          1,
          'a',
          { '39': { class_type: DIRECTOR, inputs: { workflow_name: 'ep3', timeline_data: { segments: [{}, {}] } } } },
          {},
          {}
        ],
        status: { status_str: 'success' }
      }
    }
    const out = collectRemoteCaches(history)
    expect(out[0].segmentTotal).toBe(2)
    expect(out[0].timeline).toBeTruthy()
  })

  it('时间线坏了 / 缺失时不炸，段数记 0', () => {
    const history: Record<string, HistoryLikeEntry> = {
      a: { prompt: [1, 'a', { '39': { class_type: DIRECTOR, inputs: { timeline_data: '{oops' } } }, {}, {}] },
      b: { prompt: [1, 'b', { '39': { class_type: DIRECTOR, inputs: {} } }, {}, {}] }
    }
    const out = collectRemoteCaches(history)
    expect(out.every((c) => c.segmentTotal === 0)).toBe(true)
  })

  it('空 / 脏数据返回空数组', () => {
    expect(collectRemoteCaches(null)).toEqual([])
    expect(collectRemoteCaches(undefined)).toEqual([])
    expect(collectRemoteCaches({} as Record<string, HistoryLikeEntry>)).toEqual([])
  })
})

describe('绑定对象', () => {
  const cand = {
    promptId: 'p1',
    nodeId: '39',
    workflowName: 'ep1',
    segmentTotal: 4,
    status: 'success' as const,
    at: 1000,
    outputCount: 2,
    timeline: { segments: [{}, {}, {}, {}] }
  }

  it('候选 → 绑定：去掉地址尾部斜杠，保留时间线', () => {
    const b = bindingFromCandidate(cand, 'epi_a', 'http://1.2.3.4:8188/', 42)
    expect(b.baseUrl).toBe('http://1.2.3.4:8188')
    expect(b.episodeId).toBe('epi_a')
    expect(b.promptId).toBe('p1')
    expect(b.boundAt).toBe(42)
    expect(bindingUsable(b)).toBe(true)
  })

  it('缺时间线的绑定不可用（段位对不上，不能假装能探）', () => {
    const b = bindingFromCandidate({ ...cand, timeline: null }, 'epi_a', 'http://x')
    expect(bindingUsable(b)).toBe(false)
    expect(bindingSummary(b)).toBe('ep1 · 4 段')
  })

  it('空目录名显示成「默认目录」而不是空白', () => {
    expect(cacheDirLabel('')).toBe('默认目录')
    const b = bindingFromCandidate({ ...cand, workflowName: '' }, 'e', 'http://x')
    expect(bindingSummary(b)).toBe('默认目录 · 4 段')
    expect(candidateLabel({ ...cand, workflowName: '' })).toBe('默认目录 · 4 段')
  })

  it('null 绑定的摘要与可用性', () => {
    expect(bindingSummary(null)).toBe('待生成')
    expect(bindingUsable(null)).toBe(false)
  })

  it('地址规范化只裁尾部斜杠与空白', () => {
    expect(normalizeBaseUrl('  http://a:8188// ')).toBe('http://a:8188')
    expect(normalizeBaseUrl('')).toBe('')
  })
})

describe('生成即绑定', () => {
  const submit = {
    baseUrl: 'http://10.0.0.5:8188/',
    workflowName: 'ep_3f9k2',
    nodeId: '39',
    promptId: 'p9',
    segmentTotal: 4,
    timeline: { segments: [{}, {}, {}, {}] }
  }

  it('提交事实 → 绑定：目录名原样保留（磁盘上就这一层，不能再 slug）', () => {
    const b = bindingFromSubmit(submit, 'epi_a', 7)
    expect(b.baseUrl).toBe('http://10.0.0.5:8188')
    expect(b.workflowName).toBe('ep_3f9k2')
    expect(b.nodeId).toBe('39')
    expect(b.promptId).toBe('p9')
    expect(b.segmentTotal).toBe(4)
    expect(b.boundAt).toBe(7)
    expect(b.source).toBe('auto')
    expect(bindingUsable(b)).toBe(true)
    expect(bindingSummary(b)).toBe('ep_3f9k2 · 4 段')
  })

  it('目录名空串是节点默认目录，仍然可绑定', () => {
    const b = bindingFromSubmit({ ...submit, workflowName: '' }, 'epi_a')
    expect(b.workflowName).toBe('')
    expect(bindingSummary(b)).toBe('默认目录 · 4 段')
  })

  it('出处一眼能分清是自动还是手改', () => {
    expect(bindingOriginText(bindingFromSubmit(submit, 'epi_a'))).toBe('生成时自动绑定')
    const manual = bindingFromCandidate(
      { ...submit, status: 'success', at: 1, outputCount: 1 },
      'epi_a',
      'http://x'
    )
    expect(manual.source).toBe('manual')
    expect(bindingOriginText(manual)).toBe('手动改绑的目录')
    expect(bindingOriginText(null)).toContain('第一次生成')
  })
})
