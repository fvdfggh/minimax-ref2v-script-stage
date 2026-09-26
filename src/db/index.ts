import Dexie, { type Table } from 'dexie'
import { toPlain, toPlainList } from '@/core/plain'
import {
  backendExportAllZip,
  backendExportProjectZip,
  backendImportZip,
  backendKv,
  createBackendDb,
  setBackendBase,
  setBackendProject,
  type DataTable
} from '@/core/backend'
import type { Assembly, Asset, Beat, Entity, ID, Project, Provider } from '@/domain/types'

/* ------------------------------------------------------------------ *
 * 落库出口：所有写入都必须经过这里
 *
 * Pinia 的对象是 Proxy，直接丢给 IndexedDB 会抛
 *   DataCloneError: #<Object> could not be cloned.
 * 统一在这里剥掉响应式，避免每个调用点各写一遍。
 *
 * 存储有两种模式：
 *   local   —— 浏览器 IndexedDB，开箱即用，清缓存就没了
 *   backend —— Python 后端写数据目录，能备份能版本管理
 * 两种模式共用同一套 DataTable 外观，上层 store 不需要知道自己跑在哪边。
 * ------------------------------------------------------------------ */

/**
 * store 层统一走这两个函数。
 * 它们只认 DataTable —— Dexie 的 Table 在 db/index.ts 内部直接调用，
 * 两边不混用，省掉一堆函数重载带来的类型纠缠。
 */
export async function saveOne<T>(table: DataTable<T>, row: T): Promise<void> {
  await table.put(toPlain(row))
}

export async function saveMany<T>(table: DataTable<T>, rows: T[]): Promise<void> {
  if (!rows.length) return
  await table.bulkPut(toPlainList(rows))
}

export async function removeWhere<T>(
  table: DataTable<T>,
  index: string,
  value: ID
): Promise<void> {
  await table.where(index).equals(value).delete()
}

export interface KV {
  key: string
  value: unknown
}

export interface RunRecord {
  id: string
  projectId: ID
  stage: 'split' | 'enrich' | 'summary' | 'freeform'
  providerId: string
  model: string
  promptTokens?: number
  completionTokens?: number
  durationMs: number
  status: 'ok' | 'error'
  error?: string
  createdAt: number
}

class ScriptStageDB extends Dexie {
  projects!: Table<Project, string>
  entities!: Table<Entity, string>
  assets!: Table<Asset, string>
  beats!: Table<Beat, string>
  assemblies!: Table<Assembly, string>
  providers!: Table<Provider, string>
  kv!: Table<KV, string>
  runs!: Table<RunRecord, string>

  constructor() {
    super('script-stage')
    this.version(1).stores({
      projects: 'id, updatedAt',
      entities: 'id, projectId, subjectN',
      assets: 'id, projectId, pictureN',
      beats: 'id, projectId, order, derivedFrom',
      assemblies: 'id, projectId, updatedAt',
      providers: 'id, createdAt',
      kv: 'key',
      runs: 'id, projectId, createdAt'
    })
  }
}

const dexieDb = new ScriptStageDB()

export interface AppDb {
  projects: DataTable<Project>
  entities: DataTable<Entity>
  assets: DataTable<Asset>
  beats: DataTable<Beat>
  assemblies: DataTable<Assembly>
  providers: DataTable<Provider>
  open?(): Promise<void>
  delete?(): Promise<void>
}

export type StorageMode = 'local' | 'backend'

let impl: AppDb = dexieDb as unknown as AppDb
let mode: StorageMode = 'local'

/**
 * 对外永远是同一个 db，切模式只换内部实现。
 *
 * 函数必须绑回 impl：Dexie 的方法靠 this 找表结构，this 变成 Proxy 之后
 * 它会读不到 schema，open() 直接抛 "Cannot read properties of undefined"。
 */
export const db: AppDb = new Proxy({} as AppDb, {
  get(_target, prop) {
    const value = (impl as unknown as Record<string | symbol, unknown>)[prop]
    if (typeof value === 'function') {
      return (value as (...args: unknown[]) => unknown).bind(impl)
    }
    return value
  }
})

export function storageMode(): StorageMode {
  return mode
}

export function isBackend(): boolean {
  return mode === 'backend'
}

/** 切到后端。调用前应先 backendHealth() 探活 */
export function useBackend(baseUrl: string, projectId = ''): void {
  setBackendBase(baseUrl)
  setBackendProject(projectId)
  impl = createBackendDb() as unknown as AppDb
  mode = 'backend'
}

export function useLocal(): void {
  impl = dexieDb as unknown as AppDb
  mode = 'local'
}

/** 切换项目时同步给适配器：删除操作只给 id，适配器得知道是哪个项目 */
export function setStorageProject(projectId: ID): void {
  setBackendProject(projectId)
}

/* ------------------------------ kv ------------------------------ */

export async function kvGet<T>(key: string, fallback: T): Promise<T> {
  if (isBackend()) {
    const value = await backendKv.get<T>(key)
    return value === undefined ? fallback : value
  }
  const row = await dexieDb.kv.get(key)
  return row === undefined ? fallback : (row.value as T)
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  if (isBackend()) {
    await backendKv.set(key, value)
    return
  }
  // 必须剥响应式：值里常有 Pinia 的 Proxy，直接 put 会抛 DataCloneError
  await dexieDb.kv.put(toPlain({ key, value }))
}

export async function kvDelete(key: string): Promise<void> {
  if (isBackend()) {
    await backendKv.delete(key)
    return
  }
  await dexieDb.kv.delete(key)
}

/* -------------------------- 级联删除 -------------------------- */

export async function deleteProjectDeep(projectId: ID): Promise<void> {
  if (isBackend()) {
    setBackendProject(projectId)
    await db.beats.where('projectId').equals(projectId).delete()
    await db.assemblies.where('projectId').equals(projectId).delete()
    await db.assets.where('projectId').equals(projectId).delete()
    await db.entities.where('projectId').equals(projectId).delete()
    await db.projects.delete(projectId)
    return
  }
  await dexieDb.transaction(
    'rw',
    dexieDb.projects,
    dexieDb.entities,
    dexieDb.assets,
    dexieDb.beats,
    dexieDb.assemblies,
    async () => {
      await dexieDb.projects.delete(projectId)
      await dexieDb.entities.where('projectId').equals(projectId).delete()
      await dexieDb.assets.where('projectId').equals(projectId).delete()
      await dexieDb.beats.where('projectId').equals(projectId).delete()
      await dexieDb.assemblies.where('projectId').equals(projectId).delete()
    }
  )
}

/* -------------------------- 导出 / 导入 -------------------------- */

export interface BackupFile {
  version: 1
  exportedAt: number
  projects: Project[]
  entities: Entity[]
  assets: Array<Omit<Asset, 'blob'>>
  beats: Beat[]
  assemblies: Assembly[]
}

/**
 * 整库导出。
 * backend 模式走后端 zip（连素材文件一起），local 模式只能用 JSON ——
 * 浏览器里的 Blob 没法塞进 JSON，所以这种备份不含图片，是个已知短板，
 * 想要完整备份就切到后端模式。
 */
export async function exportWorkspace(): Promise<{ blob: Blob; filename: string }> {
  if (isBackend()) {
    const blob = await backendExportAllZip()
    return { blob, filename: '剧本台-全部数据.zip' }
  }
  const [projects, entities, assets, beats, assemblies] = await Promise.all([
    dexieDb.projects.toArray(),
    dexieDb.entities.toArray(),
    dexieDb.assets.toArray(),
    dexieDb.beats.toArray(),
    dexieDb.assemblies.toArray()
  ])
  const payload: BackupFile = {
    version: 1,
    exportedAt: Date.now(),
    projects,
    entities,
    assets: assets.map(({ blob, ...rest }) => {
      void blob
      return rest
    }),
    beats,
    assemblies
  }
  return {
    blob: new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    filename: '剧本台-全部数据.json'
  }
}

export async function exportProjectFile(projectId: ID, name: string): Promise<{ blob: Blob; filename: string }> {
  if (isBackend()) {
    const blob = await backendExportProjectZip(projectId)
    const safe = (name || 'project').replace(/[\\/:*?"<>|]+/g, '_')
    return { blob, filename: `${safe}.剧本台项目.zip` }
  }
  // local 模式没有按项目拆分的备份，只能整库导出
  return await exportWorkspace()
}

/** 导入整库 / 单项目备份，两种格式都认 */
export async function importWorkspace(blob: Blob): Promise<{ projects: number }> {
  if (isBackend()) {
    const res = await backendImportZip(blob)
    return { projects: res.projects ?? (res.projectId ? 1 : 0) }
  }
  const data = JSON.parse(await blob.text()) as BackupFile
  await dexieDb.transaction(
    'rw',
    dexieDb.projects,
    dexieDb.entities,
    dexieDb.assets,
    dexieDb.beats,
    dexieDb.assemblies,
    async () => {
      await dexieDb.projects.bulkPut(toPlainList(data.projects ?? []))
      await dexieDb.entities.bulkPut(toPlainList(data.entities ?? []))
      await dexieDb.assets.bulkPut(toPlainList((data.assets ?? []) as Asset[]))
      await dexieDb.beats.bulkPut(toPlainList(data.beats ?? []))
      await dexieDb.assemblies.bulkPut(toPlainList(data.assemblies ?? []))
    }
  )
  return { projects: (data.projects ?? []).length }
}

/** 兼容旧调用：读整库 JSON（仅 local 模式） */
export async function exportBackup(): Promise<BackupFile> {
  const [projects, entities, assets, beats, assemblies] = await Promise.all([
    dexieDb.projects.toArray(),
    dexieDb.entities.toArray(),
    dexieDb.assets.toArray(),
    dexieDb.beats.toArray(),
    dexieDb.assemblies.toArray()
  ])
  return {
    version: 1,
    exportedAt: Date.now(),
    projects,
    entities,
    assets: assets.map(({ blob, ...rest }) => {
      void blob
      return rest
    }),
    beats,
    assemblies
  }
}

export async function importBackup(data: BackupFile): Promise<void> {
  await dexieDb.transaction(
    'rw',
    dexieDb.projects,
    dexieDb.entities,
    dexieDb.assets,
    dexieDb.beats,
    dexieDb.assemblies,
    async () => {
      await dexieDb.projects.bulkPut(toPlainList(data.projects ?? []))
      await dexieDb.entities.bulkPut(toPlainList(data.entities ?? []))
      await dexieDb.assets.bulkPut(toPlainList((data.assets ?? []) as Asset[]))
      await dexieDb.beats.bulkPut(toPlainList(data.beats ?? []))
      await dexieDb.assemblies.bulkPut(toPlainList(data.assemblies ?? []))
    }
  )
}
