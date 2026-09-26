/* ------------------------------------------------------------------ *
 * 后端存储适配器
 *
 * 把 REST 接口包装成 Dexie 表的外观，让 src/stores/* 里的
 * `db.beats.where('projectId').equals(pid).toArray()` 这类写法一行都不用改。
 *
 * 两个地方是"故意不透明"的，别当成 bug：
 *
 * 1. 项目 id 上下文。删除只给 id，不给 projectId，所以适配器自己记：
 *    `where('projectId').equals(v)` 顺手记下 v（store 一定先 load 再改），
 *    另外提供 setBackendProject() 供显式指定。
 * 2. 素材本体不进 JSON。Asset.blob 是二进制，PUT 之前先单独 POST 到
 *    /assets，行里只留文件名。
 * ------------------------------------------------------------------ */

import type { Assembly, Asset, Beat, Entity, Project, Provider } from '@/domain/types'

export type BackendTable = 'projects' | 'entities' | 'beats' | 'assemblies' | 'assets' | 'providers'

/** 会带 projectId 一起存的表 */
const SCOPED: BackendTable[] = ['entities', 'beats', 'assemblies', 'assets']
/** 存在项目 meta.json 里的 kv 前缀 */
const META_PREFIXES = ['overrides', 'summaries', 'segmeta']

let base = 'http://127.0.0.1:8787'
let currentProject = ''

export function setBackendBase(url: string): void {
  base = String(url || '').trim().replace(/\/+$/, '') || 'http://127.0.0.1:8787'
}

export function getBackendBase(): string {
  return base
}

export function setBackendProject(projectId: string): void {
  currentProject = String(projectId || '')
}

export function getBackendProject(): string {
  return currentProject
}

async function api<T>(path: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  // 后端没起时 fetch 会一直挂着，首屏不能陪着等 —— 探活用一个更短的超时
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(`${base}/api/${path}`, { ...init, signal: ctrl.signal })
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError'
    if (aborted) throw new Error(`后端 ${timeoutMs}ms 没响应（${base}）`)
    throw new Error(`连不上后端（${base}）。后端没起，或地址不对。`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json()
      detail = typeof body?.error === 'string' ? body.error : ''
    } catch {
      detail = ''
    }
    throw new Error(`后端 ${res.status}${detail ? `：${detail}` : ''}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  }
}

/* --------------------------- 后端能力 --------------------------- */

export interface BackendHealth {
  ok: boolean
  dataDir: string
}

export async function backendHealth(): Promise<BackendHealth | null> {
  try {
    return await api<BackendHealth>('health', undefined, 2500)
  } catch {
    return null
  }
}

export async function backendSetDataDir(dataDir: string): Promise<string> {
  const res = await api<{ dataDir: string }>('config', jsonInit('PUT', { dataDir }))
  return res.dataDir
}

export async function backendConfig(): Promise<{ dataDir: string; default: string }> {
  return api<{ dataDir: string; default: string }>('config')
}

export interface FsEntry {
  name: string
  path: string
}

export async function backendRoots(): Promise<FsEntry[]> {
  const res = await api<{ roots: FsEntry[] }>('fs/roots')
  return res.roots ?? []
}

export async function backendChildren(path: string): Promise<{ path: string; parent: string | null; dirs: FsEntry[] }> {
  return api<{ path: string; parent: string | null; dirs: FsEntry[] }>(
    `fs/children?path=${encodeURIComponent(path)}`
  )
}

/** 素材文件名列表（区别于 assets 集合本身） */
export async function backendListAssetFiles(projectId: string): Promise<string[]> {
  const res = await api<{ files: string[] }>(
    `projects/${encodeURIComponent(projectId)}/files`
  )
  return res.files ?? []
}

export function backendAssetUrl(projectId: string, fileName: string): string {
  return `${base}/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(fileName)}`
}

export async function backendUploadAsset(
  projectId: string,
  fileName: string,
  blob: Blob
): Promise<string> {
  const res = await api<{ fileName: string }>(
    `projects/${encodeURIComponent(projectId)}/assets?filename=${encodeURIComponent(fileName)}`,
    { method: 'POST', body: blob }
  )
  return res.fileName
}

export async function backendDeleteAsset(projectId: string, fileName: string): Promise<void> {
  await api(`projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(fileName)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
}

export async function backendExportProjectZip(projectId: string): Promise<Blob> {
  const res = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}/export`)
  if (!res.ok) throw new Error(`导出失败：${res.status}`)
  return await res.blob()
}

export async function backendExportAllZip(): Promise<Blob> {
  const res = await fetch(`${base}/api/export-all`)
  if (!res.ok) throw new Error(`导出失败：${res.status}`)
  return await res.blob()
}

export interface ImportResult {
  projectId?: string
  name?: string
  assets?: number
  projects?: number
}

export async function backendImportZip(blob: Blob, mode: 'new' | 'replace' = 'new'): Promise<ImportResult> {
  return api<ImportResult>(`import?mode=${mode}`, { method: 'POST', body: blob })
}

/* --------------------------- 表接口 --------------------------- */

export interface WhereClause<T> {
  equals(value: string): {
    toArray(): Promise<T[]>
    sortBy(field: string): Promise<T[]>
    delete(): Promise<number>
  }
}

export interface DataTable<T> {
  toArray(): Promise<T[]>
  get(key: string): Promise<T | undefined>
  put(row: T): Promise<unknown>
  bulkPut(rows: T[]): Promise<unknown>
  delete(key: string): Promise<void>
  bulkDelete(keys: string[]): Promise<unknown>
  count(): Promise<number>
  where(field: string): WhereClause<T>
  orderBy(field: string): { reverse(): { toArray(): Promise<T[]> } }
}

type Row = Record<string, unknown>

function idOf(row: unknown): string {
  return String((row as Row)?.id ?? '')
}

function projectOf(row: unknown): string {
  return String((row as Row)?.projectId ?? '') || currentProject
}

function sortRows<T>(rows: T[], field: string, desc = false): T[] {
  const out = [...rows]
  out.sort((a, b) => {
    const av = (a as Row)?.[field]
    const bv = (b as Row)?.[field]
    if (av === bv) return 0
    if (av == null) return 1
    if (bv == null) return -1
    return av > bv ? 1 : -1
  })
  return desc ? out.reverse() : out
}

class HttpTable<T> implements DataTable<T> {
  constructor(private readonly name: BackendTable) {}

  private get scoped(): boolean {
    return SCOPED.includes(this.name)
  }

  async toArray(): Promise<T[]> {
    if (this.name === 'projects') return await api<T[]>('projects')
    if (this.name === 'providers') return await api<T[]>('providers')
    return await api<T[]>(`all/${this.name}`)
  }

  async get(key: string): Promise<T | undefined> {
    if (this.name === 'projects') {
      try {
        return await api<T>(`projects/${encodeURIComponent(key)}`)
      } catch {
        return undefined
      }
    }
    const rows = await this.toArray()
    return rows.find((r) => idOf(r) === key)
  }

  async put(row: T): Promise<unknown> {
    return await this.bulkPut([row])
  }

  async bulkPut(rows: T[]): Promise<unknown> {
    if (!rows.length) return undefined
    if (this.name === 'projects') {
      for (const row of rows) {
        await api('projects', jsonInit('PUT', { row }))
      }
      return undefined
    }
    if (this.name === 'providers') {
      const current = await this.toArray()
      const byId = new Map(current.map((r) => [idOf(r), r]))
      for (const row of rows) byId.set(idOf(row), row)
      return await api('providers', jsonInit('PUT', { rows: [...byId.values()] }))
    }
    const pid = projectOf(rows[0])
    if (!pid) throw new Error(`写入 ${this.name} 时拿不到 projectId`)
    const payload: Row[] = []
    for (const raw of rows) {
      let row = raw as Row
      // 素材本体走单独的文件接口，不塞进 JSON
      if (this.name === 'assets') {
        const blob = row.blob as Blob | undefined
        const fileName = String(row.fileName ?? '')
        if (blob instanceof Blob && fileName) {
          await backendUploadAsset(String(row.projectId ?? pid), fileName, blob)
        }
        if (blob !== undefined) {
          const { blob: _drop, ...rest } = row
          row = rest
        }
      }
      payload.push(row)
    }
    return await api(`projects/${encodeURIComponent(pid)}/${this.name}`, jsonInit('PUT', { rows: payload }))
  }

  async delete(key: string): Promise<void> {
    if (this.name === 'projects') {
      await api('projects', jsonInit('DELETE', { ids: [key] }))
      return
    }
    if (this.name === 'providers') {
      const kept = (await this.toArray()).filter((r) => idOf(r) !== key)
      await api('providers', jsonInit('PUT', { rows: kept }))
      return
    }
    const pid = currentProject
    if (!pid) throw new Error(`删除 ${this.name} 时拿不到 projectId`)
    await api(`projects/${encodeURIComponent(pid)}/${this.name}`, jsonInit('DELETE', { ids: [key] }))
  }

  async bulkDelete(keys: string[]): Promise<unknown> {
    if (!keys.length) return undefined
    if (this.name === 'providers') {
      const drop = new Set(keys)
      const kept = (await this.toArray()).filter((r) => !drop.has(idOf(r)))
      return await api('providers', jsonInit('PUT', { rows: kept }))
    }
    if (this.name === 'projects') {
      return await api('projects', jsonInit('DELETE', { ids: keys }))
    }
    const pid = currentProject
    if (!pid) throw new Error(`删除 ${this.name} 时拿不到 projectId`)
    return await api(
      `projects/${encodeURIComponent(pid)}/${this.name}`,
      jsonInit('DELETE', { ids: keys })
    )
  }

  async count(): Promise<number> {
    return (await this.toArray()).length
  }

  where(field: string): WhereClause<T> {
    const name = this.name
    const self = this
    return {
      equals(value: string) {
        // store 都是先按 projectId 查再改，这里顺手把上下文记住
        if (field === 'projectId' && value) currentProject = String(value)
        return {
          async toArray(): Promise<T[]> {
            if (field === 'projectId' && SCOPED.includes(name)) {
              return await api<T[]>(`projects/${encodeURIComponent(String(value))}/${name}`)
            }
            const rows = await self.toArray()
            return rows.filter((r) => String((r as Row)?.[field]) === String(value))
          },
          async sortBy(sortField: string): Promise<T[]> {
            const rows = await this.toArray()
            return sortRows(rows, sortField)
          },
          async delete(): Promise<number> {
            if (field === 'projectId' && SCOPED.includes(name)) {
              await api(
                `projects/${encodeURIComponent(String(value))}/${name}`,
                jsonInit('DELETE', {})
              )
              return 0
            }
            const rows = await this.toArray()
            const doomed = rows
              .filter((r) => String((r as Row)?.[field]) === String(value))
              .map((r) => idOf(r))
            await self.bulkDelete(doomed)
            return doomed.length
          }
        }
      }
    }
  }

  orderBy(field: string): { reverse(): { toArray(): Promise<T[]> } } {
    const self = this
    return {
      reverse() {
        return {
          async toArray(): Promise<T[]> {
            const rows = await self.toArray()
            return sortRows(rows, field, true)
          }
        }
      }
    }
  }
}

/* --------------------------- kv --------------------------- */

function splitMetaKey(key: string): { pid: string } | null {
  const idx = key.indexOf(':')
  if (idx <= 0) return null
  const prefix = key.slice(0, idx)
  if (!META_PREFIXES.includes(prefix)) return null
  const pid = key.slice(idx + 1)
  return pid ? { pid } : null
}

export const backendKv = {
  async get<T>(key: string): Promise<T | undefined> {
    const meta = splitMetaKey(key)
    if (meta) {
      const bag = await api<Record<string, unknown>>(
        `projects/${encodeURIComponent(meta.pid)}/meta`
      )
      return bag?.[key] as T | undefined
    }
    const res = await api<{ found: boolean; value: T | undefined }>(
      `kv/${encodeURIComponent(key)}`
    )
    return res.found ? res.value : undefined
  },
  async set(key: string, value: unknown): Promise<void> {
    const meta = splitMetaKey(key)
    if (meta) {
      await api(
        `projects/${encodeURIComponent(meta.pid)}/meta`,
        jsonInit('PUT', { patch: { [key]: value } })
      )
      return
    }
    await api(`kv/${encodeURIComponent(key)}`, jsonInit('PUT', { value }))
  },
  async delete(key: string): Promise<void> {
    const meta = splitMetaKey(key)
    if (meta) {
      await api(
        `projects/${encodeURIComponent(meta.pid)}/meta`,
        jsonInit('DELETE', { keys: [key] })
      )
      return
    }
    await api(`kv/${encodeURIComponent(key)}`, { method: 'DELETE' })
  }
}

export interface BackendDb {
  projects: DataTable<Project>
  entities: DataTable<Entity>
  assets: DataTable<Asset>
  beats: DataTable<Beat>
  assemblies: DataTable<Assembly>
  providers: DataTable<Provider>
}

export function createBackendDb(): BackendDb {
  return {
    projects: new HttpTable<Project>('projects'),
    entities: new HttpTable<Entity>('entities'),
    assets: new HttpTable<Asset>('assets'),
    beats: new HttpTable<Beat>('beats'),
    assemblies: new HttpTable<Assembly>('assemblies'),
    providers: new HttpTable<Provider>('providers')
  }
}
