<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useRegistryStore } from '@/stores/registry'
import { useAssemblyStore } from '@/stores/assembly'
import { usePipelineStore } from '@/stores/pipeline'
import { useProviderStore } from '@/stores/provider'
import FieldRow from '@/components/FieldRow.vue'
import { useSyncItems } from '@/composables/useSyncItems'
import { batchOf, changedText, type SyncAction, type SyncBatch, type SyncItem } from '@/domain/fieldSync'
import type { ID } from '@/domain/types'
import InfoTip from '@/components/common/InfoTip.vue'

const project = useProjectStore()
const registry = useRegistryStore()
const assembly = useAssemblyStore()
const pipeline = usePipelineStore()
const provider = useProviderStore()
const message = useMessage()

const settings = computed(() => project.settings)
const schema = computed(() => project.fieldSchema)

// 清单与判定都在 domain/fieldSync，这里只拿结果
const { views, items, stats } = useSyncItems()

type FilterKey = 'all' | 'zh' | 'en' | 'src' | 'manual'
const filter = ref<FilterKey>('all')

const counts = computed(() => ({
  all: items.value.length,
  zh: items.value.filter((i) => i.changed === 'zh' && !i.needsManual).length,
  en: items.value.filter((i) => i.changed === 'en').length,
  src: items.value.filter((i) => i.changed === 'src').length,
  manual: items.value.filter((i) => i.needsManual).length
}))

const filters: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'zh', label: '中文改了' },
  { key: 'en', label: '英文改了' },
  { key: 'src', label: '引用变了' },
  { key: 'manual', label: '待人工' }
]

const shown = computed(() =>
  filter.value === 'all'
    ? items.value
    : items.value.filter((i) =>
        filter.value === 'manual'
          ? i.needsManual
          : filter.value === 'zh'
            ? i.changed === 'zh' && !i.needsManual
            : i.changed === filter.value
      )
)

/** 按段分组：一次请求处理一段，列表也按段看 */
const groups = computed(() => {
  const map = new Map<ID, { segNo: number; items: SyncItem[] }>()
  for (const it of shown.value) {
    let g = map.get(it.groupId)
    if (!g) {
      g = { segNo: it.segNo, items: [] }
      map.set(it.groupId, g)
    }
    g.items.push(it)
  }
  return [...map.entries()]
    .map(([groupId, g]) => ({ groupId, ...g }))
    .sort((a, b) => a.segNo - b.segNo)
})

/* ------------------------------------------------------------------ *
 * 执行
 * ------------------------------------------------------------------ */

const busy = ref<Record<string, boolean>>({})
const runningAll = ref(false)
const progress = ref('')

function segLabel(n: number): string {
  return `seg${String(n).padStart(2, '0')}`
}

/** 中英译名对照表：中文名 → 英文名 */
function entityNameMap(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of registry.entities) {
    if (e.nameEn?.trim()) out[e.name] = e.nameEn.trim()
  }
  return out
}

/** summary 有独立存储位，必须单独写 */
async function writeSide(pid: ID, groupId: ID, fields: Record<string, string>, lang: 'zh' | 'en') {
  if (!Object.keys(fields).length) return
  const summary = fields.summary
  const rest: Record<string, string> = { ...fields }
  delete rest.summary
  if (summary) await assembly.setSummary(pid, groupId, summary, lang)
  if (Object.keys(rest).length) await assembly.setFields(pid, groupId, rest, lang)
}

function pick(fields: Record<string, string>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of keys) if ((fields[k] ?? '').trim()) out[k] = fields[k]
  return out
}

/**
 * 同步一段。
 *
 * steps 来自清单：引用变了先重生成中文，再重译英文；
 * 只有中文变了就只翻译，只有英文变了就只回写中文。
 * 手动指定方向（待人工那一类）时只跑指定的一步。
 */
async function runOne(batch: SyncBatch, only?: SyncAction) {
  const pid = project.currentId
  if (!pid) return
  const v = views.value.find((x) => x.group.id === batch.groupId)
  if (!v) return
  if (!provider.ready) {
    message.warning('请先在模型设置里配置好供应商')
    return
  }

  const steps = only ? [only] : batch.steps
  busy.value = { ...busy.value, [batch.groupId]: true }
  try {
    const index = views.value.findIndex((x) => x.group.id === v.group.id)

    if (steps.includes('regen')) {
      progress.value = `${segLabel(batch.segNo)} 按新引用重生成中文…`
      const out = await pipeline.runSegmentFill(
        {
          schema: schema.value,
          groupBeats: v.beats,
          entities: registry.entities,
          seamFromPrev: v.seam,
          nextSeam: v.nextSeam,
          existing: { ...v.fields },
          segmentIndex: index,
          segmentTotal: views.value.length,
          frames: v.frames,
          language: 'zh'
        },
        settings.value
      )
      await writeSide(pid, v.group.id, out, 'zh')
      await assembly.markGenerated(pid, v.group.id, v.beats, registry.entities, v.frames)
    }

    if (steps.includes('translate')) {
      progress.value = `${segLabel(batch.segNo)} 重译英文…`
      const out = await pipeline.runLocalizeOne(
        {
          id: v.group.id,
          schema: schema.value,
          beats: v.beats,
          entities: registry.entities,
          fields: { ...v.fields },
          index,
          total: views.value.length,
          frames: v.frames,
          direction: 'zh2en'
        },
        settings.value,
        entityNameMap()
      )
      await writeSide(pid, v.group.id, pick(out, batch.keys), 'en')
    }

    if (steps.includes('backtranslate')) {
      progress.value = `${segLabel(batch.segNo)} 按英文回写中文…`
      const out = await pipeline.runLocalizeOne(
        {
          id: v.group.id,
          schema: schema.value,
          beats: v.beats,
          entities: registry.entities,
          fields: { ...v.fieldsEn },
          index,
          total: views.value.length,
          frames: v.frames,
          direction: 'en2zh'
        },
        settings.value,
        entityNameMap()
      )
      await writeSide(pid, v.group.id, pick(out, batch.keys), 'zh')
    }

    // 记下「这一段这几项此刻已经对齐」，之后谁再改都能立刻看出来
    await assembly.markSynced(pid, v.group.id, v.hash, batch.keys)
  } finally {
    const next = { ...busy.value }
    delete next[batch.groupId]
    busy.value = next
    progress.value = ''
  }
}

/** 单段同步：整段的全部待同步项一起处理 */
async function syncGroup(groupId: ID, only?: SyncAction) {
  const batch = batchOf(items.value).find((b) => b.groupId === groupId)
  if (!batch) {
    // 待人工的段没有自动步骤：按用户选的方向临时造一个批次
    const own = items.value.filter((i) => i.groupId === groupId)
    if (!own.length) return
    await runOne(
      {
        groupId,
        segNo: own[0].segNo,
        keys: own.map((i) => i.fieldKey),
        steps: only ? [only] : [],
        items: own
      },
      only
    )
    return
  }
  try {
    await runOne(batch, only)
    message.success(`${segLabel(batch.segNo)} 已同步`)
  } catch (e) {
    message.error(`${segLabel(batch.segNo)} 同步失败：${(e as Error).message}`, { duration: 6000 })
  }
}

/** 一键同步：按段串行跑，失败不停，最后统一报数 */
async function syncAll() {
  if (runningAll.value) return
  const batches = batchOf(items.value)
  if (!batches.length) {
    message.info('没有需要自动同步的内容')
    return
  }
  runningAll.value = true
  let ok = 0
  let fail = 0
  try {
    for (const b of batches) {
      try {
        await runOne(b)
        ok++
      } catch {
        fail++
      }
    }
  } finally {
    runningAll.value = false
    progress.value = ''
  }
  if (fail) message.warning(`同步完成：成功 ${ok} 段，失败 ${fail} 段`)
  else message.success(`同步完成：${ok} 段已对齐`)
}

/** 这一段点一下会发生什么：只翻译 / 只回写 / 重做 */
function groupAction(list: SyncItem[]): string {
  if (list.some((i) => i.needsManual)) return '先定方向'
  const steps = new Set(list.flatMap((i) => i.steps))
  if (steps.has('regen')) return '按新引用重做'
  if (steps.size === 1) return steps.has('translate') ? '重译英文' : '回写中文'
  return '同步这一段'
}

/** 段头那句方向说明；待人工时直说要人定 */
function groupHint(list: SyncItem[]): string {
  if (list.some((i) => i.needsManual)) return '两份都改过，需选一个方向'
  const steps = new Set(list.flatMap((i) => i.steps))
  if (steps.has('regen')) return '中文重生成后重译英文'
  if (steps.size === 1) return steps.has('translate') ? '英文对齐中文' : '中文对齐英文'
  return '中英互相补齐'
}

const manualCount = computed(() => stats.value.manual)
const busyAny = computed(() => runningAll.value || Object.keys(busy.value).length > 0)
</script>

<template>
  <div class="sync-page">
    <!-- 页头：只留数量与动作。段数、字段数这些细节在列表里都能看到 -->
    <div class="sy-head">
      <span class="sy-title">同步</span>
      <span class="sy-fact">{{ stats.total }} 项待同步</span>
      <span v-if="stats.segments" class="sy-fact dim">{{ stats.segments }} 段</span>
      <span v-if="manualCount" class="sy-fact err">{{ manualCount }} 项要你定</span>
      <span class="sy-spacer" />
      <span v-if="progress" class="sy-progress">{{ progress }}</span>
      <n-button size="small" :disabled="!items.length || busyAny" :loading="runningAll" @click="syncAll">
        全部同步（{{ stats.total }}）
      </n-button>
    </div>

    <!-- 一行说清这一页在做什么：不让用户猜"同步"是复制还是重写 -->
    <p class="sy-note">
      中英各存一份，把落后的一份按改过的那份重做
      <InfoTip
        size="sm"
        :width="360"
        text="哪一份刚被改过，另一份就落后了 —— 这里重做的就是落后那份。&#10;引用（片段或主体）改过时两份都算旧稿，一起重做。"
      />
    </p>

    <div class="sy-bar">
      <button
        v-for="f in filters"
        :key="f.key"
        class="sy-chip"
        :class="{ on: filter === f.key }"
        :disabled="!counts[f.key] && f.key !== 'all'"
        @click="filter = f.key"
      >
        {{ f.label }}<b>{{ counts[f.key] }}</b>
      </button>
    </div>

    <div class="sy-body">
      <!-- 空状态：说明"没有"和"还没做"是两回事 -->
      <div v-if="!items.length" class="sy-empty">
        <b>两份内容是对齐的</b>
        <span>中文、英文、以及它们引用的片段与主体，都没有不一致的地方。</span>
      </div>

      <template v-else>
        <section v-for="g in groups" :key="g.groupId" class="seg">
          <header class="seg-h">
            <span class="seg-no">{{ segLabel(g.segNo) }}</span>
            <span class="seg-count">{{ g.items.length }} 项</span>
            <span class="seg-todo">{{ groupHint(g.items) }}</span>
            <span class="sy-spacer" />
            <n-button
              size="tiny"
              :loading="busy[g.groupId]"
              :disabled="busyAny"
              @click="syncGroup(g.groupId)"
            >
              {{ groupAction(g.items) }}
            </n-button>
          </header>

          <FieldRow
            v-for="it in g.items"
            :key="it.id"
            class="item"
            :label="it.label"
            :field-key="it.fieldKey"
            :tone="it.needsManual ? 'warn' : 'plain'"
          >
            <span class="it-tag" :class="`k-${it.changed}`">{{ changedText(it) }}</span>
            <span class="it-why">{{ it.reason }}</span>

            <!--
              只有「待人工」的行才需要单独按钮：两份都改过，方向得人来定。
              其余行不重复给按钮 —— 同一段三项一起处理就够了，三个「回写中文」
              并排只会让人以为要一个个点。
            -->
            <template v-if="it.needsManual">
              <button class="it-act" @click="syncGroup(g.groupId, 'translate')">以中文为准</button>
              <button class="it-act" @click="syncGroup(g.groupId, 'backtranslate')">以英文为准</button>
            </template>
          </FieldRow>
        </section>

        <p v-if="manualCount" class="sy-foot">
          标「待人工」的字段两侧都被改过，方向得你来定
          <InfoTip
            size="sm"
            :width="340"
            text="自动同步无论选哪边都会丢掉一边的改动，所以这里只把两个方向摆出来，按你的判断点。"
          />
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 同一个视觉规则：一层边界（段间横线）、一种警示色、其余靠留白 */
.sync-page {
  height: 100%;
  overflow: auto;
  padding: 0 0 40px;
}

.sy-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 20px 10px;
}

.sy-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.sy-fact {
  font-size: 12px;
  color: var(--label);
}

.sy-fact.dim {
  color: var(--muted);
}

.sy-fact.err {
  color: var(--err);
}

.sy-spacer {
  flex: 1 1 auto;
}

.sy-progress {
  font-size: 11.5px;
  color: var(--muted);
}

.sy-note {
  margin: 0;
  padding: 0 20px 10px;
  font-size: 12px;
  line-height: 1.75;
  color: var(--muted);
}

.sy-bar {
  display: flex;
  gap: 6px;
  padding: 0 20px 10px;
}

.sy-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: transparent;
  color: var(--label);
  font-size: 11.5px;
  cursor: pointer;
}

.sy-chip b {
  font-weight: 600;
  font-size: 11px;
  color: var(--muted);
}

.sy-chip.on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.sy-chip.on b {
  color: var(--accent);
}

.sy-chip:disabled {
  opacity: 0.4;
  cursor: default;
}

.sy-body {
  padding: 0 20px;
}

.sy-empty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 40px 2px;
  font-size: 13px;
  color: var(--muted);
}

.sy-empty b {
  font-size: 14px;
  color: var(--text);
}

.seg {
  padding: 14px 0 6px;
  border-top: 1px solid var(--line);
}

.seg-todo {
  font-size: 11.5px;
  color: var(--muted);
}

.seg-h {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 4px;
}

.seg-no {
  font-family: var(--mono, monospace);
  font-size: 11.5px;
  color: var(--muted);
}

.seg-count {
  font-size: 11px;
  color: var(--muted);
}

/* 一条同步项：徽章上是字段名，条内左边「改了什么」，右边是方向按钮 */
.item {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 8px;
}

.it-tag {
  font-size: 11px;
  padding: 0 5px;
  border-radius: 3px;
  line-height: 16px;
}

.k-zh {
  color: var(--accent);
  background: var(--accent-soft);
}

.k-en {
  color: var(--warn, #b8860b);
  background: var(--warn-soft, rgba(184, 134, 11, 0.12));
}

.k-src {
  color: var(--err);
  background: var(--err-soft);
}

.it-align {
  font-size: 12px;
  color: var(--text);
}

.it-why {
  font-size: 11.5px;
  color: var(--muted);
}

.it-act {
  border: none;
  background: none;
  padding: 0;
  font-size: 12px;
  color: var(--accent);
  cursor: pointer;
}

.it-act:hover {
  text-decoration: underline;
}

.it-act:disabled {
  color: var(--muted);
  cursor: default;
  text-decoration: none;
}

.sy-foot {
  margin: 10px 0 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--muted);
}
</style>
