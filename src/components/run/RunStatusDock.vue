<script setup lang="ts">
/**
 * 全局运行状态浮窗。
 *
 * 为什么要有它：运行是一跑几十分钟的事，人不可能一直守在「运行」页 —
 * 实际动线是提交完就回剧本台改下一集。以前回去之后**状态就彻底消失了**，
 * 想知道跑完没有只能反复切页面。这个浮窗把同一份 `run.jobs` 挂在右下角，
 * 在任何页面都能看到「第几段 / 多少 % / 跑了多久」。
 *
 * 几条刻意的克制：
 *   - 只在有活时出现。空闲、或者结束超过 2 分钟，就整块消失 ——
 *     常驻一个"上次运行 3 天前"的角标，很快就会被当成噪音忽略。
 *   - 运行页不出现。那一页整块就是运行台，右下角再挂一个小的纯属重复。
 *   - 不自己起轮询。数据来自 run store 的 ws 推送 + 7 秒对账（store 里已有）；
 *     这里只负责显示，不新增一条会和它抢状态的数据源。
 *   - 未登录不读 kv。登录页也会挂载 App，这时候去读任务是必然 401 的。
 *
 * 只有"当前时刻"是这里自己的：每秒 +1，让耗时和「N 秒前」会自己动。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton } from 'naive-ui'
import { useRunStore, type RunJob } from '@/stores/run'
import { useAuthStore } from '@/stores/auth'
import { aggregate, isActiveStatus, recentFinish } from '@/domain/runStatus'
import RunJobRow from './RunJobRow.vue'

const route = useRoute()
const router = useRouter()
const run = useRunStore()
const auth = useAuthStore()

/** 展开 / 收起。默认收起 —— 它是个角标，不是面板 */
const open = ref(false)
/** 每秒推一格：耗时、合进度、"N 秒前"都靠它自己走 */
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

const visible = computed(() => route.name !== 'login' && route.name !== 'run')
const agg = computed(() => aggregate(run.jobs))
const activeJobs = computed(() => run.jobs.filter((j) => isActiveStatus(j.status)))
const justDone = computed(() => (agg.value.count ? null : recentFinish(run.jobs, now.value)))

/** 收起时只报最要紧的那一条：谁在跑 / 到哪了 */
const head = computed(() => (activeJobs.value[0] as RunJob | undefined) ?? null)

/** 展开时列哪些：优先在跑的，没有就列刚结束的那一条 */
const listJobs = computed<RunJob[]>(() => {
  if (activeJobs.value.length) return activeJobs.value
  return justDone.value ? [justDone.value] : []
})

/** 有活、或刚结束（2 分钟内），才露头 */
const show = computed(() => visible.value && (agg.value.count > 0 || !!justDone.value))

function startTimer() {
  if (timer) return
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
}
function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function openRun(episodeId?: string) {
  if (episodeId) router.push(`/p/${episodeId}`)
  else router.push('/run')
}
function toRunPage() {
  void router.push('/run')
}

/**
 * 挂载即接上：只有登录之后才去读任务表。
 * 路由守卫会在首屏导航时刷新登录态，所以这里 watch 而不是 onMounted 里读一次 ——
 * 首次挂载时 isLoggedIn 往往还是 false。
 */
watch(
  () => auth.isLoggedIn,
  async (yes) => {
    if (!yes) return
    await run.load()
    // load() 里如果发现还有活跃任务，会自己补连 ws 并立即对账，
    // 这一步是刷新页面后能把"运行中 0%"拉回真实状态的关键。
    startTimer()
  },
  { immediate: true }
)

/**
 * 有任务刚变成「出错」时自动展开一次。
 *
 * 这是唯一值得打断用户的时刻：他在别的页面改稿，任务静默失败了，
 * 不展开的话要等他自己想起来去看。只展开、不弹窗，不挡手。
 */
const seen = new Map<string, string>()
watch(
  () => run.jobs.map((j) => `${j.id}:${j.status}`),
  (list) => {
    let fresh = false
    for (const key of list) {
      const [id, status] = key.split(':')
      if (status === 'error' && seen.has(id) && seen.get(id) !== 'error') fresh = true
      seen.set(id, status)
    }
    if (fresh) open.value = true
  }
)

/** 标题栏跟着进度走：切到别的标签页时也能一眼看到跑完没有 */
const BASE_TITLE = '剧本台'
/** index.html 里的原标题：空闲时要原样还回去，不能把人家改成光秃秃四个字 */
const originalTitle = typeof document === 'undefined' ? BASE_TITLE : document.title

watch(
  [() => agg.value.percent, () => agg.value.count, show],
  () => {
    if (typeof document === 'undefined') return
    if (show.value && agg.value.count) {
      document.title = agg.value.known
        ? `[${agg.value.percent}%] 运行中 · ${BASE_TITLE}`
        : `[排队] 运行中 · ${BASE_TITLE}`
    } else if (show.value && justDone.value) {
      document.title = `[完成] ${BASE_TITLE}`
    } else {
      document.title = originalTitle
    }
  },
  { immediate: true }
)

async function stop(job: RunJob) {
  await run.interrupt(job.id)
}

onUnmounted(() => {
  stopTimer()
  if (typeof document !== 'undefined') document.title = originalTitle
})
</script>

<template>
  <div v-if="show" class="dock" :class="{ open }">
    <!-- 收起态：一条任务的一句话 -->
    <button v-if="!open" type="button" class="dock-pill" title="点开看运行详情" @click="open = true">
      <span class="dock-dot" :class="{ pulse: agg.running, done: !agg.count }" />
      <span class="dock-body">
        <span class="dock-line1">
          <template v-if="agg.count">
            <b>{{ agg.running ? '运行中' : '排队中' }}</b>
            <span class="muted"> · {{ head?.episodeName || head?.episodeId || '任务' }}</span>
          </template>
          <template v-else>
            <b>刚刚{{ justDone?.status === 'error' ? '出错' : '完成' }}</b>
          </template>
        </span>
        <span class="dock-line2">
          <template v-if="agg.count">
            {{ agg.known ? `${agg.percent}%` : `${agg.count} 个待开跑` }}
            <template v-if="agg.count > 1"> · {{ agg.count }} 个任务</template>
          </template>
          <template v-else>{{ justDone?.outputs?.length ?? 0 }} 个产物 · 点开看</template>
        </span>
      </span>
      <span class="dock-chev">‹</span>
      <span v-if="agg.count" class="dock-progress" :style="{ width: `${agg.percent}%` }" />
    </button>

    <!-- 展开态：逐条任务 -->
    <div v-else class="dock-card">
      <header class="dock-head">
        <span class="dock-title">
          {{ agg.count ? `运行台 · ${agg.count} 个在跑` : '最近一次运行' }}
        </span>
        <button type="button" class="dock-x" title="收起" @click="open = false">×</button>
      </header>
      <div class="dock-list">
        <RunJobRow
          v-for="job in listJobs"
          :key="job.id"
          :job="job"
          :now="now"
          compact
          @open="openRun(job.episodeId)"
          @stop="stop(job)"
        />
      </div>
      <footer class="dock-foot">
        <n-button size="tiny" quaternary @click="toRunPage">打开运行台</n-button>
        <span class="muted dock-src">ComfyUI 推送</span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.dock {
  position: fixed;
  right: 18px;
  bottom: 18px;
  /* 低于 naive-ui 的 modal / drawer（2000+），弹窗打开时它会乖乖待在下面 */
  z-index: 900;
}

/* ------------------------------- 收起态 ------------------------------- */
.dock-pill {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 208px;
  max-width: 300px;
  padding: 9px 12px 11px;
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow);
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: var(--text);
}
.dock-pill:hover {
  border-color: var(--line-strong);
}
.dock-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
}
.dock-dot.pulse {
  animation: dock-pulse 1.6s ease-in-out infinite;
}
.dock-dot.done {
  background: var(--ok);
}
@keyframes dock-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(59, 110, 245, 0.35);
  }
  50% {
    box-shadow: 0 0 0 5px rgba(59, 110, 245, 0);
  }
}
.dock-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1 1 auto;
}
.dock-line1 {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dock-line1 b {
  font-weight: 600;
}
.dock-line2 {
  font-size: 11.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.dock-chev {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 14px;
  line-height: 1;
  transform: rotate(180deg);
}
/* 底边那一条细进度：不占高度，扫一眼就知道大概到哪 */
.dock-progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  background: var(--accent);
  transition: width 0.4s ease;
}

/* ------------------------------- 展开态 ------------------------------- */
.dock-card {
  width: 320px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.dock-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
}
.dock-title {
  font-size: 12.5px;
  font-weight: 600;
}
.dock-x {
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}
.dock-x:hover {
  color: var(--text);
}
.dock-list {
  padding: 4px 8px;
  max-height: 260px;
  overflow-y: auto;
}
.dock-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid var(--line);
  background: var(--panel-2);
}
.dock-src {
  font-size: 10.5px;
  white-space: nowrap;
}
</style>
