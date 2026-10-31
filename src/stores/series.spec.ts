import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { db, setDbImpl, setKvImpl, saveOne } from '@/db'
import { createMemoryDb, createMemoryKv } from '@/db/memory'
import { backendUploadAsset } from '@/core/backend'
import { useSeriesStore } from './series'
import type { Entity, Project } from '@/domain/types'

vi.mock('@/core/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/backend')>()
  return {
    ...actual,
    backendUploadAsset: vi.fn(async () => 'ok.png')
  }
})

function seedSeries(name = 'S1'): { series: Project; episode: Project } {
  const ts = Date.now()
  const series: Project = {
    id: 'srs1',
    name,
    kind: 'series',
    story: '',
    stage: 'split',
    settings: {} as Project['settings'],
    fieldSchema: [],
    episodeIds: ['ep1'],
    createdAt: ts,
    updatedAt: ts
  }
  const episode: Project = {
    id: 'ep1',
    name: '第 01 集',
    kind: 'episode',
    seriesId: 'srs1',
    story: '',
    stage: 'split',
    settings: {} as Project['settings'],
    fieldSchema: [],
    createdAt: ts,
    updatedAt: ts
  }
  return { series, episode }
}

function ent(patch: Partial<Entity> & { id: string; projectId: string; name: string }): Entity {
  const ts = Date.now()
  return {
    type: 'character',
    kind: 'non_speaking',
    subjectN: null,
    sx: null,
    pictureN: null,
    voiceDesc: null,
    textDesc: null,
    createdAt: ts,
    updatedAt: ts,
    ...patch
  }
}

async function fresh() {
  setDbImpl(createMemoryDb())
  setKvImpl(createMemoryKv())
  setActivePinia(createPinia())
}

describe('series store：两级结构 + 注入/提升', () => {
  beforeEach(async () => {
    vi.unstubAllGlobals()
    await fresh()
    vi.mocked(backendUploadAsset).mockClear()
  })

  it('createSeries 建项目 + 首个默认集，成员关系正确', async () => {
    const series = useSeriesStore()
    await series.loadAll()
    const s = await series.createSeries('测试项目')

    expect(s.kind).toBe('series')
    expect(s.episodeIds).toHaveLength(1)

    const epId = s.episodeIds![0]
    const ep = await db.projects.get(epId)
    expect(ep?.kind).toBe('episode')
    expect(ep?.seriesId).toBe(s.id)

    // 集列表已加载
    expect(series.episodes.map((e) => e.id)).toContain(epId)
  })

  it('createEpisode 追加到项目集列表', async () => {
    const series = useSeriesStore()
    const { series: s, episode } = seedSeries()
    await saveOne(db.projects, s)
    await saveOne(db.projects, episode)
    await series.loadAll()
    await series.select(s.id)

    const e2 = await series.createEpisode(s.id, '第 02 集')
    expect(e2.kind).toBe('episode')
    expect(e2.seriesId).toBe(s.id)
    expect((await db.projects.get(s.id))!.episodeIds).toHaveLength(2)
    expect(series.episodes).toHaveLength(2)
  })

  it('moveEpisode 调整集顺序', async () => {
    const series = useSeriesStore()
    const { series: s } = seedSeries()
    await saveOne(db.projects, s)
    await saveOne(db.projects, { ...seedSeries().episode })
    await series.loadAll()
    await series.select(s.id)
    await series.createEpisode(s.id, '第 02 集')
    await series.createEpisode(s.id, '第 03 集')
    expect((await db.projects.get(s.id))!.episodeIds).toHaveLength(3)

    const ids = [...(await db.projects.get(s.id))!.episodeIds!]
    // 把最后一个上移一位：与倒数第二个交换
    await series.moveEpisode(ids[2], -1)
    const after = [...(await db.projects.get(s.id))!.episodeIds!]
    expect(after[1]).toBe(ids[2])
    expect(after[0]).toBe(ids[0])
    expect(after).toHaveLength(3)
  })

  it('injectToEpisode：无图主体复制进集，打 sourceId，新 id', async () => {
    const { series, episode } = seedSeries()
    await saveOne(db.projects, series)
    await saveOne(db.projects, episode)
    // 项目里的一个无图大主体
    const global = ent({ id: 'g1', projectId: 'srs1', name: '主角' })
    await saveOne(db.entities, global)

    const seriesStore = useSeriesStore()
    const res = await seriesStore.injectToEpisode('srs1', 'g1', 'ep1')

    expect(res.imageCopied).toBe(false)
    expect(res.entity.projectId).toBe('ep1')
    expect(res.entity.name).toBe('主角')
    expect(res.entity.sourceId).toBe('g1')
    expect(res.entity.id).not.toBe('g1')
    expect(res.entity.pictureN).toBeNull()

    const copied = await db.entities.where('projectId').equals('ep1').toArray()
    expect(copied).toHaveLength(1)
    expect(copied[0].sourceId).toBe('g1')
  })

  it('injectToEpisode：带参考图，复制到目标集并分配新 PictureN', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])] as unknown as BlobPart[]) }))
    )
    const { series, episode } = seedSeries()
    await saveOne(db.projects, series)
    await saveOne(db.projects, episode)
    const global = ent({ id: 'g1', projectId: 'srs1', name: '主角', pictureN: 1 })
    await saveOne(db.entities, global)
    await saveOne(db.assets, {
      id: 'a1',
      projectId: 'srs1',
      pictureN: 1,
      fileName: 'Picture1.png',
      originalName: 'a.png',
      label: '主角',
      kind: 'subject',
      createdAt: Date.now()
    })

    const seriesStore = useSeriesStore()
    const res = await seriesStore.injectToEpisode('srs1', 'g1', 'ep1')

    expect(res.imageCopied).toBe(true)
    expect(backendUploadAsset).toHaveBeenCalledWith('ep1', 'Picture1.png', expect.anything())
    expect(res.entity.pictureN).toBe(1)

    const epAssets = await db.assets.where('projectId').equals('ep1').toArray()
    expect(epAssets).toHaveLength(1)
    expect(epAssets[0].pictureN).toBe(1)
    expect(epAssets[0].refId).toBe(res.entity.id)
  })

  it('promoteToSeries：集主体复制回项目，作为大主体', async () => {
    const { series, episode } = seedSeries()
    await saveOne(db.projects, series)
    await saveOne(db.projects, episode)
    const epEntity = ent({ id: 'e1', projectId: 'ep1', name: '配角' })
    await saveOne(db.entities, epEntity)

    const seriesStore = useSeriesStore()
    const res = await seriesStore.promoteToSeries('ep1', 'e1', 'srs1')

    expect(res.entity.projectId).toBe('srs1')
    expect(res.entity.sourceId).toBe('e1')
    const srsEnts = await db.entities.where('projectId').equals('srs1').toArray()
    expect(srsEnts).toHaveLength(1)
    expect(srsEnts[0].name).toBe('配角')
  })

  it('重复取用同一个大主体：同步描述而不是再建一个副本', async () => {
    const { series, episode } = seedSeries()
    await saveOne(db.projects, series)
    await saveOne(db.projects, episode)
    await saveOne(db.entities, ent({ id: 'g1', projectId: 'srs1', name: '主角', textDesc: '短发' }))

    const seriesStore = useSeriesStore()
    const first = await seriesStore.injectToEpisode('srs1', 'g1', 'ep1')
    expect(first.reused).toBe(false)

    // 项目层改了描述，再取一次
    await saveOne(db.entities, ent({ id: 'g1', projectId: 'srs1', name: '主角', textDesc: '长发，右眉一道疤' }))
    const second = await seriesStore.injectToEpisode('srs1', 'g1', 'ep1')

    expect(second.reused).toBe(true)
    expect(second.entity.id).toBe(first.entity.id)
    expect(second.entity.textDesc).toBe('长发，右眉一道疤')

    const copied = await db.entities.where('projectId').equals('ep1').toArray()
    expect(copied).toHaveLength(1)
  })

  it('取用于项目的主体推回项目：更新项目里的原件，不再造一个影子副本', async () => {
    const { series, episode } = seedSeries()
    await saveOne(db.projects, series)
    await saveOne(db.projects, episode)
    await saveOne(db.entities, ent({ id: 'g1', projectId: 'srs1', name: '主角', textDesc: '旧描述' }))

    const seriesStore = useSeriesStore()
    const pulled = await seriesStore.injectToEpisode('srs1', 'g1', 'ep1')

    // 集里改完再推送
    await saveOne(db.entities, {
      ...(await db.entities.get(pulled.entity.id))!,
      textDesc: '集里调好的描述'
    })
    const pushed = await seriesStore.promoteToSeries('ep1', pulled.entity.id, 'srs1')

    expect(pushed.reused).toBe(true)
    expect(pushed.entity.id).toBe('g1')
    const all = await db.entities.where('projectId').equals('srs1').toArray()
    expect(all).toHaveLength(1)
    expect(all[0].textDesc).toBe('集里调好的描述')
    // 集里的副本保留，溯源不变
    const epEnt = await db.entities.get(pulled.entity.id)
    expect(epEnt?.sourceId).toBe('g1')
  })

  it('usageOf：既统计谁取用过，也统计项目主体是从哪一集推上来的', async () => {
    const { series, episode } = seedSeries()
    await saveOne(db.projects, series)
    await saveOne(db.projects, episode)
    // g1 被取用到 ep1（集内副本 c1）；g2 是从 ep1 的 c2 推上来的
    await saveOne(db.entities, ent({ id: 'g1', projectId: 'srs1', name: '主角' }))
    await saveOne(db.entities, ent({ id: 'g2', projectId: 'srs1', name: '配角', sourceId: 'c2' }))
    await saveOne(db.entities, ent({ id: 'c1', projectId: 'ep1', name: '主角', sourceId: 'g1' }))
    await saveOne(db.entities, ent({ id: 'c2', projectId: 'ep1', name: '配角' }))

    const seriesStore = useSeriesStore()
    await seriesStore.loadAll()
    await seriesStore.select('srs1')
    const res = await seriesStore.usageOf('srs1')

    expect(res.usedBy.g1).toEqual(['ep1'])
    expect(res.origin.g2).toBe('ep1')
    expect(res.origin.g1).toBeUndefined()
  })

  it('removeSeries 级联删除项目 + 所有集 + 大主体', async () => {    const { series, episode } = seedSeries()
    await saveOne(db.projects, series)
    await saveOne(db.projects, episode)
    await saveOne(db.entities, ent({ id: 'g1', projectId: 'srs1', name: '大主体' }))
    await saveOne(db.entities, ent({ id: 'e1', projectId: 'ep1', name: '集主体' }))

    const seriesStore = useSeriesStore()
    await seriesStore.loadAll()
    expect(seriesStore.seriesList).toHaveLength(1)

    await seriesStore.removeSeries('srs1')

    expect(await db.projects.get('srs1')).toBeUndefined()
    expect(await db.projects.get('ep1')).toBeUndefined()
    expect(seriesStore.seriesList).toHaveLength(0)
  })
  it('addBlankSubject：项目层先建空主体，同名不重复；填充只补空字段', async () => {
    const { series } = seedSeries()
    await saveOne(db.projects, series)

    const store = useSeriesStore()
    await store.loadAll()

    const first = await store.addBlankSubject('srs1', {
      name: '林医生',
      type: 'character',
      kind: 'speaking'
    })
    expect(first.created).toBe(true)
    expect(first.entity.projectId).toBe('srs1')
    // 空主体：只有名字 / 类型 / 是否说话，设定留空等拆解回填
    expect(first.entity.textDesc).toBeNull()
    expect(first.entity.costumeDesc).toBeNull()
    expect(first.entity.voiceDesc).toBeNull()

    // 模型重复登记同名主体：不产生第二份，类型也以母版为准
    const again = await store.addBlankSubject('srs1', {
      name: '林医生',
      type: 'scene',
      kind: 'non_speaking'
    })
    expect(again.created).toBe(false)
    expect(again.entity.id).toBe(first.entity.id)
    expect(again.entity.type).toBe('character')

    const filled = await store.fillBlankSubject(first.entity.id, {
      textDesc: '短发，右眉一道旧疤',
      voiceDesc: '低沉男声'
    })
    expect(filled?.textDesc).toBe('短发，右眉一道旧疤')
    expect(filled?.voiceDesc).toBe('低沉男声')

    // 母版已有的设定不再被后来的集覆盖
    const kept = await store.fillBlankSubject(first.entity.id, {
      textDesc: '另一套长相',
      costumeDesc: '白大褂'
    })
    expect(kept?.textDesc).toBe('短发，右眉一道旧疤')
    expect(kept?.costumeDesc).toBe('白大褂')

    expect(await store.subjectsOf('srs1')).toHaveLength(1)
  })
  it('publishToEpisode：先建项目层母版，再取用到本集；重复拆解不产生第二份', async () => {
    const { series, episode } = seedSeries()
    await saveOne(db.projects, series)
    await saveOne(db.projects, episode)

    const store = useSeriesStore()
    await store.loadAll()

    const res = await store.publishToEpisode('srs1', 'ep1', [
      { name: '林医生', type: 'character', kind: 'speaking', textDesc: '短发，右眉一道旧疤', voiceDesc: '低沉男声' },
      { name: '门诊大厅', type: 'scene', kind: 'non_speaking', textDesc: '白墙，长椅' }
    ])
    expect(res.createdInProject).toBe(2)
    expect(res.injected).toBe(2)
    expect(res.synced).toBe(0)

    const masters = await store.subjectsOf('srs1')
    expect(masters).toHaveLength(2)
    const lin = masters.find((e) => e.name === '林医生')!
    expect(lin.textDesc).toBe('短发，右眉一道旧疤')
    expect(lin.voiceDesc).toBe('低沉男声')

    const copies = await db.entities.where('projectId').equals('ep1').toArray()
    expect(copies).toHaveLength(2)
    // 本集拿到的是副本：带 sourceId 溯源，不是原生实体
    expect(copies.every((e) => !!e.sourceId)).toBe(true)
    expect(copies.find((e) => e.name === '林医生')?.sourceId).toBe(lin.id)

    // 再拆一次同一批主体：母版不新建、副本不新建，只同步描述
    const again = await store.publishToEpisode('srs1', 'ep1', [
      { name: '林医生', type: 'character', kind: 'speaking', textDesc: '另一套长相' }
    ])
    expect(again.createdInProject).toBe(0)
    expect(again.synced).toBe(1)
    expect(again.injected).toBe(0)
    expect(await store.subjectsOf('srs1')).toHaveLength(2)
    expect((await db.entities.where('projectId').equals('ep1').toArray()).length).toBe(2)
    // 母版已有设定不被后来的拆解覆盖
    expect((await store.subjectsOf('srs1')).find((e) => e.name === '林医生')?.textDesc).toBe(
      '短发，右眉一道旧疤'
    )
  })
})
