import { describe, expect, it } from 'vitest'
import { baselineOf, isBehind, migrateLegacyPairs, syncOf, valueOfSide, withSide } from './pairs'
import type { FieldPair } from './types'

/* ------------------------------------------------------------------ *
 * 中英两份字段：谁都不能覆盖谁，落后的一侧要能被标出来
 * ------------------------------------------------------------------ */

describe('字段双语：同步判定', () => {
  it('两侧都空 → empty', () => {
    expect(syncOf(undefined)).toBe('empty')
    expect(syncOf({})).toBe('empty')
  })

  it('只有中文 → zh-only（英文还没做，不算"落后"）', () => {
    const p: FieldPair = { zh: { v: '雨夜的便利店', at: 1 } }
    expect(syncOf(p)).toBe('zh-only')
    expect(isBehind('zh-only', 'en')).toBe(false)
  })

  it('只有英文 → en-only（中文稿缺失）', () => {
    const p: FieldPair = { en: { v: 'a rainy convenience store', at: 1 } }
    expect(syncOf(p)).toBe('en-only')
  })

  it('★ 改了中文 → 英文落后，英文侧标红', () => {
    const p: FieldPair = {
      zh: { v: '雨夜的便利店', at: 200 },
      en: { v: 'a rainy convenience store', at: 100 }
    }
    expect(syncOf(p)).toBe('zh-newer')
    expect(isBehind('zh-newer', 'en')).toBe(true)
    expect(isBehind('zh-newer', 'zh')).toBe(false)
  })

  it('★ 改了英文 → 中文落后，中文侧标红', () => {
    const p: FieldPair = {
      zh: { v: '雨夜的便利店', at: 100 },
      en: { v: 'a rainy store at night', at: 200 }
    }
    expect(syncOf(p)).toBe('en-newer')
    expect(isBehind('en-newer', 'zh')).toBe(true)
  })

  it('同一时刻写入（翻译刚落库）→ both，不标红', () => {
    const p: FieldPair = {
      zh: { v: '雨夜的便利店', at: 100 },
      en: { v: 'a rainy convenience store', at: 100 }
    }
    expect(syncOf(p)).toBe('both')
  })

  it('空白字符串不算有内容', () => {
    const p: FieldPair = { zh: { v: '  ', at: 300 }, en: { v: 'store', at: 100 } }
    expect(syncOf(p)).toBe('en-only')
  })
})

describe('字段双语：写入', () => {
  it('写英文不会动中文', () => {
    const zhOnly = withSide(undefined, 'zh', '中文稿', 1)
    const both = withSide(zhOnly, 'en', 'english draft', 2)
    expect(valueOfSide(both, 'zh')).toBe('中文稿')
    expect(valueOfSide(both, 'en')).toBe('english draft')
  })

  it('写中文不会覆盖已有英文', () => {
    const enOnly = withSide(undefined, 'en', 'english draft', 1)
    const both = withSide(enOnly, 'zh', '中文稿', 2)
    expect(valueOfSide(both, 'zh')).toBe('中文稿')
    expect(valueOfSide(both, 'en')).toBe('english draft')
    expect(syncOf(both)).toBe('zh-newer')
  })

  it('不修改传入的 pair', () => {
    const before: FieldPair = { zh: { v: '原稿', at: 1 } }
    withSide(before, 'en', 'translated', 2)
    expect(before.en).toBeUndefined()
  })
})

describe('字段双语：旧数据迁移', () => {
  it('含中文的归中文，纯英文的归英文', () => {
    const out = migrateLegacyPairs(
      {
        g1: {
          summary: '[reference generation] 陈默推门进入便利店。',
          overall_soundscape: 'Rain hits the glass door, footsteps on wet tiles.'
        }
      },
      { g2: '雨声、脚步声、衣物摩擦声。' }
    )
    expect(valueOfSide(out.g1.summary, 'zh')).toBe('[reference generation] 陈默推门进入便利店。')
    expect(valueOfSide(out.g1.summary, 'en')).toBe('')
    expect(valueOfSide(out.g1.overall_soundscape, 'en')).toBe(
      'Rain hits the glass door, footsteps on wet tiles.'
    )
    expect(valueOfSide(out.g2.summary, 'zh')).toBe('雨声、脚步声、衣物摩擦声。')
  })

  it('空值不产生空壳', () => {
    const out = migrateLegacyPairs({ g1: { summary: '   ' } }, { g2: '' })
    expect(out.g1?.summary).toBeUndefined()
    expect(out.g2).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 * 有了基线之后，「改了内容」和「只是重新保存了一次」要能分开
 * ------------------------------------------------------------------ */

describe('字段双语：三方基线', () => {
  const both = (z: string, e: string) => withSide(withSide(undefined, 'zh', z, 10), 'en', e, 11)

  function synced(z: string, e: string, src: string, at = 20): FieldPair {
    const p = both(z, e)
    return { ...p, synced: baselineOf(p, src, at) }
  }

  it('对齐之后内容没动 → both，不标红', () => {
    expect(syncOf(synced('雨夜', 'rainy night', 'src1'), 'src1')).toBe('both')
  })

  it('★ 只改中文 → zh-newer（英文要对齐）', () => {
    const p = synced('雨夜', 'rainy night', 'src1')
    const next = withSide(p, 'zh', '雨夜的便利店', 30)
    expect(syncOf(next, 'src1')).toBe('zh-newer')
  })

  it('★ 只改英文 → en-newer（中文要对齐）', () => {
    const p = synced('雨夜', 'rainy night', 'src1')
    const next = withSide(p, 'en', 'a rainy night at the store', 30)
    expect(syncOf(next, 'src1')).toBe('en-newer')
  })

  it('★ 同样内容重新写一遍（时间变了、内容没变）→ 不算改过', () => {
    const p = synced('雨夜', 'rainy night', 'src1')
    const next = withSide(p, 'zh', '雨夜', 99)
    expect(syncOf(next, 'src1')).toBe('both')
  })

  it('★ 引用变了 → src-newer，两侧都标红、都要重做', () => {
    expect(syncOf(synced('雨夜', 'rainy night', 'src1'), 'src2')).toBe('src-newer')
    // 只看状态，不考虑语言 —— 引用变了谁都不算对齐
    expect(isBehind('src-newer', 'zh')).toBe(true)
    expect(isBehind('src-newer', 'en')).toBe(true)
  })

  it('两侧都改过 → conflict，不能自动决定听谁的', () => {
    const p = synced('雨夜', 'rainy night', 'src1')
    const a = withSide(p, 'zh', '雨夜的便利店', 30)
    const b = withSide(a, 'en', 'a rainy store', 31)
    expect(syncOf(b, 'src1')).toBe('conflict')
  })

  it('没给引用指纹时，不把引用当成变了', () => {
    expect(syncOf(synced('雨夜', 'rainy night', 'src1'))).toBe('both')
  })

  it('空白差异不算改动', () => {
    const p = synced('雨夜  的便利店', 'rainy night', 'src1')
    const next = withSide(p, 'zh', '雨夜 的便利店', 30)
    expect(syncOf(next, 'src1')).toBe('both')
  })
})
