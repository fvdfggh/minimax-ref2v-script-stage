<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NAlert, NButton, NCheckbox, NInput, NModal, NTag, useMessage } from 'naive-ui'
import { usePipelineStore } from '@/stores/pipeline'
import { useProviderStore } from '@/stores/provider'
import { splitIssuesByScope, SCOPE_HINT, type RuleIssue } from '@/domain/rules'
import { diffLines, diffStat } from '@/core/diff'
import type { FixPatch } from '@/core/llm/prompts'
import type { SegmentView } from '@/stores/assembly'
import type { Entity, FieldSchema, ID, ProjectSettings } from '@/domain/types'

const props = defineProps<{
  show: boolean
  view: SegmentView | null
  segmentIndex: number
  segmentTotal: number
  schema: FieldSchema[]
  settings: ProjectSettings
  entities: Entity[]
  /** 全局校验里与本段相关的问题 */
  globalIssues: RuleIssue[]
}>()

const emit = defineEmits<{
  'update:show': [boolean]
  apply: [patches: FixPatch[]]
}>()

const pipeline = usePipelineStore()
const provider = useProviderStore()
const message = useMessage()

const instruction = ref('')
const error = ref<string | null>(null)
const notes = ref('')
const unfixable = ref<string[]>([])
const patches = ref<FixPatch[]>([])
const accepted = ref<Record<string, boolean>>({})
const phase = ref<'idle' | 'preview'>('idle')

watch(
  () => props.show,
  (v) => {
    if (v) {
      instruction.value = ''
      error.value = null
      notes.value = ''
      unfixable.value = []
      patches.value = []
      accepted.value = {}
      phase.value = 'idle'
    }
  }
)

const allIssues = computed<RuleIssue[]>(() => [
  ...(props.view?.issues ?? []),
  ...props.globalIssues
])

const grouped = computed(() => splitIssuesByScope(allIssues.value))

/** summary 已合并进 fields，直接取即可 */
function currentValue(key: string): string {
  return props.view?.fields[key] ?? ''
}

const previews = computed(() =>
  patches.value.map((p) => {
    const before = currentValue(p.field)
    const lines = diffLines(before, p.value)
    return { patch: p, before, lines, stat: diffStat(lines) }
  })
)

const acceptedCount = computed(
  () => previews.value.filter((p) => accepted.value[p.patch.field]).length
)

async function run() {
  const v = props.view
  if (!v) return
  if (!provider.ready) {
    message.warning('请先在模型设置里配置好供应商')
    return
  }
  if (!grouped.value.field.length) {
    message.info('没有可以靠改写字段修掉的问题')
    return
  }

  error.value = null
  try {
    const result = await pipeline.runFix(
      {
        schema: props.schema,
        fields: { ...v.fields },
        issues: grouped.value.field.map((i) => ({
          ruleId: i.ruleId,
          level: i.level,
          message: i.message,
          field: i.field
        })),
        groupBeats: v.beats,
        entities: props.entities,
        seamFromPrev: v.seam,
        nextSeam: v.nextSeam,
        segmentIndex: props.segmentIndex,
        segmentTotal: props.segmentTotal,
        frames: v.frames,
        instruction: instruction.value.trim() || undefined
      },
      props.settings
    )

    patches.value = result.patches
    unfixable.value = result.unfixable
    notes.value = result.notes
    accepted.value = Object.fromEntries(result.patches.map((p) => [p.field, true]))
    phase.value = 'preview'

    if (!result.patches.length) {
      message.warning('模型认为这些问题都改不了，见下方说明')
    }
  } catch (e) {
    error.value = (e as Error).message
  }
}

function apply() {
  const picked = patches.value.filter((p) => accepted.value[p.field])
  if (!picked.length) {
    message.warning('没有勾选任何改动')
    return
  }
  emit('apply', picked)
  emit('update:show', false)
}

function toggleAll(value: boolean) {
  accepted.value = Object.fromEntries(patches.value.map((p) => [p.field, value]))
}

function back() {
  phase.value = 'idle'
}

function scopeTagType(scope: 'field' | 'structure' | 'registry') {
  return scope === 'field' ? 'primary' : scope === 'structure' ? 'warning' : 'error'
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="AI 修复校验问题"
    style="max-width: 980px"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div v-if="!view" class="empty">没有选中段</div>

    <template v-else>
      <!-- 问题清单 -->
      <div class="row" style="gap: 10px; margin-bottom: 10px; flex-wrap: wrap">
        <n-tag size="small" type="primary" :bordered="false">
          可改写修复 {{ grouped.field.length }}
        </n-tag>
        <n-tag v-if="grouped.structure.length" size="small" type="warning" :bordered="false">
          需回前面阶段 {{ grouped.structure.length }}
        </n-tag>
        <n-tag v-if="grouped.registry.length" size="small" type="error" :bordered="false">
          需改注册表 {{ grouped.registry.length }}
        </n-tag>
        <span class="muted" style="font-size: 12.5px">
          共 {{ allIssues.length }} 个问题
        </span>
      </div>

      <n-alert v-if="phase === 'idle'" type="info" :bordered="false" style="margin-bottom: 12px">
        <div style="font-size: 12.5px; line-height: 1.7">
          模型只会被要求改写<span style="color: #2b56b8">「可改写修复」</span>的问题对应的字段
          —— 帧数超限、缺少预备镜头这类结构性问题，改字段是修不掉的，需要回前面的阶段。
          <br />
          <code>&lt;d&gt;</code> 里的中文台词会被要求逐字保留，只允许修正标签外的部分。
        </div>
      </n-alert>

      <div class="scroll-pane" style="max-height: 320px">
        <div v-if="!allIssues.length" class="empty">本段目前没有校验问题</div>

        <div v-for="scope in (['field', 'structure', 'registry'] as const)" :key="scope">
          <template v-if="grouped[scope].length">
            <div class="row" style="gap: 8px; margin: 8px 0 6px">
              <n-tag size="small" :type="scopeTagType(scope)" :bordered="false">
                {{ scope === 'field' ? '可改写修复' : scope === 'structure' ? '结构性' : '注册表' }}
              </n-tag>
              <span class="muted" style="font-size: 12px">{{ SCOPE_HINT[scope] }}</span>
            </div>
            <div class="stack" style="gap: 4px; margin-bottom: 12px">
              <div
                v-for="(i, k) in grouped[scope]"
                :key="k"
                class="issue"
                :class="i.level"
              >
                <span class="mono" style="opacity: 0.7; flex: 0 0 auto">{{ i.ruleId }}</span>
                <span v-if="i.field" class="tag-chip" style="background: #eef1f6; color: #5b6273">
                  {{ i.field }}
                </span>
                <span>{{ i.message }}</span>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- 附加要求 -->
      <div v-if="phase === 'idle'" style="margin-top: 14px">
        <div class="muted beat-label">附加要求（可选）</div>
        <n-input
          size="small"
          :value="instruction"
          placeholder="例如：顺带把烟气的描写统一成 purple mist，不要改动其他措辞"
          @update:value="(v: string) => (instruction = v)"
        />
      </div>

      <div v-if="error" class="issue error" style="margin-top: 12px">{{ error }}</div>

      <!-- 修复预览 -->
      <template v-if="phase === 'preview'">
        <div class="row-between" style="margin: 16px 0 8px">
          <div class="row" style="gap: 8px">
            <span style="font-weight: 600">修复预览</span>
            <n-tag size="small" :bordered="false">
              勾选 {{ acceptedCount }} / {{ previews.length }}
            </n-tag>
          </div>
          <div class="row" style="gap: 6px">
            <n-button size="tiny" quaternary @click="toggleAll(true)">全选</n-button>
            <n-button size="tiny" quaternary @click="toggleAll(false)">全不选</n-button>
          </div>
        </div>

        <div v-if="notes" class="issue info" style="margin-bottom: 10px">
          {{ notes }}
        </div>

        <div class="scroll-pane" style="max-height: 380px">
          <div v-for="p in previews" :key="p.patch.field" class="field-card" style="margin-bottom: 10px">
            <div class="field-head">
              <div class="row" style="gap: 8px">
                <n-checkbox
                  :checked="!!accepted[p.patch.field]"
                  @update:checked="(v: boolean) => (accepted[p.patch.field] = v)"
                />
                <span class="mono" style="font-weight: 600">{{ p.patch.field }}</span>
                <span
                  v-if="p.stat.changed"
                  class="tag-chip"
                  style="background: #e9f7ef; color: #217a52"
                >
                  +{{ p.stat.added }} / -{{ p.stat.removed }}
                </span>
                <span v-else class="tag-chip" style="background: #f2f4f7; color: #5b6273">
                  无变化
                </span>
              </div>
              <span class="muted" style="font-size: 12px">{{ p.patch.reason }}</span>
            </div>
            <div class="field-body">
              <div
                v-for="(line, li) in p.lines"
                :key="li"
                class="mono"
                :style="{
                  fontSize: '12.5px',
                  lineHeight: '1.6',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  padding: '0 4px',
                  borderRadius: '3px',
                  background:
                    line.op === 'add' ? '#e9f7ef' : line.op === 'del' ? '#fdecec' : 'transparent',
                  color: line.op === 'del' ? '#a12d2d' : line.op === 'add' ? '#217a52' : 'inherit',
                  textDecoration: line.op === 'del' ? 'line-through' : 'none'
                }"
              >
                {{ line.op === 'add' ? '+ ' : line.op === 'del' ? '- ' : '  ' }}{{ line.text }}
              </div>
            </div>
          </div>
        </div>

        <div v-if="unfixable.length" style="margin-top: 12px">
          <div class="muted beat-label">模型认为改不了、需要你手工处理</div>
          <div class="stack" style="gap: 4px">
            <div v-for="(u, k) in unfixable" :key="k" class="issue warn">{{ u }}</div>
          </div>
        </div>
      </template>
    </template>

    <template #footer>
      <div class="row-between">
        <span class="muted" style="font-size: 12.5px">
          {{ pipeline.running ? pipeline.progress : '改动会写回对应字段，可随时用「恢复自动」撤销' }}
        </span>
        <div class="row" style="gap: 8px">
          <n-button v-if="phase === 'preview'" @click="back">重新生成</n-button>
          <n-button @click="emit('update:show', false)">取消</n-button>
          <n-button
            v-if="phase === 'idle'"
            type="primary"
            :loading="pipeline.running"
            :disabled="!provider.ready || !grouped.field.length"
            @click="run"
          >
            AI 修复（{{ grouped.field.length }}）
          </n-button>
          <n-button v-else type="primary" :disabled="!acceptedCount" @click="apply">
            应用 {{ acceptedCount }} 项改动
          </n-button>
        </div>
      </div>
    </template>
  </n-modal>
</template>
