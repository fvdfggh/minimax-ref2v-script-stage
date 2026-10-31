import { describe, expect, it } from 'vitest'
import { diffRevs } from './sync'

/* ------------------------------------------------------------------ *
 * 后端指纹比对
 *
 * 这段逻辑判错的表现很隐蔽：
 *  - 漏判 → 别处改了数据，这一页还是旧的（用户以为自己的改动没保存）；
 *  - 误判 → 什么都没改却一直刷新，正在输入的内容被顶掉。
 * 所以把"哪些算变化"钉死在单测里。
 * ------------------------------------------------------------------ */

describe('后端指纹比对', () => {
  it('指纹没变就不报变化', () => {
    expect(diffRevs({ beats: '1:10' }, { beats: '1:10' })).toEqual([])
  })

  it('变了就报出是哪张表', () => {
    const out = diffRevs({ beats: '1:10', assemblies: '2:20' }, { beats: '3:11', assemblies: '2:20' })
    expect(out).toEqual([{ table: 'beats', fingerprint: '3:11' }])
  })

  it('project.json 归到「项目」这张表', () => {
    expect(diffRevs({ project: '1:1' }, { project: '2:2' })).toEqual([
      { table: 'project', fingerprint: '2:2' }
    ])
  })

  it('meta.json 的变化算成「段与字段」：覆盖值和段指纹都存在那里', () => {
    expect(diffRevs({ meta: '1:1' }, { meta: '2:2' })).toEqual([
      { table: 'assemblies', fingerprint: '2:2' }
    ])
  })

  it('meta 和 assemblies 同时变只报一次', () => {
    const out = diffRevs(
      { assemblies: 'a', meta: 'a' },
      { assemblies: 'b', meta: 'b' }
    )
    expect(out).toEqual([{ table: 'assemblies', fingerprint: 'b' }])
  })

  it('不认识的键直接忽略（后端将来加文件不会炸前端）', () => {
    expect(diffRevs({}, { somethingElse: '9:9' })).toEqual([])
  })

  it('空指纹（文件不存在）不算变化', () => {
    expect(diffRevs({ beats: '1:1' }, { beats: '' })).toEqual([])
  })

  it('多张表同时变，全部报出来', () => {
    const out = diffRevs(
      { beats: 'a', entities: 'a', assets: 'a' },
      { beats: 'b', entities: 'b', assets: 'a' }
    )
    expect(out.map((c) => c.table).sort()).toEqual(['beats', 'entities'])
  })
})
