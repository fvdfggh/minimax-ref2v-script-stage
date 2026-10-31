<script setup lang="ts">
import { NButton, NModal } from 'naive-ui'

/**
 * 详情弹窗 —— 剧本台所有「详情」统一走这里。
 *
 * 之前同一类内容有三种容器混用：Modal（片段详情）、Drawer（实体与素材 / 提意见）、
 * 内联展开（镜头详情 / 字段预览 / 中英对照）。容器不一致会带来两个实际问题：
 *   1. 抽屉从右侧滑出，会遮住页面右侧的 SectionNav 目录；
 *   2. 内联展开会把列表撑长，展开两三项后滚动位置就丢了。
 * 所以统一收敛成弹窗：位置固定居中、关闭后列表保持原样。
 *
 * 只负责「壳」，内容由插槽给；传什么都能弹，不耦合具体业务类型。
 */
const props = withDefaults(
  defineProps<{
    show: boolean
    title?: string
    /** 弹窗最大宽度（px） */
    width?: number
    /** 底部左侧的灰字提示，不传则留空 */
    hint?: string
    /** 底部按钮文案 */
    okText?: string
  }>(),
  {
    title: '详情',
    width: 760,
    hint: '',
    okText: '关闭'
  }
)

const emit = defineEmits<{ 'update:show': [boolean] }>()

function close() {
  emit('update:show', false)
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :style="{ maxWidth: props.width + 'px' }"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <template #header>
      <div class="dm-head">
        <span class="dm-title">{{ props.title }}</span>
      </div>
    </template>

    <div class="detail-body">
      <slot />
    </div>

    <template #footer>
      <div class="row" style="justify-content: space-between">
        <span class="muted dm-hint">
          <slot name="hint">{{ props.hint }}</slot>
        </span>
        <n-button type="primary" @click="close">{{ props.okText }}</n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
/* 弹窗标题统一带一道主色竖线，和其它面板的卡头保持同一语言 */
.dm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dm-head::before {
  content: '';
  flex: 0 0 auto;
  width: 3px;
  height: 15px;
  border-radius: 2px;
  background: var(--accent);
}
.dm-title {
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text);
}
.dm-hint {
  font-size: var(--fs-base);
}

/*
 * card preset 的 body 本身可滚动，但内容里若嵌了 textarea / 长表格，
 * 不显式给上限会顶满整屏、把 header 挤出视口。68vh 保证上下都留白。
 */
.detail-body {
  max-height: 68vh;
  overflow-y: auto;
  padding-right: 4px;
}
</style>
