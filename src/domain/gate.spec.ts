import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './types'
import type { Assembly, Asset, Beat, Entity } from './types'
import {
  GATE_ORDER,
  blockersFor,
  evaluateGates,
  generationBlockers,
  prerequisitesOf,
  type GateInput,
  type GateSegment
} from './gate'

/* ------------------------------ 构造器 ------------------------------ */

function ent(patch: Partial<Entity> & { id: string }): Entity {
  return {
    projectId: 'p1',
    name: patch.id,
    type: 'character',
    kind: 'non_speaking',
    subjectN: null,
    sx: null,
    pictureN: null,
    voiceDesc: null,
    textDesc: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch
  } as Entity
}

function beat(patch: Partial<Beat> & { id: string }): Beat {
  return {
    projectId: 'p1',
    order: 0,
    kind: 'action',
    title: `片段 ${patch.id}`,
    entities: ['e1'],
    sceneId: 'e1',
    manualFrames: false,
    locked: false,
    enriched: true,
    ...patch
  } as Beat
}

function kf(beatId: string, n = 1): Asset {
  return {
    id: `a-${beatId}`,
    projectId: 'p1',
    pictureN: 0,
    kind: 'keyframe',
    refId: beatId,
    fileName: `kf_${n}.png`,
    originalName: `kf_${n}.png`,
    label: 'kf',
    createdAt: 1,
    updatedAt: 1
  } as Asset
}

function seg(patch: Partial<GateSegment> = {}): GateSegment {
  return {
    frames: 124,
    overLimit: false,
    aligned: true,
    stale: false,
    fields: {},
    issues: [],
    result: { state: 'ready' },
    ...patch
  }
}

function assembly(groups = 1): Assembly {
  return {
    id: 'asm1',
    projectId: 'p1',
    name: '方案A',
    strategy: {},
    groups: Array.from({ length: groups }, (_, i) => ({ id: `g${i}`, beatIds: [`b${i}`] })),
    createdAt: 1,
    updatedAt: 1
  } as Assembly
}

/** 一条健康到可以出片的输入：1 个片段、有场景、有图、1 段、字段已补 */
function healthy(patch: Partial<GateInput> = {}): GateInput {
  const b = beat({ id: 'b0', dialogue: '你好', speakerId: 'e2', titleEn: 'hello' })
  const entities = [
    ent({ id: 'e1', type: 'scene', nameEn: 'Store' }),
    ent({ id: 'e2', kind: 'speaking', nameEn: 'A', textDesc: null, voiceDesc: null })
  ]
  const assets = [kf('b0')]
  return {
    beats: [b],
    entities,
    assets,
    entityById: new Map(entities.map((e) => [e.id, e])),
    settings: DEFAULT_SETTINGS,
    schema: [{ key: 'prompt', label: '提示词', order: 1, source: 'llm', editable: true, required: true, lang: 'en' }],
    assembly: assembly(1),
    segments: [seg({ fields: { prompt: 'a shot' } })],
    globalIssues: [],
    ...patch
  }
}

/* ------------------------------ 用例 ------------------------------ */

describe('阶段门禁', () => {
  it('全齐时每个阶段都通过', () => {
    const gates = evaluateGates(healthy())
    for (const k of GATE_ORDER) {
      expect(gates[k].errors, `${k}: ${gates[k].errors.join(' / ')}`).toEqual([])
      expect(gates[k].passed).toBe(true)
    }
    expect(generationBlockers('video', healthy())).toEqual([])
  })

  it('没有片段：拆解不通过，后面全被拦', () => {
    const input = healthy({ beats: [], segments: [], assembly: null })
    const gates = evaluateGates(input)
    expect(gates.split.passed).toBe(false)
    expect(gates.split.errors[0]).toContain('还没有拆出片段')

    const blocked = blockersFor('assemble', input).map((g) => g.key)
    expect(blocked).toContain('split')
    expect(generationBlockers('keyframes', input).length).toBeGreaterThan(0)
  })

  it('缺场景：细节填充不通过，组合被拦', () => {
    const input = healthy()
    input.beats = [beat({ id: 'b0', sceneId: undefined })]
    const gates = evaluateGates(input)
    expect(gates.enrich.passed).toBe(false)
    expect(gates.enrich.errors[0]).toContain('缺场景')
    expect(blockersFor('assemble', input).map((g) => g.key)).toEqual(['enrich'])
    expect(blockersFor('enrich', input)).toEqual([])
  })

  it('未绑场景的台词镜头同样拦在细节填充', () => {
    const input = healthy()
    input.beats = [beat({ id: 'b0', kind: 'dialogue', dialogue: '你好', speakerId: undefined })]
    expect(evaluateGates(input).enrich.errors[0]).toContain('缺说话人')
  })

  it('没有起始图：素材阶段照常通过，只给提示；出片也不拦', () => {
    const input = healthy({ assets: [] })
    const gates = evaluateGates(input)
    // 首帧可选（2026-10-28 定的口径）：没有图就用文字起画
    expect(gates.materials.passed).toBe(true)
    expect(gates.materials.errors).toEqual([])
    expect(gates.materials.warns.some((w) => w.includes('起始图'))).toBe(true)

    // 导航能进④（素材是工作台，不锁下一阶段）
    expect(blockersFor('complete', input).map((g) => g.key)).toEqual([])
    // 出片不再被起始图拦
    const gen = generationBlockers('video', input)
    expect(gen.some((m) => m.includes('起始图'))).toBe(false)
    expect(generationBlockers('keyframes', input)).toEqual([])
  })

  it('出关键帧前必须先有组合方案：链由缝合算出', () => {
    const input = healthy({ assembly: null, segments: [] })
    const gen = generationBlockers('keyframes', input)
    expect(gen.some((m) => m.includes('组合'))).toBe(true)
  })

  it('没有方案：组合不通过', () => {
    const input = healthy({ assembly: null, segments: [] })
    const gates = evaluateGates(input)
    expect(gates.assemble.passed).toBe(false)
    expect(gates.assemble.errors[0]).toContain('还没有组合方案')
    expect(blockersFor('complete', input).map((g) => g.key)).toContain('assemble')
  })

  it('段超帧上限：组合不通过', () => {
    const input = healthy({ segments: [seg({ overLimit: true, fields: { prompt: 'x' } })] })
    expect(evaluateGates(input).assemble.errors[0]).toContain('超出帧数上限')
  })

  it('段级结构错误：组合与交付都不通过', () => {
    const input = healthy({
      segments: [
        seg({
          fields: { prompt: 'x' },
          issues: [{ ruleId: 'frames:not-aligned', level: 'error', message: '本段 130 帧不满足 17k' }]
        })
      ]
    })
    const gates = evaluateGates(input)
    expect(gates.assemble.passed).toBe(false)
    expect(gates.deliver.passed).toBe(false)
    expect(gates.deliver.errors.join()).toContain('130 帧')
  })

  it('字段类错误不拦③：否则字段还没生成就永远进不去④（实测死锁）', () => {
    const input = healthy({
      segments: [
        seg({
          fields: {},
          issues: [
            { ruleId: 'field:missing', level: 'error', field: 'summary', message: '字段 summary 为空' },
            { ruleId: 'defs:missing-entity', level: 'error', field: 'subject_definitions', message: '陈默未定义' }
          ]
        })
      ]
    })
    const gates = evaluateGates(input)
    // ③ 不看字段内容
    expect(gates.assemble.passed, gates.assemble.errors.join(' / ')).toBe(true)
    // 但 ④ 会因为字段空缺不通过，⑥ 会因为完整校验不通过
    expect(gates.complete.passed).toBe(false)
    expect(gates.deliver.passed).toBe(false)
  })

  it('字段空缺：补全不通过，出片被拦', () => {
    const input = healthy({ segments: [seg({ fields: {} })] })
    const gates = evaluateGates(input)
    expect(gates.complete.passed).toBe(false)
    expect(gates.complete.errors[0]).toContain('字段空缺')
    expect(generationBlockers('video', input).some((m) => m.includes('字段空缺'))).toBe(true)
  })

  it('上游改过（stale）：补全不通过', () => {
    const input = healthy({ segments: [seg({ stale: true, fields: { prompt: 'x' } })] })
    expect(evaluateGates(input).complete.errors[0]).toContain('已过期')
  })

  /*
   * 只报「7 段已过期」等于什么都没说 —— 用户得自己在整集里找是哪 7 段。
   * 门禁文案必须点名：段号写进去，界面才有东西可点。
   */
  it('过期要说清是哪几段（点名，不是只报总数）', () => {
    const input = healthy({
      segments: [
        seg({ stale: true, fields: { prompt: 'x' } }),
        seg({ stale: false, fields: { prompt: 'x' } }),
        seg({ stale: true, fields: { prompt: 'x' } })
      ]
    })
    const msg = evaluateGates(input).complete.errors[0]
    expect(msg).toContain('2 段')
    expect(msg).toContain('seg01')
    expect(msg).toContain('seg03')
    expect(msg).not.toContain('seg02')
  })

  it('字段空缺也点名段号；超过 4 段用「等」收口', () => {
    const segs = Array.from({ length: 6 }, () => seg({ fields: {} }))
    const msg = evaluateGates(healthy({ segments: segs })).complete.errors[0]
    expect(msg).toContain('6 段')
    expect(msg).toContain('seg01、seg02、seg03、seg04 等')
    expect(msg).not.toContain('seg05')
  })

  it('词条没英文：本地化不通过，交付被拦', () => {
    const input = healthy()
    input.beats = [beat({ id: 'b0', dialogue: '你好', speakerId: 'e2', titleEn: undefined })]
    const gates = evaluateGates(input)
    expect(gates.localize.passed).toBe(false)
    expect(gates.localize.errors[0]).toContain('还没有英文')
    expect(blockersFor('deliver', input).map((g) => g.key)).toContain('localize')
  })

  it('prerequisitesOf 只返回目标之前的阶段', () => {
    // 素材排在组合与缝合之后：出了方案才谈哪段要起始图
    expect(prerequisitesOf('assemble', healthy()).map((g) => g.key)).toEqual(['split', 'enrich'])
    expect(prerequisitesOf('materials', healthy()).map((g) => g.key)).toEqual([
      'split',
      'enrich',
      'assemble'
    ])
  })
})
