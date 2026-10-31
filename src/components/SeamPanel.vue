<script setup lang="ts">
import { computed } from 'vue'
import type { Entity, ID, SeamAnalysis } from '@/domain/types'

const props = defineProps<{
  seam: SeamAnalysis
  index: number
  entityById: Map<ID, Entity>
  /**
   * 列表里的紧凑形态：只留「缝合点 N → N+1 · 怎么缝」一行。
   * 六个字段的明细（左段末帧主体/右段首个说话人/尾帧切镜目标…）在段之间重复出现，
   * 扫列表时全是噪声 —— 那些只在「详情」弹窗里展开。
   */
  compact?: boolean
}>()

function label(id: ID | null | undefined): string {
  if (!id) return '—'
  const e = props.entityById.get(id)
  if (!e) return id
  return `${e.name}${e.subjectN != null ? ` (S${e.subjectN})` : ''}`
}

const STRENGTH_TEXT: Record<number, string> = {
  0: '不引导下段',
  1: '引导 · 保留首帧锚点',
  2: '引导 · 首帧让位'
}

/*
 * 三态 + 一个 legacy 兜底态。
 * guide 策略下 kind 只有 transition / cut / take；legacy 项目仍可能出现黑屏，
 * 那种情况单独标出来，免得旧项目看到"转场"却找不到黑屏提示。
 */
const mode = computed<'black' | 'transition' | 'cut' | 'take'>(() => {
  if (props.seam.blackFallback) return 'black'
  return props.seam.kind
})

const modeText = computed(
  () =>
    ({
      black: '黑屏兜底',
      transition: '转场',
      cut: '镜切',
      take: '顺接'
    })[mode.value]
)

const modeStyle = computed(() => {
  switch (mode.value) {
    case 'black':
    case 'transition':
      return { background: '#fdf0dc', color: '#8a6008' }
    case 'cut':
      return { background: '#e7f0ff', color: '#2b56b8' }
    default:
      return { background: '#e9f7ef', color: '#217a52' }
  }
})

/** legacy 才有的段内补丁信息，guide 下整块不显示 */
const hasLegacyTail = computed(
  () => props.seam.needsTailCut || props.seam.needsPreshoot || props.seam.blackFallback
)

/** 紧凑形态只提示「有几处要注意」，明细留给弹窗；info 级（判定理由那类）不算 */
const warnCount = computed(() => props.seam.issues.filter((i) => i.level !== 'info').length)

const issueText = computed(() => props.seam.issues.map((i) => `· ${i.message}`).join('\n'))
</script>

<template>
  <!-- 列表里的形态：一行交代"这里怎么缝"，六个明细字段收进详情弹窗 -->
  <div v-if="compact" class="seam-line" :class="`is-${mode}`" :title="issueText">
    <span class="seam-glyph">⇣</span>
    <span class="mono muted">缝合点 {{ index }} → {{ index + 1 }}</span>
    <span class="tag-chip" :style="modeStyle">{{ modeText }}</span>
    <span class="seam-reason">{{ seam.reason }}</span>
    <span v-if="warnCount" class="seam-warn">{{ warnCount }} 处待确认</span>
  </div>

  <div v-else class="seam-card" :class="{ 'is-black': mode === 'black', 'is-cut': mode === 'cut' }">
    <div class="row-between">
      <div class="row" style="gap: 6px">
        <span class="mono muted" style="font-size: 11.5px">缝合点 {{ index }} → {{ index + 1 }}</span>
        <span class="tag-chip" :style="modeStyle">{{ modeText }}</span>
        <span
          v-if="seam.sceneChanged"
          class="tag-chip ok"
        >
          换场
        </span>
      </div>
      <div class="row" style="gap: 6px">
        <span class="tag-chip" :style="{ background: 'var(--panel-3)', color: 'var(--label)' }">
          引用上段：{{ seam.continuityFromPrev ? '是' : '否' }}
        </span>
        <span class="tag-chip" :style="{ background: 'var(--panel-3)', color: 'var(--label)' }">
          强度 {{ seam.strength }}
        </span>
      </div>
    </div>

    <div class="mono" style="margin-top: 8px; font-size: 12px; line-height: 1.8">
      <div>
        场景　
        <span style="color: var(--ok-ink)">{{ label(seam.leftSceneId) }}</span>
        <span v-if="seam.sceneChanged" style="color: var(--warn-ink)"> → </span>
        <span v-else style="color: var(--muted-2)"> = </span>
        <span style="color: var(--ok-ink)">{{ label(seam.rightSceneId) }}</span>
      </div>
      <div>左段末帧主体　<span style="color: var(--accent-ink)">{{ label(seam.lastSubjectId) }}</span></div>
      <div>右段首帧主体　<span style="color: var(--accent-ink)">{{ label(seam.firstSubjectId) }}</span></div>
      <div>右段首个说话人　<span style="color: var(--ok-ink)">{{ label(seam.firstSpeakerId) }}</span></div>
      <div>引用强度　{{ seam.strength }} · {{ STRENGTH_TEXT[seam.strength] }}</div>
      <div>判定依据　<span style="color: var(--label)">{{ seam.reason }}</span></div>
      <template v-if="hasLegacyTail">
        <div>
          尾帧切镜目标　
          <span :style="{ color: seam.needsTailCut ? 'var(--accent-ink)' : 'var(--muted-2)' }">
            {{ seam.needsTailCut ? label(seam.tailCutTargetId) : '不需要' }}
          </span>
          <span v-if="seam.scenePriorityApplied" style="color: var(--ok-ink)">（场景优先）</span>
        </div>
        <div>
          预备镜头　
          <span :style="{ color: seam.needsPreshoot ? 'var(--ok-ink)' : 'var(--muted-2)' }">
            {{ seam.needsPreshoot ? '需要 0.3s' : '不需要' }}
          </span>
        </div>
      </template>
    </div>

    <div v-if="seam.issues.length" class="stack" style="gap: 4px; margin-top: 8px">
      <div v-for="(i, k) in seam.issues" :key="k" class="issue" :class="i.level">{{ i.message }}</div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 紧凑形态：夹在两段之间的一根横条，左侧虚线像"接缝"。
 * 只回答"这里怎么缝"，不再铺六个字段。
 */
.seam-line {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 2px 0 2px 12px;
  padding: 2px 8px 2px 7px;
  font-size: 11.5px;
  color: var(--muted);
  border-left: 2px dotted var(--line-strong);
  border-radius: 0 6px 6px 0;
}
.seam-line.is-black,
.seam-line.is-transition {
  border-left-color: var(--warn);
}
.seam-line.is-cut {
  border-left-color: var(--accent-line);
}
.seam-line.is-take {
  border-left-color: var(--ok-line);
}
.seam-reason {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.seam-glyph {
  font-size: 10px;
  color: var(--line-strong);
}
.seam-warn {
  margin-left: auto;
  padding: 0 6px;
  font-size: 10.5px;
  line-height: 16px;
  color: var(--err-ink);
  background: var(--err-soft);
  border-radius: 4px;
}
</style>
