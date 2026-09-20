export type ID = string

/**
 * 流水线语言。
 *   zh —— 阶段①~④ 全程中文撰写，人工审阅成本最低；阶段⑤ 由模型统一转成规范英文
 *   en —— 直接产出英文终稿
 * 结构锚点（<Subject N> / (Sx) / <Picture N> / <d> / [Shot N] 时间码等）
 * 在两种语言下都保持英文，只有「自由描述」跟着语言走。
 */
export type Lang = 'zh' | 'en'

/* ------------------------------------------------------------------ *
 * 实体注册表：全片唯一真相源
 * <Subject N> / (Sx) / <Picture N> / 音色描述 只在这里存一份
 * ------------------------------------------------------------------ */

export type EntityType = 'character' | 'scene' | 'prop' | 'ui' | 'other'

/** speaking = 会说话（必须绑定音色与 Sx）；non_speaking = 不说话 */
export type EntityKind = 'speaking' | 'non_speaking'

/** 场景实体 */
export const SCENE_ENTITY_TYPE: EntityType = 'scene'

/**
 * 实体分层：
 *   场景（scene）—— 每个片段有且仅有一个，必填
 *   主体（character / prop / ui / other）—— 可选
 * 两者同样占 <Subject N>，但在数据模型、校验、组合与缝合判定上分开处理。
 */
export function isSceneEntity(e: { type: EntityType }): boolean {
  return e.type === SCENE_ENTITY_TYPE
}

export interface Entity {
  id: ID
  projectId: ID
  name: string
  type: EntityType
  kind: EntityKind
  /** <Subject N>，由 assignNumbers 统一分配 */
  subjectN: number | null
  /** (Sx)，仅 speaking 有值，且与 subjectN 相等 */
  sx: number | null
  /** <Picture N>，无图片实体为 null（纯文本描述） */
  pictureN: number | null
  /** 固定音色描述，跨段逐字复用。仅 speaking */
  voiceDesc: string | null
  /** 无图片实体的纯文本视觉描述 */
  textDesc: string | null
  /** 阶段⑤本地化产物：英文实体名，跨段统一复用 */
  nameEn?: string | null
  /** 阶段⑤本地化产物：英文音色描述，必须跨段逐字一致 */
  voiceDescEn?: string | null
  /** 阶段⑤本地化产物：英文外观描述 */
  textDescEn?: string | null
  note?: string
  createdAt: number
  updatedAt: number
}

export interface Asset {
  id: ID
  projectId: ID
  /** 全局素材编号 Picture N */
  pictureN: number
  fileName: string
  originalName: string
  label: string
  blob?: Blob
  createdAt: number
}

/* ------------------------------------------------------------------ *
 * Beat：原子片段 = 一个镜头，可拆分
 * ------------------------------------------------------------------ */

export type BeatKind =
  | 'dialogue'
  | 'action'
  | 'scene_switch'
  | 'establishing'
  | 'reaction'
  | 'insert'
  | 'preshoot'
  | 'tail_cut'
  | 'black'

/** 需要绑定主体、占用叙事时间的常规片段 */
export const NARRATIVE_KINDS: BeatKind[] = [
  'dialogue',
  'action',
  'scene_switch',
  'establishing',
  'reaction',
  'insert'
]

/** 由缝合引擎自动生成的片段 */
export const AUTO_KINDS: BeatKind[] = ['preshoot', 'tail_cut', 'black']

export interface Beat {
  id: ID
  projectId: ID
  order: number
  kind: BeatKind
  /** 阶段一产出：标题 */
  title: string
  /** 阶段一产出：纯台词，不含任何包装（角色名 / <d> 标签都不加） */
  dialogue?: string
  /** 阶段二填充：绑定实体（至少一个，未绑定不允许参与组合） */
  entities: ID[]
  /** 阶段二填充：说话人，仅 dialogue；必须属于 entities 且是 speaking 实体 */
  speakerId?: ID
  /** 阶段二填充：本镜头聚焦主体，多实体镜头用来判定"镜头给谁" */
  focusEntityId?: ID
  /** 阶段二填充：镜头描述（景别/运镜） */
  direction?: string
  /** 阶段二填充：画面细节描述 */
  visualDesc?: string
  /** 阶段⑤本地化产物：英文标题 */
  titleEn?: string
  /** 阶段⑤本地化产物：英文镜头描述 */
  directionEn?: string
  /** 阶段⑤本地化产物：英文画面描述 */
  visualDescEn?: string
  /** 帧数；为空时按 kind 与台词字数自动推算 */
  estFrames?: number
  /** 用户是否手动改过帧数 */
  manualFrames: boolean
  /** 所属场景实体 id */
  sceneId?: ID
  /** 拆分血缘：由哪个 Beat 拆出 */
  derivedFrom?: ID
  /** 在同源拆分中的次序（1 起） */
  splitIndex?: number
  locked: boolean
  /** 阶段二是否已完成填充 */
  enriched: boolean
  note?: string
  createdAt: number
  updatedAt: number
}

/* ------------------------------------------------------------------ *
 * 组合：Beat 怎么拼成视频段，完全自定义，可并存多套方案
 * ------------------------------------------------------------------ */

export type AssemblyMode = 'scene_first' | 'fill_max' | 'speaker_split' | 'manual'

export interface StrategyWeights {
  /** 浪费帧的惩罚（倾向于填满） */
  waste: number
  /** 在一个场景内部切一刀的惩罚 */
  scene: number
  /** 同段内说话人混杂的惩罚 */
  speaker: number
  /** 缝合处需要黑屏兜底的惩罚 */
  seam: number
  /** 缝合处需要尾帧切镜的惩罚（轻微） */
  cut: number
}

export interface StrategyConfig {
  mode: AssemblyMode
  maxFrames: number
  weights: StrategyWeights
}

/**
 * 段字段的生成记录。
 * 模型字段（summary / soundscape / music）不是派生字段，引擎没法自动重算，
 * 所以生成时记下「当时的段内容指纹」，之后比对判断是否需要重新生成。
 */
export interface SegmentMeta {
  /** 生成时的段内容指纹（见 domain/cascade.ts 的 segmentSourceHash） */
  llmHash: string
  /** 生成时的片段 id 序列，用于在界面上说明是哪里变了 */
  beatIds: ID[]
  updatedAt: number
}

export interface Group {
  id: ID
  beatIds: ID[]
  /**
   * 是否引用上一段。决定本段帧长度必须落在哪个家族：
   *   true  -> 17k
   *   false -> 5 + 17k
   * 缺省 = 非首段（第一个段默认不引用）。
   */
  refPrev?: boolean
  /**
   * 额外副帧：beatId -> 帧数增减量，可以为负数（压缩）。
   * 独立于 Beat 自身的帧长度，只在段内生效，可手工调整。
   * 存在即为手工值；清空后恢复按占比自动分摊。
   * 预备镜头 / 尾帧切镜 / 黑屏同样参与分摊，但它们不写进这里（每次重建都重算）。
   */
  pad?: Record<ID, number>
}

export interface Assembly {
  id: ID
  projectId: ID
  name: string
  strategy: StrategyConfig
  groups: Group[]
  createdAt: number
  updatedAt: number
}

/* ------------------------------------------------------------------ *
 * 缝合：相邻两段接缝处的自动判定
 * ------------------------------------------------------------------ */

export type SeamLevel = 'info' | 'warn' | 'error'

export interface SeamIssue {
  code: string
  level: SeamLevel
  message: string
}

export interface SeamAnalysis {
  leftGroupId: ID
  rightGroupId: ID
  /** 左段末帧主体 */
  lastSubjectId: ID | null
  /** 右段首帧主体 */
  firstSubjectId: ID | null
  /** 右段首个说话人（无台词则 null） */
  firstSpeakerId: ID | null
  /** 尾帧切镜的目标主体；null 表示不需要切 */
  tailCutTargetId: ID | null
  needsTailCut: boolean
  needsPreshoot: boolean
  /** ★ 黑屏兜底：无法合法切镜时，保证尾帧黑屏，让下一段自己决定开头 */
  blackFallback: boolean
  continuityToNext: boolean
  continuityFromPrev: boolean
  /** 左段已定义并出现的全部实体 */
  leftEntities: ID[]

  /* ---------------- 场景综合判断 ---------------- */
  /** 左段主场景 */
  leftSceneId: ID | null
  /** 右段主场景 */
  rightSceneId: ID | null
  /** 左右段是否换场 */
  sceneChanged: boolean
  /** 判定为换场时，尾帧切镜目标是否取自场景（而不是说话人） */
  scenePriorityApplied: boolean

  issues: SeamIssue[]
}

/* ------------------------------------------------------------------ *
 * 字段 Schema：数据驱动，字段后续可随意增删改序
 * ------------------------------------------------------------------ */

export type FieldSource = 'derived' | 'llm' | 'manual'

export interface FieldSchema {
  key: string
  label: string
  order: number
  /** derived = 由引擎自动生成；llm = 由模型生成；manual = 人工填写 */
  source: FieldSource
  /** derived 字段对应引擎里的派生器 key */
  deriveKey?: string
  /** llm 字段使用的提示词片段 */
  promptHint?: string
  editable: boolean
  required: boolean
  /** 字段主体语言，用于校验 */
  lang: 'en' | 'zh' | 'any'
}

export interface FieldDef extends FieldSchema {
  placeholder?: string
}

/* ------------------------------------------------------------------ *
 * Segment：组合的派生视图（不是数据源）
 * ------------------------------------------------------------------ */

export type SegmentStatus = 'draft' | 'seam_checked' | 'complete'

export interface Segment {
  id: ID
  projectId: ID
  assemblyId: ID
  groupId: ID
  index: number
  /** 分镜段的 beat id 序列（含自动生成的 preshoot / tail_cut / black） */
  beatIds: ID[]
  /** 由引擎计算，非持久字段 */
  frames: number
  fields: Record<string, string>
  summary?: string
  seamFromPrev?: SeamAnalysis
  status: SegmentStatus
  updatedAt: number
}

/* ------------------------------------------------------------------ *
 * 项目与设置
 * ------------------------------------------------------------------ */

export type ProjectStage =
  | 'split'
  | 'enrich'
  | 'assemble'
  | 'complete'
  | 'localize'
  | 'deliver'

export interface ProjectSettings {
  /**
   * 流水线工作语言。
   * zh = 阶段①~④ 全中文，阶段⑤ 由模型转成规范英文（推荐）
   * en = 全程直接产出英文
   */
  workLanguage: Lang
  fps: number
  maxSegmentFrames: number
  /** 尾帧切镜与预备镜头占用的帧数（0.3s @24fps ≈ 7 帧） */
  seamFrames: number
  preshootFrames: number
  /** 黑屏兜底占用的帧数，默认 1（保证最后一帧黑屏） */
  blackTailFrames: number
  /** 组合时是否自动插入预备镜头 */
  autoPreshoot: boolean
  /** 组合时是否自动插入段尾切镜 */
  autoTailCut: boolean
  /** 兜底策略：优先黑屏（默认） */
  preferBlackFallback: boolean
  /**
   * 缝合综合判断：换场时尾帧切镜优先切到右段场景，而不是首个说话人。
   * 关掉则一律按说话人 / 主体判定。
   */
  scenePriorityOnSeam: boolean
  /**
   * 阶段①：每批送入模型的原文长度（字符）。
   * 单次输出量由单次输入范围决定，所以这是控制拆解批大小的主开关；
   * 只限制"输出几个片段"而不切输入是不安全的 —— 模型会为了凑数而合并或截断。
   */
  storyChunkChars: number
  /** 阶段②：单批填充的片段数上限（输入是列表，切批不丢信息） */
  beatBatchSize: number
  /** 阶段⑤：单批翻译的词条数上限 */
  glossaryBatchSize: number
  /** 各 kind 的默认帧数 */
  actionFrames: number
  reactionFrames: number
  insertFrames: number
  establishingFrames: number
  sceneSwitchFrames: number
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  workLanguage: 'zh',
  fps: 24,
  maxSegmentFrames: 141,
  seamFrames: 7,
  preshootFrames: 7,
  blackTailFrames: 1,
  autoPreshoot: true,
  autoTailCut: true,
  preferBlackFallback: true,
  scenePriorityOnSeam: true,
  storyChunkChars: 1500,
  beatBatchSize: 12,
  glossaryBatchSize: 30,
  actionFrames: 36,
  reactionFrames: 18,
  insertFrames: 12,
  establishingFrames: 24,
  sceneSwitchFrames: 7
}

/** 默认字段 Schema —— 后续可在界面里直接改，不必动代码 */
export const DEFAULT_FIELD_SCHEMA: FieldSchema[] = [
  {
    key: 'subject_definitions',
    label: 'subject_definitions',
    order: 1,
    source: 'derived',
    deriveKey: 'subject_definitions',
    editable: true,
    required: true,
    lang: 'en'
  },
  {
    key: 'summary',
    label: 'summary',
    order: 2,
    source: 'llm',
    promptHint: '本段剧情概述，需以 [reference generation] 开头，并说明主体来自参考图。',
    editable: true,
    required: true,
    lang: 'en'
  },
  {
    key: 'retention_analysis',
    label: 'retention_analysis',
    order: 3,
    source: 'derived',
    deriveKey: 'retention_analysis',
    editable: true,
    required: true,
    lang: 'en'
  },
  {
    key: 'detailed_description',
    label: 'detailed_description',
    order: 4,
    source: 'derived',
    deriveKey: 'detailed_description',
    editable: true,
    required: true,
    lang: 'en'
  },
  {
    key: 'overall_soundscape',
    label: 'overall_soundscape',
    order: 5,
    source: 'llm',
    promptHint: '1-4 句环境声与物理动作声，不重复对白。',
    editable: true,
    required: true,
    lang: 'en'
  },
  {
    key: 'non_diegetic_music',
    label: 'non_diegetic_music',
    order: 6,
    source: 'llm',
    promptHint: '无配乐则填 N/A；有配乐用 1-3 句描述乐器、速度、节奏。',
    editable: true,
    required: true,
    lang: 'en'
  }
]

export interface Project {
  id: ID
  name: string
  /** 故事原文（阶段一输入） */
  story: string
  stage: ProjectStage
  settings: ProjectSettings
  fieldSchema: FieldSchema[]
  createdAt: number
  updatedAt: number
}

/* ------------------------------------------------------------------ *
 * 模型供应商（OpenAI 兼容）
 * ------------------------------------------------------------------ */

export interface Provider {
  id: ID
  name: string
  baseUrl: string
  apiKey: string
  model: string
  /** CORS 兜底：形如 https://proxy.example/?url= */
  proxyPrefix?: string
  /** 仅本次会话使用 Key（不落库） */
  sessionOnly: boolean
  createdAt: number
}
