import { describe, expect, it } from 'vitest'
import {
  allCardSubsets,
  applyRunConfigToApi,
  cardsOutOfRange,
  defaultRunConfig,
  directorNodeId,
  DIRECTOR_PROGRESS_EVENT,
  formatCardList,
  parseCardList,
  mergeProgress,
  parseDirectorProgress,
  resolveWorkflowName,
  resolveWorkflowNameWithBound,
  runConfigFromApi,
  slugifyWorkflowName,
  snapRunCanvas,
  validateRunConfig
} from './run'
import type { ApiWorkflow } from './workflow'

/** 一份最小导演工作流：Director + 放大节点 + 一个别的节点 */
function baseApi(): ApiWorkflow {
  return {
    '39': {
      class_type: 'ComfyMiniMaxH3DirectorOpt',
      inputs: {
        model: ['1', 0],
        task_type: 'r2v — 参考主体生视频(Reference to Video)',
        cfg: 1,
        seed: 0,
        steps: 25,
        sampler: 'res_multistep',
        scheduler: 'simple',
        shift_video: 12,
        shift_audio: 3,
        frame_rate: 24,
        width: 864,
        height: 480,
        ref_max_size: 1024,
        total_frames: 124,
        timeline_data: '',
        run_model: '主模型 (model)',
        use_sigmas: false,
        second_run_model: '主模型 (model)',
        second_seed: 156680013701846,
        second_only: false,
        pipeline_cards: '关闭',
        pipeline_split: 'auto'
      }
    },
    '41': {
      class_type: 'MiniMaxH3LatentUpscaleModelOpt',
      inputs: { model_name: 'up.safetensors', mode: { mode: 'megapixels', megapixels: 1 } }
    },
    '14': { class_type: 'SaveVideo', inputs: { filename_prefix: 'h3', format: 'mp4' } }
  }
}

describe('slugifyWorkflowName', () => {
  it('优先认 epNN', () => {
    expect(slugifyWorkflowName('ep01 · 夜班')).toBe('ep1')
    expect(slugifyWorkflowName('EP12')).toBe('ep12')
  })

  it('中文集名也能分出目录：取名字里的第一个数字', () => {
    expect(slugifyWorkflowName('第 01 集 · 夜班')).toBe('ep1')
    expect(slugifyWorkflowName('第02集')).toBe('ep2')
  })

  it('没有数字时用集名的稳定哈希，保证同集同名、异集异名', () => {
    const a = slugifyWorkflowName('夜班')
    const b = slugifyWorkflowName('夜班')
    const c = slugifyWorkflowName('白班')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith('ep_')).toBe(true)
  })

  it('空名退回 fallback，绝不返回空串', () => {
    expect(slugifyWorkflowName('   ')).toBe('episode')
    expect(slugifyWorkflowName('')).toBe('episode')
  })
})

describe('resolveWorkflowName', () => {
  it('钉死的目录名原样用，绝不再 slug（哈希目录名会被 slug 认成"第 3 集"）', () => {
    const cfg = defaultRunConfig()
    cfg.workflowNameExact = 'ep_3f9k2'
    expect(resolveWorkflowName(cfg, '第 03 集 · 暴雨')).toBe('ep_3f9k2')

    // 同一个名字若走集名 slug 会被改成 ep3 —— 那正是"绑了 A 目录却写进 B"的来源
    cfg.workflowNameMode = 'custom'
    cfg.workflowNameCustom = 'ep_3f9k2'
    delete cfg.workflowNameExact
    expect(resolveWorkflowName(cfg, '第 03 集 · 暴雨')).toBe('ep3')
  })

  it('钉死值为空白时退回常规规则（不能变成空目录名）', () => {
    const cfg = defaultRunConfig()
    cfg.workflowNameExact = '   '
    expect(resolveWorkflowName(cfg, '第 03 集 · 雨')).toBe('ep3')
  })

  it('按集名模式用集名', () => {
    expect(resolveWorkflowName(defaultRunConfig(), '第 03 集 · 雨')).toBe('ep3')
  })

  it('自定义模式用填的名字', () => {
    const cfg = defaultRunConfig()
    cfg.workflowNameMode = 'custom'
    cfg.workflowNameCustom = 'ep_test'
    expect(resolveWorkflowName(cfg, '第 03 集')).toBe('ep_test')
  })
})

describe('runConfigFromApi', () => {
  it('用工作流里的真实值打底，不用默认猜', () => {
    const cfg = runConfigFromApi(baseApi())
    expect(cfg.steps).toBe(25)
    expect(cfg.cfg).toBe(1)
    expect(cfg.sampler).toBe('res_multistep')
    expect(cfg.width).toBe(864)
    expect(cfg.frameRate).toBe(24)
    expect(cfg.cards).toBe('关闭')
  })

  it('绝不继承工作流里被写死的 workflow_name', () => {
    const api = baseApi()
    ;(api['39'].inputs as Record<string, unknown>).workflow_name = '23779ace-uuid'
    const cfg = runConfigFromApi(api)
    expect(cfg.workflowNameMode).toBe('episode')
    expect(cfg.workflowNameCustom).toBe('')
  })

  it('没有导演节点就原样返回', () => {
    const api = baseApi()
    delete api['39']
    expect(runConfigFromApi(api).steps).toBe(defaultRunConfig().steps)
  })
})

describe('applyRunConfigToApi', () => {
  it('把运行旋钮写进导演节点', () => {
    const cfg = defaultRunConfig()
    cfg.steps = 20
    cfg.seed = 42
    cfg.cards = '0,1'
    const res = applyRunConfigToApi(baseApi(), cfg, { episodeName: '第 01 集 · 夜班' })
    const inputs = res.api['39'].inputs as Record<string, unknown>
    expect(inputs.steps).toBe(20)
    expect(inputs.seed).toBe(42)
    expect(inputs.pipeline_cards).toBe('0,1')
    expect(res.applied).toBeGreaterThan(10)
    expect(res.skipped).toEqual([])
  })

  it('二采采样器：默认写「跟随一采」，选了具体名字就写名字（节点新增的 widget）', () => {
    const cfg = defaultRunConfig()
    const res = applyRunConfigToApi(baseApi(), cfg, { episodeName: 'x1' })
    expect((res.api['39'].inputs as Record<string, unknown>).second_sampler).toBe('跟随一采')

    cfg.secondSampler = 'euler'
    const res2 = applyRunConfigToApi(baseApi(), cfg, { episodeName: 'x1' })
    expect((res2.api['39'].inputs as Record<string, unknown>).second_sampler).toBe('euler')
  })

  it('二采种子：老配置里那个从工作流抄来的值归到节点固定值 20240', () => {
    const cfg = defaultRunConfig()
    cfg.secondSeed = 156680013701846
    const res = applyRunConfigToApi(baseApi(), cfg, { episodeName: 'x1' })
    expect((res.api['39'].inputs as Record<string, unknown>).second_seed).toBe(20240)
  })

  it('workflow_name 允许新增 —— 它是 hidden widget，UI 导出里常常没有', () => {
    const res = applyRunConfigToApi(baseApi(), defaultRunConfig(), { episodeName: '第 02 集' })
    const inputs = res.api['39'].inputs as Record<string, unknown>
    expect(inputs.workflow_name).toBe('ep2')
  })

  it('seedOverride 优先于配置里的种子（每次随机种子）', () => {
    const cfg = defaultRunConfig()
    cfg.seed = 7
    const res = applyRunConfigToApi(baseApi(), cfg, { episodeName: 'x1', seedOverride: 999 })
    expect((res.api['39'].inputs as Record<string, unknown>).seed).toBe(999)
  })

  it('totalFrames=0 时跟随时间线帧数', () => {
    const cfg = defaultRunConfig()
    cfg.totalFrames = 0
    const res = applyRunConfigToApi(baseApi(), cfg, { episodeName: 'x1', timelineFrames: 480 })
    expect((res.api['39'].inputs as Record<string, unknown>).total_frames).toBe(480)
  })

  it('totalFrames>0 时用配置值，不被时间线覆盖', () => {
    const cfg = defaultRunConfig()
    cfg.totalFrames = 124
    const res = applyRunConfigToApi(baseApi(), cfg, { episodeName: 'x1', timelineFrames: 480 })
    expect((res.api['39'].inputs as Record<string, unknown>).total_frames).toBe(124)
  })

  it('不碰其它节点，也不改原对象', () => {
    const api = baseApi()
    const before = JSON.stringify(api)
    const res = applyRunConfigToApi(api, defaultRunConfig(), { episodeName: 'x1' })
    expect(JSON.stringify(api)).toBe(before)
    expect((res.api['14'].inputs as Record<string, unknown>).filename_prefix).toBe('h3')
  })

  it('工作流里没有导演节点时如实报出来', () => {
    const api = baseApi()
    delete api['39']
    const res = applyRunConfigToApi(api, defaultRunConfig(), { episodeName: 'x1' })
    expect(res.applied).toBe(0)
    expect(res.skipped).toContain('<Director 节点缺失>')
  })

  it('只跑一采时不碰放大节点（别把控制台里配好的二采尺寸悄悄改掉）', () => {
    const cfg = defaultRunConfig()
    cfg.secondStage = 'off'
    const res = applyRunConfigToApi(baseApi(), cfg, { episodeName: 'x1' })
    expect(res.api['41'].inputs?.mode).toEqual({ mode: 'megapixels', megapixels: 1 })
  })

  it('一采+二采：second_only=true，并把二采分辨率写进放大节点', () => {
    const cfg = defaultRunConfig()
    cfg.secondStage = 'pair'
    cfg.secondUpscaleMode = 'megapixels'
    cfg.secondMegapixels = 1.5
    const res = applyRunConfigToApi(baseApi(), cfg, { episodeName: 'x1' })
    const dir = res.api['39'].inputs as Record<string, unknown>
    expect(dir.second_only).toBe(true)
    const up = res.api['41'].inputs as Record<string, unknown>
    expect(up.mode).toBe('megapixels')
    expect(up['mode.megapixels']).toBe(1.5)
    expect(up.align).toBe(32)
  })

  it('二采直出：second_only=false（它靠时间线的 secondSample 触发）', () => {
    const cfg = defaultRunConfig()
    cfg.secondStage = 'direct'
    const res = applyRunConfigToApi(baseApi(), cfg, { episodeName: 'x1' })
    expect((res.api['39'].inputs as Record<string, unknown>).second_only).toBe(false)
  })

  it('填了 sigmas 文本就新建 ManualSigmas 并接线（一采 sigmas / 二采 second_sigmas）', () => {
    const cfg = defaultRunConfig()
    cfg.secondStage = 'pair'
    cfg.sigmas = '0.85, 0.5'
    cfg.secondSigmas = '0.9, 0.6, 0.3, 0'
    const res = applyRunConfigToApi(baseApi(), cfg, { episodeName: 'x1' })
    const dir = res.api['39'].inputs as Record<string, unknown>
    const a = dir.sigmas as [string, number]
    const b = dir.second_sigmas as [string, number]
    expect(res.api[a[0]].class_type).toBe('ManualSigmas')
    expect(res.api[a[0]].inputs?.sigmas).toBe('0.85, 0.5')
    expect(res.api[b[0]].inputs?.sigmas).toBe('0.9, 0.6, 0.3, 0')
    expect(a[0]).not.toBe(b[0])
  })

  it('工作流里没有的键不硬塞，只记进 skipped', () => {
    const api = baseApi()
    const inputs = api['39'].inputs as Record<string, unknown>
    delete inputs.second_only
    delete inputs.use_sigmas
    const res = applyRunConfigToApi(api, defaultRunConfig(), { episodeName: 'x1' })
    expect(res.skipped).toContain('second_only')
    expect('second_only' in (res.api['39'].inputs as Record<string, unknown>)).toBe(false)
  })
})

describe('directorNodeId', () => {
  it('认两个历史 class_type', () => {
    expect(directorNodeId(baseApi())).toBe('39')
    const api: ApiWorkflow = { '7': { class_type: 'MiniMaxH3DirectorOpt', inputs: {} } }
    expect(directorNodeId(api)).toBe('7')
    expect(directorNodeId(null)).toBeNull()
  })
})

describe('snapRunCanvas', () => {
  it('向上取到 32 的倍数', () => {
    expect(snapRunCanvas(850, 864)).toBe(864)
    expect(snapRunCanvas(864, 864)).toBe(864)
    expect(snapRunCanvas(0, 480)).toBe(480)
    expect(snapRunCanvas(1, 480)).toBe(32)
  })
})

describe('validateRunConfig', () => {
  it('没有 API 基线就报出来', () => {
    const out = validateRunConfig(defaultRunConfig(), {
      hasApi: false,
      hasDirector: false,
      hasUpscaleNode: false
    })
    expect(out.join()).toContain('还没有导入 API 工作流')
  })

  it('要跑二采但图里没放大节点 —— 会在二采阶段才炸，必须提前说', () => {
    const cfg = defaultRunConfig()
    cfg.secondStage = 'pair'
    const out = validateRunConfig(cfg, {
      hasApi: true,
      hasDirector: true,
      hasUpscaleNode: false
    })
    expect(out.join()).toContain('放大节点')
  })

  it('只跑一采时不该因为"没有放大节点"被拦住', () => {
    const cfg = defaultRunConfig()
    cfg.secondStage = 'off'
    const out = validateRunConfig(cfg, {
      hasApi: true,
      hasDirector: true,
      hasUpscaleNode: false
    })
    expect(out.join()).not.toContain('放大节点')
  })

  it('切分覆盖写错格式', () => {
    const cfg = defaultRunConfig()
    cfg.cards = '0,1'
    cfg.split = 'abc'
    const out = validateRunConfig(cfg, {
      hasApi: true,
      hasDirector: true,
      hasUpscaleNode: true
    })
    expect(out.join()).toContain('切分覆盖')
  })

  it('一切都对就不报错', () => {
    const out = validateRunConfig(defaultRunConfig(), {
      hasApi: true,
      hasDirector: true,
      hasUpscaleNode: true
    })
    expect(out).toEqual([])
  })
})

describe('parseDirectorProgress', () => {
  /** 节点实际发的载荷：注意**没有 prompt_id**，靠 node_id 归任务 */
  const payload = {
    node_id: '39',
    segment: 2,
    segment_total: 4,
    timeline_segment: 2,
    timeline_segment_total: 4,
    partial_run: false,
    phase: 'sample',
    phase_label: '采样',
    phase_value: 6,
    phase_max: 20,
    overall_value: 6.3,
    overall_max: 16,
    remaining_segments: 2,
    frames_label: '107 帧',
    task_key: 'seg2'
  }

  it('读的是自定义事件名，不是 ComfyUI 标准的 progress', () => {
    expect(DIRECTOR_PROGRESS_EVENT).toBe('minimax_director_opt_progress')
  })

  it('把节点载荷翻成进度', () => {
    const p = parseDirectorProgress(payload)
    expect(p).not.toBeNull()
    expect(p!.nodeId).toBe('39')
    expect(p!.overall).toBe(true)
    expect(p!.value).toBeCloseTo(6.3)
    expect(p!.max).toBe(16)
    expect(p!.segment).toBe(2)
    expect(p!.segmentTotal).toBe(4)
    expect(p!.phase).toBe('sample')
    expect(p!.phaseLabel).toBe('采样')
    expect(p!.framesLabel).toBe('107 帧')
    expect(p!.remainingSegments).toBe(2)
  })

  it('phase_label 缺席时退回 phase', () => {
    const p = parseDirectorProgress({ ...payload, phase_label: undefined })
    expect(p!.phaseLabel).toBe('sample')
  })

  it('只有步内 value/max 时标记为非整体进度（不能拿去覆盖整体百分比）', () => {
    const p = parseDirectorProgress({ node_id: '39', value: 1, max: 3, phase: 'sample' })
    expect(p).not.toBeNull()
    expect(p!.overall).toBe(false)
    expect(p!.value).toBe(1)
    expect(p!.max).toBe(3)
  })

  it('空载荷不算进度（别拿 0/0 去覆盖已有进度）', () => {
    expect(parseDirectorProgress({})).toBeNull()
    expect(parseDirectorProgress(null)).toBeNull()
    expect(parseDirectorProgress({ overall_value: 0, overall_max: 0 })).toBeNull()
  })
})

describe('选卡：任意张数 / 任意组合', () => {
  it('4 张卡就是 关闭 + 15 种组合（与节点侧 combinations 同规则）', () => {
    const opts = allCardSubsets(4)
    expect(opts[0]).toBe('关闭')
    expect(opts).toHaveLength(16)
    // 不是只有"连续前缀"，任意组合都得在
    expect(opts).toContain('1,3')
    expect(opts).toContain('0,2,3')
    expect(opts).toContain('0,1,2,3')
    expect(opts).toContain('2')
  })

  it('2 张卡 = 关闭 + 3 种，0 张卡只有关闭', () => {
    expect(allCardSubsets(2)).toEqual(['关闭', '0', '1', '0,1'])
    expect(allCardSubsets(0)).toEqual(['关闭'])
  })

  it('解析容错：多种写法都认，关闭因为不含数字自然为空', () => {
    expect(parseCardList('0,1')).toEqual([0, 1])
    expect(parseCardList('0 1')).toEqual([0, 1])
    expect(parseCardList('卡 0 + 卡 1')).toEqual([0, 1])
    expect(parseCardList(['0', '2'])).toEqual([0, 2])
    expect(parseCardList(1)).toEqual([1])
    expect(parseCardList('关闭')).toEqual([])
    expect(parseCardList('')).toEqual([])
    expect(parseCardList(null)).toEqual([])
    expect(parseCardList('1,1,2')).toEqual([1, 2])
  })

  it('格式化：排序去重，空则关闭', () => {
    expect(formatCardList([3, 1])).toBe('1,3')
    expect(formatCardList([1, 1, 0])).toBe('0,1')
    expect(formatCardList([])).toBe('关闭')
  })

  it('超出可见范围的卡被点出来', () => {
    expect(cardsOutOfRange([0, 1], 2)).toEqual([])
    expect(cardsOutOfRange([0, 2], 2)).toEqual([2])
    // 连不上 ComfyUI（visible=0）时不校验，别误报
    expect(cardsOutOfRange([0, 1], 0)).toEqual([])
  })

  it('选了 ComfyUI 看不见的卡 → 自检拦截并给出该用的启动参数', () => {
    const cfg = defaultRunConfig()
    cfg.cards = '0,1,2'
    expect(validateRunConfig(cfg, ctx({ visibleCards: 2 })).join()).toMatch(/看不见的卡 2/)
    expect(validateRunConfig(cfg, ctx({ visibleCards: 2 })).join()).toMatch(/--cuda-device 0,1,2/)
    // 可见 3 张就不该报错
    expect(validateRunConfig(cfg, ctx({ visibleCards: 3 }))).toEqual([])
    // 未知可见卡数时不拦
    expect(validateRunConfig(cfg, ctx({}))).toEqual([])
  })
})

/** 自检用的上下文，默认"一切齐备" */
function ctx(extra: Partial<Parameters<typeof validateRunConfig>[1]> = {}) {
  return {
    hasApi: true,
    hasDirector: true,
    hasUpscaleNode: true,
    ...extra
  }
}

describe('mergeProgress：多段并发报进度时只许前进', () => {
  /** 四卡实测的跳变序列：75% → 38% → 19% → 94%，回跳的全要挡掉 */
  it('落后段报的更低百分比一律丢弃', () => {
    let p = { value: 0, max: 0 }
    p = mergeProgress(p, { overall: true, value: 12, max: 16 })
    expect(p).toEqual({ value: 12, max: 16 })
    p = mergeProgress(p, { overall: true, value: 6, max: 16 })
    expect(p).toEqual({ value: 12, max: 16 })
    p = mergeProgress(p, { overall: true, value: 3, max: 16 })
    expect(p).toEqual({ value: 12, max: 16 })
    p = mergeProgress(p, { overall: true, value: 15, max: 16 })
    expect(p).toEqual({ value: 15, max: 16 })
  })

  it('步内口径（2/3）不能把整体（12/16）打回去', () => {
    const p = mergeProgress({ value: 12, max: 16 }, { overall: true, value: 2, max: 3 })
    expect(p).toEqual({ value: 12, max: 16 })
  })

  it('百分比真的更高时才更新，哪怕 max 变小了', () => {
    const p = mergeProgress({ value: 1, max: 16 }, { overall: true, value: 2, max: 3 })
    expect(p).toEqual({ value: 2, max: 3 })
  })

  it('步内进度（overall=false）完全不碰百分比', () => {
    expect(mergeProgress({ value: 12, max: 16 }, { overall: false, value: 2, max: 3 })).toEqual({
      value: 12,
      max: 16
    })
  })

  it('第一次上报（max=0）一定接受，否则永远起不来', () => {
    expect(mergeProgress({ value: 0, max: 0 }, { overall: true, value: 1, max: 3 })).toEqual({
      value: 1,
      max: 3
    })
  })
})

describe('导演台其余参数（extras）', () => {
  it('导入工作流时把没提成一等公民的输入收进 extras', () => {
    const api = baseApi()
    const inputs = api['39'].inputs as Record<string, unknown>
    inputs.global_prompt = '夜班，雨'
    inputs.some_new_switch = true
    const cfg = runConfigFromApi(api)
    expect(cfg.extras.global_prompt).toBe('夜班，雨')
    expect(cfg.extras.some_new_switch).toBe(true)
    // 一等公民字段不进 extras，免得两处写同一个键
    expect(cfg.extras.steps).toBeUndefined()
    expect(cfg.extras.pipeline_cards).toBeUndefined()
    expect(cfg.extras.workflow_name).toBeUndefined()
  })

  it('连线引用不进 extras（那是图上的线，不是旋钮）', () => {
    const api = baseApi()
    ;(api['39'].inputs as Record<string, unknown>).model = ['12', 0]
    expect(runConfigFromApi(api).extras.model).toBeUndefined()
  })

  it('提交时把 extras 写进导演节点', () => {
    const cfg = defaultRunConfig()
    cfg.extras = { global_prompt: '夜班，雨' }
    const api = baseApi()
    ;(api['39'].inputs as Record<string, unknown>).global_prompt = '占位'
    const res = applyRunConfigToApi(api, cfg, { episodeName: '第 01 集' })
    expect((res.api['39'].inputs as Record<string, unknown>).global_prompt).toBe('夜班，雨')
    expect(res.skipped).toEqual([])
  })

  it('工作流里没有这个键 → 记进 skipped，而不是凭空加一个', () => {
    const cfg = defaultRunConfig()
    cfg.extras = { not_a_real_input: 1 }
    const res = applyRunConfigToApi(baseApi(), cfg, { episodeName: '第 01 集' })
    expect(res.skipped).toContain('not_a_real_input')
  })

  it('extras 不能覆盖一等公民字段与 workflow_name', () => {
    const cfg = defaultRunConfig()
    cfg.steps = 7
    cfg.extras = { steps: 999, workflow_name: 'hijack' }
    const res = applyRunConfigToApi(baseApi(), cfg, { episodeName: '第 01 集' })
    const inputs = res.api['39'].inputs as Record<string, unknown>
    expect(inputs.steps).toBe(7)
    expect(inputs.workflow_name).not.toBe('hijack')
  })
})

describe('resolveWorkflowNameWithBound', () => {
  it('★ 绑定之后给剧集改名，目录不变（否则旧缓存会"消失"）', () => {
    const cfg = defaultRunConfig()
    // 第一次生成时集名是「第 03 集 · 雨」→ 目录 ep3
    expect(resolveWorkflowNameWithBound(cfg, '第 03 集 · 雨', '')).toBe('ep3')
    // 用户改名成「第 03 集 · 暴雨」：绑定还在 ep3，就该继续写 ep3
    expect(resolveWorkflowNameWithBound(cfg, '第 03 集 · 暴雨', 'ep3')).toBe('ep3')
    // 反例：没有绑定时会按新名字算，这就是"改名就找不到产物"的来源
    expect(resolveWorkflowName(cfg, '第 03 集 · 暴雨')).toBe('ep3')
    expect(resolveWorkflowNameWithBound(cfg, '夜班特辑', 'ep_3f9k2')).toBe('ep_3f9k2')
  })

  it('钉死的名字优先于绑定（调用方已明确指定）', () => {
    const cfg = defaultRunConfig()
    cfg.workflowNameExact = 'ep_fixed'
    expect(resolveWorkflowNameWithBound(cfg, '第 01 集', 'ep1')).toBe('ep_fixed')
  })

  it('用户主动改自定义目录 → 尊重他（这是唯一有意换目录的方式）', () => {
    const cfg = defaultRunConfig()
    cfg.workflowNameMode = 'custom'
    cfg.workflowNameCustom = '第 07 集'
    expect(resolveWorkflowNameWithBound(cfg, '第 03 集 · 雨', 'ep7')).toBe('ep7')
    cfg.workflowNameCustom = '第 08 集'
    expect(resolveWorkflowNameWithBound(cfg, '第 03 集 · 雨', 'ep7')).toBe('ep8')
  })

  it('自定义留空 / 有绑定但模式仍是集名 → 走绑定', () => {
    const cfg = defaultRunConfig()
    cfg.workflowNameMode = 'custom'
    cfg.workflowNameCustom = ''
    expect(resolveWorkflowNameWithBound(cfg, '第 03 集 · 雨', 'ep3')).toBe('ep3')
  })

  it('没有绑定也没有钉死 → 回到常规规则', () => {
    const cfg = defaultRunConfig()
    expect(resolveWorkflowNameWithBound(cfg, '第 03 集 · 雨', '   ')).toBe('ep3')
  })
})
