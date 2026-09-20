export type DiffOp = 'same' | 'add' | 'del'

export interface DiffLine {
  op: DiffOp
  text: string
}

/** 文本太大时退化成整段替换，避免 O(n·m) 的表把页面卡死 */
const MAX_LINES = 400

/**
 * 行级 LCS diff，用来预览 AI 改写的字段内容。
 * 只依赖行数，几行到几十行的提示词字段完全够用。
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = (before ?? '').split('\n')
  const b = (after ?? '').split('\n')

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text) => ({ op: 'del' as DiffOp, text })),
      ...b.map((text) => ({ op: 'add' as DiffOp, text }))
    ]
  }

  const n = a.length
  const m = b.length
  // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: 'del', text: a[i] })
      i++
    } else {
      out.push({ op: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) out.push({ op: 'del', text: a[i++] })
  while (j < m) out.push({ op: 'add', text: b[j++] })
  return out
}

export interface DiffStat {
  added: number
  removed: number
  changed: boolean
}

export function diffStat(lines: DiffLine[]): DiffStat {
  const added = lines.filter((l) => l.op === 'add').length
  const removed = lines.filter((l) => l.op === 'del').length
  return { added, removed, changed: added > 0 || removed > 0 }
}
