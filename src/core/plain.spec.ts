import { describe, expect, it } from 'vitest'
import { computed, reactive, ref, shallowRef } from 'vue'
import { deepClone, toPlain } from './plain'

describe('deepClone（拷一份再改的地方都走它）', () => {
  it('reactive 对象可以直接拷 —— 这是 structuredClone 会炸的那种输入', () => {
    const src = reactive({ id: 'runc_1', name: '整集 8 卡', nested: { cards: '0,1,2,3' }, list: [1, 2] })

    // 先确认这个前提真实存在：直接结构化克隆代理必抛 DataCloneError
    expect(() => structuredClone(src)).toThrow()

    const copy = deepClone(src)
    expect(copy).toEqual({ id: 'runc_1', name: '整集 8 卡', nested: { cards: '0,1,2,3' }, list: [1, 2] })
  })

  it('拷出来的是普通对象，不是代理：还能再 structuredClone', () => {
    const copy = deepClone(reactive({ a: 1 }))
    expect(() => structuredClone(copy)).not.toThrow()
  })

  it('深拷贝：改副本不影响源', () => {
    const src = reactive({ nested: { steps: 20 }, list: [{ k: 1 }] })
    const copy = deepClone(src)
    copy.nested.steps = 8
    copy.list[0].k = 99
    expect(src.nested.steps).toBe(20)
    expect(src.list[0].k).toBe(1)
  })

  it('数组元素（Pinia 列表里取出来的那种）也能拷', () => {
    const list = ref([{ id: 'wft_1', name: '模板 A' }, { id: 'wft_2', name: '模板 B' }])
    const copy = deepClone(list.value[0])
    expect(copy).toEqual({ id: 'wft_1', name: '模板 A' })
    expect(() => structuredClone(copy)).not.toThrow()
  })

  it('computed 包着的值先解包再拷', () => {
    const src = ref([{ key: 'a' }])
    const c = computed(() => src.value)
    expect(deepClone(c)).toEqual([{ key: 'a' }])
  })

  it('Date / Map 这类宿主对象保留语义（structuredClone 那一层还在起作用）', () => {
    const at = new Date('2026-10-28T00:00:00Z')
    const copy = deepClone(reactive({ at, map: new Map([['k', 1]]) }))
    expect(copy.at instanceof Date).toBe(true)
    expect(copy.at.getTime()).toBe(at.getTime())
    expect(copy.at).not.toBe(at)
  })

  it('带函数的值不抛（structuredClone 不认，退回 toPlain 那份）', () => {
    const fn = () => 1
    const copy = deepClone(reactive({ name: 'x', fn }))
    expect(copy.name).toBe('x')
    expect(copy.fn).toBe(fn)
  })

  it('空值 / 原始值原样返回', () => {
    expect(deepClone(null)).toBeNull()
    expect(deepClone(undefined)).toBeUndefined()
    expect(deepClone(0)).toBe(0)
    expect(deepClone('s')).toBe('s')
    expect(deepClone(false)).toBe(false)
  })

  it('shallowRef 里的对象也能拷（不触发代理，但走到同一个入口）', () => {
    const s = shallowRef({ a: { b: 2 } })
    expect(deepClone(s.value)).toEqual({ a: { b: 2 } })
  })
})

describe('toPlain（IndexedDB 写入前剥代理）', () => {
  it('ref 解包、reactive 剥成普通对象', () => {
    const v = ref({ a: reactive({ b: 1 }) })
    const plain = toPlain(v)
    expect(plain).toEqual({ a: { b: 1 } })
    expect(() => structuredClone(plain)).not.toThrow()
  })

  it('未知类实例不深拷，保持引用（避免破坏语义）', () => {
    class Foo {
      x = 1
    }
    const foo = new Foo()
    expect(toPlain({ foo }).foo).toBe(foo)
  })
})
