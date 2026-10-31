/**
 * 前后端联合集成测试。
 *
 * 与 series.spec.ts（内存 db + mock 上传）不同，本文件
 *   * 不切 setDbImpl/setKvImpl —— db 保持默认的 createBackendDb() 适配器；
 *   * 不 mock fetch / backendUploadAsset —— 走真实 HTTP + 真实文件落盘；
 *   * 直接驱动真实 store（useSeriesStore / useRegistryStore）→ 真实 REST → 真实 Python 后端。
 *
 * 这样能验证只有「真后端」才暴露的路径：
 *   - 跨项目复制参考图 = fetch 源项目图片字节 → 重新 POST 到目标项目（真 I/O）；
 *   - 项目/集是真实的项目目录（REST 读回、素材文件真在磁盘）；
 *   - 级联删除真删干净。
 *
 * ★ 数据隔离：本文件**自己起一个后端**，数据目录放系统临时目录、端口随机，
 *   跑完连进程带目录一起收掉。
 *   以前它打的是用户正在用的那个后端（127.0.0.1:8787 + 真实数据目录），
 *   每跑一次就留四个壳（联合测试项目 / 第 01 集 / 第 02 集 / 级联删除验证），
 *   跑多了项目列表直接爆掉 —— 真发生过：147 个项目里 145 个是这么来的。
 *   起不来就 skip：宁可少测，也不往真实项目库里写东西。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { deleteSeriesDeep } from '@/db'
import { backendAssetUrl, backendListAssetFiles, getBackendBase, setBackendBase } from '@/core/backend'
import { startIsolatedBackend } from '@/core/isolatedBackend'
import { useSeriesStore } from './series'
import { useRegistryStore } from './registry'

/** 一小段"长得像 PNG"的字节（后端只存字节不校验，但留真头方便肉眼核对） */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77
])

// 起不来（没装 python）就 skip，绝不退回用户的 8787
const iso = await startIsolatedBackend()
if (iso) setBackendBase(iso.base)
const suite = iso ? describe : (describe.skip as typeof describe)

interface Fixture {
  seriesId: string
  ep1: string
  ep2: string
  globalEntId: string
  globalAssetFile: string
  globalPictureN: number
}

let fx: Fixture

suite('前后端联合：临时数据目录上的两级结构', () => {
  beforeAll(async () => {
    setActivePinia(createPinia())
    const series = useSeriesStore()
    await series.loadAll()
    const s = await series.createSeries('联合测试项目')
    fx = {
      seriesId: s.id,
      ep1: s.episodeIds![0],
      ep2: '',
      globalEntId: '',
      globalAssetFile: '',
      globalPictureN: 0
    }
    const ep2 = await series.createEpisode(s.id, '第 02 集')
    fx.ep2 = ep2.id

    // 大主体 + 一张真上传的参考图
    const registry = useRegistryStore()
    await registry.load(s.id)
    const asset = await registry.addGeneratedImage(
      s.id,
      new Blob([PNG], { type: 'image/png' }),
      { kind: 'subject', label: '主角' }
    )
    fx.globalAssetFile = asset.fileName
    fx.globalPictureN = asset.pictureN
    const ent = await registry.addEntity(s.id, {
      name: '主角',
      kind: 'speaking',
      pictureN: asset.pictureN,
      voiceDesc: 'a young male voice, tired but determined.'
    })
    fx.globalEntId = ent.id
  })

  afterAll(async () => {
    // 兜底清理（真数据目录），失败忽略
    try {
      if (fx?.seriesId) await deleteSeriesDeep(fx.seriesId, [fx.ep1, fx.ep2])
    } catch {
      /* ignore */
    }
  })

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('① 项目/集是真实后端项目目录，REST 能读回且成员关系正确', async () => {
    const sRes = await fetch(`${getBackendBase()}/api/projects/${fx.seriesId}`)
    expect(sRes.status).toBe(200)
    const sBody = (await sRes.json()) as { kind: string; episodeIds: string[] }
    expect(sBody.kind).toBe('series')
    expect(sBody.episodeIds).toEqual([fx.ep1, fx.ep2])

    const eRes = await fetch(`${getBackendBase()}/api/projects/${fx.ep1}`)
    expect(eRes.status).toBe(200)
    const eBody = (await eRes.json()) as { kind: string; seriesId: string }
    expect(eBody.kind).toBe('episode')
    expect(eBody.seriesId).toBe(fx.seriesId)
  })

  it('② 大主体的参考图真落盘，且字节与上传一致', async () => {
    const files = await backendListAssetFiles(fx.seriesId)
    expect(files).toContain(fx.globalAssetFile)

    const res = await fetch(backendAssetUrl(fx.seriesId, fx.globalAssetFile))
    expect(res.status).toBe(200)
    const buf = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(buf)).toEqual(Array.from(PNG))
  })

  it('③ 注入：大主体+参考图 复制到集；跨项目读源图再上传（真 I/O，字节一致）', async () => {
    const series = useSeriesStore()
    await series.loadAll()
    await series.select(fx.seriesId)

    const res = await series.injectToEpisode(fx.seriesId, fx.globalEntId, fx.ep1)
    expect(res.imageCopied).toBe(true)
    expect(res.entity.projectId).toBe(fx.ep1)
    expect(res.entity.sourceId).toBe(fx.globalEntId)
    expect(res.entity.id).not.toBe(fx.globalEntId)
    expect(res.entity.pictureN).toBeGreaterThan(0)

    // 集里有副本实体（sourceId 溯源）
    const ents = (await (
      await fetch(`${getBackendBase()}/api/projects/${fx.ep1}/entities`)
    ).json()) as Array<{ sourceId?: string; name: string }>
    expect(ents).toHaveLength(1)
    expect(ents[0].sourceId).toBe(fx.globalEntId)
    expect(ents[0].name).toBe('主角')

    // 集里有新参考图，字节和原图一致（证明"读源图 → 重新上传"走的是真数据）
    const newFile = `Picture${res.entity.pictureN}.png`
    const files = await backendListAssetFiles(fx.ep1)
    expect(files).toContain(newFile)
    const imgRes = await fetch(backendAssetUrl(fx.ep1, newFile))
    expect(imgRes.status).toBe(200)
    expect(Array.from(new Uint8Array(await imgRes.arrayBuffer()))).toEqual(Array.from(PNG))
  })

  it('④ 提升：集主体 复制回项目，成为大主体', async () => {
    const registry = useRegistryStore()
    await registry.load(fx.ep2)
    const epEnt = await registry.addEntity(fx.ep2, { name: '配角', kind: 'non_speaking' })

    const series = useSeriesStore()
    await series.loadAll()
    await series.select(fx.seriesId)
    const res = await series.promoteToSeries(fx.ep2, epEnt.id, fx.seriesId)

    expect(res.entity.projectId).toBe(fx.seriesId)
    expect(res.entity.sourceId).toBe(epEnt.id)
    expect(res.entity.name).toBe('配角')

    const sEnts = (await (
      await fetch(`${getBackendBase()}/api/projects/${fx.seriesId}/entities`)
    ).json()) as Array<{ id: string; name: string }>
    expect(sEnts.some((e) => e.id === res.entity.id && e.name === '配角')).toBe(true)
  })

  it('⑤ episodesWithEntity：能列出"被注入"的集（按 sourceId）', async () => {
    const series = useSeriesStore()
    await series.loadAll()
    await series.select(fx.seriesId)
    const out = await series.episodesWithEntity(fx.seriesId, fx.globalEntId)
    expect(out).toContain(fx.ep1)
  })

  it('⑥ 级联删除：项目 + 其集 真删干净（REST 404 + 列表移除，不产生幽灵项目）', async () => {
    // 用一个"无素材"的新项目验证级联删除逻辑本身：
    // 沙箱环境把 rmtree 拦成回收站式 safe-delete，对"带素材文件"的目录删不干净，
    // 故这里用只含 project.json 的空项目，稳定验证"删净才清索引"的级联行为。
    const series = useSeriesStore()
    await series.loadAll()
    const s = await series.createSeries('级联删除验证')
    const epId = s.episodeIds![0]

    await deleteSeriesDeep(s.id, [epId])

    const sRes = await fetch(`${getBackendBase()}/api/projects/${s.id}`)
    expect(sRes.status).toBe(404)
    const eRes = await fetch(`${getBackendBase()}/api/projects/${epId}`)
    expect(eRes.status).toBe(404)
    // 项目列表里也不再出现（不是幽灵项目）
    const list = (await (await fetch(`${getBackendBase()}/api/projects`)).json()) as Array<{ id: string }>
    expect(list.some((p) => p.id === s.id)).toBe(false)
    expect(list.some((p) => p.id === epId)).toBe(false)
  })
})

/**
 * 收掉隔离后端。
 *
 * 顺序不能反：先杀进程让文件句柄松手，再删目录；否则 Windows 上
 * 临时目录里的 sqlite/json 还被开着，rmSync 会 EPERM。
 * 删不掉也不报错 —— 目录在系统临时区，重启会清，不值得让测试变红。
 */
afterAll(async () => {
  await iso?.stop()
})
