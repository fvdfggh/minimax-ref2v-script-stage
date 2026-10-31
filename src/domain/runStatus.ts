/**
 * 运行状态的「一句话口径」。
 *
 * 为什么单独抽出来：同一份 `run.jobs` 现在有四个地方在显示 ——
 *   运行页的任务卡片（RunJobsPanel）
 *   全局浮窗（RunStatusDock，所有页面右下角）
 *   剧本台首页的状态卡（LibraryView）
 *   浏览器标题（浮窗顺手改的）
 *
 * 各写一套 `value / max` 的结果就是「浮窗说 42%、运行页说 40%」，
 * 用户只会觉得哪边坏了。所以数值换算、阶段文案、耗时格式只留这一份。
 *
 * 这里刻意不 import store：入参是结构化的最小字段集，
 * 单测直接拿字面量对象就能测，不需要起 pinia。
 */

/** 任务状态。和 stores/run.ts 的 JobStatus 一一对应，但不耦合 */
export type RunStatus =
  | 'submitting'
  | 'queued'
  | 'running'
  | 'done'
  | 'error'
  | 'interrupted'

/** 浮窗那一小块要显示的东西 */
export interface RunJobLike {
  status: string
  progress: {
    value: number
    max: number
    segment: number
    segmentTotal: number
    phaseLabel: string
    framesLabel: string
    remainingSegments: number
    updatedAt: number
  }
  submittedAt: number
  startedAt: number | null
  endedAt: number | null
  error?: string
}

export const STATUS_TEXT: Record<
  string,
  { text: string; tone: 'info' | 'ok' | 'warn' | 'err' | 'idle' }
> = {
  submitting: { text: '提交中', tone: 'info' },
  queued: { text: '排队', tone: 'info' },
  running: { text: '运行中', tone: 'info' },
  done: { text: '完成', tone: 'ok' },
  error: { text: '出错', tone: 'err' },
  interrupted: { text: '已中断', tone: 'warn' }
}

/** 还在跑（含排队与提交中）：浮窗只在有这种任务时露头 */
export function isActiveStatus(status: string): boolean {
  return status === 'running' || status === 'queued' || status === 'submitting'
}

export function statusOf(job: { status: string }): { text: string; tone: string } {
  return STATUS_TEXT[job.status] ?? { text: job.status, tone: 'idle' }
}

/**
 * 进度百分比。
 *
 * 没有 max 时返回 0 而不是 NaN —— 排队阶段 ComfyUI 还没报过进度，
 * 这时候该显示"排队"，不该显示一个 0/0 算出来的 NaN%。
 */
export function percentOf(job: Pick<RunJobLike, 'progress'>): number {
  const { value, max } = job.progress
  if (!max || max <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)))
}

/**
 * 阶段一句话：`第 3/12 段` 优先于 phaseLabel，再退到排队文案。
 *
 * 顺序不能反：phaseLabel 是节点自报的（"KSampler"），段号才是用户能对上
 * 时间线的东西；已经在跑第几段却显示一个节点名，等于没说。
 */
export function phaseText(job: Pick<RunJobLike, 'status' | 'progress'>): string {
  const p = job.progress
  if (p.segment) {
    return `第 ${p.segment}/${p.segmentTotal || '?'} 段`
  }
  if (p.phaseLabel) return p.phaseLabel
  if (job.status === 'submitting') return '正在提交'
  if (job.status === 'queued') return '排队中'
  if (job.status === 'running') return '已开始，等第一条进度'
  return ''
}

/** `第 3/12 段 · 24 帧`（帧数有才拼） */
export function detailText(job: RunJobLike): string {
  const head = phaseText(job)
  const frames = job.progress.framesLabel
  if (head && frames) return `${head} · ${frames}`
  return head || frames || ''
}

/** `2m31s` / `31s`。与运行页任务卡保持一致，别一页一个格式 */
export function durationLabel(
  job: Pick<RunJobLike, 'startedAt' | 'endedAt'>,
  nowMs: number = Date.now()
): string {
  if (!job.startedAt) return '—'
  const end = job.endedAt ?? nowMs
  const s = Math.max(0, Math.round((end - job.startedAt) / 1000))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return m ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

/** 进度事件最后一次到达到现在多久：判断"卡住"还是"只是没上报" */
export function sinceLabel(ts: number, nowMs: number = Date.now()): string {
  if (!ts) return '还没收到进度'
  const s = Math.max(0, Math.round((nowMs - ts) / 1000))
  if (s < 60) return `${s}s 前`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s 前` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m 前`
}

export interface Aggregate {
  /** 在跑（含排队）的任务数 */
  count: number
  /** 加权百分比：Σvalue / Σmax。全都没上报时 known=false */
  percent: number
  known: boolean
  /** 有没有任务正在真的跑（而不只是排队） */
  running: boolean
}

/**
 * 多条任务的合进度。
 *
 * 用 Σvalue/Σmax 而不是"各任务百分比取平均"：两个任务一个 99%、一个 1% 时，
 * 平均值 50% 看起来像"跑了一半"，实际还剩整个第二条。加权才对得上总工作量。
 */
export function aggregate(jobs: RunJobLike[]): Aggregate {
  const act = jobs.filter((j) => isActiveStatus(j.status))
  let value = 0
  let max = 0
  for (const j of act) {
    value += Math.max(0, j.progress.value)
    max += Math.max(0, j.progress.max)
  }
  return {
    count: act.length,
    percent: max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0,
    known: max > 0,
    running: act.some((j) => j.status === 'running')
  }
}

/**
 * 最近结束的任务（浮窗用来报一声"刚跑完"）。
 *
 * 只认 done / error / interrupted 且 endedAt 在窗口内。为什么要窗口：
 * 浮窗是常驻的，把三天前的完成挂在角上，等于永远消不掉的一条通知。
 */
export function recentFinish<T extends Pick<RunJobLike, 'status' | 'endedAt'>>(
  jobs: T[],
  nowMs: number = Date.now(),
  windowMs = 120_000
): T | null {
  let best: T | null = null
  for (const j of jobs) {
    if (isActiveStatus(j.status)) continue
    if (!j.endedAt) continue
    if (nowMs - j.endedAt > windowMs) continue
    if (!best || (best.endedAt ?? 0) < j.endedAt) best = j
  }
  return best
}
