<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NInput, NModal, NPopconfirm, NSpin, useMessage } from 'naive-ui'
import { useSeriesStore } from '@/stores/series'
import { useProviderStore } from '@/stores/provider'
import { useStorageStore } from '@/stores/storage'
import { useRunStore } from '@/stores/run'
import { aggregate, isActiveStatus, statusOf } from '@/domain/runStatus'
import ProviderDialog from '@/components/ProviderDialog.vue'
import StorageDialog from '@/components/StorageDialog.vue'
import ImportProjectDialog from '@/components/ImportProjectDialog.vue'
import RunJobRow from '@/components/run/RunJobRow.vue'
import TopTabs from '@/components/TopTabs.vue'
import { exportProjectFile, isBackend } from '@/db'
import InfoTip from '@/components/common/InfoTip.vue'

const router = useRouter()
const series = useSeriesStore()
const provider = useProviderStore()
const storage = useStorageStore()
const run = useRunStore()
const message = useMessage()

const showCreate = ref(false)
const showProvider = ref(false)
const showStorage = ref(false)
const showImport = ref(false)
const newName = ref('')
const newEpisode = ref('')

// 后端必须连上才能读库；没连上就先给出拦截，不读数据
const backendReady = ref(false)

/* ------------------------------ 运行状态 ------------------------------ */

/**
 * 首页只做"瞭望"：有哪些任务在跑、跑到哪、跑了多久，以及点进去。
 *
 * 详细的东西（产物、日志、参数）一律留在运行页 —— 首页是选项目的地方，
 * 把任务卡片墙搬过来会把项目列表挤到第二屏。
 *
 * 数据源和运行页、右下角浮窗是**同一个** run store：不新开轮询，
 * 这里只借它已经维护好的推送 + 对账结果。
 */
const now = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null

const agg = computed(() => aggregate(run.jobs))
const activeJobs = computed(() => run.jobs.filter((j) => isActiveStatus(j.status)))
/** 最近一条已结束的任务（jobs 是新的在前），空闲态那句「最近 10:02 完成」用它 */
const lastDone = computed(() => run.jobs.find((j) => !isActiveStatus(j.status)) ?? null)

function clockOf(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function openRun() {
  void router.push('/run')
}

function openEpisode(id: string) {
  if (id) void router.push(`/p/${id}`)
}

async function stopJob(id: string) {
  await run.interrupt(id)
}

onMounted(async () => {
  await storage.init()
  backendReady.value = storage.ready
  if (!storage.ready) return
  // 任务表也要读：这里要显示「谁在跑」，不能等用户切到运行页才去读
  await Promise.all([series.loadAll(), provider.load(), run.load()])
  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
})

async function retryConnect() {
  const ok = await storage.connect()
  if (ok) location.reload()
}

async function create() {
  if (!newName.value.trim()) {
    message.warning('请填写项目名称')
    return
  }
  const s = await series.createSeries(newName.value.trim(), newEpisode.value.trim())
  showCreate.value = false
  newName.value = ''
  newEpisode.value = ''
  router.push(`/s/${s.id}`)
}

function open(id: string) {
  router.push(`/s/${id}`)
}

async function remove(id: string, name: string) {
  await series.removeSeries(id)
  message.success(`已删除「${name}」`)
}

/**
 * 项目级导出：项目 + 各集（含分镜/主体/素材文件）+ 用到的音色包。
 * 目的很具体 —— 在另一台设备上导入后能直接接着做，而不是只拿到一份 JSON。
 */
const exporting = ref('')

async function exportProject(id: string, name: string) {
  exporting.value = id
  try {
    const { blob, filename } = await exportProjectFile(id, name)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
    message.success(`已导出「${name}」（${(blob.size / 1048576).toFixed(1)} MB）`)
  } catch (err) {
    message.error(`导出失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    exporting.value = ''
  }
}

function episodeCount(s: { episodeIds?: string[] }): number {
  return s.episodeIds?.length ?? 0
}
</script>

<template>
  <div class="lib-wrap">
    <div class="row-between" style="margin-bottom: 6px">
      <div class="row" style="gap: 14px">
        <h1 style="margin: 0; font-size: 24px; letter-spacing: -0.01em">剧本台</h1>
        <TopTabs />
      </div>
      <div class="row">
        <n-button quaternary @click="showStorage = true">
          存储
          <span class="tag-chip" :class="isBackend() ? 'info' : 'mute'" style="margin-left: 6px">
            {{ isBackend() ? '后端目录' : '浏览器' }}
          </span>
        </n-button>
        <n-button quaternary @click="showProvider = true">
          模型设置
          <span class="tag-chip" :class="provider.ready ? 'info' : 'err'" style="margin-left: 6px">
            {{ provider.ready ? '已连接' : '未配置' }}
          </span>
        </n-button>
        <n-button quaternary @click="showImport = true">导入项目</n-button>
        <n-button type="primary" @click="showCreate = true">新建项目</n-button>
      </div>
    </div>

    <div class="muted row" style="margin-top: 4px; font-size: 12.5px; gap: 0; align-items: center">
      项目 → 多集，每集独立打包
      <InfoTip
        size="sm"
        :width="320"
        text="大主体挂在项目层，可注入到任意一集；每集可选用一套工作流模板。"
      />
    </div>

    <template v-if="backendReady">
      <!--
        运行状态：有活在跑才铺成一块面板（逐条任务），空闲时收成一行。
        首页的主语是项目列表，状态区不能把它挤到第二屏。
      -->
      <section v-if="agg.count" class="panel run-card">
        <div class="panel-head">
          <div class="row" style="gap: 8px">
            <span>{{ agg.running ? '运行中' : '排队中' }}</span>
            <span class="tag-chip run-chip">{{ agg.count }} 个任务</span>
            <span v-if="agg.known" class="muted run-pct">{{ agg.percent }}%</span>
          </div>
          <n-button size="tiny" quaternary @click="openRun">打开运行台</n-button>
        </div>
        <div class="run-list">
          <RunJobRow
            v-for="job in activeJobs"
            :key="job.id"
            :job="job"
            :now="now"
            @open="openEpisode(job.episodeId)"
            @stop="stopJob(job.id)"
          />
        </div>
      </section>

      <!-- 空闲：一行就够，但要看得到「上一次跑成没成」 -->
      <div v-else class="run-idle">
        <span class="run-idle-dot" />
        <span>运行台空闲</span>
        <span v-if="lastDone" class="muted">
          · 最近 {{ clockOf(lastDone.endedAt) }} {{ statusOf(lastDone).text }}，{{ lastDone.outputs.length }} 个产物
        </span>
        <span v-else class="muted">· 还没有提交过任务</span>
        <button type="button" class="run-idle-link" @click="openRun">去运行台</button>
      </div>

      <div v-if="!series.seriesList.length" class="panel" style="margin-top: 28px">
        <div class="empty">
          <div style="font-size: 15px; margin-bottom: 6px">还没有项目</div>
          <div class="row" style="justify-content: center; gap: 0; align-items: center">
            新建一个项目，下面可放多集
            <InfoTip
              size="sm"
              :width="320"
              text="每集是一个独立工作台（故事 → 片段 → 组合 → 导演包）。&#10;在别的设备上做过？用「导入项目」把项目包（含各集、素材、音色包）搬过来。"
            />
          </div>
        </div>
      </div>

      <div v-else class="proj-grid">
        <article v-for="s in series.seriesList" :key="s.id" class="panel proj">
          <div class="proj-head">
            <span class="proj-name" :title="s.name">{{ s.name }}</span>
            <span class="chip info">{{ episodeCount(s) }} 集</span>
          </div>
          <div class="proj-body">
            <div class="proj-desc">项目 / 系列 · 大主体可注入到任意一集</div>
          </div>
          <div class="proj-foot">
            <n-button size="small" type="primary" ghost @click="open(s.id)">打开</n-button>
            <div class="row" style="gap: 4px">
              <n-button
                size="small"
                quaternary
                :loading="exporting === s.id"
                :title="`把「${s.name}」连同各集、素材、音色包打成一个 zip，可在别的设备导入`"
                @click="exportProject(s.id, s.name)"
              >
                导出项目包
              </n-button>
              <n-popconfirm @positive-click="remove(s.id, s.name)">
                <template #trigger>
                  <n-button size="small" quaternary type="error">删除</n-button>
                </template>
                同时删除该项目下的所有集与大主体，确定？
              </n-popconfirm>
            </div>
          </div>
        </article>
      </div>
    </template>

    <div v-else class="panel" style="margin-top: 28px; padding: 48px 24px; text-align: center">
      <n-spin v-if="storage.checking" size="large" style="margin-bottom: 12px" />
      <template v-else>
        <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px">后端未连接</div>
        <div class="muted" style="font-size: 13px; line-height: 1.9">
          所有数据都保存在 Python 后端里，现在连不上后端，暂时无法读取或写入项目。<br />
          请在项目目录运行 <code>python server/app.py</code>（地址 <span class="mono">{{ storage.baseUrl }}</span>），
          启动后点下方按钮重试。
        </div>
        <div style="margin-top: 16px">
          <n-button type="primary" @click="retryConnect">重试连接后端</n-button>
        </div>
      </template>
    </div>

    <n-modal v-model:show="showCreate" preset="card" title="新建项目" style="max-width: 520px">
      <div class="stack">
        <div>
          <div class="muted" style="margin-bottom: 6px">项目名称</div>
          <n-input v-model:value="newName" placeholder="例如：毒尊归来" />
        </div>
        <div>
          <div class="muted" style="margin-bottom: 6px">首集名称（可选，留空自动「第 01 集」）</div>
          <n-input v-model:value="newEpisode" placeholder="第 01 集" />
        </div>
        <div class="muted row" style="font-size: 12px; gap: 0; align-items: center">
          项目是顶层容器
          <InfoTip
            size="sm"
            :width="320"
            text="下面可放多集（每集独立工作台、独立打包），项目层可维护「大主体」并注入到任意一集。"
          />
        </div>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button @click="showCreate = false">取消</n-button>
          <n-button type="primary" @click="create">创建并打开</n-button>
        </div>
      </template>
    </n-modal>

    <ProviderDialog v-model:show="showProvider" />
    <StorageDialog v-model:show="showStorage" />
    <ImportProjectDialog v-model:show="showImport" />
  </div>
</template>

<style scoped>
/*
 * 资料库是"门户页"，不是工作台：留白要大、卡片要宽。
 * 原来 max-width 1080 + minmax(300px) 在 1600 屏上只剩中间一小条，
 * 项目卡被压成 220 宽，标题一长就换行。
 */
.lib-wrap {
  max-width: 1180px;
  margin: 0 auto;
  padding: 30px 22px 72px;
}

/* 项目卡：卡头灰底带 + 正文 + 动作脚，和交付页模块卡同一套骨架 */
.proj-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
  margin-top: 22px;
}
.proj {
  display: flex;
  flex-direction: column;
}
.proj-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 9px 12px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--line);
}
.proj-name {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-lg);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.proj-body {
  flex: 1;
  padding: 10px 12px 12px;
}
.proj-desc {
  font-size: var(--fs-md);
  line-height: 1.6;
  color: var(--muted);
}
.proj-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  background: var(--panel-2);
}

:deep(.n-empty) {
  --n-icon-color: var(--line-strong);
}

.run-card {
  margin-top: 18px;
}
.run-chip {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 500;
}
.run-pct {
  font-size: 12px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
.run-list {
  padding: 4px 10px 8px;
}

.run-idle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 18px;
  padding: 9px 14px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  font-size: 12.5px;
}
.run-idle-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--line-strong);
}
.run-idle-link {
  margin-left: auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.run-idle-link:hover {
  text-decoration: underline;
}
</style>
