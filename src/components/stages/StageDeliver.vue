<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NAlert, NButton, NInput, NModal, NSelect, NTag, useMessage } from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { useAssemblyStore } from '@/stores/assembly'
import { usePipelineStore } from '@/stores/pipeline'
import { useProviderStore } from '@/stores/provider'
import SeamPanel from '@/components/SeamPanel.vue'
import StageAdvice from '@/components/StageAdvice.vue'
import FixIssuesDialog from '@/components/FixIssuesDialog.vue'
import { splitIssuesByScope } from '@/domain/rules'
import { hasCjkOutsideD } from '@/domain/lang'
import type { FixPatch } from '@/core/llm/prompts'
import { composeSegmentText } from '@/domain/derive'
import { secondsFromFrames } from '@/domain/timing'
import { formatPad } from '@/domain/frames'
import type { FieldSchema, ID, ProjectSettings } from '@/domain/types'

const project = useProjectStore()
const beats = useBeatStore()
const registry = useRegistryStore()
const assembly = useAssemblyStore()
const pipeline = usePipelineStore()
const provider = useProviderStore()
const message = useMessage()

const activeSegment = ref(0)
const showExport = ref(false)
const showSchema = ref(false)
const showFix = ref(false)
const schemaDraft = ref<FieldSchema[]>([])

const settings = computed<ProjectSettings>(() => project.settings)
const schema = computed(() => project.fieldSchema)
const list = computed(() => beats.ordered)
const current = computed(() => assembly.current)

const views = computed(() => {
  if (!current.value) return []
  return assembly.buildSegmentViews(
    current.value,
    list.value,
    settings.value,
    registry.entityById,
    project.fieldSchema
  )
})

const active = computed(() => views.value[activeSegment.value] ?? null)

/** 是否已经切到英文终稿（阶段⑤ 完成） */
const finalMode = computed(() => settings.value.workLanguage === 'en')

/** 模型字段基于旧内容生成、现在已不可信的段数 */
const staleCount = computed(() => views.value.filter((v) => v.stale).length)

/** 不在任何段里的片段：它们不会出现在交付结果里 */
const orphanCount = computed(() => {
  const asm = current.value
  if (!asm) return 0
  const assigned = new Set(asm.groups.flatMap((g) => g.beatIds))
  return list.value.filter((b) => !assigned.has(b.id)).length
})

/** 还在中文工作稿里、但已经混进英文的字段（本地化没做干净的信号） */
const cjkFields = computed(() => {
  const out: string[] = []
  if (!finalMode.value) return out
  for (const v of views.value) {
    for (const f of project.fieldSchema) {
      if (hasCjkOutsideD(v.fields[f.key])) out.push(`${f.key}@${v.group.id}`)
    }
  }
  return out
})

const globalIssues = computed(() => {
  if (!views.value.length) return []
  return assembly.globalIssues(
    views.value,
    registry.entities,
    list.value,
    settings.value,
    registry.entityById,
    project.fieldSchema
  )
})

const stats = computed(() => {
  const errors = views.value.reduce((s, v) => s + v.issues.filter((i) => i.level === 'error').length, 0)
  const warns = views.value.reduce((s, v) => s + v.issues.filter((i) => i.level === 'warn').length, 0)
  return {
    errors: errors + globalIssues.value.filter((i) => i.level === 'error').length,
    warns: warns + globalIssues.value.filter((i) => i.level === 'warn').length
  }
})

/** 本段（含全片级）里能靠改写字段修掉的问题数 */
const fixableCount = computed(() => {
  if (!active.value) return 0
  return splitIssuesByScope([...active.value.issues, ...globalIssues.value]).field.length
})

/** 段字段的权威值：summary 已由 store 合并进 fields */
function fieldValue(key: string): string {
  return active.value?.fields[key] ?? ''
}

/* ---------------- 草稿式编辑：失焦才写库 ---------------- */

const drafts = ref<Record<string, string>>({})
const draftKey = (groupId: ID, key: string) => `${groupId}|${key}`

function draftOf(groupId: ID, key: string): string {
  const k = draftKey(groupId, key)
  if (k in drafts.value) return drafts.value[k]
  return active.value?.fields[key] ?? ''
}

function onDraft(groupId: ID, key: string, value: string) {
  drafts.value = { ...drafts.value, [draftKey(groupId, key)]: value }
}

async function commitField(groupId: ID, key: string) {
  const k = draftKey(groupId, key)
  if (!(k in drafts.value)) return
  const value = drafts.value[k]
  const next = { ...drafts.value }
  delete next[k]
  drafts.value = next

  const pid = project.currentId
  if (!pid) return
  if (value === (active.value?.fields[key] ?? '')) return

  if (key === 'summary') await assembly.setSummary(pid, groupId, value)
  else await assembly.setField(pid, groupId, key, value)
}

/** 切换段之前把未提交的草稿落库 */
async function commitAll() {
  const v = active.value
  if (!v) return
  const prefix = `${v.group.id}|`
  const pending = Object.keys(drafts.value).filter((k) => k.startsWith(prefix))
  for (const k of pending) {
    await commitField(v.group.id, k.slice(prefix.length))
  }
}

watch(
  () => active.value?.group.id,
  async (_next, prev) => {
    if (prev) await commitAll()
  }
)

/* ---------------- 锁定状态 ---------------- */

const lockedSet = computed(() => {
  const v = active.value
  if (!v) return new Set<string>()
  return new Set(assembly.lockedKeys(v.group.id))
})

async function unlockField(key: string) {
  const v = active.value
  if (!v || !project.currentId) return
  if (key === 'summary') await assembly.clearSummary(project.currentId, v.group.id)
  else await assembly.clearFields(project.currentId, v.group.id, [key])

  const k = draftKey(v.group.id, key)
  const next = { ...drafts.value }
  delete next[k]
  drafts.value = next
  message.success(`${key} 已恢复自动生成`)
}

async function unlockAll() {
  const v = active.value
  if (!v || !project.currentId) return
  await assembly.clearFields(project.currentId, v.group.id, schema.value.map((f) => f.key))
  await assembly.clearSummary(project.currentId, v.group.id)
  drafts.value = {}
  message.success('本段全部字段已恢复自动生成')
}

function rowsFor(groupId: ID, key: string) {
  const text = draftOf(groupId, key)
  return Math.min(18, Math.max(2, text.split('\n').length || 1))
}

/* ---------------- AI 修复 ---------------- */

async function applyPatches(patches: FixPatch[]) {
  const v = active.value
  const pid = project.currentId
  if (!v || !pid) return

  for (const p of patches) {
    if (p.field === 'summary') await assembly.setSummary(pid, v.group.id, p.value)
    else await assembly.setField(pid, v.group.id, p.field, p.value)
  }

  // 清掉本段未提交的草稿，否则旧草稿会在失焦时把刚写入的值盖回去
  const prefix = `${v.group.id}|`
  const next = { ...drafts.value }
  for (const k of Object.keys(next)) if (k.startsWith(prefix)) delete next[k]
  drafts.value = next

  message.success(`已应用 ${patches.length} 项修复`)
}

const SOURCE_LABEL: Record<string, string> = {
  derived: '引擎派生',
  llm: '模型生成',
  manual: '人工填写'
}

const SOURCE_STYLE: Record<string, { background: string; color: string }> = {
  derived: { background: '#eaf0ff', color: '#2b56b8' },
  llm: { background: '#e9f7ef', color: '#217a52' },
  manual: { background: '#f2f4f7', color: '#5b6273' }
}

/** 调阶段三的同一个补全流程：模型补全 llm 字段，写回本页可继续手工微调 */
async function fillSegments(targets: typeof views.value) {
  if (!provider.ready) {
    message.warning('请先配置模型供应商')
    return
  }
  if (!targets.length || !project.currentId) return

  const tasks = targets.map((v) => ({
    id: v.group.id,
    schema: schema.value,
    beats: v.beats,
    entities: registry.entities,
    seamFromPrev: v.seam,
    nextSeam: v.nextSeam,
    existing: {
      ...v.fields,
      summary: assembly.getSummary(v.group.id) || v.fields.summary || ''
    },
    frames: v.frames,
    index: views.value.findIndex((x) => x.group.id === v.group.id)
  }))

  const res = await pipeline.fillSegments(
    tasks,
    settings.value,
    async (taskId, fields, err) => {
      if (err) return
      const summary = fields.summary
      const rest: Record<string, string> = { ...fields }
      delete rest.summary
      if (summary) await assembly.setSummary(project.currentId!, taskId, summary)
      if (Object.keys(rest).length) await assembly.setFields(project.currentId!, taskId, rest)
    },
    2
  )

  if (res.failed) message.warning(`成功 ${res.ok} 段，失败 ${res.failed} 段`)
  else message.success(`${res.ok} 段已补全`)
}

function genSummary() {
  if (active.value) void fillSegments([active.value])
}

function genAllSummaries() {
  void fillSegments(views.value)
}

function copyText(text: string) {
  navigator.clipboard.writeText(text)
  message.success('已复制')
}

function exportJson() {
  return assembly.exportAssembly(views.value, schema.value, settings.value)
}

function download() {
  const blob = new Blob([exportJson()], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${project.current?.name ?? 'segments'}-deliverable.json`
  a.click()
  URL.revokeObjectURL(url)
  message.success('已导出')
}

function openSchema() {
  schemaDraft.value = structuredClone(schema.value)
  showSchema.value = true
}

async function saveSchema() {
  await project.updateFieldSchema(schemaDraft.value)
  showSchema.value = false
  message.success('字段 Schema 已保存')
}

function addSchemaRow() {
  schemaDraft.value.push({
    key: `field_${schemaDraft.value.length + 1}`,
    label: '',
    order: schemaDraft.value.length + 1,
    source: 'manual',
    editable: true,
    required: false,
    lang: 'any'
  })
}

function moveSchema(idx: number, dir: -1 | 1) {
  const to = idx + dir
  if (to < 0 || to >= schemaDraft.value.length) return
  const arr = schemaDraft.value
  ;[arr[idx], arr[to]] = [arr[to], arr[idx]]
}
</script>

<template>
  <div style="height: 100%; display: flex; flex-direction: column">
    <div class="panel-head" style="border-radius: 0">
      <div class="row" style="gap: 10px">
        <span>交付</span>
        <n-tag size="small" :bordered="false">{{ views.length }} 段</n-tag>
        <n-tag v-if="!finalMode" size="small" type="warning" :bordered="false">中文工作稿</n-tag>
        <n-tag v-else size="small" type="success" :bordered="false">英文终稿</n-tag>
        <n-tag v-if="stats.errors" size="small" type="error" :bordered="false">
          {{ stats.errors }} 个错误
        </n-tag>
        <n-tag v-if="stats.warns" size="small" type="warning" :bordered="false">
          {{ stats.warns }} 个警告
        </n-tag>
      </div>
      <div class="row" style="gap: 8px">
        <n-button size="small" quaternary @click="openSchema">字段配置</n-button>
        <n-button
          size="small"
          type="warning"
          ghost
          :disabled="!active || !fixableCount || !provider.ready"
          @click="showFix = true"
        >
          AI 修复问题{{ fixableCount ? `（${fixableCount}）` : '' }}
        </n-button>
        <n-button size="small" :disabled="!views.length || !provider.ready" @click="genAllSummaries">
          全部重新生成
        </n-button>
        <n-button size="small" type="primary" :disabled="!views.length" @click="showExport = true">
          导出
        </n-button>
      </div>
    </div>

    <div v-if="!views.length" class="empty" style="flex: 1">
      <div>还没有可交付的段，先到「阶段三 · 组合与缝合」生成方案</div>
    </div>

    <div v-else style="flex: 1; min-height: 0; display: flex">
      <!-- 段列表 -->
      <div
        style="
          width: 220px;
          flex: 0 0 220px;
          border-right: 1px solid var(--line);
          background: var(--panel);
          overflow: auto;
          padding: 10px;
        "
      >
        <div
          v-for="(v, i) in views"
          :key="v.group.id"
          class="panel"
          :style="{
            padding: '8px 10px',
            marginBottom: '6px',
            cursor: 'pointer',
            borderColor: activeSegment === i ? 'var(--accent)' : 'var(--line)',
            background: activeSegment === i ? 'var(--accent-soft)' : 'var(--panel)'
          }"
          @click="activeSegment = i"
        >
          <div class="row-between">
            <span style="font-weight: 600">seg{{ String(i + 1).padStart(2, '0') }}</span>
            <span class="muted mono" style="font-size: 11px">{{ v.frames }}f</span>
          </div>
          <div class="row" style="gap: 4px; margin-top: 4px; flex-wrap: wrap">
            <span v-if="v.over" class="tag-chip" style="background: #fdecec; color: #a12d2d">超限</span>
            <span
              v-else-if="v.nextSeam?.blackFallback"
              class="tag-chip"
              style="background: #fdf0dc; color: #8a6008"
            >
              黑屏
            </span>
            <span
              v-if="v.issues.some((x) => x.level === 'error')"
              class="tag-chip"
              style="background: #fdecec; color: #a12d2d"
            >
              {{ v.issues.filter((x) => x.level === 'error').length }} 错
            </span>
          </div>
        </div>
      </div>

      <!-- 字段编辑 -->
      <div class="scroll-pane" style="flex: 1; padding: 16px">
        <div style="margin-bottom: 12px">
          <StageAdvice
            stage="deliver"
            :presets="['这几个校验错误帮我修掉', '整体节奏太拖，帮我压缩一下', '检查一遍有没有中文残留']"
          />
        </div>

        <n-alert v-if="orphanCount" type="error" :bordered="false" style="margin-bottom: 12px">
          有 {{ orphanCount }} 个片段不在任何段里，不会出现在交付结果里。
          去「③ 组合与缝合」把它们并入相邻段。
        </n-alert>
        <n-alert v-if="staleCount" type="warning" :bordered="false" style="margin-bottom: 12px">
          有 {{ staleCount }} 段的模型字段是在旧内容上生成的，上游片段或实体改过之后已不可信。
          回「④ 字段补全」点「补空缺 + 重生成过期」。
        </n-alert>
        <n-alert v-if="!finalMode" type="warning" :bordered="false" style="margin-bottom: 12px">
          当前还是中文工作稿。交付前请到「⑤ 中英本地化」做一次转换：
          派生字段会由引擎用英文词条重新渲染，模型字段（summary / overall_soundscape / non_diegetic_music）需要翻译一遍。
        </n-alert>
        <n-alert
          v-else-if="cjkFields.length"
          type="error"
          :bordered="false"
          style="margin-bottom: 12px"
        >
          已切到英文终稿，但仍有 {{ cjkFields.length }} 处字段在 &lt;d&gt; 之外残留中文，
          多半是词条表没翻全。回「⑤ 中英本地化」补翻词条后再看。
        </n-alert>

        <n-alert
          v-if="active && active.issues.filter((i) => i.level === 'error').length"
          type="error"
          :bordered="false"
          style="margin-bottom: 12px"
        >
          <div class="row-between">
            <span>
              {{ active.issues.filter((i) => i.level === 'error').length }} 个错误需要处理
              <span v-if="fixableCount" class="muted">· 其中 {{ fixableCount }} 个可交给 AI 修</span>
            </span>
            <n-button
              size="tiny"
              type="warning"
              ghost
              :disabled="!fixableCount || !provider.ready"
              @click="showFix = true"
            >
              AI 修复
            </n-button>
          </div>
        </n-alert>

        <template v-if="active">
          <div class="panel" style="margin-bottom: 14px">
            <div class="panel-head">
              <div class="row" style="gap: 8px">
                <span>seg{{ String(activeSegment + 1).padStart(2, '0') }}</span>
                <span class="mono" style="font-size: 12px; color: #5b6273">
                  {{ active.rawFrames }}
                  <span
                    v-if="active.padTotal"
                    :style="{ color: active.padTotal > 0 ? '#b06a12' : '#2b56b8' }"
                  >
                    {{ formatPad(active.padTotal) }}
                  </span>
                  = {{ active.frames }} 帧
                </span>
                <span class="muted mono" style="font-size: 12px">
                  {{ secondsFromFrames(active.frames, settings.fps).toFixed(3) }}s ·
                  {{ active.beats.length }} 拍
                </span>
                <span
                  class="tag-chip"
                  :style="
                    active.aligned
                      ? { background: '#e9f7ef', color: '#217a52' }
                      : { background: '#fdecec', color: '#a12d2d' }
                  "
                >
                  {{ active.refPrev ? '17k · 引用上段' : '5+17k · 不引用' }}
                </span>
                <n-tag v-if="active.over" size="small" type="error" :bordered="false">超限</n-tag>
              </div>
              <div class="row" style="gap: 8px">
                <n-button
                  size="tiny"
                  quaternary
                  :disabled="lockedSet.size === 0"
                  @click="unlockAll"
                >
                  全部恢复自动
                </n-button>
                <n-button size="tiny" :disabled="!provider.ready" @click="genSummary">
                  重新生成模型字段
                </n-button>
                <n-button
                  size="tiny"
                  quaternary
                  @click="copyText(composeSegmentText(schema, active.fields))"
                >
                  复制全文
                </n-button>
              </div>
            </div>
            <div v-if="active.seam" class="panel-body">
              <SeamPanel
                :seam="active.seam"
                :index="activeSegment"
                :entity-by-id="registry.entityById"
              />
            </div>
          </div>

          <div v-for="f in schema" :key="f.key" class="field-card">
            <div class="field-head">
              <div class="row" style="gap: 8px; flex-wrap: wrap">
                <span class="mono" style="font-weight: 600">{{ f.key }}</span>
                <span class="tag-chip" :style="SOURCE_STYLE[f.source]">
                  {{ SOURCE_LABEL[f.source] }}
                </span>
                <span
                  v-if="lockedSet.has(f.key)"
                  class="tag-chip"
                  style="background: #fff3e0; color: #b06a12"
                  title="已手改锁定，引擎不再自动派生这个字段"
                >
                  手改锁定
                </span>
                <span
                  v-if="!fieldValue(f.key).trim()"
                  class="tag-chip"
                  style="background: #fdecec; color: #a12d2d"
                >
                  空
                </span>
              </div>
              <div class="row" style="gap: 6px">
                <n-button
                  v-if="lockedSet.has(f.key)"
                  size="tiny"
                  quaternary
                  @click="unlockField(f.key)"
                >
                  恢复自动
                </n-button>
                <n-button size="tiny" quaternary @click="copyText(fieldValue(f.key))">复制</n-button>
              </div>
            </div>
            <div class="field-body">
              <textarea
                :rows="rowsFor(active.group.id, f.key)"
                :value="draftOf(active.group.id, f.key)"
                :placeholder="f.promptHint ?? ''"
                @input="onDraft(active.group.id, f.key, ($event.target as HTMLTextAreaElement).value)"
                @blur="commitField(active.group.id, f.key)"
              />
            </div>
          </div>

          <div v-if="active.issues.length" class="stack" style="gap: 4px; margin-top: 16px">
            <div style="font-weight: 600; font-size: 13px">本段检查</div>
            <div
              v-for="(i, k) in active.issues"
              :key="k"
              class="issue"
              :class="i.level"
            >
              <span class="mono" style="opacity: 0.7">{{ i.ruleId }}</span>
              <span>{{ i.message }}</span>
            </div>
          </div>
        </template>

        <div v-if="globalIssues.length" class="stack" style="gap: 4px; margin-top: 20px">
          <div style="font-weight: 600; font-size: 13px">全片检查</div>
          <div v-for="(i, k) in globalIssues" :key="k" class="issue" :class="i.level">
            <span class="mono" style="opacity: 0.7">{{ i.ruleId }}</span>
            <span>{{ i.message }}</span>
          </div>
        </div>
      </div>
    </div>

    <n-modal v-model:show="showExport" preset="card" title="交付 JSON" style="max-width: 900px">
      <div class="row-between" style="margin-bottom: 10px">
        <span class="muted" style="font-size: 12.5px">
          含每段帧数、连续性参数、缝合判定、字段全文
          <span v-if="!finalMode" style="color: #b06a12">· 当前仍是中文工作稿</span>
        </span>
        <div class="row" style="gap: 8px">
          <n-button size="small" @click="copyText(exportJson())">复制</n-button>
          <n-button size="small" type="primary" @click="download">下载</n-button>
        </div>
      </div>
      <textarea
        readonly
        :value="exportJson()"
        style="
          width: 100%;
          height: 460px;
          border: 1px solid var(--line);
          border-radius: 8px;
          padding: 12px;
          font-family: var(--mono);
          font-size: 12px;
          line-height: 1.6;
          resize: vertical;
        "
      />
    </n-modal>

    <n-modal v-model:show="showSchema" preset="card" title="字段配置" style="max-width: 820px">
      <n-alert type="info" :bordered="false" style="margin-bottom: 12px">
        字段可随意增删改序。派生字段由引擎自动生成，模型生成字段由大模型补全，人工字段只由你填写。
      </n-alert>
      <div
        v-for="(f, i) in schemaDraft"
        :key="i"
        class="panel"
        style="padding: 10px; margin-bottom: 8px"
      >
        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <n-input
            size="small"
            style="width: 180px"
            :value="f.key"
            placeholder="key"
            @update:value="(v: string) => (schemaDraft[i].key = v)"
          />
          <n-select
            size="small"
            style="width: 120px"
            :value="f.source"
            :options="[
              { label: '引擎派生', value: 'derived' },
              { label: '模型生成', value: 'llm' },
              { label: '人工填写', value: 'manual' }
            ]"
            @update:value="(v: string) => (schemaDraft[i].source = v as FieldSchema['source'])"
          />
          <n-input
            size="small"
            style="flex: 1; min-width: 180px"
            :value="f.promptHint ?? ''"
            placeholder="给模型的说明 / 占位提示"
            @update:value="(v: string) => (schemaDraft[i].promptHint = v)"
          />
          <n-button size="tiny" quaternary @click="moveSchema(i, -1)">↑</n-button>
          <n-button size="tiny" quaternary @click="moveSchema(i, 1)">↓</n-button>
          <n-button size="tiny" quaternary type="error" @click="schemaDraft.splice(i, 1)">
            删除
          </n-button>
        </div>
      </div>
      <n-button size="small" dashed block @click="addSchemaRow">+ 新增字段</n-button>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button @click="showSchema = false">取消</n-button>
          <n-button type="primary" @click="saveSchema">保存</n-button>
        </div>
      </template>
    </n-modal>

    <FixIssuesDialog
      v-model:show="showFix"
      :view="active"
      :segment-index="activeSegment"
      :segment-total="views.length"
      :schema="schema"
      :settings="settings"
      :entities="registry.entities"
      :global-issues="globalIssues"
      @apply="applyPatches"
    />
  </div>
</template>
