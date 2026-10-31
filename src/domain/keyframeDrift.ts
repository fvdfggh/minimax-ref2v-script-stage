/**
 * 关键帧"过期"判定：这张图还是不是这一段现在的样子。
 *
 * 起因很具体：出图之后回头改台词、改画面描述、换场景、改人物外观，
 * 图本身不会变 —— 但导演台还是把它当这一帧的锚点。等到跑视频才发现
 * 画面和台词对不上，代价就大了。所以出图那一刻把"当时的样子"记下来，
 * 之后每次渲染都拿现在比一次，不一致就在卡片上标出来。
 *
 * 比的是**模板提示词**（genContext），不是用户手改的那句：
 * 手改只影响那一张图，不是这段内容变了；拿整句比会把"自己润色过"
 * 也判成失效，那就天天报警告了。
 */
import type { Asset } from './types'

/** 这一段"现在"的样子 */
export interface KeyframeNow {
  /** 现在的模板提示词（调用方传 keyframePrompt(beatId, 'at')） */
  context: string
  /** 现在的台词 / 语音文本 */
  dialogue: string
}

export interface KeyframeDrift {
  /** 画面提示词（画面描述 / 运镜 / 场景 / 主体外观）变过 */
  prompt: boolean
  /** 语音文本变过 */
  voice: boolean
  /** 任一失效 */
  any: boolean
  /** 有溯源可比。上传的图、早期老数据没有，不报失效 */
  known: boolean
  /** 一句话说明，直接丢进 tooltip */
  text: string
}

const NONE: KeyframeDrift = { prompt: false, voice: false, any: false, known: false, text: '' }

/**
 * 空白折叠后再比：多打一个空格、多一个换行不该算"内容变了"。
 * 中文台词里换行很常见（阶段一按句断行），不折一下几乎每条都会误报。
 */
function norm(s: string | undefined | null): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

export function keyframeDrift(a: Asset, now: KeyframeNow): KeyframeDrift {
  if (a.kind !== 'keyframe') return NONE
  // 没有溯源：不知道当时按什么出的，就不能说它"过期"
  if (a.genContext === undefined && a.genDialogue === undefined) return NONE

  // genContext 缺省时不判提示词（老数据只补了台词快照的情况）
  const prompt = a.genContext !== undefined && norm(a.genContext) !== norm(now.context)
  const voice = a.genDialogue !== undefined && norm(a.genDialogue) !== norm(now.dialogue)

  const bits: string[] = []
  if (prompt) bits.push('画面提示词已变（画面描述 / 运镜 / 场景 / 人物外观）')
  if (voice) bits.push('语音文本已变')
  const text = bits.length
    ? `${bits.join('，')}：这张图还是旧的，建议按现在的文本重出`
    : ''

  return { prompt, voice, any: prompt || voice, known: true, text }
}

/** 一批资产里已经失效的那些（给"选出失效"这类批量操作数数用） */
export function driftedAssets(assets: Asset[], now: KeyframeNow): Asset[] {
  return assets.filter((a) => keyframeDrift(a, now).any)
}
