<!--
  段卡的第三层：这一整段的模型字段。

  为什么长在段卡里，而不是另开一页：这几个字段描述的是「一个已经定稿的视频段」——
  段落概述、详细画面描述、整体声景。段一合、一拆、补几帧，它们就旧了。
  两件事本来就是同一次判断（"这一段缝合对不对" + "这段的字是不是旧稿"），
  拆成两页只会逼人来回跳。

  为什么默认折起来：③ 的主活是缝合与帧长，字段是核对用的第二层。
  折起来也得能看出状态 —— 所以头部常驻「3/6 · 缺 整体声景」，
  要读正文再展开，不弹窗。
-->
<template>
  <section class="sf">
    <header class="sf-h" :title="open ? '收起这一段的字段' : '展开这一段的字段'" @click="toggle">
      <span class="sf-lead">段字段</span>
      <span class="sf-count mono">{{ filled }}/{{ llmFields.length }}</span>
      <span v-if="state.tone !== 'ok'" class="sf-state" :class="`t-${state.tone}`">
        {{ state.label }}
      </span>
      <span v-if="missingNames" class="sf-miss" :title="`缺：${missingNames}`">
        缺 {{ missingNames }}
      </span>
      <span v-if="pendingSync" class="sf-sync" title="中文和英文两份内容对不上">· {{ pendingSync }} 项待同步</span>
      <span class="sf-spacer" />
      <button
        class="sf-act"
        :disabled="running || !providerReady"
        :title="providerReady ? '按这一段现在的内容重新生成模型字段' : '先在模型设置里配置供应商'"
        @click.stop="$emit('generate')"
      >
        {{ running ? '生成中…' : status === 'done' ? '重新生成' : '生成本段' }}
      </button>
      <span class="sf-more">{{ open ? '收起' : '展开' }}</span>
    </header>

    <p v-if="failedText" class="sf-note err"><b>失败</b>{{ failedText }}</p>
    <!--
      补帧之后段变长变短：模型生成时看到的是「X 帧 = Y 秒」，
      文字里提到的时长就旧了。它不算过期（内容没改），但要说一声。
    -->
    <p v-if="view.framesChanged" class="sf-note warn">
      <b>帧数改过</b>生成时 {{ view.generatedFrames }} 帧，现在 {{ view.frames }} 帧：字段里的时长要复核
    </p>

    <div v-if="open" class="flds">
      <template v-for="f in llmFields" :key="f.key">
        <FieldRow
          class="fld"
          :label="fieldLabel(f)"
          :field-key="f.key"
          :tone="!fieldFilled(f) ? 'empty' : 'plain'"
          :dot="!!syncTone(f.key)"
          :dot-title="syncText(f.key)"
        >
          <div v-if="!fieldFilled(f)" class="fld-hint">
            {{ fieldHint(f) || '这一段该填什么，见字段说明' }}
          </div>
          <div class="fld-val mono" :class="[clampClass(f.source), { open: isFieldOpen(f.key) }]">
            {{ textOf(f).trim() || blankText(f) }}
          </div>
          <button v-if="isLongField(textOf(f), f.source)" class="fld-toggle" @click="toggleField(f.key)">
            {{ isFieldOpen(f.key) ? '收起' : '展开全文' }}
          </button>
        </FieldRow>
      </template>

      <div v-if="derivedFields.length" class="flds-sep">
        派生字段 · 由引擎按片段现算，改片段才会变
      </div>
      <template v-for="f in derivedFields" :key="f.key">
        <FieldRow
          class="fld is-derived"
          :label="fieldLabel(f)"
          :field-key="f.key"
          tone="quiet"
          :dot="!!syncTone(f.key)"
          :dot-title="syncText(f.key)"
        >
          <div class="fld-val mono" :class="[clampClass(f.source), { open: isFieldOpen(f.key) }]">
            {{ textOf(f).trim() || '（空）' }}
          </div>
          <button v-if="isLongField(textOf(f), f.source)" class="fld-toggle" @click="toggleField(f.key)">
            {{ isFieldOpen(f.key) ? '收起' : '展开全文' }}
          </button>
        </FieldRow>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import FieldRow from '@/components/FieldRow.vue'
import { useProviderStore } from '@/stores/provider'
import type { SegmentView } from '@/stores/assembly'
import type { SegFieldState } from '@/composables/useSegmentFields'
import { fieldHint, fieldLabel } from '@/domain/fieldLabels'
import type { FieldSchema } from '@/domain/types'

const props = defineProps<{
  /** 这一段（字段、帧数、同步状态都在里面） */
  view: SegmentView
  /** 模型字段（要人看的） */
  llmFields: FieldSchema[]
  /** 派生字段（只读，排在最后） */
  derivedFields: FieldSchema[]
  /** 状态胶囊，由页面统一判定，卡片不自己算 */
  state: SegFieldState
  /** 页面上的「全部展开」 */
  expandAll: boolean
  /** 是否有生成任务在跑 */
  running: boolean
  /** 这一段上一次生成失败的原因 */
  failedText?: string
}>()

defineEmits<{ generate: [] }>()

const provider = useProviderStore()
const providerReady = computed(() => provider.ready)

/** 默认折起；页面点「全部展开」时跟着开，点「全部收起」时跟着关 */
const open = ref(props.expandAll)
watch(
  () => props.expandAll,
  (v) => (open.value = v)
)

function toggle() {
  open.value = !open.value
}

/* ------------------------------ 字段正文 ------------------------------ */

/** 收起的字段：点「展开全文」单独打开（不跟着全局开关走） */
const openFields = ref<Record<string, boolean>>({})

function isFieldOpen(key: string): boolean {
  return !!openFields.value[key]
}

function toggleField(key: string) {
  openFields.value = { ...openFields.value, [key]: !openFields.value[key] }
}

function textOf(f: FieldSchema): string {
  return props.view.delivery[f.key] ?? ''
}

function fieldFilled(f: FieldSchema): boolean {
  return !!textOf(f).trim()
}

const filled = computed(() => props.llmFields.filter((f) => textOf(f).trim()).length)

/** 缺的字段名：段头上直接写「缺 整体声景、非叙事配乐」，不用展开 */
const missingNames = computed(() =>
  props.llmFields
    .filter((f) => !textOf(f).trim())
    .map((f) => fieldLabel(f))
    .join('、')
)

const status = computed(() => {
  if (!props.llmFields.length) return 'done'
  const missing = props.llmFields.length - filled.value
  if (missing === 0) return 'done'
  return missing === props.llmFields.length ? 'empty' : 'partial'
})

/** 空字段占位：区分「没生成过」和「中文被英文覆盖了」 */
function blankText(f: FieldSchema): string {
  return props.view.fieldSync?.[f.key] === 'en-only' ? '（中文稿缺失）' : '（尚未生成）'
}

/* --------------------------- 中英同步状态 --------------------------- */

function syncTone(key: string): 'err' | '' {
  const st = props.view.fieldSync?.[key]
  return st === 'zh-newer' || st === 'en-newer' || st === 'src-newer' || st === 'conflict'
    ? 'err'
    : ''
}

function syncText(key: string): string {
  switch (props.view.fieldSync?.[key]) {
    case 'zh-newer':
      return '中文比英文新：英文终稿待重译'
    case 'en-newer':
      return '英文比中文新：这份中文稿落后了'
    case 'en-only':
      return '只有英文：中文稿缺失'
    case 'zh-only':
      return '只有中文：英文终稿还没做'
    case 'src-newer':
      return '引用改过：中文和英文都该按新素材重做'
    case 'conflict':
      return '中英两份都改过：去「同步」页定一个方向'
    default:
      return ''
  }
}

/** 这一段有几项两份对不上 */
const pendingSync = computed(
  () =>
    Object.values(props.view.fieldSync ?? {}).filter(
      (x) => x === 'zh-newer' || x === 'en-newer' || x === 'src-newer' || x === 'conflict'
    ).length
)

/* ------------------------------ 折叠 ------------------------------ */

/**
 * 阈值按行数估：模型字段露 8 行、派生字段只露 1 行。派生字段是只读的，
 * 默认铺满会把一屏撑成一段 —— 想知道细节的人点开就是了。
 */
function isLongField(text: string, source: string): boolean {
  if (!text) return false
  const lines = text.split('\n').length
  return source === 'llm' ? lines > 6 || text.length > 340 : lines > 1 || text.length > 48
}

function clampClass(source: string): string {
  return source === 'llm' ? 'clamp-6' : 'clamp-1'
}
</script>

<style scoped>
/* ------------------------------------------------------------------ *
 * 第三层：字段
 *
 * 一条虚分隔线把它和上面的镜头分开 —— 上面是"这一段怎么拼"，
 * 下面是"这一段在说什么"。不铺底色、不加左侧色条：
 * 段卡左边那条 2px 只表达一件事（缝合/过期），不能有两个语义。
 * ------------------------------------------------------------------ */
.sf {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}

.sf-h {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  cursor: pointer;
  user-select: none;
}

.sf-lead {
  font-size: 12px;
  font-weight: 600;
  color: var(--label);
}

.sf-count {
  font-size: 11.5px;
  color: var(--muted);
}

.sf-state {
  font-size: 11.5px;
  font-weight: 600;
}

.sf-state.t-err {
  color: var(--err-ink);
}

.sf-state.t-warn {
  color: var(--warn-ink);
}

.sf-state.t-todo {
  color: var(--muted);
}

/* 缺哪几项：常驻，不用展开就能看见 */
.sf-miss {
  min-width: 0;
  max-width: 340px;
  overflow: hidden;
  font-size: 11.5px;
  color: var(--warn-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sf-sync {
  font-size: 11.5px;
  color: var(--err-ink);
}

.sf-spacer {
  flex: 1 1 0;
  min-width: 0;
}

/* 卡里的动作按钮：比段头那排更轻，它是"这一段"的动作不是"整页"的 */
.sf-act {
  padding: 1px 8px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--panel);
  color: var(--label);
  font-family: inherit;
  font-size: 11.5px;
  line-height: 18px;
  cursor: pointer;
}

.sf-act:hover:not(:disabled) {
  border-color: var(--accent-line);
  color: var(--accent);
}

.sf-act:disabled {
  opacity: 0.4;
  cursor: default;
}

.sf-more {
  font-size: 11.5px;
  color: var(--accent);
}

.sf-note {
  display: flex;
  gap: 8px;
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.65;
}

.sf-note b {
  flex: 0 0 auto;
  font-weight: 600;
  opacity: 0.85;
}

.sf-note.err {
  color: var(--err-ink);
}

.sf-note.warn {
  color: var(--warn-ink);
}

/* 字段：一条 = 左边一个名字徽章 + 右边一条正文 */
.flds {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}

.fld-val {
  font-size: 12.6px;
  line-height: 1.7;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

/* 空字段：只有这里允许出现「红」，因为它是唯一必须动手的地方 */
.fld.is-empty .fld-val {
  color: var(--muted);
  font-family: inherit;
  font-style: italic;
}

.fld-hint {
  margin-bottom: 2px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--err-ink);
  opacity: 0.9;
}

/* 派生字段：正文浅一档 */
.fld.is-derived .fld-val {
  color: var(--label);
  opacity: 0.9;
}

.fld-toggle {
  margin-top: 3px;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: 11px;
  color: var(--accent);
  cursor: pointer;
}

.fld-toggle:hover {
  text-decoration: underline;
}

.flds-sep {
  margin: 8px 0 2px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
  font-size: 11px;
  color: var(--muted);
}

/* 折叠：模型字段 6 行，派生字段 1 行 */
.fld-val.clamp-6,
.fld-val.clamp-1 {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.fld-val.clamp-6 {
  -webkit-line-clamp: 6;
}

.fld-val.clamp-1 {
  -webkit-line-clamp: 1;
}

.fld-val.open {
  display: block;
  -webkit-line-clamp: unset;
  overflow: visible;
}

@media (max-width: 900px) {
  .flds {
    --frow-badge-w: 62px;
    --frow-badge-fs: 10.5px;
  }
}
</style>
