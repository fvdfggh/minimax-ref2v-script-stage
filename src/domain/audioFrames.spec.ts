import { describe, expect, it } from 'vitest'
import {
  SPEECH_MIN_FRAMES,
  SPEECH_TAIL_SEC,
  isRiffWav,
  secondsLabel,
  speechFitOf,
  speechFramePatch,
  speechFramesPlan,
  voiceoverAssetsOf,
  wavDurationSec
} from './audioFrames'
import { VOICEOVER_LABEL } from './voiceover'
import { DEFAULT_SETTINGS } from './types'
import type { Asset, Beat, ID } from './types'

/* ------------------------------ 素材构造 ------------------------------ */

function wavBytes(
  seconds: number,
  opts: { sampleRate?: number; channels?: number; streamSize?: boolean } = {}
): ArrayBuffer {
  const sampleRate = opts.sampleRate ?? 24000
  const channels = opts.channels ?? 1
  const bits = 16
  const blockAlign = (channels * bits) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = Math.round(byteRate * seconds)
  const buf = new ArrayBuffer(44 + dataSize)
  const v = new DataView(buf)
  const put = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  put(0, 'RIFF')
  v.setUint32(4, 36 + dataSize, true)
  put(8, 'WAVE')
  put(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, channels, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, byteRate, true)
  v.setUint16(32, blockAlign, true)
  v.setUint16(34, bits, true)
  put(36, 'data')
  // 流式编码器常见的两种写法：0 与 0xFFFFFFFF
  v.setUint32(40, opts.streamSize ? 0 : dataSize, true)
  return buf
}

function beat(p: Partial<Beat> = {}): Beat {
  return {
    id: 'b1' as ID,
    projectId: 'p1' as ID,
    order: 0,
    kind: 'dialogue',
    title: 't',
    dialogue: '还有热的东西吗？',
    entities: [],
    speakerId: 'e1' as ID,
    manualFrames: false,
    locked: false,
    enriched: false,
    createdAt: 0,
    updatedAt: 0,
    ...p
  } as Beat
}

function voiceAsset(p: Partial<Asset> = {}): Asset {
  return {
    id: 'a1' as ID,
    projectId: 'p1' as ID,
    pictureN: 0,
    fileName: 'voice.wav',
    originalName: 'voice_e1.wav',
    label: VOICEOVER_LABEL,
    kind: 'material',
    refId: 'b1' as ID,
    media: 'audio',
    createdAt: 0,
    ...p
  } as Asset
}

/* ------------------------------ WAV 解析 ------------------------------ */

describe('wavDurationSec', () => {
  it('按 data 字节数 ÷ byteRate 算时长', () => {
    expect(wavDurationSec(wavBytes(1.5))).toBeCloseTo(1.5, 3)
    expect(wavDurationSec(wavBytes(0.25, { sampleRate: 44100, channels: 2 }))).toBeCloseTo(0.25, 3)
  })

  it('data chunk 写成 0（流式）时退回文件实际长度', () => {
    const buf = wavBytes(1, { streamSize: true })
    expect(wavDurationSec(buf, buf.byteLength)).toBeCloseTo(1, 3)
  })

  it('非 wav / 空文件返回 null', () => {
    expect(isRiffWav(new ArrayBuffer(8))).toBe(false)
    expect(wavDurationSec(new ArrayBuffer(8))).toBeNull()
    expect(wavDurationSec(new TextEncoder().encode('ID3 this is an mp3').buffer)).toBeNull()
  })
})

/* ---------------------------- 时长 → 帧数 ---------------------------- */

describe('speechFramesPlan', () => {
  it('2.1 秒 @24fps = 51 帧声音 + 7 帧尾留白', () => {
    const p = speechFramesPlan({ seconds: 2.1, fps: 24 })!
    expect(p.audioFrames).toBe(51)
    expect(p.tailFrames).toBe(Math.round(SPEECH_TAIL_SEC * 24))
    expect(p.needed).toBe(58)
    expect(p.overLimit).toBe(false)
  })

  it('音频不从段首开始时，片段要连前面那截一起算', () => {
    const p = speechFramesPlan({ seconds: 2.1, fps: 24, startFrame: 12 })!
    expect(p.endFrame).toBe(63)
    expect(p.needed).toBe(70)
  })

  it('向上取整：差一点点也不能截掉最后一个字', () => {
    // 1.02 秒 × 24 = 24.48 帧
    expect(speechFramesPlan({ seconds: 1.02, fps: 24 })!.audioFrames).toBe(25)
  })

  it('极短的音频也留够最小长度', () => {
    const p = speechFramesPlan({ seconds: 0.05, fps: 24 })!
    expect(p.audioFrames).toBe(2)
    // 2 帧声音 + 7 帧尾留白，比最小长度大，按实际需要算
    expect(p.needed).toBeGreaterThanOrEqual(SPEECH_MIN_FRAMES)
    expect(p.needed).toBe(2 + Math.round(SPEECH_TAIL_SEC * 24))
  })

  it('超过单段上限时标记出来（不在这里硬拆）', () => {
    const p = speechFramesPlan({ seconds: 6, fps: 24, maxFrames: 141 })!
    expect(p.needed).toBe(151)
    expect(p.overLimit).toBe(true)
  })

  it('非法输入返回 null', () => {
    expect(speechFramesPlan({ seconds: 0, fps: 24 })).toBeNull()
    expect(speechFramesPlan({ seconds: -1, fps: 24 })).toBeNull()
    expect(speechFramesPlan({ seconds: 1, fps: 0 })).toBeNull()
  })
})

/* --------------------------- 片段该多长 --------------------------- */

describe('speechFitOf', () => {
  it('配音比当前帧数长就要求延长', () => {
    const b = beat({ estFrames: 40, manualFrames: true })
    const fit = speechFitOf(b, [voiceAsset({ durationSec: 2.1 })], DEFAULT_SETTINGS)!
    expect(fit.current).toBe(40)
    expect(fit.frames).toBe(58)
    expect(fit.longer).toBe(true)
    expect(fit.shorter).toBe(false)
  })

  it('配音比当前短只标记 shorter，不强制压回去', () => {
    const b = beat({ estFrames: 90, manualFrames: true })
    const fit = speechFitOf(b, [voiceAsset({ durationSec: 2.1 })], DEFAULT_SETTINGS)!
    expect(fit.longer).toBe(false)
    expect(fit.shorter).toBe(true)
  })

  it('起点帧算进去：从第 12 帧起的配音要更长', () => {
    const b = beat({ estFrames: 60, manualFrames: true })
    const fit = speechFitOf(
      b,
      [voiceAsset({ durationSec: 2.1, frameIdx: 12 })],
      DEFAULT_SETTINGS
    )!
    expect(fit.frames).toBe(70)
  })

  it('没有配音 / 没测到时长时返回 null，不瞎猜', () => {
    const b = beat({ estFrames: 40, manualFrames: true })
    expect(speechFitOf(b, [], DEFAULT_SETTINGS)).toBeNull()
    expect(speechFitOf(b, [voiceAsset({ durationSec: undefined })], DEFAULT_SETTINGS)).toBeNull()
    // 不是配音的普通音频不参与（label 和文件名前缀都不像配音）
    expect(
      speechFitOf(
        b,
        [voiceAsset({ durationSec: 2.1, label: '参考音频', originalName: 'ambience.wav' })],
        DEFAULT_SETTINGS
      )
    ).toBeNull()
  })

  it('多条配音取最长的那条，别让另一条被截断', () => {
    const b = beat({ estFrames: 40, manualFrames: true })
    const fit = speechFitOf(
      b,
      [voiceAsset({ id: 'a1' as ID, durationSec: 1 }), voiceAsset({ id: 'a2' as ID, durationSec: 3 })],
      DEFAULT_SETTINGS
    )!
    expect(fit.frames).toBe(3 * 24 + Math.round(SPEECH_TAIL_SEC * 24))
  })

  it('会自动忽略别的片段的配音', () => {
    const b = beat({ id: 'b1' as ID })
    const other = voiceAsset({ refId: 'b2' as ID, durationSec: 2 })
    expect(speechFitOf(b, [other], DEFAULT_SETTINGS)).toBeNull()
    expect(voiceoverAssetsOf([other], 'b1' as ID)).toEqual([])
  })
})

describe('secondsLabel', () => {
  it('两位小数，无效值给空串', () => {
    expect(secondsLabel(2.1)).toBe('2.10s')
    expect(secondsLabel(0)).toBe('')
    expect(secondsLabel(undefined)).toBe('')
  })
})

describe('speechFramePatch', () => {
  /** 长台词：字数估算 48 帧，合成出来 2.1 秒 → 58 帧 */
  const longBeat = (p: Partial<Beat> = {}) => beat({ dialogue: '你'.repeat(10), ...p })

  it('没手动改过：音频说了算，可长可短', () => {
    const b = beat({ dialogue: '嗯'.repeat(10) }) // 10 字 → 48 帧
    const growFit = speechFitOf(b, [voiceAsset({ durationSec: 3 })], DEFAULT_SETTINGS)!
    expect(speechFramePatch(b, growFit)).toEqual({ estFrames: growFit.frames, manualFrames: true })

    const shrinkFit = speechFitOf(b, [voiceAsset({ durationSec: 1 })], DEFAULT_SETTINGS)!
    expect(shrinkFit.shorter).toBe(true)
    expect(speechFramePatch(b, shrinkFit)).toEqual({
      estFrames: shrinkFit.frames,
      manualFrames: true
    })
  })

  it('手动改过：只补不足，不擅自缩短', () => {
    const b = longBeat({ estFrames: 120, manualFrames: true })
    const fit = speechFitOf(b, [voiceAsset({ durationSec: 2 })], DEFAULT_SETTINGS)!
    expect(fit.shorter).toBe(true)
    expect(speechFramePatch(b, fit)).toBeNull()

    const b2 = longBeat({ estFrames: 20, manualFrames: true })
    const fit2 = speechFitOf(b2, [voiceAsset({ durationSec: 2 })], DEFAULT_SETTINGS)!
    expect(fit2.longer).toBe(true)
    expect(speechFramePatch(b2, fit2)).toEqual({ estFrames: fit2.frames, manualFrames: true })
  })

  it('已经一致 / 没有配音时不写入', () => {
    const b = beat({ estFrames: 55, manualFrames: true })
    const fit = speechFitOf(b, [voiceAsset({ durationSec: 2 })], DEFAULT_SETTINGS)!
    expect(fit.frames).toBe(55)
    expect(speechFramePatch(b, fit)).toBeNull()
    expect(speechFramePatch(b, null)).toBeNull()
  })
})
