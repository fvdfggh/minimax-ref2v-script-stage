import { describe, expect, it } from 'vitest'
import type { DataTable } from '@/core/backend'
import { createMemoryDb, createMemoryKv } from './memory'

/**
 * 内存库是「后端唯一存储」后 store 测试的注入底座（setDbImpl/setKvImpl）。
 * 这里锁住它与后端适配器共用的 DataTable / KvStore 契约：
 * 只要这两个实现稳定，store 层就与真实后端同构。
 */
type Row = { id: string; projectId: string; order: number }

function freshTable(): DataTable<Row> {
  return createMemoryDb().beats as unknown as DataTable<Row>
}
const r = (id: string, projectId = 'p', order = 0): Row => ({ id, projectId, order })

describe('内存数据表 createMemoryDb', () => {
  it('put / get / delete / count 基本读写', async () => {
    const t = freshTable()
    await t.put(r('a'))
    await t.put(r('b'))
    expect(await t.count()).toBe(2)
    expect((await t.get('a'))?.id).toBe('a')
    await t.delete('a')
    expect(await t.get('a')).toBeUndefined()
    expect(await t.count()).toBe(1)
  })

  it('put 同 id 覆盖，bulkPut 批量写入', async () => {
    const t = freshTable()
    await t.put(r('a', 'p', 1))
    await t.put(r('a', 'p', 9))
    expect((await t.get('a'))?.order).toBe(9)
    await t.bulkPut([r('b'), r('c'), r('d')])
    expect(await t.count()).toBe(4)
  })

  it('bulkDelete 按 id 批量删除，未命中的忽略', async () => {
    const t = freshTable()
    await t.bulkPut([r('a'), r('b'), r('c')])
    await t.bulkDelete(['a', 'c', 'ghost'])
    expect(await t.count()).toBe(1)
    expect((await t.get('b'))?.id).toBe('b')
  })

  it('where().equals().toArray 只取匹配行', async () => {
    const t = freshTable()
    await t.bulkPut([r('a', 'p1'), r('b', 'p1'), r('c', 'p2')])
    const rows = await t.where('projectId').equals('p1').toArray()
    expect(rows.map((x) => x.id).sort()).toEqual(['a', 'b'])
  })

  it('where().equals().delete 只删匹配行并返回删除数', async () => {
    const t = freshTable()
    await t.bulkPut([r('a', 'p1'), r('b', 'p1'), r('c', 'p2')])
    const removed = await t.where('projectId').equals('p1').delete()
    expect(removed).toBe(2)
    const rest = await t.toArray()
    expect(rest.map((x) => x.id)).toEqual(['c'])
  })

  it('where().equals().sortBy 按字段升序', async () => {
    const t = freshTable()
    await t.bulkPut([r('a', 'p', 3), r('b', 'p', 1), r('c', 'p', 2)])
    const rows = await t.where('projectId').equals('p').sortBy('order')
    expect(rows.map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })

  it('orderBy().reverse().toArray 降序', async () => {
    const t = freshTable()
    await t.bulkPut([r('a', 'p', 1), r('b', 'p', 3), r('c', 'p', 2)])
    const rows = await t.orderBy('order').reverse().toArray()
    expect(rows.map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })

  it('各表相互隔离，互不影响', async () => {
    const db = createMemoryDb()
    const b = db.beats as unknown as DataTable<Row>
    await b.put(r('x'))
    expect(await db.entities.count()).toBe(0)
    expect(await db.assemblies.count()).toBe(0)
    expect(await b.count()).toBe(1)
  })
})

describe('内存 kv createMemoryKv', () => {
  it('set / get / delete，缺省返回 undefined', async () => {
    const kv = createMemoryKv()
    expect(await kv.get('k')).toBeUndefined()
    await kv.set('k', { n: 1 })
    expect(await kv.get<{ n: number }>('k')).toEqual({ n: 1 })
    await kv.delete('k')
    expect(await kv.get('k')).toBeUndefined()
  })

  it('同 key 覆盖写，不同 key 隔离', async () => {
    const kv = createMemoryKv()
    await kv.set('a', 1)
    await kv.set('a', 2)
    await kv.set('b', 3)
    expect(await kv.get('a')).toBe(2)
    expect(await kv.get('b')).toBe(3)
  })
})
