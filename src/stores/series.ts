import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, deleteProjectDeep, deleteSeriesDeep, kvGet, kvSet, saveOne } from '@/db'
import { backendAssetUrl, backendUploadAsset } from '@/core/backend'
import { uid, now } from '@/core/id'
import { DEFAULT_FIELD_SCHEMA, DEFAULT_SETTINGS, isSeries } from '@/domain/types'
import type { Asset, Entity, ID, Project } from '@/domain/types'

/**
 * 两级结构的核心 store：
 *   series（项目/系列）—— 顶层容器，含「集列表」+「大主体（全局主体）」
 *   episode（集）       —— 真正跑流程的工作台，独立打包
 *
 * 集/项目都是同一个后端项目目录（db.projects 里的一条记录），用 kind 区分：
 *   kind='series'  的 entities 就是「大主体」
 *   kind='episode' 的 entities 就是「集内主体」
 *
 * 注入 / 提升 = 跨项目复制一个实体（+ 可选地复制它的参考图），并打上 sourceId 溯源。
 * 这里刻意直接用 db 读写 + backendUploadAsset，不依赖当前 registry 的内存态，
 * 这样无论当前界面加载的是哪个项目都能正确跨项目操作。
 */
export const useSeriesStore = defineStore('series', () => {
  const seriesList = ref<Project[]>([])
  const currentId = ref<ID | null>(null)
  const episodes = ref<Project[]>([])
  const loading = ref(false)

  const current = computed(() => seriesList.value.find((p) => p.id === currentId.value) ?? null)

  /* ----------------------------- 项目(系列) ----------------------------- */

  async function loadAll() {
    loading.value = true
    try {
      const all = await db.projects.toArray()
      seriesList.value = all
        .filter(isSeries)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      const cid = await kvGet<ID | null>('currentSeriesId', null)
      if (cid && seriesList.value.some((s) => s.id === cid)) currentId.value = cid
      else currentId.value = seriesList.value[0]?.id ?? null
    } finally {
      loading.value = false
    }
  }

  async function select(id: ID | null) {
    currentId.value = id
    await kvSet('currentSeriesId', id)
    await loadEpisodes(id)
  }

  async function loadEpisodes(seriesId: ID | null) {
    if (!seriesId) {
      episodes.value = []
      return
    }
    const all = await db.projects.toArray()
    const s = all.find((p) => p.id === seriesId)
    const ids = s?.episodeIds ?? []
    const byId = new Map(all.map((p) => [p.id, p]))
    episodes.value = ids.map((eid) => byId.get(eid)).filter((p): p is Project => !!p)
  }

  function episodeName(count: number): string {
    return `第 ${String(count).padStart(2, '0')} 集`
  }

  async function createSeries(name: string, firstEpisodeName = ''): Promise<Project> {
    const ts = now()
    const series: Project = {
      id: uid('srs'),
      name: name || '未命名项目',
      kind: 'series',
      story: '',
      stage: 'split',
      settings: { ...DEFAULT_SETTINGS },
      fieldSchema: structuredClone(DEFAULT_FIELD_SCHEMA),
      episodeIds: [],
      createdAt: ts,
      updatedAt: ts
    }
    await saveOne(db.projects, series)
    seriesList.value = [series, ...seriesList.value]
    await createEpisode(series.id, firstEpisodeName || episodeName(1))
    await select(series.id)
    return series
  }

  async function createEpisode(seriesId: ID, name = ''): Promise<Project> {
    const ts = now()
    const s = seriesList.value.find((x) => x.id === seriesId)
    const count = (s?.episodeIds ?? []).length + 1
    const episode: Project = {
      id: uid('epi'),
      name: name || episodeName(count),
      kind: 'episode',
      seriesId,
      story: '',
      stage: 'split',
      settings: { ...DEFAULT_SETTINGS },
      fieldSchema: structuredClone(DEFAULT_FIELD_SCHEMA),
      createdAt: ts,
      updatedAt: ts
    }
    await saveOne(db.projects, episode)
    if (s) {
      s.episodeIds = [...(s.episodeIds ?? []), episode.id]
      s.updatedAt = ts
      await saveOne(db.projects, { ...s })
    }
    await loadEpisodes(seriesId)
    return episode
  }

  async function renameSeries(id: ID, name: string) {
    const s = seriesList.value.find((x) => x.id === id)
    if (!s) return
    s.name = name
    s.updatedAt = now()
    await saveOne(db.projects, { ...s })
  }

  async function renameEpisode(id: ID, name: string) {
    const e = episodes.value.find((x) => x.id === id)
    if (!e) return
    e.name = name
    e.updatedAt = now()
    await saveOne(db.projects, { ...e })
  }

  async function removeEpisode(id: ID) {
    const e = episodes.value.find((x) => x.id === id)
    const seriesId = e?.seriesId ?? currentId.value
    await deleteProjectDeep(id)
    if (seriesId) {
      const s = seriesList.value.find((x) => x.id === seriesId)
      if (s) {
        s.episodeIds = (s.episodeIds ?? []).filter((x) => x !== id)
        s.updatedAt = now()
        await saveOne(db.projects, { ...s })
      }
      await loadEpisodes(seriesId)
    }
  }

  async function removeSeries(id: ID) {
    const s = seriesList.value.find((x) => x.id === id)
    await deleteSeriesDeep(id, s?.episodeIds ?? [])
    seriesList.value = seriesList.value.filter((x) => x.id !== id)
    if (currentId.value === id) {
      currentId.value = seriesList.value[0]?.id ?? null
      await kvSet('currentSeriesId', currentId.value)
      await loadEpisodes(currentId.value)
    }
  }

  async function moveEpisode(id: ID, dir: -1 | 1) {
    const s = seriesList.value.find((x) => x.id === currentId.value)
    if (!s) return
    const ids = [...(s.episodeIds ?? [])]
    const i = ids.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    s.episodeIds = ids
    s.updatedAt = now()
    await saveOne(db.projects, { ...s })
    await loadEpisodes(s.id)
  }

  /* --------------------------- 大主体 / 集主体 复制 --------------------------- */

  /** 某项目内主体参考图（kind!=scene）的下一个可用 PictureN */
  async function nextPictureN(projectId: ID): Promise<number> {
    const assets = await db.assets.where('projectId').equals(projectId).toArray()
    const used = new Set(assets.filter((a) => a.kind !== 'scene' && a.pictureN > 0).map((a) => a.pictureN))
    let n = 1
    while (used.has(n)) n++
    return n
  }

  /**
   * 跨项目复制一个主体：读源实体 +（若带图）源参考图，在目标项目建一个副本，
   * 参考图重新上传并分配新的 PictureN。打上 sourceId 溯源。
   * 返回副本实体 + 图片是否成功复制（复制失败时主体仍会建，仅 pictureN 为空）。
   */
  async function copyEntity(
    srcProjectId: ID,
    srcEntityId: ID,
    dstProjectId: ID
  ): Promise<{ entity: Entity; imageCopied: boolean }> {
    const srcEnt = await db.entities.get(srcEntityId)
    if (!srcEnt) throw new Error('找不到要复制的主体')

    let srcAsset: Asset | null = null
    if (srcEnt.pictureN && srcEnt.pictureN > 0) {
      const assets = await db.assets.where('projectId').equals(srcProjectId).toArray()
      srcAsset = assets.find((a) => a.pictureN === srcEnt.pictureN) ?? null
    }

    const ts = now()
    const newEntityId = uid('ent')

    let dstPictureN: number | null = null
    let imageCopied = false
    if (srcAsset && srcAsset.pictureN > 0) {
      try {
        const n = await nextPictureN(dstProjectId)
        const resp = await fetch(backendAssetUrl(srcProjectId, srcAsset.fileName))
        if (!resp.ok) throw new Error(`读取源图失败 ${resp.status}`)
        const blob = await resp.blob()
        const fileName = `Picture${n}.png`
        await backendUploadAsset(dstProjectId, fileName, blob)
        await saveOne(db.assets, {
          id: uid('ast'),
          projectId: dstProjectId,
          pictureN: n,
          fileName,
          originalName: srcAsset.originalName,
          label: srcAsset.label,
          kind: 'subject',
          refId: newEntityId,
          createdAt: ts
        })
        dstPictureN = n
        imageCopied = true
      } catch {
        dstPictureN = null
        imageCopied = false
      }
    }

    const dstEnt: Entity = {
      id: newEntityId,
      projectId: dstProjectId,
      name: srcEnt.name,
      type: srcEnt.type,
      kind: srcEnt.kind,
      subjectN: null,
      sx: null,
      pictureN: dstPictureN,
      voiceDesc: srcEnt.voiceDesc ?? null,
      textDesc: srcEnt.textDesc ?? null,
      nameEn: srcEnt.nameEn ?? null,
      voiceDescEn: srcEnt.voiceDescEn ?? null,
      textDescEn: srcEnt.textDescEn ?? null,
      note: srcEnt.note,
      sourceId: srcEnt.id,
      createdAt: ts,
      updatedAt: ts
    }
    await saveOne(db.entities, dstEnt)
    return { entity: dstEnt, imageCopied }
  }

  /** 把项目(系列)里的「大主体」注入到某一集（复制进该集） */
  async function injectToEpisode(seriesId: ID, seriesEntityId: ID, episodeId: ID) {
    return await copyEntity(seriesId, seriesEntityId, episodeId)
  }

  /** 把某集里的主体「提升」为项目(系列)的「大主体」（复制回项目） */
  async function promoteToSeries(episodeId: ID, episodeEntityId: ID, seriesId: ID) {
    return await copyEntity(episodeId, episodeEntityId, seriesId)
  }

  /** 某「大主体」已被注入到哪些集（按 name 匹配副本的 sourceId） */
  async function episodesWithEntity(seriesId: ID, seriesEntityId: ID): Promise<ID[]> {
    const s = seriesList.value.find((x) => x.id === seriesId)
    const ids = s?.episodeIds ?? []
    const out: ID[] = []
    for (const eid of ids) {
      const ents = await db.entities.where('projectId').equals(eid).toArray()
      if (ents.some((e) => e.sourceId === seriesEntityId)) out.push(eid)
    }
    return out
  }

  function reset() {
    seriesList.value = []
    currentId.value = null
    episodes.value = []
  }

  return {
    seriesList,
    currentId,
    current,
    episodes,
    loading,
    loadAll,
    select,
    loadEpisodes,
    createSeries,
    createEpisode,
    renameSeries,
    renameEpisode,
    removeEpisode,
    removeSeries,
    moveEpisode,
    nextPictureN,
    copyEntity,
    injectToEpisode,
    promoteToSeries,
    episodesWithEntity,
    reset
  }
})
