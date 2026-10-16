import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setDbImpl, setKvImpl } from '@/db'
import { createMemoryDb, createMemoryKv } from '@/db/memory'
import { useImageStore } from './images'
import type { Entity } from '@/domain/types'

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

beforeEach(() => {
  setActivePinia(createPinia())
  setDbImpl(createMemoryDb())
  setKvImpl(createMemoryKv())
})

describe('imageStore 提示词构造', () => {
  it('角色主体 → 全身 + 中性背景；场景实体 → 空镜环境', () => {
    const s = useImageStore()
    const char = s.subjectPrompt(ent({ id: 'e1', name: '阿明', type: 'character', textDesc: '黑发青年，穿灰外套' }))
    expect(char).toContain('character reference')
    expect(char).toContain('阿明')
    expect(char).toContain('黑发青年')

    const scene = s.subjectPrompt(ent({ id: 'e2', name: '客厅', type: 'scene', textDesc: '昏暗的客厅，暖黄灯光' }))
    expect(scene).toContain('environment reference')
    expect(scene).toContain('客厅')
    expect(scene).not.toContain('character reference')
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
