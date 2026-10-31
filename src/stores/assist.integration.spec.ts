import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setDbImpl, setKvImpl } from '@/db'
import { createMemoryDb, createMemoryKv } from '@/db/memory'
import { useProviderStore } from './provider'
import { usePipelineStore } from './pipeline'

/**
 * 单点助手的端到端口径：提示词 → 请求 → 清洗 → 落成一项值。
 *
 * 这里不测模型写得对不对（那没法测），测的是**中间这一段不会出错**：
 *   - 请求真的发到了 chat/completions，body 里带的是那一支提示词；
 *   - 返回带前缀 / 代码块时会被清掉，不会原样写进字段；
 *   - 拆拍返回的 JSON 会走归一（weight 夹紧、kind 白名单、假台词丢掉）。
 */

type Reply = { content: string }

let reply: Reply = { content: '' }
let lastBody: any = null

function okJson(content: string) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

beforeEach(async () => {
  setDbImpl(createMemoryDb())
  setKvImpl(createMemoryKv())
  setActivePinia(createPinia())
  lastBody = null
  const p = useProviderStore()
  await p.load()
  await p.update(p.current!.id, {
    baseUrl: 'http://127.0.0.1:9999/v1',
    apiKey: 'sk-test',
    model: 'mock'
  })
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    lastBody = JSON.parse(String(init?.body ?? '{}'))
    return okJson(reply.content)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('单点助手走通一遍', () => {
  it('写一拍的镜头描述：请求带提示词，返回的前缀被清掉', async () => {
    reply = { content: '镜头描述：中景，缓慢推近' }
    const pipeline = usePipelineStore()
    const out = await pipeline.writeBeatField({
      field: 'direction',
      beat: { title: '陈默推门进来', kind: 'action', frames: 36, fps: 24 },
      scene: '便利店 夜',
      cast: [],
      language: 'zh'
    })
    expect(out).toBe('中景，缓慢推近')
    expect(lastBody.model).toBe('mock')
    expect(String(lastBody.messages[0].content)).toContain('只写机位语言')
    expect(String(lastBody.messages[1].content)).toContain('陈默推门进来')
  })

  it('返回空内容要报错，不能把空串写进字段', async () => {
    reply = { content: '   ' }
    const pipeline = usePipelineStore()
    await expect(
      pipeline.writeBeatField({
        field: 'visualDesc',
        beat: { title: 'x', kind: 'action', frames: 36, fps: 24 },
        cast: []
      })
    ).rejects.toThrow('模型没有返回内容')
  })

  it('拆拍：JSON 归一后再交出去，weight 夹紧、假台词丢掉', async () => {
    reply = {
      content: JSON.stringify({
        beats: [
          { title: '林晚抬头', kind: 'action', weight: 0 },
          { title: '林晚回应', kind: 'dialogue', dialogue: '你每次都这么说', weight: 9 },
          { title: '  ', kind: 'action' }
        ]
      })
    }
    const pipeline = usePipelineStore()
    const parts = await pipeline.splitBeatByAi({
      beat: { title: '林晚找零并回应', kind: 'action', frames: 72, fps: 24 },
      language: 'zh'
    })
    expect(parts).toHaveLength(2)
    expect(parts[0].weight).toBe(1)
    expect(parts[1]).toMatchObject({ kind: 'dialogue', dialogue: '你每次都这么说', weight: 3 })
  })

  it('拆不出一拍以上要明确报错（而不是静默不改）', async () => {
    reply = { content: JSON.stringify({ beats: [{ title: '只有一个', kind: 'action' }] }) }
    const pipeline = usePipelineStore()
    await expect(
      pipeline.splitBeatByAi({ beat: { title: 'x', kind: 'action', frames: 36, fps: 24 } })
    ).rejects.toThrow('模型没有拆出多拍')
  })

  it('写主体的音色：上下文带原文片段与其他角色', async () => {
    reply = { content: '青年男声，偏低，略带沙哑' }
    const pipeline = usePipelineStore()
    const out = await pipeline.writeEntityDesc({
      field: 'voiceDesc',
      entity: { name: '陈默', type: 'character', kind: 'speaking' },
      storyExcerpt: '陈默推门进来，外套湿透。',
      peers: ['林晚'],
      language: 'zh'
    })
    expect(out).toBe('青年男声，偏低，略带沙哑')
    const user = String(lastBody.messages[1].content)
    expect(user).toContain('陈默推门进来')
    expect(user).toContain('林晚')
  })
})
