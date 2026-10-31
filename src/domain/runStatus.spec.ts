import { describe, expect, it } from 'vitest'
import {
  aggregate,
  detailText,
  durationLabel,
  isActiveStatus,
  percentOf,
  phaseText,
  recentFinish,
  sinceLabel,
  statusOf,
  type RunJobLike
} from './runStatus'

function job(over: Partial<RunJobLike> = {}): RunJobLike {
  return {
    status: 'running',
    progress: {
      value: 0,
      max: 0,
      segment: 0,
      segmentTotal: 0,
      phaseLabel: '',
      framesLabel: '',
      remainingSegments: 0,
      updatedAt: 0
    },
    submittedAt: 0,
    startedAt: 0,
    endedAt: null,
    ...over,
    ...(over.progress ? { progress: { ...job().progress, ...over.progress } } : {})
  }
}

describe('runStatus', () => {
  it('只把提交中 / 排队 / 运行中算作在跑', () => {
    expect(['submitting', 'queued', 'running'].every(isActiveStatus)).toBe(true)
    expect(['done', 'error', 'interrupted', 'whatever'].some(isActiveStatus)).toBe(false)
  })

  it('没上报 max 时是 0%，不是 NaN', () => {
    expect(percentOf(job())).toBe(0)
    expect(percentOf(job({ progress: { value: 50, max: 0 } as never }))).toBe(0)
  })

  it('百分比夹在 0~100，越界不会画出格', () => {
    expect(percentOf(job({ progress: { value: 25, max: 50 } as never }))).toBe(50)
    expect(percentOf(job({ progress: { value: 120, max: 100 } as never }))).toBe(100)
    expect(percentOf(job({ progress: { value: -10, max: 100 } as never }))).toBe(0)
  })

  it('段号优先于节点名', () => {
    const j = job({ progress: { segment: 3, segmentTotal: 12, phaseLabel: 'KSampler' } as never })
    expect(phaseText(j)).toBe('第 3/12 段')
  })

  it('不知道总段数时不留一个空的 /', () => {
    expect(phaseText(job({ progress: { segment: 2 } as never }))).toBe('第 2/? 段')
  })

  it('没有段号才退到节点名 / 排队文案', () => {
    expect(phaseText(job({ progress: { phaseLabel: 'KSampler' } as never }))).toBe('KSampler')
    expect(phaseText(job({ status: 'queued' }))).toBe('排队中')
    expect(phaseText(job({ status: 'submitting' }))).toBe('正在提交')
    expect(phaseText(job({ status: 'running' }))).toBe('已开始，等第一条进度')
    expect(phaseText(job({ status: 'done' }))).toBe('')
  })

  it('帧数有才拼进详情', () => {
    expect(
      detailText(job({ progress: { segment: 1, segmentTotal: 4, framesLabel: '24 帧' } as never }))
    ).toBe('第 1/4 段 · 24 帧')
    expect(detailText(job({ progress: { segment: 1, segmentTotal: 4 } as never }))).toBe('第 1/4 段')
  })

  it('耗时按 时长 / 分秒 / 时分 分档', () => {
    const t0 = 1_000_000
    expect(durationLabel(job({ startedAt: null }), t0)).toBe('—')
    expect(durationLabel(job({ startedAt: t0 }), t0 + 31_000)).toBe('31s')
    expect(durationLabel(job({ startedAt: t0 }), t0 + 151_000)).toBe('2m31s')
    expect(durationLabel(job({ startedAt: t0 }), t0 + 3_600_000 * 2 + 60_000 * 5)).toBe('2h05m')
    // 结束后不再跟着 now 走
    expect(durationLabel(job({ startedAt: t0, endedAt: t0 + 9_000 }), t0 + 99_000)).toBe('9s')
  })

  it('进度延迟只说"多久前"，不擅自判卡死', () => {
    const t0 = 1_000_000
    expect(sinceLabel(0, t0)).toBe('还没收到进度')
    expect(sinceLabel(t0 - 5_000, t0)).toBe('5s 前')
    expect(sinceLabel(t0 - 125_000, t0)).toBe('2m05s 前')
    expect(sinceLabel(t0 - 3_600_000 * 2, t0)).toBe('2h00m 前')
  })

  it('合进度按工作量加权，不是各任务百分比取平均', () => {
    const a = job({ status: 'running', progress: { value: 99, max: 100 } as never })
    const b = job({ status: 'running', progress: { value: 1, max: 100 } as never })
    expect(aggregate([a, b]).percent).toBe(50)

    // 第二条几乎没动但总量是第一条的 10 倍 —— 不能因为"两条都在跑"就报 50%
    const heavy = job({ status: 'running', progress: { value: 10, max: 1000 } as never })
    expect(aggregate([a, heavy]).percent).toBe(10)
  })

  it('合进度只算在跑的，已完成的不拉低整体', () => {
    const done = job({ status: 'done', progress: { value: 100, max: 100 } as never })
    const run = job({ status: 'running', progress: { value: 10, max: 100 } as never })
    const agg = aggregate([done, run])
    expect(agg.count).toBe(1)
    expect(agg.percent).toBe(10)
    expect(agg.running).toBe(true)
  })

  it('全在排队时 known=false，界面该显示"排队"而不是 0%', () => {
    const agg = aggregate([job({ status: 'queued' }), job({ status: 'queued' })])
    expect(agg).toMatchObject({ count: 2, percent: 0, known: false, running: false })
  })

  it('空列表不炸', () => {
    expect(aggregate([])).toMatchObject({ count: 0, percent: 0, known: false })
    expect(recentFinish([], 0)).toBeNull()
  })

  it('最近结束只认窗口内的，且取最新的那条', () => {
    const now = 1_000_000
    const old = job({ status: 'done', endedAt: now - 10 * 60_000 })
    const fresh = job({ status: 'done', endedAt: now - 2_000 })
    const newer = job({ status: 'error', endedAt: now - 1_000 })
    expect(recentFinish([old, fresh, newer], now)?.status).toBe('error')
    expect(recentFinish([old], now)).toBeNull()
    // 还在跑的不算"刚结束"
    expect(recentFinish([job({ status: 'running' })], now)).toBeNull()
  })

  it('未知状态原样显示，不吞掉', () => {
    expect(statusOf({ status: 'weird' }).text).toBe('weird')
    expect(statusOf({ status: 'running' }).tone).toBe('info')
  })
})
