import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { db, setDbImpl, setKvImpl } from '@/db'
import { createMemoryDb, createMemoryKv } from '@/db/memory'
import { useImageStore, sizeToWH } from './images'
import { useRegistryStore } from './registry'
import { useBeatStore } from './beats'
import type { Beat, Entity } from '@/domain/types'

function ent(patch: Partial<Entity> & { id: string; name: string }): Entity {
  return {
    projectId: 'p1',
    type: 'character',
    kind: 'non_speaking',
    subjectN: null,
    sx: null,
    pictureN: null,
    voiceDesc: null,
    textDesc: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch
  } as Entity
}

function beat(patch: Partial<Beat> & { id: string }): Beat {
  return {
    projectId: 'p1',
    order: 1,
    kind: 'shot',
    title: '镜头',
    entities: [],
    manualFrames: false,
    locked: false,
    enriched: true,
    createdAt: 1,
    updatedAt: 1,
    ...patch
  } as Beat
}

beforeEach(() => {
  setActivePinia(createPinia())
  setDbImpl(createMemoryDb())
  setKvImpl(createMemoryKv())
})

describe('imageStore 提示词构造', () => {
  it('角色主体 → 基模头（头肩特写、头颈完整）；场景实体 → 空镜环境', () => {
    const s = useImageStore()
    const char = s.subjectPrompt(ent({ id: 'e1', name: '阿明', type: 'character', textDesc: '黑发青年，穿灰外套' }))
    // 角色的参考图就是"头"，不再是全身：全身在三视图那一步
    expect(char).toContain('head-and-shoulders portrait')
    expect(char).toContain('the whole head and the full neck are visible')
    expect(char).toContain('阿明')
    expect(char).toContain('黑发青年')

    const scene = s.subjectPrompt(ent({ id: 'e2', name: '客厅', type: 'scene', textDesc: '昏暗的客厅，暖黄灯光' }))
    expect(scene).toContain('environment reference')
    expect(scene).toContain('客厅')
    expect(scene).not.toContain('head-and-shoulders')
  })

  it('优先使用英文词条（nameEn / textDescEn），与 Ref2V 参考图语言一致', () => {
    const s = useImageStore()
    const char = s.subjectPrompt(
      ent({ id: 'e1', name: '阿明', type: 'character', textDesc: '黑发青年', nameEn: 'Aming', textDescEn: 'young man with black hair' })
    )
    expect(char).toContain('Aming')
    expect(char).toContain('young man with black hair')
  })
})

describe('关键帧提示词（本地工作流出图同样靠这一段文字）', () => {
  async function seed() {
    await db.entities.bulkPut([
      ent({ id: 'e1', name: '阿明', nameEn: 'Aming', type: 'character', textDesc: '黑发青年，灰外套' }),
      ent({ id: 'e2', name: '雨夜街道', nameEn: 'Rainy street', type: 'scene', textDesc: '霓虹反光，积水' })
    ])
    await db.beats.put(
      beat({
        id: 'b1',
        entities: ['e1', 'e2'],
        sceneId: 'e2',
        direction: '中景，缓慢推近',
        visualDesc: '阿明撑伞站在街口回头'
      })
    )
    await useRegistryStore().load('p1')
    await useBeatStore().load('p1')
    return useImageStore()
  }

  it('带上出场主体的外观描述 —— 没有参考图的工作流只能靠这句话认人', async () => {
    const s = await seed()
    const p = s.keyframePrompt('b1', 'head')
    expect(p).toContain('Characters on screen: Aming')
    expect(p).toContain('Character design: Aming (黑发青年，灰外套)')
    expect(p).toContain('Opening frame of the shot')
  })

  it('场景的名字和描述都进 Setting，且场景不会重复算成角色', async () => {
    const s = await seed()
    const p = s.keyframePrompt('b1', 'tail')
    expect(p).toContain('Setting: Rainy street — 霓虹反光，积水')
    expect(p).not.toContain('Rainy street (')
    expect(p).toContain('Final frame of the shot')
  })

  it('没有主体描述时只写名字，不留空括号', async () => {
    await db.entities.bulkPut([ent({ id: 'e3', name: '路人' })])
    await db.beats.put(beat({ id: 'b2', entities: ['e3'], visualDesc: '街角' }))
    await useRegistryStore().load('p1')
    await useBeatStore().load('p1')
    const p = useImageStore().keyframePrompt('b2')
    expect(p).toContain('Characters on screen: 路人')
    expect(p).not.toContain('路人 (')
    expect(p).not.toContain('Character design')
  })
})

describe('尺寸换算（给 ComfyUI 的 width/height）', () => {
  it('解析 1024x576 这类写法，认 × 与 *', () => {
    expect(sizeToWH('1024x576')).toEqual({ width: 1024, height: 576 })
    expect(sizeToWH('1024×576')).toEqual({ width: 1024, height: 576 })
    expect(sizeToWH(' 512 * 512 ')).toEqual({ width: 512, height: 512 })
  })

  it('认不出来就留空，让工作流用回自己的尺寸', () => {
    expect(sizeToWH(undefined)).toEqual({})
    expect(sizeToWH('big')).toEqual({})
  })
})
