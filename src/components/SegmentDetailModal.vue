<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NAlert, NButton, NModal, NTabs, NTabPane, useMessage } from 'naive-ui'
import type { SegmentView } from '@/stores/assembly'
import type { Asset, Beat, BeatKind, Entity, FieldSchema, ID, ProjectSettings } from '@/domain/types'
import { composeSegmentText } from '@/domain/derive'
import { beatWindowsOf, formatPad } from '@/domain/frames'
import { mergeAttachments } from '@/domain/packInput'
import type { MergedAttachments } from '@/domain/packInput'
import { BEAT_KIND_COLOR, BEAT_KIND_LABEL } from '@/domain/beats'
import { secondsFromFrames } from '@/domain/timing'
import BeatDetail from './BeatDetail.vue'
import SeamPanel from './SeamPanel.vue'
import InfoTip from './common/InfoTip.vue'

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
  /** 注册表里的全部素材：用来把关键帧 / 音视频摊到合并后的段内帧位 */
  assets?: Asset[]
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

/** 概览 = 实际会提交的那份提示词（跟工作语言一致，见 domain/lang.deliveryFields） */
const overviewText = computed(() =>
  props.view
    ? composeSegmentText(props.schema, props.view.delivery)
    : ''
)
const duration = computed(() => (props.view ? secondsFromFrames(props.view.frames, props.settings.fps) : 0))
const familyTag = computed(() => (props.view?.refPrev ? '17k 单段' : '5+17k 衔接'))
const hardIssues = computed(() =>
  (props.view?.issues ?? []).filter((i) => i.level !== 'info').slice(0, 12)
)

/* ---------------- 合并后的段内位置 ----------------
 * 关键帧 / 音视频在片段卡片上是"本拍第 N 帧"，几个片段拼成一段之后，
 * 位置必须换算成段内绝对帧位（含副帧、含预备镜头这类自动片段）。
 * 这里和打包走同一个 mergeAttachments，界面上看到的就是实际会送出去的位置。
 */
const windows = computed(() =>
  props.view ? beatWindowsOf(props.view.beats, props.settings, props.view.pad) : []
)

const merged = computed<MergedAttachments>(() =>
  props.view
    ? mergeAttachments(props.view.beats, props.assets ?? [], props.settings, props.view.pad)
    : { keyframes: [], materials: [], refImages: [] }
)

const beatLabels = computed(() => {
  const map = new Map<ID, string>()
  windows.value.forEach((w, i) => map.set(w.beat.id, `${i + 1}. ${w.beat.title || '未命名'}`))
  return map
})

/** 片段类型色：与 BeatCard / BeatDetail 同一套，浅底 + 同色描边 */
function kindStyle(kind: BeatKind): Record<string, string> {
  const c = BEAT_KIND_COLOR[kind] ?? '#6b7280'
  return { background: c + '16', borderColor: c + '38', color: c }
}

function kfPosText(k: { role: string; frameIdx: number }): string {
  if (k.role === 'start') return `第 ${k.frameIdx} 帧 · 兼作起始画面`
  if (k.role === 'end') return `第 ${k.frameIdx} 帧 · 兼作收尾画面`
  return `第 ${k.frameIdx} 帧`
}

function nameOf(a: Asset): string {
  return a.originalName || a.fileName
}

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
    style="max-width: 880px"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <template #header>
      <div class="sd-head">
        <span class="sd-seq mono">seg{{ String(index + 1).padStart(2, '0') }}</span>
        <span class="sd-title">视频段详情</span>
        <div v-if="view" class="sd-chips">
          <span class="chip mute">{{ view.frames }} 帧</span>
          <span class="chip" :class="view.aligned ? 'ok' : 'err'">{{ familyTag }}</span>
          <span v-if="view.over" class="chip err">超限</span>
          <span v-if="view.stale" class="chip warn">字段可能过期</span>
          <span
            v-if="view.result.state !== 'none'"
            class="chip"
            :class="
              view.result.state === 'ready'
                ? 'ok'
                : view.result.state === 'moved'
                  ? 'info'
                  : view.result.state === 'stale'
                    ? 'warn'
                    : 'err'
            "
            :title="view.result.reason"
          >
            {{ view.result.label }}
          </span>
        </div>
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
          :show-head="false"
          @patch="(id, p) => emit('patch', id, p)"
        />
      </NTabPane>

      <!-- 视频段 Tab（只读）：帧长 / 副帧 / 全部镜头 / 缝合 -->
      <NTabPane name="seg" tab="视频段">
        <div class="sd-body">
          <section class="sd-sec t-blue">
            <div class="sd-sec-h">帧长与对齐<span class="sd-ro">只读</span></div>
            <div class="sd-frames mono">
              <span>片段自身 {{ view.rawFrames }} 帧</span>
              <span v-if="view.padTotal" :class="view.padTotal > 0 ? 'sd-warn' : 'sd-ok'">
                + 副帧 {{ formatPad(view.padTotal) }}
              </span>
              <span class="sd-eq">=</span>
              <span class="sd-total">{{ view.frames }} 帧 · {{ duration.toFixed(3) }}s</span>
            </div>
            <div class="sd-chips">
              <span class="chip mute">引用上段：{{ view.refPrev ? '是 (17k)' : '否 (5+17k)' }}</span>
              <span class="chip" :class="view.aligned ? 'ok' : 'err'">
                {{ view.aligned ? '帧长已对齐' : '帧长未对齐' }}
              </span>
              <span v-if="view.over" class="chip err">超限</span>
            </div>
          </section>

          <section class="sd-sec t-teal">
            <div class="sd-sec-h">
              本段全部镜头
              <span class="sd-ro">{{ view.beats.length }} 个 · 含引擎自动片段</span>
            </div>
            <div class="sd-list">
              <div v-for="(w, k) in windows" :key="w.beat.id" class="sd-row">
                <span class="sd-row-l">
                  <span class="mono sd-idx">{{ k + 1 }}</span>
                  <span class="sd-kind" :style="kindStyle(w.beat.kind)">
                    {{ BEAT_KIND_LABEL[w.beat.kind] }}
                  </span>
                  <span class="sd-name">
                    {{ w.beat.title === BEAT_KIND_LABEL[w.beat.kind] ? '' : w.beat.title }}
                  </span>
                </span>
                <span class="sd-row-r mono">
                  第 {{ w.start }}–{{ w.end }} 帧
                  <em>· {{ formatPad(view.pad[w.beat.id] ?? 0) }}f</em>
                </span>
              </div>
            </div>
          </section>

          <!-- 合并后的关键帧 / 音视频位置：随段组成、副帧实时变化 -->
          <section class="sd-sec t-violet">
            <div class="sd-sec-h">段内参考素材位置<span class="sd-ro">合并后 · 含副帧</span></div>
            <div v-if="!merged.keyframes.length && !merged.materials.length" class="sd-empty">
              本段还没有关键帧或音视频素材
            </div>
            <div v-else class="sd-list">
              <div v-for="k in merged.keyframes" :key="'k' + k.asset.id" class="sd-row">
                <span class="sd-row-l">
                  <span class="chip ok">关键帧</span>
                  <span class="mono sd-from">{{ beatLabels.get(k.beatId) }}</span>
                  <span class="sd-name">{{ nameOf(k.asset) }}</span>
                </span>
                <span class="sd-row-r mono">{{ kfPosText(k) }}</span>
              </div>
              <div v-for="m in merged.materials" :key="'m' + m.asset.id" class="sd-row">
                <span class="sd-row-l">
                  <span class="chip info">{{ m.asset.media === 'audio' ? '音频' : '视频' }}</span>
                  <span class="mono sd-from">{{ beatLabels.get(m.beatId) }}</span>
                  <span class="sd-name">{{ nameOf(m.asset) }}</span>
                </span>
                <span class="sd-row-r mono">第 {{ m.frameIdx }} 帧起</span>
              </div>
            </div>
            <p class="sd-help">
              位置按片段实际长度累加
              <InfoTip size="sm" :width="320" text="片段长度 = 自身帧数 + 副帧；段首有预备镜头时从预备镜头之后算起。" />
            </p>
          </section>

          <section v-if="view.seam" class="sd-sec t-amber">
            <div class="sd-sec-h">与上一段的缝合</div>
            <SeamPanel :seam="view.seam" :index="index - 1" :entity-by-id="entityById" />
          </section>
        </div>
      </NTabPane>

      <!-- 总览 Tab（只读）：最终 Ref2V 提示词，由前面的镜头/字段驱动 -->
      <NTabPane name="overview" tab="总览">
        <div class="sd-body">
          <n-alert v-if="view.stale" type="warning" :bordered="false">
            上游片段 / 实体改过，模型字段可能过期
            <InfoTip
              :width="360"
              text="summary / 环境音 / 配乐 是在旧内容上生成的。回「③ 组合与缝合」下面那块字段补全重新生成。"
            />
          </n-alert>

          <section v-if="hardIssues.length" class="sd-sec t-amber">
            <div class="sd-sec-h">校验提示<span class="sd-ro">{{ hardIssues.length }} 条</span></div>
            <div class="sd-list">
              <div v-for="(i, k) in hardIssues" :key="k" class="issue" :class="i.level">
                <span class="mono" style="opacity: 0.7">{{ i.ruleId }}</span>
                <span>{{ i.message }}</span>
              </div>
            </div>
          </section>

          <section class="sd-sec t-blue">
            <div class="sd-sec-h">最终 Ref2V 提示词<span class="sd-ro">由镜头与字段生成 · 只读</span></div>
            <div class="sd-code">
              <div class="sd-code-h">
                <span class="mono">{{ overviewText.length }} 字符</span>
                <n-button size="tiny" quaternary @click="copyOverview">复制</n-button>
              </div>
              <pre class="mono sd-pre">{{ overviewText }}</pre>
            </div>
          </section>
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

<style scoped>
/* ---------- 弹窗头 ---------- */
.sd-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.sd-seq {
  flex: 0 0 auto;
  padding: 0 7px;
  border-radius: var(--r-sm);
  border: 1px solid var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 11px;
  line-height: 19px;
  font-weight: 600;
}
.sd-title {
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text);
}
.sd-chips {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  margin-left: auto;
}
/* 内容区里的胶囊靠左；靠右只是弹窗标题那一行的事 */
.sd-sec .sd-chips {
  margin-left: 0;
}

/* ---------- 段 ---------- */
.sd-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  /* 镜头多、提示词长的时候，让内容自己滚，别把弹窗顶出视口 */
  max-height: 68vh;
  overflow-y: auto;
  padding-right: 4px;
}
.sd-sec {
  --mod: var(--m-blue);
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.sd-sec.t-violet {
  --mod: var(--m-violet);
}
.sd-sec.t-teal {
  --mod: var(--m-teal);
}
.sd-sec.t-amber {
  --mod: var(--m-amber);
}
.sd-sec + .sd-sec {
  border-top: 1px dashed var(--line);
  padding-top: 12px;
}
.sd-sec-h {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.4px;
  color: var(--text-2);
}
.sd-sec-h::before {
  content: '';
  width: 14px;
  height: 3px;
  border-radius: 2px;
  background: var(--mod);
}
.sd-ro {
  font-weight: 400;
  font-size: var(--fs-xs);
  letter-spacing: 0;
  color: var(--muted);
}

/* ---------- 帧长行 ---------- */
.sd-frames {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 7px 10px;
  border-radius: var(--r-sm);
  background: var(--panel-2);
  border: 1px solid var(--line);
  font-size: var(--fs-base);
  color: var(--text-2);
}
.sd-frames .sd-eq {
  color: var(--muted-2);
}
.sd-total {
  font-weight: 600;
  color: var(--text);
}
.sd-warn {
  color: var(--warn-ink);
}
.sd-ok {
  color: var(--accent-ink);
}

/* ---------- 行列表 ---------- */
.sd-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sd-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  padding: 5px 9px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  border-left: 2px solid var(--mod);
  background: var(--panel-2);
}
.sd-row-l {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.sd-row-r {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--text-2);
}
.sd-row-r em {
  font-style: normal;
  color: var(--muted);
}
.sd-idx {
  flex: 0 0 auto;
  min-width: 14px;
  font-size: 11px;
  color: var(--muted);
}
.sd-kind {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: var(--r-pill);
  border: 1px solid transparent;
  font-size: 10.5px;
  line-height: 17px;
}
.sd-name {
  min-width: 0;
  font-size: var(--fs-base);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sd-from {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--muted);
}
.sd-empty {
  padding: 10px;
  border-radius: var(--r-sm);
  border: 1px dashed var(--line);
  font-size: var(--fs-sm);
  color: var(--muted);
  text-align: center;
}
.sd-help {
  margin: 0;
  font-size: 10.8px;
  line-height: 1.6;
  color: var(--muted);
}

/* ---------- 提示词代码块 ---------- */
.sd-code {
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--panel);
}
.sd-code-h {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 6px 3px 10px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--line);
  font-size: 11px;
  color: var(--muted);
}
.sd-pre {
  margin: 0;
  padding: 11px 12px;
  max-height: 360px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
}
</style>
