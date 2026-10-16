<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NInput, NModal, NPopconfirm, NSpin, useMessage } from 'naive-ui'
import { useSeriesStore } from '@/stores/series'
import { useProviderStore } from '@/stores/provider'
import { useStorageStore } from '@/stores/storage'
import ProviderDialog from '@/components/ProviderDialog.vue'
import StorageDialog from '@/components/StorageDialog.vue'
import { isBackend } from '@/db'

const router = useRouter()
const series = useSeriesStore()
const provider = useProviderStore()
const storage = useStorageStore()
const message = useMessage()

const showCreate = ref(false)
const showProvider = ref(false)
const showStorage = ref(false)
const newName = ref('')
const newEpisode = ref('')

// 后端必须连上才能读库；没连上就先给出拦截，不读数据
const backendReady = ref(false)

onMounted(async () => {
  await storage.init()
  backendReady.value = storage.ready
  if (!storage.ready) return
  await Promise.all([series.loadAll(), provider.load()])
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

function episodeCount(s: { episodeIds?: string[] }): number {
  return s.episodeIds?.length ?? 0
}
</script>

<template>
  <div style="max-width: 1080px; margin: 0 auto; padding: 32px 20px 64px">
    <div class="row-between" style="margin-bottom: 6px">
      <div>
        <h1 style="margin: 0; font-size: 24px; letter-spacing: -0.01em">剧本台</h1>
        <div class="muted" style="margin-top: 4px">
          项目 → 多集 · 大主体可注入到任意一集 · 每集独立打包
        </div>
      </div>
      <div class="row">
        <n-button quaternary @click="showStorage = true">
          存储
          <span
            class="tag-chip"
            :style="{
              marginLeft: '6px',
              background: isBackend() ? 'var(--accent-soft)' : '#f2f4f7',
              color: isBackend() ? 'var(--accent)' : '#5b6273'
            }"
          >
            {{ isBackend() ? '后端目录' : '浏览器' }}
          </span>
        </n-button>
        <n-button quaternary @click="showProvider = true">
          模型设置
          <span
            class="tag-chip"
            :style="{
              marginLeft: '6px',
              background: provider.ready ? 'var(--accent-soft)' : '#fdecec',
              color: provider.ready ? 'var(--accent)' : 'var(--err)'
            }"
          >
            {{ provider.ready ? '已连接' : '未配置' }}
          </span>
        </n-button>
        <n-button type="primary" @click="showCreate = true">新建项目</n-button>
      </div>
    </div>

    <template v-if="backendReady">
      <div v-if="!series.seriesList.length" class="panel" style="margin-top: 28px">
        <div class="empty">
          <div style="font-size: 15px; margin-bottom: 6px">还没有项目</div>
          <div>新建一个项目：它下面可以放多集，每集是一个独立工作台（故事→片段→组合→导演包）</div>
        </div>
      </div>

      <div
        v-else
        style="
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 14px;
          margin-top: 24px;
        "
      >
        <div v-for="s in series.seriesList" :key="s.id" class="panel" style="padding: 16px">
          <div class="row-between">
            <div style="font-weight: 600; font-size: 15px">{{ s.name }}</div>
            <span class="tag-chip" style="background: var(--accent-soft); color: var(--accent)">
              {{ episodeCount(s) }} 集
            </span>
          </div>
          <div class="muted" style="margin-top: 8px; font-size: 12.5px; line-height: 1.6">
            项目 / 系列 · 大主体挂在项目层，可注入到任意一集
          </div>
          <div class="row-between" style="margin-top: 14px">
            <n-button size="small" type="primary" ghost @click="open(s.id)">打开</n-button>
            <n-popconfirm @positive-click="remove(s.id, s.name)">
              <template #trigger>
                <n-button size="small" quaternary type="error">删除</n-button>
              </template>
              同时删除该项目下的所有集与大主体，确定？
            </n-popconfirm>
          </div>
        </div>
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
        <div class="muted" style="font-size: 12px; line-height: 1.7">
          项目是顶层容器：下面可放多集（每集独立工作台、独立打包），项目层可维护「大主体」并注入到任意一集。
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
  </div>
</template>

<style scoped>
:deep(.n-empty) {
  --n-icon-color: #b9bfca;
}
</style>
