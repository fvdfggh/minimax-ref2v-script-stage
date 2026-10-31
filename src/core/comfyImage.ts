/**
 * 本地出图：调剧本台后端，让它跑一份 ComfyUI 工作流。
 *
 * 为什么不让浏览器直接打 8188：跟前端其它 ComfyUI 调用同一个理由 ——
 * CORS、本机代理、以及 30~120 秒的等待都需要后端兜着。而且 UI 格式的工作流
 * 要先转成 API 格式，那一步要读 /object_info，浏览器做不了。
 *
 * 图片以 base64 回来：一次请求就能拿到图 + prompt_id + 注入报告，
 * 失败时后端还能把"哪个节点被拒绝"一起带回来。
 */

import { getBackendBase } from './backend'

export interface ComfyWorkflowEntry {
  name: string
  format: 'api' | 'ui' | 'unknown' | 'broken'
  bytes: number
  mtime: number
  nodes?: number
  /** 看起来是文生图（有 KSampler + 空 latent），列表里排前面 */
  t2i?: boolean
  checkpoints?: string[]
  /** 编码器能吃几张参考图（0 = 只能文生图） */
  refs?: number
  /** 能吃参考图 = 支持「按主体图片编辑」 */
  edit?: boolean
  error?: string
}

export interface ComfyWorkflowList {
  root: string
  dir: string
  exists: boolean
  base: string
  workflows: ComfyWorkflowEntry[]
  objectInfo?: boolean
  objectInfoError?: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${getBackendBase()}/api/${path}`, init)
  } catch {
    throw new Error('连不上剧本台后端：先把后端跑起来（server/app.py）')
  }
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    throw new Error(String(body?.error || text || `HTTP ${res.status}`))
  }
  return body as T
}

export function comfyImageWorkflows(opts: {
  base?: string
  root?: string
  refresh?: boolean
} = {}): Promise<ComfyWorkflowList> {
  const q = new URLSearchParams()
  if (opts.base) q.set('base', opts.base)
  if (opts.root) q.set('root', opts.root)
  if (opts.refresh) q.set('refresh', '1')
  return request<ComfyWorkflowList>(`imagegen/workflows?${q.toString()}`)
}

/**
 * 一张参考图。两种来源：
 *   · 项目素材 —— 给 projectId + fileName，后端直接从数据目录读，省一趟 base64；
 *   · 临时图   —— 给 data（base64，可带 data: 前缀）。
 * 字符串形式 = 已经在 ComfyUI input 目录里的文件名（高级用法）。
 */
export type ComfyRef =
  | string
  | { projectId: string; fileName: string }
  | { name?: string; data: string }

export interface ComfyImageRunOptions {
  base?: string
  root?: string
  workflow: string
  prompt: string
  negative?: string
  width?: number
  height?: number
  seed?: number
  steps?: number
  cfg?: number
  /** 参考图：工作流的编码器吃图时才会生效（Qwen-Image-2.1 / Qwen-Image-Edit） */
  refs?: ComfyRef[]
}

export interface ComfyInjectReport {
  sampler?: string | null
  positive?: string | null
  negative?: string | null
  size?: string | null
  seed?: string | null
  steps?: string | null
  format?: string
  workflow?: string
  notes?: string[]
}

export interface ComfyImageResult {
  blob: Blob
  promptId: string
  seconds: number
  report: ComfyInjectReport
  /** 工作流里那张图在 ComfyUI output 下的文件名 */
  filename?: string
}

function base64ToBlob(input: string, mime: string): Blob {
  const bin = atob(input)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime || 'image/png' })
}

/**
 * 跑工作流出图。
 *
 * 没有超时中止：ComfyUI 首次加载模型能到一两分钟，中途 abort 只会让用户
 * 以为"失败了"，而图其实还在队列里跑。后端的 waitSec 才是真正的上限。
 */
export async function comfyImageRun(opts: ComfyImageRunOptions): Promise<ComfyImageResult> {
  const data = await request<{
    image: string
    mime?: string
    promptId?: string
    seconds?: number
    report?: ComfyInjectReport
    filename?: string
  }>('imagegen/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(opts)
  })
  if (!data?.image) throw new Error('后端没有返回图片')
  return {
    blob: base64ToBlob(data.image, data.mime || 'image/png'),
    promptId: data.promptId || '',
    seconds: Number(data.seconds) || 0,
    report: data.report || {},
    filename: data.filename
  }
}

/* ------------------------------- 参考图 ------------------------------- */

/**
 * 把一张参考图放进 ComfyUI 的 input 目录，拿回 LoadImage 能用的文件名。
 *
 * 平时不用单独调：run / batch 的 refs 直接给 {projectId, fileName}，
 * 后端会顺手传。这个接口留给"还没落库的临时图"。
 */
export async function comfyImageUpload(opts: {
  base?: string
  ref: ComfyRef
}): Promise<string> {
  const data = await request<{ name?: string }>('imagegen/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ base: opts.base, ...(typeof opts.ref === 'string' ? { name: opts.ref } : opts.ref) })
  })
  if (!data?.name) throw new Error('后端没有返回参考图文件名')
  return data.name
}

/* ------------------------------- 批量出图 ------------------------------- */

export interface ComfyBatchItem {
  /** 调用方的标识（这里的片段 id），回来后靠它把图对回片段 */
  key: string
  prompt: string
  seed?: number
  /** 这一条自己的参考图：同一批里各段绑的主体不一样，不能共用 */
  refs?: ComfyRef[]
}

export interface ComfyBatchReport extends ComfyInjectReport {
  count?: number
  /** 只有一份的节点（模型 / CLIP / VAE 加载器） */
  shared?: string[]
  /** 每条支路各复制一份的节点 */
  copyPerItem?: string[]
  sink?: string
  nodes?: number
  /** 编码屏障节点 id：有它才做到"先统一编码再统一采样" */
  barrier?: string | null
}

export interface ComfyBatchResult {
  items: { key: string; blob: Blob }[]
  promptId: string
  seconds: number
  report: ComfyBatchReport
}

/**
 * 批量出图：N 条提示词**一次提交**。
 *
 * 后端会把它们做成同一张图里的 N 条支路，共用一套加载器 ——
 * 文本编码器只加载一次，编码全部先做完，再一张张采样。
 * 所以不要在这里循环调 comfyImageRun：那样每张都重新加载一遍编码器。
 */
export async function comfyImageBatch(
  opts: Omit<ComfyImageRunOptions, 'prompt' | 'seed'> & { items: ComfyBatchItem[] }
): Promise<ComfyBatchResult> {
  const data = await request<{
    images: { key: string; image: string; mime?: string }[]
    promptId?: string
    seconds?: number
    report?: ComfyBatchReport
  }>('imagegen/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(opts)
  })
  const images = data?.images ?? []
  if (!images.length) throw new Error('后端没有返回图片')
  return {
    items: images.map((img) => ({
      key: String(img.key),
      blob: base64ToBlob(img.image, img.mime || 'image/png')
    })),
    promptId: data.promptId || '',
    seconds: Number(data.seconds) || 0,
    report: data.report || {}
  }
}
