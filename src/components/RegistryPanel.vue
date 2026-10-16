<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from 'vue'
import {
  NButton,
  NDataTable,
  NInput,
  NSelect,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
  useMessage
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useRegistryStore } from '@/stores/registry'
import { useBeatStore } from '@/stores/beats'
import { useProjectStore } from '@/stores/project'
import { ENTITY_TYPE_LABEL, groupEntitiesByLayer, normalizeVoiceDesc } from '@/domain/registry'
import type { Asset, Entity, EntityKind, EntityType } from '@/domain/types'
import { useImageStore } from '@/stores/images'
import { useSeriesStore } from '@/stores/series'
import { db } from '@/db'
import { backendAssetUrl } from '@/core/backend'
import ImageGenModal from './ImageGenModal.vue'

const registry = useRegistryStore()
const beats = useBeatStore()
const project = useProjectStore()
const message = useMessage()
const images = useImageStore()

const fileInput = ref<HTMLInputElement | null>(null)

/* 主体参考图：生成 / 编辑（图生图） */
const imgModal = ref<{ entity: Entity } | null>(null)
function openSubjectImage(e: Entity) {
  imgModal.value = { entity: e }
}
function subjectImageUrl(e: Entity): string | null {
  const a = registry.subjectImageFor(e.id)
  return a ? registry.assetUrl(a) : null
}

const projectId = computed(() => project.currentId ?? '')

/* 项目(系列)上下文：本集主体可"提升"为大主体；项目大主体可"注入"到本集 */
const series = useSeriesStore()
const seriesId = computed(() => project.current?.seriesId)

const globalSubjects = ref<Entity[]>([])
const globalAssets = ref<Asset[]>([])
async function loadGlobal() {
  if (!seriesId.value) {
    globalSubjects.value = []
    globalAssets.value = []
    return
  }
  const sid = seriesId.value
  const [ents, assets] = await Promise.all([
    db.entities.where('projectId').equals(sid).toArray(),
    db.assets.where('projectId').equals(sid).toArray()
  ])
  globalSubjects.value = ents
  globalAssets.value = assets
}
onMounted(loadGlobal)
watch(seriesId, loadGlobal)

function globalImageUrl(g: Entity): string | null {
  if (!g.pictureN) return null
  const a = globalAssets.value.find((x) => x.pictureN === g.pictureN)
  return a && seriesId.value ? backendAssetUrl(seriesId.value, a.fileName) : null
}

/** 把本集主体"提升"为项目大主体（复制回项目层，本集保留原主体） */
async function promoteToSeries(e: Entity) {
  const sid = seriesId.value
  const pid = project.currentId
  if (!sid || !pid) return
  try {
    await series.promoteToSeries(pid, e.id, sid)
    message.success(`已把「${e.name}」提升为项目大主体（本集保留原主体）`)
  } catch (err) {
    message.error((err as Error).message)
  }
}

/** 把项目大主体"注入"到本集（复制进本集，独立编号/参考图） */
async function injectToThisEpisode(g: Entity) {
  const sid = seriesId.value
  const pid = project.currentId
  if (!sid || !pid) return
  try {
    const res = await series.injectToEpisode(sid, g.id, pid)
    await registry.load(pid) // 让注入的副本立刻显示出来
    if (!res.imageCopied) message.warning(`已注入「${g.name}」（参考图未复制成功）`)
    else message.success(`已把「${g.name}」注入到本集`)
  } catch (err) {
    message.error((err as Error).message)
  }
}

const typeOptions = (Object.keys(ENTITY_TYPE_LABEL) as EntityType[]).map((t) => ({
  label: ENTITY_TYPE_LABEL[t],
  value: t
}))

const entityColumns = computed<DataTableColumns<Entity>>(() => [
  {
    title: '编号',
    key: 'subjectN',
    width: 62,
    render: (row) => (row.subjectN == null ? '—' : `S${row.subjectN}`)
  },
  {
    title: '名称',
    key: 'name',
    render: (row) =>
      h(NInput, {
        value: row.name,
        size: 'small',
        onUpdateValue: (v: string) => registry.updateEntity(row.id, { name: v })
      })
  },
  {
    title: '类型',
    key: 'type',
    width: 96,
    render: (row) =>
      h(NSelect, {
        value: row.type,
        size: 'small',
        options: typeOptions,
        onUpdateValue: (v: string) => registry.updateEntity(row.id, { type: v as EntityType })
      })
  },
  {
    title: '会说话',
    key: 'kind',
    width: 84,
    render: (row) =>
      h(NSwitch, {
        value: row.kind === 'speaking',
        size: 'small',
        onUpdateValue: (v: boolean) =>
          registry.updateEntity(row.id, { kind: (v ? 'speaking' : 'non_speaking') as EntityKind })
      })
  },
  {
    title: '素材',
    key: 'pictureN',
    width: 120,
    render: (row) =>
      h(NSelect, {
        value: row.pictureN,
        size: 'small',
        clearable: true,
        placeholder: '纯文本',
        // 只列主体参考图（pictureN>0），场景图(pictureN=0)不进 reference 槽
        options: registry.assets
          .filter((a) => a.kind !== 'scene' && a.pictureN > 0)
          .map((a) => ({
            label: `<Picture ${a.pictureN}> ${a.label}`,
            value: a.pictureN
          })),
        onUpdateValue: (v: number | null) => registry.updateEntity(row.id, { pictureN: v })
      })
  },
  {
    title: '参考图',
    key: 'refimg',
    width: 118,
    render: (row) => {
      const a = registry.subjectImageFor(row.id)
      const url = a ? registry.assetUrl(a) : null
      return h('div', { style: 'display:flex;align-items:center;gap:6px' }, [
        url
          ? h('img', {
              src: url,
              style:
                'width:32px;height:32px;border-radius:4px;object-fit:cover;flex:none;background:#f1f3f6'
            })
          : h('span', { style: 'width:32px;height:32px;flex:none;background:#f1f3f6;border-radius:4px' }),
        h(
          NButton,
          {
            size: 'tiny',
            quaternary: true,
            onClick: () => openSubjectImage(row)
          },
          { default: () => (url ? '换 / 编辑' : '生成') }
        )
      ])
    }
  },
  {
    title: '操作',
    key: 'ops',
    width: 118,
    render: (row) =>
      h('div', { style: 'display:flex;gap:4px;align-items:center' }, [
        seriesId.value
          ? h(
              NButton,
              { size: 'tiny', quaternary: true, onClick: () => promoteToSeries(row) },
              { default: () => '提升' }
            )
          : null,
        h(
          NButton,
          { size: 'tiny', quaternary: true, type: 'error', onClick: () => registry.removeEntity(row.id) },
          { default: () => '删除' }
        )
      ])
  }
])

const layers = computed(() => groupEntitiesByLayer(registry.entities))

const voiceRows = computed(() =>
  registry.sortedEntities.filter((e) => e.kind === 'speaking' && e.type !== 'scene')
)
</script>

<template>
  <n-tabs type="line" animated>
    <n-tab-pane name="entities" tab="实体注册表">
      <div class="row-between" style="margin-bottom: 10px">
        <div class="muted" style="font-size: 12.5px">
          编号由「首次发声顺序」自动分配，会说话的角色排在前，不说话排在后
        </div>
        <div class="row">
          <n-button
            size="small"
            @click="
              async () => {
                const n = await registry.renumber(beats.beats)
                message.success(n ? `已重排 ${n} 个编号` : '编号已是最新')
              }
            "
          >
            重排编号
          </n-button>
          <n-button
            size="small"
            ghost
            @click="registry.addEntity(projectId, { name: '新主体', kind: 'character' as EntityKind })"
          >
            新增主体
          </n-button>
          <n-button
            size="small"
            type="primary"
            ghost
            @click="
              registry.addEntity(projectId, {
                name: '新场景',
                type: 'scene' as EntityType,
                kind: 'non_speaking' as EntityKind
              })
            "
          >
            新增场景
          </n-button>
        </div>
      </div>

      <div class="row" style="gap: 8px; margin-bottom: 10px; flex-wrap: wrap">
        <n-tag size="small" :bordered="false">会说话 {{ layers.speaking.length }}</n-tag>
        <n-tag size="small" :bordered="false">主体 {{ layers.subjects.length }}</n-tag>
        <n-tag size="small" :bordered="false" type="success">场景 {{ layers.scenes.length }}</n-tag>
        <span class="muted" style="font-size: 12px">
          场景是必填项，每个片段有且仅有一个；主体可选。两者同样占 Subject 编号，场景排最后
        </span>
      </div>

      <n-data-table
        :columns="entityColumns"
        :data="registry.sortedEntities"
        :bordered="false"
        size="small"
        :max-height="300"
        virtual-scroll
      />
    </n-tab-pane>

    <n-tab-pane name="voices" tab="音色表">
      <div class="muted" style="font-size: 12.5px; margin-bottom: 10px">
        只在这里写一次，跨段逐字复用。末尾的 (Sx) 由系统自动追加，不需要手写
      </div>
      <div v-for="e in voiceRows" :key="e.id" class="stack" style="gap: 4px; margin-bottom: 12px">
        <div class="row" style="gap: 6px">
          <n-tag size="small" :bordered="false" type="info">S{{ e.subjectN ?? '?' }}</n-tag>
          <span style="font-weight: 600">{{ e.name }}</span>
        </div>
        <n-input
          type="textarea"
          :rows="2"
          size="small"
          :value="e.voiceDesc ?? ''"
          placeholder="speaking with a young male voice, slightly hoarse, tired but determined, measured and urgent"
          @update:value="(v: string) => registry.updateEntity(e.id, { voiceDesc: normalizeVoiceDesc(v) })"
        />
      </div>
      <div v-if="!voiceRows.length" class="empty">还没有会说话的角色</div>
    </n-tab-pane>

    <n-tab-pane name="assets" tab="素材">
      <div class="row-between" style="margin-bottom: 10px">
        <div class="muted" style="font-size: 12.5px">
          拖入或选择图片，自动按 shared_params/PictureN.png 编号。
          每张素材的「素材说明」会作为只读上下文交给大模型帮它理解参考内容，但不会写进最终生成的提示词。
        </div>
        <div class="row">
          <n-button size="small" @click="registry.compactAssets()">压缩编号</n-button>
          <n-button size="small" type="primary" ghost @click="fileInput?.click()">
            添加图片
          </n-button>
        </div>
      </div>
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        multiple
        style="display: none"
        @change="
          async (ev: Event) => {
            const files = (ev.target as HTMLInputElement).files
            if (!files) return
            for (const f of Array.from(files)) await registry.addAsset(projectId, f)
            ;(ev.target as HTMLInputElement).value = ''
          }
        "
      />
      <div
        style="
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
          gap: 10px;
        "
      >
        <div v-for="a in registry.assets" :key="a.id" class="panel" style="padding: 8px">
          <img
            v-if="registry.assetUrl(a)"
            :src="registry.assetUrl(a)!"
            style="width: 100%; height: 76px; object-fit: cover; border-radius: 6px"
          />
          <div v-else style="height: 76px; background: #f1f3f6; border-radius: 6px" />
          <div class="row-between" style="margin-top: 6px">
            <span class="mono" style="font-size: 11.5px">P{{ a.pictureN }}</span>
            <n-button
              size="tiny"
              quaternary
              type="error"
              @click="registry.removeAsset(a.id)"
            >
              移除
            </n-button>
          </div>
          <n-input
            size="tiny"
            :value="a.label"
            placeholder="标签"
            @update:value="(v: string) => registry.updateAsset(a.id, { label: v })"
          />
          <n-input
            type="textarea"
            size="tiny"
            :rows="2"
            :value="a.desc ?? ''"
            placeholder="素材说明（供大模型读取，不进最终提示词）"
            @update:value="(v: string) => registry.updateAsset(a.id, { desc: v })"
          />
        </div>
      </div>
      <div v-if="!registry.assets.length" class="empty">还没有素材</div>
    </n-tab-pane>

    <n-tab-pane v-if="seriesId" name="globals" tab="项目大主体">
      <div class="muted" style="font-size: 12.5px; margin-bottom: 12px; line-height: 1.7">
        把项目层的「大主体」注入到本集：复制一份进本集（独立编号 + 参考图，本集独立打包）。
      </div>
      <div v-if="!globalSubjects.length" class="empty">项目里还没有大主体，请到项目页维护大主体</div>
      <div v-else class="stack" style="gap: 8px">
        <div
          v-for="g in globalSubjects"
          :key="g.id"
          style="display: flex; align-items: center; gap: 10px; padding: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px"
        >
          <img
            v-if="globalImageUrl(g)"
            :src="globalImageUrl(g)!"
            style="width: 36px; height: 36px; border-radius: 6px; object-fit: cover; flex: none; background: #f1f3f6"
          />
          <div v-else style="width: 36px; height: 36px; border-radius: 6px; background: #f1f3f6; flex: none" />
          <div style="flex: 1; min-width: 0; font-weight: 600; font-size: 13px">{{ g.name }}</div>
          <n-tag size="small" :bordered="false">{{ ENTITY_TYPE_LABEL[g.type] }}</n-tag>
          <n-button size="small" type="primary" ghost @click="injectToThisEpisode(g)">注入到本集</n-button>
        </div>
      </div>
    </n-tab-pane>
  </n-tabs>

  <ImageGenModal
    v-if="imgModal"
    :show="true"
    title="主体参考图"
    :default-prompt="imgModal ? images.subjectPrompt(imgModal.entity) : ''"
    :base-image-url="imgModal ? subjectImageUrl(imgModal.entity) : null"
    default-size="1024x1024"
    @done="(blob: Blob) => imgModal && images.attachSubjectImage(imgModal.entity.id, blob)"
    @update:show="(v: boolean) => { if (!v) imgModal = null }"
  />
</template>
