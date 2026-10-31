/**
 * 阶段门禁 —— 流水线「顺序执行」的唯一判定处。
 *
 * 为什么要集中在一个纯函数里：
 *
 * 1. **口径只能有一份**。导航（阶段 tab）与各类「生成」按钮如果各写一套判断，
 *    早晚会出现「能进页面但按钮不让点」或反过来「页面进不去、生成却在跑」。
 *    这里把每个阶段的「无误」定义成代码，两边都读它。
 *
 * 2. **顺序是硬约束**。前一个阶段有错，后面的阶段一律不准进 —— 因为后面的
 *    所有产物都建立在前面的结构上：场景没绑就出关键帧，图一定是错的；字段没
 *    补全就出片，对面导演节点会静默清空槽位。等到交付才发现，返工成本是整轮。
 *
 * 3. **两个层次刻意分开**：
 *    - `blocksNext`：该阶段不通过时，**后面的阶段进不去**。素材是例外
 *      （见下），所以它的 blocksNext = false。
 *    - `generationBlockers`：点「生成」时**额外**要过的关。出片要求关键帧齐，
 *      这条不在阶段锁里，但必须拦住。
 *
 * ★ 素材排在「③ 组合与缝合」**之后**：
 *
 *   图是按**链**出的（一条链只有链头要一张起始图，链内用上段尾帧引导），
 *   而链是 ③ 缝合算出来的（refPrev）。把出图放在缝合之前，就只能按段盲出一轮：
 *   要么多出十几张白费的图，要么链内段同时拿到"上段尾帧"和"本段首帧"两个起点。
 *
 *   它仍然 blocksNext = false：素材是工作台，不是结构阶段。缝合完先看方案、
 *   回头再来补图是正常动线。但「出片」必须有图 —— 所以它拦生成，不拦导航。
 *
 * ★ 素材**没有自己的页面**了（2026-10-30 定的）：备图与配音就在 ② 每张卡片
 *   的素材带上做。这一关的判定照旧保留（出片前仍有"图音齐不齐"的检查），
 *   只是它的问题条点进去落到 ②，不再有 navigable 的 素材 tab。
 */
import { beatIssueLabel } from './beats'
import { fieldName } from './fieldLabels'
import { materialsCoverage } from './materials'
import { refProblemOf } from './refSheet'
import type { RuleIssue } from './rules'
import type { ResultState } from './insertion'
import type { Assembly, Asset, Beat, Entity, FieldSchema, ID, ProjectSettings } from './types'

/** 流水线顺序。`subjects` 不在其中：主体是资料库，不是阶段。 */
export const GATE_ORDER = [
  'split',
  'enrich',
  'assemble',
  // 缝合在生图之前：链先定下来，才知道哪几条段需要起始图
  'materials',
  'complete',
  'localize',
  'deliver'
] as const

export type GateStage = (typeof GATE_ORDER)[number]

export const GATE_LABEL: Record<GateStage, string> = {
  split: '① 拆解',
  enrich: '② 细节填充',
  materials: '素材',
  assemble: '③ 组合与缝合',
  // 字段补全并进 ③ 了：它本来就是"组合定稿之后，按整段补"，不是另开一页的事。
  // 门禁仍单独一档（管的是"这段的字段齐不齐"），但归到同一页去办。
  complete: '③ 字段补全',
  localize: '④ 中英本地化',
  deliver: '⑤ 交付'
}

export interface StageGate {
  key: GateStage
  label: string
  /** 硬性问题：有它就 passed = false */
  errors: string[]
  /** 提醒：不拦，但值得摆出来 */
  warns: string[]
  passed: boolean
  /** 不通过时是否拦后面的阶段（素材为 false） */
  blocksNext: boolean
}

/**
 * 段视图的最小投影。
 *
 * 刻意不 import `stores/assembly` 的 SegmentView：domain 不能反过来依赖 store。
 * SegmentView 结构上满足这个接口，调用方直接传即可。
 */
export interface GateSegment {
  frames: number
  overLimit: boolean
  aligned: boolean
  stale: boolean
  fields: Record<string, string>
  issues: RuleIssue[]
  result?: { state: ResultState }
  /**
   * 这一段包含哪些 beat（按片序）。
   *
   * 素材按**链**判定要图时要用它：链是段级的，卡片是 beat 级的，
   * 得知道"这个 beat 是某段的第一个、还是段内后续"。
   * 可选是因为历史调用方（纯结构判定）不需要它。
   */
  beatIds?: ID[]
  /** 这一段是否引用上一段（链的判定依据） */
  refPrev?: boolean
}

export interface GateInput {
  beats: Beat[]
  entities: Entity[]
  assets: Asset[]
  entityById: Map<ID, Entity>
  settings: ProjectSettings
  schema: FieldSchema[]
  assembly: Assembly | null
  segments: GateSegment[]
  globalIssues: RuleIssue[]
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 1 基拍号，最多列 3 个，后面用「等」收口 */
function beatsLabel(indexes: number[]): string {
  const head = indexes.slice(0, 3).map((i) => `第 ${i + 1} 拍`).join('、')
  return indexes.length > 3 ? `${head} 等` : head
}

/**
 * 段号，最多列 4 个，后面用「等」收口。
 *
 * 为什么必须点名：只说「7 段内容已过期」，用户得自己去翻 7 段找是哪几段 ——
 * 实际就是找不到。这里给出段号，界面再提供跳转/筛选，才谈得上"能定位"。
 */
function segmentsLabel(indexes: number[]): string {
  const head = indexes
    .slice(0, 4)
    .map((i) => `seg${String(i + 1).padStart(2, '0')}`)
    .join('、')
  return indexes.length > 4 ? `${head} 等` : head
}

/** 判断某个字段值是否算「已填」 */
function filled(v: string | undefined): boolean {
  return !!v && v.trim().length > 0
}

/** 片段还需要哪些英文词条 */
function beatNeedsEn(b: Beat): boolean {
  if (!b.titleEn) return true
  if (b.direction && !b.directionEn) return true
  if (b.visualDesc && !b.visualDescEn) return true
  return false
}

/** 主体还需要哪些英文词条 */
function entityNeedsEn(e: Entity): boolean {
  if (!e.nameEn) return true
  if (e.textDesc && !e.textDescEn) return true
  if (e.costumeDesc && !e.costumeDescEn) return true
  if (e.voiceDesc && !e.voiceDescEn) return true
  return false
}

/** 把 RuleIssue 压成一句可读的话（去重，最多 3 条） */
function issueSummary(issues: RuleIssue[]): string {
  const msgs = Array.from(new Set(issues.map((i) => i.message.replace(/\s+/g, ' ').trim())))
  const head = msgs.slice(0, 3).join('；')
  return msgs.length > 3 ? `${head} 等 ${msgs.length} 条` : head
}

/* ------------------------------------------------------------------ *
 * 逐阶段判定
 * ------------------------------------------------------------------ */

function splitGate(input: GateInput): { errors: string[]; warns: string[] } {
  const errors: string[] = []
  const warns: string[] = []

  if (!input.beats.length) {
    errors.push('还没有拆出片段')
    return { errors, warns }
  }

  // 标题和台词都空的片段，后面所有环节都没法定位它
  const blank = input.beats
    .map((b, i) => ({ i, b }))
    .filter(({ b }) => !filled(b.title) && !filled(b.dialogue))
    .map(({ i }) => i)
  if (blank.length) errors.push(`${blank.length} 个片段既没有标题也没有台词（${beatsLabel(blank)}）`)

  return { errors, warns }
}

function enrichGate(input: GateInput): { errors: string[]; warns: string[] } {
  const errors: string[] = []
  const warns: string[] = []

  if (!input.beats.length) {
    errors.push('还没有片段')
    return { errors, warns }
  }

  // 与「② 细节填充」页共用同一个判定：缺场景 / 台词缺说话人
  const bad = input.beats
    .map((b, i) => ({ i, label: beatIssueLabel(b) }))
    .filter((x): x is { i: number; label: string } => !!x.label)

  if (bad.length) {
    const noScene = bad.filter((x) => x.label === '未指定场景').length
    const noSpeaker = bad.filter((x) => x.label === '台词未指定说话人').length
    const parts: string[] = []
    if (noScene) parts.push(`${noScene} 个缺场景`)
    if (noSpeaker) parts.push(`${noSpeaker} 条台词缺说话人`)
    errors.push(`${bad.length} 个片段没填全：${parts.join('、')}（${beatsLabel(bad.map((x) => x.i))}）`)
  }

  return { errors, warns }
}

function materialsGate(input: GateInput): { errors: string[]; warns: string[] } {
  const errors: string[] = []
  const warns: string[] = []

  if (!input.beats.length) {
    errors.push('还没有片段')
    return { errors, warns }
  }

  const cov = materialsCoverage(
    input.beats,
    input.assets,
    input.entityById,
    input.settings,
    // 只有拿到"段 → beat"的映射才能判链；没拿到时 materialsCoverage 会退回逐段要求
    input.segments
      .filter((s): s is GateSegment & { beatIds: ID[] } => !!s.beatIds?.length)
      .map((s) => ({ beatIds: s.beatIds, refPrev: !!s.refPrev }))
  )

  // 起始图**不是**硬条件（2026-10-28 定的口径）：没有图，导演台就用文字起画。
  // 所以这里只提示、不拦 —— 以前这条进 errors，素材阶段永远过不了，用户
  // 每出一段都得先烧一张图才能往下走。
  if (cov.missingImage > 0) {
    warns.push(
      `${cov.missingImage}/${cov.chains} 条链还没起始图（可选：没有也能用文字起画，有图画面更稳）`
    )
  }

  if (cov.voiceBlocked > 0) {
    warns.push(`${cov.voiceBlocked} 条台词配不了音：缺台词或说话人没固定音色`)
  }
  if (cov.voiceTodo > 0) {
    warns.push(`${cov.voiceTodo} 条台词还没配音（出片会按字数估帧长）`)
  }

  // 参考图必须是「头 + 身子」拼接的一张：只给一张脸，模型拿不到身高、体型
  // 和这一身衣服，每段都会自己编一套 —— 这是"参考了等于没参考"的根子。
  // 只提醒、不拦：素材阶段本来就允许边跑边补。
  const weakRefs = input.entities.filter((e) => refProblemOf(e))
  if (weakRefs.length) {
    const names = weakRefs.slice(0, 3).map((e) => e.name).join('、')
    warns.push(
      `${weakRefs.length} 个角色的参考图不是「组头 + 三视图」拼接图（${names}${
        weakRefs.length > 3 ? ' 等' : ''
      }）：出片会每段换一套衣服`
    )
  }

  return { errors, warns }
}

/**
 * ③ 只认这些「结构类」规则：段到底能不能跑。
 *
 * 为什么白名单而不是黑名单 —— 这里的判定直接决定「能不能进④」，
 * 一旦把「字段为空」算成 ③ 的错误，而字段本来就是 ④ 才生成的，整条流水线
 * 就死锁了（③ 永远不过 → ④ 永远进不去 → 字段永远不生成）。实测踩过。
 *
 * 白名单的代价是：新增的内容类规则默认不拦 ③，由 ⑤ 交付的完整校验兜底 ——
 * 这个方向的漏判只是晚一点发现，黑名单的漏判是卡死流程。
 *
 * 归属：
 *   frames:*   帧数/分段 —— ③ 的本职
 *   scene:*    场景绑定 —— ② 没绑好，③ 组装时一定出问题
 *   beat:*     说话人
 *   registry:  编号类（no-number / stale-number / sx-mismatch）。
 *              ⚠️ registry:voice-missing 不在此列：它检查的是字段里有没有写
 *              speaking with，属于 ④ 生成的内容。
 *   dialogue:too-tight 台词塞不进段时长 —— 段的容量问题，不是文案问题
 */
const STRUCT_RULES = new Set([
  'frames:not-aligned',
  'frames:limit',
  'frames:pad-mismatch',
  'frames:dialogue-overflow',
  'dialogue:too-tight',
  'scene:missing',
  'scene:multiple',
  'scene:not-scene',
  'scene:undefined',
  'scene:unknown',
  'beat:no-speaker',
  'registry:no-number',
  'registry:stale-number',
  'registry:sx-mismatch'
])

function assembleGate(input: GateInput): { errors: string[]; warns: string[] } {
  const errors: string[] = []
  const warns: string[] = []

  if (!input.assembly) {
    errors.push('还没有组合方案')
    return { errors, warns }
  }
  if (!input.segments.length) {
    errors.push('方案里没有可交付的段')
    return { errors, warns }
  }

  const over = input.segments
    .map((s, i) => ({ i, s }))
    .filter(({ s }) => s.overLimit)
    .map(({ i }) => i)
  if (over.length) errors.push(`${over.length} 段超出帧数上限，必须先拆段（第 ${over.map((i) => i + 1).join('、')} 段）`)

  // 段级错误只取结构类：字段内容归 ④，完整校验归 ⑥
  const segErrors = input.segments
    .flatMap((s) => s.issues)
    .filter((i) => i.level === 'error' && STRUCT_RULES.has(i.ruleId))
  if (segErrors.length) errors.push(`段内还有 ${segErrors.length} 处结构错误：${issueSummary(segErrors)}`)

  const unaligned = input.segments.filter((s) => !s.aligned).length
  if (unaligned) warns.push(`${unaligned} 段帧数没对齐（出片前会自动补正）`)

  return { errors, warns }
}

function completeGate(input: GateInput): { errors: string[]; warns: string[] } {
  const errors: string[] = []
  const warns: string[] = []

  if (!input.segments.length) {
    errors.push('还没有段')
    return { errors, warns }
  }

  // 与 ③ 里那块整段字段补全同一口径：只算模型生成的字段
  const llm = input.schema.filter((f) => f.source === 'llm')
  if (!llm.length) return { errors, warns }

  const missingKeys: string[] = []
  const missingIdx: number[] = []
  input.segments.forEach((s, i) => {
    const miss = llm.filter((f) => !filled(s.fields[f.key]))
    if (!miss.length) return
    missingIdx.push(i)
    for (const f of miss) if (!missingKeys.includes(f.key)) missingKeys.push(f.key)
  })
  if (missingIdx.length) {
    // 报错里也要说中文名：`summary` 这种 key 摆给用户看等于没说
    const labels = missingKeys
      .slice(0, 4)
      .map((k) => fieldName(k))
      .join('、')
    errors.push(
      `${missingIdx.length} 段还有字段空缺（${segmentsLabel(missingIdx)}）：${labels}${
        missingKeys.length > 4 ? ' 等' : ''
      }`
    )
  }

  // 上游改过 => 段里存的内容与当前片段对不上，必须重生成
  const staleIdx = input.segments
    .map((s, i) => (s.stale ? i : -1))
    .filter((i) => i >= 0)
  if (staleIdx.length) {
    errors.push(
      `${staleIdx.length} 段内容已过期（${segmentsLabel(staleIdx)}）：上游片段或实体改过，需要重新生成`
    )
  }

  return { errors, warns }
}

function localizeGate(input: GateInput): { errors: string[]; warns: string[] } {
  const errors: string[] = []
  const warns: string[] = []

  const pendingB = input.beats.filter(beatNeedsEn).length
  const pendingE = input.entities.filter(entityNeedsEn).length
  if (pendingB + pendingE) {
    const parts: string[] = []
    if (pendingB) parts.push(`片段 ${pendingB} 条`)
    if (pendingE) parts.push(`主体 ${pendingE} 条`)
    errors.push(`${pendingB + pendingE} 条词条还没有英文（${parts.join('、')}）`)
  }

  return { errors, warns }
}

function deliverGate(input: GateInput): { errors: string[]; warns: string[] } {
  const errors: string[] = []
  const warns: string[] = []

  if (!input.segments.length) {
    errors.push('还没有可交付的段')
    return { errors, warns }
  }

  const segErrors = input.segments.flatMap((s) => s.issues).filter((i) => i.level === 'error')
  if (segErrors.length) errors.push(`段内还有 ${segErrors.length} 处错误：${issueSummary(segErrors)}`)

  const globalErrors = input.globalIssues.filter((i) => i.level === 'error')
  if (globalErrors.length) errors.push(`全片还有 ${globalErrors.length} 处错误：${issueSummary(globalErrors)}`)

  // 出片是「交付」的主要动作，没出过片的段要明说，但不算错误
  const never = input.segments.filter((s) => (s.result?.state ?? 'none') === 'none').length
  if (never) warns.push(`${never} 段还没出过片`)
  const stale = input.segments.filter((s) => (s.result?.state ?? 'none') === 'stale').length
  if (stale) warns.push(`${stale} 段出片后又改过内容，缓存不再对得上`)

  return { errors, warns }
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

const EVALUATORS: Record<GateStage, (input: GateInput) => { errors: string[]; warns: string[] }> = {
  split: splitGate,
  enrich: enrichGate,
  materials: materialsGate,
  assemble: assembleGate,
  complete: completeGate,
  localize: localizeGate,
  deliver: deliverGate
}

/** 所有阶段的判定结果（一次算全，导航与生成按钮共用） */
export function evaluateGates(input: GateInput): Record<GateStage, StageGate> {
  const out = {} as Record<GateStage, StageGate>
  for (const key of GATE_ORDER) {
    const { errors, warns } = EVALUATORS[key](input)
    out[key] = {
      key,
      label: GATE_LABEL[key],
      errors,
      warns,
      passed: errors.length === 0,
      // 素材不锁下一阶段，见文件头注释
      blocksNext: key !== 'materials'
    }
  }
  return out
}

/**
 * 想进 target，必须先过哪些关（按顺序）。
 *
 * 返回的是「拦路的阶段」而不是布尔值 —— 弹窗要把原因一条条摆出来，
 * 只说"不能进"等于让用户自己猜哪里错了。
 */
export function blockersFor(target: GateStage, input: GateInput): StageGate[] {
  return blockersOf(evaluateGates(input), target)
}

/**
 * 同上，但复用已算好的结果。
 *
 * 导航要给 7 个 tab 各算一遍「拦路者」，逐个调 blockersFor 会把 materialsCoverage
 * 这类遍历重算 7 次 —— 所以拆出这一层，调用方一次 evaluateGates 就够。
 */
export function blockersOf(
  gates: Record<GateStage, StageGate>,
  target: GateStage
): StageGate[] {
  const idx = GATE_ORDER.indexOf(target)
  if (idx <= 0) return []
  return GATE_ORDER.slice(0, idx)
    .map((k) => gates[k])
    .filter((g) => g.blocksNext && !g.passed)
}

/** 想进 target，所有阶段的完整状态（含通过项，用于列表展示） */
export function prerequisitesOf(target: GateStage, input: GateInput): StageGate[] {
  return prerequisitesIn(evaluateGates(input), target)
}

/** 同上的复用版：只返回 target 之前的阶段状态（含通过项） */
export function prerequisitesIn(
  gates: Record<GateStage, StageGate>,
  target: GateStage
): StageGate[] {
  const idx = GATE_ORDER.indexOf(target)
  return GATE_ORDER.slice(0, Math.max(0, idx)).map((k) => gates[k])
}

export type GenerationAction =
  /** 批量生成素材 */
  | 'keyframes'
  /** 提交出片（导演节点跑视频） */
  | 'video'

/**
 * 「生成」动作的前置条件。
 *
 * 与阶段锁分开是因为两者要的关不一样：
 *   - 出关键帧：得有片段（①）、得绑好场景与说话人（②），还要先有组合方案（③）
 *     —— 图是按链出的，链由缝合算出，没有链就只能按段盲出；
 *   - 出片：还要有方案（③）、字段补全（④），且**链头起始图必须齐** ——
 *     关键帧不锁导航，但它是出片的硬条件。
 *
 * 返回空数组才允许提交。非空时把每一条都摆给用户，别只显示"还有问题"。
 */
export function generationBlockers(action: GenerationAction, input: GateInput): string[] {
  const gates = evaluateGates(input)
  const need: GateStage[] =
    action === 'keyframes'
      ? ['split', 'enrich', 'assemble']
      : ['split', 'enrich', 'assemble', 'complete']

  const out: string[] = []
  for (const k of need) {
    for (const e of gates[k].errors) out.push(`${gates[k].label}：${e}`)
  }
  if (action === 'video') {
    for (const e of gates.materials.errors) out.push(`素材：${e}`)
  }
  return out
}
