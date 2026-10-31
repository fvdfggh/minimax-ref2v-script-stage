/**
 * 从 ComfyUI 前端把「界面格式」工作流导出成「API 格式」。
 *
 * 为什么必须有这个脚本：
 * 界面格式用 `nodes[] / links[] / widgets_values[]` 按位置存值，服务端
 * /api/prompt 根本不认；而 UI→API 的转换逻辑只存在于 ComfyUI 的**前端 JS**
 * 里，服务端没有任何接口能做这件事。所以只能开着真实的浏览器页面，调前端
 * 的 graphToPrompt() 让它自己转。
 *
 * 用法：
 *   1) 先启动带调试端口的 Edge（见下）
 *   2) node scripts/comfy-cdp-export.mjs <ui-workflow.json> [out.json]
 *
 * 它会自动连上已有页面（或新开一个），把图塞进前端，再取回转好的 API 图。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const CDP = 'http://127.0.0.1:9222'
const COMFY = 'http://127.0.0.1:8188'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function listTargets() {
  const res = await fetch(`${CDP}/json/list`)
  return await res.json()
}

async function newTarget(url) {
  // 新版 Chrome DevTools Protocol 用 PUT 建标签页
  let res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  if (!res.ok) {
    res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'GET' })
  }
  if (!res.ok) throw new Error(`建标签页失败：${res.status}`)
  return await res.json()
}

class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} 超时`))
        }
      }, 120000)
    })
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate 抛异常')
    }
    return r.result?.value
  }
}

async function main() {
  const src = process.argv[2]
  const out = process.argv[3]
  if (!src) {
    console.error('用法：node scripts/comfy-cdp-export.mjs <ui-workflow.json> [out.json]')
    process.exit(1)
  }
  const graph = JSON.parse(readFileSync(src, 'utf-8'))

  // 找一个 ComfyUI 页面，没有就新建
  let targets = await listTargets()
  let page = targets.find((t) => t.type === 'page' && (t.url || '').includes('8188'))
  if (!page) {
    page = await newTarget(COMFY)
    // 等前端加载完（要拉 object_info，慢）
    await sleep(12000)
  }
  if (!page.webSocketDebuggerUrl) throw new Error('拿不到 webSocketDebuggerUrl')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  const s = new Session(ws)
  await s.send('Runtime.enable')

  // 等 window.app 就绪
  let ok = false
  for (let i = 0; i < 40; i++) {
    const probe = await s.evaluate(
      `(() => { const a = window.app || window.comfyApp; return !!(a && typeof a.loadGraphData === 'function' && typeof a.graphToPrompt === 'function'); })()`
    )
    if (probe) {
      ok = true
      break
    }
    await sleep(1500)
  }
  if (!ok) throw new Error('ComfyUI 前端未就绪（找不到 app.loadGraphData / app.graphToPrompt）')

  // 把界面格式的图塞进去，再让它自己转成 API 格式
  const payload = JSON.stringify(graph)
  const api = await s.evaluate(
    `(async () => {
       const app = window.app || window.comfyApp;
       const g = ${payload};
       await app.loadGraphData(g);
       const p = await app.graphToPrompt();
       return p.output ?? p.workflow ?? p;
     })()`
  )
  ws.close()

  if (!api || typeof api !== 'object') throw new Error('导出的 API 图为空')
  const keys = Object.keys(api)
  console.error(`导出成功：${keys.length} 个节点`)
  for (const k of keys) console.error(`  ${k}  ${api[k].class_type}`)

  const text = JSON.stringify(api, null, 2)
  if (out) {
    writeFileSync(out, text, 'utf-8')
    console.error(`已写入 ${out}`)
  } else {
    console.log(text)
  }
}

main().catch((e) => {
  console.error('失败：', e.message)
  process.exit(1)
})
