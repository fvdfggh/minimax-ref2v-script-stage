import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { db, setDbImpl, setKvImpl } from '@/db'
import { createMemoryDb, createMemoryKv } from '@/db/memory'
import { useRegistryStore } from './registry'
import { addGroup, sheetOf } from '@/domain/refSheet'
import type { Entity } from '@/domain/types'

const PID = 'p1'

function ent(patch: Partial<Entity> = {}): Entity {
  return {
    id: 'e1',
    projectId: PID,
    name: '陈默',
    type: 'character',
    kind: 'speaking',
    subjectN: 1,
    sx: 1,
    pictureN: null,
    voiceDesc: null,
    textDesc: '三十岁出头，短发，深灰工装外套，右眉一道旧疤',
    createdAt: 1,
    updatedAt: 1,
    ...patch
  } as Entity
}

const png = (name = 'a.png') =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })

async function setup(e = ent()) {
  await db.entities.put(e)
  const registry = useRegistryStore()
  await registry.load(PID)
  return registry
}

beforeEach(() => {
  setActivePinia(createPinia())
  setDbImpl(createMemoryDb())
  setKvImpl(createMemoryKv())
})

describe('设定图组：素材层', () => {
  it('设定图原图不占 Picture N（否则多组并存会把参考槽挤爆）', async () => {
    const registry = await setup()
    const a = await registry.addSheetImage(PID, 'e1', png(), '基模头')
    const b = await registry.addSheetImage(PID, 'e1', png(), '三视图')
    expect(a.pictureN).toBe(0)
    expect(b.pictureN).toBe(0)
    expect(a.kind).toBe('sheet')
    expect(a.refId).toBe('e1')
    // 文件名带主体 id：同一目录下多张图不能互相覆盖
    expect(a.fileName).toMatch(/^sheet_e1_/)
    expect(a.fileName).not.toBe(b.fileName)
  })

  it('按主体列出设定图，别的实体的不混进来', async () => {
    const registry = await setup()
    await registry.addSheetImage(PID, 'e1', png(), '基模头')
    expect(registry.sheetAssetsOf('e1')).toHaveLength(1)
    expect(registry.sheetAssetsOf('e2')).toHaveLength(0)
  })

  it('把某张设定图定为参考图：像素覆盖进 Picture N，编号不变', async () => {
    const registry = await setup(ent({ pictureN: null }))
    const head = await registry.addSheetImage(PID, 'e1', png('head.png'), '基模头')
    await registry.useSheetImageAsReference(PID, 'e1', head.id)

    const after = registry.entityById.get('e1')!
    expect(after.pictureN).toBe(1)
    const ref = registry.subjectImageFor('e1')!
    expect(ref.kind).toBe('subject')
    expect(ref.id).not.toBe(head.id)
    // 设定图原图还在（组里要用），参考图是另存的一份
    expect(registry.sheetAssetsOf('e1')).toHaveLength(1)
  })

  it('换一张设定图当参考图时复用同一个 Picture N，不新增槽位', async () => {
    const registry = await setup(ent({ pictureN: null }))
    const a = await registry.addSheetImage(PID, 'e1', png(), '组头')
    const b = await registry.addSheetImage(PID, 'e1', png(), '三视图')
    await registry.useSheetImageAsReference(PID, 'e1', a.id)
    const first = registry.entityById.get('e1')!.pictureN
    await registry.useSheetImageAsReference(PID, 'e1', b.id)
    expect(registry.entityById.get('e1')!.pictureN).toBe(first)
    expect(registry.assets.filter((x) => x.pictureN > 0)).toHaveLength(1)
  })

  it('删一张设定图：组里的引用和素材本身一起消失', async () => {
    const registry = await setup()
    const head = await registry.addSheetImage(PID, 'e1', png(), '组头')
    await registry.setRefSheet(
      'e1',
      addGroup(sheetOf({}), {
        id: 'g1',
        label: '造型 1',
        headId: head.id,
        viewIds: [],
        createdAt: 1
      })
    )
    await registry.removeSheetImage('e1', head.id)

    const s = sheetOf(registry.entityById.get('e1')!)
    expect(s.groups[0].headId).toBeNull()
    expect(registry.assets.some((a) => a.id === head.id)).toBe(false)
  })

  it('删主体时设定图一并清理，不留孤儿文件', async () => {
    const registry = await setup()
    const head = await registry.addSheetImage(PID, 'e1', png(), '基模头')
    await registry.setRefSheet('e1', { masterId: head.id, groups: [], active: null })
    await registry.removeEntity('e1')
    expect(registry.assets.some((a) => a.id === head.id)).toBe(false)
  })
})
