import specText from '../../../说明.txt?raw'
import type { Beat, Entity, FieldSchema, Lang, SeamAnalysis } from '@/domain/types'
import { subjectTag, sxTag } from '@/domain/registry'
import { BEAT_KIND_LABEL, resolveSubjectId } from '@/domain/beats'
import type { ChatMessage } from './types'

/* ------------------------------------------------------------------ *
 * 三阶段提示词
 *   阶段一：故事 -> Beat 标题（台词为纯台词）
 *   阶段二：已确认的 Beat -> 填充细节
 *   阶段三：组合好的段 -> summary
 * ------------------------------------------------------------------ */

export const SPEC_TEXT = specText

const BASE_SYSTEM = `你是一个影视分镜与提示词工程助手，服务于 MiniMax H3 Ref2VA 多段拼接视频生成。
下面的团队规范文档是你唯一的判定依据，必须严格遵守：

<spec>
${specText}
</spec>

输出必须是合法 JSON，不要输出任何解释文字或 Markdown 代码块标记。`

/* --------------------------- 阶段一 --------------------------- */

export interface Stage1Beat {
  title: string
  kind: string
  dialogue?: string
  /** 本片段所在场景的实体名（必填，type 必须是 scene） */
  scene?: string
  /** 本片段涉及的其他主体名（可选，来自已知清单或 newEntities） */
  entities?: string[]
  /** 台词片段的说话人实体名 */
  speaker?: string
}

export type ProposedEntityType = 'character' | 'scene' | 'prop' | 'ui' | 'other'

export interface Stage1NewEntity {
  name: string
  type: ProposedEntityType
  kind: 'speaking' | 'non_speaking'
  /** 会说话角色必须给出固定音色描述，后续跨段逐字复用 */
  voiceDesc?: string
  /** 无图实体的纯文本视觉描述 */
  textDesc?: string
  /** 该实体在故事中的说明，便于人工核对 */
  note?: string
  /** 首次出现的大致位置说明 */
  firstAppear?: string
}

/** 分批拆解：本次是第几批、覆盖原文哪一段、上文已拆出什么 */
export interface Stage1Batch {
  /** 1 起 */
  index: number
  total: number
  paraFrom: number
  paraTo: number
  paragraphCount: number
  /** 上文已拆出的末尾片段标题，只作续接锚点 */
  contextTitles: string[]
}

export interface Stage1Options {
  language?: Lang
  batch?: Stage1Batch
}

export function buildStage1Messages(
  story: string,
  knownEntityNames: string[],
  options: Stage1Options = {}
): ChatMessage[] {
  const lang = options.language ?? 'zh'
  const free = lang === 'zh' ? '中文' : '英文'
  const batch = options.batch
  const batched = !!batch && batch.total > 1

  const batchRule = batched
    ? `
── C. 分批规则（本次是第 ${batch!.index} / ${batch!.total} 批）──
17. 你只负责「本批原文」，不要复述全文，不要输出上文已经给出的片段。
18. 下面会给出上文末尾的几个片段标题作为续接锚点：
    - 只用它判断本批第一个片段该怎么接上；
    - 不要重新输出这些片段，也不要改写它们的措辞。
19. 实体命名必须与上文一致：已知实体清单一律复用，不允许另起一种写法。
20. 只有在本批是最后一批时才做自然收束；否则按原文继续推进，
    不要提前总结、不要写"未完待续"、不要在结尾加收尾镜头。
21. 不要为了控制数量而合并动作或台词；宁可把动作拆得更细，也不要跳过原文内容。`
    : ''

  return [
    {
      role: 'system',
      content: `${BASE_SYSTEM}

现在是【阶段一：分镜拆解 + 实体登记】${
        batched ? `（分批进行：第 ${batch!.index} / ${batch!.total} 批）` : ''
      }。
任务分两件，一次做完：
  A. 把故事拆成最小原子片段（Beat），每个 Beat 对应一个镜头，只做一件事；
  B. 同时把故事里出现过的实体（角色、场景、道具、界面）登记出来，并让每个 Beat 绑定它涉及的实体。

── A. 拆解规则 ──
1. 一个 Beat 只做一件事：一个动作 / 一次场景切换 / 一句台词 / 一个铺垫 / 一个反应 / 一个特写。
2. 台词必须与动作、场景切换完全分开。台词 Beat 的 dialogue 字段只写纯台词本身：
   - 不要写角色名，不要写引号，不要写 <d> 标签，不要写任何格式标记。
   - 例：dialogue: "我不信这世上没有解药。"
3. 动作与场景切换用 title 描述，dialogue 留空。
4. kind 只能取：dialogue、action、scene_switch、establishing、reaction、insert。
5. 过长就拆细：一个动作 Beat 建议不超过 3 秒；一句台词 Beat 建议不超过 5 秒。
6. title 用${free}，简洁一句话；不要出现镜头编号与时间戳。
7. 不要臆造故事里没有的情节，保持原有顺序与因果。

── B. 实体与绑定规则 ──
8. 每个 Beat 必须给出 scene，值是它所在场景的实体名，该实体的 type 必须是 scene。场景是必填项。
9. 每个 Beat 还可以给出 entities 数组，列出这个镜头里出现的「其他主体」（角色、道具、界面）。
   - entities 可以为空数组：纯场景镜（空镜、环境铺垫、换场）没有角色是允许的。
   - 不要把场景名重复写进 entities。
10. 台词 Beat 必须额外给出 speaker，它的值必须同时出现在 entities 里，且该实体必须是 kind = speaking。
11. 实体名必须与"已知实体"或你在 newEntities 里声明的名字完全一致，不允许出现第三种写法。
12. 会说话的角色：只要在故事里发过声，kind 填 speaking，并必须给出固定音色描述 voiceDesc：
    - ${free}，一句话，形如${lang === 'zh' ? '"青年男声，略带沙哑，疲惫但坚定"' : '"speaking with a young male voice, slightly hoarse, tired but determined"'}
    - 不要带 (Sx) 后缀，编号由系统分配
    - 同一角色全片只描述一次，后续复用
13. 场景必须作为独立实体登记：type 填 scene，kind 填 non_speaking，并给 textDesc 描述环境外观。
    - 每个实际出现的场景都要有独立的场景实体，不要拿角色名或道具名当场景。
14. 不说话的角色、道具、界面：kind 填 non_speaking，不要写 voiceDesc。
15. 实体尽量给 textDesc：${free}，描述它的外观特征，用于无参考图时的画面描述。
16. 已经存在、无需新建的实体不要放进 newEntities，但可以正常在 scene / entities 里引用。
${batchRule}

已知实体（可直接引用，不要重复放进 newEntities）：
${knownEntityNames.length ? knownEntityNames.join('、') : '（暂无）'}

输出 JSON 结构：
{
  "beats": [
    {
      "title": "字符串",
      "kind": "dialogue|action|scene_switch|establishing|reaction|insert",
      "dialogue": "纯台词，非台词片段省略此字段",
      "scene": "场景实体名，必填",
      "entities": ["其他主体实体名，可为空数组"],
      "speaker": "实体名，仅台词片段需要"
    }
  ],
  "newEntities": [
    {
      "name": "实体名",
      "type": "character|scene|prop|ui|other",
      "kind": "speaking|non_speaking",
      "voiceDesc": "${free}音色描述，仅 speaking",
      "textDesc": "${free}外观描述",
      "note": "一句话说明",
      "firstAppear": "首次出现的片段标题"
    }
  ]
}`
    },
    {
      role: 'user',
      content: batched
        ? `${contextBlock(batch!.contextTitles)}请拆解本批原文（第 ${batch!.paraFrom} ~ ${batch!.paraTo} 段，共 ${batch!.paragraphCount} 段），并登记其中的实体。
要求：每个片段都必须归属到一个场景；只输出本批范围内的片段。

<本批原文>
${story}`
        : `请拆解以下故事，并登记其中的实体（注意：每个片段都必须归属到一个场景）：\n\n${story}`
    }
  ]
}

function contextBlock(titles: string[]): string {
  if (!titles.length) {
    return '【说明】本批是全片开头，没有上文。\n\n'
  }
  return `【上文末尾片段（只读，不要重复输出、不要改写）】
${titles.map((t) => `- ${t}`).join('\n')}

`
}

/* ---------------- 只梳理实体（不拆片段） ---------------- */

export function buildEntityExtractMessages(
  story: string,
  knownEntityNames: string[],
  options: { language?: Lang } = {}
): ChatMessage[] {
  const free = (options.language ?? 'zh') === 'zh' ? '中文' : '英文'
  return [
    {
      role: 'system',
      content: `${BASE_SYSTEM}

现在是【实体梳理】。只做一件事：把故事里出现过的实体完整登记出来。

规则：
1. 覆盖到角色、场景、道具、界面四类。不要遗漏只在背景里出现的场景。
2. 会说话的角色 kind 填 speaking，并给出${free} voiceDesc（形如 ${free === '中文' ? '"成熟男声，慵懒傲慢"' : '"speaking with a mature male voice, lazy and arrogant"'}），不带 (Sx) 后缀。
3. 不说话的实体 kind 填 non_speaking，不写 voiceDesc，改为尽量给出 textDesc（${free}外观描述）。
4. 每个实体给一句话 note 说明用途，并给 firstAppear 说明首次出现在哪。
5. 已知实体不要重复输出。

已知实体：
${knownEntityNames.length ? knownEntityNames.join('、') : '（暂无）'}

输出 JSON 结构：
{
  "newEntities": [
    { "name": "", "type": "character|scene|prop|ui|other", "kind": "speaking|non_speaking",
      "voiceDesc": "", "textDesc": "", "note": "", "firstAppear": "" }
  ]
}`
    },
    {
      role: 'user',
      content: `故事原文：\n\n${story}`
    }
  ]
}

/* --------------------------- 阶段二 --------------------------- */

export interface Stage2BeatDetail {
  id: string
  entities: string[]
  speaker?: string
  focus?: string
  direction?: string
  visualDesc?: string
  scene?: string
}

export interface Stage2Options {
  fps?: number
  language?: Lang
  batch?: { index: number; total: number }
  /** 上一批已填好的细节：只用来对齐运镜 / 画面的措辞风格 */
  contextDetails?: Stage2BeatDetail[]
}

export function buildStage2Messages(
  beats: Beat[],
  entities: Entity[],
  options: Stage2Options = {}
): ChatMessage[] {
  const free = (options.language ?? 'zh') === 'zh' ? '中文' : '英文'
  const batch = options.batch
  const batched = !!batch && batch.total > 1
  const entityTable = entities
    .map((e) => {
      const parts = [
        `- name: ${e.name}`,
        `type: ${e.type}`,
        `kind: ${e.kind}`,
        e.pictureN != null ? `picture: <Picture ${e.pictureN}>` : 'picture: 无（纯文本描述）',
        e.voiceDesc ? `voice: ${e.voiceDesc}` : '',
        e.textDesc ? `visual: ${e.textDesc}` : ''
      ].filter(Boolean)
      return parts.join(' | ')
    })
    .join('\n')

  const beatTable = beats
    .map((b) => {
      const base = [`id: ${b.id}`, `kind: ${b.kind}`, `title: ${b.title}`]
      if (b.kind === 'dialogue') base.push(`dialogue: ${b.dialogue ?? ''}`)
      base.push(`当前场景: ${b.sceneId ? (entities.find((e) => e.id === b.sceneId)?.name ?? '未知') : '（未指定，必须补上）'}`)
      const sub = (b.entities ?? [])
        .map((id) => entities.find((e) => e.id === id)?.name)
        .filter(Boolean)
        .join('+')
      base.push(`当前主体: ${sub || '（无，纯场景镜）'}`)
      return `- ${base.join(' | ')}`
    })
    .join('\n')

  return [
    {
      role: 'system',
      content: `${BASE_SYSTEM}

现在是【阶段二：细节填充】${
        batched ? `（分批进行：第 ${batch!.index} / ${batch!.total} 批）` : ''
      }。
任务：为每个已确认的 Beat 补充镜头细节与实体绑定。

实体分两层，判断方式不同：
- 场景（type = scene）：必填，每个 Beat 有且仅有一个；
- 其他主体（角色 / 道具 / 界面）：可选，纯场景镜可以为空数组。

硬性要求：
1. 只做"补全与细化"，不要推翻已有信息：
   - 已经给出的 scene、entities、speaker 必须原样返回，不得替换；
   - 只有在它为空时才由你补全。
2. scene 必须是已知实体名单中 type = scene 的实体名。若某个 Beat 的当前场景是"（未指定）"，你必须结合剧情把它补上。
3. entities 必须是已知实体名单中的 name，用数组给出，可以为空数组（纯场景镜）；
   - 不要把场景名写进 entities。
4. dialogue 类型的 Beat 的 speaker 必须是 kind 为 speaking 的实体，并出现在 entities 里。
5. focus 是本镜头聚焦的主体。优先取 speaker；纯场景镜取场景名。
6. direction 写景别与运镜，${free}，简短，例如 "${free === '中文' ? '中景，缓慢推近' : 'medium shot, slow push in'}"。
7. visualDesc 写画面内容，${free}，简短，描述保留参考图中的哪些特征。
8. 不得引入名单外的实体；不得改动 Beat 的 kind 与顺序；不得编造新剧情。
9. 必须为每一个输入的 Beat id 返回一条结果，id 原样返回。${
        batched
          ? `
10. 本批只输出下面列出的 Beat id，不要多、不要少、不要复述上一批。
11. 下面会给上一批已填好的几条细节，只用来对齐运镜与画面的措辞风格与粒度，
    不要把它们的实体绑定或场景套到本批。`
          : ''
      }

已知实体名单：
${entityTable || '（无）'}

输出 JSON 结构：
{
  "details": [
    {
      "id": "与输入一致的 beat id",
      "entities": ["实体名"],
      "speaker": "实体名，非台词片段省略",
      "focus": "实体名",
      "scene": "实体名",
      "direction": "${free}镜头描述",
      "visualDesc": "${free}画面描述"
    }
  ]
}`
    },
    {
      role: 'user',
      content: `${
        batched
          ? `${stage2ContextBlock(options.contextDetails, entities)}本批需要填充的 Beat 列表（第 ${batch!.index} / ${batch!.total} 批，共 ${beats.length} 个）：\n\n${beatTable}`
          : `需要填充的 Beat 列表：\n\n${beatTable}`
      }`
    }
  ]
}

/** 上一批已填好的细节，供本批对齐措辞风格 */
function stage2ContextBlock(details: Stage2BeatDetail[] | undefined, entities: Entity[]): string {
  if (!details?.length) {
    return '【说明】本批是全片开头，没有上一批。\n\n'
  }
  const byId = new Map(entities.map((e) => [e.id, e]))
  const lines = details
    .filter((d) => d.direction || d.visualDesc)
    .map((d) => {
      const who = d.focus ? (byId.get(d.focus)?.name ?? d.focus) : ''
      const body = [d.direction, d.visualDesc].filter(Boolean).join(' / ')
      return `- ${who ? `${who}：` : ''}${body}`
    })
  if (!lines.length) return '【说明】本批是全片开头，没有上一批。\n\n'
  return `【上一批已填好的细节（只读，用来对齐风格，不要重复输出）】
${lines.join('\n')}

`
}

/* --------------------------- 阶段三 --------------------------- */

export interface SegmentFillInput {
  schema: FieldSchema[]
  /** 已素材化的片段序列（含 preshoot / tail_cut / black） */
  groupBeats: Beat[]
  entities: Entity[]
  seamFromPrev: SeamAnalysis | null
  nextSeam: SeamAnalysis | null
  /** 已有字段：派生字段已由引擎算好，作为只读上下文交给模型，不给它改 */
  existing: Record<string, string>
  segmentIndex: number
  segmentTotal: number
  frames: number
  fps: number
  /** 本段字段应当用什么语言撰写 */
  language?: Lang
}

/** 与 SegmentFillInput 共用的语言解析 */
function fillLang(input: { language?: Lang }): Lang {
  return input.language ?? 'zh'
}

/** 每个字段的写作要求，优先于 Schema 里的 promptHint（按工作语言分叉） */
const FIELD_RULES: Record<Lang, Record<string, string>> = {
  en: {
    summary: `必须以字面量 [reference generation] 开头（含方括号），紧接着用 2-4 句英文概述本段：谁、在哪、做了什么、结果如何。必须点明主体保留自哪张参考图，例如 <Subject 1> is retained from <Picture 1>。不得重复台词原文，不得出现 leave / disappear / fade out 这类反向叙事表述。`,
    overall_soundscape: `1-4 句英文，描写环境声、物理动作声、非语言人声（呼吸、脚步、衣物摩擦）。不得重复任何对白原文，不得描写配乐。`,
    non_diegetic_music: `无配乐时只填 N/A（三个字符）。有配乐则用 1-3 句英文描述乐器、速度、节奏与情绪走向。`
  },
  zh: {
    summary: `必须以字面量 [reference generation] 开头（含方括号），紧接着用 2-4 句中文概述本段：谁、在哪、做了什么、结果如何。必须点明主体保留自哪张参考图，例如 <Subject 1> 保留自 <Picture 1>。<Subject N> / <Picture N> 是结构标记，原样保留。不得重复台词原文，不得出现 离开 / 消失 / 淡出 这类反向叙事表述。`,
    overall_soundscape: `1-4 句中文，描写环境声、物理动作声、非语言人声（呼吸、脚步、衣物摩擦）。不得重复任何对白原文，不得描写配乐。`,
    non_diegetic_music: `无配乐时只填 N/A（三个字符）。有配乐则用 1-3 句中文描述乐器、速度、节奏与情绪走向。`
  }
}

const FILL_RULES: Record<Lang, string> = {
  en: `2. 除 <d> 标签内的中文台词外，全部使用英文。`,
  zh: `2. 除 <d> 标签内的中文台词外，其余一律用中文（<Subject N>、(Sx)、<Picture N> 等结构标记原样保留）。这一阶段是中文工作稿，之后由本地化阶段统一转成规范英文。`
}

/**
 * 阶段三：为一个已经组合定稿的视频段补全需要模型填写的字段。
 * 只请求 schema 中 source === 'llm' 的字段，derived 字段作为只读上下文给出。
 */
export function buildSegmentFillMessages(input: SegmentFillInput): ChatMessage[] {
  const { schema, groupBeats, entities, existing, segmentIndex, segmentTotal, frames, fps } = input
  const lang = fillLang(input)
  const rules = FIELD_RULES[lang] ?? FIELD_RULES.zh

  const entityById = new Map(entities.map((e) => [e.id, e]))
  const nameOf = (id?: string | null) => (id ? entityById.get(id)?.name ?? '' : '')

  const targets = [...schema].sort((a, b) => a.order - b.order).filter((f) => f.source === 'llm')
  const targetKeys = new Set(targets.map((f) => f.key))

  const duration = (frames / fps).toFixed(3)
  const dialogueCount = groupBeats.filter((b) => b.kind === 'dialogue').length

  const usedIds = new Set<string>()
  for (const b of groupBeats) {
    for (const id of b.entities ?? []) usedIds.add(id)
    if (b.speakerId) usedIds.add(b.speakerId)
  }
  const entityBrief = [...usedIds]
    .map((id) => entityById.get(id))
    .filter((e): e is Entity => !!e)
    .sort((a, b) => (a.subjectN ?? 999) - (b.subjectN ?? 999))
    .map((e) => {
      const src =
        e.pictureN != null
          ? `参考图 <Picture ${e.pictureN}>`
          : '无参考图，按 subject_definitions 的文本描述'
      const voice = e.voiceDesc ? `音色：${e.voiceDesc}` : '不说话'
      const tag = `${subjectTag(e)}${e.sx != null ? ` ${sxTag(e)}` : ''}`
      return `- ${tag} ${e.name} — ${src}；${voice}`
    })
    .join('\n')

  const structure = groupBeats
    .map((b, i) => {
      const who = nameOf(b.speakerId) || nameOf(resolveSubjectId(b)) || '—'
      const body = b.kind === 'dialogue' ? `says: ${b.dialogue ?? ''}` : b.visualDesc || b.title
      return `${String(i + 1).padStart(2, '0')}. [${BEAT_KIND_LABEL[b.kind]}] ${who} — ${body}`
    })
    .join('\n')

  const seamBrief = (seam: SeamAnalysis | null, which: 'prev' | 'next'): string => {
    if (!seam) return which === 'prev' ? '本段是第一段，无前接。' : '本段是最后一段，无后接。'
    if (which === 'prev') {
      if (seam.blackFallback) return '上一段最后一帧为黑屏，本段自行决定开头。'
      return seam.needsPreshoot
        ? '上段结尾与本段首个说话主体一致，本段开头有 0.3 秒说话人独占预备镜头。'
        : '上段与本段直接顺接。'
    }
    if (seam.blackFallback) return '本段最后一帧黑屏，下段自行决定开头。'
    return seam.needsTailCut
      ? `本段最后 0.3 秒切镜至 ${nameOf(seam.tailCutTargetId)}。`
      : '本段结尾与下段主体一致，直接顺接。'
  }

  // 派生字段作为只读上下文，帮模型对齐镜头与主体，但不允许它改写
  const derivedContext = Object.entries(existing)
    .filter(([k, v]) => v && !targetKeys.has(k))
    .map(([k, v]) => `【${k}】\n${v}`)
    .join('\n\n')

  const targetList = targets
    .map((f) => `- ${f.key}：${rules[f.key] ?? f.promptHint ?? f.label}`)
    .join('\n')

  const jsonShape = JSON.stringify(Object.fromEntries(targets.map((f) => [f.key, ''])), null, 2)

  return [
    {
      role: 'system',
      content: `${BASE_SYSTEM}

现在是【视频段字段补全】。
分段已经组合定稿，镜头顺序、时间轴、主体绑定都不可更改。
你的任务只有一件：为这一段补全下面列出的字段。

硬性要求：
1. 只输出要求你生成的字段。其余字段是只读上下文，不要重复输出、不要改写。
${FILL_RULES[lang] ?? FILL_RULES.zh}
3. 不得编造镜头序列里不存在的信息。
4. 输出必须是合法 JSON，不要输出任何解释文字或 Markdown 代码块标记。

各字段的写作要求：
${targetList || '-（没有需要生成的字段）'}

输出 JSON 结构：
${jsonShape}`
    },
    {
      role: 'user',
      content: `【段信息】
第 ${segmentIndex + 1} / ${segmentTotal} 段
${frames} 帧 = ${duration} 秒
共 ${groupBeats.length} 拍，其中说话镜头 ${dialogueCount} 个

【段首衔接】${seamBrief(input.seamFromPrev, 'prev')}
【段尾衔接】${seamBrief(input.nextSeam, 'next')}

【出场实体与参考图】
${entityBrief || '-（无）'}

【本段镜头序列】
${structure}
${derivedContext ? `\n【已生成字段（只读，不要重复输出）】\n${derivedContext}` : ''}

请只生成这些字段：${targets.map((f) => f.key).join('、') || '（无）'}`
    }
  ]
}

/* --------------------------- 错误修复 --------------------------- */

export interface FixIssueInput {
  ruleId: string
  level: string
  message: string
  field?: string
}

export interface FixPatch {
  field: string
  value: string
  reason: string
}

export interface FixInput {
  schema: FieldSchema[]
  fields: Record<string, string>
  /** 只传「改字段就能修」的问题，结构性问题由调用方过滤掉 */
  issues: FixIssueInput[]
  groupBeats: Beat[]
  entities: Entity[]
  seamFromPrev: SeamAnalysis | null
  nextSeam: SeamAnalysis | null
  segmentIndex: number
  segmentTotal: number
  frames: number
  fps: number
  /** 用户附加的额外要求 */
  instruction?: string
}

/**
 * 把校验出的违规项交给模型改写字段。
 * 返回完整字段内容而不是 diff —— 模型产出局部补丁的可靠性太差。
 */
export function buildFixMessages(input: FixInput): ChatMessage[] {
  const { schema, fields, issues, groupBeats, entities, segmentIndex, segmentTotal, frames, fps } = input

  const entityById = new Map(entities.map((e) => [e.id, e]))
  const nameOf = (id?: string | null) => (id ? entityById.get(id)?.name ?? '' : '')

  const entityBrief = [...new Set(groupBeats.flatMap((b) => [...(b.entities ?? []), ...(b.speakerId ? [b.speakerId] : [])]))]
    .map((id) => entityById.get(id))
    .filter((e): e is Entity => !!e)
    .map((e) => {
      const pic = e.pictureN != null ? `<Picture ${e.pictureN}>` : '无参考图'
      const voice = e.voiceDesc ? `音色：${e.voiceDesc}` : '不说话'
      const tag = `${subjectTag(e)}${e.sx != null ? ` ${sxTag(e)}` : ''}`
      return `- ${tag} ${e.name} — ${pic}；${voice}`
    })
    .join('\n')

  const structure = groupBeats
    .map((b, i) => {
      const who = nameOf(b.speakerId) || nameOf(resolveSubjectId(b)) || '—'
      const body = b.kind === 'dialogue' ? `says: ${b.dialogue ?? ''}` : b.visualDesc || b.title
      return `${String(i + 1).padStart(2, '0')}. [${BEAT_KIND_LABEL[b.kind]}] ${who} — ${body}`
    })
    .join('\n')

  const issueList = issues
    .map((i, n) => `${n + 1}. [${i.ruleId}]${i.field ? ` 字段 ${i.field}` : ''} ${i.message}`)
    .join('\n')

  // 只把有内容的字段给模型，空字段让它按规则补
  const fieldBlocks = schema
    .filter((f) => (fields[f.key] ?? '').trim())
    .map((f) => `【${f.key}】\n${fields[f.key]}`)
    .join('\n\n')

  const emptyKeys = schema.filter((f) => !(fields[f.key] ?? '').trim()).map((f) => f.key)

  const jsonShape = JSON.stringify(
    { patches: [{ field: '字段名', value: '该字段修正后的完整内容', reason: '一句话说明改了什么' }], unfixable: [], notes: '' },
    null,
    2
  )

  return [
    {
      role: 'system',
      content: `${BASE_SYSTEM}

现在是【交付前错误修复】。
段已经组合定稿。下面列出了校验器在这段提示词里查出的违规项，
请通过改写相应字段的内容来修掉它们。

硬性要求：
1. 只修问题清单里点到的地方。没被点到的内容一律逐字保留，不要顺手润色、不要重排、不要改风格。
2. <d> 标签内的中文台词必须逐字保留。如果问题只出在标签外（说话人 ID 写法、标签格式），只改标签外的部分。
3. 不得编造镜头序列里不存在的信息；不得删掉镜头。
4. 返回的是「该字段修正后的完整内容」，不是补丁片段，也不是 diff。
5. 只把确实被修改过的字段放进 patches；没改的字段不要出现。
6. 如果你的判断是某个问题靠改字段根本修不掉，把它写进 unfixable 数组并说明原因，不要硬改。
7. 值为 1 的字段必须保留 <Subject N> 与 (Sx) 的严格对应；音色描述必须与给定的音色完全一致（含结尾的句号，之后跟 (Sx)）。
8. 无配乐时 non_diegetic_music 只填 N/A。
9. 输出必须是合法 JSON，不要输出解释文字或 Markdown 代码块标记。

输出 JSON 结构：
${jsonShape}`
    },
    {
      role: 'user',
      content: `【段信息】第 ${segmentIndex + 1} / ${segmentTotal} 段，${frames} 帧 = ${(frames / fps).toFixed(3)} 秒

【需要修掉的问题清单】
${issueList || '（无）'}

【出场实体与参考图】
${entityBrief || '-（无）'}

【本段镜头序列（只读，不要改动镜头）】
${structure}

【当前字段内容】
${fieldBlocks || '（全部为空）'}
${emptyKeys.length ? `\n（以下字段当前为空，需要按规则补出来：${emptyKeys.join('、')}）` : ''}
${input.instruction ? `\n【附加要求】\n${input.instruction}` : ''}

请输出 patches。`
    }
  ]
}

/* ------------------------------------------------------------------ *
 * 阶段五：中英本地化
 *
 * 前面几个阶段全部用中文撰写，交付前由模型把「自由描述」转成规范英文。
 * 分两步，目的是让结构不可能被翻译改坏：
 *   1) 词条表：把每个 Beat 的描述、每个实体的名称 / 外观 / 音色译成英文，
 *      逐条落库（Beat.titleEn / Entity.nameEn …），全片统一复用；
 *   2) 派生字段由引擎用英文词条重新渲染，
 *      只有 summary / overall_soundscape / non_diegetic_music 需要模型译。
 * 结构锚点（<Subject N> / (Sx) / <Picture N> / <d> / 时间码）始终由引擎拼装，
 * 不经过模型，因此本地化不会破坏任何格式约束。
 * ------------------------------------------------------------------ */

export interface GlossaryInput {
  beats: Beat[]
  entities: Entity[]
  /** 已定稿的译名（前几批的产出）：本批必须逐字复用，不得另起译法 */
  fixedNames?: Record<string, string>
  /** 分批标注，例如 "实体词条 2 / 5" */
  scopeLabel?: string
}

export interface GlossaryEntityPatch {
  id: string
  name: string
  voiceDesc: string
  textDesc: string
}

export interface GlossaryBeatPatch {
  id: string
  title: string
  direction: string
  visualDesc: string
}

/** 第一步：词条表翻译（全片一次） */
export function buildGlossaryMessages(input: GlossaryInput): ChatMessage[] {
  const entityRows = input.entities
    .map((e) => {
      const parts = [
        `id: ${e.id}`,
        `名称: ${e.name}`,
        `类型: ${e.type}`,
        `说话: ${e.kind === 'speaking' ? '是' : '否'}`,
        e.voiceDesc ? `音色: ${e.voiceDesc}` : '',
        e.textDesc ? `外观: ${e.textDesc}` : ''
      ].filter(Boolean)
      return `- ${parts.join(' | ')}`
    })
    .join('\n')

  const beatRows = input.beats
    .map((b) => {
      const parts = [`id: ${b.id}`, `标题: ${b.title}`]
      if (b.direction) parts.push(`运镜: ${b.direction}`)
      if (b.visualDesc) parts.push(`画面: ${b.visualDesc}`)
      return `- ${parts.join(' | ')}`
    })
    .join('\n')

  const fixedNames = input.fixedNames ?? {}
  const fixedBlock = Object.keys(fixedNames).length
    ? `【已定稿译名（必须逐字复用，不要重新翻译）】
${Object.entries(fixedNames)
  .map(([zh, en]) => `- ${zh} → ${en}`)
  .join('\n')}

`
    : ''

  const jsonShape = JSON.stringify(
    {
      entities: [{ id: '', name: '', voiceDesc: '', textDesc: '' }],
      beats: [{ id: '', title: '', direction: '', visualDesc: '' }]
    },
    null,
    2
  )

  return [
    {
      role: 'system',
      content: `你是影视提示词的本地化译者，负责把中文工作稿转成 MiniMax H3 Ref2VA 可用的规范英文终稿。

现在是【本地化第一步：词条表翻译】${
        input.scopeLabel ? `（${input.scopeLabel}）` : ''
      }。只译词条，不译句子，不译台词。

硬性要求：
1. 逐条返回，id 原样返回，一条都不能少、不能多、不能改序。
2. 实体名 name：短、可读、可直接朗读的英文专名。
   - 中文人名 / 地名优先用拼音（楚辞 → Chuci），但带明显含义的称号、职业、器物要意译（老掌柜 → Old Shopkeeper，青霜剑 → Frostblade）。
   - 全片同一个实体只能用同一个名字；不同实体不能撞名。
   - 「已定稿译名」里的对照必须逐字复用，哪怕你觉得有更好的译法，也不要改；
     这一批只译新出现的词条。
3. 音色描述 voiceDesc：写成 "speaking with ..." 里 "..." 的那部分内容，一句英文，以句号结尾，不要带 (Sx)，不要带引号。
   - 例：青年男声，略带沙哑 → a young male voice, slightly hoarse
4. 外观描述 textDesc：一句英文，描述外观特征，去掉结尾多余标点。
5. 镜头描述 direction / visualDesc、片段标题 title：译成简短自然的英文，保留原意与细节，不要加戏。
6. 原字段为空就返回空字符串，不要凭空补内容。
7. 不得出现中文。台词（对白原文）不属于本步骤，不要在这里翻译。
8. 输出必须是合法 JSON，不要输出解释文字或 Markdown 代码块标记。

输出 JSON 结构：
${jsonShape}`
    },
    {
      role: 'user',
      content: `${fixedBlock}
${entityRows ? `【实体词条】\n${entityRows}\n\n` : ''}${
        beatRows ? `【片段词条】\n${beatRows}\n\n` : ''
      }请逐条输出英文词条。${input.fixedNames && Object.keys(input.fixedNames).length ? '已定稿译名不必重复输出。' : ''}`
    }
  ]
}

export interface LocalizeFieldsInput {
  schema: FieldSchema[]
  /** 中文原稿（含引擎派生字段，作为只读上下文） */
  fields: Record<string, string>
  groupBeats: Beat[]
  entities: Entity[]
  segmentIndex: number
  segmentTotal: number
  frames: number
  fps: number
  /** 已确定的英文词条：中文实体名 -> 英文名 */
  entityNameMap: Record<string, string>
}

/** 第二步：段内模型字段的中译英 */
export function buildLocalizeFieldsMessages(input: LocalizeFieldsInput): ChatMessage[] {
  const { schema, fields, groupBeats, segmentIndex, segmentTotal, frames, fps } = input

  const targets = [...schema].sort((a, b) => a.order - b.order).filter((f) => f.source === 'llm')
  const targetKeys = targets.map((f) => f.key)

  const dict = Object.entries(input.entityNameMap)
    .map(([zh, en]) => `- ${zh} → ${en}`)
    .join('\n')

  const structure = groupBeats
    .map(
      (b, i) =>
        `${String(i + 1).padStart(2, '0')}. [${BEAT_KIND_LABEL[b.kind]}] ${b.title}${b.dialogue ? ` — ${b.dialogue}` : ''}`
    )
    .join('\n')

  const source = targets
    .map((f) => `【${f.key}（中文原稿）】\n${(fields[f.key] ?? '').trim() || '（空）'}`)
    .join('\n\n')

  const jsonShape = JSON.stringify(Object.fromEntries(targets.map((f) => [f.key, ''])), null, 2)

  return [
    {
      role: 'system',
      content: `${BASE_SYSTEM}

现在是【本地化第二步：段字段中译英】。
前面几步已经把这段的中文工作稿定稿，现在只做一件事：把它译成规范英文终稿。

硬性要求：
1. 只翻译下面列出的字段，逐字段返回完整英文内容。
2. summary 必须以字面量 [reference generation] 开头（含方括号）。
3. <Subject N> / (Sx) / <Picture N> 是结构标记，原样保留；实体名一律使用给定的「译名对照表」。
4. <d> 标签内的中文台词逐字保留，一个字都不要改、不要翻译。
5. non_diegetic_music 若无配乐只返回 N/A 三个字符。
6. 只做翻译与规范化，不要新增镜头、不要删信息、不要改叙事方向。
7. 不得在 <d> 之外残留任何中文。
8. 输出必须是合法 JSON，不要输出解释文字或 Markdown 代码块标记。

输出 JSON 结构：
${jsonShape}`
    },
    {
      role: 'user',
      content: `【段信息】第 ${segmentIndex + 1} / ${segmentTotal} 段，${frames} 帧 = ${(frames / fps).toFixed(3)} 秒

【实体译名对照表（必须逐字使用）】
${dict || '-（无）'}

【本段镜头序列（只读）】
${structure}

${source}

请只输出这些字段的英文版：${targetKeys.join('、') || '（无）'}`
    }
  ]
}
