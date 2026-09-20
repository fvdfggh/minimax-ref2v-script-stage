import { describe, expect, it } from 'vitest'
import {
  buildGlossaryMessages,
  buildSegmentFillMessages,
  buildStage1Messages,
  buildStage2Messages
} from './prompts'
import { DEFAULT_FIELD_SCHEMA, DEFAULT_SETTINGS } from '@/domain/types'
import type { Beat, Entity, FieldSchema } from '@/domain/types'

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

describe('阶段二：分批填充', () => {
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

describe('阶段五：分批翻译词条', () => {
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
