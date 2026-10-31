export type ID = string

/**
 * 流水线语言。
 *   zh —— 阶段①~③ 全程中文撰写，人工审阅成本最低；阶段④ 由模型统一转成规范英文
 *   en —— 直接产出英文终稿
 * 结构锚点（<Subject N> / (Sx) / <Picture N> / <d> / [Shot N] 时间码等）
 * 在两种语言下都保持英文，只有「自由描述」跟着语言走。
 */
export type Lang = 'zh' | 'en'

/* ------------------------------------------------------------------ *
 * 实体注册表：全片唯一真相源
 * <Subject N> / (Sx) / <Picture N> / 音色描述 只在这里存一份
 * ------------------------------------------------------------------ */

/**
 * 主体只有三类，别再细分：
 *   character 角色 —— 人形、有表演、可以说话（只有这类能开「会说话」）
 *   scene     场景 —— 每个片段有且仅有一个，必填
 *   prop      道具 —— 物件 / 车辆 / 界面元素，不发声
 *
 * 之前还有一个 ui 和 other：实际用起来，界面元素归道具、认不出的也归道具就行，
 * 多两个枚举只会让填写的人纠结，对提示词没有区别。旧数据由 normalizeEntityType 收口。
 */
export type EntityType = 'character' | 'scene' | 'prop'

/** 固定顺序：角色 → 场景 → 道具（列表分组、筛选、下拉都用它） */
export const ENTITY_TYPES: readonly EntityType[] = ['character', 'scene', 'prop'] as const

/** speaking = 会说话（必须绑定音色与 Sx）；non_speaking = 不说话 */
export type EntityKind = 'speaking' | 'non_speaking'

/** 场景实体 */
export const SCENE_ENTITY_TYPE: EntityType = 'scene'

/**
 * 把历史数据 / 模型返回里更细的类型收进三类。
 *
 * ui（界面）和 other 都归道具：这样老项目不会因为类型收敛而丢主体、丢编号、
 * 丢参考图；认不出的值也按道具处理，比直接当角色（会被塞进音色表）更保守。
 */
export function normalizeEntityType(v: unknown): EntityType {
  return v === 'character' || v === 'scene' || v === 'prop' ? v : 'prop'
}

/**
 * 实体分层：
 *   场景（scene）—— 每个片段有且仅有一个，必填
 *   角色 / 道具（character / prop）—— 可选
 * 两者同样占 <Subject N>，但在数据模型、校验、组合与缝合判定上分开处理。
 */
export function isSceneEntity(e: { type: EntityType }): boolean {
  return e.type === SCENE_ENTITY_TYPE
}

/**
 * 固定下来的音色包（.s2voice）。
 *
 * 和 voiceDesc 的分工：voiceDesc 是**给导演模型读的文字**（跨段逐字一致），
 * 决定画面里这个人"听起来什么样"；voicePack 是**给合成引擎用的声音本体**，
 * 决定段内配音真的发出什么声。两者描述的是同一件事，但一个进提示词、一个出声，
 * 所以都得存 —— 也所以改了 voiceDesc 不等于换了音色，界面上要能分别重来。
 */
export interface VoicePack {
  /** .s2voice 的文件名（不含扩展名），也是合成时的 voice id */
  id: string
  /** 设计这个音色时用的描述（快照：之后改 voiceDesc 不会回溯污染它） */
  desc: string
  /** 候选参考 wav 的文件名 */
  sample: string
  seed: number
  /** 固化时 s2 编码参考音频所用的文本，必须与设计时逐字一致 */
  text: string
  fixedAt: number
}

/**
 * 设定图里一张图承担的角色。
 * 存在组的结构里，不单独建表：一张图的身份由"它在哪个位置"决定，
 * 而不是它自己带一个字段 —— 同一张图挪了位置，身份就该跟着变。
 */
export type SheetSlot = 'master' | 'head' | 'view'

/** 一组造型：1 张组头 + N 张三视图 */
export interface RefSheetGroup {
  id: ID
  /** 组名，默认「造型 N」，可改 */
  label: string
  /** 组头（asset id）。先建组后补图时可以是 null */
  headId: ID | null
  /** 三视图（asset id），0 张也合法 */
  viewIds: ID[]
  /**
   * 这一组里**拼参考图时用哪张**三视图。
   *
   * 一组可以有好几张（重出一版、换个角度），但拼进 1376×768 的右区只需要
   * 一张 —— 塞两张进去每张只剩 464 宽，三个全身会缩成一排火柴人。
   * 缺省（null）时取 viewIds 的第一张。
   */
  pickedViewId?: ID | null
  /** 建组时的变体要求（"换季军大衣""老了十岁"），出图后留作溯源 */
  variant?: string
  createdAt: number
}

/**
 * 当前挂给 <Picture N> 的是哪组哪张 —— 界面要标出来，不然换组后不知道在用谁。
 *
 * 两种来源：
 *   single  —— 直接拿一张设定图（基模头 / 组头 / 单张三视图）当参考图
 *   compose —— 组头 + 三视图拼成 1376×768 的整张（**主路径**，每集各选一次）
 */
export interface RefSheetActive {
  groupId: ID | null
  /** single：设定图的 asset id；compose：拼接产物（也就是 <Picture N> 那张） */
  assetId: ID
  mode?: 'single' | 'compose'
  /** compose 时用的是哪张三视图 */
  viewId?: ID | null
}

/**
 * 主体的设定图组（见 domain/refSheet.ts 的说明与提示词）。
 *
 *   masterId —— 基模头：全片一张，所有组都由它编辑出来
 *   groups   —— 多组造型，各组独立
 *   active   —— 当前作为 <Picture N> 的那张
 */
export interface RefSheet {
  masterId?: ID | null
  groups: RefSheetGroup[]
  active?: RefSheetActive | null
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
  /**
   * 已经固定下来的音色包。缺省 = 还没固定（只能看描述，配不了音）。
   * 只对 speaking 有意义，切到 non_speaking 时会被清掉。
   */
  voicePack?: VoicePack | null
  /**
   * **长相**：脸型 / 五官 / 发型 / 肤色 / 年龄 / 体型骨架 / 标志性细节。
   *
   * ★ 这里**不许写穿着**。参考图是分两步出的：基模头与组头只画头肩，
   *   一拍全身的穿着写在 costumeDesc 里，由三视图那一步吃。混在一起会让
   *   头部图里凭空长出一身衣服（头肩构图装不下，模型只能裁成一团），
   *   而三视图又拿同一句话去画全身，两边永远对不上。
   *
   * 有参考图时它不是废字段 —— 模型靠它理解 <Picture N> 里到底是什么人/什么场景；
   * 无参考图时它就是唯一的画面依据。所以两种情况下都该填，别再当成
   * "纯文本实体的专用字段"。
   */
  textDesc: string | null
  /**
   * **服装与身形**：这一套造型穿什么（款式 / 颜色 / 材质 / 鞋 / 配饰），
   * 以及体型（高矮胖瘦 / 肩宽 / 姿态）。
   *
   * 只喂给三视图那一步；头部两步（基模头 / 组头）不读它。缺省 = 老数据，
   * 服装只能从 textDesc 里解析（会退化成"头部图里带一身衣服"，界面会提示拆开）。
   */
  costumeDesc?: string | null
  /** 阶段⑤本地化产物：英文实体名，跨段统一复用 */
  nameEn?: string | null
  /** 阶段⑤本地化产物：英文音色描述，必须跨段逐字一致 */
  voiceDescEn?: string | null
  /** 阶段⑤本地化产物：英文外观描述（只含长相，服装在 costumeDescEn） */
  textDescEn?: string | null
  /** 阶段⑤本地化产物：英文服装与身形描述 */
  costumeDescEn?: string | null
  /**
   * 设定图组（仅角色有意义）：基模头 + 多组「组头 + 三视图」。
   * 缺省 = 还在用"一张参考图"的老路子，界面上按老样子显示。
   */
  refSheet?: RefSheet | null
  note?: string
  /** 溯源：由哪个实体「注入/提升」复制而来（大主体→集 或 集→大主体）。null/缺省 = 原生 */
  sourceId?: ID
  createdAt: number
  updatedAt: number
}

/**
 * 素材用途（五种，别混）：
 *   subject   —— 主体的参考图，占 <Picture N>，跨段共用，进导演包 reference 槽
 *   scene     —— 片段的场景图，pictureN 固定为 0，不进 reference 槽，仅本地查看
 *   keyframe  —— **本段独有**的关键帧，导演台里作为画面锚点（首帧 / 中间 / 尾帧），
 *                随段送进 kfImages / genImage，强度低于 100 时按强度混噪当参考
 *   material  —— **本段独有**的音视频素材：图像 / 视频按强度进 kfVideos，音频强度满值时
 *                固定音轨（kfAudios），低于满值走 refAudios
 *   other     —— 其它 / 未分类
 *
 * 为什么 keyframe 不直接当成 subject：subject 是"这个人/这个地方长什么样"，
 * 换一段还用同一张；keyframe 是"这一秒画面就该是这样"，只属于这一拍。
 * 混在一起会导致改一拍的画面把别的段一起改了。
 *
 * plate —— **场景占位图**：一个场景一张宽幅图（人物按站位摊开），refId = 场景实体 id。
 *   它既不是主体参考图（不占 <Picture N>、不进导演包），也不是某一段的场景图
 *   （refId 不是 beat.id）—— 它是给本场所有片段"裁起始帧"用的底图。
 *   与 scene 一样 pictureN 恒为 0，打包时两边都不会捡到它。
 *
 * sheet —— **设定图组的原图**（基模头 / 组头 / 三视图），refId = 主体实体 id。
 *   pictureN 恒为 0：一组的图有好几张，而 <Picture N> 只认**一张**。
 *   用户在界面上挑中哪张，就把那张的像素写进主体的 Picture N 槽位
 *   （见 registry.useSheetImageAsReference），组里的原图本身永远不进导演包。
 *   这样"多组造型并存、用的时候只挑一张"才不会把参考图槽挤爆。
 */
export type AssetKind = 'subject' | 'scene' | 'plate' | 'sheet' | 'other' | 'keyframe' | 'material'

/** 素材本体类型（图片 / 音频 / 视频），由扩展名 + MIME 推断 */
export type MediaKind = 'image' | 'audio' | 'video'

/**
 * 段内素材的**作用方式**（图片、音视频都有这一维）。
 *
 *   keyframe  —— 当这一段自己的内容用：图片落在段内某一帧（进 kfImages，
 *                强度决定钉得多硬），音视频落在这条时间轴上（音频满强度是
 *                固定音轨、视频够硬就钉一段画面）。
 *   reference —— 只借给模型看 / 听：图片**不落帧、不抢首尾**，只占一个
 *                <Picture N> 槽；音视频**不占时间轴**，只进参考通道
 *                （refAudios / refVideos，借音色 / 动作）。
 *
 * 为什么要有这个字段：同一张图、同一段声音，"这一秒就该是这样"和"借它
 * 的感觉"是两件事。混成一种，用户就只能用"强度调低"这种隐晦办法来表达
 * "我不想它锁住这一帧 / 占住这条音轨"。
 *
 * 缺省 = keyframe：老数据里的段内素材一直当内容用，不能静默变成参考。
 */
export type AssetActAs = 'keyframe' | 'reference'

/**
 * 旧版「作用」字段，只为读老数据 / 老项目包保留。
 *
 * 现在一律写 `Asset.strength`（0~100）。这个类型不再出现在写入路径上：
 * 导入旧数据时由 `references.strengthOf` 折成强度（force → 100、ref → 30）。
 */
export type AssetUsage = 'force' | 'ref'

/** 关键帧在段内的位置：首帧 / 中间锚点 / 尾帧 */
export type KeyframeRole = 'start' | 'anchor' | 'end'

/**
 * 关键帧的**放置**（比 role 更贴近用户在界面上做的选择）：
 *   head —— 段首（第 0 帧），打包时同时充当 startImage / genImage
 *   tail —— 段尾（最后一帧），打包时同时充当 endImage
 *   at   —— 指定帧，任意位置，只进 kfImages 当锚点
 *
 * role 是导演台的三种"身份"，placement 是"把它摆在哪"。两者一一对应
 * （head↔start、tail↔end、at↔anchor），分开命名只是因为界面上说
 * "中间锚点"没人知道是"可以放任意帧"的意思。
 */
export type KeyframePlacement = 'head' | 'tail' | 'at'

/** 一个片段里多张关键帧的自动摆放策略 */
export type KeyframeLayout = 'head_tail' | 'even' | 'manual'

export interface Asset {
  id: ID
  projectId: ID
  /**
   * 全局素材编号 Picture N。
   * 场景图 / 关键帧 / 音视频素材为 0（不占 reference 槽）；
   * 例外：作用方式 = reference 的段内图片**要占槽**，会在这里分配一个编号。
   */
  pictureN: number
  fileName: string
  originalName: string
  label: string
  blob?: Blob
  /** 素材用途，缺省视为 subject（历史数据兼容） */
  kind?: AssetKind
  /** 归属：subject → entity.id；scene / keyframe / material → beat.id */
  refId?: ID
  /** 本体类型；老数据缺省按图片处理 */
  media?: MediaKind
  /**
   * 作用方式：keyframe = 这一段自己的内容（图片钉在某一帧 / 音视频落在时间轴上）；
   * reference = 只借给模型看或听（图片占 <Picture N> 槽、音视频只走参考通道，
   * 都不占时间轴）。缺省 keyframe（老数据兼容）。
   */
  actAs?: AssetActAs
  /**
   * 锚定强度 0~100。**和起始帧正交**，两者都有意义：
   *   100 —— 硬锚点：这一帧 / 这一段必须从它出发（latent 槽 pin 死，不加噪）
   *   1~99 —— 带强度的参考：仍落在 `frameIdx` 上，但按比例混噪，
   *            数值越低模型越大程度地重画（ComfyUI 的 visual_noise_aug）
   *   0   —— 纯参考：只给"长什么样"
   *
   * 缺省由本体推：图片 → 100（关键帧本来就该钉住）；
   * 音频 → 100（固定音轨），视频 → 60（参考动作，不锁死画面）。
   * 老数据的 `usage` 也在这里折算（见 references.strengthOf）。
   */
  strength?: number
  /** 旧字段，只读：导入老数据后折算成 `strength`，不再写入 */
  usage?: AssetUsage
  /** 关键帧在段内的位置（仅 kind = keyframe） */
  role?: KeyframeRole
  /**
   * 关键帧的放置（仅 kind = keyframe）。
   * 权威字段；缺省时由 role 推（老数据兼容），写入时两个一起写。
   */
  placement?: KeyframePlacement
  /**
   * 段内帧位，两个用途共用同一个字段（都只属于这一段）：
   *   keyframe —— 指定帧的帧位（placement = at 时生效）；0 / 缺省 = 段首
   *   material —— **作用起始帧**：这段音频 / 视频从本段第几帧开始生效，
   *               可以是段内任意帧（0 = 段首）；缺省按 0 处理
   */
  frameIdx?: number
  /** 素材字节数，列表里显示用 */
  bytes?: number
  /**
   * 音频时长（秒），上传 / 合成时测出来存下。
   *
   * 只对 media = audio 有意义。存下来是为了让「这段台词要多长」不必每次
   * 重新解析音频 —— 卡片、素材弹窗、批量配音都要用，重算一遍很浪费。
   * 测不出来时留空，界面退回按字数估算。
   */
  durationSec?: number
  /**
   * 素材内容说明（图片 / 音频通用）：描述这张参考图 / 这段音频里到底是什么。
   * 只作为「只读上下文」交给大模型，帮它理解 <Picture N> 参考的内容，
   * 从而写出更准确的字段；但【不会】写进最终生成的提示词 / 导演包。
   */
  desc?: string
  /**
   * 这条素材**自己的提示词**（正文）。
   *
   * 新增一条素材时它就是空串 —— 空着的提示词是一条待填的活，不是缺陷；
   * 用户可以直接写，也可以给一句口语要求让 AI 写成英文生图提示词
   * （见 stores/images.suggestAssetPrompt）。
   *
   * 只存"用户那句正文"，**不存**参考图引用段：引用段由
   * domain/assetPrompt.composeMaterialPrompt() 在展示 / 出图时按
   * refAssetIds 现拼，这样改了引用关系不会在正文里留下一段段旧话。
   */
  prompt?: string
  /** 写 prompt 时用户给的那句口语要求（"雨夜街头，他回头看"），留作重新生成的起点 */
  promptBrief?: string
  /**
   * 出图时用哪些参考图（**素材 id**，顺序即提示词里的引用顺序）。
   *
   * 一般是主体参考图（entity.pictureN 那张）。参考方式时这些图会以
   * `<Picture N> 名字 — 外观描述` 的形式写进提示词末尾 —— 导演包的正文
   * 要求出现 <Picture N>，不写的话图进了参考槽、正文却没点名。
   */
  refAssetIds?: ID[]
  /**
   * 草稿：先建了一条素材、写好"要什么"，本体还没合成。
   *
   * 两种草稿（媒体不同，作用一样 —— 都是**待合成槽位**）：
   *   图片 —— prompt 是图片合成的提示词，出图后草稿被替换成真素材；
   *   音频 —— voiceText / voiceSpeakerId 是语音合成的内容与音色，合成后同样替换。
   *
   * 草稿**不参与任何出图 / 打包**（keyframesOf / refImagesOf / materialsOf 都会
   * 把它滤掉），否则会带着"没有本体"的警告混进导演包。
   */
  draft?: boolean
  /**
   * 待合成音频槽（draft + media = 'audio'）要念的文本。
   *
   * 为什么不复用 prompt：prompt 的语义是"图片提示词"，进了打包 / 出图那条链；
   * 语音合成要的是**念出来的字**，和画面提示词是两回事，混用一个字段迟早
   * 出现"改了配音文本，图也跟着被重出"。
   */
  voiceText?: string
  /**
   * 待合成音频槽用谁的音色（主体 id）—— 合成时取该主体已固定的音色包。
   *
   * 不存 voiceId 本身：音色包是可以重新设计 / 固定的，存 id 会指向一个
   * 已经换掉的旧音色；存主体则永远跟着主体当前的声音走。
   */
  voiceSpeakerId?: ID
  /**
   * 这一格是**自动建**的（台词段默认带的那格配音），文本跟着台词走。
   *
   * 台词段天生就有一句话要说，让用户先点「＋音频配置」再抄一遍台词是白费力气：
   * 打开就是「待配音 · 某人 F0」，文本已经对齐台词。等用户在配置里改了文本，
   * 就把 auto 落成 false —— 改过之后这格属于用户，台词再变也不覆盖它。
   */
  auto?: boolean
  /**
   * 关键帧溯源：这张图**出图当时**的样子，用来判断"后来这段被改过没有"。
   *
   * 为什么存三份而不是只存一句提示词：
   *   genPrompt  —— 真正发给模型的那一句（可能被用户手改过），只供人看 / 复查；
   *   genContext —— 当时这段的**模板提示词**（画面 / 运镜 / 场景 / 主体外观）。
   *                 它是"这段没被改过"的指纹：拿它跟现在的模板比，才知道
   *                 画面描述、场景、人物外观有没有变。手改的那几个词不算改，
   *                 因为模板本身没动 —— 否则用户自己润色一句就会被判失效。
   *   genDialogue—— 当时的台词 / 语音文本。台词一变，这一段的画面与配音
   *                 都对不上了，得让用户重出。
   *
   * 三个字段都可缺省：上传的图、AI 排布出现之前的老数据没有溯源，
   * 就不判失效（不知道当时按什么出的，报警告只会吓人）。
   */
  genPrompt?: string
  genContext?: string
  genDialogue?: string
  /**
   * 溯源：这张关键帧是**从场景占位图的哪个取景框裁出来的**。
   *
   * 存下来而不是按当时的景别重算：用户可能手拖过框，重算会把他的选择抹掉；
   * 而且占位图换了以后，这张图仍然是按旧框裁的，得说清它从哪来。
   * 只有「占位取景」产生的关键帧才有这两个字段，其它出图 / 上传的都没有。
   */
  plateId?: ID
  plateRect?: { x: number; y: number; w: number; h: number }
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
  /**
   * 阶段一产出：这一拍是"转场"进来的。
   *
   * 只靠场景 / 主体 / 镜头这些结构化字段，判不出「同一间店、三天后」这种
   * 时间跳跃 —— 场景没变、人也还在。这层信息只有读完整原文的拆解阶段才有，
   * 所以让它在阶段一就落成字段，装配时直接读，而不是在阶段四拿关键词猜。
   */
  transitionIn?: boolean
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
  /**
   * 用户明确删掉了这一段的默认配音格：别再自动建回来。
   *
   * 默认配音格是"台词段自带一格待配音"，但有人就是不想配（画外音、留白）。
   * 删掉又不记一笔的话，下次刷新它又冒出来 —— 那会让人以为删不掉。
   */
  voiceSkipped?: boolean
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
  /**
   * 这个指纹是按哪一版口径算的（`FINGERPRINT_VERSION`）。
   *
   * 只在排障和迁移时用：口径升级会让同一份内容算出不同的串，比对时必须
   * 认得旧版本，否则会把所有历史记录一次性判成"过期"。
   */
  hashVersion?: number
  /** 生成时的片段 id 序列，用于在界面上说明是哪里变了 */
  beatIds: ID[]
  /**
   * 生成时逐片段的指纹。有过期时用它指出「哪一拍改了」。
   * 老记录没有这两项 —— 只能笼统提示，界面对应 unknown 分支。
   */
  beatHashes?: Record<ID, string>
  /** 生成时逐实体的指纹，指出「哪个主体改了」 */
  entityHashes?: Record<ID, string>
  /**
   * 生成时这一段的帧数（含副帧）。
   *
   * ★ 为什么不塞进 llmHash：帧数不是片段内容，改了副帧不该把内容判成"上游改过"
   *   —— 那会让人以为自己动了台词。但字段里确实写着「X 帧 = Y 秒」，
   *   帧数一变这段文字就旧了。所以单独记一份，只提示「秒数需复核」，
   *   不参与过期判定，也不升指纹口径（升了会把所有老记录一起标红）。
   *
   * 老记录没有这一项 —— 无从比对，按"没记录"处理，不报警。
   */
  frames?: number
  updatedAt: number
}

/**
 * 段尾接缝的冻结快照。
 *
 * 一段出了片，它的尾帧去向（黑屏 / 切镜 / 直接接）就已经被烤进画面里了。
 * 之后在它后面插新段，实时重算接缝会把尾巴改掉 —— 那等于把已出的片废掉。
 * 所以出片时把当时的判定记下来，插空时照这份快照复现，邻居的镜头序列逐字节不变。
 */
export interface FrozenSeam {
  /** none = 直接接下一段；black = 尾帧黑屏；cut = 尾帧切镜 */
  tail: 'none' | 'black' | 'cut'
  tailCutTargetId: ID | null
  /**
   * 出片时本段开头有没有 0.3s 预备镜头。
   *
   * 缺省（策略切换功能之前出片的老数据）按"当时是 legacy"推断 —— 那时候
   * 只有 legacy 一种行为，所以那个字段缺失就等于有。不记这一位的话，
   * 把项目从 legacy 切到 guide，所有老片的段首会凭空少 7 帧、整段作废。
   */
  preshoot?: boolean
  continuityToNext: boolean
  /** 出片时的入向连续性（来自上一段） */
  continuityFromPrev: boolean
}

/**
 * 段的出片台账。
 *
 * 只记"出片那一刻是什么内容"，不记产物在哪 —— 产物在导演节点的缓存里，
 * 按内容哈希寻址（位置由节点的槽位表管）。所以内容没变、只是位置挪了，
 * 缓存照样能命中；内容变了就是真失效。
 */
export interface SegmentLock {
  /** 渲染指纹（见 domain/insertion.ts 的 renderHashOf） */
  hash: string
  /** 出片时的段序号（0 基），用来提示"位置变了" */
  slot: number
  frames: number
  /** 出片时的素材化片段序列，用来算新增/删除了哪些镜头 */
  beatIds: ID[]
  at: number
  by: 'fields' | 'product' | 'manual'
  frozen: FrozenSeam
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
   * refPrev 是人工改过的（不是引擎推出来的）。
   *
   * 引擎按接缝推 refPrev 时会写这个字段之外的值，但老数据里 refPrev 是
   * 旧口径（"只要不是首段就引用"）自动赋的，没有这个标记就分不出
   * "用户明确要 17k" 还是"当年自动算的" —— 一律当自动，按接缝重算。
   */
  refPrevManual?: boolean
  /**
   * 本段与**下一段**的接缝判法。缺省 auto = 按结构化字段自动判。
   *
   * 显式指定优先于任何自动判定：自动判据只看场景 / 主体 / 镜头，
   * 判不出「同一间店、三天后」这种时间跳跃，那类要人在这里定死。
   */
  seamToNext?: SeamOverride
  /**
   * 额外副帧：beatId -> 帧数增减量，可以为负数（压缩）。
   * 独立于 Beat 自身的帧长度，只在段内生效，可手工调整。
   * 存在即为手工值；清空后恢复按占比自动分摊。
   * 预备镜头 / 尾帧切镜 / 黑屏同样参与分摊，但它们不写进这里（每次重建都重算）。
   */
  pad?: Record<ID, number>
  /** 插空新建的段（不是引擎自动组合出来的） */
  inserted?: boolean
  /** 出片台账；有它才谈得上"失效" */
  lock?: SegmentLock
  /** 接缝不再沿用台账快照，改为按当前邻居实时重算（会让本段失效） */
  seamLive?: boolean
  /** 人工判定失效：内容动过、但产物还是旧的 */
  voided?: { at: number; reason: string }
}

export interface Assembly {
  id: ID
  projectId: ID
  name: string
  strategy: StrategyConfig
  groups: Group[]
  /**
   * 待编排片段：被删掉的段 / 被抽出来的镜头放这里。
   * 留在 groups 之外，但**不算孤立片段**，自动归位不会又把它们塞回某个段里。
   */
  parked?: ID[]
  createdAt: number
  updatedAt: number
}

/* ------------------------------------------------------------------ *
 * 缝合：相邻两段接缝处的自动判定
 * ------------------------------------------------------------------ */

export type SeamLevel = 'info' | 'warn' | 'error'

/**
 * 接缝的三种类型。
 *
 *   transition —— 转场：换地方、换时间。**不引导下段**，靠本段首帧关键帧起画。
 *   cut        —— 镜切：同一个空间里换人 / 换机位 / 插入反应。**引用上段**。
 *   take       —— 顺接：同一主体连着演。**引用上段**，首帧让位给上段尾帧。
 *
 * 为什么不是"转场 / 非转场"二分：镜切和顺接对引导的依赖强度不一样 ——
 * 顺接时上段尾帧已经把脸、站位、光全给全了，再钉一张首帧就是两个源头抢开场；
 * 镜切换了人，模型需要一个目标主体的锚点，首帧反而要留着。
 */
export type SeamKind = 'transition' | 'cut' | 'take'

/**
 * 引用强度：0 不引导、1 弱（有锚点）、2 强（首帧让位）。
 * 直接由 SeamKind 映射，单独留一个类型是为了让界面能只按数字排序。
 */
export type GuideStrength = 0 | 1 | 2

/** 接缝的人工覆盖：auto = 听自动判定 */
export type SeamOverride = 'auto' | SeamKind

/**
 * 接缝策略：
 *   guide  —— 段间引导（默认）：不再往段内塞预备镜头 / 尾帧切镜
 *   legacy —— 旧行为：段首 0.3s 预备镜头 + 段尾 0.3s 尾帧切镜 / 黑屏
 *
 * 老项目的 settings 里没有这个字段，读出 undefined 时按 guide 走：
 * 已经出过片的段有 SegmentLock.frozen 快照兜着，不会因为换策略集体失效。
 */
export type SeamPolicy = 'guide' | 'legacy'

export interface SeamIssue {
  code: string
  level: SeamLevel
  message: string
}

export interface SeamAnalysis {
  leftGroupId: ID
  rightGroupId: ID
  /** 接缝类型（guide 策略下的唯一判据来源） */
  kind: SeamKind
  /** 引用强度，由 kind 映射：transition 0 / cut 1 / take 2 */
  strength: GuideStrength
  /** 判定理由，直接给界面显示（中文一句话） */
  reason: string
  /** 左段末帧主体 */
  lastSubjectId: ID | null
  /** 右段首帧主体 */
  firstSubjectId: ID | null
  /** 右段首个说话人（无台词则 null） */
  firstSpeakerId: ID | null
  /** 尾帧切镜的目标主体；guide 策略下恒为 null */
  tailCutTargetId: ID | null
  /** @deprecated guide 策略下恒 false，仅 legacy / 旧冻结快照会为 true */
  needsTailCut: boolean
  /** @deprecated guide 策略下恒 false */
  needsPreshoot: boolean
  /** @deprecated guide 策略下恒 false：不引导时右段本来就能自己开头，不需要黑屏兜底 */
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

/* ------------------------------------------------------------------ *
 * 字段的中英双份
 *
 * 同一个段、同一个字段名，存两份内容：zh 是工作稿，en 是终稿。
 * 两者靠 groupId + fieldKey 绑定，谁被改过就记在 at 上 ——
 * 另一份的 at 更早，说明它落后了，界面标红提示需要重新同步。
 *
 * ★ 为什么不是"覆盖写"：⑤ 本地化如果直接盖掉中文，④ 就再也回不到
 *   中文稿，改了中文也无法提示英文过期。
 * ------------------------------------------------------------------ */

export interface FieldSide {
  v: string
  /** 最后修改时间（ms）；0 表示是从旧数据迁移过来的、不知道确切时间 */
  at: number
  /**
   * 内容指纹。
   *
   * 只靠时间戳判断"谁变了"不可靠：程序写入、导入、迁移都会刷新时间，
   * 而内容可能一个字没动。存一份指纹，才能回答"这一侧相对上次对齐
   * 到底变没变"——同步页据此决定谁是变化点、谁该被对齐。
   *
   * 早期数据没有这一项，读取时按当前内容补算（见 domain/pairs.ts）。
   */
  h?: string
}

/**
 * 上次确认「中英一致」时的三方指纹。
 *
 * 三个都要存：只比中英两份，无法区分"英文改了"和"中文改了"；
 * 只比内容不看引用，上游片段/实体改名后两份都成了旧稿却毫无标记。
 */
export interface FieldBaseline {
  zh: string
  en: string
  /** 当时这一段引用的片段 + 实体指纹（见 domain/cascade.ts） */
  src: string
  at: number
}

export interface FieldPair {
  zh?: FieldSide
  en?: FieldSide
  /** 上次对齐的基线；没有它说明这份字段从来没被确认过一致 */
  synced?: FieldBaseline
}

/** `${groupId}` → `${fieldKey}` → 中英两份 */
export type FieldPairMap = Record<ID, Record<string, FieldPair>>

/** 一个字段两侧的同步状态 */
export type FieldSync =
  /** 两侧都没有内容 */
  | 'empty'
  /** 只有一侧有内容，另一侧还没生成 / 翻译 */
  | 'zh-only'
  | 'en-only'
  /** 两侧都有内容，且都跟上次同步一致 */
  | 'both'
  /** 中文比英文新：英文待重译（红） */
  | 'zh-newer'
  /** 英文比中文新：中文待跟进（红） */
  | 'en-newer'
  /** 引用变了：这一段引用的片段或实体改过，两份都成了旧稿（红） */
  | 'src-newer'
  /**
   * 两侧都被改过。
   *
   * 这种状态没有「变化点」，自动对齐任何一边都是在瞎猜 —— 只能摆出来让人定，
   * 或者让他先选一份为准再同步。
   */
  | 'conflict'

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
  /**
   * 素材（图 + 音）。
   *
   * 位置在②之后、③之前，但**不编号**：它不是一个"不做完就不能往下走"的闸门，
   * 而是素材的准备工作台 —— 想先去组合、回头再来补图也完全正常。
   * 编号一旦插进 ③~⑥，所有提示文案里的「③ 组合与缝合」都得跟着改，
   * 换来的只是一个好看的序号，不值。
   */
  | 'materials'
  | 'assemble'
  | 'complete'
  | 'localize'
  | 'deliver'
  /**
   * 产物页（段 ↔ 一采/二采缓存）。
   *
   * 它不是流水线的一环、也没有"完成后才能往下走"的语义，只是记住用户离开
   * 这一集时停在哪。放进来是为了刷新页面能回到同一个 tab —— 否则每次回到
   * 交付页都得再点一次。
   */
  | 'products'

export interface ProjectSettings {
  /**
   * 流水线工作语言。
   * zh = 阶段①~③ 全中文，阶段⑤ 由模型转成规范英文（推荐）
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
  /** 组合时是否自动插入预备镜头（guide 策略下不再插，恒无意义） */
  autoPreshoot: boolean
  /** 组合时是否自动插入段尾切镜（guide 策略下不再插，恒无意义） */
  autoTailCut: boolean
  /**
   * 段间接缝策略。
   * 缺省（老项目读不到这个字段）= guide：不往段内塞自动片段，改用段间引导 + 关键帧。
   * 想回到"段首预备镜头 + 段尾切镜"的旧行为，显式设成 legacy。
   */
  seamPolicy?: SeamPolicy
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
  /**
   * 导演包输出画布尺寸。
   * r2v 走 gen_blank 分支，后端强校验：≥32 且为 32 的倍数。
   */
  outputWidth: number
  outputHeight: number
  /** 各 kind 的默认帧数 */
  actionFrames: number
  reactionFrames: number
  insertFrames: number
  establishingFrames: number
  sceneSwitchFrames: number
  /**
   * 段级关键帧的默认摆放策略（可以随时按片段覆盖，不影响已摆好的图）：
   *   head_tail —— 首尾优先：一张就放段首，两张首尾，多出来的等分中间
   *   even      —— 均匀铺开：全部按帧位等分，不额外占用 startImage / endImage
   *   manual    —— 手动：新图放段首，位置自己调
   */
  keyframeLayout: KeyframeLayout
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
  seamPolicy: 'guide',
  preferBlackFallback: true,
  scenePriorityOnSeam: true,
  storyChunkChars: 1500,
  beatBatchSize: 12,
  glossaryBatchSize: 30,
  outputWidth: 864,
  outputHeight: 480,
  actionFrames: 36,
  reactionFrames: 18,
  insertFrames: 12,
  establishingFrames: 24,
  sceneSwitchFrames: 7,
  keyframeLayout: 'head_tail'
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

/**
 * 两级结构：
 *   series  —— 顶层「项目/系列」：容器，管理它下面的若干「集」+ 一批「大主体（全局主体）」
 *   episode —— 「集」：真正跑流程的工作台（故事→片段→组合→…→导演包），独立打包
 * 一个 series 由若干 episode 组成；全局主体存在 series 自己的实体表里，可注入到某集。
 */
export type ProjectKind = 'series' | 'episode'

export interface Project {
  id: ID
  name: string
  /** 层级：缺省按 episode 处理（历史数据兼容） */
  kind?: ProjectKind
  /** episode → 所属 series.id */
  seriesId?: ID
  /** series → 其下各集 id（有序，即集列表的顺序） */
  episodeIds?: ID[]
  /** 故事原文（阶段一输入，仅 episode 用） */
  story: string
  /**
   * 这一集选用的工作流模板（stores/workflow.ts）。
   * 缺省 = 用控制台里的当前模板；存 id 是为了让"这集当时用哪套参数"可追溯，
   * 模板改名/复制都不会悄悄改变已绑定的集。
   */
  workflowTemplateId?: ID
  stage: ProjectStage
  settings: ProjectSettings
  fieldSchema: FieldSchema[]
  createdAt: number
  updatedAt: number
}

export function isSeries(p: Pick<Project, 'kind'>): boolean {
  return p.kind === 'series'
}

export function isEpisode(p: Pick<Project, 'kind'>): boolean {
  return (p.kind ?? 'episode') === 'episode'
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
  /**
   * 图片生成 / 编辑用的模型名。
   * 留空则回退到 model（很多 OpenAI 兼容服务用同一个 model 出图）。
   * 例如 OpenAI 填 gpt-image-1 / dall-e-3，MiniMax 填其 image 模型名。
   */
  imageModel?: string
  /** CORS 兜底：形如 https://proxy.example/?url= */
  proxyPrefix?: string
  /** 仅本次会话使用 Key（不落库） */
  sessionOnly: boolean
  createdAt: number
}
