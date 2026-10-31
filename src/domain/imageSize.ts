/**
 * 出图尺寸：比例随便挑，**像素量级锁在 720p = 1280×720 = 921,600**。
 *
 * 为什么锁像素数而不是锁宽高：
 *   采样步数只有 2 步，真正决定耗时和显存的是 token 数，也就是像素总数 × 常数；
 *   出图质量也跟它走（512×512 会糊成一团，1792×1024 要慢一倍多）。
 *   所以比例要能变（竖屏、方图、超宽），量级不能变。
 *
 * 为什么宽高必须是 16 的倍数：
 *   Qwen-Image-2.1 的 latent 是 1/16 下采样、64 通道。EmptyLatentImage 交出来
 *   1/8 的 4 通道，靠 downscale_ratio_spacial=8 再缩一半，缩的时候是 round()——
 *   1032×584 会被静默改成 1024×576，不报错。后端 `_align_latent_side()` 也会
 *   兜一层，但前端先对齐掉，免得用户填的数跟出图对不上。
 *
 * 纯函数，不碰 store；弹窗与后端注入共用同一套换算。
 */

/**
 * ★ p 档位表 —— 全项目唯一一张「多少 p = 多少像素」（16:9 画布）。
 *
 * 二采 `lib/latent_upscaler_3d.py` 的 `P_TABLE` 必须与本表逐字一致。
 * （导演台 2026-10-28 已把「清晰度档位」回退成百万像素输入，不再持有 p 表。）
 *
 * 720p 必须是 1280×720；480p 沿用历史画布 864×480；1080p 的 16:9 是 1920×1088
 * （1080 不是 16 的倍数，1/16 的 latent 装不下）。
 */
export const P_LEVELS = [480, 720, 1080] as const

export const P_ANCHOR: Record<number, SizePx> = {
  480: { w: 864, h: 480 },
  720: { w: 1280, h: 720 },
  1080: { w: 1920, h: 1088 }
}

/** p → 16:9 的像素预算；表外按 16:9、短边 = p 现算 */
export function pixelsForP(p: number): number {
  const anchor = P_ANCHOR[p]
  if (anchor) return anchor.w * anchor.h
  if (!Number.isFinite(p) || p <= 0) return P_ANCHOR[720].w * P_ANCHOR[720].h
  const h = Math.max(16, Math.round(p / 16) * 16)
  const w = Math.max(16, Math.round(((h * 16) / 9 / 16)) * 16)
  return w * h
}

/** 像素数 → 最近的 p 档位（显示用） */
export function pForPixels(px: number | null): number | null {
  if (px === null || !Number.isFinite(px) || px <= 0) return null
  let best: number | null = null
  let bestErr = Infinity
  for (const p of P_LEVELS) {
    const err = Math.abs(px - pixelsForP(p)) / pixelsForP(p)
    if (err < bestErr) {
      bestErr = err
      best = p
    }
  }
  return best
}

export function pLabel(p: number): string {
  return `${p}p`
}

/** 1280 × 720 —— 720p。预设尺寸全部按这个像素总数换算。 */
export const PIXEL_BUDGET = 1280 * 720

/** 默认尺寸（16:9 = 720p）。所有入口在没有特别指定时都用它。 */
export const DEFAULT_SIZE = '1280x720'

/** 宽高的最小步长，必须和 latent 下采样倍数一致。 */
export const SIZE_STEP = 16

/** 自定义尺寸偏离预算多少以内算"同一量级"。±12% ≈ 81 万 ~ 103 万。 */
export const BUDGET_TOLERANCE = 0.12

export type SizePx = { w: number; h: number }

export type SizeOption = { label: string; value: string }

/** `"1280x720"` / `"1280×720"` / `"1280 * 720"` → `{w,h}`；认不出返回 null */
export function parseSize(size: string): SizePx | null {
  const m = /(\d+)\s*[x×*]\s*(\d+)/i.exec(size || '')
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  return { w, h }
}

/** `"1280x720"` → `"1280 × 720"`；认不出就原样返回 */
export function formatSize(size: string): string {
  const p = parseSize(size)
  return p ? `${p.w} × ${p.h}` : size
}

/** 921600 → `"92 万"` */
export function formatPixels(px: number): string {
  if (!Number.isFinite(px) || px <= 0) return '?'
  if (px >= 10000) return `${Math.round(px / 10000)} 万`
  return String(Math.round(px))
}

/** 对齐到 16 的倍数，最小 16 */
export function alignSide(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return SIZE_STEP
  return Math.max(SIZE_STEP, Math.round(v / SIZE_STEP) * SIZE_STEP)
}

/** 给定比例，算出锁在该档位像素预算上的尺寸（16 对齐） */
export function sizeForRatio(rw: number, rh: number, p = 720): string {
  // 16:9 直接用档位表的锚点：720p 必须一字不差是 1280×720，不能被 16 对齐挪走
  // （858.6 会变 848、483 会变 480，那就不是 720p 了）。
  if (rw === 16 && rh === 9 && P_ANCHOR[p]) {
    const { w, h } = P_ANCHOR[p]
    return `${w}x${h}`
  }
  const budget = pixelsForP(p)
  const w = alignSide(Math.sqrt((budget * rw) / rh))
  const h = alignSide(Math.sqrt((budget * rh) / rw))
  return `${w}x${h}`
}

/** 像素总数；认不出返回 null */
export function pixelCount(size: string): number | null {
  const p = parseSize(size)
  return p ? p.w * p.h : null
}

/** 是否落在预算量级内 */
export function nearBudget(size: string, tolerance = BUDGET_TOLERANCE): boolean {
  const px = pixelCount(size)
  if (px === null) return false
  return Math.abs(px - PIXEL_BUDGET) <= PIXEL_BUDGET * tolerance
}

/**
 * 把任意输入收成"16 对齐 + 预算量级"的尺寸。
 *
 * 对齐和缩放的先后顺序不能反：先对齐再判预算，否则 1279×719 这种
 * 差一点点没对齐、量级其实没问题的输入会被误判。
 */
export function normalizeSize(input: string): { size: string; note: string | null } {
  const parsed = parseSize(input)
  if (!parsed) {
    return {
      size: DEFAULT_SIZE,
      note: `认不出「${input}」，按默认 ${formatSize(DEFAULT_SIZE)} 出图`
    }
  }
  const w = alignSide(parsed.w)
  const h = alignSide(parsed.h)
  const aligned = `${w}x${h}`
  const alignedNote =
    w !== parsed.w || h !== parsed.h ? `已对齐到 16 的倍数：${w} × ${h}` : null

  if (nearBudget(aligned)) return { size: aligned, note: alignedNote }

  const scaled = sizeForRatio(w, h)
  const px = w * h
  const why =
    px > PIXEL_BUDGET
      ? `超出 720p（${formatPixels(PIXEL_BUDGET)}像素）量级`
      : `低于 720p（${formatPixels(PIXEL_BUDGET)}像素）量级`
  return {
    size: scaled,
    note: `${w} × ${h} 是 ${formatPixels(px)}像素，${why}；已按同比例换算成 ${formatSize(scaled)}`
  }
}

/** 比例档位：像素量级全部锁在 PIXEL_BUDGET */
export const RATIO_PRESETS: Array<{ ratio: string; rw: number; rh: number; use: string }> = [
  { ratio: '16:9', rw: 16, rh: 9, use: '宽屏，默认' },
  { ratio: '1:1', rw: 1, rh: 1, use: '方图，主体' },
  { ratio: '4:3', rw: 4, rh: 3, use: '标准' },
  { ratio: '3:4', rw: 3, rh: 4, use: '竖版' },
  { ratio: '9:16', rw: 9, rh: 16, use: '竖屏' },
  { ratio: '21:9', rw: 21, rh: 9, use: '超宽' }
]

/**
 * 下拉选项：每一项都标出尺寸、比例、档位和像素数。
 *
 * 标像素数不是为了好看 —— 换比例时用户得能一眼看出"总量没变"，
 * 否则会觉得 960×960 比 1280×720 "小"。
 *
 * `p` 只在需要别的档位时才传（480p 便宜、1080p 更贵），默认 720p。
 */
export function sizeOptions(p = 720): SizeOption[] {
  return RATIO_PRESETS.map(({ ratio, rw, rh, use }) => {
    const value = sizeForRatio(rw, rh, p)
    const px = pixelCount(value) ?? pixelsForP(p)
    const tail = value === DEFAULT_SIZE ? '默认' : use
    return {
      label: `${formatSize(value)}（${ratio} ${tail} · ${pLabel(p)} · ${formatPixels(px)}像素）`,
      value
    }
  })
}
