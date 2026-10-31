/**
 * 「给这一段出一张关键帧」这件事的全部状态。
 *
 * 原来只有 BeatRefMaterials 一处会出图，逻辑写死在组件里；现在卡片墙
 * （卡片上"重出这一张"）也要能就地出图，两处必须走同一条落库路径 —— 否则
 * "从卡片出的图"和"从详情出的图"在替换、帧位、溯源上迟早不一致。
 *
 * 所以抽到这里，组件只负责把「当前的段 / 关键帧 / 末帧号」递进来：
 *
 *   const gen = useBeatKeyframeGen({ beatId, keyframes, lastFrame, onDone })
 *   gen.openGen('head')                     // 出段首
 *   gen.openGen('head', existingAsset)      // 重出某一张：先删旧的，再按原位置写回
 *   gen.openGenForAsset(draftOrAsset)       // 按**这条素材自己的提示词**出图（素材详情）
 *   gen.onGenerated(blob, sentPrompt, refs) // ImageGenModal 的 done
 *
 * 替换这件事必须在这里做：同一帧上有两张图时，导演台只会认后一张，
 * 旧那张留在轨道上纯属干扰（还会被当成冲突标红）。
 */
import { computed, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useImageStore } from '@/stores/images'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { PLACEMENT_LABEL, actAsOf, placementOf } from '@/domain/references'
import type { Asset, ID, KeyframePlacement } from '@/domain/types'

export interface BeatGenCtx {
  beatId: () => ID
  /** 这一段现有的关键帧（用来算底图、找同位置的已有图） */
  keyframes: () => Asset[]
  /** 段内末帧号：指定帧的默认落点 */
  lastFrame: () => number
  /** 图落库之后回调（让外面刷新统计 / 重选） */
  onDone?: () => void
}

export function useBeatKeyframeGen(ctx: BeatGenCtx) {
  const images = useImageStore()
  const beats = useBeatStore()
  const registry = useRegistryStore()
  const message = useMessage()

  /** 正在出哪一种：null = 弹窗关着。模板上直接拿它当 v-if */
  const genPlacement = ref<KeyframePlacement | null>(null)
  /** 重出时被替换的那张（落库成功后删掉，避免同帧两张） */
  const genReplaceId = ref<ID | null>(null)
  const genFrameIdx = ref(0)
  /**
   * 正在出图的那条素材（按这条素材自己的提示词出图时才用）。
   *
   * 和 genPlacement 同时存在：placement 决定新图落在第几帧，这条记录决定
   * 「用哪句提示词、挂哪几张参考图、原来是不是参考方式」。
   */
  const genAsset = ref<Asset | null>(null)

  function clearGen() {
    genPlacement.value = null
    genReplaceId.value = null
    genAsset.value = null
    genFrameIdx.value = 0
  }

  function openGen(placement: KeyframePlacement, replace?: Asset) {
    genAsset.value = null
    genPlacement.value = placement
    genReplaceId.value = replace?.id ?? null
    genFrameIdx.value = Number(replace?.frameIdx ?? Math.round(ctx.lastFrame() / 2)) || 0
  }

  /**
   * 按一条素材自己的提示词出图（草稿也行）。
   *
   * 草稿没有"被替换的旧图"：出图成功后它自己消失，换成一条真素材；
   * 已有图重出走的是同一套替换逻辑（先删旧再写新）。
   */
  function openGenForAsset(asset: Asset) {
    genAsset.value = asset
    const placement = asset.draft ? 'head' : placementOf(asset)
    genPlacement.value = placement
    genReplaceId.value = asset.draft ? null : asset.id
    // 草稿落在「指定帧」时，frameIdx 默认是 0 —— 那会和段首那张撞同一帧
    // （打包时只认一张）。落到中间帧，两张都能留下。
    const mid = Math.round(ctx.lastFrame() / 2)
    genFrameIdx.value =
      asset.draft && placement === 'at' ? mid : Number(asset.frameIdx ?? 0) || 0
  }

  function closeGen() {
    clearGen()
  }

  /** 这一段所在场景的总图（没有就 null） */
  const plateAsset = computed<Asset | null>(() => {
    const beat = beats.ordered.find((b) => b.id === ctx.beatId())
    const sceneId = beat?.sceneId
    return sceneId ? registry.plateFor(sceneId) : null
  })

  /**
   * 图生图的底图：同位置已有图就用它；出尾帧时退而用段首，尽量接得上。
   * 重出某一张时用它自己 —— 拿别的图当底，出来的构图会跑。
   *
   * 都没有时用**本场总图**：这一版关键帧只有"按总图编辑"这一条路，
   * 不能空着底图让它退回纯文生图。
   */
  const genBaseUrl = computed(() => {
    // 按素材出图：草稿本来就没图，不能拿它的 fileName 拼一个 404 的 URL
    const own = genAsset.value
    if (own) return own.draft ? null : registry.assetUrl(own)
    const p = genPlacement.value
    if (!p) return null
    const kfs = ctx.keyframes()
    const replace = kfs.find((a) => a.id === genReplaceId.value)
    if (replace) return registry.assetUrl(replace)
    const same = kfs.find((a) => placementOf(a) === p)
    if (same) return registry.assetUrl(same)
    if (p === 'tail') {
      const head = kfs.find((a) => placementOf(a) === 'head')
      if (head) return registry.assetUrl(head)
    }
    return plateAsset.value ? registry.assetUrl(plateAsset.value) : null
  })

  /**
   * 默认提示词。
   *
   * 按素材出图时用**这条素材自己的**那句（正文 + 参考图引用段）；
   * 从按钮直接出图时退回老路子：按本场总图编辑这一镜。
   */
  const genPrompt = computed(() => {
    if (genAsset.value) return images.materialPrompt(genAsset.value)
    return genPlacement.value
      ? images.plateEditPromptFor(ctx.beatId()) || images.keyframePrompt(ctx.beatId(), genPlacement.value)
      : ''
  })

  /**
   * 默认勾哪些参考图。
   *
   * 按素材出图：它自己勾过的那几张。
   * 从按钮直接出图：有总图就**只勾总图**（人物已经在图里，再塞人像会串脸）；
   * 没有总图才退回空 —— 那一行提示词也会退回纯文本模板。
   */
  const genDefaultRefs = computed<ID[]>(() => {
    if (genAsset.value) return [...(genAsset.value.refAssetIds ?? [])]
    return plateAsset.value ? [plateAsset.value.id] : []
  })

  async function onGenerated(blob: Blob, prompt?: string, pickedRefs?: ID[]) {
    const placement = genPlacement.value ?? 'head'
    const asset = genAsset.value
    try {
      // 草稿没有旧图（genReplaceId 为 null）；已有素材重出时先删旧的
      if (genReplaceId.value) await registry.removeAsset(genReplaceId.value)
      await images.attachBeatKeyframe(
        ctx.beatId(),
        blob,
        placement,
        placement === 'at' ? genFrameIdx.value : undefined,
        prompt,
        asset
          ? {
              actAs: actAsOf(asset),
              // 正文存素材自己那份：弹窗里临时改的那句只属于"这一次出图"，
              // 不该反过来改写素材（用户下次打开素材编辑器会认不出自己的句子）
              prompt: images.materialPromptBody(asset),
              promptBrief: asset.promptBrief,
              // 用户在弹窗里加了 / 去掉了参考图，以那一刻勾的为准
              refAssetIds: pickedRefs ?? asset.refAssetIds
            }
          : undefined
      )
      // 草稿出图后自己要让位：留着会变成一条没有图、却占着提示词的空条目
      if (asset?.draft) await registry.removeAsset(asset.id)
      message.success(`已合成${PLACEMENT_LABEL[placement]}关键帧`)
      ctx.onDone?.()
    } catch (e) {
      message.error((e as Error).message || '保存失败')
    } finally {
      closeGen()
    }
  }

  return {
    genPlacement,
    genFrameIdx,
    genAsset,
    genBaseUrl,
    genPrompt,
    genDefaultRefs,
    openGen,
    openGenForAsset,
    closeGen,
    onGenerated
  }
}
