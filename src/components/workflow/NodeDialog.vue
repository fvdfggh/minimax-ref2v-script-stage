<script setup lang="ts">
/**
 * 通用节点参数弹窗。
 *
 * 除了放大节点（它有专用面板、且在控制台里内联展开），其余节点都从这张弹窗
 * 里改。参数清单来自导入的 API 工作流，所以这里不需要知道任何具体节点的
 * 参数名 —— 换工作流、加节点都不用改这个文件。
 */
import { computed } from 'vue'
import { NAlert, NButton, NModal } from 'naive-ui'
import ParamField from './ParamField.vue'
import { GROUP_LABELS } from '@/domain/workflow'
import { useLocalStore } from '@/stores/local'
import type { NodeSpec, ParamValue } from '@/domain/workflow'
import InfoTip from '@/components/common/InfoTip.vue'

const props = defineProps<{
  show: boolean
  node: NodeSpec | null
  values: Record<string, ParamValue>
}>()

const emit = defineEmits<{
  'update:show': [boolean]
  change: [nodeKey: string, param: string, value: ParamValue]
  reset: [nodeKey: string]
}>()

const local = useLocalStore()

const current = computed(() =>
  props.node
    ? Object.fromEntries(
        props.node.params.map((p) => [p.key, props.values[`${props.node!.key}.${p.key}`] ?? p.default])
      )
    : {}
)

function onUpdate(param: string, value: ParamValue) {
  if (!props.node) return
  emit('change', props.node.key, param, value)
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="node?.title ?? ''"
    style="max-width: 720px"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <template v-if="node">
      <div class="row" style="gap: 8px; margin-bottom: 10px">
        <span class="tag-chip">{{ GROUP_LABELS[node.group] }}</span>
        <span class="tag-chip" style="font-family: var(--mono)">{{ node.type }}</span>
        <span v-if="!node.present" class="tag-chip" style="background: var(--warn-soft); color: var(--warn)">
          不在当前工作流里
        </span>
      </div>

      <n-alert v-if="!node.present" type="warning" :show-icon="false" style="margin-bottom: 12px">
        这个节点不在已导入的 API 工作流里
        <InfoTip :width="280" text="下面的值会保存，但不会生效。" />
      </n-alert>

      <div v-if="!node.params.length" class="empty" style="padding: 24px 0">
        这个节点没有可配参数（输入全是连线）。
      </div>

      <div v-else class="dialog-body">
        <ParamField
          v-for="spec in node.params"
          :key="spec.key"
          :spec="spec"
          :value="current[spec.key] as ParamValue"
          :candidates="local.candidatesFor(spec.key)"
          @update:value="(v: ParamValue) => onUpdate(spec.key, v)"
        />
      </div>

      <div class="row" style="justify-content: space-between; margin-top: 14px">
        <span class="muted" style="font-size: 12px">
          {{ node.params.length }} 个参数 · 改完立即写入当前模板
          <template v-if="!local.ready"> · 未扫描本机模型（下拉只能选当前值）</template>
        </span>
        <n-button size="small" quaternary @click="emit('reset', node.key)">恢复默认</n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.dialog-body {
  max-height: 58vh;
  overflow-y: auto;
  padding-right: 6px;
}
</style>
