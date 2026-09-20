<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NCheckbox, NDropdown, NTag } from 'naive-ui'
import { BEAT_KIND_COLOR, BEAT_KIND_LABEL, beatIssueLabel, resolveSubjectId } from '@/domain/beats'
import { beatFrames, secondsFromFrames } from '@/domain/timing'
import type { Beat, BeatKind, Entity, ID, ProjectSettings } from '@/domain/types'
import { AUTO_KINDS } from '@/domain/types'

const props = defineProps<{
  beat: Beat
  index: number
  settings: ProjectSettings
  entityById: Map<ID, Entity>
  selected?: boolean
  selectable?: boolean
  draggable?: boolean
  /** 建议拆分份数，>1 时显示拆分提示 */
  splitHint?: number
}>()

const emit = defineEmits<{
  edit: [id: ID]
  remove: [id: ID]
  split: [id: ID]
  merge: [id: ID]
  move: [from: number, to: number]
  select: [id: ID]
}>()

const dragging = ref(false)
const dropSide = ref<'before' | 'after' | null>(null)

const frames = computed(() => beatFrames(props.beat, props.settings))
const seconds = computed(() => secondsFromFrames(frames.value, props.settings.fps))
const issue = computed(() => beatIssueLabel(props.beat))
const isAuto = computed(() => AUTO_KINDS.includes(props.beat.kind))
const kindColor = computed(() => BEAT_KIND_COLOR[props.beat.kind as BeatKind] ?? '#6b7280')
const kindLabel = computed(() => BEAT_KIND_LABEL[props.beat.kind as BeatKind] ?? props.beat.kind)

const entityList = computed(() => props.beat.entities ?? [])

const entityChips = computed(() =>
  entityList.value
    .map((id) => props.entityById.get(id))
    .filter((e): e is Entity => !!e)
    .map((e) => ({
      id: e.id,
      text: `${e.name}${e.subjectN != null ? ` S${e.subjectN}` : ''}`,
      isSpeaker: e.id === props.beat.speakerId,
      isFocus: e.id === resolveSubjectId(props.beat)
    }))
)

/** 场景单独一个 chip，和主体区分开 */
const sceneChip = computed(() => {
  const id = props.beat.sceneId
  if (!id) return null
  const e = props.entityById.get(id)
  return {
    id,
    text: e ? `${e.name}${e.subjectN != null ? ` S${e.subjectN}` : ''}` : id,
    isScene: e ? e.type === 'scene' : false
  }
})

const moreOptions = [
  { label: '编辑片段', key: 'edit' },
  { type: 'divider', key: 'd0' },
  { label: '拆分为多个片段', key: 'split' },
  { label: '与相邻片段合并', key: 'merge' },
  { type: 'divider', key: 'd1' },
  { label: '删除片段', key: 'remove' }
]

function onMore(key: string) {
  if (key === 'edit') emit('edit', props.beat.id)
  else if (key === 'split') emit('split', props.beat.id)
  else if (key === 'merge') emit('merge', props.beat.id)
  else if (key === 'remove') emit('remove', props.beat.id)
}

/* ------------------------------ 拖拽 ------------------------------ */

function onDragStart(e: DragEvent) {
  if (!props.draggable) return
  dragging.value = true
  e.dataTransfer?.setData('text/plain', String(props.index))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragEnd() {
  dragging.value = false
  dropSide.value = null
}

function onDragOver(e: DragEvent) {
  if (!props.draggable) return
  e.preventDefault()
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  // 网格布局里用左右半边判定插入位置更自然
  dropSide.value = e.clientX - rect.left < rect.width / 2 ? 'before' : 'after'
}

function onDrop(e: DragEvent) {
  if (!props.draggable) return
  e.preventDefault()
  const from = Number(e.dataTransfer?.getData('text/plain'))
  if (Number.isNaN(from)) return
  const to = dropSide.value === 'after' ? props.index + 1 : props.index
  emit('move', from, to)
  dragging.value = false
  dropSide.value = null
}
</script>

<template>
  <div
    class="beat-card beat-square"
    :class="{
      'is-invalid': !!issue,
      'is-dragging': dragging,
      'drop-before': dropSide === 'before',
      'drop-after': dropSide === 'after',
      'is-selected': !!selected
    }"
    :style="{ borderLeftColor: kindColor }"
    :draggable="draggable"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <!-- 顶部工具条 -->
    <div class="sq-head">
      <n-checkbox
        v-if="selectable"
        size="small"
        :checked="!!selected"
        @update:checked="() => emit('select', beat.id)"
        @click.stop
      />
      <span class="drag-handle" :style="{ opacity: draggable ? 1 : 0.25 }">⠿</span>
      <span class="beat-index mono">{{ index + 1 }}</span>
      <span
        class="tag-chip"
        :style="{ background: kindColor + '18', color: kindColor }"
      >
        {{ kindLabel }}
      </span>
      <span style="flex: 1" />
      <n-tag v-if="isAuto" size="tiny" :bordered="false">自动</n-tag>
      <n-dropdown :options="moreOptions" trigger="click" @select="onMore" @click.stop>
        <n-button size="tiny" quaternary @click.stop>⋯</n-button>
      </n-dropdown>
    </div>

    <!-- 正文：点击进入编辑 -->
    <div class="sq-body" @click="emit('edit', beat.id)">
      <div class="sq-title">{{ beat.title || '（无标题）' }}</div>
      <div v-if="beat.kind === 'dialogue'" class="sq-dialogue mono">
        {{ beat.dialogue || '（无台词）' }}
      </div>
      <div v-if="beat.direction || beat.visualDesc" class="sq-sub">
        {{ [beat.direction, beat.visualDesc].filter(Boolean).join(' · ') }}
      </div>
      <div v-if="beat.note" class="sq-note">{{ beat.note }}</div>
    </div>

    <!-- 场景 + 其他主体 -->
    <div class="sq-entities">
      <span
        v-if="sceneChip"
        class="tag-chip"
        :style="{
          background: sceneChip.isScene ? '#eef4ee' : '#fdecec',
          color: sceneChip.isScene ? '#3d6b4a' : '#a12d2d'
        }"
        :title="sceneChip.isScene ? '场景' : '指定的实体类型不是场景'"
      >
        ▣ {{ sceneChip.text }}
      </span>
      <span
        v-else-if="!isAuto"
        class="tag-chip"
        style="background: #fdecec; color: #a12d2d"
      >
        未指定场景
      </span>

      <span
        v-for="t in entityChips"
        :key="t.id"
        class="tag-chip"
        :style="{
          background: t.isSpeaker ? '#e7f6ee' : t.isFocus ? '#eaf0ff' : '#f2f4f7',
          color: t.isSpeaker ? '#217a52' : t.isFocus ? '#2b56b8' : '#5b6273'
        }"
      >
        {{ t.text }}<template v-if="t.isSpeaker">·说</template>
      </span>
      <span
        v-if="!entityChips.length && !isAuto && sceneChip"
        class="tag-chip"
        style="background: #f7f8fa; color: #8b93a1"
      >
        纯场景镜
      </span>
    </div>

    <!-- 底部指标 -->
    <div class="sq-foot">
      <span class="mono muted" style="font-size: 11.5px" @click="emit('edit', beat.id)">
        {{ frames }}f · {{ seconds.toFixed(2) }}s
      </span>
      <div class="row" style="gap: 4px" @click.stop>
        <n-tag
          v-if="splitHint && splitHint > 1"
          size="tiny"
          type="warning"
          :bordered="false"
          style="cursor: pointer"
          @click="emit('split', beat.id)"
        >
          拆 {{ splitHint }}
        </n-tag>
        <n-tag v-if="issue" size="tiny" type="error" :bordered="false">{{ issue }}</n-tag>
      </div>
    </div>
  </div>
</template>
