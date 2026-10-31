import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 5178,
    host: true,
    /**
     * 开发时把 /api 代到 Python 后端，让页面和后端"同源"。
     *
     * 为什么必须这么做：登录会话是 HttpOnly cookie，跨端口（5178 → 8787）时
     * `<img src>` 这类浏览器直连的地址在 localhost / 127.0.0.1 混用的情况下
     * 属于跨站，cookie 带不过去，素材会整片 401。走代理就完全没有跨域问题。
     *
     * changeOrigin 保持 false：后端回显 Origin 时要比对 Host，改了就对不上。
     */
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false
      }
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    /**
     * 文件之间串行跑。
     *
     * 原因只有一条：`series.integration.spec.ts` 打的是**同一个真后端 (127.0.0.1:8787)
     * + 同一个真数据目录**。并行时它和别的 spec 抢同一份 `/api/projects`（别处正在
     * 建项目/删项目），`episodesWithEntity` 就会偶发拿到空列表 —— 表现为
     * "④提升 / ⑤注入列表" 时红时绿，单跑又必过。串行只多三四秒，换 `npm test` 可复现。
     *
     * 用 singleFork（一个进程串行跑所有文件）而不是 fileParallelism:false：
     * 后者每个文件都要重开 worker，全套 42s；singleFork 11s。文件之间仍然各自隔离。
     */
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }
  }
})
