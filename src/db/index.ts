import Dexie, { type Table } from 'dexie'
import { toPlain, toPlainList } from '@/core/plain'
import type { Assembly, Asset, Beat, Entity, ID, Project, Provider } from '@/domain/types'

/* ------------------------------------------------------------------ *
 * 落库出口：所有写入都必须经过这里
 *
 * Pinia 的对象是 Proxy，直接丢给 IndexedDB 会抛
 *   DataCloneError: #<Object> could not be cloned.
 * 统一在这里剥掉响应式，避免每个调用点各写一遍。
 * ------------------------------------------------------------------ */

export async function saveOne<T>(table: Table<T, string>, row: T): Promise<void> {
  await table.put(toPlain(row))
}

export async function saveMany<T>(table: Table<T, string>, rows: T[]): Promise<void> {
  if (!rows.length) return
  await table.bulkPut(toPlainList(rows))
}

export async function removeWhere<T>(
  table: Table<T, string>,
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

export const db = new ScriptStageDB()

export async function kvGet<T>(key: string, fallback: T): Promise<T> {
  const row = await db.kv.get(key)
  return row === undefined ? fallback : (row.value as T)
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await saveOne(db.kv, { key, value })
}

export async function deleteProjectDeep(projectId: ID): Promise<void> {
  await db.transaction('rw', db.projects, db.entities, db.assets, db.beats, db.assemblies, async () => {
    await db.projects.delete(projectId)
    await db.entities.where('projectId').equals(projectId).delete()
    await db.assets.where('projectId').equals(projectId).delete()
    await db.beats.where('projectId').equals(projectId).delete()
    await db.assemblies.where('projectId').equals(projectId).delete()
  })
}

export interface BackupFile {
  version: 1
  exportedAt: number
  projects: Project[]
  entities: Entity[]
  assets: Array<Omit<Asset, 'blob'>>
  beats: Beat[]
  assemblies: Assembly[]
}

export async function exportBackup(includeKeys = false): Promise<BackupFile> {
  const [projects, entities, assets, beats, assemblies] = await Promise.all([
    db.projects.toArray(),
    db.entities.toArray(),
    db.assets.toArray(),
    db.beats.toArray(),
    db.assemblies.toArray()
  ])
  void includeKeys
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
  await db.transaction('rw', db.projects, db.entities, db.assets, db.beats, db.assemblies, async () => {
    await saveMany(db.projects, data.projects ?? [])
    await saveMany(db.entities, data.entities ?? [])
    await saveMany(db.assets, (data.assets ?? []) as Asset[])
    await saveMany(db.beats, data.beats ?? [])
    await saveMany(db.assemblies, data.assemblies ?? [])
  })
}
