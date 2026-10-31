<script setup lang="ts">
/**
 * 「本段产物」：挂在交付页每一段的详情顶部。
 *
 * 产物不是独立一摊东西，它属于**这一段** —— 所以这里只画这一段的一采/二采，
 * 两个操作（重跑这段 / 导出这段）就只作用于这一段：一采重跑单段是日常操作，
 * 勾选不扩链，上游没一起跑时这一段会沿用上一次留在缓存里的末帧作参考
 * （`useSegmentProducts.pickForRun`）。只有二采才按整条链补齐。
 */
import { computed } from 'vue'
import { NButton, NTag } from 'naive-ui'
import type { SegmentProduct } from '@/stores/outputs'
import { passLabelText, passToneOf, posterUrl } from '@/domain/productDisplay'
import type { ResultStatus } from '@/domain/insertion'

const props = defineProps<{
  row: SegmentProduct | null
  loading?: boolean
  hint?: string
  /** 这一段在组合页那边的结果状态：已失效 / 待重跑时这里也要说一声 */
  result?: ResultStatus | null
}>()

defineEmits<{
  (e: 'run'): void
  (e: 'export'): void
}>()

const firstLabel = computed(() =>
  props.row ? passLabelText(props.row.first, 'first') : '未探测'
)
const secondLabel = computed(() =>
  props.row ? passLabelText(props.row.second, 'second', props.row.canSecondSample) : '未探测'
)
</script>

<template>
  <section class="prod-block">
    <div class="pb-head">
      <span class="pb-title">本段产物</span>
      <template v-if="row">
        <n-tag size="tiny" :type="passToneOf(row.first)" :bordered="false">
          一采 {{ firstLabel }}
        </n-tag>
        <n-tag size="tiny" :type="passToneOf(row.second)" :bordered="false">
          二采 {{ secondLabel }}
        </n-tag>
        <n-tag v-if="row.first.stale || row.second.stale" size="tiny" type="warning" :bordered="false">
          内容已改，缓存是旧渲染
        </n-tag>
        <n-tag
          v-if="result && (result.state === 'stale' || result.state === 'voided')"
          size="tiny"
          type="error"
          :bordered="false"
          :title="result.reason"
        >
          {{ result.state === 'voided' ? '成片已失效' : '待重跑' }}
        </n-tag>
        <span class="muted mono" style="font-size: 11px">
          {{ row.frames }}f · {{ row.seconds.toFixed(1) }}s
        </span>
      </template>
      <span v-else class="muted" style="font-size: 11.5px">
        {{ loading ? '正在读缓存…' : hint || '这一段的缓存对不上当前段表' }}
      </span>
      <div class="row" style="gap: 4px; margin-left: auto">
        <n-button
          size="tiny"
          quaternary
          :disabled="!row"
          title="按交付页的「统一运行参数」重跑：只跑这一段；若它引用上段且上游这次不跑，会沿用上一次的末帧作参考"
          @click="$emit('run')"
        >
          重跑这段
        </n-button>
        <n-button
          size="tiny"
          quaternary
          :disabled="!row"
          :title="
            row
              ? '把这一个段的成片写到导出目录（只复制缓存，不重新渲染）'
              : '这一段现在没有成片：先跑一采，或检查缓存目录'
          "
          @click="$emit('export')"
        >
          导出这段
        </n-button>
      </div>
    </div>

    <div v-if="row" class="pb-passes">
      <div class="pb-pass">
        <div class="pb-pass-head">
          <span>一采</span>
          <a v-if="row.first.hasClip" :href="row.firstUrl" target="_blank" rel="noreferrer">打开</a>
        </div>
        <video
          v-if="row.first.hasClip"
          :src="posterUrl(row.firstUrl)"
          controls
          playsinline
          preload="metadata"
        />
        <div v-else class="pb-empty">{{ firstLabel }}</div>
      </div>

      <div class="pb-pass">
        <div class="pb-pass-head">
          <span>二采</span>
          <a v-if="row.second.hasClip" :href="row.secondUrl" target="_blank" rel="noreferrer">打开</a>
        </div>
        <video
          v-if="row.second.hasClip"
          :src="posterUrl(row.secondUrl)"
          controls
          playsinline
          preload="metadata"
        />
        <div v-else class="pb-empty">{{ secondLabel }}</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.prod-block {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-2, var(--panel-2));
  padding: 8px 10px 10px;
  margin-bottom: 14px;
}
.pb-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.pb-title {
  font-size: 13px;
  font-weight: 600;
}
.pb-passes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 10px;
}
.pb-pass {
  min-width: 0;
}
.pb-pass-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--muted);
  margin-bottom: 4px;
}
.pb-pass-head a {
  color: var(--accent);
  text-decoration: none;
}
.pb-pass video {
  /* 按自身比例缩，不硬框成扁盒子（否则左右留黑边，像被压窄了） */
  display: block;
  width: 100%;
  height: auto;
  max-height: 220px;
  margin: 0 auto;
  object-fit: contain;
  background: #000;
  border: 1px solid var(--line);
  border-radius: 6px;
}
.pb-empty {
  width: 100%;
  aspect-ratio: 16 / 9;
  max-height: 200px;
  min-height: 88px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 0 10px;
  font-size: 12px;
  color: var(--muted);
  border: 1px dashed var(--line);
  border-radius: 6px;
  background: var(--panel);
}
</style>
