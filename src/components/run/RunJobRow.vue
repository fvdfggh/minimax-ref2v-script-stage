<script setup lang="ts">
/**
 * 一条运行任务的"轻量行"。
 *
 * 运行页里那张大卡片是**操作台**（编参数、看产物、翻日志）；这里只回答
 * 在别的页面上最要紧的三个问题：**谁在跑、跑到哪、跑了多久**。
 * 所以不复制日志和产物墙，只留一行进度条 + 两个动作。
 *
 * 为什么抽成组件而不是在浮窗和首页各写一遍：两处的百分比必须一样
 * （口径来自 domain/runStatus.ts），各写一遍迟早一处改了另一处没改。
 */
import { computed } from 'vue'
import { NButton, NProgress } from 'naive-ui'
import { detailText, durationLabel, percentOf, statusOf } from '@/domain/runStatus'
import type { RunJob } from '@/stores/run'

const props = withDefaults(
  defineProps<{
    job: RunJob
    /** 当前时刻：由外层统一给，避免每行自己起一个定时器 */
    now: number
    /** 紧凑模式（浮窗里）：不显示"多久没上报"这类次要信息 */
    compact?: boolean
    /** 显示"打开这一集" */
    canOpen?: boolean
  }>(),
  { compact: false, canOpen: true }
)

const emit = defineEmits<{ (e: 'open', job: RunJob): void; (e: 'stop', job: RunJob): void }>()

const active = computed(
  () => props.job.status === 'running' || props.job.status === 'queued' || props.job.status === 'submitting'
)
const pct = computed(() => percentOf(props.job))
const tone = computed(() => statusOf(props.job).tone)
const detail = computed(() => detailText(props.job))
const elapsed = computed(() => durationLabel(props.job, props.now))
/** 队列里还没上报时进度条走 indeterminate，别让人以为卡在 0% */
const waiting = computed(() => active.value && !props.job.progress.max)
</script>

<template>
  <div
    class="rjr"
    :data-tone="tone"
    :title="canOpen ? '打开这一集的工作台' : ''"
    @click="canOpen && emit('open', job)"
  >
    <span class="rjr-dot" :class="{ pulse: job.status === 'running' }" />
    <div class="rjr-main">
      <div class="rjr-l1">
        <span class="rjr-name" :title="job.episodeName || job.episodeId">
          {{ job.episodeName || job.episodeId || '未命名' }}
        </span>
        <span class="rjr-pct mono">
          <template v-if="active && !waiting">{{ pct }}%</template>
          <template v-else-if="!active">{{ statusOf(job).text }}</template>
        </span>
      </div>
      <div class="rjr-l2">
        <span class="rjr-phase">{{ detail || (active ? '准备中' : '—') }}</span>
        <span class="rjr-dur mono">{{ elapsed }}</span>
      </div>
      <n-progress
        v-if="active"
        class="rjr-bar"
        :percentage="pct"
        :height="3"
        :show-indicator="false"
        :processing="waiting"
        :status="waiting ? 'default' : 'info'"
      />
      <div v-else-if="!compact" class="rjr-l3 muted">
        结束 · {{ job.outputs?.length ?? 0 }} 个产物
      </div>
      <div v-if="job.error && !compact" class="rjr-err">{{ job.error }}</div>
    </div>
    <div v-if="active" class="rjr-acts" @click.stop>
      <n-button size="tiny" quaternary type="error" @click="emit('stop', job)">中断</n-button>
    </div>
  </div>
</template>

<style scoped>
.rjr {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 4px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.12s;
}
.rjr:hover {
  background: var(--panel-2);
}
.rjr-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--muted);
}
.rjr[data-tone='info'] .rjr-dot {
  background: var(--accent);
}
.rjr[data-tone='ok'] .rjr-dot {
  background: var(--ok);
}
.rjr[data-tone='warn'] .rjr-dot {
  background: var(--warn);
}
.rjr[data-tone='err'] .rjr-dot {
  background: var(--err);
}
.rjr-dot.pulse {
  animation: rjr-pulse 1.6s ease-in-out infinite;
}
@keyframes rjr-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(59, 110, 245, 0.35);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(59, 110, 245, 0);
  }
}
.rjr-main {
  flex: 1 1 auto;
  min-width: 0;
}
.rjr-l1 {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.rjr-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--text);
}
.rjr-pct {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--muted);
}
.rjr[data-tone='err'] .rjr-pct {
  color: var(--err);
}
.rjr-l2 {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 1px;
  font-size: 11.5px;
  color: var(--muted);
}
.rjr-phase {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rjr-dur {
  flex: 0 0 auto;
}
.rjr-bar {
  margin-top: 4px;
}
.rjr-l3 {
  margin-top: 1px;
  font-size: 11px;
}
.rjr-err {
  margin-top: 3px;
  font-size: 11px;
  color: var(--err);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.rjr-acts {
  flex: 0 0 auto;
  margin-top: 1px;
}
/* naive-ui 的进度条底色在浮动层里偏深，压淡一档 */
.rjr-bar :deep(.n-progress-graph-line-rail) {
  background: var(--line);
}
</style>
