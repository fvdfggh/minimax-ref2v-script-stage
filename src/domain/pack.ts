import { jsonEntry, zipToBlob, type ZipEntry } from '@/core/zip'
import type { Asset, Entity, ID, ProjectSettings } from './types'

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
const PICTURE_NAME_RE = /^Picture\d+(?:\.[A-Za-z0-9]{1,8})?$/
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
}

export interface PackBuildInput {
  projectName?: string
  settings: ProjectSettings
  segments: PackSegmentInput[]
  /** 全部素材（含 blob），按 pictureN 与实体绑定 */
  assets: Asset[]
  width?: number
  height?: number
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

/** 包内文件名：已经是 PictureN.ext 就沿用，否则按编号重造 */
function assetPackName(asset: Asset): string {
  const name = (asset.fileName ?? '').trim()
  if (PICTURE_NAME_RE.test(name)) return name
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
  const segments: Array<Record<string, unknown>> = []
  const groupJsons: Array<Record<string, unknown>> = []
  let cursor = 0

  input.segments.forEach((seg, i) => {
    const rawFrames = Math.max(FRAME_OFFSET, Math.round(seg.frames))
    const frames = alignMiniMaxFrameCount(rawFrames)
    if (frames !== rawFrames) {
      warnings.push(
        `seg${String(i + 1).padStart(2, '0')} 帧数 ${rawFrames} 不在 H3 的 17k+5 网格上，已对齐为 ${frames}。`
      )
    }

    const used = usedPictures(seg)
    const refs = used
      .filter((n) => n <= MAX_REFERENCE_IMAGES)
      .filter((n) => packNameByPicture.has(n))
      .map((n) => refEntry(n, packNameByPicture.get(n)!))
    for (const n of used) {
      if (n <= MAX_REFERENCE_IMAGES && !packNameByPicture.has(n)) missing.add(n)
    }

    const continuityFromPrev = i > 0 && seg.continuityFromPrev === true
    const continuityToNext = seg.continuityToNext === true
    const id = `seg${String(i + 1).padStart(2, '0')}`
    const durationSec = preferredDurationSecFromFrames(frames, PACK_FPS)
    const prompt = (seg.prompt ?? '').trim()

    segments.push({
      id,
      start: cursor,
      length: frames,
      frameCount: frames,
      durationSec,
      prompt,
      negativePrompt: '',
      taskType: R2V_TASK_TYPE,
      refs,
      refAudios: [],
      refVideos: [],
      continuityFromPrev,
      continuityToNext,
      refImageSize: 'match',
      genImage: { imageFile: '' }
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
      refs,
      refAudios: [],
      refVideos: [],
      continuityFromPrev,
      refImageSize: 'match',
      genImage: { imageFile: '' },
      startImage: null,
      endImage: null
    })

    cursor += frames
  })

  if (missing.size) {
    warnings.push(
      `提示词引用了 ${[...missing].sort((a, b) => a - b).join('、')} 号素材，但注册表里没有对应图片，` +
        '这些槽位不会写入包内。'
    )
  }

  const continuityEnabled =
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
