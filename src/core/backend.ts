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
const META_PREFIXES = ['pairs', 'overrides', 'summaries', 'segmeta']

/**
 * 后端地址。
 *
 * 浏览器里默认**同源**（空串）：`npm run build` 之后由 Python 后端在同一个
 * 端口把 dist/ 一起托管，`npm run dev` 时由 vite 把 /api 代理到后端 ——
 * 两条路都是同源，素材的 `<img src>` / `<video src>` 才能带着会话 cookie
 * 直接加载（跨源的话浏览器不给带 cookie，图片会整片 401）。
 *
 * node 环境（vitest）没有 location，退回绝对地址；集成测试本来就会用
 * setBackendBase() 指向自己起的隔离后端。
 */
const DEFAULT_BASE = typeof location === 'undefined' ? 'http://127.0.0.1:8787' : ''
let base = DEFAULT_BASE
let currentProject = ''

export function setBackendBase(url: string): void {
  base = String(url || '').trim().replace(/\/+$/, '')
}

export function getBackendBase(): string {
  return base
}

/** 401 的统一出口：登录过期时由 main.ts 监听并跳登录页 */
export const UNAUTHORIZED_EVENT = 'scriptstage:unauthorized'

function signalUnauthorized(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
  }
}

export function setBackendProject(projectId: string): void {
  currentProject = String(projectId || '')
}

export function getBackendProject(): string {
  return currentProject
}

/**
 * 发一个请求并把错误翻成人话。
 *
 * 抽出来是因为**不是所有接口都回 JSON**：设定图拼接直接回 PNG 字节，
 * 走 `api()` 会在 `res.json()` 上炸掉，而且只会在真的点了「拼成参考图」
 * 时才炸 —— 那种"平时都好好的、一用就报错"的 bug 最难查。
 */
async function request(path: string, init?: RequestInit, timeoutMs = 8000): Promise<Response> {
  // 后端没起时 fetch 会一直挂着，首屏不能陪着等 —— 探活用一个更短的超时
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(`${base}/api/${path}`, {
      ...init,
      // 会话是 cookie：不写 include 的话跨端口开发时 fetch 不会带 cookie
      credentials: 'include',
      signal: ctrl.signal
    })
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError'
    if (aborted) throw new Error(`后端 ${timeoutMs}ms 没响应（${base || '同源'}）`)
    throw new Error(`连不上后端（${base || '同源'}）。后端没起，或地址不对。`)
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 401) {
    // 先把详情读出来再抛，消息里带上后端原话（"密码不对"/"未登录或登录已过期"）
    let detail = ''
    try {
      const body = await res.json()
      detail = typeof body?.error === 'string' ? body.error : ''
    } catch {
      detail = ''
    }
    signalUnauthorized()
    throw new Error(`后端 401${detail ? `：${detail}` : ''}`)
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
  return res
}

async function api<T>(path: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const res = await request(path, init, timeoutMs)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** 二进制接口（目前只有设定图拼接）。超时给得宽：拼一张要几百毫秒到几秒。 */
async function apiBlob(path: string, init?: RequestInit, timeoutMs = 30000): Promise<Blob> {
  const res = await request(path, init, timeoutMs)
  return await res.blob()
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
  /** 未登录时后端不返回数据目录（避免匿名探测磁盘路径） */
  dataDir?: string
  authRequired?: boolean
  authenticated?: boolean
  user?: AuthUser
}

export async function backendHealth(): Promise<BackendHealth | null> {
  try {
    return await api<BackendHealth>('health', undefined, 2500)
  } catch {
    return null
  }
}

/* ---------------------------- 登录 / 账号 ---------------------------- */

export interface AuthUser {
  username: string
  displayName: string
  createdAt?: number
  lastLoginAt?: number
}

export async function authMe(): Promise<AuthUser | null> {
  const res = await api<{ user: AuthUser | null }>('auth/me', undefined, 4000)
  return res.user ?? null
}

export async function authLogin(username: string, password: string): Promise<AuthUser> {
  const res = await api<{ user: AuthUser }>(
    'auth/login',
    jsonInit('POST', { username, password }),
    10000
  )
  return res.user
}

export async function authLogout(): Promise<void> {
  await api('auth/logout', jsonInit('POST', {}), 5000)
}

export async function authChangePassword(
  oldPassword: string,
  newPassword: string
): Promise<void> {
  await api('auth/password', jsonInit('POST', { oldPassword, newPassword }), 10000)
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

/**
 * 设定图拼接：组头 + 一张三视图 → 1376×768 的 16:9 PNG。
 *
 * 只传**文件名**不传图：素材本来就在后端磁盘上，再 base64 传一遍是白搬
 * 几 MB。拼接规则（槽位、contain、补缝色）全在 `server/sheet.py` 一处，
 * 前端不重复实现 —— 两张图分别缩放的取整差一像素，接缝就会露出白线。
 */
export async function backendComposeSheet(
  projectId: string,
  head: string,
  views: string[]
): Promise<Blob> {
  return await apiBlob(
    'sheet/compose',
    jsonInit('POST', { projectId, head, views }),
    // 1376×768 的 LANCZOS 重采样 + PNG 编码，慢机器上要 1~3 s
    30000
  )
}

/** 版式常量。只用于自检 —— 前端的权威值在 `domain/refSheet.ts` 里。 */
export interface SheetLayoutInfo {
  width: number
  height: number
  aspect: string
  head: { x: number; y: number; width: number; height: number }
  view: { x: number; y: number; width: number; height: number }
}

export async function backendSheetLayout(): Promise<SheetLayoutInfo> {
  return await api<SheetLayoutInfo>('sheet/layout')
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

/** 音色包落地情况：restored=这次写进去的，kept=目标机已有一模一样的，conflict=同名但内容不同（保留旧的） */
export interface VoicePackReport {
  restored: string[]
  kept: string[]
  conflict: string[]
  dir?: string
  error?: string
}

/** 包里引用了、但导出时本机就没有的音色包 —— 到对面会变成"有音色描述但合成不了" */
export interface MissingPack {
  id: string
  entity: string
  entityId?: string
  projectId?: string
  projectName?: string
}

export interface ImportResult {
  projectId?: string
  name?: string
  assets?: number
  projects?: number
  episodes?: number
  voicePacks?: VoicePackReport
  missingPacks?: MissingPack[]
  /** 导出时就算出来的缺失清单（导入端直接沿用，不用再算一遍） */
  missing?: { voicePacks?: MissingPack[] }
}

export async function backendImportZip(blob: Blob, mode: 'new' | 'replace' = 'new'): Promise<ImportResult> {
  return api<ImportResult>(`import?mode=${mode}`, { method: 'POST', body: blob })
}

/* --------------------------- 变更指纹 --------------------------- */

/**
 * 每个数据文件的内容指纹。
 *
 * 同一份数据前后端各存一份「看起来的样子」是万恶之源 —— 前端只能靠轮询
 * 后端问「盘上的东西还是不是我上次读到的那个」，所以后端只回指纹
 * （mtime_ns:size），前端存一份基线，比出差异再去 reload 对应表。
 */
export async function backendProjectRevs(
  projectId: string,
  timeoutMs = 4000
): Promise<Record<string, string> | null> {
  if (!projectId) return null
  try {
    return await api<Record<string, string>>(
      `projects/${encodeURIComponent(projectId)}/revs`,
      undefined,
      timeoutMs
    )
  } catch {
    // 轮询失败不打扰用户：后端短暂不可用不该弹错误，下一轮自己会补上
    return null
  }
}

/** 一次写库的通知（谁、哪张表、哪些 id） */
export interface BackendWrite {
  table: BackendTable
  ids: string[]
  kind: 'put' | 'delete'
  projectId: string
}

/**
 * 写库广播。
 *
 * 全站写入都过 HttpTable，所以只要在这里发一次信号，
 * 「某个模块改了数据」这件事就不需要每个调用点自己记得上报。
 * 用回调而不是 EventTarget：core 层不假设运行在浏览器里（vitest 下没有 window）。
 */
let writeSink: ((write: BackendWrite) => void) | null = null

export function setBackendWriteSink(fn: ((write: BackendWrite) => void) | null): void {
  writeSink = fn
}

function reportWrite(table: BackendTable, ids: string[], kind: 'put' | 'delete', projectId: string): void {
  if (!writeSink || !ids.length) return
  try {
    writeSink({ table, ids, kind, projectId })
  } catch {
    // 广播失败绝不能影响已经成功的写库
  }
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
  /**
   * 行 id → 所属 projectId。
   *
   * 为什么需要这张表：**写入**按行里的 projectId 走（下面的 bulkPut），但**删除**
   * 原来只认模块级的 currentProject。而 currentProject 是"最近一次按 projectId
   * 查过谁"，跨项目读（系列页读各集、主体取用/推送）会把它切走 ——
   * 于是一旦在集页里删素材，请求可能发到系列项目上，静默地"删了个空"。
   *
   * 所以把见过的行记下来，删的时候按行自己的 projectId 走。
   */
  private readonly projectById = new Map<string, string>()

  constructor(private readonly name: BackendTable) {}

  private remember(rows: T[]): void {
    if (!this.scoped) return
    for (const row of rows) {
      const id = idOf(row)
      const pid = String((row as Row)?.projectId ?? '')
      if (id && pid) this.projectById.set(id, pid)
    }
  }

  /** 删除时这一行属于哪个项目：优先用见过的行，其次才退回 currentProject */
  private ownerOf(key: string): string {
    return this.projectById.get(key) || currentProject
  }

  private get scoped(): boolean {
    return SCOPED.includes(this.name)
  }

  async toArray(): Promise<T[]> {
    if (this.name === 'projects') return await api<T[]>('projects')
    if (this.name === 'providers') return await api<T[]>('providers')
    const rows = await api<T[]>(`all/${this.name}`)
    this.remember(rows)
    return rows
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
      reportWrite(this.name, rows.map(idOf).filter(Boolean), 'put', '')
      return undefined
    }
    if (this.name === 'providers') {
      const current = await this.toArray()
      const byId = new Map(current.map((r) => [idOf(r), r]))
      for (const row of rows) byId.set(idOf(row), row)
      const out = await api('providers', jsonInit('PUT', { rows: [...byId.values()] }))
      reportWrite(this.name, rows.map(idOf).filter(Boolean), 'put', '')
      return out
    }
    const pid = projectOf(rows[0])
    if (!pid) throw new Error(`写入 ${this.name} 时拿不到 projectId`)
    this.remember(rows)
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
    const out = await api(
      `projects/${encodeURIComponent(pid)}/${this.name}`,
      jsonInit('PUT', { rows: payload })
    )
    reportWrite(this.name, rows.map(idOf).filter(Boolean), 'put', pid)
    return out
  }

  async delete(key: string): Promise<void> {
    if (this.name === 'projects') {
      await api('projects', jsonInit('DELETE', { ids: [key] }))
      reportWrite(this.name, [key], 'delete', '')
      return
    }
    if (this.name === 'providers') {
      const kept = (await this.toArray()).filter((r) => idOf(r) !== key)
      await api('providers', jsonInit('PUT', { rows: kept }))
      reportWrite(this.name, [key], 'delete', '')
      return
    }
    const pid = this.ownerOf(key)
    if (!pid) throw new Error(`删除 ${this.name} 时拿不到 projectId`)
    await api(`projects/${encodeURIComponent(pid)}/${this.name}`, jsonInit('DELETE', { ids: [key] }))
    this.projectById.delete(key)
    reportWrite(this.name, [key], 'delete', pid)
  }

  async bulkDelete(keys: string[]): Promise<unknown> {
    if (!keys.length) return undefined
    if (this.name === 'providers') {
      const drop = new Set(keys)
      const kept = (await this.toArray()).filter((r) => !drop.has(idOf(r)))
      const out = await api('providers', jsonInit('PUT', { rows: kept }))
      reportWrite(this.name, keys, 'delete', '')
      return out
    }
    if (this.name === 'projects') {
      const out = await api('projects', jsonInit('DELETE', { ids: keys }))
      reportWrite(this.name, keys, 'delete', '')
      return out
    }
    // 一批 id 可能跨项目（系列/集同时被选中时），按项目分批发；
    // 全发到 currentProject 的话，别的项目那几条会"删了个空"却没有任何提示
    const groups = new Map<string, string[]>()
    for (const key of keys) {
      const pid = this.ownerOf(key)
      if (!pid) throw new Error(`删除 ${this.name} 时拿不到 projectId`)
      const list = groups.get(pid) ?? []
      list.push(key)
      groups.set(pid, list)
    }
    for (const [pid, ids] of groups) {
      await api(`projects/${encodeURIComponent(pid)}/${this.name}`, jsonInit('DELETE', { ids }))
      for (const id of ids) this.projectById.delete(id)
      reportWrite(this.name, ids, 'delete', pid)
    }
    return undefined
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
              const rows = await api<T[]>(`projects/${encodeURIComponent(String(value))}/${name}`)
              self.remember(rows)
              return rows
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
      // 字段覆盖值 / 摘要 / 段指纹都存在 meta.json，效果落在「段与字段」上。
      // 不广播的话，本页自己改完字段会被下一轮轮询当成"别处改的"。
      reportWrite('assemblies', ['*meta*'], 'put', meta.pid)
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
      reportWrite('assemblies', ['*meta*'], 'delete', meta.pid)
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
