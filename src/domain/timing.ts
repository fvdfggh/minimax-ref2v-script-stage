import type { Beat, ProjectSettings } from './types'
import { AUTO_KINDS, DEFAULT_SETTINGS } from './types'

/* ------------------------------------------------------------------ *
 * 时长与帧：全片统一口径
 * 规范：台词时长 = 汉字数 ÷ 5（标点不计）；单段 ≤141 帧
 * ------------------------------------------------------------------ */

const CJK_RANGES: Array<[number, number]> = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x3040, 0x30ff] // 假名，一并计入"字"
]

export function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0)
  if (code === undefined) return false
  return CJK_RANGES.some(([a, b]) => code >= a && code <= b)
}

/** 汉字数（中日文字符），标点、空格、拉丁字母均不计 */
export function countHanzi(text: string | undefined | null): number {
  if (!text) return 0
  let n = 0
  for (const ch of text) if (isCjk(ch)) n++
  return n
}

export function framesFromSeconds(sec: number, fps = DEFAULT_SETTINGS.fps): number {
  return Math.max(1, Math.round(sec * fps))
}

export function secondsFromFrames(frames: number, fps = DEFAULT_SETTINGS.fps): number {
  return frames / fps
}

/** 台词占用帧数 = 汉字数 ÷ 5 秒 × fps */
export function dialogueFrames(text: string | undefined, fps = DEFAULT_SETTINGS.fps): number {
  const hanzi = countHanzi(text)
  if (hanzi <= 0) return framesFromSeconds(1, fps)
  return Math.ceil((hanzi / 5) * fps)
}

/**
 * 一个 Beat 占用的帧数
 * - 自动片段（preshoot / tail_cut / black）用固定值
 * - 手动改过帧数的用 estFrames
 * - 台词按汉字数推算
 * - 其余按 kind 的默认值
 */
export function beatFrames(beat: Beat, settings: ProjectSettings = DEFAULT_SETTINGS): number {
  if (AUTO_KINDS.includes(beat.kind)) {
    if (beat.kind === 'black') return beat.estFrames ?? settings.blackTailFrames
    if (beat.kind === 'preshoot') return beat.estFrames ?? settings.preshootFrames
    return beat.estFrames ?? settings.seamFrames
  }
  if (beat.manualFrames && typeof beat.estFrames === 'number') return beat.estFrames
  if (beat.kind === 'dialogue') return dialogueFrames(beat.dialogue, settings.fps)
  switch (beat.kind) {
    case 'action':
      return settings.actionFrames
    case 'reaction':
      return settings.reactionFrames
    case 'insert':
      return settings.insertFrames
    case 'establishing':
      return settings.establishingFrames
    case 'scene_switch':
      return settings.sceneSwitchFrames
    default:
      return settings.actionFrames
  }
}

export function beatsFrames(beats: Beat[], settings?: ProjectSettings): number {
  return beats.reduce((sum, b) => sum + beatFrames(b, settings), 0)
}

/** 时间戳格式 [Shot N] At 00:0X.XXX —— mm:ss.mmm */
export function timecode(frames: number, fps = DEFAULT_SETTINGS.fps): string {
  const totalSeconds = frames / fps
  let ss = Math.floor(totalSeconds)
  let ms = Math.round((totalSeconds - ss) * 1000)
  if (ms >= 1000) {
    ms -= 1000
    ss += 1
  }
  return `00:${String(ss).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

/** 单段是否超限 */
export function isOverLimit(frames: number, settings: ProjectSettings = DEFAULT_SETTINGS): boolean {
  return frames > settings.maxSegmentFrames
}

/** 单段超限时，至少需要拆成几段 */
export function minGroupsNeeded(frames: number, settings: ProjectSettings = DEFAULT_SETTINGS): number {
  return Math.max(1, Math.ceil(frames / settings.maxSegmentFrames))
}
