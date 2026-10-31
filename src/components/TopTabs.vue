<script setup lang="ts">
/**
 * 顶层导航（剧本台 / 工作流控制台 / 运行）。
 *
 * 单独抽出来是因为三个页面都要有同一套 tab：控制台和运行都不是某个项目的
 * 子页，它们是和"剧本台"平级的另外两个工作面。
 *
 * ★ 样式契约：一级导航一律**下划线 + 文字**，页内子视图用 pill（n-radio-button）。
 * 以前两套都是同一种蓝底 pill，顶部同时亮着两个蓝块，用户在控制台里分不清
 * 「换页面」和「换视图」。下划线 = 我在哪个工作面，pill = 这一面看哪块。
 * 改样式时别把这里改回 pill。
 */
import { useRoute } from 'vue-router'
import UserMenu from './UserMenu.vue'

const route = useRoute()

function active(path: string): boolean {
  if (path === '/') return route.name === 'library'
  return route.path.startsWith(path)
}
</script>

<template>
  <nav class="top-tabs">
    <router-link to="/" class="tt-item" :class="{ on: active('/') }">剧本台</router-link>
    <router-link to="/console" class="tt-item" :class="{ on: active('/console') }">
      工作流控制台
    </router-link>
    <router-link to="/run" class="tt-item" :class="{ on: active('/run') }">运行</router-link>
    <UserMenu />
  </nav>
</template>

<style scoped>
.top-tabs {
  display: flex;
  align-items: stretch;
  height: 100%;
  flex: 0 0 auto;
}
.tt-item {
  display: flex;
  align-items: center;
  padding: 0 13px;
  font-size: 13.5px;
  color: var(--muted);
  text-decoration: none;
  border-bottom: 2px solid transparent;
  transition: color 0.12s, border-color 0.12s;
  /* 工作台头部塞了 7 个阶段 tab，窄窗口会把这几个词折成两行 */
  white-space: nowrap;
}
.tt-item:hover {
  color: var(--text);
}
.tt-item.on {
  color: var(--text);
  font-weight: 500;
  border-bottom-color: var(--accent);
}
</style>
