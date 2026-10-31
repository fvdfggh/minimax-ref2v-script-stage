/**
 * 导演台（ComfyMiniMaxH3DirectorOpt）在剧本台里的镜像。
 *
 * 两件事：
 *   1. 拉 `/object_info` 得到**此刻真实**的参数规格（枚举会随可见卡/模型变，
 *      所以必须现取，不能写死一份）。
 *   2. 执行导演台的 HTTP 动作（清缓存、导出段、二采、音频提取、ASR、镜头检测…）。
 *
 * 动作全部经剧本台后端转发 —— 浏览器直连 8188 会被本机代理打成 502。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { comfyProxy } from '@/core/comfy'
import {
  DIRECTOR_ACTIONS,
  buildActionPayload,
  isConfigurable,
  parseDirectorSpec,
  type DirectorAction,
  type DirectorInputSpec
} from '@/domain/director'

/** 导演节点的两个历史 class_type，导入的工作流可能用任意一个 */
const DIRECTOR_TYPES = ['ComfyMiniMaxH3DirectorOpt', 'MiniMaxH3DirectorOpt']

export interface ActionLogLine {
  t: number
  action: string
  ok: boolean
  text: string
}

export const useDirectorStore = defineStore('director', () => {
  const specs = ref<DirectorInputSpec[]>([])
  const specLoading = ref(false)
  const specError = ref('')
  /** 规格是哪个 class_type 取的，UI 上标一下，方便对不上时排查 */
  const specNodeType = ref('')

  const actions = DIRECTOR_ACTIONS
  const busyId = ref('')
  const lastResult = ref<Record<string, unknown> | null>(null)
  const log = ref<ActionLogLine[]>([])

  /** 能当旋钮配的参数（排除连线口与分组标题） */
  const knobs = computed(() => specs.value.filter(isConfigurable))
  const linkInputs = computed(() => specs.value.filter((s) => !isConfigurable(s)))

  function specFor(name: string): DirectorInputSpec | undefined {
    return specs.value.find((s) => s.name === name)
  }

  async function loadSpec(base: string, nodeTypeHint?: string) {
    if (!base) return
    specLoading.value = true
    specError.value = ''
    try {
      for (const nodeType of [...(nodeTypeHint ? [nodeTypeHint] : []), ...DIRECTOR_TYPES]) {
        const res = await comfyProxy<Record<string, unknown>>(
          base,
          'GET',
          `/object_info/${nodeType}`,
          undefined,
          40
        )
        if (!res.ok || !res.json) continue
        const parsed = parseDirectorSpec(res.json)
        if (!parsed.length) continue
        specs.value = parsed
        specNodeType.value = nodeType
        return
      }
      specError.value = '没取到导演节点规格（ComfyUI 没起，或节点没装）'
    } catch (err) {
      specError.value = err instanceof Error ? err.message : String(err)
    } finally {
      specLoading.value = false
    }
  }

  function pushLog(action: string, ok: boolean, text: string) {
    log.value.unshift({ t: Date.now(), action, ok, text })
    if (log.value.length > 60) log.value.length = 60
  }

  /**
   * 执行一次导演台动作。
   *
   * 上下文（node_id / workflow_name / timeline_data）由调用方给 —— 同一个动作
   * 打在哪个节点上，是"当前这张图"的事，store 不该替用户猜。
   */
  async function runAction(
    action: DirectorAction,
    values: Record<string, unknown>,
    ctx: { base: string; nodeId: string; workflowName: string; timelineData?: unknown }
  ) {
    if (!ctx.base) throw new Error('没有 ComfyUI 地址')
    if (!ctx.nodeId && (action.auto ?? []).includes('node_id')) {
      throw new Error('当前工作流里没有导演节点，这个动作不知道该打在谁身上')
    }
    busyId.value = action.id
    const path = `/minimax/director_opt${action.path}`
    try {
      const body = buildActionPayload(action, values, ctx)
      const res =
        action.method === 'GET'
          ? await comfyProxy(ctx.base, 'GET', withQuery(path, body), undefined, 60)
          : await comfyProxy(ctx.base, 'POST', path, body, 120)
      lastResult.value = (res.json ?? { raw: res.text }) as Record<string, unknown>
      pushLog(action.label, res.ok, res.ok ? '完成' : `HTTP ${res.status}：${res.text.slice(0, 400)}`)
      return lastResult.value
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      pushLog(action.label, false, text)
      throw err
    } finally {
      busyId.value = ''
    }
  }

  /** GET 动作要把参数拼到路径上（后端 proxy 只转发 path） */
  function withQuery(path: string, body: Record<string, unknown>): string {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || v === null || v === '') continue
      qs.set(k, String(v))
    }
    const sep = path.includes('?') ? '&' : '?'
    return qs.toString() ? `${path}${sep}${qs.toString()}` : path
  }

  return {
    specs,
    specLoading,
    specError,
    specNodeType,
    actions,
    knobs,
    linkInputs,
    busyId,
    lastResult,
    log,
    specFor,
    loadSpec,
    runAction
  }
})
