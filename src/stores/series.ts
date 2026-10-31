import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, deleteProjectDeep, deleteSeriesDeep, kvGet, kvSet, saveOne } from '@/db'
import { backendAssetUrl, backendUploadAsset, getBackendProject, setBackendProject } from '@/core/backend'
import { uid, now } from '@/core/id'
import { DEFAULT_FIELD_SCHEMA, DEFAULT_SETTINGS, isSeries, normalizeEntityType } from '@/domain/types'
import type { Asset, Entity, ID, Project, RefSheet } from '@/domain/types'
import { sheetOf } from '@/domain/refSheet'

/** 项目层空主体的占位备注：被拆解结果回填时可以被替换 */
const BLANK_SUBJECT_NOTE = '拆解时自动登记的项目主体，设定待补'

/** 跨项目取用 / 推送的结果 */
export interface CopyEntityResult {
  entity: Entity
  /** 参考图是否被复制（源没图 / 复制失败时为 false） */
  imageCopied: boolean
  /** 目标项目里已有同一主体的副本：本次同步了描述，没有新建 */
  reused: boolean
}

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

  /**
   * 给某一集绑定工作流模板（空 = 用控制台里的当前模板）。
   *
   * 存 id 而不是快照：模板改了参数，绑定的集跟着变；要冻结某一集的参数，
   * 用户应该在控制台「复制」一份模板再绑定 —— 这样"改了谁"永远看得见。
   */
  async function setEpisodeTemplate(id: ID, templateId: ID | '') {
    const e = episodes.value.find((x) => x.id === id)
    if (!e) return
    if (templateId) e.workflowTemplateId = templateId
    else delete e.workflowTemplateId
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

  /* --------------------------- 项目层主体（拆解用） --------------------------- */

  /**
   * 读项目(系列)自己的实体表 —— 拆解时作为「外部项目主体」交给模型。
   *
   * 按 projectId 查会把后端的「当前项目」切到项目层（HttpTable 的副作用），
   * 读完必须切回来：否则之后在集里删素材 / 删片段会落到项目层目录上，
   * 静默地"删了个空"。
   */
  async function subjectsOf(seriesId: ID): Promise<Entity[]> {
    const prev = getBackendProject()
    try {
      return await db.entities.where('projectId').equals(seriesId).toArray()
    } finally {
      setBackendProject(prev)
    }
  }

  /**
   * 在项目层建一个「空主体」：只落名字 / 类型 / 是否说话，外观与音色留空。
   *
   * 拆解前先有这个占位，同名主体就不会在集里被重复定义（第 2 集不会再造一份
   * 「林医生」）。设定由拆解结果回填（见 fillBlankSubject），只补空字段，
   * 不覆盖项目层已经写好的母版设定。
   * 同名已存在时不新建，直接返回母版 —— 模型重复登记不该产生第二份。
   */
  async function addBlankSubject(
    seriesId: ID,
    brief: { name: string; type?: string; kind?: string }
  ): Promise<{ entity: Entity; created: boolean }> {
    const name = (brief.name ?? '').trim()
    if (!name) throw new Error('项目主体需要名字')
    const all = await subjectsOf(seriesId)
    const hit = all.find((e) => e.name === name)
    if (hit) return { entity: hit, created: false }

    const ts = now()
    const entity: Entity = {
      id: uid('ent'),
      projectId: seriesId,
      name,
      type: normalizeEntityType(brief.type),
      kind: brief.kind === 'speaking' ? 'speaking' : 'non_speaking',
      subjectN: null,
      sx: null,
      pictureN: null,
      voiceDesc: null,
      textDesc: null,
      costumeDesc: null,
      note: BLANK_SUBJECT_NOTE,
      createdAt: ts,
      updatedAt: ts
    }
    await saveOne(db.entities, entity)
    return { entity, created: true }
  }

  /** 把拆解得到的设定补进项目层的空主体：只补空字段，母版已有的一个字都不动 */
  async function fillBlankSubject(
    entityId: ID,
    patch: {
      voiceDesc?: string | null
      textDesc?: string | null
      costumeDesc?: string | null
      note?: string | null
    }
  ): Promise<Entity | null> {
    const cur = await db.entities.get(entityId)
    if (!cur) return null
    const next: Entity = { ...cur }
    if (!next.voiceDesc && patch.voiceDesc) next.voiceDesc = patch.voiceDesc
    if (!next.textDesc && patch.textDesc) next.textDesc = patch.textDesc
    if (!next.costumeDesc && patch.costumeDesc) next.costumeDesc = patch.costumeDesc
    if ((!next.note || next.note === BLANK_SUBJECT_NOTE) && patch.note) next.note = patch.note
    const changed =
      next.voiceDesc !== cur.voiceDesc ||
      next.textDesc !== cur.textDesc ||
      next.costumeDesc !== cur.costumeDesc ||
      next.note !== cur.note
    if (!changed) return cur
    next.updatedAt = now()
    await saveOne(db.entities, next)
    return next
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

  /** 某项目里的主体参考图（kind != scene） */
  async function subjectAssetOf(projectId: ID, entity: Entity): Promise<Asset | null> {
    if (!entity.pictureN || entity.pictureN <= 0) return null
    const assets = await db.assets.where('projectId').equals(projectId).toArray()
    return assets.find((a) => a.pictureN === entity.pictureN) ?? null
  }

  /**
   * 把源主体的「设定图组」（基模头 + 各组组头 / 三视图）整体搬到目标项目。
   *
   * 组本身只是一堆 asset id，跨项目后这些 id 都不存在了，所以必须
   * **逐张把文件重新上传**再换 id —— 只抄结构会得到一排坏图。
   * 单张失败就跳过那张（组还在，只是少一张），不要整组放弃。
   *
   * 目标已经有自己的设定图组时**不覆盖**：那是本集自己调过的造型。
   */
  async function copySheet(
    srcProjectId: ID,
    srcEntity: Entity,
    dstProjectId: ID,
    dstEntityId: ID
  ): Promise<RefSheet | null> {
    const src = sheetOf(srcEntity)
    if (!src.masterId && !src.groups.length) return null

    const idMap = new Map<ID, ID>()
    const copyOne = async (assetId: ID | null): Promise<ID | null> => {
      if (!assetId) return null
      const done = idMap.get(assetId)
      if (done) return done
      const a = await db.assets.get(assetId)
      if (!a) return null
      try {
        const resp = await fetch(backendAssetUrl(srcProjectId, a.fileName))
        if (!resp.ok) throw new Error(`读取源设定图失败 ${resp.status}`)
        const blob = await resp.blob()
        const fileName = `sheet_${dstEntityId}_${uid('x').replace(/[^A-Za-z0-9]/g, '').slice(0, 6)}.png`
        await backendUploadAsset(dstProjectId, fileName, blob)
        const nid = uid('ast')
        await saveOne(db.assets, {
          id: nid,
          projectId: dstProjectId,
          pictureN: 0,
          fileName,
          originalName: a.originalName,
          label: a.label,
          desc: a.desc,
          kind: 'sheet',
          refId: dstEntityId,
          createdAt: now()
        } as Asset)
        idMap.set(assetId, nid)
        return nid
      } catch {
        return null
      }
    }

    const masterId = await copyOne(src.masterId ?? null)
    const groups: RefSheet['groups'] = []
    for (const g of src.groups) {
      const headId = await copyOne(g.headId)
      const viewIds: ID[] = []
      for (const v of g.viewIds) {
        const nid = await copyOne(v)
        if (nid) viewIds.push(nid)
      }
      if (!headId && !viewIds.length) continue
      // pickedViewId 存的是**源项目**的 asset id，跨项目后必须换成新 id ——
      // 不换的话，注入到新集之后"拼这张"的角标会指向一个不存在的图，
      // 用户点「拼成参考图」就会拼到默认的第一张（看起来像"选择没生效"）。
      const picked = g.pickedViewId ? (idMap.get(g.pickedViewId) ?? null) : null
      groups.push({
        ...g,
        id: uid('grp'),
        headId,
        viewIds,
        pickedViewId: picked && viewIds.includes(picked) ? picked : (viewIds[0] ?? null)
      })
    }
    if (!masterId && !groups.length) return null
    // active 指向的是"源项目的那张图"，跨项目后没有对应关系，直接不带
    return { masterId, groups, active: null }
  }

  /**
   * 目标项目里已有的同源副本。
   * 「取用」和「推送」都可能被点第二次，没有这一步就会堆出一串同名副本。
   */
  async function findCopyIn(dstProjectId: ID, srcEntityId: ID): Promise<Entity | null> {
    const ents = await db.entities.where('projectId').equals(dstProjectId).toArray()
    return ents.find((e) => e.sourceId === srcEntityId) ?? null
  }

  /**
   * 反过来：源实体本身就是"从目标项目推过来的副本"。
   *
   * 例：项目里的小明被取到第 1 集（副本 sourceId=项目小明），在第 1 集改完之后
   * 再推回项目 —— 此时项目里的"项目小明"才是本体，应该更新它，而不是
   * 造一个 sourceId 指向集内副本的新实体（那会让项目里出现自己的影子）。
   */
  async function originIn(srcEnt: Entity, dstProjectId: ID): Promise<Entity | null> {
    if (!srcEnt.sourceId) return null
    const origin = await db.entities.get(srcEnt.sourceId)
    return origin && origin.projectId === dstProjectId ? origin : null
  }

  /**
   * 用源实体的内容更新已有副本（不新建）。
   *
   * 只同步"描述层"（名称 / 类型 / 描述 / 声音 / 备注 / 英文词条），
   * **不覆盖**目标已有的参考图：那是本集自己调过的，覆盖掉很难解释。
   * 只有目标完全没有图、源有图时才补一张。
   */
  async function syncCopy(
    srcProjectId: ID,
    srcEnt: Entity,
    dstEnt: Entity
  ): Promise<CopyEntityResult> {
    let pictureN = dstEnt.pictureN
    let imageCopied = false

    if (!dstEnt.pictureN) {
      const srcAsset = await subjectAssetOf(srcProjectId, srcEnt)
      if (srcAsset && srcAsset.pictureN > 0) {
        try {
          const n = await nextPictureN(dstEnt.projectId)
          const resp = await fetch(backendAssetUrl(srcProjectId, srcAsset.fileName))
          if (!resp.ok) throw new Error(`读取源图失败 ${resp.status}`)
          const blob = await resp.blob()
          const fileName = `Picture${n}.png`
          await backendUploadAsset(dstEnt.projectId, fileName, blob)
          await saveOne(db.assets, {
            id: uid('ast'),
            projectId: dstEnt.projectId,
            pictureN: n,
            fileName,
            originalName: srcAsset.originalName,
            label: srcAsset.label,
            desc: srcAsset.desc,
            kind: 'subject',
            refId: dstEnt.id,
            createdAt: now()
          })
          pictureN = n
          imageCopied = true
        } catch {
          pictureN = null
        }
      }
    }

    // 描述层同步不动目标已有的设定图组；只有目标完全没建过组时才补一份
    const dstSheet = sheetOf(dstEnt)
    const refSheet =
      !dstSheet.masterId && !dstSheet.groups.length
        ? (await copySheet(srcProjectId, srcEnt, dstEnt.projectId, dstEnt.id)) ?? dstEnt.refSheet ?? null
        : dstEnt.refSheet ?? null

    const next: Entity = {
      ...dstEnt,
      name: srcEnt.name,
      type: srcEnt.type,
      kind: srcEnt.kind,
      pictureN,
      refSheet,
      voiceDesc: srcEnt.voiceDesc ?? null,
      textDesc: srcEnt.textDesc ?? null,
      costumeDesc: srcEnt.costumeDesc ?? null,
      nameEn: srcEnt.nameEn ?? null,
      voiceDescEn: srcEnt.voiceDescEn ?? null,
      textDescEn: srcEnt.textDescEn ?? null,
      costumeDescEn: srcEnt.costumeDescEn ?? null,
      voicePack: srcEnt.voicePack ?? null,
      note: srcEnt.note,
      updatedAt: now()
    }
    await saveOne(db.entities, next)
    return { entity: next, imageCopied, reused: true }
  }

  /**
   * 跨项目复制一个主体：读源实体 +（若带图）源参考图，在目标项目建一个副本，
   * 参考图重新上传并分配新的 PictureN。打上 sourceId 溯源。
   *
   * 目标项目里已经存在同一主体的副本时**不新建**，改为把描述同步过去
   * （reused = true），这样反复点「取用 / 推送」不会堆副本。
   */
  async function copyEntity(
    srcProjectId: ID,
    srcEntityId: ID,
    dstProjectId: ID
  ): Promise<CopyEntityResult> {
    // 复制过程要跨项目读写，会把后端"当前项目"切到目标项目；
    // 结束后必须切回来，否则调用方后续的删除会落到别人的目录里。
    const prevProject = getBackendProject()
    try {
      return await copyEntityScoped(srcProjectId, srcEntityId, dstProjectId)
    } finally {
      setBackendProject(prevProject)
    }
  }

  async function copyEntityScoped(
    srcProjectId: ID,
    srcEntityId: ID,
    dstProjectId: ID
  ): Promise<CopyEntityResult> {
    const srcEnt = await db.entities.get(srcEntityId)
    if (!srcEnt) throw new Error('找不到要复制的主体')

    const existing =
      (await findCopyIn(dstProjectId, srcEntityId)) ?? (await originIn(srcEnt, dstProjectId))
    if (existing) return await syncCopy(srcProjectId, srcEnt, existing)

    const srcAsset = await subjectAssetOf(srcProjectId, srcEnt)

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
          desc: srcAsset.desc,
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

    // 新建副本时设定图组整体搬过来（文件重传、id 重映射），否则到了新集只剩一张参考图
    const dstRefSheet = await copySheet(srcProjectId, srcEnt, dstProjectId, newEntityId)

    const dstEnt: Entity = {
      id: newEntityId,
      projectId: dstProjectId,
      name: srcEnt.name,
      type: srcEnt.type,
      kind: srcEnt.kind,
      subjectN: null,
      sx: null,
      pictureN: dstPictureN,
      refSheet: dstRefSheet,
      voiceDesc: srcEnt.voiceDesc ?? null,
      textDesc: srcEnt.textDesc ?? null,
      costumeDesc: srcEnt.costumeDesc ?? null,
      nameEn: srcEnt.nameEn ?? null,
      voiceDescEn: srcEnt.voiceDescEn ?? null,
      textDescEn: srcEnt.textDescEn ?? null,
      costumeDescEn: srcEnt.costumeDescEn ?? null,
      // 音色包是磁盘上的一个文件（voiceId），复制只是带个引用：
      // 项目与集共用同一个包，正是"同一角色跨集同声"想要的效果
      voicePack: srcEnt.voicePack ?? null,
      note: srcEnt.note,
      sourceId: srcEnt.id,
      createdAt: ts,
      updatedAt: ts
    }
    await saveOne(db.entities, dstEnt)
    return { entity: dstEnt, imageCopied, reused: false }
  }

  /** 把项目(系列)里的「大主体」取到某一集（已有的同源副本则同步描述） */
  async function injectToEpisode(seriesId: ID, seriesEntityId: ID, episodeId: ID) {
    return await copyEntity(seriesId, seriesEntityId, episodeId)
  }

  /**
   * 拆解产出的主体 → 项目层母版 → 取用到本集，一条链路走完。
   *
   * 顺序不能反：先有母版，本集拿到的是带 sourceId 的副本。这样第 2 集拆解时
   * 能在「外部项目主体」清单里看到它，不会再定义一遍。
   * 母版已有的设定（长相 / 服装 / 音色）一个字都不覆盖 —— 那是跨集唯一真相源；
   * 只有刚建的空壳才用这次拆解的结果填。
   */
  async function publishToEpisode(
    seriesId: ID,
    episodeId: ID,
    items: Array<{
      name: string
      type?: string
      kind?: string
      voiceDesc?: string | null
      textDesc?: string | null
      costumeDesc?: string | null
      note?: string | null
    }>
  ): Promise<{
    createdInProject: number
    injected: number
    synced: number
    entities: Entity[]
  }> {
    let createdInProject = 0
    let injected = 0
    let synced = 0
    const out: Entity[] = []

    for (const item of items) {
      const { entity: blank, created } = await addBlankSubject(seriesId, item)
      if (created) createdInProject += 1
      const master = (await fillBlankSubject(blank.id, item)) ?? blank
      const res = await injectToEpisode(seriesId, master.id, episodeId)
      if (res.reused) synced += 1
      else injected += 1
      out.push(res.entity)
    }
    return { createdInProject, injected, synced, entities: out }
  }

  /** 把某集里的主体「推送」到项目(系列)（若它本身就取用于项目，则更新项目里的那个） */
  async function promoteToSeries(episodeId: ID, episodeEntityId: ID, seriesId: ID) {
    return await copyEntity(episodeId, episodeEntityId, seriesId)
  }

  /** 某「大主体」已被取到哪些集（按副本的 sourceId 反查） */
  async function episodesWithEntity(seriesId: ID, seriesEntityId: ID): Promise<ID[]> {
    const prevProject = getBackendProject()
    const s = seriesList.value.find((x) => x.id === seriesId)
    const ids = s?.episodeIds ?? []
    const out: ID[] = []
    try {
      for (const eid of ids) {
        const ents = await db.entities.where('projectId').equals(eid).toArray()
        if (ents.some((e) => e.sourceId === seriesEntityId)) out.push(eid)
      }
    } finally {
      setBackendProject(prevProject)
    }
    return out
  }

  /**
   * 项目层主体的流转情况，一次读全：
   *   usedBy —— 某个大主体被哪些集取用过（entityId → episodeId[]）
   *   origin —— 某个大主体本身是从哪一集推送来的（entityId → episodeId）
   *
   * 集多的时候逐主体查会慢一个数量级，所以按集读一遍再反查。
   * 跨项目读会把后端的"当前项目"切走，结束后必须切回来 —— 否则后续的
   * 删除操作会落到别的项目目录里。
   */
  async function usageOf(seriesId: ID): Promise<{
    usedBy: Record<ID, ID[]>
    origin: Record<ID, ID>
  }> {
    const prevProject = getBackendProject()
    const s = seriesList.value.find((x) => x.id === seriesId)
    const ids = s?.episodeIds ?? []
    const usedBy: Record<ID, ID[]> = {}
    const origin: Record<ID, ID> = {}
    try {
      const seriesEnts = await db.entities.where('projectId').equals(seriesId).toArray()
      const perEpisode: Array<{ eid: ID; ents: Entity[] }> = []
      for (const eid of ids) {
        perEpisode.push({ eid, ents: await db.entities.where('projectId').equals(eid).toArray() })
      }
      const epOfEntity = new Map<ID, ID>()
      for (const { eid, ents } of perEpisode) {
        for (const e of ents) {
          epOfEntity.set(e.id, eid)
          if (!e.sourceId) continue
          ;(usedBy[e.sourceId] ??= []).push(eid)
        }
      }
      for (const se of seriesEnts) {
        if (!se.sourceId) continue
        const eid = epOfEntity.get(se.sourceId)
        if (eid) origin[se.id] = eid
      }
    } finally {
      setBackendProject(prevProject)
    }
    return { usedBy, origin }
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
    setEpisodeTemplate,
    removeEpisode,
    removeSeries,
    moveEpisode,
    nextPictureN,
    subjectsOf,
    addBlankSubject,
    fillBlankSubject,
    copyEntity,
    injectToEpisode,
    publishToEpisode,
    promoteToSeries,
    episodesWithEntity,
    usageOf,
    reset
  }
})
