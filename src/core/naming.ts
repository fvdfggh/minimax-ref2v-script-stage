/**
 * 名字去重。
 *
 * 由来：模板和运行配置都是一列可复制的条目，而列表里只有名字能区分它们。
 * 之前「新建」「复制」「导入」都给同一个名字，「H3 一采（自动导入）」能堆六个、
 * 「e2e 双卡」也能堆六个 —— 左栏变成一列无法辨认的重复项，用户没得选。
 *
 * 这里不追求聪明（不会去查"哪个才是真的"），只保证**同一张列表里名字唯一**。
 * 编号从 2 开始并跳过已占用的号：已有 (2) 时给 (3)，删掉 (2) 后再建还是 (2)，
 * 不会一路涨到 (17) —— 那比重复更让人迷惑。
 */

const TRAILING_INDEX = /^(.*?)\s*\((\d+)\)$/

/** 在一批已有名字里给 base 找一个不重复的名字。 */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set<string>()
  for (const t of taken) set.add(String(t ?? '').trim())

  const name = String(base ?? '').trim() || '未命名'
  if (!set.has(name)) return name

  const m = TRAILING_INDEX.exec(name)
  const root = (m ? m[1] : name).trim() || '未命名'
  let i = m ? Number(m[2]) + 1 : 2
  // 上限只是防御：真到 999 说明这用户该整理列表了，不能在这里死循环。
  while (i < 1000 && set.has(`${root} (${i})`)) i += 1
  return `${root} (${i})`
}

/**
 * 给一整批条目重新分配名字，返回 id → 新名字（只包含需要改的）。
 *
 * 用途是收拾**存量**：去重只对"以后新建的"有效，而历史数据里已经躺着一堆
 * 同名条目（比如六个「e2e 双卡」）。这类数据不能靠猜测合并 —— 它们内容可能
 * 完全不同 —— 只能按出现顺序加序号，让用户能指着说"我要第二个"。
 */
export function dedupeBatch<T extends { id: string; name: string }>(
  items: readonly T[]
): Map<string, string> {
  const used = new Set<string>()
  const plan = new Map<string, string>()
  for (const it of items) {
    const base = String(it.name ?? '').trim() || '未命名'
    let name = base
    if (used.has(name)) {
      let i = 2
      while (i < 1000 && used.has(`${base} (${i})`)) i += 1
      name = `${base} (${i})`
      plan.set(it.id, name)
    }
    used.add(name)
  }
  return plan
}
