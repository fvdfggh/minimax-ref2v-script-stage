<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NModal } from 'naive-ui'
import type { Beat, BeatKind, Entity, ID, ProjectSettings } from '@/domain/types'
import { BEAT_KIND_COLOR, BEAT_KIND_LABEL } from '@/domain/beats'
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

const kindColor = computed(() =>
  props.beat ? BEAT_KIND_COLOR[props.beat.kind as BeatKind] ?? '#6b7280' : '#6b7280'
)
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    style="max-width: 780px"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <template #header>
      <div class="be-head">
        <span
          v-if="beat"
          class="be-kind"
          :style="{ background: kindColor + '16', borderColor: kindColor + '38', color: kindColor }"
        >
          {{ BEAT_KIND_LABEL[beat.kind as BeatKind] }}
        </span>
        <span class="be-title">{{ beat?.title || '编辑片段' }}</span>
        <span class="be-hint">改动会立即保存</span>
      </div>
    </template>

    <div v-if="!beat" class="empty">没有选中片段</div>

    <div v-else class="be-body">
      <BeatDetail
        :beat="beat"
        :settings="settings"
        :entities="entities"
        :entity-by-id="entityById"
        :show-head="false"
        @patch="(id, p) => emit('patch', id, p)"
      />
    </div>

    <template #footer>
      <div class="row" style="justify-content: flex-end">
        <n-button type="primary" @click="emit('update:show', false)">完成</n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.be-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.be-kind {
  flex: 0 0 auto;
  padding: 0 8px;
  border-radius: var(--r-pill);
  border: 1px solid transparent;
  font-size: 11px;
  line-height: 19px;
  font-weight: 600;
}
.be-title {
  min-width: 0;
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.be-hint {
  flex: 0 0 auto;
  margin-left: auto;
  font-size: var(--fs-xs);
  font-weight: 400;
  color: var(--muted);
}
/*
 * 高度交给 NModal 自己算（card preset 已经有视口上限）。
 * 这里再加一层 max-height 会变成双重限制，内容只多几十像素就冒出滚动条。
 */
.be-body {
  min-height: 0;
}
</style>
