import { describe, expect, it } from 'vitest'
import {
  VOICEOVER_LABEL,
  hasVoiceover,
  isVoiceover,
  needsVoiceSlot,
  voiceoverCheck,
  voiceoverQueue
} from './voiceover'
import type { Asset, Beat, Entity, ID } from './types'

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

function ent(p: Partial<Entity> = {}): Entity {
  return {
    id: 'e1' as ID,
    projectId: 'p1' as ID,
    name: '陈默',
    type: 'character',
    kind: 'speaking',
    subjectN: 1,
    sx: 1,
    pictureN: null,
    voiceDesc: '低沉的男声',
    textDesc: null,
    createdAt: 0,
    updatedAt: 0,
    ...p
  } as Entity
}

function audio(p: Partial<Asset> = {}): Asset {
  return {
    id: 'a1' as ID,
    projectId: 'p1' as ID,
    pictureN: 0,
    fileName: 'mat_x.wav',
    originalName: 'voice_v_1.wav',
    label: VOICEOVER_LABEL,
    kind: 'material',
    media: 'audio',
    refId: 'b1' as ID,
    createdAt: 0,
    ...p
  } as Asset
}

const withPack = () =>
  ent({ voicePack: { id: 'v_abc', desc: '低沉的男声', sample: 's.wav', seed: 11, text: 'x', fixedAt: 1 } })

describe('isVoiceover', () => {
  it('认标签', () => {
    expect(isVoiceover(audio())).toBe(true)
  })

  it('老数据没标签时按文件名认', () => {
    expect(isVoiceover(audio({ label: '参考音频' }))).toBe(true)
    expect(isVoiceover(audio({ label: '参考音频', originalName: '录音.wav' }))).toBe(false)
  })

  it('视频 / 关键帧不算', () => {
    expect(isVoiceover(audio({ media: 'video' }))).toBe(false)
    expect(isVoiceover(audio({ media: 'image', kind: 'keyframe' }))).toBe(false)
  })
})

describe('hasVoiceover', () => {
  it('按片段归属判定，不看别的镜头', () => {
    expect(hasVoiceover([audio()], 'b1' as ID)).toBe(true)
    expect(hasVoiceover([audio({ refId: 'b2' as ID })], 'b1' as ID)).toBe(false)
  })
})

describe('voiceoverCheck', () => {
  it('台词 + 说话人 + 固定音色，齐了才给 target', () => {
    const r = voiceoverCheck(beat(), new Map([['e1' as ID, withPack()]]))
    expect(r.target?.voiceId).toBe('v_abc')
    expect(r.target?.text).toBe('还有热的东西吗？')
    expect(r.target?.speaker.name).toBe('陈默')
    expect(r.reason).toBeNull()
  })

  it('非台词镜头不给配', () => {
    const r = voiceoverCheck(beat({ kind: 'action' }), new Map())
    expect(r.target).toBeNull()
    expect(r.reason).toContain('台词镜头')
  })

  it('没台词不给配', () => {
    const r = voiceoverCheck(beat({ dialogue: '  ' }), new Map([['e1' as ID, withPack()]]))
    expect(r.target).toBeNull()
    expect(r.reason).toContain('台词')
  })

  it('没选说话人 / 说话人没固定音色都明说原因', () => {
    expect(voiceoverCheck(beat(), new Map()).reason).toContain('说话人')
    const noPack = voiceoverCheck(beat(), new Map([['e1' as ID, ent()]]))
    expect(noPack.target).toBeNull()
    expect(noPack.reason).toContain('还没固定音色')
    // 提示要能直接指路，否则用户不知道该去哪儿
    expect(noPack.reason).toContain('主体')
  })
})

describe('needsVoiceSlot', () => {
  it('台词段有台词、还没有任何音频 → 自动给一格', () => {
    expect(needsVoiceSlot(beat(), [])).toBe(true)
  })

  it('已经有配音了 → 不再建', () => {
    expect(needsVoiceSlot(beat(), [audio()])).toBe(false)
  })

  it('已有的占位还在 → 别叠第二格', () => {
    expect(needsVoiceSlot(beat(), [audio({ draft: true })])).toBe(false)
  })

  it('只有参考音频（只借音色、不占时间轴）→ 仍然要建', () => {
    expect(needsVoiceSlot(beat(), [audio({ actAs: 'reference', label: '参考语音' })])).toBe(true)
  })

  it('用户删过（voiceSkipped）→ 不再建回来', () => {
    expect(needsVoiceSlot(beat({ voiceSkipped: true }), [])).toBe(false)
  })

  it('没写台词 / 不是台词段 → 不建', () => {
    expect(needsVoiceSlot(beat({ dialogue: '   ' }), [])).toBe(false)
    expect(needsVoiceSlot(beat({ kind: 'action' }), [])).toBe(false)
  })
})

describe('voiceoverQueue', () => {
  it('已配过的不再进队列（不覆盖用户调好的那条）', () => {
    const q = voiceoverQueue(
      [beat({ id: 'b1' as ID }), beat({ id: 'b2' as ID })],
      new Map([['e1' as ID, withPack()]]),
      [audio({ refId: 'b1' as ID })]
    )
    expect(q.voiced).toBe(1)
    expect(q.ready.map((t) => t.beat.id)).toEqual(['b2'])
  })

  it('动作段不算受阻，台词段缺音色才计入 blocked', () => {
    const q = voiceoverQueue(
      [
        beat({ id: 'b1' as ID, kind: 'action', dialogue: undefined }),
        beat({ id: 'b2' as ID }),
        beat({ id: 'b3' as ID, dialogue: '' })
      ],
      new Map([['e1' as ID, ent()]]),
      []
    )
    expect(q.ready.length).toBe(0)
    // b2 是台词段但有台词却没音色 → blocked；b3 台词为空也 blocked
    expect(q.blocked).toBe(2)
  })
})
