/**
 * 交付页的「统一运行参数」。
 *
 * 参数不属于某一段，也不属于"这一次运行" —— 它是**这一集（乃至整条流水线）**的
 * 一套设置：选中几段批量跑，它们共用同一套种子/步数/CFG/选卡；单独重跑某一段，
 * 用的也还是这一套。否则同一集里各段参数飘来飘去，拼成整片时根本对不上。
 *
 * 所以这里不放"草稿"，只做三件事：
 *   1. RunConfig ↔ PipelineParams 的双向映射（写回运行配置，即持久化）；
 *   2. 人话摘要与"沿用上次配方"要打的 prompt 字段；
 *   3. 面板要用的换算：像素密度（MP）↔ 宽高、选卡多选、"这一次跑哪几档"。
 *
 * 覆盖面：**运行配置里的一等公民字段全部搬到这里**。
 * 留在这里的唯一判据是：它是不是**导演节点（或二采那两个连线节点）上的运行旋钮**。
 * 节点参数（模型文件、LoRA、加速）仍在工作流控制台。
 */
import {
  CARD_OFF,
  RUN_MODEL_CHOICES,
  formatCardList,
  parseCardList,
  secondStageOf,
  type RunConfig,
  type SecondStage
} from './run'
import { R2V_TASK_TYPE } from './pack'
import {
  SECOND_SEED_FIXED,
  secondSeedOf,
  secondSamplerOf,
  stageFlags,
  type SecondUpscaleMode
} from './secondPass'

export interface PipelineParams {
  seed: number
  /** 每次提交换一个随机种子（此时 seed 只作展示） */
  randomSeed: boolean
  steps: number
  cfg: number
  sampler: string
  scheduler: string
  /** 视频 shift（flow matching 的噪声调度，越大越"听话"） */
  shiftVideo: number
  shiftAudio: number
  useSigmas: boolean
  /**
   * 一采自定义 sigmas 文本（"0.85, 0.5"）。
   * 空 = 图上现有接线/节点默认调度都不动 —— 不是"清空 sigmas"。
   */
  sigmas: string
  /** 一采模型口：主模型 / 备用模型 1 / 备用模型 2 */
  runModel: string
  taskType: string
  width: number
  height: number
  frameRate: number
  refMaxSize: number
  /** 0 = 跟随时间线实际总帧数 */
  totalFrames: number
  /** pipeline_cards：'关闭' 或 '0,1' 这种组合（多选打勾拼出来） */
  cards: string
  /** pipeline_split：'auto' 或 '24,26' 这种块数覆盖 */
  split: string

  /* ---- 二采：跟一采一样是一整套，只是能调的旋钮由节点决定 ---- */
  /** 这一次跑哪几档：只一采 / 一采+二采 / 二采直出 */
  secondStage: SecondStage
  secondRunModel: string
  secondSeed: number
  /** 二采采样器：'' = 跟随一采 */
  secondSampler: string
  /** 二采 sigmas 文本（步数 = 条数 − 1） */
  secondSigmas: string
  secondUpscaleMode: SecondUpscaleMode
  secondMegapixels: number
  secondPTier: number
  secondScale: number
  secondWidth: number
  secondHeight: number
  secondAlign: number

  /** 提交前清一次该集的缓存（换 TE kernel / 量化后必清，否则命中旧产物） */
  clearCacheOnSubmit: boolean
}

/**
 * 默认值必须与 `defaultRunConfig()` 逐项一致 —— 否则"这一集还没绑配置"和
 * "绑了默认配置"会呈现出两套不同的数值。`pipelineParams.spec.ts` 里有一条
 * 断言专门盯这件事。
 */
export const DEFAULT_PIPELINE_PARAMS: PipelineParams = {
  seed: 0,
  randomSeed: false,
  steps: 25,
  cfg: 1,
  sampler: 'res_multistep',
  scheduler: 'simple',
  shiftVideo: 12,
  shiftAudio: 3,
  useSigmas: false,
  sigmas: '',
  runModel: RUN_MODEL_CHOICES[0],
  taskType: R2V_TASK_TYPE,
  width: 864,
  height: 480,
  frameRate: 24,
  refMaxSize: 1024,
  totalFrames: 0,
  cards: CARD_OFF,
  split: 'auto',
  secondStage: 'off',
  secondRunModel: RUN_MODEL_CHOICES[0],
  secondSeed: SECOND_SEED_FIXED,
  secondSampler: '',
  secondSigmas: '',
  secondUpscaleMode: 'megapixels',
  secondMegapixels: 1,
  secondPTier: 720,
  secondScale: 2,
  secondWidth: 1376,
  secondHeight: 768,
  secondAlign: 32,
  clearCacheOnSubmit: false
}

/**
 * 数字字段的容错：null / undefined / 空串 / NaN 一律回默认。
 *
 * 不能只写 `Number.isFinite(Number(v))` —— `Number(null) === 0`、`Number('') === 0`，
 * 清空过输入框的字段会静默变成 0（步数 0、画布 0），提交时才炸。
 * 而 0 本身是合法值（CFG 0、总帧数 0 = 跟随），所以只对"空"回退。
 */
function num(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 字符串字段的容错：空串回默认（采样器选空会让节点报错） */
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

/** 允许空串的字符串（sigmas 文本空 = 不动） */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 运行配置 → 统一参数 */
export function pipelineParamsFromConfig(cfg: RunConfig | null | undefined): PipelineParams {
  const d = DEFAULT_PIPELINE_PARAMS
  if (!cfg) return { ...d }
  return {
    seed: num(cfg.seed, d.seed),
    randomSeed: !!cfg.randomSeed,
    steps: num(cfg.steps, d.steps),
    cfg: num(cfg.cfg, d.cfg),
    sampler: str(cfg.sampler, d.sampler),
    scheduler: str(cfg.scheduler, d.scheduler),
    shiftVideo: num(cfg.shiftVideo, d.shiftVideo),
    shiftAudio: num(cfg.shiftAudio, d.shiftAudio),
    useSigmas: !!cfg.useSigmas,
    sigmas: text(cfg.sigmas),
    runModel: str(cfg.runModel, d.runModel),
    taskType: str(cfg.taskType, d.taskType),
    width: num(cfg.width, d.width),
    height: num(cfg.height, d.height),
    frameRate: num(cfg.frameRate, d.frameRate),
    refMaxSize: num(cfg.refMaxSize, d.refMaxSize),
    totalFrames: num(cfg.totalFrames, d.totalFrames),
    cards: str(cfg.cards, CARD_OFF),
    split: typeof cfg.split === 'string' ? cfg.split : d.split,
    secondStage: secondStageOf(cfg),
    secondRunModel: str(cfg.secondRunModel, d.secondRunModel),
    secondSeed: secondSeedOf(cfg),
    secondSampler: secondSamplerOf(cfg.secondSampler),
    secondSigmas: text(cfg.secondSigmas),
    secondUpscaleMode: (cfg.secondUpscaleMode || d.secondUpscaleMode) as SecondUpscaleMode,
    secondMegapixels: num(cfg.secondMegapixels, d.secondMegapixels),
    secondPTier: num(cfg.secondPTier, d.secondPTier),
    secondScale: num(cfg.secondScale, d.secondScale),
    secondWidth: num(cfg.secondWidth, d.secondWidth),
    secondHeight: num(cfg.secondHeight, d.secondHeight),
    secondAlign: num(cfg.secondAlign, d.secondAlign),
    clearCacheOnSubmit: !!cfg.clearCacheOnSubmit
  }
}

/**
 * 统一参数 → `run.patch()` 的补丁。
 *
 * 键名与 `RunConfig` 同名，所以是**逐个显式列出**而不是展开对象：
 * 交付页的输入框偶尔会传出 `undefined`（清空输入），展开对象会把它写进配置，
 * 把原本有值的旋钮清成 undefined。只认"明确给过的字段"。
 *
 * `secondStage` 是唯一的例外：它一变，两个老布尔必须跟着变（别的页面还在读
 * `secondEnabled` / `secondOnly`），所以在这里顺手换算，别让两处各写一遍。
 */
export function pipelineParamsPatch(p: Partial<PipelineParams>): Partial<RunConfig> {
  const out: Partial<RunConfig> = {}
  if (p.seed !== undefined) out.seed = p.seed
  if (p.randomSeed !== undefined) out.randomSeed = p.randomSeed
  if (p.steps !== undefined) out.steps = p.steps
  if (p.cfg !== undefined) out.cfg = p.cfg
  if (p.sampler !== undefined) out.sampler = p.sampler
  if (p.scheduler !== undefined) out.scheduler = p.scheduler
  if (p.shiftVideo !== undefined) out.shiftVideo = p.shiftVideo
  if (p.shiftAudio !== undefined) out.shiftAudio = p.shiftAudio
  if (p.useSigmas !== undefined) out.useSigmas = p.useSigmas
  if (p.sigmas !== undefined) out.sigmas = p.sigmas
  if (p.runModel !== undefined) out.runModel = p.runModel
  if (p.taskType !== undefined) out.taskType = p.taskType
  if (p.width !== undefined) out.width = p.width
  if (p.height !== undefined) out.height = p.height
  if (p.frameRate !== undefined) out.frameRate = p.frameRate
  if (p.refMaxSize !== undefined) out.refMaxSize = p.refMaxSize
  if (p.totalFrames !== undefined) out.totalFrames = p.totalFrames
  if (p.cards !== undefined) out.cards = p.cards
  if (p.split !== undefined) out.split = p.split
  if (p.secondStage !== undefined) {
    out.secondStage = p.secondStage
    Object.assign(out, stageFlags(p.secondStage))
  }
  if (p.secondRunModel !== undefined) out.secondRunModel = p.secondRunModel
  if (p.secondSeed !== undefined) out.secondSeed = p.secondSeed
  if (p.secondSampler !== undefined) out.secondSampler = p.secondSampler
  if (p.secondSigmas !== undefined) out.secondSigmas = p.secondSigmas
  if (p.secondUpscaleMode !== undefined) out.secondUpscaleMode = p.secondUpscaleMode
  if (p.secondMegapixels !== undefined) out.secondMegapixels = p.secondMegapixels
  if (p.secondPTier !== undefined) out.secondPTier = p.secondPTier
  if (p.secondScale !== undefined) out.secondScale = p.secondScale
  if (p.secondWidth !== undefined) out.secondWidth = p.secondWidth
  if (p.secondHeight !== undefined) out.secondHeight = p.secondHeight
  if (p.secondAlign !== undefined) out.secondAlign = p.secondAlign
  if (p.clearCacheOnSubmit !== undefined) out.clearCacheOnSubmit = p.clearCacheOnSubmit
  return out
}

/**
 * 「沿用上次配方」重跑时要打回 prompt 的字段。
 *
 * 键名是导演节点上的输入名：选卡叫 `pipeline_cards`、切分叫 `pipeline_split`，
 * 跟配置里的 `cards` / `split` 不是一个词。随机种子不进 prompt —— 它在提交
 * 那一刻已经算成具体数值了。
 *
 * 这些键**只写入 prompt 里本来就有的**（`run.resubmit` 会过滤），所以多带几个
 * 不会给老版本节点塞未知输入。
 *
 * **不含 `task_type`**：任务类型决定"这条时间线要几张参考图、走不走 i2v"，
 * 而沿用配方时时间线是历史那一份，改任务类型等于让节点拿着 r2v 的时间线去跑 i2v。
 * 正常路径（按当前段重建导演包）里它照旧由 `applyRunConfigToApi` 注入。
 *
 * **不含 sigmas 文本与二采分辨率**：它们在别的节点上（ManualSigmas / 放大节点），
 * 由 `run.resubmit` 单独按图去改（`applySigmasText` / `applyUpscaleToApi`）。
 */
export function pipelinePromptInputs(p: PipelineParams): Record<string, unknown> {
  return {
    seed: p.seed,
    steps: p.steps,
    cfg: p.cfg,
    sampler: p.sampler,
    scheduler: p.scheduler,
    shift_video: p.shiftVideo,
    shift_audio: p.shiftAudio,
    use_sigmas: p.useSigmas,
    run_model: p.runModel,
    width: p.width,
    height: p.height,
    frame_rate: p.frameRate,
    ref_max_size: p.refMaxSize,
    pipeline_cards: p.cards,
    pipeline_split: p.split,
    second_run_model: p.secondRunModel,
    second_seed: p.secondSeed,
    second_only: p.secondStage === 'pair'
  }
}

/** 选卡的人话：'关闭' 说成单卡，'0,1' 说成 卡 0,1 */
export function cardsLabel(cards: string): string {
  const list = parseCardList(cards)
  if (!list.length) return '单卡'
  return `卡 ${list.join(',')}`
}

/** 勾选/取消一张卡（多选），空选 = 关闭（单卡原样） */
export function toggleCard(cards: string, card: number): string {
  const list = parseCardList(cards)
  const next = list.includes(card) ? list.filter((c) => c !== card) : [...list, card]
  return formatCardList(next)
}

/**
 * 「统一参数」一行摘要（页头 chip / 提交弹窗都用它，保证两处说法一致）。
 *
 * 只挑"一眼能判断这次跑得多重"的几项：种子、步数、CFG、采样器、画布、卡。
 * 帧率 / shift / 参考图上限这类藏在展开区，塞进摘要只会让它长到看不清。
 *
 * 档位（只一采 / 一采 + 二采 / 二采直出）刻意不进这里 —— 它是点运行按钮那一下
 * 才定的，写进摘要会让人以为是个常驻参数，还会和按钮上的档位打架。
 */
export function pipelineSummary(p: PipelineParams): string {
  const parts = [
    p.randomSeed ? '种子 随机' : `种子 ${p.seed}`,
    `${p.steps} 步`,
    `CFG ${p.cfg}`,
    p.sampler,
    `${p.width}×${p.height}`,
    cardsLabel(p.cards)
  ]
  return parts.join(' · ')
}

/** 参数是否有实质差异（决定"统一参数"标签要不要标成已改过） */
export function pipelineEquals(a: PipelineParams, b: PipelineParams): boolean {
  const keys = Object.keys(DEFAULT_PIPELINE_PARAMS) as (keyof PipelineParams)[]
  return keys.every((k) => a[k] === b[k])
}

/* ------------------------------------------------------------------ *
 * 画布：手输像素密度，动态算宽高
 * ------------------------------------------------------------------ */

/** 画布步长：必须 32 的倍数（导演包 snapCanvas + 后端强校验） */
export const CANVAS_STEP = 32

/** 常用画幅比例（宽/高）。1.8 是 H3 官方历史画布 864×480 的比例 */
export const CANVAS_RATIOS: Array<{ label: string; value: number }> = [
  { label: '1.8:1', value: 1.8 },
  { label: '16:9', value: 16 / 9 },
  { label: '2:1', value: 2 },
  { label: '4:3', value: 4 / 3 },
  { label: '1:1', value: 1 },
  { label: '3:4（竖）', value: 3 / 4 },
  { label: '9:16（竖）', value: 9 / 16 }
]

/**
 * 像素密度快捷档（百万像素）。
 *
 * 0.09 MP ≈ 416×224 —— 比原来最小档 640×352 还小一半，纯为"先看个动作对不对"。
 * 1.0 MP 是 T10 上 864×480（0.41 MP）的两倍多，一采能不能吃得下要自己试。
 */
export const CANVAS_MP_PRESETS = [0.09, 0.15, 0.22, 0.3, 0.42, 0.6, 0.9, 1.0, 1.5, 2.0]

/** 宽高 → 百万像素 */
export function canvasMegapixels(width: number, height: number): number {
  const px = Math.max(0, Number(width) || 0) * Math.max(0, Number(height) || 0)
  return Math.round((px / 1_000_000) * 1000) / 1000
}

/** 宽高 → 比例 */
export function canvasRatio(width: number, height: number): number {
  const h = Number(height) || 0
  if (h <= 0) return 1.8
  return (Number(width) || 0) / h
}

/**
 * 像素密度 + 比例 → 宽高（都是 32 的倍数）。
 *
 * 反解的时候先按比例定高、再由高定宽，这样高总是 32 的倍数、宽只差一次取整；
 * 反过来（先定宽）在竖画布上会把高度误差放大到 2 格。
 */
export function canvasFromMegapixels(
  megapixels: number,
  ratio: number,
  step = CANVAS_STEP
): { width: number; height: number } {
  const mp = Math.max(0.0001, Number(megapixels) || 0)
  const r = Number(ratio) > 0 ? Number(ratio) : 1.8
  const total = mp * 1_000_000
  const rawH = Math.sqrt(total / r)
  const rawW = rawH * r
  const snap = (n: number) => Math.max(step, Math.round(n / step) * step)
  return { width: snap(rawW), height: snap(rawH) }
}

/**
 * 画布快捷档。
 *
 * 全部是 **32 的倍数**：导演包 `buildDirectorPack` 会把宽高 `snapCanvas` 到 32，
 * 这里给一个 720 之类的值，配置里写着 1280×720、时间线里却是 1280×704，
 * 产物探测按哪个尺寸都对不上。宁可给 1280×704（比例 1.82）也不给 720。
 */
export const CANVAS_PRESETS: { label: string; width: number; height: number; note: string }[] = [
  { label: '384×224', width: 384, height: 224, note: '草稿 · 0.09MP' },
  { label: '512×288', width: 512, height: 288, note: '试跑 · 0.15MP' },
  { label: '640×352', width: 640, height: 352, note: '小画布 · 0.22MP' },
  { label: '768×448', width: 768, height: 448, note: '中画布 · 0.34MP' },
  { label: '864×480', width: 864, height: 480, note: '默认 · 0.41MP' },
  { label: '960×544', width: 960, height: 544, note: '略大 · 0.52MP' },
  { label: '1088×608', width: 1088, height: 608, note: '大画布 · 0.66MP' },
  { label: '1280×704', width: 1280, height: 704, note: '最大 · 0.90MP' }
]

/** 步数快捷档：试跑 / 常规 / 质量 */
export const STEP_PRESETS = [8, 12, 16, 20, 25, 30, 40, 50]

/**
 * 总帧数的"跟随"值。
 *
 * 0 = 跟随时间线，节点侧就是这么约定的；单独提出来是因为 UI 上要把它显示成
 * 「跟随时间线（自动）」而不是一个 0，否则用户会以为写错了。
 */
export const TOTAL_FRAMES_FOLLOW = 0
