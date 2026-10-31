import { jsonEntry, zipToBlob, type ZipEntry } from '@/core/zip'
import {
  STRENGTH_HARD,
  STRENGTH_MEDIA_ANCHOR,
  clampStrength,
  extOf,
  visualNoiseAugOf
} from './references'
import type { Asset, AssetActAs, Entity, ID, KeyframeRole, ProjectSettings } from './types'

/* ------------------------------------------------------------------ *
 * 导演包导出 —— 把交付段打成 MiniMax H3 Director 能导入的 pack zip
 *
 * 对面是 director/pack_import.py，那边的规则都是硬校验，不是建议：
 *
 *   1. 必须是 zip，且必须有 pack.json（format / formatVersion）
 *   2. 所有包内路径必须 ASCII：^[A-Za-z0-9_./]+$（不含 -）
 *   3. timeline.json 存在就原样采用，不再从目录扫描重建
 *      所以 timeline 必须自己写全，asset_groups/NN/group.json 只是给原版插件兜底
 *   4. 参考图必须真的打进 zip。找不到文件的 ref 会被 _collect_missing_media
 *      静默清空 —— 不报错，只是那段退化成 t2v
 *
 * 另外两个容易踩的：
 *
 *   · editMode 必须是 "segment"，否则后端拿 global.prompt 当唯一提示词跑
 *   · refs 必须写在每个 segment 上，global.refs 只在 commonEnabled 时合并
 *
 * 帧长度：H3 只有 17k+5 一条网格（frame_align.minimax_align_frame_count），
 * 剧本台的「引用上段 17k」家族对面表示不了，导出时向上对齐并给出警告。
 * ------------------------------------------------------------------ */

export const PACK_FORMAT = 'minimax-h3-director-pack'
export const PACK_VERSION = 1
/** 任务类型必须是这个完整标签，导入端按 " — " 切出 key */
export const R2V_TASK_TYPE = 'r2v — 参考主体生视频(Reference to Video)'

/** 官方 ReferenceToVideo 只有 9 个参考图槽位 */
export const MAX_REFERENCE_IMAGES = 9
/** 画布必须是 32 的倍数（r2v 走 gen_blank，后端强校验） */
export const CANVAS_MULTIPLE = 32
export const DEFAULT_OUTPUT_WIDTH = 864
export const DEFAULT_OUTPUT_HEIGHT = 480

export const FRAME_STEP = 17
export const FRAME_OFFSET = 5
/** 导演端换算帧数时硬编码 24fps，与项目 fps 无关 */
export const PACK_FPS = 24

const PICTURE_TAG_RE = /<Picture\s*(\d+)\s*>/g
const NAME_SAFE_RE = /[^A-Za-z0-9_-]+/g

/* --------------------------- 帧长度 --------------------------- */

/** 向上对齐到 H3 唯一的网格 17k+5（最小 5） */
export function alignMiniMaxFrameCount(frames: number): number {
  let n = Math.max(FRAME_OFFSET, Math.round(Number(frames) || FRAME_OFFSET))
  while (n % FRAME_STEP !== FRAME_OFFSET) n += 1
  return n
}

/** 对面 minimax_gen_timeline.durationToMiniMaxFrames 的等价实现 */
export function durationToMiniMaxFrames(seconds: number, fps = PACK_FPS): number {
  const a = Math.max(0.1, Number(seconds) || 0.1)
  const n = Math.max(FRAME_OFFSET, Math.round(a * fps))
  const rem = (((FRAME_OFFSET - (n % FRAME_STEP)) % FRAME_STEP) + FRAME_STEP) % FRAME_STEP
  return n + rem
}

function roundDurationSec(seconds: number): number {
  return Math.round(seconds * 10) / 10
}

/**
 * 反解 durationSec。
 *
 * 导入瞬间前端 ensureImageBatchTimeline 会用硬编码 24fps 从 durationSec
 * 重算 frameCount 并覆盖我们写的值，所以 durationSec 不是给后端看的，
 * 是给对面 UI 看的 —— 必须取那个「能被算回原帧数」的秒数。
 * 例：141 帧 → 5.6（写 5.875 会被算成 158）。
 */
export function preferredDurationSecFromFrames(frames: number, fps = PACK_FPS): number {
  const f = Math.max(FRAME_OFFSET, Math.round(Number(frames) || FRAME_OFFSET))
  const rough = f / Math.max(fps, 0.001)
  const intLo = Math.max(1, Math.floor(rough) - 1)
  const intHi = Math.ceil(rough) + 1
  for (let s = intLo; s <= intHi; s++) {
    if (durationToMiniMaxFrames(s, fps) === f) return s
  }
  const dLo = Math.max(1, Math.floor(rough * 10) - 2)
  const dHi = Math.ceil(rough * 10) + 2
  for (let t = dLo; t <= dHi; t++) {
    const s = roundDurationSec(t / 10)
    if (durationToMiniMaxFrames(s, fps) === f) return s
  }
  return roundDurationSec(rough)
}

/** 画布尺寸必须 ≥32 且为 32 的倍数 */
export function snapCanvas(value: number, fallback: number): number {
  const n = Math.round(Number(value) || fallback)
  return Math.max(CANVAS_MULTIPLE, Math.round(n / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
}

/* --------------------------- 输入 --------------------------- */

export interface PackSegmentInput {
  id: ID
  /** 段总帧数（含副帧） */
  frames: number
  /** 六段式全文，即 composeSegmentText 的结果 */
  prompt: string
  refPrev: boolean
  continuityFromPrev: boolean
  continuityToNext: boolean
  /** 本段出场实体，用于挑参考图；为空则只认提示词里的 <Picture N> */
  entities?: Entity[]
  /**
   * 本段关键帧（段级，不占 <Picture N>）。
   * 首帧 → genImage / startImage，尾帧 → endImage，其余 → kfImages 锚点。
   */
  keyframes?: PackKeyframeInput[]
  /** 本段音视频素材（段级）→ refAudios / refVideos */
  materials?: PackMaterialInput[]
  /**
   * 本段**按参考图方式**起作用的素材（段级，作用方式 = reference）。
   *
   * 它们不落帧位、不抢首尾，占一个 <Picture N> 槽跟着这一段进 refs ——
   * 与提示词里写着的 <Picture N> 是同一个池子，只是归属这张图只属于这一段。
   */
  refImages?: PackRefImageInput[]
}

export interface PackRefImageInput {
  /** 全局编号：refs 里的 index = pictureN - 1 */
  pictureN: number
  /** 包内文件名；缺省从 assets 的映射里取，再缺省按 PictureN 生成 */
  fileName?: string
  originalName?: string
  blob?: Blob
}

export interface PackKeyframeInput {
  /** 只用来取扩展名；包内一律重命名成 start/end/kfN */
  originalName?: string
  blob?: Blob
  role: KeyframeRole
  /** 段内帧位：这张图落在第几帧 */
  frameIdx?: number
  /**
   * 锚定强度 0~100，缺省 100。
   * 100 → visual_noise_aug 0.999（钉死）；越低混噪越重，越偏参考。
   */
  strength?: number
}

export interface PackMaterialInput {
  originalName?: string
  blob?: Blob
  media: 'audio' | 'video'
  /**
   * 起始帧（**段内绝对帧位**）：这段音频 / 视频从本段第几帧开始生效。
   * 可以落在段内任意一帧；缺省按 0 处理（从段首起）。
   */
  frameIdx?: number
  /**
   * 锚定强度 0~100，缺省见 `references.strengthOf`。
   * 视频：进 kfVideos 并按强度混噪；音频：满强度钉音轨，低于满值进 refAudios。
   */
  strength?: number
  /**
   * 作用方式：reference = 只当参考（只进 refAudios / refVideos，不占时间轴）。
   * 缺省 / keyframe = 这一段自己的内容。
   */
  actAs?: AssetActAs
}

export interface PackBuildInput {
  projectName?: string
  settings: ProjectSettings
  segments: PackSegmentInput[]
  /** 全部素材（含 blob），按 pictureN 与实体绑定 */
  assets: Asset[]
  width?: number
  height?: number
  /**
   * 是否焊接接缝（把「本段尾帧要不要接下一段首帧」写进包里）。
   *
   * 缺省 false，和 ComfyUI 导演节点一致（那边叫「对齐下段」，默认就是关）。
   * 焊接要求下一段已有首帧视频缓存（frames_ht），新时间线首跑不存在那个缓存，
   * 导演节点会在 Phase 1 之前直接中止（"有片段没有可钉的下一段首帧缓存"）。
   * 只有重抽某段、要把它接到已出片的下一段上时，调用方才显式传 true。
   */
  weldSeams?: boolean
}

export interface PackBuildResult {
  filename: string
  packJson: Record<string, unknown>
  timeline: Record<string, unknown>
  entries: ZipEntry[]
  warnings: string[]
}

/* --------------------------- 素材 --------------------------- */

/** 提示词里出现的 <Picture N> 是权威来源，实体绑定只作补充 */
export function extractPictureNumbers(text: string): number[] {
  const set = new Set<number>()
  for (const m of text.matchAll(PICTURE_TAG_RE)) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > 0) set.add(n)
  }
  return [...set].sort((a, b) => a - b)
}

function usedPictures(seg: PackSegmentInput): number[] {
  const set = new Set(extractPictureNumbers(seg.prompt))
  for (const e of seg.entities ?? []) {
    if (e.pictureN != null && e.pictureN > 0) set.add(e.pictureN)
  }
  return [...set].sort((a, b) => a - b)
}

/**
 * 包内文件名：已经是 `PictureN.ext` 且**编号对得上**就沿用，否则按 pictureN 重造。
 *
 * 为什么必须核对编号：素材编号压缩重排后，行里的 pictureN 变了，但磁盘上
 * 的文件名不一定跟着改（改文件名会让 `<img src>` 立刻 404）。这时若只看
 * "像不像 PictureN"，就会把 3 号图按 3 号写进包，而它的 pictureN 已经是 4。
 */
function assetPackName(asset: Asset): string {
  const name = (asset.fileName ?? '').trim()
  const m = /^Picture(\d+)(\.[A-Za-z0-9]{1,8})?$/.exec(name)
  if (m && Number(m[1]) === asset.pictureN) return name
  const raw = (asset.originalName ?? '').match(/\.[A-Za-z0-9]{1,8}$/)?.[0]
  let ext = (raw ?? '.png').toLowerCase()
  if (ext === '.jpeg') ext = '.jpg'
  if (!/^\.[A-Za-z0-9]{1,8}$/.test(ext)) ext = '.png'
  return `Picture${asset.pictureN}${ext}`
}

function refEntry(pictureN: number, fileName: string) {
  return {
    index: pictureN - 1,
    imageFile: `shared_params/${fileName}`,
    fileName,
    type: 'input',
    subfolder: 'shared_params'
  }
}

/**
 * 段级素材的扩展名。
 *
 * 包内文件名必须是 ASCII 且符合 `^(start|end|Picture\d+|Audio\d+|Video\d+)` 的
 * 扫描规则，所以原名一律不用，只借它的后缀。jpeg 统一成 jpg（导入端按
 * 扩展名决定能不能解码）。
 */
function slotExt(input: { originalName?: string; blob?: Blob }, fallback: string): string {
  const ext = extOf(input.originalName ?? '')
  if (/^[a-z0-9]{1,8}$/.test(ext)) return ext === 'jpeg' ? 'jpg' : ext
  const type = String(input.blob?.type ?? '').toLowerCase()
  if (type === 'image/jpeg') return 'jpg'
  if (type === 'image/png') return 'png'
  if (type === 'image/webp') return 'webp'
  if (type === 'video/mp4') return 'mp4'
  if (type === 'video/quicktime') return 'mov'
  if (type === 'video/webm') return 'webm'
  if (type === 'audio/mpeg' || type === 'audio/mp3') return 'mp3'
  if (type === 'audio/wav' || type === 'audio/x-wav') return 'wav'
  if (type === 'audio/mp4') return 'm4a'
  return fallback
}

function mediaSlotEntry(
  folder: string,
  fileName: string,
  key: 'imageFile' | 'audioFile' | 'videoFile',
  extra: Record<string, unknown> = {}
): {
  imageFile?: string
  audioFile?: string
  videoFile?: string
  fileName: string
  type: string
  subfolder: string
  [k: string]: unknown
} {
  const rel = `${folder}/${fileName}`
  return { ...extra, [key]: rel, fileName, type: 'input', subfolder: folder }
}

/**
 * 关键帧落位：首帧 / 尾帧各只取一张，同角色重复的降级成中间锚点。
 * 与 domain/references.ts 的 keyframePlan 同一套规则，只是这边拿到的是
 * 打包输入而不是 Asset。
 */
export function planPackKeyframes(list: PackKeyframeInput[], frames = 0): {
  start: PackKeyframeInput | null
  end: PackKeyframeInput | null
  anchors: PackKeyframeInput[]
} {
  let start: PackKeyframeInput | null = null
  let end: PackKeyframeInput | null = null
  const anchors: PackKeyframeInput[] = []
  for (const k of list) {
    if (k.role === 'start') {
      if (!start) start = k
      else anchors.push(k)
      continue
    }
    if (k.role === 'end') {
      if (!end) end = k
      else anchors.push(k)
      continue
    }
    anchors.push(k)
  }
  // 刻意**不**把中间锚点提升成首帧：锚点落在第 100 帧这件事本身就是信息，
  // 提升成首帧会把它挪到第 0 帧。没有首帧就只是没有 genImage，r2v 不依赖它。
  return { start, end, anchors }
}

function safeName(name: string): string {
  const out = (name ?? '').trim().replace(NAME_SAFE_RE, '_').replace(/^_+|_+$/g, '')
  return out || 'script-stage'
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/* --------------------------- 构建 --------------------------- */

export function buildDirectorPack(input: PackBuildInput): PackBuildResult {
  const { settings, assets, projectName = '' } = input
  const warnings: string[] = []

  const width = snapCanvas(input.width ?? DEFAULT_OUTPUT_WIDTH, DEFAULT_OUTPUT_WIDTH)
  const height = snapCanvas(input.height ?? DEFAULT_OUTPUT_HEIGHT, DEFAULT_OUTPUT_HEIGHT)
  const frameRate = Number(settings.fps) || PACK_FPS

  const assetByPicture = new Map<number, Asset>()
  for (const a of assets) assetByPicture.set(a.pictureN, a)
  const packNameByPicture = new Map<number, string>()
  for (const a of assets) packNameByPicture.set(a.pictureN, assetPackName(a))

  const oversized = [...packNameByPicture.keys()]
    .filter((n) => n > MAX_REFERENCE_IMAGES)
    .sort((a, b) => a - b)
  if (oversized.length) {
    warnings.push(
      `素材编号 ${oversized.join('、')} 超过 ${MAX_REFERENCE_IMAGES}，官方只有 ${MAX_REFERENCE_IMAGES} 个参考图槽位，` +
        '这些编号不会被送进模型，但提示词里仍写着 <Picture N>，需要压缩素材编号或改写提示词。'
    )
  }

  const globalPictures = [...packNameByPicture.keys()]
    .filter((n) => n > 0 && n <= MAX_REFERENCE_IMAGES)
    .sort((a, b) => a - b)

  if (!globalPictures.length && input.segments.some((s) => usedPictures(s).length)) {
    warnings.push('提示词引用了参考图，但项目里没有上传任何素材，导入后每段都会退化成 t2v。')
  }

  const missing = new Set<number>()
  /**
   * 用了、但主体没有参考图。
   *
   * 参考图挂在主体上（entity.pictureN → Picture N 槽），段里绑了主体就自动带上；
   * 主体没图时这段只会按 textDesc 描述生成 —— 不报错，但成片容易跑形。
   * 按主体名去重，避免十几个段把同一条警告刷十几遍。
   */
  const noPicEntities = new Set<string>()
  const segments: Array<Record<string, unknown>> = []
  const groupJsons: Array<Record<string, unknown>> = []
  /** 段级素材（关键帧 / 音视频）的本体，最后统一塞进 zip */
  const segmentEntries: ZipEntry[] = []
  let cursor = 0

  input.segments.forEach((seg, i) => {
    const rawFrames = Math.max(FRAME_OFFSET, Math.round(seg.frames))
    const frames = alignMiniMaxFrameCount(rawFrames)
    if (frames !== rawFrames) {
      warnings.push(
        `seg${String(i + 1).padStart(2, '0')} 帧数 ${rawFrames} 不在 H3 的 17k+5 网格上，已对齐为 ${frames}。`
      )
    }

    for (const e of seg.entities ?? []) {
      const hasPic = !!e.pictureN && e.pictureN > 0 && assetByPicture.has(e.pictureN)
      if (!hasPic) noPicEntities.add(e.name)
    }

    const used = usedPictures(seg)
    const segRefs = used
      .filter((n) => n <= MAX_REFERENCE_IMAGES)
      .filter((n) => packNameByPicture.has(n))
      .map((n) => refEntry(n, packNameByPicture.get(n)!))
    for (const n of used) {
      if (n <= MAX_REFERENCE_IMAGES && !packNameByPicture.has(n)) missing.add(n)
    }

    const weld = input.weldSeams === true
    const continuityFromPrev = weld && i > 0 && seg.continuityFromPrev === true
    const continuityToNext = weld && seg.continuityToNext === true
    const id = `seg${String(i + 1).padStart(2, '0')}`
    const durationSec = preferredDurationSecFromFrames(frames, PACK_FPS)
    const prompt = (seg.prompt ?? '').trim()

    /*
     * 段级「参考方式」素材并进同一份 refs。
     *
     * 它和主体参考图走同一个池子（shared_params/PictureN），区别只在归属：
     * 主体图跟着实体跨段共用，这张只属于这一段。所以这里只往本段 refs 补一条，
     * 文件本体由末尾的全局循环统一写进 shared_params。
     *
     * 提示词没点名要单独提醒：refs 里有图、六段式正文里却没有 <Picture N>，
     * 导演台只把点名过的编号交给模型，这张图多半会被当不存在。
     */
    const named = new Set(extractPictureNumbers(prompt))
    for (const r of seg.refImages ?? []) {
      const n = Math.round(Number(r.pictureN) || 0)
      if (n <= 0) {
        warnings.push(`${id} 有一张参考方式素材还没分配 Picture 编号，导入后不会进参考图槽。`)
        continue
      }
      if (n > MAX_REFERENCE_IMAGES) {
        warnings.push(
          `${id} 的参考方式素材编号 ${n} 超过 ${MAX_REFERENCE_IMAGES} 个参考图槽位，` +
            '它不会被送进模型，需要在素材里压缩编号。'
        )
        continue
      }
      if (!packNameByPicture.has(n)) {
        missing.add(n)
        continue
      }
      if (!segRefs.some((x) => x.index === n - 1)) {
        segRefs.push(refEntry(n, packNameByPicture.get(n)!))
      }
      if (!named.has(n)) {
        warnings.push(
          `${id} 的参考方式素材是 Picture${n}，但这一段提示词里没有出现 <Picture ${n}>：` +
            '导演台只把点名过的编号交给模型，这张图可能被忽略。'
        )
      }
    }
    // 按编号排：segRefs 与 shared_params 的池子顺序保持一致，照编号对图时不会错位
    segRefs.sort((x, y) => Number(x.index) - Number(y.index))

    /* ---- 段级素材：关键帧 / 音视频（不进 <Picture N>，只属于这一段） ---- */

    const segFolder = `asset_groups/${id}`
    /**
     * 素材只有**两个参数**，都在这里落地：
     *   起始帧 frameIdx —— 落在哪一帧（首 / 尾 / 指定帧）
     *   强度   strength —— 有多硬，折算成 ComfyUI 的 visual_noise_aug
     *
     * 不再有"另走 refs 抢一个 <Picture N>"的岔路：段内素材一律进 kfImages，
     * 靠强度混噪变软。否则同一张图会有两套编号、两处界面说法。
     */
    const allKeyframes = seg.keyframes ?? []
    const kf = planPackKeyframes(allKeyframes, frames)
    const startEntry = kf.start
      ? mediaSlotEntry(segFolder, `start.${slotExt(kf.start, 'png')}`, 'imageFile')
      : null
    const endEntry = kf.end
      ? mediaSlotEntry(segFolder, `end.${slotExt(kf.end, 'png')}`, 'imageFile')
      : null

    if (kf.start && !kf.start.blob) {
      warnings.push(`${id} 的首帧关键帧没有图片本体，导入后这一段没有起始画面。`)
    }
    if (kf.end && !kf.end.blob) {
      warnings.push(`${id} 的尾帧关键帧没有图片本体，导入后这一段没有收尾画面。`)
    }
    /*
     * 不引用上段的段（转场进入）又没有首帧关键帧 = 这一段完全靠文字起画：
     * 画风、人物长相、环境全看模型当场怎么理解。规则层拿不到素材，
     * 出包前是最后一次拦得住的地方，所以在这里提醒。
     */
    if (i > 0 && !continuityFromPrev && !kf.start) {
      warnings.push(
        `${id} 不引用上段（转场进入），但没有段首关键帧：这一段的画面只能靠文字起画，画风容易飘。` +
          '去「素材」给这一段出一张起始帧最稳。'
      )
    }
    /*
     * 链内段（引用上段）本来就靠上一段尾帧起画。再给它一张段首关键帧，
     * 导演台会同时收到"上段尾帧"和"本段首帧"两个起点 —— 多数时候还能跑，
     * 但两帧对不上时就是肉眼可见的一跳。只提醒，不拦：用户可能故意要钉住。
     */
    if (i > 0 && continuityFromPrev && kf.start) {
      warnings.push(
        `${id} 引用上段（链内），同时又挂了段首关键帧：首帧会受"上段尾帧"和"本段首帧"两处牵引，` +
          '两者对不上时画面会跳。链内段一般不需要自己的起始图，确认要钉住再留。'
      )
    }
    if (startEntry && kf.start?.blob) {
      segmentEntries.push({ path: startEntry.imageFile!, data: kf.start.blob })
    }
    if (endEntry && kf.end?.blob) {
      segmentEntries.push({ path: endEntry.imageFile!, data: kf.end.blob })
    }

    /**
     * r2v 模式下导演台只从 `kfImages` 读「关键帧」——`genImage` / `startImage`
     * 是 i2v / fl2v 的入口，r2v 走 gen_blank 时根本不看。所以首帧 / 尾帧
     * 除了写 startImage / endImage，还必须以锚点身份进 kfImages，
     * 否则界面上明明有首帧，对面跑出来却是"没有关键帧"。
     */
    const kfImages: Array<Record<string, unknown>> = []
    let kfIndex = 0
    /**
     * 首 / 尾帧的锚点帧位取**合并后的真实位置**，不再写死 0 / 末帧。
     *
     * 段首有预备镜头时，第一拍的第 0 帧其实从第 7 帧才开始；段尾有黑屏 /
     * 尾帧切镜时，最后一个叙事拍的尾帧也不在整段最后一帧上。写死会让图落在
     * 别的片段上 —— 界面上看不出错，成片里就是画面提前 / 延后出现。
     */
    const clampIdx = (raw: number | undefined, fallback: number): number => {
      const n = raw == null ? fallback : Math.round(Number(raw) || 0)
      return frames > 0 ? Math.max(0, Math.min(n, frames - 1)) : Math.max(0, n)
    }
    /** 强度 → 条目字段：strength 给人看，visualNoiseAug 给导演台/节点读 */
    const kfStrength = (k: PackKeyframeInput | null | undefined) => {
      const strength = clampStrength(k?.strength ?? STRENGTH_HARD)
      return { strength, visualNoiseAug: visualNoiseAugOf(strength) }
    }
    if (startEntry) {
      kfImages.push({
        ...startEntry,
        index: kfIndex++,
        frameIdx: clampIdx(kf.start?.frameIdx, 0),
        ...kfStrength(kf.start)
      })
    }
    kf.anchors.forEach((a, n) => {
      const name = `kf${n + 1}.${slotExt(a, 'png')}`
      const entry = mediaSlotEntry(segFolder, name, 'imageFile', {
        index: kfIndex++,
        frameIdx: clampIdx(a.frameIdx, 0),
        ...kfStrength(a)
      })
      kfImages.push(entry)
      if (a.blob) segmentEntries.push({ path: entry.imageFile!, data: a.blob })
      else warnings.push(`${id} 的第 ${n + 1} 张中间关键帧没有图片本体，导入后会被丢掉。`)
    })
    if (endEntry) {
      kfImages.push({
        ...endEntry,
        index: kfIndex++,
        frameIdx: clampIdx(kf.end?.frameIdx, Math.max(0, frames - 1)),
        ...kfStrength(kf.end)
      })
    }

    const refAudios: Array<Record<string, unknown>> = []
    const refVideos: Array<Record<string, unknown>> = []
    /**
     * 音视频同样只有「起始帧 + 强度」两个参数：
     *
     *   视频 → 一律进 kfVideos：从 frameIdx 起覆盖一段画面，强度折算成
     *          visual_noise_aug（100 = 原样覆盖，越低越像动作参考）
     *   音频 → 强度满值进 kfAudios（这段音轨就用它）；低于满值进 refAudios
     *          （参考音色）。音频没有"视觉混噪"这条软化路径，只能走参考通道，
     *          所以这里按强度选通道，而不是像视频那样按强度混噪。
     *
     * 文件名加 Kf 前缀，避免和同目录的参考素材 Audio1 / Video1 撞名。
     */
    const kfAudios: Array<Record<string, unknown>> = []
    const kfVideos: Array<Record<string, unknown>> = []
    let audioSeq = 0
    let videoSeq = 0
    let kfAudioSeq = 0
    let kfVideoSeq = 0
    for (const m of seg.materials ?? []) {
      const isAudio = m.media === 'audio'
      // 缺省 30 与老数据一致（老项目的音视频一直走参考槽，不能被静默改成钉住）
      const strength = clampStrength(m.strength ?? 30)
      const noiseAug = visualNoiseAugOf(strength)
      // 起始帧夹到段内：导演台对越界锚点是丢弃，这里夹住至少不会悄悄消失。
      const rawStart = Math.max(0, Math.round(Number(m.frameIdx) || 0))
      const startFrameIdx = frames > 0 ? Math.min(rawStart, Math.max(0, frames - 1)) : rawStart

      /**
       * 通道由**作用方式**和强度一起决定：
       *   作用方式 = reference —— 一律走参考通道，不占这段的时间轴。
       *     用户说得明明白白"只借这段声音 / 动作"，强度调多高也不该反过来
       *     抢走音轨或画面（否则卡片上放在「参考素材」里、包里却钉住了）。
       *   否则按强度：音频满强度才固定音轨（kfAudios），低了只能走参考音色
       *     （音频没有视觉混噪这条路，没法在 kf 槽里"半软"）；
       *     视频 80 及以上进 kfVideos（钉一段 + 按强度混噪），低了走 refVideos。
       * 阈值 80 和 strengthLabel 的「强参考」分界对齐，界面说"强"就真的钉住。
       */
      const anchored =
        m.actAs === 'reference'
          ? false
          : isAudio
            ? strength >= STRENGTH_HARD
            : strength >= STRENGTH_MEDIA_ANCHOR

      if (anchored) {
        const seq = isAudio ? kfAudioSeq : kfVideoSeq
        const name = isAudio
          ? `KfAudio${seq + 1}.${slotExt(m, 'mp3')}`
          : `KfVideo${seq + 1}.${slotExt(m, 'mp4')}`
        const key = isAudio ? 'audioFile' : 'videoFile'
        // 关键帧通道读的是 frameIdx（段内像素帧），不是 startFrameIdx
        const entry = mediaSlotEntry(segFolder, name, key, {
          index: seq,
          frameIdx: startFrameIdx,
          strength,
          ...(isAudio ? {} : { visualNoiseAug: noiseAug })
        })
        if (isAudio) {
          kfAudios.push(entry)
          kfAudioSeq += 1
        } else {
          kfVideos.push(entry)
          kfVideoSeq += 1
        }
        if (m.blob) segmentEntries.push({ path: `${segFolder}/${name}`, data: m.blob })
        else warnings.push(`${id} 的${isAudio ? '固定音轨' : '参考视频'} ${name} 没有本体，导入后会被丢掉。`)
        continue
      }

      const seq = isAudio ? audioSeq : videoSeq
      const name = isAudio ? `Audio${seq + 1}.${slotExt(m, 'mp3')}` : `Video${seq + 1}.${slotExt(m, 'mp4')}`
      const key = isAudio ? 'audioFile' : 'videoFile'
      // 字段名用 startFrameIdx 而不是 frameIdx —— 音视频的帧位是"从这一帧起
      // 生效"，跟关键帧"落在这一帧"不是一回事，混名以后不好读。
      const entry = mediaSlotEntry(segFolder, name, key, {
        index: seq,
        startFrameIdx,
        strength,
        visualNoiseAug: noiseAug
      })
      if (isAudio) {
        refAudios.push(entry)
        audioSeq += 1
      } else {
        refVideos.push(entry)
        videoSeq += 1
      }
      if (m.blob) segmentEntries.push({ path: `${segFolder}/${name}`, data: m.blob })
      else warnings.push(`${id} 的${isAudio ? '参考音频' : '参考视频'} ${name} 没有本体，导入后会被丢掉。`)
    }

    segments.push({
      id,
      start: cursor,
      length: frames,
      frameCount: frames,
      durationSec,
      prompt,
      negativePrompt: '',
      taskType: R2V_TASK_TYPE,
      refs: segRefs,
      refAudios,
      refVideos,
      kfImages,
      kfAudios,
      kfVideos,
      continuityFromPrev,
      continuityToNext,
      refImageSize: 'match',
      genImage: startEntry ?? { imageFile: '' },
      startImage: startEntry,
      endImage: endEntry
    })

    groupJsons.push({
      id,
      prompt,
      negativePrompt: '',
      durationSec,
      frameCount: frames,
      length: frames,
      start: cursor,
      taskType: R2V_TASK_TYPE,
      refs: segRefs,
      refAudios,
      refVideos,
      kfImages,
      kfAudios,
      kfVideos,
      continuityFromPrev,
      refImageSize: 'match',
      genImage: startEntry ?? { imageFile: '' },
      startImage: startEntry,
      endImage: endEntry
    })

    cursor += frames
  })

  if (missing.size) {
    warnings.push(
      `提示词引用了 ${[...missing].sort((a, b) => a - b).join('、')} 号素材，但注册表里没有对应图片，` +
        '这些槽位不会写入包内。'
    )
  }

  /* 「对齐下段」是重抽专用的：它要求下一段已有首帧视频缓存，新时间线首跑必然没有。
   * 导演节点那边的默认值就是关，所以打包默认也不写 —— 只有重抽某段、明确要求焊接时
   * 才由调用方显式传 weldSeams: true。 */
  const continuityEnabled =
    input.weldSeams === true &&
    input.segments.length >= 2 &&
    segments.some((s) => s.continuityFromPrev === true || s.continuityToNext === true)

  const packJson: Record<string, unknown> = {
    format: PACK_FORMAT,
    formatVersion: PACK_VERSION,
    taskType: 'r2v',
    widgets: { task_type: R2V_TASK_TYPE },
    output: {
      mode: 'fixed',
      width,
      height,
      exportMode: 'all',
      audioMode: 'generate',
      refImageSize: 'match',
      continuityEnabled,
      continuityOverlapFrames: 22,
      continuityMode: 'guide',
      continuityRedraw: 0.1
    }
  }

  if (noPicEntities.size) {
    warnings.push(
      `这些主体还没有参考图：${[...noPicEntities].join('、')}。` +
        '用到他们的段只能按文字描述生成（参考图挂在主体上，到「主体登记」页补一张，所有用到他的段都会自动带上）。'
    )
  }

  const timeline: Record<string, unknown> = {
    version: 5,
    timelineMode: 'prompt_batch',
    editMode: 'segment',
    frameRate,
    totalFrames: cursor || FRAME_OFFSET,
    global: {
      taskType: R2V_TASK_TYPE,
      prompt: '',
      commonEnabled: true,
      commonCollapsed: false,
      refs: globalPictures.map((n) => refEntry(n, packNameByPicture.get(n)!)),
      refAudios: [],
      refVideos: [],
      referenceVideo: {},
      continuousReference: false
    },
    output: {
      mode: 'fixed',
      width,
      height,
      aspectRatio: '16:9 (宽屏)',
      megapixels: 0.4,
      multiple: CANVAS_MULTIPLE,
      longEdge: Math.max(width, height),
      maxExportFrames: 0,
      exportMode: 'all',
      audioMode: 'generate',
      refImageSize: 'match',
      continuityEnabled,
      continuityOverlapFrames: 22,
      continuityMode: 'guide',
      continuityRedraw: 0.1
    },
    segments: segments.length
      ? segments
      : [
          {
            id: 'seg01',
            start: 0,
            length: 124,
            frameCount: 124,
            durationSec: 5,
            prompt: '',
            negativePrompt: '',
            taskType: R2V_TASK_TYPE,
            refs: [],
            refAudios: [],
            refVideos: [],
            continuityFromPrev: false,
            continuityToNext: false,
            refImageSize: 'match',
            genImage: { imageFile: '' }
          }
        ],
    video: { fileName: '', videoFile: '', subfolder: '', type: 'input', frames: [], frameMap: [] },
    videoClips: [],
    runSelectEnabled: false,
    runSelection: []
  }

  const entries: ZipEntry[] = [jsonEntry('pack.json', packJson), jsonEntry('timeline.json', timeline)]

  const sharedRefs = (timeline.global as { refs: Array<Record<string, unknown>> }).refs
  entries.push(
    jsonEntry('shared_params/shared_params.json', {
      commonEnabled: true,
      commonCollapsed: false,
      prompt: '',
      refs: sharedRefs,
      refAudios: [],
      refVideos: []
    })
  )

  // 参考图：不打进去的话导入端会把对应槽位静默清空
  for (const a of [...assets].sort((x, y) => x.pictureN - y.pictureN)) {
    if (!a.blob) continue
    if (a.pictureN <= 0 || a.pictureN > MAX_REFERENCE_IMAGES) continue
    entries.push({ path: `shared_params/${packNameByPicture.get(a.pictureN)}`, data: a.blob })
  }

  // 段级素材（关键帧 / 音视频）：同样必须真打进包，缺文件导入端会静默清空
  entries.push(...segmentEntries)

  // 原版 Director 在没有 timeline.json 时才读 group.json，这里一并写上便于跨插件往返
  groupJsons.forEach((g, i) => {
    entries.push(jsonEntry(`asset_groups/${String(i + 1).padStart(2, '0')}/group.json`, g))
  })

  return {
    filename: `${safeName(projectName)}-${stamp()}.mmxpack.zip`,
    packJson,
    timeline,
    entries,
    warnings
  }
}

/** 构建 + 打包成可下载的 zip */
export async function buildDirectorPackZip(input: PackBuildInput): Promise<{
  blob: Blob
  filename: string
  warnings: string[]
  timeline: Record<string, unknown>
}> {
  const result = buildDirectorPack(input)
  const blob = await zipToBlob(result.entries)
  return { blob, filename: result.filename, warnings: result.warnings, timeline: result.timeline }
}
