import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, kvSet, saveOne } from '@/db'
import { uid, now } from '@/core/id'
import { chat, chatJson, extractJson, listModels } from '@/core/llm/openai'
import type { Provider } from '@/domain/types'

const SESSION_KEY_STORE = new Map<string, string>()

export const useProviderStore = defineStore('provider', () => {
  const providers = ref<Provider[]>([])
  const currentId = ref<string | null>(null)
  const busy = ref(false)
  const lastError = ref<string | null>(null)
  const lastUsage = ref<{ prompt: number; completion: number; total: number } | null>(null)

  const current = computed(() => providers.value.find((p) => p.id === currentId.value) ?? null)
  const ready = computed(() => {
    const p = current.value
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
      SESSION_KEY_STORE.set(provider.id, provider.apiKey)
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
    SESSION_KEY_STORE.delete(id)
    providers.value = providers.value.filter((p) => p.id !== id)
    if (currentId.value === id) currentId.value = providers.value[0]?.id ?? null
  }

  async function select(id: string | null) {
    currentId.value = id
    await kvSet('currentProviderId', id)
  }

  /** 取实际可用的 Provider（含仅会话保存的 Key） */
  function resolved(): Provider | null {
    const p = current.value
    if (!p) return null
    const sessionKey = SESSION_KEY_STORE.get(p.id)
    return sessionKey ? { ...p, apiKey: sessionKey } : p
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
