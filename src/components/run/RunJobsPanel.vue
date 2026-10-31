<script setup lang="ts">
/**
 * 运行台：选一集 → 编好导演包 → 提交 → 看进度与产物。
 *
 * 为什么"选集"放在这里而不是复用工作台：提交需要**段的最终态**（六段式全文、
 * 副帧、参考图 blob），这些都由 assembly / registry 现算。工作台那边每次
 * 切 tab 都在改同一个 store，把提交塞进去会和编辑状态互相打架。
 * 这里按需加载一次，算完就走，不动工作台的编辑上下文。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NEmpty,
  NProgress,
  NSelect,
  NSpin,
  NSwitch,
  NTag,
  useMessage
} from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { useAssemblyStore } from '@/stores/assembly'
import { useWorkflowStore } from '@/stores/workflow'
import { useRunStore } from '@/stores/run'
import { useGateStore } from '@/stores/gate'
import { setStorageProject } from '@/db'
import { packSegmentOf } from '@/domain/packInput'
import {
  buildDirectorPack,
  buildDirectorPackZip,
  DEFAULT_OUTPUT_HEIGHT,
  DEFAULT_OUTPUT_WIDTH,
  type PackBuildInput
} from '@/domain/pack'
import { resolveWorkflowName } from '@/domain/run'

/**
 * compact = 放在运行页右侧窄栏里（420px）。
 *
 * 同一份面板以前是整页宽的：四个下拉铺成一行，任务列表占满整幅。
 * 塞进窄栏后不能只是"变窄" —— 表单要改单列、内距要收，否则每行输入框
 * 都被挤成一条缝。提交逻辑与数据流完全不变，只影响排版。
 */
const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

const project = useProjectStore()
const beats = useBeatStore()
const registry = useRegistryStore()
const assembly = useAssemblyStore()
const workflow = useWorkflowStore()
const run = useRunStore()
const gate = useGateStore()
const message = useMessage()

const seriesId = ref<string | null>(null)
const episodeId = ref<string | null>(null)
const loadingEp = ref(false)
const submitting = ref(false)
const openLogs = ref<Record<string, boolean>>({})

/* ------------------------------ 集选择 ------------------------------ */

const seriesList = computed(() => project.projects.filter((p) => p.kind === 'series'))
const looseEpisodes = computed(() => project.projects.filter((p) => (p.kind ?? 'episode') === 'episode' && !p.seriesId))
const episodeOptions = computed(() => {
  const s = project.projects.find((p) => p.id === seriesId.value)
  const ids = s?.episodeIds ?? []
  const fromSeries = ids
    .map((id) => project.projects.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => !!p)
  return [...fromSeries, ...looseEpisodes.value].map((p) => ({ label: p.name, value: p.id }))
})

onMounted(async () => {
  await project.loadAll()
  if (seriesList.value.length) seriesId.value = seriesList.value[0].id
  else if (looseEpisodes.value.length) episodeId.value = looseEpisodes.value[0].id

  // 刷新过页面的话，ws 是断的：这里补连一次并对账，把"运行中 0%"拉回真实状态
  await run.load()
  const base = run.active?.baseUrl || run.jobs[0]?.baseUrl
  if (base && run.running.length) {
    run.connect(base)
    void run.reconnect()
  }
})

/** 每秒走一格，只为让"最后更新 Ns 前"自己动起来 */
const tick = ref(0)
let tickTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  tickTimer = setInterval(() => {
    tick.value += 1
  }, 1000)
})
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
})

watch(seriesId, (id) => {
  const s = project.projects.find((p) => p.id === id)
  episodeId.value = s?.episodeIds?.[0] ?? null
})

/** 选中集之后才加载它的数据 —— 段视图要段/素材/装配三张表都在 */
watch(episodeId, async (id) => {
  pack.value = null
  if (!id) return
  loadingEp.value = true
  try {
    await project.select(id)
    setStorageProject(id)
    await Promise.all([registry.load(id), beats.load(id), assembly.load(id)])
    await registry.hydrateAssetBlobs()
  } catch (err) {
    message.error(`加载这一集失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    loadingEp.value = false
  }
})

/* ------------------------------ 导演包 ------------------------------ */

const settings = computed(() => project.settings)
const schema = computed(() => project.fieldSchema)

const views = computed(() => {
  const cur = assembly.current
  if (!cur) return []
  return assembly.buildSegmentViews(
    cur,
    beats.ordered,
    settings.value,
    registry.entityById,
    schema.value,
    registry.assets
  )
})

const cfg = computed(() =>
  (episodeId.value ? run.configForEpisode(episodeId.value) : null) ?? run.active
)

const canvas = computed(() => ({
  width: cfg.value?.width ?? DEFAULT_OUTPUT_WIDTH,
  height: cfg.value?.height ?? DEFAULT_OUTPUT_HEIGHT
}))

const packInput = computed<PackBuildInput>(() => ({
  projectName: project.current?.name ?? '',
  settings: settings.value,
  // 段视图 → 包段输入：与「产物」页共用 domain/packInput，timeline 必须逐字一致，
  // 否则产物页拿 index 去对缓存槽会对到别人身上。
  segments: views.value.map((v) =>
    packSegmentOf(v, schema.value, registry.entityById, registry.assets, settings.value)
  ),
  assets: registry.assets,
  width: canvas.value.width,
  height: canvas.value.height
}))

const packWarnings = computed(() => {
  if (!views.value.length) return []
  try {
    return buildDirectorPack(packInput.value).warnings
  } catch {
    return []
  }
})

const totalFrames = computed(() =>
  views.value.reduce((s, v) => s + Math.max(5, Math.round(v.frames)), 0)
)

const refCount = computed(() => registry.assets.filter((a) => a.pictureN > 0).length)

/** 缓存里真的有图的素材数 —— 没 blob 的图不会进包，对面会静默清空槽位 */
const refWithBlob = computed(() => registry.assets.filter((a) => a.pictureN > 0 && a.blob).length)

const pack = ref<{ blob: Blob; filename: string; timeline: Record<string, unknown> } | null>(null)

async function buildPack() {
  if (!views.value.length) {
    message.warning('这一集还没有可交付的段')
    return null
  }
  const res = await buildDirectorPackZip(packInput.value)
  pack.value = { blob: res.blob, filename: res.filename, timeline: res.timeline }
  return pack.value
}

/* ------------------------------ 模板与配置 ------------------------------ */

const templateOptions = computed(() =>
  workflow.templates.map((t) => ({ label: t.name, value: t.id }))
)
const templateId = ref<string | null>(null)
const template = computed(
  () => workflow.templates.find((t) => t.id === templateId.value) ?? workflow.active
)

const configOptions = computed(() => run.configs.map((c) => ({ label: c.name, value: c.id })))
const configId = ref<string | null>(null)
const runCfg = computed(() => run.configs.find((c) => c.id === configId.value) ?? cfg.value)

watch(
  () => [workflow.templates.length, episodeId.value],
  () => {
    if (!templateId.value) {
      const bound = episodeId.value ? workflow.templateForEpisode(episodeId.value) : null
      templateId.value = bound?.id ?? workflow.activeId
    }
    const boundCfg = episodeId.value ? run.configForEpisode(episodeId.value) : null
    configId.value = boundCfg?.id ?? run.activeId
  },
  { immediate: true }
)

const cacheDir = computed(() =>
  runCfg.value
    ? resolveWorkflowName(runCfg.value, project.current?.name ?? '')
    : ''
)

/* ------------------------------ 提交 ------------------------------ */

/**
 * 跟随左栏选中的运行配置。
 *
 * run.load() 是异步的：本组件 immediate 那次执行时 activeId 还是 null，
 * 于是"运行配置"下拉一直停在"请选择"——明明左边已经选好一个，右边还要再选一次。
 * 这里补一条跟随：左边换配置，右边提交的就是那一个；用户仍可在这里临时改。
 */
watch(
  () => run.activeId,
  (id) => {
    if (!id) return
    const bound = episodeId.value ? run.configForEpisode(episodeId.value) : null
    configId.value = bound?.id ?? id
  },
  { immediate: true }
)

/**
 * 内容门禁：这一集本身还不够出片。
 *
 * 与下面的 submitBlockers 刻意分开：那些是"配置没选好"，一秒就能补；
 * 这些是"剧本还没做完"，得回工作台改。混成一行会让用户以为换个模板就行。
 *
 * 判定来自 stores/gate，和导航拦的是同一份 —— 不会出现"页面进得去、提交被拒"。
 */
const contentBlockers = computed(() =>
  views.value.length ? gate.guard('video') : []
)

const canSubmit = computed(
  () =>
    !!episodeId.value &&
    !!views.value.length &&
    !!template.value?.api &&
    !!runCfg.value &&
    !submitting.value &&
    contentBlockers.value.length === 0
)

const submitBlockers = computed(() => {
  const out: string[] = []
  if (!episodeId.value) out.push('还没选集')
  if (episodeId.value && !views.value.length) out.push('这一集还没有可交付的段')
  if (!template.value?.api) out.push('选用的模板还没导入 API 工作流（去工作流控制台导入）')
  if (!runCfg.value) out.push('没有运行配置')
  return out
})

async function submit() {
  const tpl = template.value
  const rc = runCfg.value
  if (!episodeId.value || !tpl?.api || !rc) return
  // 按钮已按门禁禁用，这里再挡一次：快捷键 / 回车重放也不能绕过
  if (contentBlockers.value.length) {
    message.error(`还不能出片：${contentBlockers.value[0]}`, { duration: 9000 })
    return
  }
  submitting.value = true
  try {
    const built = pack.value ?? (await buildPack())
    if (!built) return
    const job = await run.submit({
      episodeId: episodeId.value,
      episodeName: project.current?.name ?? '',
      templateName: tpl.name,
      api: tpl.api,
      values: tpl.values,
      timeline: built.timeline,
      packBlob: rc.usePackImport ? built.blob : null,
      packFilename: built.filename,
      config: rc
    })
    message.success(`已提交：${job.promptId.slice(0, 8)}…`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err), { duration: 9000 })
  } finally {
    submitting.value = false
  }
}

/* ------------------------------ 任务列表 ------------------------------ */

const STATUS_LABEL: Record<string, { text: string; type: 'default' | 'info' | 'success' | 'error' | 'warning' }> = {
  submitting: { text: '提交中', type: 'info' },
  queued: { text: '排队', type: 'info' },
  running: { text: '运行中', type: 'info' },
  done: { text: '完成', type: 'success' },
  error: { text: '出错', type: 'error' },
  interrupted: { text: '已中断', type: 'warning' }
}

function pct(job: { progress: { value: number; max: number } }): number {
  const p = job.progress
  if (!p.max) return 0
  return Math.min(100, Math.round((p.value / p.max) * 100))
}

/** 进度事件最后一次到达到现在多久了 —— 判断"卡住"和"只是没上报"就看它 */
function sinceLabel(ts: number): string {
  void tick.value
  if (!ts) return '还没收到进度'
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  return s < 60 ? `${s}s 前` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s 前`
}

function waited(job: { startedAt: number | null; submittedAt: number }): string {
  void tick.value
  const from = job.startedAt ?? job.submittedAt
  const s = Math.max(0, Math.round((Date.now() - from) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

function reconnectAll() {
  const base = run.active?.baseUrl || run.jobs[0]?.baseUrl
  if (!base) {
    message.warning('没有可用的 ComfyUI 地址')
    return
  }
  run.connect(base)
  void run.reconnect()
  message.info('已重连 WebSocket 并重新对账')
}

function time(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function duration(job: { startedAt: number | null; endedAt: number | null }): string {
  if (!job.startedAt) return '—'
  const end = job.endedAt ?? Date.now()
  const s = Math.max(0, Math.round((end - job.startedAt) / 1000))
  const m = Math.floor(s / 60)
  return m ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}
</script>

<template>
  <div class="jobs" :class="{ compact: props.compact }">
    <!-- 提交区 -->
    <section class="panel">
      <div class="panel-head">
        <span>发起运行</span>
        <span class="muted" style="font-size: 12px">
          {{ run.jobs.length }} 个任务 · {{ run.running.length }} 个在跑
        </span>
      </div>
      <div class="panel-body" style="padding: 12px 14px">
        <div class="pick">
          <label class="f">
            <span class="f-label">系列</span>
            <n-select
              v-model:value="seriesId"
              :options="seriesList.map((s) => ({ label: s.name, value: s.id }))"
              size="small"
              clearable
              placeholder="（无系列）"
            />
          </label>
          <label class="f">
            <span class="f-label">集</span>
            <n-select v-model:value="episodeId" :options="episodeOptions" size="small" />
          </label>
          <label class="f">
            <span class="f-label">工作流模板</span>
            <n-select v-model:value="templateId" :options="templateOptions" size="small" />
          </label>
          <label class="f">
            <span class="f-label">运行配置</span>
            <n-select v-model:value="configId" :options="configOptions" size="small" />
          </label>
        </div>

        <div v-if="loadingEp" class="row" style="gap: 8px; padding: 10px 0">
          <n-spin size="small" /><span class="muted" style="font-size: 12.5px">正在读取这一集…</span>
        </div>

        <template v-else-if="views.length">
          <div class="summary mono">
            {{ views.length }} 段 · 约 {{ totalFrames }} 帧 · {{ canvas.width }}×{{ canvas.height }}
            · 选卡 {{ runCfg?.cards === '关闭' ? '单卡' : runCfg?.cards }}
            · 步数 {{ runCfg?.steps }} · 缓存 {{ cacheDir || '—' }}
          </div>
          <div class="summary muted">
            参考图 {{ refWithBlob }}/{{ refCount }} 张带图
            <template v-if="runCfg?.secondEnabled"> · 开二采</template>
            <template v-if="runCfg?.randomSeed"> · 每次随机种子</template>
          </div>

          <n-alert
            v-if="contentBlockers.length"
            type="error"
            :bordered="false"
            style="margin-top: 10px"
          >
            <div style="font-weight: 600; font-size: 13px; margin-bottom: 4px">
              还不能出片：前面的阶段没做完
            </div>
            <ul style="margin: 0; padding-left: 18px; font-size: 12.5px; line-height: 1.8">
              <li v-for="(b, i) in contentBlockers" :key="i">{{ b }}</li>
            </ul>
          </n-alert>

          <n-alert v-if="packWarnings.length" type="warning" :show-icon="false" style="margin-top: 10px">
            <ul style="margin: 0; padding-left: 18px; font-size: 12.5px; line-height: 1.8">
              <li v-for="(w, i) in packWarnings" :key="i">{{ w }}</li>
            </ul>
          </n-alert>

          <div class="row" style="gap: 8px; margin-top: 12px">
            <n-button size="small" type="primary" :disabled="!canSubmit" :loading="submitting" @click="submit">
              提交运行
            </n-button>
            <n-button size="small" quaternary @click="buildPack">先编一次导演包</n-button>
            <n-button
              v-if="episodeId && configId"
              size="small"
              quaternary
              @click="run.bindEpisode(episodeId!, configId)"
            >
              把这套配置绑到这一集
            </n-button>
            <span v-if="pack" class="muted" style="font-size: 12px">
              已编 {{ pack.filename }}（{{ (pack.blob.size / 1024 / 1024).toFixed(2) }} MB）
            </span>
          </div>
          <div v-if="submitBlockers.length" class="muted" style="font-size: 12px; margin-top: 8px">
            {{ submitBlockers.join(' · ') }}
          </div>
        </template>

        <div v-else-if="episodeId" class="muted" style="font-size: 12.5px; padding: 10px 0">
          这一集还没有可交付的段（先在工作台跑到「交付」）。
        </div>
      </div>
    </section>

    <!-- 任务 -->
    <div v-if="!run.jobs.length" class="panel" style="margin-top: 16px">
      <n-empty description="还没有提交过任务" style="padding: 40px 0" />
    </div>

    <section v-for="job in run.jobs" :key="job.id" class="panel" style="margin-top: 12px">
      <div class="panel-head">
        <div class="row" style="gap: 8px">
          <n-tag size="small" :type="STATUS_LABEL[job.status]?.type ?? 'default'" :bordered="false">
            {{ STATUS_LABEL[job.status]?.text ?? job.status }}
          </n-tag>
          <span>{{ job.episodeName || job.episodeId }}</span>
          <span class="muted" style="font-size: 11.5px">{{ job.configName }}</span>
          <!-- 部分运行：不标出来，事后只会觉得"这次怎么这么快就完了" -->
          <n-tag v-if="job.onlySegments?.length" size="tiny" type="info" :bordered="false">
            只跑 {{ job.onlySegments.length }}/{{ job.segmentTotal ?? '?' }} 段
          </n-tag>
        </div>
        <div class="row" style="gap: 4px">
          <span class="muted mono" style="font-size: 11.5px">{{ job.promptId.slice(0, 8) }}</span>
          <n-button
            v-if="job.status === 'running' || job.status === 'queued'"
            size="tiny"
            quaternary
            type="error"
            @click="run.interrupt(job.id)"
          >
            中断
          </n-button>
          <n-button
            v-if="job.status === 'done' || job.status === 'error'"
            size="tiny"
            quaternary
            @click="run.refresh(job.id)"
          >
            重取产物
          </n-button>
        </div>
      </div>

      <div class="panel-body" style="padding: 10px 14px 12px">
        <div class="row-between" style="font-size: 12px; margin-bottom: 4px">
          <span>
            <template v-if="job.progress.segment">
              第 {{ job.progress.segment }}/{{ job.progress.segmentTotal || '?' }} 段
            </template>
            <template v-else-if="job.progress.phaseLabel">{{ job.progress.phaseLabel }}</template>
            <template v-else-if="job.status === 'running' || job.status === 'queued'">
              排队 / 准备中（已 {{ waited(job) }}）
            </template>
            <template v-else>{{ job.outputs.length }} 个产物</template>
            <span v-if="job.progress.framesLabel" class="muted"> · {{ job.progress.framesLabel }}</span>
          </span>
          <span class="muted mono">{{ duration(job) }}</span>
        </div>
        <n-progress
          v-if="job.status === 'running' || job.status === 'queued'"
          :percentage="pct(job)"
          :height="8"
          :show-indicator="false"
          :processing="!job.progress.max"
        />
        <div
          v-if="job.status === 'running' || job.status === 'queued'"
          class="muted"
          style="font-size: 11.5px; margin-top: 4px"
        >
          {{ job.progress.max ? `${pct(job)}%` : '还没收到进度上报' }}
          · 更新于 {{ sinceLabel(job.progress.updatedAt) }}
          <template v-if="job.progress.remainingSegments">
            · 还剩 {{ job.progress.remainingSegments }} 段
          </template>
        </div>

        <div v-if="job.error" class="err">{{ job.error }}</div>

        <!-- 产物 -->
        <div v-if="job.outputs.length" class="outs">
          <div v-for="(o, i) in job.outputs" :key="i" class="out" :class="o.kind">
            <!-- 视频必须给 controls：以前既没有 controls 也没 autoplay，即使认成了
                 视频也不会自己播；点击整个卡片是跳新标签，控件根本点不到。 -->
            <video
              v-if="o.kind === 'video'"
              :src="o.url"
              :title="o.filename"
              controls
              playsinline
              preload="metadata"
            />
            <img v-else :src="o.url" :alt="o.filename" loading="lazy" />
            <div class="out-bar">
              <span class="out-name" :title="o.filename">{{ o.filename }}</span>
              <a class="out-open" :href="o.url" target="_blank" rel="noreferrer" title="新标签打开原文件">
                打开
              </a>
            </div>
          </div>
        </div>

        <!-- 日志 -->
        <div class="row" style="gap: 6px; margin-top: 8px">
          <n-button size="tiny" quaternary @click="openLogs[job.id] = !openLogs[job.id]">
            {{ openLogs[job.id] ? '收起日志' : `日志（${job.logs.length}）` }}
          </n-button>
          <span v-if="job.skipped.length" class="muted" style="font-size: 11.5px">
            {{ job.skipped.length }} 个参数未命中
          </span>
        </div>
        <div v-if="openLogs[job.id]" class="logs mono">
          <div v-for="(l, i) in job.logs" :key="i" :class="l.level">
            {{ time(l.t) }} {{ l.text }}
          </div>
        </div>
      </div>
    </section>

    <div v-if="run.jobs.length" class="row" style="gap: 8px; padding: 16px 0 60px">
      <n-button size="small" quaternary @click="run.clearFinished()">清掉已结束的</n-button>
      <n-button size="small" quaternary @click="reconnectAll">重连并重新对账</n-button>
    </div>
  </div>
</template>

<style scoped>
.jobs {
  padding: 16px 20px 40px;
}
/* 窄栏排版：单列表单、收紧内距 */
.jobs.compact {
  padding: 12px 12px 28px;
}
.jobs.compact .pick {
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}
.jobs.compact .out {
  width: 100%;
}
.pick {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px 14px;
}
.f {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.f-label {
  font-size: 11.5px;
  color: var(--muted);
}
.summary {
  font-size: 12px;
  margin-top: 10px;
  line-height: 1.6;
}
.summary.muted {
  color: var(--muted);
}
.err {
  margin-top: 8px;
  font-size: 12px;
  color: var(--err);
  line-height: 1.7;
  word-break: break-all;
}
.outs {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.out {
  width: 100%;
  min-width: 0;
}
.out img,
.out video {
  width: 100%;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: #000;
  display: block;
}
/* 缩略图按 16:9 裁切；视频给播放器留出控件条的高度，别把控件压在画面上 */
.out.image img {
  height: 84px;
  object-fit: cover;
}
.out.video video {
  aspect-ratio: 16 / 9;
  height: auto;
  object-fit: contain;
}
.out-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.out-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.out-open {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--accent);
  text-decoration: none;
}
.out-open:hover {
  text-decoration: underline;
}
.logs {
  margin-top: 6px;
  max-height: 240px;
  overflow-y: auto;
  font-size: 11.5px;
  line-height: 1.7;
  background: var(--panel-2);
  border-radius: 8px;
  padding: 8px 10px;
}
.logs .warn {
  color: var(--warn);
}
.logs .error {
  color: var(--err);
}
</style>
