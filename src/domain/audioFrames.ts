/**
 * 用配音决定片段帧长。
 *
 * 原来的台词帧数靠字数推：汉字数 ÷ 5 秒。这个方法只在"平均语速"上成立，
 * 一旦音色偏慢、句子里有停顿、或者情绪重音，估算就会偏 —— 偏短会把话截断，
 * 偏长会让画面空等。合成完的音频本身就是最权威的答案，用它的时长反推帧数。
 *
 * 三件事分开写：
 *   wavDurationSec   纯解析，不依赖浏览器（单测直接喂构造出来的 wav）
 *   speechFramesPlan 时长 → 帧数，纯计算
 *   speechFitOf      从一个片段里找出配音、算出"应有多长"
 *
 * 注意这里**不处理 17 帧家族的对齐**：那是段级约束（见 domain/frames.ts），
 * 片段自身多少帧都合法，差额由副帧摊掉。这里只管"这段话要占多少帧"。
 */

import { beatFrames } from './timing'
import { isVoiceover } from './voiceover'
import type { Asset, Beat, ProjectSettings } from './types'

/** 句尾留白：声音结束后画面再停一会儿，免得话没落就被切走 */
export const SPEECH_TAIL_SEC = 0.3

/** 一句话最短的片段长度，防止极短气声把片段压成两三帧 */
export const SPEECH_MIN_FRAMES = 5

/* ------------------------------------------------------------------ *
 * WAV 时长：读 header，不解码
 * ------------------------------------------------------------------ */

function tagOf(v: DataView, off: number): string {
  return (
    String.fromCharCode(v.getUint8(off)) +
    String.fromCharCode(v.getUint8(off + 1)) +
    String.fromCharCode(v.getUint8(off + 2)) +
    String.fromCharCode(v.getUint8(off + 3))
  )
}

export function isRiffWav(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false
  const v = new DataView(buf)
  return tagOf(v, 0) === 'RIFF' && tagOf(v, 8) === 'WAVE'
}

/**
 * 从 WAV 头算时长：data 字节数 ÷ byteRate。
 *
 * `totalBytes` 用来兜底流式 wav：有些编码器把 data chunk size 写成 0 或
 * 0xFFFFFFFF，这时按文件实际长度减 data 起点算。
 */
export function wavDurationSec(buf: ArrayBuffer, totalBytes = buf.byteLength): number | null {
  if (!isRiffWav(buf)) return null
  const v = new DataView(buf)
  let off = 12
  let byteRate = 0
  let dataSize = 0
  let dataOffset = 0

  while (off + 8 <= buf.byteLength) {
    const id = tagOf(v, off)
    const size = v.getUint32(off + 4, true)
    const body = off + 8

    if (id === 'fmt ' && body + 16 <= buf.byteLength) {
      byteRate = v.getUint32(body + 8, true)
    } else if (id === 'data') {
      dataOffset = body
      // size 写成 0 / 0xFFFFFFFF / 超过文件长度，都是"长度不可信"，
      // 按文件实际长度减 data 起点算（流式编码器的常见写法）
      const declaredOk = size > 0 && body + size <= buf.byteLength
      dataSize = declaredOk ? size : Math.max(0, totalBytes - body)
      // 头和体都拿到了就不必再往下扫（wav 里 fmt 一定在 data 之前）
      if (byteRate) break
    }

    // chunk 是字对齐的：奇数长度后面有一个填充字节
    const next = body + size + (size % 2)
    if (next <= off) break
    off = next
  }

  if (dataOffset <= 0 || dataSize <= 0 || byteRate <= 0) return null
  const sec = dataSize / byteRate
  return Number.isFinite(sec) && sec > 0 ? sec : null
}

/**
 * 测一段音频的时长。
 *
 * WAV 走 header（不解码，几百 KB 也是瞬时）；其它格式退回 <audio> 元数据。
 * 任何失败都返回 null —— 时长是"有更好"的信息，不能因为它让上传/合成失败。
 */
export async function audioDurationSec(blob: Blob, timeoutMs = 3000): Promise<number | null> {
  try {
    // 先只读头部判断格式，不是 wav 就不要把整段音频拉进内存
    const head = await blob.slice(0, 64).arrayBuffer()
    if (isRiffWav(head)) {
      const buf = await blob.arrayBuffer()
      const sec = wavDurationSec(buf, blob.size)
      if (sec != null) return sec
    }
  } catch {
    /* 读不到就走下面的兜底 */
  }

  const AudioCtor = (globalThis as { Audio?: new () => HTMLAudioElement }).Audio
  const createUrl = (globalThis as { URL?: typeof URL }).URL?.createObjectURL
  if (!AudioCtor || typeof createUrl !== 'function') return null

  return await new Promise<number | null>((resolve) => {
    const url = createUrl.call(URL, blob)
    const audio = new AudioCtor()
    let settled = false
    const finish = (v: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      audio.onloadedmetadata = null
      audio.onerror = null
      try {
        URL.revokeObjectURL(url)
      } catch {
        /* 忽略 */
      }
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => {
      const d = audio.duration
      finish(Number.isFinite(d) && d > 0 ? d : null)
    }
    audio.onerror = () => finish(null)
    audio.src = url
  })
}

/* ------------------------------------------------------------------ *
 * 时长 → 帧数
 * ------------------------------------------------------------------ */

export interface SpeechFramesPlan {
  /** 音频时长（秒） */
  seconds: number
  /** 音频起点（段内帧位） */
  startFrame: number
  /** 声音本身占多少帧（向上取整，宁可多一帧也不截断） */
  audioFrames: number
  /** 句尾留白帧数 */
  tailFrames: number
  /** 这段声音结束时所在的帧（不含留白） */
  endFrame: number
  /** 本片段至少需要多少帧 */
  needed: number
  /** needed 超过单段上限：设进去会被组合器拆成多段 */
  overLimit: boolean
}

export function speechFramesPlan(args: {
  seconds: number
  fps: number
  startFrame?: number
  tailSec?: number
  maxFrames?: number
}): SpeechFramesPlan | null {
  const { seconds, fps } = args
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  if (!Number.isFinite(fps) || fps <= 0) return null

  const start = Math.max(0, Math.round(args.startFrame ?? 0))
  const audioFrames = Math.max(1, Math.ceil(seconds * fps))
  const tailSec = args.tailSec ?? SPEECH_TAIL_SEC
  const tailFrames = Math.max(0, Math.round(tailSec * fps))
  const endFrame = start + audioFrames
  const needed = Math.max(SPEECH_MIN_FRAMES, endFrame + tailFrames)
  return {
    seconds,
    startFrame: start,
    audioFrames,
    tailFrames,
    endFrame,
    needed,
    overLimit: typeof args.maxFrames === 'number' ? needed > args.maxFrames : false
  }
}

export interface SpeechFit {
  /** 提供时长的那条配音素材 */
  asset: Asset
  plan: SpeechFramesPlan
  /** 片段当前帧数 */
  current: number
  /** 按配音应当设成多少帧 */
  frames: number
  /** 比现在长：不延长就会把话截断 */
  longer: boolean
  /** 比现在短：延长是用户自己加的表演留白，缩不缩由人决定 */
  shorter: boolean
}

/** 这个片段里的配音素材（能测出时长的那些） */
export function voiceoverAssetsOf(assets: Asset[], beatId: Beat['id']): Asset[] {
  return assets.filter(
    (a) =>
      a.refId === beatId &&
      isVoiceover(a) &&
      typeof a.durationSec === 'number' &&
      a.durationSec > 0
  )
}

/**
 * 按片段里的配音算出应有的帧长。
 *
 * 有多条配音时（正常不会，重配会先删旧的）取需要最长的那条：宁可让最后一句
 * 说完，也不要因为按了较短的一条而截断另一条。
 */
export function speechFitOf(
  beat: Beat,
  assets: Asset[],
  settings: ProjectSettings
): SpeechFit | null {
  const voiced = voiceoverAssetsOf(assets, beat.id)
  if (!voiced.length) return null

  const current = beatFrames(beat, settings)
  let best: SpeechFit | null = null

  for (const a of voiced) {
    const plan = speechFramesPlan({
      seconds: a.durationSec as number,
      fps: settings.fps,
      startFrame: a.frameIdx ?? 0,
      maxFrames: settings.maxSegmentFrames
    })
    if (!plan) continue
    const fit: SpeechFit = {
      asset: a,
      plan,
      current,
      frames: plan.needed,
      longer: plan.needed > current,
      shorter: plan.needed < current
    }
    if (!best || fit.frames > best.frames) best = fit
  }

  return best
}

/** 界面上的短标签：2.10s */
export function secondsLabel(sec: number | undefined | null): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return ''
  return `${sec.toFixed(2)}s`
}

/**
 * 合成完之后该不该自动改帧数。
 *
 * 分两种情况，区别只在"能不能缩短"：
 *   manualFrames = false —— 现在的长度本来就是我们按字数估的，没有用户意图
 *                          在里面，直接换成音频算出来的长度（可长可短）
 *   manualFrames = true  —— 用户亲手调过，只补不足的（短了会截断台词），
 *                          多出来的部分不动，那可能是故意留的表演停顿
 *
 * 长度已经等于音频需求时返回 null，免得写一次没意义的"手动帧数"。
 */
export function speechFramePatch(
  beat: Beat,
  fit: SpeechFit | null
): { estFrames: number; manualFrames: true } | null {
  if (!fit) return null
  if (fit.frames === fit.current) return null
  if (beat.manualFrames && !fit.longer) return null
  return { estFrames: fit.frames, manualFrames: true }
}
