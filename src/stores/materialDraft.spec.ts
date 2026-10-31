/**
 * 新增素材 = 建一条空白提示词的草稿。
 *
 * 这组测试守两条线：
 *   1. 草稿**不进** keyframesOf / refImagesOf / 打包 —— 否则导演包会拿到
 *      一张没有本体的图，导入端只能报"首帧关键帧没有图片本体"。
 *   2. 草稿**不吃** <Picture N> —— 删一条草稿不该在编号里留一个洞。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { db, setDbImpl, setKvImpl } from '@/db'
import { createMemoryDb, createMemoryKv } from '@/db/memory'
import { useRegistryStore } from './registry'
import { beatTrackOf, draftsOf, frameOf, keyframesOf, materialsOf, refImagesOf, slotDraftsOf } from '@/domain/references'

const PID = 'p1'
const BEAT = 'b1'

async function setup() {
  const registry = useRegistryStore()
  await registry.load(PID)
  return registry
}

beforeEach(() => {
  setActivePinia(createPinia())
  setDbImpl(createMemoryDb())
  setKvImpl(createMemoryKv())
})

describe('createDraftAsset：新增即一条空白提示词', () => {
  it('新建的素材没有图、提示词为空、不占 Picture 编号', async () => {
    const registry = await setup()
    const a = await registry.createDraftAsset(PID, BEAT)
    expect(a.draft).toBe(true)
    expect(a.pictureN).toBe(0)
    expect(a.prompt).toBe('')
    expect(a.refAssetIds).toEqual([])
    expect(a.kind).toBe('keyframe')
    expect(a.refId).toBe(BEAT)
    expect(a.blob).toBeUndefined()
  })

  it('草稿不出现在关键帧 / 参考图列表里，但 draftsOf 能查到', async () => {
    const registry = await setup()
    const a = await registry.createDraftAsset(PID, BEAT)
    expect(keyframesOf(registry.assets, BEAT)).toEqual([])
    expect(refImagesOf(registry.assets, BEAT)).toEqual([])
    expect(draftsOf(registry.assets, BEAT).map((x) => x.id)).toEqual([a.id])
  })

  it('图片槽记住勾选的参考图与那句口语要求', async () => {
    const registry = await setup()
    const a = await registry.createDraftAsset(PID, BEAT, {
      prompt: 'rainy alley',
      promptBrief: '雨夜巷口，他回头',
      refAssetIds: ['ast_1', 'ast_2']
    })
    expect(a.refAssetIds).toEqual(['ast_1', 'ast_2'])
    expect(a.promptBrief).toBe('雨夜巷口，他回头')
    // 再改一次也走同一个字段
    await registry.updateAsset(a.id, { refAssetIds: ['ast_2'], prompt: 'next' })
    const got = registry.assets.find((x) => x.id === a.id)!
    expect(got.refAssetIds).toEqual(['ast_2'])
    expect(got.prompt).toBe('next')
  })

  it('草稿切到参考方式也不占号（占号会在删掉后留一个空洞）', async () => {
    const registry = await setup()
    const a = await registry.createDraftAsset(PID, BEAT)
    await registry.setBeatAssetActAs(a.id, 'reference')
    const after = registry.assets.find((x) => x.id === a.id)!
    expect(after.actAs).toBe('reference')
    expect(after.pictureN).toBe(0)
    // 仍然不算"这一段的参考图"：没有图本体
    expect(refImagesOf(registry.assets, BEAT)).toEqual([])
  })

  it('提示词能直接改在素材上，刷新后还在', async () => {
    const registry = await setup()
    const a = await registry.createDraftAsset(PID, BEAT)
    await registry.updateAsset(a.id, { prompt: 'Rainy alley, he turns his head' })
    // 重新从库里读一遍（模拟刷新）
    const again = useRegistryStore()
    await again.load(PID)
    const got = again.assets.find((x) => x.id === a.id)!
    expect(got.prompt).toBe('Rainy alley, he turns his head')
    expect(got.draft).toBe(true)
  })

  it('同一段可以有多条草稿，各自带自己的提示词', async () => {
    const registry = await setup()
    const a = await registry.createDraftAsset(PID, BEAT)
    const b = await registry.createDraftAsset(PID, BEAT)
    await registry.updateAsset(a.id, { prompt: 'first' })
    await registry.updateAsset(b.id, { prompt: 'second' })
    expect(draftsOf(registry.assets, BEAT)).toHaveLength(2)
    expect(draftsOf(registry.assets, BEAT).map((x) => x.prompt)).toEqual(['first', 'second'])
  })

  it('草稿删掉就彻底消失，不会在统计里留影子', async () => {
    const registry = await setup()
    const a = await registry.createDraftAsset(PID, BEAT)
    await registry.removeAsset(a.id)
    expect(draftsOf(registry.assets, BEAT)).toEqual([])
    expect(keyframesOf(registry.assets, BEAT)).toEqual([])
  })
})

describe('createDraftAsset({ media: "audio" })：待配音槽', () => {
  it('建出来是一条 material 草稿：文本与音色都记在它上面', async () => {
    const registry = await setup()
    const a = await registry.createDraftAsset(PID, BEAT, {
      media: 'audio',
      voiceText: '还是一杯热的，不要糖。',
      voiceSpeakerId: 'ent_1',
      frameIdx: 12
    })
    expect(a.draft).toBe(true)
    expect(a.kind).toBe('material')
    expect(a.media).toBe('audio')
    expect(a.voiceText).toBe('还是一杯热的，不要糖。')
    expect(a.voiceSpeakerId).toBe('ent_1')
    expect(a.frameIdx).toBe(12)
    // 没有本体：不占号、没有时长
    expect(a.pictureN).toBe(0)
    expect(a.durationSec).toBeUndefined()
  })

  it('不参与打包：轨道 / 音视频列表都看不到它', async () => {
    const registry = await setup()
    await registry.createDraftAsset(PID, BEAT, { media: 'audio', voiceText: 'hi' })
    expect(materialsOf(registry.assets, BEAT)).toEqual([])
    expect(beatTrackOf(registry.assets, BEAT, 60)).toEqual([])
  })

  it('slotDraftsOf 同时认图片槽与音频槽，draftsOf 只认图片', async () => {
    const registry = await setup()
    const img = await registry.createDraftAsset(PID, BEAT, { prompt: 'rainy alley' })
    const aud = await registry.createDraftAsset(PID, BEAT, { media: 'audio', voiceText: 'hi' })
    expect(slotDraftsOf(registry.assets, BEAT).map((x) => x.id)).toEqual([img.id, aud.id])
    expect(draftsOf(registry.assets, BEAT).map((x) => x.id)).toEqual([img.id])
  })

  it('参考方式的音频槽同样不占时间轴，但仍是可编辑的占位', async () => {
    const registry = await setup()
    const a = await registry.createDraftAsset(PID, BEAT, {
      media: 'audio',
      actAs: 'reference',
      voiceText: '借个音色'
    })
    expect(a.actAs).toBe('reference')
    expect(materialsOf(registry.assets, BEAT)).toEqual([])
    expect(slotDraftsOf(registry.assets, BEAT).map((x) => x.id)).toEqual([a.id])
  })
})

describe('任意素材都能选到任意帧', () => {
  it('参考图改帧位：只落帧号，作用方式仍然是参考', async () => {
    const registry = await setup()
    const a = await registry.createDraftAsset(PID, BEAT, { actAs: 'reference', prompt: 'landscape' })
    await registry.setAssetFrameAt(a.id, 18, 60)
    const got = registry.assets.find((x) => x.id === a.id)!
    expect(got.frameIdx).toBe(18)
    expect(got.actAs).toBe('reference')
    // 参考图不进时间轴：它不因为有了帧号就变成关键帧
    expect(keyframesOf(registry.assets, BEAT)).toEqual([])
    expect(refImagesOf(registry.assets, BEAT)).toEqual([]) // 仍是草稿
  })

  it('帧位越界夹到段内（和关键帧同一个夹取规则）', async () => {
    const registry = await setup()
    const a = await registry.createDraftAsset(PID, BEAT, { media: 'audio', voiceText: 'hi' })
    await registry.setAssetFrameAt(a.id, 999, 60)
    expect(registry.assets.find((x) => x.id === a.id)!.frameIdx).toBe(59)
  })

  it('图片槽能配到指定帧：frameOf 按配置的帧号算，不再恒为段首', async () => {
    const registry = await setup()
    const a = await registry.createDraftAsset(PID, BEAT, {
      actAs: 'reference',
      frameIdx: 24
    })
    expect(a.frameIdx).toBe(24)
    expect(frameOf(a, 60)).toBe(24)
  })
})
