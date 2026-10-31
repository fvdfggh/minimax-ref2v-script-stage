<script setup lang="ts">
/**
 * 全部参数浏览器 —— 不依赖"有没有导入 API 工作流"。
 *
 * 参数来自两条路的合集：ComfyUI 的 /object_info（权威）和节点包源码静态扫描
 * （ComfyUI 没起时的兜底）。配好的值按 `class_type#0.参数名` 写进当前模板，
 * 和"导入工作流后生成的节点"用的是同一套键 —— 所以先在这里配、之后再导入
 * 工作流，参数一样能命中，不需要迁移。
 *
 * 一个必须说清的边界：**这里配的是"图里出现这个节点时用什么值"**。
 * 工作流里没有的节点，配了也不生效（applyTemplateToApi 会报 skipped）。
 * 所以列表里会标出哪些类型真的在当前工作流里。
 */
import { computed, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NEmpty,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSwitch,
  NTag
} from 'naive-ui'
import { useSchemaStore } from '@/stores/schema'
import { useWorkflowStore } from '@/stores/workflow'
import { useLocalStore } from '@/stores/local'
import { GROUP_LABELS, GROUP_ORDER } from '@/domain/workflow'
import { DEFAULT_COMFY_URL } from '@/domain/run'
import type { NodeGroup, ParamValue } from '@/domain/workflow'
import type { NodeSchema } from '@/domain/schema'
import InfoTip from '@/components/common/InfoTip.vue'

const schema = useSchemaStore()
const workflow = useWorkflowStore()
const local = useLocalStore()

const keyword = ref('')
const onlyInGraph = ref(false)
const baseInput = ref(DEFAULT_COMFY_URL)
const openType = ref<NodeSchema | null>(null)

/** 当前工作流里真实存在的 class_type —— 用来标"配了才生效" */
const typesInGraph = computed(() => {
  const t = workflow.active?.api
  if (!t) return new Set<string>()
  return new Set(Object.values(t).map((n) => String(n?.class_type ?? '')))
})

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return schema.all.filter((n) => {
    if (onlyInGraph.value && !typesInGraph.value.has(n.type)) return false
    if (!kw) return true
    return (
      n.type.toLowerCase().includes(kw) ||
      n.display.toLowerCase().includes(kw) ||
      n.category.toLowerCase().includes(kw) ||
      n.params.some((p) => p.key.toLowerCase().includes(kw))
    )
  })
})

const grouped = computed(() => {
  const map = new Map<NodeGroup, NodeSchema[]>()
  for (const n of filtered.value) {
    const list = map.get(n.group) ?? []
    list.push(n)
    map.set(n.group, list)
  }
  // 固定按 GROUP_ORDER 排，不按数量排 —— 数量排序会让"其他"那 354 个顶到最前，
  // 用户每次进来第一个看到的都是杂物。
  return [...map.entries()]
    .map(([group, nodes]) => ({ group, label: GROUP_LABELS[group] ?? group, nodes }))
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
})

/** 某类型已经配过几个参数 —— 卡片上要显示，否则不知道自己改过什么 */
function editedCount(type: string): number {
  const values = workflow.active?.values ?? {}
  return Object.keys(values).filter((k) => k.startsWith(`${type}#`)).length
}

function valueOf(node: NodeSchema, param: string): ParamValue {
  const key = `${node.type}#0.${param}`
  const spec = node.params.find((p) => p.key === param)
  const v = workflow.active?.values?.[key]
  return (v ?? spec?.default ?? '') as ParamValue
}

function setValue(node: NodeSchema, param: string, value: ParamValue) {
  workflow.setParam(`${node.type}#0`, param, value)
}

function resetType(node: NodeSchema) {
  for (const p of node.params) setValue(node, p.key, p.default)
}

async function refresh() {
  await schema.refresh(baseInput.value)
}

async function scanSource() {
  await schema.scanOffline(local.root)
}

watch(openType!, (n) => {
  if (n) {
    // 弹窗打开时若本机扫过模型，候选已在 local 里，无需额外动作
  }
})
</script>

<template>
  <div>
    <div class="row-between" style="margin-bottom: 10px">
      <div class="row" style="gap: 8px">
        <n-input
          v-model:value="keyword"
          size="small"
          placeholder="搜节点类型 / 分类 / 参数名"
          style="width: 280px"
          clearable
        />
        <n-switch v-model:value="onlyInGraph" size="small" />
        <span class="muted" style="font-size: 12.5px">只看当前工作流有的</span>
        <span class="muted" style="font-size: 12px">
          共 {{ filtered.length }} 个类型
        </span>
      </div>
      <div class="row" style="gap: 6px">
        <n-button size="small" quaternary :loading="schema.loading" @click="scanSource">
          扫源码
        </n-button>
        <n-input
          v-model:value="baseInput"
          size="small"
          placeholder="http://127.0.0.1:8188"
          style="width: 190px"
        />
        <n-button size="small" type="primary" :loading="schema.loading" @click="refresh">
          拉全量参数
        </n-button>
      </div>
    </div>

    <n-alert v-if="schema.error" type="warning" :show-icon="false" style="margin-bottom: 10px">
      {{ schema.error }}
    </n-alert>

    <div v-if="schema.source === 'source'" class="muted" style="font-size: 12px; margin-bottom: 10px">
      源码静态扫描（ComfyUI 没连上）
      <InfoTip
        :width="380"
        text="动态构造的 INPUT_TYPES 抽不全，参数可能少于实际节点 —— 起 ComfyUI 后点「拉全量参数」拿到权威清单。"
      />
    </div>
    <n-alert v-else-if="schema.hasOnline" type="success" :show-icon="false" style="margin-bottom: 10px">
      已拿到 ComfyUI 全量参数（{{ schema.online.length }} 个类型，来自 {{ schema.onlineBase }}）。
    </n-alert>

    <n-empty v-if="!filtered.length" description="还没有参数定义，先点「拉全量参数」或「扫源码」" />

    <div v-for="g in grouped" :key="g.group" class="sg-group">
      <div class="sg-head">
        <span>{{ g.label }}</span>
        <span class="muted" style="font-size: 11.5px">{{ g.nodes.length }}</span>
      </div>
      <div class="sg-grid">
        <div
          v-for="n in g.nodes"
          :key="n.type"
          class="sg-card"
          :class="{ ingraph: typesInGraph.has(n.type) }"
          @click="openType = n"
        >
          <div class="sg-title">{{ n.display || n.type }}</div>
          <div class="sg-type">{{ n.type }}</div>
          <div class="sg-foot">
            <span>{{ n.params.length }} 参数</span>
            <span v-if="editedCount(n.type)" class="sg-edited">已改 {{ editedCount(n.type) }}</span>
            <n-tag v-if="typesInGraph.has(n.type)" size="tiny" type="success">图中有</n-tag>
          </div>
        </div>
      </div>
    </div>

    <n-modal
      :show="openType !== null"
      preset="card"
      :title="openType?.display || openType?.type || ''"
      style="max-width: 760px"
      @update:show="(v: boolean) => { if (!v) openType = null }"
    >
      <template v-if="openType">
        <div class="row" style="gap: 8px; margin-bottom: 10px">
          <span class="tag-chip" style="font-family: var(--mono)">{{ openType.type }}</span>
          <span class="tag-chip">{{ openType.category || '未分类' }}</span>
          <n-tag size="small" :type="openType.source === 'object_info' ? 'success' : 'warning'">
            {{ openType.source === 'object_info' ? 'ComfyUI 权威定义' : '源码静态解析' }}
          </n-tag>
        </div>

        <n-alert
          v-if="!typesInGraph.has(openType.type)"
          type="warning"
          :show-icon="false"
          style="margin-bottom: 12px"
        >
          当前工作流里没有这个节点
          <InfoTip :width="300" text="值会存下来，等导入含它的工作流后自动生效。" />
        </n-alert>

        <div class="sb-body">
          <div v-for="p in openType.params" :key="p.key" class="sb-row">
            <div class="sb-label">
              <span>{{ p.key }}</span>
              <span v-if="p.hint" class="sb-hint" :title="p.hint">?</span>
            </div>
            <div class="sb-control">
              <n-select
                v-if="p.kind === 'enum'"
                size="small"
                :value="String(valueOf(openType!, p.key))"
                :options="[...new Set([String(valueOf(openType!, p.key)), ...(p.options ?? []), ...local.candidatesFor(p.key)])].map((o) => ({ label: o, value: o }))"
                filterable
                @update:value="(v: string) => setValue(openType!, p.key, v)"
              />
              <n-switch
                v-else-if="p.kind === 'bool'"
                size="small"
                :value="Boolean(valueOf(openType!, p.key))"
                @update:value="(v: boolean) => setValue(openType!, p.key, v)"
              />
              <n-input-number
                v-else-if="p.kind === 'int' || p.kind === 'float'"
                size="small"
                :value="Number(valueOf(openType!, p.key))"
                :min="p.min"
                :max="p.max"
                :step="p.step ?? (p.kind === 'int' ? 1 : 0.01)"
                style="width: 100%"
                @update:value="(v: number | null) => setValue(openType!, p.key, v ?? 0)"
              />
              <n-input
                v-else
                size="small"
                :value="String(valueOf(openType!, p.key))"
                @update:value="(v: string) => setValue(openType!, p.key, v)"
              />
            </div>
            <div v-if="p.hint" class="sb-note">{{ p.hint }}</div>
          </div>
        </div>

        <div class="row" style="justify-content: space-between; margin-top: 14px">
          <span class="muted" style="font-size: 12px">
            {{ openType.params.length }} 个参数 · 写入 {{ openType.type }}#0.* · 立即存入当前模板
          </span>
          <n-button size="small" quaternary @click="resetType(openType)">全部恢复默认</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.sg-group {
  margin-top: 16px;
}
.sg-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--muted);
  margin-bottom: 8px;
  padding-left: 2px;
}
.sg-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 10px;
}
.sg-card {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
  padding: 10px 12px;
  cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.12s;
}
.sg-card:hover {
  border-color: var(--line-strong);
  box-shadow: var(--shadow);
}
.sg-card.ingraph {
  border-color: var(--accent-line);
  background: var(--panel-2);
}
.sg-title {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sg-type {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sg-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
  font-size: 11.5px;
  color: var(--muted);
}
.sg-edited {
  color: var(--accent);
}
.sb-body {
  max-height: 56vh;
  overflow-y: auto;
  padding-right: 6px;
}
.sb-row {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 4px 10px;
  align-items: center;
  padding: 6px 0;
}
.sb-label {
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 5px;
}
.sb-hint {
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
}
.sb-control {
  min-width: 0;
}
.sb-note {
  grid-column: 2;
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.5;
}
</style>
