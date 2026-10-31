/**
 * 批量出图的编排：**本地通道必须是"一次提交"**。
 *
 * 这条断言看着像在测实现细节，其实是在守住那个唯一的好处：
 * 一旦退化成循环调单张，文本编码器就会每张重新加载一遍 ——
 * 图还是能出来，只是慢，而且没人会注意到。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setDbImpl, setKvImpl } from '@/db'
import { createMemoryDb, createMemoryKv } from '@/db/memory'
import { useImageStore } from './images'
import { useProjectStore } from './project'
import { useBeatStore } from './beats'
import { useProviderStore } from './provider'

const { batchCalls, runCalls, chatCalls, chatReply } = vi.hoisted(() => ({
  batchCalls: [] as any[],
  runCalls: [] as any[],
  chatCalls: [] as any[],
  chatReply: { value: null as any }
}))

// AI 排布走的是文本模型通道；把它替换掉，才能断言"只出建议、不出图"
vi.mock('@/core/llm/openai', async (importOriginal) => {
  const mod = await importOriginal<Record<string, any>>()
  return {
    ...mod,
    chatJson: vi.fn(async (_p: any, messages: any[]) => {
      chatCalls.push(messages)
      return chatReply.value
    })
  }
})

vi.mock('@/core/comfyImage', () => ({
  comfyImageWorkflows: vi.fn(async () => ({
    workflows: [{ name: 'Krea2简易生成', format: 'ui', bytes: 1, mtime: 1, t2i: true }],
    dir: '',
    root: '',
    base: 'http://127.0.0.1:8188',
    exists: true
  })),
  comfyImageRun: vi.fn(async (opts: any) => {
    runCalls.push(opts)
    return { blob: new Blob(['x']), promptId: 'p', seconds: 1, report: {} }
  }),
  comfyImageBatch: vi.fn(async (opts: any) => {
    batchCalls.push(opts)
    return {
      items: opts.items.map((it: any) => ({ key: it.key, blob: new Blob([it.key]) })),
      promptId: 'pid',
      seconds: 12,
      report: { count: opts.items.length, notes: [] }
    }
  })
}))

beforeEach(() => {
  setActivePinia(createPinia())
  setDbImpl(createMemoryDb())
  setKvImpl(createMemoryKv())
  batchCalls.length = 0
  runCalls.length = 0
  chatCalls.length = 0
  chatReply.value = { shots: [] }
})

describe('images.generateBatch', () => {
  it('本地通道：N 条提示词一次提交，尺寸/步数/负向一起带过去', async () => {
    const s = useImageStore()
    await s.patchComfy({
      channel: 'comfy',
      base: 'http://127.0.0.1:8188',
      workflow: 'Krea2简易生成',
      steps: 4,
      negative: 'blurry'
    })

    const out = await s.generateBatch(
      [
        { key: 'a', prompt: 'p1' },
        { key: 'b', prompt: 'p2' }
      ],
      { size: '768x448' }
    )

    expect(batchCalls).toHaveLength(1)
    expect(runCalls).toHaveLength(0)
    expect(batchCalls[0].items.map((i: any) => i.key)).toEqual(['a', 'b'])
    expect(batchCalls[0].items.map((i: any) => i.prompt)).toEqual(['p1', 'p2'])
    expect(batchCalls[0].width).toBe(768)
    expect(batchCalls[0].height).toBe(448)
    expect(batchCalls[0].steps).toBe(4)
    expect(batchCalls[0].negative).toBe('blurry')
    // 每条都要有种子：同一句提示词连出两张不该长一样
    expect(batchCalls[0].items.every((i: any) => Number.isInteger(i.seed))).toBe(true)
    expect(out.map((o) => o.key)).toEqual(['a', 'b'])
    expect(out[0].blob).toBeTruthy()
    expect(s.batchRunning).toBe(false)
  })

  it('本地通道没选工作流：明确报错，而不是静默走云端', async () => {
    const s = useImageStore()
    await s.patchComfy({ channel: 'comfy', workflow: '' })
    await expect(s.generateBatch([{ key: 'a', prompt: 'p' }])).rejects.toThrow(/工作流/)
    expect(batchCalls).toHaveLength(0)
  })

  it('云端通道：没有"一次提交"这回事，逐条跑，一条失败不影响其他条', async () => {
    const s = useImageStore()
    await s.patchComfy({ channel: 'http' })
    const out = await s.generateBatch([
      { key: 'a', prompt: 'p1' },
      { key: 'b', prompt: 'p2' }
    ])
    // 没配云端模型 → 两条各自失败，但结果条数对得上（说明是逐条跑的）
    expect(out).toHaveLength(2)
    expect(out.every((o) => !!o.error)).toBe(true)
    expect(batchCalls).toHaveLength(0)
  })

  it('空列表直接返回，不发请求', async () => {
    const s = useImageStore()
    await s.patchComfy({ channel: 'comfy', workflow: 'Krea2简易生成' })
    const out = await s.generateBatch([])
    expect(out).toEqual([])
    expect(batchCalls).toHaveLength(0)
  })
})

describe('images.planKeyframes：AI 只排建议，不出图', () => {
  async function seedBeat() {
    const project = useProjectStore()
    const beats = useBeatStore()
    const provider = useProviderStore()
    const p = await project.create('测试项目')
    await beats.replaceAll(p.id, [
      { title: '林晚擦收银台', kind: 'dialogue', dialogue: '又是你。' }
    ])
    const prov = await provider.create({
      name: 't',
      baseUrl: 'https://example.com/v1',
      apiKey: 'k',
      model: 'm',
      sessionOnly: false
    })
    await provider.select(prov.id)
    return { beat: beats.ordered[0], provider }
  }

  it('把分镜交给模型，拿回"第几帧、画什么"，全程不碰出图通道', async () => {
    const s = useImageStore()
    const { beat } = await seedBeat()
    chatReply.value = {
      shots: [
        { beat: 1, frame: 0, prompt: 'opening frame of the counter', reason: '开场' },
        { beat: 1, frame: 12, prompt: 'she looks up at the door', reason: '台词落到抬头' }
      ]
    }

    const rows = await s.planKeyframes([beat.id])

    expect(chatCalls).toHaveLength(1)
    expect(chatCalls[0][1].content).toContain('林晚擦收银台')
    expect(rows).toHaveLength(1)
    expect(rows[0].beatId).toBe(beat.id)
    expect(rows[0].shots.map((x) => [x.frame, x.prompt])).toEqual([
      [0, 'opening frame of the counter'],
      [12, 'she looks up at the door']
    ])
    expect(s.planNote).toContain('2 张')
    expect(s.planBusy).toBe(false)
    // ★ 关键：排布阶段绝不能自己出图
    expect(batchCalls).toHaveLength(0)
    expect(runCalls).toHaveLength(0)
  })

  it('没配文本模型就说清楚，别静默不出建议', async () => {
    const s = useImageStore()
    await expect(s.planKeyframes(['x'])).rejects.toThrow(/供应商/)
    expect(chatCalls).toHaveLength(0)
  })

  it('模型给了看不懂的东西：返回空表 + 一句提示，不抛错', async () => {
    const s = useImageStore()
    const { beat } = await seedBeat()
    chatReply.value = { nonsense: true }
    const rows = await s.planKeyframes([beat.id])
    expect(rows).toEqual([])
    expect(s.planNote).toContain('没有给出可用建议')
  })
})
