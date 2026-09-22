import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { db } from '@/db'
import { useProviderStore } from './provider'

async function freshDb() {
  await db.delete()
  await db.open()
}

describe('供应商就绪判定 ready', () => {
  beforeEach(async () => {
    await freshDb()
    setActivePinia(createPinia())
  })

  it('三个字段缺一不可：baseUrl / apiKey / model', async () => {
    const p = useProviderStore()
    await p.load()
    const id = p.current!.id

    await p.update(id, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '' })
    expect(p.ready).toBe(false)

    await p.update(id, { apiKey: 'sk-x' })
    expect(p.ready).toBe(true)

    await p.update(id, { model: '' })
    expect(p.ready).toBe(false)
  })

  it('★ 勾了「仅本次会话」时 Key 不落库，但同一会话内必须仍然是就绪的', async () => {
    const p = useProviderStore()
    await p.load()
    const id = p.current!.id

    await p.update(id, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-session-only',
      sessionOnly: true
    })

    // 落库的那份 Key 是空的
    const persisted = await db.providers.get(id)
    expect(persisted?.apiKey).toBe('')
    // 但实际可用
    expect(p.resolved()?.apiKey).toBe('sk-session-only')
    expect(p.ready).toBe(true)
  })

  it('★ 再次 load() 会从库里重读（切项目时会触发），会话 Key 必须从内存补回来', async () => {
    const p = useProviderStore()
    await p.load()
    const id = p.current!.id

    await p.update(id, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-session-only',
      sessionOnly: true
    })
    expect(p.ready).toBe(true)

    // WorkbenchView.boot() 在切换项目时会再跑一次 load()
    await p.load()
    expect(p.current!.apiKey).toBe('')

    // 修复前这里会变成 false —— 表现就是页面上所有 AI 按钮集体变灰、点不动
    expect(p.ready).toBe(true)
  })

  it('刷新页面后会话 Key 真的丢了，此时就该是未就绪', async () => {
    const first = useProviderStore()
    await first.load()
    await first.update(first.current!.id, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-session-only',
      sessionOnly: true
    })
    expect(first.ready).toBe(true)

    // 新页面 = 全新的 pinia 实例，内存里的会话 Key 不复存在
    setActivePinia(createPinia())
    const second = useProviderStore()
    await second.load()
    expect(second.ready).toBe(false)
  })

  it('删除供应商时一并清掉内存里的会话 Key', async () => {
    const p = useProviderStore()
    await p.load()
    const id = p.current!.id
    await p.update(id, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-session-only',
      sessionOnly: true
    })

    await p.remove(id)
    expect(p.resolved()).toBeNull()
    expect(p.ready).toBe(false)
  })
})
