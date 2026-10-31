/**
 * 素材的齐备度。
 *
 * 「这一段能不能进组合」不是看字段填没填，而是看**素材有没有备齐**。
 *
 * ★ 硬条件只有一件：台词镜头的**配音**。缺音，成片只能按字数估帧长。
 * ★ 首帧是**可选**的：没有起始图，导演台就用文字起画（r2v 本身不依赖首帧）。
 *   所以 `ready` 不再把"没有图"算成缺口 —— 只在界面上提示一句"还没起始图"，
 *   让用户自己决定要不要为这一镜多花几十秒。
 *
 * ★ 图按**链**算，不按段算。
 *
 * 段与段之间靠「引用上段」串成链（beats[i].refPrev）：上游那一段的尾帧
 * 直接喂给下游当首帧引导。所以一条链**只有链头可能需要一张起始图** ——
 * 链内下游段自己再出一张，和引导进来的画面打架
 * （导演台会同时收到"上段尾帧"和"本段首帧"两个起点）。
 *
 * 这就是为什么这个模块要读 refPrev：先缝合（③ 组合与缝合）定出链，
 * 再生图（素材），顺序反过来就只能按段盲出一轮。
 *
 * 抽成纯函数的原因：这个判断有两个消费者，而且口径必须一致 ——
 *   ② 细节填充卡片上的"齐没齐"提示
 *   阶段门禁（domain/gate，出片前的检查）
 * 各算各的迟早出现"清单说齐了、统计说还缺"。
 *
 * 判定依据全部来自既有领域函数（keyframesOf / voiceoverCheck / hasVoiceover），
 * 不在这里另立一套"什么算有图、什么算能配"。
 */

import { keyframesOf, refImagesOf } from './references'
import { beatFrames } from './timing'
import { hasVoiceover, voiceoverCheck } from './voiceover'
import type { Asset, Beat, Entity, ID, ProjectSettings } from './types'

/**
 * 配音状态：
 *   done    —— 已经有一条配音
 *   todo    —— 该配、也能配，但还没配（点一下就能补）
 *   blocked —— 该配但配不了（没写台词 / 没选说话人 / 说话人没固定音色）
 *   none    —— 本来就不该有配音（动作、空镜、转场、黑屏…）
 *
 * todo 和 blocked 必须分开：前者用户自己能补，后者得先去「主体」固定音色
 * 或者回「① 拆解」补台词 —— 混成一句"缺配音"只会让人点进去发现点不动。
 */
export type VoiceState = 'done' | 'todo' | 'blocked' | 'none'

export interface BeatMaterials {
  beatId: ID
  /** 在传入列表里的序号（1 起）：清单上直接显示，和段卡片上的编号对得上 */
  index: number
  /** 本段共几帧 */
  frames: number
  /** 关键帧张数（只算按关键帧方式起作用的图；参考方式的不占帧位） */
  images: number
  /** 按参考图方式起作用的段内素材张数 */
  refImages: number
  /** 段内音视频素材条数（配音也算 1 条） */
  audios: number
  voice: VoiceState
  /** 一句话说明配音这一格为什么是这个状态 */
  voiceNote: string
  /**
   * 这一段是不是**链的起点**（第 0 段，或没有勾「引用上段」）。
   * 链头建议给一张起始图；链内靠上一段尾帧引导。
   */
  chainHead: boolean
  /** 这一段要不要自己一张起始图（= chainHead，读起来比 `<` 判断清楚）。**可选** */
  needImage: boolean
  /** 该配的音都配了（首帧不影响齐备：没有图也能用文字起画） */
  ready: boolean
}

export interface MaterialsCoverage {
  rows: BeatMaterials[]
  total: number
  /** 至少有 1 张关键帧 */
  withImage: number
  /** 至少有 1 张参考方式素材（不占帧位，所以不影响齐备度） */
  withRef: number
  /** **链头**里还缺起始图的条数（链内不算，它用上段尾帧） */
  missingImage: number
  /** 一共几条链（= 链头数） */
  chains: number
  /** 已经配好的台词镜头 */
  voiceDone: number
  /** 能配但还没配 */
  voiceTodo: number
  /** 该配却配不了（缺台词 / 缺说话人 / 音色没固定） */
  voiceBlocked: number
  /** 图有了 + 该配的都配了 */
  ready: number
  /** 还缺东西的段数（= total - ready） */
  notReady: number
}

/** 段内音视频条数：图片之外的都属于「音视频素材」（待合成槽位不算，它还没有本体） */
function audioCountOf(assets: Asset[], beatId: ID): number {
  return assets.filter((a) => a.refId === beatId && a.kind === 'material' && !a.draft).length
}

function voiceOf(
  beat: Beat,
  assets: Asset[],
  entityById: Map<ID, Entity>
): { voice: VoiceState; voiceNote: string } {
  const check = voiceoverCheck(beat, entityById)
  if (hasVoiceover(assets, beat.id)) {
    return { voice: 'done', voiceNote: '已配音' }
  }
  if (check.target) {
    return { voice: 'todo', voiceNote: `还没配音：用「${check.target.speaker.name}」的音色配这句` }
  }
  // 没有目标时，只有台词镜头才算"该配却没配成"；动作段的 reason 是"只有台词镜头能配音"，
  // 那不是缺陷，别把它当缺口报出去
  if (beat.kind === 'dialogue') {
    return { voice: 'blocked', voiceNote: check.reason ?? '配不了：缺少台词或说话人音色' }
  }
  return { voice: 'none', voiceNote: '不必配音（非台词镜头）' }
}

export function beatMaterialsOf(
  beat: Beat,
  assets: Asset[],
  entityById: Map<ID, Entity>,
  settings: ProjectSettings,
  index: number,
  opts: { chainHead?: boolean } = {}
): BeatMaterials {
  const images = keyframesOf(assets, beat.id).length
  // 参考方式不占帧位，齐备度里不算"这一段有起始图"，只用于展示
  const refImages = refImagesOf(assets, beat.id).length
  const audios = audioCountOf(assets, beat.id)
  const { voice, voiceNote } = voiceOf(beat, assets, entityById)
  // 默认按"链头"算，保持单段调用（没有链上下文时）的严格口径；
  // 知道链结构的地方（materialsCoverage）会把链内段显式传 false。
  const chainHead = opts.chainHead !== false
  // todo / blocked 都算缺口：一个能自己补，一个得先去别处补
  const voiceOk = voice === 'done' || voice === 'none'
  // ★ 首帧是**可选**的（2026-10-28 用户定的口径）：没有起始图这一段照样能跑，
  //   导演台会用文字起画。所以齐备度只看音；图只在界面上提示"还没起始图"。
  return {
    beatId: beat.id,
    index,
    frames: beatFrames(beat, settings),
    images,
    refImages,
    audios,
    voice,
    voiceNote,
    chainHead,
    needImage: chainHead,
    ready: voiceOk
  }
}

/**
 * 链头判定。
 *
 * 「链」是**段（Group）**级别的：段与段之间靠 refPrev 串起来，而素材卡片是
 * beat 级的。所以映射是：
 *   该段是链头（第 0 段或不引用上段）→ 段内**第一个** beat 要起始图；
 *   段内其余 beat 属于同一段视频，不单独要图；
 *   链内段的所有 beat 都不需要（首帧由上一段尾帧引导）。
 *
 * 没拿到段信息时（还没进③组合、或老数据）**全部按链头算** —— 也就是退回
 * 逐段要求。这是保守方向：多要一张图的代价是几十秒，漏掉一段起始图则是
 * 整段画面靠文字起画。
 */
export interface ChainSegment {
  /** 这一段包含哪些 beat（按片序） */
  beatIds: ID[]
  /** 这一段是否引用上一段 */
  refPrev: boolean
}

export function chainHeadsOf(beats: Beat[], segments?: ChainSegment[]): boolean[] {
  if (!segments || !segments.length) return beats.map(() => true)

  /** beatId → 需不需要自己的起始图 */
  const need = new Map<ID, boolean>()
  segments.forEach((s, i) => {
    const head = i === 0 || !s.refPrev
    s.beatIds.forEach((id, j) => need.set(id, head && j === 0))
  })
  // 段信息里找不到的 beat（刚拆段还没重组）：按链头算，别让它悄无声息地缺图
  return beats.map((b) => need.get(b.id) ?? true)
}

export function materialsCoverage(
  beats: Beat[],
  assets: Asset[],
  entityById: Map<ID, Entity>,
  settings: ProjectSettings,
  segments?: ChainSegment[]
): MaterialsCoverage {
  const heads = chainHeadsOf(beats, segments)
  const rows = beats.map((b, i) =>
    beatMaterialsOf(b, assets, entityById, settings, i + 1, { chainHead: heads[i] })
  )
  let withImage = 0
  let withRef = 0
  let missingImage = 0
  let chains = 0
  let voiceDone = 0
  let voiceTodo = 0
  let voiceBlocked = 0
  let ready = 0
  for (const r of rows) {
    if (r.images > 0) withImage += 1
    if (r.refImages > 0) withRef += 1
    if (r.chainHead) {
      chains += 1
      // 只有链头缺图才算缺口：链内段本来就不需要起始图
      if (r.images === 0) missingImage += 1
    }
    if (r.voice === 'done') voiceDone += 1
    else if (r.voice === 'todo') voiceTodo += 1
    else if (r.voice === 'blocked') voiceBlocked += 1
    if (r.ready) ready += 1
  }
  return {
    rows,
    total: rows.length,
    withImage,
    withRef,
    missingImage,
    chains,
    voiceDone,
    voiceTodo,
    voiceBlocked,
    ready,
    notReady: rows.length - ready
  }
}
