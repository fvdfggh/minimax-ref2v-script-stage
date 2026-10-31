import { describe, expect, it } from 'vitest'
import { requestEntityRegister, useEntityRegister } from './useEntityRegister'
import type { EntityProposal } from '@/stores/pipeline'

const proposal = (name: string): EntityProposal => ({
  name,
  type: 'character',
  kind: 'non_speaking',
  accepted: true,
  exists: false,
  inProject: false,
  refCount: 0
})

describe('useEntityRegister 跨 tab 交接', () => {
  it('每次请求都把候选带过去，并让序号自增', () => {
    const { presets, seq } = useEntityRegister()
    const before = seq.value

    requestEntityRegister([proposal('张三')])
    expect(seq.value).toBe(before + 1)
    expect(presets.value.map((p) => p.name)).toEqual(['张三'])

    // 不带候选的请求（只要求打开登记页）也要能触发
    requestEntityRegister()
    expect(seq.value).toBe(before + 2)
    expect(presets.value).toEqual([])
  })

  it('同一份候选重复请求，序号依然变化 —— 接收方靠序号而不是布尔打开', () => {
    const { seq } = useEntityRegister()
    const list = [proposal('李四')]
    requestEntityRegister(list)
    const first = seq.value
    requestEntityRegister(list)
    expect(seq.value).toBe(first + 1)
  })
})
