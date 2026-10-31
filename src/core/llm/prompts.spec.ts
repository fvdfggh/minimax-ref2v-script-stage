import { describe, expect, it } from 'vitest'
import {
  buildAssetPromptMessages,
  buildEntityExtractMessages,
  buildGlossaryMessages,
  buildKeyframePlanMessages,
  buildSegmentFillMessages,
  buildStage1Messages,
  buildStage2Messages,
  type KeyframePlanBeat
} from './prompts'
import { DEFAULT_FIELD_SCHEMA, DEFAULT_SETTINGS } from '@/domain/types'
import type { Asset, Beat, Entity, FieldSchema } from '@/domain/types'
import { composeSegmentText, deriveFields } from '@/domain/derive'

function beat(patch: Partial<Beat> & { title: string; kind: Beat['kind'] }): Beat {
  return {
    id: patch.id ?? patch.title,
    projectId: 'p',
    order: patch.order ?? 0,
    kind: patch.kind,
    title: patch.title,
    dialogue: patch.dialogue,
    entities: patch.entities ?? [],
    speakerId: patch.speakerId,
    focusEntityId: patch.focusEntityId,
    direction: patch.direction,
    visualDesc: patch.visualDesc,
    estFrames: patch.estFrames,
    manualFrames: patch.manualFrames ?? false,
    sceneId: patch.sceneId,
    locked: false,
    enriched: true,
    createdAt: 1,
    updatedAt: 1
  }
}

const chuci: Entity = {
  id: 'e1',
  projectId: 'p',
  name: '楚辞',
  type: 'character',
  kind: 'speaking',
  subjectN: 1,
  sx: 1,
  pictureN: 1,
  voiceDesc: 'speaking with a young male voice, tired but determined.',
  textDesc: 'dark robe',
  createdAt: 1,
  updatedAt: 1
}

const cave: Entity = {
  ...chuci,
  id: 'e2',
  name: '九幽毒渊',
  type: 'scene',
  kind: 'non_speaking',
  subjectN: 3,
  sx: null,
  pictureN: 5,
  voiceDesc: null,
  textDesc: 'misty cavern'
}

const ENTITIES = [chuci, cave]

const BEATS: Beat[] = [
  beat({ title: '预备镜头', kind: 'preshoot', entities: ['e1'], focusEntityId: 'e1', estFrames: 7, manualFrames: true }),
  beat({ title: '洞窟', kind: 'establishing', entities: ['e2'], focusEntityId: 'e2' }),
  beat({
    title: '台词',
    kind: 'dialogue',
    dialogue: '我不信这世上没有解药。',
    entities: ['e1'],
    speakerId: 'e1'
  })
]

const EXISTING = {
  subject_definitions: '<Subject 1> is 楚辞 in <Picture 1>, dark robe, speaking with ... (S1)',
  retention_analysis: '<Subject 1> (appears in [Shot 1]): fully_preserved - ...',
  detailed_description: '[Shot 1] At 00:00.000, Only 楚辞 is in frame, no dialogue, minimal motion.',
  summary: '',
  overall_soundscape: '',
  non_diegetic_music: ''
}

function build(schema: FieldSchema[] = DEFAULT_FIELD_SCHEMA) {
  return buildSegmentFillMessages({
    schema,
    groupBeats: BEATS,
    entities: ENTITIES,
    seamFromPrev: null,
    nextSeam: null,
    existing: EXISTING,
    segmentIndex: 2,
    segmentTotal: 7,
    frames: 141,
    fps: DEFAULT_SETTINGS.fps
  })
}

describe('阶段三：视频段字段补全提示词', () => {
  it('只请求 source === llm 的字段', () => {
    const [system, user] = build()
    const shape = system.content.slice(system.content.indexOf('输出 JSON 结构'))
    expect(shape).toContain('"summary"')
    expect(shape).toContain('"overall_soundscape"')
    expect(shape).toContain('"non_diegetic_music"')
    // 派生字段不能出现在要求生成的清单里
    expect(shape).not.toContain('"subject_definitions"')
    expect(shape).not.toContain('"retention_analysis"')
    expect(shape).not.toContain('"detailed_description"')
    expect(user.content).toContain('请只生成这些字段：summary、overall_soundscape、non_diegetic_music')
  })

  it('派生字段作为只读上下文给出，不让模型改', () => {
    const [system, user] = build()
    expect(user.content).toContain('<Subject 1> is 楚辞 in <Picture 1>')
    expect(user.content).toContain('[Shot 1] At 00:00.000')
    expect(system.content).toContain('只读上下文')
    expect(system.content).toContain('不要重复输出、不要改写')
  })

  it('summary 规则里写死了 [reference generation] 前缀要求', () => {
    const [system] = build()
    expect(system.content).toContain('[reference generation]')
  })

  it('带上了段信息、出场实体与参考图、镜头序列', () => {
    const [, user] = build()
    expect(user.content).toContain('第 3 / 7 段')
    expect(user.content).toContain('141 帧 = 5.875 秒')
    expect(user.content).toContain('<Picture 1>')
    expect(user.content).toContain('<Picture 5>')
    expect(user.content).toContain('[预备镜头]')
    expect(user.content).toContain('[台词]')
    expect(user.content).toContain('我不信这世上没有解药。')
    // 不说话实体不该多出一个空格
    expect(user.content).toContain('<Subject 3> 九幽毒渊')
  })

  it('字段 Schema 可自定义：改成全 manual 时不再请求任何字段', () => {
    const manualOnly = DEFAULT_FIELD_SCHEMA.map((f) => ({ ...f, source: 'manual' as const }))
    const [system, user] = build(manualOnly)
    expect(system.content).toContain('（没有需要生成的字段）')
    expect(user.content).toContain('请只生成这些字段：（无）')
  })

  it('自定义新增的 llm 字段会被自动纳入请求', () => {
    const extended: FieldSchema[] = [
      ...DEFAULT_FIELD_SCHEMA,
      {
        key: 'camera_notes',
        label: '镜头备注',
        order: 99,
        source: 'llm',
        promptHint: '一句话说明本段运镜意图',
        editable: true,
        required: false,
        lang: 'en'
      }
    ]
    const [system, user] = build(extended)
    expect(system.content).toContain('"camera_notes"')
    expect(system.content).toContain('一句话说明本段运镜意图')
    expect(user.content).toContain('camera_notes')
  })
})

/* ------------------------------------------------------------------ *
 * 分批：单次输出必须被限制住，上文必须回喂
 * ------------------------------------------------------------------ */

describe('阶段一：分批拆解', () => {
  const STORY = '第一段原文。\n\n第二段原文。'

  it('不传 batch 时保持原来的单批形态', () => {
    const [system, user] = buildStage1Messages(STORY, [])
    expect(system.content).not.toContain('分批进行')
    expect(system.content).not.toContain('分批规则')
    expect(user.content).toContain('请拆解以下故事')
    expect(user.content).not.toContain('本批原文')
  });

  it('★ 分批时显式告知批号、批数与原文段落范围', () => {
    const [system, user] = buildStage1Messages(STORY, [], {
      batch: { index: 3, total: 7, paraFrom: 21, paraTo: 30, paragraphCount: 10, contextTitles: [] }
    })
    expect(system.content).toContain('第 3 / 7 批')
    expect(user.content).toContain('第 21 ~ 30 段')
    expect(user.content).toContain('共 10 段')
    // 输入只包含本批原文，不是整篇
    expect(user.content).toContain('第二段原文。')
  })

  it('★ 上文末尾片段作为续接锚点回喂，且明确要求不要重复输出', () => {
    const [, user] = buildStage1Messages(STORY, ['楚辞', '老掌柜'], {
      batch: {
        index: 3,
        total: 7,
        paraFrom: 21,
        paraTo: 30,
        paragraphCount: 10,
        contextTitles: ['楚辞质问老掌柜', '老掌柜否认']
      }
    })
    expect(user.content).toContain('上文末尾片段')
    expect(user.content).toContain('- 楚辞质问老掌柜')
    expect(user.content).toContain('- 老掌柜否认')
    expect(user.content).toContain('不要重复输出')

    const [system] = buildStage1Messages(STORY, ['楚辞', '老掌柜'], {
      batch: { index: 3, total: 7, paraFrom: 21, paraTo: 30, paragraphCount: 10, contextTitles: ['x'] }
    })
    // 实体命名跨批一致 + 不要为了凑数而合并
    expect(system.content).toContain('实体命名必须与上文一致')
    expect(system.content).toContain('不要为了控制数量而合并动作或台词')
    expect(system.content).toContain('楚辞、老掌柜')
  })

  it('第一批说明自己是开头，不伪造上文', () => {
    const [, user] = buildStage1Messages(STORY, [], {
      batch: { index: 1, total: 7, paraFrom: 1, paraTo: 8, paragraphCount: 8, contextTitles: [] }
    })
    expect(user.content).toContain('本批是全片开头')
  })
})

describe('阶段一：拆细 + 台词拍不带动作', () => {
  const [system] = buildStage1Messages('故事', [])
  const text = system.content as string

  it('★ 台词拍只装「说」：说话前的动作必须先有自己的一拍', () => {
    expect(text).toContain('台词 Beat 只装「说」这一件事')
    expect(text).toContain('说话前该做的动作必须先有自己的一拍')
    expect(text).toContain('不许出现任何身体动作')
    // 给了正解与反例，别只写一句"要拆开"
    expect(text).toContain('林晚抬头看他，把找零推回去')
    expect(text).toContain('先动作，后台词，再后续动作')
  })

  it('★ 禁止用缝合词把动作缝进台词拍', () => {
    expect(text).toContain('一边…一边')
    expect(text).toContain('顺手')
  })

  it('★ 一句台词一个 dialogue Beat，且不许合并两句话', () => {
    expect(text).toContain('对应**一个** dialogue Beat')
    expect(text).toContain('不同的话不许并进同一拍')
  })

  it('★ 一个动作一拍：并列动词必须拆开', () => {
    expect(text).toContain('一个 Beat 只放一个动作')
    expect(text).toContain('陈默推门进来，环顾四周，走向柜台')
  })

  it('★ 输出前带自检清单（模型对"逐条打勾"更服从）', () => {
    expect(text).toContain('A2. 出结果前自检')
    expect(text).toContain('每个 dialogue Beat 的 title 里都没有身体动作')
    expect(text).toContain('原文每一句台词都对得上一个 dialogue Beat')
  })

  it('★ 用户回合也重申一次，别把关键约束只放系统提示里', () => {
    const [, user] = buildStage1Messages('故事', [])
    expect(user.content).toContain('台词拍只说话')
    expect(user.content).toContain('动作各自成拍')
  })

  it('★ 给「原文长度 → 片段数」的量化基准，防止模型按自己的预算压缩条数', () => {
    const [, user] = buildStage1Messages('一'.repeat(240), [])
    expect(user.content).toContain('约 240 字')
    expect(user.content).toContain('15~30 个片段')
    expect(user.content).toContain('就是拆粗了')
  })

  it('原文太短时不硬给篇幅参考，避免为了凑数而造片段', () => {
    const [, user] = buildStage1Messages('很短。', [])
    expect(user.content).not.toContain('篇幅参考')
  })
})

describe('阶段二：分批填充', () => {
  it('★ 台词拍的 visualDesc 不许写动作（否则就成了"一边动一边说"）', () => {
    const [system] = buildStage2Messages(BEATS, ENTITIES)
    expect(system.content).toContain('visualDesc 只写**说话这一瞬间**')
    expect(system.content).toContain('那些动作在这一拍之前的镜头里已经做完了')
    expect(system.content).toContain('也不要把听者的反应写进台词拍')
    // 非台词拍照常写动作，别一刀切
    expect(system.content).toContain('非台词 Beat 不受此限')
  })

  it('★ 分批时带上本批批号，并回喂上一批已填好的细节做风格锚点', () => {
    const [system, user] = buildStage2Messages(BEATS, ENTITIES, {
      batch: { index: 2, total: 5 },
      contextDetails: [
        { id: 'x', entities: ['e1'], focus: 'e1', direction: '中景，缓慢推近', visualDesc: '火光在脸上跳动' }
      ]
    })
    expect(system.content).toContain('第 2 / 5 批')
    expect(system.content).toContain('本批只输出下面列出的 Beat id')
    expect(user.content).toContain('上一批已填好的细节')
    expect(user.content).toContain('中景，缓慢推近')
    expect(user.content).toContain('第 2 / 5 批，共 3 个')
  });

  it('单批时不出现分批规则，也不塞上下文', () => {
    const [system, user] = buildStage2Messages(BEATS, ENTITIES)
    expect(system.content).not.toContain('分批进行')
    expect(system.content).not.toContain('本批只输出')
    expect(user.content).not.toContain('上一批已填好的细节')
  })
})

describe('阶段四：分批翻译词条', () => {
  it('★ 已定稿译名必须逐字复用，防止跨批译名漂移', () => {
    const [system, user] = buildGlossaryMessages({
      beats: [],
      entities: [chuci],
      fixedNames: { 老掌柜: 'Old Shopkeeper' },
      scopeLabel: '实体词条 2 / 4'
    })
    expect(system.content).toContain('实体词条 2 / 4')
    expect(system.content).toContain('已定稿译名')
    expect(user.content).toContain('老掌柜 → Old Shopkeeper')
    expect(user.content).toContain('必须逐字复用')
  })

  it('没有已定稿译名时不出现该区块', () => {
    const [, user] = buildGlossaryMessages({ beats: [], entities: [chuci] })
    expect(user.content).not.toContain('已定稿译名')
  })

  it('只传实体时不输出空的片段词条区块', () => {
    const [, user] = buildGlossaryMessages({ beats: [], entities: [chuci] })
    expect(user.content).toContain('【实体词条】')
    expect(user.content).not.toContain('【片段词条】')
  })
})

/* ------------------------------------------------------------------ *
 * 参考素材说明：供大模型读取（只读上下文），但不进最终生成的提示词
 * ------------------------------------------------------------------ */

describe('参考素材说明：供大模型读取，但不进最终提示词', () => {
  const DESC = '黑衣青年，撑着油纸伞，在雨中静立'
  const assets: Asset[] = [
    {
      id: 'a1',
      projectId: 'p',
      pictureN: 1,
      fileName: 'Picture1.png',
      originalName: 'c.png',
      label: '楚辞',
      kind: 'subject',
      desc: DESC,
      createdAt: 1
    },
    {
      id: 'a2',
      projectId: 'p',
      pictureN: 5,
      fileName: 'Picture5.png',
      originalName: 'd.png',
      label: '毒渊',
      kind: 'subject',
      desc: '雾气弥漫的洞窟，岩壁渗水',
      createdAt: 1
    }
  ]

  it('阶段二：素材说明作为只读上下文交给模型，并要求不写进输出字段', () => {
    const [system] = buildStage2Messages(BEATS, ENTITIES, { assets })
    expect(system.content).toContain(DESC)
    expect(system.content).toContain('<Picture 5>')
    expect(system.content).toContain('只读上下文')
    expect(system.content).toContain('写进任何输出字段')
  })

  it('阶段三：素材说明进入段补全的输入（供模型理解参考内容）', () => {
    const [, user] = buildSegmentFillMessages({
      schema: DEFAULT_FIELD_SCHEMA,
      groupBeats: BEATS,
      entities: ENTITIES,
      seamFromPrev: null,
      nextSeam: null,
      existing: EXISTING,
      segmentIndex: 2,
      segmentTotal: 7,
      frames: 141,
      fps: DEFAULT_SETTINGS.fps,
      assets
    })
    expect(user.content).toContain(DESC)
    expect(user.content).toContain('写进任何输出字段')
  })

  it('素材没有 desc 时，不生成素材说明块（不产生空块）', () => {
    const bare: Asset[] = [
      {
        id: 'a3',
        projectId: 'p',
        pictureN: 2,
        fileName: 'Picture2.png',
        originalName: 'e.png',
        label: 'x',
        kind: 'subject',
        createdAt: 1
      }
    ]
    const [system] = buildStage2Messages(BEATS, ENTITIES, { assets: bare })
    expect(system.content).not.toContain('参考素材说明')
  })

  it('★ 最终提示词（派生字段 + composeSegmentText）里绝不含素材说明', () => {
    const entityById = new Map(ENTITIES.map((e) => [e.id, e]))
    const fields = deriveFields(DEFAULT_FIELD_SCHEMA, BEATS, {}, {
      settings: DEFAULT_SETTINGS,
      entityById
    })
    const finalText = composeSegmentText(DEFAULT_FIELD_SCHEMA, fields)
    // 说明只作为「只读上下文」出现在模型输入里，绝不进入最终交付的提示词
    expect(finalText).not.toContain(DESC)
    expect(finalText).not.toContain('撑着油纸伞')
  })
})

describe('buildKeyframePlanMessages：AI 排关键帧', () => {
  const PLAN_BEATS: KeyframePlanBeat[] = [
    {
      index: 1,
      title: '林晚擦收银台',
      kind: '对白',
      frames: 24,
      fps: 24,
      direction: '固定机位，缓慢推近',
      visualDesc: '林晚第三遍擦收银台，抬头看向门口',
      dialogue: '又是你。',
      scene: '便利店门面',
      cast: ['林晚（24 岁，丸子头，便利店制服）'],
      existingFrames: [7, 12]
    },
    { index: 2, title: '推门进来', kind: '动作', frames: 36, fps: 24 }
  ]

  it('把帧数 / 已有帧 / 运镜 / 外观交给模型，并写明"一张够就放开场"', () => {
    const [system, user] = buildKeyframePlanMessages({ beats: PLAN_BEATS })
    // 位置规则：范围 + 默认开场 + 上限
    expect(system.content).toContain('0 到 frames-1')
    expect(system.content).toContain('放在开场（frame 0）')
    expect(system.content).toContain('最多 3 张')
    // 提示词必须是英文单帧画面，不能有文字水印
    expect(system.content).toContain('英文')
    expect(system.content).toContain('水印')
    expect(user.content).toContain('24 帧')
    expect(user.content).toContain('已有帧：7 / 12')
    expect(user.content).toContain('林晚（24 岁，丸子头，便利店制服）')
    expect(user.content).toContain('固定机位，缓慢推近')
    // 没给已有帧的段要写"无"，模型才不会以为漏了
    expect(user.content).toContain('已有帧：无')
  })

  it('每段张数上限跟着参数走', () => {
    const [system] = buildKeyframePlanMessages({ beats: PLAN_BEATS, maxPerBeat: 2 })
    expect(system.content).toContain('最多 2 张')
    expect(system.content).not.toContain('最多 3 张')
  })
})

describe('buildKeyframePlanMessages：给 AI 的补充要求', () => {
  const BEATS: KeyframePlanBeat[] = [
    { index: 1, title: '推门进来', kind: '动作', frames: 36, fps: 24 },
    { index: 2, title: '林晚抬头', kind: '对白', frames: 24, fps: 24 }
  ]

  it('原话交给模型，并说明它不能越过帧号范围与张数上限', () => {
    const [system, user] = buildKeyframePlanMessages({ beats: BEATS, note: '动作大的段多排两张，别给特写' })
    expect(user.content).toContain('【补充要求】动作大的段多排两张，别给特写')
    expect(system.content).toContain('不能改变 frame 范围与张数上限')
  })

  it('没填就不出现这一段，别给模型留一个空标题', () => {
    const [, user] = buildKeyframePlanMessages({ beats: BEATS, note: '   ' })
    expect(user.content).not.toContain('【补充要求】')
  })
})

describe('buildAssetPromptMessages：把一句要求写成提示词', () => {
  const base = {
    brief: '雨夜巷口，他回头看一眼',
    beat: {
      title: '回头',
      kind: '动作',
      frames: 36,
      fps: 24,
      direction: '手持跟拍',
      visualDesc: '陈默走进雨里',
      dialogue: '',
      scene: '老巷子 — 湿漉漉的青石板'
    },
    cast: ['Chen Mo（early thirties, short hair）'],
    refs: [{ pictureN: 3, name: 'Chen Mo', desc: 'early thirties, short hair' }],
    asReference: true
  }

  it('用户那句要求和段落上下文都交给模型', () => {
    const [, user] = buildAssetPromptMessages(base)
    expect(user.content).toContain('雨夜巷口，他回头看一眼')
    expect(user.content).toContain('手持跟拍')
    expect(user.content).toContain('湿漉漉的青石板')
    expect(user.content).toContain('Chen Mo（early thirties, short hair）')
    expect(user.content).toContain('36 帧')
  })

  it('参考方式：参考图写成 <Picture N> 名字 — 外观，并在正文要求里点名', () => {
    const [system, user] = buildAssetPromptMessages(base)
    expect(user.content).toContain('<Picture 3> Chen Mo — early thirties, short hair')
    expect(user.content).toContain('必须出现 <Picture N>')
    // 编号要贴着人名出现，否则模型会写成"陈默在 Picture 3 里"这种读不通的句子
    expect(system.content).toContain('在提到他的那一句开头')
  })

  it('关键帧方式：参考图只写名字与外观，不出现编号', () => {
    const [, user] = buildAssetPromptMessages({ ...base, asReference: false })
    expect(user.content).toContain('- Chen Mo — early thirties, short hair')
    expect(user.content).not.toContain('<Picture 3>')
    expect(user.content).not.toContain('必须出现 <Picture N>')
  })

  it('没有参考图时写"（无）"，别留空行让模型自己编一个人', () => {
    const [, user] = buildAssetPromptMessages({ ...base, refs: [] })
    expect(user.content).toContain('（无）')
  })

  it('硬性要求覆盖：英文单段、不写文字水印、不写元信息、16:9', () => {
    const [system] = buildAssetPromptMessages(base)
    expect(system.content).toContain('英文、单段')
    expect(system.content).toContain('水印')
    expect(system.content).toContain('第几帧')
    expect(system.content).toContain('16:9')
  })
})

/* ------------------------------------------------------------------ *
 * 拆解：外部项目（系列）主体作为上下文
 * ------------------------------------------------------------------ */

describe('阶段一：外部项目主体', () => {
  it('★ 带上项目层主体的设定，并要求按名字引用、不许重复定义', () => {
    const [system] = buildStage1Messages('故事', [], {
      projectSubjects: [
        {
          id: 'g1',
          name: '林医生',
          type: 'character',
          kind: 'speaking',
          textDesc: '短发，右眉一道旧疤',
          costumeDesc: '白大褂',
          voiceDesc: '低沉男声'
        }
      ]
    })
    expect(system.content).toContain('外部项目主体')
    expect(system.content).toContain('林医生')
    // 只有名字不够：长相 / 服装 / 音色都得在，模型才不会在本集重编一套
    expect(system.content).toContain('右眉一道旧疤')
    expect(system.content).toContain('白大褂')
    expect(system.content).toContain('低沉男声')
    expect(system.content).toContain('不要写进 newEntities')
  })

  it('项目层没有主体时，明确说明"先建空主体再拆解"', () => {
    const [system] = buildStage1Messages('故事', [])
    expect(system.content).toContain('外部项目暂无主体')
    expect(system.content).toContain('先在项目层建立一个空主体')
  })

  it('实体梳理同样带项目主体清单', () => {
    const [system] = buildEntityExtractMessages('故事', [], {
      projectSubjects: [{ name: '老宅正厅', type: 'scene', kind: 'non_speaking', textDesc: '斑驳的木梁' }]
    })
    expect(system.content).toContain('外部项目主体')
    expect(system.content).toContain('老宅正厅')
    expect(system.content).toContain('斑驳的木梁')
    // 场景的描述标签应是「环境」，不是「长相」
    expect(system.content).toContain('环境：斑驳的木梁')
  })
})
