import { describe, expect, it } from 'vitest'
import {
  buildBeatSplitMessages,
  buildBeatWriteMessages,
  buildEntityWriteMessages,
  type BeatWriteInput,
  type EntityWriteInput
} from './assist'

const beatInput: BeatWriteInput = {
  field: 'visualDesc',
  beat: {
    title: '林晚把硬币推回去',
    kind: 'action',
    frames: 36,
    fps: 24,
    current: '林晚抬头看了他一眼'
  },
  scene: '便利店 夜',
  cast: [{ name: '林晚', look: '短发，眼下有一颗痣', costume: '藏青针织衫', pictureN: 2 }],
  prevTitle: '陈默推门进来',
  nextTitle: '林晚回应',
  language: 'zh'
}

function text(messages: Array<{ content: string }>): string {
  return messages.map((m) => m.content).join('\n')
}

describe('单点助手：一拍的镜头 / 画面', () => {
  it('镜头描述只写机位语言，明确禁止写动作与台词', () => {
    const t = text(buildBeatWriteMessages({ ...beatInput, field: 'direction' }))
    expect(t).toContain('只写机位语言')
    expect(t).toContain('一次只给一个运镜')
    expect(t).toContain('不写动作、表情、台词')
    // 台词拍要提示用固定机位，避免口型对不上
    expect(t).toContain('口型')
  })

  it('画面描述禁止把说话前的动作写进台词拍', () => {
    const t = text(
      buildBeatWriteMessages({
        ...beatInput,
        field: 'visualDesc',
        beat: { ...beatInput.beat, kind: 'dialogue', dialogue: '你每次都这么说' }
      })
    )
    expect(t).toContain('说话这一瞬间')
    expect(t).toContain('不许写说话前的动作')
    expect(t).toContain('一拍只写一个动作')
  })

  it('输出只要一项内容：禁止前缀 / 引号 / JSON', () => {
    const t = text(buildBeatWriteMessages(beatInput))
    expect(t).toContain('只输出改写后的这一项内容')
    expect(t).toContain('不要标题、不要引号')
  })

  it('把当前写法当起点，而不是从零重写', () => {
    const t = text(buildBeatWriteMessages(beatInput))
    expect(t).toContain('【当前写法】林晚抬头看了他一眼')
    expect(t).toContain('在它基础上改')
  })

  it('用户那句要求会原样进提示词；没给就不出现这一段', () => {
    const withReq = text(buildBeatWriteMessages({ ...beatInput, requirement: '只写手部特写' }))
    expect(withReq).toContain('【我的要求】只写手部特写')
    expect(text(buildBeatWriteMessages(beatInput))).not.toContain('【我的要求】')
  })

  it('出场角色带上长相与服装，避免跨拍换一身衣服', () => {
    const t = text(buildBeatWriteMessages(beatInput))
    expect(t).toContain('林晚（<Picture 2>）')
    expect(t).toContain('长相：短发，眼下有一颗痣')
    expect(t).toContain('服装：藏青针织衫')
  })
})

describe('单点助手：把一拍拆细', () => {
  const input = {
    beat: {
      title: '林晚抬头看他，把找零推回去',
      kind: 'action',
      frames: 72,
      fps: 24,
      visualDesc: '林晚抬头看了他一眼'
    },
    scene: '便利店 夜',
    language: 'zh' as const
  }

  it('限定 2~4 拍，并给出拆的判据', () => {
    const t = text(buildBeatSplitMessages(input))
    expect(t).toContain('只输出 2~4 拍')
    expect(t).toContain('两个以上的动作')
    expect(t).toContain('台词拍里带着说话前的动作')
  })

  it('台词不许改字、不许拆断', () => {
    const t = text(buildBeatSplitMessages(input))
    expect(t).toContain('台词必须')
    expect(t).toContain('不许改字')
    expect(t).toContain('不许断句')
  })

  it('要求 weight 有判断，不许全填一样', () => {
    const t = text(buildBeatSplitMessages(input))
    expect(t).toContain('相对时长')
    expect(t).toContain('不要把 weight 全填成一样')
  })

  it('kind 只允许四种，且不新增剧情', () => {
    const t = text(buildBeatSplitMessages(input))
    expect(t).toContain('action、dialogue、reaction、insert')
    expect(t).toContain('不新增原文没有的人物')
  })
})

describe('单点助手：主体的描述字段', () => {
  const base: EntityWriteInput = {
    field: 'textDesc',
    entity: {
      name: '陈默',
      type: 'character',
      kind: 'speaking',
      textDesc: '三十岁上下，脸瘦，下颌线明显',
      voiceDesc: '青年男声，偏低'
    },
    storyExcerpt: '陈默推门进来，外套湿透。',
    peers: ['林晚', '老周'],
    language: 'zh'
  }

  it('长相：绝对不许写穿着，且要点名去哪写', () => {
    const t = text(buildEntityWriteMessages(base))
    expect(t).toContain('绝对不许写穿着')
    expect(t).toContain('服装与身形')
  })

  it('服装：不重复长相、不写只属于某一拍的状态', () => {
    const t = text(buildEntityWriteMessages({ ...base, field: 'costumeDesc' }))
    expect(t).toContain('不重复长相')
    expect(t).toContain('不要写"雨淋湿了"')
  })

  it('音色：给的是音色描述，不是台词或性格分析', () => {
    const t = text(buildEntityWriteMessages({ ...base, field: 'voiceDesc' }))
    expect(t).toContain('不是台词、不是性格分析')
    expect(t).toContain('年龄与性别')
    expect(t).toContain('音色是固定的，情绪属于某一拍')
  })

  it('原文片段与同项目其他主体都会进上下文', () => {
    const t = text(buildEntityWriteMessages(base))
    expect(t).toContain('陈默推门进来，外套湿透。')
    expect(t).toContain('林晚')
    expect(t).toContain('【当前写法】三十岁上下，脸瘦，下颌线明显')
  })
})
