/**
 * 一条命令把前后台一起起起来。
 *
 *   npm start                 需要时先构建前端，然后启动 Python 后端（单端口）
 *   npm start -- --no-build   跳过构建，直接起（改了后端代码时最快）
 *   npm start -- --port 9000  换端口
 *   npm start -- --host 0.0.0.0  允许局域网访问（记得先把初始密码改掉）
 *
 * 为什么不用 concurrently / vite preview 这类现成方案：
 *   线上形态是「一个端口」—— Python 后端顺带把 dist/ 托管出去。前端和后端
 *   同源，登录 cookie 才带得动，`<img src>` 这些直连素材才不会被 401 拦掉。
 *   两个进程两个端口只是开发时的权宜，不该是用户按的那个按钮。
 *
 * 构建为什么按需：`vite build` 在这台机器上要十几秒，后端只改一行 Python 时
 * 不该陪着等。判据是 mtime —— dist/index.html 比 src/ 里所有文件都新就跳过。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const out = { port: '8787', host: '', build: true, dataDir: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-build') out.build = false
    else if (a === '--port') out.port = argv[++i] ?? out.port
    else if (a === '--host') out.host = argv[++i] ?? out.host
    else if (a === '--data-dir') out.dataDir = argv[++i] ?? out.dataDir
    else if (a === '--no-auth') out.noAuth = true
    else if (a === '-h' || a === '--help') {
      console.log(
        [
          '用法: npm start [-- 参数]',
          '',
          '  --port <端口>     后端端口（默认 8787）',
          '  --host <地址>     监听地址（默认 127.0.0.1；0.0.0.0 = 允许局域网）',
          '  --data-dir <目录> 临时指定数据目录',
          '  --no-build        不重新构建前端',
          '  --no-auth         关闭登录校验（只给排障用）'
        ].join('\n')
      )
      process.exit(0)
    }
  }
  return out
}

/**
 * 找 Python。
 *
 * Windows 上 PATH 里的 `python` 经常是 Microsoft Store 的存根，一执行就弹
 * 商店 —— 所以按「常见安装路径 → py → python」的顺序试，并且用一次真实的
 * 解释器启动来验证（只 `existsSync` 不够，存根文件也是存在的）。
 */
function findPython() {
  const candidates = []
  if (process.env.PYTHON) candidates.push(process.env.PYTHON)
  if (process.platform === 'win32') {
    const home = process.env.USERPROFILE || ''
    const local = process.env.LOCALAPPDATA || ''
    candidates.push(
      join(home, 'miniconda3', 'python.exe'),
      join(home, 'anaconda3', 'python.exe'),
      join(local, 'miniconda3', 'python.exe'),
      join(local, 'Programs', 'Python', 'Python313', 'python.exe'),
      join(local, 'Programs', 'Python', 'Python312', 'python.exe'),
      join(local, 'Programs', 'Python', 'Python311', 'python.exe'),
      'C:\\ProgramData\\miniconda3\\python.exe',
      'C:\\ProgramData\\anaconda3\\python.exe'
    )
  }
  candidates.push('python3', 'python', 'py')

  for (const exe of candidates) {
    if (!exe) continue
    if (exe.includes('/') || exe.includes('\\')) {
      if (!existsSync(exe)) continue
    }
    const probe = spawnSync(exe, ['-c', 'import sys; print(sys.version_info[0])'], {
      stdio: 'ignore',
      timeout: 8000
    })
    if (probe.status === 0) return exe
  }
  return null
}

function newestMtime(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue
    }
    const full = join(dir, entry.name)
    try {
      if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full))
      else newest = Math.max(newest, statSync(full).mtimeMs)
    } catch {
      /* 权限/竞态：忽略这个文件 */
    }
  }
  return newest
}

function needBuild() {
  const index = join(root, 'dist', 'index.html')
  if (!existsSync(index)) return '前端还没构建过'
  const built = statSync(index).mtimeMs
  const sources = Math.max(
    newestMtime(join(root, 'src')),
    statSync(join(root, 'index.html')).mtimeMs,
    statSync(join(root, 'vite.config.ts')).mtimeMs
  )
  return sources > built ? '前端源码有更新' : ''
}

function build() {
  // 直接跑 vite 的可执行脚本，不经 npm。
  // 理由：Windows 上 `npm` 是 npm.cmd，Node 18.20+ 出于安全不再允许 spawnSync
  // 直接执行 .cmd（EINVAL）；加 shell:true 又会把路径里的空格和中文交给 cmd 解析。
  // 用当前 node 跑 node_modules 里的入口，两边都绕开了。
  const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(vite)) {
    console.error('没装依赖（找不到 node_modules/vite）。先跑一次 `npm install`。')
    process.exit(1)
  }
  console.log('▸ 构建前端…')
  const res = spawnSync(process.execPath, [vite, 'build'], { cwd: root, stdio: 'inherit' })
  if (res.status !== 0) {
    console.error('\n构建失败，已中止。')
    process.exit(res.status || 1)
  }
}

const args = parseArgs(process.argv.slice(2))

const python = findPython()
if (!python) {
  console.error(
    '没找到 Python。装一个 Miniconda（https://docs.conda.io/en/latest/miniconda.html），\n' +
      '或者用环境变量 PYTHON 指定解释器路径。'
  )
  process.exit(1)
}

if (args.build) {
  const reason = needBuild()
  if (reason) {
    console.log(`▸ ${reason}，先构建。`)
    build()
  }
}

const argv = ['server/app.py', '--port', String(args.port)]
if (args.host) argv.push('--host', args.host)
if (args.dataDir) argv.push('--data-dir', args.dataDir)
if (args.noAuth) argv.push('--no-auth')

console.log(`▸ 启动后端（${python}）`)
const child = spawn(python, argv, {
  cwd: root,
  stdio: 'inherit',
  // 首次启动会在控制台打印初始密码；不关缓冲的话它可能一直卡在管道里
  env: { ...process.env, PYTHONUNBUFFERED: '1' }
})

let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  child.kill()
  // 后端是 ThreadingHTTPServer，收到 SIGTERM 会自己 server_close；
  // 给 2 秒收尾，超时就直接走（Ctrl-C 不该卡住终端）。
  setTimeout(() => process.exit(0), 2000)
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)

child.on('exit', (code, signal) => {
  if (signal && !stopping) {
    console.log(`\n后端被信号 ${signal} 结束`)
  }
  process.exit(code ?? 0)
})
