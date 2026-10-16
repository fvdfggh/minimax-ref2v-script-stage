import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, saveMany, saveOne } from '@/db'
import { backendAssetUrl } from '@/core/backend'
import { uid, now } from '@/core/id'
import {
  applyNumbering,
  computeNumbering,
  normalizeVoiceDesc,
  numberingIsStale
} from '@/domain/registry'
import type { Asset, AssetKind, Beat, Entity, ID } from '@/domain/types'

export const useRegistryStore = defineStore('registry', () => {
  const entities = ref<Entity[]>([])
  const assets = ref<Asset[]>([])
  const loading = ref(false)

  const entityById = computed(() => new Map(entities.value.map((e) => [e.id, e])))
  const entityByName = computed(() => new Map(entities.value.map((e) => [e.name, e])))
  const sortedEntities = computed(() =>
    [...entities.value].sort((a, b) => (a.subjectN ?? 9999) - (b.subjectN ?? 9999))
  )
  const speakingEntities = computed(() => entities.value.filter((e) => e.kind === 'speaking'))

  async function load(projectId: ID) {
    loading.value = true
    try {
      entities.value = await db.entities.where('projectId').equals(projectId).toArray()
      assets.value = await db.assets.where('projectId').equals(projectId).sortBy('pictureN')
    } finally {
      loading.value = false
    }
  }

  function reset() {
    entities.value = []
    assets.value = []
  }

  /* ----------------------------- 实体 ----------------------------- */

  async function addEntity(projectId: ID, patch: Partial<Entity> & { name: string }) {
    const ts = now()
    const entity: Entity = {
      id: uid('ent'),
      projectId,
      name: patch.name,
      type: patch.type ?? 'character',
      kind: patch.kind ?? 'non_speaking',
      subjectN: null,
      sx: null,
      pictureN: patch.pictureN ?? null,
      voiceDesc: patch.voiceDesc ?? null,
      textDesc: patch.textDesc ?? null,
      note: patch.note,
      createdAt: ts,
      updatedAt: ts
    }
    await saveOne(db.entities, entity)
    entities.value = [...entities.value, entity]
    return entity
  }

  /** 批量创建（阶段一由模型提议的实体） */
  async function addEntitiesBulk(
    projectId: ID,
    items: Array<Partial<Entity> & { name: string }>
  ): Promise<Entity[]> {
    const existingNames = new Set(entities.value.map((e) => e.name))
    const created: Entity[] = []

    for (const item of items) {
      const name = (item.name ?? '').trim()
      if (!name || existingNames.has(name)) continue
      existingNames.add(name)
      // 模型无法绑定素材，先登记为纯文本描述实体，素材后续在注册表里手动关联
      const ts = now()
      created.push({
        id: uid('ent'),
        projectId,
        name,
        type: item.type ?? 'character',
        kind: item.kind === 'speaking' ? 'speaking' : 'non_speaking',
        subjectN: null,
        sx: null,
        pictureN: null,
        voiceDesc: item.kind === 'speaking' ? normalizeVoiceDesc(item.voiceDesc ?? '') : null,
        textDesc: item.textDesc ?? null,
        note: item.note,
        createdAt: ts,
        updatedAt: ts
      })
    }
    if (created.length) {
      await saveMany(db.entities, created)
      entities.value = [...entities.value, ...created]
    }
    return created
  }

  /**
   * 中文原文一改，之前译好的英文词条就过期了。
   * 统一在这里失效，避免英文终稿停留在旧译文上而没人发现。
   */
  function invalidateTranslations(prev: Entity, next: Entity): Entity {
    let out = next
    const drop = (enKey: 'nameEn' | 'voiceDescEn' | 'textDescEn') => {
      if (out[enKey] === undefined || out[enKey] === null) return
      out = { ...out, [enKey]: null }
    }
    if (next.name !== prev.name) drop('nameEn')
    if (next.voiceDesc !== prev.voiceDesc) drop('voiceDescEn')
    if (next.textDesc !== prev.textDesc) drop('textDescEn')
    return out
  }

  async function updateEntity(id: ID, patch: Partial<Entity>) {
    const idx = entities.value.findIndex((e) => e.id === id)
    if (idx < 0) return
    const next = invalidateTranslations(entities.value[idx], {
      ...entities.value[idx],
      ...patch,
      updatedAt: now()
    })
    if (patch.kind === 'non_speaking') {
      next.sx = null
      next.voiceDesc = next.voiceDesc ?? null
    }
    await saveOne(db.entities, next)
    const copy = [...entities.value]
    copy[idx] = next
    entities.value = copy
  }

  /** 每个实体写各自的 patch（阶段五词条回写用） */
  async function patchEntities(patches: Array<{ id: ID; patch: Partial<Entity> }>) {
    const byId = new Map(patches.map((p) => [p.id, p.patch]))
    if (!byId.size) return 0
    const changed: Entity[] = []
    const next = entities.value.map((e) => {
      const patch = byId.get(e.id)
      if (!patch) return e
      const merged = invalidateTranslations(e, { ...e, ...patch, updatedAt: now() })
      changed.push(merged)
      return merged
    })
    if (changed.length) {
      await saveMany(db.entities, changed)
      entities.value = next
    }
    return changed.length
  }

  async function removeEntity(id: ID) {
    await db.entities.delete(id)
    entities.value = entities.value.filter((e) => e.id !== id)
  }

  /** 依据当前 Beats 重新分配全片编号 */
  async function renumber(beats: Beat[]) {
    const map = computeNumbering(entities.value, beats)
    const next = applyNumbering(entities.value, map)
    const changed = next.filter((e, i) => e !== entities.value[i])
    if (changed.length) await saveMany(db.entities, changed)
    entities.value = next
    return changed.length
  }

  function stale(beats: Beat[]) {
    return numberingIsStale(entities.value, beats)
  }

  /* ----------------------------- 素材 ----------------------------- */

  async function addAsset(
    projectId: ID,
    file: File,
    label = ''
  ): Promise<Asset> {
    const existing = assets.value.map((a) => a.pictureN)
    let pictureN = 1
    while (existing.includes(pictureN)) pictureN++
    const asset: Asset = {
      id: uid('ast'),
      projectId,
      pictureN,
      fileName: `Picture${pictureN}.png`,
      originalName: file.name,
      label: label || file.name.replace(/\.[^.]+$/, ''),
      blob: file,
      createdAt: now()
    }
    await saveOne(db.assets, asset)
    assets.value = [...assets.value, asset].sort((a, b) => a.pictureN - b.pictureN)
    return asset
  }

  /**
   * 存一张由模型生成/编辑出的图片。
   *   kind=scene  → pictureN 固定 0，不进导演包 reference 槽，仅本地查看（场景图）
   *   kind=subject→ 分配下一个可用 PictureN（进 reference 槽）
   */
  async function addGeneratedImage(
    projectId: ID,
    blob: Blob,
    opts: { label?: string; kind?: AssetKind; refId?: ID } = {}
  ): Promise<Asset> {
    const kind: AssetKind = opts.kind ?? 'subject'
    const isScene = kind === 'scene'
    let pictureN = 0
    if (!isScene) {
      const used = assets.value.map((a) => a.pictureN).filter((n) => n > 0)
      pictureN = 1
      while (used.includes(pictureN)) pictureN++
    }
    const ts = now()
    const type = blob.type || 'image/png'
    const file = new File([blob], 'generated.png', { type })
    const safeRef = (opts.refId ?? 'img').replace(/[^A-Za-z0-9_-]/g, '')
    const fileName = isScene ? `scene_${safeRef}_${ts % 100000}.png` : `Picture${pictureN}.png`
    const asset: Asset = {
      id: uid('ast'),
      projectId,
      pictureN,
      fileName,
      originalName: file.name,
      label: opts.label || (isScene ? '场景图' : '主体参考图'),
      blob,
      kind,
      refId: opts.refId,
      createdAt: ts
    }
    await saveOne(db.assets, asset)
    assets.value = [...assets.value, asset].sort((a, b) => a.pictureN - b.pictureN)
    return asset
  }

  async function updateAsset(id: ID, patch: Partial<Asset>) {
    const idx = assets.value.findIndex((a) => a.id === id)
    if (idx < 0) return
    const next = { ...assets.value[idx], ...patch }
    await saveOne(db.assets, next)
    const copy = [...assets.value]
    copy[idx] = next
    assets.value = copy
  }

  async function removeAsset(id: ID) {
    await db.assets.delete(id)
    assets.value = assets.value.filter((a) => a.id !== id)
  }

  /**
   * 素材编号出现空档时压缩重排。
   * 只重排主体参考图（kind!=scene 且 pictureN>0）；场景图 pictureN 恒为 0，
   * 不参与 reference 编号，避免把主体编号顶出 1~9 的槽位。
   */
  async function compactAssets() {
    const subjectAssets = [...assets.value]
      .filter((a) => a.kind !== 'scene' && a.pictureN > 0)
      .sort((a, b) => a.pictureN - b.pictureN)
    const patched: Asset[] = []
    subjectAssets.forEach((a, i) => {
      const pictureN = i + 1
      if (a.pictureN !== pictureN) {
        patched.push({
          ...a,
          pictureN,
          fileName: `Picture${pictureN}.png`
        })
      }
    })
    if (patched.length) await saveMany(db.assets, patched)
    const byId = new Map(patched.map((p) => [p.id, p]))
    assets.value = [...assets.value]
      .sort((a, b) => a.pictureN - b.pictureN)
      .map((a) => byId.get(a.id) ?? a)
    return patched.length
  }

  /** 主体的参考图（按 entity.pictureN 反查；手工上传与生成统一走这里） */
  function subjectImageFor(entityId: ID): Asset | null {
    const e = entities.value.find((x) => x.id === entityId)
    if (!e || e.pictureN == null || e.pictureN <= 0) return null
    return assets.value.find((a) => a.pictureN === e.pictureN) ?? null
  }

  /** 片段的场景图（pictureN=0，靠 refId=beatId 定位） */
  function sceneImageFor(beatId: ID): Asset | null {
    return assets.value.find((a) => a.kind === 'scene' && a.refId === beatId) ?? null
  }

  function assetUrl(asset: Asset): string | null {
    // 图片本体在数据目录里，统一走后端地址
    return backendAssetUrl(asset.projectId, asset.fileName)
  }

  return {
    entities,
    assets,
    loading,
    entityById,
    entityByName,
    sortedEntities,
    speakingEntities,
    load,
    reset,
    addEntity,
    addEntitiesBulk,
    updateEntity,
    patchEntities,
    removeEntity,
    renumber,
    stale,
    addAsset,
    addGeneratedImage,
    updateAsset,
    removeAsset,
    compactAssets,
    subjectImageFor,
    sceneImageFor,
    assetUrl
  }
})
