<script setup lang="ts">
import { NConfigProvider, NDialogProvider, NMessageProvider, zhCN, dateZhCN } from 'naive-ui'
import type { GlobalThemeOverrides } from 'naive-ui'

/*
 * 关于 template 根节点上的 class="app-root"：
 *
 * naive-ui 的 ConfigProvider 会渲染一层 <div class="n-config-provider">，这层 div 没有高度。
 * 而 #app 是 height: 100%、页面组件也写 height: 100%，CSS 规定百分比高度遇到
 * 「高度由内容决定」的父级时会退化成 auto —— 高度链会在这里断掉：
 * 页面组件被内容撑高 → main 失去约束 → 整页变成 body 滚动（表头和左右两栏一起滚）。
 *
 * 修法是给这层 div 补上 height: 100%（见 styles/global.css 的 .app-root）。
 * 这里刻意不用 ConfigProvider 的 abstract 属性：abstract 会让它直接渲染 slot、
 * 不再产生 DOM，虽然文档上说只影响 render，但它动的是全局组件树，
 * 实测会连带影响样式挂载。补一行 CSS 更保守，效果一样，风险为零。
 *
 * 同理，注释不要写在 <template> 顶层 —— 那会让 SFC 从单根变成 Fragment 根。
 */
const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#3b6ef5',
    primaryColorHover: '#5583f7',
    primaryColorPressed: '#2f5cd6',
    borderRadius: '8px',
    fontSize: '14px',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
  },
  Button: {
    borderRadiusMedium: '8px'
  },
  Input: {
    borderRadius: '8px'
  }
}
</script>

<template>
  <n-config-provider
    class="app-root"
    :theme-overrides="themeOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <n-message-provider>
      <n-dialog-provider>
        <router-view />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
