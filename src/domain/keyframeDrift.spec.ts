import { describe, expect, it } from 'vitest'
import { driftedAssets, keyframeDrift } from './keyframeDrift'
import type { Asset } from './types'

function kf(patch: Partial<Asset> = {}): Asset {
  return {
    id: 'ast_1',
    projectId: 'p1',
    pictureN: 0,
    fileName: 'keyframe.png',
    originalName: 'keyframe.png',
    label: '关键帧',
    kind: 'keyframe',
    media: 'image',
    createdAt: 1,
    ...patch
  }
}

/** 当前这段的样子：模板提示词 + 台词 */
const now = (context: string, dialogue = '') => ({ context, dialogue })

describe('keyframeDrift：出图后文本改过就标失效', () => {
  it('提示词没变、台词没变：不报失效', () => {
    const a = kf({
      genContext: 'Cinematic film still. Setting: 便利店. Action: 擦柜台',
      genDialogue: '又是你。'
    })
    const d = keyframeDrift(a, now('Cinematic film still. Setting: 便利店. Action: 擦柜台', '又是你。'))
    expect(d).toMatchObject({ prompt: false, voice: false, any: false, known: true })
  })

  it('画面描述 / 场景 / 外观变了（模板提示词变）→ 提示词失效', () => {
    const a = kf({ genContext: 'Action: 擦柜台', genDialogue: '' })
    const d = keyframeDrift(a, now('Action: 抬头看向门口'))
    expect(d.prompt).toBe(true)
    expect(d.voice).toBe(false)
    expect(d.any).toBe(true)
    expect(d.text).toContain('画面提示词已变')
  })

  it('台词变了 → 语音文本失效（画面没动也算）', () => {
    const a = kf({ genContext: 'Action: 擦柜台', genDialogue: '又是你。' })
    const d = keyframeDrift(a, now('Action: 擦柜台', '这次换我问你。'))
    expect(d.prompt).toBe(false)
    expect(d.voice).toBe(true)
    expect(d.text).toContain('语音文本已变')
  })

  it('两个都变了：两句话都说出来', () => {
    const a = kf({ genContext: 'A', genDialogue: '旧台词' })
    const d = keyframeDrift(a, now('B', '新台词'))
    expect(d.prompt && d.voice).toBe(true)
    expect(d.text).toContain('画面提示词已变')
    expect(d.text).toContain('语音文本已变')
  })

  it('用户自己润色过提示词不算失效：比的是模板，不是整句', () => {
    // genPrompt 是手改后的句子，genContext 仍是模板 —— 模板没动就不报
    const a = kf({
      genPrompt: 'Cinematic film still. Action: 擦柜台. moody neon light',
      genContext: 'Action: 擦柜台',
      genDialogue: '又是你。'
    })
    expect(keyframeDrift(a, now('Action: 擦柜台', '又是你。')).any).toBe(false)
  })

  it('只多了空格 / 换行不算改：中文台词按句断行很常见', () => {
    const a = kf({ genContext: 'Action: 擦柜台', genDialogue: '又是你。\n这次换我问你。' })
    // 模板多打了几个空格、台词从换行变成空格：内容没变，不该报
    const d = keyframeDrift(a, now('Action:   擦柜台', '又是你。 这次换我问你。'))
    expect(d.any).toBe(false)
  })

  it('没有溯源（上传的图 / 早期老数据）：不报失效，也不谎称"已核对"', () => {
    const d = keyframeDrift(kf({ genDialogue: '旧台词' }), now('随便什么', '新台词'))
    // 只补了台词快照：单调判定台词
    expect(d.prompt).toBe(false)
    expect(d.voice).toBe(true)

    const legacy = keyframeDrift(kf(), now('随便什么', '新台词'))
    expect(legacy).toMatchObject({ any: false, known: false, text: '' })
  })

  it('非关键帧（音视频素材）不参与判定', () => {
    const audio = kf({ kind: 'material', media: 'audio', genContext: 'A', genDialogue: '旧' })
    expect(keyframeDrift(audio, now('B', '新')).any).toBe(false)
  })

  it('driftedAssets 只挑失效的那些', () => {
    const list = [
      kf({ id: 'a', genContext: 'A', genDialogue: '' }),
      kf({ id: 'b', genContext: 'B', genDialogue: '' }),
      kf({ id: 'c' })
    ]
    expect(driftedAssets(list, now('A', '')).map((a) => a.id)).toEqual(['b'])
  })
})
