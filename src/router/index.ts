import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'library',
      component: () => import('@/views/LibraryView.vue')
    },
    {
      path: '/p/:id',
      name: 'workbench',
      component: () => import('@/views/WorkbenchView.vue'),
      props: true
    },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

export default router
