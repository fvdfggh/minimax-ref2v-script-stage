/**
 * 导演台（ComfyMiniMaxH3DirectorOpt）的"全功能"描述。
 *
 * 分两半：
 *   1. **参数**：节点的 38 个输入里哪些是能当旋钮配的（哪些是连线口、分组标题）。
 *      运行配置页据此渲染，不再手工挑一批 —— 手工挑的下场就是"导演台有、
 *      剧本台没有"，而用户根本分不清是没做还是坏了。
 *   2. **动作**：节点在 ComfyUI 界面上那些按钮背后其实是 HTTP 端点
 *      （`/minimax/director_opt/...`）。剧本台把它们收进来，就不用为了按一个
 *      按钮切回 ComfyUI。
 *
 * 全部走纯数据描述 + 纯函数，**不 import 任何节点代码**（节点包不能从前端引）。
 */

export const DIRECTOR_ROUTE_PREFIX = '/minimax/director_opt'

/* ------------------------------------------------------------------ *
 * 参数规格
 * ------------------------------------------------------------------ */

/** 这些类型接的是别的节点的输出（或只是分组标题），不能当旋钮配 */
const LINK_TYPES = new Set([
  'MODEL',
  'VAE',
  'CLIP',
  'SIGMAS',
  'CONDITIONING',
  'LATENT',
  'IMAGE',
  'AUDIO',
  'BDGROUP',
  'MMX_DIR_GROUP',
  'T8_MOSS_TRANSCRIBE_MODEL',
  'LATENT_UPSCALE_MODEL',
  'ASR_MODEL'
])

export type DirectorInputType = 'INT' | 'FLOAT' | 'STRING' | 'BOOLEAN' | 'COMBO' | 'LINK'

export interface DirectorInputSpec {
  name: string
  type: DirectorInputType
  bucket: 'required' | 'optional'
  /** COMBO 的候选（节点按当前可见卡/模型实时生成，必须现取不能写死） */
  options?: string[]
  default?: unknown
  min?: number
  max?: number
  step?: number
  multiline?: boolean
  /** 该输入的中文说明（object_info 的 tooltip），没有就是空的 */
  tooltip?: string
}

/**
 * 解析 `/object_info/<导演节点>`。
 *
 * object_info 的形状是 `{ <nodeType>: { input: { required: {..}, optional: {..} },
 * input_order: {...} } }`，每个输入是 `[type|options, opts]`。
 */
export function parseDirectorSpec(objectInfo: unknown): DirectorInputSpec[] {
  const root = (objectInfo ?? {}) as Record<string, unknown>
  const nodeType = Object.keys(root)[0]
  const node = (root[nodeType] ?? {}) as Record<string, unknown>
  const input = (node.input ?? {}) as Record<string, Record<string, unknown>>
  const out: DirectorInputSpec[] = []

  for (const bucket of ['required', 'optional'] as const) {
    const items = input[bucket] ?? {}
    for (const [name, raw] of Object.entries(items)) {
      const entry = raw as unknown
      if (!Array.isArray(entry) || entry.length === 0) continue
      const head = entry[0]
      const opts = (entry[1] ?? {}) as Record<string, unknown>
      const forceInput = opts.forceInput === true

      let type: DirectorInputType
      let options: string[] | undefined
      if (Array.isArray(head)) {
        type = 'COMBO'
        options = head.map((o) => String(o))
      } else if (typeof head === 'string' && !LINK_TYPES.has(head) && !forceInput) {
        type = head as DirectorInputType
      } else {
        type = 'LINK'
      }

      out.push({
        name,
        type,
        bucket,
        options,
        default: opts.default,
        min: typeof opts.min === 'number' ? opts.min : undefined,
        max: typeof opts.max === 'number' ? opts.max : undefined,
        step: typeof opts.step === 'number' ? opts.step : undefined,
        multiline: opts.multiline === true,
        tooltip: typeof opts.tooltip === 'string' ? opts.tooltip : ''
      })
    }
  }
  return out
}

/** 连线口不配：它们是图上的线，不是旋钮 */
export function isConfigurable(spec: DirectorInputSpec): boolean {
  return spec.type !== 'LINK'
}

/**
 * 剧本台已经有一等公民字段的那些输入 —— extras 不能再碰，
 * 否则两处写同一个键，谁后写谁生效，用户改了没反应还查不出原因。
 */
export const OWNED_DIRECTOR_KEYS = new Set([
  'task_type',
  'cfg',
  'seed',
  'steps',
  'sampler',
  'scheduler',
  'shift_video',
  'shift_audio',
  'frame_rate',
  'width',
  'height',
  'ref_max_size',
  'total_frames',
  'run_model',
  'use_sigmas',
  'second_run_model',
  'second_seed',
  'second_only',
  'pipeline_cards',
  'pipeline_split',
  // workflow_name 由"缓存分集"那一栏专门管（按集分目录），不能让 extras 覆盖
  'workflow_name'
])

/* ------------------------------------------------------------------ *
 * 动作
 * ------------------------------------------------------------------ */

export type ActionFieldType = 'text' | 'int' | 'number' | 'bool' | 'combo'

export interface DirectorActionField {
  name: string
  label: string
  type: ActionFieldType
  options?: string[]
  default?: string | number | boolean
  hint?: string
}

export interface DirectorAction {
  id: string
  label: string
  method: 'GET' | 'POST'
  /** 去掉前缀的那一段，前缀统一拼 */
  path: string
  /** 每次调用都会自动带上的上下文字段 */
  auto?: Array<'node_id' | 'workflow_name' | 'timeline_data'>
  fields: DirectorActionField[]
  hint: string
  /** 危险动作：会删已经渲好的东西 */
  danger?: boolean
}

/**
 * 导演台的全部端点。
 *
 * 字段是从节点源码里逐个挖出来的（`routes_segments.py` / `routes_asr.py` /
 * `routes_media.py` 里各 handler 真正读的 request 键），不是猜的。
 * 上传类（upload_chunk / *_reference_audio）走 multipart，剧本台已有 pack
 * 导入覆盖素材上载，这里不重复实现。
 */
export const DIRECTOR_ACTIONS: DirectorAction[] = [
  {
    id: 'clear_cache',
    label: '清缓存',
    method: 'POST',
    path: '/clear_cache',
    auto: ['node_id', 'workflow_name'],
    fields: [
      {
        name: 'clear_all',
        label: '连已渲好的段一起删',
        type: 'bool',
        default: false,
        hint: '默认只清中间态（条件/暂存），已渲的段保留'
      }
    ],
    hint: '清空该节点的缓存目录。换模型/量化后必清一次。',
    danger: true
  },
  {
    id: 'segment_export',
    label: '导出选中段',
    method: 'POST',
    path: '/segment_export',
    auto: ['node_id', 'workflow_name', 'timeline_data'],
    fields: [
      { name: 'indices', label: '段序号（0 起，逗号分隔）', type: 'text', default: '' },
      { name: 'seg_ids', label: '段 id（seg01，逗号分隔）', type: 'text', default: '' },
      {
        name: 'mode',
        label: '模式',
        type: 'combo',
        options: ['', 'frames', 'video', 'audio'],
        default: ''
      },
      { name: 'source', label: '来源', type: 'text', default: '' }
    ],
    hint: '把已渲好的段导出成文件。indices 与 seg_ids 给一个即可。'
  },
  {
    id: 'segment_export_status',
    label: '查导出进度',
    method: 'POST',
    path: '/segment_export_status',
    auto: ['node_id', 'workflow_name', 'timeline_data'],
    fields: [{ name: 'source', label: '来源', type: 'text', default: '' }],
    hint: '轮询导出任务的状态。'
  },
  {
    id: 'second_sample_status',
    label: '查二采进度',
    method: 'POST',
    path: '/second_sample_status',
    auto: ['node_id', 'workflow_name', 'timeline_data'],
    fields: [],
    hint: '二级采样的进度。'
  },
  {
    id: 'align_to_next_status',
    label: '对齐到下一段',
    method: 'POST',
    path: '/align_to_next_status',
    auto: ['node_id', 'workflow_name', 'timeline_data'],
    fields: [],
    hint: '段接缝对齐（锥形重绘的衔接）。'
  },
  {
    id: 'remove_segment_slot',
    label: '删除段槽',
    method: 'POST',
    path: '/remove_segment_slot',
    auto: ['node_id', 'workflow_name'],
    fields: [
      { name: 'index', label: '段序号（0 起）', type: 'int', default: 0 },
      { name: 'seg_ids', label: '段 id（逗号分隔）', type: 'text', default: '' }
    ],
    hint: '删掉时间线上的一个段槽。',
    danger: true
  },
  {
    id: 'audio_extract',
    label: '提取音轨',
    method: 'POST',
    path: '/audio_extract',
    auto: ['node_id', 'workflow_name', 'timeline_data'],
    fields: [
      { name: 'indices', label: '段序号（0 起，逗号分隔）', type: 'text', default: '' },
      { name: 'source', label: '来源', type: 'text', default: '' }
    ],
    hint: '从参考视频里抽音轨，供"保留音频"的段复用。'
  },
  {
    id: 'audio_extract_status',
    label: '查提取进度',
    method: 'POST',
    path: '/audio_extract_status',
    auto: ['node_id', 'workflow_name', 'timeline_data'],
    fields: [{ name: 'source', label: '来源', type: 'text', default: '' }],
    hint: '音轨提取的进度。'
  },
  {
    id: 'audio_extract_list',
    label: '音轨列表',
    method: 'POST',
    path: '/audio_extract_list',
    auto: ['node_id', 'workflow_name', 'timeline_data'],
    fields: [{ name: 'index', label: '段序号（-1 = 全部）', type: 'int', default: -1 }],
    hint: '列出已提取的音轨条目。'
  },
  {
    id: 'audio_extract_remove',
    label: '删除音轨',
    method: 'POST',
    path: '/audio_extract_remove',
    auto: ['node_id', 'workflow_name'],
    fields: [{ name: 'entry_id', label: '条目 id', type: 'text', default: '' }],
    hint: '删掉一条已提取的音轨。',
    danger: true
  },
  {
    id: 'asr_check',
    label: '音频有效性校验',
    method: 'POST',
    path: '/asr_check',
    auto: ['node_id', 'workflow_name'],
    fields: [],
    hint: '用 ASR 模型核对已生成的音轨与提示词是否对得上（需先接 asr_model 跑过一次）。'
  },
  {
    id: 'asr_check_status',
    label: '查校验进度',
    method: 'POST',
    path: '/asr_check_status',
    auto: ['node_id', 'workflow_name'],
    fields: [],
    hint: 'ASR 校验的进度。'
  },
  {
    id: 'probe_video',
    label: '探测视频信息',
    method: 'POST',
    path: '/probe_video',
    fields: [
      { name: 'video_file', label: '视频文件名', type: 'text', default: '' },
      { name: 'subfolder', label: '子目录', type: 'text', default: '' },
      {
        name: 'type',
        label: '位置',
        type: 'combo',
        options: ['input', 'output', 'temp'],
        default: 'input'
      }
    ],
    hint: '读视频的时长/帧率/分辨率，用来排时间线。'
  },
  {
    id: 'detect_shots',
    label: '镜头检测',
    method: 'POST',
    path: '/detect_shots',
    fields: [
      { name: 'video_file', label: '视频文件名', type: 'text', default: '' },
      { name: 'subfolder', label: '子目录', type: 'text', default: '' },
      {
        name: 'type',
        label: '位置',
        type: 'combo',
        options: ['input', 'output', 'temp'],
        default: 'input'
      },
      { name: 'sensitivity', label: '灵敏度', type: 'number', default: 0.5 },
      { name: 'min_shot_frames', label: '最小镜头帧数', type: 'int', default: 12 },
      { name: 'frame_rate', label: '帧率', type: 'number', default: 24 },
      { name: 'native_fps', label: '源帧率', type: 'number', default: 0 },
      { name: 'total_frames', label: '总帧数', type: 'int', default: 0 },
      { name: 'logical_start', label: '逻辑起点', type: 'int', default: 0 },
      { name: 'logical_end', label: '逻辑终点', type: 'int', default: 0 },
      { name: 'clips', label: '已有片段（JSON）', type: 'text', default: '' }
    ],
    hint: '自动切镜头，结果可直接喂时间线。'
  },
  {
    id: 'list_input_media',
    label: '输入素材列表',
    method: 'GET',
    path: '/list_input_media',
    fields: [
      {
        name: 'kind',
        label: '类型',
        type: 'combo',
        options: ['', 'video', 'image', 'audio'],
        default: ''
      },
      { name: 'include', label: '包含（逗号分隔）', type: 'text', default: '' }
    ],
    hint: '列出 ComfyUI input 目录下的素材。'
  }
]

/**
 * 组装一次动作调用：表单值 + 自动上下文。
 *
 * 空串一律不带上 —— 节点那边的 `body.get("x") or DEFAULT` 会把空串当没填，
 * 但显式的空串会把某些分支带进"填了但非法"的坑，不如不传。
 */
export function buildActionPayload(
  action: DirectorAction,
  values: Record<string, unknown>,
  ctx: { nodeId: string; workflowName: string; timelineData?: unknown }
): Record<string, unknown> {
  const body: Record<string, unknown> = {}

  for (const auto of action.auto ?? []) {
    if (auto === 'node_id') body.node_id = ctx.nodeId
    else if (auto === 'workflow_name') body.workflow_name = ctx.workflowName
    else if (auto === 'timeline_data' && ctx.timelineData !== undefined) {
      body.timeline_data = ctx.timelineData
    }
  }

  for (const field of action.fields) {
    const raw = values[field.name]
    if (raw === undefined || raw === null || raw === '') continue
    if (field.type === 'int') {
      const n = Number(raw)
      if (Number.isFinite(n)) body[field.name] = Math.trunc(n)
      continue
    }
    if (field.type === 'number') {
      const n = Number(raw)
      if (Number.isFinite(n)) body[field.name] = n
      continue
    }
    if (field.type === 'bool') {
      body[field.name] = raw === true || raw === 'true'
      continue
    }
    body[field.name] = String(raw)
  }

  return body
}

/** 段片段 / 音轨文件这类"取文件"的端点要拼成地址，不能走 JSON */
export function directorFileUrl(
  base: string,
  kind: 'segment_clip' | 'audio_extract_file',
  query: Record<string, string | number>
): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === '' || v === undefined) continue
    qs.set(k, String(v))
  }
  return `${base}${DIRECTOR_ROUTE_PREFIX}/${kind}?${qs.toString()}`
}
