import type { Provider } from '@/domain/types'
import {
  chatCompletionsUrl,
  LlmError,
  mapHttpError,
  modelsUrl,
  type ChatMessage,
  type ChatParams,
  type StreamHandlers,
  type Usage
} from './types'

/* ------------------------------------------------------------------ *
 * OpenAI 兼容客户端
 * 纯前端直连：fetch + ReadableStream 手工解析 SSE
 * ------------------------------------------------------------------ */

function headersFor(provider: Provider): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${provider.apiKey}`
  }
}

export interface ChatOptions extends ChatParams {
  signal?: AbortSignal
}

/** 非流式调用，返回完整文本 */
export async function chat(
  provider: Provider,
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<{ text: string; usage?: Usage; reasoning?: string }> {
  const url = chatCompletionsUrl(provider)
  if (!url) throw new LlmError('unknown', '未配置 baseUrl', undefined, '请到设置里填写接口地址')

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headersFor(provider),
      body: JSON.stringify({
        model: provider.model,
        messages,
        temperature: options.temperature ?? 0.7,
        top_p: options.top_p,
        max_tokens: options.max_tokens,
        seed: options.seed,
        stop: options.stop,
        response_format: options.response_format,
        stream: false
      }),
      signal: options.signal
    })
  } catch (e) {
    throw new LlmError('network', String((e as Error)?.message ?? e), undefined, '网络失败或 CORS 拦截，试试代理前缀')
  }

  if (!res.ok) throw mapHttpError(res.status, await res.text())

  const data = await res.json()
  const choice = data?.choices?.[0]
  return {
    text: choice?.message?.content ?? '',
    reasoning: choice?.message?.reasoning_content ?? undefined,
    usage: data?.usage
      ? {
          prompt: data.usage.prompt_tokens ?? 0,
          completion: data.usage.completion_tokens ?? 0,
          total: data.usage.total_tokens ?? 0
        }
      : undefined
  }
}

/** 流式调用 */
export async function chatStream(
  provider: Provider,
  messages: ChatMessage[],
  params: ChatParams,
  handlers: StreamHandlers = {},
  signal?: AbortSignal
): Promise<string> {
  const url = chatCompletionsUrl(provider)
  if (!url) throw new LlmError('unknown', '未配置 baseUrl', undefined, '请到设置里填写接口地址')

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headersFor(provider),
      body: JSON.stringify({
        model: provider.model,
        messages,
        temperature: params.temperature ?? 0.7,
        top_p: params.top_p,
        max_tokens: params.max_tokens,
        seed: params.seed,
        stop: params.stop,
        response_format: params.response_format,
        stream: true,
        stream_options: { include_usage: true }
      }),
      signal
    })
  } catch (e) {
    const err = new LlmError('network', String((e as Error)?.message ?? e), undefined, '网络失败或 CORS 拦截，试试代理前缀')
    handlers.onError?.(err)
    throw err
  }

  if (!res.ok || !res.body) {
    const err = mapHttpError(res.status, await res.text().catch(() => ''))
    handlers.onError?.(err)
    throw err
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let full = ''
  let usage: Usage | undefined

  const handleEvent = (raw: string) => {
    const lines = raw.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(':')) continue
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return
      let json: any
      try {
        json = JSON.parse(payload)
      } catch {
        continue
      }
      const delta = json?.choices?.[0]?.delta
      if (delta?.content) {
        full += delta.content
        handlers.onDelta?.(delta.content)
      }
      if (delta?.reasoning_content) handlers.onReasoning?.(delta.reasoning_content)
      if (json?.usage) {
        usage = {
          prompt: json.usage.prompt_tokens ?? 0,
          completion: json.usage.completion_tokens ?? 0,
          total: json.usage.total_tokens ?? 0
        }
      }
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx = buffer.indexOf('\n\n')
      while (idx >= 0) {
        const event = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        handleEvent(event)
        idx = buffer.indexOf('\n\n')
      }
    }
    if (buffer.trim()) handleEvent(buffer)
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      handlers.onDone?.(full)
      return full
    }
    const err = new LlmError('network', String((e as Error)?.message ?? e))
    handlers.onError?.(err)
    throw err
  }

  if (usage) handlers.onUsage?.(usage)
  handlers.onDone?.(full)
  return full
}

/** 拉取模型列表 */
export async function listModels(provider: Provider): Promise<string[]> {
  const url = modelsUrl(provider)
  if (!url) return []
  const res = await fetch(url, { headers: headersFor(provider) })
  if (!res.ok) throw mapHttpError(res.status, await res.text())
  const data = await res.json()
  const list: any[] = data?.data ?? data?.models ?? []
  return list.map((m) => m.id ?? m.name).filter(Boolean)
}

/* --------------------------- JSON 兜底 --------------------------- */

/**
 * 提取 JSON：
 * 1. 直接 parse
 * 2. 去掉 ```json 代码块再 parse
 * 3. 截取第一个 { 到最后一个 } 再 parse
 * 4. 找第一个平衡的 JSON 对象
 */
export function extractJson<T = any>(raw: string): T {
  const text = (raw ?? '').trim()
  const attempts: string[] = [text]

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) attempts.push(fence[1].trim())

  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) attempts.push(text.slice(first, last + 1))

  for (const a of attempts) {
    try {
      return JSON.parse(a) as T
    } catch {
      /* try next */
    }
  }

  const balanced = firstBalancedJson(text)
  if (balanced) {
    try {
      return JSON.parse(balanced) as T
    } catch {
      /* fallthrough */
    }
  }

  throw new LlmError('parse', `无法解析为 JSON：${text.slice(0, 200)}`, undefined, '模型未按要求返回 JSON，请重试或降低温度')
}

function firstBalancedJson(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 带 JSON 约束的调用，失败自动降级重试一次 */
export async function chatJson<T = any>(
  provider: Provider,
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<T> {
  const withFormat: ChatOptions = {
    ...options,
    temperature: options.temperature ?? 0.4,
    response_format: options.response_format ?? { type: 'json_object' }
  }

  try {
    const { text } = await chat(provider, messages, withFormat)
    return extractJson<T>(text)
  } catch (e) {
    if (e instanceof LlmError && e.kind === 'parse') {
      const { text } = await chat(provider, messages, { ...options, temperature: 0.2 })
      return extractJson<T>(text)
    }
    if (e instanceof LlmError && (e.kind === 'not_found' || e.kind === 'forbidden')) {
      // 有些不支持 response_format，去掉再试
      const { text } = await chat(provider, messages, { ...options, temperature: 0.4 })
      return extractJson<T>(text)
    }
    throw e
  }
}
