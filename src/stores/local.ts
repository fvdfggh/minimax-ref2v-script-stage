/**
 * 本机资源（ComfyUI 根目录 / 模型文件 / 工作流文件）。
 *
 * 存在的理由：模型选择不能依赖 ComfyUI 在跑。
 * ComfyUI 的 /object_info 确实能给出更完整的候选，但它要进程活着 ——
 * 而用户绝大多数时间是"先把参数配好，等下再起 ComfyUI"。模型只是磁盘上的
 * 文件，直接从 models/ 目录读就能拿到真实清单，这个 store 就是干这个的。
 *
 * 另外它顺带解决了"工作流从哪来"：不用再去 ComfyUI 里点 Export(API) 然后
 * 手动找文件 —— 这里直接列出 user/default/workflows 下的 json，点一下就导入。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { kvGet, kvSet } from '@/db'
import {
  comfyGuessRoot,
  comfyLocalModels,
  comfyLocalWorkflows,
  comfyProxy,
  comfyReadFile
} from '@/core/comfy'
import type { LocalModels, LocalWorkflowFile, LocalWorkflows, ModelKind } from '@/core/comfy'

const KV_ROOT = 'comfyRoot'

export const MODEL_KIND_LABEL: Record<ModelKind, string> = {
  model: '主模型 / UNET',
  lora: 'LoRA',
  vae: 'VAE',
  clip: '文本编码器 CLIP',
  clip_vision: 'CLIP Vision',
  upscale: '放大模型',
  controlnet: 'ControlNet',
  patch: 'Model Patch',
  audio: '音频模型'
}

/**
 * 参数名 → 模型类别。
 *
 * ComfyUI 的 Combo 参数在 API format 里**只保存当前值，没有候选列表**，
 * 所以导入工作流后下拉里永远只有那一个值 —— 看着就像"不可选"。
 * 这里按参数名猜它该从哪个目录取候选；猜不中就返回空数组，
 * 控件退化成自由输入（宁可让用户手填，也不能给错候选）。
 */
/**
 * 顺序很重要：前面的先命中。
 *
 * 具体类别（lora / vae / clip_vision / audio）必须排在笼统的 model 之前 ——
 * 否则 `audio_vae` 会被 model 那条的 `vae`… 不对，是 `asr_model_path` 会被
 * model 抢走。宁可让笼统规则垫底。
 */
const PARAM_KIND_HINTS: Array<{ test: RegExp; kinds: ModelKind[] }> = [
  { test: /lora/i, kinds: ['lora'] },
  { test: /vae/i, kinds: ['vae'] },
  { test: /upscale/i, kinds: ['upscale'] },
  { test: /(clip_vision|vision)/i, kinds: ['clip_vision'] },
  { test: /(clip|te_|text_encod|qwen|t5|llm)/i, kinds: ['clip'] },
  { test: /controlnet/i, kinds: ['controlnet'] },
  { test: /(audio|asr|moss|whisper)/i, kinds: ['audio'] },
  // 垫底的笼统规则：自定义节点给主模型参数起的名字五花八门
  { test: /(model|unet|ckpt|dit|transformer|diffusion|backbone)/i, kinds: ['model'] }
]

export function kindsForParam(paramName: string): ModelKind[] {
  for (const h of PARAM_KIND_HINTS) {
    if (h.test.test(paramName)) return h.kinds
  }
  return []
}

export const useLocalStore = defineStore('local', () => {
  const root = ref('')
  const models = ref<LocalModels | null>(null)
  const workflows = ref<LocalWorkflowFile[]>([])
  const loading = ref(false)
  const error = ref('')

  const ready = computed(() => Boolean(models.value?.ok))
  const rootExists = computed(() => Boolean(models.value?.exists))

  /** 按类别取文件名列表 */
  function filesOf(kind: ModelKind): string[] {
    return models.value?.dirs?.[kind] ?? []
  }

  /** 按参数名取候选 —— 下拉里"有东西可选"的关键 */
  function candidatesFor(paramName: string): string[] {
    const kinds = kindsForParam(paramName)
    if (!kinds.length) return []
    const out: string[] = []
    for (const k of kinds) {
      const list = filesOf(k)
      // 节点里填的是相对 models/ 的路径，但很多自定义节点只认文件名，
      // 所以两份都给，用户按节点实际行为挑。
      for (const f of list) {
        if (!out.includes(f)) out.push(f)
      }
    }
    return out
  }

  async function load() {
    root.value = await kvGet<string>(KV_ROOT, '')
    if (!root.value) {
      try {
        const g = await comfyGuessRoot()
        root.value = g.root || ''
      } catch {
        root.value = ''
      }
    }
    if (root.value) await scan()
  }

  async function setRoot(next: string) {
    root.value = next.trim()
    await kvSet(KV_ROOT, root.value)
    await scan()
  }

  async function scan() {
    loading.value = true
    error.value = ''
    try {
      const [m, w] = await Promise.all([
        comfyLocalModels(root.value),
        comfyLocalWorkflows(root.value)
      ])
      models.value = m
      workflows.value = w.items ?? []
      if (!m.exists) error.value = m.reason ?? '目录不存在'
    } catch (err) {
      models.value = null
      workflows.value = []
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  /** 读一份工作流文件内容（用于导入）。UI 格式会在导入处被拒绝。 */
  async function readWorkflow(file: LocalWorkflowFile): Promise<string> {
    const res = await comfyReadFile(root.value, file.path)
    return res.text ?? ''
  }

  /* ---------------------- 从 ComfyUI 运行历史里取图 ---------------------- */

  /**
   * 绕开「手动 Export (API)」这条路。
   *
   * ComfyUI 只在前端 JS 里做 UI→API 转换，没有服务端导出接口，所以离线拿不到
   * API 格式 —— 用户目录里 64 个工作流全是界面格式就是这个原因。
   * 但**跑过一次的图一定在 /history 里**，而且是前端已经转好的 API 格式
   * （history[].prompt[2] 就是那份 graph）。只要 ComfyUI 在跑，这里就能直接取，
   * 用户不用回去点菜单。
   */
  const historyItems = ref<{ id: string; nodes: number; label: string }[]>([])
  const historyLoading = ref(false)
  const historyError = ref('')

  async function fetchHistory(base: string) {
    historyLoading.value = true
    historyError.value = ''
    historyItems.value = []
    try {
      const res = await comfyProxy<Record<string, unknown>>(
        base,
        'GET',
        '/history?max_items=25',
        undefined,
        15
      )
      if (!res.ok) {
        historyError.value = `ComfyUI 返回 HTTP ${res.status}`
        return
      }
      const doc = (res.json ?? {}) as Record<string, { prompt?: unknown[] }>
      const out: { id: string; nodes: number; label: string }[] = []
      for (const [id, entry] of Object.entries(doc)) {
        const graph = Array.isArray(entry?.prompt) ? (entry.prompt[2] as unknown) : null
        const nodes =
          graph && typeof graph === 'object' ? Object.keys(graph as Record<string, unknown>).length : 0
        if (!nodes) continue
        out.push({ id, nodes, label: `${id.slice(0, 8)}… · ${nodes} 节点` })
      }
      out.sort((a, b) => b.nodes - a.nodes)
      historyItems.value = out
      if (!out.length) historyError.value = '历史里没有可用的图（先去 ComfyUI 跑一次）'
    } catch (err) {
      historyError.value = err instanceof Error ? err.message : String(err)
    } finally {
      historyLoading.value = false
    }
  }

  async function graphFromHistory(base: string, id: string): Promise<string> {
    const res = await comfyProxy<Record<string, { prompt?: unknown[] }>>(
      base,
      'GET',
      `/history/${encodeURIComponent(id)}`,
      undefined,
      20
    )
    const entry = res.json?.[id]
    const graph = Array.isArray(entry?.prompt) ? entry.prompt[2] : null
    if (!graph || typeof graph !== 'object') {
      throw new Error('这条历史里没有 graph（可能是很久以前的记录）')
    }
    return JSON.stringify(graph, null, 2)
  }

  const apiWorkflows = computed(() => workflows.value.filter((f) => f.format === 'api'))

  const summary = computed(() => {
    const counts = models.value?.counts ?? {}
    return (Object.keys(counts) as ModelKind[])
      .filter((k) => counts[k])
      .map((k) => ({ kind: k, label: MODEL_KIND_LABEL[k] ?? k, count: counts[k] ?? 0 }))
  })

  return {
    root,
    models,
    workflows,
    loading,
    error,
    ready,
    rootExists,
    apiWorkflows,
    summary,
    historyItems,
    historyLoading,
    historyError,
    filesOf,
    candidatesFor,
    load,
    setRoot,
    scan,
    readWorkflow,
    fetchHistory,
    graphFromHistory
  }
})

export type { LocalWorkflows }
