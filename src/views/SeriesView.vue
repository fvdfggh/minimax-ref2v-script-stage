<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NInput, NPopconfirm, NSelect, NSpin, useMessage } from 'naive-ui'
import { useSeriesStore } from '@/stores/series'
import { useWorkflowStore } from '@/stores/workflow'
import { useRegistryStore } from '@/stores/registry'
import { useProviderStore } from '@/stores/provider'
import { useStorageStore } from '@/stores/storage'
import { setStorageProject } from '@/db'
import ProviderDialog from '@/components/ProviderDialog.vue'
import SubjectManager from '@/components/SubjectManager.vue'
import TopTabs from '@/components/TopTabs.vue'
import { ENTITY_TYPES } from '@/domain/types'
import { ENTITY_TYPE_LABEL } from '@/domain/registry'
import type { ID } from '@/domain/types'
import InfoTip from '@/components/common/InfoTip.vue'

const route = useRoute()
const router = useRouter()
const message = useMessage()

const series = useSeriesStore()
const workflow = useWorkflowStore()
const registry = useRegistryStore()
const provider = useProviderStore()
const storage = useStorageStore()

const backendReady = ref(false)
const booted = ref(false)
const showProvider = ref(false)
/** 项目页两个视图：各集 / 统一的主体管理 */
const view = ref<'episodes' | 'subjects'>('episodes')

const seriesId = computed(() => String(route.params.id ?? ''))

/**
 * 集级模板选择。
 * 空值 = 跟随控制台当前模板（多数情况下就是这个）；选具体模板 = 把这集钉在
 * 某套参数上，之后在控制台改别的模板不会影响它。
 */
const templateOptions = computed(() => [
  { label: '默认（跟随控制台）', value: '' },
  ...workflow.templates.map((t) => ({ label: t.name, value: t.id }))
])

function onPickTemplate(episodeId: ID, value: string | number | null) {
  void series.setEpisodeTemplate(episodeId, String(value ?? '') as ID | '')
}

async function boot() {
  await storage.init()
  backendReady.value = storage.ready
  if (!storage.ready) {
    booted.value = true
    return
  }
  await series.loadAll()
  await series.select(seriesId.value)
  setStorageProject(seriesId.value)
  // 大主体 = 项目(系列)自身的实体表
  await registry.load(seriesId.value)
  await provider.load()
  await workflow.load()
  booted.value = true
}

onMounted(boot)
watch(seriesId, async () => {
  booted.value = false
  await boot()
})

async function retryConnect() {
  const ok = await storage.connect()
  if (ok) location.reload()
}

/* ------------------------------- 项目(系列) ------------------------------- */

const seriesName = computed({
  get: () => series.current?.name ?? '',
  set: (v: string) => series.renameSeries(seriesId.value, v)
})

async function addEpisode() {
  await series.createEpisode(seriesId.value)
  message.success('已新增一集')
}

async function removeEpisode(id: ID) {
  const name = series.episodes.find((e) => e.id === id)?.name ?? ''
  await series.removeEpisode(id)
  message.success(`已删除「${name}」`)
}

async function moveEpisode(id: ID, dir: -1 | 1) {
  await series.moveEpisode(id, dir)
}

function openEpisode(id: ID) {
  router.push(`/p/${id}`)
}

/* --------------------------- 项目主体（概览） --------------------------- */

/**
 * 项目主体 = 项目(series)自己的实体表，是跨集复用的母版。
 * 详细维护在「主体管理」视图（SubjectManager scope=project）里做，
 * 这里只提供一眼能看到的规模，避免项目页把它堆成第二份编辑界面。
 */
const subjectCount = computed(() => registry.entities.length)
const subjectWithImage = computed(() => registry.entities.filter((e) => !!e.pictureN).length)
const speakingCount = computed(() => registry.entities.filter((e) => e.kind === 'speaking').length)
/** 三类各自的规模：角色 / 场景 / 道具 */
const typeCounts = computed(() =>
  ENTITY_TYPES.map((t) => ({
    label: ENTITY_TYPE_LABEL[t],
    n: registry.entities.filter((e) => e.type === t).length
  }))
)
</script>

<template>
  <div style="height: 100%; display: flex; flex-direction: column">
    <header
      style="
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 10px 18px;
        background: var(--panel);
        border-bottom: 1px solid var(--line);
      "
    >
      <div class="row" style="gap: 14px; min-width: 0; flex: 1">
        <n-button quaternary size="small" @click="router.push('/')">← 项目</n-button>
        <n-input v-model:value="seriesName" placeholder="项目名称" :bordered="false" style="max-width: 320px; font-size: 16px" />
      </div>
      <div class="row" style="gap: 8px">
        <TopTabs />
        <span style="width: 1px; height: 18px; background: var(--line)" />
        <span
          class="tag-chip"
          :style="{
            background: provider.ready ? 'var(--accent-soft)' : 'var(--err-soft)',
            color: provider.ready ? 'var(--accent)' : 'var(--err)'
          }"
        >
          {{ provider.current?.name ?? '未配置' }}
        </span>
        <n-button size="small" quaternary @click="showProvider = true">模型设置</n-button>
        <n-button size="small" type="primary" @click="addEpisode">＋ 新增一集</n-button>
      </div>
    </header>

    <main style="flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden">
      <div
        v-if="!backendReady"
        style="height: 100%; display: flex; align-items: center; justify-content: center; padding: 24px"
      >
        <div class="panel" style="padding: 40px 28px; text-align: center; max-width: 460px">
          <n-spin v-if="storage.checking" size="large" style="margin-bottom: 12px" />
          <template v-else>
            <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px">后端未连接</div>
            <div class="muted" style="font-size: 13px; line-height: 1.9">
              连不上 Python 后端，暂时打不开这个项目。请先在项目目录运行
              <code>python server/app.py</code>，然后点重试。
            </div>
            <div class="row" style="justify-content: center; gap: 8px; margin-top: 14px">
              <n-button quaternary size="small" @click="router.push('/')">返回项目列表</n-button>
              <n-button type="primary" size="small" @click="retryConnect">重试连接</n-button>
            </div>
          </template>
        </div>
      </div>

      <n-spin v-else-if="!booted" style="height: 100%" content-style="height:100%">
        <div style="height: 100%" />
      </n-spin>

      <template v-else>
        <div class="series-switch">
          <button class="ss-item" :class="{ on: view === 'episodes' }" @click="view = 'episodes'">
            各集<span class="ss-n">{{ series.episodes.length }}</span>
          </button>
          <button class="ss-item" :class="{ on: view === 'subjects' }" @click="view = 'subjects'">
            主体管理<span class="ss-n">{{ subjectCount }}</span>
          </button>
        </div>

        <div v-if="view === 'episodes'" class="scroll-pane" style="flex: 1; min-height: 0">
          <div style="max-width: 1120px; margin: 0 auto; padding: 16px 20px 48px">
            <section class="panel subj-bar">
              <div style="min-width: 0">
                <div style="font-weight: 600; font-size: 14px">项目主体 {{ subjectCount }}</div>
                <div class="muted" style="font-size: 12px; margin-top: 3px; line-height: 1.7">
                  <template v-for="(t, i) in typeCounts" :key="t.label">
                    <span v-if="i" class="muted"> · </span>{{ t.label }} {{ t.n }}
                  </template>
                  · 有参考图 {{ subjectWithImage }} · 会说话 {{ speakingCount }}
                  <InfoTip
                    size="sm"
                    :width="280"
                    text="项目主体是跨集母版，集里怎么改都不影响这里。"
                  />
                </div>
              </div>
              <n-button size="small" type="primary" ghost @click="view = 'subjects'">
                管理主体
              </n-button>
            </section>

            <section class="panel ep-card">
              <div class="ep-card-h">
                <span class="ep-card-t">各集（{{ series.episodes.length }}）</span>
                <span class="ep-card-s">每集独立打包</span>
              </div>

              <div v-if="!series.episodes.length" class="empty">
                还没有集，点右上角「＋ 新增一集」
              </div>

              <div v-else class="ep-list">
                <div v-for="(ep, i) in series.episodes" :key="ep.id" class="ep-row">
                  <span class="ep-idx mono">{{ i + 1 }}</span>
                  <n-input
                    size="small"
                    :value="ep.name"
                    @update:value="(v: string) => series.renameEpisode(ep.id, v)"
                  />
                  <n-select
                    size="small"
                    title="这一集使用哪套工作流模板"
                    :value="ep.workflowTemplateId ?? ''"
                    :options="templateOptions"
                    @update:value="(v: string | number | null) => onPickTemplate(ep.id, v)"
                  />
                  <n-button size="small" type="primary" ghost @click="openEpisode(ep.id)">打开</n-button>
                  <div class="ep-ops">
                    <n-button size="tiny" quaternary :disabled="i === 0" title="上移" @click="moveEpisode(ep.id, -1)">↑</n-button>
                    <n-button
                      size="tiny"
                      quaternary
                      :disabled="i === series.episodes.length - 1"
                      title="下移"
                      @click="moveEpisode(ep.id, 1)"
                    >
                      ↓
                    </n-button>
                    <n-popconfirm @positive-click="removeEpisode(ep.id)">
                      <template #trigger>
                        <n-button size="tiny" quaternary type="error">删除</n-button>
                      </template>
                      删除该集及其所有片段？
                    </n-popconfirm>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>

        <SubjectManager v-else scope="project" :project-id="seriesId" />
      </template>
    </main>

    <ProviderDialog v-model:show="showProvider" />
  </div>
</template>

<style scoped>
/*
 * 「各集」：原来是 panel 里再套一层 panel（白卡套白卡，只剩两圈灰线），
 * 现在是一张卡 + 头部灰带 + 行与行之间的细线，像一张表。
 */
.ep-card {
  overflow: hidden;
}
.ep-card-h {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 12px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--line);
}
.ep-card-t {
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text);
}
.ep-card-s {
  font-size: var(--fs-md);
  color: var(--muted);
}
.ep-list {
  display: flex;
  flex-direction: column;
}
.ep-row {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) 168px auto auto;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  min-width: 0;
}
.ep-row + .ep-row {
  border-top: 1px solid var(--line);
}
.ep-idx {
  font-size: var(--fs-sm);
  color: var(--muted-3);
  text-align: center;
}
.ep-ops {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* 页内子视图用 pill（一级导航才用下划线，见 TopTabs 的样式契约） */
.series-switch {
  display: flex;
  gap: 4px;
  flex: none;
  padding: 9px 20px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
}
.ss-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 13px;
  color: var(--muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 999px;
  cursor: pointer;
}
.ss-item:hover {
  color: var(--text);
  background: var(--panel-2);
}
.ss-item.on {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: var(--accent-line);
  font-weight: 500;
}
.ss-n {
  font-size: 11px;
  color: var(--muted);
}
.ss-item.on .ss-n {
  color: var(--accent);
}
.subj-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
</style>
