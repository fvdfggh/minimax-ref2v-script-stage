<script>
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

const props = withDefaults(
  defineProps<{
    items: SectionNavItem[]
    /** 滚动容器的 CSS 选择器，目录悬浮在它右上角、滚动定位也只动它 */
    container: string
    title?: string
  }>(),
  { title: '目录' }
)

const open = ref(true)
const activeId = ref('')
let containerEl: HTMLElement | null = null
let raf = 0

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
</script>

<template>
  <div v-if="show" class="sec-nav">
    <!-- 展开：列标签 + 状态色点 -->
    <div v-if="open" class="sec-nav-panel">
      <div class="sec-nav-head">
        <span class="sec-nav-title">{{ title }} · {{ count }}</span>
        <button class="sec-nav-toggle" title="收起目录" @click="open = false">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6" /></svg>
        </button>
      </div>
      <div class="sec-nav-list">
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
    </div>

    <!-- 收起：一条圆点导航条，仍可点击定位 -->
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
  </div>
</template>

<style scoped>
.sec-nav {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 20;
  font-size: 12px;
}

.sec-nav-panel {
  width: 184px;
  max-height: calc(100% - 24px);
  display: flex;
  flex-direction: column;
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(4px);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow);
  overflow: hidden;
}

.sec-nav-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 6px 5px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-2);
  flex: 0 0 auto;
}

.sec-nav-title {
  font-weight: 600;
  font-size: 12px;
  color: var(--muted);
}

.sec-nav-toggle,
.sec-nav-expand {
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
  overflow-y: auto;
  padding: 6px;
}

.sec-nav-heading {
  font-size: 11px;
  color: var(--muted);
  padding: 6px 6px 2px;
  font-weight: 600;
}

.sec-nav-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
  border: none;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  color: var(--text);
  text-align: left;
}

.sec-nav-item:hover {
  background: #f1f4f9;
}

.sec-nav-item.is-active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.sec-nav-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #c3c9d4;
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
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 6px 4px;
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(4px);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow);
  max-height: calc(100% - 24px);
  overflow-y: auto;
}

.sec-nav-rail-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: none;
  padding: 0;
  cursor: pointer;
  background: #c3c9d4;
  flex: 0 0 7px;
}

.sec-nav-rail-dot:hover,
.sec-nav-rail-dot.is-active {
  transform: scale(1.35);
}

.sec-nav-rail-dot.is-active {
  background: var(--accent);
}
</style>
