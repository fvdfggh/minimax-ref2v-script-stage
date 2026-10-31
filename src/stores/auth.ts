import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  authChangePassword,
  authLogin,
  authLogout,
  authMe,
  type AuthUser
} from '@/core/backend'

/**
 * 登录状态。
 *
 * 会话本身是后端发的 HttpOnly cookie（JS 读不到，XSS 偷不走），这里只缓存
 * "当前是谁"用于渲染，以及给路由守卫一个同步可读的登录态。
 *
 * 没有注册：账号由管理员在命令行建（`python server/app.py user add 名字`）。
 * 前端的登录页刻意不画"注册"入口 —— 画了就是骗人。
 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref<AuthUser | null>(null)
  /** 是否已经问过一次后端（守卫据此决定要不要再问） */
  const ready = ref(false)
  const checking = ref(false)

  const isLoggedIn = computed(() => !!user.value)
  const displayName = computed(() => user.value?.displayName || user.value?.username || '')

  /** 把后端那句「后端 401：用户名或密码不对」剥成「用户名或密码不对」 */
  function tidy(err: unknown): string {
    const text = err instanceof Error ? err.message : String(err)
    return text.replace(/^后端 \d{3}[：:]\s*/, '')
  }

  async function refresh(): Promise<AuthUser | null> {
    checking.value = true
    try {
      user.value = await authMe()
    } catch {
      user.value = null
    } finally {
      ready.value = true
      checking.value = false
    }
    return user.value
  }

  async function login(username: string, password: string): Promise<void> {
    try {
      user.value = await authLogin(username.trim(), password)
      ready.value = true
    } catch (err) {
      user.value = null
      throw new Error(tidy(err))
    }
  }

  async function logout(): Promise<void> {
    try {
      await authLogout()
    } catch {
      // 后端没起/令牌已失效都无所谓，本地照样退
    } finally {
      user.value = null
    }
  }

  async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
    try {
      await authChangePassword(oldPassword, newPassword)
    } catch (err) {
      throw new Error(tidy(err))
    }
  }

  /** 后端说 401 时调用：清掉本地登录态，守卫会把页面带回登录页 */
  function markExpired(): void {
    user.value = null
  }

  return {
    user,
    ready,
    checking,
    isLoggedIn,
    displayName,
    refresh,
    login,
    logout,
    changePassword,
    markExpired
  }
})
