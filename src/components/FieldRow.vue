<!--
  一条字段：左边一个名字徽章，右边一条正文。

  这是全站展示"后台存的字段"的唯一写法 —— ③ 的整段字段补全、④ 中英对照、⑤ 交付、
  同步页都用它。原来每个页面各写各的（有的是「左栏名字 + 右栏正文」的两列
  表格，有的是「顶部灰标题栏 + 下面内容」的卡片），同一个字段在四个页面
  有四种长相。

  为什么是徽章 + 条，而不是表格：
  - 表格左栏宽度是按最长的名字定的，短名字那栏空着一大半，一屏六个字段
    眼睛要横向对位；
  - 徽章贴着它管的那条字，"这一行是谁"不用找。

  槽位放正文：普通文本直接塞进去；要编辑的（⑥）塞 textarea；要带动作的
  （同步页）塞按钮。徽章本身只负责"是谁"。
-->
<template>
  <div class="frow" :class="`is-${tone}`">
    <span class="frow-badge" :title="badgeTitle">
      {{ label }}<i v-if="dot" class="frow-dot" :title="dotTitle" />
    </span>
    <div class="frow-body"><slot /></div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 徽章上的名字：一般是字段中文名 */
    label: string
    /** 悬停提示：默认「名字 · key」，传了就按传的来 */
    title?: string
    /** 字段的英文 key，只进悬停提示，不占版面 */
    fieldKey?: string
    /** plain 可编辑 / quiet 只读派生 / empty 还是空的 / warn 有冲突 */
    tone?: 'plain' | 'quiet' | 'empty' | 'warn'
    /** 名字后面点一个红点（另一份内容落后） */
    dot?: boolean
    dotTitle?: string
  }>(),
  { tone: 'plain', dot: false }
)

const badgeTitle = computed(
  () => props.title ?? (props.fieldKey ? `${props.label} · ${props.fieldKey}` : props.label)
)
</script>

<style scoped>
.frow {
  display: flex;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
}

/* 名字徽章：固定宽，右边缘贴着正文条（只留一道 2px 的缝） */
.frow-badge {
  flex: 0 0 auto;
  width: var(--frow-badge-w, 82px);
  margin-top: 1px;
  padding: 4px 6px;
  border-radius: 4px 0 0 4px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: var(--frow-badge-fs, 11px);
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 只读派生字段：徽章退成灰的 —— 一屏里"要你填"和"不用管"靠颜色分开 */
.frow.is-quiet .frow-badge {
  background: var(--panel-3);
  color: var(--muted);
  font-weight: 500;
}

/* 空字段：徽章转红。整页只有这里允许红，因为它是唯一必须动手的地方 */
.frow.is-empty .frow-badge {
  background: var(--err-soft);
  color: var(--err-ink);
}

/* 冲突：黄，和"红=缺内容"分开 */
.frow.is-warn .frow-badge {
  background: var(--warn-soft);
  color: var(--warn-ink);
}

/* 正文条：右侧圆角，和徽章的直角咬在一起 */
.frow-body {
  flex: 1;
  min-width: 0;
  padding: 4px 10px 5px;
  border: 1px solid var(--line);
  border-radius: 0 6px 6px 0;
  background: var(--panel);
}

.frow-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-left: 4px;
  border-radius: 50%;
  background: var(--err);
  vertical-align: middle;
}
</style>
