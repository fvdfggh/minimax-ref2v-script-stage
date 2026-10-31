/**
 * ⚠️ 当前没有调用方（2026-10-30 起）。批量配音已改走 useSlotBatch.runSynth：
 * 台词段默认带一格「待配音」配置（文本对齐台词），批量就是把那些格子跑完 ——
 * 这一份"直接按 beat.dialogue 配"的老路径不再需要。留在这里是因为它把
 * "配完按音频改帧长"的分寸写得很清楚，删之前先确认没有别的地方要用。
 *
 * 台词配音的"跑一遍"。
 *
 * 判定「能不能配」在 domain/voiceover（voiceoverCheck / voiceoverQueue），
 * 这里只负责**真的跑**：合成 → 落成段内音频 → 按音频长度校正段帧数。
 *
 * 为什么抽成 composable 而不是留在页面里：现在有两个页面要做这件事 ——
 *   ② 细节填充（顺手把全片台词配掉）
 *   素材（这一页的主角就是图 + 音，配音按钮对单段和全片都要有）
 * 各写一份的话，"配到第几条 / 配完要不要改帧数 / 失败怎么报"迟早两套口径。
 *
 * 一条一条地配，不并发：s2 服务本身是单请求的，并发只会在它门口排队，
 * 还会让"配到第几条"变得没法显示。按钮上的 3/8 就是进度。
 *
 * 只配**还没有配音**的镜头（voiceoverQueue.ready 已排除），
 * 免得把用户已经调好起始帧的那条覆盖掉。
 */
import { computed, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { voiceSpeak } from '@/core/voice'
import { VOICEOVER_LABEL, isVoiceover, voiceoverCheck, voiceoverQueue } from '@/domain/voiceover'
import { secondsLabel, speechFitOf, speechFramePatch } from '@/domain/audioFrames'
import type { Beat } from '@/domain/types'

export interface VoiceRunResult {
  total: number
  ok: number
  fail: number
  firstErr: string
  /** 按配音调整过帧数的镜头数 */
  adjusted: number
}

export function useBatchVoiceover() {
  const project = useProjectStore()
  const beats = useBeatStore()
  const registry = useRegistryStore()
  const message = useMessage()

  const settings = computed(() => project.settings)
  const voicing = ref(false)
  const done = ref(0)
  const total = ref(0)

  /** 这批片段里：谁还能配、已配几条、几条配不了 */
  function queue(list: Beat[]) {
    return voiceoverQueue(list, registry.entityById, registry.assets)
  }

  /**
   * 跑一遍。传单段就是"给这一段配音"，传全片就是批量。
   * 返回 null 表示没有可配的（已配完 / 音色都没固定），提示已经给过了。
   *
   * force = true 时**连已经配过的也重配**（会先删掉上一版）：
   * 只用于"这一段重配"这种用户明确点了的动作 —— 批量绝不能带这个参数，
   * 否则手调过起始帧的那条会被悄悄覆盖。
   */
  async function runAll(list: Beat[], opts: { force?: boolean } = {}): Promise<VoiceRunResult | null> {
    if (voicing.value) return null
    const q = opts.force
      ? list
          .map((b) => voiceoverCheck(b, registry.entityById).target)
          .filter((t): t is NonNullable<typeof t> => !!t)
      : queue(list).ready
    if (!q.length) {
      message.info('没有需要配音的镜头：要么都配过了，要么说话人还没在「主体登记」里固定音色')
      return null
    }
    voicing.value = true
    total.value = q.length
    done.value = 0
    let fail = 0
    let firstErr = ''
    let adjusted = 0
    /** 其中超过单段上限的 */
    let overLimit = 0
    let longestSec = 0
    let longestFrames = 0
    try {
      for (const t of q) {
        try {
          const blob = await voiceSpeak(t.voiceId, t.text)
          // 重配时先删上一版：轨道上留两条一模一样的台词，只会让人不敢动
          for (const old of registry.materialsFor(t.beat.id).filter(isVoiceover)) {
            await registry.removeAsset(old.id)
          }
          const asset = await registry.addBeatAsset(
            t.beat.projectId,
            t.beat.id,
            new File([blob], `voice_${t.voiceId}.wav`, { type: 'audio/wav' }),
            { kind: 'material', frameIdx: 0, label: VOICEOVER_LABEL }
          )
          /*
           * 帧长以配音为准：字数估算在慢语速上会短，短了就把最后几个字切掉。
           * 没手动调过的直接换成音频长度；手调过的只补不足（分寸在 speechFramePatch）。
           */
          const fit = speechFitOf(t.beat, registry.assets, settings.value)
          const framePatch = speechFramePatch(t.beat, fit)
          if (framePatch) {
            await beats.updateBeat(t.beat.id, framePatch)
            adjusted += 1
            if (fit?.plan.overLimit) overLimit += 1
            const sec = asset.durationSec ?? 0
            if (sec > longestSec) {
              longestSec = sec
              longestFrames = framePatch.estFrames
            }
          }
        } catch (e) {
          fail += 1
          if (!firstErr) firstErr = e instanceof Error ? e.message : String(e)
        } finally {
          done.value += 1
        }
      }
    } finally {
      voicing.value = false
    }

    if (fail) {
      message.warning(`配音完成 ${q.length - fail} 条，${fail} 条失败：${firstErr}`)
    } else {
      message.success(
        `已为 ${q.length} 个镜头合成台词音频` +
          (adjusted
            ? `，${adjusted} 个按配音调整了帧数（最长一句 ${secondsLabel(longestSec)}，${longestFrames} 帧）`
            : '，帧数都够用')
      )
    }
    if (overLimit) {
      message.warning(
        `${overLimit} 个镜头按配音算超过单段 ${settings.value.maxSegmentFrames} 帧，组合时会被拆成多段`
      )
    }
    return {
      total: q.length,
      ok: q.length - fail,
      fail,
      firstErr,
      adjusted
    }
  }

  return { voicing, done, total, queue, runAll, settings }
}
