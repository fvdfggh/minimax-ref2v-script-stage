import { describe, expect, it } from 'vitest'
import {
  applyTemplateToApi,
  buildUpscaleMode,
  estimateUpscaleSize,
  parseApiWorkflow,
  upgradeUint8CreateVideo,
  upscaleValuesFromApi,
  valuesFromApi
} from './workflow'
import type { ApiWorkflow } from './workflow'

/**
 * 测试用工作流：刻意复刻真实工作流的两个坑
 *   1. 导演节点 width/height 是基座尺寸，不该出现在参数卡片里
 *   2. 放大节点的 mode 是 COMFY_DYNAMICCOMBO_V3 —— 主键放字符串，
 *      子参数平铺成 mode.*（写成嵌套 dict 会让 ComfyUI 收不到 mode）
 */
const api: ApiWorkflow = {
  '39': {
    class_type: 'ComfyMiniMaxH3DirectorOpt',
    inputs: { width: 864, height: 480, timeline_data: '{}', steps: 3 }
  },
  '41': {
    class_type: 'MiniMaxH3LatentUpscaleModelOpt',
    inputs: {
      model_name: 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
      mode: 'megapixels',
      'mode.megapixels': 1,
      align: 32,
      enable_temporal_chunking: true,
      force_unload: true,
      device: 'cuda',
      precision: 'fp16'
    }
  },
  '2': {
    class_type: 'CLIPLoader',
    inputs: { clip_name: 'qwen3vl.safetensors', type: 'minimax', device: 'default' }
  },
  '4': {
    class_type: 'LoraLoaderModelOnly',
    inputs: { model: ['1', 0], lora_name: 'turbo.safetensors', strength_model: 0.75 }
  }
}

describe('parseApiWorkflow', () => {
  it('跳过渡演节点与连线，只留可配参数', () => {
    const nodes = parseApiWorkflow(api)
    const types = nodes.map((n) => n.type)
    expect(types).not.toContain('ComfyMiniMaxH3DirectorOpt')

    const lora = nodes.find((n) => n.type === 'LoraLoaderModelOnly')
    expect(lora).toBeTruthy()
    // model 是连线（数组），不该出现在参数里
    expect(lora!.params.map((p) => p.key)).toEqual(['lora_name', 'strength_model'])
  })

  it('放大节点被标记为专用面板', () => {
    const up = parseApiWorkflow(api).find((n) => n.type === 'MiniMaxH3LatentUpscaleModelOpt')
    expect(up?.panel).toBe('upscale')
  })

  it('空工作流返回空列表', () => {
    expect(parseApiWorkflow(null)).toEqual([])
  })
})

describe('valuesFromApi', () => {
  it('不收集数组（连线）与对象（复合输入）', () => {
    const values = valuesFromApi(api)
    expect(values['LoraLoaderModelOnly#0.lora_name']).toBe('turbo.safetensors')
    expect(values['CLIPLoader#0.device']).toBe('default')
    // 导演节点整条被排除
    expect(Object.keys(values).some((k) => k.startsWith('ComfyMiniMaxH3DirectorOpt'))).toBe(false)
  })
})

describe('upscaleValuesFromApi', () => {
  it('从 mode.* 平铺键里取出子参数', () => {
    const v = upscaleValuesFromApi(api)
    expect(v?.mode).toBe('megapixels')
    expect(v?.megapixels).toBe(1)
    expect(v?.align).toBe(32)
    expect(v?.precision).toBe('fp16')
  })

  it('子参数取的是真实值，不是默认值兜底', () => {
    const flat: ApiWorkflow = {
      '41': {
        class_type: 'MiniMaxH3LatentUpscaleModelOpt',
        inputs: { mode: 'megapixels', 'mode.megapixels': 1.5, align: 64 }
      }
    }
    const v = upscaleValuesFromApi(flat)
    expect(v?.megapixels).toBe(1.5)
    expect(v?.align).toBe(64)
  })

  it('没有放大节点时返回 null', () => {
    expect(upscaleValuesFromApi({})).toBeNull()
  })
})

describe('buildUpscaleMode', () => {
  it('倍率模式只带 scale', () => {
    expect(buildUpscaleMode({ mode: 'scale by multiplier', scale: 2.5, megapixels: 4 })).toEqual({
      mode: 'scale by multiplier',
      scale: 2.5
    })
  })

  it('目标尺寸模式带 width/height', () => {
    expect(buildUpscaleMode({ mode: 'target dimensions', width: 1280, height: 704 })).toEqual({
      mode: 'target dimensions',
      width: 1280,
      height: 704
    })
  })

  it('像素量模式带 megapixels', () => {
    expect(buildUpscaleMode({ mode: 'megapixels', megapixels: 2 })).toEqual({
      mode: 'megapixels',
      megapixels: 2
    })
  })
})

describe('applyTemplateToApi', () => {
  it('放大模式按 DYNAMICCOMBO 的写法落：mode 是字符串，子值平铺成 mode.*', () => {
    const { api: next } = applyTemplateToApi(api, {
      'MiniMaxH3LatentUpscaleModelOpt#0.mode': 'target dimensions',
      'MiniMaxH3LatentUpscaleModelOpt#0.width': 1728,
      'MiniMaxH3LatentUpscaleModelOpt#0.height': 960,
      'MiniMaxH3LatentUpscaleModelOpt#0.precision': 'bf16',
      'LoraLoaderModelOnly#0.strength_model': 0.5
    })

    const up = next['41'].inputs as Record<string, unknown>
    // ★ mode 必须是字符串。写成 dict 时 ComfyUI 认不出来，会把 mode 当成没传，
    //   二采节点报 execute() missing 1 required positional argument: 'mode'。
    expect(up.mode).toBe('target dimensions')
    expect(up['mode.width']).toBe(1728)
    expect(up['mode.height']).toBe(960)
    expect(up.precision).toBe('bf16')
    expect((next['4'].inputs as Record<string, unknown>).strength_model).toBe(0.5)
  })

  it('切模式时清掉上一次的 mode.* 残留', () => {
    // 基线是 megapixels；这里换成倍率模式，mode.megapixels 不该留着
    const { api: next } = applyTemplateToApi(api, {
      'MiniMaxH3LatentUpscaleModelOpt#0.mode': 'scale by multiplier',
      'MiniMaxH3LatentUpscaleModelOpt#0.scale': 2
    })
    const up = next['41'].inputs as Record<string, unknown>
    expect(up.mode).toBe('scale by multiplier')
    expect(up['mode.scale']).toBe(2)
    expect(up['mode.megapixels']).toBeUndefined()
  })

  it('像素量模式回落 mode.megapixels', () => {
    const { api: next } = applyTemplateToApi(api, {
      'MiniMaxH3LatentUpscaleModelOpt#0.mode': 'megapixels',
      'MiniMaxH3LatentUpscaleModelOpt#0.megapixels': 1.5
    })
    const up = next['41'].inputs as Record<string, unknown>
    expect(up.mode).toBe('megapixels')
    expect(up['mode.megapixels']).toBe(1.5)
  })

  it('不改原对象', () => {
    applyTemplateToApi(api, { 'LoraLoaderModelOnly#0.strength_model': 0.1 })
    expect((api['4'].inputs as Record<string, unknown>).strength_model).toBe(0.75)
  })

  it('找不到落点的参数进入 skipped，不静默丢弃', () => {
    const { skipped } = applyTemplateToApi(api, {
      'TESpeedMiniMaxH3#0.speed': 0.4,
      'LoraLoaderModelOnly#0.not_a_param': 1
    })
    expect(skipped).toContain('TESpeedMiniMaxH3#0.speed')
    expect(skipped).toContain('LoraLoaderModelOnly#0.not_a_param')
  })

  it('换工作流后节点 id 变了也能对上（按类型+序号定位）', () => {
    const reordered: ApiWorkflow = {
      '77': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'x', strength_model: 1 } }
    }
    const { api: next } = applyTemplateToApi(reordered, {
      'LoraLoaderModelOnly#0.strength_model': 0.3
    })
    expect((next['77'].inputs as Record<string, unknown>).strength_model).toBe(0.3)
  })

  it('同类型多节点的序号按 id 数值排序，不随 JSON 插入顺序漂移', () => {
    // 故意把 id 大的写在前面：如果按插入顺序编号，#0 会落到 22 号节点上
    const multi: ApiWorkflow = {
      '22': { class_type: 'VAELoader', inputs: { vae_name: 'audio_vae.safetensors' } },
      '5': { class_type: 'VAELoader', inputs: { vae_name: 'video_vae.safetensors' } }
    }
    const values = valuesFromApi(multi)
    expect(values['VAELoader#0.vae_name']).toBe('video_vae.safetensors')
    expect(values['VAELoader#1.vae_name']).toBe('audio_vae.safetensors')

    const { api: next } = applyTemplateToApi(multi, {
      'VAELoader#1.vae_name': 'replaced.safetensors'
    })
    expect((next['22'].inputs as Record<string, unknown>).vae_name).toBe('replaced.safetensors')
    expect((next['5'].inputs as Record<string, unknown>).vae_name).toBe('video_vae.safetensors')
  })
})

describe('estimateUpscaleSize', () => {
  it('倍率模式按倍数放大并对齐', () => {
    const r = estimateUpscaleSize(864, 480, { mode: 'scale by multiplier', scale: 2, align: 32 })
    expect(r).toEqual({ width: 1728, height: 960, megapixels: 1.66 })
  })

  it('目标尺寸模式直接采用并向上对齐到 align', () => {
    const r = estimateUpscaleSize(864, 480, { mode: 'target dimensions', width: 1281, height: 705, align: 32 })
    expect(r.width % 32).toBe(0)
    expect(r.height % 32).toBe(0)
    expect(r.width).toBe(1280)
    expect(r.height).toBe(704)
  })

  it('像素量模式按原比例反算（二采自己的 1.0 = 1024²，864×480 → 1376×768）', () => {
    const r = estimateUpscaleSize(864, 480, { mode: 'megapixels', megapixels: 1, align: 32 })
    expect(r.width).toBe(1376)
    expect(r.height).toBe(768)
  })
})

/**
 * 负片回归：导演节点的 IMAGE 出口是 uint8 [0,255]，原生 CreateVideo 会做
 * `(frame * 255).byte()` ⇒ 整数回绕成 `256 - x`，整片正好反色，而段片段正常。
 * 提交前必须换成 H3 包自带的 U8 版建视频节点。
 */
describe('upgradeUint8CreateVideo', () => {
  const director: ApiWorkflow = {
    '39': { class_type: 'ComfyMiniMaxH3DirectorOpt', inputs: { timeline_data: '{}' } },
    '10': {
      class_type: 'CreateVideo',
      inputs: { images: ['39', 0], fps: ['39', 2], bit_depth: 8, color_space: 'sRGB', codec: 'none' }
    },
    '14': { class_type: 'SaveVideo', inputs: { video: ['10', 0], filename_prefix: 'video/x' } }
  }

  it('把 CreateVideo 换掉，并把 bit_depth 改成字符串枚举', () => {
    const r = upgradeUint8CreateVideo(director)
    expect(r.upgraded).toBe(1)
    expect(r.api['10'].class_type).toBe('MiniMaxH3CreateVideoU8Opt')
    // U8 节点的 combo 是 "8"/"10"，传数字会被 ComfyUI 校验拒掉
    expect(r.api['10'].inputs?.bit_depth).toBe('8')
    // 其余参数与连线原样保留
    expect(r.api['10'].inputs?.images).toEqual(['39', 0])
    expect(r.api['10'].inputs?.color_space).toBe('sRGB')
    expect(r.api['14'].class_type).toBe('SaveVideo')
  })

  it('10bit 模板保留 10', () => {
    const api10: ApiWorkflow = JSON.parse(JSON.stringify(director))
    api10['10'].inputs!.bit_depth = 10
    expect(upgradeUint8CreateVideo(api10).api['10'].inputs?.bit_depth).toBe('10')
  })

  it('不改入参（幂等、可重复调用）', () => {
    const before = JSON.stringify(director)
    const once = upgradeUint8CreateVideo(director)
    upgradeUint8CreateVideo(once.api)
    expect(JSON.stringify(director)).toBe(before)
  })

  it('没有导演节点时不动 —— 别的图里的 CreateVideo 拿的是 float32', () => {
    const plain: ApiWorkflow = {
      '1': { class_type: 'LoadImage', inputs: { image: 'a.png' } },
      '10': { class_type: 'CreateVideo', inputs: { images: ['1', 0], fps: 24, bit_depth: 8 } }
    }
    const r = upgradeUint8CreateVideo(plain)
    expect(r.upgraded).toBe(0)
    expect(r.api['10'].class_type).toBe('CreateVideo')
  })
})
