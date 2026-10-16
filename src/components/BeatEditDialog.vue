<script setup lang="ts">
import { NButton, NModal } from 'naive-ui'
import type { Beat, Entity, ID, ProjectSettings } from '@/domain/types'
import BeatDetail from './BeatDetail.vue'

/**
 * 片段编辑弹窗 —— 只是 BeatDetail 共用表单的一层 Modal 壳。
 * 表单本体（字段、校验、patch 事件）全部在 BeatDetail 里，
 * 视频段详情的镜头 Tab 复用的是同一个 BeatDetail，不是这里的副本。
 */
const props = defineProps<{
  show: boolean
  beat: Beat | null
  settings: ProjectSettings
  entities: Entity[]
  entityById: Map<ID, Entity>
}>()

const emit = defineEmits<{
  'update:show': [boolean]
  patch: [id: ID, patch: Partial<Beat>]
}>()
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    style="max-width: 760px"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <template #header>
      <span style="font-weight: 600">{{ beat?.title || '编辑片段' }}</span>
    </template>

    <div v-if="!beat" class="empty">没有选中片段</div>

    <BeatDetail
      v-else
      :beat="beat"
      :settings="settings"
      :entities="entities"
      :entity-by-id="entityById"
      @patch="(id, p) => emit('patch', id, p)"
    />

    <template #footer>
      <div class="row" style="justify-content: space-between">
        <span class="muted" style="font-size: 12.5px">改动会立即保存</span>
        <n-button type="primary" @click="emit('update:show', false)">完成</n-button>
      </div>
    </template>
  </n-modal>
</template>
