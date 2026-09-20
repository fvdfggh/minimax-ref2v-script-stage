import { beatFrames, dialogueFrames } from './timing'
import type { Beat, ID, ProjectSettings } from './types'

/* ------------------------------------------------------------------ *
 * 帧长度补正
 *
 * 视频段的总帧数必须落在两个家族之一：
 *   引用上段：17k      ->  17, 34, 51, 68, 85, 102, 119, 136
 *   不引用上段：5 + 17k ->  5, 22, 39, 56, 73, 90, 107, 124, 141
 *
 * 注意 141 = 5 + 17×8、136 = 17×8，正好卡住原来的 141 帧上限。
 *
 * 差额以「额外副帧」的形式单独记录，按各片段帧数占比分摊，可以是负数（压缩）。
 * 片段自身的帧长度不因此改变，副帧也只在段内生效，可手工调整。
 * ------------------------------------------------------------------ */

export const FRAME_STEP = 17
export const NON_REF_OFFSET = 5

/** 引用上段：必须是 17 的正整数倍 */
export function isRefAligned(frames: number): boolean {
  return frames > 0 && frames % FRAME_STEP === 0
}

/** 不引用上段：必须是 5 + 17k */
export function isNonRefAligned(frames: number): boolean {
  return frames >= NON_REF_OFFSET && (frames - NON_REF_OFFSET) % FRAME_STEP === 0
}

export function isAligned(frames: number, refPrev: boolean): boolean {
  return refPrev ? isRefAligned(frames) : isNonRefAligned(frames)
}

/** 该模式下允许的最大帧数（不超过上限） */
export function maxAlignedFrames(refPrev: boolean, maxSegmentFrames: number): number {
  if (refPrev) {
    return Math.max(FRAME_STEP, Math.floor(maxSegmentFrames / FRAME_STEP) * FRAME_STEP)
  }
  const k = Math.floor((maxSegmentFrames - NON_REF_OFFSET) / FRAME_STEP)
  return NON_REF_OFFSET + Math.max(0, k) * FRAME_STEP
}

/** 不小于 raw 的最小合法帧数 */
export function snapUp(raw: number, refPrev: boolean): number {
  if (refPrev) {
    const k = Math.max(1, Math.ceil(raw / FRAME_STEP))
    return k * FRAME_STEP
  }
  const k = Math.max(0, Math.ceil((raw - NON_REF_OFFSET) / FRAME_STEP))
  return NON_REF_OFFSET + k * FRAME_STEP
}

/**
 * 离哪边近就取哪边，同时不越过下限（例如台词总时长）。
 * 距离相同时向上取，避免把内容压得太紧。
 */
export function snapNearest(raw: number, refPrev: boolean, floorFrames = 0): number {
  const up = snapUp(raw, refPrev)
  const down = up - FRAME_STEP
  const lower = refPrev ? FRAME_STEP : NON_REF_OFFSET
  let target: number
  if (down >= lower && Math.abs(down - raw) < Math.abs(up - raw)) target = down
  else target = up
  if (target < floorFrames) target = snapUp(floorFrames, refPrev)
  return target
}

export interface FrameFit {
  /** 片段自身占用的帧数（不含副帧） */
  raw: number
  /** 补正后的目标总帧数 */
  target: number
  /** 需要追加的副帧总量，可为负（压缩） */
  padTotal: number
  /** 目标已经超出该模式的上限 —— 只能拆段 */
  overLimit: boolean
  refPrev: boolean
  /** 该模式允许的最大帧数 */
  cap: number
  /** 是否为压缩 */
  compressing: boolean
}

export function fitSegmentFrames(
  raw: number,
  refPrev: boolean,
  maxSegmentFrames: number,
  floorFrames = 0
): FrameFit {
  const cap = maxAlignedFrames(refPrev, maxSegmentFrames)
  const target = snapNearest(raw, refPrev, floorFrames)
  return {
    raw,
    target,
    padTotal: target - raw,
    overLimit: target > cap,
    refPrev,
    cap,
    compressing: target < raw
  }
}

/** 列出该模式下所有不超过上限的合法帧数，供 UI 直接选 */
export function alignedOptions(refPrev: boolean, maxSegmentFrames: number): number[] {
  const out: number[] = []
  for (let f = refPrev ? FRAME_STEP : NON_REF_OFFSET; f <= maxSegmentFrames; f += FRAME_STEP) {
    out.push(f)
  }
  return out
}

/* ------------------------- 副帧分摊 ------------------------- */

/** 一个片段最多能被压到多少帧：台词不能短于台词本身，其余至少留 1 帧 */
export function minFramesOf(beat: Beat, settings: ProjectSettings): number {
  if (beat.kind === 'dialogue') {
    return Math.max(1, dialogueFrames(beat.dialogue, settings.fps))
  }
  return 1
}

/**
 * 把副帧按各片段自身帧数的占比分摊出去。
 * - padTotal > 0：追加，余数从前往后逐个 +1
 * - padTotal < 0：压缩，先按占比削减，再逐个 -1，且不超过每个片段的可压缩容量
 *
 * 返回的 map 一定包含所有传入的片段（含 0，方便 UI 直接编辑）。
 * 压缩容量不足时合计会小于请求量，由调用方通过 padTotalOf 检出。
 */
export function distributePad(
  beats: Beat[],
  padTotal: number,
  settings: ProjectSettings
): Record<ID, number> {
  const out: Record<ID, number> = {}
  if (!beats.length) return out
  for (const b of beats) out[b.id] = 0
  if (!padTotal) return out

  const actual = beats.map((b) => Math.max(1, beatFrames(b, settings)))
  const totalWeight = actual.reduce((a, b) => a + b, 0)

  if (padTotal > 0) {
    let assigned = 0
    beats.forEach((b, i) => {
      const share = Math.floor((padTotal * actual[i]) / totalWeight)
      out[b.id] = share
      assigned += share
    })
    let rest = padTotal - assigned
    let i = 0
    while (rest > 0) {
      out[beats[i % beats.length].id] += 1
      rest--
      i++
    }
    return out
  }

  // 压缩
  const need = -padTotal
  const capacity = beats.map((b, i) => Math.max(0, actual[i] - minFramesOf(b, settings)))

  let assigned = 0
  beats.forEach((b, i) => {
    const share = Math.min(capacity[i], Math.floor((need * actual[i]) / totalWeight))
    // 注意 -0：Object.is(-0, 0) 为 false，会把断言和 UI 都搞乱
    out[b.id] = share === 0 ? 0 : -share
    assigned += share
  })

  let rest = need - assigned
  let guard = 0
  while (rest > 0 && guard < beats.length * 200) {
    let progressed = false
    for (let i = 0; i < beats.length && rest > 0; i++) {
      const cut = -out[beats[i].id]
      if (cut < capacity[i]) {
        out[beats[i].id] -= 1
        rest--
        progressed = true
      }
    }
    if (!progressed) break
    guard++
  }

  return out
}

export function padTotalOf(pad: Record<ID, number> | undefined | null): number {
  if (!pad) return 0
  let sum = 0
  for (const v of Object.values(pad)) sum += v || 0
  return sum
}

export interface BuildPadInput {
  /** 参与分摊的全部片段，包含预备镜头 / 尾帧切镜 / 黑屏 */
  all: Beat[]
  /** 手工固定的值（键为叙事片段 id），会覆盖自动分摊结果 */
  overrides?: Record<ID, number> | null
  /** 目标副帧总量，可为负 */
  padTotal: number
  settings: ProjectSettings
}

/**
 * 生成最终的副帧表：
 *   1. 先在全量片段（含自动生成的拼接片段）上按占比分摊
 *   2. 用 overrides 覆盖被手工固定过的片段
 *   3. 覆盖造成的差额，重新摊到「没被固定」的片段上，保证合计仍然等于 padTotal
 */
export function buildPad(input: BuildPadInput): Record<ID, number> {
  const { all, overrides, padTotal, settings } = input
  const pad = distributePad(all, padTotal, settings)
  if (!overrides || !Object.keys(overrides).length) return pad

  const frozen = new Set<ID>()
  for (const [id, value] of Object.entries(overrides)) {
    if (!(id in pad)) continue
    pad[id] = value
    frozen.add(id)
  }

  const diff = padTotal - padTotalOf(pad)
  if (!diff) return pad

  const pool = all.filter((b) => !frozen.has(b.id))
  const targets = pool.length ? pool : all
  if (!targets.length) return pad

  const step = diff > 0 ? 1 : -1
  let remaining = Math.abs(diff)
  let guard = 0
  while (remaining > 0 && guard < targets.length * 400) {
    let progressed = false
    for (const b of targets) {
      if (remaining <= 0) break
      const cur = pad[b.id] ?? 0
      if (step < 0 && beatFrames(b, settings) + cur <= minFramesOf(b, settings)) continue
      pad[b.id] = cur + step
      remaining--
      progressed = true
    }
    if (!progressed) break
    guard++
  }

  return pad
}

/** 单个片段的实际占用 = 自身帧数 + 副帧 */
export function paddedBeatFrames(
  beat: Beat,
  settings: ProjectSettings,
  pad?: Record<ID, number> | null
): number {
  return Math.max(1, beatFrames(beat, settings) + (pad?.[beat.id] ?? 0))
}

export function sumPaddedFrames(
  beats: Beat[],
  settings: ProjectSettings,
  pad?: Record<ID, number> | null
): number {
  return beats.reduce((s, b) => s + paddedBeatFrames(b, settings, pad), 0)
}

/** 第一个段默认不引用，其余默认引用 */
export function defaultRefPrev(index: number): boolean {
  return index > 0
}

export function resolveRefPrev(group: { refPrev?: boolean }, index: number): boolean {
  return group.refPrev ?? defaultRefPrev(index)
}

/** 人类可读的家族描述，用于校验提示 */
export function familyLabel(refPrev: boolean): string {
  return refPrev ? '17k（引用上段）' : '5 + 17k（不引用上段）'
}

/** 副帧的显示形式：+5 / -3 / 0 */
export function formatPad(n: number): string {
  if (!n) return '0'
  return n > 0 ? `+${n}` : String(n)
}
