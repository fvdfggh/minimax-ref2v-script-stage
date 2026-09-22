import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, kvSet, saveOne } from '@/db'
import { uid, now } from '@/core/id'
import { chat, chatJson, extractJson, listModels } from '@/core/llm/openai'
import type { Provider } from '@/domain/types'

export const useProviderStore = defineStore('provider', () => {
  /**
   * 「仅本次会话使用 Key」的明文 Key 只留在内存里，不落库。
   *
   * 用 ref（而不是裸 Map）是有意为之：provider.ready 依赖它，
   * 裸 Map 不可响应，Key 从无到有时 ready 不会重算 ——
   * 表现就是勾了「仅本次会话」之后，Key 明明填好了，按钮却一直是灰的、点不动。
   *
   * ★ 放在 store 内部而不是模块级：模块级状态是跨 pinia 实例的隐藏全局。
   * 刷新页面在真实浏览器里会重载模块、Key 自然丢失，但在测试或任何重建 pinia
   * 的场景下不会 —— 于是「刷新后会话 Key 真的丢了」这条最要紧的保证无法被验证。
   * store 的生命周期就等于「这一次会话」，语义也更准。
   */
  const sessionKeys = ref<Record<string, string>>({})

  const providers = ref<Provider[]>([])
  const currentId = ref<string | null>(null)
  const busy = ref(false)
  const lastError = ref<string | null>(null)
  const lastUsage = ref<{ prompt: number; completion: number; total: number } | null>(null)

  const current = computed(() => providers.value.find((p) => p.id === currentId.value) ?? null)

  /** 取实际可用的 Provider（含仅会话保存的 Key） */
  function resolved(): Provider | null {
    const p = current.value
    if (!p) return null
    const sessionKey = sessionKeys.value[p.id]
    return sessionKey ? { ...p, apiKey: sessionKey } : p
  }

  /**
   * ★ 必须用 resolved()，不能用 current.value。
   * 会话 Key 不落库，库里的 apiKey 是空串；
   * 用 current 判断会让「能正常调模型」和「按钮全灰」同时成立，非常难查。
   */
  const ready = computed(() => {
    const p = resolved()
    return !!p && !!p.baseUrl && !!p.apiKey && !!p.model
  })

  async function load() {
    providers.value = await db.providers.toArray()
    const kv = await db.kv.get('currentProviderId')
    currentId.value = (kv?.value as string) ?? providers.value[0]?.id ?? null
    if (!providers.value.length) {
      await create({
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: '',
        model: 'deepseek-chat'
      })
    }
  }

  async function create(patch: Omit<Provider, 'id' | 'createdAt' | 'sessionOnly'> & { sessionOnly?: boolean }) {
    const provider: Provider = {
      id: uid('prv'),
      name: patch.name,
      baseUrl: patch.baseUrl,
      apiKey: patch.apiKey,
      model: patch.model,
      proxyPrefix: patch.proxyPrefix,
      sessionOnly: patch.sessionOnly ?? false,
      createdAt: now()
    }
    await save(provider)
    providers.value = [...providers.value, provider]
    if (!currentId.value) await select(provider.id)
    return provider
  }

  async function save(provider: Provider) {
    const persisted: Provider = provider.sessionOnly
      ? { ...provider, apiKey: '' }
      : provider
    await saveOne(db.providers, persisted)
    if (provider.sessionOnly && provider.apiKey) {
      sessionKeys.value = { ...sessionKeys.value, [provider.id]: provider.apiKey }
    }
  }

  async function update(id: string, patch: Partial<Provider>) {
    const idx = providers.value.findIndex((p) => p.id === id)
    if (idx < 0) return
    const next = { ...providers.value[idx], ...patch }
    await save(next)
    const copy = [...providers.value]
    copy[idx] = next
    providers.value = copy
  }

  async function remove(id: string) {
    await db.providers.delete(id)
    const next = { ...sessionKeys.value }
    delete next[id]
    sessionKeys.value = next
    providers.value = providers.value.filter((p) => p.id !== id)
    if (currentId.value === id) currentId.value = providers.value[0]?.id ?? null
  }

  async function select(id: string | null) {
    currentId.value = id
    await kvSet('currentProviderId', id)
  }

  async function probeModels(): Promise<string[]> {
    const p = resolved()
    if (!p) return []
    busy.value = true
    lastError.value = null
    try {
      return await listModels(p)
    } catch (e) {
      lastError.value = (e as Error).message
      throw e
    } finally {
      busy.value = false
    }
  }

  /** 统一的 JSON 调用入口 */
  async function callJson<T = any>(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options: { temperature?: number; max_tokens?: number } = {}
  ): Promise<T> {
    const p = resolved()
    if (!p) throw new Error('未配置模型供应商')
    busy.value = true
    lastError.value = null
    const started = performance.now()
    try {
      const result = await chatJson<T>(p, messages, {
        temperature: options.temperature ?? 0.4,
        max_tokens: options.max_tokens
      })
      lastUsage.value = null
      void started
      return result
    } catch (e) {
      lastError.value = (e as Error).message
      throw e
    } finally {
      busy.value = false
    }
  }

  async function callText(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options: { temperature?: number; max_tokens?: number } = {}
  ): Promise<string> {
    const p = resolved()
    if (!p) throw new Error('未配置模型供应商')
    const started = performance.now()
    try {
      const { text, usage } = await chat(p, messages, {
        temperature: options.temperature ?? 0.6,
        max_tokens: options.max_tokens
      })
      if (usage) lastUsage.value = usage
      void started
      return text
    } catch (e) {
      lastError.value = (e as Error).message
      throw e
    }
  }

  return {
    providers,
    currentId,
    current,
    ready,
    busy,
    lastError,
    lastUsage,
    load,
    create,
    update,
    remove,
    select,
    resolved,
    probeModels,
    callJson,
    callText,
    extractJson
  }
})
