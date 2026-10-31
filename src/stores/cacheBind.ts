/**
 * 远程缓存绑定 store：**每一集**记一条自己的绑定。
 *
 * 存 kv 而不是项目集合：它描述的是"这集在对面哪台机器、哪个缓存目录里出过片"，
 * 属于运行环境而不是剧本文档，换台机器照样能读、也不需要后端建表。
 *
 * 只做三件事：载入 / 扫描对面用过的目录 / 绑定与解绑。探测本身仍在
 * `stores/outputs.ts` —— 那是"这一段有没有成片"，跟"绑到哪个目录"是两回事。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { kvGet, kvSet } from '@/db'
import { comfyHistoryAll } from '@/core/comfy'
import {
  bindingFromCandidate,
  bindingFromSubmit,
  collectRemoteCaches,
  normalizeBaseUrl,
  type CacheBinding,
  type RemoteCacheCandidate,
  type SubmitBindingInput
} from '@/domain/cacheBind'

const KV_BINDS = 'cacheBindingsByEpisode'

/** 一次扫多少条 history：够覆盖"最近几集各跑过几次"，又不至于拖成十几 MB */
export const SCAN_MAX_ITEMS = 60

export const useCacheBindStore = defineStore('cacheBind', () => {
  /** episodeId → 绑定 */
  const binds = ref<Record<string, CacheBinding>>({})
  const loaded = ref(false)
  const scanning = ref(false)
  const scanError = ref('')
  /** 最近一次扫出来的候选（按目录去重、成功的在前） */
  const candidates = ref<RemoteCacheCandidate[]>([])
  /** 这批候选是从哪个地址扫来的 —— 换地址后旧结果不能拿去绑 */
  const scannedBase = ref('')

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  async function load() {
    if (loaded.value) return
    binds.value = await kvGet<Record<string, CacheBinding>>(KV_BINDS, {})
    loaded.value = true
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void kvSet(KV_BINDS, binds.value)
    }, 300)
  }

  function forEpisode(episodeId: string): CacheBinding | null {
    if (!episodeId) return null
    return binds.value[episodeId] ?? null
  }

  /**
   * 扫对面的缓存目录。
   *
   * 失败不清空上一次的结果：用户可能只是地址暂时打错了，回头还能按上次的列表
   * 绑 —— 把唯一能用的证据抹掉，比留一份旧列表糟得多。
   */
  async function scan(base: string, maxItems = SCAN_MAX_ITEMS): Promise<RemoteCacheCandidate[]> {
    const url = normalizeBaseUrl(base)
    if (!url) {
      scanError.value = '先填 ComfyUI 地址'
      return candidates.value
    }
    scanning.value = true
    scanError.value = ''
    try {
      const res = await comfyHistoryAll(url, maxItems)
      if (!res.ok) {
        scanError.value = `读远程历史失败：${res.text || `HTTP ${res.status}`}`
        return candidates.value
      }
      candidates.value = collectRemoteCaches(res.json ?? null)
      scannedBase.value = url
      if (!candidates.value.length) {
        scanError.value =
          '对面历史里没有跑过导演节点的记录（也可能是 ComfyUI 重启后 history 被清空了）。'
      }
      return candidates.value
    } catch (err) {
      scanError.value = err instanceof Error ? err.message : String(err)
      return candidates.value
    } finally {
      scanning.value = false
    }
  }

  /** 绑定某一集；同一个目录重复绑只是刷新时间线与时间戳 */
  function bind(candidate: RemoteCacheCandidate, episodeId: string, baseUrl: string): CacheBinding {
    const b = bindingFromCandidate(candidate, episodeId, baseUrl)
    binds.value = { ...binds.value, [episodeId]: b }
    scheduleSave()
    return b
  }

  /**
   * 生成成功后自动绑定 —— **默认路径，用户不需要做任何选择**。
   *
   * 提交那一刻我们已经知道全部事实（地址、目录、节点、那份时间线），
   * 顺手记下来，之后刷新页面/换浏览器/换机器都还认得这一集的产物。
   *
   * 唯一的例外是用户手动改绑过、且改到别的目录：那说明他明确要换，
   * 自动绑定不能把它悄悄抢回去，否则"我改完又变回去"。
   */
  function autoBind(episodeId: string, input: SubmitBindingInput): CacheBinding | null {
    if (!episodeId || !input.nodeId || !normalizeBaseUrl(input.baseUrl)) return null
    const prev = binds.value[episodeId]
    if (prev?.source === 'manual' && prev.workflowName !== input.workflowName) return prev
    const b = bindingFromSubmit(input, episodeId)
    binds.value = { ...binds.value, [episodeId]: b }
    scheduleSave()
    return b
  }

  function unbind(episodeId: string) {
    if (!(episodeId in binds.value)) return
    const next = { ...binds.value }
    delete next[episodeId]
    binds.value = next
    scheduleSave()
  }

  /** 解绑后候选列表也该清 —— 否则弹窗里还挂着上次那台机器的目录 */
  function clearCandidates() {
    candidates.value = []
    scannedBase.value = ''
    scanError.value = ''
  }

  return {
    binds,
    loaded,
    scanning,
    scanError,
    candidates,
    scannedBase,
    load,
    forEpisode,
    scan,
    bind,
    autoBind,
    unbind,
    clearCandidates
  }
})
