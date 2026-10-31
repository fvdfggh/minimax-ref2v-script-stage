/**
 * ComfyUI 客户端 —— 全部经剧本台后端转发。
 *
 * 为什么不从浏览器直连 8188：
 *   1. CORS。ComfyUI 要 `--enable-cors-header` 才放行，用户不一定这么起。
 *   2. 本机 `HTTPS_PROXY=127.0.0.1:60155` 会把浏览器对 127.0.0.1 的请求也送去代理，
 *      直连直接 502。后端转发时在 Python 侧挂了空代理 opener，绕得开。
 *   3. multipart（pack.zip 导入）从浏览器拼也麻烦。
 *
 * 例外是**进度**：WebSocket 不受 CORS 限制，运行页直接连 `ws://host/ws`，
 * 这样进度是推送而不是轮询，后端也不需要实现 ws 转发。
 */

import { getBackendBase } from './backend'

export interface ComfyResult<T = unknown> {
  status: number
  ok: boolean
  json?: T
  text: string
  contentType: string
}

/** 后端 /api/comfy/proxy 的返回体 */
interface ProxyResponse {
  status: number
  ok: boolean
  json?: unknown
  text?: string
  contentType?: string
}

async function post<T>(path: string, body: unknown, timeoutMs = 15000): Promise<ComfyResult<T>> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(`${getBackendBase()}/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError'
    throw new Error(
      aborted
        ? `转发超时（${Math.round(timeoutMs / 1000)}s）`
        : '连不上剧本台后端，无法转发到 ComfyUI。'
    )
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: string }
      detail = typeof body?.error === 'string' ? body.error : ''
    } catch {
      detail = ''
    }
    throw new Error(detail || `转发失败（HTTP ${res.status}）`)
  }
  const data = (await res.json()) as ProxyResponse
  return {
    status: data.status,
    ok: data.ok,
    json: data.json as T | undefined,
    text: data.text ?? '',
    contentType: data.contentType ?? ''
  }
}

/**
 * 前端这条超时该给多久。
 *
 * 转发有**两条独立的超时**，它们量的不是同一件事：
 *
 *   后端 `timeout`（秒）→ Python urllib 的 socket 超时，是"连上之后每一次读
 *                          最多等多久"，不是整单的截止时间；
 *   前端 AbortController → 从发出请求到收完响应体的硬截止。
 *
 * 所以前端必须比后端长，而且不能吃默认的 15 s。反例就是分段导出：后端给
 * 300 s 慢慢解码重编码（19 段实测 47 s），前端 15 s 就 abort —— 用户看到
 * 「转发超时（15s）」，可后端其实还在写文件，重试还会撞上同一批输出。
 */
export function proxyFrontTimeoutMs(timeoutSec?: number): number {
  const sec = timeoutSec && timeoutSec > 0 ? timeoutSec : 30
  return Math.max(15000, sec * 1000 + 5000)
}

/** 通用转发：`proxy('http://127.0.0.1:8188', 'GET', '/system_stats')` */
export function comfyProxy<T = unknown>(
  base: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutSec?: number
): Promise<ComfyResult<T>> {
  return post<T>(
    'comfy/proxy',
    { base, method, path, body, timeout: timeoutSec },
    proxyFrontTimeoutMs(timeoutSec)
  )
}

export interface ComfyStats {
  system?: {
    os?: string
    python_version?: string
    devices?: Array<{ name: string; type: string; vram_total: number; vram_free: number }>
  }
  devices?: Array<{ name: string; type: string; vram_total: number; vram_free: number }>
}

/** 探活 + 顺便把显卡信息带回来（选卡页要用真实的可见卡数） */
export async function comfyPing(base: string): Promise<{
  ok: boolean
  stats: ComfyStats | null
  detail: string
}> {
  try {
    const res = await comfyProxy<ComfyStats>(base, 'GET', '/system_stats', undefined, 6)
    if (!res.ok) return { ok: false, stats: null, detail: `ComfyUI 返回 HTTP ${res.status}` }
    return { ok: true, stats: res.json ?? null, detail: '' }
  } catch (err) {
    return { ok: false, stats: null, detail: err instanceof Error ? err.message : String(err) }
  }
}

export interface PromptSubmitResult {
  prompt_id?: string
  node_errors?: Record<string, unknown>
  error?: unknown
}

export function comfySubmitPrompt(
  base: string,
  payload: { prompt: unknown; client_id: string }
): Promise<ComfyResult<PromptSubmitResult>> {
  return comfyProxy<PromptSubmitResult>(base, 'POST', '/prompt', payload, 30)
}

export function comfyInterrupt(base: string): Promise<ComfyResult> {
  return comfyProxy(base, 'POST', '/interrupt', {}, 10)
}

export function comfyClearQueue(base: string): Promise<ComfyResult> {
  return comfyProxy(base, 'POST', '/queue', { clear: true }, 10)
}

export interface ComfyQueue {
  queue_running?: unknown[]
  queue_pending?: unknown[]
}

export function comfyQueue(base: string): Promise<ComfyResult<ComfyQueue>> {
  return comfyProxy<ComfyQueue>(base, 'GET', '/queue', undefined, 10)
}

export interface ComfyHistoryEntry {
  prompt?: unknown
  outputs?: Record<string, unknown>
  /** 结局与时间戳都在这里（`status_str` / `messages[][1].timestamp`） */
  status?: Record<string, unknown>
  meta?: Record<string, unknown>
}

export type ComfyHistory = Record<string, ComfyHistoryEntry>

export function comfyHistory(
  base: string,
  promptId: string
): Promise<ComfyResult<ComfyHistory>> {
  return comfyProxy<ComfyHistory>(
    base,
    'GET',
    `/history/${encodeURIComponent(promptId)}`,
    undefined,
    15
  )
}

/**
 * 整份 history（最近 N 条）。
 *
 * 远程缓存绑定就靠它：每一份 prompt 里的导演节点都带着 `workflow_name`
 * （缓存目录）和 `timeline_data`（段位），这是"对面到底缓存过哪几集"的
 * 唯一事实来源 —— 不需要新端点，也不需要能访问对面的文件系统。
 *
 * 超时给 30s：history 里每份 prompt 都是一张完整的 API 图（25 节点、含
 * 参考图路径），200 条能有十几 MB，比 `/system_stats` 重得多。
 */
export function comfyHistoryAll(
  base: string,
  maxItems = 60
): Promise<ComfyResult<ComfyHistory>> {
  return comfyProxy<ComfyHistory>(
    base,
    'GET',
    `/history?max_items=${encodeURIComponent(String(maxItems))}`,
    undefined,
    30
  )
}

/**
 * 取某次提交**当时**的 timeline（导演节点的 `timeline_data` 输入）。
 *
 * 为什么要回到 history 里翻：分段缓存是按 timeline 里的**位置**（index）放的。
 * 剧本台现在的段可能已经改过、甚至被清空，用当前段计划去问
 * `segment_export_status`，index 就会指到别的段上，产物全部错位。
 * history 里存着提交时的完整 prompt，那份 timeline 才是唯一和缓存对得上的版本。
 */
export async function comfyPromptTimeline(
  base: string,
  promptId: string,
  nodeId: string
): Promise<Record<string, unknown> | null> {
  const api = await comfyPromptApi(base, promptId)
  const inputs = (api?.[nodeId] as { inputs?: Record<string, unknown> } | undefined)?.inputs
  const raw = inputs?.timeline_data
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  return null
}

/**
 * 取某次提交**当时**的整份 API prompt（`/history/<id>` 里 `prompt[2]`）。
 *
 * 「沿用上次配方重跑」要用它：本地段内容没了之后重建不出导演包，但 history
 * 里那份 prompt 是当时真正交给 ComfyUI 的东西 —— 模型、步数、种子、参考图
 * 路径、时间线全在里面，逐字复现比重编更接近"就重跑这一段"。
 */
export async function comfyPromptApi(
  base: string,
  promptId: string
): Promise<Record<string, unknown> | null> {
  if (!base || !promptId) return null
  const res = await comfyHistory(base, promptId)
  const entry = res.json?.[promptId]
  // prompt 形状：[序号, prompt_id, api, extra, outputs]
  const api = Array.isArray(entry?.prompt) ? (entry?.prompt as unknown[])[2] : null
  return api && typeof api === 'object' ? (api as Record<string, unknown>) : null
}

/** node type 是否存在 —— 结果按 base 缓存：一次会话里不会变，提交时不该多一次探测 */
const hasTypeCache = new Map<string, boolean>()

/**
 * 这台 ComfyUI 装了某个节点类型吗？
 *
 * 用来决定"能不能把原生 `CreateVideo` 换成 `MiniMaxH3CreateVideoU8Opt`"：
 * 换是修负片的唯一正确解，但换成一个不存在的节点会让整次提交被拒 ——
 * 探测不到就保持原样（负片，但至少能出片）。
 */
export async function comfyHasNodeType(base: string, type: string): Promise<boolean> {
  if (!base || !type) return false
  const key = `${base.replace(/\/+$/, '')}|${type}`
  const hit = hasTypeCache.get(key)
  if (hit !== undefined) return hit
  let ok = false
  try {
    const res = await comfyProxy<Record<string, unknown>>(
      base,
      'GET',
      `/object_info/${encodeURIComponent(type)}`,
      undefined,
      15
    )
    ok = res.ok && !!res.json && Object.keys(res.json).length > 0
  } catch {
    ok = false
  }
  hasTypeCache.set(key, ok)
  return ok
}

/** 清导演节点的缓存（按 workflow_name 分目录） */
export function comfyClearCache(
  base: string,
  payload: { workflow_name?: string; node_id?: string; clear_all?: boolean }
): Promise<ComfyResult> {
  return comfyProxy(base, 'POST', '/minimax/director_opt/clear_cache', payload, 60)
}

export interface PackImportResult {
  timeline?: unknown
  widgets?: Record<string, unknown>
  packId?: string
  missing?: string[]
}

/**
 * 把 pack.zip 交给导演包的 import_pack。
 *
 * 走的是 multipart（字段名必须是 `pack`），后端代理自己拼 boundary。
 */
export async function comfyImportPack(
  base: string,
  blob: Blob,
  filename: string
): Promise<PackImportResult> {
  const url =
    `${getBackendBase()}/api/comfy/import_pack` +
    `?base=${encodeURIComponent(base)}&filename=${encodeURIComponent(filename)}`
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', body: blob })
  } catch {
    throw new Error('连不上剧本台后端，pack 无法转发。')
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: string }
      detail = typeof body?.error === 'string' ? body.error : ''
    } catch {
      detail = ''
    }
    throw new Error(detail || `pack 转发失败（HTTP ${res.status}）`)
  }
  const data = (await res.json()) as ProxyResponse
  if (!data.ok) {
    throw new Error(`ComfyUI 拒绝了这个 pack（HTTP ${data.status}）：${data.text || '无响应体'}`)
  }
  return (data.json ?? {}) as PackImportResult
}

/**
 * 产物 URL（图片/视频）。后端透传，前端可以直接挂到 <img> / <video> 上。
 * 不拼 ComfyUI 直连地址 —— 直连会被本机代理打成 502。
 */
export function comfyViewUrl(
  base: string,
  filename: string,
  subfolder = '',
  type = 'output'
): string {
  const qs = new URLSearchParams({ base, filename, subfolder, type })
  return `${getBackendBase()}/api/comfy/view?${qs.toString()}`
}

/* ----------------------- 导演台：分段产物 ----------------------- */

/** 哪一遍的缓存：一采 / 二采 */
export type SegmentPass = 'first' | 'second'

/** 状态端点里 `source` / `variant` 的取值 */
const PASS_WIRE: Record<SegmentPass, string> = { first: '1st', second: '2nd' }

/**
 * 某一段的成片片段地址（导演节点的 `segment_clip`）。
 *
 * **必须经后端转发**，不能让 `<video>` 直连 8188：
 *   - 跨源媒体在页面里会被判 `MEDIA_ERR_SRC_NOT_SUPPORTED`（ComfyUI 默认不发
 *     CORS 头），地址栏单独打开却是正常的 —— 症状就是"链接能播、页面黑块"；
 *   - 转发层会透传 `Range`，进度条才拖得动。
 * 代价是多一跳本机转发，对 2~5 MB 的段片段可以忽略。
 */
export function comfySegmentClipUrl(
  base: string,
  opts: { nodeId: string; workflowName: string; index: number; pass: SegmentPass }
): string {
  const qs = new URLSearchParams({
    base: (base || '').trim(),
    node_id: opts.nodeId,
    workflow_name: opts.workflowName,
    index: String(opts.index),
    variant: PASS_WIRE[opts.pass]
  })
  return `${getBackendBase()}/api/comfy/clip?${qs.toString()}`
}

export interface SegmentExportRow {
  index: number
  /** 这一遍的 mp4 片段在缓存里 */
  hasClip: boolean
  /** 张量帧还在（能导出，但没现成片段） */
  hasFrames: boolean
  /** 仅 latent（导出要重新 VAE 解码） */
  hasLatent: boolean
  exportable: boolean
  /** 缓存来自被顶掉的那一组 ⇒ 段内容改过，这是旧渲染 */
  stale: boolean
}

export interface SecondSampleRow {
  index: number
  hasLatent: boolean
  hasTextCond: boolean
  hasSecondLatent: boolean
  canSecondSample: boolean
  continuityFromPrev: boolean
}

interface StatusProbeBody {
  node_id: string
  workflow_name: string
  timeline_data: string
  source?: string
}

/**
 * 分段导出可用性（一采/二采各问一次）。
 *
 * 时间线必须和**提交时**那份一致：节点是按 index 找缓存槽的，时间线一改，
 * index 就落到别的段上。所以调用方要传提交用的那份 timeline。
 */
export async function comfySegmentExportStatus(
  base: string,
  body: StatusProbeBody,
  pass: SegmentPass
): Promise<SegmentExportRow[]> {
  const res = await comfyProxy<{ segments?: SegmentExportRow[]; error?: string }>(
    base,
    'POST',
    '/minimax/director_opt/segment_export_status',
    { ...body, source: PASS_WIRE[pass] },
    30
  )
  if (!res.ok) throw new Error(res.json?.error || res.text || `HTTP ${res.status}`)
  return res.json?.segments ?? []
}

/** 二采可用性：知道哪段有 `seg2_*` latent（做过二采） */
export async function comfySecondSampleStatus(
  base: string,
  body: StatusProbeBody
): Promise<SecondSampleRow[]> {
  const res = await comfyProxy<{ segments?: SecondSampleRow[]; error?: string }>(
    base,
    'POST',
    '/minimax/director_opt/second_sample_status',
    body,
    30
  )
  if (!res.ok) throw new Error(res.json?.error || res.text || `HTTP ${res.status}`)
  return res.json?.segments ?? []
}

/** `segment_export` 的原始响应（解析在 domain/segmentOps 里，纯函数好测） */
export interface SegmentExportRaw {
  files?: string[]
  skipped?: Array<{ index?: number; reason?: string }>
  export_dir?: string
  mode?: string
  source?: string
  error?: string
}

/**
 * 分段导出（纯磁盘操作：直接把缓存里的成片写出去，不重新渲染）。
 *
 * `indices` 必须是**数组**：节点侧检查 `isinstance(body.get("indices"), list)`，
 * 传 "0,1" 这样的逗号串会被直接 400 掉（"No segment indices selected."）。
 *
 * 超时给 5 分钟：连段模式要把相邻段解码后重编码，19 段实测 47 s，慢盘更久；
 * 用默认的 30 s 会在导出进行到一半时被后端掐断，用户看到的是"导出没反应"。
 */
export async function comfySegmentExport(
  base: string,
  body: StatusProbeBody & { indices: number[]; mode: string },
  timeoutSec = 300
): Promise<SegmentExportRaw> {
  const res = await comfyProxy<SegmentExportRaw>(
    base,
    'POST',
    '/minimax/director_opt/segment_export',
    body,
    timeoutSec
  )
  if (!res.ok) throw new Error(res.json?.error || res.text || `HTTP ${res.status}`)
  return res.json ?? {}
}

/** ComfyUI 的 ws 地址：http→ws，https→wss */
export function comfyWsUrl(base: string, clientId: string): string {
  const raw = (base || '').trim().replace(/\/+$/, '')
  const ws = raw.startsWith('https://')
    ? `wss://${raw.slice('https://'.length)}`
    : raw.startsWith('http://')
      ? `ws://${raw.slice('http://'.length)}`
      : `ws://${raw}`
  return `${ws}/ws?clientId=${encodeURIComponent(clientId)}`
}

/* ------------------------------ 本机扫描 ------------------------------ */

/**
 * 本机目录扫描 —— 这一组**不需要 ComfyUI 在跑**。
 *
 * 模型只是磁盘上的文件，ComfyUI 的 /object_info 虽然能给更全的候选（含远程
 * 下载列表），但它要进程活着。用户经常是"配参数时 ComfyUI 还没起"，所以
 * 这里直接从 models/ 目录读，保证任何时刻下拉里都有真实的本机文件。
 */

export type ModelKind =
  | 'model'
  | 'lora'
  | 'vae'
  | 'clip'
  | 'clip_vision'
  | 'upscale'
  | 'controlnet'
  | 'patch'
  | 'audio'

export interface LocalModels {
  ok: boolean
  root: string
  exists: boolean
  reason?: string
  /** 类别 → 相对 models/ 的路径列表 */
  dirs: Partial<Record<ModelKind, string[]>>
  counts: Partial<Record<ModelKind, number>>
}

export interface LocalWorkflowFile {
  name: string
  path: string
  format: 'api' | 'ui' | 'unknown' | 'broken'
  nodes: number
  size: number
}

export interface LocalWorkflows {
  ok: boolean
  root: string
  exists: boolean
  dir?: string
  items: LocalWorkflowFile[]
}

async function getLocal<T>(kind: string, root: string, extra?: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ kind, root, ...(extra ?? {}) })
  let res: Response
  try {
    res = await fetch(`${getBackendBase()}/api/comfy/local?${qs.toString()}`)
  } catch {
    throw new Error('连不上剧本台后端，无法扫描本机目录。')
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: string }
      detail = typeof body?.error === 'string' ? body.error : ''
    } catch {
      detail = ''
    }
    throw new Error(detail || `扫描失败（HTTP ${res.status}）`)
  }
  return (await res.json()) as T
}

export function comfyLocalModels(root: string): Promise<LocalModels> {
  return getLocal<LocalModels>('models', root)
}

export function comfyLocalWorkflows(root: string): Promise<LocalWorkflows> {
  return getLocal<LocalWorkflows>('workflows', root)
}

/** 让后端猜一个 ComfyUI 根目录（用户没填时用） */
export function comfyGuessRoot(): Promise<{ root: string }> {
  return getLocal<{ root: string }>('guess', '')
}

/** 读 ComfyUI 根目录内的一个文件（路径必须在根目录内，后端会校验） */
export function comfyReadFile(root: string, rel: string): Promise<{ ok: boolean; text: string }> {
  return getLocal<{ ok: boolean; text: string }>('read', root, { path: rel })
}

/* ------------------------------------------------------------------ *
 * 显卡
 * ------------------------------------------------------------------ */

export interface GpuInfo {
  index: number
  name: string
  memoryTotal: number
  memoryUsed: number
  util: number
}

export interface ComfyGpuView {
  online: boolean
  /** ComfyUI 进程能看见几张卡（= --cuda-device 给的个数） */
  visible: number
  /** 节点此刻真实的选卡枚举（可见卡的全部子集） */
  options: string[]
  devices: Array<{ index: number; name: string; vramTotal: number }>
}

export interface GpuSnapshot {
  ok: boolean
  reason: string
  gpus: GpuInfo[]
  comfy: ComfyGpuView
  base: string
}

/** 本机物理卡 + ComfyUI 可见卡 + 节点选卡枚举，一次拿全 */
export async function comfyGpus(base: string): Promise<GpuSnapshot> {
  const qs = new URLSearchParams({ base })
  let res: Response
  try {
    res = await fetch(`${getBackendBase()}/api/comfy/gpus?${qs.toString()}`)
  } catch {
    throw new Error('连不上剧本台后端，读不到显卡。')
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: string }
      detail = typeof body?.error === 'string' ? body.error : ''
    } catch {
      detail = ''
    }
    throw new Error(detail || `读显卡失败（HTTP ${res.status}）`)
  }
  return (await res.json()) as GpuSnapshot
}
