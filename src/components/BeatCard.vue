<script setup lang="ts">
/**
 * 「拆解」页的单个片段卡片。
 *
 * 拆解阶段真正要反复动的东西只有几样：类型、标题、台词、帧数、场景、主体、说话人。
 * 以前它们全在「编辑片段」弹窗里 —— 一段一段点开、改一个数字、关掉、再点下一段，
 * 二十段就是四十次点击。现在全部铺在卡片上：
 *
 *   · 帧数带 − / ＋ 微调 + 「自动」标记，手动改过会标「手动」，点 ↺ 回到自动推算
 *   · 场景 / 主体 / 说话人是下拉，改完立即落库
 *   · 标题 / 台词走本地草稿 + 600ms 防抖 —— 直接绑 store 的话每敲一个字都全表落库
 *
 * 详情弹窗仍然保留（⋯ → 打开完整详情）：聚焦主体、镜头描述、画面描述、场景图
 * 这些属于阶段二填充的内容还在那里，需要时再进去，不占卡片的日常空间。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NCheckbox, NDropdown, NInput, NInputNumber, NSelect, NTag } from 'naive-ui'
import { BEAT_KIND_COLOR, BEAT_KIND_LABEL, beatIssueLabel } from '@/domain/beats'
import { beatFrames, countHanzi, dialogueFrames, secondsFromFrames } from '@/domain/timing'
import type { Beat, BeatKind, Entity, ID, ProjectSettings } from '@/domain/types'
import { AUTO_KINDS } from '@/domain/types'

const props = defineProps<{
  beat: Beat
  index: number
  settings: ProjectSettings
  entityById: Map<ID, Entity>
  sceneOptions: Array<{ label: string; value: ID }>
  entityOptions: Array<{ label: string; value: ID }>
  speakerOptions: Array<{ label: string; value: ID }>
  /**
   * 本段会自动带上的参考图。
   * 图挂在主体上（entity.pictureN），不是段级素材：选了主体就自动有，
   * 所以这张卡片上只能"看"，换图要去主体页或素材弹窗。
   */
  refPics?: Array<{ id: string; name: string; url: string | null; pic: number }>
  selected?: boolean
  selectable?: boolean
  draggable?: boolean
  /** 建议拆分份数，>1 时显示拆分提示 */
  splitHint?: number
  /** "过长被迫拆开"的分片信息；有值时卡片标一个"拆 i/n"徽章 */
  splitPiece?: { index: number; total: number } | null
}>()

const emit = defineEmits<{
  patch: [id: ID, patch: Partial<Beat>]
  edit: [id: ID]
  remove: [id: ID]
  split: [id: ID]
  merge: [id: ID]
  /** 让模型把这一拍拆细（页面弹预览，不直接改） */
  aiSplit: [id: ID]
  move: [from: number, to: number]
  select: [id: ID]
}>()

const dragging = ref(false)
const dropSide = ref<'before' | 'after' | null>(null)

const frames = computed(() => beatFrames(props.beat, props.settings))
const seconds = computed(() => secondsFromFrames(frames.value, props.settings.fps))
const autoFrames = computed(() => dialogueFrames(props.beat.dialogue, props.settings.fps))
const hanziCount = computed(() => countHanzi(props.beat.dialogue))
const issue = computed(() => beatIssueLabel(props.beat))
const isAuto = computed(() => AUTO_KINDS.includes(props.beat.kind))
const kindColor = computed(() => BEAT_KIND_COLOR[props.beat.kind as BeatKind] ?? '#6b7280')

const KINDS: Array<{ label: string; value: BeatKind }> = [
  { label: '台词', value: 'dialogue' },
  { label: '动作', value: 'action' },
  { label: '换场', value: 'scene_switch' },
  { label: '铺垫', value: 'establishing' },
  { label: '反应', value: 'reaction' },
  { label: '特写', value: 'insert' }
]

/**
 * 自动片段（预备镜头 / 尾帧切镜 / 黑屏）不在可选项里 —— 但万一它出现在这个列表，
 * 下拉得能显示它自己的名字，不然 select 会渲染成空白。
 */
const kindOptions = computed(() => {
  if (KINDS.some((k) => k.value === props.beat.kind)) return KINDS
  return [
    { label: BEAT_KIND_LABEL[props.beat.kind] ?? props.beat.kind, value: props.beat.kind },
    ...KINDS
  ]
})

/* --------------------------- 文本草稿与提交 --------------------------- */

const dTitle = ref(props.beat.title ?? '')
const dDialogue = ref(props.beat.dialogue ?? '')
let dirty = false
let timer: ReturnType<typeof setTimeout> | null = null

function sync() {
  dTitle.value = props.beat.title ?? ''
  dDialogue.value = props.beat.dialogue ?? ''
  dirty = false
}

watch(() => props.beat.id, sync)

// 外部改动（AI 重填 / 别处修改）时同步过来；自己提交的回声值相同，不会打架
watch(
  () => props.beat.title,
  (v) => {
    if (!dirty) dTitle.value = v ?? ''
  }
)
watch(
  () => props.beat.dialogue,
  (v) => {
    if (!dirty) dDialogue.value = v ?? ''
  }
)

function flush() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!dirty) return
  dirty = false
  const p: Partial<Beat> = {}
  if (dTitle.value !== (props.beat.title ?? '')) p.title = dTitle.value
  if (dDialogue.value !== (props.beat.dialogue ?? '')) p.dialogue = dDialogue.value
  if (Object.keys(p).length) emit('patch', props.beat.id, p)
}

function touch() {
  dirty = true
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, 600)
}

onBeforeUnmount(flush)

/* ------------------------------- 写入 ------------------------------- */

/** naive-ui 的多选 / 单选清空会 emit null，这里统一收敛 */
function patch(p: Partial<Beat>) {
  const next: Partial<Beat> = { ...p }
  if ('entities' in next) next.entities = Array.isArray(next.entities) ? next.entities : []
  if ('speakerId' in next && !next.speakerId) next.speakerId = undefined
  if ('sceneId' in next && !next.sceneId) next.sceneId = undefined
  if ('kind' in next && next.kind !== 'dialogue') next.speakerId = undefined
  emit('patch', props.beat.id, next)
}

/** 改帧数 = 打上手动标记；清空则退回自动推算 */
function setFrames(v: number | null) {
  if (v == null || !Number.isFinite(v)) {
    resetFrames()
    return
  }
  patch({ estFrames: Math.max(1, Math.round(v)), manualFrames: true })
}

function nudge(delta: number) {
  setFrames(Math.max(1, frames.value + delta))
}

function resetFrames() {
  patch({ estFrames: undefined, manualFrames: false })
}

/* ------------------------------ 菜单 ------------------------------ */

const moreOptions = [
  { label: '打开完整详情', key: 'edit' },
  { type: 'divider', key: 'd0' },
  { label: '拆分为多个片段', key: 'split' },
  { label: 'AI 拆细这一拍', key: 'aiSplit' },
  { label: '与相邻片段合并', key: 'merge' },
  { type: 'divider', key: 'd1' },
  { label: '删除片段', key: 'remove' }
]

function onMore(key: string) {
  if (key === 'edit') emit('edit', props.beat.id)
  else if (key === 'split') emit('split', props.beat.id)
  else if (key === 'aiSplit') emit('aiSplit', props.beat.id)
  else if (key === 'merge') emit('merge', props.beat.id)
  else if (key === 'remove') emit('remove', props.beat.id)
}

/* ------------------------------ 拖拽 ------------------------------ */

function onDragStart(e: DragEvent) {
  if (!props.draggable) return
  // 从输入框里起拖会把文字拖走，这里只认卡片空白处
  const t = e.target as HTMLElement
  if (t.closest('input, textarea, .n-select, .n-base-selection')) {
    e.preventDefault()
    return
  }
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
  <article
    :id="'sp-b-' + beat.id"
    class="sp-card"
    :class="{
      'is-invalid': !!issue,
      'is-dragging': dragging,
      'drop-before': dropSide === 'before',
      'drop-after': dropSide === 'after',
      'is-selected': !!selected,
      'is-auto': isAuto
    }"
    :style="{ '--sp-kind': kindColor }"
    :draggable="draggable"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <!-- 头：序号 / 类型 / 拆片徽章 / 状态 / 菜单 -->
    <header class="sp-head">
      <n-checkbox
        v-if="selectable"
        size="small"
        :checked="!!selected"
        @update:checked="() => emit('select', beat.id)"
        @click.stop
      />
      <span class="sp-grip" :style="{ opacity: draggable ? 1 : 0.25 }" title="拖动调整顺序">⠿</span>
      <span class="sp-idx mono">{{ String(index + 1).padStart(2, '0') }}</span>
      <n-select
        size="tiny"
        class="sp-kind"
        :value="beat.kind"
        :options="kindOptions"
        :style="{ '--k': kindColor }"
        @update:value="(v: string) => patch({ kind: v as BeatKind })"
      />
      <n-tag
        v-if="splitPiece"
        size="tiny"
        type="warning"
        :bordered="false"
        :title="`原片段过长，被迫拆成 ${splitPiece.total} 段，这是第 ${splitPiece.index} 段`"
      >
        拆 {{ splitPiece.index }}/{{ splitPiece.total }}
      </n-tag>
      <span v-if="isAuto" class="sp-auto-tag" title="引擎自动生成的拼接片段">自动</span>
      <span style="flex: 1" />
      <span v-if="issue" class="sp-issue" :title="issue">{{ issue }}</span>
      <n-dropdown :options="moreOptions" trigger="click" @select="onMore" @click.stop>
        <n-button size="tiny" quaternary @click.stop>⋯</n-button>
      </n-dropdown>
    </header>

    <!-- 标题：直接可改 -->
    <n-input
      size="small"
      class="sp-title-input"
      :value="dTitle"
      placeholder="一句话说明这个镜头做什么"
      @update:value="(v: string) => { dTitle = v; touch() }"
      @blur="flush"
      @keydown.enter="(e: KeyboardEvent) => { if (!e.isComposing) flush() }"
    />

    <!-- 台词：直接可改，下面实时算字数 → 帧数 -->
    <div v-if="beat.kind === 'dialogue'" class="sp-dialogue">
      <n-input
        type="textarea"
        size="small"
        :value="dDialogue"
        :autosize="{ minRows: 1, maxRows: 4 }"
        placeholder="纯台词，不写角色名、不加格式标记"
        :input-props="{ style: 'font-size:12.5px;line-height:1.6' }"
        @update:value="(v: string) => { dDialogue = v; touch() }"
        @blur="flush"
      />
      <span class="sp-dlg-hint" :title="`按 ${settings.fps}fps 与每秒字数推算`">
        汉字 {{ hanziCount }} 字 → 自动 {{ autoFrames }} 帧
      </span>
    </div>

    <!-- 场景 / 主体 / 说话人：常用绑定全部摆在外面 -->
    <div class="sp-grid" :class="beat.kind === 'dialogue' ? 'n3' : 'n2'">
      <div class="sp-f">
        <span class="sp-lb">
          场景<i v-if="!beat.sceneId" class="sp-need">必填</i>
        </span>
        <n-select
          size="small"
          :value="beat.sceneId ?? null"
          :options="sceneOptions"
          placeholder="这个镜头发生在哪"
          :status="beat.sceneId ? undefined : 'warning'"
          filterable
          @update:value="(v: string | null) => patch({ sceneId: v ?? undefined })"
        />
      </div>

      <div v-if="beat.kind === 'dialogue'" class="sp-f">
        <span class="sp-lb">
          说话人<i v-if="!beat.speakerId" class="sp-need">必填</i>
        </span>
        <n-select
          size="small"
          :value="beat.speakerId ?? null"
          :options="speakerOptions"
          placeholder="谁说的"
          :status="beat.speakerId ? undefined : 'warning'"
          filterable
          @update:value="(v: string | null) => patch({ speakerId: v ?? undefined })"
        />
      </div>

      <div class="sp-f">
        <span class="sp-lb">主体</span>
        <n-select
          size="small"
          multiple
          :value="beat.entities ?? []"
          :options="entityOptions"
          placeholder="角色 / 道具，纯场景镜可留空"
          :max-tag-count="2"
          filterable
          @update:value="(v: string[] | null) => patch({ entities: v ?? [] })"
        />
      </div>
    </div>

    <!-- 参考图：主体自带，选了主体就自动带上；这里只确认"带的是哪张" -->
    <div v-if="refPics && refPics.length" class="sp-refbar">
      <span class="sp-lb">参考图</span>
      <span
        v-for="r in refPics"
        :key="r.id"
        class="sp-ref"
        :title="`${r.name} · P${r.pic} · 跟着主体走，换图会影响所有用到他的段`"
      >
        <img v-if="r.url" :src="r.url" alt="" />
        <span v-else class="sp-ref-none" />
        <b class="mono">P{{ r.pic }}</b>
      </span>
      <span class="sp-ref-hint">自动跟随主体</span>
    </div>

    <!-- 脚：帧数（可直接改 / −＋微调）+ 时长 + 拆分提示 -->
    <footer class="sp-foot">
      <span class="sp-lb" style="flex: none">帧数</span>
      <!-- 减 / 数字 / 加 包在一个框里，读起来是一个调节器，不会看成"34 + 1.42s" -->
      <span class="sp-step">
        <button type="button" class="sp-nudge" title="减 1 帧" @click="nudge(-1)">−</button>
        <n-input-number
          size="tiny"
          class="sp-frames"
          :value="frames"
          :min="1"
          :max="2000"
          :show-button="false"
          :bordered="false"
          @update:value="setFrames"
        />
        <button type="button" class="sp-nudge" title="加 1 帧" @click="nudge(1)">+</button>
      </span>
      <span class="sp-dur mono" :title="`${frames} 帧 @ ${settings.fps}fps`">
        {{ seconds.toFixed(2) }}s
      </span>
      <button
        v-if="beat.manualFrames"
        class="sp-mode is-manual"
        title="当前是手动帧数，点一下回到按类型 / 台词自动推算"
        @click="resetFrames"
      >
        ↺ 自动
      </button>
      <span v-else class="sp-mode" title="帧数按类型与台词字数自动推算，直接填数字会转为手动">
        自动
      </span>
      <span style="flex: 1" />
      <n-tag
        v-if="splitHint && splitHint > 1"
        size="tiny"
        type="warning"
        :bordered="false"
        style="cursor: pointer"
        title="按这份长度建议拆成几段"
        @click="emit('split', beat.id)"
      >
        拆 {{ splitHint }}
      </n-tag>
      <n-button size="tiny" quaternary @click="emit('edit', beat.id)">全部字段</n-button>
    </footer>
  </article>
</template>

<style scoped>
.sp-card {
  padding: 8px 11px 9px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-left: 3px solid var(--sp-kind, var(--line));
  border-radius: 10px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* 卡片自己判断有多宽：分栏后窗口宽度完全不代表卡片宽度 */
  container-type: inline-size;
}
.sp-card.is-auto {
  background: var(--panel-2);
}
.sp-card.is-invalid {
  border-color: var(--err-line);
}
.sp-card.is-selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.sp-card.is-dragging {
  opacity: 0.5;
}

/* 插入位置：网格里用左右竖线 */
.sp-card.drop-before::before,
.sp-card.drop-after::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--accent);
  border-radius: 2px;
}
.sp-card.drop-before {
  position: relative;
}
.sp-card.drop-after {
  position: relative;
}
.sp-card.drop-before::before {
  left: -6px;
}
.sp-card.drop-after::after {
  right: -6px;
}

.sp-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.sp-grip {
  color: var(--muted);
  cursor: grab;
  font-size: 12px;
  line-height: 1;
}
.sp-idx {
  color: var(--muted);
  font-size: 11.5px;
  min-width: 18px;
}
.sp-kind {
  width: 78px;
  flex: none;
}
/* 类型下拉染上本类型的颜色，一眼能认出是台词还是动作 */
.sp-kind :deep(.n-base-selection) {
  --n-border: 1px solid transparent;
  background: color-mix(in srgb, var(--k) 12%, transparent);
}
.sp-kind :deep(.n-base-selection-label) {
  color: var(--k);
  font-weight: 500;
}
.sp-auto-tag {
  flex: none;
  font-size: 10.5px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--panel-3);
  color: var(--label);
}
.sp-issue {
  flex: none;
  font-size: 10.5px;
  line-height: 16px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--err-soft);
  color: var(--err-ink);
  white-space: nowrap;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sp-title-input :deep(.n-input__input-el) {
  font-weight: 600;
  font-size: 13px;
}
/* 标题输入框不要边框，看起来还是标题而不是表单 */
.sp-title-input {
  --n-border: 1px solid transparent;
  --n-border-hover: 1px solid var(--line);
  --n-border-focus: 1px solid var(--accent);
  height: 26px;
}

.sp-dialogue {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.sp-dlg-hint {
  font-size: 10.5px;
  color: var(--muted);
  align-self: flex-end;
}

.sp-grid {
  display: grid;
  gap: 6px 9px;
}
.sp-grid.n3 {
  /* 顺序是 场景 / 说话人 / 主体：主体排最后并给最宽 —— 窄卡折两列时它正好独占一行 */
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 0.8fr) minmax(0, 1.3fr);
}
.sp-grid.n2 {
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
}
.sp-f {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.sp-lb {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--muted);
  line-height: 16px;
  white-space: nowrap;
}
.sp-need {
  font-style: normal;
  font-size: 10px;
  padding: 0 5px;
  color: var(--err-ink);
  background: var(--err-soft);
  border-radius: 3px;
}

/* ---- 参考图（主体自带）---- */
.sp-refbar {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  padding-top: 1px;
}
.sp-ref {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 4px 1px 2px;
  border-radius: 5px;
  background: var(--panel-2);
  box-shadow: inset 0 0 0 1px var(--line);
  font-size: 10.5px;
  color: var(--muted);
  cursor: default;
}
.sp-ref img,
.sp-ref-none {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  object-fit: cover;
  display: block;
  background: var(--hover);
}
.sp-ref-none {
  border: 1px dashed var(--warn);
  background: transparent;
}
.sp-ref b {
  font-weight: 500;
  font-size: 10px;
  color: var(--muted-2);
}
.sp-ref-hint {
  font-size: 10.5px;
  color: var(--line-strong);
}

.sp-foot {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 2px;
  padding-top: 7px;
  border-top: 1px dashed var(--line);
}
.sp-step {
  display: inline-flex;
  align-items: center;
  height: 24px;
  flex: none;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  overflow: hidden;
}
.sp-nudge {
  width: 20px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.sp-nudge:hover {
  background: var(--panel-3);
  color: var(--text);
}
.sp-frames {
  width: 50px;
  flex: none;
}
.sp-frames :deep(.n-input__input-el) {
  text-align: center;
  font-family: var(--mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.sp-dur {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}
.sp-mode {
  font-size: 10.5px;
  line-height: 17px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--panel-3);
  color: var(--muted-2);
  border: none;
  white-space: nowrap;
}
.sp-mode.is-manual {
  background: var(--warn-soft);
  color: var(--warn-ink);
  cursor: pointer;
}

/* ---------------------------- 窄卡降列 ---------------------------- */

/*
 * 三列排布时卡片约 570，三栏各约 175 还能读；再窄就得收，
 * 不然「主体」多选只露一个标签、下拉里全是省略号。
 * 容器查询统一放末尾：与基础规则同权重，靠顺序取胜。
 */
@container (max-width: 470px) {
  .sp-grid.n3 {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .sp-grid.n3 > .sp-f:nth-child(3) {
    grid-column: 1 / -1;
  }
}
@container (max-width: 330px) {
  .sp-grid.n3,
  .sp-grid.n2 {
    grid-template-columns: minmax(0, 1fr);
  }
  .sp-grid.n3 > .sp-f:nth-child(3) {
    grid-column: auto;
  }
}
</style>
