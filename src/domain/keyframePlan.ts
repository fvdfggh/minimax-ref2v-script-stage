/**
 * AI 排关键帧：把模型返回的「第几帧、画什么」变成可审查的行。
 *
 * 分工很明确，别让它糊在一起：
 *   AI   —— 决定这一段该在哪几帧有画面、每帧画什么（模型只看文字，看不见片子）
 *   用户 —— 看建议、改帧号 / 改词，**点「开始出图」才真的跑**
 *
 * 所以这里全是纯函数：解析、夹帧、去重、限流。不碰 store、不发请求、不落库。
 * 模型给的帧号一律当"建议"处理：越界的夹回段内，重复的只留第一条，
 * 太碎的砍到上限 —— 宁可少一张，也不要因为模型多给一条就凭空多出一倍的出图时间。
 */
import { clampFrame } from './references'
import type { ID } from './types'

/** 一段最多排几张：再多也是同一个机位的重复描述，出图时间却是实打实翻倍 */
export const MAX_SHOTS_PER_BEAT = 3

export interface PlanBeat {
  id: ID
  /** 本段总帧数，用来夹帧 */
  frames: number
}

/** AI 给的一条关键帧建议 */
export interface KeyframeShot {
  /** 段内帧号（0 = 开场第一帧），已夹到 0..frames-1 */
  frame: number
  /** 英文画面提示词 */
  prompt: string
  /** 为什么放这一帧（中文一句话，给用户判断用） */
  reason?: string
}

export interface KeyframePlanRow {
  beatId: ID
  frames: number
  shots: KeyframeShot[]
}

function listOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    // 模型有时会把数组包一层：shots / items / keyframes 都认
    for (const key of ['shots', 'items', 'keyframes']) {
      if (Array.isArray(o[key])) return o[key] as unknown[]
    }
  }
  return []
}

function textOf(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function numOf(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 解析模型输出。
 *
 * 模型只抄「片段序号」（1 起）而不是 id：让模型复述不透明 id 几乎必错，
 * 而序号就是它在清单里看到的东西。
 */
export function parseKeyframePlan(
  raw: unknown,
  beats: PlanBeat[],
  opts: { maxPerBeat?: number } = {}
): KeyframePlanRow[] {
  const max = Math.max(1, Math.round(opts.maxPerBeat ?? MAX_SHOTS_PER_BEAT))
  const byBeat = new Map<ID, KeyframeShot[]>()

  for (const item of listOf(raw)) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const idx = numOf(o.beat ?? o.beatIndex ?? o.index)
    if (idx === null) continue
    const beat = beats[Math.round(idx) - 1]
    if (!beat) continue

    const prompt = textOf(o.prompt ?? o.text ?? o.desc)
    if (!prompt) continue

    const frameRaw = numOf(o.frame ?? o.frameIdx)
    const frame = clampFrame(frameRaw ?? 0, beat.frames)
    const shot: KeyframeShot = { frame, prompt }
    const reason = textOf(o.reason)
    if (reason) shot.reason = reason

    const arr = byBeat.get(beat.id)
    if (arr) arr.push(shot)
    else byBeat.set(beat.id, [shot])
  }

  const out: KeyframePlanRow[] = []
  for (const beat of beats) {
    const shots = byBeat.get(beat.id)
    if (!shots?.length) continue
    // 同帧只留第一条：同帧两张图在导演台里后一张会盖掉前一张，纯浪费一次采样
    const seen = new Set<number>()
    const kept: KeyframeShot[] = []
    for (const s of [...shots].sort((a, b) => a.frame - b.frame)) {
      if (seen.has(s.frame)) continue
      seen.add(s.frame)
      kept.push(s)
    }
    out.push({ beatId: beat.id, frames: beat.frames, shots: kept.slice(0, max) })
  }
  return out
}
