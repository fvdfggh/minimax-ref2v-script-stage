import { describe, expect, it } from 'vitest'
import {
  CANVAS_MP_PRESETS,
  CANVAS_PRESETS,
  canvasFromMegapixels,
  canvasMegapixels,
  canvasRatio,
  cardsLabel,
  DEFAULT_PIPELINE_PARAMS,
  pipelineEquals,
  pipelineParamsFromConfig,
  pipelineParamsPatch,
  pipelinePromptInputs,
  pipelineSummary,
  toggleCard
} from './pipelineParams'
import { defaultRunConfig, secondStageOf } from './run'

describe('pipelineParamsFromConfig', () => {
  it('把运行配置的一等公民字段全部搬过来（交付页要能改，而不是只能看）', () => {
    const cfg = defaultRunConfig()
    cfg.seed = 12345
    cfg.randomSeed = true
    cfg.steps = 11
    cfg.cfg = 1.5
    cfg.sampler = 'uni_pc'
    cfg.scheduler = 'karras'
    cfg.shiftVideo = 8
    cfg.shiftAudio = 2.5
    cfg.useSigmas = true
    cfg.sigmas = '0.85, 0.5'
    cfg.runModel = '备用模型 1 (model_b)'
    cfg.taskType = 'i2v'
    cfg.width = 640
    cfg.height = 352
    cfg.frameRate = 30
    cfg.refMaxSize = 768
    cfg.totalFrames = 121
    cfg.cards = '0,1'
    cfg.split = '24,26'
    cfg.secondStage = 'direct'
    cfg.secondRunModel = '备用模型 2 (model_c)'
    cfg.secondSeed = 999
    cfg.secondSampler = 'euler'
    cfg.secondSigmas = '0.9, 0.4, 0'
    cfg.secondUpscaleMode = 'p'
    cfg.secondPTier = 1080
    cfg.clearCacheOnSubmit = true

    expect(pipelineParamsFromConfig(cfg)).toEqual({
      seed: 12345,
      randomSeed: true,
      steps: 11,
      cfg: 1.5,
      sampler: 'uni_pc',
      scheduler: 'karras',
      shiftVideo: 8,
      shiftAudio: 2.5,
      useSigmas: true,
      sigmas: '0.85, 0.5',
      runModel: '备用模型 1 (model_b)',
      taskType: 'i2v',
      width: 640,
      height: 352,
      frameRate: 30,
      refMaxSize: 768,
      totalFrames: 121,
      cards: '0,1',
      split: '24,26',
      secondStage: 'direct',
      secondRunModel: '备用模型 2 (model_c)',
      secondSeed: 999,
      secondSampler: 'euler',
      secondSigmas: '0.9, 0.4, 0',
      secondUpscaleMode: 'p',
      secondMegapixels: 1,
      secondPTier: 1080,
      secondScale: 2,
      secondWidth: 1376,
      secondHeight: 768,
      secondAlign: 32,
      clearCacheOnSubmit: true
    })
  })

  it('默认值必须与 defaultRunConfig() 逐项一致（"没绑配置"和"绑了默认配置"不能两套数）', () => {
    expect(pipelineParamsFromConfig(defaultRunConfig())).toEqual(DEFAULT_PIPELINE_PARAMS)
    expect({ ...DEFAULT_PIPELINE_PARAMS }).toEqual(pipelineParamsFromConfig(null))
    expect({ ...DEFAULT_PIPELINE_PARAMS }).toEqual(pipelineParamsFromConfig(undefined))
  })

  it('二采种子默认就是固定值 20240，一采开随机也不跟着变', () => {
    expect(DEFAULT_PIPELINE_PARAMS.secondSeed).toBe(20240)
    expect(DEFAULT_PIPELINE_PARAMS.secondSampler).toBe('')
    const p = pipelineParamsFromConfig({ ...defaultRunConfig(), randomSeed: true })
    expect(p.secondSeed).toBe(20240)
  })

  it('老配置没有 secondStage：按 secondOnly 迁移（secondEnabled 单独为真在节点上什么都不做）', () => {
    const cfg = defaultRunConfig()
    delete (cfg as { secondStage?: unknown }).secondStage
    cfg.secondOnly = true
    expect(secondStageOf(cfg)).toBe('pair')

    cfg.secondOnly = false
    cfg.secondEnabled = true // 旧 UI 的"开二采"—— 节点上并没有这个开关
    expect(secondStageOf(cfg)).toBe('off')
    expect(pipelineParamsFromConfig(cfg).secondStage).toBe('off')
  })

  it('脏数据（NaN / 空串 / null）退回默认，不让输入框炸掉', () => {
    const cfg = defaultRunConfig()
    cfg.seed = Number.NaN
    cfg.steps = Number.NaN
    cfg.cfg = null as unknown as number
    cfg.sampler = ''
    cfg.cards = ''
    cfg.split = null as unknown as string
    cfg.sigmas = null as unknown as string
    const p = pipelineParamsFromConfig(cfg)
    expect(p.seed).toBe(DEFAULT_PIPELINE_PARAMS.seed)
    expect(p.steps).toBe(DEFAULT_PIPELINE_PARAMS.steps)
    expect(p.cfg).toBe(DEFAULT_PIPELINE_PARAMS.cfg)
    expect(p.sampler).toBe(DEFAULT_PIPELINE_PARAMS.sampler)
    expect(p.cards).toBe('关闭')
    expect(p.split).toBe(DEFAULT_PIPELINE_PARAMS.split)
    // sigmas 是"可以空"的：空 = 不动图上接线，不能回退成别的值
    expect(p.sigmas).toBe('')
  })
})

describe('pipelineParamsPatch', () => {
  it('面板上能改的每一项都映射到 RunConfig 同名键', () => {
    expect(
      pipelineParamsPatch({
        sampler: 'euler',
        scheduler: 'beta',
        shiftVideo: 5,
        shiftAudio: 1,
        useSigmas: true,
        sigmas: '0.85, 0.5',
        width: 640,
        height: 352,
        frameRate: 30,
        refMaxSize: 768,
        totalFrames: 121,
        split: '24,26',
        secondRunModel: '备用模型 1 (model_b)',
        secondSeed: 7,
        secondSigmas: '0.9, 0.4, 0',
        secondUpscaleMode: 'megapixels',
        secondMegapixels: 1.5,
        clearCacheOnSubmit: true
      })
    ).toEqual({
      sampler: 'euler',
      scheduler: 'beta',
      shiftVideo: 5,
      shiftAudio: 1,
      useSigmas: true,
      sigmas: '0.85, 0.5',
      width: 640,
      height: 352,
      frameRate: 30,
      refMaxSize: 768,
      totalFrames: 121,
      split: '24,26',
      secondRunModel: '备用模型 1 (model_b)',
      secondSeed: 7,
      secondSigmas: '0.9, 0.4, 0',
      secondUpscaleMode: 'megapixels',
      secondMegapixels: 1.5,
      clearCacheOnSubmit: true
    })
  })

  it('改「跑哪一档」时顺手把两个老布尔写一致（别的页面还在读它们）', () => {
    expect(pipelineParamsPatch({ secondStage: 'pair' })).toEqual({
      secondStage: 'pair',
      secondEnabled: true,
      secondOnly: true
    })
    expect(pipelineParamsPatch({ secondStage: 'direct' })).toEqual({
      secondStage: 'direct',
      secondEnabled: true,
      secondOnly: false
    })
    expect(pipelineParamsPatch({ secondStage: 'off' })).toEqual({
      secondStage: 'off',
      secondEnabled: false,
      secondOnly: false
    })
  })

  it('没传的字段不生成 key（避免把别的旋钮顺手清掉）', () => {
    expect(Object.keys(pipelineParamsPatch({}))).toHaveLength(0)
    expect('seed' in pipelineParamsPatch({ cfg: 2 })).toBe(false)
  })

  it('false / 0 这类假值要能写进去', () => {
    expect(pipelineParamsPatch({ seed: 0, randomSeed: false, totalFrames: 0 })).toEqual({
      seed: 0,
      randomSeed: false,
      totalFrames: 0
    })
  })
})

describe('pipelinePromptInputs', () => {
  it('键名用节点上的 pipeline_cards / pipeline_split，不是配置里的 cards / split', () => {
    const inputs = pipelinePromptInputs({ ...DEFAULT_PIPELINE_PARAMS, seed: 7, cards: '0,1' })
    expect(inputs.seed).toBe(7)
    expect(inputs.pipeline_cards).toBe('0,1')
    expect(inputs.pipeline_split).toBe('auto')
    expect('randomSeed' in inputs).toBe(false)
    expect('cards' in inputs).toBe(false)
    expect('split' in inputs).toBe(false)
  })

  it('采样 / 画布 / 二采这些也一起打回 prompt（沿用配方时也能调）', () => {
    const inputs = pipelinePromptInputs({
      ...DEFAULT_PIPELINE_PARAMS,
      sampler: 'euler',
      scheduler: 'karras',
      shiftVideo: 8,
      shiftAudio: 2,
      width: 640,
      height: 352,
      frameRate: 30,
      refMaxSize: 768,
      secondSeed: 99,
      secondStage: 'pair',
      useSigmas: true,
      runModel: '备用模型 1 (model_b)',
      taskType: 'i2v'
    })
    expect(inputs).toMatchObject({
      sampler: 'euler',
      scheduler: 'karras',
      shift_video: 8,
      shift_audio: 2,
      width: 640,
      height: 352,
      frame_rate: 30,
      ref_max_size: 768,
      second_seed: 99,
      second_only: true,
      use_sigmas: true,
      run_model: '备用模型 1 (model_b)'
    })
    // 任务类型不进"沿用配方"：时间线是按旧任务类型编的，改了会配不上
    expect('task_type' in inputs).toBe(false)
    // sigmas 文本与二采分辨率不在导演节点上，走 resubmit 的 secondPass 分支
    expect('sigmas' in inputs).toBe(false)
    expect('second_megapixels' in inputs).toBe(false)
  })

  it('「二采直出」不打 second_only（它靠时间线的 secondSample）', () => {
    expect(
      pipelinePromptInputs({ ...DEFAULT_PIPELINE_PARAMS, secondStage: 'direct' }).second_only
    ).toBe(false)
  })
})

describe('cardsLabel / toggleCard（选卡多选）', () => {
  it('关闭说成单卡，组合说成卡 0,1', () => {
    expect(cardsLabel('关闭')).toBe('单卡')
    expect(cardsLabel('')).toBe('单卡')
    expect(cardsLabel('0,1,3')).toBe('卡 0,1,3')
  })

  it('打勾/取消一张，结果总是排序去重的合法值', () => {
    expect(toggleCard('关闭', 2)).toBe('2')
    expect(toggleCard('0', 2)).toBe('0,2')
    expect(toggleCard('0,1,2', 1)).toBe('0,2')
    expect(toggleCard('2', 2)).toBe('关闭')
    expect(toggleCard('关闭', 0)).toBe('0')
  })
})

describe('pipelineSummary', () => {
  it('摘要一行说清这一次所有段怎么跑（采样器 / 画布 / 卡）', () => {
    const base = { ...DEFAULT_PIPELINE_PARAMS, seed: 42, steps: 25, cfg: 1 }
    expect(pipelineSummary(base)).toBe(
      '种子 42 · 25 步 · CFG 1 · res_multistep · 864×480 · 单卡'
    )
    expect(pipelineSummary({ ...base, randomSeed: true, cards: '0,1' })).toBe(
      '种子 随机 · 25 步 · CFG 1 · res_multistep · 864×480 · 卡 0,1'
    )
  })

  it('档位不算统一参数：跑哪一档由运行按钮定，不进摘要', () => {
    const base = { ...DEFAULT_PIPELINE_PARAMS }
    for (const stage of ['off', 'pair', 'direct'] as const) {
      const text = pipelineSummary({ ...base, secondStage: stage })
      expect(text).not.toContain('二采')
      expect(text).not.toContain('只一采')
    }
  })
})

describe('pipelineEquals', () => {
  it('任一旋钮不同就不算同一套参数', () => {
    const a = { ...DEFAULT_PIPELINE_PARAMS }
    expect(pipelineEquals(a, { ...a })).toBe(true)
    expect(pipelineEquals(a, { ...a, steps: 26 })).toBe(false)
    expect(pipelineEquals(a, { ...a, sampler: 'euler' })).toBe(false)
    expect(pipelineEquals(a, { ...a, width: 640 })).toBe(false)
    expect(pipelineEquals(a, { ...a, secondStage: 'pair' })).toBe(false)
  })
})

describe('画布：像素密度 ↔ 宽高', () => {
  it('密度 + 比例反解出的宽高都是 32 的倍数，且密度能对得上', () => {
    for (const mp of [0.09, 0.15, 0.3, 0.42, 1, 1.5]) {
      const { width, height } = canvasFromMegapixels(mp, 1.8)
      expect(width % 32, `${mp}MP 宽`).toBe(0)
      expect(height % 32, `${mp}MP 高`).toBe(0)
      // 32 取整会带来一点误差，但不该超过一个步长带来的比例偏差
      expect(Math.abs(canvasMegapixels(width, height) - mp) / mp).toBeLessThan(0.12)
    }
  })

  it('默认画布 864×480 = 0.415 MP、比例 1.8', () => {
    expect(canvasMegapixels(864, 480)).toBe(0.415)
    expect(canvasRatio(864, 480)).toBeCloseTo(1.8, 5)
    const back = canvasFromMegapixels(0.41472, 1.8)
    expect(back).toEqual({ width: 864, height: 480 })
  })

  it('小画布必须能算出来（以前最小的档位是 640×352，试跑还是太贵）', () => {
    const { width, height } = canvasFromMegapixels(0.09, 1.8)
    expect(width * height).toBeLessThan(640 * 352)
    expect(CANVAS_MP_PRESETS.some((mp) => mp <= 0.1)).toBe(true)
  })

  it('竖构图也是 32 的倍数、比例正确', () => {
    const { width, height } = canvasFromMegapixels(0.4, 9 / 16)
    expect(width % 32).toBe(0)
    expect(height % 32).toBe(0)
    expect(canvasRatio(width, height)).toBeCloseTo(9 / 16, 1)
    expect(height).toBeGreaterThan(width)
  })

  it('每一档都是 32 的倍数（导演包会 snap 到 32，给 720 会让配置和实际画布对不上）', () => {
    for (const p of CANVAS_PRESETS) {
      expect(p.width % 32, `${p.label} 宽`).toBe(0)
      expect(p.height % 32, `${p.label} 高`).toBe(0)
    }
  })
})
