import { describe, expect, it } from 'vitest'
import {
  canSecondSampleOf,
  passLabelText,
  passToneOf,
  posterUrl,
  secondSelectable,
  segProductHint
} from './productDisplay'
import type { PassOutput } from '@/stores/outputs'

const none: PassOutput = { hasClip: false, hasFrames: false, hasLatent: false, stale: false }
const clip: PassOutput = { ...none, hasClip: true }
const frames: PassOutput = { ...none, hasFrames: true }
const latent: PassOutput = { ...none, hasLatent: true }

describe('passLabelText', () => {
  it('按"能播 → 能导 → 只有 latent → 没有"的顺序说清状态', () => {
    expect(passLabelText(clip, 'first')).toBe('已出片')
    expect(passLabelText(frames, 'first')).toBe('有帧缓存（未编码）')
    expect(passLabelText(latent, 'first')).toBe('仅 latent')
    expect(passLabelText(none, 'first')).toBe('未渲染')
  })

  it('二采的"没有"要分两种：能补跑（有一采 latent）vs 连底子都没有', () => {
    expect(passLabelText(none, 'second', true)).toBe('可二采，还没跑')
    expect(passLabelText(none, 'second', false)).toBe('无一采 latent')
    expect(passLabelText(latent, 'second')).toBe('已二采（latent 在）')
  })
})

describe('canSecondSampleOf', () => {
  it('一采 latent 不在就绝对不能二采，哪怕节点说能', () => {
    // 演示项目踩过的坑：一采只剩成片（latent 被清），节点仍回 canSecondSample=true，
    // 结果勾满 4 段去导，拿到 0 个文件 + 4 条跳过
    expect(canSecondSampleOf(none, { hasLatent: false, canSecondSample: true })).toBe(false)
    expect(canSecondSampleOf(clip, { hasLatent: false, canSecondSample: true })).toBe(false)
  })

  it('一采 latent 在，再看节点那份补充条件（文本条件等）', () => {
    expect(canSecondSampleOf(latent, { hasLatent: true, canSecondSample: true })).toBe(true)
    expect(canSecondSampleOf(latent, { hasLatent: true, canSecondSample: false })).toBe(false)
  })

  it('节点端没回 hasLatent 时，本地一采状态说了算', () => {
    expect(canSecondSampleOf(latent)).toBe(true)
    expect(canSecondSampleOf(clip)).toBe(false)
  })

  it('本地一采只剩成片、节点现问回 latent 在：以现问的为准', () => {
    expect(canSecondSampleOf(clip, { hasLatent: true, canSecondSample: true })).toBe(true)
  })
})

describe('secondSelectable', () => {
  it('二采已经有缓存 ⇒ 一定可选（导出读磁盘，不看一采 latent）', () => {
    expect(secondSelectable({ first: clip, second: clip, canSecondSample: false })).toBe(true)
    expect(secondSelectable({ first: none, second: latent, canSecondSample: false })).toBe(true)
  })

  it('二采还没产物 ⇒ 有一采 latent 才可选', () => {
    expect(secondSelectable({ first: latent, second: none, canSecondSample: true })).toBe(true)
    expect(secondSelectable({ first: clip, second: none, canSecondSample: false })).toBe(false)
  })
})

describe('passToneOf', () => {
  it('出片=成功、有缓存=警告、全无=默认', () => {
    expect(passToneOf(clip)).toBe('success')
    expect(passToneOf(frames)).toBe('warning')
    expect(passToneOf(latent)).toBe('warning')
    expect(passToneOf(none)).toBe('default')
  })
})

describe('segProductHint', () => {
  it('段列表上一眼看出这段有没有片', () => {
    expect(segProductHint(clip, none)).toEqual({ text: '一采出片', tone: 'success' })
    expect(segProductHint(clip, clip)).toEqual({ text: '一采+二采', tone: 'success' })
    // 一采只采样不解码（仅 latent）+ 二采出片:不能说成「一采+二采」，
    // 否则用户切到一采列导出才发现没有片。
    expect(segProductHint(latent, clip)).toEqual({ text: '二采出片', tone: 'success' })
    expect(segProductHint(latent, none)).toEqual({ text: '仅缓存', tone: 'warning' })
    expect(segProductHint(none, none)).toEqual({ text: '未渲染', tone: 'default' })
  })
})

describe('posterUrl', () => {
  it('给播放器加 #t=0.1 让它 seek 出一帧当封面', () => {
    expect(posterUrl('/api/comfy/clip?x=1')).toBe('/api/comfy/clip?x=1#t=0.1')
    // 空地址不能拼出 "#t=0.1"，否则 <video src> 会去请求当前页
    expect(posterUrl('')).toBe('')
  })
})
