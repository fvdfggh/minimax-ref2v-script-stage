/**
 * 段视图 → 导演包段输入。
 *
 * 这层转换以前只存在于 `RunJobsPanel`（提交时用）。「产物」页也要它 ——
 * 它得用**同一份 timeline** 去问 ComfyUI "第 i 段的成片在不在"，
 * timeline 一变，index 就对不上缓存槽了。所以抽出来共用一份实现，
 * 避免两处各写一遍然后慢慢漂移。
 *
 * 段级参考素材（关键帧 / 音视频）也在这里摊平：一个段可能由好几个片段拼成，
 * 每个片段都有自己的关键帧，得换算成**段内绝对帧位**才能交给导演台。
 *
 * 刻意不 import `SegmentView`：那是 store 里的类型，domain 不该反向依赖 store。
 * 这里只声明它真正用到的形状，装配层传什么都能塞进来。
 */
import { collectEntities } from './beats'
import { composeSegmentText } from './derive'
import { deliveryFields, langOf } from './lang'
import { beatWindowsOf } from './frames'
import {
  actAsOf,
  clampFrame,
  keyframesOf,
  materialsOf,
  placementOf,
  refImagesOf,
  strengthOf
} from './references'
import type {
  PackKeyframeInput,
  PackMaterialInput,
  PackRefImageInput,
  PackSegmentInput
} from './pack'
import type {
  Asset,
  AssetActAs,
  Beat,
  Entity,
  FieldSchema,
  ID,
  KeyframeRole,
  ProjectSettings
} from './types'
import { AUTO_KINDS, DEFAULT_SETTINGS } from './types'

/** 段视图里与出片相关的那部分字段 */
export interface PackSegSource {
  group: { id: ID }
  frames: number
  /** 纯叙事片段（字段派生用） */
  narrativeBeats: Beat[]
  /**
   * 素材化后的完整片段序列（含 preshoot / tail_cut / black）。
   *
   * 关键帧位置必须按**这个**序列算：自动拼接片段也占帧，少算它们，
   * 后面所有关键帧都会提前若干帧。老调用方没有这个字段时退回叙事片段。
   */
  beats?: Beat[]
  /** 副帧表：拍 id → 追加帧数（可为负）。漏传会让位置在合并后整体漂移。 */
  pad?: Record<ID, number>
  fields: Record<string, string>
  /** 英文终稿（en 工作语言下用它打包；缺整份时退回 fields） */
  fieldsEn?: Record<string, string>
  refPrev: boolean
  seam: { continuityFromPrev: boolean } | null
  nextSeam: { continuityToNext: boolean } | null
  /**
   * 实际入向 / 出向连续性。
   *
   * 出过片的段沿用出片时的冻结判定（见 types.FrozenSeam），此时它和 `seam`
   * 实时算出来的结论可能不同。打包必须用这个值 —— 否则插了新段就悄悄改了
   * 已出片段的提示词，缓存对不上还是小事，画面接不上才是大事。
   */
  continuityFromPrev?: boolean
  continuityToNext?: boolean
}

export interface PackAttachments {
  keyframes: PackKeyframeInput[]
  materials: PackMaterialInput[]
  /** 作用方式 = reference 的段内素材：走 <Picture N> 参考图通道 */
  refImages: PackRefImageInput[]
}

/** 合并后的一张关键帧：落在整段的第几帧 */
export interface MergedKeyframe {
  beatId: ID
  asset: Asset
  /** start / end 只在真正占住整段首尾时才出现 */
  role: KeyframeRole
  /** 段内绝对帧位 */
  frameIdx: number
  /** 锚定强度 0~100 */
  strength: number
}

/** 合并后的一段音视频素材：从整段第几帧起生效 */
export interface MergedMaterial {
  beatId: ID
  asset: Asset
  frameIdx: number
  /** 锚定强度 0~100 */
  strength: number
  /** 作用方式：reference = 只当参考（不占时间轴） */
  actAs?: AssetActAs
}

/** 合并后的参考方式素材：没有帧位，只靠 pictureN 进本段 refs */
export interface MergedRefImage {
  beatId: ID
  asset: Asset
}

export interface MergedAttachments {
  keyframes: MergedKeyframe[]
  materials: MergedMaterial[]
  refImages: MergedRefImage[]
}

/**
 * 把各片段的关键帧 / 音视频摊平到**合并后的整段坐标系**。
 *
 * 位置规则：
 *   · 每个片段的起点 = 前面所有片段的「自身帧数 + 副帧」累加（见 beatWindowsOf）
 *   · 拍内偏移照旧：段首 = 0、段尾 = 本拍最后一帧、指定帧 = frameIdx（夹到本拍内）
 *   · 只有**素材化序列里真正的第一拍**的段首才算整段首帧（start），
 *     因为它前面没有预备镜头；否则降成锚点，落在它真实的起点上
 *   · 只有**真正的最后一拍**的段尾才算整段尾帧（end）；后面还有尾帧切镜 /
 *     黑屏时降成锚点，否则这张图会被写到黑屏那一帧上
 *
 * 这几条合起来的效果就是：片段增删、换段、改副帧 → 关键帧位置立刻跟着变，
 * 而且和导演台实际播到的那一帧对得上。
 */
export function mergeAttachments(
  beats: Beat[],
  assets: Asset[],
  settings: ProjectSettings = DEFAULT_SETTINGS,
  pad?: Record<ID, number> | null
): MergedAttachments {
  const keyframes: MergedKeyframe[] = []
  const materials: MergedMaterial[] = []
  const refImages: MergedRefImage[] = []
  if (!beats.length) return { keyframes, materials, refImages }

  const windows = beatWindowsOf(beats, settings, pad)
  const lastIndex = windows.length - 1
  // 首尾只认第一 / 最后一个**叙事**片段：自动片段没有素材，但它可能把
  // 叙事片段的首尾从 0 / 末帧上挤开。
  const firstNarrative = windows.find((w) => !AUTO_KINDS.includes(w.beat.kind))
  const lastNarrative = [...windows].reverse().find((w) => !AUTO_KINDS.includes(w.beat.kind))

  for (const w of windows) {
    // 夹取要用本拍的实际长度（含副帧）：副帧让片子变长，指定帧要能跟着变宽
    const withinOf = (place: ReturnType<typeof placementOf>, raw?: number): number => {
      if (place === 'head') return 0
      if (place === 'tail') return Math.max(0, w.frames - 1)
      return clampFrame(raw, w.frames)
    }

    for (const a of keyframesOf(assets, w.beat.id)) {
      const place = placementOf(a)
      const within = withinOf(place, a.frameIdx)
      // 强度只决定"有多硬"，不改变它落在哪一帧，所以首尾身份照常判定
      const isSegmentStart = place === 'head' && w.index === firstNarrative?.index
      const isSegmentEnd =
        place === 'tail' && w.index === lastNarrative?.index && w.index === lastIndex

      keyframes.push({
        beatId: w.beat.id,
        asset: a,
        // 段首 / 段尾只留给真正占住整段首尾的那一张，其余一律是锚点：
        // 让位置说话，不要为了凑出 startImage 把图挪回第 0 帧。
        role: isSegmentStart ? 'start' : isSegmentEnd ? 'end' : 'anchor',
        frameIdx: w.start + within,
        strength: strengthOf(a)
      })
    }

    for (const a of materialsOf(assets, w.beat.id)) {
      if (a.media !== 'audio' && a.media !== 'video') continue
      materials.push({
        beatId: w.beat.id,
        asset: a,
        frameIdx: w.start + clampFrame(a.frameIdx, w.frames),
        strength: strengthOf(a),
        // 作用方式 = reference 的只走参考通道：不占时间轴，强度再高也不钉
        actAs: actAsOf(a)
      })
    }

    // 参考方式：没有帧位，不需要换算坐标，只把"这一段要用它"记下来
    for (const a of refImagesOf(assets, w.beat.id)) {
      refImages.push({ beatId: w.beat.id, asset: a })
    }
  }

  return { keyframes, materials, refImages }
}

/** 摊平成打包输入（blob / 文件名等） */
export function attachmentsOf(
  beats: Beat[],
  assets: Asset[],
  settings?: ProjectSettings,
  pad?: Record<ID, number> | null
): PackAttachments {
  const merged = mergeAttachments(beats, assets, settings, pad)
  return {
    keyframes: merged.keyframes.map((k) => ({
      originalName: k.asset.originalName || k.asset.fileName,
      blob: k.asset.blob,
      role: k.role,
      frameIdx: k.frameIdx,
      strength: k.strength
    })),
    materials: merged.materials.map((m) => ({
      originalName: m.asset.originalName || m.asset.fileName,
      blob: m.asset.blob,
      media: m.asset.media as 'audio' | 'video',
      frameIdx: m.frameIdx,
      strength: m.strength,
      actAs: m.actAs ?? actAsOf(m.asset)
    })),
    refImages: merged.refImages.map((r) => ({
      pictureN: r.asset.pictureN,
      fileName: r.asset.fileName,
      originalName: r.asset.originalName || r.asset.fileName,
      blob: r.asset.blob
    }))
  }
}

export function packSegmentOf(
  v: PackSegSource,
  schema: FieldSchema[],
  entityById: Map<ID, Entity>,
  assets: Asset[] = [],
  settings?: ProjectSettings
): PackSegmentInput {
  // 位置按素材化后的完整序列算（含自动拼接片段），副帧也要算进去
  const timeline = v.beats?.length ? v.beats : v.narrativeBeats
  const { keyframes, materials, refImages } = attachmentsOf(timeline, assets, settings, v.pad)
  return {
    id: v.group.id,
    frames: v.frames,
    // 提示词要跟「交付页看到的」同一份：en 模式打包英文终稿，zh 模式打包中文工作稿
    prompt: composeSegmentText(schema, deliveryFields(v.fields, v.fieldsEn, langOf(settings))),
    refPrev: v.refPrev,
    continuityFromPrev: v.continuityFromPrev ?? v.seam?.continuityFromPrev ?? false,
    continuityToNext: v.continuityToNext ?? v.nextSeam?.continuityToNext ?? false,
    entities: collectEntities(v.narrativeBeats)
      .map((id) => entityById.get(id))
      .filter((e): e is Entity => !!e),
    keyframes,
    materials,
    refImages
  }
}
