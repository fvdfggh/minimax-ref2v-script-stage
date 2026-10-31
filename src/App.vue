<script setup lang="ts">
import { NConfigProvider, NDialogProvider, NMessageProvider, zhCN, dateZhCN } from 'naive-ui'
import type { GlobalThemeOverrides } from 'naive-ui'
import RunStatusDock from '@/components/run/RunStatusDock.vue'

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
/*
 * Naive UI 主题覆盖 —— 和 styles/global.css 的令牌一一对应。
 *
 * 这里有三个"不许各写一套"的东西：主色、圆角、状态色。
 * 之前 n-button 是 naive 默认蓝、n-tag 一套色、自定义 CSS 又是另一套蓝，
 * 同一个页面里能出现四五种蓝。现在颜色只从下面这几个值来，
 * 改主题只改这里 + global.css 的 :root，别的地方不用动。
 */
const themeOverrides: GlobalThemeOverrides = {
  common: {
    // 主色
    primaryColor: '#3b6ef5',
    primaryColorHover: '#2f5cd6',
    primaryColorPressed: '#23448f',
    primaryColorSuppl: '#3b6ef5',
    // 状态色（对齐 --ok / --warn / --err）
    infoColor: '#3b6ef5',
    successColor: '#2f9e6f',
    warningColor: '#d89614',
    errorColor: '#d64545',
    // 圆角
    borderRadius: '8px',
    borderRadiusSmall: '6px',
    // 字
    fontSize: '14px',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    textColorBase: '#1f2430',
    textColor1: '#1f2430',
    textColor2: '#4b5565',
    textColor3: '#8b93a1',
    // 线 / hover 底
    borderColor: '#e5e7eb',
    dividerColor: '#e5e7eb',
    hoverColor: '#eef1f5',
    // 阴影分三档，和 --shadow-1/2/3 一致
    boxShadow1: '0 1px 2px rgba(16, 24, 40, 0.06)',
    boxShadow2: '0 1px 2px rgba(16, 24, 40, 0.06), 0 4px 12px rgba(16, 24, 40, 0.05)',
    boxShadow3: '0 8px 28px rgba(16, 24, 40, 0.12)'
  },
  Button: {
    borderRadiusTiny: '6px',
    borderRadiusSmall: '6px',
    borderRadiusMedium: '8px',
    fontWeight: '500'
  },
  Input: {
    borderRadius: '8px'
  },
  Select: {
    peers: {
      InternalSelection: { borderRadius: '8px' },
      InternalSelectMenu: { borderRadius: '10px' }
    }
  },
  Card: {
    borderRadius: '10px'
  },
  Dialog: {
    borderRadius: '12px'
  },
  Tag: {
    borderRadius: '6px'
  },
  Popover: {
    borderRadius: '8px'
  },
  Tooltip: {
    borderRadius: '6px'
  },
  Checkbox: {
    borderRadius: '4px'
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
        <!--
          全局运行状态浮窗：挂在路由之外，所以切页面也跟着走。
          它内部按路由自己决定显不显示（登录页和运行页不显示）。
        -->
        <RunStatusDock />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
