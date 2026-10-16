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

  it('removeSeries 级联删除项目 + 所有集 + 大主体', async () => {
    const { series, episode } = seedSeries()
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
})
