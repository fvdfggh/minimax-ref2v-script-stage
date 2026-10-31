/**
 * 单点助手：一次只干一件小事的提示词。
 *
 * 为什么和 prompts.ts 分开：
 *   prompts.ts 里的那几支是**流水线**的整段任务（整篇拆解、整批补全、整段字段），
 *   一跑就是几十条片段 / 一屏字段。用户在这些页面上想改的往往只是"这一拍的画面
 *   描述"或"这个角色的音色"，让模型重新跑一遍整批，既慢又会顺手改坏别处。
 *
 * 所以这里每一支都只输出**一个字段**（或一拍拆成几拍），输入也只带这一条上下文。
 * 三条硬规矩写在所有提示词里：
 *   1. 只输出要求的那一项，格式是纯文本（不套 JSON，少一层解析失败）；
 *   2. 不改用户已有的措辞里没被要求改的部分（重写不是"重编"）；
 *   3. 不引入原文之外的人物 / 道具 / 剧情。
 */

import type { EntityType, Lang } from '@/domain/types'
import { BEAT_KIND_LABEL } from '@/domain/beats'
import { BASE_SYSTEM } from './prompts'
import type { ChatMessage } from './types'

/* ------------------------------------------------------------------ *
 * 一拍的单个字段
 * ------------------------------------------------------------------ */

export type BeatWriteField = 'direction' | 'visualDesc'

export interface BeatWriteCast {
  name: string
  /** 长相（textDesc） */
  look?: string
  /** 服装（costumeDesc） */
  costume?: string
  /** <Picture N>；0 = 纯文本实体 */
  pictureN?: number
  /** 这一拍说话的人 */
  speaking?: boolean
}

export interface BeatWriteInput {
  field: BeatWriteField
  beat: {
    title: string
    kind: string
    dialogue?: string
    frames: number
    fps: number
    /** 当前值：让模型知道"在改哪一句"，而不是从零重写 */
    current?: string
  }
  scene?: string
  cast: BeatWriteCast[]
  /** 前后各一拍的标题：只用来判断"这一拍从哪来、往哪去"，不参与输出 */
  prevTitle?: string
  nextTitle?: string
  /** 用户给的一句要求（可空） */
  requirement?: string
  language?: Lang
}

const DIRECTION_RULES = `【镜头描述】只写机位语言，不写人物与剧情。
必须写到：景别（特写 / 近景 / 中景 / 全景 …）+ 机位角度（平视 / 俯拍 / 仰拍 / 过肩 …）
+ 一个运镜（固定 / 缓推 / 拉远 / 横移 / 跟拍 / 手持）。
- 一次只给一个运镜：写"推近 + 横移 + 升起"这种叠三层的，下游根本执行不了。
- 不写动作、表情、台词、环境细节、光线 —— 那些属于画面描述，重复写会互相打架。
- 台词拍优先固定机位或极慢的推近：说话时大幅运动会让口型对不上。
- 不写镜头编号、时间码、"第几拍"这类元信息。`

const VISUAL_RULES = `【画面描述】只写画面上看得见的东西，不写怎么拍。
必须写到：谁在做什么（姿态 + 一个明确动作或状态）、表情与视线、关键道具、环境里的具体物件。
- 不写景别 / 机位 / 运镜（那是镜头描述的事），也不写台词原文。
- 台词拍只写**说话这一瞬间**：表情、视线、手停在哪儿；不许写说话前的动作
  （抬头 / 转身 / 伸手 / 递 / 推门 / 坐下 …）—— 动作在这一拍之前已经演完了。
- 一拍只写一个动作。两个动作并列（"推门进来，环顾四周，走向柜台"）就说明该拆拍了，
  这里只保留最贴近这一拍标题的那一个。
- 出场角色沿用给定的长相与服装，不要临时换衣服、加配饰、加人。
- 不要写"参考图""Picture 1""保留特征"这类制作笔记，直接写画面。`

export function buildBeatWriteMessages(input: BeatWriteInput): ChatMessage[] {
  const lang: Lang = input.language ?? 'zh'
  const rules = input.field === 'direction' ? DIRECTION_RULES : VISUAL_RULES
  const b = input.beat
  const sec = b.fps > 0 ? (b.frames / b.fps).toFixed(2) : '?'
  const cast = input.cast
    .map((c) => {
      const bits = [
        c.speaking ? '（这一拍说话）' : '',
        c.look ? `长相：${c.look}` : '',
        c.costume ? `服装：${c.costume}` : ''
      ].filter(Boolean)
      return `- ${c.name}${c.pictureN ? `（<Picture ${c.pictureN}>）` : ''}${bits.length ? ` — ${bits.join('；')}` : ''}`
    })
    .join('\n')

  const lengthHint =
    input.field === 'direction'
      ? lang === 'zh'
        ? '8~20 字，一行，不加句号'
        : '5~12 words, one line, no period'
      : lang === 'zh'
        ? '30~70 字，一段话'
        : '20~45 words, one paragraph'

  return [
    {
      role: 'system',
      content: `${BASE_SYSTEM}

现在是【只改一拍的${input.field === 'direction' ? '镜头描述' : '画面描述'}】。
下游会把你的输出**直接覆盖**到这个字段上，所以只准输出这一项内容本身。

${rules}

输出要求：
1. 只输出改写后的这一项内容：${lengthHint}。
2. 不要标题、不要引号、不要 Markdown、不要编号、不要中文解释、不要"${lang === 'zh' ? '镜头描述：' : 'Shot: '}"这类前缀。
3. 用${lang === 'zh' ? '中文' : '英文'}写（${lang === 'zh' ? '这一阶段是中文工作稿，之后统一本地化' : 'downstream comes after localization'}）。
4. 用户给了【当前写法】时，是让你在它基础上改：保留其中成立的信息，
   只修掉不合规则的地方（例如台词拍里的动作、堆叠的运镜）；用户没提到的不要另起一套。
5. 不要引入上面【出场】之外的人物或道具，不要编造原文没有的剧情。`
    },
    {
      role: 'user',
      content: `【这一拍】${b.title || '（未命名）'} · ${BEAT_KIND_LABEL[b.kind as keyof typeof BEAT_KIND_LABEL] ?? b.kind} · ${b.frames} 帧（${sec}s）
${b.dialogue ? `【台词】${b.dialogue}\n` : ''}${input.scene ? `【场景】${input.scene}\n` : ''}${
        input.prevTitle ? `【上一拍】${input.prevTitle}\n` : ''
      }${input.nextTitle ? `【下一拍】${input.nextTitle}\n` : ''}
【出场】
${cast || '-（纯场景镜，没有人）'}
${b.current ? `\n【当前写法】${b.current}\n` : ''}${input.requirement ? `\n【我的要求】${input.requirement}\n` : ''}
请直接输出${input.field === 'direction' ? '镜头描述' : '画面描述'}。`
    }
  ]
}

/* ------------------------------------------------------------------ *
 * 把一拍拆细
 * ------------------------------------------------------------------ */

export interface BeatSplitInput {
  beat: {
    title: string
    kind: string
    dialogue?: string
    direction?: string
    visualDesc?: string
    frames: number
    fps: number
  }
  scene?: string
  /** 前后拍标题：让模型知道这一拍在整场里的位置，避免拆出重复内容 */
  prevTitle?: string
  nextTitle?: string
  /** 一句要求（"拆成三拍""把动作和台词分开"…） */
  requirement?: string
  language?: Lang
}

/** 模型返回的一拍：weight 是相对时长，由调用方折算成帧 */
export interface BeatSplitPart {
  title: string
  kind: string
  dialogue?: string
  direction?: string
  visualDesc?: string
  weight?: number
}

export function buildBeatSplitMessages(input: BeatSplitInput): ChatMessage[] {
  const lang: Lang = input.language ?? 'zh'
  const b = input.beat
  const sec = b.fps > 0 ? (b.frames / b.fps).toFixed(2) : '?'
  const free = lang === 'zh' ? '中文' : '英文'

  return [
    {
      role: 'system',
      content: `${BASE_SYSTEM}

现在是【把一拍拆细】——只拆这一拍，不碰别的片段。

拆的判据（满足任意一条就该拆）：
- 一拍里写了两个以上的动作（"推门进来，环顾四周，走向柜台"）；
- 台词拍里带着说话前的动作（"抬头看他，把硬币推回去" + 一句台词）；
- 一拍盖住了两个镜头该有的时间（默认 36 帧 ≈ 1.5 秒，超过 90 帧基本就是拆粗了）。

硬性要求：
1. 只输出 2~4 拍，按发生顺序排列。不要拆成 5 拍以上（那不是拆细，是重写）。
2. 台词必须**完整**落在某一拍里：不许改字、不许断句、不许拆成两条 dialogue。
   台词拍前面若有动作，把动作单独排成一条 action 拍放在它前面。
3. kind 只能取：action、dialogue、reaction、insert。
   - 说话本身 → dialogue（dialogue 字段写纯台词，不带角色名与引号）；
   - 听者的反应 / 沉默 → reaction；
   - 特写道具或细节 → insert；
   - 其余动作 → action。
4. title 用${free}，一句话，动词开头或"谁 + 做什么"，10~20 字。
5. weight 是这一拍占的**相对时长**（1~3 的整数）：动作大的、台词长的给 2~3，
   一个眼神 / 一次特写给 1。不要把 weight 全填成一样 —— 那是没判断。
6. direction / visualDesc 可以省略：拆出来的新拍还没细填，交给后面的补全阶段。
   如果原拍已经有这两项，就把它们分配到各自合适的那一拍上，不要重复写同一句。
7. 不新增原文没有的人物、道具、台词；不改变剧情顺序。

输出 JSON（只输出这些字段，不要解释）：
{
  "beats": [
    { "title": "${free}标题", "kind": "action", "weight": 2, "dialogue": "仅 dialogue 拍有" }
  ]
}`
    },
    {
      role: 'user',
      content: `【要拆的这一拍】${b.title || '（未命名）'} · ${BEAT_KIND_LABEL[b.kind as keyof typeof BEAT_KIND_LABEL] ?? b.kind} · ${b.frames} 帧（${sec}s）
${b.dialogue ? `【台词】${b.dialogue}\n` : ''}${b.direction ? `【镜头】${b.direction}\n` : ''}${
        b.visualDesc ? `【画面】${b.visualDesc}\n` : ''
      }${input.scene ? `【场景】${input.scene}\n` : ''}${
        input.prevTitle ? `【上一拍】${input.prevTitle}\n` : ''
      }${input.nextTitle ? `【下一拍】${input.nextTitle}\n` : ''}${input.requirement ? `\n【我的要求】${input.requirement}\n` : ''}
请给出拆分结果。`
    }
  ]
}

/* ------------------------------------------------------------------ *
 * 主体的单个描述字段
 * ------------------------------------------------------------------ */

export type EntityWriteField = 'textDesc' | 'costumeDesc' | 'voiceDesc'

export interface EntityWriteInput {
  field: EntityWriteField
  entity: {
    name: string
    type: EntityType
    kind: string
    textDesc?: string | null
    costumeDesc?: string | null
    voiceDesc?: string | null
  }
  /** 原文里提到这个名字的片段（可空） */
  storyExcerpt?: string
  /** 项目里其他主体的名字：避免把配角写进这个人的描述 */
  peers?: string[]
  requirement?: string
  language?: Lang
}

const ENTITY_RULES: Record<EntityWriteField, string> = {
  textDesc: `【长相】只写"这个人是/这个东西是什么样"，供头部两步（基模头 / 组头）出图。
必须写到：脸型、五官、发型、肤色、年龄感、体型骨架、一个标志性细节
（脸上的疤 / 眼镜 / 常年不刮的胡茬 …）。
- **绝对不许写穿着**（衣服 / 鞋 / 配饰 / 制服）：头部图只画头肩，写进去会被裁成一团，
  三视图又会拿同一句话画全身，两边永远对不上。穿着写到「服装与身形」。
- 不许写动作、表情、情绪、剧情、人物关系。
- 场景 / 道具没有"脸"：写空间结构、材质、色调、光源方向与标志性陈设。`,
  costumeDesc: `【服装与身形】只写这一套造型，供三视图出全身。
必须写到：款式、颜色、材质、鞋、配饰；以及体型（高矮胖瘦 / 肩宽 / 姿态）。
- 不重复长相（脸型五官发型），不写动作、表情、剧情。
- 同一套造型要能跨镜头复用：不要写"雨淋湿了""沾了血"这种只属于某一拍的状态。`,
  voiceDesc: `【音色】写一句给音色设计模型用的描述，不是台词、不是性格分析。
必须写到：年龄与性别、音高、音质（沙哑 / 清亮 / 浑厚 / 发紧）、说话方式
（语速、气口、口音）、气质底色。
- 形如：「青年男声，偏低的音高，略带沙哑，说话慢，尾音压着，疲惫但坚定」。
- 不写"他/她"的剧情、不写说了什么、不写情绪变化（音色是固定的，情绪属于某一拍）。
- 一句话，不超过 40 字（英文 25 words）。`
}

export function buildEntityWriteMessages(input: EntityWriteInput): ChatMessage[] {
  const lang: Lang = input.language ?? 'zh'
  const e = input.entity
  const current =
    input.field === 'textDesc' ? e.textDesc : input.field === 'costumeDesc' ? e.costumeDesc : e.voiceDesc
  const label =
    input.field === 'textDesc' ? '长相' : input.field === 'costumeDesc' ? '服装与身形' : '音色'

  return [
    {
      role: 'system',
      content: `${BASE_SYSTEM}

现在是【只写一个主体的一个描述字段：${label}】。
下游会把你的输出直接存成这个字段，跨段逐字复用 —— 所以只输出这一项内容本身。

${ENTITY_RULES[input.field]}

硬性要求：
1. 只输出描述正文：不要标题、不要引号、不要 Markdown、不要"${label}："前缀。
2. 用${lang === 'zh' ? '中文（这一阶段是中文工作稿，之后统一本地化）' : '英文'}写。
3. 原文里给了信息的，一律以原文为准；原文没写的，按名字、身份、场景合理设定，
   设定要**能拍**（具体到颜色、材质、形状），不要"看起来很特别"这种空话。
4. 已有【当前写法】时，在它基础上改：保留成立的信息，只补缺的、修不合规矩的。
5. 不要把这个主体之外的人写进来：每个角色各有各的描述，混在一起会让两个角色越长越像。`
    },
    {
      role: 'user',
      content: `【主体】${e.name} · ${e.type} · ${e.kind === 'speaking' ? '会说话' : '不说话'}
${e.textDesc ? `【已有长相】${e.textDesc}\n` : ''}${
        e.costumeDesc ? `【已有服装】${e.costumeDesc}\n` : ''
      }${e.voiceDesc ? `【已有音色】${e.voiceDesc}\n` : ''}${
        input.storyExcerpt ? `\n【原文里提到 TA 的地方】\n${input.storyExcerpt}\n` : ''
      }${input.peers?.length ? `\n【同项目里还有】${input.peers.slice(0, 6).join('、')}\n` : ''}${
        current ? `\n【当前写法】${current}\n` : ''
      }${input.requirement ? `\n【我的要求】${input.requirement}\n` : ''}
请直接输出${label}。`
    }
  ]
}
