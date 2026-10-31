import { afterAll, describe, expect, it } from 'vitest'
import {
  backendExportProjectZip,
  backendHealth,
  backendImportZip,
  backendRoots,
  createBackendDb,
  getBackendBase,
  setBackendBase,
  setBackendProject
} from './backend'
import { startIsolatedBackend } from './isolatedBackend'
import type { Project } from '@/domain/types'

/* ------------------------------------------------------------------ *
 * 前后端契约联调
 *
 * 这些用例打的是真实后端，验证的是"适配器翻译出来的请求"和
 * "后端实际接受的形状"对不对得上 —— 纯单测 mock 掉 fetch 是测不出来的。
 *
 * 后端没起就整组跳过：这是联调，不该让 CI 因为没开服务而失败。
 * ------------------------------------------------------------------ */

/*
 * 自带一个隔离后端：数据目录在系统临时目录、端口随机，跑完连进程一起收掉。
 *
 * 以前是「PUT /api/config 把用户后端的**数据目录**临时切到 scratch，跑完再切回来」。
 * 这有两个坑，都真实踩过：
 *   - 测试跑着的时候用户刷新页面，看到的是空项目列表；
 *   - 中途崩了就没机会切回，`~/.scriptstage/config.json` 会永久指向一个临时目录，
 *     用户下次启动后端直接空库。
 * 现在用户的 8787 和真实数据目录一个字节都不碰。
 */
const iso = await startIsolatedBackend()
if (iso) setBackendBase(iso.base)
const describeIf = iso ? describe : describe.skip

const db = createBackendDb()

describeIf('后端联调（真实 HTTP）', () => {
  it('健康接口返回数据目录', async () => {
    const health = await backendHealth()
    expect(health?.ok).toBe(true)
    expect(health?.dataDir).toBeTruthy()
    // 数据目录必须是本次测试的临时目录，不是用户的 .itest-data
    expect(health?.dataDir).toBe(iso!.dir)
  })

  it('项目写入后能被 orderBy(...).reverse() 读到', async () => {
    const project = {
      id: 'prj_it01',
      name: '联调项目',
      story: '正文',
      stage: 'deliver',
      settings: { fps: 24, maxSegmentFrames: 141 },
      fieldSchema: [],
      createdAt: 1,
      updatedAt: 2
    }
    // 只填联调要用的字段，其余交给断言（这里验证的是契约，不是 Project 的形状）
    await db.projects.put(project as unknown as Project)
    const rows = await db.projects.orderBy('updatedAt').reverse().toArray()
    expect(rows.some((r) => r.id === 'prj_it01')).toBe(true)
    expect(await db.projects.get('prj_it01')).toMatchObject({ name: '联调项目' })
  })

  it('where(projectId).equals() 只返回本项目的行', async () => {
    setBackendProject('prj_it01')
    await db.beats.put({ id: 'b1', projectId: 'prj_it01', title: '一' } as never)
    await db.beats.put({ id: 'b2', projectId: 'prj_it01', title: '二' } as never)
    await db.beats.put({ id: 'b9', projectId: 'prj_other', title: '别的项目' } as never)

    const rows = await db.beats.where('projectId').equals('prj_it01').toArray()
    expect(rows.map((r) => r.id).sort()).toEqual(['b1', 'b2'])
  })

  it('sortBy 按顺序返回', async () => {
    setBackendProject('prj_it01')
    await db.assets.put({ id: 'a1', projectId: 'prj_it01', pictureN: 2 } as never)
    await db.assets.put({ id: 'a2', projectId: 'prj_it01', pictureN: 1 } as never)
    const rows = await db.assets.where('projectId').equals('prj_it01').sortBy('pictureN')
    expect(rows.map((r) => r.pictureN)).toEqual([1, 2])
  })

  it('素材本体走文件接口，行里不留 blob', async () => {
    setBackendProject('prj_it01')
    const payload = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])])
    await db.assets.put({
      id: 'a3',
      projectId: 'prj_it01',
      pictureN: 3,
      fileName: 'Picture3.png',
      blob: payload
    } as never)

    const rows = await db.assets.where('projectId').equals('prj_it01').toArray()
    const row = rows.find((r) => r.id === 'a3')
    expect(row).toBeTruthy()
    expect((row as unknown as { blob?: unknown }).blob).toBeUndefined()

    const res = await fetch(`${getBackendBase()}/api/projects/prj_it01/assets/Picture3.png`)
    expect(res.ok).toBe(true)
    expect((await res.arrayBuffer()).byteLength).toBe(7)
  })

  it('按 id 删除生效', async () => {
    setBackendProject('prj_it01')
    await db.beats.delete('b2')
    const rows = await db.beats.where('projectId').equals('prj_it01').toArray()
    expect(rows.map((r) => r.id)).toEqual(['b1'])
  })

  it('删除按行自己的项目走，不受"当前项目"被切走的影响', async () => {
    // 两个项目各一条素材（真实页面也是"先读到、再删"）
    await db.assets.put({ id: 'a_it_a', projectId: 'prj_it01', pictureN: 0 } as never)
    await db.assets.put({ id: 'a_it_b', projectId: 'prj_other', pictureN: 0 } as never)
    await db.assets.where('projectId').equals('prj_it01').toArray()

    // 模拟"系列页/主体取用"把上下文切到了别的项目
    setBackendProject('prj_other')
    await db.assets.delete('a_it_a')

    // 目标项目的这条必须真的没了……
    const inA = await db.assets.where('projectId').equals('prj_it01').toArray()
    expect(inA.some((r) => r.id === 'a_it_a')).toBe(false)
    // ……而当时"当前项目"里的数据不许被误删
    const inB = await db.assets.where('projectId').equals('prj_other').toArray()
    expect(inB.some((r) => r.id === 'a_it_b')).toBe(true)

    await db.assets.delete('a_it_b')
  })

  it('清空集合（where 后不带 ids）', async () => {
    await db.assemblies.where('projectId').equals('prj_it01').delete()
    expect(await db.assemblies.where('projectId').equals('prj_it01').toArray()).toEqual([])
  })

  it('目录浏览至少给出主目录', async () => {
    const roots = await backendRoots()
    expect(roots.length).toBeGreaterThan(0)
    expect(roots[0].path).toBeTruthy()
  })

  it('导出再导入，内容一致', async () => {
    const zip = await backendExportProjectZip('prj_it01')
    expect(zip.size).toBeGreaterThan(0)

    const res = await backendImportZip(zip, 'new')
    expect(res.projectId).toBeTruthy()
    expect(res.assets).toBe(1)

    const imported = await db.projects.get(res.projectId!)
    expect(imported).toMatchObject({ name: '联调项目' })
    const beats = await db.beats.where('projectId').equals(res.projectId!).toArray()
    expect(beats.map((b) => b.id)).toEqual(['b1'])
  })
})

afterAll(async () => {
  await iso?.stop()
})
