/**
 * 段产物的展示文案（纯函数，好测、好复用到段列表与段详情）。
 */
import type { PassOutput } from '@/stores/outputs'

/** 一采/二采在某一遍上的状态短语 */
export function passLabelText(
  p: PassOutput,
  which: 'first' | 'second',
  canSecond = false
): string {
  if (p.hasClip) return '已出片'
  if (p.hasFrames) return '有帧缓存（未编码）'
  if (p.hasLatent) return which === 'second' ? '已二采（latent 在）' : '仅 latent'
  if (which === 'second') {
    // 二采没片时**必须说清原因**：不是"没做"，多半是连一采 latent 都没有
    return canSecond ? '可二采，还没跑' : '无一采 latent'
  }
  return '未渲染'
}

/**
 * 二采能不能跑：**硬前提是一采 latent 在**。
 *
 * 二采是在一采那份 latent 上再采一遍，不是凭空重新生成。一采 latent 不在了
 * （只留了成片、缓存被清过、段表换过一版），二采就无从跑起 —— 这时候让它
 * "可选"，用户勾上、点导出，只会拿到 0 个文件加一串跳过。
 *
 * 节点的 `second_sample_status` 本来也是按 `hasLatent` 算 `canSecondSample`
 * 的，但它可能是上一次探测留下的旧结果，而一采状态我们手上就有：两边一起判，
 * 才不会被旧结果带偏。
 *
 * `node` 缺省（老节点没这个端点）时只认一采 latent —— 有一采 latent 就允许跑。
 */
export function canSecondSampleOf(
  first: PassOutput,
  node?: { hasLatent: boolean; canSecondSample: boolean }
): boolean {
  const hasFirstLatent = first.hasLatent || !!node?.hasLatent
  if (!hasFirstLatent) return false
  // 一采 latent 在，再看节点有没有别的前置条件（文本条件等）；没这条结果就算通过
  return node ? !!node.canSecondSample : true
}

/**
 * 二采这一段的格子**能不能勾**。
 *
 * 分两种"能"：
 *   · 二采自己已经有缓存（片/帧/latent 在磁盘上）—— 导出是读文件，不需要
 *     一采 latent，一采缓存被清过也照样能导；
 *   · 二采还没产物 —— 那就必须有一采 latent 才能跑，否则这段是死的。
 */
export function secondSelectable(row: {
  first: PassOutput
  second: PassOutput
  canSecondSample: boolean
}): boolean {
  if (row.second.hasClip || row.second.hasFrames || row.second.hasLatent) return true
  return row.canSecondSample
}

/** 状态徽标颜色 */
export function passToneOf(p: PassOutput): 'success' | 'warning' | 'default' {
  if (p.hasClip) return 'success'
  if (p.hasFrames || p.hasLatent) return 'warning'
  return 'default'
}

/**
 * 让 `<video>` 停在 0.1s 而不是 0s。
 *
 * `preload="metadata"` 只拉头部，画面是黑的 —— 用户得先点播放才知道这一段
 * 长什么样。加 `#t=0.1` 浏览器就会去 seek 一帧画出来，等于免费拿到封面图。
 * 只给播放器的 src 加，`打开` 链接仍用原地址。
 */
export function posterUrl(url: string): string {
  return url ? `${url}#t=0.1` : url
}

/** 段列表上的一行小结（有产物 / 只有缓存 / 什么都还没有） */
export function segProductHint(first: PassOutput, second: PassOutput): {
  text: string
  tone: 'success' | 'warning' | 'default'
} {
  if (first.hasClip || second.hasClip) {
    return {
      // 「一采+二采」只在**两遍都有成片**时才对。一采只采样不解码（仅 latent）
      // 而二采出了片，写「一采+二采」会让人以为一采也有可导出的像素 ——
      // 切到一采列导出才发现是空的。
      text: second.hasClip ? (first.hasClip ? '一采+二采' : '二采出片') : '一采出片',
      tone: 'success'
    }
  }
  if (first.hasFrames || second.hasFrames || first.hasLatent || second.hasLatent) {
    return { text: '仅缓存', tone: 'warning' }
  }
  return { text: '未渲染', tone: 'default' }
}
