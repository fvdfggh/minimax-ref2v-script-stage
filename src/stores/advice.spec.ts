import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { db } from '@/db'
import { DEFAULT_SETTINGS } from '@/domain/types'
import type { ID } from '@/domain/types'
import type { StageAdvice } from '@/core/llm/advice'
import { useProjectStore } from './project'
import { useRegistryStore } from './registry'
import { useBeatStore } from './beats'
import { useAssemblyStore } from './assembly'
import { useAdviceStore } from './advice'

const DRAFTS = [
  { title: 'a 洞窟', kind: 'establishing' as const },
  { title: 'b 起身', kind: 'action' as const },
  { title: 'c 台词', kind: 'dialogue' as const, dialogue: '我不信。' },
  { title: 'd 现身', kind: 'action' as const },
  { title: 'e 换场', kind: 'scene_switch' as const }
]

async function freshDb() {
  await db.delete()
  await db.open()
}

/** 建项目 + 片段 + 实体 + 一个方案，返回常用句柄 */
async function seed() {
  const project = useProjectStore()
  const beats = useBeatStore()
  const registry = useRegistryStore()
  const assembly = useAssemblyStore()
  const advice = useAdviceStore()

  const p = await project.create('测试', '故事')
  await beats.replaceAll(p.id, DRAFTS)

  const cave = await registry.addEntity(p.id, { name: '洞窟', type: 'scene' })
  const hero = await registry.addEntity(p.id, { name: '楚辞', kind: 'speaking', voiceDesc: '青年男声' })

  // 每个片段都绑上场景，否则组合时会被跳过
  for (const b of beats.ordered) {
    await beats.updateBeat(b.id, { sceneId: cave.id, entities: [hero.id] })
  }

  await assembly.load(p.id)
  await assembly.createAssembly(p.id, '方案A', 'manual', beats.ordered, DEFAULT_SETTINGS, registry.entityById)

  const groupId = assembly.current!.groups[0].id
  await assembly.setGroups(assembly.current!.id, [
    { id: groupId, beatIds: beats.ordered.slice(0, 3).map((b) => b.id) },
    { id: 'g2', beatIds: beats.ordered.slice(3).map((b) => b.id) }
  ])

  const groupIds = () =>
    assembly.current!.groups.filter((g) => g.beatIds.length).map((g) => g.id)

  return { project, beats, registry, assembly, advice, caveId: cave.id, heroId: hero.id, groupIds }
}

describe('意见补丁：应用与级联', () => {
  beforeEach(async () => {
    await freshDb()
    setActivePinia(createPinia())
  })

  it('按序号修改：只改点到的那一个片段', async () => {
    const s = await seed()
    await s.advice.apply({ beats: [{ op: 'update', index: 2, title: '改过的标题' }] }, s.groupIds())

    const list = s.beats.ordered
    expect(list[1].title).toBe('改过的标题')
    expect(list[0].title).toBe('a 洞窟')
    expect(list[2].title).toBe('c 台词')
  })

  it('★ 序号全部在快照上解析：先删 #2 再改 #3，改的必须是原来的 #3', async () => {
    const s = await seed()
    const original = s.beats.ordered.map((b) => b.title)
    expect(original[2]).toBe('c 台词')

    await s.advice.apply(
      {
        beats: [
          { op: 'delete', index: 2 },
          { op: 'update', index: 3, title: 'X' }
        ]
      },
      s.groupIds()
    )

    const list = s.beats.ordered
    // #2 被删掉了
    expect(list.map((b) => b.title)).not.toContain('b 起身')
    // 被改的是原来的 #3，而不是删除之后顺位补上来的那个
    expect(list.map((b) => b.title)).toContain('X')
    const x = list.find((b) => b.title === 'X')
    expect(x?.dialogue).toBe('我不信。')
  })

  it('★ 新增片段会被自动并入相邻段，不会静默消失', async () => {
    const s = await seed()
    const res = await s.advice.apply(
      { beats: [{ op: 'insert', afterIndex: 2, title: '新增镜头', kind: 'action' }] },
      s.groupIds()
    )

    expect(res.beats.inserted).toBe(1)
    expect(res.adopted).toBe(1)

    const created = s.beats.ordered.find((b) => b.title === '新增镜头')
    expect(created).toBeTruthy()
    // 已经出现在某个分组里
    const assigned = s.assembly.current!.groups.flatMap((g) => g.beatIds)
    expect(assigned).toContain(created!.id)
    // 并且紧跟在 #2 之后
    const orderedIds = s.beats.ordered.map((b) => b.id)
    expect(orderedIds.indexOf(created!.id)).toBe(2)
  })

  it('插入到最前面（afterIndex = 0）', async () => {
    const s = await seed()
    await s.advice.apply(
      { beats: [{ op: 'insert', afterIndex: 0, title: '开场空镜', kind: 'establishing' }] },
      s.groupIds()
    )
    expect(s.beats.ordered[0].title).toBe('开场空镜')
    const assigned = s.assembly.current!.groups.flatMap((g) => g.beatIds)
    expect(assigned).toContain(s.beats.ordered[0].id)
  })

  it('删除片段后，分组里的引用被清掉', async () => {
    const s = await seed()
    const res = await s.advice.apply({ beats: [{ op: 'delete', index: 1 }] }, s.groupIds())
    expect(res.beats.deleted).toBe(1)
    expect(res.dropped).toBe(1)
    const assigned = s.assembly.current!.groups.flatMap((g) => g.beatIds)
    expect(assigned).toHaveLength(4)
  })

  it('修改绑定：场景与说话人按名称解析成 id', async () => {
    const s = await seed()
    const other = await s.registry.addEntity(s.project.currentId!, { name: '毒尊', kind: 'speaking', voiceDesc: '老者' })

    await s.advice.apply(
      { beats: [{ op: 'update', index: 3, scene: '洞窟', entities: ['毒尊'], speaker: '毒尊' }] },
      s.groupIds()
    )

    const b = s.beats.ordered[2]
    expect(b.sceneId).toBe(s.caveId)
    expect(b.entities).toContain(other.id)
    expect(b.speakerId).toBe(other.id)
  })

  it('越界序号会被跳过并给出理由，不会瞎改', async () => {
    const s = await seed()
    const res = await s.advice.apply(
      { beats: [{ op: 'update', index: 99, title: 'x' }] },
      s.groupIds()
    )
    expect(res.beats.updated).toBe(0)
    expect(res.skipped.join()).toContain('99')
  })

  /* ---------------- 段字段的作废规则 ---------------- */

  it('只改片段内容时，段号没变，段字段补丁照常生效', async () => {
    const s = await seed()
    const gid = s.groupIds()[0]
    const res = await s.advice.apply(
      {
        beats: [{ op: 'update', index: 1, title: '改了标题' }],
        fields: [{ segment: 1, key: 'summary', value: '[reference generation] x' }]
      },
      s.groupIds()
    )
    expect(res.beats.updated).toBe(1)
    expect(res.fields.updated).toBe(1)
    expect(s.assembly.getSummary(gid)).toBe('[reference generation] x')
  })

  it('★ 增删片段会让段内构成变化，段字段补丁一律跳过', async () => {
    const s = await seed()
    const gid = s.groupIds()[0]
    const res = await s.advice.apply(
      {
        beats: [{ op: 'insert', afterIndex: 1, title: '插入的', kind: 'action' }],
        fields: [{ segment: 1, key: 'summary', value: '[reference generation] x' }]
      },
      s.groupIds()
    )
    expect(res.fields.updated).toBe(0)
    expect(res.skipped.join()).toContain('段字段补丁已跳过')
    expect(s.assembly.getSummary(gid)).toBe('')
  })

  it('★ 切分 / 合并分段之后，段字段补丁一律跳过', async () => {
    const s = await seed()
    const res = await s.advice.apply(
      {
        groups: [{ op: 'split', atBeatIndex: 3 }],
        fields: [{ segment: 1, key: 'summary', value: '[reference generation] x' }]
      },
      s.groupIds()
    )
    expect(res.groups.split).toBe(1)
    expect(res.fields.updated).toBe(0)
    expect(res.skipped.join()).toContain('段字段补丁已跳过')
  })

  it('没动片段时，段字段补丁正常生效', async () => {
    const s = await seed()
    const gids = s.groupIds()
    const res = await s.advice.apply(
      { fields: [{ segment: 1, key: 'summary', value: '[reference generation] 新概述' }] },
      gids
    )
    expect(res.fields.updated).toBe(1)
    expect(s.assembly.getSummary(gids[0])).toBe('[reference generation] 新概述')
  })

  /* ---------------- 实体 ---------------- */

  it('实体新增 / 修改 / 删除', async () => {
    const s = await seed()
    const res = await s.advice.apply(
      {
        entities: [
          { op: 'insert', name: '新角色', type: 'character', kind: 'speaking', voiceDesc: '少年音' },
          { op: 'update', name: '楚辞', voiceDesc: '改过的音色' },
          { op: 'delete', name: '不存在的实体' }
        ]
      },
      s.groupIds()
    )
    expect(res.entities.inserted).toBe(1)
    expect(res.entities.updated).toBe(1)
    expect(res.skipped.join()).toContain('不存在的实体')

    const created = s.registry.entities.find((e) => e.name === '新角色')
    expect(created?.voiceDesc).toBe('少年音')
    expect(s.registry.entities.find((e) => e.name === '楚辞')?.voiceDesc).toBe('改过的音色')
  })

  it('新增同名实体会被拒绝，不会造出两个同名的', async () => {
    const s = await seed()
    const res = await s.advice.apply({ entities: [{ op: 'insert', name: '楚辞' }] }, s.groupIds())
    expect(res.entities.inserted).toBe(0)
    expect(s.registry.entities.filter((e) => e.name === '楚辞')).toHaveLength(1)
  })

  /* ---------------- 分组 ---------------- */

  it('切开分段：按片段序号找到所在段再切', async () => {
    const s = await seed()
    // 第 4 个片段是第二段的第一个，往后挪一个才能切
    const res = await s.advice.apply({ groups: [{ op: 'split', atBeatIndex: 3 }] }, s.groupIds())
    expect(res.groups.split).toBe(1)
    expect(s.assembly.current!.groups.length).toBeGreaterThan(2)
  })

  it('段首片段无法再切，给出理由而不是硬切出空段', async () => {
    const s = await seed()
    const res = await s.advice.apply({ groups: [{ op: 'split', atBeatIndex: 1 }] }, s.groupIds())
    expect(res.groups.split).toBe(0)
    expect(res.skipped.join()).toContain('切不出新段')
  })

  it('合并分段', async () => {
    const s = await seed()
    const before = s.assembly.current!.groups.length
    const res = await s.advice.apply({ groups: [{ op: 'merge', fromSegment: 1, toSegment: 2 }] }, s.groupIds())
    expect(res.groups.merged).toBe(1)
    expect(s.assembly.current!.groups.length).toBe(before - 1)
  })

  it('★ 合并之后，后续按段号的补丁会被跳过（段号已失效）', async () => {
    const s = await seed()
    const res = await s.advice.apply(
      {
        groups: [
          { op: 'merge', fromSegment: 1, toSegment: 2 },
          { op: 'refPrev', segment: 2, refPrev: true }
        ]
      },
      s.groupIds()
    )
    expect(res.groups.merged).toBe(1)
    expect(res.groups.refPrev).toBe(0)
    expect(res.skipped.join()).toContain('失效')
  })

  it('切换引用上段', async () => {
    const s = await seed()
    const res = await s.advice.apply({ groups: [{ op: 'refPrev', segment: 2, refPrev: true }] }, s.groupIds())
    expect(res.groups.refPrev).toBe(1)
    expect(s.assembly.current!.groups[1].refPrev).toBe(true)
  })

  /* ---------------- 端到端 ---------------- */

  it('一份混合补丁：实体 + 片段 + 分组一起应用，最后仍然一致', async () => {
    const s = await seed()
    const res = await s.advice.apply(
      {
        entities: [{ op: 'insert', name: '毒尊', type: 'character', kind: 'speaking', voiceDesc: '老者音' }],
        beats: [
          { op: 'update', index: 2, title: '楚辞质问', speaker: '楚辞' },
          { op: 'insert', afterIndex: 3, title: '毒尊回应', kind: 'dialogue', dialogue: '那就试试。', speaker: '毒尊' }
        ]
      },
      s.groupIds()
    )

    expect(res.entities.inserted).toBe(1)
    expect(res.beats.updated).toBe(1)
    expect(res.beats.inserted).toBe(1)
    expect(res.adopted).toBe(1)

    // 新增的台词片段绑对了说话人
    const added = s.beats.ordered.find((b) => b.title === '毒尊回应')
    const duzun = s.registry.entities.find((e) => e.name === '毒尊')
    expect(added?.speakerId).toBe(duzun?.id)

    // 每个片段都在某个段里，没有孤儿
    const assigned = new Set(s.assembly.current!.groups.flatMap((g) => g.beatIds))
    for (const b of s.beats.ordered) expect(assigned.has(b.id)).toBe(true)
  })

  it('空补丁不产生任何变更，也不报错', async () => {
    const s = await seed()
    const before = s.beats.ordered.map((b) => b.title).join('|')
    const res = await s.advice.apply({}, s.groupIds())
    expect(res.beats.updated).toBe(0)
    expect(s.beats.ordered.map((b) => b.title).join('|')).toBe(before)
  })
})
