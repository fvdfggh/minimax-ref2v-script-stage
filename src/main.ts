import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createDiscreteApi } from 'naive-ui'
import App from './App.vue'
import router from './router'
import './styles/global.css'
import { setBackendWriteSink, UNAUTHORIZED_EVENT } from './core/backend'
import { useAuthStore } from './stores/auth'
import { useSyncStore } from './stores/sync'

/**
 * 兜底错误出口。
 * 之前组件事件里的异步错误只会变成一句空白的 "Uncaught (in promise)"，
 * 这里把真实错误名 + message + 触发位置吐出来，方便定位。
 */
const { message } = createDiscreteApi(['message'])

let lastKey = ''
let lastAt = 0

function describe(err: unknown): string {
  if (err == null) return '未知错误（值为 null / undefined）'
  if (err instanceof Error) {
    return `${err.name || 'Error'}: ${err.message || '(无 message)'}`
  }
  if (typeof err === 'object') {
    const e = err as { name?: string; message?: string; code?: number }
    const parts = [
      e.name,
      e.message,
      e.code != null ? `code=${e.code}` : ''
    ].filter((x): x is string => !!x)
    if (parts.length) return parts.join(' · ')
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

function report(err: unknown, where: string) {
  console.error(`[剧本台] ${where}`, err)
  const text = describe(err)
  const key = `${where}|${text}`
  const at = Date.now()
  // 同一个错误 1 秒内只弹一次，避免渲染循环刷屏
  if (key === lastKey && at - lastAt < 1000) return
  lastKey = key
  lastAt = at
  message.error(`${where} → ${text}`, { duration: 8000, closable: true })
}

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)

/**
 * 所有写库都从 HttpTable 走，这里挂一个全局出口：
 * 谁改了哪张表、哪几行，同步总线立刻知道。
 * 不挂的话，「数据变了」只能靠每个调用点自己记得上报 —— 迟早漏。
 */
setBackendWriteSink((write) => useSyncStore(pinia).noteLocal(write))

app.config.errorHandler = (err, _instance, info) => {
  report(err, `组件错误(${info})`)
}

window.addEventListener('unhandledrejection', (e) => {
  e.preventDefault()
  report(e.reason, '未处理的异步错误')
})

window.addEventListener('error', (e) => {
  if (e.error) report(e.error, '全局错误')
})

/**
 * 会话失效（后端回 401）→ 清登录态 + 回登录页。
 *
 * 为什么会过期：cookie 14 天到期、管理员改了密码/删了账号、或者后端换了台机器。
 * 不处理的话页面会挂着一堆「后端 401」的报错卡片，用户根本不知道该干什么。
 */
window.addEventListener(UNAUTHORIZED_EVENT, () => {
  const auth = useAuthStore()
  auth.markExpired()
  const current = router.currentRoute.value
  if (current.name === 'login') return
  void router.replace({
    name: 'login',
    query: current.fullPath && current.fullPath !== '/' ? { next: current.fullPath } : {}
  })
})

app.mount('#app')
