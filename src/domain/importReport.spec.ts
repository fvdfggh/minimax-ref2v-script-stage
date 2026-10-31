import { describe, expect, it } from 'vitest'
import type { ImportResult } from '@/core/backend'
import { importIsClean, importSummary, missingPacksOf, packLabel } from './importReport'

function res(patch: Partial<ImportResult> = {}): ImportResult {
  return { projects: 1, episodes: 0, assets: 0, ...patch }
}

describe('missingPacksOf', () => {
  it('没有导入结果时是空清单', () => {
    expect(missingPacksOf(null)).toEqual([])
    expect(missingPacksOf(undefined)).toEqual([])
  })

  it('优先读导入端算出的清单', () => {
    const one = { id: 'v_1', entity: '林小满' }
    expect(missingPacksOf(res({ missingPacks: [one] }))).toEqual([one])
  })

  it('导入端没给就沿用导出时算的那份', () => {
    const one = { id: 'v_2', entity: '陈默' }
    expect(missingPacksOf(res({ missing: { voicePacks: [one] } }))).toEqual([one])
  })

  it('都没有就是空数组，不是 undefined', () => {
    expect(missingPacksOf(res())).toEqual([])
  })
})

describe('importIsClean', () => {
  it('没有缺失就算干净', () => {
    expect(importIsClean(res({ missingPacks: [] }))).toBe(true)
  })

  it('有缺失就不干净（要先让用户看见）', () => {
    expect(importIsClean(res({ missingPacks: [{ id: 'v', entity: '甲' }] }))).toBe(false)
  })

  it('同名冲突也算不干净：本机版本被保留，用户得知道', () => {
    const r = res({
      voicePacks: { restored: [], kept: [], conflict: ['v_x'], dir: 'C:/s2/voices/packs' }
    })
    expect(importIsClean(r)).toBe(false)
  })

  it('restored / kept 不影响干净判定', () => {
    const r = res({
      voicePacks: { restored: ['v_a'], kept: ['v_b'], conflict: [], dir: 'd' }
    })
    expect(importIsClean(r)).toBe(true)
  })

  it('没有结果时当干净处理，避免空弹窗卡住刷新', () => {
    expect(importIsClean(null)).toBe(true)
  })
})

describe('importSummary', () => {
  it('只报非零项，不写"0 个素材"', () => {
    expect(importSummary(res())).toBe('1 个项目')
  })

  it('集数、素材、音色包都带上', () => {
    const r = res({
      projects: 2,
      episodes: 5,
      assets: 8,
      voicePacks: { restored: ['v_a'], kept: [], conflict: [], dir: 'd' }
    })
    expect(importSummary(r)).toBe('2 个项目 · 5 集 · 8 个素材 · 1 个音色包')
  })

  it('音色包被跳过（本机已有）不算写入，不出现在摘要里', () => {
    const r = res({ voicePacks: { restored: [], kept: ['v_a'], conflict: [], dir: 'd' } })
    expect(importSummary(r)).toBe('1 个项目')
  })
})

describe('packLabel', () => {
  it('有集名时带上，跨集同名角色才分得清', () => {
    expect(packLabel({ id: 'v', entity: '林小满', projectName: '第02集' })).toBe(
      '林小满（第02集）'
    )
  })

  it('没集名就只写角色', () => {
    expect(packLabel({ id: 'v', entity: '林小满' })).toBe('林小满')
  })
})
