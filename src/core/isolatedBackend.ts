/**
 * 集成测试用的「隔离后端」。
 *
 * 为什么需要它：
 *   前端的联调测试（src/core/backend.spec.ts、src/stores/series.integration.spec.ts）
 *   打的是真 HTTP + 真文件落盘，以前直接连用户正在用的那个后端
 *   （127.0.0.1:8787 + 真实数据目录），后果是两条：
 *
 *   1. **留垃圾**：每跑一次就多出「联合测试项目 / 第 01 集 / 第 02 集 /
 *      级联删除验证」这几个壳，跑几十次项目列表就没法看了
 *      （真实发生过：147 个项目里 145 个是这么堆出来的）。
 *   2. **动到用户的东西**：backend.spec 为了不污染数据，会 PUT /api/config
 *      把用户后端的**数据目录**临时切到 scratch，跑完再切回来。
 *      测试中途崩了它就没机会切回，全局配置会永久指向一个临时目录 ——
 *      下次启动后端看到的是空库。
 *
 * 所以改成：测试自己起一个后端，数据目录放系统临时目录，端口随机，
 * 跑完连进程一起收掉。用户的 8787 和后端数据目录一个字节都不碰。
 *
 * 起不来（没装 python / 端口耗尽）就返回 null，调用方自行 skip：
 * 宁可少测，不要为了测试去改用户的真实数据。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface IsolatedBackend {
  /** 形如 http://127.0.0.1:53412 */
  base: string
  /** 临时数据目录（系统 tmp 下，不碰项目里的 .itest-data） */
  dir: string
  child: ChildProcess
  /** 关进程 + 删临时目录；重复调用无副作用 */
  stop: () => Promise<void>
}

/** 让系统分配一个空闲端口（listen(0) 拿到就关掉，不会真的占着） */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function startIsolatedBackend(): Promise<IsolatedBackend | null> {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'scriptstage-itest-'))
  const port = await freePort()

  const child = spawn(
    'python',
    /*
     * `--no-auth`：联调测试直接打 REST，没有登录那一步。
     * 这里连的是测试自己起的临时后端，数据目录在系统临时目录，关掉鉴权
     * 不会让任何真实数据失去保护；真要测登录本身，走 server/test_auth.py。
     */
    ['server/app.py', '--port', String(port), '--data-dir', dir, '--no-auth'],
    {
      cwd: root,
      stdio: 'ignore',
      /*
       * 不继承 PYTHONPATH：那里挂着宿主环境的 safe-delete 钩子，它按
       * 「一次请求删几次」设配额，超了直接 SystemExit 把连接掐断。
       * 测试要连续删好几个项目，撞上配额就变成时红时绿的假失败。
       */
      env: { ...process.env, PYTHONPATH: '' }
    }
  )
  // spawn 失败（PATH 里没有 python）不会抛，只是立刻 exit
  child.once('error', () => {
    /* 交给下面的健康检查判定 */
  })

  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(800) })
      if (res.ok) {
        return {
          base,
          dir,
          child,
          stop: async () => {
            child.kill()
            // 先让进程退，句柄松开再删；Windows 上顺序反了就是 EPERM
            await sleep(300)
            try {
              rmSync(dir, { recursive: true, force: true })
            } catch {
              /* 句柄还没放干净：留给系统临时目录回收，不值得让测试变红 */
            }
          }
        }
      }
    } catch {
      /* 还没起好，继续等 */
    }
    await sleep(120)
  }
  child.kill()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 同上 */
  }
  return null
}
