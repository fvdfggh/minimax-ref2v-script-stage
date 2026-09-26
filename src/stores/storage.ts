import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  backendConfig,
  backendHealth,
  backendSetDataDir,
  setBackendBase
} from '@/core/backend'
import { storageMode, useBackend, useLocal } from '@/db'

/* ------------------------------------------------------------------ *
 * 存储模式
 *
 *   local   —— 浏览器 IndexedDB。开箱即用，但清缓存就没了
 *   backend —— Python 后端写数据目录。能备份、能进版本管理、素材是真文件
 *
 * 新装默认 local，不动已有数据；只有用户明确选了目录才切到 backend。
 * 后端没起就自动退回 local，不让页面卡在"打不开"的状态。
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'scriptstage.storage'

export const useStorageStore = defineStore('storage', () => {
  const baseUrl = ref('http://127.0.0.1:8787')
  const dataDir = ref('')
  const defaultDir = ref('')
  const online = ref(false)
  const checking = ref(false)
  const lastError = ref('')
  /** 用户是否主动选过后端（决定启动时是否自动连） */
  const preferBackend = ref(false)

  const mode = ref<'local' | 'backend'>('local')
  const isBackend = computed(() => mode.value === 'backend')

  function persist(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ baseUrl: baseUrl.value, preferBackend: preferBackend.value })
      )
    } catch {
      /* 隐私模式下写不了，忽略 */
    }
  }

  function restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const data = JSON.parse(raw) as { baseUrl?: string; preferBackend?: boolean }
      if (data.baseUrl) baseUrl.value = data.baseUrl
      preferBackend.value = data.preferBackend === true
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

  let initialized = false

  /**
   * 幂等：页面里有多个入口都会调它，但存储模式只能定一次，
   * 而且必须在任何 store 读数据之前定下来。
   */
  async function init(): Promise<void> {
    if (initialized) return
    initialized = true
    restore()
    if (!preferBackend.value) return
    if (await probe()) enableBackend()
  }

  function enableBackend(): void {
    useBackend(baseUrl.value)
    mode.value = 'backend'
    preferBackend.value = true
    persist()
  }

  function enableLocal(): void {
    useLocal()
    mode.value = 'local'
    persist()
  }

  async function setDataDir(dir: string): Promise<void> {
    dataDir.value = await backendSetDataDir(dir)
  }

  /** 已连后端就用它，否则退回浏览器 */
  function ensureBackendOrLocal(): void {
    if (online.value) enableBackend()
    else enableLocal()
  }

  return {
    baseUrl,
    dataDir,
    defaultDir,
    online,
    checking,
    lastError,
    preferBackend,
    mode,
    isBackend,
    probe,
    init,
    enableBackend,
    enableLocal,
    setDataDir,
    ensureBackendOrLocal,
    storageMode
  }
})
