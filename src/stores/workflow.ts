/**
 * 工作流模板 store。
 *
 * 模板是 workspace 级数据（跨项目共享），所以走 kv 而不是项目集合 ——
 * 后端不需要任何改动，kv 已经是 GET/PUT/DELETE 全通的。
 *
 * 设计约束：**模板不能绑死在某个工作流的节点 id 上**。参数键是
 * `class_type#序号.参数名`，换一份工作流时节点 id 变了照样能对上；
 * 只有当某类节点在新工作流里根本没有时，applyTemplateToApi 才会把它
 * 计入 skipped 并如实报告。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { kvGet, kvSet } from '@/db'
import { now, uid } from '@/core/id'
import { uniqueName, dedupeBatch } from '@/core/naming'
import { deepClone } from '@/core/plain'
import {
  applyTemplateToApi,
  fallbackNodeSpecs,
  parseApiWorkflow,
  upscaleValuesFromApi,
  upscaleParamSpecs,
  valuesFromApi
} from '@/domain/workflow'
import type { ApiWorkflow, NodeSpec, ParamValue, WorkflowTemplate } from '@/domain/workflow'

const KV_TEMPLATES = 'workflowTemplates'
const KV_ACTIVE = 'workflowTemplateActive'
const KV_EPISODE_BIND = 'workflowTemplateByEpisode'

function defaultUpscaleValues(): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  for (const spec of upscaleParamSpecs()) out[spec.key] = spec.default
  return out
}

function upscaleKeys(): string[] {
  return upscaleParamSpecs().map((s) => s.key)
}

/** 把放大节点的值拍平到 `类型#序号.参数` 命名空间下。 */
function flattenUpscale(
  nodeKey: string,
  values: Record<string, ParamValue>
): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  for (const [k, v] of Object.entries(values)) out[`${nodeKey}.${k}`] = v
  return out
}

export const useWorkflowStore = defineStore('workflow', () => {
  const templates = ref<WorkflowTemplate[]>([])
  const activeId = ref<string | null>(null)
  const episodeBind = ref<Record<string, string>>({})
  const loaded = ref(false)
  const saving = ref(false)

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  const active = computed(
    () => templates.value.find((t) => t.id === activeId.value) ?? templates.value[0] ?? null
  )

  const nodes = computed<NodeSpec[]>(() => {
    const api = active.value?.api ?? null
    if (!api) return fallbackNodeSpecs()
    const parsed = parseApiWorkflow(api)
    // 放大节点总是用手写 spec 覆盖自动推断的结果：自动推断只能拿到一个
    // mode 字符串，拼不出三套子参数。
    const idx = parsed.findIndex((n) => n.type === 'MiniMaxH3LatentUpscaleModelOpt')
    const upscale: NodeSpec = {
      key: 'MiniMaxH3LatentUpscaleModelOpt#0',
      type: 'MiniMaxH3LatentUpscaleModelOpt',
      title: '二采放大（Latent Upscaler 3D）',
      group: 'second',
      panel: 'upscale',
      params: upscaleParamSpecs(),
      present: idx >= 0
    }
    if (idx >= 0) parsed[idx] = upscale
    else parsed.unshift(upscale)
    return parsed
  })

  /** 取某节点某个参数的值（带默认值兜底）。 */
  function paramValue(nodeKey: string, param: string): ParamValue {
    const full = `${nodeKey}.${param}`
    const v = active.value?.values[full]
    if (v !== undefined) return v
    const spec = nodes.value.find((n) => n.key === nodeKey)?.params.find((p) => p.key === param)
    return spec?.default ?? ''
  }

  /** 放大节点的全部值，扁平 key 形态。 */
  const upscaleValues = computed<Record<string, ParamValue>>(() => {
    const out: Record<string, ParamValue> = {}
    for (const spec of upscaleParamSpecs()) {
      out[spec.key] = paramValue('MiniMaxH3LatentUpscaleModelOpt#0', spec.key)
    }
    return out
  })

  /**
   * 一采画布尺寸 —— 放大面板用它算「864×480 → ?」的目标尺寸。
   *
   * 从导演节点的 inputs 里取：它虽然不出现在参数卡片里（一个节点就是一整个
   * 工作台），但 width/height 是真实写在图上的，读它比让用户再填一遍可靠。
   * 取不到时退回 lib/constants.py 的默认值 864×480。
   */
  const baseCanvas = computed(() => {
    const api = active.value?.api
    if (api) {
      for (const node of Object.values(api)) {
        const type = node?.class_type
        if (type !== 'ComfyMiniMaxH3DirectorOpt' && type !== 'MiniMaxH3DirectorOpt') continue
        const w = Number(node?.inputs?.width)
        const h = Number(node?.inputs?.height)
        if (w > 0 && h > 0) return { width: w, height: h }
      }
    }
    return { width: 864, height: 480 }
  })

  /* ------------------------------ 载入 ------------------------------ */

  async function load() {
    if (loaded.value) return
    templates.value = await kvGet<WorkflowTemplate[]>(KV_TEMPLATES, [])
    const act = await kvGet<string | null>(KV_ACTIVE, null)
    activeId.value = act && templates.value.some((t) => t.id === act)
      ? act
      : (templates.value[0]?.id ?? null)
    episodeBind.value = await kvGet<Record<string, string>>(KV_EPISODE_BIND, {})

    if (!templates.value.length) {
      const t = makeTemplate('默认模板')
      templates.value = [t]
      activeId.value = t.id
      await flush()
    }
    loaded.value = true
    // 存量重名就地整理一次：早期"新建/复制"不带序号，攒出过一列六个同名模板，
    // 进去就认不出谁是谁。只加序号、不动内容，用户随时能自己改名。
    tidyNames()
  }

  function makeTemplate(name: string, api: ApiWorkflow | null = null): WorkflowTemplate {
    const ts = now()
    const values: Record<string, ParamValue> = api ? valuesFromApi(api) : {}
    const up = api ? upscaleValuesFromApi(api) : null
    Object.assign(values, flattenUpscale('MiniMaxH3LatentUpscaleModelOpt#0', up ?? defaultUpscaleValues()))
    return {
      id: uid('wft'),
      name,
      desc: api ? '' : '还没有导入 API 工作流，目前只能编辑二采放大参数',
      values,
      api,
      createdAt: ts,
      updatedAt: ts
    }
  }

  /* ------------------------------ 持久化 ------------------------------ */

  async function flush() {
    saving.value = true
    try {
      await kvSet(KV_TEMPLATES, templates.value)
      await kvSet(KV_ACTIVE, activeId.value)
      await kvSet(KV_EPISODE_BIND, episodeBind.value)
    } finally {
      saving.value = false
    }
  }

  /** 改参数很频繁，攒 400ms 再落盘，避免每拖一格滑杆写一次文件。 */
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void flush()
    }, 400)
  }

  /* ------------------------------ 模板 CRUD ------------------------------ */

  function select(id: string) {
    if (!templates.value.some((t) => t.id === id)) return
    activeId.value = id
    void flush()
  }

  function create(name: string): WorkflowTemplate {
    // 同名模板在左栏里完全无法区分（曾经一口气堆过 6 个「H3 一采（自动导入）」），
    // 所以新建/复制一律先过一遍去重，用户想改再自己改名。
    const t = makeTemplate(uniqueName(name || '未命名模板', templates.value.map((x) => x.name)))
    templates.value = [...templates.value, t]
    activeId.value = t.id
    void flush()
    return t
  }

  function duplicate(id: string): WorkflowTemplate | null {
    const src = templates.value.find((t) => t.id === id)
    if (!src) return null
    const ts = now()
    const t: WorkflowTemplate = {
      // src 是 templates.value 里的元素（Proxy），structuredClone 会抛 DataCloneError
      ...deepClone(src),
      id: uid('wft'),
      name: uniqueName(`${src.name} 副本`, templates.value.map((x) => x.name)),
      createdAt: ts,
      updatedAt: ts
    }
    templates.value = [...templates.value, t]
    activeId.value = t.id
    void flush()
    return t
  }

  function remove(id: string) {
    templates.value = templates.value.filter((t) => t.id !== id)
    for (const [ep, tid] of Object.entries(episodeBind.value)) {
      if (tid === id) delete episodeBind.value[ep]
    }
    if (activeId.value === id) activeId.value = templates.value[0]?.id ?? null
    void flush()
  }

  function rename(id: string, name: string) {
    const t = templates.value.find((x) => x.id === id)
    if (!t) return
    t.name = name || t.name
    t.updatedAt = now()
    void flush()
  }

  /**
   * 整理存量重名：按列表顺序给重复的名字加序号，返回改了几个。
   * 只改名字，不动 values / api —— 用户据此才能分辨"我要第二个"。
   */
  function tidyNames(): number {
    const plan = dedupeBatch(templates.value)
    if (!plan.size) return 0
    const ts = now()
    for (const t of templates.value) {
      const next = plan.get(t.id)
      if (next) {
        t.name = next
        t.updatedAt = ts
      }
    }
    templates.value = [...templates.value]
    void flush()
    return plan.size
  }

  /* ------------------------------ 参数编辑 ------------------------------ */

  function setParam(nodeKey: string, param: string, value: ParamValue) {
    const t = active.value
    if (!t) return
    t.values[`${nodeKey}.${param}`] = value
    t.updatedAt = now()
    scheduleSave()
  }

  function setUpscale(param: string, value: ParamValue) {
    setParam('MiniMaxH3LatentUpscaleModelOpt#0', param, value)
  }

  /** 恢复某节点到默认值。 */
  function resetNode(nodeKey: string) {
    const t = active.value
    const node = nodes.value.find((n) => n.key === nodeKey)
    if (!t || !node) return
    for (const spec of node.params) t.values[`${nodeKey}.${spec.key}`] = spec.default
    t.updatedAt = now()
    void flush()
  }

  /* ------------------------------ 导入工作流 ------------------------------ */

  /**
   * 导入 API format 工作流。
   *
   * 必须校验是 API 格式而不是界面格式：界面格式是 `{nodes:[...], links:[...]}`，
   * 直接丢进来会解析出 0 个节点，用户会以为"导入成功但没参数"。
   */
  function importApi(id: string, raw: string): { nodes: number; params: number } {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(`不是合法 JSON：${(err as Error).message}`)
    }
    if (parsed && typeof parsed === 'object' && 'nodes' in (parsed as Record<string, unknown>)) {
      throw new Error(
        '这是界面工作流（UI format），不能用于参数注入。请在 ComfyUI 里用「Save (API Format)」重新导出。'
      )
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('API 工作流应该是一个对象：{ "节点id": { class_type, inputs } }')
    }
    const api = parsed as ApiWorkflow
    const hasClassType = Object.values(api).some((n) => typeof n?.class_type === 'string')
    if (!hasClassType) {
      throw new Error('这个 JSON 里没有 class_type 字段，看起来不像 API format。')
    }

    const t = templates.value.find((x) => x.id === id)
    if (!t) throw new Error('模板不存在')

    const specs = parseApiWorkflow(api)
    t.api = api
    t.values = valuesFromApi(api)
    const up = upscaleValuesFromApi(api) ?? defaultUpscaleValues()
    Object.assign(t.values, flattenUpscale('MiniMaxH3LatentUpscaleModelOpt#0', up))
    t.desc = `已导入 ${specs.length} 个节点`
    t.updatedAt = now()
    void flush()

    const params = specs.reduce((sum, n) => sum + n.params.length, 0)
    return { nodes: specs.length, params }
  }

  /** 导出模板（含基线），用于备份或换机器。 */
  function exportTemplate(id: string): string {
    const t = templates.value.find((x) => x.id === id)
    if (!t) throw new Error('模板不存在')
    return JSON.stringify(
      { format: 'scriptstage-workflow-template', version: 1, template: t },
      null,
      2
    )
  }

  /** 应用模板到提供的 API 基线，返回新工作流与未命中的键。 */
  function materialize(templateId: string, api: ApiWorkflow) {
    const t = templates.value.find((x) => x.id === templateId)
    if (!t) throw new Error('模板不存在')
    return applyTemplateToApi(api, t.values)
  }

  /* ------------------------------ 集级绑定 ------------------------------ */

  function bindEpisode(episodeId: string, templateId: string | null) {
    if (!templateId) delete episodeBind.value[episodeId]
    else episodeBind.value[episodeId] = templateId
    void flush()
  }

  function templateForEpisode(episodeId: string): WorkflowTemplate | null {
    const tid = episodeBind.value[episodeId]
    if (!tid) return null
    return templates.value.find((t) => t.id === tid) ?? null
  }

  return {
    templates,
    activeId,
    active,
    nodes,
    upscaleValues,
    baseCanvas,
    episodeBind,
    loaded,
    saving,
    load,
    flush,
    select,
    create,
    duplicate,
    remove,
    rename,
    tidyNames,
    setParam,
    setUpscale,
    resetNode,
    paramValue,
    importApi,
    exportTemplate,
    materialize,
    bindEpisode,
    templateForEpisode
  }
})

/** 放大节点的键在多个组件里都要用，集中一处避免拼错。 */
export const UPSCALE_NODE_KEY = 'MiniMaxH3LatentUpscaleModelOpt#0'
export { upscaleParamSpecs, upscaleKeys }
