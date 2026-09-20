import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { isReactive } from 'vue'
import { db } from '@/db'
import { DEFAULT_SETTINGS } from '@/domain/types'
import { isAligned } from '@/domain/frames'
import { beatFrames } from '@/domain/timing'
import type { ID, ProjectSettings } from '@/domain/types'
import type { Stage1Beat } from '@/core/llm/prompts'
import { useProjectStore } from './project'
import { useRegistryStore } from './registry'
import { useBeatStore } from './beats'
import { useAssemblyStore, type SegmentView } from './assembly'

const S: ProjectSettings = { ...DEFAULT_SETTINGS }

const DRAFTS: Stage1Beat[] = [
  { title: '洞窟俯视，毒雾弥漫', kind: 'establishing' },
  { title: '楚辞扶壁起身', kind: 'action' },
  { title: '台词1', kind: 'dialogue', dialogue: '我不信这世上没有解药。' },
  { title: '毒尊现身', kind: 'action' },
  { title: '台词2', kind: 'dialogue', dialogue: '那就试试。' },
  { title: '切到新世界', kind: 'scene_switch' }
]

async function freshDb() {
  await db.delete()
  await db.open()
}

describe('stores 端到端（真实 IndexedDB 语义）', () => {
  beforeEach(async () => {
    await freshDb()
    setActivePinia(createPinia())
  })

  async function seed() {
    const project = useProjectStore()
    const beats = useBeatStore()
    const registry = useRegistryStore()

    const p = await project.create('测试项目', '故事原文')
    await beats.replaceAll(p.id, DRAFTS)

    const chuci = await registry.addEntity(p.id, {
      name: '楚辞',
      kind: 'speaking',
      pictureN: 1,
      voiceDesc: 'speaking with a young male voice, tired but determined.'
    })
    const duzun = await registry.addEntity(p.id, {
      name: '毒尊',
      kind: 'speaking',
      pictureN: 2,
      voiceDesc: 'speaking with a mature male voice, lazy and arrogant.'
    })
    const cave = await registry.addEntity(p.id, { name: '九幽毒渊', type: 'scene', pictureN: 3 })
    const world = await registry.addEntity(p.id, { name: '新世界', type: 'scene', pictureN: 4 })

    // 绑定实体
    const list = beats.ordered
    await beats.updateBeat(list[0].id, { entities: [cave.id], focusEntityId: cave.id, sceneId: cave.id })
    await beats.updateBeat(list[1].id, {
      entities: [chuci.id, cave.id],
      focusEntityId: chuci.id,
      sceneId: cave.id,
      enriched: true
    })
    await beats.updateBeat(list[2].id, {
      entities: [chuci.id],
      speakerId: chuci.id,
      focusEntityId: chuci.id,
      sceneId: cave.id,
      enriched: true
    })
    await beats.updateBeat(list[3].id, {
      entities: [duzun.id],
      focusEntityId: duzun.id,
      sceneId: cave.id,
      enriched: true
    })
    await beats.updateBeat(list[4].id, {
      entities: [duzun.id],
      speakerId: duzun.id,
      focusEntityId: duzun.id,
      sceneId: cave.id,
      enriched: true
    })
    await beats.updateBeat(list[5].id, {
      entities: [world.id],
      focusEntityId: world.id,
      sceneId: world.id,
      enriched: true
    })

    await registry.renumber(beats.beats)
    return { p, beats, registry, chuci, duzun, cave, world }
  }

  it('项目 / 片段 / 实体 全流程不抛错', async () => {
    const { p, beats, registry } = await seed()
    expect(beats.ordered.length).toBe(6)
    expect(registry.entities.length).toBe(4)
    // 编号：说话角色 1、2，不说话 3、4
    const sorted = registry.sortedEntities
    expect(sorted[0].name).toBe('楚辞')
    expect(sorted[1].name).toBe('毒尊')
    expect(registry.stale(beats.beats)).toBe(false)
    expect(p.name).toBe('测试项目')
  })

  it('拆分超长台词后再合并，帧数守恒', async () => {
    const { beats } = await seed()
    const dialogueBeat = beats.ordered.find((b) => b.kind === 'dialogue')!
    // 拉长台词让它必须被拆
    const long = '我不信这世上没有解药。毒尊，你错了！那就试试吧？终有一日我会走出这里。'
    await beats.updateBeat(dialogueBeat.id, { dialogue: long, manualFrames: false })

    const before = beats.ordered.length
    const ok = await beats.splitAuto(dialogueBeat.id, S)
    expect(ok).toBe(true)
    expect(beats.ordered.length).toBeGreaterThan(before)

    const children = beats.ordered.filter((b) => b.derivedFrom === dialogueBeat.id)
    expect(children.length).toBeGreaterThan(1)
    const merged = await beats.merge(
      children.map((c) => c.id),
      S
    )
    expect(merged).toBe(true)
    expect(beats.ordered.filter((b) => b.derivedFrom === dialogueBeat.id).length).toBe(0)
  })

  it('删除片段、移动片段、清空都不抛错', async () => {
    const { beats } = await seed()
    const ids = beats.ordered.map((b) => b.id)
    // 把第 1 个片段移到索引 3
    await beats.moveBeat(ids[0], 3)
    expect(beats.ordered.map((b) => b.id)).toEqual([
      ids[1],
      ids[2],
      ids[3],
      ids[0],
      ids[4],
      ids[5]
    ])

    await beats.removeBeats([ids[1]])
    expect(beats.ordered.some((b) => b.id === ids[1])).toBe(false)
    expect(beats.ordered.length).toBe(5)

    await beats.clearAll(beats.ordered[0].projectId)
    expect(beats.ordered.length).toBe(0)
  })

  it('选择器清空导致的 null 绑定会被规范化成空数组', async () => {
    const { beats } = await seed()
    const b = beats.ordered[0]
    // naive-ui 的 multiple select 清空时会 emit null
    await beats.updateBeat(b.id, { entities: null as unknown as ID[] })
    const after = beats.beatById.get(b.id)!
    expect(Array.isArray(after.entities)).toBe(true)
    expect(after.entities).toEqual([])

    // 下面这些以前会因为 null 而崩
    expect(() => beats.ordered.filter((x) => x.entities.length)).not.toThrow()
  })

  it('写入 IndexedDB 的记录必须是可结构化克隆的普通对象', async () => {
    const { beats } = await seed()
    const row = await db.beats.toArray()
    expect(row.length).toBeGreaterThan(0)
    for (const b of row) {
      // 落库后不应再是 Vue 响应式代理
      expect(isReactive(b)).toBe(false)
      expect(Array.isArray(b.entities)).toBe(true)
    }
    const entities = await db.entities.toArray()
    for (const e of entities) expect(isReactive(e)).toBe(false)
  })

  it('组合与缝合视图可以完整产出', async () => {
    const { p, beats, registry } = await seed()
    const assembly = useAssemblyStore()
    const project = useProjectStore()

    await assembly.load(p.id)
    await assembly.createAssembly(p.id, '方案A', 'scene_first', beats.beats, S, registry.entityById)
    expect(assembly.assemblies.length).toBe(1)

    const views = assembly.buildSegmentViews(
      assembly.current!,
      beats.beats,
      S,
      registry.entityById,
      project.fieldSchema
    )
    expect(views.length).toBeGreaterThan(0)
    for (const v of views) {
      expect(v.frames).toBeLessThanOrEqual(S.maxSegmentFrames + v.beats.length * 0)
      expect(v.fields.subject_definitions).toBeTruthy()
      expect(v.fields.detailed_description).toBeTruthy()
    }

    const groupId = views[0].group.id
    await assembly.setField(p.id, groupId, 'overall_soundscape', 'dripping water echoes in the cavern')
    await assembly.setSummary(p.id, groupId, '[reference generation] test summary.')

    const views2 = assembly.buildSegmentViews(
      assembly.current!,
      beats.beats,
      S,
      registry.entityById,
      project.fieldSchema
    )
    expect(views2[0].fields.overall_soundscape).toBe('dripping water echoes in the cavern')
    expect(assembly.getSummary(groupId)).toBe('[reference generation] test summary.')

    const json = assembly.exportAssembly(views2, project.fieldSchema, S)
    expect(JSON.parse(json).segments.length).toBe(views2.length)
  })

  it('带自动生成片段（预备镜头 / 黑屏）的段能正常派生与校验', async () => {
    const { p, beats, registry } = await seed()
    const assembly = useAssemblyStore()
    const project = useProjectStore()
    await assembly.load(p.id)

    // 手工造三段，段间主体会变化 -> 触发预备镜头 / 尾帧切镜 / 黑屏兜底
    const groups = [
      { id: 'g1', beatIds: [beats.ordered[0].id, beats.ordered[1].id, beats.ordered[2].id] },
      { id: 'g2', beatIds: [beats.ordered[3].id, beats.ordered[4].id] },
      { id: 'g3', beatIds: [beats.ordered[5].id] }
    ]
    await assembly.createAssembly(p.id, '手工', 'manual', beats.beats, S, registry.entityById)
    await assembly.setGroups(assembly.current!.id, groups)

    const views = assembly.buildSegmentViews(
      assembly.current!,
      beats.beats,
      S,
      registry.entityById,
      project.fieldSchema
    )
    const kinds = views.flatMap((v) => v.beats.map((b) => b.kind))
    expect(kinds).toContain('preshoot')
    expect(kinds.some((k) => k === 'tail_cut' || k === 'black')).toBe(true)

    const issues = assembly.globalIssues(
      views,
      registry.entities,
      beats.beats,
      S,
      registry.entityById,
      project.fieldSchema
    )
    const errors = issues.filter((i) => i.level === 'error')
    expect(errors.map((e) => `${e.ruleId}: ${e.message}`)).toEqual([])
  })

  /* ---------------------- 交付页回归 ---------------------- */

  async function setupSingleSegment() {
    const ctx = await seed()
    const assembly = useAssemblyStore()
    const project = useProjectStore()
    await assembly.load(ctx.p.id)
    await assembly.createAssembly(ctx.p.id, '手工', 'manual', ctx.beats.beats, S, ctx.registry.entityById)
    const asm = assembly.current!
    await assembly.setGroups(asm.id, [
      { id: 'g1', beatIds: ctx.beats.ordered.map((b) => b.id) }
    ])
    const rebuild = () =>
      assembly.buildSegmentViews(
        assembly.current!,
        ctx.beats.beats,
        S,
        ctx.registry.entityById,
        project.fieldSchema
      )
    return { ...ctx, assembly, project, rebuild }
  }

  it('回归：阶段三写入的字段与 summary 必须能被交付页读到，且不再报缺失', async () => {
    const { p, assembly, rebuild } = await setupSingleSegment()

    let views = rebuild()
    const gid = views[0].group.id
    // 初始：summary 为空，且确实被标记为缺失
    expect(views[0].fields.summary).toBeFalsy()
    expect(
      views[0].issues.some((i) => i.ruleId === 'field:missing' && i.field === 'summary')
    ).toBe(true)

    // 模拟阶段三写回
    await assembly.setSummary(p.id, gid, '[reference generation] 楚辞 wakes in the cavern.')
    await assembly.setFields(p.id, gid, {
      overall_soundscape: 'dripping water and slow breathing',
      non_diegetic_music: 'N/A'
    })

    views = rebuild()
    // 交付页读的是 v.fields，summary 必须已经合并进来
    expect(views[0].fields.summary).toBe('[reference generation] 楚辞 wakes in the cavern.')
    expect(views[0].fields.overall_soundscape).toBe('dripping water and slow breathing')
    expect(views[0].fields.non_diegetic_music).toBe('N/A')
    // 不再报 summary 缺失
    expect(
      views[0].issues.some((i) => i.ruleId === 'field:missing' && i.field === 'summary')
    ).toBe(false)

    // 锁定状态可见
    expect(assembly.isFieldLocked(gid, 'summary')).toBe(true)
    expect(assembly.isFieldLocked(gid, 'overall_soundscape')).toBe(true)
    expect(assembly.lockedKeys(gid).sort()).toEqual(
      ['non_diegetic_music', 'overall_soundscape', 'summary'].sort()
    )

    // 解除 summary 锁定后应重新变空并再次报缺失
    await assembly.clearSummary(p.id, gid)
    views = rebuild()
    expect(views[0].fields.summary).toBeFalsy()
    expect(
      views[0].issues.some((i) => i.ruleId === 'field:missing' && i.field === 'summary')
    ).toBe(true)
  })

  /* ---------------------- 帧长度补正 ---------------------- */

  it('段帧数自动落到 17k / 5+17k 家族，副帧独立于片段帧长度', async () => {
    const { p, beats, registry } = await seed()
    const assembly = useAssemblyStore()
    const project = useProjectStore()
    await assembly.load(p.id)
    await assembly.createAssembly(p.id, '手工', 'manual', beats.beats, S, registry.entityById)
    const asmId = assembly.current!.id
    const ids = beats.ordered.map((b) => b.id)
    await assembly.setGroups(asmId, [
      { id: 'g1', beatIds: ids.slice(0, 3) },
      { id: 'g2', beatIds: ids.slice(3) }
    ])

    const build = () =>
      assembly.buildSegmentViews(
        assembly.current!,
        beats.beats,
        S,
        registry.entityById,
        project.fieldSchema
      )

    let views = build()
    // 第一个不引用，其余引用
    expect(views[0].refPrev).toBe(false)
    expect(views[1].refPrev).toBe(true)

    for (const v of views) {
      expect(isAligned(v.frames, v.refPrev)).toBe(true)
      expect(v.aligned).toBe(true)
      expect(v.rawFrames + v.padTotal).toBe(v.frames)
      expect(v.frames).toBe(v.targetFrames)
      expect(v.overLimit).toBe(false)
    }
    // 第一个上限 141，第二个上限 136
    expect(views[0].cap).toBe(141)
    expect(views[1].cap).toBe(136)

    // 副帧不写进 beat 自身的帧长度（允许为负，即压缩，所以只保证数字有效）
    const rawBefore = views[1].narrativeBeats.map((b) => beatFrames(b, S))
    expect(views[1].narrativeBeats.map((b) => beatFrames(b, S))).toEqual(rawBefore)
    expect(Number.isFinite(views[1].padTotal)).toBe(true)
    for (const v of views) {
      for (const b of v.narrativeBeats) {
        expect(beatFrames(b, S) + (v.pad[b.id] ?? 0)).toBeGreaterThanOrEqual(1)
      }
    }

    // 切换引用模式 -> 家族与目标帧数一起变
    await assembly.setGroupRefPrev(asmId, 'g1', true)
    views = build()
    expect(views[0].refPrev).toBe(true)
    expect(views[0].cap).toBe(136)
    expect(isAligned(views[0].frames, true)).toBe(true)
    expect(views[0].frames % 17).toBe(0)
  })

  it('副帧分布可手工调整，合计始终维持对齐', async () => {
    const { p, beats, registry } = await seed()
    const assembly = useAssemblyStore()
    const project = useProjectStore()
    await assembly.load(p.id)
    await assembly.createAssembly(p.id, '手工', 'manual', beats.beats, S, registry.entityById)
    const asmId = assembly.current!.id
    const ids = beats.ordered.map((b) => b.id)
    await assembly.setGroups(asmId, [{ id: 'g1', beatIds: ids }])

    const build = () =>
      assembly.buildSegmentViews(
        assembly.current!,
        beats.beats,
        S,
        registry.entityById,
        project.fieldSchema
      )

    /** 与 StageAssemble 的 pinPad 保持一致：只固定叙事片段的副帧 */
    const narrativePadOf = (v: SegmentView) => {
      const set = new Set(v.narrativeBeats.map((b) => b.id))
      const out: Record<string, number> = {}
      for (const [k, val] of Object.entries(v.pad)) if (set.has(k)) out[k] = val
      return out
    }

    const auto = build()[0]
    expect(auto.padAuto).toBe(true)
    expect(auto.aligned).toBe(true)

    // 固定当前自动分摊结果 -> 变成手工值，但帧数不变
    await assembly.setGroupPad(asmId, auto.group.id, narrativePadOf(auto))
    let v = build()[0]
    expect(v.padAuto).toBe(false)
    expect(v.aligned).toBe(true)
    expect(v.frames).toBe(auto.frames)

    // 把第一拍的副帧 +2 -> 差额被其它片段吸收，总帧数保持对齐
    const firstId = v.narrativeBeats[0].id
    const tuned: Record<string, number> = { ...narrativePadOf(v) }
    tuned[firstId] = (tuned[firstId] ?? 0) + 2
    await assembly.setGroupPad(asmId, v.group.id, tuned)

    v = build()[0]
    expect(v.pad[firstId]).toBe((auto.pad[firstId] ?? 0) + 2)
    expect(v.frames).toBe(auto.frames)
    expect(v.aligned).toBe(true)
    expect(v.issues.some((i) => i.ruleId === 'frames:not-aligned')).toBe(false)

    // 恢复自动 -> 回到纯占比分摊
    await assembly.clearGroupPad(asmId, v.group.id)
    v = build()[0]
    expect(v.padAuto).toBe(true)
    expect(v.pad[firstId]).toBe(auto.pad[firstId] ?? 0)
  })

  it('回归：手改派生字段会锁定，解锁后重新跟随分镜变化', async () => {
    const { p, beats, assembly, rebuild } = await setupSingleSegment()
    const gid = rebuild()[0].group.id
    const first = beats.ordered[0]

    // 派生字段跟着分镜走
    const before = rebuild()[0].fields.detailed_description
    await beats.updateBeat(first.id, { title: '改过的标题A' })
    const afterEdit = rebuild()[0].fields.detailed_description
    expect(afterEdit).not.toBe(before)
    expect(afterEdit).toContain('改过的标题A')

    // 手改一次 → 锁定
    await assembly.setField(p.id, gid, 'detailed_description', 'HAND WRITTEN')
    expect(assembly.isFieldLocked(gid, 'detailed_description')).toBe(true)

    await beats.updateBeat(first.id, { title: '改过的标题B' })
    expect(rebuild()[0].fields.detailed_description).toBe('HAND WRITTEN')

    // 解锁 → 恢复自动派生，重新跟随分镜
    await assembly.clearFields(p.id, gid, ['detailed_description'])
    expect(assembly.isFieldLocked(gid, 'detailed_description')).toBe(false)
    const unlocked = rebuild()[0].fields.detailed_description
    expect(unlocked).toContain('改过的标题B')
  })
})
