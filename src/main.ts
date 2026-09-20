import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createDiscreteApi } from 'naive-ui'
import App from './App.vue'
import router from './router'
import './styles/global.css'

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
app.use(createPinia())
app.use(router)

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

app.mount('#app')
