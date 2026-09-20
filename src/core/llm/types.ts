import type { Provider } from '@/domain/types'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatParams {
  temperature?: number
  top_p?: number
  max_tokens?: number
  seed?: number
  stop?: string[]
  response_format?: { type: 'text' | 'json_object' }
}

export interface Usage {
  prompt: number
  completion: number
  total: number
}

export interface StreamHandlers {
  onDelta?(text: string): void
  onReasoning?(text: string): void
  onUsage?(usage: Usage): void
  onDone?(full: string): void
  onError?(err: Error): void
}

export type LlmErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limit'
  | 'network'
  | 'cors'
  | 'parse'
  | 'unknown'

export class LlmError extends Error {
  kind: LlmErrorKind
  status?: number
  hint: string

  constructor(kind: LlmErrorKind, message: string, status?: number, hint = '') {
    super(message)
    this.name = 'LlmError'
    this.kind = kind
    this.status = status
    this.hint = hint
  }
}

export const ERROR_HINT: Record<LlmErrorKind, string> = {
  auth: 'API Key 无效或已过期，请到设置里重新填写。',
  forbidden: '被拒绝访问。可能是地区限制或 CORS，试试在设置里配置代理前缀。',
  not_found: '接口路径或模型名不存在。检查 baseUrl 是否包含 /v1，模型名是否正确。',
  rate_limit: '触发限流或余额不足，稍后重试或更换 Key。',
  network: '网络请求失败。检查网络，或确认供应商是否允许浏览器直连（CORS）。',
  cors: '浏览器直连被 CORS 拦截。请在设置里填写代理前缀。',
  parse: '返回内容不是合法 JSON，已尝试兜底解析。',
  unknown: '未知错误，详见原始信息。'
}

export function normalizeBaseUrl(baseUrl: string): string {
  let url = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  return url
}

/** 兼容 baseUrl 带不带 /v1 的写法 */
export function chatCompletionsUrl(provider: Provider): string {
  const base = normalizeBaseUrl(provider.baseUrl)
  if (!base) return ''
  let full: string
  if (/\/chat\/completions$/.test(base)) full = base
  else if (/\/v\d+$/.test(base)) full = `${base}/chat/completions`
  else full = `${base}/v1/chat/completions`
  return applyProxy(full, provider.proxyPrefix)
}

export function modelsUrl(provider: Provider): string {
  const base = normalizeBaseUrl(provider.baseUrl)
  if (!base) return ''
  let full: string
  if (/\/models$/.test(base)) full = base
  else if (/\/v\d+$/.test(base)) full = `${base}/models`
  else full = `${base}/v1/models`
  return applyProxy(full, provider.proxyPrefix)
}

export function applyProxy(url: string, proxyPrefix?: string): string {
  const prefix = (proxyPrefix || '').trim()
  if (!prefix) return url
  if (prefix.includes('{url}')) return prefix.replace('{url}', encodeURIComponent(url))
  return prefix + encodeURIComponent(url)
}

export function mapHttpError(status: number, body: string): LlmError {
  let kind: LlmErrorKind = 'unknown'
  if (status === 401) kind = 'auth'
  else if (status === 403) kind = 'forbidden'
  else if (status === 404) kind = 'not_found'
  else if (status === 429) kind = 'rate_limit'
  else if (status >= 500) kind = 'network'
  return new LlmError(kind, `HTTP ${status}: ${body.slice(0, 400)}`, status, ERROR_HINT[kind])
}
