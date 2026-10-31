/**
 * 节点参数总表（schema）。
 *
 * 存在的理由：工作流控制台原本只认"导入的 API 工作流"，没导入就一个参数都
 * 配不了 —— 而用户手里几十份工作流全是界面格式，导不进来。参数定义其实一直
 * 都在磁盘上（`/object_info` 或者节点包源码），不该被"有没有导入"卡住。
 *
 * 两条来源：
 *   1. ComfyUI `/object_info` —— 权威、完整，但要进程活着
 *   2. `?kind=nodes` 静态扫源码 —— 随时可用，但动态构造的 INPUT_TYPES 会漏
 * 在线那份覆盖离线那份，离线只用来补空。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { kvGet, kvSet } from '@/db'
import { getBackendBase } from '@/core/backend'
import { comfyProxy } from '@/core/comfy'
import { DEFAULT_COMFY_URL } from '@/domain/run'
import { mergeSchemas, normalizeObjectInfo, normalizeSourceScan } from '@/domain/schema'
import type { NodeSchema } from '@/domain/schema'
import { useLocalStore } from './local'

const KV_ONLINE = 'comfyObjectInfo'

export const useSchemaStore = defineStore('schema', () => {
  const online = ref<NodeSchema[]>([])
  const offline = ref<NodeSchema[]>([])
  const loading = ref(false)
  const error = ref('')
  /** 在线那份是什么时候拉的、从哪个地址拉的 —— 用户要能判断它还新不新 */
  const onlineAt = ref(0)
  const onlineBase = ref('')

  const all = computed(() => mergeSchemas(online.value, offline.value))

  const hasOnline = computed(() => online.value.length > 0)
  const source = computed(() => (hasOnline.value ? 'object_info' : offline.value.length ? 'source' : 'none'))

  /** 按类型取；在线优先（mergeSchemas 已经保证） */
  function nodeOf(type: string): NodeSchema | null {
    return all.value.find((n) => n.type === type) ?? null
  }

  /* ------------------------------ 在线 ------------------------------ */

  /**
   * 拉 /object_info。响应经常好几 MB，所以存的是**归一化之后**的精简结构，
   * 不是原始响应 —— 原始响应塞进 kv 会把后端目录撑大且毫无用处。
   */
  async function fetchOnline(base: string, opts: { cache?: boolean } = {}) {
    loading.value = true
    error.value = ''
    try {
      const res = await comfyProxy<unknown>(base, 'GET', '/object_info', undefined, 60)
      if (!res.ok) {
        error.value = `ComfyUI 返回 HTTP ${res.status}`
        return
      }
      const list = normalizeObjectInfo(res.json)
      if (!list.length) {
        error.value = '/object_info 里没有可用节点'
        return
      }
      online.value = list
      onlineAt.value = Date.now()
      onlineBase.value = base
      if (opts.cache !== false) {
        await kvSet(KV_ONLINE, { at: onlineAt.value, base, nodes: list })
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  /* ------------------------------ 离线 ------------------------------ */

  async function scanOffline(root: string) {
    loading.value = true
    try {
      const qs = new URLSearchParams({ kind: 'nodes', root })
      const res = await fetch(`${getBackendBase()}/api/comfy/local?${qs.toString()}`)
      if (!res.ok) {
        error.value = `源码扫描失败（HTTP ${res.status}）`
        return
      }
      const doc = (await res.json()) as { ok?: boolean; nodes?: unknown; stats?: unknown }
      offline.value = normalizeSourceScan(doc)
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  async function load() {
    const cached = await kvGet<{ at: number; base: string; nodes: NodeSchema[] } | null>(
      KV_ONLINE,
      null
    )
    if (cached?.nodes?.length) {
      online.value = cached.nodes
      onlineAt.value = cached.at ?? 0
      onlineBase.value = cached.base ?? ''
    }
  }

  /** 一键两条都来：先在线，失败就退回离线。 */
  async function refresh(base = DEFAULT_COMFY_URL) {
    const local = useLocalStore()
    await fetchOnline(base)
    if (!online.value.length) await scanOffline(local.root)
  }

  return {
    online,
    offline,
    all,
    loading,
    error,
    onlineAt,
    onlineBase,
    hasOnline,
    source,
    nodeOf,
    load,
    refresh,
    fetchOnline,
    scanOffline
  }
})
