import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, saveMany, saveOne } from '@/db'
import { backendAssetUrl, backendComposeSheet, getBackendProject, setBackendProject } from '@/core/backend'
import { uid, now } from '@/core/id'
import {
  applyNumbering,
  computeNumbering,
  normalizeVoiceDesc,
  numberingIsStale
} from '@/domain/registry'
import type {
  Asset,
  AssetActAs,
  AssetKind,
  Beat,
  Entity,
  ID,
  KeyframeLayout,
  KeyframePlacement,
  KeyframeRole,
  MediaKind,
  RefSheet
} from '@/domain/types'
import { normalizeEntityType } from '@/domain/types'
import { dropAsset, findGroup, sheetAssetIds, sheetOf } from '@/domain/refSheet'
import {
  ACT_AS_LABEL,
  PLACEMENT_LABEL,
  STRENGTH_HARD,
  actAsOf,
  clampFrame,
  clampStrength,
  extOf,
  forcedKeyframesOf,
  isRefImage,
  keyframesOf,
  layoutKeyframes,
  materialsOf,
  mediaKindOf,
  placementOf,
  placementOfRole,
  roleOfPlacement,
  strengthOf
} from '@/domain/references'
import { audioDurationSec } from '@/domain/audioFrames'

export const useRegistryStore = defineStore('registry', () => {
  const entities = ref<Entity[]>([])
  const assets = ref<Asset[]>([])
  const loading = ref(false)
  /**
   * 已经加载过素材的项目 id。
   *
   * `assets` 为空有两种意思：这个项目真的一条素材都没有，或者还没开始加载。
   * 有些逻辑（台词段自动建配音格）**必须**分清这两者 —— 把"还没加载"当成
   * "没有素材"，会给已经有配音的段凭空多建一格占位。
   */
  const loadedProjectId = ref<ID | null>(null)

  const entityById = computed(() => new Map(entities.value.map((e) => [e.id, e])))
  const entityByName = computed(() => new Map(entities.value.map((e) => [e.name, e])))
  const sortedEntities = computed(() =>
    [...entities.value].sort((a, b) => (a.subjectN ?? 9999) - (b.subjectN ?? 9999))
  )
  const speakingEntities = computed(() => entities.value.filter((e) => e.kind === 'speaking'))

  async function load(projectId: ID) {
    loading.value = true
    try {
      const rows = await db.entities.where('projectId').equals(projectId).toArray()
      // 主体只有三类。老项目里可能还有 ui / other，读进来就地收口成道具并写回，
      // 免得列表分组把它们漏掉（漏掉等于主体"消失"，但还在包里）。
      const fixed: Entity[] = []
      for (const e of rows) {
        const t = normalizeEntityType(e.type)
        if (t !== e.type) {
          e.type = t
          fixed.push(e)
        }
      }
      if (fixed.length) await saveMany(db.entities, fixed)
      entities.value = rows
      assets.value = await db.assets.where('projectId').equals(projectId).sortBy('pictureN')
      loadedProjectId.value = projectId
    } finally {
      loading.value = false
    }
    // 老项目的音频没有 durationSec，后台补测一次；失败不影响加载
    void ensureAudioDurations().catch(() => 0)
  }

  function reset() {
    entities.value = []
    assets.value = []
    loadedProjectId.value = null
  }

  /* ----------------------------- 实体 ----------------------------- */

  async function addEntity(projectId: ID, patch: Partial<Entity> & { name: string }) {
    const ts = now()
    const entity: Entity = {
      id: uid('ent'),
      projectId,
      name: patch.name,
      type: patch.type ? normalizeEntityType(patch.type) : 'character',
      kind: patch.kind ?? 'non_speaking',
      subjectN: null,
      sx: null,
      pictureN: patch.pictureN ?? null,
      voiceDesc: patch.voiceDesc ?? null,
      textDesc: patch.textDesc ?? null,
      costumeDesc: patch.costumeDesc ?? null,
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
        type: item.type ? normalizeEntityType(item.type) : 'character',
        kind: item.kind === 'speaking' ? 'speaking' : 'non_speaking',
        subjectN: null,
        sx: null,
        pictureN: null,
        voiceDesc: item.kind === 'speaking' ? normalizeVoiceDesc(item.voiceDesc ?? '') : null,
        textDesc: item.textDesc ?? null,
        costumeDesc: item.costumeDesc ?? null,
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
    const drop = (enKey: 'nameEn' | 'voiceDescEn' | 'textDescEn' | 'costumeDescEn') => {
      if (out[enKey] === undefined || out[enKey] === null) return
      out = { ...out, [enKey]: null }
    }
    if (next.name !== prev.name) drop('nameEn')
    if (next.voiceDesc !== prev.voiceDesc) drop('voiceDescEn')
    if (next.textDesc !== prev.textDesc) drop('textDescEn')
    if (next.costumeDesc !== prev.costumeDesc) drop('costumeDescEn')
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

  /** 每个实体写各自的 patch（阶段四词条回写用） */
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
    // 设定图组只属于这一个主体：主体没了，基模头 / 组头 / 三视图都该跟着走，
    // 否则素材目录里会攒下一堆谁也引用不到的图
    const e = entities.value.find((x) => x.id === id)
    if (e) {
      for (const assetId of sheetAssetIds(sheetOf(e))) await removeAsset(assetId)
    }
    await db.entities.delete(id)
    entities.value = entities.value.filter((x) => x.id !== id)
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

  /**
   * 上传一张图片素材。
   *
   * refId 可选：主体参考图在**拿到 PictureN 之前**就已经知道属于哪个主体
   * （addAsset 分配编号 → 再回写 entity.pictureN），所以这里允许直接标记归属，
   * 不必等回写完成。不传就是"未绑定"的图，留给「素材与音色」里手工处理。
   */
  async function addAsset(
    projectId: ID,
    file: File,
    label = '',
    opts: { refId?: ID } = {}
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
      kind: 'subject',
      refId: opts.refId,
      createdAt: now()
    }
    await saveOne(db.assets, asset)
    assets.value = [...assets.value, asset].sort((a, b) => a.pictureN - b.pictureN)
    return asset
  }

  /**
   * 存一张由模型生成/编辑出的图片。
   *   kind=scene  → pictureN 固定 0，不进导演包 reference 槽，仅本地查看（场景图）
   *   kind=plate  → 同上（场景占位图），归属是**场景实体**，不是某一段
   *   kind=sheet  → 同上（设定图组的原图：基模头 / 组头 / 三视图），归属是**主体**
   *   kind=subject→ 分配下一个可用 PictureN（进 reference 槽）
   */
  async function addGeneratedImage(
    projectId: ID,
    blob: Blob,
    opts: { label?: string; kind?: AssetKind; refId?: ID } = {}
  ): Promise<Asset> {
    const kind: AssetKind = opts.kind ?? 'subject'
    // 场景图 / 占位图 / 设定图原图都不占 Picture 编号：它们不进 reference 槽
    const isScene = kind === 'scene' || kind === 'plate'
    const isSheet = kind === 'sheet'
    const isPlate = kind === 'plate'
    let pictureN = 0
    if (!isScene && !isSheet) {
      const used = assets.value.map((a) => a.pictureN).filter((n) => n > 0)
      pictureN = 1
      while (used.includes(pictureN)) pictureN++
    }
    const ts = now()
    const type = blob.type || 'image/png'
    const file = new File([blob], 'generated.png', { type })
    const safeRef = (opts.refId ?? 'img').replace(/[^A-Za-z0-9_-]/g, '')
    const prefix = isPlate ? 'plate' : isSheet ? 'sheet' : 'scene'
    // 设定图一次会连着出好几张（组头 + 三视图）——只按毫秒做名字，同一毫秒内
    // 连出两张就会同名、后一张把前一张的**文件**覆盖掉（列表里还剩两行，图却一样）。
    // 所以再掺一小段随机后缀。
    const stamp = isSheet
      ? `${ts % 100000}_${uid('s').replace(/[^A-Za-z0-9]/g, '').slice(0, 5)}`
      : String(ts % 100000)
    const fileName =
      isScene || isSheet ? `${prefix}_${safeRef}_${stamp}.png` : `Picture${pictureN}.png`
    const asset: Asset = {
      id: uid('ast'),
      projectId,
      pictureN,
      fileName,
      originalName: file.name,
      label: opts.label || (isPlate ? '场景占位图' : isSheet ? '设定图' : isScene ? '场景图' : '主体参考图'),
      blob,
      kind,
      refId: opts.refId,
      createdAt: ts
    }
    await saveOne(db.assets, asset)
    assets.value = [...assets.value, asset].sort((a, b) => a.pictureN - b.pictureN)
    return asset
  }

  /* --------------------------- 设定图组 --------------------------- */

  /** 主体名下的设定图原图（基模头 / 组头 / 三视图），都不占 Picture N */
  function sheetAssetsOf(entityId: ID): Asset[] {
    return assets.value
      .filter((a) => a.kind === 'sheet' && a.refId === entityId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  function sheetAssetById(id: ID | null | undefined): Asset | null {
    if (!id) return null
    return assets.value.find((a) => a.id === id) ?? null
  }

  /** 存一张设定图原图（不占编号、不进导演包） */
  async function addSheetImage(
    projectId: ID,
    entityId: ID,
    blob: Blob,
    label = '设定图'
  ): Promise<Asset> {
    return addGeneratedImage(projectId, blob, { label, kind: 'sheet', refId: entityId })
  }

  /**
   * 写回主体身上的设定图组结构。
   * 结构本身只是 id 的排布，真正的图在 assets 里 —— 所以这里不搬文件。
   */
  async function setRefSheet(entityId: ID, sheet: RefSheet) {
    await updateEntity(entityId, { refSheet: sheet })
  }

  /**
   * 删一张设定图：先摘掉组里对它的引用，再删素材本身。
   *
   * 两步必须一起做。只删素材会留下指向不存在 id 的组（界面上一格一格的黑洞），
   * 只摘引用又会让没人认领的图片一直躺在素材目录里。
   */
  async function removeSheetImage(entityId: ID, assetId: ID) {
    const e = entities.value.find((x) => x.id === entityId)
    if (e) await setRefSheet(entityId, dropAsset(sheetOf(e), assetId))
    await removeAsset(assetId)
  }

  /**
   * 把某张设定图**定为参考图**（写进 <Picture N>）。
   *
   * 做法是把像素覆盖到主体现有的参考图槽位，而不是把这张图的编号改掉：
   * Picture N 是外部引用（导演包、关键帧、别的段都按它找人），
   * 换编号等于换了个人。文件名不动也顺手解决了缓存 —— 上层加 `?v=` 破缓存即可。
   */
  async function useSheetImageAsReference(
    projectId: ID,
    entityId: ID,
    assetId: ID
  ): Promise<Asset | null> {
    const asset = sheetAssetById(assetId)
    if (!asset) throw new Error('这张设定图已经不存在了')
    let blob = asset.blob
    if (!blob) {
      // 后端只回元数据，图本体在磁盘上
      const resp = await fetch(backendAssetUrl(asset.projectId, asset.fileName))
      if (!resp.ok) throw new Error(`读取设定图失败 ${resp.status}`)
      blob = await resp.blob()
    }
    return attachEntityImage(projectId, entityId, blob, asset.originalName)
  }

  /**
   * 把某一组拼成参考图：组头（左 1/3）+ 选定的一张三视图（右 2/3）→ 1376×768。
   *
   * 这是主体参考图的**主路径**：一张全身定不住脸、一张脸定不住身形，而模型
   * 一次只吃一张参考图 —— 那就拼成一张。拼接在服务端做，这里只管挑图、
   * 覆盖槽位、记住用的是哪组哪张（`Sheet.active`），换集时界面才能标出来。
   *
   * 覆盖的是本集已有的 <Picture N> 槽位（编号不变），所以这一集里所有引用
   * 这个主体的地方会跟着换成新造型，不需要重新编号。
   */
  async function composeGroupAsReference(
    projectId: ID,
    entityId: ID,
    groupId: ID,
    viewId?: ID | null
  ): Promise<Asset> {
    const e = entities.value.find((x) => x.id === entityId)
    if (!e) throw new Error('主体不存在')
    const s = sheetOf(e)
    const g = findGroup(s, groupId)
    if (!g) throw new Error('这一组已经不在了')
    const head = sheetAssetById(g.headId)
    if (!head) throw new Error('这一组还没有组头：先由基模头编辑出一张组头')
    const pickId = viewId ?? g.pickedViewId ?? g.viewIds[0] ?? null
    const view = sheetAssetById(pickId)
    if (!view) throw new Error('这一组还没有三视图：先用组头生成三视图')

    const png = await backendComposeSheet(projectId, head.fileName, [view.fileName])
    const asset = await attachEntityImage(projectId, entityId, png, `sheet_ref_${g.id}.png`)
    if (!asset) throw new Error('写入参考图失败')
    await setRefSheet(entityId, {
      // 顺手把"拼这张"钉到实际用的那张上：下次进来看角标和实际参考图才对得上
      groups: s.groups.map((x) => (x.id === groupId ? { ...x, pickedViewId: view.id } : x)),
      masterId: s.masterId ?? null,
      active: { groupId, assetId: asset.id, mode: 'compose', viewId: view.id }
    })
    return asset
  }

  /**
   * 改素材元数据（帧位 / 放置 / 标签…）。
   *
   * 先更内存、再落库：卡片上的帧数调节器可以连着点，每次都从最新的内存值
   * 往上加。反过来的话要等一次 HTTP 才生效，连点三下会被吞成一步。
   */
  async function updateAsset(id: ID, patch: Partial<Asset>) {
    const idx = assets.value.findIndex((a) => a.id === id)
    if (idx < 0) return
    const prev = assets.value[idx]
    const next = { ...prev, ...patch }
    const copy = [...assets.value]
    copy[idx] = next
    assets.value = copy
    try {
      await saveOne(db.assets, next)
    } catch (e) {
      const back = [...assets.value]
      const i = back.findIndex((a) => a.id === id)
      if (i >= 0) {
        back[i] = prev
        assets.value = back
      }
      throw e
    }
  }

  async function removeAsset(id: ID) {
    await db.assets.delete(id)
    assets.value = assets.value.filter((a) => a.id !== id)
  }

  /**
   * 素材编号出现空档时压缩重排。
   *
   * 分两批，顺序固定：
   *   主体参考图（kind 不是 scene / plate / keyframe）→ 1,2,3…
   *   段内参考方式素材（kind = keyframe 且 pictureN>0）→ 接在后面
   *
   * 段内参考图必须排在主体之后：主体编号有 `entity.pictureN` 这份外部引用，
   * 让段级图插在中间会把所有主体编号顶后一位，而 entity 里的编号不会跟着变，
   * 结果就是"名字改了、人换脸了"。排在尾巴上则谁都不动。
   *
   * **只改 pictureN，不改 fileName**：fileName 指向磁盘上的真实文件，改了
   * 所有 `<img src>` 立刻 404。包内文件名由 pack.assetPackName 按新编号现算
   * （它会核对编号，对不上就重新命名），所以这里不需要同步。
   */
  async function compactAssets() {
    const subjectAssets = [...assets.value]
      .filter(
        (a) =>
          a.kind !== 'scene' &&
          a.kind !== 'plate' &&
          !(a.kind === 'keyframe' && a.pictureN > 0) &&
          a.pictureN > 0
      )
      .sort((a, b) => a.pictureN - b.pictureN)
    const refAssets = [...assets.value]
      .filter((a) => a.kind === 'keyframe' && a.pictureN > 0)
      .sort((a, b) => a.pictureN - b.pictureN)
    const ordered = [...subjectAssets, ...refAssets]
    const patched: Asset[] = []
    ordered.forEach((a, i) => {
      const pictureN = i + 1
      if (a.pictureN !== pictureN) patched.push({ ...a, pictureN })
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

  /**
   * 给主体挂参考图 —— 手工上传与生成都走这里。
   *
   * 参考图属于**主体**，不属于某一段：段里只要绑了这个主体（场景实体也算），
   * 打包时就会按 entity.pictureN 自动带上这张图，不需要在段里再传一次。
   * 所以"给段补图"实际就是"给主体补图"：已经有图就覆盖同一个 Picture N，
   * 文件同名覆盖、编号不变，不会在素材池里留空号。
   */
  async function attachEntityImage(
    projectId: ID,
    entityId: ID,
    blob: Blob,
    originalName?: string
  ): Promise<Asset | null> {
    const e = entities.value.find((x) => x.id === entityId)
    if (!e) return null
    const prev = subjectImageFor(entityId)
    if (prev) {
      await updateAsset(prev.id, {
        blob,
        originalName: originalName || prev.originalName
      })
      return { ...prev, blob }
    }
    const name = originalName || 'subject.png'
    const f = blob instanceof File ? blob : new File([blob], name, { type: blob.type || 'image/png' })
    const asset = await addAsset(projectId, f, e.name, { refId: e.id })
    await updateEntity(entityId, { pictureN: asset.pictureN })
    return asset
  }

  /**
   * 移除主体的参考图：删素材 + 把 pictureN 置空。
   * 两个动作必须一起做 —— 只删素材会留下指向不存在的 Picture N 的实体（破图），
   * 只置空会留下没人引用的孤儿素材继续占编号。
   */
  async function removeEntityImage(entityId: ID, assetId: ID) {
    await db.assets.delete(assetId)
    assets.value = assets.value.filter((a) => a.id !== assetId)
    await updateEntity(entityId, { pictureN: null })
  }

  /**
   * 跨项目读实体 / 素材（取用、下发对话框要用）。
   * where('projectId') 会把后端的"当前项目"切到目标项目，读完必须切回来，
   * 否则后续删除会落到别人的目录里。
   */
  async function listEntitiesOf(projectId: ID): Promise<Entity[]> {
    const prev = getBackendProject()
    try {
      return await db.entities.where('projectId').equals(projectId).toArray()
    } finally {
      setBackendProject(prev)
    }
  }

  async function listAssetsOf(projectId: ID): Promise<Asset[]> {
    const prev = getBackendProject()
    try {
      return await db.assets.where('projectId').equals(projectId).toArray()
    } finally {
      setBackendProject(prev)
    }
  }

  /* --------------------- 段级素材：关键帧 / 音视频 --------------------- */

  /** MIME → 扩展名，浏览器没给文件名后缀时兜底（这些扩展名导演台都认） */
  const MIME_EXT: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'audio/ogg': 'ogg',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm'
  }

  function fileExt(fileName: string, mime?: string): string {
    const ext = extOf(fileName)
    if (ext) return ext === 'jpeg' ? 'jpg' : ext
    return MIME_EXT[String(mime ?? '').toLowerCase()] ?? 'png'
  }

  /**
   * 段级素材的文件名。
   *
   * 刻意不要 `PictureN.png`：关键帧 / 音视频**不占 reference 槽**，一旦叫成
   * PictureN，打包时就会和主体参考图抢编号。用 `kf_/mat_ + 片段 id + 时间戳`
   * 保证唯一（后端文件名只允许 [A-Za-z0-9._-]，片段 id 本身是安全的）。
   */
  function beatAssetName(kind: 'keyframe' | 'material', beatId: ID, ext: string): string {
    const tag = kind === 'keyframe' ? 'kf' : 'mat'
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    return `${tag}_${beatId}_${stamp}.${ext}`
  }

  function normalizeRole(role?: KeyframeRole): KeyframeRole {
    return role === 'end' || role === 'anchor' ? role : 'start'
  }

  /** 没指定放置时：还没有段首就放段首，否则放一个"指定帧" */
  function defaultPlacement(beatId: ID): KeyframePlacement {
    return keyframesOf(assets.value, beatId).some((a) => placementOf(a) === 'head') ? 'at' : 'head'
  }

  /** 下一个可用的 Picture 编号（只数 >0 的；场景图 / 关键帧都是 0，不占位） */
  function nextPictureN(): number {
    const used = assets.value.map((a) => a.pictureN).filter((n) => n > 0)
    let n = 1
    while (used.includes(n)) n += 1
    return n
  }

  /**
   * 段级素材落库（上传走这里；生成的图片走 addGeneratedKeyframe）。
   *
   * 段首 / 段尾各只有一张：再往同一位置传一张，替换旧的而不是堆两张 ——
   * 否则界面上看着有三张"段首"，打包时只有一张生效，很难解释。
   * 「指定帧」不占位置，想放几帧放几帧。
   */
  /**
   * 新增一条**待合成槽位**：配置写好了，本体还没有。
   *
   * 为什么先建条目、而不是等合成完再落库：
   *   用户脑子里先有的是"这一镜要画什么 / 这一句怎么念"，本体是最后一步。
   *   所以「配置」保存后立刻在素材带上出现一格占位 —— 它记着配置、点开能改，
   *   合成成功后才换成真素材。
   *
   * 两种槽位共用这一条路径，只有 media 不同：
   *   图片 —— prompt 是图片合成提示词（沿用既有草稿语义，出图后替换）；
   *   音频 —— voiceText + voiceSpeakerId 是要念的文本与音色，合成后替换。
   *
   * 草稿的约束：
   *   pictureN 恒为 0 —— 没有本体就不该吃 <Picture N> 的号，否则删一条草稿
   *   会在编号里留一个洞（导演包里要按号连续压缩）。
   *   draft = true —— keyframesOf / refImagesOf / materialsOf / 打包全部滤掉它，
   *   不会带着"没有本体"的警告混进导演包。
   */
  async function createDraftAsset(
    projectId: ID,
    beatId: ID,
    opts: {
      placement?: KeyframePlacement
      actAs?: AssetActAs
      label?: string
      /** 槽位媒体：图片（写提示词）还是音频（写要念的文本） */
      media?: 'image' | 'audio'
      /** 图片槽：图片合成提示词 */
      prompt?: string
      /** 图片槽：照着哪几张图画（主体图 / 场景图 / 总图） */
      refAssetIds?: ID[]
      /** 图片槽：用户那句口语要求（AI 写提示词的起点） */
      promptBrief?: string
      /** 音频槽：要念的文本 */
      voiceText?: string
      /** 音频槽：用谁的音色（主体 id） */
      voiceSpeakerId?: ID
      /** 槽位落在第几帧（图片=落点，音频=起始帧；参考素材也有这一格） */
      frameIdx?: number
      /** 台词段默认建的格子：文本跟着台词走（用户改过就落成 false） */
      auto?: boolean
    } = {}
  ): Promise<Asset> {
    const actAs: AssetActAs = opts.actAs ?? 'keyframe'
    const media: 'image' | 'audio' = opts.media ?? 'image'
    const audio = media === 'audio'
    const asRef = actAs === 'reference'
    // 音频槽没有"锁帧"这回事，它只有起始帧；参考图同样不锁帧，但也可以挑起始帧
    const place: KeyframePlacement | undefined =
      audio || asRef ? undefined : opts.placement ?? defaultPlacement(beatId)
    const id = uid('ast')
    const asset: Asset = {
      id,
      projectId,
      pictureN: 0,
      // 草稿没有本体：文件名只是为了界面上"这条素材有个名字"，不落盘
      fileName: `draft_${id}.${audio ? 'wav' : 'png'}`,
      originalName: audio ? '待合成语音' : '新素材',
      label:
        opts.label ||
        (audio
          ? '待合成语音'
          : asRef
            ? '新参考图（待出图）'
            : '新素材（待出图）'),
      kind: audio ? 'material' : 'keyframe',
      refId: beatId,
      media,
      actAs,
      strength: STRENGTH_HARD,
      role: place ? roleOfPlacement(place) : undefined,
      placement: place,
      frameIdx:
        opts.frameIdx != null
          ? Math.max(0, Math.round(Number(opts.frameIdx) || 0))
          : audio
            ? 0
            : place === 'at'
              ? 0
              : undefined,
      prompt: audio ? undefined : opts.prompt ?? '',
      promptBrief: audio ? undefined : opts.promptBrief,
      voiceText: audio ? opts.voiceText ?? '' : undefined,
      voiceSpeakerId: audio ? opts.voiceSpeakerId : undefined,
      refAssetIds: audio ? undefined : [...(opts.refAssetIds ?? [])],
      draft: true,
      auto: opts.auto,
      createdAt: now()
    }
    await saveOne(db.assets, asset)
    assets.value = [...assets.value, asset]
    return asset
  }

  async function addBeatAsset(
    projectId: ID,
    beatId: ID,
    file: File,
    opts: {
      kind?: 'keyframe' | 'material'
      /**
       * 作用方式（仅图片）：keyframe = 关键帧（默认），reference = 参考图。
       * 参考方式会占一个 Picture 编号，因为它是靠 <Picture N> 进模型的。
       */
      actAs?: AssetActAs
      /** 老接口：等价于 placement（start↔head、end↔tail、anchor↔at） */
      role?: KeyframeRole
      placement?: KeyframePlacement
      frameIdx?: number
      label?: string
      media?: MediaKind
      /** 锚定强度 0~100；缺省图片 100、音视频 60 */
      strength?: number
      /** 关键帧溯源（生成的图才有）：出图当时的提示词 / 上下文 / 台词 */
      genPrompt?: string
      genContext?: string
      genDialogue?: string
      /** 占位取景溯源：从哪张场景占位图的哪个框裁出来的 */
      plateId?: ID
      plateRect?: { x: number; y: number; w: number; h: number }
      /** 这条素材自己的提示词（正文，不含引用段）与用户那句口语要求 */
      prompt?: string
      promptBrief?: string
      /** 出图时选用的参考图（素材 id）：下次重出还能照着同一批图 */
      refAssetIds?: ID[]
    } = {}
  ): Promise<Asset> {
    const media = opts.media ?? mediaKindOf(file.name, file.type)
    const kind = opts.kind ?? (media === 'image' ? 'keyframe' : 'material')
    /*
     * 作用方式对**所有**段内素材都有意义：图片分"锁帧 / 只借画面"，
     * 音视频分"这段的内容 / 只借音色动作"。
     * 缺省：图片 → keyframe（老数据兼容）；音视频 → 不写（同样等于 keyframe）。
     */
    const actAs: AssetActAs | undefined =
      opts.actAs ?? (media === 'image' ? 'keyframe' : undefined)
    /** 当参考图用：不落帧、不抢首尾，改占一个 <Picture N> 槽 */
    const asRef = kind === 'keyframe' && actAs === 'reference'
    const place =
      kind === 'keyframe' && !asRef
        ? opts.placement ?? (opts.role ? placementOfRole(normalizeRole(opts.role)) : defaultPlacement(beatId))
        : undefined
    const role = place ? roleOfPlacement(place) : undefined
    if (kind === 'keyframe' && place && place !== 'at') {
      const dup = keyframesOf(assets.value, beatId).filter((a) => placementOf(a) === place)
      for (const d of dup) await removeAsset(d.id)
    }
    const pictureN = asRef ? nextPictureN() : 0
    const ext = fileExt(file.name, file.type)
    const label =
      opts.label ||
      (asRef
        ? `参考图 P${pictureN}`
        : kind === 'keyframe'
          ? PLACEMENT_LABEL[place ?? 'head']
          : media === 'audio'
            ? '参考音频'
            : media === 'video'
              ? '参考视频'
              : '参考素材')
    const durationSec =
      media === 'audio' ? ((await audioDurationSec(file)) ?? undefined) : undefined
    const asset: Asset = {
      id: uid('ast'),
      projectId,
      pictureN,
      fileName: asRef ? `Picture${pictureN}.${ext}` : beatAssetName(kind, beatId, ext),
      originalName: file.name,
      label,
      blob: file,
      kind,
      refId: beatId,
      media,
      actAs,
      strength:
        opts.strength ?? (media === 'image' ? STRENGTH_HARD : media === 'video' ? 60 : 30),
      role,
      placement: place,
      // 关键帧只有「指定帧」带帧位；参考方式没有帧位；音视频的帧位是**作用起始帧**
      frameIdx:
        kind === 'material'
          ? Math.max(0, Math.round(Number(opts.frameIdx) || 0))
          : place === 'at'
            ? Math.max(0, Math.round(Number(opts.frameIdx) || 0))
            : undefined,
      durationSec,
      bytes: file.size,
      // 溯源只对"生成的关键帧"有意义：上传的图不是按提示词出的，比了也没用
      genPrompt: kind === 'keyframe' ? opts.genPrompt : undefined,
      genContext: kind === 'keyframe' ? opts.genContext : undefined,
      genDialogue: kind === 'keyframe' ? opts.genDialogue : undefined,
      plateId: kind === 'keyframe' ? opts.plateId : undefined,
      plateRect: kind === 'keyframe' ? opts.plateRect : undefined,
      // 提示词是素材自己的东西：**图片一律带一个（哪怕是空串）**，
      // 这样"新增一条素材"就同时得到一条待填的提示词（用户可直接写，
      // 或给一句要求让 AI 写成英文）。音视频没有提示词这一说，留 undefined。
      prompt: media === 'image' ? (opts.prompt ?? '') : undefined,
      promptBrief: opts.promptBrief,
      refAssetIds: opts.refAssetIds ?? [],
      createdAt: now()
    }
    await saveOne(db.assets, asset)
    assets.value = [...assets.value, asset]
    return asset
  }

  /** 生成的关键帧：与上传同一条落库路径，只是本体来自图片合成接口 */
  async function addGeneratedKeyframe(
    projectId: ID,
    beatId: ID,
    blob: Blob,
    opts: {
      role?: KeyframeRole
      placement?: KeyframePlacement
      frameIdx?: number
      label?: string
      /** 作用方式：不传按关键帧（老行为）；重出参考图时必须传 reference，否则会变成关键帧 */
      actAs?: AssetActAs
      /** 出图溯源：真正发出的提示词 / 当时这段的模板指纹 / 当时的台词 */
      genPrompt?: string
      genContext?: string
      genDialogue?: string
      /** 占位取景溯源（从场景占位图裁出来的图才有） */
      plateId?: ID
      plateRect?: { x: number; y: number; w: number; h: number }
      /** 这条素材自己的提示词与选用的参考图（出图转正时一起写回） */
      prompt?: string
      promptBrief?: string
      refAssetIds?: ID[]
    } = {}
  ): Promise<Asset> {
    const place =
      opts.placement ?? (opts.role ? placementOfRole(normalizeRole(opts.role)) : defaultPlacement(beatId))
    const type = blob.type || 'image/png'
    const ext = MIME_EXT[type.toLowerCase()] ?? 'png'
    const file = new File([blob], `keyframe.${ext}`, { type })
    return addBeatAsset(projectId, beatId, file, {
      kind: 'keyframe',
      actAs: opts.actAs,
      placement: place,
      frameIdx: opts.frameIdx,
      label: opts.label,
      media: 'image',
      genPrompt: opts.genPrompt,
      genContext: opts.genContext,
      genDialogue: opts.genDialogue,
      plateId: opts.plateId,
      plateRect: opts.plateRect,
      prompt: opts.prompt,
      promptBrief: opts.promptBrief,
      refAssetIds: opts.refAssetIds
    })
  }

  /** 本段的关键帧（段首 → 指定帧 → 段尾） */
  function keyframesFor(beatId: ID): Asset[] {
    return keyframesOf(assets.value, beatId)
  }

  /**
   * 改一张段内图片的**作用方式**：关键帧 ↔ 参考图。
   *
   * 两个方向都要动编号，不是翻个开关：
   *   关键帧 → 参考图：分配一个 Picture 编号（>0 就沿用），之后按 <Picture N>
   *                    进参考图通道。
   *   参考图 → 关键帧：编号交回去（pictureN = 0）。
   *
   * **磁盘上的 fileName 一动都不能动**：它拼进 <img src>，改名当场 404。
   * 包内名字由 pack.assetPackName 按 pictureN 现算（并核对编号），与这里无关。
   *
   * **帧位刻意不动**：参考方式根本不读 placement / frameIdx（keyframesOf 按
   * actAs 过滤掉了），留着不占轨道也不抢首尾；切回来时位置还在原处，用户
   * 来回试两种用法不会把精心摆好的第 12 帧弄丢。label 同理保留。
   *
   * 只认图片：音频 / 视频没有"关键帧方式"这一说。
   */
  async function setBeatAssetActAs(id: ID, actAs: AssetActAs): Promise<void> {
    const target = assets.value.find((a) => a.id === id)
    if (!target) return
    /*
     * 音视频只有"走哪条通道"这件事要改：占不占这段的时间轴。
     * 不碰 pictureN（它不占 <Picture N> 槽），也不碰 frameIdx —— 只当参考时
     * 那个帧位仍然是"从第几帧起比对"，删了反而丢信息。
     */
    if (target.kind === 'material') {
      if (actAsOf(target) === actAs) return
      await updateAsset(id, { actAs })
      return
    }
    if (target.kind !== 'keyframe' || target.media !== 'image') return
    if (actAsOf(target) === actAs) return
    const beatId = target.refId ?? ''

    // 草稿还没有图：切到参考方式**不能**先占一个 <Picture N>。
    // 占号的代价是删掉这条草稿后编号留一个洞，而导演包的编号必须连续压缩。
    // 出图转正时 addBeatAsset 会按当时的 actAs 正常分配。
    if (target.draft) {
      await updateAsset(id, { actAs, pictureN: 0 })
      return
    }

    if (actAs === 'reference') {
      // 已经有编号就不重发（同一张图来回切不该每切一次涨一个号）。
      // **不改 fileName**：它指向磁盘上的真实文件，改了 <img src> 立刻 404；
      // 包内名字由 pack.assetPackName 按 pictureN 现算，不依赖这里。
      const pictureN = target.pictureN > 0 ? target.pictureN : nextPictureN()
      await updateAsset(id, { actAs: 'reference', pictureN })
      return
    }

    await updateAsset(id, {
      actAs: 'keyframe',
      pictureN: 0,
      // 老数据可能压根没有 placement（只有 role）：补一个，否则它不上轨道
      placement: target.placement ?? defaultPlacement(beatId),
      role: target.role ?? roleOfPlacement(target.placement ?? defaultPlacement(beatId))
    })
  }

  /** 本段按参考图方式起作用的图片（不占帧位，占 Picture 槽） */
  function refImagesFor(beatId: ID): Asset[] {
    return assets.value.filter((a) => a.kind === 'keyframe' && a.refId === beatId && isRefImage(a))
  }

  /**
   * 改一张关键帧的放置。
   *
   * 段首 / 段尾各只有一张：把原来占着这个位置的降级成「指定帧」并保留它原来的
   * 帧位，而不是悄悄让两张都叫"段首"（打包时只会有一张生效，很难解释）。
   */
  /**
   * 改一个段内素材的**锚定强度**（0~100）：100 = 钉死，越低越偏参考。
   *
   * 不动 placement / frameIdx —— 强度是"有多硬"，位置是"落在哪一帧"，
   * 两者正交：调软了起始帧仍然有效，调回 100 也不用重摆。
   * 图片、视频按强度混噪；音频满强度固定音轨、否则走参考音色通道。
   */
  async function setAssetStrength(id: ID, strength: number): Promise<void> {
    const target = assets.value.find((a) => a.id === id)
    if (!target) return
    const next = clampStrength(strength)
    if (strengthOf(target) === next) return
    await updateAsset(id, { strength: next })
  }

  async function setKeyframePlacement(
    id: ID,
    placement: KeyframePlacement,
    frameIdx?: number
  ): Promise<void> {
    const target = assets.value.find((a) => a.id === id)
    if (!target) return
    if (placement !== 'at') {
      const sameBeat = keyframesOf(assets.value, target.refId ?? '')
      for (const other of sameBeat) {
        if (other.id === id) continue
        if (placementOf(other) !== placement) continue
        await updateAsset(other.id, {
          placement: 'at',
          role: 'anchor',
          frameIdx: Math.max(0, Math.round(Number(other.frameIdx) || 0))
        })
      }
    }
    await updateAsset(id, {
      placement,
      role: roleOfPlacement(placement),
      frameIdx:
        placement === 'at' ? Math.max(0, Math.round(Number(frameIdx ?? target.frameIdx) || 0)) : undefined
    })
  }

  /** 按策略一键重排本段的关键帧（用户点「按策略摆放」时才调用） */
  async function applyKeyframeLayout(
    beatId: ID,
    frames: number,
    layout: KeyframeLayout
  ): Promise<number> {
    // 只摆强制图：参考作用的不进 kfImages，把它排到段首也不会变成 startImage
    const list = forcedKeyframesOf(assets.value, beatId)
    if (!list.length) return 0
    const plan = layoutKeyframes(list, frames, layout)
    let changed = 0
    for (const p of plan) {
      const item = list.find((a) => a.id === p.id)
      if (!item) continue
      const same =
        placementOf(item) === p.placement &&
        (p.placement !== 'at' || (Number(item.frameIdx) || 0) === (p.frameIdx ?? 0))
      if (same) continue
      await updateAsset(item.id, {
        placement: p.placement,
        role: roleOfPlacement(p.placement),
        frameIdx: p.frameIdx
      })
      changed += 1
    }
    return changed
  }

  /** 本段的音视频素材（按作用起始帧排序，同帧音频在前） */
  function materialsFor(beatId: ID): Asset[] {
    return materialsOf(assets.value, beatId)
  }

  /**
   * 改一段音频 / 视频的**作用起始帧**。
   * 任意帧都行（0 = 段首），越界夹到段内 —— 与关键帧「指定帧」同一套规则。
   */
  async function setMaterialStartFrame(id: ID, frame: number, frames = 0): Promise<void> {
    const target = assets.value.find((a) => a.id === id)
    if (!target) return
    await updateAsset(id, { frameIdx: clampFrame(frame, frames) })
  }

  /**
   * 任意素材改帧位 —— **什么都不动，只动"落在第几帧"**。
   *
   * 界面上的要求是"无论什么素材都能选到任意帧"，所以这个写入口不能只管音视频：
   *   关键帧图片：走 setKeyframePlacement('at')，顺带处理"两张抢同一帧"；
   *   参考图（含草稿）：只把帧位落成具体帧 —— 它不锁帧，但"从第几帧起参考"
   *     是个有用的信息（打包时也照它排参考的起点）；
   *   音视频（含参考音视频）：只有 frameIdx 一个语义，actAs 不动。
   *
   * 单独一个入口的原因是"改帧位"和"改作用方式"必须是两件事：从卡片上拨一下
   * 帧号，不该顺手把一条参考素材变成时间轴上的内容。
   */
  async function setAssetFrameAt(id: ID, frame: number, frames = 0): Promise<void> {
    const target = assets.value.find((a) => a.id === id)
    if (!target) return
    const n = clampFrame(frame, frames)
    if (target.media === 'image' && target.kind === 'keyframe' && !target.draft) {
      await setKeyframePlacement(id, 'at', n)
      return
    }
    const patch: Partial<Asset> = { frameIdx: n }
    if (target.media === 'image') {
      patch.placement = 'at'
      // 参考图不是关键帧：不写 role，免得它被当成时间轴上的锚点
      if (actAsOf(target) === 'keyframe') patch.role = 'anchor'
    }
    await updateAsset(id, patch)
  }

  /** 片段的场景图（pictureN=0，靠 refId=beatId 定位） */
  function sceneImageFor(beatId: ID): Asset | null {
    return assets.value.find((a) => a.kind === 'scene' && a.refId === beatId) ?? null
  }

  /**
   * 场景占位图（一个场景一张，靠 kind=plate + refId=实体 id 定位）。
   *
   * 注意别用 sceneImageFor 找它：那个按 beat.id 查，占位图挂在场景实体上，
   * 两者 id 不同，查不到就会让人以为"没出过图"，反复重出。
   */
  function plateFor(sceneId: ID): Asset | null {
    if (!sceneId) return null
    const list = assets.value
      .filter((a) => a.kind === 'plate' && a.refId === sceneId)
      .sort((a, b) => b.createdAt - a.createdAt)
    return list[0] ?? null
  }

  function assetUrl(asset: Asset): string | null {
    // 图片本体在数据目录里，统一走后端地址
    return backendAssetUrl(asset.projectId, asset.fileName)
  }

  /**
   * 把素材本体补回内存。
   *
   * 后端只存素材元数据（assets.json），blob 不会随表一起回来。而 pack.ts 里
   * 是 `if (!a.blob) continue` —— 不补齐的话导出的导演包一张参考图都没有，
   * 还不报错，只是每段在导入端静默退化成 t2v。
   *
   * 补三类进包的素材：主体参考图（pictureN > 0）、段级关键帧、段级音视频。
   * 场景图不进包，按 URL 直接显示即可。
   */
  async function hydrateAssetBlobs(): Promise<number> {
    const pending = assets.value.filter(
      (a) =>
        !a.blob &&
        (a.pictureN > 0 || a.kind === 'keyframe' || a.kind === 'material')
    )
    if (!pending.length) return 0
    const loaded = await Promise.all(
      pending.map(async (a) => {
        try {
          const resp = await fetch(backendAssetUrl(a.projectId, a.fileName))
          if (!resp.ok) return null
          return { id: a.id, blob: await resp.blob() }
        } catch {
          return null
        }
      })
    )
    const byId = new Map(
      loaded.filter((x): x is { id: ID; blob: Blob } => !!x).map((x) => [x.id, x.blob])
    )
    if (!byId.size) return 0
    assets.value = assets.value.map((a) => (byId.has(a.id) ? { ...a, blob: byId.get(a.id)! } : a))
    return byId.size
  }

  /**
   * 补齐音频时长。
   *
   * 旧项目的音频是在 durationSec 这个字段存在之前上传的，没有时长。
   * 不回填的话，「按配音决定帧长」在这些项目上会静默退化成按字数估算 ——
   * 界面上看不出为什么对不准。所以加载后补测一次并落库，之后不再重复。
   *
   * 只处理段内音频素材：主体参考音、场景音这些不参与片段时长。
   */
  async function ensureAudioDurations(limit = 40): Promise<number> {
    const pending = assets.value
      .filter((a) => a.media === 'audio' && a.kind === 'material' && !a.durationSec && !a.draft)
      .slice(0, limit)
    if (!pending.length) return 0

    const found = await Promise.all(
      pending.map(async (a) => {
        let blob = a.blob
        if (!blob) {
          try {
            const resp = await fetch(backendAssetUrl(a.projectId, a.fileName))
            if (!resp.ok) return null
            blob = await resp.blob()
          } catch {
            return null
          }
        }
        const sec = await audioDurationSec(blob)
        return sec == null ? null : { id: a.id, sec }
      })
    )
    const hits = found.filter((x): x is { id: ID; sec: number } => !!x)
    if (!hits.length) return 0

    const byId = new Map(hits.map((h) => [h.id, h.sec]))
    assets.value = assets.value.map((a) =>
      byId.has(a.id) ? { ...a, durationSec: byId.get(a.id) } : a
    )
    const rows = assets.value.filter((a) => byId.has(a.id))
    try {
      await saveMany(db.assets, rows)
    } catch {
      /* 时长是派生信息，写库失败不影响本次使用 */
    }
    return hits.length
  }

  return {
    entities,
    assets,
    loading,
    loadedProjectId,
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
    sheetAssetsOf,
    sheetAssetById,
    addSheetImage,
    setRefSheet,
    removeSheetImage,
    useSheetImageAsReference,
    composeGroupAsReference,
    addBeatAsset,
    createDraftAsset,
    addGeneratedKeyframe,
    keyframesFor,
    refImagesFor,
    materialsFor,
    setAssetStrength,
    setBeatAssetActAs,
    setKeyframePlacement,
    setAssetFrameAt,
    setMaterialStartFrame,
    applyKeyframeLayout,
    updateAsset,
    removeAsset,
    compactAssets,
    subjectImageFor,
    attachEntityImage,
    removeEntityImage,
    listEntitiesOf,
    listAssetsOf,
    sceneImageFor,
    plateFor,
    assetUrl,
    hydrateAssetBlobs,
    ensureAudioDurations
  }
})
