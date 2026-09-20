<script setup lang="ts">
import { computed, h, ref } from 'vue'
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

const registry = useRegistryStore()
const beats = useBeatStore()
const project = useProjectStore()
const message = useMessage()

const fileInput = ref<HTMLInputElement | null>(null)

const projectId = computed(() => project.currentId ?? '')

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
        options: registry.assets.map((a) => ({
          label: `<Picture ${a.pictureN}> ${a.label}`,
          value: a.pictureN
        })),
        onUpdateValue: (v: number | null) => registry.updateEntity(row.id, { pictureN: v })
      })
  },
  {
    title: '操作',
    key: 'ops',
    width: 64,
    render: (row) =>
      h(
        NButton,
        {
          size: 'tiny',
          quaternary: true,
          type: 'error',
          onClick: () => registry.removeEntity(row.id)
        },
        { default: () => '删除' }
      )
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
          拖入或选择图片，自动按 shared_params/PictureN.png 编号
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
            placeholder="素材说明"
            @update:value="(v: string) => registry.updateAsset(a.id, { label: v })"
          />
        </div>
      </div>
      <div v-if="!registry.assets.length" class="empty">还没有素材</div>
    </n-tab-pane>
  </n-tabs>
</template>
