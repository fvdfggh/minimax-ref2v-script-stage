<script setup lang="ts">
/**
 * 行内说明图标：一个「?」，悬浮出解释。
 *
 * 判据很简单 —— 这段话是**解释一次就够**的（为什么这样、不这样会怎样），
 * 还是**每次都要看**的（数量、状态、报错）。前者收进图标，后者留在原地。
 *
 * 用 popover 而不是 title 属性：title 有 1s 延迟、不能换行、不能选中文字。
 */
import { NPopover } from 'naive-ui'

type Placement =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-start'
  | 'top-end'
  | 'bottom-start'
  | 'bottom-end'

const props = withDefaults(
  defineProps<{
    /** 解释正文，支持换行（\n） */
    text: string
    /** 气泡最大宽度，长解释给 360~420 */
    width?: number
    placement?: Placement
    /** 挂在标题后面时用 sm，挤在表格行里也不撑高 */
    size?: 'sm' | 'md'
  }>(),
  { width: 320, placement: 'top', size: 'md' }
)
</script>

<template>
  <n-popover
    trigger="hover"
    :placement="props.placement"
    :delay="120"
    :style="{ maxWidth: props.width + 'px' }"
  >
    <template #trigger>
      <span
        class="info-tip"
        :class="`is-${props.size}`"
        role="button"
        tabindex="0"
        aria-label="说明"
        @keydown.enter.prevent
      >
        ?
      </span>
    </template>
    <div class="info-body">{{ props.text }}</div>
  </n-popover>
</template>

<style scoped>
.info-tip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  margin-left: 4px;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  color: var(--label);
  cursor: help;
  user-select: none;
  flex: 0 0 auto;
  vertical-align: 1px;
}
.info-tip.is-sm {
  width: 13px;
  height: 13px;
  margin-left: 3px;
  font-size: 9px;
}
.info-tip:hover,
.info-tip:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
  outline: none;
}
.info-body {
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
}
</style>
