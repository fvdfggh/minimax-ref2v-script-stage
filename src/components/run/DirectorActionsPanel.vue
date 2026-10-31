<script setup lang="ts">
/**
 * 导演台动作面板。
 *
 * ComfyUI 里导演节点那些按钮（清缓存、导出段、二采、对齐、删段、提取音轨、
 * ASR 校验、镜头检测…）背后其实是 HTTP 端点。剧本台把它们收进来，
 * 就不用为了按一个按钮切回 ComfyUI 再找节点。
 *
 * 动作的字段是从节点源码里逐个挖出来的，不是猜的；拿不准的还能切到
 * 「原始请求」直接改 JSON。
 */
import { computed, onMounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NInput,
  NInputNumber,
  NSelect,
  NSwitch,
  NTag,
  useMessage
} from 'naive-ui'
import { useDirectorStore } from '@/stores/director'
import { useRunStore } from '@/stores/run'
import { useWorkflowStore } from '@/stores/workflow'
import { directorNodeId, resolveWorkflowName } from '@/domain/run'
import { comfySegmentClipUrl } from '@/core/comfy'
import type { DirectorAction } from '@/domain/director'

const director = useDirectorStore()
const run = useRunStore()
const workflow = useWorkflowStore()
const message = useMessage()

const baseUrl = computed(() => run.active?.baseUrl ?? '')
const api = computed(() => workflow.active?.api ?? null)
const nodeId = computed(() => directorNodeId(api.value) ?? '')
const workflowName = computed(() =>
  run.active ? resolveWorkflowName(run.active, '第 01 集') : ''
)
/** 时间线：导演台好几个动作要靠它重建 plan */
const timelineData = computed(() => {
  const inputs = nodeId.value ? (api.value?.[nodeId.value]?.inputs ?? {}) : {}
  return inputs.timeline_data as unknown
})

const openId = ref('')
const values = ref<Record<string, Record<string, unknown>>>({})
const rawMode = ref(false)
const rawBody = ref('{}')

function actionValues(id: string): Record<string, unknown> {
  if (!values.value[id]) {
    const action = director.actions.find((a) => a.id === id)
    const init: Record<string, unknown> = {}
    for (const f of action?.fields ?? []) init[f.name] = f.default ?? ''
    values.value[id] = init
  }
  return values.value[id]
}

function setField(id: string, name: string, v: unknown) {
  actionValues(id)[name] = v
}

function toggle(id: string) {
  openId.value = openId.value === id ? '' : id
}

async function execute(action: DirectorAction) {
  let payload: Record<string, unknown>
  if (rawMode.value) {
    try {
      payload = JSON.parse(rawBody.value || '{}') as Record<string, unknown>
    } catch {
      message.error('JSON 解析失败')
      return
    }
  } else {
    payload = actionValues(action.id)
  }
  try {
    await director.runAction(action, payload, {
      base: baseUrl.value,
      nodeId: nodeId.value,
      workflowName: workflowName.value,
      timelineData: timelineData.value
    })
    message.success(`${action.label}：已发出`)
  } catch (err) {
    message.error(`${action.label} 失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 段片段/音轨文件这类"取文件"端点：拼地址交给播放器，别当 JSON 吃 */
const clipIndex = ref(0)
/** 走剧本台后端的流转发（直连 8188 的跨源媒体会被浏览器拒播） */
const clipUrl = computed(() =>
  comfySegmentClipUrl(baseUrl.value, {
    nodeId: nodeId.value,
    workflowName: workflowName.value,
    index: clipIndex.value,
    pass: 'first'
  })
)

onMounted(() => {
  if (baseUrl.value) void director.loadSpec(baseUrl.value)
})
</script>

<template>
  <div class="dir">
    <div class="row-between" style="padding: 10px 14px; border-bottom: 1px solid var(--line)">
      <div>
        <div style="font-size: 13px; font-weight: 500">导演台动作</div>
        <div class="muted" style="font-size: 11.5px; margin-top: 2px">
          节点 <span class="mono">{{ nodeId || '（未找到）' }}</span> · 缓存目录
          <span class="mono">{{ workflowName }}</span> · ComfyUI
          <span class="mono">{{ baseUrl }}</span>
        </div>
      </div>
      <div class="row" style="gap: 6px">
        <n-button size="tiny" tertiary @click="director.loadSpec(baseUrl)">重载规格</n-button>
      </div>
    </div>

    <n-alert
      v-if="!baseUrl || !nodeId"
      type="warning"
      :show-icon="false"
      style="margin: 12px 14px"
    >
      {{ !baseUrl ? '运行配置里没有 ComfyUI 地址。' : '当前工作流里没有导演节点，动作不知道该打在谁身上。' }}
      先在运行配置里连上 ComfyUI 并导入 API 工作流。
    </n-alert>

    <n-alert v-else-if="director.specError" type="error" :show-icon="false" style="margin: 12px 14px">
      {{ director.specError }}
    </n-alert>

    <div class="dir-body">
      <!-- 动作列表 -->
      <div class="dir-grid">
        <div
          v-for="action in director.actions"
          :key="action.id"
          class="dir-card"
          :class="{ on: openId === action.id, danger: action.danger }"
        >
          <div class="row-between" @click="toggle(action.id)">
            <div style="min-width: 0">
              <div class="row" style="gap: 6px">
                <span class="dir-name">{{ action.label }}</span>
                <n-tag size="tiny" :bordered="false">{{ action.method }}</n-tag>
                <n-tag v-if="action.danger" size="tiny" :bordered="false" type="warning">危险</n-tag>
              </div>
              <div class="muted mono" style="font-size: 11px">
                /minimax/director_opt{{ action.path }}
              </div>
              <div class="muted" style="font-size: 11.5px; margin-top: 2px">{{ action.hint }}</div>
            </div>
            <n-button
              size="tiny"
              :type="action.danger ? 'error' : 'primary'"
              secondary
              :loading="director.busyId === action.id"
              :disabled="!baseUrl || !nodeId"
              @click.stop="execute(action)"
            >
              执行
            </n-button>
          </div>

          <div v-if="openId === action.id" class="dir-form">
            <template v-if="action.fields.length">
              <label v-for="f in action.fields" :key="f.name" class="df">
                <span class="df-label">
                  {{ f.label }}
                  <span class="muted mono" style="font-size: 10.5px">{{ f.name }}</span>
                </span>
                <n-switch
                  v-if="f.type === 'bool'"
                  :value="!!actionValues(action.id)[f.name]"
                  size="small"
                  @update:value="(v: boolean) => setField(action.id, f.name, v)"
                />
                <n-select
                  v-else-if="f.type === 'combo'"
                  :value="String(actionValues(action.id)[f.name] ?? '')"
                  :options="(f.options ?? []).map((o) => ({ label: o || '（默认）', value: o }))"
                  size="small"
                  @update:value="(v: string) => setField(action.id, f.name, v)"
                />
                <n-input-number
                  v-else-if="f.type === 'int'"
                  :value="Number(actionValues(action.id)[f.name] ?? 0)"
                  size="small"
                  @update:value="(v: number | null) => setField(action.id, f.name, v ?? 0)"
                />
                <n-input-number
                  v-else-if="f.type === 'number'"
                  :value="Number(actionValues(action.id)[f.name] ?? 0)"
                  size="small"
                  :step="0.05"
                  @update:value="(v: number | null) => setField(action.id, f.name, v ?? 0)"
                />
                <n-input
                  v-else
                  :value="String(actionValues(action.id)[f.name] ?? '')"
                  size="small"
                  :placeholder="f.hint || ''"
                  @update:value="(v: string) => setField(action.id, f.name, v)"
                />
              </label>
            </template>
            <div v-else class="muted" style="font-size: 11.5px">
              这个动作不需要额外参数（node_id / workflow_name 会自动带上）。
            </div>

            <div class="row" style="gap: 6px; margin-top: 8px">
              <n-button size="tiny" quaternary @click="rawMode = !rawMode">
                {{ rawMode ? '回到表单' : '改原始 JSON' }}
              </n-button>
              <span v-if="action.auto?.length" class="muted" style="font-size: 11px">
                自动带上：{{ action.auto.join('、') }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- 原始 JSON -->
      <div v-if="rawMode" class="dir-side">
        <div class="side-head">原始请求体（POST 的 body）</div>
        <n-input
          v-model:value="rawBody"
          type="textarea"
          :rows="10"
          size="small"
          placeholder='{"clear_all": true}'
        />
        <div class="muted" style="font-size: 11.5px; margin-top: 6px">
          留空 = <span class="mono">&#123;&#125;</span>。自动上下文仍会带上。
        </div>
      </div>

      <!-- 段片段预览 -->
      <div class="dir-side">
        <div class="side-head">段片段预览</div>
        <div class="row" style="gap: 6px; align-items: center">
          <span class="muted" style="font-size: 11.5px">段序号</span>
          <n-input-number v-model:value="clipIndex" size="tiny" :min="0" style="width: 90px" />
        </div>
        <video
          v-if="nodeId"
          :src="clipUrl"
          controls
          muted
          style="width: 100%; margin-top: 8px; border-radius: 6px; background: #000"
        ></video>
        <div class="muted mono" style="font-size: 10.5px; margin-top: 6px; overflow-wrap: anywhere">
          {{ clipUrl }}
        </div>
      </div>

      <!-- 结果 / 日志 -->
      <div class="dir-side">
        <div class="side-head">最近响应</div>
        <pre v-if="director.lastResult" class="dir-json">{{ JSON.stringify(director.lastResult, null, 2) }}</pre>
        <div v-else class="muted" style="font-size: 11.5px">还没有执行过动作。</div>

        <div class="side-head" style="margin-top: 12px">执行记录</div>
        <div v-if="!director.log.length" class="muted" style="font-size: 11.5px">空。</div>
        <div v-for="(l, i) in director.log" :key="i" class="dir-log" :class="{ bad: !l.ok }">
          <span class="mono">{{ new Date(l.t).toLocaleTimeString() }}</span>
          <span>{{ l.action }}</span>
          <span class="muted" style="overflow-wrap: anywhere">{{ l.text }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dir {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}
.dir-body {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(280px, 1fr);
  gap: 12px;
  padding: 12px 14px 60px;
  align-items: start;
}
.dir-grid {
  display: grid;
  gap: 8px;
}
.dir-card {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  cursor: pointer;
}
.dir-card.on {
  border-color: var(--accent, var(--ok));
}
.dir-card.danger {
  border-left: 3px solid var(--warn);
}
.dir-name {
  font-size: 12.5px;
  font-weight: 500;
}
.dir-form {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
  display: grid;
  gap: 6px;
}
.df {
  display: grid;
  grid-template-columns: minmax(120px, 40%) minmax(0, 1fr);
  gap: 8px;
  align-items: center;
}
.df-label {
  font-size: 11.5px;
  display: flex;
  flex-direction: column;
}
.dir-side {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
}
.side-head {
  font-size: 11.5px;
  color: var(--muted);
  margin-bottom: 6px;
}
.dir-json {
  margin: 0;
  max-height: 320px;
  overflow: auto;
  font-size: 11px;
  background: rgba(127, 127, 127, 0.1);
  border-radius: 6px;
  padding: 8px;
}
.dir-log {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  gap: 6px;
  font-size: 11px;
  padding: 2px 0;
  border-bottom: 1px dashed var(--line);
}
.dir-log.bad {
  color: var(--warn);
}
</style>
