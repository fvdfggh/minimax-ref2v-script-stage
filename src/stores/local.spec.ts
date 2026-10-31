/**
 * 模型候选映射的测试。
 *
 * 只测纯函数 `kindsForParam` —— store 本体要连后端 kv，不适合放进单测。
 * 这个映射是"下拉里有没有东西可选"的关键：映射错了，用户看到的就是
 * 一个只有当前值、点不开的下拉。
 */
import { describe, expect, it } from 'vitest'
import { kindsForParam } from './local'

describe('kindsForParam —— 参数名 → 模型类别', () => {
  it('主模型类参数归到 model', () => {
    for (const name of ['ckpt_name', 'unet_name', 'model_name', 'base_model', 'unet', 'dit']) {
      expect(kindsForParam(name), name).toEqual(['model'])
    }
  })

  it('LoRA / VAE / 放大各归各类', () => {
    expect(kindsForParam('lora_name')).toEqual(['lora'])
    expect(kindsForParam('vae_name')).toEqual(['vae'])
    expect(kindsForParam('upscale_model')).toEqual(['upscale'])
    expect(kindsForParam('latent_upscale_model')).toEqual(['upscale'])
  })

  it('CLIP Vision 不能被普通 clip 规则抢走', () => {
    // 两条规则都含 clip，必须先命中更具体的那条
    expect(kindsForParam('clip_vision_name')).toEqual(['clip_vision'])
    expect(kindsForParam('clip_name')).toEqual(['clip'])
  })

  it('杂项参数不瞎猜 —— 返回空，控件退化成自由输入', () => {
    // 给错候选比不给更糟：用户会以为那就是全部可选值
    for (const name of ['steps', 'cfg', 'seed', 'device', 'precision', 'align']) {
      expect(kindsForParam(name), name).toEqual([])
    }
  })

  it('H3 目录里的真实参数名能命中', () => {
    expect(kindsForParam('model')).toEqual(['model'])
    expect(kindsForParam('audio_vae')).toEqual(['vae'])
    expect(kindsForParam('asr_model_path')).toEqual(['audio'])
  })
})
