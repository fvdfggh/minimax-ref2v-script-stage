<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NCheckbox, NInput, NModal, NPopconfirm, NSpin, NTag, useMessage } from 'naive-ui'
import { useSeriesStore } from '@/stores/series'
import { useRegistryStore } from '@/stores/registry'
import { useProviderStore } from '@/stores/provider'
import { useImageStore } from '@/stores/images'
import { useStorageStore } from '@/stores/storage'
import { setStorageProject } from '@/db'
import { ENTITY_TYPE_LABEL } from '@/domain/registry'
import ImageGenModal from '@/components/ImageGenModal.vue'
import ProviderDialog from '@/components/ProviderDialog.vue'
import type { Entity, ID } from '@/domain/types'

const route = useRoute()
const router = useRouter()
const message = useMessage()

const series = useSeriesStore()
const registry = useRegistryStore()
const provider = useProviderStore()
const images = useImageStore()
const storage = useStorageStore()

const backendReady = ref(false)
const booted = ref(false)
const showProvider = ref(false)

const seriesId = computed(() => String(route.params.id ?? ''))

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

/* ------------------------------- 大主体 ------------------------------- */

const globalEntities = computed(() => registry.entities)

async function addGlobalSubject() {
  await registry.addEntity(seriesId.value, { name: '新大主体' })
}

async function removeGlobal(id: ID) {
  await registry.removeEntity(id)
}

function globalImageUrl(e: Entity): string | null {
  const a = registry.subjectImageFor(e.id)
  return a ? registry.assetUrl(a) : null
}

async function attachGlobalImage(e: Entity, blob: Blob) {
  const prev = registry.subjectImageFor(e.id)
  const asset = await registry.addGeneratedImage(seriesId.value, blob, {
    label: e.name,
    kind: 'subject',
    refId: e.id
  })
  await registry.updateEntity(e.id, { pictureN: asset.pictureN })
  if (prev && prev.id !== asset.id) await registry.removeAsset(prev.id)
}

const imgModal = ref<{ entity: Entity } | null>(null)
function openImage(e: Entity) {
  imgModal.value = { entity: e }
}

/* ------------------------------- 注入到集 ------------------------------- */

const injectTarget = ref<{ entity: Entity; episodeIds: ID[] } | null>(null)
function openInject(e: Entity) {
  // 已注入的集先勾上
  const all = series.episodes.map((ep) => ep.id)
  injectTarget.value = { entity: e, episodeIds: [] }
  void all
}
async function confirmInject() {
  const t = injectTarget.value
  if (!t || !t.episodeIds.length) {
    message.warning('先选择要注入的集')
    return
  }
  let imgMiss = 0
  for (const eid of t.episodeIds) {
    const res = await series.injectToEpisode(seriesId.value, t.entity.id, eid)
    if (!res.imageCopied) imgMiss++
  }
  injectTarget.value = null
  if (imgMiss) message.warning(`已注入 ${t.episodeIds.length} 集（${imgMiss} 集参考图未复制成功）`)
  else message.success(`已把「${t.entity.name}」注入 ${t.episodeIds.length} 集`)
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
      <div class="row" style="gap: 14px; min-width: 0; flex: 1">
        <n-button quaternary size="small" @click="router.push('/')">← 项目</n-button>
        <n-input v-model:value="seriesName" placeholder="项目名称" :bordered="false" style="max-width: 320px; font-size: 16px" />
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
        <n-button size="small" type="primary" @click="addEpisode">＋ 新增一集</n-button>
      </div>
    </header>

    <main style="flex: 1; min-height: 0; overflow: auto">
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

      <div v-else style="max-width: 1120px; margin: 0 auto; padding: 22px 20px 64px">
        <div style="display: grid; grid-template-columns: minmax(320px, 2fr) minmax(360px, 3fr); gap: 20px">
          <!-- 各集 -->
          <section class="panel" style="padding: 16px">
            <div class="row-between" style="margin-bottom: 12px">
              <div style="font-weight: 600; font-size: 15px">各集（{{ series.episodes.length }}）</div>
              <span class="muted" style="font-size: 12px">每集是独立工作台，独立打包</span>
            </div>

            <div v-if="!series.episodes.length" class="empty" style="margin-bottom: 10px">
              还没有集，点右上角「＋ 新增一集」
            </div>

            <div class="stack" style="gap: 8px">
              <div
                v-for="(ep, i) in series.episodes"
                :key="ep.id"
                class="panel"
                style="padding: 10px 12px; display: flex; align-items: center; gap: 10px"
              >
                <span class="mono muted" style="width: 22px; text-align: center; flex: none">{{ i + 1 }}</span>
                <n-input
                  size="small"
                  :value="ep.name"
                  style="flex: 1"
                  @update:value="(v: string) => series.renameEpisode(ep.id, v)"
                />
                <n-button size="small" type="primary" ghost @click="openEpisode(ep.id)">打开</n-button>
                <n-button size="tiny" quaternary :disabled="i === 0" @click="moveEpisode(ep.id, -1)">↑</n-button>
                <n-button size="tiny" quaternary :disabled="i === series.episodes.length - 1" @click="moveEpisode(ep.id, 1)">↓</n-button>
                <n-popconfirm @positive-click="removeEpisode(ep.id)">
                  <template #trigger>
                    <n-button size="tiny" quaternary type="error">删除</n-button>
                  </template>
                  删除该集及其所有片段？
                </n-popconfirm>
              </div>
            </div>
          </section>

          <!-- 大主体 -->
          <section class="panel" style="padding: 16px">
            <div class="row-between" style="margin-bottom: 12px">
              <div style="font-weight: 600; font-size: 15px">大主体 / 全局主体（{{ globalEntities.length }}）</div>
              <n-button size="small" type="primary" ghost @click="addGlobalSubject">＋ 新增</n-button>
            </div>
            <div class="muted" style="font-size: 12px; margin-bottom: 12px; line-height: 1.7">
              大主体挂在项目层，可「注入」到任意一集（复制进该集，独立编号/独立参考图，每集独立打包）。
            </div>

            <div v-if="!globalEntities.length" class="empty" style="margin-bottom: 10px">还没有大主体</div>

            <div class="stack" style="gap: 8px">
              <div
                v-for="e in globalEntities"
                :key="e.id"
                style="display: flex; align-items: center; gap: 10px; padding: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px"
              >
                <img
                  v-if="globalImageUrl(e)"
                  :src="globalImageUrl(e)!"
                  style="width: 40px; height: 40px; border-radius: 6px; object-fit: cover; flex: none; background: #f1f3f6"
                />
                <div v-else style="width: 40px; height: 40px; border-radius: 6px; background: #f1f3f6; flex: none" />
                <div style="flex: 1; min-width: 0">
                  <n-input size="small" :value="e.name" @update:value="(v: string) => registry.updateEntity(e.id, { name: v })" />
                  <div class="muted" style="font-size: 11.5px; margin-top: 4px">
                    {{ ENTITY_TYPE_LABEL[e.type] }}<span v-if="e.kind === 'speaking'"> · 会说话</span>
                  </div>
                </div>
                <n-button size="small" quaternary @click="openImage(e)">{{ globalImageUrl(e) ? '换图' : '生成图' }}</n-button>
                <n-button size="small" @click="openInject(e)">注入到集</n-button>
                <n-popconfirm @positive-click="removeGlobal(e.id)">
                  <template #trigger>
                    <n-button size="tiny" quaternary type="error">删除</n-button>
                  </template>
                  删除这个大主体？
                </n-popconfirm>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>

    <ImageGenModal
      v-if="imgModal"
      :show="true"
      title="大主体参考图"
      :default-prompt="imgModal ? images.subjectPrompt(imgModal.entity) : ''"
      :base-image-url="imgModal ? globalImageUrl(imgModal.entity) : null"
      default-size="1024x1024"
      @done="(blob: Blob) => imgModal && attachGlobalImage(imgModal.entity, blob)"
      @update:show="(v: boolean) => { if (!v) imgModal = null }"
    />

    <n-modal v-if="injectTarget" preset="card" title="注入到集" style="max-width: 420px">
      <div class="muted" style="font-size: 12.5px; margin-bottom: 12px">
        选择要把「{{ injectTarget.entity.name }}」复制到哪些集。每集会得到一份独立副本（独立编号 + 参考图）。
      </div>
      <div class="stack" style="gap: 8px">
        <n-checkbox
          v-for="ep in series.episodes"
          :key="ep.id"
          :checked="injectTarget.episodeIds.includes(ep.id)"
          @update:checked="(v: boolean) =>
            (injectTarget!.episodeIds = v
              ? [...injectTarget!.episodeIds, ep.id]
              : injectTarget!.episodeIds.filter((x) => x !== ep.id))"
        >
          {{ ep.name }}
        </n-checkbox>
        <div v-if="!series.episodes.length" class="muted" style="font-size: 12.5px">这个项目还没有集</div>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end; gap: 8px">
          <n-button @click="injectTarget = null">取消</n-button>
          <n-button type="primary" @click="confirmInject">确认注入</n-button>
        </div>
      </template>
    </n-modal>

    <ProviderDialog v-model:show="showProvider" />
  </div>
</template>
