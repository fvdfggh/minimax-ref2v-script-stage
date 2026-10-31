import type { Provider } from '@/domain/types'
import { DEFAULT_SIZE } from '@/domain/imageSize'
import {
  LlmError,
  applyProxy,
  mapHttpError,
  normalizeBaseUrl
} from './types'

/* ------------------------------------------------------------------ *
 * OpenAI 兼容图片客户端
 *
 * 文生图  POST {base}/images/generations   （JSON，body 里带 prompt）
 * 图生图  POST {base}/images/edits         （multipart，带原图 + prompt）
 *
 * 与 chat 完全同一套 baseUrl / apiKey / 代理前缀，复用 types.ts 的
 * URL 归一化和错误映射。输出优先请求 b64_json（浏览器零 CORS 二次请求），
 * 服务不支持时自动回退到 url 再下载成 Blob。
 * ------------------------------------------------------------------ */

export interface ImageGenOptions {
  prompt: string
  /** 覆盖模型名；不填则 provider.imageModel → provider.model */
  model?: string
  /** 形如 1280x720 / 960x960；不填用默认（92 万像素量级，见 domain/imageSize.ts） */
  size?: string
  n?: number
  signal?: AbortSignal
}

export interface ImageEditOptions extends ImageGenOptions {
  /** 原图：Blob 或可访问的 url（会先下载成 Blob 再送 edits） */
  image: Blob | string
}

export interface ImageResult {
  blob: Blob
  url?: string
}

function headersFor(provider: Provider): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${provider.apiKey}`
  }
}

function resolveImageModel(provider: Provider, model?: string): string {
  return (model || provider.imageModel || provider.model || '').trim()
}

export function imageGenerationsUrl(provider: Provider): string {
  const base = normalizeBaseUrl(provider.baseUrl)
  if (!base) return ''
  let full: string
  if (/\/images\/generations$/.test(base)) full = base
  else if (/\/v\d+$/.test(base)) full = `${base}/images/generations`
  else full = `${base}/v1/images/generations`
  return applyProxy(full, provider.proxyPrefix)
}

export function imageEditsUrl(provider: Provider): string {
  const base = normalizeBaseUrl(provider.baseUrl)
  if (!base) return ''
  let full: string
  if (/\/images\/edits$/.test(base)) full = base
  else if (/\/v\d+$/.test(base)) full = `${base}/images/edits`
  else full = `${base}/v1/images/edits`
  return applyProxy(full, provider.proxyPrefix)
}

/* --------------------------- 底层 fetch --------------------------- */

async function postJson(
  url: string,
  provider: Provider,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<any> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headersFor(provider),
      body: JSON.stringify(body),
      signal
    })
  } catch (e) {
    throw new LlmError('network', String((e as Error)?.message ?? e), undefined, '网络失败或 CORS 拦截，试试代理前缀')
  }
  if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ''))
  return await res.json()
}

async function postForm(
  url: string,
  provider: Provider,
  form: FormData,
  signal?: AbortSignal
): Promise<any> {
  let res: Response
  try {
    // multipart：浏览器自己带 boundary，Content-Type 不能手设
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      body: form,
      signal
    })
  } catch (e) {
    throw new LlmError('network', String((e as Error)?.message ?? e), undefined, '网络失败或 CORS 拦截，试试代理前缀')
  }
  if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ''))
  return await res.json()
}

/* --------------------------- 解码 / 下载 --------------------------- */

function b64ToBlob(input: string, fallbackMime = 'image/png'): Blob {
  let mime = fallbackMime
  let data = input
  const m = input.match(/^data:([^;,]+)[^,]*,/)
  if (m) {
    mime = m[1]
    data = input.slice(m[0].length)
  }
  const bin = atob(data.trim())
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

async function urlToBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  if (/^data:/i.test(url)) {
    const m = url.match(/^data:([^;,]+)[^,]*,(.*)$/)
    if (m && /base64/i.test(url.slice(0, m.index ?? 0)) === false && m[2]) {
      return new Blob([decodeURIComponent(m[2])], { type: m[1] })
    }
    if (m) return b64ToBlob(m[2], m[1])
  }
  let res: Response
  try {
    res = await fetch(url, { signal })
  } catch (e) {
    throw new LlmError('cors', String((e as Error)?.message ?? e), undefined, '下载生成的图片被 CORS 拦截，试试代理前缀或支持 b64 的供应商')
  }
  if (!res.ok) throw new LlmError('network', `下载图片失败：HTTP ${res.status}`)
  return await res.blob()
}

/** 从响应体里取出图片（兼容 b64_json / data 字段 / url） */
async function parseImagePayload(data: any, signal?: AbortSignal): Promise<ImageResult> {
  const item = Array.isArray(data?.data) ? data.data[0] : data?.data ?? data
  if (!item) throw new LlmError('parse', '图片接口没有返回数据')
  if (typeof item.b64_json === 'string') {
    const mime = item.type && /^image\//.test(item.type) ? item.type : 'image/png'
    return { blob: b64ToBlob(item.b64_json, mime), url: item.url }
  }
  if (typeof item.data === 'string' && item.data.length > 100) {
    return { blob: b64ToBlob(item.data, 'image/png'), url: item.url }
  }
  if (typeof item.url === 'string') {
    return { blob: await urlToBlob(item.url, signal), url: item.url }
  }
  throw new LlmError('parse', '无法从响应里取到图片（既无 b64_json 也无 url），可检查供应商的 images 接口')
}

/* --------------------------- 对外接口 --------------------------- */

/** 文生图。先按 b64_json 请求，服务不支持（400/404/422）则去掉再试（多为 url）。 */
export async function generateImage(provider: Provider, opts: ImageGenOptions): Promise<ImageResult> {
  const url = imageGenerationsUrl(provider)
  if (!url) throw new LlmError('unknown', '未配置 baseUrl', undefined, '请到设置里填写接口地址')
  const model = resolveImageModel(provider, opts.model)
  if (!model) throw new LlmError('unknown', '未配置图片模型', undefined, '在模型设置里填一个图片模型名，或让它回退到主模型')

  const base: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
    n: opts.n ?? 1,
    size: opts.size ?? DEFAULT_SIZE
  }

  let data: any
  try {
    data = await postJson(url, provider, { ...base, response_format: 'b64_json' }, opts.signal)
  } catch (e) {
    if (e instanceof LlmError && (e.status === 400 || e.status === 404 || e.status === 422)) {
      data = await postJson(url, provider, base, opts.signal)
    } else {
      throw e
    }
  }
  return parseImagePayload(data, opts.signal)
}

/** 图生图（基于原图 + 提示词重绘）。multipart 走 /images/edits。 */
export async function editImage(provider: Provider, opts: ImageEditOptions): Promise<ImageResult> {
  const url = imageEditsUrl(provider)
  if (!url) throw new LlmError('unknown', '未配置 baseUrl', undefined, '请到设置里填写接口地址')
  const model = resolveImageModel(provider, opts.model)
  if (!model) throw new LlmError('unknown', '未配置图片模型', undefined, '在模型设置里填一个图片模型名')

  const baseBlob = typeof opts.image === 'string' ? await urlToBlob(opts.image, opts.signal) : opts.image
  const file = new File([baseBlob], 'input.png', { type: baseBlob.type || 'image/png' })

  const form = new FormData()
  form.append('image', file)
  form.append('prompt', opts.prompt)
  form.append('model', model)
  form.append('n', String(opts.n ?? 1))
  if (opts.size) form.append('size', opts.size)
  form.append('response_format', 'b64_json')

  let data: any
  try {
    data = await postForm(url, provider, form, opts.signal)
  } catch (e) {
    if (e instanceof LlmError && (e.status === 400 || e.status === 404 || e.status === 422)) {
      form.delete('response_format')
      data = await postForm(url, provider, form, opts.signal)
    } else {
      throw e
    }
  }
  return parseImagePayload(data, opts.signal)
}
