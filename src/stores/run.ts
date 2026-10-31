/**
 * 运行 store：运行配置的持久化 + 提交/进度/产物回收。
 *
 * 和控制台 store 的关系：控制台管"参数长什么样"，这里管"这一跑怎么发"。
 * 提交时两者合并 —— 先套模板（节点参数），再套运行配置（导演旋钮），
 * 顺序不能反：运行配置里有个 workflow_name，模板不会碰它。
 *
 * 进度走浏览器直连的 WebSocket（不受 CORS 限制），因此是推送而不是轮询。
 * 命令与产物回收走剧本台后端转发，避开本机代理与 multipart 的麻烦。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { kvGet, kvSet } from '@/db'
import { now, uid } from '@/core/id'
import { uniqueName, dedupeBatch } from '@/core/naming'
import { deepClone } from '@/core/plain'
import {
  comfyClearCache,
  comfyHistory,
  comfyImportPack,
  comfyInterrupt,
  comfyPing,
  comfyHasNodeType,
  comfyPromptApi,
  comfyPromptTimeline,
  comfyQueue,
  comfySubmitPrompt,
  comfyViewUrl,
  comfyWsUrl,
  type ComfyStats
} from '@/core/comfy'
import {
  applyRunConfigToApi,
  defaultRunConfig,
  directorNodeId,
  DIRECTOR_PROGRESS_EVENT,
  mergeProgress,
  parseDirectorProgress,
  resolveWorkflowNameWithBound,
  runConfigFromApi,
  secondStageOf,
  validateRunConfig,
  type RunConfig
} from '@/domain/run'
import {
  applySecondSample,
  applySigmasText,
  applyUpscaleToApi,
  secondSampleFor
} from '@/domain/secondPass'
import {
  applyTemplateToApi,
  upgradeUint8CreateVideo,
  UINT8_CREATE_VIDEO
} from '@/domain/workflow'
import {
  applyRunSelection,
  patchPromptInputs,
  patchPromptTimeline,
  timelineSegmentCount
} from '@/domain/segmentOps'
import type { ApiWorkflow } from '@/domain/workflow'
import { useCacheBindStore } from '@/stores/cacheBind'

const KV_CONFIGS = 'runConfigs'
const KV_ACTIVE = 'runConfigActive'
const KV_EPISODE_BIND = 'runConfigByEpisode'
const KV_JOBS = 'runJobs'

/** 只保留最近这么多任务：日志和产物 URL 全在内存里，攒多了没意义 */
const JOB_KEEP = 30

/** 每个任务"上次记进日志的阶段"，用来给高频进度事件去重（不进 kv） */
const phaseKeys = new WeakMap<RunJob, string>()

export type JobStatus =
  | 'submitting'
  | 'queued'
  | 'running'
  | 'done'
  | 'error'
  | 'interrupted'

export interface RunProgress {
  value: number
  max: number
  /** 第几段 / 共几段 */
  segment: number
  segmentTotal: number
  /** 时间线里的段 id（seg03） */
  timelineSegment: string
  phase: string
  phaseLabel: string
  framesLabel: string
  remainingSegments: number
  /** 最后一次收到进度事件的时间。用来判断"是卡住了还是只是没上报" */
  updatedAt: number
}

export interface LogLine {
  t: number
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface RunOutput {
  kind: 'image' | 'video'
  filename: string
  subfolder: string
  type: string
  url: string
  nodeId: string
}

export interface RunJob {
  id: string
  promptId: string
  episodeId: string
  episodeName: string
  templateName: string
  configName: string
  baseUrl: string
  workflowName: string
  status: JobStatus
  submittedAt: number
  startedAt: number | null
  endedAt: number | null
  progress: RunProgress
  logs: LogLine[]
  outputs: RunOutput[]
  error: string
  /** 提交时套用的参数命中情况，事后排查"为什么没生效"要看它 */
  applied: number
  skipped: string[]
  /**
   * 提交时导演节点的图内 id。
   * 导演的进度事件不带 prompt_id，只有 node_id，靠它才能把进度归到任务上。
   */
  directorNodeId: string
  /** 这次只跑了哪几段（空 = 全跑） */
  onlySegments?: number[]
  /** 时间线里一共几段（部分运行时显示 "2/4 段" 用） */
  segmentTotal?: number
  /** 最后一次收到任何 ws 消息的时间 */
  lastEventAt: number
}

function emptyProgress(): RunProgress {
  return {
    value: 0,
    max: 0,
    segment: 0,
    segmentTotal: 0,
    timelineSegment: '',
    phase: '',
    phaseLabel: '',
    framesLabel: '',
    remainingSegments: 0,
    updatedAt: 0
  }
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff)
}

/**
 * 能交给 `<video>` 播放的扩展名（含纯音频 —— video 元素播音频也正常，
 * 显示成控件条即可，总比当图片渲染成破图强）。
 *
 * 为什么必须按扩展名判、不能按 history 里的键名判：ComfyUI 的 `SaveVideo`
 * 把成片塞在 **`images`** 键下（历史行为，也兼容前端预览），VideoHelperSuite
 * 又把视频放在 `gifs` 下。按 `images → 图片` 判，mp4 就会被当图片渲染成
 * `<img src="....mp4">` —— 一片黑，正是"产物识别不到、根本不可播放"。
 */
const VIDEO_EXT = new Set([
  '.mp4',
  '.webm',
  '.mov',
  '.mkv',
  '.m4v',
  '.avi',
  '.flv',
  '.wav',
  '.mp3',
  '.flac',
  '.m4a',
  '.ogg',
  '.opus'
])

export function kindOfFile(filename: string): RunOutput['kind'] {
  const dot = filename.lastIndexOf('.')
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : ''
  return VIDEO_EXT.has(ext) ? 'video' : 'image'
}

/** 从任意一层里把形如 `{filename, subfolder, type}` 的条目捞出来 */
function harvestFiles(value: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 3 || !value) return []
  if (Array.isArray(value)) return value.flatMap((v) => harvestFiles(v, depth + 1))
  if (typeof value !== 'object') return []
  const r = value as Record<string, unknown>
  if (typeof r.filename === 'string' && r.filename) return [r]
  return Object.values(r).flatMap((v) => harvestFiles(v, depth + 1))
}

/**
 * 从 history 的 outputs 里挑出能看的图/视频。
 *
 * 不再写死 `images / videos / gifs` 三个键：自定义节点把产出放在哪个键下
 * 全凭作者心情（`outputs` / `files` / `videos` / `0`……）。只要值里有一个带
 * `filename` 的对象就收，kind 由扩展名决定。
 */
export function collectOutputs(
  history: Record<string, { outputs?: Record<string, unknown> }> | undefined,
  promptId: string,
  baseUrl: string
): RunOutput[] {
  const out: RunOutput[] = []
  const seen = new Set<string>()
  const entry = history?.[promptId]
  if (!entry?.outputs) return out
  for (const [nodeId, nodeOut] of Object.entries(entry.outputs)) {
    for (const r of harvestFiles(nodeOut)) {
      const filename = String(r.filename ?? '')
      if (!filename) continue
      const subfolder = String(r.subfolder ?? '')
      const type = String(r.type ?? 'output')
      // 同一个文件既出现在 images 又出现在 animated 里是常态，去重按三者组合
      const key = `${type}/${subfolder}/${filename}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        kind: kindOfFile(filename),
        filename,
        subfolder,
        type,
        url: comfyViewUrl(baseUrl, filename, subfolder, type),
        nodeId
      })
    }
  }
  return out
}

export interface SubmitInput {
  episodeId: string
  episodeName: string
  templateName: string
  /** 模板里的 API 基线 */
  api: ApiWorkflow
  values: Record<string, string | number | boolean>
  /** 剧本台自己生成的 timeline（pack 导入失败或关闭时用它） */
  timeline: Record<string, unknown>
  packBlob?: Blob | null
  packFilename?: string
  config?: RunConfig | null
  /**
   * 只跑这几段（索引，0 起）。空/不传 = 全跑。
   *
   * 落点是时间线 JSON 上的 `runSelectEnabled` / `runSelection` —— 导演节点
   * 自己的「选择运行」开关，不是剧本台发明的字段。缓存槽仍按完整时间线的
   * 位置编号，所以未选中的段缓存不会被动。
   */
  onlySegments?: number[]
}

export const useRunStore = defineStore('run', () => {
  const configs = ref<RunConfig[]>([])
  const activeId = ref<string | null>(null)
  const episodeBind = ref<Record<string, string>>({})
  const jobs = ref<RunJob[]>([])
  const loaded = ref(false)
  const saving = ref(false)

  /** ComfyUI 探活结果，配置页顶部那盏灯 */
  const online = ref<boolean | null>(null)
  const onlineDetail = ref('')
  const stats = ref<ComfyStats | null>(null)
  const probing = ref(false)
  /** ComfyUI 能看见几张卡；连不上时为 null（此时不校验选卡范围，别误报） */
  const visibleCards = ref<number | null>(null)

  /** ws 只连一次，按 clientId 复用 */
  const clientId = ref<string>(`scriptstage-${uid('c')}`)
  let socket: WebSocket | null = null
  /** 断线重连的开关与状态 */
  let wantSocket = false
  let lastBase = ''
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectTries = 0
  /** 兜底轮询：ws 掉了对账还能把状态拉回来 */
  let watchTimer: ReturnType<typeof setInterval> | null = null

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  const active = computed(
    () => configs.value.find((c) => c.id === activeId.value) ?? configs.value[0] ?? null
  )

  const running = computed(() => jobs.value.filter((j) => j.status === 'running' || j.status === 'queued'))
  const hasActive = computed(() => running.value.length > 0)

  /* ------------------------------ 载入 ------------------------------ */

  /**
   * 正在进行的 load()。
   *
   * 为什么要它：全局浮窗、运行页、剧本台首页现在都可能同时触发 load()，
   * 而 `loaded` 要等整个读盘结束才置 true —— 三个调用会同时穿过那道检查，
   * 各自读一遍 kv，还会各自判一次"没有配置就新建"，最后写出两份空配置。
   * 让后到的调用直接等同一个 Promise 就够了。
   */
  let loading: Promise<void> | null = null

  async function load() {
    if (loaded.value) return
    if (loading) return loading
    loading = (async () => {
      configs.value = await kvGet<RunConfig[]>(KV_CONFIGS, [])
      const act = await kvGet<string | null>(KV_ACTIVE, null)
      activeId.value =
        act && configs.value.some((c) => c.id === act) ? act : (configs.value[0]?.id ?? null)
      episodeBind.value = await kvGet<Record<string, string>>(KV_EPISODE_BIND, {})
      jobs.value = await kvGet<RunJob[]>(KV_JOBS, [])
      // 存量任务里的 kind 是按旧规则（键名）判的，mp4 被记成了 image ⇒ 渲染成
      // `<img>` 一片黑。这里按扩展名就地纠正一次，老任务不用重跑也能播放。
      for (const j of jobs.value) {
        for (const o of j.outputs ?? []) {
          const k = kindOfFile(o.filename)
          if (k !== o.kind) o.kind = k
        }
      }
      if (!configs.value.length) {
        const c: RunConfig = { ...defaultRunConfig(), id: uid('runc') }
        configs.value = [c]
        activeId.value = c.id
        await flush()
      }
      loaded.value = true
      // 存量重名整理（历史上一口气攒过六个「e2e 双卡」）。只加序号，不动配置内容。
      tidyNames()
      // 从 kv 恢复的任务可能早就跑完或已经失联（典型是刷新过页面）
      if (activeJobs().length) {
        const base = activeJobs()[0].baseUrl
        if (base) ensureSocket(base)
        startWatch()
        void reconcile()
      }
    })()
    try {
      await loading
    } finally {
      loading = null
    }
  }

  async function flush() {
    saving.value = true
    try {
      await kvSet(KV_CONFIGS, configs.value)
      await kvSet(KV_ACTIVE, activeId.value)
      await kvSet(KV_EPISODE_BIND, episodeBind.value)
      await kvSet(KV_JOBS, jobs.value.slice(0, JOB_KEEP))
    } finally {
      saving.value = false
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void flush()
    }, 400)
  }

  /* ------------------------------ 配置 CRUD ------------------------------ */

  function select(id: string) {
    if (!configs.value.some((c) => c.id === id)) return
    activeId.value = id
    void flush()
  }

  function create(name: string, api: ApiWorkflow | null = null): RunConfig {
    const base = runConfigFromApi(api, defaultRunConfig())
    const c: RunConfig = {
      ...base,
      id: uid('runc'),
      // 同模板列表：左栏只靠名字区分，重名等于没名字。
      name: uniqueName(name || '未命名运行配置', configs.value.map((x) => x.name)),
      createdAt: now(),
      updatedAt: now()
    }
    configs.value = [...configs.value, c]
    activeId.value = c.id
    void flush()
    return c
  }

  function duplicate(id: string): RunConfig | null {
    const src = configs.value.find((c) => c.id === id)
    if (!src) return null
    const c: RunConfig = {
      // src 取自 configs.value（响应式代理），必须剥代理再拷，否则 DataCloneError
      ...deepClone(src),
      id: uid('runc'),
      name: uniqueName(`${src.name} 副本`, configs.value.map((x) => x.name)),
      createdAt: now(),
      updatedAt: now()
    }
    configs.value = [...configs.value, c]
    activeId.value = c.id
    void flush()
    return c
  }

  function remove(id: string) {
    configs.value = configs.value.filter((c) => c.id !== id)
    for (const [ep, cid] of Object.entries(episodeBind.value)) {
      if (cid === id) delete episodeBind.value[ep]
    }
    if (activeId.value === id) activeId.value = configs.value[0]?.id ?? null
    void flush()
  }

  function rename(id: string, name: string) {
    const c = configs.value.find((x) => x.id === id)
    if (!c) return
    c.name = name || c.name
    c.updatedAt = now()
    void flush()
  }

  /** 整理存量重名（历史遗留的六个「e2e 双卡」就是靠它收拾），返回改了几个 */
  function tidyNames(): number {
    const plan = dedupeBatch(configs.value)
    if (!plan.size) return 0
    const ts = now()
    for (const c of configs.value) {
      const next = plan.get(c.id)
      if (next) {
        c.name = next
        c.updatedAt = ts
      }
    }
    configs.value = [...configs.value]
    void flush()
    return plan.size
  }

  /** 改一个字段。表单项很多，逐个写方法不现实。 */
  function patch(id: string, changes: Partial<RunConfig>) {
    const c = configs.value.find((x) => x.id === id)
    if (!c) return
    Object.assign(c, changes, { updatedAt: now() })
    scheduleSave()
  }

  /** 用导入的工作流把配置刷成工作流里的真实值 */
  function syncFromApi(id: string, api: ApiWorkflow | null) {
    const c = configs.value.find((x) => x.id === id)
    if (!c) return
    Object.assign(c, runConfigFromApi(api, c), { updatedAt: now() })
    void flush()
  }

  function bindEpisode(episodeId: string, configId: string | null) {
    if (!configId) delete episodeBind.value[episodeId]
    else episodeBind.value[episodeId] = configId
    void flush()
  }

  function configForEpisode(episodeId: string): RunConfig | null {
    const cid = episodeBind.value[episodeId]
    if (!cid) return null
    return configs.value.find((c) => c.id === cid) ?? null
  }

  /* ------------------------------ 探活 ------------------------------ */

  async function probe(base = active.value?.baseUrl ?? '') {
    probing.value = true
    try {
      const res = await comfyPing(base)
      online.value = res.ok
      onlineDetail.value = res.detail
      stats.value = res.stats ?? null
      // 可见卡数：system_stats 里 devices 有几条，ComfyUI 就看得见几张（= --cuda-device）
      const devs = (res.stats as { devices?: unknown[] } | null | undefined)?.devices
      visibleCards.value = Array.isArray(devs) && devs.length ? devs.length : null
      return res.ok
    } finally {
      probing.value = false
    }
  }

  /* ------------------------------ WebSocket ------------------------------ */

  function log(job: RunJob | undefined, level: LogLine['level'], text: string) {
    if (!job) return
    job.logs.push({ t: now(), level, text })
    if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300)
  }

  /** 还活着的（未结束的）任务 */
  function activeJobs(): RunJob[] {
    return jobs.value.filter(
      (j) => j.status === 'running' || j.status === 'queued' || j.status === 'submitting'
    )
  }

  /**
   * 一条 ws 消息属于哪个任务。
   *
   * 标准事件（executing / progress / executed）带 prompt_id，直接对。
   * 导演节点的自定义进度事件**只有 node_id**，所以退化到 node_id；
   * 最后兜底：如果当前就一个活着的任务，那必然是它的。
   */
  function resolveJob(data: Record<string, unknown>): RunJob | undefined {
    const pid = String(data.prompt_id ?? '')
    if (pid) {
      const byPrompt = jobs.value.find((j) => j.promptId === pid)
      if (byPrompt) return byPrompt
    }
    const nodeId = String(data.node_id ?? data.node ?? '')
    if (nodeId) {
      const byNode = activeJobs().find((j) => j.directorNodeId && j.directorNodeId === nodeId)
      if (byNode) return byNode
    }
    const act = activeJobs()
    return act.length === 1 ? act[0] : undefined
  }

  function markEvent(job: RunJob | undefined) {
    if (job) job.lastEventAt = now()
  }

  /** 断线后退避重连：ComfyUI 重启、页面休眠都会把 ws 掐掉 */
  function scheduleReconnect() {
    if (!wantSocket || !lastBase) return
    if (reconnectTimer) return
    const delay = Math.min(30000, 1500 * 2 ** Math.min(5, reconnectTries))
    reconnectTries += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (wantSocket) ensureSocket(lastBase)
    }, delay)
  }

  function ensureSocket(baseUrl: string) {
    wantSocket = true
    lastBase = baseUrl
    if (socket && socket.readyState <= WebSocket.OPEN) return socket
    const url = comfyWsUrl(baseUrl, clientId.value)
    try {
      socket = new WebSocket(url)
    } catch (err) {
      onlineDetail.value = `WebSocket 建连失败：${err instanceof Error ? err.message : String(err)}`
      scheduleReconnect()
      return null
    }
    socket.onopen = () => {
      reconnectTries = 0
      online.value = true
      // 连上就对一次账：补上断线期间错过的完成/报错
      void reconcile()
    }
    socket.onmessage = (ev) => {
      let msg: { type?: string; data?: Record<string, unknown> }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      const data = msg.data ?? {}
      const job = resolveJob(data)
      markEvent(job)
      applyWsMessage(msg.type ?? '', data, job)
    }
    socket.onclose = () => {
      if (socket) socket = null
      scheduleReconnect()
    }
    socket.onerror = () => {
      // 不弹错：ComfyUI 没起时提交那一步已经会报，这里静默即可
    }
    return socket
  }

  /** ComfyUI 的进度事件字段在不同版本上名字略有出入，全部按可选读 */
  function applyWsMessage(type: string, data: Record<string, unknown>, job: RunJob | undefined) {
    if (type === 'execution_start') {
      if (job) {
        job.status = 'running'
        job.startedAt = now()
        log(job, 'info', '开始执行')
      }
      return
    }
    if (type === 'executing' && job) {
      const node = String(data.node ?? '')
      if (node) log(job, 'info', `执行节点 ${node}`)
      return
    }
    /**
     * 导演节点的自定义进度。
     *
     * 它不叫 progress 也不带 prompt_id —— 只认标准事件的话，导演跑起来
     * 进度条会一直是 0%，看起来就像卡死了，实际在正常出片。
     */
    if (type === DIRECTOR_PROGRESS_EVENT) {
      const patch = parseDirectorProgress(data)
      if (!job || !patch) return
      const p = job.progress
      // 4 段并发各报各的口径，按百分比单调合并（细节见 mergeProgress 注释）
      const merged = mergeProgress(p, patch)
      p.value = merged.value
      p.max = merged.max
      // 段号同理：并发下会来回跳，取推进到的最大段
      if (patch.segment) p.segment = Math.max(p.segment, patch.segment)
      p.segmentTotal = patch.segmentTotal || p.segmentTotal
      p.timelineSegment = patch.timelineSegment || p.timelineSegment
      p.phase = patch.phase || p.phase
      p.phaseLabel = patch.phaseLabel || p.phaseLabel
      p.framesLabel = patch.framesLabel || p.framesLabel
      if (patch.remainingSegments) {
        p.remainingSegments = p.remainingSegments
          ? Math.min(p.remainingSegments, patch.remainingSegments)
          : patch.remainingSegments
      }
      p.updatedAt = now()
      if (job.status === 'queued') {
        job.status = 'running'
        if (!job.startedAt) job.startedAt = now()
      }
      // 同一个阶段内的每一帧都上报，只在阶段/段变化时记一条，免得日志刷爆
      const key = `${patch.phase}|${patch.segment}|${patch.timelineSegment}`
      if (phaseKeys.get(job) !== key) {
        phaseKeys.set(job, key)
        const label = p.phaseLabel || p.phase || '进度'
        log(
          job,
          'info',
          `${label}${p.segment ? ` · 第 ${p.segment}/${p.segmentTotal || '?'} 段` : ''}${
            p.framesLabel ? ` · ${p.framesLabel}` : ''
          }`
        )
      }
      return
    }
    if (type === 'progress') {
      if (!job) return
      const p = job.progress
      p.value = Number(data.value ?? data.overall_value ?? p.value) || p.value
      p.max = Number(data.max ?? data.overall_max ?? p.max) || p.max
      p.segment = Number(data.segment ?? p.segment) || p.segment
      p.segmentTotal = Number(data.segment_total ?? p.segmentTotal) || p.segmentTotal
      p.timelineSegment = String(data.timeline_segment ?? p.timelineSegment)
      p.phase = String(data.phase ?? p.phase)
      p.phaseLabel = String(data.phase_label ?? p.phaseLabel)
      p.framesLabel = String(data.frames_label ?? p.framesLabel)
      p.remainingSegments = Number(data.remaining_segments ?? p.remainingSegments) || p.remainingSegments
      p.updatedAt = now()
      const label = p.phaseLabel || p.phase
      if (label) log(job, 'info', `${label}${p.segment ? ` · 第 ${p.segment}/${p.segmentTotal || '?'} 段` : ''}`)
      return
    }
    if (type === 'execution_error') {
      if (!job) return
      job.status = 'error'
      job.endedAt = now()
      job.error = String(data.exception_message ?? data.error ?? '节点执行出错')
      log(job, 'error', job.error)
      void flush()
      return
    }
    if (type === 'execution_interrupted' || type === 'interrupt') {
      if (!job) return
      job.status = 'interrupted'
      job.endedAt = now()
      log(job, 'warn', '已中断')
      void flush()
      return
    }
    if (type === 'executed' || type === 'execution_success') {
      if (!job) return
      void finish(job)
      return
    }
  }

  /** 收尾：拉 history 拿产物。executed 事件太早，history 才是权威。 */
  async function finish(job: RunJob) {
    if (job.status === 'done') return
    try {
      const res = await comfyHistory(job.baseUrl, job.promptId)
      const found = res.json?.[job.promptId]
      if (found) {
        job.outputs = collectOutputs(res.json, job.promptId, job.baseUrl)
        job.status = 'done'
        log(job, 'info', `完成，回收 ${job.outputs.length} 个产物`)
        // 跑完了才是"真正可用的缓存"：把绑定刷成这一份（提交时可能先绑了一条
        // 后来被中断的，promptId 与时间线要落到真正成功的那次上）
        void bindAfterDone(job)
      } else {
        // history 还没落盘（常见），稍后再试一次
        setTimeout(() => void finish(job), 1500)
        return
      }
    } catch (err) {
      job.error = err instanceof Error ? err.message : String(err)
      log(job, 'warn', `取回产物失败：${job.error}`)
      job.status = 'done'
    }
    job.endedAt = now()
    void flush()
  }

  /**
   * 任务跑完后，把绑定刷成这一次的时间线。
   *
   * 提交时已经绑过一次（那一刻只知道"要写进哪个目录"），但那次可能被中断；
   * 真正落盘的缓存属于**成功完成**的这一份时间线，段位也以它为准。
   */
  async function bindAfterDone(job: RunJob) {
    if (!job.episodeId || !job.directorNodeId) return
    try {
      const cacheBind = useCacheBindStore()
      await cacheBind.load()
      // 用户手动改绑到别的目录：那是明确意图，别抢
      const prev = cacheBind.forEpisode(job.episodeId)
      if (prev?.source === 'manual' && prev.workflowName !== job.workflowName) return
      const tl = await comfyPromptTimeline(job.baseUrl, job.promptId, job.directorNodeId)
      if (!tl) return
      cacheBind.autoBind(job.episodeId, {
        baseUrl: job.baseUrl,
        workflowName: job.workflowName ?? '',
        nodeId: job.directorNodeId,
        promptId: job.promptId,
        segmentTotal: timelineSegmentCount(tl),
        timeline: tl
      })
    } catch {
      // 刷绑定失败不影响任务本身：下一次提交/打开交付页还会再对齐一次
    }
  }

  /* ------------------------------ 兜底对账 ------------------------------ */

  /** ComfyUI 队列项形如 `[序号, prompt_id, prompt, extra, outputs]` */
  function extractQueueIds(q: unknown): string[] {
    const out: string[] = []
    const lists = q as { queue_running?: unknown[]; queue_pending?: unknown[] } | undefined
    for (const list of [lists?.queue_running, lists?.queue_pending]) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (Array.isArray(item) && item.length > 1 && typeof item[1] === 'string') {
          out.push(item[1])
        }
      }
    }
    return out
  }

  /**
   * 拿 ComfyUI 的 queue / history 校正本地任务状态。
   *
   * 为什么必须有这一步：ws 是"推"，断了就永远停在最后一眼。页面刷新、
   * ComfyUI 重启、笔记本睡一觉醒来，本地都会是一个"运行中 · 0%"的僵尸任务。
   * 对账是"拉"，只要 ComfyUI 还活着就能把状态拉回来。
   */
  async function reconcile() {
    const act = activeJobs()
    if (!act.length) return
    const base = act[0].baseUrl
    let queueOk = false
    let queueIds: string[] = []
    try {
      const q = await comfyQueue(base)
      queueOk = q.ok
      queueIds = extractQueueIds(q.json)
    } catch {
      queueOk = false
    }

    for (const job of act) {
      try {
        const res = await comfyHistory(job.baseUrl, job.promptId)
        if (res.json?.[job.promptId]) {
          await finish(job)
          continue
        }
      } catch {
        /* 转发抖动，下一轮再试 */
      }
      if (!queueOk) continue
      const inQueue = queueIds.includes(job.promptId)
      if (inQueue) continue
      // 两分钟没有任何消息、队列里也没有、history 里也没有 —— 它真的不在了
      const since = Math.max(job.lastEventAt || 0, job.submittedAt)
      if (now() - since < 120000) continue
      job.status = 'error'
      job.endedAt = now()
      job.error =
        'ComfyUI 上已经查不到这个任务了（进程重启、被清队列或执行中崩溃）。' +
        '它不会再自己跑完，需重新提交。'
      log(job, 'error', job.error)
      void flush()
    }
  }

  /** 有活跃任务时每 7 秒对一次账，没有就空转 */
  function startWatch() {
    if (watchTimer) return
    watchTimer = setInterval(() => {
      void reconcile()
    }, 7000)
  }

  function stopWatch() {
    if (watchTimer) {
      clearInterval(watchTimer)
      watchTimer = null
    }
  }

  /* ------------------------------ 提交 ------------------------------ */

  async function submit(input: SubmitInput): Promise<RunJob> {
    const cfg = input.config ?? active.value
    if (!cfg) throw new Error('没有运行配置')

    /**
     * 这一集的缓存目录：**绑定了就钉死**。
     *
     * 目录名要跟着"集"走，而不是跟着"集名"走。用户把剧集改名之后，若还按集名
     * 重新 slug，就会指向另一个目录 —— 对面磁盘上的缓存明明还在，交付页却会说
     * 这一集从没出过片。绑定是第一次生成时自动落下的（见 cacheBind.autoBind），
     * 这里把它当成唯一真相；用户主动改过自定义目录则尊重他。
     */
    const cacheBind = useCacheBindStore()
    await cacheBind.load()
    const bound = input.episodeId ? cacheBind.forEpisode(input.episodeId) : null
    const dirName = resolveWorkflowNameWithBound(cfg, input.episodeName, bound?.workflowName ?? '')
    const cfgEff: RunConfig = { ...cfg, workflowNameExact: dirName }

    const hasDirector = !!directorNodeId(input.api)
    const hasUpscale = Object.values(input.api).some(
      (n) => n?.class_type === 'MiniMaxH3LatentUpscaleModelOpt'
    )
    const problems = validateRunConfig(cfgEff, {
      hasApi: true,
      hasDirector,
      hasUpscaleNode: hasUpscale,
      episodeName: input.episodeName,
      visibleCards: visibleCards.value ?? undefined
    })
    if (problems.length) throw new Error(problems.join(' '))

    // 1) 模板（节点参数）→ 2) 运行配置（导演旋钮）。顺序不可颠倒
    const withTemplate = applyTemplateToApi(input.api, input.values)

    // 2.5) 时间线：优先用 ComfyUI 解出来的那份（参考图路径是它落盘的）
    let timeline = input.timeline
    if (cfgEff.usePackImport && input.packBlob) {
      const imported = await comfyImportPack(cfgEff.baseUrl, input.packBlob, input.packFilename || 'pack.zip')
      if (imported.timeline && typeof imported.timeline === 'object') {
        timeline = imported.timeline as Record<string, unknown>
      } else if (imported.missing?.length) {
        throw new Error(`pack 导入后缺素材：${imported.missing.join('、')}`)
      }
    }

    /**
     * 2.6) 「选择运行」：把勾选的段写进时间线。
     *
     * 必须在 pack 导入**之后**：import_pack 会用它自己解出来的 timeline 覆盖
     * 我们这份（并且把 runSelectEnabled 重置成 false），在导入前打标记等于白写。
     * 也必须在 `frames` 之前/之后都不影响总量 —— 这里刻意放在算帧数之前，
     * 但改的是选择开关而不是 segments，所以总帧数不变。
     */
    timeline = applyRunSelection(timeline, input.onlySegments ?? [])
    const onlySegments = Array.isArray(timeline.runSelection)
      ? (timeline.runSelection as number[])
      : []
    const segmentTotal = timelineSegmentCount(timeline)

    /**
     * 2.65) 「二采直出」：时间线里的 `secondSample` 是**一次性触发块** ——
     * 节点看到它就跳过一采，直接对已有缓存 latent 放大 + 重采样。
     *
     * 三档里只有 `direct` 需要它；另两档必须**显式清掉**：导入的包、绑定的
     * 时间线都可能带着上一次留下的这一块，不清就等于每次都偷偷跳过一采。
     */
    const stage = secondStageOf(cfgEff)
    timeline = applySecondSample(
      timeline,
      secondSampleFor(stage, onlySegments, segmentTotal)
    )

    const frames = Number((timeline as Record<string, unknown>)?.totalFrames ?? 0) || 0
    const runRes = applyRunConfigToApi(withTemplate.api, cfgEff, {
      episodeName: input.episodeName,
      timelineFrames: frames,
      seedOverride: cfgEff.randomSeed ? randomSeed() : undefined
    })

    const nodeId = directorNodeId(runRes.api)
    if (nodeId) {
      const inputs = runRes.api[nodeId].inputs ?? (runRes.api[nodeId].inputs = {})
      inputs.timeline_data = JSON.stringify(timeline)
    }

    /**
     * 2.7) 建视频节点：原生 `CreateVideo` 拿到导演节点的 uint8 帧会整数溢出，
     * 整片变成**负片**（段片段正常、合成完全对不上）。换成 H3 包自带的 U8 版
     * 才能逐位一致；探测不到这个节点就保持原样，不让提交直接失败。
     */
    let submitApi: ApiWorkflow = runRes.api
    let uint8Note = ''
    if (await comfyHasNodeType(cfgEff.baseUrl, UINT8_CREATE_VIDEO)) {
      const up = upgradeUint8CreateVideo(submitApi)
      submitApi = up.api
      if (up.upgraded) {
        uint8Note = `建视频用 ${UINT8_CREATE_VIDEO}（原生 CreateVideo 会把 uint8 帧写成负片）`
      }
    }

    // 3) 清缓存（换 TE kernel / 量化之后必须清，否则旧条件继续命中）
    if (cfgEff.clearCacheOnSubmit) {
      try {
        await comfyClearCache(cfgEff.baseUrl, {
          workflow_name: dirName,
          clear_all: false
        })
      } catch (err) {
        // 清缓存失败不该挡住出片：最坏是缓存没清，命中旧条目
        console.warn('清缓存失败', err)
      }
    }

    // 4) 提交
    ensureSocket(cfgEff.baseUrl)
    const res = await comfySubmitPrompt(cfgEff.baseUrl, {
      prompt: submitApi,
      client_id: clientId.value
    })
    if (!res.ok) {
      const errText =
        typeof res.json?.error === 'string'
          ? res.json.error
          : res.text || `HTTP ${res.status}`
      throw new Error(`ComfyUI 拒绝了这个任务：${errText}`)
    }
    const promptId = String(res.json?.prompt_id ?? '')
    if (!promptId) throw new Error('ComfyUI 没有返回 prompt_id')

    const job: RunJob = {
      id: uid('job'),
      promptId,
      episodeId: input.episodeId,
      episodeName: input.episodeName,
      templateName: input.templateName,
      configName: cfgEff.name,
      baseUrl: cfgEff.baseUrl,
      workflowName: runRes.workflowName,
      status: 'queued',
      submittedAt: now(),
      startedAt: null,
      endedAt: null,
      progress: emptyProgress(),
      logs: [
        { t: now(), level: 'info', text: `已提交 · 模板「${input.templateName}」· 配置「${cfg.name}」` },
        {
          t: now(),
          level: 'info',
          text: `参数命中 ${withTemplate.applied + runRes.applied} 项，缓存目录 ${runRes.workflowName}`
        }
      ],
      outputs: [],
      error: '',
      applied: withTemplate.applied + runRes.applied,
      skipped: [...withTemplate.skipped, ...runRes.skipped],
      directorNodeId: nodeId ?? '',
      onlySegments,
      segmentTotal,
      lastEventAt: now()
    }
    if (uint8Note) log(job, 'info', uint8Note)
    if (onlySegments.length) {
      log(job, 'info', `只跑选中的 ${onlySegments.length}/${segmentTotal} 段（其余段的缓存不动）`)
    }
    if (job.skipped.length) {
      log(job, 'warn', `${job.skipped.length} 个参数没找到落点：${job.skipped.slice(0, 6).join('、')}`)
    }
    /**
     * 4.5) **生成即绑定**。
     *
     * 提交成功这一刻，"这一集的产物落在哪"已经确定了：地址、目录、节点、那份
     * 时间线全在手上。顺手记下来，从此预览/导出都不需要用户再选一次目录；
     * 用户给剧集改名也不影响（目录名钉在这条记录里）。
     */
    if (input.episodeId && nodeId) {
      cacheBind.autoBind(input.episodeId, {
        baseUrl: cfgEff.baseUrl,
        workflowName: runRes.workflowName,
        nodeId,
        promptId,
        segmentTotal,
        timeline
      })
    }
    jobs.value = [job, ...jobs.value].slice(0, JOB_KEEP)
    startWatch()
    void flush()
    return job
  }

  /**
   * 沿用某次提交的**配方**重跑，可按段。
   *
   * 为什么要有这条路（而不是永远走 submit）：产物页看到的是缓存，缓存可能比
   * 本地段活得更久 —— 段被清空/重排之后，本地已经编不出当时那份导演包了。
   * 这时候唯一可靠的输入是 history 里那份 prompt 原文（模型/步数/种子/参考图
   * 路径/时间线全在里面），拿它改「选择运行」再提交，才是真的"就重跑这段"。
   *
   * 不做配置校验，也不套模板：这份 prompt 已经是当时提交的成品，再套一遍
   * 等于拿今天的配置去改历史的参数，跑出来的东西和缓存对不上。
   */
  async function resubmit(
    source: RunJob,
    opts: {
      onlySegments?: number[]
      secondOnly?: boolean
      /**
       * 这一次要改的导演节点输入（seed / steps / cfg / pipeline_cards…）。
       *
       * 交付页想在"沿用配方"时也能调参数 —— 但绝不能拿今天的整份配置去覆盖
       * 历史的 prompt（模型、参考图、时间线都会跟着变）。所以只允许点名改几个键，
       * 其余一律照旧。
       */
      inputs?: Record<string, unknown>
      /**
       * 二采那一套（阶段 + 放大分辨率 + 两个 sigmas）。
       *
       * 这几样**不在导演节点上**：分辨率在放大节点、sigmas 在 ManualSigmas，
       * 所以走不了 `inputs`（那个只会写导演节点的、且只写本来就有的键）。
       * 传整份配置进来，由本函数按图去改对应节点。
       */
      secondPass?: RunConfig
    } = {}
  ): Promise<RunJob> {
    const api = await comfyPromptApi(source.baseUrl, source.promptId)
    if (!api) {
      throw new Error(
        'ComfyUI 的 history 里已经没有这次提交的原始请求了（重启或被清理过），没法沿用它的配方。' +
          '请到「运行」用当前段重新提交一次。'
      )
    }
    const nodeId =
      source.directorNodeId || directorNodeId(api as unknown as ApiWorkflow) || ''
    if (!nodeId) throw new Error('这份提交里没有导演节点，不能按段重跑')
    let patched = patchPromptTimeline(api, nodeId, opts.onlySegments ?? [])
    // 「二采只出」是节点上的一个开关，不是时间线字段：沿用配方时也得能改它
    if (opts.secondOnly !== undefined) {
      patched = patchPromptInputs(patched, nodeId, { second_only: opts.secondOnly })
    }
    // 参数只写"这份 prompt 里本来就有"的键：旧版本节点可能没有某个输入，
    // 凭空加一个等于给节点塞未知字段，行为未定义。
    let appliedParams: Record<string, unknown> = {}
    if (opts.inputs) {
      const exist = (patched[nodeId] as { inputs?: Record<string, unknown> }).inputs ?? {}
      const safe: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(opts.inputs)) {
        if (k in exist && v !== undefined) safe[k] = v
      }
      if (Object.keys(safe).length) {
        patched = patchPromptInputs(patched, nodeId, safe)
        appliedParams = safe
      }
    }
    const inputs = (patched[nodeId] as { inputs?: Record<string, unknown> }).inputs ?? {}
    const tl = JSON.parse(String(inputs.timeline_data ?? '{}')) as Record<string, unknown>
    const onlySegments = Array.isArray(tl.runSelection) ? (tl.runSelection as number[]) : []
    const segmentTotal = timelineSegmentCount(tl)

    /**
     * 二采：沿用配方时同样要能选三档、改分辨率、改 sigmas。
     *
     * 顺序有讲究 —— 先把 `second_only`（导演节点）写掉，再改放大节点与
     * ManualSigmas，最后把 `secondSample` 打进时间线（它会被写回 timeline_data）。
     */
    if (opts.secondPass) {
      const sp = opts.secondPass
      const stage = secondStageOf(sp)
      const graph = patched as unknown as Record<
        string,
        { class_type?: string; inputs?: Record<string, unknown> }
      >
      if (opts.secondOnly === undefined) {
        patched = patchPromptInputs(patched, nodeId, { second_only: stage === 'pair' })
      }
      if (stage !== 'off') {
        applyUpscaleToApi(
          graph,
          {
            mode: sp.secondUpscaleMode,
            megapixels: sp.secondMegapixels,
            p: sp.secondPTier,
            scale: sp.secondScale,
            width: sp.secondWidth,
            height: sp.secondHeight,
            align: sp.secondAlign
          },
          nodeId
        )
      }
      applySigmasText(graph, nodeId, 'sigmas', sp.sigmas)
      applySigmasText(graph, nodeId, 'second_sigmas', sp.secondSigmas)
      const nextTl = applySecondSample(tl, secondSampleFor(stage, onlySegments, segmentTotal))
      patched = patchPromptInputs(patched, nodeId, { timeline_data: JSON.stringify(nextTl) })
    }

    /**
     * 沿用配方也要写回**这一集自己的目录**。
     *
     * 源 prompt 里的 workflow_name 是那次提交的目录，本来通常就等于绑定目录；
     * 但用户手动改绑过的话就不一样了 —— 这时候还按源 prompt 写，等于把缓存
     * 灌进另一个目录，回来又说"这些段没成片"。
     */
    const cacheBind = useCacheBindStore()
    await cacheBind.load()
    const bound = source.episodeId ? cacheBind.forEpisode(source.episodeId) : null
    const dirName = bound?.workflowName
      ? bound.workflowName
      : String(inputs.workflow_name ?? '')
    if (bound?.workflowName && inputs.workflow_name !== bound.workflowName) {
      patched = patchPromptInputs(patched, nodeId, { workflow_name: bound.workflowName })
    }

    // 同一处负片修复：老 prompt 里写的是原生 `CreateVideo`，沿用配方重跑
    // 会再产出一条负片。这里按节点是否存在再换一次（幂等）。
    if (await comfyHasNodeType(source.baseUrl, UINT8_CREATE_VIDEO)) {
      patched = upgradeUint8CreateVideo(patched as unknown as ApiWorkflow)
        .api as unknown as Record<string, unknown>
    }

    ensureSocket(source.baseUrl)
    const res = await comfySubmitPrompt(source.baseUrl, {
      prompt: patched,
      client_id: clientId.value
    })
    if (!res.ok) {
      const errText =
        typeof res.json?.error === 'string' ? res.json.error : res.text || `HTTP ${res.status}`
      throw new Error(`ComfyUI 拒绝了这个任务：${errText}`)
    }
    const promptId = String(res.json?.prompt_id ?? '')
    if (!promptId) throw new Error('ComfyUI 没有返回 prompt_id')

    const job: RunJob = {
      id: uid('job'),
      promptId,
      episodeId: source.episodeId,
      episodeName: source.episodeName,
      templateName: source.templateName,
      configName: source.configName,
      baseUrl: source.baseUrl,
      workflowName: source.workflowName,
      status: 'queued',
      submittedAt: now(),
      startedAt: null,
      endedAt: null,
      progress: emptyProgress(),
      logs: [
        { t: now(), level: 'info', text: `沿用 ${source.promptId.slice(0, 8)} 的配方重跑` },
        {
          t: now(),
          level: 'info',
          text: onlySegments.length
            ? `只跑选中的 ${onlySegments.length}/${segmentTotal} 段（其余段的缓存不动）`
            : `全部 ${segmentTotal} 段`
        },
        ...(Object.keys(appliedParams).length
          ? [
              {
                t: now(),
                level: 'info' as const,
                text: `本次改参数：${Object.entries(appliedParams)
                  .map(([k, v]) => `${k}=${String(v)}`)
                  .join(' · ')}`
              }
            ]
          : [])
      ],
      outputs: [],
      error: '',
      applied: 0,
      skipped: [],
      directorNodeId: nodeId,
      onlySegments,
      segmentTotal,
      lastEventAt: now()
    }
    // 重跑同样是一次生成：目录/时间线可能比上次更准（例如段被改过），跟着更新
    if (source.episodeId) {
      cacheBind.autoBind(source.episodeId, {
        baseUrl: source.baseUrl,
        workflowName: dirName,
        nodeId,
        promptId,
        segmentTotal,
        timeline: tl
      })
    }
    jobs.value = [job, ...jobs.value].slice(0, JOB_KEEP)
    startWatch()
    void flush()
    return job
  }

  /**
   * 只读：取某次提交里导演节点的 inputs。
   *
   * 产物页要拿它把「二采只出」开关初始化成**那次提交真实的值** —— 沿用配方
   * 却把开关盖成今天配置里的值，等于悄悄改了这次重跑的口径。
   */
  async function sourceInputs(source: RunJob): Promise<Record<string, unknown>> {
    const api = await comfyPromptApi(source.baseUrl, source.promptId)
    if (!api) return {}
    const nodeId =
      source.directorNodeId || directorNodeId(api as unknown as ApiWorkflow) || ''
    const inputs = (api[nodeId] as { inputs?: Record<string, unknown> } | undefined)?.inputs
    return inputs ?? {}
  }

  async function interrupt(jobId: string) {
    const job = jobs.value.find((j) => j.id === jobId)
    if (!job) return
    await comfyInterrupt(job.baseUrl)
    job.status = 'interrupted'
    job.endedAt = now()
    log(job, 'warn', '已请求中断')
    void flush()
  }

  async function refresh(jobId: string) {
    const job = jobs.value.find((j) => j.id === jobId)
    if (!job) return
    const res = await comfyHistory(job.baseUrl, job.promptId)
    if (res.json?.[job.promptId]) {
      job.outputs = collectOutputs(res.json, job.promptId, job.baseUrl)
      job.status = 'done'
      job.endedAt = now()
      log(job, 'info', `重新取回 ${job.outputs.length} 个产物`)
      void flush()
    }
  }

  function clearFinished() {
    jobs.value = jobs.value.filter((j) => j.status === 'running' || j.status === 'queued')
    void flush()
  }

  function disconnect() {
    stopWatch()
    wantSocket = false
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (socket) {
      try {
        socket.close()
      } catch {
        /* 已经关了 */
      }
      socket = null
    }
  }

  return {
    configs,
    activeId,
    active,
    episodeBind,
    jobs,
    running,
    hasActive,
    loaded,
    saving,
    online,
    onlineDetail,
    stats,
    visibleCards,
    probing,
    clientId,
    load,
    flush,
    select,
    create,
    duplicate,
    remove,
    rename,
    tidyNames,
    patch,
    syncFromApi,
    bindEpisode,
    configForEpisode,
    probe,
    submit,
    resubmit,
    sourceInputs,
    interrupt,
    refresh,
    clearFinished,
    connect: ensureSocket,
    reconnect: reconcile,
    startWatch,
    stopWatch,
    disconnect
  }
})
