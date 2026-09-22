import type { Beat, Entity, FieldSchema, Group } from '@/domain/types'
import type { ChatMessage } from './types'

/* ------------------------------------------------------------------ *
 * 阶段意见 —— 把自然语言诉求变成可审查的结构化补丁
 *
 * 设计要点：
 *  1. 模型只输出补丁，不输出整份改好的内容。整份改写会顺手润色没被点到的
 *     地方，用户根本看不出改了什么。
 *  2. 定位一律用「序号」而不是 id。模型抄不透明 id 极容易抄错，
 *     而序号就是它在清单里看到的东西。
 *  3. 应用顺序固定：实体 → 片段 → 分组 → 段字段；
 *     一旦动了片段或分组，段字段补丁就作废（系统会让受影响的段重新生成），
 *     避免模型按旧结构算出来的段号被套到新结构上。
 * ------------------------------------------------------------------ */

export type AdviceStage = 'split' | 'enrich' | 'assemble' | 'complete' | 'localize' | 'deliver'

export const ADVICE_STAGE_LABEL: Record<AdviceStage, string> = {
  split: '① 拆解',
  enrich: '② 细节填充',
  assemble: '③ 组合与缝合',
  complete: '④ 字段补全',
  localize: '⑤ 中英本地化',
  deliver: '⑥ 交付'
}

/** 本阶段的"主场"职责：模型越级改别的对象时，要有意识这是越级 */
const STAGE_DUTY: Record<AdviceStage, string> = {
  split: '片段的新增 / 删除 / 拆分、标题、类型（kind）、台词原文、场景与主体绑定、实体登记。',
  enrich: '每个镜头的运镜 direction、画面 visualDesc、聚焦主体 focus、说话人、主体与场景绑定。',
  assemble: '分段的边界（在哪一刀切开、哪几段合并）、某段是否引用上一段。',
  complete: '各段模型字段的内容：summary / overall_soundscape / non_diegetic_music。',
  localize: '英文词条（实体名 / 音色 / 外观、片段标题 / 运镜 / 画面）与各段的英文模型字段。',
  deliver: '按校验结果收尾：字段写法的违规项、以及需要回上游调整的结构问题。'
}

/* --------------------------- 补丁结构 --------------------------- */

/**
 * 补丁一律是「部分」的：
 *   字段不出现 = 不改（默认）
 *   字段为 null = 清空
 *   字段有值   = 改成这个值
 * 所以模型只该返回真正要改的那几个字段，不要把整个对象抄一遍。
 */
export interface AdviceBeatPatch {
  op: 'update' | 'insert' | 'delete'
  /** 片段序号，1 起，对应下方清单里的编号。update / delete 必填 */
  index?: number
  /** insert：插在这个序号之后；0 表示插到最前面 */
  afterIndex?: number
  title?: string | null
  kind?: string
  dialogue?: string | null
  direction?: string | null
  visualDesc?: string | null
  /** 下面几项填实体「名称」，不是 id；null 表示解绑 */
  scene?: string | null
  entities?: string[]
  speaker?: string | null
  focus?: string | null
  /** 本地化阶段用：英文词条 */
  titleEn?: string | null
  directionEn?: string | null
  visualDescEn?: string | null
  reason?: string
}

export interface AdviceEntityPatch {
  op: 'update' | 'insert' | 'delete'
  /** 用名称定位；insert 时是新实体的名字 */
  name: string
  type?: string
  kind?: 'speaking' | 'non_speaking'
  voiceDesc?: string | null
  textDesc?: string | null
  nameEn?: string | null
  voiceDescEn?: string | null
  textDescEn?: string | null
  reason?: string
}

export interface AdviceGroupPatch {
  op: 'split' | 'merge' | 'refPrev'
  /** split：在第 N 个片段之前切开（片段序号，1 起） */
  atBeatIndex?: number
  /** merge：第 fromSegment 段到第 toSegment 段合并（段号 1 起） */
  fromSegment?: number
  toSegment?: number
  /** refPrev：段号，1 起 */
  segment?: number
  refPrev?: boolean
  reason?: string
}

export interface AdviceFieldPatch {
  /** 段号，1 起 */
  segment: number
  key: string
  value: string
  reason?: string
}

export interface StageAdvice {
  /** 一句话说明你打算怎么改 */
  summary?: string
  beats?: AdviceBeatPatch[]
  entities?: AdviceEntityPatch[]
  groups?: AdviceGroupPatch[]
  fields?: AdviceFieldPatch[]
  /** 用补丁表达不了、需要人工处理的事 */
  notes?: string
}

/* --------------------------- 输入 --------------------------- */

export interface AdviceSegmentBrief {
  index: number
  beats: Beat[]
  fields: Record<string, string>
  /** 模型字段是否已过期 */
  stale: boolean
}

export interface AdviceInput {
  stage: AdviceStage
  /** 用户的原话 */
  request: string
  beats: Beat[]
  entities: Entity[]
  groups?: Group[]
  segments?: AdviceSegmentBrief[]
  schema: FieldSchema[]
  /** 本次允许模型越级到什么程度，用于收紧范围 */
  scope?: 'auto' | 'beats' | 'beats-fields' | 'groups' | 'segments'
}

/* --------------------------- 生成 --------------------------- */

function beatLine(b: Beat, i: number, nameOf: (id?: string | null) => string): string {
  const parts = [`${i + 1}.`, `[${b.kind}]`, b.title || '（无标题）']
  if (b.dialogue) parts.push(`台词「${b.dialogue}」`)
  if (b.sceneId) parts.push(`场景「${nameOf(b.sceneId)}」`)
  const subs = (b.entities ?? []).map((id) => nameOf(id)).filter(Boolean)
  if (subs.length) parts.push(`主体「${subs.join('+')}」`)
  if (b.speakerId) parts.push(`说话人「${nameOf(b.speakerId)}」`)
  if (b.focusEntityId) parts.push(`聚焦「${nameOf(b.focusEntityId)}」`)
  if (b.direction) parts.push(`运镜「${b.direction}」`)
  if (b.visualDesc) parts.push(`画面「${b.visualDesc}」`)
  if (b.titleEn) parts.push(`英文标题「${b.titleEn}」`)
  return `- ${parts.join(' ')}`
}

export function buildAdviceMessages(input: AdviceInput): ChatMessage[] {
  const { stage, request, beats, entities, schema } = input
  const duty = STAGE_DUTY[stage]

  const entityById = new Map(entities.map((e) => [e.id, e]))
  const nameOf = (id?: string | null) => (id ? (entityById.get(id)?.name ?? '(已删除)') : '')

  const ordered = [...beats].sort((a, b) => a.order - b.order)

  const beatTable = ordered.map((b, i) => beatLine(b, i, nameOf)).join('\n')

  const entityTable = entities
    .map((e) => {
      const parts = [`- ${e.name}`, `[${e.type}/${e.kind}]`]
      if (e.pictureN != null) parts.push(`<Picture ${e.pictureN}>`)
      if (e.voiceDesc) parts.push(`音色「${e.voiceDesc}」`)
      if (e.textDesc) parts.push(`外观「${e.textDesc}」`)
      if (e.nameEn) parts.push(`英文名「${e.nameEn}」`)
      return parts.join(' ')
    })
    .join('\n')

  const groupTable = input.segments?.length
    ? input.segments
        .map((s) => {
          const ids = s.beats.map((b) => ordered.findIndex((x) => x.id === b.id) + 1).filter((n) => n > 0)
          return `- 第 ${s.index} 段：片段 ${ids.join(', ') || '（空）'}（${s.beats.length} 拍）`
        })
        .join('\n')
    : ''

  const fieldTable = input.segments?.length
    ? input.segments
        .map((s) => {
          const rows = schema
            .filter((f) => f.source === 'llm')
            .map((f) => `    ${f.key}: ${(s.fields[f.key] ?? '').trim() || '（空）'}`)
            .join('\n')
          return `- 第 ${s.index} 段${s.stale ? '（★ 上游已改，当前内容可能过期）' : ''}\n${rows}`
        })
        .join('\n')
    : ''

  const scopeHint: Record<NonNullable<AdviceInput['scope']>, string> = {
    auto: '按用户诉求决定改哪些对象',
    beats: '只改片段本身，不要动分组与段字段',
    'beats-fields': '可以改片段，也可以改各段的模型字段',
    groups: '只调整分段边界，不要改片段内容',
    segments: '只改段字段内容，不要动片段与分组'
  }

  return [
    {
      role: 'system',
      content: `你是影视分镜流水线里的审阅助手。用户对当前阶段的结果提出意见，
你的任务是判断「哪些对象需要改、改成什么」，输出结构化补丁交给用户逐条审查。

当前阶段：${ADVICE_STAGE_LABEL[stage]}
这个阶段的分内职责是：${duty}
如果用户的意见涉及别的层面，可以越级修改对应对象 —— 以用户意图为准，
但要在 reason 里说明这是越级改动。本次允许范围：${scopeHint[input.scope ?? 'auto']}

硬性要求：
1. 只输出补丁，不要输出整份改写后的内容。没被点到的对象一律不要出现在补丁里。
2. ★★ 补丁是「部分」的 —— 只输出你要改的那几个字段，其余字段一律不要写进 JSON。
   - 字段不出现 = 不改，这是默认行为，**不要为了"填满模板"而把整个对象抄一遍**；
   - 关键：如果你只改场景，就只返回 scene，不要带 title / direction / visualDesc；
     如果只改说话人，就只返回 speaker，不要带 entities。
     带不相关内容会被当成"你确实想改它"，风险很大。
   - 想清空某个字段，显式写 null（例："direction": null），不要写空字符串。
3. 定位一律用清单里的「序号」或「名称」，不要编造 id。
   - 片段序号是 1 起，对应全片清单里的编号；
   - 插入用 afterIndex 表示"插在这个序号之后"，0 表示插到最前面。
4. 每条补丁都必须写 reason，一句话说清为什么改。
5. 只改必须改的。不要顺手润色、不要重排顺序、不要改风格、不要补充用户没提的内容。
6. 台词（dialogue）是纯台词本身，不要加角色名、引号、<d> 标签或任何格式标记。
7. 实体名必须与「实体清单」里已有名称或你在 entities 里新增的名称完全一致。
8. 如果本次要「增删片段」或「调整分段边界」，就不要输出 fields ——
   段号是按当前结构算的，结构一变就失效，系统会让受影响的段重新生成。
   只改片段内容（标题 / 运镜 / 画面 / 台词）不影响段号，可以照常输出 fields。
9. 如果用户的诉求靠补丁表达不了（例如需要人工重新讲故事），写进 notes，不要硬改。
10. 如果用户的意见本身有歧义、或者你判断不需要改动，输出空的补丁数组并把原因写进 summary。
11. 输出必须是合法 JSON，不要输出解释文字或 Markdown 代码块标记。

可用的字段名（这是词表，不是让你填满的模板）：
  summary    一句话说明你打算怎么改（可选）
  beats[]    片段补丁
             op          必填：update | insert | delete
             index       片段序号，1 起；update / delete 必填
             afterIndex  仅 insert：插在这个序号之后，0 = 插到最前面
             可改字段    title / kind / dialogue / direction / visualDesc /
                         scene / entities / speaker / focus /
                         titleEn / directionEn / visualDescEn
  entities[] 实体补丁
             op          必填：update | insert | delete
             name        必填，用名称定位；insert 时是新实体的名字
             可改字段    type / kind / voiceDesc / textDesc /
                         nameEn / voiceDescEn / textDescEn
  groups[]   分段补丁
             op          必填：split | merge | refPrev
             split  →    atBeatIndex（在第 N 个片段之前切）
             merge  →    fromSegment, toSegment
             refPrev →   segment, refPrev
  fields[]   段字段补丁
             segment     段号，1 起
             key         字段名
             value       新内容
  notes      补丁表达不了、需要人工处理的事（可选）

每条补丁还可以带 reason（一句话说明为什么改）。

最小示例 —— 只把第 3 个片段的场景换掉、再删掉第 5 个片段：
{
  "summary": "第 3 个片段的场景绑错了，第 5 个片段与第 4 个重复",
  "beats": [
    { "op": "update", "index": 3, "scene": "九幽毒渊", "reason": "原本绑错了场景" },
    { "op": "delete", "index": 5, "reason": "与第 4 个片段重复" }
  ]
}
注意这个例子里**没有**出现 title / direction / entities —— 因为不需要改它们。`
    },
    {
      role: 'user',
      content: `【全片片段清单（共 ${ordered.length} 个）】
${beatTable || '-（无）'}

【实体清单（共 ${entities.length} 个）】
${entityTable || '-（无）'}
${groupTable ? `\n【当前分段结构】\n${groupTable}` : ''}
${fieldTable ? `\n【各段模型字段现状】\n${fieldTable}` : ''}

【用户的意见】
${request}

请输出补丁。`
    }
  ]
}
