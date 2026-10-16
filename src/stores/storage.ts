import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  backendConfig,
  backendHealth,
  backendSetDataDir,
  setBackendBase
} from '@/core/backend'
import { storageMode, useBackend } from '@/db'

/* ------------------------------------------------------------------ *
 * 存储
 *
 * 数据统一由 Python 后端管理，不再有"浏览器本地模式"。
 * 启动时探活后端：
 *   - 连上  -> 进入可用状态（ready=true），一切读写走后端
 *   - 连不上 -> ready=false，由页面给出"后端未启动"的拦截，而不是
 *               悄悄退回浏览器（浏览器已不再存放任何数据）。
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'scriptstage.storage'

export const useStorageStore = defineStore('storage', () => {
  const baseUrl = ref('http://127.0.0.1:8787')
  const dataDir = ref('')
  const defaultDir = ref('')
  const online = ref(false)
  const checking = ref(false)
  const lastError = ref('')

  const mode = ref<'backend'>('backend')
  const isBackend = computed(() => true)
  /** 后端是否已成功连接（页面据此决定放行渲染还是给出拦截） */
  const ready = ref(false)

  function persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseUrl: baseUrl.value }))
    } catch {
      /* 隐私模式下写不了，忽略 */
    }
  }

  function restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const data = JSON.parse(raw) as { baseUrl?: string }
      if (data.baseUrl) baseUrl.value = data.baseUrl
    } catch {
      /* 坏值就用默认 */
    }
  }

  async function probe(candidate = baseUrl.value): Promise<boolean> {
    checking.value = true
    lastError.value = ''
    try {
      setBackendBase(candidate)
      const health = await backendHealth()
      if (!health) {
        online.value = false
        lastError.value = '后端没有响应'
        return false
      }
      baseUrl.value = candidate
      dataDir.value = health.dataDir
      online.value = true
      try {
        const cfg = await backendConfig()
        defaultDir.value = cfg.default
      } catch {
        /* 拿默认目录失败不影响使用 */
      }
      return true
    } finally {
      checking.value = false
    }
  }

  function enableBackend(): void {
    useBackend(baseUrl.value)
    mode.value = 'backend'
    persist()
  }

  /**
   * 连接后端。成功则启用后端存储并置 ready；失败保持 ready=false。
   * 幂等入口 init() 与"重试"按钮都走这里。
   */
  async function connect(): Promise<boolean> {
    const ok = await probe()
    if (ok) {
      enableBackend()
      ready.value = true
    } else {
      ready.value = false
    }
    return ok
  }

  let initialized = false

  /**
   * 幂等：页面里有多个入口都会调它，但存储只能定一次，
   * 而且必须在任何 store 读数据之前定下来。
   */
  async function init(): Promise<void> {
    if (initialized) return
    initialized = true
    restore()
    await connect()
  }

  async function setDataDir(dir: string): Promise<void> {
    dataDir.value = await backendSetDataDir(dir)
  }

  return {
    baseUrl,
    dataDir,
    defaultDir,
    online,
    checking,
    lastError,
    mode,
    isBackend,
    ready,
    probe,
    init,
    connect,
    enableBackend,
    setDataDir,
    storageMode
  }
})
