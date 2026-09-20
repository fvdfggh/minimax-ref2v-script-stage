<script setup lang="ts">
import { computed } from 'vue'
import type { Entity, ID, SeamAnalysis } from '@/domain/types'

const props = defineProps<{
  seam: SeamAnalysis
  index: number
  entityById: Map<ID, Entity>
}>()

function label(id: ID | null | undefined): string {
  if (!id) return '—'
  const e = props.entityById.get(id)
  if (!e) return id
  return `${e.name}${e.subjectN != null ? ` (S${e.subjectN})` : ''}`
}

const mode = computed(() => {
  if (props.seam.blackFallback) return 'black'
  if (props.seam.scenePriorityApplied) return 'scene'
  if (props.seam.needsTailCut) return 'cut'
  return 'aligned'
})

const modeText = computed(
  () =>
    ({
      black: '黑屏兜底',
      scene: '换场切镜',
      cut: '尾帧切镜',
      aligned: '直接顺接'
    })[mode.value]
)

const modeStyle = computed(() => {
  switch (mode.value) {
    case 'black':
      return { background: '#fdf0dc', color: '#8a6008' }
    case 'scene':
      return { background: '#eaf3ec', color: '#3d6b4a' }
    case 'cut':
      return { background: '#e7f0ff', color: '#2b56b8' }
    default:
      return { background: '#e9f7ef', color: '#217a52' }
  }
})
</script>

<template>
  <div class="seam-card" :class="{ 'is-black': mode === 'black', 'is-cut': mode === 'cut' }">
    <div class="row-between">
      <div class="row" style="gap: 6px">
        <span class="mono muted" style="font-size: 11.5px">缝合点 {{ index }} → {{ index + 1 }}</span>
        <span class="tag-chip" :style="modeStyle">{{ modeText }}</span>
        <span
          v-if="seam.sceneChanged"
          class="tag-chip"
          style="background: #eaf3ec; color: #3d6b4a"
        >
          换场
        </span>
      </div>
      <div class="row" style="gap: 6px">
        <span class="tag-chip" :style="{ background: '#f2f4f7', color: '#5b6273' }">
          continuityToNext: {{ seam.continuityToNext }}
        </span>
        <span class="tag-chip" :style="{ background: '#f2f4f7', color: '#5b6273' }">
          continuityFromPrev: {{ seam.continuityFromPrev }}
        </span>
      </div>
    </div>

    <div class="mono" style="margin-top: 8px; font-size: 12px; line-height: 1.8">
      <div>
        场景　
        <span style="color: #3d6b4a">{{ label(seam.leftSceneId) }}</span>
        <span v-if="seam.sceneChanged" style="color: #b06a12"> → </span>
        <span v-else style="color: #9aa1ad"> = </span>
        <span style="color: #3d6b4a">{{ label(seam.rightSceneId) }}</span>
      </div>
      <div>左段末帧主体　<span style="color: #2b56b8">{{ label(seam.lastSubjectId) }}</span></div>
      <div>右段首帧主体　<span style="color: #2b56b8">{{ label(seam.firstSubjectId) }}</span></div>
      <div>右段首个说话人　<span style="color: #217a52">{{ label(seam.firstSpeakerId) }}</span></div>
      <div>
        尾帧切镜目标　
        <span :style="{ color: seam.needsTailCut ? '#2b56b8' : '#9aa1ad' }">
          {{ seam.needsTailCut ? label(seam.tailCutTargetId) : '不需要' }}
        </span>
        <span v-if="seam.scenePriorityApplied" style="color: #3d6b4a">（场景优先）</span>
      </div>
      <div>预备镜头　<span :style="{ color: seam.needsPreshoot ? '#217a52' : '#9aa1ad' }">{{ seam.needsPreshoot ? '需要 0.3s' : '不需要' }}</span></div>
    </div>

    <div v-if="seam.issues.length" class="stack" style="gap: 4px; margin-top: 8px">
      <div v-for="(i, k) in seam.issues" :key="k" class="issue" :class="i.level">{{ i.message }}</div>
    </div>
  </div>
</template>
