import {
  backendExportAllZip,
  backendExportProjectZip,
  backendImportZip,
  backendKv,
  createBackendDb,
  setBackendBase,
  setBackendProject,
  type DataTable,
  type ImportResult
} from '@/core/backend'
import { toPlain, toPlainList } from '@/core/plain'
import type { Assembly, Asset, Beat, Entity, ID, Project, Provider } from '@/domain/types'

/* ------------------------------------------------------------------ *
 * 落库出口：所有写入都必须经过这里
 *
 * 数据统一由 Python 后端管理（写数据目录，能备份、能进版本管理，
 * 素材是真文件）。浏览器 IndexedDB 已移除 —— 不再提供"本地模式"，
 * 一切读写都走后端 REST。后端没起时由上层给出"后端必需"拦截，
 * 而不是悄悄退回浏览器。
 *
 * Pinia 的对象是 Proxy，直接丢出去会抛
 *   DataCloneError: #<Object> could not be cloned.
 * 统一在这里剥掉响应式，避免每个调用点各写一遍。
 * ------------------------------------------------------------------ */

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

/** kv 存储抽象：后端 / 内存 两种实现都满足它 */
export interface KvStore {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

export interface AppDb {
  projects: DataTable<Project>
  entities: DataTable<Entity>
  assets: DataTable<Asset>
  beats: DataTable<Beat>
  assemblies: DataTable<Assembly>
  providers: DataTable<Provider>
}

export type StorageMode = 'backend'

let impl: AppDb = createBackendDb() as unknown as AppDb
let mode: StorageMode = 'backend'

/** kv 存储，默认走后端；测试可换成内存实现 */
let kvImpl: KvStore = backendKv

/** 测试注入：整库表实现换掉（不影响已存在的 db Proxy，getter 每次都读 impl） */
export function setDbImpl(next: AppDb): void {
  impl = next as unknown as AppDb
}

/** 测试注入：kv 实现换掉 */
export function setKvImpl(next: KvStore): void {
  kvImpl = next
}

/**
 * 对外永远是同一个 db。
 *
 * 函数必须绑回 impl：适配器方法靠 this 找到表名，this 变成 Proxy 之后
 * 会读不到内部状态。
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

/** 数据只走后端，这里恒为 true（保留函数签名给调用点用） */
export function isBackend(): boolean {
  return true
}

/** 指定后端地址并重建适配器。调用前应先 backendHealth() 探活 */
export function useBackend(baseUrl: string, projectId = ''): void {
  setBackendBase(baseUrl)
  setBackendProject(projectId)
  impl = createBackendDb() as unknown as AppDb
  mode = 'backend'
}

/** 切换项目时同步给适配器：删除操作只给 id，适配器得知道是哪个项目 */
export function setStorageProject(projectId: ID): void {
  setBackendProject(projectId)
}

/* ------------------------------ kv ------------------------------ */

export async function kvGet<T>(key: string, fallback: T): Promise<T> {
  const value = await kvImpl.get<T>(key)
  return value === undefined ? fallback : value
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await kvImpl.set(key, value)
}

export async function kvDelete(key: string): Promise<void> {
  await kvImpl.delete(key)
}

/* -------------------------- 级联删除 -------------------------- */

export async function deleteProjectDeep(projectId: ID): Promise<void> {
  setBackendProject(projectId)
  await db.beats.where('projectId').equals(projectId).delete()
  await db.assemblies.where('projectId').equals(projectId).delete()
  await db.assets.where('projectId').equals(projectId).delete()
  await db.entities.where('projectId').equals(projectId).delete()
  await db.projects.delete(projectId)
}

/**
 * 删除整个「项目/系列」：先删它下面的每一集（各集是独立后端项目目录，
 * 含片段/方案/素材/集内实体），再删项目自身（含其大主体/全局主体）。
 */
export async function deleteSeriesDeep(seriesId: ID, episodeIds: ID[] = []): Promise<void> {
  for (const eid of episodeIds) {
    if (eid && eid !== seriesId) await deleteProjectDeep(eid)
  }
  await deleteProjectDeep(seriesId)
}

/* -------------------------- 导出 / 导入 -------------------------- */

/**
 * 整库导出。统一走后端 zip（连素材文件一起）。
 */
export async function exportWorkspace(): Promise<{ blob: Blob; filename: string }> {
  const blob = await backendExportAllZip()
  return { blob, filename: '剧本台-全部数据.zip' }
}

/**
 * 导出单个项目（项目 = 系列：连各集、素材、用到的音色包一起打），
 * 是为了"换一台设备直接接着做"——不只是项目 JSON。
 */
export async function exportProjectFile(
  projectId: ID,
  name: string
): Promise<{ blob: Blob; filename: string }> {
  const blob = await backendExportProjectZip(projectId)
  const safe = (name || 'project').replace(/[\\/:*?"<>|]+/g, '_')
  return { blob, filename: `${safe}.剧本台项目.zip` }
}

/** 导入整库 / 项目包（zip，后端识别项目包 / 整库 / 单项目 / 旧版备份四种） */
export async function importWorkspace(blob: Blob): Promise<ImportResult> {
  const res = await backendImportZip(blob)
  return { ...res, projects: res.projects ?? (res.projectId ? 1 : 0) }
}
