/**
 * 「待合成占位」的跑法：图片合成 / 语音合成。
 *
 * 为什么抽出来：同一件事现在有两个入口 ——
 *   卡片上的「保存并出图 / 保存并配音」（一格一格来）
 *   页面顶部的「批量出图 / 批量合成」（一次跑完所有配置好的格子）
 * 各写一份的话，"合成完要不要删占位 / 要不要按音频改帧数 / 落第几帧"迟早两套口径。
 * 所以真正的动作只在这里：`synthOne` 一格音频，`runGen` 一批图片。
 *
 * 两条共同点：
 *   1. **占位是有内容的草稿**（asset.draft）：跑完用真素材替换它，不留空气条目；
 *   2. **落点是它自己配的那一帧**：图片落 frameOf（段首 / 段尾 / 指定帧都折算成
 *      具体帧号），音频从 materialFrameOf 起生效 —— 这正是"内部配置"与"外部
 *      时间轴"对齐的地方。
 */
import { computed, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { useImageStore } from '@/stores/images'
import { voiceSpeak } from '@/core/voice'
import { VOICEOVER_LABEL } from '@/domain/voiceover'
import { secondsLabel, speechFitOf, speechFramePatch } from '@/domain/audioFrames'
import { beatFrames } from '@/domain/timing'
import { actAsOf, frameOf, materialFrameOf } from '@/domain/references'
import type { Asset, Beat } from '@/domain/types'

/** 一格占位 + 它属于哪一段 */
export interface SlotPair {
  slot: Asset
  beat: Beat
}

export interface SlotRunResult {
  total: number
  ok: number
  fail: number
  firstErr: string
}

const EMPTY: SlotRunResult = { total: 0, ok: 0, fail: 0, firstErr: '' }

export function useSlotBatch() {
  const project = useProjectStore()
  const beats = useBeatStore()
  const registry = useRegistryStore()
  const images = useImageStore()
  const message = useMessage()

  const settings = computed(() => project.settings)

  /* ------------------------------ 语音 ------------------------------ */

  const synthing = ref(false)
  const synthDone = ref(0)
  const synthTotal = ref(0)

  /**
   * 按一格的配置合成语音。成功返回新落库的音频素材，失败抛错（调用方决定怎么说）。
   *
   * 帧长只在**落时间轴**的那一格上跟着音频改：参考语音不占时间轴，
   * 拿它去改段长会把一段画面无缘无故拉长。
   */
  async function synthOne(slot: Asset, beat: Beat): Promise<Asset> {
    const speaker = slot.voiceSpeakerId ? registry.entityById.get(slot.voiceSpeakerId) : undefined
    const text = (slot.voiceText ?? '').trim()
    if (!text) throw new Error('这格还没写要念的文本')
    if (!speaker?.voicePack) throw new Error('这格还缺音色：先选一个已固定音色的说话人')

    const frames = beatFrames(beat, settings.value)
    const onTimeline = actAsOf(slot) === 'keyframe'
    const blob = await voiceSpeak(speaker.voicePack.id, text)
    const file = new File([blob], `voice_${speaker.voicePack.id}.wav`, { type: 'audio/wav' })
    const asset = await registry.addBeatAsset(beat.projectId, beat.id, file, {
      kind: 'material',
      actAs: actAsOf(slot),
      frameIdx: materialFrameOf(slot, frames),
      label: onTimeline ? (beat.kind === 'dialogue' ? VOICEOVER_LABEL : '合成语音') : '参考语音'
    })
    // 占位让位：本体已经有了，留着它只会让人以为还要再合成一次
    await registry.removeAsset(slot.id)
    if (onTimeline) {
      const fit = speechFitOf(beat, registry.assets, settings.value)
      const framePatch = speechFramePatch(beat, fit)
      if (framePatch) await beats.updateBeat(beat.id, framePatch)
    }
    return asset
  }

  /** 一批音频格：一条一条来（语音服务本身不并发，并发只是排队 + 进度没法看） */
  async function runSynth(pairs: SlotPair[]): Promise<SlotRunResult | null> {
    if (synthing.value || !pairs.length) return null
    synthing.value = true
    synthTotal.value = pairs.length
    synthDone.value = 0
    let ok = 0
    let fail = 0
    let firstErr = ''
    try {
      for (const { slot, beat } of pairs) {
        try {
          await synthOne(slot, beat)
          ok += 1
        } catch (e) {
          fail += 1
          if (!firstErr) firstErr = e instanceof Error ? e.message : String(e)
        } finally {
          synthDone.value += 1
        }
      }
    } finally {
      synthing.value = false
    }
    if (fail) message.warning(`合成完成 ${ok} 格，${fail} 格失败：${firstErr}`)
    else message.success(`已合成 ${ok} 格语音，占位换成了真素材`)
    return { total: pairs.length, ok, fail, firstErr }
  }

  /* ------------------------------ 图片 ------------------------------ */

  const genning = ref(false)
  const genDone = ref(0)
  const genTotal = ref(0)

  /** 一格图片能用的参考图（按它自己存的那批；找不到的静默跳过） */
  function refsOf(beatId: string, ids?: string[]) {
    if (!ids?.length) return undefined
    const byKey = new Map(images.refCandidatesFor(beatId).map((c) => [c.key, c.ref]))
    const out = ids.map((id) => byKey.get(id)).filter((r): r is NonNullable<typeof r> => !!r)
    return out.length ? out : undefined
  }

  /**
   * 一批图片格：本地通道一次提交所有提示词（统一编码、逐张采样），
   * 云端通道在 images.generateBatch 里自动退化成逐条。
   *
   * 不在这里重算提示词：提示词就是这一格配置里那句（`materialPrompt` 会把
   * 它引用到的 <Picture N> 也拼上）—— 批量出的图和单张「保存并出图」出的
   * 必须是同一句，否则同一个配置出两次长两个样。
   */
  async function runGen(pairs: SlotPair[]): Promise<SlotRunResult | null> {
    if (genning.value || !pairs.length) return null
    genning.value = true
    genTotal.value = pairs.length
    genDone.value = 0
    let ok = 0
    let fail = 0
    let firstErr = ''
    try {
      const items = pairs.map(({ slot, beat }) => ({
        key: slot.id,
        prompt: images.materialPrompt(slot),
        refs: refsOf(beat.id, slot.refAssetIds)
      }))
      const results = await images.generateBatch(items, { size: '1280x720' })
      const byKey = new Map(results.map((r) => [r.key, r]))
      for (const { slot, beat } of pairs) {
        const res = byKey.get(slot.id)
        if (!res?.blob) {
          fail += 1
          if (!firstErr) firstErr = res?.error || '没有拿到图'
        } else {
          try {
            const frames = beatFrames(beat, settings.value)
            await images.attachBeatKeyframe(
              beat.id,
              res.blob,
              'at',
              frameOf(slot, frames),
              items.find((i) => i.key === slot.id)?.prompt,
              {
                actAs: actAsOf(slot),
                // 存正文：参考图引用段是按 refAssetIds 现拼的，不该固化进正文
                prompt: images.materialPromptBody(slot),
                promptBrief: slot.promptBrief,
                refAssetIds: slot.refAssetIds
              }
            )
            await registry.removeAsset(slot.id)
            ok += 1
          } catch (e) {
            fail += 1
            if (!firstErr) firstErr = e instanceof Error ? e.message : String(e)
          }
        }
        genDone.value += 1
      }
    } catch (e) {
      // 整批都起不来（没配工作流 / 没配供应商）：说清一句就够，别逐格报同一个错
      message.error(e instanceof Error ? e.message : '批量出图失败')
      return { ...EMPTY, total: pairs.length, fail: pairs.length, firstErr: String(e) }
    } finally {
      genning.value = false
    }
    if (fail) message.warning(`出图完成 ${ok} 张，${fail} 张失败：${firstErr}`)
    else message.success(`已按配置出图 ${ok} 张，占位换成了真素材`)
    return { total: pairs.length, ok, fail, firstErr }
  }

  /* ------------------------------ 进度文案 ------------------------------ */

  const genLabel = computed(() =>
    genning.value ? `出图 ${genDone.value}/${genTotal.value}` : ''
  )
  const synthLabel = computed(() =>
    synthing.value ? `合成 ${synthDone.value}/${synthTotal.value}` : ''
  )

  return {
    synthOne,
    runSynth,
    runGen,
    synthing,
    synthDone,
    synthTotal,
    synthLabel,
    genning,
    genDone,
    genTotal,
    genLabel,
    secondsLabel
  }
}
