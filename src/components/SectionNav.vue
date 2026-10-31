<script lang="ts">
/**
 * 侧边目录条目。
 * id 必须是目标 DOM 元素的 id（滚动定位用它）；
 * heading=true 的条目只做分组标题，不参与定位和高亮。
 */
export interface SectionNavItem {
  id: string
  label: string
  /** 右侧小字：数量 / 状态 */
  hint?: string
  /** 状态色点 */
  tone?: 'default' | 'ok' | 'warn' | 'err'
  heading?: boolean
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { navOpen } from './sectionNavState'

const props = withDefaults(
  defineProps<{
    items: SectionNavItem[]
    /** 滚动容器的 CSS 选择器，目录跟着它滚动高亮、点击定位也只动它 */
    container: string
    title?: string
  }>(),
  { title: '目录' }
)

/**
 * 收起 / 展开由 sectionNavState 统一管：六个阶段是 v-show 同时挂载的，
 * 状态放实例里会出现「这页收起了、切过去那边又展开」。
 */
const open = navOpen
const activeId = ref('')
let containerEl: HTMLElement | null = null
let raf = 0
const listEl = ref<HTMLElement | null>(null)

/** 参与定位的条目不足 2 个时目录没有意义，直接隐藏 */
const show = computed(() => props.items.filter((i) => !i.heading).length >= 2)
const count = computed(() => props.items.filter((i) => !i.heading).length)

function resolveContainer(): HTMLElement | null {
  if (containerEl && document.contains(containerEl)) return containerEl
  containerEl = document.querySelector<HTMLElement>(props.container) ?? null
  return containerEl
}

/** 找「顶部已滚过、且最靠近容器上沿」的区块作为当前项 */
function spy() {
  raf = 0
  const c = resolveContainer()
  if (!c) return
  const top = c.getBoundingClientRect().top
  let best: string | null = null
  let bestRel = -Infinity
  for (const it of props.items) {
    if (it.heading) continue
    const el = document.getElementById(it.id)
    if (!el) continue
    const rel = el.getBoundingClientRect().top - top
    if (rel <= 96 && rel > bestRel) {
      bestRel = rel
      best = it.id
    }
  }
  if (best) {
    if (best !== activeId.value) activeId.value = best
  } else if (c.scrollTop + c.clientHeight >= c.scrollHeight - 8) {
    // 滚到底：高亮最后一个存在的区块
    const last = [...props.items].reverse().find((i) => !i.heading && document.getElementById(i.id))
    if (last && last.id !== activeId.value) activeId.value = last.id
  }
}

function onScroll() {
  if (raf) return
  raf = requestAnimationFrame(spy)
}

function jump(id: string) {
  const c = resolveContainer()
  const el = document.getElementById(id)
  if (!c || !el) return
  activeId.value = id
  // 直接算出容器内的目标偏移，避免 scrollIntoView 连带滚动其他祖先
  const target = c.scrollTop + (el.getBoundingClientRect().top - c.getBoundingClientRect().top) - 10
  c.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
}

onMounted(() => {
  resolveContainer()?.addEventListener('scroll', onScroll, { passive: true })
  spy()
})

onBeforeUnmount(() => {
  resolveContainer()?.removeEventListener('scroll', onScroll)
  if (raf) cancelAnimationFrame(raf)
})

// 条目增删（片段/段数量变化）后重新定位高亮
watch(
  () => props.items,
  () => {
    if (activeId.value && !props.items.some((i) => i.id === activeId.value)) activeId.value = ''
    spy()
  }
)

// 当前区块变了：目录自己滚一下，别让高亮跑到可视区外
watch(activeId, () => {
  const box = listEl.value
  const el = box?.querySelector<HTMLElement>('.sec-nav-item.is-active')
  el?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <!--
    右侧常驻目录栏（不是浮层）：和「交付」页左侧的段列表同一个做法 ——
    占位一列、自己滚、内容区让位。以前这里是 absolute 浮在内容右上角，
    段一多就把卡片文字压住，看起来像贴了个补丁。
  -->
  <aside v-if="show" class="sec-nav" :class="{ 'is-rail': !open }">
    <template v-if="open">
      <div class="sec-nav-head">
        <span class="sec-nav-title">{{ title }}</span>
        <span class="sec-nav-count">{{ count }}</span>
        <button class="sec-nav-toggle" title="收起目录" @click="open = false">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6" /></svg>
        </button>
      </div>
      <div ref="listEl" class="sec-nav-list">
        <template v-for="it in items" :key="it.id">
          <div v-if="it.heading" class="sec-nav-heading">{{ it.label }}</div>
          <button
            v-else
            class="sec-nav-item"
            :class="['tone-' + (it.tone ?? 'default'), { 'is-active': activeId === it.id }]"
            :title="it.hint ? `${it.label} · ${it.hint}` : it.label"
            @click="jump(it.id)"
          >
            <i class="sec-nav-dot" />
            <span class="sec-nav-label">{{ it.label }}</span>
            <span v-if="it.hint" class="sec-nav-hint">{{ it.hint }}</span>
          </button>
        </template>
      </div>
    </template>

    <!-- 收起：一条竖窄条，仍可点击定位 -->
    <div v-else class="sec-nav-rail">
      <button class="sec-nav-expand" title="展开目录" @click="open = true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
      </button>
      <button
        v-for="it in items"
        :key="it.id"
        v-show="!it.heading"
        class="sec-nav-rail-dot"
        :class="['tone-' + (it.tone ?? 'default'), { 'is-active': activeId === it.id }]"
        :title="it.hint ? `${it.label} · ${it.hint}` : it.label"
        @click="jump(it.id)"
      />
    </div>
  </aside>
</template>

<style scoped>
/*
 * 常驻右栏：flex 项而不是 absolute —— 父级已经是 flex 行，这里占一列就够，
 * 内容区自己 flex:1 让位，再也不会盖住卡片。
 * 视觉跟交付页的段列表对齐：同宽 220、同底色、只留一条分隔线。
 */
.sec-nav {
  flex: 0 0 220px;
  width: 220px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--line);
  background: var(--panel);
  font-size: 12px;
}

.sec-nav.is-rail {
  flex-basis: 34px;
  width: 34px;
}

.sec-nav-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 6px 7px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-2);
}

.sec-nav-title {
  font-weight: 600;
  font-size: 12px;
  color: var(--text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sec-nav-count {
  flex: 0 0 auto;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--hover);
  color: var(--muted);
  font-size: 11px;
  line-height: 16px;
  text-align: center;
  font-family: var(--mono);
}

.sec-nav-toggle,
.sec-nav-expand {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 3px 5px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.sec-nav-toggle:hover,
.sec-nav-expand:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

.sec-nav-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 8px 12px;
}

.sec-nav-heading {
  font-size: 11px;
  color: var(--muted);
  padding: 8px 6px 4px;
  font-weight: 600;
}

/* 条目做成和交付页 .seg-item 一样的小卡片：白底 + 细边 + 圆角 */
.sec-nav-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 7px 9px;
  margin-bottom: 6px;
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  color: var(--text);
  text-align: left;
  line-height: 18px;
  transition: border-color 0.12s, background 0.12s;
}

.sec-nav-item:hover {
  border-color: var(--accent-line);
  background: var(--panel-2);
}

/* 当前区块：和交付页「正在编辑的段」同一种标记 —— 强调色边框 + 左侧色条 */
.sec-nav-item.is-active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
  border-color: var(--accent);
  box-shadow: inset 3px 0 0 var(--accent);
}

.sec-nav-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--line-strong);
  flex: 0 0 6px;
}

.tone-ok .sec-nav-dot,
.tone-ok.sec-nav-rail-dot {
  background: var(--ok);
}

.tone-warn .sec-nav-dot,
.tone-warn.sec-nav-rail-dot {
  background: var(--warn);
}

.tone-err .sec-nav-dot,
.tone-err.sec-nav-rail-dot {
  background: var(--err);
}

.sec-nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sec-nav-hint {
  color: var(--muted);
  font-size: 11px;
  flex: 0 0 auto;
  font-family: var(--mono);
}

.sec-nav-item.is-active .sec-nav-hint {
  color: var(--accent);
}

.sec-nav-rail {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 6px 0 10px;
  overflow-y: auto;
}

.sec-nav-rail-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: none;
  padding: 0;
  cursor: pointer;
  background: var(--line-strong);
  flex: 0 0 7px;
  transition: transform 0.12s;
}

.sec-nav-rail-dot:hover,
.sec-nav-rail-dot.is-active {
  transform: scale(1.35);
}

.sec-nav-rail-dot.is-active {
  background: var(--accent);
}
</style>
