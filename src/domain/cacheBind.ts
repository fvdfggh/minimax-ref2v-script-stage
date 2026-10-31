/**
 * 远程缓存绑定：把「这一集」指到 ComfyUI 上的某个缓存目录。
 *
 * 为什么需要绑定，而不是"永远跟着最近一次提交走"：
 *
 *   分段缓存落在 `output/minimax_director_opt_cache/<workflow_name>/node_<id>/`，
 *   而剧本台原来只能从**本机的运行任务列表**（`run.jobs`）里猜这个目录。
 *   一旦换浏览器、清过任务、或者 ComfyUI 在另一台机器上跑过，列表是空的 ——
 *   交付页就变成"这一集没有任何产物"，可缓存其实好好躺在对面磁盘上。
 *
 * 所以绑定是显式的：(集 → ComfyUI 地址 + 缓存目录 + 节点 id + 那次的时间线)。
 * 时间线必须一起存：节点是按 timeline 里的**位置**找缓存槽的，光知道目录名
 * 探不出第 3 段是谁。
 *
 * 候选从哪来：ComfyUI 的 `/history` 里每一份 prompt 都带着导演节点的
 * `workflow_name` 与 `timeline_data`，这就是"对面真正用过的缓存目录"的事实来源。
 * 不需要新端点、也不需要访问对面的文件系统 —— 远程部署一样能用。
 */
import { directorNodeId, isDirectorClass } from './run'
import { timelineSegmentCount } from './segmentOps'
import type { ApiWorkflow } from './workflow'

/** 那次提交在 ComfyUI 上的结局（决定这个目录的缓存可不可信） */
export type RemoteCacheStatus = 'success' | 'error' | 'unknown'

/** 扫出来的一条"对面用过的缓存目录" */
export interface RemoteCacheCandidate {
  /** 贡献了时间线的那次提交 */
  promptId: string
  /** 导演节点在图里的 id（`segment_clip` / `segment_export_status` 都要它） */
  nodeId: string
  /** 缓存目录名（导演节点的 hidden widget `workflow_name`） */
  workflowName: string
  /** 那段时间线里有几段 */
  segmentTotal: number
  status: RemoteCacheStatus
  /** 那次提交的开始时间（ms），0 = 历史里没带 */
  at: number
  /** 那次提交产出的文件条目数（>0 说明真出过片） */
  outputCount: number
  /** 提交时那份时间线（对象形式），探测/预览都靠它对齐段位 */
  timeline: Record<string, unknown> | null
}

/** 集 ↔ 远程缓存的绑定关系 */
export interface CacheBinding {
  episodeId: string
  label: string
  baseUrl: string
  workflowName: string
  nodeId: string
  /** 绑定时引用的那次提交（事后追查"这时间线哪来的"） */
  promptId: string
  segmentTotal: number
  /** 提交时那份时间线；没有它就只能显示绑定，探不了段 */
  timeline: Record<string, unknown> | null
  boundAt: number
  /**
   * 这条绑定怎么来的：
   *
   *   · `auto`   —— 生成成功时自动落的（默认路径，用户不用管）；
   *   · `manual` —— 用户在缓存弹窗里**主动改绑**过。改绑意味着他明确要换目录，
   *                 之后的自动绑定不能把它悄悄抢走，否则"我改完又变回去"。
   */
  source?: 'auto' | 'manual'
}

/** history 条目的最小形状（只声明用到的字段，避免把 ComfyUI 的类型抄一遍） */
export interface HistoryLikeEntry {
  prompt?: unknown
  outputs?: Record<string, unknown>
  status?: Record<string, unknown>
}

export function normalizeBaseUrl(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '')
}

/**
 * 从 history 条目里取"这次提交什么时候跑的"。
 *
 * ComfyUI 顶层没有时间戳，时间藏在 `status.messages[][1].timestamp`（毫秒）。
 * 取所有消息里最大的那个 = 结束时间，比开始时间更能代表"这份缓存的年龄"。
 */
function entryTime(entry: HistoryLikeEntry): number {
  const messages = entry.status?.messages
  if (!Array.isArray(messages)) return 0
  let best = 0
  for (const m of messages) {
    if (!Array.isArray(m)) continue
    const payload = m[1] as Record<string, unknown> | undefined
    const t = Number(payload?.timestamp ?? 0)
    if (Number.isFinite(t) && t > best) best = t
  }
  return best
}

function entryStatus(entry: HistoryLikeEntry): RemoteCacheStatus {
  const raw = entry.status?.status_str
  if (raw === 'success') return 'success'
  if (raw === 'error') return 'error'
  return 'unknown'
}

/** `timeline_data` 可能是字符串（正常提交）也可能是对象（部分自定义客户端） */
function parseTimeline(inputs: Record<string, unknown>): Record<string, unknown> | null {
  const raw = inputs.timeline_data
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return null
    }
  }
  return null
}

/** 这份 prompt 里的导演节点（图是任意来源的，所以不能假设节点 id） */
function directorNodeOf(api: unknown): { nodeId: string; inputs: Record<string, unknown> } | null {
  if (!api || typeof api !== 'object' || Array.isArray(api)) return null
  const graph = api as Record<string, unknown>
  const nodeId = directorNodeId(graph as ApiWorkflow)
  if (!nodeId) return null
  const node = graph[nodeId] as { class_type?: unknown; inputs?: Record<string, unknown> } | undefined
  if (!node || !isDirectorClass(node.class_type)) return null
  return { nodeId, inputs: node.inputs ?? {} }
}

/**
 * 把一整份 `/history` 提炼成"对面用过的缓存目录"列表。
 *
 * 去重按 `目录 + 节点`：同一个目录会被跑很多次，但缓存只有一份，用户要选的是
 * **目录**而不是某一次提交。同组里优先挑成功的那次（它的时间线才对应真正
 * 落盘的缓存），都失败才退回最新的一次 —— 失败的任务也可能留下一采缓存，
 * 把它藏起来反而让用户以为"对面从来没跑过"。
 */
export function collectRemoteCaches(
  history: Record<string, HistoryLikeEntry> | null | undefined
): RemoteCacheCandidate[] {
  if (!history || typeof history !== 'object') return []
  const collected: RemoteCacheCandidate[] = []

  for (const [promptId, entry] of Object.entries(history)) {
    if (!entry || typeof entry !== 'object') continue
    // prompt 形状：[序号, prompt_id, api, extra, outputs]
    const api = Array.isArray(entry.prompt) ? (entry.prompt as unknown[])[2] : null
    const dir = directorNodeOf(api)
    if (!dir) continue
    const timeline = parseTimeline(dir.inputs)
    const rawName = dir.inputs.workflow_name
    collected.push({
      promptId,
      nodeId: dir.nodeId,
      workflowName: typeof rawName === 'string' ? rawName.trim() : '',
      segmentTotal: timelineSegmentCount(timeline),
      status: entryStatus(entry),
      at: entryTime(entry),
      outputCount: entry.outputs ? Object.keys(entry.outputs).length : 0,
      timeline
    })
  }

  const rank = (c: RemoteCacheCandidate): number =>
    c.status === 'success' ? 2 : c.status === 'unknown' ? 1 : 0

  const byDir = new Map<string, RemoteCacheCandidate>()
  for (const c of collected) {
    const key = `${c.workflowName}|${c.nodeId}`
    const prev = byDir.get(key)
    if (!prev) {
      byDir.set(key, c)
      continue
    }
    const better =
      rank(c) > rank(prev) || (rank(c) === rank(prev) && (c.at || 0) > (prev.at || 0))
    if (better) byDir.set(key, c)
  }

  return [...byDir.values()].sort(
    (a, b) => rank(b) - rank(a) || (b.at || 0) - (a.at || 0)
  )
}

/** 目录名的显示形态：空串是节点自己的默认目录，别显示成空白 */
export function cacheDirLabel(workflowName: string): string {
  return workflowName || '默认目录'
}

export function candidateLabel(c: RemoteCacheCandidate): string {
  return `${cacheDirLabel(c.workflowName)} · ${c.segmentTotal || 0} 段`
}

/** 候选 → 绑定记录 */
export function bindingFromCandidate(
  c: RemoteCacheCandidate,
  episodeId: string,
  baseUrl: string,
  at = Date.now(),
  source: 'auto' | 'manual' = 'manual'
): CacheBinding {
  return {
    episodeId,
    label: candidateLabel(c),
    baseUrl: normalizeBaseUrl(baseUrl),
    workflowName: c.workflowName,
    nodeId: c.nodeId,
    promptId: c.promptId,
    segmentTotal: c.segmentTotal,
    timeline: c.timeline,
    boundAt: at,
    source
  }
}

/** 一次提交里"产物落在哪"的全部事实 —— 生成成功时直接拿它落绑定 */
export interface SubmitBindingInput {
  baseUrl: string
  workflowName: string
  nodeId: string
  promptId: string
  segmentTotal: number
  timeline: Record<string, unknown> | null
}

/**
 * 提交成功 → 绑定记录。
 *
 * 绑定是**生成的副产物**，不是一道选择题：这次提交把产物写进了
 * `<baseUrl>` 的 `<workflowName>` 目录，那这一集的产物就在那儿 ——
 * 以后刷新页面、换浏览器、换台电脑，照着这条记录就能预览。
 */
export function bindingFromSubmit(
  input: SubmitBindingInput,
  episodeId: string,
  at = Date.now()
): CacheBinding {
  const dir = String(input.workflowName ?? '').trim()
  return {
    episodeId,
    label: `${cacheDirLabel(dir)} · ${input.segmentTotal || 0} 段`,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    workflowName: dir,
    nodeId: input.nodeId,
    promptId: input.promptId,
    segmentTotal: input.segmentTotal || 0,
    timeline: input.timeline,
    boundAt: at,
    source: 'auto'
  }
}

/**
 * 绑定能不能真的探出产物。
 *
 * 三样缺一不可：地址、导演节点 id、时间线。少了时间线就只能显示"绑到哪个目录"，
 * 段位对不上 —— 那种情况下宁可在 UI 上直说，也不要拿空白播放器糊弄。
 */
export function bindingUsable(b: CacheBinding | null | undefined): b is CacheBinding {
  return !!b && !!normalizeBaseUrl(b.baseUrl) && !!b.nodeId && !!b.timeline
}

/** 一句话说清当前绑定（页头 chip 与弹窗都用它） */
export function bindingSummary(b: CacheBinding | null | undefined): string {
  if (!b) return '待生成'
  return `${cacheDirLabel(b.workflowName)} · ${b.segmentTotal || 0} 段`
}

/** 这条绑定怎么来的（弹窗里给个出处，省得用户以为要自己绑） */
export function bindingOriginText(b: CacheBinding | null | undefined): string {
  if (!b) return '这一集还没生成过，第一次生成后会自动记住目录'
  return b.source === 'manual' ? '手动改绑的目录' : '生成时自动绑定'
}
