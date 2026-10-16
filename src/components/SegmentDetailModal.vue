<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NAlert, NButton, NTag, NTabs, NTabPane, useMessage } from 'naive-ui'
import type { SegmentView } from '@/stores/assembly'
import type { Beat, Entity, FieldSchema, ID, ProjectSettings } from '@/domain/types'
import { composeSegmentText } from '@/domain/derive'
import { formatPad } from '@/domain/frames'
import { BEAT_KIND_COLOR, BEAT_KIND_LABEL } from '@/domain/beats'
import { secondsFromFrames } from '@/domain/timing'
import BeatDetail from './BeatDetail.vue'
import SeamPanel from './SeamPanel.vue'

/**
 * 视频段详情弹窗 —— 在「片段详情(BeatDetail)」基础上，
 * 一个视频段 = 它包含的若干镜头 Tab(可编辑) + 「视频段」Tab(只读) + 「总览」Tab(只读)。
 *
 * 只有前面的镜头 Tab 可改；「视频段」和「总览」只读。
 * 总览 = composeSegmentText 把前面的字段合成最终 Ref2V 提示词，
 * 由镜头 Tab 的编辑实时驱动（view 变化 → 总览跟着变）。
 */
const props = defineProps<{
  show: boolean
  view: SegmentView | null
  index: number
  settings: ProjectSettings
  entities: Entity[]
  entityById: Map<ID, Entity>
  schema: FieldSchema[]
}>()

const emit = defineEmits<{
  'update:show': [boolean]
  patch: [id: ID, patch: Partial<Beat>]
}>()

const message = useMessage()
const activeTab = ref<string>('seg')

/** 可编辑的镜头 = 本段的纯叙事片段（引擎自动片段不进可编辑 Tab） */
const narrativeBeats = computed<Beat[]>(() => props.view?.narrativeBeats ?? [])

const firstBeatTab = computed(() => {
  const b = narrativeBeats.value[0]
  return b ? 'b' + b.id : 'seg'
})

// 每次打开/换段，默认落到第一个镜头 Tab
watch(
  [() => props.show, () => props.view?.group.id],
  ([show]) => {
    if (show) activeTab.value = firstBeatTab.value
  },
  { immediate: true }
)

const overviewText = computed(() => (props.view ? composeSegmentText(props.schema, props.view.fields) : ''))
const duration = computed(() => (props.view ? secondsFromFrames(props.view.frames, props.settings.fps) : 0))
const familyTag = computed(() => (props.view?.refPrev ? '17k' : '5+17k'))
const hardIssues = computed(() =>
  (props.view?.issues ?? []).filter((i) => i.level !== 'info').slice(0, 12)
)

async function copyOverview() {
  const text = overviewText.value
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    message.success('已复制到剪贴板')
  } catch {
    message.error('复制失败，请手动选择文本复制')
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    style="max-width: 860px"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <template #header>
      <div class="row" style="gap: 8px">
        <span style="font-weight: 600">seg{{ String(index + 1).padStart(2, '0') }} · 视频段详情</span>
        <n-tag v-if="view" size="small" :bordered="false">{{ view.frames }} 帧</n-tag>
        <n-tag v-if="view" size="small" :bordered="false" :type="view.aligned ? 'success' : 'error'">
          {{ familyTag }}
        </n-tag>
        <n-tag v-if="view?.over" size="small" type="error" :bordered="false">超限</n-tag>
        <n-tag v-if="view?.stale" size="small" type="warning" :bordered="false">字段可能过期</n-tag>
      </div>
    </template>

    <div v-if="!view" class="empty">没有选中视频段</div>

    <NTabs v-else v-model:value="activeTab" type="line" animated>
      <!-- 镜头 Tab（可编辑）：复用共用组件 BeatDetail -->
      <NTabPane
        v-for="(b, k) in narrativeBeats"
        :key="'b' + b.id"
        :name="'b' + b.id"
        :tab="`${k + 1}. ${b.title || '未命名'}`"
      >
        <BeatDetail
          :beat="b"
          :settings="settings"
          :entities="entities"
          :entity-by-id="entityById"
          @patch="(id, p) => emit('patch', id, p)"
        />
      </NTabPane>

      <!-- 视频段 Tab（只读）：帧长 / 副帧 / 全部镜头 / 缝合 -->
      <NTabPane name="seg" tab="视频段">
        <div class="stack" style="gap: 14px">
          <div class="panel" style="padding: 10px 12px; background: var(--panel-2)">
            <div class="muted" style="font-size: 12px; margin-bottom: 6px">帧长与对齐（只读）</div>
            <div class="mono" style="font-size: 12.5px; line-height: 1.9">
              片段自身 {{ view.rawFrames }} 帧
              <span v-if="view.padTotal" :style="{ color: view.padTotal > 0 ? '#b06a12' : '#2b56b8' }">
                &nbsp;+ 副帧 {{ formatPad(view.padTotal) }}
              </span>
              &nbsp;= {{ view.frames }} 帧 · {{ duration.toFixed(3) }}s
            </div>
            <div class="row" style="gap: 6px; margin-top: 8px; flex-wrap: wrap">
              <span class="tag-chip" style="background: #eef4ee; color: #3d6b4a">
                引用上段：{{ view.refPrev ? '是 (17k)' : '否 (5+17k)' }}
              </span>
              <span
                class="tag-chip"
                :style="view.aligned
                  ? { background: '#e9f7ef', color: '#217a52' }
                  : { background: '#fdecec', color: '#a12d2d' }"
              >
                {{ view.aligned ? '帧长已对齐' : '帧长未对齐' }}
              </span>
              <span v-if="view.over" class="tag-chip" style="background: #fdecec; color: #a12d2d">超限</span>
            </div>
          </div>

          <div>
            <div class="muted" style="font-size: 12px; margin-bottom: 6px">
              本段全部镜头（{{ view.beats.length }}，含引擎自动片段 · 只读）
            </div>
            <div class="stack" style="gap: 6px">
              <div
                v-for="(b, k) in view.beats"
                :key="b.id"
                class="issue"
                style="justify-content: space-between; background: #f7f8fa; border-color: var(--line)"
              >
                <span class="row" style="gap: 6px">
                  <span class="mono" style="color: var(--muted)">{{ k + 1 }}.</span>
                  <span
                    class="tag-chip"
                    :style="{
                      background: BEAT_KIND_COLOR[b.kind] + '18',
                      color: BEAT_KIND_COLOR[b.kind],
                      fontSize: '11px'
                    }"
                  >
                    {{ BEAT_KIND_LABEL[b.kind] }}
                  </span>
                  <span style="font-size: 12.5px">{{ b.title }}</span>
                </span>
                <span class="mono" style="font-size: 11.5px; color: var(--muted)">
                  {{ formatPad(view.pad[b.id] ?? 0) }}f
                </span>
              </div>
            </div>
          </div>

          <div v-if="view.seam">
            <div class="muted" style="font-size: 12px; margin-bottom: 6px">与上一段的缝合</div>
            <SeamPanel :seam="view.seam" :index="index - 1" :entity-by-id="entityById" />
          </div>
        </div>
      </NTabPane>

      <!-- 总览 Tab（只读）：最终 Ref2V 提示词，由前面的镜头/字段驱动 -->
      <NTabPane name="overview" tab="总览">
        <div class="stack" style="gap: 14px">
          <n-alert v-if="view.stale" type="warning" :bordered="false">
            上游片段/实体在上次生成后改过，模型字段（summary / 环境音 / 配乐）可能过期，
            回「④ 字段补全」重新生成。
          </n-alert>

          <div v-if="hardIssues.length">
            <div class="muted" style="font-size: 12px; margin-bottom: 6px">校验提示</div>
            <div class="stack" style="gap: 4px">
              <div v-for="(i, k) in hardIssues" :key="k" class="issue" :class="i.level">
                <span class="mono" style="opacity: 0.7">{{ i.ruleId }}</span>
                <span>{{ i.message }}</span>
              </div>
            </div>
          </div>

          <div>
            <div class="row-between" style="margin-bottom: 6px">
              <span class="muted" style="font-size: 12px">最终 Ref2V 提示词（由前面的镜头与字段生成 · 只读）</span>
              <n-button size="tiny" quaternary @click="copyOverview">复制</n-button>
            </div>
            <pre
              class="mono"
              style="
                margin: 0;
                padding: 12px;
                background: var(--panel-2);
                border: 1px solid var(--line);
                border-radius: 8px;
                font-size: 12px;
                line-height: 1.7;
                white-space: pre-wrap;
                word-break: break-word;
                max-height: 360px;
                overflow: auto;
              "
            >{{ overviewText }}</pre>
          </div>
        </div>
      </NTabPane>
    </NTabs>

    <template #footer>
      <div class="row" style="justify-content: flex-end">
        <n-button @click="emit('update:show', false)">关闭</n-button>
      </div>
    </template>
  </n-modal>
</template>
