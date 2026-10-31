import { describe, expect, it } from 'vitest'
import { proxyFrontTimeoutMs } from './comfy'

/**
 * 转发是两条独立超时：后端 urllib 的 socket 超时（秒）和前端 AbortController
 * 的硬截止（毫秒）。前端必须盖住后端 + 余量，否则后端还在跑，浏览器先报超时。
 */
describe('转发的前端预算', () => {
  it('没给后端秒数时按后端默认 30s 算', () => {
    expect(proxyFrontTimeoutMs()).toBe(35000)
    expect(proxyFrontTimeoutMs(0)).toBe(35000)
    expect(proxyFrontTimeoutMs(-5)).toBe(35000)
  })

  it('短请求不会缩到 15s 以下（探活 6s 仍给足建连余量）', () => {
    expect(proxyFrontTimeoutMs(6)).toBe(15000)
    expect(proxyFrontTimeoutMs(10)).toBe(15000)
  })

  it('长请求按秒数放大并留 5s 余量', () => {
    expect(proxyFrontTimeoutMs(30)).toBe(35000)
    expect(proxyFrontTimeoutMs(60)).toBe(65000)
    // 分段导出：19 段解码重编码实测 47s，后端给 300s
    expect(proxyFrontTimeoutMs(300)).toBe(305000)
    // 音色固化：后端 360s
    expect(proxyFrontTimeoutMs(360)).toBe(365000)
  })

  it('永远大于后端那条，不会出现前端先掐断', () => {
    for (const sec of [6, 10, 15, 20, 25, 30, 60, 120, 300, 360]) {
      expect(proxyFrontTimeoutMs(sec)).toBeGreaterThan(sec * 1000)
    }
  })
})
