/**
 * 台词配音：把「台词文字 + 说话人的固定音色」变成一条可用的段内音频素材。
 *
 * 抽成纯函数的原因很实际 —— 这件事有两个调用点：
 *   卡片上给单个镜头配一句（EnrichBeatCard）
 *   整页给所有能配的镜头批量配（StageEnrich）
 * 两边如果各判一遍"能不能配"，迟早会出现"卡片能点、批量跳过了它"这种
 * 说不清的不一致。判定只写在这里，两边都调它。
 *
 * 谁能配（缺一不可）：台词镜头 · 有台词 · 有说话人 · 说话人已固定音色包。
 */

import type { Asset, Beat, Entity, ID } from './types'

/** 合成出来的音频素材统一打这个标签，重配时靠它找到上一版 */
export const VOICEOVER_LABEL = '台词配音'
/** 文件名前缀：老数据可能没 label，靠名字也能认出来 */
export const VOICEOVER_PREFIX = 'voice_'

export function isVoiceover(a: Asset): boolean {
  return (
    a.media === 'audio' &&
    (a.label === VOICEOVER_LABEL || (a.originalName ?? '').startsWith(VOICEOVER_PREFIX))
  )
}

export function hasVoiceover(assets: Asset[], beatId: ID): boolean {
  return assets.some((a) => a.refId === beatId && isVoiceover(a))
}

/**
 * 台词段该不该**自带一格待配音**。
 *
 * 台词段天生有一句话要说：不给它一格，用户就得先点「＋音频配置」、再把台词
 * 抄一遍 —— 那一步没有任何信息增量。所以台词段一出现就带一格空的配音配置，
 * 文本已经对齐台词、音色取说话人，点开就能改、点「合成」就能出声。
 *
 * 四种情况不再建：
 *   已经有音频（不管是不是台词配音 —— 用户可能自己传了一条）
 *   已经有音频格（占位还在，别叠第二格）
 *   台词是空的（没话可说）
 *   用户删过（voiceSkipped：有人就是要留白，删了又建回来等于删不掉）
 */
export function needsVoiceSlot(beat: Beat, assets: Asset[]): boolean {
  if (beat.kind !== 'dialogue') return false
  if (beat.voiceSkipped) return false
  if (!(beat.dialogue ?? '').trim()) return false
  /*
   * 只数**走时间轴**的音频：一条"只借音色"的参考音频不替这一段说话，
   * 拿它当"已经配过了"会让台词段永远缺那格配音。
   */
  return !assets.some(
    (a) =>
      a.refId === beat.id &&
      a.media === 'audio' &&
      a.actAs !== 'reference' &&
      (a.draft || a.kind === 'material')
  )
}

export interface VoiceoverTarget {
  beat: Beat
  speaker: Entity
  voiceId: string
  text: string
}

export interface VoiceoverCheck {
  target: VoiceoverTarget | null
  /** 配不了的原因，直接给界面当提示用（能配时为 null） */
  reason: string | null
}

/**
 * 能不能给这个镜头配音。
 *
 * 注意"说话人没固定音色"要**明说**：界面据此把按钮置灰并解释去哪固定，
 * 而不是点了没反应，或者偷偷换一个默认声音。
 */
export function voiceoverCheck(
  beat: Beat,
  entityById: Map<ID, Entity>
): VoiceoverCheck {
  if (beat.kind !== 'dialogue') return { target: null, reason: '只有台词镜头能配音' }
  const text = (beat.dialogue ?? '').trim()
  if (!text) return { target: null, reason: '这个镜头还没有台词' }
  const speaker = beat.speakerId ? entityById.get(beat.speakerId) : undefined
  if (!speaker) return { target: null, reason: '先选说话人' }
  if (!speaker.voicePack) {
    return { target: null, reason: `「${speaker.name}」还没固定音色：去「主体登记」里按描述设计一条并固定` }
  }
  return {
    target: { beat, speaker, voiceId: speaker.voicePack.id, text },
    reason: null
  }
}

/**
 * 批量配音的队列。
 *
 * ready    —— 能配、且这一遍还没配过的（已有配音的不重配，避免手滑把调好的覆盖掉）
 * voiced   —— 已经有配音的镜头数
 * blocked  —— 想配但配不了（台词没写 / 说话人没固定音色…）
 */
export function voiceoverQueue(
  beats: Beat[],
  entityById: Map<ID, Entity>,
  assets: Asset[]
): { ready: VoiceoverTarget[]; voiced: number; blocked: number } {
  const ready: VoiceoverTarget[] = []
  let voiced = 0
  let blocked = 0
  for (const beat of beats) {
    const check = voiceoverCheck(beat, entityById)
    if (!check.target) {
      // 没台词的动作段不算"受阻"，它本来就不该有配音
      if (beat.kind === 'dialogue') blocked += 1
      continue
    }
    if (hasVoiceover(assets, beat.id)) {
      voiced += 1
      continue
    }
    ready.push(check.target)
  }
  return { ready, voiced, blocked }
}
