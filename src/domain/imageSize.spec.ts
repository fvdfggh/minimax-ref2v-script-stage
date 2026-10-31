import { describe, expect, it } from 'vitest'
import {
  BUDGET_TOLERANCE,
  DEFAULT_SIZE,
  PIXEL_BUDGET,
  RATIO_PRESETS,
  SIZE_STEP,
  alignSide,
  formatPixels,
  formatSize,
  nearBudget,
  normalizeSize,
  P_LEVELS,
  parseSize,
  pForPixels,
  pLabel,
  pixelCount,
  pixelsForP,
  sizeForRatio,
  sizeOptions
} from './imageSize'

describe('出图尺寸的量级约束', () => {
  it('预算是 1280×720', () => {
    expect(PIXEL_BUDGET).toBe(921600)
    expect(DEFAULT_SIZE).toBe('1280x720')
    expect(pixelCount(DEFAULT_SIZE)).toBe(PIXEL_BUDGET)
  })

  it('每个比例档位都是同一像素量级', () => {
    for (const { ratio, rw, rh } of RATIO_PRESETS) {
      const size = sizeForRatio(rw, rh)
      const px = pixelCount(size)!
      // 16 对齐会让像素数有一点误差，但不该超过 5%
      expect(Math.abs(px - PIXEL_BUDGET) / PIXEL_BUDGET, `${ratio} -> ${size}`).toBeLessThan(0.05)
      expect(nearBudget(size), `${ratio} -> ${size}`).toBe(true)
    }
  })

  it('每个档位的宽高都是 16 的倍数', () => {
    for (const { ratio, rw, rh } of RATIO_PRESETS) {
      const { w, h } = parseSize(sizeForRatio(rw, rh))!
      expect(w % SIZE_STEP, `${ratio} 宽 ${w}`).toBe(0)
      expect(h % SIZE_STEP, `${ratio} 高 ${h}`).toBe(0)
    }
  })

  it('比例换算保留比例（误差在一格 16 之内）', () => {
    const { w, h } = parseSize(sizeForRatio(16, 9))!
    expect(w / h).toBeCloseTo(16 / 9, 1)
    const sq = parseSize(sizeForRatio(1, 1))!
    expect(sq.w).toBe(sq.h)
  })
})

describe('parseSize / formatSize', () => {
  it('认三种分隔符', () => {
    expect(parseSize('1280x720')).toEqual({ w: 1280, h: 720 })
    expect(parseSize('1280×720')).toEqual({ w: 1280, h: 720 })
    expect(parseSize('1280 * 720')).toEqual({ w: 1280, h: 720 })
    expect(parseSize('  1280 X 720 ')).toEqual({ w: 1280, h: 720 })
  })

  it('认不出就是 null，不猜', () => {
    expect(parseSize('')).toBeNull()
    expect(parseSize('720p')).toBeNull()
    expect(parseSize('0x0')).toBeNull()
    expect(parseSize('1280')).toBeNull()
  })

  it('格式化带乘号', () => {
    expect(formatSize('1280x720')).toBe('1280 × 720')
    expect(formatSize('乱码')).toBe('乱码')
  })
})

describe('alignSide', () => {
  it('就近对齐到 16（.5 一律向上，和后端 _align_latent_side 口径一致）', () => {
    expect(alignSide(1280)).toBe(1280)
    expect(alignSide(1032)).toBe(1040) // 64.5 格 -> 65 格
    expect(alignSide(1000)).toBe(1008) // 62.5 格 -> 63 格
    expect(alignSide(1008)).toBe(1008)
  })

  it('小于一步兜到 16，不算出 0', () => {
    expect(alignSide(1)).toBe(16)
    expect(alignSide(0)).toBe(16)
    expect(alignSide(-5)).toBe(16)
    expect(alignSide(Number.NaN)).toBe(16)
  })
})

describe('normalizeSize', () => {
  it('默认尺寸原样通过，不出提示', () => {
    expect(normalizeSize('1280x720')).toEqual({ size: '1280x720', note: null })
  })

  it('非 16 倍数先对齐再判量级', () => {
    const { size, note } = normalizeSize('1272x712')
    expect(size).toBe('1280x720')
    expect(note).toContain('16')
  })

  it('同量级的不同比例直接放行', () => {
    expect(normalizeSize('960x960').size).toBe('960x960')
    expect(normalizeSize('1472x624').size).toBe('1472x624')
  })

  it('超出量级就按同比例换算回来', () => {
    const { size, note } = normalizeSize('1920x1080')
    expect(size).toBe('1280x720')
    expect(note).toContain('换算')
    // 竖屏同理，比例不能丢
    expect(normalizeSize('1080x1920').size).toBe('720x1280')
  })

  it('低于量级也换算上去，别出 512 那种糊图', () => {
    expect(normalizeSize('512x512').size).toBe('960x960')
    // 768×448 只有 34 万像素，按同比例抬回预算量级，比例不能走样
    const low = normalizeSize('768x448')
    expect(nearBudget(low.size)).toBe(true)
    const p = parseSize(low.size)!
    expect(p.w / p.h).toBeCloseTo(768 / 448, 1)
  })

  it('认不出就回默认，并说清楚', () => {
    const { size, note } = normalizeSize('720p')
    expect(size).toBe(DEFAULT_SIZE)
    expect(note).toContain('认不出')
  })
})

describe('展示', () => {
  it('像素数按万显示', () => {
    expect(formatPixels(PIXEL_BUDGET)).toBe('92 万')
    expect(formatPixels(512 * 512)).toBe('26 万')
    expect(formatPixels(0)).toBe('?')
  })

  it('下拉第一项就是默认 1280×720，且标注默认', () => {
    const opts = sizeOptions()
    expect(opts).toHaveLength(RATIO_PRESETS.length)
    expect(opts[0].value).toBe(DEFAULT_SIZE)
    expect(opts[0].label).toContain('默认')
    // 每一项都把尺寸和像素数写出来，换比例时看得出来总量没变
    for (const o of opts) {
      expect(o.label).toContain('像素')
      expect(o.label).toMatch(/\d+ × \d+/)
    }
  })

  it('容差是个窄带，不是随便放', () => {
    expect(BUDGET_TOLERANCE).toBeLessThan(0.2)
    expect(nearBudget('1280x720')).toBe(true)
    expect(nearBudget('1792x1024')).toBe(false)
    expect(nearBudget('512x512')).toBe(false)
    expect(nearBudget('乱码')).toBe(false)
  })
})

describe('p 档位表（与二采 P_TABLE 同一份）', () => {
  it('720p 就是 1280×720 —— 这张表存在的唯一理由', () => {
    expect(sizeForRatio(16, 9, 720)).toBe('1280x720')
    expect(pixelsForP(720)).toBe(PIXEL_BUDGET)
  })

  it('480p 沿用历史画布 864×480（比例 1.8，不动老工程）', () => {
    expect(sizeForRatio(16, 9, 480)).toBe('864x480')
    expect(pixelsForP(480)).toBe(414720)
  })

  it('1080p 的 16:9 是 1920×1088：1080 不是 16 的倍数', () => {
    expect(sizeForRatio(16, 9, 1080)).toBe('1920x1088')
    expect(pixelsForP(1080)).toBe(2088960)
  })

  it('换档位不换比例：方图、竖屏跟着短边走', () => {
    expect(sizeForRatio(1, 1, 720)).toBe('960x960')
    expect(sizeForRatio(9, 16, 720)).toBe('720x1280')
    expect(sizeForRatio(1, 1, 480)).toBe('640x640')
  })

  it('像素数反推档位', () => {
    expect(pForPixels(921600)).toBe(720)
    expect(pForPixels(414720)).toBe(480)
    expect(pForPixels(2088960)).toBe(1080)
    expect(pForPixels(null)).toBeNull()
    expect(pLabel(720)).toBe('720p')
    expect(P_LEVELS).toEqual([480, 720, 1080])
  })

  it('非 16:9 的档位也要落在预算附近', () => {
    for (const p of P_LEVELS) {
      for (const [rw, rh] of [[1, 1], [4, 3], [9, 16], [21, 9]] as const) {
        const size = sizeForRatio(rw, rh, p)
        const px = pixelCount(size)!
        expect(Math.abs(px - pixelsForP(p)) / pixelsForP(p), `${p}p ${rw}:${rh} -> ${size}`).toBeLessThan(0.05)
      }
    }
  })
})
