/**
 * 一次性导出：把「测试用工作流1_段1-192_一采」从界面格式转成 API 格式。
 *
 * 走 CDP 是因为 UI→API 转换只存在于 ComfyUI 前端 JS 里，服务端没有接口。
 * 前提：Edge 已带 --remote-debugging-port=9222 打开 http://127.0.0.1:8188。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const UI = 'C:/Users/于玉宇/Desktop/comfyui/ComfyUI/user/default/workflows/测试用工作流1_段1-192_一采.json'
const OUT = 'C:/Users/于玉宇/Desktop/minimax-ref2v-script-stage/scripts/_exported_api.json'

const payload = readFileSync(UI, 'utf-8')
console.error('界面图字节数', payload.length)

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && (t.url || '').includes('8188'))
if (!page) throw new Error('没有打开 ComfyUI 页面的标签')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.addEventListener('open', r)
  ws.addEventListener('error', j)
})

let id = 0
const pend = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m)
    pend.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id
    pend.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
    setTimeout(() => {
      if (pend.has(i)) {
        pend.delete(i)
        rej(new Error(method + ' 超时'))
      }
    }, 300000)
  })

await send('Runtime.enable')
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true
  })
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800))
  }
  return r.result?.result?.value
}

const s1 = await ev(
  `(async()=>{ try { await window.app.loadGraphData(${payload}); return 'loaded nodes=' + window.app.graph.nodes.length } catch(e){ return 'ERR ' + (e && e.stack || e) } })()`
)
console.error('step1 载入图:', String(s1).slice(0, 300))

const s2 = await ev(
  `(async()=>{ try { const p = await window.app.graphToPrompt(); const o = p.output || p.workflow; return 'ok keys=' + Object.keys(p) + ' nodes=' + Object.keys(o).length } catch(e){ return 'ERR ' + (e && e.stack || e) } })()`
)
console.error('step2 转换:', String(s2).slice(0, 400))

const api = await ev(`(async()=>{ const p = await window.app.graphToPrompt(); return JSON.stringify(p.output || p.workflow) })()`)
ws.close()

writeFileSync(OUT, api, 'utf-8')
const parsed = JSON.parse(api)
console.error('已写出', OUT)
console.error('节点数', Object.keys(parsed).length)
const types = {}
for (const n of Object.values(parsed)) types[n.class_type] = (types[n.class_type] ?? 0) + 1
for (const [k, v] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
  console.error(`  ${k} ×${v}`)
}
