import { createRouter, createWebHashHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true }
    },
    {
      path: '/',
      name: 'library',
      component: () => import('@/views/LibraryView.vue')
    },
    {
      path: '/s/:id',
      name: 'series',
      component: () => import('@/views/SeriesView.vue'),
      props: true
    },
    {
      path: '/p/:id',
      name: 'workbench',
      component: () => import('@/views/WorkbenchView.vue'),
      props: true
    },
    {
      path: '/console',
      name: 'console',
      component: () => import('@/views/ConsoleView.vue')
    },
    {
      path: '/run',
      name: 'run',
      component: () => import('@/views/RunView.vue')
    },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

/**
 * 全局登录守卫。
 *
 * 第一次导航先问一次后端「我是谁」（会话在 HttpOnly cookie 里，前端读不到），
 * 之后 ready=true 就不再问 —— 否则每切一次 tab 都多一个请求。
 *
 * 未登录一律回 /login，并记下原本要去的地址，登录后原地返回。
 */
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (!auth.ready) await auth.refresh()

  if (to.name === 'login') {
    return auth.isLoggedIn ? { path: '/' } : true
  }
  if (to.meta.public) return true
  if (!auth.isLoggedIn) {
    return {
      name: 'login',
      query: to.fullPath && to.fullPath !== '/' ? { next: to.fullPath } : {}
    }
  }
  return true
})

export default router
