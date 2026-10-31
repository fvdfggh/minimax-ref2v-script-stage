/**
 * 段级参考素材：关键帧 / 音视频素材 / 主体绑定图。
 *
 * 段内素材只有**两个参数**，而且互不替代：
 *   起始帧（frameIdx）—— 从这一段的第几帧开始参与
 *   强度（strength）  —— 参与得有多硬，0~100
 *
 * 落到导演包里：
 *   关键帧（keyframe）· 强度 → kfImages，带 frameIdx + visualNoiseAug
 *   视频（material）  · 强度 → kfVideos，带 frameIdx + visualNoiseAug
 *   音频（material）  · 满强度 → kfAudios（固定音轨）
 *                       低于满值 → refAudios（参考音色，带起始帧标注）
 *   主体参考图（subject）→ <Picture N> / refs，按实体绑定跨段共用
 *
 * 纯函数，不碰 store；UI 与 pack.ts 共用同一套判定，避免"界面上算一类、
 * 打包时算另一类"。
 */
import type {
  Asset,
  AssetActAs,
  Beat,
  Entity,
  ID,
  KeyframeLayout,
  KeyframePlacement,
  KeyframeRole,
  MediaKind
} from './types'

const VIDEO_EXT = new Set([
  'mp4',
  'mov',
  'm4v',
  'webm',
  'mkv',
  'avi',
  'mpg',
  'mpeg',
  'wmv',
  // 摄像机直出：不认的话会掉进"按图片处理"，被塞成关键帧
  'mts',
  'ts'
])
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'])

export const KEYFRAME_ROLE_LABEL: Record<KeyframeRole, string> = {
  start: '首帧',
  anchor: '中间锚点',
  end: '尾帧'
}

/** 界面上的放置选项：说「段首 / 段尾 / 指定帧」，不说「锚点」 */
export const PLACEMENT_LABEL: Record<KeyframePlacement, string> = {
  head: '段首',
  tail: '段尾',
  at: '指定帧'
}

export const LAYOUT_LABEL: Record<KeyframeLayout, string> = {
  head_tail: '首尾优先',
  even: '均匀铺开',
  manual: '手动摆放'
}

export const LAYOUT_HINT: Record<KeyframeLayout, string> = {
  head_tail: '一张放段首，两张分首尾，多出来的等分中间；首尾兼作起始 / 收尾画面',
  even: '全部按帧位等分铺开，不占用起始 / 收尾画面（只进 kfImages）',
  manual: '新图默认放段首，位置自己调'
}

export const MEDIA_LABEL: Record<MediaKind, string> = {
  image: '图片',
  audio: '音频',
  video: '视频'
}

/**
 * 锚定强度：0~100 的连续量，配一个始终可设的起始帧。
 *
 * 这两件事是**正交**的，不要再做成"作用二选一"：
 *   起始帧 —— 这段素材从第几帧开始参与（图片是落点帧，音视频是起点）
 *   强度   —— 那一点上有多硬：100 = 钉死，越低越偏参考
 *
 * ComfyUI 侧对应 `visual_noise_aug`（per-keyframe，默认 0.999）：
 * 强度 100 → 0.999（不加噪），强度 s → 0.999·s/100。
 */
export const STRENGTH_MIN = 0
export const STRENGTH_MAX = 100
/** 满强度：走 latent 槽 pin 死，不混噪 */
export const STRENGTH_HARD = 100
/**
 * 「参考」档的落点。
 *
 * 不取 0：0 是"什么都不留"，画面完全交给模型，连构图都借不到；
 * 30 大约 visual_noise_aug 0.3，保留三成线索，是"像参考图那样"最常用的档位。
 * 界面上那颗「参考」按钮只是把强度拨到这里，之后还能用滑杆细调。
 */
export const STRENGTH_REF = 30

/**
 * 视频强度到多少算「钉住这一段画面」。
 *
 * 音频没有中间档：只有满强度才是固定音轨，低了只能走参考音色（音频不存在
 * 视觉混噪这条路）。视频从 80 起进 kfVideos，和 `strengthLabel` 的「强参考」
 * 分界对齐 —— 面板上说"强"，包里就真的钉住。
 */
export const STRENGTH_MEDIA_ANCHOR = 80

export type StrengthUsage = 'force' | 'ref'

/** 强度 → 作用档位：只有满强度才算「强制」，其余都算「参考」 */
export function usageOfStrength(strength: number): StrengthUsage {
  return clampStrength(strength) >= STRENGTH_HARD ? 'force' : 'ref'
}

/** 档位 → 一句话，给按钮和角标用 */
export const USAGE_LABEL: Record<StrengthUsage, string> = {
  force: '强制',
  ref: '参考'
}

export function clampStrength(raw: unknown): number {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return STRENGTH_HARD
  return Math.max(STRENGTH_MIN, Math.min(STRENGTH_MAX, n))
}

/**
 * 素材的锚定强度。老数据按本体折算，保证改造前后打包结果一致：
 *   usage = 'force' → 100；usage = 'ref' → 30
 *   两者都没有     → 图片 100、音频 / 视频 30
 *
 * 按 media 而不是 kind 兜底，理由同旧实现：历史数据里存在"只有 placement、
 * 没有 kind"的图片，用 kind 会把它们误判成参考。
 */
export function strengthOf(
  a: Pick<Asset, 'media' | 'strength' | 'usage' | 'kind'>
): number {
  if (typeof a.strength === 'number' && Number.isFinite(a.strength)) {
    return clampStrength(a.strength)
  }
  if (a.usage === 'force') return STRENGTH_HARD
  if (a.usage === 'ref') return 30
  return a.media === 'audio' || a.media === 'video' ? 30 : STRENGTH_HARD
}

/** 是不是硬锚点（满强度、钉在某一帧上） */
export function isAnchored(a: Pick<Asset, 'media' | 'strength' | 'usage' | 'kind'>): boolean {
  return strengthOf(a) >= STRENGTH_HARD
}

/** 强度换算成 ComfyUI 的 visual_noise_aug（0.999 基准，三位小数） */
export function visualNoiseAugOf(strength: number): number {
  const s = clampStrength(strength)
  return Math.round(0.999 * (s / STRENGTH_MAX) * 1000) / 1000
}

/** 强度 → 一句话描述，给界面上的滑杆与提示用 */
export function strengthLabel(strength: number): string {
  const s = clampStrength(strength)
  if (s >= STRENGTH_HARD) return '硬锚点'
  if (s >= 80) return '强参考'
  if (s >= 50) return '参考'
  if (s > 0) return '弱参考'
  return '纯参考'
}

export function strengthHint(strength: number): string {
  const s = clampStrength(strength)
  const aug = visualNoiseAugOf(s)
  if (s >= STRENGTH_HARD) {
    return '钉死在这一帧：visual_noise_aug 0.999，模型必须从它出发'
  }
  return (
    `落在起始帧上，但按强度混噪（visual_noise_aug ${aug.toFixed(3)}）：` +
    `数值越低，模型越会重画，只借它的构图 / 动作 / 音色`
  )
}

/** 取扩展名（小写、不带点）；没有就返回空串 */
export function extOf(fileName: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(fileName ?? '').trim())
  return m ? m[1].toLowerCase() : ''
}

/**
 * 判断素材本体类型。
 *
 * 先看 MIME（浏览器给的更准，特别是 wav / m4a 的 MIME 常被写错），
 * 再退回扩展名；都认不出来按图片处理 —— 这条链路历史上只处理过图片，
 * 把未知当图片至少不会把一张图误送进音频槽。
 */
export function mediaKindOf(fileName: string, mime?: string): MediaKind {
  const type = String(mime ?? '').toLowerCase()
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type.startsWith('image/')) return 'image'
  const ext = extOf(fileName)
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return 'image'
}

/**
 * 该素材是不是"段级"的（关键帧 / 音视频素材）。
 *
 * 段级素材没有全局 Picture 编号（asset.pictureN = 0），也**永远不占** Picture 槽：
 * 它靠起始帧 + 强度进 kf 通道，和主体参考图那套 &lt;Picture N&gt; 编号是两回事。
 * （旧版把"参考"图塞进本段 refs 抢号，已经去掉 —— 同一张图两套编号最难解释。）
 */
export function isSegmentAsset(asset: Asset): boolean {
  return asset.kind === 'keyframe' || asset.kind === 'material'
}

/**
 * 这个文件能不能进导演包。
 *
 * 上传口收得比导入口宽：浏览器能选到 .mts / .opus 这类，而导演台导入端
 * 只认白名单里的容器，别的会在导入时被静默丢掉 —— 与其让人传完才发现少了
 * 一段参考音，不如在选择时就挡回去。图片同理（gif/tif 都算图片）。
 */
export function mediaFileSupported(fileName: string, mime?: string): boolean {
  const kind = mediaKindOf(fileName, mime)
  const ext = extOf(fileName)
  // 没有扩展名（或扩展名被截断）时只能信 MIME：浏览器选的文件一般都有
  if (!ext) return ['image', 'audio', 'video'].includes(String(mime ?? '').toLowerCase().split('/')[0])
  if (kind === 'image') return IMAGE_EXT.has(ext)
  if (kind === 'video') return VIDEO_EXT.has(ext)
  return AUDIO_EXT.has(ext)
}

/* ------------------------------ 作用方式 ------------------------------ */

/**
 * 段内素材的两种作用方式。
 *
 * 这一维和「强度」不是一回事，别再合并：
 *   作用方式 决定它**走哪条通道**——关键帧通道（kfImages / kfAudios / kfVideos，
 *            占帧位、占时间轴）还是参考通道（refs 的 <Picture N> 槽、
 *            refAudios / refVideos）；
 *   强度     只在关键帧通道里有意义——同一帧 / 同一段上钉得多硬。
 *
 * 以前只有强度一个旋钮，用户想表达"这张只是给模型看看长相，别锁住这一帧"
 * 只能把强度调到 30，可它仍然落在那一帧、仍然可能被当成起始画面。现在
 * 这两件事分开了。音视频同理：一条"只借音色 / 动作"的参考，不该占住这段的
 * 音轨或画面，也不该因为强度调高了就悄悄变成这一段的内容。
 */
export const ACT_AS_LABEL: Record<AssetActAs, string> = {
  keyframe: '关键帧',
  reference: '参考图'
}

export const ACT_AS_HINT: Record<AssetActAs, string> = {
  keyframe: '落在段内某一帧上，能当段首 / 段尾画面，强度决定钉得多硬',
  reference: '不占帧位，占一个 <Picture N> 槽跟着本段进参考图通道'
}

/** 这张图 / 这段声音按什么方式起作用。缺省 keyframe —— 老数据里的段内素材一直是内容 */
export function actAsOf(a: Pick<Asset, 'actAs' | 'kind'>): AssetActAs {
  return a.actAs === 'reference' ? 'reference' : 'keyframe'
}

/** 当参考图用的段内图片（不进帧轨道、不抢首尾） */
export function isRefImage(a: Pick<Asset, 'actAs' | 'kind'>): boolean {
  return actAsOf(a) === 'reference'
}

/** 当关键帧用的图片（含老数据） */
export function isKfImage(a: Pick<Asset, 'actAs' | 'kind'>): boolean {
  return actAsOf(a) === 'keyframe'
}

/**
 * 只借给模型看 / 听的**音视频**：不占这段的时间轴，只进 refAudios / refVideos。
 *
 * 和参考图是同一个意思 —— "这是参考，不是这一段的内容"。区别只是它借的是
 * 音色 / 动作，而不是长相，所以在打包里走的是另一组槽位。
 */
export function isRefMaterial(a: Pick<Asset, 'actAs' | 'kind'>): boolean {
  return a.kind === 'material' && actAsOf(a) === 'reference'
}

/**
 * 素材落在这一段的时间轴上吗？
 *
 *   图片：作用方式 = keyframe（参考图不落帧）
 *   音视频：作用方式 = keyframe（参考素材只走参考通道）
 *
 * 界面用它把素材带分成「关键帧 / 参考素材」两块，判据必须和打包一致，
 * 否则出现"卡片上在关键帧块里、包里走的是参考槽"这种对不上的情况。
 */
export function onTimelineOf(a: Pick<Asset, 'actAs' | 'kind'>): boolean {
  return actAsOf(a) === 'keyframe'
}

/* ------------------------------ 放置 ------------------------------ */

/** placement → 导演台身份（head 兼作 startImage，tail 兼作 endImage） */
export function roleOfPlacement(p: KeyframePlacement): KeyframeRole {
  if (p === 'head') return 'start'
  if (p === 'tail') return 'end'
  return 'anchor'
}

/** 老数据只有 role，没有 placement —— 在这里统一折回去 */
export function placementOfRole(role?: KeyframeRole | null): KeyframePlacement {
  if (role === 'start') return 'head'
  if (role === 'end') return 'tail'
  return 'at'
}

/** 这张关键帧摆在哪：优先看 placement，缺省由 role 推 */
export function placementOf(a: Pick<Asset, 'placement' | 'role'>): KeyframePlacement {
  return a.placement ?? placementOfRole(a.role)
}

/**
 * 落在段内第几帧。
 *   head → 0（段首）
 *   tail → 最后一帧（跟着段长走，改帧数不用重新摆）
 *   at   → 用户指定的帧位，越界夹到段内
 */
export function frameOf(
  a: Pick<Asset, 'placement' | 'role' | 'frameIdx'>,
  frames = 0
): number {
  const p = placementOf(a)
  if (p === 'head') return 0
  if (p === 'tail') return frames > 0 ? Math.max(0, frames - 1) : 0
  return clampFrame(a.frameIdx, frames)
}

/** 列表里显示的位置文案：段首 / 尾帧 · 第 N 帧 / 第 N 帧 */
export function frameLabel(
  a: Pick<Asset, 'placement' | 'role' | 'frameIdx'>,
  frames = 0
): string {
  const p = placementOf(a)
  if (p === 'head') return '段首'
  if (p === 'tail') return '段尾'
  return `第 ${frameOf(a, frames)} 帧`
}

function roleOrder(role: KeyframeRole | undefined): number {
  if (role === 'start') return 0
  if (role === 'anchor') return 1
  return 2
}

/* --------------------- 音视频素材的作用起始帧 --------------------- */

/**
 * 音视频素材从本段第几帧开始生效。
 *
 * 与关键帧的"指定帧"共用 `frameIdx`，但语义是**区间起点**而不是一张画面的
 * 落点：一张图只说"这一帧长这样"，一段音频 / 视频说的是"从这一帧起我上场"。
 * 越界一律夹到段内（0..frames-1），与关键帧同一个夹取规则。
 */
export function materialFrameOf(
  a: Pick<Asset, 'frameIdx'>,
  frames = 0
): number {
  return clampFrame(a.frameIdx, frames)
}

/** 界面上给音视频显示的起始帧文案：段首 / 第 N 帧起 */
export function startFrameLabel(
  a: Pick<Asset, 'frameIdx'>,
  frames = 0
): string {
  const f = materialFrameOf(a, frames)
  return f === 0 ? '段首起' : `第 ${f} 帧起`
}

/**
 * 本段"带帧位"的全部素材：关键帧（图片）+ 音视频素材，按生效帧升序排。
 *
 * 界面要把它们放同一条轨道上（图片是"这一帧长这样"，音视频是"从这一帧起
 * 生效"），所以这里统一按帧排；同帧时图片在前 —— 图是画面锚点，先看到它更
 * 符合"这一段从哪开始"的直觉。
 *
 * 作用方式 = reference 的图**不在轨道上**：它没有帧位，上轨道只会让人以为
 * 它锁了某帧。它们单独走 `refImagesOf`。
 */
export function beatTrackOf(assets: Asset[], beatId: ID, frames = 0): Asset[] {
  const all = [
    ...assets.filter((a) => a.kind === 'keyframe' && a.refId === beatId && isKfImage(a) && !a.draft),
    ...assets.filter((a) => a.kind === 'material' && a.refId === beatId && !a.draft)
  ]
  return all.sort((a, b) => {
    const fa = frameOf(a, frames)
    const fb = frameOf(b, frames)
    if (fa !== fb) return fa - fb
    const ka = a.kind === 'keyframe' ? 0 : 1
    const kb = b.kind === 'keyframe' ? 0 : 1
    return ka - kb || a.createdAt - b.createdAt
  })
}

/** 一个片段自己的关键帧，按 段首 → 指定帧（帧位升序）→ 段尾 排好 */
export function keyframesOf(assets: Asset[], beatId: ID): Asset[] {
  return assets
    .filter((a) => a.kind === 'keyframe' && a.refId === beatId && isKfImage(a) && !a.draft)
    .sort((a, b) => {
      const pa = placementOf(a)
      const pb = placementOf(b)
      const ra = roleOrder(roleOfPlacement(pa))
      const rb = roleOrder(roleOfPlacement(pb))
      return (
        ra - rb ||
        (pa === 'at' ? Number(a.frameIdx ?? 0) || 0 : 0) -
          (pb === 'at' ? Number(b.frameIdx ?? 0) || 0 : 0) ||
        a.createdAt - b.createdAt
      )
    })
}

/**
 * 一个片段里**按参考图方式起作用**的素材：不占帧位，靠 pictureN 进本段 refs。
 *
 * 它们和主体参考图属于同一个通道（都是 <Picture N>），区别只是归属：主体图
 * 跟着实体跨段共用，这些只属于这一段。打包时会合并进同一份 refs，按编号排。
 */
export function refImagesOf(assets: Asset[], beatId: ID): Asset[] {
  return assets
    .filter((a) => a.kind === 'keyframe' && a.refId === beatId && isRefImage(a) && !a.draft)
    .sort((a, b) => a.pictureN - b.pictureN || a.createdAt - b.createdAt)
}

/**
 * 一个片段里**只当参考**的音视频：不占这段的时间轴，只进 refAudios / refVideos。
 *
 * 和参考图是同一件事的另一半 —— 一张图借长相，一段声音借音色 / 动作。
 * 它们照样带一个起始帧（参考也要知道从第几帧开始比对），但那条帧位只影响
 * 参考通道里的起点，不占音轨、不抢画面。
 */
export function refMaterialsOf(assets: Asset[], beatId: ID): Asset[] {
  return materialsOf(assets, beatId).filter(isRefMaterial)
}

/** 其中满强度的那些（`applyKeyframeLayout` 只重排它们，避免动用户调软过的图） */
export function forcedKeyframesOf(assets: Asset[], beatId: ID): Asset[] {
  return keyframesOf(assets, beatId).filter(isAnchored)
}

/**
 * 这一段还没出图的草稿（新增素材时先建的那条空提示词）。
 *
 * 草稿是"一条待填的活"：它不进 keyframesOf（否则打包会拿一张没有本体的图
 * 去当锚点），但在素材列表里必须显示出来，否则用户写完提示词一刷新就找不到它。
 */
export function draftsOf(assets: Asset[], beatId: ID): Asset[] {
  return assets
    .filter((a) => a.kind === 'keyframe' && a.refId === beatId && a.draft === true)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * 这一段的**全部待合成槽位**（图片 / 音频都算）。
 *
 * 和 draftsOf 的区别：那个只认图片草稿（"还有几条提示词没出图"），
 * 这个认所有媒体 —— 卡片素材带里一格待出图、一格待配音，都是同一种东西：
 * 配置已经写完、本体还没合成。它们同样不进打包（materialsOf / keyframesOf
 * 都滤掉 draft），只用来在界面上占一格、点开继续改配置。
 */
export function slotDraftsOf(assets: Asset[], beatId: ID): Asset[] {
  return assets
    .filter((a) => a.refId === beatId && a.draft === true)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * 一个片段自己的音视频素材：先按**作用起始帧**升序（第 0 帧上场的排前面，
 * 打包时也就是 Audio1 / Video1），同帧再先音频后视频、按上传顺序。
 *
 * 按起始帧排而不是按上传顺序排，是因为界面上它们已经和关键帧排在同一条
 * 轨道上（见 beatTrackOf），序号和轨道顺序不一致会让人对不上号。
 */
export function materialsOf(assets: Asset[], beatId: ID): Asset[] {
  return assets
    .filter((a) => a.kind === 'material' && a.refId === beatId && !a.draft)
    .sort((a, b) => {
      const rank = (x: Asset) => (x.media === 'audio' ? 0 : x.media === 'video' ? 1 : 2)
      const fa = Math.max(0, Math.round(Number(a.frameIdx) || 0))
      const fb = Math.max(0, Math.round(Number(b.frameIdx) || 0))
      return fa - fb || rank(a) - rank(b) || a.createdAt - b.createdAt
    })
}

/**
 * 关键帧在段内的落位。
 *
 * 段首 / 段尾各只取一张（同位置多张时取第一张，其余的在界面上仍可见、可删，
 * 打包时降级成同帧锚点）；指定帧一律按 frameIdx 落位，超出段长时夹到段内，
 * 因为导演台对越界锚点是"丢弃 + 警告"，在这里夹住至少不会悄悄少一个锚点。
 */
export function keyframePlan(
  list: Asset[],
  frames = 0
): { start: Asset | null; end: Asset | null; anchors: Array<{ asset: Asset; frameIdx: number }> } {
  let start: Asset | null = null
  let end: Asset | null = null
  const anchors: Array<{ asset: Asset; frameIdx: number }> = []

  for (const a of list) {
    // 强度只影响混噪，不改变它"落在一帧上"的事实 —— 首尾帧判定照常参与。
    const p = placementOf(a)
    if (p === 'head') {
      if (!start) start = a
      else anchors.push({ asset: a, frameIdx: clampFrame(a.frameIdx, frames) })
      continue
    }
    if (p === 'tail') {
      if (!end) end = a
      else anchors.push({ asset: a, frameIdx: clampFrame(a.frameIdx, frames) })
      continue
    }
    anchors.push({ asset: a, frameIdx: clampFrame(a.frameIdx, frames) })
  }

  // 不把指定帧提升成首帧：落在第几帧本身就是信息。
  // 没有首帧就是没有 genImage（r2v 不依赖它），比偷偷挪到第 0 帧诚实。
  return { start, end, anchors }
}

function lastFrame(frames: number): number {
  return frames > 0 ? Math.max(0, frames - 1) : 0
}

/** 在 0..last 上按序号等分取一帧（n = 1 时落在段首） */
function evenFrame(i: number, n: number, frames: number): number {
  const last = lastFrame(frames)
  if (n <= 1) return 0
  return Math.min(last, Math.round((last * i) / (n - 1)))
}

/** 只关心"摆在哪"的最小形状，UI 里的临时数组 / Asset 都能塞进来 */
export type KeyframeLike = Pick<Asset, 'placement' | 'role' | 'frameIdx'>

/**
 * 按策略重排一组关键帧，返回**建议值**（纯函数，不落库）。
 *
 *   head_tail —— 一张段首；两张首尾；三张以上首尾 + 中间等分
 *   even      —— 全部按帧位等分（段首那张不算首帧身份，只进 kfImages）
 *   manual    —— 原样返回，什么都不动
 *
 * 只在用户点「按策略摆放」时才会套用；上传新图只决定新图自己放哪
 * （见 suggestPlacement），不会把已经摆好的图挪走。
 */
export function layoutKeyframes<T extends KeyframeLike & { id: ID }>(
  list: T[],
  frames: number,
  layout: KeyframeLayout
): Array<{ id: ID; placement: KeyframePlacement; frameIdx?: number }> {
  if (!list.length) return []
  if (layout === 'manual') {
    return list.map((a) => ({
      id: a.id,
      placement: placementOf(a),
      frameIdx: placementOf(a) === 'at' ? clampFrame(a.frameIdx, frames) : undefined
    }))
  }

  const n = list.length
  if (layout === 'even') {
    return list.map((a, i) => ({
      id: a.id,
      placement: 'at' as KeyframePlacement,
      frameIdx: evenFrame(i, n, frames)
    }))
  }

  return list.map((a, i) => {
    if (i === 0) return { id: a.id, placement: 'head' as KeyframePlacement }
    if (i === n - 1) return { id: a.id, placement: 'tail' as KeyframePlacement }
    return {
      id: a.id,
      placement: 'at' as KeyframePlacement,
      frameIdx: evenFrame(i, n, frames)
    }
  })
}

/**
 * 新加一张关键帧时默认放哪。
 *
 * 不重新排别人，只给新图找一个尽量不打架的位置：
 *   head_tail —— 没段首就段首，没段尾就段尾，都占满了就放到最空的一段中间
 *   even      —— 直接按现有数量取下一个等分格
 *   manual    —— 没段首就段首，否则放段中间
 */
export function suggestPlacement(
  list: KeyframeLike[],
  frames: number,
  layout: KeyframeLayout
): { placement: KeyframePlacement; frameIdx?: number } {
  const has = (p: KeyframePlacement) => list.some((a) => placementOf(a) === p)
  const last = lastFrame(frames)

  if (layout === 'even') {
    return { placement: 'at', frameIdx: evenFrame(list.length, list.length + 1, frames) }
  }

  if (!has('head')) return { placement: 'head' }
  if (layout === 'head_tail' && !has('tail')) return { placement: 'tail' }

  // 找一个离已有帧位最远的空格，避免新图叠在旧图身上
  const used = new Set(list.map((a) => frameOf(a, frames)))
  let best = Math.round(last / 2)
  let bestGap = -1
  for (let f = 0; f <= last; f += 1) {
    if (used.has(f)) continue
    let gap = last
    for (const u of used) gap = Math.min(gap, Math.abs(u - f))
    if (gap > bestGap) {
      bestGap = gap
      best = f
    }
  }
  return { placement: 'at', frameIdx: best }
}

/**
 * 把 n 张图均匀铺在**段内但不贴边**的位置。
 *
 *   n = 1 → 中点；n = 2 → 1/3、2/3；n = 3 → 25%、50%、75%
 *
 * 与 `layoutKeyframes('even')` 的差别：那个铺满 0..last（第一张就是段首），
 * 这个刻意避开两端 —— 批量出图要的是"这一拍某个时刻长这样"，不是抢首尾帧。
 */
export function innerFramesOf(frames: number, n: number): number[] {
  const last = lastFrame(frames)
  if (n <= 0) return []
  const out: number[] = []
  for (let i = 0; i < n; i += 1) {
    out.push(Math.min(last, Math.round((last * (i + 1)) / (n + 1))))
  }
  return out
}

/**
 * 给"任意位置帧"挑一个默认落点：优先段中点；中点被占了，就贴着中点往两边
 * 找最近的空格（不跳到段首段尾去 —— 那两个位置在导演台里是另一种身份）。
 *
 * 和 suggestPlacement 的分工：那个是"新图入列时往 head/tail 上贴"，
 * 这个只给一个**段内帧号**，不赋予任何首尾身份 —— 批量出图每一张都是锚点。
 */
export function autoFrameOf(list: KeyframeLike[], frames: number): number {
  const last = lastFrame(frames)
  const mid = Math.round(last / 2)
  const used = new Set(list.map((a) => frameOf(a, frames)))
  if (!used.has(mid)) return mid
  for (let d = 1; d <= last; d += 1) {
    if (mid - d >= 0 && !used.has(mid - d)) return mid - d
    if (mid + d <= last && !used.has(mid + d)) return mid + d
  }
  return mid
}

/** 与别人撞在同一帧的关键帧 id（打包时同帧只有一张生效，界面上要提示） */
export function frameConflicts(list: Asset[], frames: number): Set<ID> {
  const seen = new Map<number, ID[]>()
  for (const a of list) {
    const f = frameOf(a, frames)
    const arr = seen.get(f)
    if (arr) arr.push(a.id)
    else seen.set(f, [a.id])
  }
  const out = new Set<ID>()
  for (const ids of seen.values()) {
    if (ids.length > 1) for (const id of ids) out.add(id)
  }
  return out
}

/** 帧位夹取：没有段长信息时原样返回，交给上层显示 */
export function clampFrame(frameIdx: number | undefined, frames: number): number {
  const n = Math.max(0, Math.round(Number(frameIdx) || 0))
  if (!frames || frames <= 0) return n
  return Math.min(n, Math.max(0, frames - 1))
}

/**
 * 主体参考图：从片段绑定的实体（含场景实体）反查 <Picture N>。
 *
 * 这里是"参考图跟着主体走"的落点 —— 段里绑了主体，图就自动在这儿出现，
 * 不需要（也不应该）在段里另传一张。同一张图被多个实体引用时只列一次。
 */
export function subjectPicturesOf(
  beat: Pick<Beat, 'entities' | 'sceneId'>,
  entityById: Map<ID, Entity>,
  assets: Asset[]
): Array<{ entity: Entity; asset: Asset; pictureN: number }> {
  const ids: ID[] = []
  if (beat.sceneId) ids.push(beat.sceneId)
  for (const id of beat.entities ?? []) if (!ids.includes(id)) ids.push(id)

  const byPicture = new Map<number, Asset>()
  for (const a of assets) {
    if (a.pictureN > 0 && !byPicture.has(a.pictureN)) byPicture.set(a.pictureN, a)
  }

  const out: Array<{ entity: Entity; asset: Asset; pictureN: number }> = []
  const seen = new Set<number>()
  for (const id of ids) {
    const entity = entityById.get(id)
    if (!entity || entity.pictureN == null || entity.pictureN <= 0) continue
    if (seen.has(entity.pictureN)) continue
    const asset = byPicture.get(entity.pictureN)
    if (!asset) continue
    seen.add(entity.pictureN)
    out.push({ entity, asset, pictureN: entity.pictureN })
  }
  return out.sort((a, b) => a.pictureN - b.pictureN)
}

/**
 * 本段绑定了、但**还没有参考图**的主体（含场景实体）。
 *
 * 用途是提示"这段用了某某，但他还没有图" —— 这种情况打包不会报错，
 * 只是这一段里他会退化成纯文字描述，等到看片子才发现就太晚了。
 * 返回的是实体本身（不是缺口数量），因为界面要能就地给他补图。
 */
export function subjectPictureGaps(
  beat: Pick<Beat, 'entities' | 'sceneId'>,
  entityById: Map<ID, Entity>,
  assets: Asset[]
): Entity[] {
  const ids: ID[] = []
  if (beat.sceneId) ids.push(beat.sceneId)
  for (const id of beat.entities ?? []) if (!ids.includes(id)) ids.push(id)

  const covered = new Set(subjectPicturesOf(beat, entityById, assets).map((s) => s.entity.id))
  const out: Entity[] = []
  for (const id of ids) {
    const e = entityById.get(id)
    if (!e || covered.has(e.id)) continue
    out.push(e)
  }
  return out
}

export interface BeatRefSummary {
  keyframes: number
  /** 按参考图方式起作用的段内素材张数 */
  references: number
  materials: number
  audio: number
  video: number
  subjects: number
  /** 任意一类有内容 */
  any: boolean
  /** 界面上的一行摘要，例如 "关键帧 2 · 参考图 1 · 音频 1 · 主体 P1/P3" */
  text: string
}

export function beatRefSummary(
  beat: Pick<Beat, 'id' | 'entities' | 'sceneId'>,
  entityById: Map<ID, Entity>,
  assets: Asset[]
): BeatRefSummary {
  const keyframes = keyframesOf(assets, beat.id).length
  const references = refImagesOf(assets, beat.id).length
  const materials = materialsOf(assets, (beat as Beat).id)
  const audio = materials.filter((m) => m.media === 'audio').length
  const video = materials.filter((m) => m.media === 'video').length
  const subjects = subjectPicturesOf(beat, entityById, assets)

  const bits: string[] = []
  if (keyframes) bits.push(`关键帧 ${keyframes}`)
  if (references) bits.push(`参考图 ${references}`)
  if (audio) bits.push(`音频 ${audio}`)
  if (video) bits.push(`视频 ${video}`)
  if (subjects.length) bits.push(`主体 ${subjects.map((s) => `P${s.pictureN}`).join('/')}`)

  return {
    keyframes,
    references,
    materials: materials.length,
    audio,
    video,
    subjects: subjects.length,
    any: keyframes + references + materials.length + subjects.length > 0,
    text: bits.join(' · ')
  }
}

/**
 * 把「哪张图是谁」写进提示词。
 *
 * Qwen-Image-2.1 这类编辑模型不是"看着图随便画"：参考图在序列里就是
 * <image1> / <image2> 这些占位符，提示词里点了名，模型才知道哪个是主角、
 * 哪个只是背景里的人。不点名时它经常把两个人的衣服串在一起。
 *
 * 顺序必须和传给工作流的 images.image_N 一致 —— 两边都按同一个候选顺序取。
 */
export function refClause(refs: { label: string; kind?: 'subject' | 'scene' | 'plate' }[]): string {
  if (!refs.length) return ''
  // 用「<image1> is 林岚」这种指代句，而不是「<image1> = 林岚」：
  // Qwen 系的编辑示例都是「<image1> 中的人物……」的写法，指代句它才当图看。
  const map = refs
    .map((r, i) => {
      const n = i + 1
      if (r.kind === 'plate') {
        // 总图是"这场戏的唯一真相"：地点、道具、光、人的位置全在里面，
        // 只允许动机位。写成"参考氛围"会让它重新设计一间店。
        return `<image${n}> is the scene blocking plate of this scene — keep its location, props, lighting and every person in it exactly as they are, only change the camera`
      }
      if (r.kind === 'scene') {
        return `<image${n}> is this shot's setting — borrow only its light and atmosphere, do not copy its composition`
      }
      return `<image${n}> is ${r.label}`
    })
    .join('; ')
  const head = `Reference images: ${map}.`
  // 只有场景图 / 只有总图时，"别互换身份"就是废话，反而干扰模型：
  // 总图里所有人本来就是同一张图上的，没有"哪张是谁"可换。
  const hasSubject = refs.some((r) => r.kind !== 'scene' && r.kind !== 'plate')
  if (!hasSubject) return head
  return `${head} Keep each person's face, hair and outfit exactly as in their own reference image; do not swap their identities.`
}
