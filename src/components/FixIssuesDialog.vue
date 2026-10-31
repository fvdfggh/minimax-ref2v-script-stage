<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NAlert, NButton, NCheckbox, NInput, NModal, useMessage } from 'naive-ui'
import { usePipelineStore } from '@/stores/pipeline'
import { useProviderStore } from '@/stores/provider'
import { splitIssuesByScope, SCOPE_HINT, type RuleIssue } from '@/domain/rules'
import { diffLines, diffStat } from '@/core/diff'
import type { FixPatch } from '@/core/llm/prompts'
import type { SegmentView } from '@/stores/assembly'
import type { Entity, FieldSchema, ID, ProjectSettings } from '@/domain/types'
import InfoTip from '@/components/common/InfoTip.vue'

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
  // 读交付口径：en 模式下要修的是英文终稿那份
  return props.view?.delivery[key] ?? ''
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

/** 三个 scope 各自一个颜色身份：能改的蓝、要回前面的琥珀、要改注册表的红 */
function scopeChip(scope: 'field' | 'structure' | 'registry') {
  return scope === 'field' ? 'info' : scope === 'structure' ? 'warn' : 'err'
}

function scopeLabel(scope: 'field' | 'structure' | 'registry') {
  return scope === 'field' ? '可改写修复' : scope === 'structure' ? '结构性' : '注册表'
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

    <div v-else class="fx-body">
      <!-- 问题统计 -->
      <div class="fx-stats">
        <span class="chip" :class="grouped.field.length ? 'info' : 'mute'">
          可改写修复 {{ grouped.field.length }}
        </span>
        <span v-if="grouped.structure.length" class="chip warn">
          需回前面阶段 {{ grouped.structure.length }}
        </span>
        <span v-if="grouped.registry.length" class="chip err">
          需改注册表 {{ grouped.registry.length }}
        </span>
        <span class="fx-total">共 {{ allIssues.length }} 个问题</span>
      </div>

      <n-alert v-if="phase === 'idle'" type="info" :bordered="false">
        <div class="fx-alert">
          模型只改写<span class="fx-em">「可改写修复」</span>这一类问题
          <InfoTip
            :width="380"
            text="帧数超限、缺少预备镜头这类结构性问题改字段是修不掉的，需要回前面的阶段。&#10;<d> 里的中文台词会被要求逐字保留，只允许修正标签外的部分。"
          />
        </div>
      </n-alert>

      <!-- 问题清单 -->
      <section class="fx-sec t-amber">
        <div class="fx-sec-h">问题清单<span class="fx-ro">按处理方式分组</span></div>

        <div class="fx-pane">
          <div v-if="!allIssues.length" class="empty">本段目前没有校验问题</div>

          <div v-for="scope in (['field', 'structure', 'registry'] as const)" :key="scope">
            <template v-if="grouped[scope].length">
              <div class="fx-group">
                <span class="chip" :class="scopeChip(scope)">
                  {{ scopeLabel(scope) }} · {{ grouped[scope].length }}
                </span>
                <span class="fx-hint">{{ SCOPE_HINT[scope] }}</span>
              </div>
              <div class="fx-list">
                <div v-for="(i, k) in grouped[scope]" :key="k" class="issue" :class="i.level">
                  <span class="mono fx-rule">{{ i.ruleId }}</span>
                  <span v-if="i.field" class="chip mute">{{ i.field }}</span>
                  <span class="fx-msg">{{ i.message }}</span>
                </div>
              </div>
            </template>
          </div>
        </div>
      </section>

      <!-- 附加要求 -->
      <div v-if="phase === 'idle'" class="fx-field">
        <div class="fx-l">附加要求<span class="fx-hint">可选</span></div>
        <n-input
          size="small"
          :value="instruction"
          placeholder="例如：顺带把烟气的描写统一成 purple mist，不要改动其他措辞"
          @update:value="(v: string) => (instruction = v)"
        />
      </div>

      <div v-if="error" class="issue error">{{ error }}</div>

      <!-- 修复预览 -->
      <template v-if="phase === 'preview'">
        <section class="fx-sec t-blue">
          <div class="fx-sec-h">
            修复预览
            <span class="chip mute">勾选 {{ acceptedCount }} / {{ previews.length }}</span>
            <div class="fx-actions">
              <n-button size="tiny" quaternary @click="toggleAll(true)">全选</n-button>
              <n-button size="tiny" quaternary @click="toggleAll(false)">全不选</n-button>
            </div>
          </div>

          <div v-if="notes" class="issue info">{{ notes }}</div>

          <div class="fx-pane tall">
            <div v-for="p in previews" :key="p.patch.field" class="field-card fx-card">
              <div class="field-head">
                <div class="fx-card-l">
                  <n-checkbox
                    :checked="!!accepted[p.patch.field]"
                    @update:checked="(v: boolean) => (accepted[p.patch.field] = v)"
                  />
                  <span class="mono fx-fname">{{ p.patch.field }}</span>
                  <span v-if="p.stat.changed" class="chip ok">
                    +{{ p.stat.added }} / -{{ p.stat.removed }}
                  </span>
                  <span v-else class="chip mute">无变化</span>
                </div>
                <span class="fx-hint">{{ p.patch.reason }}</span>
              </div>
              <div class="field-body fx-diff">
                <div
                  v-for="(line, li) in p.lines"
                  :key="li"
                  class="mono fx-line"
                  :class="line.op"
                >{{ line.op === 'add' ? '+ ' : line.op === 'del' ? '- ' : '  ' }}{{ line.text }}</div>
              </div>
            </div>
          </div>
        </section>

        <section v-if="unfixable.length" class="fx-sec t-slate">
          <div class="fx-sec-h">模型认为改不了、需要你手工处理</div>
          <div class="fx-list">
            <div v-for="(u, k) in unfixable" :key="k" class="issue warn">{{ u }}</div>
          </div>
        </section>
      </template>
    </div>

    <template #footer>
      <div class="row-between">
        <span class="muted fx-foot">
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

<style scoped>
.fx-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

/* ---------- 统计 ---------- */
.fx-stats {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.fx-total {
  font-size: var(--fs-sm);
  color: var(--muted);
}
.fx-alert {
  font-size: var(--fs-base);
  line-height: 1.7;
}
.fx-em {
  color: var(--accent-ink);
  font-weight: 600;
}

/* ---------- 段 ---------- */
.fx-sec {
  --mod: var(--m-amber);
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.fx-sec.t-blue {
  --mod: var(--m-blue);
}
.fx-sec.t-slate {
  --mod: var(--m-slate);
}
.fx-sec-h {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.4px;
  color: var(--text-2);
}
.fx-sec-h::before {
  content: '';
  width: 14px;
  height: 3px;
  border-radius: 2px;
  background: var(--mod);
}
.fx-ro {
  font-weight: 400;
  font-size: var(--fs-xs);
  letter-spacing: 0;
  color: var(--muted);
}
.fx-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

/* ---------- 清单 ---------- */
.fx-pane {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
  padding: 8px 9px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel-2);
}
.fx-pane.tall {
  max-height: 380px;
}
.fx-group {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  margin: 2px 0 4px;
}
.fx-hint {
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--muted);
}.fx-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.fx-rule {
  flex: 0 0 auto;
  opacity: 0.7;
}
.fx-msg {
  min-width: 0;
}

/* ---------- 字段 ---------- */
.fx-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.fx-l {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-sm);
  color: var(--label);
}

/* ---------- 预览 ---------- */
.fx-card {
  min-width: 0;
  background: var(--panel);
  border-color: var(--line-strong);
}
.fx-card + .fx-card {
  margin-top: 0;
}
.fx-card .field-head {
  background: var(--panel-3);
}
.fx-card-l {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.fx-fname {
  font-weight: 600;
  font-size: var(--fs-base);
}
.fx-diff {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.fx-line {
  padding: 0 4px;
  border-radius: 3px;
  font-size: var(--fs-base);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-2);
}
.fx-line.add {
  background: var(--ok-soft);
  color: var(--ok-ink);
}
.fx-line.del {
  background: var(--err-soft);
  color: var(--err-ink);
  text-decoration: line-through;
}

.fx-foot {
  font-size: var(--fs-base);
}
</style>
