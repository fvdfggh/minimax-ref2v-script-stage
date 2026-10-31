<script setup lang="ts">
/**
 * 单个参数的控件。
 *
 * 只做一件事：按 ParamSpec.kind 选控件并回传值。
 * 所有业务语义（联动显隐、单位换算、目标尺寸预估）都不在这里，
 * 放在各自的节点面板里 —— 否则这个组件会变成第二个 schema。
 */
import { computed } from 'vue'
import { NInput, NSelect, NSwitch, NInputNumber } from 'naive-ui'
import type { ParamSpec, ParamValue } from '@/domain/workflow'

const props = defineProps<{
  spec: ParamSpec
  value: ParamValue
  disabled?: boolean
  /** 本机扫描出来的候选（模型文件名等）。没有就沿用 spec.options。 */
  candidates?: string[]
}>()

const emit = defineEmits<{ 'update:value': [ParamValue] }>()

/**
 * 下拉候选 = 规格自带 ∪ 本机扫描。
 *
 * 为什么必须合一份：API format 里 Combo 参数只存了**当前值**，导入后下拉里
 * 就那一项，看着像"锁死了不能选"。本机扫出来的文件才是真正能选的清单。
 * 当前值一定要保留在列表里（哪怕磁盘上已经没这个文件），否则控件会显示空白。
 */
const options = computed(() => {
  const merged: string[] = []
  const cur = props.value === null || props.value === undefined ? '' : String(props.value)
  if (cur) merged.push(cur)
  for (const o of props.candidates ?? []) if (!merged.includes(o)) merged.push(o)
  for (const o of props.spec.options ?? []) if (!merged.includes(o)) merged.push(o)
  return merged.map((o) => ({ label: o, value: o }))
})

/** 有候选就走下拉，没有才退回自由输入 —— 下拉选空值会丢掉原值 */
const asSelect = computed(() => props.spec.kind === 'enum' && options.value.length > 0)

function set(v: ParamValue | null) {
  if (v === null || v === undefined) return
  emit('update:value', v)
}
</script>

<template>
  <div class="pf">
    <div class="pf-label">
      <span>{{ spec.label }}</span>
      <span v-if="spec.hint" class="pf-hint" :title="spec.hint">?</span>
    </div>

    <div class="pf-control">
      <n-select
        v-if="asSelect"
        size="small"
        :value="String(value)"
        :options="options"
        :disabled="disabled"
        filterable
        @update:value="(v: string) => set(v)"
      />

      <n-switch
        v-else-if="spec.kind === 'bool'"
        size="small"
        :value="Boolean(value)"
        :disabled="disabled"
        @update:value="(v: boolean) => set(v)"
      />

      <n-input-number
        v-else-if="spec.kind === 'int' || spec.kind === 'float'"
        size="small"
        :value="Number(value)"
        :min="spec.min"
        :max="spec.max"
        :step="spec.step ?? (spec.kind === 'int' ? 1 : 0.01)"
        :precision="spec.kind === 'int' ? 0 : undefined"
        :disabled="disabled"
        style="width: 100%"
        @update:value="(v: number | null) => set(v)"
      />

      <n-input
        v-else
        size="small"
        :value="String(value)"
        :disabled="disabled"
        @update:value="(v: string) => set(v)"
      />
    </div>

    <div v-if="spec.hint" class="pf-note">{{ spec.hint }}</div>
  </div>
</template>

<style scoped>
.pf {
  display: grid;
  grid-template-columns: 132px 1fr;
  gap: 4px 10px;
  align-items: center;
  padding: 6px 0;
}
.pf-label {
  font-size: 13px;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 5px;
}
.pf-hint {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--hover);
  color: var(--muted-2);
  font-size: 10px;
  cursor: help;
  flex: 0 0 auto;
}
.pf-control {
  min-width: 0;
}
.pf-note {
  grid-column: 2;
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.5;
  margin-top: -2px;
}
</style>
