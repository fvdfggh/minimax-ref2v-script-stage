/**
 * 生成一个「开箱可用」的单集测试剧本：夜班便利店
 *
 * 为什么是脚本而不是手点：
 *   一个能跑通全流程的集，需要 5 个主体/场景实体、16 个片段、1 个组合方案、
 *   7 张参考图、4 段的模型字段，还要让段内容指纹与前端算出来的完全一致
 *   （否则每段都会显示「上游已改、需要重新生成」）。
 *
 *   所以这里不手抄数据，而是直接 import 真实的领域函数：
 *     computeNumbering / analyzeSeam / materializeSegment / fitSegmentFrames
 *     buildPad / deriveFields / validateSegment / segmentSourceHash
 *   脚本算出来的东西 = 前端渲染时算出来的东西。
 *
 * 用法：
 *   npx vite-node scripts/seed-demo-episode.ts
 *   STAGE_BACKEND=http://127.0.0.1:8787 npx vite-node scripts/seed-demo-episode.ts
 */

import { deflateSync } from 'node:zlib'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_FIELD_SCHEMA, DEFAULT_SETTINGS } from '@/domain/types'
import type {
  Assembly,
  Asset,
  Beat,
  BeatKind,
  Entity,
  FieldSchema,
  Group,
  Project,
  ProjectSettings
} from '@/domain/types'
import { applyNumbering, computeNumbering } from '@/domain/registry'
import { defaultStrategy } from '@/domain/assembler'
import { analyzeSeam, materializeSegment } from '@/domain/seam'
import { segmentSourceHash } from '@/domain/cascade'
import { buildPad, fitSegmentFrames, resolveRefPrev, sumPaddedFrames } from '@/domain/frames'
import { deriveFields, makeSeeders } from '@/domain/derive'
import { validateSegment } from '@/domain/rules'
import { dialogueFrames } from '@/domain/timing'

const BASE = process.env.STAGE_BACKEND || 'http://127.0.0.1:8787'
const API = `${BASE}/api`

const SERIES_ID = 'srs_demo_nightshift'
const EPISODE_ID = 'epi_demo_nightshift'
const ASSEMBLY_ID = 'asm_demo_nightshift'

const ENT = {
  chen: 'ent_demo_chen',
  lin: 'ent_demo_lin',
  ticket: 'ent_demo_ticket',
  store: 'ent_demo_storefront',
  street: 'ent_demo_street'
} as const

const TS = Date.now()

/* ------------------------------------------------------------------ *
 * 1. 剧本内容
 * ------------------------------------------------------------------ */

const STORY = `凌晨两点十七分，雨把整条街洗得发亮。便利店的自动门坏了三天，林晚用一把塑料椅顶着门框。

她今晚第三遍擦收银台。擦到第三个来回时，门被推开，一个浑身湿透的男人走了进来。他把雨水带进店里，也带进来一股旧报纸的味道。

「还有热的东西吗？」他问。

林晚抬头。男人的头发贴在额头上，左手手背上有一道很旧的疤。她指了指角落的保温柜：「关东煮还剩两串。」

男人走过去，弯腰的动作很慢，像在数每一格。他拿起纸杯，只夹了一串，另一串留在汤里冒热气。

「就要这个。」他说。

林晚递给他一张纸巾。他没接，从风衣口袋里摸出一张对折过很多次的纸片——一张泛黄的车票，边角已经磨软。

「三年前，也是这个点。」他把车票放在台面上，指尖没有松开。

林晚认得那种沉默。她在这里上了两年夜班，见过太多在凌晨两点不肯回家的人。

「你等的人，来了吗？」

男人没回答。他端着纸杯走到门口，站在雨檐下，看向街对面。路灯下空无一人，只有积水一直在动。

他把车票折回口袋，咬了一口已经凉掉的关东煮。远处传来第一班公交的报站声。

「没来。」他说，声音轻得像在跟自己说话。`

function entity(patch: Partial<Entity> & { id: string; name: string }): Entity {
  return {
    id: patch.id,
    projectId: EPISODE_ID,
    name: patch.name,
    type: patch.type ?? 'character',
    kind: patch.kind ?? 'non_speaking',
    subjectN: null,
    sx: null,
    pictureN: patch.pictureN ?? null,
    voiceDesc: patch.voiceDesc ?? null,
    textDesc: patch.textDesc ?? null,
    nameEn: patch.nameEn ?? null,
    voiceDescEn: patch.voiceDescEn ?? null,
    textDescEn: patch.textDescEn ?? null,
    note: patch.note,
    createdAt: TS,
    updatedAt: TS
  }
}

const RAW_ENTITIES: Entity[] = [
  entity({
    id: ENT.chen,
    name: '陈默',
    kind: 'speaking',
    pictureN: 1,
    voiceDesc: '低沉克制的男声，语速慢，句尾几乎没有起伏。',
    textDesc: '三十岁上下的男性，深灰色连帽风衣，湿发贴在额前，左手手背上有一道很旧的疤。',
    nameEn: 'Chen Mo',
    voiceDescEn: 'A low, restrained male voice, slow and steady, with almost no lift at the end of sentences.',
    textDescEn:
      'A man in his early thirties in a dark grey hooded trench coat, wet hair flat on his forehead, an old scar across the back of his left hand.'
  }),
  entity({
    id: ENT.lin,
    name: '林晚',
    kind: 'speaking',
    pictureN: 2,
    voiceDesc: '清亮偏沙哑的年轻女声，语速快，尾音略微上扬。',
    textDesc: '二十四岁女性，扎马尾，穿蓝色工作围裙，胸前别着一枚褪色的工牌。',
    nameEn: 'Lin Wan',
    voiceDescEn: 'A bright, slightly husky young female voice, speaking fast with a light upward lilt at the end.',
    textDescEn:
      'A 24-year-old woman with a ponytail, wearing a blue work apron and a faded name tag on her chest.'
  }),
  entity({
    id: ENT.ticket,
    name: '旧车票',
    type: 'prop',
    kind: 'non_speaking',
    pictureN: 3,
    textDesc: '泛黄的硬纸车票，边缘磨得发软，票面印着 2003-11-07 23:40 和模糊的站名。',
    nameEn: 'Old Bus Ticket',
    textDescEn:
      'A yellowed hard-paper bus ticket with softened edges, printed with 2003-11-07 23:40 and a blurred station name.'
  }),
  entity({
    id: ENT.store,
    name: '便利店门面',
    type: 'scene',
    kind: 'non_speaking',
    pictureN: 4,
    textDesc: '深夜街角的便利店外景，24H 霓虹招牌，玻璃门里透出暖光，雨水顺着玻璃往下流。',
    nameEn: 'Convenience Store Front',
    textDescEn:
      'A corner convenience store at night, a glowing 24H neon sign, warm light behind the glass door, rain running down the pane.'
  }),
  entity({
    id: ENT.street,
    name: '店门外街道',
    type: 'scene',
    kind: 'non_speaking',
    pictureN: 5,
    textDesc: '雨夜的街道，对面只有一盏昏黄路灯，人行道积着水，空无一人。',
    nameEn: 'Street Outside the Store',
    textDescEn:
      'A rainy street at night, a single dim yellow streetlight on the far side, water standing on the empty sidewalk.'
  })
]

interface BeatSeed {
  b: BeatKind
  title: string
  titleEn: string
  sceneId: string
  entities?: string[]
  speakerId?: string
  focusEntityId?: string
  dialogue?: string
  direction: string
  directionEn: string
  visualDesc: string
  visualDescEn: string
}

const BEAT_SEEDS: BeatSeed[] = [
  {
    b: 'establishing',
    title: '雨夜便利店外景',
    titleEn: 'Rainy night outside the store',
    sceneId: ENT.store,
    focusEntityId: ENT.store,
    direction: '固定机位，缓慢推近',
    directionEn: 'Locked-off wide shot, slow push in',
    visualDesc: '雨幕中的街角便利店，24H 霓虹在积水里晃；玻璃门上贴着一张褪色的促销海报。',
    visualDescEn:
      'A corner convenience store in heavy rain; the 24H neon trembles in the standing water; a faded promo poster is taped to the glass door.'
  },
  {
    b: 'action',
    title: '林晚擦收银台',
    titleEn: 'Lin Wan wiping the counter',
    sceneId: ENT.store,
    entities: [ENT.lin],
    focusEntityId: ENT.lin,
    direction: '中景，固定',
    directionEn: 'Medium shot, static',
    visualDesc: '林晚低着头，用抹布一遍遍擦同一块台面，蓝色围裙上有一点汤渍。',
    visualDescEn: 'Lin Wan keeps wiping the same patch of counter, a soup stain on her blue apron.'
  },
  {
    b: 'dialogue',
    title: '陈默推门进来',
    titleEn: 'Chen Mo pushes the door open',
    sceneId: ENT.store,
    entities: [ENT.chen],
    speakerId: ENT.chen,
    focusEntityId: ENT.chen,
    dialogue: '还有热的东西吗？',
    direction: '过肩中景，随开门动作轻微后拉',
    directionEn: 'Over-the-shoulder medium shot, slight pull-back as the door opens',
    visualDesc: '陈默浑身湿透站在门口，雨水顺着帽檐往下滴，在脚边积成一小片。',
    visualDescEn:
      'Chen Mo stands soaked in the doorway, rain dripping from his hood, a small puddle forming at his feet.'
  },
  {
    b: 'reaction',
    title: '林晚抬头',
    titleEn: 'Lin Wan looks up',
    sceneId: ENT.store,
    entities: [ENT.lin],
    focusEntityId: ENT.lin,
    direction: '近景，微仰角',
    directionEn: 'Close-up, slight low angle',
    visualDesc: '林晚抬眼，视线从台面移到门口，手里的抹布停在半空。',
    visualDescEn: 'Lin Wan lifts her eyes from the counter to the door, the rag frozen mid-air.'
  },
  {
    b: 'dialogue',
    title: '林晚指向保温柜',
    titleEn: 'Lin Wan points to the warmer',
    sceneId: ENT.store,
    entities: [ENT.lin],
    speakerId: ENT.lin,
    focusEntityId: ENT.lin,
    dialogue: '关东煮还剩两串。',
    direction: '中近景，带手部指向',
    directionEn: 'Medium close-up with the pointing hand in frame',
    visualDesc: '林晚用下巴示意角落的保温柜，柜里的汤还在轻轻翻泡。',
    visualDescEn: 'Lin Wan tilts her chin toward the warmer in the corner, the broth still bubbling.'
  },
  {
    b: 'action',
    title: '陈默走向保温柜',
    titleEn: 'Chen Mo walks to the warmer',
    sceneId: ENT.store,
    entities: [ENT.chen],
    focusEntityId: ENT.chen,
    direction: '侧跟，缓慢横移',
    directionEn: 'Side tracking shot, slow lateral move',
    visualDesc: '陈默把帽檐往后一推，沿着货架走向角落，鞋底在地砖上留下水痕。',
    visualDescEn:
      'Chen Mo pushes his hood back and walks past the shelves, wet footprints trailing on the tile.'
  },
  {
    b: 'insert',
    title: '关东煮冒热气',
    titleEn: 'Steam over the warmer',
    sceneId: ENT.store,
    focusEntityId: ENT.store,
    direction: '特写，固定',
    directionEn: 'Close-up, static',
    visualDesc: '保温柜格子里只剩两串，一根竹签斜靠着格壁，热气在灯下泛白。',
    visualDescEn:
      'Only two skewers are left in the warmer; one leans against the divider, steam whitening under the lamp.'
  },
  {
    b: 'dialogue',
    title: '陈默拿起纸杯',
    titleEn: 'Chen Mo takes a paper cup',
    sceneId: ENT.store,
    entities: [ENT.chen],
    speakerId: ENT.chen,
    focusEntityId: ENT.chen,
    dialogue: '就要这个。',
    direction: '近景，略俯视',
    directionEn: 'Close-up, slight high angle',
    visualDesc: '陈默捏着纸杯边缘，另一只手把竹签往里推了推。',
    visualDescEn:
      'Chen Mo pinches the rim of a paper cup and pushes the skewer down with his other hand.'
  },
  {
    b: 'reaction',
    title: '林晚递纸巾',
    titleEn: 'Lin Wan offers a napkin',
    sceneId: ENT.store,
    entities: [ENT.lin],
    focusEntityId: ENT.lin,
    direction: '近景，浅景深',
    directionEn: 'Close-up, shallow depth of field',
    visualDesc: '林晚从抽屉里抽出一张纸巾递过去，手臂停在两人之间的空气里。',
    visualDescEn:
      'Lin Wan pulls a napkin from the drawer and holds it out, her arm stopped in the air between them.'
  },
  {
    b: 'insert',
    title: '陈默掏出旧车票',
    titleEn: 'Chen Mo takes out an old ticket',
    sceneId: ENT.store,
    entities: [ENT.ticket],
    focusEntityId: ENT.ticket,
    direction: '大特写，手部为主',
    directionEn: 'Extreme close-up, hands only',
    visualDesc: '一张对折过很多次的泛黄车票被摊在台面上，边角磨得起了毛。',
    visualDescEn:
      'A yellowed bus ticket, folded many times, is flattened on the counter, its corners worn fuzzy.'
  },
  {
    b: 'dialogue',
    title: '陈默低声开口',
    titleEn: 'Chen Mo speaks quietly',
    sceneId: ENT.store,
    entities: [ENT.chen],
    speakerId: ENT.chen,
    focusEntityId: ENT.chen,
    dialogue: '三年前，也是这个点。',
    direction: '近景，正面，略低角度',
    directionEn: 'Close-up, frontal, slightly low angle',
    visualDesc: '陈默的视线落在车票上，喉结动了一下，没有抬头。',
    visualDescEn:
      'Chen Mo looks down at the ticket, his throat moving once, without raising his head.'
  },
  {
    b: 'dialogue',
    title: '林晚问',
    titleEn: 'Lin Wan asks',
    sceneId: ENT.store,
    entities: [ENT.lin],
    speakerId: ENT.lin,
    focusEntityId: ENT.lin,
    dialogue: '你等的人，来了吗？',
    direction: '过肩近景，林晚在前景',
    directionEn: 'Over-the-shoulder close-up, Lin Wan in the foreground',
    visualDesc: '林晚把手收回围裙口袋，声音比刚才轻。',
    visualDescEn: 'Lin Wan tucks her hand into her apron pocket, her voice softer than before.'
  },
  {
    b: 'scene_switch',
    title: '切到店门外',
    titleEn: 'Cut to outside the door',
    sceneId: ENT.street,
    focusEntityId: ENT.street,
    direction: '固定全景，硬切',
    directionEn: 'Locked-off wide shot, hard cut',
    visualDesc: '雨檐外，街面被雨点砸出细碎的白点。',
    visualDescEn:
      'Under the awning outside, the rain breaks into fine white points on the pavement.'
  },
  {
    b: 'action',
    title: '陈默站在雨檐下',
    titleEn: 'Chen Mo stands under the awning',
    sceneId: ENT.street,
    entities: [ENT.chen],
    focusEntityId: ENT.chen,
    direction: '中景，背后跟拍',
    directionEn: 'Medium shot, following from behind',
    visualDesc: '陈默端着纸杯站在雨檐边缘，风衣下摆被打湿，肩膀一动不动。',
    visualDescEn:
      'Chen Mo stands at the edge of the awning with the paper cup, his coat hem soaked, shoulders still.'
  },
  {
    b: 'establishing',
    title: '街对面空无一人',
    titleEn: 'The street across is empty',
    sceneId: ENT.street,
    focusEntityId: ENT.street,
    direction: '大远景，固定',
    directionEn: 'Extreme wide shot, static',
    visualDesc: '对面只有一盏昏黄的路灯，灯下的人行道空着，积水一直在动。',
    visualDescEn:
      'Only one dim streetlight across the road; the sidewalk beneath it is empty, the puddles keep moving.'
  },
  {
    b: 'action',
    title: '陈默折起车票',
    titleEn: 'Chen Mo folds the ticket away',
    sceneId: ENT.street,
    entities: [ENT.chen],
    focusEntityId: ENT.chen,
    direction: '近景，手部与侧脸同框',
    directionEn: 'Close-up, hand and profile in one frame',
    visualDesc: '陈默把车票沿旧折痕折回去，塞进风衣内袋，咬了一口已经凉掉的关东煮。',
    visualDescEn:
      'Chen Mo folds the ticket along its old creases, slides it into an inside pocket, and bites into the cold skewer.'
  }
]

function buildBeats(): Beat[] {
  return BEAT_SEEDS.map((s, i) => ({
    id: `beat_demo_${String(i + 1).padStart(2, '0')}`,
    projectId: EPISODE_ID,
    order: i,
    kind: s.b,
    title: s.title,
    titleEn: s.titleEn,
    dialogue: s.dialogue,
    entities: s.entities ?? [],
    speakerId: s.speakerId,
    focusEntityId: s.focusEntityId,
    direction: s.direction,
    directionEn: s.directionEn,
    visualDesc: s.visualDesc,
    visualDescEn: s.visualDescEn,
    estFrames: undefined,
    manualFrames: false,
    sceneId: s.sceneId,
    locked: false,
    enriched: true,
    createdAt: TS + i,
    updatedAt: TS + i
  }))
}

/* ------------------------------------------------------------------ *
 * 2. 段字段（模型字段：脚本里直接写成"已生成"的内容）
 * ------------------------------------------------------------------ */

const SEGMENT_COPY = [
  {
    summary:
      '[reference generation] A rainy night outside a corner convenience store. <Subject 2> keeps wiping the counter while <Subject 1> pushes in through the broken automatic door, soaked from head to boots.',
    soundscape:
      'Steady rain drumming on the awning, the low hum of a refrigerator, wet footsteps, and a plastic chair scraping once on tile.',
    music: 'N/A'
  },
  {
    summary:
      '[reference generation] <Subject 1> walks to the warmer while <Subject 2> points the way; steam rises off the last two skewers as he picks one and she offers him a napkin.',
    soundscape:
      'Broth simmering in the warmer, the click of a paper cup being peeled apart, rain muffled behind glass.',
    music: 'Sparse solo piano, slow, one note at a time.'
  },
  {
    summary:
      '[reference generation] <Subject 1> lays a yellowed <Subject 3> on the counter and says it was the same hour three years ago; <Subject 2> asks whether the person he waits for ever came.',
    soundscape:
      'Paper unfolding, the counter fan ticking, rain filling the silence between two lines of dialogue.',
    music: 'N/A'
  },
  {
    summary:
      '[reference generation] Outside under the awning, <Subject 1> looks across the empty street; a single streetlight burns over an empty sidewalk and no one is there.',
    soundscape:
      'Rain on the pavement, a bus announcement far down the road, one wet footstep shifting on concrete.',
    music: 'Low sustained strings that fade out before the bus announcement.'
  }
]

const GROUP_SPANS: Array<[number, number]> = [
  [1, 4],
  [5, 9],
  [10, 12],
  [13, 16]
]

/* ------------------------------------------------------------------ *
 * 3. 用真实领域函数推导：编号 / 分组 / 指纹 / 派生字段 / 校验
 * ------------------------------------------------------------------ */

const settings: ProjectSettings = { ...DEFAULT_SETTINGS }
const schema: FieldSchema[] = structuredClone(DEFAULT_FIELD_SCHEMA)

const beats = buildBeats()
const entities = applyNumbering(RAW_ENTITIES, computeNumbering(RAW_ENTITIES, beats))
const entityById = new Map(entities.map((e) => [e.id, e]))

const groups: Group[] = GROUP_SPANS.map(([from, to], i) => ({
  id: `grp_demo_${i + 1}`,
  beatIds: beats.filter((b) => b.order + 1 >= from && b.order + 1 <= to).map((b) => b.id),
  refPrev: i > 0
}))

const assembly: Assembly = {
  id: ASSEMBLY_ID,
  projectId: EPISODE_ID,
  name: '主方案（16 片段 / 4 段）',
  strategy: defaultStrategy(settings, 'fill_max'),
  groups,
  createdAt: TS,
  updatedAt: TS
}

const byId = new Map(beats.map((b) => [b.id, b]))
const narratives = groups.map((g) => g.beatIds.map((id) => byId.get(id)!))
const seams = narratives.map((n, i) =>
  i === 0 ? null : analyzeSeam(narratives[i - 1], n, { settings, entityById })
)

interface BuiltSegment {
  group: Group
  material: ReturnType<typeof materializeSegment>
  frames: number
  fields: Record<string, string>
  hash: string
  issues: ReturnType<typeof validateSegment>
}

const seeder = makeSeeders(entityById, settings.workLanguage)

const built: BuiltSegment[] = narratives.map((narrative, i) => {
  const group = groups[i]
  const seam = seams[i]
  const nextSeam = i + 1 < seams.length ? seams[i + 1] : null
  const material = materializeSegment(narrative, nextSeam, { settings, entityById })
  const refPrev = resolveRefPrev(group, i)
  const floorFrames = narrative
    .filter((b) => b.kind === 'dialogue')
    .reduce((s, b) => s + dialogueFrames(b.dialogue, settings.fps), 0)
  const fit = fitSegmentFrames(material.frames, refPrev, settings.maxSegmentFrames, floorFrames)
  const pad = buildPad({ all: material.beats, padTotal: fit.padTotal, settings })
  const frames = sumPaddedFrames(material.beats, settings, pad)
  const copy = SEGMENT_COPY[i]
  const bag: Record<string, string> = {
    summary: copy.summary,
    overall_soundscape: copy.soundscape,
    non_diegetic_music: copy.music
  }
  const fields = deriveFields(schema, material.beats, bag, {
    settings,
    entityById,
    seeder,
    pad
  })
  const issues = validateSegment(
    { beats: material.beats, narrativeBeats: narrative, fields, seam, nextSeam, refPrev, pad },
    { settings, entityById, schema }
  )
  return {
    group,
    material,
    frames,
    fields,
    hash: segmentSourceHash(material.beats, entities),
    issues
  }
})

/* ------------------------------------------------------------------ *
 * 4. 参考图 / 场景图（纯代码画 PNG，不依赖任何图形库）
 * ------------------------------------------------------------------ */

type RGB = [number, number, number]

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Canvas {
  readonly data: Uint8Array

  constructor(
    readonly w: number,
    readonly h: number
  ) {
    this.data = new Uint8Array(w * h * 3)
  }

  private blend(x: number, y: number, c: RGB, a: number): void {
    const xi = x | 0
    const yi = y | 0
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return
    const i = (yi * this.w + xi) * 3
    const k = Math.max(0, Math.min(1, a))
    this.data[i] = this.data[i] * (1 - k) + c[0] * k
    this.data[i + 1] = this.data[i + 1] * (1 - k) + c[1] * k
    this.data[i + 2] = this.data[i + 2] * (1 - k) + c[2] * k
  }

  vgrad(top: RGB, bottom: RGB): void {
    for (let y = 0; y < this.h; y++) {
      const t = y / Math.max(1, this.h - 1)
      const c: RGB = [
        top[0] + (bottom[0] - top[0]) * t,
        top[1] + (bottom[1] - top[1]) * t,
        top[2] + (bottom[2] - top[2]) * t
      ]
      for (let x = 0; x < this.w; x++) this.blend(x, y, c, 1)
    }
  }

  rect(x0: number, y0: number, x1: number, y1: number, c: RGB, a = 1): void {
    for (let y = Math.max(0, y0); y < Math.min(this.h, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(this.w, x1); x++) this.blend(x, y, c, a)
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, a = 1): void {
    for (let y = Math.max(0, cy - ry); y < Math.min(this.h, cy + ry); y++) {
      for (let x = Math.max(0, cx - rx); x < Math.min(this.w, cx + rx); x++) {
        const dx = (x - cx) / rx
        const dy = (y - cy) / ry
        if (dx * dx + dy * dy <= 1) this.blend(x, y, c, a)
      }
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, c: RGB, width = 1, a = 1): void {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const x = x0 + (x1 - x0) * t
      const y = y0 + (y1 - y0) * t
      this.ellipse(x, y, width, width, c, a)
    }
  }

  poly(points: Array<[number, number]>, c: RGB, a = 1): void {
    const ys = points.map((p) => p[1])
    const y0 = Math.max(0, Math.floor(Math.min(...ys)))
    const y1 = Math.min(this.h - 1, Math.ceil(Math.max(...ys)))
    for (let y = y0; y <= y1; y++) {
      const xs: number[] = []
      for (let i = 0; i < points.length; i++) {
        const [ax, ay] = points[i]
        const [bx, by] = points[(i + 1) % points.length]
        if (ay === by) continue
        if (y >= Math.min(ay, by) && y < Math.max(ay, by)) {
          xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax))
        }
      }
      xs.sort((p, q) => p - q)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.floor(xs[k]); x <= Math.ceil(xs[k + 1]); x++) this.blend(x, y, c, a)
      }
    }
  }

  rain(count: number, seed: number, c: RGB = [150, 175, 195], a = 0.22): void {
    const rnd = mulberry32(seed)
    for (let i = 0; i < count; i++) {
      const x = rnd() * (this.w + 200) - 100
      const y = rnd() * this.h
      const len = 24 + rnd() * 90
      this.line(x, y, x - len * 0.32, y + len, c, 0.6, a * (0.4 + rnd() * 0.6))
    }
  }

  png(): Buffer {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h)
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0
      Buffer.from(this.data.buffer, y * this.w * 3, this.w * 3).copy(
        raw,
        y * (this.w * 3 + 1) + 1
      )
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(this.w, 0)
    ihdr.writeUInt32BE(this.h, 4)
    ihdr[8] = 8
    ihdr[9] = 2
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', deflateSync(raw, { level: 9 })),
      pngChunk('IEND', Buffer.alloc(0))
    ])
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function silhouette(c: Canvas, cx: number, headY: number, headR: number, body: RGB): void {
  c.ellipse(cx, c.h + 40, headR * 2.35, headR * 2.6, body)
  c.ellipse(cx, headY, headR, headR * 1.12, body)
}

function drawChen(): Buffer {
  const c = new Canvas(512, 640)
  c.vgrad([24, 33, 44], [41, 55, 70])
  c.rain(150, 7)
  // 雨檐下的冷光
  c.ellipse(256, 190, 220, 150, [58, 78, 96], 0.28)
  silhouette(c, 256, 252, 88, [11, 16, 22])
  // 连帽边缘
  c.ellipse(256, 236, 104, 108, [26, 37, 48], 0.65)
  c.ellipse(256, 252, 84, 92, [16, 22, 29], 1)
  // 湿发与面部高光
  c.ellipse(256, 218, 62, 34, [10, 14, 19], 0.9)
  c.ellipse(238, 258, 10, 5, [120, 138, 152], 0.5)
  c.ellipse(276, 258, 10, 5, [120, 138, 152], 0.5)
  // 风衣领口与前襟
  c.poly(
    [
      [172, 400],
      [256, 356],
      [340, 400],
      [356, 640],
      [156, 640]
    ],
    [18, 25, 33],
    0.95
  )
  c.line(256, 372, 256, 640, [8, 12, 16], 3, 0.65)
  // 肩头雨水
  for (let i = 0; i < 26; i++) c.ellipse(180 + i * 6, 402 + (i % 3) * 3, 2, 2, [150, 175, 195], 0.35)
  return c.png()
}

function drawLin(): Buffer {
  const c = new Canvas(512, 640)
  c.vgrad([42, 33, 24], [74, 56, 40])
  c.ellipse(256, 210, 230, 170, [104, 82, 58], 0.35)
  silhouette(c, 250, 258, 84, [16, 20, 26])
  // 马尾
  c.ellipse(322, 300, 30, 96, [26, 24, 24], 0.95)
  c.ellipse(256, 222, 60, 32, [30, 26, 24], 0.85)
  // 围裙
  c.poly(
    [
      [190, 396],
      [256, 368],
      [322, 396],
      [336, 640],
      [176, 640]
    ],
    [206, 198, 184],
    0.9
  )
  c.poly(
    [
      [212, 430],
      [300, 430],
      [308, 640],
      [204, 640]
    ],
    [188, 180, 166],
    0.75
  )
  // 工牌
  c.rect(240, 452, 272, 476, [236, 232, 224], 0.95)
  c.rect(244, 458, 268, 464, [120, 116, 110], 0.8)
  c.ellipse(232, 258, 9, 5, [120, 104, 92], 0.55)
  c.ellipse(268, 258, 9, 5, [120, 104, 92], 0.55)
  return c.png()
}

function drawTicket(): Buffer {
  const c = new Canvas(640, 400)
  c.vgrad([233, 223, 201], [214, 202, 178])
  c.rect(60, 54, 580, 346, [186, 170, 138], 1)
  c.rect(66, 60, 574, 340, [246, 238, 220], 1)
  // 齿孔
  for (let y = 70; y < 330; y += 26) {
    c.ellipse(66, y, 7, 7, [222, 210, 186], 1)
    c.ellipse(574, y, 7, 7, [222, 210, 186], 1)
  }
  // 标题与文字占位
  c.rect(110, 96, 360, 124, [96, 84, 64], 0.85)
  c.rect(110, 146, 300, 160, [140, 126, 100], 0.7)
  c.rect(110, 174, 336, 188, [140, 126, 100], 0.7)
  c.rect(110, 202, 240, 216, [140, 126, 100], 0.7)
  // 日期戳
  c.line(420, 92, 420, 250, [176, 160, 130], 1.2, 0.8)
  c.rect(436, 100, 540, 118, [110, 96, 74], 0.7)
  c.rect(436, 130, 512, 144, [150, 136, 110], 0.7)
  // 条码
  const rnd = mulberry32(21)
  for (let x = 110; x < 520; x += 4) {
    if (rnd() > 0.45) c.rect(x, 268, x + 2, 320, [52, 46, 36], 0.9)
  }
  // 折痕
  c.line(66, 244, 574, 244, [206, 194, 170], 1, 0.7)
  return c.png()
}

function drawStoreFront(): Buffer {
  const c = new Canvas(864, 480)
  c.vgrad([8, 14, 21], [22, 33, 44])
  c.rain(180, 3)
  c.rect(96, 96, 768, 480, [24, 34, 45], 1)
  // 招牌
  c.rect(236, 120, 628, 176, [16, 22, 30], 1)
  c.rect(252, 132, 300, 164, [214, 74, 58], 0.92)
  c.rect(318, 132, 366, 164, [214, 74, 58], 0.92)
  c.rect(384, 132, 432, 164, [232, 224, 208], 0.9)
  c.rect(452, 132, 610, 164, [232, 224, 208], 0.18)
  // 玻璃与暖光
  c.rect(236, 190, 628, 404, [232, 190, 122], 0.88)
  c.rect(236, 190, 628, 404, [255, 214, 150], 0.18)
  for (let x = 320; x < 628; x += 96) c.rect(x, 190, x + 8, 404, [30, 40, 50], 1)
  // 店内货架剪影
  for (let y = 230; y < 390; y += 46) {
    c.rect(258, y, 600, y + 12, [120, 88, 54], 0.55)
    for (let x = 264; x < 596; x += 22) c.rect(x, y - 22, x + 14, y - 2, [90, 66, 40], 0.5)
  }
  // 雨帘
  c.rain(140, 11, [190, 205, 220], 0.16)
  // 湿地反光
  c.rect(96, 404, 768, 480, [26, 34, 42], 0.86)
  for (let i = 0; i < 40; i++) {
    const x = 236 + i * 10
    c.ellipse(x, 432 + (i % 4) * 10, 5, 2, [232, 190, 122], 0.12)
  }
  return c.png()
}

function drawStreet(): Buffer {
  const c = new Canvas(864, 480)
  c.vgrad([7, 12, 17], [18, 26, 34])
  c.rain(200, 5)
  // 对面楼体
  c.rect(0, 70, 864, 300, [16, 22, 29], 1)
  c.rect(60, 130, 220, 300, [22, 30, 38], 1)
  c.rect(420, 150, 540, 300, [20, 28, 36], 1)
  // 路灯
  c.rect(634, 60, 646, 330, [44, 52, 60], 1)
  c.ellipse(640, 56, 22, 14, [255, 216, 160], 0.95)
  for (const [r, a] of [
    [70, 0.12],
    [48, 0.16],
    [26, 0.22]
  ] as Array<[number, number]>) {
    c.ellipse(640, 60, r, r * 0.8, [255, 206, 140], a)
  }
  // 人行道与路缘
  c.poly(
    [
      [0, 300],
      [864, 286],
      [864, 352],
      [0, 372]
    ],
    [34, 42, 50],
    1
  )
  // 车行道
  c.poly(
    [
      [0, 372],
      [864, 352],
      [864, 480],
      [0, 480]
    ],
    [22, 28, 34],
    1
  )
  // 积水反光
  for (let i = 0; i < 9; i++) {
    const x = 60 + i * 88
    c.ellipse(x, 420 + (i % 3) * 18, 60, 10, [58, 70, 82], 0.5)
    c.ellipse(x, 414 + (i % 3) * 18, 40, 4, [255, 206, 140], 0.08)
  }
  c.rain(160, 9, [170, 190, 210], 0.18)
  return c.png()
}

function drawInterior(): Buffer {
  const c = new Canvas(864, 480)
  c.vgrad([62, 46, 30], [38, 28, 20])
  // 顶灯
  for (let x = 120; x < 780; x += 180) {
    c.rect(x, 24, x + 120, 40, [255, 236, 200], 0.95)
    c.ellipse(x + 60, 66, 150, 60, [255, 226, 178], 0.16)
  }
  // 货架
  for (let row = 0; row < 3; row++) {
    const y = 150 + row * 86
    c.rect(70, y, 520, y + 14, [120, 96, 66], 0.9)
    for (let x = 88; x < 500; x += 34) {
      c.rect(x, y - 46, x + 24, y - 4, [150, 128, 96], 0.75)
    }
  }
  // 收银台
  c.rect(560, 300, 840, 480, [96, 74, 50], 1)
  c.rect(560, 292, 840, 306, [140, 112, 78], 1)
  // 保温柜
  c.rect(596, 190, 700, 292, [52, 60, 66], 1)
  c.rect(604, 198, 692, 284, [96, 118, 122], 0.45)
  for (let i = 0; i < 3; i++) c.rect(610, 210 + i * 24, 686, 214 + i * 24, [180, 160, 120], 0.5)
  // 玻璃门雨痕
  c.rain(90, 13, [200, 214, 226], 0.12)
  return c.png()
}

function drawAwning(): Buffer {
  const c = new Canvas(864, 480)
  c.vgrad([20, 18, 24], [30, 30, 38])
  // 雨檐
  c.poly(
    [
      [0, 0],
      [864, 0],
      [864, 96],
      [0, 118]
    ],
    [34, 30, 38],
    1
  )
  for (let x = 0; x < 864; x += 64) c.rect(x, 0, x + 30, 104, [58, 46, 52], 0.5)
  // 店门暖光
  c.rect(0, 100, 240, 480, [232, 190, 122], 0.16)
  // 街面
  c.poly(
    [
      [0, 330],
      [864, 312],
      [864, 480],
      [0, 480]
    ],
    [24, 26, 32],
    1
  )
  c.ellipse(700, 190, 90, 74, [255, 206, 140], 0.1)
  c.rect(694, 120, 704, 330, [48, 50, 58], 0.8)
  c.ellipse(699, 118, 14, 10, [255, 220, 168], 0.9)
  for (let i = 0; i < 10; i++) {
    c.ellipse(60 + i * 84, 400 + (i % 3) * 20, 54, 8, [46, 52, 60], 0.55)
  }
  c.rain(220, 17, [190, 205, 220], 0.18)
  return c.png()
}

/* ------------------------------------------------------------------ *
 * 5. 上传
 * ------------------------------------------------------------------ */

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${API}${path}`, init)
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

async function upload(pid: string, fileName: string, bytes: Buffer): Promise<void> {
  const res = await fetch(`${API}/projects/${pid}/assets?filename=${encodeURIComponent(fileName)}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: new Uint8Array(bytes)
  })
  if (!res.ok) throw new Error(`上传 ${fileName} 失败：${res.status} ${await res.text()}`)
}

function assetRow(patch: Partial<Asset> & { id: string; pictureN: number; fileName: string }): Asset {
  return {
    id: patch.id,
    projectId: EPISODE_ID,
    pictureN: patch.pictureN,
    fileName: patch.fileName,
    originalName: patch.originalName ?? patch.fileName,
    label: patch.label ?? '',
    kind: patch.kind ?? 'subject',
    refId: patch.refId,
    desc: patch.desc,
    createdAt: TS
  }
}

async function main(): Promise<void> {
  console.log(`后端：${BASE}`)
  console.log(`片段 ${beats.length} 个 / 段 ${built.length} 个 / 实体 ${entities.length} 个`)

  const errors = built.flatMap((s, i) =>
    s.issues.filter((x) => x.level === 'error').map((x) => `段${i + 1}: ${x.message}`)
  )
  const warns = built.flatMap((s, i) =>
    s.issues.filter((x) => x.level === 'warn').map((x) => `段${i + 1}: ${x.message}`)
  )
  built.forEach((s, i) => console.log(`  段${i + 1}  ${s.frames} 帧  (${s.group.beatIds.length} 拍)`))
  if (warns.length) console.log(`警告 ${warns.length}：\n  ${warns.join('\n  ')}`)
  if (errors.length) console.log(`错误 ${errors.length}：\n  ${errors.join('\n  ')}`)
  else console.log('校验：无错误')

  // 幂等：先删掉上一次生成的同名演示（只删这两个固定 id）
  await api('/projects', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [EPISODE_ID, SERIES_ID] })
  }).catch(() => undefined)

  const series: Project = {
    id: SERIES_ID,
    name: '测试项目 · 夜班便利店',
    kind: 'series',
    story: '',
    stage: 'split',
    settings: { ...DEFAULT_SETTINGS },
    fieldSchema: structuredClone(DEFAULT_FIELD_SCHEMA),
    episodeIds: [EPISODE_ID],
    createdAt: TS,
    updatedAt: TS
  }
  const episode: Project = {
    id: EPISODE_ID,
    name: '第 01 集 · 夜班',
    kind: 'episode',
    seriesId: SERIES_ID,
    story: STORY,
    stage: 'complete',
    settings,
    fieldSchema: schema,
    createdAt: TS,
    updatedAt: TS
  }

  await api('/projects', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ row: series })
  })
  await api('/projects', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ row: episode })
  })

  // 参考图 + 场景图
  const tmp = mkdtempSync(join(tmpdir(), 'seed-demo-'))
  const images: Array<{ file: string; bytes: Buffer }> = [
    { file: 'Picture1.png', bytes: drawChen() },
    { file: 'Picture2.png', bytes: drawLin() },
    { file: 'Picture3.png', bytes: drawTicket() },
    { file: 'Picture4.png', bytes: drawStoreFront() },
    { file: 'Picture5.png', bytes: drawStreet() },
    { file: 'scene_beat_demo_02.png', bytes: drawInterior() },
    { file: 'scene_beat_demo_14.png', bytes: drawAwning() }
  ]
  try {
    for (const img of images) {
      writeFileSync(join(tmp, img.file), img.bytes)
      await upload(EPISODE_ID, img.file, img.bytes)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  const assets: Asset[] = [
    assetRow({
      id: 'ast_demo_p1',
      pictureN: 1,
      fileName: 'Picture1.png',
      originalName: 'chen-mo.png',
      label: '陈默 · 参考图',
      refId: ENT.chen,
      desc: '三十岁男性，深灰连帽风衣，湿发贴额，左手手背有旧疤；雨夜冷色调，半身正面。'
    }),
    assetRow({
      id: 'ast_demo_p2',
      pictureN: 2,
      fileName: 'Picture2.png',
      originalName: 'lin-wan.png',
      label: '林晚 · 参考图',
      refId: ENT.lin,
      desc: '二十四岁女性，马尾，蓝色工作围裙，胸前褪色工牌；便利店暖光下的半身正面。'
    }),
    assetRow({
      id: 'ast_demo_p3',
      pictureN: 3,
      fileName: 'Picture3.png',
      originalName: 'old-ticket.png',
      label: '旧车票 · 参考图',
      refId: ENT.ticket,
      desc: '平铺的泛黄硬纸车票，边缘磨软，票面有日期戳与条码，米色背景。'
    }),
    assetRow({
      id: 'ast_demo_p4',
      pictureN: 4,
      fileName: 'Picture4.png',
      originalName: 'storefront.png',
      label: '便利店门面 · 参考图',
      refId: ENT.store,
      desc: '深夜街角便利店正面外观，24H 招牌，玻璃门内暖光与货架剪影，地面湿反光。'
    }),
    assetRow({
      id: 'ast_demo_p5',
      pictureN: 5,
      fileName: 'Picture5.png',
      originalName: 'street.png',
      label: '店门外街道 · 参考图',
      refId: ENT.street,
      desc: '雨夜空街，对面一盏昏黄路灯与空人行道，路面大片积水反光。'
    }),
    assetRow({
      id: 'ast_demo_sc1',
      pictureN: 0,
      fileName: 'scene_beat_demo_02.png',
      label: '场景图 · 店内收银台',
      kind: 'scene',
      refId: 'beat_demo_02',
      desc: '便利店内部，暖色顶灯、货架与收银台，角落有保温柜。'
    }),
    assetRow({
      id: 'ast_demo_sc2',
      pictureN: 0,
      fileName: 'scene_beat_demo_14.png',
      label: '场景图 · 门外雨檐',
      kind: 'scene',
      refId: 'beat_demo_14',
      desc: '从店门口看向雨夜街道，雨檐在上方，远处路灯发光。'
    })
  ]

  const putRows = async (table: string, rows: unknown[]) => {
    await api(`/projects/${EPISODE_ID}/${table}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows })
    })
  }

  await putRows('entities', entities)
  await putRows('beats', beats)
  await putRows('assemblies', [assembly])
  await putRows('assets', assets)

  // 段字段：summary / 音景 / 配乐 + 生成记录（指纹与前端算法一致）
  const summaries: Record<string, string> = {}
  const overrides: Record<string, Record<string, string>> = {}
  const segmeta: Record<string, { llmHash: string; beatIds: string[]; updatedAt: number }> = {}
  built.forEach((s, i) => {
    const copy = SEGMENT_COPY[i]
    summaries[s.group.id] = copy.summary
    overrides[s.group.id] = {
      overall_soundscape: copy.soundscape,
      non_diegetic_music: copy.music
    }
    segmeta[s.group.id] = {
      llmHash: s.hash,
      beatIds: s.material.beats.map((b) => b.id),
      updatedAt: TS
    }
  })

  // 注意：这三把键是「项目级」的 —— 前端 backendKv 会把
  // overrides/summaries/segmeta 前缀的键写进项目 meta.json，而不是全局 kv.json。
  // 写到 /kv 前端读不到（读的是 meta），而且不会报错，只会安静地空着。
  const putMeta = async (key: string, value: unknown) => {
    await api(`/projects/${EPISODE_ID}/meta`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { [key]: value } })
    })
  }
  await putMeta(`summaries:${EPISODE_ID}`, summaries)
  await putMeta(`overrides:${EPISODE_ID}`, overrides)
  await putMeta(`segmeta:${EPISODE_ID}`, segmeta)

  console.log('\n完成：')
  console.log(`  系列 id ：${SERIES_ID}`)
  console.log(`  剧集 id ：${EPISODE_ID}`)
  console.log(`  打开    ：http://localhost:5178/p/${EPISODE_ID}`)
  built.forEach((s, i) => {
    console.log(`  段${i + 1} 指纹 ${s.hash}  字段 ${Object.keys(s.fields).length} 个`)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
