import { describe, expect, it } from 'vitest'
import {
  DIRECTOR_ACTIONS,
  OWNED_DIRECTOR_KEYS,
  buildActionPayload,
  isConfigurable,
  parseDirectorSpec
} from './director'

/** 截取真实 object_info 的形状：input.required / input.optional，每项 [type|options, opts] */
const objectInfo = {
  ComfyMiniMaxH3DirectorOpt: {
    input: {
      required: {
        model: ['MODEL', {}],
        task_type: [
          ['t2v — 文生视频', 'r2v — 参考主体生视频'],
          { default: 'r2v — 参考主体生视频' }
        ],
        global_prompt: ['STRING', { default: 'A cinematic scene', multiline: true }],
        bd_grp_sample: ['BDGROUP', { default: '采样设置' }],
        cfg: ['FLOAT', { default: 1, min: 0, max: 30, step: 0.01 }],
        width: ['INT', { default: 864, min: 32, max: 8192, step: 32 }]
      },
      optional: {
        asr_model: ['T8_MOSS_TRANSCRIBE_MODEL', { forceInput: true }],
        sigmas: ['SIGMAS', { forceInput: true }],
        pipeline_cards: [['关闭', '0', '1', '0,1'], { default: '关闭' }],
        use_sigmas: ['BOOLEAN', { default: false }],
        i2v_groups: ['MMX_DIR_GROUP', {}]
      }
    }
  }
}

describe('parseDirectorSpec', () => {
  const specs = parseDirectorSpec(objectInfo)

  it('把 combo 的候选原样带出来（枚举必须现取，不能写死）', () => {
    const cards = specs.find((s) => s.name === 'pipeline_cards')
    expect(cards?.type).toBe('COMBO')
    expect(cards?.options).toEqual(['关闭', '0', '1', '0,1'])
    expect(cards?.default).toBe('关闭')
  })

  it('标量类型带上范围与默认值', () => {
    const cfg = specs.find((s) => s.name === 'cfg')
    expect(cfg?.type).toBe('FLOAT')
    expect(cfg?.min).toBe(0)
    expect(cfg?.max).toBe(30)
    expect(cfg?.multiline).toBe(false)
    const prompt = specs.find((s) => s.name === 'global_prompt')
    expect(prompt?.multiline).toBe(true)
  })

  it('连线口与分组标题一律判为 LINK，不进旋钮', () => {
    expect(specs.find((s) => s.name === 'model')?.type).toBe('LINK')
    expect(specs.find((s) => s.name === 'asr_model')?.type).toBe('LINK')
    expect(specs.find((s) => s.name === 'sigmas')?.type).toBe('LINK')
    expect(specs.find((s) => s.name === 'bd_grp_sample')?.type).toBe('LINK')
    expect(specs.find((s) => s.name === 'i2v_groups')?.type).toBe('LINK')
    expect(specs.filter(isConfigurable).map((s) => s.name)).toEqual([
      'task_type',
      'global_prompt',
      'cfg',
      'width',
      'pipeline_cards',
      'use_sigmas'
    ])
  })

  it('空 / 畸形输入不会炸', () => {
    expect(parseDirectorSpec(null)).toEqual([])
    expect(parseDirectorSpec({})).toEqual([])
    expect(parseDirectorSpec({ X: { input: { required: { a: [] } } } })).toEqual([])
  })
})

describe('buildActionPayload', () => {
  const clearCache = DIRECTOR_ACTIONS.find((a) => a.id === 'clear_cache')!

  it('自动上下文（node_id / workflow_name）一定带上', () => {
    const body = buildActionPayload(
      clearCache,
      {},
      { nodeId: '39', workflowName: 'ep1' }
    )
    expect(body.node_id).toBe('39')
    expect(body.workflow_name).toBe('ep1')
  })

  it('表单值按声明的类型换算，空串不传', () => {
    const body = buildActionPayload(
      clearCache,
      { clear_all: 'true' },
      { nodeId: '39', workflowName: 'ep1' }
    )
    expect(body.clear_all).toBe(true)
    expect(buildActionPayload(clearCache, { clear_all: '' }, { nodeId: '1', workflowName: 'w' })).not.toHaveProperty(
      'clear_all'
    )
  })

  it('int / number 走数字，非法值不进 body', () => {
    const detect = DIRECTOR_ACTIONS.find((a) => a.id === 'detect_shots')!
    const body = buildActionPayload(
      detect,
      { min_shot_frames: '24', sensitivity: '0.75', video_file: '', bogus: 'x' },
      { nodeId: '39', workflowName: 'ep1' }
    )
    expect(body.min_shot_frames).toBe(24)
    expect(body.sensitivity).toBe(0.75)
    expect(body).not.toHaveProperty('video_file')
    expect(body).not.toHaveProperty('bogus')
  })

  it('timeline_data 只在给了的时候才带', () => {
    const exp = DIRECTOR_ACTIONS.find((a) => a.id === 'segment_export')!
    const tl = { segments: [] }
    expect(buildActionPayload(exp, {}, { nodeId: '1', workflowName: 'w', timelineData: tl }).timeline_data).toBe(tl)
    expect(
      buildActionPayload(exp, {}, { nodeId: '1', workflowName: 'w' })
    ).not.toHaveProperty('timeline_data')
  })
})

describe('导演台动作清单', () => {
  it('id 不重复，路径都挂在节点前缀下', () => {
    const ids = DIRECTOR_ACTIONS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const a of DIRECTOR_ACTIONS) expect(a.path.startsWith('/')).toBe(true)
  })

  it('覆盖导演台的主要功能（以前只能切回 ComfyUI 按）', () => {
    const paths = new Set(DIRECTOR_ACTIONS.map((a) => a.path))
    for (const p of [
      '/clear_cache',
      '/segment_export',
      '/second_sample_status',
      '/align_to_next_status',
      '/remove_segment_slot',
      '/audio_extract',
      '/asr_check',
      '/detect_shots',
      '/probe_video',
      '/list_input_media'
    ]) {
      expect(paths).toContain(p)
    }
  })

  it('一等公民字段与 extras 不会重复管同一个键', () => {
    // workflow_name 由"缓存分集"专门管：extras 碰它会导致按集分目录失效
    expect(OWNED_DIRECTOR_KEYS.has('workflow_name')).toBe(true)
    expect(OWNED_DIRECTOR_KEYS.has('pipeline_cards')).toBe(true)
    expect(OWNED_DIRECTOR_KEYS.has('global_prompt')).toBe(false)
  })
})
