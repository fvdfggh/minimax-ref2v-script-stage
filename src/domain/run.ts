/**
 * 运行配置（RunConfig）的领域模型。
 *
 * 和工作流控制台的分工：
 *
 *   控制台（stores/workflow.ts）= **节点参数** —— 模型、LoRA、加速、输出、二采放大。
 *   运行配置（本文件）         = **导演节点的运行旋钮** —— seed / cfg / steps / 采样器
 *                                 / 调度器 / 画布 / 帧率 / 选卡 / 二采开关 / 缓存分集。
 *
 * 为什么要分开：导演节点（`ComfyMiniMaxH3DirectorOpt`）在控制台里是**刻意隐藏**的
 * —— 它一个节点就是一整个工作台（29 个 widget + 一条 timeline JSON），塞进参数
 * 卡片只会变成一堆没有上下文的滑杆。但它的这些旋钮恰恰是"每次跑之前都要调"的
 * 东西：换一个 seed、降到 20 步、只用 1 张卡试跑、把缓存指到另一块盘。
 * 没有这一页，控制台编好参数也无从发起一次运行。
 *
 * 注入规则沿用控制台那一条铁律：**只认 API format 的命名 `inputs{}`**，
 * 绝不碰 UI 工作流的 widgets_values（位置数组，节点一改就整体错位）。
 */

import { OWNED_DIRECTOR_KEYS } from './director'
import { R2V_TASK_TYPE } from './pack'
import {
  SECOND_SAMPLER_FOLLOW,
  SECOND_SEED_FIXED,
  SECOND_UPSCALE_MODES,
  applySigmasText,
  applyUpscaleToApi,
  secondSeedOf,
  secondSamplerOf,
  type SecondStage,
  type SecondUpscaleMode
} from './secondPass'
import type { ApiWorkflow } from './workflow'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

export const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188'

/**
 * 三态（只一采 / 一采+二采 / 二采直出）定义在 `secondPass.ts` —— `run.ts`
 * 要 import 它去改图，反过来定义就成了循环依赖。这里只做转出，调用方仍然
 * 可以从 `domain/run` 拿到。
 */
export {
  SECOND_SAMPLER_FOLLOW,
  SECOND_SEED_FIXED,
  SECOND_STAGE_OPTIONS,
  secondSamplerOf,
  type SecondStage
} from './secondPass'

/**
 * 配置里到底该跑哪一档。
 *
 * 老配置没有 `secondStage`：只有 `secondOnly` 真的会让节点跑二采，所以按它迁移；
 * `secondEnabled` 单独为 true 时在节点上**什么都不会发生**（那是旧 UI 的谎话），
 * 一律按"只跑一采"处理。
 */
export function secondStageOf(cfg: RunConfig | null | undefined): SecondStage {
  if (!cfg) return 'off'
  const s = cfg.secondStage
  if (s === 'off' || s === 'pair' || s === 'direct') return s
  return cfg.secondOnly ? 'pair' : 'off'
}

/** 导演节点的两个历史 class_type，导入的工作流可能用任意一个 */
const DIRECTOR_TYPES = ['ComfyMiniMaxH3DirectorOpt', 'MiniMaxH3DirectorOpt']

/**
 * 这个 class_type 是不是导演节点。
 *
 * 导出成一个函数是因为它不止用在"导入的工作流"上：远程绑定缓存时要扫
 * ComfyUI 的 `/history`，那里的图是**任意来源**的 API prompt，同样得先认出
 * 哪个节点是导演，才知道 `workflow_name`（缓存目录）和 `timeline_data` 在哪。
 */
export function isDirectorClass(classType: unknown): boolean {
  return typeof classType === 'string' && DIRECTOR_TYPES.includes(classType)
}

/** 选卡：节点枚举值由随包引擎按实际可见卡生成，这里给常见组合 + 兜底 */
export const CARD_PRESETS = ['关闭', '0', '1', '0,1', '0,1,2', '0,1,2,3']

/** 选卡的"关闭"值：不含数字，所以「无数字即关闭」的容错解析才成立 */
export const CARD_OFF = '关闭'

/**
 * 选卡值 → 物理卡下标，按用户勾选顺序。
 *
 * 刻意宽容：值可能是 `'0,1'`、`'0 1'`、`'卡 0 + 卡 1'`、数组，甚至 1 这种数字
 * （不同渲染器给的类型不一样）。规则同节点侧 `h3mg.director_bridge.normalize_cards`：
 * 提取所有数字段，`关闭` 因不含数字自然得到空数组。
 */
export function parseCardList(value: unknown): number[] {
  if (value == null) return []
  if (Array.isArray(value)) {
    const out: number[] = []
    for (const v of value) for (const n of parseCardList(v)) if (!out.includes(n)) out.push(n)
    return out
  }
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? [Math.trunc(value)] : []
  const out: number[] = []
  for (const m of String(value).matchAll(/\d+/g)) {
    const n = Number(m[0])
    if (Number.isFinite(n) && !out.includes(n)) out.push(n)
  }
  return out
}

/** 物理卡下标 → 选卡值。空 = 关闭 */
export function formatCardList(cards: number[]): string {
  const list = [...new Set(cards.filter((n) => Number.isFinite(n) && n >= 0))].sort((a, b) => a - b)
  return list.length ? list.join(',') : CARD_OFF
}

/**
 * n 张可见卡的全部有用组合 —— 与节点侧 `card_options()` 同一套规则
 * （`itertools.combinations` 枚举非空子集），所以前端算出来的一定是节点认的。
 * 4 张卡就是 关闭 + 15 种：1 张、2 张、3 张、4 张，任意组合都可选。
 */
export function allCardSubsets(n: number): string[] {
  const count = Math.max(0, Math.trunc(n))
  const out = [CARD_OFF]
  if (count <= 0) return out
  const idx = Array.from({ length: count }, (_, i) => i)
  for (let k = 1; k <= count; k++) {
    for (const pick of combinations(idx, k)) out.push(pick.join(','))
  }
  return out
}

function combinations(pool: number[], k: number): number[][] {
  if (k === 0) return [[]]
  if (k > pool.length) return []
  const [head, ...rest] = pool
  return [
    ...combinations(rest, k - 1).map((tail) => [head, ...tail]),
    ...combinations(rest, k)
  ]
}

/** 选了、但 ComfyUI 看不见的卡 —— 提交前必须拦下来，否则节点直接报错 */
export function cardsOutOfRange(cards: number[], visible: number): number[] {
  if (!Number.isFinite(visible) || visible <= 0) return []
  return cards.filter((c) => c >= visible)
}

export const RUN_MODEL_CHOICES = [
  '主模型 (model)',
  '备用模型 1 (model_b)',
  '备用模型 2 (model_c)'
]

/** ComfyUI KSampler.SAMPLERS 的常用子集；H3 官方模板用 res_multistep */
export const SAMPLERS = [
  'res_multistep',
  'uni_pc',
  'uni_pc_bh2',
  'euler',
  'euler_ancestral',
  'heun',
  'dpmpp_2m',
  'dpmpp_2m_sde',
  'dpmpp_3m_sde',
  'dpmpp_sde',
  'lcm',
  'ddpm',
  'lms'
]

export const SCHEDULERS = [
  'simple',
  'normal',
  'karras',
  'exponential',
  'sgm_uniform',
  'ddim_uniform',
  'beta',
  'linear_quadratic',
  'kl_optimal'
]

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

export type WorkflowNameMode = 'episode' | 'custom'

export interface RunConfig {
  id: string
  name: string
  desc: string

  /** ComfyUI 地址。前端经剧本台后端转发，不受浏览器 CORS / 本机代理影响 */
  baseUrl: string
  /** 是否走 /minimax/director_opt/import_pack（否则直接用剧本站生成的 timeline） */
  usePackImport: boolean

  /** 多卡流水线：pipeline_cards。'关闭' = 单卡原样 */
  cards: string
  /** 切分覆盖：留 auto 即可（节点侧按字节均衡，实测也是吞吐最优档） */
  split: string

  /** Director 节点 */
  taskType: string
  cfg: number
  seed: number
  /** 每次提交都换一个随机种子（seed 控件只作展示） */
  randomSeed: boolean
  steps: number
  sampler: string
  scheduler: string
  shiftVideo: number
  shiftAudio: number
  frameRate: number
  width: number
  height: number
  refMaxSize: number
  /** 0 = 跟随时间线实际总帧数 */
  totalFrames: number
  runModel: string
  useSigmas: boolean

  /** 二级采样 */
  secondEnabled: boolean
  secondRunModel: string
  secondSeed: number
  /** 二采采样器：'' = 跟随一采（节点侧 second_sampler 的默认值） */
  secondSampler: string
  /** 一采只出 latent、不解码，出片全来自二采 */
  secondOnly: boolean

  /**
   * 这一次跑哪几段（三选一，前端就是三个运行按钮）：
   *
   *   · `off`    —— 只跑一采，不碰二采；
   *   · `pair`   —— 一采 + 二采串在同一跑里（节点侧 `second_only=true`：
   *                 一采只采样不解码，二采拿它的 latent 出片）；
   *   · `direct` —— **二采直出**：跳过一采，直接对磁盘上已有的缓存 latent
   *                 做放大 + 重采样（节点侧靠时间线的 `secondSample` 触发）。
   *
   * 为什么不用 `secondEnabled + secondOnly` 两个布尔：它们的组合里只有两种
   * 是节点真认的，"开了二采但没开只出"这一档在节点上**什么都不发生** ——
   * 一直是一句谎话。这里用一个三态字段把话说清楚，两个老布尔仅作兼容写入。
   */
  secondStage: SecondStage

  /** 一采自定义 sigmas（`ManualSigmas.sigmas` 的文本；空 = 不动图上现有接线） */
  sigmas: string
  /** 二采自定义 sigmas（同上，接的是 `second_sigmas`；步数 = 条数 − 1） */
  secondSigmas: string
  /** 二采分辨率：改的是放大节点的 `mode` + `mode.<子键>` */
  secondUpscaleMode: SecondUpscaleMode
  /** megapixels 档：1.0 = 1024²（二采自己的口径，864×480 → 1376×768） */
  secondMegapixels: number
  /** p 档：480 / 720 / 1080（内部按 16 对齐，720 才是 1280×720） */
  secondPTier: number
  /** 倍率档：1.0 – 4.0 */
  secondScale: number
  /** 指定尺寸档 */
  secondWidth: number
  secondHeight: number
  /** 像素对齐（p 档忽略，那一档固定 16） */
  secondAlign: number

  /** 缓存分集：hidden widget workflow_name，决定缓存落在哪个目录 */
  workflowNameMode: WorkflowNameMode
  workflowNameCustom: string
  /**
   * 直接钉死缓存目录名（跳过集名 slug 化）。
   *
   * 远程缓存绑定专用：绑定里的目录名已经是磁盘上真实存在的那一层（可能是
   * `ep_3f9k2` 这种哈希），再按集名规则 slug 一遍会把它认成"第 3 集"→ `ep3`，
   * 于是提交跑到另一个目录，回来又说找不到产物。
   */
  workflowNameExact?: string
  /** 提交前清一次该 workflow 的缓存（换 TE kernel / 量化后必清） */
  clearCacheOnSubmit: boolean

  /**
   * 导演台上"其余那一批"参数（global_prompt、shift、各类开关…）。
   *
   * 键就是节点的 input 名。存在的理由：导演台有 38 个输入，剧本台只把最常用的
   * 提成一等公民字段，剩下的如果丢掉，用户就会以为"剧本台缺功能"。
   * 一等公民字段管到的键见 `OWNED_DIRECTOR_KEYS`，这里绝不重复。
   */
  extras: Record<string, unknown>

  createdAt: number
  updatedAt: number
}

export function defaultRunConfig(): RunConfig {
  const ts = Date.now()
  return {
    id: '',
    name: '默认运行配置',
    desc: '',
    baseUrl: DEFAULT_COMFY_URL,
    usePackImport: true,
    cards: '关闭',
    split: 'auto',
    taskType: R2V_TASK_TYPE,
    cfg: 1,
    seed: 0,
    randomSeed: false,
    steps: 25,
    sampler: 'res_multistep',
    scheduler: 'simple',
    shiftVideo: 12,
    shiftAudio: 3,
    frameRate: 24,
    width: 864,
    height: 480,
    refMaxSize: 1024,
    totalFrames: 0,
    runModel: RUN_MODEL_CHOICES[0],
    useSigmas: false,
    secondEnabled: true,
    secondRunModel: RUN_MODEL_CHOICES[0],
    secondSeed: SECOND_SEED_FIXED,
    secondSampler: '',
    secondOnly: false,
    secondStage: 'off',
    sigmas: '',
    secondSigmas: '',
    secondUpscaleMode: 'megapixels',
    secondMegapixels: 1,
    secondPTier: 720,
    secondScale: 2,
    secondWidth: 1376,
    secondHeight: 768,
    secondAlign: 32,
    workflowNameMode: 'episode',
    workflowNameCustom: '',
    clearCacheOnSubmit: false,
    extras: {},
    createdAt: ts,
    updatedAt: ts
  }
}

/* ------------------------------------------------------------------ *
 * 与导入的工作流对齐
 * ------------------------------------------------------------------ */

export function directorNodeId(api: ApiWorkflow | null | undefined): string | null {
  if (!api) return null
  for (const [id, node] of Object.entries(api)) {
    if (node?.class_type && isDirectorClass(node.class_type)) return id
  }
  return null
}

function num(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function str(value: unknown, fallback: string): string {
  const s = typeof value === 'string' ? value : fallback
  return s || fallback
}

/**
 * 用导入的工作流给运行配置打底。
 *
 * 目的不是"让用户少填几个数"，而是**默认必须等于工作流里真实在跑的值** ——
 * 否则用户什么都没改就提交，等于悄悄把 25 步改成 20 步、把单卡改成双卡。
 */
export function runConfigFromApi(
  api: ApiWorkflow | null | undefined,
  base: RunConfig = defaultRunConfig()
): RunConfig {
  const id = directorNodeId(api)
  if (!id || !api) return base
  const inputs = (api[id].inputs ?? {}) as Record<string, unknown>
  const pick = <T>(key: string, fallback: T): T =>
    inputs[key] === undefined ? fallback : (inputs[key] as T)

  return {
    ...base,
    taskType: str(inputs.task_type, base.taskType),
    cfg: num(inputs.cfg, base.cfg),
    seed: num(inputs.seed, base.seed),
    steps: num(inputs.steps, base.steps),
    sampler: str(inputs.sampler, base.sampler),
    scheduler: str(inputs.scheduler, base.scheduler),
    shiftVideo: num(inputs.shift_video, base.shiftVideo),
    shiftAudio: num(inputs.shift_audio, base.shiftAudio),
    frameRate: num(inputs.frame_rate, base.frameRate),
    width: num(inputs.width, base.width),
    height: num(inputs.height, base.height),
    refMaxSize: num(inputs.ref_max_size, base.refMaxSize),
    totalFrames: num(inputs.total_frames, base.totalFrames),
    runModel: str(inputs.run_model, base.runModel),
    secondRunModel: str(inputs.second_run_model, base.secondRunModel),
    secondSeed: secondSeedOf({ secondSeed: inputs.second_seed ?? base.secondSeed }),
    secondSampler: secondSamplerOf(str(inputs.second_sampler, base.secondSampler)),
    secondOnly: typeof inputs.second_only === 'boolean' ? inputs.second_only : base.secondOnly,
    secondStage: inputs.second_only === true ? 'pair' : base.secondStage,
    useSigmas: typeof inputs.use_sigmas === 'boolean' ? inputs.use_sigmas : base.useSigmas,
    cards: str(inputs.pipeline_cards, base.cards),
    split: str(inputs.pipeline_split, base.split),
    // 工作流里那个被写死的 UUID 不能继承 —— 它正是 3.2G 缓存目录的来源
    workflowNameMode: 'episode',
    workflowNameCustom: '',
    extras: leftoverDirectorInputs(inputs, base.extras)
  }
}

/**
 * 一等公民字段没管的那些导演台输入，原样收进 extras。
 *
 * 这样导入工作流后"导演台还有什么"一眼看得见，而不是只剩剧本台挑过的那几个。
 * 连线口（值是 `["39", 0]` 这种上游引用）不收 —— 那是图上的线，不是旋钮。
 */
export function leftoverDirectorInputs(
  inputs: Record<string, unknown>,
  base: Record<string, unknown> = {}
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(inputs)) {
    if (OWNED_DIRECTOR_KEYS.has(key)) continue
    // 连线引用：array 且首元素是字符串（node id）
    if (Array.isArray(value) && typeof value[0] === 'string') continue
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) continue
    out[key] = value
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 缓存分集
 * ------------------------------------------------------------------ */

/**
 * 把集名变成能当目录名的 slug。
 *
 * 缓存目录按 workflow_name 分，`第 01 集 · 夜班` 这种名字进文件系统会在
 * Windows 上留下一个带空格和间隔号的目录，脚本处理起来处处要加引号。
 *
 * 三级降级是必须的：**中文集名里没有 ASCII**，只做 ASCII 过滤的话所有中文集
 * 都会落成同一个空串 → 全部退回默认目录 → 各集缓存串在一起，一采二采互相
 * 命中错误的段。所以先找 epNN，再找任意数字（第 01 集 → ep1），最后才用
 * 集名的稳定哈希 —— 保证「同一集永远同一目录、不同集一定不同目录」。
 */
export function slugifyWorkflowName(input: string, fallback = 'episode'): string {
  const raw = (input ?? '').trim()
  if (!raw) return fallback

  const ep = raw.match(/ep\s*(\d{1,4})/i)
  if (ep) return `ep${Number(ep[1])}`

  const anyNum = raw.match(/\d{1,4}/)
  if (anyNum) return `ep${Number(anyNum[0])}`

  const ascii = raw
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  if (ascii) return ascii

  // djb2：同样的集名永远得到同样的目录，不需要持久化任何映射表
  let h = 5381
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) | 0
  return `ep_${(h >>> 0).toString(36)}`
}

export function resolveWorkflowName(
  cfg: Pick<RunConfig, 'workflowNameMode' | 'workflowNameCustom'> & {
    workflowNameExact?: string
  },
  episodeName: string
): string {
  // 钉死的目录名优先，且**不再 slug**：它就是对面磁盘上的那层目录名
  const exact = (cfg.workflowNameExact ?? '').trim()
  if (exact) return exact
  if (cfg.workflowNameMode === 'custom') {
    return slugifyWorkflowName(cfg.workflowNameCustom, 'episode')
  }
  return slugifyWorkflowName(episodeName, 'episode')
}

/**
 * 这一集**这一次该写进哪个缓存目录**（提交时用，带"已绑定就不动"的规则）。
 *
 * 为什么不能直接用 `resolveWorkflowName`：目录名一旦定下来就该跟着**集**走，
 * 而不是跟着**集名**走。用户把「第 03 集 · 雨」改成「第 03 集 · 暴雨」之后，
 * 集名 slug 变成 `ep3`（或别的），但对面磁盘上的缓存还在旧目录里 —— 一改名，
 * 交付页就会说这一集从没出过片，几百 GB 的一采二采等于凭空丢了。
 *
 * 所以按这个顺序定：
 *
 *   1. 显式钉死的名字（调用方已指定，比如从绑定恢复）；
 *   2. 用户主动改过的自定义目录 —— 模式是 custom 且**与绑定不同**，说明他在
 *      换目录（这是唯一有意为之的换法），尊重他；
 *   3. 已有的绑定目录（正常情况都走这条：第一次生成时自动绑上，此后改名不变）；
 *   4. 常规规则：集名 slug。
 */
export function resolveWorkflowNameWithBound(
  cfg: Pick<RunConfig, 'workflowNameMode' | 'workflowNameCustom'> & {
    workflowNameExact?: string
  },
  episodeName: string,
  boundName: string
): string {
  const exact = (cfg.workflowNameExact ?? '').trim()
  if (exact) return exact
  const bound = String(boundName ?? '').trim()
  if (cfg.workflowNameMode === 'custom' && cfg.workflowNameCustom.trim()) {
    const custom = slugifyWorkflowName(cfg.workflowNameCustom, 'episode')
    if (custom !== bound) return custom
  }
  if (bound) return bound
  return resolveWorkflowName(cfg, episodeName)
}

/* ------------------------------------------------------------------ *
 * 注入
 * ------------------------------------------------------------------ */

export interface ApplyRunOptions {
  /** 集名 → 决定 workflow_name（按集分缓存目录） */
  episodeName: string
  /** 时间线实际总帧数；totalFrames=0 时用它 */
  timelineFrames?: number
  /** 随机种子（randomSeed 时由调用方生成，便于测试与复现） */
  seedOverride?: number
}

/**
 * 把运行配置写进 Director 节点。
 *
 * 与 `applyTemplateToApi` 的两点差异：
 * 1. 只动 Director 一个节点，其余节点交给模板。
 * 2. `workflow_name` 是 hidden widget —— UI 导出的 API 里**常常根本没有这个键**
 *    （实测当前工作流里它是被写死的 UUID，确实在）。所以它是唯一允许**新增**
 *    的键：漏掉它就等于放弃按集分缓存，一采二采的命中全串在一起。
 *
 * 其余键一律"已存在才写"：工作流里没有 `second_only`（旧版本）时硬塞一个，
 * 节点会收到一个它不认识的 input，行为未定义。
 */
export function applyRunConfigToApi(
  api: ApiWorkflow,
  cfg: RunConfig,
  opts: ApplyRunOptions
): { api: ApiWorkflow; applied: number; skipped: string[]; workflowName: string } {
  const next: ApiWorkflow = JSON.parse(JSON.stringify(api))
  const nodeId = directorNodeId(next)
  const workflowName = resolveWorkflowName(cfg, opts.episodeName)

  if (!nodeId) {
    return { api: next, applied: 0, skipped: ['<Director 节点缺失>'], workflowName }
  }

  const inputs = next[nodeId].inputs ?? (next[nodeId].inputs = {})
  const skipped: string[] = []
  let applied = 0

  const put = (key: string, value: unknown, allowCreate = false) => {
    if (!(key in inputs) && !allowCreate) {
      skipped.push(key)
      return
    }
    inputs[key] = value
    applied += 1
  }

  put('task_type', cfg.taskType)
  put('cfg', cfg.cfg)
  put('seed', opts.seedOverride ?? cfg.seed)
  put('steps', cfg.steps)
  put('sampler', cfg.sampler)
  put('scheduler', cfg.scheduler)
  put('shift_video', cfg.shiftVideo)
  put('shift_audio', cfg.shiftAudio)
  put('frame_rate', cfg.frameRate)
  put('width', cfg.width)
  put('height', cfg.height)
  put('ref_max_size', cfg.refMaxSize)
  put('run_model', cfg.runModel)
  put('use_sigmas', cfg.useSigmas)
  put('second_run_model', cfg.secondRunModel)
  put('second_seed', secondSeedOf(cfg))
  // 新加的 widget：老工作流的模板里还没有这个键，用 allowCreate 补上
  // （节点没声明它时 ComfyUI 会忽略未知输入，不会报错）
  put('second_sampler', cfg.secondSampler || SECOND_SAMPLER_FOLLOW, true)
  // 「一采+二采」在节点上就是 second_only=true；另两档一律 false
  // （「二采直出」靠时间线的 secondSample，不是这个开关，见 secondPass.ts）
  put('second_only', secondStageOf(cfg) === 'pair')
  put('pipeline_cards', cfg.cards)
  put('pipeline_split', cfg.split)

  // 0 = 跟随时间线；否则用配置里写死的帧数
  const frames = cfg.totalFrames > 0 ? cfg.totalFrames : Number(opts.timelineFrames ?? 0)
  if (frames > 0) put('total_frames', frames)

  put('workflow_name', workflowName, true)

  // 导演台其余参数。只改"图里本来就有这个键"的 —— 凭空加键节点会当未知输入丢掉，
  // 用户改了没反应还查不出原因，所以落空的一律记进 skipped 让他看见。
  for (const [key, value] of Object.entries(cfg.extras ?? {})) {
    if (OWNED_DIRECTOR_KEYS.has(key)) continue
    if (value === undefined || value === null || value === '') continue
    put(key, value)
  }

  /**
   * 二采那三样"不在导演节点上"的东西：放大节点的分辨率、两个 ManualSigmas。
   *
   * 只在真的要跑二采时才动放大节点 —— 只跑一采却把二采分辨率写了，等于
   * 悄悄改了用户在控制台里配的节点参数，下次他自己跑二采会发现尺寸变了。
   */
  const stage = secondStageOf(cfg)
  if (stage !== 'off') {
    const up = applyUpscaleToApi(next as unknown as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>, {
      mode: cfg.secondUpscaleMode,
      megapixels: cfg.secondMegapixels,
      p: cfg.secondPTier,
      scale: cfg.secondScale,
      width: cfg.secondWidth,
      height: cfg.secondHeight,
      align: cfg.secondAlign
    }, nodeId)
    if (up.nodeId) applied += up.applied.length
    else skipped.push('upscale_model（图里没有放大节点）')
  }

  for (const [which, text] of [
    ['sigmas', cfg.sigmas],
    ['second_sigmas', cfg.secondSigmas]
  ] as const) {
    const r = applySigmasText(
      next as unknown as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>,
      nodeId,
      which,
      text
    )
    if (r.applied) applied += 1
    else if (String(text ?? '').trim()) skipped.push(which)
  }

  return { api: next, applied, skipped, workflowName }
}

/** 画布必须是 32 的倍数（r2v 后端强校验），提交前先兜一次 */
export function snapRunCanvas(value: number, fallback: number): number {
  const n = Math.round(Number(value) || fallback)
  return Math.max(32, Math.round(n / 32) * 32)
}

/**
 * 提交前的自检。
 *
 * 返回的是**人能看懂的中文问题**，不是校验码。这些东西错了不会报异常 ——
 * 选了看不见的卡会直接报错退出、二采开了但放大节点没接会在跑到二采时才炸，
 * 那时候一采已经跑完二十分钟了。
 */
export function validateRunConfig(
  cfg: RunConfig,
  ctx: {
    hasApi: boolean
    hasUpscaleNode: boolean
    hasDirector: boolean
    episodeName?: string
    /** ComfyUI 进程能看见几张卡；未知就不校验选卡范围 */
    visibleCards?: number
  }
): string[] {
  const out: string[] = []
  if (!ctx.hasApi) out.push('还没有导入 API 工作流，没有可提交的工作流。')
  else if (!ctx.hasDirector) out.push('工作流里没有导演节点（ComfyMiniMaxH3DirectorOpt），无法注入运行参数。')
  const stage = secondStageOf(cfg)
  if (ctx.hasApi && stage !== 'off' && !ctx.hasUpscaleNode) {
    out.push('这一次要跑二采，但工作流里没有放大节点（MiniMaxH3LatentUpscaleModelOpt），二采阶段会直接报错。')
  }
  const cards = parseCardList(cfg.cards)
  if (cards.length >= 2 && cfg.split.trim() && cfg.split.trim() !== 'auto') {
    const parts = cfg.split.split(',').map((s) => Number(s.trim()))
    if (parts.some((p) => !Number.isFinite(p) || p <= 0)) {
      out.push(`切分覆盖「${cfg.split}」不是合法的块数列表，形如 24,26。`)
    }
  }
  // 选了 ComfyUI 看不见的卡：节点会直接报错（不会悄悄降级），这里提前拦下。
  // 提示里直接给"该用哪几张"的启动参数，省得用户自己拼。
  const bad = cardsOutOfRange(cards, ctx.visibleCards ?? 0)
  if (bad.length) {
    // 建议值取「0..最大所选」的连续区间：CUDA 可见卡本来就是从 0 连续编的
    const want = formatCardList(Array.from({ length: Math.max(...cards) + 1 }, (_, i) => i))
    out.push(
      `选了 ComfyUI 看不见的卡 ${bad.join('、')}（当前只对 ${ctx.visibleCards} 张卡可见）。` +
        `要用它请重启 ComfyUI 并带上 --cuda-device ${want}。`
    )
  }
  if (cfg.workflowNameMode === 'custom' && !cfg.workflowNameCustom.trim()) {
    out.push('缓存分集选了「自定义」但没填名字，会退回默认目录。')
  }
  if (cfg.steps < 1) out.push('步数至少 1。')
  if (cfg.width < 32 || cfg.height < 32) out.push('画布最小 32。')
  return out
}

/* ------------------------------------------------------------------ *
 * 导演节点的自定义进度事件
 * ------------------------------------------------------------------ */

/**
 * 导演节点发的是**自定义事件**，不是 ComfyUI 标准的 `progress`。
 *
 * 两个坑（都是实测出来的，踩过才知道）：
 *   1. 事件名是 `minimax_director_opt_progress`。ComfyUI 标准采样进度叫 `progress`，
 *      只认后者的话，导演节点跑起来进度条**永远是 0%**。
 *   2. 载荷里**没有 `prompt_id`**，只有 `node_id`。所以不能像标准事件那样
 *      用 prompt_id 找任务，得拿 node_id 去对提交时记下的导演节点 id。
 */
export const DIRECTOR_PROGRESS_EVENT = 'minimax_director_opt_progress'

export interface DirectorProgressPatch {
  /** 发事件的节点 id —— 用来把进度归到某个任务上 */
  nodeId: string
  /**
   * 这条是不是"整体进度"（payload 里有 overall_*）。
   *
   * 采样步里的上报只有 `value/max`（比如 1/3 步），拿它去覆盖整体进度会把
   * 75% 打成 33%。所以调用方只在 overall 为真时才动 value/max。
   */
  overall: boolean
  value: number
  max: number
  segment: number
  segmentTotal: number
  timelineSegment: string
  phase: string
  phaseLabel: string
  framesLabel: string
  remainingSegments: number
}

/**
 * 解析导演进度载荷。字段全是可选的：节点不同版本发的字段不一样，
 * 少一个就保持调用方原来的值，绝不能因为半个字段就把整条进度丢掉。
 */
/**
 * 把一条进度上报并进进度条 —— **按百分比单调**。
 *
 * 为什么不能直接 `value = max(value, patch.value)`：
 *   4 段并发时，各段报的是**自己的口径** —— 一会儿是整体的 `12/16`，
 *   一会儿是步内的 `2/3`。`max` 字段一变，`Math.max(12, 2)` 这种写法就守不住了
 *   （12/16=75% 会被 2/3=67%、甚至被另一个段的 6/16=38% 直接打回去）。
 *   实测四卡跑时百分比在 75% → 38% → 19% → 94% 之间来回跳，看着就像卡死。
 *
 * 所以只认百分比：更低的（落后段/步内）一律丢弃，进度条只许前进。
 */
export function mergeProgress(
  cur: { value: number; max: number },
  patch: { overall: boolean; value: number; max: number }
): { value: number; max: number } {
  if (!patch.overall) return cur
  if (patch.max <= 0) return cur
  const curPct = cur.max > 0 ? cur.value / cur.max : -1
  const nextPct = patch.value / patch.max
  if (curPct >= 0 && nextPct < curPct) return cur
  return { value: patch.value, max: patch.max }
}

export function parseDirectorProgress(
  data: Record<string, unknown> | null | undefined
): DirectorProgressPatch | null {
  if (!data) return null
  const n = (k: string, f = 0): number => {
    const v = Number((data as Record<string, unknown>)[k])
    return Number.isFinite(v) && v !== 0 ? v : f
  }
  const s = (k: string, f = ''): string => {
    const v = (data as Record<string, unknown>)[k]
    return typeof v === 'string' && v ? v : f
  }
  const value = n('overall_value', n('value', 0))
  const max = n('overall_max', n('max', 0))
  if (!max && !value) return null
  const overall =
    (data as Record<string, unknown>)['overall_value'] !== undefined ||
    (data as Record<string, unknown>)['overall_max'] !== undefined
  return {
    nodeId: s('node_id'),
    overall,
    value,
    max,
    segment: n('segment'),
    segmentTotal: n('segment_total', n('timeline_segment_total')),
    timelineSegment: s('timeline_segment'),
    phase: s('phase'),
    phaseLabel: s('phase_label', s('phase')),
    framesLabel: s('frames_label'),
    remainingSegments: n('remaining_segments')
  }
}
