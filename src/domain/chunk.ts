/* ------------------------------------------------------------------ *
 * 分批（chunking）
 *
 * 单次请求要模型产出太多内容时，质量会掉、还容易中途截断。
 * 这里提供两种切分粒度：
 *   - splitStory  按「原文自然段」聚合到约 N 字符，把输入也一起分批；
 *                 这直接决定了阶段①的单次输出量（输出量由输入范围决定，
 *                 所以只限制输出个数是不安全的，会丢内容）
 *   - chunkBy     只切列表，输入侧不丢信息，用于阶段②⑤
 * ------------------------------------------------------------------ */

/** 单段超过这个长度就按句末标点再切 */
const MAX_PARAGRAPH_CHARS = 600

/** 把故事切成自然段；过长的段落按句末标点细分 */
export function splitParagraphs(story: string): string[] {
  const text = story.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (!text) return []

  const raw = text
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean)

  const out: string[] = []
  for (const p of raw) {
    if (p.length <= MAX_PARAGRAPH_CHARS) {
      out.push(p)
      continue
    }
    // 中文句末标点 / 英文句末标点，保留标点本身
    const sentences = p.split(/(?<=[。！？；!?;])/).filter((s) => s.trim())
    let buf = ''
    for (const s of sentences) {
      if (buf && (buf + s).length > MAX_PARAGRAPH_CHARS) {
        out.push(buf.trim())
        buf = s
      } else {
        buf += s
      }
    }
    if (buf.trim()) out.push(buf.trim())
  }
  return out
}

export interface StoryChunk {
  /** 批序号，0 起 */
  index: number
  /** 本批的原文（多段用空行连接） */
  text: string
  /** 本批覆盖的段落范围（1 起，闭区间） */
  paraFrom: number
  paraTo: number
  /** 本批包含的段落数 */
  paragraphs: number
}

/**
 * 按原文长度分批。每批尽量凑到 maxChars，但不会把单个段落切开
 * （除单段本身就超长的情况）。
 */
export function splitStory(story: string, maxChars = 1500): StoryChunk[] {
  const paras = splitParagraphs(story)
  if (!paras.length) return []

  const size = Math.max(300, Math.round(maxChars))
  const chunks: StoryChunk[] = []
  let buf: string[] = []
  let from = 1
  let charCount = 0

  const flush = (to: number) => {
    if (!buf.length) return
    chunks.push({
      index: chunks.length,
      text: buf.join('\n\n'),
      paraFrom: from,
      paraTo: to,
      paragraphs: buf.length
    })
    buf = []
    from = to + 1
    charCount = 0
  }

  paras.forEach((p, i) => {
    // 单段超长：自己单独成批，不要和前一段挤在一起
    if (buf.length && charCount + p.length > size) flush(i)
    buf.push(p)
    charCount += p.length + 2
    if (charCount >= size || i === paras.length - 1) flush(i + 1)
  })

  return chunks
}

/** 把列表按固定大小切批（输入侧不丢信息） */
export function chunkBy<T>(list: T[], size: number): T[][] {
  const n = Math.max(1, Math.round(size) || 1)
  if (!list.length) return []
  if (list.length <= n) return [list]
  const out: T[][] = []
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
  return out
}

/** 按每批片段数反推原文长度，供界面给出直观提示 */
export const CHARS_PER_BEAT_HINT = 120
