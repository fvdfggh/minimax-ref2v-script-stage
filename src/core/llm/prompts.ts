import specText from '../../../说明.txt?raw'
import type { Asset, Beat, Entity, EntityKind, EntityType, FieldSchema, Lang, SeamAnalysis } from '@/domain/types'
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

export const BASE_SYSTEM = `你是一个影视分镜与提示词工程助手，服务于 MiniMax H3 Ref2VA 多段拼接视频生成。
下面的团队规范文档是你唯一的判定依据，必须严格遵守：

<spec>
${specText}
</spec>

输出必须是合法 JSON，不要输出任何解释文字或 Markdown 代码块标记。`

/**
 * 素材说明只读上下文：把每张参考图 / 参考音频的 desc 交给模型，
 * 帮它理解 <Picture N> 里到底是什么，从而写出更准确的字段。
 *
 * ★ 关键：这只是一段「只读上下文」，不是任何输出字段的内容。
 *   最终提示词里 <Picture N> 是权威的结构标记，视频模型也会直接看到参考本体，
 *   所以 desc 绝不能被原样 / 改写进输出。这里明确告知模型这一点。
 * 没有 desc 的素材不出现；全是空则返回空串（调用方不额外输出）。
 */
function referenceNotes(assets?: Asset[]): string {
  if (!assets?.length) return ''
  const rows = assets
    .filter((a) => a.pictureN > 0 && a.kind !== 'scene' && (a.desc ?? '').trim())
    .sort((a, b) => a.pictureN - b.pictureN)
    .map((a) => `- <Picture ${a.pictureN}>: ${a.desc!.trim()}`)
  if (!rows.length) return ''
  return (
    '【参考素材说明（只读上下文：帮你理解每张参考图 / 参考音频里是什么，供撰写时参考）】\n' +
    rows.join('\n') +
    '\n⚠ 以上仅供你理解参考内容，不要原样或改写写进任何输出字段；最终提示词里只保留 <Picture N> 结构标记。'
  )
}

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
  /**
   * 这一拍是「在时间上不连续地进入」（次日 / 三年后 / 闪回 / 梦境）。
   * 场景没变也标 —— 装配阶段判转场只认结构化字段，不猜文本。
   */
  transition?: boolean
}

/** 主体只有三类：角色 / 场景 / 道具（与 domain/types.ts 的 EntityType 一致） */
export type ProposedEntityType = EntityType

export interface Stage1NewEntity {
  name: string
  type: ProposedEntityType
  kind: 'speaking' | 'non_speaking'
  /** 会说话角色必须给出固定音色描述，后续跨段逐字复用 */
  voiceDesc?: string
  /** 无图实体的纯文本视觉描述：**只写长相**（脸 / 发型 / 肤色 / 年龄 / 体型骨架） */
  textDesc?: string
  /** 穿什么 + 体型。与 textDesc 分开写：头部图只读长相，三视图才读这一段 */
  costumeDesc?: string
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

/**
 * 拆解时带上的「外部项目主体」。
 *
 * 两级结构里，项目(系列)自己的实体表是跨集复用的母版：第 2 集拆解时如果
 * 只看到本集实体，模型就会把「林医生」再定义一遍，描述还和第 1 集对不上。
 * 所以把项目层主体（带设定，不只是名字）一并交给模型，让它**按名字引用**，
 * 命中的人不再进 newEntities —— 系统落库时从项目取用，而不是新建副本。
 */
export interface ProjectSubjectBrief {
  id?: string
  name: string
  type: EntityType
  kind: EntityKind
  /** 长相 / 场景外观 */
  textDesc?: string | null
  costumeDesc?: string | null
  voiceDesc?: string | null
  note?: string | null
}

export interface Stage1Options {
  language?: Lang
  batch?: Stage1Batch
  /** 项目层（母版）已有的主体：可引用、不许重复定义 */
  projectSubjects?: ProjectSubjectBrief[]
}

/** 描述太长会挤占拆解本身的注意力，截断到一句半即可 */
function clipDesc(s: string | null | undefined, max = 120): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * 项目主体清单块。
 *
 * ★ 一定要带设定，而不只是名字：只给名字，模型知道"有这个人"，但不知道
 *   长什么样，本集遇到他的新镜头时仍会自己编一套描述，重复定义就回来了。
 */
function projectSubjectBlock(list: ProjectSubjectBrief[] | undefined): string {
  if (!list?.length) {
    return `外部项目暂无主体：本片出现的主体请照常登记；系统会先在项目层建立一个空主体，再完成拆解与绑定。`
  }
  const rows = list.slice(0, 80).map((e) => {
    const parts = [`- ${e.name}`, e.type, e.kind]
    if (e.voiceDesc) parts.push(`音色：${clipDesc(e.voiceDesc)}`)
    if (e.textDesc) parts.push(`${e.type === 'scene' ? '环境' : '外观'}：${clipDesc(e.textDesc)}`)
    if (e.costumeDesc) parts.push(`服装：${clipDesc(e.costumeDesc)}`)
    if (e.note) parts.push(`备注：${clipDesc(e.note, 60)}`)
    return parts.join(' | ')
  })
  const more = list.length > rows.length ? `\n（另有 ${list.length - rows.length} 个未列出，命名仍以母版为准）` : ''
  return `${rows.join('\n')}${more}`
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

  /**
   * 篇幅 → 片段数的量化锚点。
   *
   * 只写「拆细一点」时模型会按自己的预算压缩条数：一段 240 字的原文拆成 12 拍，
   * 就是把「动作 + 台词」并成了一拍。给一个字数区间，让它有可对照的产出量，
   * 同时用「明显偏少就是拆粗了」留出判断空间（场景标题这类不一定成拍）。
   */
  const chars = story.replace(/\s+/g, '').length
  const lowBeats = Math.max(1, Math.round(chars / 16))
  const highBeats = Math.max(lowBeats + 1, Math.round(chars / 8))
  const scaleHint =
    chars > 40
      ? `篇幅参考：本段原文约 ${chars} 字，按「一句话一拍」约对应 ${lowBeats}~${highBeats} 个片段；` +
        `明显比 ${lowBeats} 个少，就是拆粗了（多半是把动作并进了台词拍）。`
      : ''

  const batchRule = batched
    ? `
── C. 分批规则（本次是第 ${batch!.index} / ${batch!.total} 批）──
24. 你只负责「本批原文」，不要复述全文，不要输出上文已经给出的片段。
25. 下面会给出上文末尾的几个片段标题作为续接锚点：
    - 只用它判断本批第一个片段该怎么接上；
    - 不要重新输出这些片段，也不要改写它们的措辞。
26. 实体命名必须与上文一致：已知实体清单一律复用，不允许另起一种写法。
27. 只有在本批是最后一批时才做自然收束；否则按原文继续推进，
    不要提前总结、不要写"未完待续"、不要在结尾加收尾镜头。
28. 不要为了控制数量而合并动作或台词：
    - 宁可把动作拆得更细，也不要跳过原文内容；
    - 尤其不许把「动作 + 台词」并成一条来省条数 —— 该拆成两拍的，一定拆成两拍。`
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
  B. 同时把故事里出现过的实体（角色、场景、道具）登记出来，并让每个 Beat 绑定它涉及的实体。

── A. 拆解规则 ──
1. 一个 Beat = 一个镜头 = 只做一件事。动作、场景切换、台词、铺垫、反应、特写各自独立成 Beat。
2. ★ 台词 Beat 只装「说」这一件事。说话不是动作，说话前该做的动作必须先有自己的一拍。
   - dialogue 非空的 Beat，title 里**不许出现任何身体动作**：
     抬头 / 转头 / 转身 / 回头 / 低头 / 抬眼 / 看 / 望向 / 伸手 / 拿起 / 放下 / 推开 / 拉 /
     递 / 掏 / 走 / 站起 / 坐下 / 停下 / 擦 / 握 / 皱眉 / 点头 / 摇头 / 点烟 / 推门 —— 全算动作。
   - 只允许言语动词：说 / 问 / 答 / 回 / 反问 / 追问 / 解释 / 补充 / 承认 / 否认 / 拒绝 /
     提醒 / 建议 / 感叹 / 喊 / 低语。
   - 不许用「并 / 同时 / 一边…一边 / 边…边 / 顺手 / 随后 / 之后」把动作缝到台词拍上。
   - 台词 Beat 的 title 只写「谁 + 怎么发话」，例：「林晚回应」「陈默解释来意」。
     同一主体连着几句时，用不同的言语动词区分（回应 / 追问 / 补充 / 拒绝…），不要写成一样的。
   - dialogue 字段只写纯台词本身：不带角色名、不带引号、不带 <d> 标签、不带任何格式标记。
     例：dialogue: "我不信这世上没有解药。"
   - ✗ 违规（一个镜头里先动后说）：title「林晚抬头看他，把找零推回去」+ dialogue「你每次都这么说」
   - ✓ 正解：action「林晚抬头看了他一眼」→ action「林晚把找零的硬币推回去」→ dialogue「林晚回应」
3. 台词**之后**的动作（放下杯子、转身走开、低头沉默）同样单独成 Beat，按原文顺序排在台词拍后面。
4. 原文一句话里同时写了动作和台词时，一律按原文顺序拆成多个 Beat：先动作，后台词，再后续动作。
   宁可用一个 1 秒的短镜头，也不许让说话人一边做事一边说话。
5. 台词与台词也不合并：原文每一句台词（每一处引号 / 每一个「人名：」）对应**一个** dialogue Beat。
   不同的话不许并进同一拍；同一句话也不许拆成两拍（不拆同一句台词）。
6. 一个 Beat 只放一个动作：title 里出现两个不同动词（逗号 / 顿号并列）就拆开。
   ✗「陈默推门进来，环顾四周，走向柜台」→ ✓ 三个 Beat。
   （同一个动作的连续细节可以留在同一拍：「陈默推门进来，外套湿透」）
7. 反应独立成 reaction Beat：对方说完之后的表情、沉默、眼神变化，不要塞进台词拍。
8. 粗细基准：一个 Beat 大致对应原文一句话（约 10~20 个字）。
   - 一条 Beat 盖住了原文两三行，就是拆粗了；
   - 但也不要为了凑数把一句话硬切成前后两半。
9. 动作与场景切换用 title 描述，dialogue 留空。
10. kind 只能取：dialogue、action、scene_switch、establishing、reaction、insert。
11. 时长：一个动作 Beat 不超过 3 秒；一句台词 Beat 不超过 5 秒。超了继续拆。
12. title 用${free}，一句话一个动词；不要出现镜头编号与时间戳。
13. 不要臆造故事里没有的情节，保持原有顺序与因果。
14. 若这一拍在**时间上不连续**地进入（次日 / 三天后 / 多年以后 / 闪回 / 梦境 / 回忆 / 醒来），
   置 "transition": true；其余情况省略这个字段。
   - 换场（scene 变了）不用标，系统按场景自动判定。
   - 只按原文判断，不要凭"感觉这段该转场了"来标。

── A2. 出结果前自检（逐条过一遍，任何一条不过就改完再输出）──
□ 每个 dialogue Beat 的 title 里都没有身体动作，只描述「说话」这件事？
□ 台词拍里没有「并 / 同时 / 一边 / 边…边 / 顺手」这类把两件事缝在一起的词？
□ 台词之前该做的动作，是否都已经排在前面、各自单独成 Beat（而不是塞进台词拍）？
□ 每个 action Beat 只有一个动作，没有「推门、环顾、走过去」这种连串？
□ 听者的反应 / 沉默没有塞进台词拍？
□ 原文每一句台词都对得上一个 dialogue Beat（数量能数得出来）？

── B. 实体与绑定规则 ──
15. 每个 Beat 必须给出 scene，值是它所在场景的实体名，该实体的 type 必须是 scene。场景是必填项。
16. 每个 Beat 还可以给出 entities 数组，列出这个镜头里出现的「其他主体」（角色、道具）。
   - entities 可以为空数组：纯场景镜（空镜、环境铺垫、换场）没有角色是允许的。
   - 不要把场景名重复写进 entities。
17. 台词 Beat 必须额外给出 speaker，它的值必须同时出现在 entities 里，且该实体必须是 kind = speaking。
18. 实体名必须与"已知实体"或你在 newEntities 里声明的名字完全一致，不允许出现第三种写法。
19. 会说话的角色：只要在故事里发过声，kind 填 speaking，并必须给出固定音色描述 voiceDesc：
    - ${free}，一句话，形如${lang === 'zh' ? '"青年男声，略带沙哑，疲惫但坚定"' : '"speaking with a young male voice, slightly hoarse, tired but determined"'}
    - 不要带 (Sx) 后缀，编号由系统分配
    - 同一角色全片只描述一次，后续复用
20. 场景必须作为独立实体登记：type 填 scene，kind 填 non_speaking，并给 textDesc 描述环境外观。
    - 每个实际出现的场景都要有独立的场景实体，不要拿角色名或道具名当场景。
21. 不说话的角色、场景、道具：kind 填 non_speaking，不要写 voiceDesc。
22. 实体的外观**必须分两个字段写**，一个字段只写一件事，绝不许混：
    - textDesc = 长相：五官、脸型、发型、肤色、年龄、体型骨架、标志性身体细节（疤 / 痣 / 纹身）。
      ✗ 严禁出现任何衣物、鞋、帽、包、配饰、妆造 ——「穿着 / 身穿 / 戴着 / 换了身 / wearing / outfit」都算违规。
      ✓ 正例：${lang === 'zh' ? '"男性，约三十岁，短发微乱，瘦削，右眉一道旧疤"' : '"male, around thirty, slightly messy short hair, lean, an old scar through the right eyebrow"'}
      ✗ 反例：${lang === 'zh' ? '"男性，穿着湿透的外套，神情疲惫"' : '"a man wearing a soaked coat, exhausted"'}
    - costumeDesc = 服装与身形：这一套造型穿什么（款式 / 颜色 / 材质 / 鞋 / 配饰）。
      **角色必填**，再简单也要写${lang === 'zh' ? '（例："深灰工装外套，黑色长裤，旧球鞋"）' : '（e.g. "dark grey work jacket, black trousers, worn sneakers"）'}，不许留空。
    - 场景 / 道具没有"穿"，只写 textDesc，costumeDesc 留空。
    - 两段都不写动作、表情、情绪、镜头、机位、剧情 —— 那些属于**具体某一拍**，写到主体上会让这个人每张图都在重复同一个动作。
    - 反例：${lang === 'zh' ? '"他正转身回头，疲惫地看着镜头"' : '"he is turning around and looking at the camera"'}
23. 已经存在、无需新建的实体不要放进 newEntities，但可以正常在 scene / entities 里引用。
── B2. 外部项目主体（跨集复用的母版，优先复用）──
- 下面是本集所属项目已有的主体（母版）。故事里出现它们时**直接按清单里的名字引用**
  （scene / entities / speaker 都可以用），不要因为本集还没有就另起一种写法，
  也不要写进 newEntities —— 系统会自动把它们取用到本集。
- 只有清单里确实没有的主体，才登记进 newEntities。
- 命中的主体沿用母版的设定，不要在本集重新描述它的长相 / 服装 / 音色。
清单：
${projectSubjectBlock(options.projectSubjects)}
${batchRule}

本集已有实体（可直接引用，不要重复放进 newEntities）：
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
      "speaker": "实体名，仅台词片段需要",
      "transition": "true，仅时间跳跃进入的片段需要，其余省略"
    }
  ],
  "newEntities": [
    {
      "name": "实体名",
      "type": "character|scene|prop",
      "kind": "speaking|non_speaking",
      "voiceDesc": "${free}音色描述，仅 speaking",
      "textDesc": "${free}长相（五官/发型/肤色/年龄，不写穿着）",
      "costumeDesc": "${free}服装与身形（款式/颜色/材质/鞋），场景道具留空",
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
拆到一句话一个镜头：动作各自成拍，**台词拍只说话**，说话前的动作一律放在前面单独的片段里。
${scaleHint}

<本批原文>
${story}`
        : `请拆解以下故事，并登记其中的实体（注意：每个片段都必须归属到一个场景）。
拆到一句话一个镜头：动作各自成拍，**台词拍只说话**，说话前的动作一律放在前面单独的片段里。
${scaleHint}

${story}`
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
  options: { language?: Lang; projectSubjects?: ProjectSubjectBrief[] } = {}
): ChatMessage[] {
  const free = (options.language ?? 'zh') === 'zh' ? '中文' : '英文'
  return [
    {
      role: 'system',
      content: `${BASE_SYSTEM}

现在是【实体梳理】。只做一件事：把故事里出现过的实体完整登记出来。

规则：
1. 覆盖到角色、场景、道具三类。不要遗漏只在背景里出现的场景。
2. 会说话的角色 kind 填 speaking，并给出${free} voiceDesc（形如 ${free === '中文' ? '"成熟男声，慵懒傲慢"' : '"speaking with a mature male voice, lazy and arrogant"'}），不带 (Sx) 后缀。
3. 不说话的实体 kind 填 non_speaking，不写 voiceDesc，改为尽量给出外观，**分两个字段，一个字段只写一件事**：
   - textDesc：长相（五官 / 脸型 / 发型 / 肤色 / 年龄 / 体型骨架 / 疤痣）。角色**严禁**出现衣物、鞋、帽、配饰、妆造。
     ${free === '中文' ? '✓ "女性，二十多岁，齐肩黑发，圆脸"\n     ✗ "女性，穿着制服"' : '✓ "female, mid twenties, shoulder-length black hair, round face"\n     ✗ "a female wearing a uniform"'}
   - costumeDesc：服装与身形（穿什么）。**角色必填，不许留空**；场景 / 道具没有"穿"，留空。
   两段都不写动作、表情、情绪、镜头、剧情 —— 主体是"这个人长什么样"，动作属于某一拍。
4. 每个实体给一句话 note 说明用途，并给 firstAppear 说明首次出现在哪。
5. 已知实体不要重复输出：本集已有的、以及外部项目母版里已有的，都直接按名字引用即可。

── 外部项目主体（跨集母版，直接引用，不要重复登记）──
${projectSubjectBlock(options.projectSubjects)}

本集已有实体：
${knownEntityNames.length ? knownEntityNames.join('、') : '（暂无）'}

输出 JSON 结构：
{
  "newEntities": [
    { "name": "", "type": "character|scene|prop", "kind": "speaking|non_speaking",
      "voiceDesc": "", "textDesc": "", "costumeDesc": "", "note": "", "firstAppear": "" }
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
  /** 素材清单：把有 desc 的参考图 / 参考音频作为只读上下文交给模型 */
  assets?: Asset[]
}

export function buildStage2Messages(
  beats: Beat[],
  entities: Entity[],
  options: Stage2Options = {}
): ChatMessage[] {
  const free = (options.language ?? 'zh') === 'zh' ? '中文' : '英文'
  const batch = options.batch
  const batched = !!batch && batch.total > 1
  const refNotes = referenceNotes(options.assets)
  const entityTable = entities
    .map((e) => {
      const parts = [
        `- name: ${e.name}`,
        `type: ${e.type}`,
        `kind: ${e.kind}`,
        e.pictureN != null ? `picture: <Picture ${e.pictureN}>` : 'picture: 无（纯文本描述）',
        e.voiceDesc ? `voice: ${e.voiceDesc}` : '',
        e.textDesc ? `visual: ${e.textDesc}` : '',
        e.costumeDesc ? `costume: ${e.costumeDesc}` : ''
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
- 其他主体（角色 / 道具）：可选，纯场景镜可以为空数组。

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
8. ★ dialogue 类型的 Beat，visualDesc 只写**说话这一瞬间**：景别、构图、说话人的表情与视线。
   - 不得写身体动作（抬头 / 转身 / 伸手 / 递 / 推 / 走 / 坐 / 擦 / 握 / 拿 / 放下…）：
     那些动作在这一拍之前的镜头里已经做完了，写进来就等于「一边动一边说」。
   - 也不要把听者的反应写进台词拍 —— 反应属于它自己的 reaction Beat。
   - 非台词 Beat 不受此限，照常写动作。
9. 不得引入名单外的实体；不得改动 Beat 的 kind 与顺序；不得编造新剧情。
10. 必须为每一个输入的 Beat id 返回一条结果，id 原样返回。${
        batched
          ? `
11. 本批只输出下面列出的 Beat id，不要多、不要少、不要复述上一批。
12. 下面会给上一批已填好的几条细节，只用来对齐运镜与画面的措辞风格与粒度，
    不要把它们的实体绑定或场景套到本批。`
          : ''
      }

已知实体名单：
${entityTable || '（无）'}
${refNotes}
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
  /** 素材清单：把有 desc 的参考图 / 参考音频作为只读上下文交给模型 */
  assets?: Asset[]
  /**
   * 用户给这一项的一句要求（单字段生成时才有）。
   * 整段补全不带它 —— 那是"按既有规则铺满"，没有可改的方向。
   */
  requirement?: string
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
  const refNotes = referenceNotes(input.assets)

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

  /*
   * 接缝说明：只描述"这一段和邻居是什么关系"，不再写"本段末尾要切镜至 X"。
   *
   * 旧的写法是在让模型自己完成一次转场 —— 段内切 0.3 秒给下一个人。
   * 现在衔接交给段间引导（上一段尾帧直接喂给下一段）与首帧关键帧，
   * 模型只需要：
   *   转场  → 老老实实开新环境，别去承接上一段的画面；
   *   镜切  → 从新机位起画，环境光位与上段一致；
   *   顺接  → 接着上一段最后一帧往下演。
   * 结尾同理：除了顺接要"保持主体在画面内、动作不断"，其余都自然收住，
   * 不要自己做淡出 / 黑屏 / 切镜 —— 那会把引导进来的衔接再切一次。
   */
  const seamBrief = (seam: SeamAnalysis | null, which: 'prev' | 'next'): string => {
    if (!seam) return which === 'prev' ? '本段是第一段，无前接。' : '本段是最后一段，无后接。'

    if (which === 'prev') {
      switch (seam.kind) {
        case 'transition':
          return '本段从上一段转场进入（换场或换时间）：开场第一帧就是新环境，与上一段画面不连续，不要承接上一段的最后一帧。'
        case 'cut':
          return `本段与上一段同场，镜头切至 ${nameOf(seam.firstSubjectId)}：环境与光源和上一段一致，从新机位起画。`
        default:
          return `本段与上一段是同一主体（${nameOf(seam.firstSubjectId)}）连着演：直接从上一段的最后一帧接着往下。`
      }
    }

    switch (seam.kind) {
      case 'transition':
        return '下一段从转场进入：本段结尾自然收住即可，不要为下一段做预备动作（不切镜、不留黑屏、不做淡出）。'
      case 'cut':
        return '下一段是同场镜切：本段结尾自然收住即可，不要切到下一段的主体。'
      default:
        return '下一段是同一主体连着演：本段结尾保持该主体在画面内、动作不断，不要收成静止画面。'
    }
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
${refNotes}
【本段镜头序列】
${structure}
${derivedContext ? `\n【已生成字段（只读，不要重复输出）】\n${derivedContext}` : ''}

请只生成这些字段：${targets.map((f) => f.key).join('、') || '（无）'}${
        input.requirement
          ? `\n\n【我的要求】${input.requirement}\n（只作用在上面这些字段上；与硬性要求冲突时以硬性要求为准，例如要求"写长一点"也不能把台词原文抄进去）`
          : ''
      }`
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
  /** 素材清单：把有 desc 的参考图 / 参考音频作为只读上下文交给模型 */
  assets?: Asset[]
}

/**
 * 把校验出的违规项交给模型改写字段。
 * 返回完整字段内容而不是 diff —— 模型产出局部补丁的可靠性太差。
 */
export function buildFixMessages(input: FixInput): ChatMessage[] {
  const { schema, fields, issues, groupBeats, entities, segmentIndex, segmentTotal, frames, fps } = input
  const refNotes = referenceNotes(input.assets)

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
${refNotes}
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
 * 阶段四：中英本地化
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
  /** 穿什么 / 体型。与 textDesc 分开译：一个进头部图，一个进三视图 */
  costumeDesc: string
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
        e.textDesc ? `长相: ${e.textDesc}` : '',
        e.costumeDesc ? `服装: ${e.costumeDesc}` : ''
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
      entities: [{ id: '', name: '', voiceDesc: '', textDesc: '', costumeDesc: '' }],
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
4. 外观词条分两段译，**不许合并**：
   - textDesc（长相）：脸型、五官、发型、肤色、年龄、体型骨架。**绝不写穿着** ——
     它是头部参考图的唯一依据，写进衣服会让头肩构图里塞一整身。
   - costumeDesc（服装与身形）：穿什么（款式 / 颜色 / 材质 / 鞋 / 配饰）+ 体型。
     它是全身三视图的唯一依据。
   - 原文若把两者混在一句里，按上面的分工拆开；拆不出来时宁可把服装整句放进
     costumeDesc，也不要留在 textDesc 里。
   两段都不要写动作、表情、情绪、镜头、剧情 —— 原文里若混着这些，译的时候直接丢掉。
   原字段为空就返回空字符串。
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

/**
 * 字段同步的方向。
 *
 * zh2en = 中文工作稿刚改过，让英文跟上来（⑤ 本地化的常规方向）；
 * en2zh = 英文终稿改过（交付页直接改），让中文回写对齐。
 */
export type LocalizeDirection = 'zh2en' | 'en2zh'

export interface LocalizeFieldsInput {
  schema: FieldSchema[]
  /** 源稿（含引擎派生字段，作为只读上下文） */
  fields: Record<string, string>
  /** 缺省 zh2en，保持与本地化原有行为一致 */
  direction?: LocalizeDirection
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

  // en2zh 时对照表要反过来查：给模型的是「英文名 → 中文名」
  const toEn = (input.direction ?? 'zh2en') === 'zh2en'
  const dict = Object.entries(input.entityNameMap)
    .map(([zh, en]) => (toEn ? `- ${zh} → ${en}` : `- ${en} → ${zh}`))
    .join('\n')

  const structure = groupBeats
    .map(
      (b, i) =>
        `${String(i + 1).padStart(2, '0')}. [${BEAT_KIND_LABEL[b.kind]}] ${b.title}${b.dialogue ? ` — ${b.dialogue}` : ''}`
    )
    .join('\n')

  const source = targets
    .map(
      (f) =>
        `【${f.key}（${toEn ? '中文原稿' : '英文终稿'}）】\n${(fields[f.key] ?? '').trim() || '（空）'}`
    )
    .join('\n\n')

  const jsonShape = JSON.stringify(Object.fromEntries(targets.map((f) => [f.key, ''])), null, 2)

  return [
    {
      role: 'system',
      content: toEn
        ? `${BASE_SYSTEM}

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
        : `${BASE_SYSTEM}

现在是【字段同步：段字段英译中】。
英文终稿刚被改过，中文工作稿还停在旧版本。现在只做一件事：按英文终稿把中文工作稿回写一遍。

硬性要求：
1. 只回写下面列出的字段，逐字段返回完整中文内容。
2. summary 必须以字面量 [reference generation] 开头（含方括号）。
3. <Subject N> / (Sx) / <Picture N> 是结构标记，原样保留；实体名一律使用给定的「译名对照表」。
4. <d> 标签内的台词原样保留，不要翻译、不要改写。
5. non_diegetic_music 若无配乐只返回 N/A 三个字符。
6. 这一段是**中文工作稿**：除 <d> 外的正文必须是中文，不得夹带英文句子。
7. 只做回写，不要新增镜头、不要删信息、不要改叙事方向。
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

请只输出这些字段的${toEn ? '英文' : '中文'}版：${targetKeys.join('、') || '（无）'}`
    }
  ]
}

/* ------------------------- 关键帧排布（出图前） ------------------------- */

/**
 * 一段的信息，够模型判断"在哪几帧有画面变化"。
 *
 * 注意这里给的是**帧数**而不是秒：模型对"第 37 帧"和"第 1.5 秒"的理解差不多，
 * 但落库、夹帧、去重都按帧算，少一次换算就少一次错位。
 */
export interface KeyframePlanBeat {
  /** 序号，1 起（模型只抄序号，不抄 id） */
  index: number
  title: string
  kind: string
  /** 本段总帧数 */
  frames: number
  fps: number
  direction?: string
  visualDesc?: string
  dialogue?: string
  scene?: string
  /** "林晚（24 岁，丸子头，便利店制服）" —— 外观写进来，跨帧才不会长成两个人 */
  cast?: string[]
  /** 这一段已经挂了图的帧号：那里已经有画面，别再排 */
  existingFrames?: number[]
}

export interface KeyframePlanInput {
  beats: KeyframePlanBeat[]
  /** 每段最多几张，默认 3 */
  maxPerBeat?: number
  /** 画面风格 / 画幅要求，跟着出图通道走 */
  style?: string
  /**
   * 用户这次想额外强调的点（可空）。
   *
   * "这段太亮了""别给人物特写""多排两张动作"这类要求没法做成固定选项，
   * 但模型完全能听懂 —— 与其让用户改完结果再叹气，不如开口就能说。
   * 只作**补充**，硬性规则（帧号范围、张数上限、英文单帧）仍然优先。
   */
  note?: string
}

/**
 * 让模型给每个片段排关键帧：哪几帧、每帧画什么。
 *
 * 这一环的意义：帧位和画面描述都该由**看过这一段文字的人**决定，
 * 而不是前端按"中点 / 等分"算一个出来。模型给了建议之后，
 * 用户仍然可以逐条改、逐条勾，最后点「开始出图」才真的跑。
 */
export function buildKeyframePlanMessages(input: KeyframePlanInput): ChatMessage[] {
  const { beats } = input
  const max = Math.max(1, Math.round(input.maxPerBeat ?? 3))
  const style = (input.style ?? '').trim() || 'Cinematic film still, 16:9 widescreen, detailed lighting, photorealistic.'
  const note = (input.note ?? '').trim()

  const rows = beats
    .map((b) => {
      const sec = b.fps > 0 ? (b.frames / b.fps).toFixed(2) : '?'
      const existing = b.existingFrames?.length ? b.existingFrames.join(' / ') : '无'
      return [
        `${String(b.index).padStart(2, '0')}. [${b.kind}] ${b.title || '（未命名）'} · ${b.frames} 帧（${sec}s）· 已有帧：${existing}`,
        b.direction ? `    运镜：${b.direction}` : '',
        b.visualDesc ? `    画面：${b.visualDesc}` : '',
        b.dialogue ? `    台词：${b.dialogue}` : '',
        b.scene ? `    场景：${b.scene}` : '',
        b.cast?.length ? `    出场：${b.cast.join('；')}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')

  const shape = `{
  "shots": [
    { "beat": 1, "frame": 0, "prompt": "English prompt of this single frame", "reason": "一句话中文说明为什么放这一帧" }
  ]
}`

  return [
    {
      role: 'system',
      content: `${BASE_SYSTEM}

现在是【关键帧排布：给每个片段定"第几帧、画什么"】。
下游会拿这些提示词逐张出图，出的图会被导演台当成画面锚点钉在对应帧上，
所以位置错一帧、描述偏一点，就是整段画面跟着偏。

硬性要求：
1. frame 必须是该段内的整数：0 到 frames-1，0 = 开场第一帧，frames-1 = 收尾帧。
2. 一段 1 张能交代清楚，就只给 1 张，放在开场（frame 0）；只有当段内动作 / 台词
   出现明显变化（人物换位、起身、递东西、情绪转折）时才补中间帧，**最多 ${max} 张**。
   不要为了凑数而多给，也不要同一段给两张几乎一样的画面。
3. 不要和「已有帧」重复：那些帧上已经有图了，再排一张只是覆盖掉用户挑好的画面。
4. prompt 必须是**英文**，描述单张电影静帧：景别 + 机位 + 主体动作 + 环境 + 光线。
   不要写对白、字幕、文字、水印、界面、分镜编号，也不要写"第一帧 / 第 37 帧"这类元信息。
5. 角色外观必须沿用给定的外观描述，同一角色跨帧保持同一张脸、同一身衣服。
6. reason 用一句中文说明为什么把画面放在这一帧（给用户判断，不进出图）。
7. 输出必须是合法 JSON，不要输出解释文字或 Markdown 代码块标记。
8. 用户可能附一句【补充要求】：在不违反上面规则的前提下，优先满足它
   （比如要求多给几张、只拍某个角落、统一光线）。它不能改变 frame 范围与张数上限。

输出 JSON 结构：
${shape}`
    },
    {
      role: 'user',
      content: `【统一画面要求】${style}
${note ? `\n【补充要求】${note}\n` : ''}
【片段清单】（序号 · 类型 · 标题 · 帧数 · 已有帧）
${rows || '（无）'}

请给上面每个片段排关键帧（每段 1~${max} 张；一张够就放 frame 0）。`
    }
  ]
}

/* ------------------------------------------------------------------ *
 * 一条素材的提示词
 * ------------------------------------------------------------------ */

export interface AssetPromptRefInput {
  /** <Picture N>；0 = 没有编号 */
  pictureN: number
  name: string
  desc: string
}

export interface AssetPromptInput {
  /**
   * 用户给的一句要求（口语就行："雨夜巷口，他回头看了一眼"）。
   * 这是**唯一**必须有的输入 —— 没有它，模型只能照段落的画面描述重写一遍，
   * 那和"当前模板"没有区别，用户也就没必要点这个按钮。
   */
  brief: string
  beat: {
    title: string
    kind: string
    frames: number
    fps: number
    direction: string
    visualDesc: string
    dialogue: string
    scene: string
  }
  /** 出场人物（名字 + 外观），用来保证同一个角色跨图长得一样 */
  cast: string[]
  /** 已经勾上的参考图 */
  refs: AssetPromptRefInput[]
  /** 参考方式：提示词里要出现 <Picture N>，导演包才认这张图被引用 */
  asReference: boolean
  note?: string
}

/**
 * 把"一句要求"写成一条能直接出图的英文提示词。
 *
 * 为什么不直接拿用户的这句当提示词：
 *   中文口语里没有景别、光线、镜头这些词，本地工作流吃的是英文；
 *   用户给的是意图（"他回头看一眼"），要补的是画面（medium shot、over-shoulder、
 *   雨丝打在背光里）。这一步就是把意图翻译成画面语言。
 *
 * 输出是**纯文本**而不是 JSON：只有一句提示词，套 JSON 只会多一层解析失败的可能。
 */
export function buildAssetPromptMessages(input: AssetPromptInput): ChatMessage[] {
  const b = input.beat
  const sec = b.fps > 0 ? (b.frames / b.fps).toFixed(2) : '?'
  const refs = input.refs
  const refLines = refs.length
    ? refs
        .map((r) => {
          const tag = input.asReference && r.pictureN > 0 ? `<Picture ${r.pictureN}> ` : ''
          return `- ${tag}${r.name}${r.desc ? ` — ${r.desc}` : ''}`
        })
        .join('\n')
    : '（无）'

  return [
    {
      role: 'system',
      content: `${BASE_SYSTEM}

现在是【把一句口语要求写成一条出图提示词】。
下游会把你的输出直接发给图像模型，一个字都不改。

硬性要求：
1. 输出**只有提示词本身**：英文、单段、不超过 90 个词。不要标题、不要引号、
   不要 Markdown、不要"Prompt:"前缀、不要中文解释。
2. 必须写到：景别与机位、主体在做什么、环境与关键道具、光线与色调、画面质感。
3. 主体外观沿用给定的角色描述（同一角色跨图必须是同一张脸、同一身衣服），
   不要临时加新人物、新服装、新道具。
4. 参考图已经在画面里的人物，用名字指代：参考方式下**在提到他的那一句开头**
   写 \`<Picture N> 名字\`（例如 "…, <Picture 3> Chen Mo turns his head, …"），
   编号和名字要紧挨着；不要解释编号是什么，也不要重复描述他的长相去"重新发明"一个人。
5. 不写对白、字幕、文字、水印、界面、分镜编号，也不写"第几帧 / 上一镜"这类元信息。
6. 用户的要求是**画面意图**，不是措辞：照着它重新组织画面语言，不要逐字翻译。
7. 画面是 16:9 横画幅。
8. 用户可能附一句【补充要求】，在不违反上面规则时优先满足。`
    },
    {
      role: 'user',
      content: `【这一镜】${b.title || '（未命名）'} · ${b.kind} · ${b.frames} 帧（${sec}s）${
        b.direction ? `\n【运镜】${b.direction}` : ''
      }${b.visualDesc ? `\n【画面】${b.visualDesc}` : ''}${
        b.dialogue ? `\n【台词】${b.dialogue}` : ''
      }${b.scene ? `\n【场景】${b.scene}` : ''}
${input.cast.length ? `\n【出场人物】\n${input.cast.map((c) => `- ${c}`).join('\n')}` : ''}
【可用的参考图】${input.asReference ? '（参考方式：正文里必须出现 <Picture N>）' : ''}
${refLines}
${input.note ? `\n【补充要求】${input.note}\n` : ''}
【我的要求】${input.brief}

请直接输出这一条英文提示词。`
    }
  ]
}
