import { describe, expect, it } from 'vitest'
import {
  SECOND_SEED_FIXED,
  applySecondSample,
  applySigmasText,
  applyUpscaleToApi,
  secondSampleFor,
  secondSeedOf,
  secondSamplerOf,
  secondTargetSize,
  sigmasStepCount,
  upscaleNodeId,
  type NodeLike
} from './secondPass'

/** 真实工作流的骨架：导演节点 39，放大节点 41 接在 upscale_model 上，ManualSigmas 52 接 second_sigmas */
function graph(): Record<string, NodeLike> {
  return {
    '39': {
      class_type: 'ComfyMiniMaxH3DirectorOpt',
      inputs: {
        width: 864,
        height: 480,
        steps: 25,
        upscale_model: ['41', 0],
        second_sigmas: ['52', 0]
      }
    },
    '41': {
      class_type: 'MiniMaxH3LatentUpscaleModelOpt',
      inputs: {
        model_name: 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
        mode: 'megapixels',
        'mode.megapixels': 1,
        align: 32,
        precision: 'fp16'
      }
    },
    '52': { class_type: 'ManualSigmas', inputs: { sigmas: '0.85, 0.5' } }
  }
}

describe('secondTargetSize（与节点 target_final_pixels 逐字一致）', () => {
  it('像素量档：1.0 = 1024²，864×480 放大到 1376×768', () => {
    expect(secondTargetSize(864, 480, { mode: 'megapixels', megapixels: 1, align: 32 })).toEqual({
      width: 1376,
      height: 768,
      scale: 1.59
    })
  })

  it('p 档：720 必须是 1280×720（内部按 16 对齐，套 32 会变 704）', () => {
    const r = secondTargetSize(1280, 720, { mode: 'p', p: 720 })
    expect({ width: r.width, height: r.height }).toEqual({ width: 1280, height: 720 })
  })

  it('p 档在非 16:9 的一采画布上按比例走（不是硬给 1280×720）', () => {
    const r = secondTargetSize(864, 480, { mode: 'p', p: 720 })
    // 864×480 比例 1.8，720p 的像素预算 1280×720 摊到 1.8 上
    expect(r.width / r.height).toBeCloseTo(1.8, 1)
    expect(r.width % 16).toBe(0)
    expect(r.height % 16).toBe(0)
  })

  it('倍率档：×2 后仍按 align 对齐', () => {
    expect(secondTargetSize(864, 480, { mode: 'scale by multiplier', scale: 2, align: 32 })).toEqual({
      width: 1728,
      height: 960,
      scale: 2
    })
  })

  it('指定尺寸档：向上/向下取整到 align，再落到 VAE 的 16 倍数', () => {
    const r = secondTargetSize(864, 480, {
      mode: 'target dimensions',
      width: 1281,
      height: 705,
      align: 32
    })
    expect({ width: r.width, height: r.height }).toEqual({ width: 1280, height: 704 })
  })
})

describe('upscaleNodeId', () => {
  it('顺着导演节点的 upscale_model 连线找（图里可能有好几个放大节点）', () => {
    const api = graph()
    expect(upscaleNodeId(api, '39')).toBe('41')
  })

  it('没有连线时按类型兜底', () => {
    const api = graph()
    delete (api['39'].inputs as Record<string, unknown>).upscale_model
    expect(upscaleNodeId(api, '39')).toBe('41')
  })

  it('图里根本没有放大节点就返回 null', () => {
    expect(upscaleNodeId({ '39': { class_type: 'ComfyMiniMaxH3DirectorOpt', inputs: {} } })).toBeNull()
  })
})

describe('applyUpscaleToApi', () => {
  it('写主键 + mode.<子键>，并清掉上一次留下的其他 mode.*', () => {
    const api = graph()
    // 先切到 p 档（会留下 mode.p），再切回像素量：mode.p 必须消失
    applyUpscaleToApi(api, {
      mode: 'p',
      megapixels: 1,
      p: 720,
      scale: 2,
      width: 1376,
      height: 768,
      align: 32
    }, '39')
    expect(api['41'].inputs?.['mode.p']).toBe(720)

    applyUpscaleToApi(api, {
      mode: 'megapixels',
      megapixels: 1.5,
      p: 720,
      scale: 2,
      width: 1376,
      height: 768,
      align: 32
    }, '39')
    expect(api['41'].inputs?.mode).toBe('megapixels')
    expect(api['41'].inputs?.['mode.megapixels']).toBe(1.5)
    expect('mode.p' in (api['41'].inputs ?? {})).toBe(false)
  })

  it('p 档不写 align（那一档固定 16，写了会让面板和实际对不上）', () => {
    const api = graph()
    delete (api['41'].inputs as Record<string, unknown>).align
    applyUpscaleToApi(api, {
      mode: 'p',
      megapixels: 1,
      p: 1080,
      scale: 2,
      width: 1376,
      height: 768,
      align: 32
    }, '39')
    expect('align' in (api['41'].inputs ?? {})).toBe(false)
  })

  it('图里没有放大节点时不抛，只报没写', () => {
    expect(
      applyUpscaleToApi({ '39': { class_type: 'ComfyMiniMaxH3DirectorOpt', inputs: {} } }, {
        mode: 'megapixels',
        megapixels: 1,
        p: 720,
        scale: 2,
        width: 1376,
        height: 768,
        align: 32
      }, '39')
    ).toEqual({ nodeId: null, applied: [] })
  })
})

describe('applySigmasText', () => {
  it('已接 ManualSigmas：直接改它的 sigmas 文本', () => {
    const api = graph()
    const r = applySigmasText(api, '39', 'second_sigmas', '0.9, 0.6, 0.3, 0')
    expect(r).toEqual({ nodeId: '52', created: false, applied: true })
    expect(api['52'].inputs?.sigmas).toBe('0.9, 0.6, 0.3, 0')
  })

  it('没接线：新建一个 ManualSigmas 并接到对应口（一采是 sigmas）', () => {
    const api = graph()
    const r = applySigmasText(api, '39', 'sigmas', '0.85, 0.5')
    expect(r.created).toBe(true)
    const id = r.nodeId as string
    expect(api[id].class_type).toBe('ManualSigmas')
    expect(api[id].inputs?.sigmas).toBe('0.85, 0.5')
    expect(api['39'].inputs?.sigmas).toEqual([id, 0])
  })

  it('新节点 id 不与现有节点撞车', () => {
    const api = graph()
    const r = applySigmasText(api, '39', 'sigmas', '0.5, 0')
    expect(Number(r.nodeId)).toBeGreaterThan(52)
  })

  it('口上接的是别的调度节点就不抢（尊重用户在图上自己接的）', () => {
    const api = graph()
    api['60'] = { class_type: 'BasicScheduler', inputs: { scheduler: 'simple' } }
    api['39'].inputs!.sigmas = ['60', 0]
    const r = applySigmasText(api, '39', 'sigmas', '0.9, 0.5')
    expect(r).toEqual({ nodeId: '60', created: false, applied: false })
    expect(api['60'].inputs?.scheduler).toBe('simple')
  })

  it('空文本什么都不改（"没填"和"填空"不能有两种行为）', () => {
    const api = graph()
    expect(applySigmasText(api, '39', 'sigmas', '  ')).toEqual({
      nodeId: null,
      created: false,
      applied: false
    })
    expect('sigmas' in (api['39'].inputs ?? {})).toBe(false)
  })
})

describe('sigmasStepCount / secondSampleFor', () => {
  it('步数 = 条数 − 1（节点侧就是这么算的）', () => {
    expect(sigmasStepCount('0.85, 0.5')).toBe(1)
    expect(sigmasStepCount('0.85, 0.725, 0.4219, 0')).toBe(3)
    expect(sigmasStepCount('')).toBe(0)
    expect(sigmasStepCount('0.5')).toBe(0)
  })

  it('只有「二采直出」才触发 secondSample', () => {
    expect(secondSampleFor('off', [0, 1], 4)).toEqual({ enabled: false, indices: [] })
    expect(secondSampleFor('pair', [0, 1], 4)).toEqual({ enabled: false, indices: [] })
    expect(secondSampleFor('direct', [1, 3], 4)).toEqual({ enabled: true, indices: [1, 3] })
    // 没勾段 = 全部段
    expect(secondSampleFor('direct', [], 3)).toEqual({ enabled: true, indices: [0, 1, 2] })
  })
})

describe('applySecondSample（时间线）', () => {
  it('打开：写在顶层（节点两种位置都认，但我们统一写顶层）', () => {
    const tl = applySecondSample({ segments: [] }, { enabled: true, indices: [2, 0] })
    expect(tl.secondSample).toEqual({ enabled: true, indices: [0, 2] })
  })

  it('关掉：顶层和 output 里都清掉，否则每次都偷偷跳过一采', () => {
    const tl = applySecondSample(
      {
        secondSample: { enabled: true, indices: [0] },
        output: { secondSample: { enabled: true, indices: [0] }, second_sample: { enabled: true } }
      },
      { enabled: false, indices: [] }
    )
    expect('secondSample' in tl).toBe(false)
    const out = tl.output as Record<string, unknown>
    expect('secondSample' in out).toBe(false)
    expect('second_sample' in out).toBe(false)
  })

  it('不改原对象（模板是共享的）', () => {
    const src = { secondSample: { enabled: true, indices: [0] } }
    applySecondSample(src, { enabled: false, indices: [] })
    expect(src.secondSample).toEqual({ enabled: true, indices: [0] })
  })
})

describe('二采的两个固定值', () => {
  it('种子默认用节点内置的固定值（20240），不是早期从工作流抄来的那个大数', () => {
    expect(SECOND_SEED_FIXED).toBe(20240)
    expect(secondSeedOf(undefined)).toBe(20240)
    expect(secondSeedOf({ secondSeed: 156680013701846 })).toBe(20240)
  })

  it('用户自己填过的种子原样保留', () => {
    expect(secondSeedOf({ secondSeed: 7 })).toBe(7)
    expect(secondSeedOf({ secondSeed: 0 })).toBe(0)
  })

  it('采样器：节点的「跟随一采」归一成空串，具体名字原样带过去', () => {
    expect(secondSamplerOf('跟随一采')).toBe('')
    expect(secondSamplerOf('')).toBe('')
    expect(secondSamplerOf(undefined)).toBe('')
    expect(secondSamplerOf('euler')).toBe('euler')
    expect(secondSamplerOf(' dpmpp_2m ')).toBe('dpmpp_2m')
  })
})
