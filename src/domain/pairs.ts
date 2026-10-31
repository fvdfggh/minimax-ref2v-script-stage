import { fingerprint } from './cascade'
import type {
  FieldBaseline,
  FieldPair,
  FieldPairMap,
  FieldSide,
  FieldSync,
  ID,
  Lang
} from './types'

/* ------------------------------------------------------------------ *
 * 字段的中英双份
 *
 * 一条规则：中文是工作稿，英文是终稿，谁都不能覆盖谁。
 * 谁落后了由三方指纹决定：中文内容、英文内容、这一段引用的片段与实体。
 * 只比时间戳会把「重新保存了一次」当成「内容改了」，所以内容本身也要留指纹。
 * ------------------------------------------------------------------ */

export const CJK_ANY_RE = /[\u4e00-\u9fff]/

export function sideOf(pair: FieldPair | undefined, lang: Lang): FieldSide | undefined {
  return lang === 'zh' ? pair?.zh : pair?.en
}

export function valueOfSide(pair: FieldPair | undefined, lang: Lang): string {
  return (sideOf(pair, lang)?.v ?? '').trim()
}

/** 内容指纹：空白差异不算改动，否则一次格式化就会把整页标红 */
export function contentHash(text: string | undefined): string {
  return fingerprint((text ?? '').trim().replace(/\s+/g, ' '))
}

/**
 * 某一侧的指纹。
 *
 * 早期数据没有存 `h`，按当前内容现算 —— 这样迁移过来的字段第一次也能
 * 参与比较，不会因为缺字段被一律当成「变过」。
 */
export function hashOfSide(side: FieldSide | undefined): string {
  const v = (side?.v ?? '').trim()
  if (!v) return ''
  return side?.h || contentHash(v)
}

/** 引用指纹：段内片段与实体的指纹；空串表示调用方没提供，不参与判定 */
export function hashOfSource(srcHash: string | undefined): string {
  return (srcHash ?? '').trim()
}

/**
 * 两侧的同步状态。
 *
 * `srcHash` 是这一段**当前**的内容指纹。给了它，才能判断引用有没有变过：
 * 上游改了一个片段、改了某个主体的外观，这一段的两份稿子就都过期了 ——
 * 而且这个变化跟"哪一侧更新"无关，两侧都得重做。
 */
export function syncOf(pair: FieldPair | undefined, srcHash?: string): FieldSync {
  const zh = valueOfSide(pair, 'zh')
  const en = valueOfSide(pair, 'en')
  if (!zh && !en) return 'empty'

  const base = pair?.synced
  const src = hashOfSource(srcHash)
  if (base && src && src !== base.src) return 'src-newer'

  if (!zh && en) return 'en-only'
  if (zh && !en) return 'zh-only'

  if (base) {
    const zhChanged = hashOfSide(pair?.zh) !== base.zh
    const enChanged = hashOfSide(pair?.en) !== base.en
    // 两侧都被改过：没有"变化点"，不能自动对齐任何一边，必须人来定
    if (zhChanged && enChanged) return 'conflict'
    if (zhChanged) return 'zh-newer'
    if (enChanged) return 'en-newer'
    return 'both'
  }

  // 没有基线（老数据 / 手工写入）：只能退回时间戳
  const zAt = pair?.zh?.at ?? 0
  const eAt = pair?.en?.at ?? 0
  if (zAt > eAt) return 'zh-newer'
  if (eAt > zAt) return 'en-newer'
  return 'both'
}

/** 这一侧是否落后于另一侧（界面据此标红） */
export function isBehind(state: FieldSync, lang: Lang): boolean {
  switch (state) {
    case 'src-newer':
      return true
    case 'conflict':
      return true
    case 'zh-newer':
      return lang === 'en'
    case 'en-newer':
      return lang === 'zh'
    default:
      return false
  }
}

/** 这一刻的三方指纹，作为"已对齐"的凭据 */
export function baselineOf(pair: FieldPair | undefined, srcHash: string, at: number): FieldBaseline {
  return {
    zh: hashOfSide(pair?.zh),
    en: hashOfSide(pair?.en),
    src: hashOfSource(srcHash),
    at
  }
}

/**
 * 旧数据迁移：原来只有一份内容，不知道它当初是什么语言 —— 按内容判断。
 *
 * 含中文的归 zh，纯英文的归 en。at = 0 表示"不知道确切时间"，
 * 之后任何一次真实写入都会让它变成落后的一侧。
 */
export function migrateLegacyPairs(
  overrides: Record<ID, Record<string, string>> | null | undefined,
  summaries: Record<ID, string> | null | undefined
): FieldPairMap {
  const out: FieldPairMap = {}
  const put = (gid: string, key: string, raw: string) => {
    const v = (raw ?? '').trim()
    if (!v) return
    const lang: Lang = CJK_ANY_RE.test(v) ? 'zh' : 'en'
    out[gid] = out[gid] ?? {}
    out[gid][key] = { [lang]: { v, at: 0, h: contentHash(v) } } as FieldPair
  }
  for (const [gid, bag] of Object.entries(overrides ?? {})) {
    for (const [key, v] of Object.entries(bag)) put(gid, key, v)
  }
  for (const [gid, v] of Object.entries(summaries ?? {})) put(gid, 'summary', v)
  return out
}

/** 写入一份内容，返回新的 pair（不改原对象） */
export function withSide(pair: FieldPair | undefined, lang: Lang, value: string, at: number): FieldPair {
  return { ...(pair ?? {}), [lang]: { v: value, at, h: contentHash(value) } }
}
