<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NDrawer, NDrawerContent, NSpin, useMessage } from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useRegistryStore } from '@/stores/registry'
import { useBeatStore } from '@/stores/beats'
import { useAssemblyStore } from '@/stores/assembly'
import { useProviderStore } from '@/stores/provider'
import { usePipelineStore } from '@/stores/pipeline'
import { useStorageStore } from '@/stores/storage'
import { setStorageProject } from '@/db'
import RegistryPanel from '@/components/RegistryPanel.vue'
import ProviderDialog from '@/components/ProviderDialog.vue'
import StageSplit from '@/components/stages/StageSplit.vue'
import StageEnrich from '@/components/stages/StageEnrich.vue'
import StageAssemble from '@/components/stages/StageAssemble.vue'
import StageComplete from '@/components/stages/StageComplete.vue'
import StageLocalize from '@/components/stages/StageLocalize.vue'
import StageDeliver from '@/components/stages/StageDeliver.vue'

const route = useRoute()
const router = useRouter()
const message = useMessage()

const project = useProjectStore()
const registry = useRegistryStore()
const beats = useBeatStore()
const assembly = useAssemblyStore()
const provider = useProviderStore()
const pipeline = usePipelineStore()
const storage = useStorageStore()

const tab = ref<'split' | 'enrich' | 'assemble' | 'complete' | 'localize' | 'deliver'>('split')
const showRegistry = ref(false)
const showProvider = ref(false)
const booted = ref(false)
const backendReady = ref(false)

const projectId = computed(() => String(route.params.id ?? ''))

const projectName = computed(() => project.current?.name ?? '')

// 本集属于哪个项目(系列)；有则回到项目页，否则回项目列表
const backTo = computed(() =>
  project.current?.seriesId ? `/s/${project.current.seriesId}` : '/'
)

const tabs = [
  { key: 'split', label: '① 拆解' },
  { key: 'enrich', label: '② 细节填充' },
  { key: 'assemble', label: '③ 组合与缝合' },
  { key: 'complete', label: '④ 字段补全' },
  { key: 'localize', label: '⑤ 中英本地化' },
  { key: 'deliver', label: '⑥ 交付' }
] as const

async function boot() {
  await storage.init()
  backendReady.value = storage.ready
  // 连不上后端就直接拦住，不读库（后端是唯一数据源）
  if (!storage.ready) {
    booted.value = true
    return
  }
  await project.loadAll()
  // 让 current 与路由的集 id 一致（而不是停留在 kv 里的旧值）
  await project.select(projectId.value)
  if (!project.current) {
    message.warning('集不存在')
    router.replace('/')
    return
  }
  // 后端模式下删除操作只给 id，适配器得先知道在哪个项目里
  setStorageProject(projectId.value)
  await Promise.all([
    registry.load(projectId.value),
    beats.load(projectId.value),
    assembly.load(projectId.value),
    provider.load()
  ])
  tab.value = project.current.stage === 'deliver' ? 'deliver' : project.current.stage
  booted.value = true
}

async function retryConnect() {
  const ok = await storage.connect()
  if (ok) location.reload()
}

onMounted(boot)

watch(projectId, async () => {
  booted.value = false
  await boot()
})

watch(tab, async (v) => {
  if (!project.current) return
  if (project.current.stage !== v) await project.setStage(v)
})

async function renumberIfNeeded() {
  if (registry.stale(beats.beats)) {
    await registry.renumber(beats.beats)
  }
}
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
      <div class="row" style="gap: 14px; min-width: 0">
        <n-button quaternary size="small" @click="router.push(backTo)">← 项目</n-button>
        <div style="font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">
          {{ projectName }}
        </div>
        <div class="stage-tabs">
          <button
            v-for="t in tabs"
            :key="t.key"
            class="stage-tab"
            :class="{ active: tab === t.key }"
            @click="tab = t.key"
          >
            {{ t.label }}
          </button>
        </div>
      </div>

      <div class="row" style="gap: 8px">
        <span
          class="tag-chip"
          :style="{
            background: provider.ready ? 'var(--accent-soft)' : '#fdecec',
            color: provider.ready ? 'var(--accent)' : 'var(--err)'
          }"
        >
          {{ provider.current?.name ?? '未配置' }}
        </span>
        <n-button size="small" quaternary @click="showProvider = true">模型设置</n-button>
        <n-button size="small" @click="showRegistry = true">
          实体与素材
          <span
            class="tag-chip"
            style="margin-left: 6px; background: #f2f4f7; color: #5b6273"
          >
            {{ registry.entities.length }}
          </span>
        </n-button>
      </div>
    </header>

    <main style="flex: 1; min-height: 0; overflow: hidden">
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
        <StageSplit v-show="tab === 'split'" @changed="renumberIfNeeded" />
        <StageEnrich v-show="tab === 'enrich'" @changed="renumberIfNeeded" />
        <StageAssemble v-show="tab === 'assemble'" />
        <StageComplete v-show="tab === 'complete'" />
        <StageLocalize v-show="tab === 'localize'" />
        <StageDeliver v-show="tab === 'deliver'" />
      </template>
    </main>

    <n-drawer v-model:show="showRegistry" :width="640" placement="right">
      <n-drawer-content title="实体与素材" closable>
        <RegistryPanel />
      </n-drawer-content>
    </n-drawer>

    <ProviderDialog v-model:show="showProvider" />
  </div>
</template>
