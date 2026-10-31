<script setup lang="ts">
/**
 * 「让 AI 写」的统一入口。
 *
 * 全站有二十来处需要模型补一句话的地方（一拍的镜头 / 画面、一段的某个字段、
 * 一个角色的长相 / 服装 / 音色）。它们的交互是同一件事：
 *
 *   点一下 → 看一眼这是写什么 →（可选）补一句要求 → 生成 → 落在原地
 *
 * 所以只做这一个组件，别每处再手写一颗按钮 + 一个弹窗。差别只在文案和预设。
 *
 * 为什么要点开才能用，而不是点一下直接跑：
 *   直接跑的话，用户想改"更暗一点""别写动作"就无处可说，只能生成完再手改；
 *   而模型最擅长的恰恰是"按一句要求重来"。这颗按钮的价值一半在这个输入框里。
 *
 * 这里**不发请求**：谁用谁把 `run` 接上。组件只管收要求、管自己的开合，
 * busy 由调用方传进来（同一页可能有好几颗同时在跑，不能共用一个状态）。
 */
import { computed, ref } from 'vue'
import { NButton, NInput, NPopover } from 'naive-ui'

const props = withDefaults(
  defineProps<{
    /** 这一颗是写什么的：「镜头描述」 */
    title: string
    /** 一句话说明输出会长什么样（给用户判断要不要点） */
    hint?: string
    /** 常用要求，一键填进输入框 */
    presets?: string[]
    /** 正在跑：按钮转圈并禁用 */
    busy?: boolean
    /** 跑不了（没配模型 / 字段是引擎派生的） */
    disabled?: boolean
    /** 跑不了的原因，直接当 title 用 */
    disabledReason?: string
    /** icon = 只有一颗 ✨（塞进输入框后缀）；chip = 带文字的小胶囊（放在标题行） */
    variant?: 'icon' | 'chip'
    /** chip 变体的按钮文字 */
    label?: string
    placement?: 'top' | 'bottom' | 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end'
  }>(),
  { variant: 'icon', placement: 'bottom-end', busy: false, disabled: false }
)

const emit = defineEmits<{ run: [brief: string] }>()

const show = ref(false)
const brief = ref('')
const inputEl = ref<InstanceType<typeof NInput> | null>(null)

const canRun = computed(() => !props.busy && !props.disabled)

function toggle() {
  if (props.busy || props.disabled) return
  show.value = !show.value
  if (show.value) {
    // 点开就聚焦：多数时候用户是带着一句要求来的
    requestAnimationFrame(() => inputEl.value?.focus())
  }
}

function submit() {
  if (!canRun.value) return
  show.value = false
  emit('run', brief.value.trim())
  brief.value = ''
}

function preset(text: string) {
  brief.value = text
  requestAnimationFrame(() => inputEl.value?.focus())
}
</script>

<template>
  <n-popover
    v-model:show="show"
    trigger="manual"
    :placement="props.placement"
    :show-arrow="false"
    raw
    @clickoutside="show = false"
  >
    <template #trigger>
      <button
        type="button"
        class="aiw"
        :class="[`is-${props.variant}`, { 'is-busy': props.busy, 'is-off': props.disabled }]"
        :title="props.disabled ? (props.disabledReason ?? '现在用不了') : `${props.title}：让 AI 写`"
        :aria-label="`${props.title}：让 AI 写`"
        :disabled="props.disabled"
        @click.stop="toggle"
      >
        <span v-if="props.busy" class="aiw-spin" aria-hidden="true" />
        <svg v-else class="aiw-ico" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M8 1.7l1.25 3.4 3.4 1.25-3.4 1.25L8 11l-1.25-3.4L3.35 6.35l3.4-1.25L8 1.7Z"
            fill="currentColor"
          />
          <path d="M12.3 10.2l.62 1.66 1.66.62-1.66.62-.62 1.66-.62-1.66-1.66-.62 1.66-.62.62-1.66Z" fill="currentColor" opacity=".75" />
        </svg>
        <span v-if="props.variant === 'chip'" class="aiw-lb">{{ props.label ?? 'AI 写' }}</span>
      </button>
    </template>

    <div class="aiw-pop" :style="{ width: '288px' }">
      <div class="aiw-ttl">{{ props.title }}</div>
      <div v-if="props.hint" class="aiw-hint">{{ props.hint }}</div>

      <div v-if="props.presets?.length" class="aiw-presets">
        <button v-for="p in props.presets" :key="p" type="button" class="aiw-preset" @click="preset(p)">
          {{ p }}
        </button>
      </div>

      <n-input
        ref="inputEl"
        v-model:value="brief"
        type="textarea"
        size="small"
        :autosize="{ minRows: 2, maxRows: 4 }"
        placeholder="补一句要求（可留空）：只写这一项，别动别的"
        @keydown.enter.exact.prevent="submit"
      />

      <div class="aiw-foot">
        <span class="aiw-kbd">Enter 生成</span>
        <span style="flex: 1" />
        <n-button size="tiny" quaternary @click="show = false">取消</n-button>
        <n-button size="tiny" type="primary" :disabled="!canRun" @click="submit">生成</n-button>
      </div>
    </div>
  </n-popover>
</template>

<style scoped>
.aiw {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid transparent;
  background: transparent;
  /* 默认就用强调色：塞在输入框右端时，灰色的小图标看起来像装饰，不像能点 */
  color: var(--accent-ink);
  opacity: 0.72;
  cursor: pointer;
  user-select: none;
  padding: 0;
}
.aiw:hover {
  color: var(--accent);
  opacity: 1;
}
.aiw.is-off {
  opacity: 0.45;
  cursor: not-allowed;
}
.aiw.is-icon {
  width: 20px;
  height: 20px;
  border-radius: 5px;
}
.aiw.is-icon:hover {
  background: var(--accent-soft);
}
.aiw.is-busy {
  opacity: 1;
}
.aiw.is-chip {
  opacity: 1;
  height: 22px;
  padding: 0 8px 0 6px;
  border-radius: var(--r-pill);
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 11.5px;
  font-weight: 500;
}
.aiw.is-chip:hover {
  border-color: var(--accent-line);
  color: var(--accent);
}
.aiw-ico {
  width: 13px;
  height: 13px;
  flex: none;
}
.aiw-lb {
  line-height: 1;
}
.aiw-spin {
  width: 11px;
  height: 11px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: aiw-rot 0.7s linear infinite;
}
@keyframes aiw-rot {
  to {
    transform: rotate(360deg);
  }
}

.aiw-pop {
  /* popover 用了 raw（不要它自带的内边距 / 字号），底色和边框就得自己给：
     不给的话面板是透明的，底下的卡片会透上来，字叠在一起没法读。 */
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  background: var(--panel);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgb(15 23 42 / 14%);
}
.aiw-ttl {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}
.aiw-hint {
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--muted);
  margin-top: -3px;
}
.aiw-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.aiw-preset {
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  background: var(--panel-2);
  color: var(--muted);
  font-size: 11px;
  line-height: 17px;
  cursor: pointer;
}
.aiw-preset:hover {
  border-color: var(--accent-line);
  color: var(--accent-ink);
  background: var(--accent-soft);
}
.aiw-foot {
  display: flex;
  align-items: center;
  gap: 6px;
}
.aiw-kbd {
  font-size: 10.5px;
  color: var(--muted-3, var(--muted));
}
</style>
