<script setup lang="ts">
import { computed, ref } from 'vue'
import { NAlert, NButton, NProgress, NSelect, NTag, useMessage } from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { useAssemblyStore, type SegmentView } from '@/stores/assembly'
import { usePipelineStore, type SegmentFillTask } from '@/stores/pipeline'
import { useProviderStore } from '@/stores/provider'
import StageAdvice from '@/components/StageAdvice.vue'
import { secondsFromFrames } from '@/domain/timing'
import { formatPad } from '@/domain/frames'
import type { ID } from '@/domain/types'

const project = useProjectStore()
const beats = useBeatStore()
const registry = useRegistryStore()
const assembly = useAssemblyStore()
const pipeline = usePipelineStore()
const provider = useProviderStore()
const message = useMessage()

const concurrency = ref(2)
const expanded = ref<ID | null>(null)
const failed = ref<Record<string, string>>({})
const running = ref(false)

const settings = computed(() => project.settings)
const schema = computed(() => project.fieldSchema)

/** 需要模型填写的字段 */
const llmFields = computed(() => schema.value.filter((f) => f.source === 'llm'))

const views = computed<SegmentView[]>(() => {
  const asm = assembly.current
  if (!asm) return []
  return assembly.buildSegmentViews(
    asm,
    beats.ordered,
    settings.value,
    registry.entityById,
    project.fieldSchema
  )
})

/** 段字段的权威值：summary 已由 store 合并进 fields */
function valueOf(v: SegmentView, key: string): string {
  return v.fields[key] ?? ''
}

function missingOf(v: SegmentView): string[] {
  return llmFields.value.filter((f) => !valueOf(v, f.key).trim()).map((f) => f.key)
}

function statusOf(v: SegmentView): 'empty' | 'partial' | 'done' {
  if (!llmFields.value.length) return 'done'
  const missing = missingOf(v).length
  if (missing === 0) return 'done'
  if (missing === llmFields.value.length) return 'empty'
  return 'partial'
}

const stats = computed(() => {
  let done = 0
  let partial = 0
  let empty = 0
  for (const v of views.value) {
    const s = statusOf(v)
    if (s === 'done') done++
    else if (s === 'partial') partial++
    else empty++
  }
  const llmTotal = views.value.reduce((sum, v) => sum + missingOf(v).length, 0)
  // 上游改过、内容已不可信的段
  const stale = views.value.filter((v) => v.stale).length
  return { done, partial, empty, missingFields: llmTotal, stale }
})

/** 需要（重新）生成的目标：字段空缺的 + 上游改过已过期的 */
const targetsToFill = computed(() => views.value.filter((v) => missingOf(v).length > 0 || v.stale))

const progressPercent = computed(() => {
  if (!views.value.length) return 0
  return Math.round((stats.value.done / views.value.length) * 100)
})

async function writeBack(groupId: ID, fields: Record<string, string>) {
  const pid = project.currentId
  if (!pid) return
  const summary = fields.summary
  const rest: Record<string, string> = { ...fields }
  delete rest.summary
  if (summary) await assembly.setSummary(pid, groupId, summary)
  if (Object.keys(rest).length) await assembly.setFields(pid, groupId, rest)

  // ★ 记下这次生成是基于哪份内容。之后上游一改，指纹对不上就会被标成需要重新生成
  const v = views.value.find((x) => x.group.id === groupId)
  if (v) await assembly.markGenerated(pid, groupId, v.beats, registry.entities)
}

function tasksFor(targets: SegmentView[]): SegmentFillTask[] {
  return targets.map((v) => ({
    id: v.group.id,
    schema: schema.value,
    beats: v.beats,
    entities: registry.entities,
    seamFromPrev: v.seam,
    nextSeam: v.nextSeam,
    existing: { ...v.fields },
    frames: v.frames,
    index: views.value.findIndex((x) => x.group.id === v.group.id)
  }))
}

async function run(targets: SegmentView[], label: string) {
  if (!provider.ready) {
    message.warning('请先在模型设置里配置好供应商')
    return
  }
  if (!targets.length) {
    message.info('没有需要生成的段')
    return
  }
  if (!llmFields.value.length) {
    message.warning('当前字段配置里没有「模型生成」类型的字段')
    return
  }

  failed.value = {}
  running.value = true
  try {
    const result = await pipeline.fillSegments(
      tasksFor(targets),
      settings.value,
      async (taskId, fields, err) => {
        if (err) {
          failed.value = { ...failed.value, [taskId]: err }
          return
        }
        await writeBack(taskId, fields)
      },
      concurrency.value
    )
    if (result.failed) {
      message.warning(`${label}：成功 ${result.ok} 段，失败 ${result.failed} 段`)
    } else {
      message.success(`${label}：${result.ok} 段已补全`)
    }
  } finally {
    running.value = false
  }
}

function fillMissing() {
  run(targetsToFill.value, stats.value.stale ? '补空缺 + 重新生成过期段' : '补全空缺')
}

function regenerateAll() {
  run(views.value, '全部重生成')
}

function regenerateOne(v: SegmentView) {
  run([v], `seg 重生成`)
}

function segLabel(index: number) {
  return `seg${String(index + 1).padStart(2, '0')}`
}
</script>

<template>
  <div style="height: 100%; display: flex; flex-direction: column">
    <div class="panel-head" style="border-radius: 0">
      <div class="row" style="gap: 10px">
        <span>阶段三 · 字段补全</span>
        <n-tag size="small" :bordered="false">{{ views.length }} 段</n-tag>
        <n-tag size="small" type="success" :bordered="false">已补全 {{ stats.done }}</n-tag>
        <n-tag v-if="stats.partial" size="small" type="warning" :bordered="false">
          部分 {{ stats.partial }}
        </n-tag>
        <n-tag v-if="stats.empty" size="small" :bordered="false">待补 {{ stats.empty }}</n-tag>
        <n-tag v-if="stats.stale" size="small" type="warning" :bordered="false">
          上游已改 {{ stats.stale }}
        </n-tag>
      </div>
      <div class="row" style="gap: 8px">
        <span class="muted" style="font-size: 12.5px">并发</span>
        <n-select
          size="small"
          style="width: 80px"
          :value="concurrency"
          :options="[1, 2, 3, 4].map((n) => ({ label: String(n), value: n }))"
          @update:value="(v: number) => (concurrency = v)"
        />
        <n-button
          size="small"
          :disabled="!targetsToFill.length"
          :loading="running"
          @click="fillMissing"
        >
          {{ stats.stale ? `补空缺 + 重生成过期（${targetsToFill.length}）` : `补全空缺（${stats.missingFields}）` }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          :disabled="!views.length || !provider.ready"
          :loading="running"
          @click="regenerateAll"
        >
          全部重生成
        </n-button>
      </div>
    </div>

    <div style="padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line)">
      <n-progress type="line" :percentage="progressPercent" :height="6" :show-indicator="false" />
      <div class="row-between" style="margin-top: 6px">
        <div class="muted" style="font-size: 12px">
          每段一次独立请求，模型只负责
          <span class="mono">{{ llmFields.map((f) => f.key).join(' / ') || '（未配置）' }}</span>
          ；其余字段由引擎派生，会作为只读上下文一起发给模型
        </div>
        <span class="muted mono" style="font-size: 12px">
          {{ pipeline.running ? pipeline.progress : `${stats.done}/${views.length} 完成` }}
        </span>
      </div>
    </div>

    <StageAdvice
      stage="complete"
      scope="segments"
      :presets="['summary 不要重复台词原文', '某段的配乐不合适', '某段的环境声写太空了']"
    />

    <div class="scroll-pane" style="flex: 1; padding: 16px">
      <n-alert v-if="pipeline.error" type="error" :bordered="false" style="margin-bottom: 12px">
        {{ pipeline.error }}
      </n-alert>

      <n-alert v-if="stats.stale" type="warning" :bordered="false" style="margin-bottom: 12px">
        有 {{ stats.stale }} 段的字段是在旧内容上生成的，上游片段或实体改过之后已不可信。
        点「补空缺 + 重生成过期」重新生成。
      </n-alert>

      <div v-if="!views.length" class="empty">
        <div>还没有组合好的段，先到「组合与缝合」生成方案</div>
      </div>

      <div class="stack" style="gap: 8px">
        <div v-for="(v, i) in views" :key="v.group.id" class="panel" style="padding: 10px 12px">
          <div class="row-between" style="gap: 10px">
            <div class="row" style="gap: 8px; min-width: 0">
              <span style="font-weight: 600">{{ segLabel(i) }}</span>
              <span class="mono" style="font-size: 12px; color: #5b6273">
                {{ v.rawFrames
                }}<span
                  v-if="v.padTotal"
                  :style="{ color: v.padTotal > 0 ? '#b06a12' : '#2b56b8' }"
                >{{ formatPad(v.padTotal) }}</span>
                = {{ v.frames }}f
              </span>
              <span class="muted mono" style="font-size: 12px">
                {{ secondsFromFrames(v.frames, settings.fps).toFixed(2) }}s · {{ v.beats.length }} 拍
              </span>
              <span
                class="tag-chip"
                :style="
                  v.aligned
                    ? { background: '#e9f7ef', color: '#217a52' }
                    : { background: '#fdecec', color: '#a12d2d' }
                "
              >
                {{ v.refPrev ? '17k' : '5+17k' }}
              </span>
              <n-tag v-if="v.over" size="small" type="error" :bordered="false">超限</n-tag>
              <n-tag
                v-if="v.stale"
                size="small"
                type="warning"
                :bordered="false"
                style="cursor: help"
                title="上游片段或实体改过，这段字段已经不可信"
              >
                上游已改
              </n-tag>
              <n-tag
                v-if="failed[v.group.id]"
                size="small"
                type="error"
                :bordered="false"
                style="cursor: help"
              >
                生成失败
              </n-tag>
              <n-tag
                v-else-if="statusOf(v) === 'done'"
                size="small"
                type="success"
                :bordered="false"
              >
                已补全
              </n-tag>
              <n-tag
                v-else-if="statusOf(v) === 'partial'"
                size="small"
                type="warning"
                :bordered="false"
              >
                缺 {{ missingOf(v).length }}
              </n-tag>
              <n-tag v-else size="small" :bordered="false">待补全</n-tag>
            </div>

            <div class="row" style="gap: 6px">
              <n-button
                size="tiny"
                quaternary
                @click="expanded = expanded === v.group.id ? null : v.group.id"
              >
                {{ expanded === v.group.id ? '收起' : '预览' }}
              </n-button>
              <n-button
                size="tiny"
                :loading="running"
                :disabled="!provider.ready"
                @click="regenerateOne(v)"
              >
                {{ statusOf(v) === 'done' ? '重新生成' : '生成' }}
              </n-button>
            </div>
          </div>

          <div v-if="failed[v.group.id]" class="issue error" style="margin-top: 8px">
            {{ failed[v.group.id] }}
          </div>

          <div v-if="expanded === v.group.id" class="stack" style="gap: 8px; margin-top: 10px">
            <div
              v-for="f in llmFields"
              :key="f.key"
              class="field-card"
            >
              <div class="field-head">
                <div class="row" style="gap: 8px">
                  <span class="mono" style="font-weight: 600">{{ f.key }}</span>
                  <span
                    v-if="!valueOf(v, f.key).trim()"
                    class="tag-chip"
                    style="background: #fdecec; color: #a12d2d"
                  >
                    空
                  </span>
                </div>
                <span class="muted" style="font-size: 12px">在「交付」页编辑</span>
              </div>
              <div class="field-body">
                <div
                  class="mono"
                  style="font-size: 12.5px; line-height: 1.65; white-space: pre-wrap; word-break: break-word"
                >
                  {{ valueOf(v, f.key) || '（尚未生成）' }}
                </div>
              </div>
            </div>

            <div class="muted" style="font-size: 12px">
              本段还会带上这些只读上下文：{{ v.beats.length }} 拍镜头序列、出场实体与参考图编号、段首段尾衔接结论
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
