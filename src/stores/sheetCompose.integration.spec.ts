/**
 * 设定图拼接：前后端联合集成测试（真后端 + 真落盘 + 真 PNG）。
 *
 * 为什么单独一个文件、而且要起隔离后端：
 *   `composeGroupAsReference` 是**唯一**能把"选一组 → 拼成 1376×768 →
 *   覆盖本集 <Picture N>"这条链路走完的地方，中间任何一环断了（素材没上传、
 *   后端缺 Pillow、拼接接口回的不是 PNG、asset 行没写上 pictureN），
 *   界面都只会显示一句"生成失败"，看不出来断在哪。所以这里逐环节断言：
 *
 *     ① 两张素材真上传到后端；
 *     ② /sheet/compose 回来的是 1376×768 的 PNG（读 IHDR，不看文件名）；
 *     ③ 拼接结果占了本集的一个 <Picture N> 槽位，且实体指向它；
 *     ④ 再拼一次是**覆盖**同一个槽位，不是又加一个 Picture ——
 *        否则每换一次造型，这一集的参考图编号就往后跑一位，别的引用全错位。
 *
 * 起不来就 skip（和 series.integration 一样），绝不往用户的真实数据目录写。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { deleteSeriesDeep } from '@/db'
import { backendAssetUrl, setBackendBase } from '@/core/backend'
import { startIsolatedBackend } from '@/core/isolatedBackend'
import { useSeriesStore } from './series'
import { useRegistryStore } from './registry'
import type { RefSheet } from '@/domain/types'

/** 1×1 的红点 PNG。只要能解码就行 —— 尺寸对不对由 IHDR 断言。 */
const PNG_1PX = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  ),
  (c) => c.charCodeAt(0)
)

/** 从 PNG 字节里读宽高（IHDR 就在签名之后，宽 16..20、高 20..24，大端） */
function pngSize(buf: Uint8Array): [number, number] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return [dv.getUint32(16), dv.getUint32(20)]
}

const iso = await startIsolatedBackend()
if (iso) setBackendBase(iso.base)
const suite = iso ? describe : (describe.skip as typeof describe)

interface Fixture {
  seriesId: string
  episodeId: string
  entityId: string
}

let fx: Fixture

suite('设定图拼接：选一组 → 1376×768 → 覆盖本集参考图', () => {
  beforeAll(async () => {
    setActivePinia(createPinia())
    const series = useSeriesStore()
    await series.loadAll()
    const s = await series.createSeries('拼接测试项目')
    fx = { seriesId: s.id, episodeId: s.episodeIds![0], entityId: '' }

    // 主体挂在**集**上：每集各选各的造型，互不影响
    const registry = useRegistryStore()
    await registry.load(fx.episodeId)
    const ent = await registry.addEntity(fx.episodeId, { name: '主角', kind: 'speaking' })
    fx.entityId = ent.id
  })

  afterAll(async () => {
    try {
      if (fx?.seriesId) await deleteSeriesDeep(fx.seriesId, [fx.episodeId])
    } catch {
      /* ignore */
    }
  })

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('拼出来的图是 1376×768，并占住本集的 <Picture N> 槽位', async () => {
    const registry = useRegistryStore()
    await registry.load(fx.episodeId)
    const pid = fx.episodeId

    // 组头 + 一张三视图（都走真实上传接口落到磁盘）
    const head = await registry.addSheetImage(
      pid,
      fx.entityId,
      new Blob([PNG_1PX], { type: 'image/png' }),
      '组头'
    )
    const view = await registry.addSheetImage(
      pid,
      fx.entityId,
      new Blob([PNG_1PX], { type: 'image/png' }),
      '三视图'
    )
    const sheet: RefSheet = {
      masterId: null,
      groups: [
        {
          id: 'grp_test',
          label: '造型 1',
          headId: head.id,
          viewIds: [view.id],
          pickedViewId: view.id,
          createdAt: 0
        }
      ],
      active: null
    }
    await registry.setRefSheet(fx.entityId, sheet)

    const composed = await registry.composeGroupAsReference(pid, fx.entityId, 'grp_test')

    // ① 尺寸：直接读后端落盘的字节，不看前端缓存
    const res = await fetch(backendAssetUrl(pid, composed.fileName))
    expect(res.status).toBe(200)
    expect(pngSize(new Uint8Array(await res.arrayBuffer()))).toEqual([1376, 768])

    // ② 占的是参考图槽位，且实体指向它
    expect(composed.pictureN).toBeGreaterThan(0)
    const ent = registry.entities.find((e) => e.id === fx.entityId)!
    expect(ent.pictureN).toBe(composed.pictureN)
    expect(registry.subjectImageFor(fx.entityId)?.fileName).toBe(composed.fileName)

    // ③ 记住用的是哪组哪张 —— 换集后界面要靠它标"来自造型 1 · 拼接"
    expect(ent.refSheet?.active).toMatchObject({
      groupId: 'grp_test',
      viewId: view.id,
      mode: 'compose'
    })
  })

  it('再拼一次是覆盖同一个槽位，不会多出一个 Picture', async () => {
    const registry = useRegistryStore()
    await registry.load(fx.episodeId)
    const pid = fx.episodeId
    const before = registry.entities.find((e) => e.id === fx.entityId)!.pictureN

    const again = await registry.composeGroupAsReference(pid, fx.entityId, 'grp_test')
    expect(again.pictureN).toBe(before)

    const pics = registry.assets.filter((a) => a.pictureN > 0)
    expect(pics.filter((a) => a.pictureN === before)).toHaveLength(1)
    // 设定图（kind=sheet）永远不占槽位，拼完也不该多出一张
    expect(registry.assets.filter((a) => a.kind === 'sheet').every((a) => a.pictureN === 0)).toBe(true)
  })

  it('缺组头 / 缺三视图时给出能看懂的错，而不是 500', async () => {
    const registry = useRegistryStore()
    await registry.load(fx.episodeId)
    const pid = fx.episodeId

    await registry.setRefSheet(fx.entityId, {
      masterId: null,
      groups: [
        { id: 'grp_empty', label: '空组', headId: null, viewIds: [], createdAt: 0 },
        { id: 'grp_nohead', label: '没组头', headId: null, viewIds: ['x'], createdAt: 0 }
      ],
      active: null
    })

    await expect(registry.composeGroupAsReference(pid, fx.entityId, 'grp_empty')).rejects.toThrow(/组头/)
    await expect(registry.composeGroupAsReference(pid, fx.entityId, 'grp_nohead')).rejects.toThrow(/组头/)
    await expect(registry.composeGroupAsReference(pid, fx.entityId, 'grp_missing')).rejects.toThrow(/不在/)
  })
})
