<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NAlert,
  NButton,
  NCheckbox,
  NDrawer,
  NDrawerContent,
  NInput,
  NModal,
  useMessage
} from 'naive-ui'
import { useAdviceStore } from '@/stores/advice'
import { useAssemblyStore } from '@/stores/assembly'
import { useBeatStore } from '@/stores/beats'
import { usePipelineStore } from '@/stores/pipeline'
import { useProjectStore } from '@/stores/project'
import { useProviderStore } from '@/stores/provider'
import { useRegistryStore } from '@/stores/registry'
import { ADVICE_STAGE_LABEL } from '@/core/llm/advice'
import type {
  AdviceStage,
  AdviceInput,
  AdviceSegmentBrief,
  StageAdvice
} from '@/core/llm/advice'
import type { Beat, Entity } from '@/domain/types'

const props = defineProps<{
  stage: AdviceStage
  /** 收紧模型可改的范围 */
  scope?: AdviceInput['scope']
  placeholder?: string
  /** 直接给几句常用说法，省得每次从零组织语言 */
  presets?: string[]
}>()

const emit = defineEmits<{ applied: [] }>()

const advice = useAdviceStore()
const project = useProjectStore()
const beats = useBeatStore()
const registry = useRegistryStore()
const assembly = useAssemblyStore()
const pipeline = usePipelineStore()
const provider = useProviderStore()
const message = useMessage()

const request = ref('')
/** 意见抽屉是否展开 */
const panelOpen = ref(false)
/** 改动审查弹窗是否展开 */
const open = ref(false)
const busy = ref(false)
const result = ref<StageAdvice | null>(null)
const picked = ref<Set<string>>(new Set())
const report = ref<string[]>([])

const ordered = computed(() => beats.ordered)
const settings = computed(() => project.settings)

/** 需要分组/段字段的阶段才算视图，前面的阶段没必要付这份开销 */
const withSegments = computed(() => props.stage !== 'split' && props.stage !== 'enrich')

const views = computed(() => {
  if (!withSegments.value) return []
  const asm = assembly.current
  if (!asm) return []
  return assembly.buildSegmentViews(
    asm,
    ordered.value,
    settings.value,
    registry.entityById,
    project.fieldSchema
  )
})

const segmentBriefs = computed<AdviceSegmentBrief[]>(() =>
  views.value.map((v, i) => ({ index: i + 1, beats: v.beats, fields: v.fields, stale: v.stale }))
)

const groupIds = computed(() => views.value.map((v) => v.group.id))

/* --------------------------- 变更预览 --------------------------- */

interface ChangeRow {
  key: string
  kind: '实体' | '片段' | '分段' | '字段'
  op: string
  target: string
  changes: Array<{ label: string; before: string; after: string }>
  reason?: string
}

const OP_LABEL: Record<string, string> = {
  update: '修改',
  insert: '新增',
  delete: '删除',
  split: '切开',
  merge: '合并',
  refPrev: '引用上段'
}

function beatAt(n?: number): Beat | undefined {
  if (!n || n < 1) return undefined
  return ordered.value[n - 1]
}

function entityOf(name: string): Entity | undefined {
  return registry.entities.find((e) => e.name === name)
}

/**
 * 只渲染真正会变的字段。
 * after === null 表示「清空」，显示成（清空）；
 * after === undefined 表示「不改」，此时 after 收敛成 '' 与 before 相等，会被过滤掉。
 */
function diff(
  label: string,
  before: string | null | undefined,
  after: string | null | undefined
) {
  const b = (before ?? '').trim()
  const a = (after ?? '').trim()
  if (a === '' && b === '') return null
  if (b === a) return null
  return { label, before: b || '（空）', after: after === null ? '（清空）' : a || '（空）' }
}

const rows = computed<ChangeRow[]>(() => {
  const a = result.value
  if (!a) return []
  const out: ChangeRow[] = []

  ;(a.entities ?? []).forEach((p, i) => {
    const cur = entityOf(p.name)
    const changes = [
      diff('类型', cur?.type, p.type),
      diff('说话', cur?.kind, p.kind),
      diff('音色', cur?.voiceDesc ?? undefined, p.voiceDesc),
      diff('外观', cur?.textDesc ?? undefined, p.textDesc),
      diff('英文名', cur?.nameEn ?? undefined, p.nameEn),
      diff('英文音色', cur?.voiceDescEn ?? undefined, p.voiceDescEn),
      diff('英文外观', cur?.textDescEn ?? undefined, p.textDescEn)
    ].filter(Boolean)
    out.push({
      key: `e${i}`,
      kind: '实体',
      op: p.op,
      target: `${p.name}${cur ? '' : '（新建）'}`,
      changes: changes as ChangeRow['changes'],
      reason: p.reason
    })
  })

  ;(a.beats ?? []).forEach((p, i) => {
    const cur = p.op === 'insert' ? undefined : beatAt(p.index)
    const label = p.op === 'insert' ? `插到 #${p.afterIndex ?? 0} 之后` : `#${p.index}`
    const changes = [
      diff('标题', cur?.title, p.title),
      diff('类型', cur?.kind, p.kind),
      diff('台词', cur?.dialogue ?? undefined, p.dialogue),
      diff('运镜', cur?.direction ?? undefined, p.direction),
      diff('画面', cur?.visualDesc ?? undefined, p.visualDesc),
      diff('场景', cur?.sceneId ? registry.entityById.get(cur.sceneId)?.name : undefined, p.scene),
      diff('说话人', cur?.speakerId ? registry.entityById.get(cur.speakerId)?.name : undefined, p.speaker),
      diff('聚焦', cur?.focusEntityId ? registry.entityById.get(cur.focusEntityId)?.name : undefined, p.focus),
      p.entities
        ? diff(
            '主体',
            (cur?.entities ?? []).map((id) => registry.entityById.get(id)?.name).filter(Boolean).join('+'),
            p.entities.join('+')
          )
        : null,
      diff('英文标题', cur?.titleEn, p.titleEn),
      diff('英文运镜', cur?.directionEn, p.directionEn),
      diff('英文画面', cur?.visualDescEn, p.visualDescEn)
    ].filter(Boolean)
    out.push({
      key: `b${i}`,
      kind: '片段',
      op: p.op,
      target: label,
      changes: changes as ChangeRow['changes'],
      reason: p.reason
    })
  })

  ;(a.groups ?? []).forEach((p, i) => {
    const target =
      p.op === 'split'
        ? `在片段 #${p.atBeatIndex} 之前切开`
        : p.op === 'merge'
          ? `第 ${p.fromSegment} ~ ${p.toSegment} 段合并`
          : `第 ${p.segment} 段`
    const changes =
      p.op === 'refPrev' ? [{ label: '引用上段', before: '—', after: p.refPrev ? '是' : '否' }] : []
    out.push({ key: `g${i}`, kind: '分段', op: p.op, target, changes, reason: p.reason })
  })

  ;(a.fields ?? []).forEach((p, i) => {
    const cur = views.value[p.segment - 1]?.fields[p.key] ?? ''
    out.push({
      key: `f${i}`,
      kind: '字段',
      op: 'update',
      target: `第 ${p.segment} 段 · ${p.key}`,
      changes: [{ label: p.key, before: cur.trim() || '（空）', after: p.value.trim() || '（空）' }],
      reason: p.reason
    })
  })

  return out
})

const skippedRows = computed(() => rows.value.filter((r) => r.changes.length === 0 && r.kind !== '分段'))

/* --------------------------- 交互 --------------------------- */

async function ask() {
  const text = request.value.trim()
  if (!text) {
    message.warning('先说说你想改什么')
    return
  }
  if (!provider.ready) {
    message.warning('请先在模型设置里配置好供应商')
    return
  }
  busy.value = true
  report.value = []
  try {
    const res = await pipeline.runAdvice({
      stage: props.stage,
      request: text,
      beats: ordered.value,
      entities: registry.entities,
      groups: assembly.current?.groups,
      segments: segmentBriefs.value.length ? segmentBriefs.value : undefined,
      schema: project.fieldSchema,
      scope: props.scope
    })
    result.value = res
    // 默认全选"确实会改东西"的条目
    picked.value = new Set(rows.value.filter((r) => r.changes.length > 0 || r.kind === '分段').map((r) => r.key))
    // 抽屉让位给审查弹窗，免得两层浮层叠在一起
    panelOpen.value = false
    open.value = true
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    busy.value = false
  }
}

function toggle(key: string) {
  const next = new Set(picked.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  picked.value = next
}

/** 只把勾选的补丁交回去，其余丢掉 */
function filtered(): StageAdvice | null {
  const a = result.value
  if (!a) return null
  return {
    summary: a.summary,
    entities: (a.entities ?? []).filter((_, i) => picked.value.has(`e${i}`)),
    beats: (a.beats ?? []).filter((_, i) => picked.value.has(`b${i}`)),
    groups: (a.groups ?? []).filter((_, i) => picked.value.has(`g${i}`)),
    fields: (a.fields ?? []).filter((_, i) => picked.value.has(`f${i}`)),
    notes: a.notes
  }
}

async function confirm() {
  const a = filtered()
  if (!a) return
  if (!picked.value.size) {
    message.info('没有勾选任何改动')
    return
  }
  busy.value = true
  try {
    const res = await advice.apply(a, groupIds.value)
    open.value = false
    request.value = ''

    const lines: string[] = []
    if (res.entities.inserted || res.entities.updated || res.entities.deleted) {
      lines.push(
        `实体：新增 ${res.entities.inserted} · 修改 ${res.entities.updated} · 删除 ${res.entities.deleted}`
      )
    }
    if (res.beats.inserted || res.beats.updated || res.beats.deleted) {
      lines.push(
        `片段：新增 ${res.beats.inserted} · 修改 ${res.beats.updated} · 删除 ${res.beats.deleted}`
      )
    }
    if (res.groups.split || res.groups.merged || res.groups.refPrev) {
      lines.push(`分段：切开 ${res.groups.split} · 合并 ${res.groups.merged} · 引用上段 ${res.groups.refPrev}`)
    }
    if (res.fields.updated) lines.push(`段字段：修改 ${res.fields.updated}`)
    if (res.adopted) lines.push(`新增的 ${res.adopted} 个片段已自动并入相邻段`)
    if (res.dropped) lines.push(`${res.dropped} 个已删除片段的引用已从分段里清掉`)
    if (res.renumbered) lines.push(`重算了 ${res.renumbered} 个实体的编号`)

    report.value = [...lines, ...res.skipped]
    message.success('已应用改动')
    emit('applied')

    // 上游一变，后面的阶段就会过期，这里直接说清楚
    const dirty =
      res.beats.inserted +
      res.beats.updated +
      res.beats.deleted +
      res.entities.inserted +
      res.entities.updated +
      res.entities.deleted
    if (dirty && withSegments.value) {
      message.info('受影响的段字段已标记为需要重新生成，去「④ 字段补全」处理', { duration: 5000 })
    }
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <!--
    外壳本身不占布局：入口是 fixed 悬浮按钮，抽屉/弹窗都走 Teleport。
    所以放在页面哪个位置都行，各阶段不用再为它留版面。
  -->
  <div>
    <button
      class="advice-fab"
      type="button"
      :title="`${ADVICE_STAGE_LABEL[stage]} · 提意见`"
      @click="panelOpen = true"
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.4H8l-4.5 3v-6.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" />
      </svg>
      提意见
      <span v-if="report.length" class="advice-fab-dot" />
    </button>

    <n-drawer v-model:show="panelOpen" :width="440" placement="right">
      <n-drawer-content closable>
        <template #header>提意见</template>

        <div class="stack" style="gap: 12px">
          <div class="muted" style="font-size: 12.5px; line-height: 1.75">
            {{ ADVICE_STAGE_LABEL[stage] }} · 模型只负责判断「哪些对象要改、改成什么」，
            输出结构化补丁；你逐条确认之后才会写进库。
          </div>

          <n-input
            v-model:value="request"
            type="textarea"
            :rows="7"
            :placeholder="
              placeholder ?? '例如：第 3 到第 5 个片段其实是连续的一个长动作，帮我拆细一点'
            "
            @keydown.ctrl.enter="ask"
          />

          <div v-if="presets?.length" class="stack" style="gap: 6px">
            <div class="muted" style="font-size: 12px">常用说法</div>
            <div class="row" style="gap: 6px; flex-wrap: wrap; align-items: flex-start">
              <button
                v-for="(p, i) in presets"
                :key="i"
                class="advice-preset"
                type="button"
                @click="request = p"
              >
                {{ p }}
              </button>
            </div>
          </div>

          <n-button
            type="primary"
            block
            :loading="busy || pipeline.running"
            :disabled="!provider.ready"
            @click="ask"
          >
            {{ pipeline.running ? pipeline.progress : '分析' }}
          </n-button>

          <n-alert v-if="!provider.ready" type="warning" :bordered="false">
            还没配置模型供应商，先去右上角「模型设置」。
          </n-alert>

          <div v-if="report.length" class="stack" style="gap: 4px">
            <div class="muted" style="font-size: 12px">上次应用的结果</div>
            <div v-for="(line, i) in report" :key="i" class="issue info">{{ line }}</div>
          </div>
        </div>
      </n-drawer-content>
    </n-drawer>

    <n-modal v-model:show="open" preset="card" title="确认改动" style="max-width: 880px">
      <n-alert v-if="result?.summary" type="info" :bordered="false" style="margin-bottom: 10px">
        {{ result.summary }}
      </n-alert>

      <div class="row-between" style="margin-bottom: 8px">
        <span class="muted" style="font-size: 12.5px">
          勾选要应用的条目。没被点到的对象模型不会动，也不会顺手润色。
        </span>
        <div class="row" style="gap: 6px">
          <n-button size="tiny" quaternary @click="picked = new Set(rows.map((r) => r.key))">
            全选
          </n-button>
          <n-button size="tiny" quaternary @click="picked = new Set()">全不选</n-button>
        </div>
      </div>

      <div v-if="!rows.length" class="empty" style="padding: 24px">
        <div>模型没有给出任何改动</div>
        <div class="muted" style="font-size: 12px; margin-top: 6px">
          可能是你的意见本身不需要改结构，或者诉求它判断表达不了 —— 看下面的说明
        </div>
      </div>

      <div class="scroll-pane" style="max-height: 52vh; padding-right: 4px">
        <div class="stack" style="gap: 8px">
          <div
            v-for="r in rows"
            :key="r.key"
            class="panel"
            :style="{
              padding: '9px 11px',
              opacity: picked.has(r.key) ? 1 : 0.5,
              borderColor: picked.has(r.key) ? 'var(--accent)' : 'var(--line)'
            }"
          >
            <div class="row" style="gap: 8px; align-items: center">
              <n-checkbox
                :checked="picked.has(r.key)"
                @update:checked="() => toggle(r.key)"
              />
              <span class="tag-chip" style="background: #eef1f6; color: #5b6273">{{ r.kind }}</span>
              <span class="tag-chip" :style="{ background: r.op === 'delete' ? '#fdecec' : '#e9f7ef', color: r.op === 'delete' ? '#a12d2d' : '#217a52' }">
                {{ OP_LABEL[r.op] ?? r.op }}
              </span>
              <span style="font-weight: 600; font-size: 13px">{{ r.target }}</span>
            </div>

            <div v-if="r.reason" class="muted" style="font-size: 12px; margin-top: 5px">
              {{ r.reason }}
            </div>

            <div v-if="r.changes.length" class="stack" style="gap: 3px; margin-top: 7px">
              <div
                v-for="(c, i) in r.changes"
                :key="i"
                class="row"
                style="gap: 8px; font-size: 12px; align-items: flex-start"
              >
                <span class="muted" style="width: 64px; flex: 0 0 64px">{{ c.label }}</span>
                <span
                  class="mono"
                  style="flex: 1; color: #a12d2d; text-decoration: line-through; word-break: break-word"
                >
                  {{ c.before }}
                </span>
                <span class="muted">→</span>
                <span class="mono" style="flex: 1; color: #217a52; word-break: break-word">
                  {{ c.after }}
                </span>
              </div>
            </div>
            <div v-else-if="r.kind !== '分段'" class="muted" style="font-size: 12px; margin-top: 5px">
              没有实际变化，勾了也不会改
            </div>
          </div>
        </div>
      </div>

      <n-alert v-if="result?.notes" type="warning" :bordered="false" style="margin-top: 10px">
        {{ result.notes }}
      </n-alert>
      <div v-if="skippedRows.length" class="muted" style="font-size: 12px; margin-top: 8px">
        其中 {{ skippedRows.length }} 条没有实际变化
      </div>

      <template #footer>
        <div class="row-between">
          <span class="muted" style="font-size: 12px">
            应用后：编号会重算，新片段会并入相邻段，受影响的段字段会标记为需要重新生成
          </span>
          <div class="row" style="gap: 8px">
            <n-button @click="open = false">取消</n-button>
            <n-button type="primary" :loading="busy" :disabled="!picked.size" @click="confirm">
              应用选中（{{ picked.size }}）
            </n-button>
          </div>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
/*
 * 悬浮入口：固定在右下角。
 * z-index 给 1500 —— 高于页面内的任何面板，低于 naive-ui 的浮层（2000 起），
 * 这样它不会被右侧滚动区盖住而点不到，也不会盖住抽屉和弹窗。
 * 这里刻意不写 :disabled 样式：这个入口永远可点，供应商没配好时
 * 在抽屉里提示，而不是把功能整个藏起来。
 */
.advice-fab {
  position: fixed;
  right: 22px;
  bottom: 22px;
  z-index: 1500;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 10px 16px;
  border: none;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-family: inherit;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 6px 18px rgba(59, 110, 245, 0.34);
  transition: transform 0.15s, box-shadow 0.15s, opacity 0.15s;
}

.advice-fab:hover {
  transform: translateY(-1px);
  box-shadow: 0 9px 24px rgba(59, 110, 245, 0.42);
}

.advice-fab:active {
  transform: translateY(0);
}

/* 有上次结果时点一个小圆点，提示"抽屉里还有东西" */
.advice-fab-dot {
  position: absolute;
  top: 5px;
  right: 7px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 0 2px var(--accent);
}

.advice-preset {
  padding: 3px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
  color: var(--muted);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.advice-preset:hover {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
