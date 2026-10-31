import { describe, expect, it } from 'vitest'
import { alignText, batchOf, collectSyncItems, statsOf, type SyncFieldMeta } from './fieldSync'
import type { FieldSync } from './types'

/* ------------------------------------------------------------------ *
 * 同步清单：谁是变化点，谁向谁对齐
 * ------------------------------------------------------------------ */

const FIELDS: SyncFieldMeta[] = [
  { key: 'summary', label: '段落概述', source: 'llm' },
  { key: 'overall_soundscape', label: '整体声景', source: 'llm' },
  { key: 'non_diegetic_music', label: '非叙事配乐', source: 'llm' },
  { key: 'subject_definitions', label: '主体定义', source: 'derived' }
]

function seg(
  sync: Record<string, FieldSync>,
  extra: { segNo?: number; stale?: boolean; srcNote?: string } = {}
) {
  return {
    groupId: 'g1',
    segNo: extra.segNo ?? 1,
    zh: { summary: '中文稿' } as Record<string, string>,
    en: { summary: 'english draft' } as Record<string, string>,
    sync,
    stale: extra.stale ?? false,
    srcNote: extra.srcNote
  }
}

describe('同步清单：分类', () => {
  it('中文改了 → 英文对齐中文，动作是重译', () => {
    const items = collectSyncItems([seg({ summary: 'zh-newer' })], FIELDS)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      fieldKey: 'summary',
      changed: 'zh',
      align: 'en',
      steps: ['translate'],
      needsManual: false
    })
    expect(alignText(items[0])).toBe('英文对齐中文')
  })

  it('英文改了 → 中文对齐英文，动作是回写中文', () => {
    const items = collectSyncItems([seg({ summary: 'en-newer' })], FIELDS)
    expect(items[0]).toMatchObject({ changed: 'en', align: 'zh', steps: ['backtranslate'] })
    expect(alignText(items[0])).toBe('中文对齐英文')
  })

  it('★ 引用变了 → 没有非变化的一侧，两份都要按新素材重做', () => {
    const items = collectSyncItems(
      [seg({ summary: 'src-newer' }, { srcNote: '第 2 拍的画面描述改了' })],
      FIELDS
    )
    expect(items[0]).toMatchObject({
      changed: 'src',
      align: 'both',
      steps: ['regen', 'translate']
    })
    expect(items[0].reason).toContain('第 2 拍')
    expect(alignText(items[0])).toBe('两份都按新素材重做')
  })

  it('只有一侧有内容 → 补另一侧，不算"冲突"', () => {
    const zhOnly = collectSyncItems([seg({ summary: 'zh-only' })], FIELDS)[0]
    expect(zhOnly).toMatchObject({ changed: 'zh', align: 'en', steps: ['translate'] })
    const enOnly = collectSyncItems([seg({ summary: 'en-only' })], FIELDS)[0]
    expect(enOnly).toMatchObject({ changed: 'en', align: 'zh', steps: ['backtranslate'] })
  })

  it('两侧都改过 → 不自动动，标为待人工', () => {
    const items = collectSyncItems([seg({ summary: 'conflict' })], FIELDS)
    expect(items[0].needsManual).toBe(true)
    expect(items[0].steps).toEqual([])
  })

  it('对齐的字段不进清单', () => {
    expect(collectSyncItems([seg({ summary: 'both' })], FIELDS)).toHaveLength(0)
    expect(collectSyncItems([seg({ summary: 'empty' })], FIELDS)).toHaveLength(0)
  })

  it('派生字段永远不进清单（引擎按词条各算一遍）', () => {
    const items = collectSyncItems([seg({ subject_definitions: 'zh-newer' })], FIELDS)
    expect(items).toHaveLength(0)
  })
})

describe('同步清单：引用变化的兜底', () => {
  it('没有逐字段状态、但段过期了 → 有内容的字段都算引用变化', () => {
    const items = collectSyncItems([seg({}, { stale: true })], FIELDS)
    // summary 两侧都有内容 → 一条；其它字段没有内容 → 不收
    expect(items).toHaveLength(1)
    expect(items[0].changed).toBe('src')
  })

  it('段过期但字段两侧都空 → 不收', () => {
    const s = seg({}, { stale: true })
    s.zh = {}
    s.en = {}
    expect(collectSyncItems([s], FIELDS)).toHaveLength(0)
  })
})

describe('同步清单：引用变化压过时间戳', () => {
  it('★ 两份都有内容、但引用变了 → 不再按"谁更新"判方向，两份一起重做', () => {
    const s = seg({ summary: 'zh-newer' }, { stale: true })
    s.zh = { summary: '中文稿' }
    s.en = { summary: 'english draft' }
    const items = collectSyncItems([{ ...s, srcChanged: true }], FIELDS)
    expect(items[0]).toMatchObject({ changed: 'src', align: 'both', steps: ['regen', 'translate'] })
  })

  it('引用变了但只有英文 → 也要重做，不能拿旧英文回写中文', () => {
    const s = seg({ summary: 'en-only' }, { stale: true })
    s.zh = {}
    const items = collectSyncItems([{ ...s, srcChanged: true }], FIELDS)
    expect(items[0]).toMatchObject({ changed: 'src', steps: ['regen', 'translate'] })
  })
})

describe('同步清单：排序与统计', () => {
  it('按段号升序，段内按字段顺序', () => {
    const items = collectSyncItems(
      [
        { ...seg({ non_diegetic_music: 'zh-newer' }, { segNo: 2 }), groupId: 'g2' },
        { ...seg({ non_diegetic_music: 'zh-newer', summary: 'zh-newer' }, { segNo: 1 }), groupId: 'g1' }
      ],
      FIELDS
    )
    expect(items.map((i) => `${i.segNo}:${i.fieldKey}`)).toEqual([
      '1:summary',
      '1:non_diegetic_music',
      '2:non_diegetic_music'
    ])
  })

  it('统计变化类型与涉及段数', () => {
    const items = collectSyncItems(
      [
        { ...seg({ summary: 'zh-newer', overall_soundscape: 'src-newer' }), groupId: 'g1' },
        { ...seg({ summary: 'conflict' }, { segNo: 2 }), groupId: 'g2' }
      ],
      FIELDS
    )
    const s = statsOf(items)
    expect(s.total).toBe(3)
    expect(s.manual).toBe(1)
    expect(s.segments).toBe(2)
    expect(s.byChanged).toEqual({ zh: 2, en: 0, src: 1 })
  })
})

describe('同步清单：按段合并', () => {
  it('同一段多个字段只跑一次请求', () => {
    const items = collectSyncItems([seg({ summary: 'zh-newer', overall_soundscape: 'zh-newer' })], FIELDS)
    const batches = batchOf(items)
    expect(batches).toHaveLength(1)
    expect(batches[0].keys).toEqual(['summary', 'overall_soundscape'])
    expect(batches[0].steps).toEqual(['translate'])
  })

  it('引用变了的段：先重生成再翻译', () => {
    const items = collectSyncItems([seg({ summary: 'src-newer' })], FIELDS)
    expect(batchOf(items)[0].steps).toEqual(['regen', 'translate'])
  })

  it('待人工的项不进入批量', () => {
    const items = collectSyncItems([seg({ summary: 'conflict', overall_soundscape: 'zh-newer' })], FIELDS)
    const batches = batchOf(items)
    expect(batches[0].keys).toEqual(['overall_soundscape'])
  })
})
