<script setup lang="ts">
import { computed, ref } from 'vue'
import { NAlert, NButton, NInput, NProgress, NSelect, NTag, useMessage } from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { useAssemblyStore, type SegmentView } from '@/stores/assembly'
import { usePipelineStore, type SegmentLocalizeTask } from '@/stores/pipeline'
import { useProviderStore } from '@/stores/provider'
import StageAdvice from '@/components/StageAdvice.vue'
import { hasCjkOutsideD } from '@/domain/lang'
import type { Beat, Entity, ID } from '@/domain/types'

const project = useProjectStore()
const beats = useBeatStore()
const registry = useRegistryStore()
const assembly = useAssemblyStore()
const pipeline = usePipelineStore()
const provider = useProviderStore()
const message = useMessage()

const concurrency = ref(2)
const busy = ref(false)
const showGlossary = ref(true)
const expanded = ref<ID | null>(null)
const failed = ref<Record<string, string>>({})

const settings = computed(() => project.settings)
const schema = computed(() => project.fieldSchema)
const llmFields = computed(() => schema.value.filter((f) => f.source === 'llm'))
const derivedKeys = computed(() => schema.value.filter((f) => f.source === 'derived').map((f) => f.key))
const finalMode = computed(() => settings.value.workLanguage === 'en')

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

/* --------------------------- 词条进度 --------------------------- */

function beatNeeds(b: Beat): boolean {
  if (!b.titleEn) return true
  if (b.direction && !b.directionEn) return true
  if (b.visualDesc && !b.visualDescEn) return true
  return false
}

function entityNeeds(e: Entity): boolean {
  if (!e.nameEn) return true
  if (e.textDesc && !e.textDescEn) return true
  if (e.voiceDesc && !e.voiceDescEn) return true
  return false
}

const pendingBeats = computed(() => beats.ordered.filter(beatNeeds))
const pendingEntities = computed(() => registry.entities.filter(entityNeeds))

/* --------------------------- 分批翻译 --------------------------- */

const GLOSSARY_BATCH_OPTIONS = [15, 20, 30, 50, 80].map((n) => ({ label: `${n} 条`, value: n }))

/** 词条表会被切成几批（实体批 + 片段批） */
const glossaryBatches = computed(() => {
  const size = Math.max(1, settings.value.glossaryBatchSize)
  const total = pendingBeats.value.length + pendingEntities.value.length
  return total ? Math.ceil(pendingEntities.value.length / size) + Math.ceil(pendingBeats.value.length / size) : 0
})

async function setGlossaryBatch(v: number) {
  await project.updateSettings({ glossaryBatchSize: v })
}

const glossaryStats = computed(() => {
  const total = beats.ordered.length + registry.entities.length
  const todo = pendingBeats.value.length + pendingEntities.value.length
  return { total, todo, done: total - todo }
})

/* --------------------------- 段字段进度 --------------------------- */

/** 该段还有哪些模型字段没英文化（<d> 之外残留中文） */
function pendingFields(v: SegmentView): string[] {
  return llmFields.value.map((f) => f.key).filter((k) => hasCjkOutsideD(v.fields[k]))
}

/** 该段是否已经没有任何中文残留（含引擎派生字段） */
function residualFields(v: SegmentView): string[] {
  return schema.value.map((f) => f.key).filter((k) => hasCjkOutsideD(v.fields[k]))
}

const segStats = computed(() => {
  let done = 0
  let todo = 0
  for (const v of views.value) {
    if (pendingFields(v).length) todo++
    else done++
  }
  return { done, todo, total: views.value.length }
})

const progressPercent = computed(() => {
  const total = glossaryStats.value.total + segStats.value.total
  if (!total) return 0
  return Math.round(((glossaryStats.value.done + segStats.value.done) / total) * 100)
})

/* --------------------------- 动作 --------------------------- */

async function localizeGlossary() {
  if (!provider.ready) {
    message.warning('请先在模型设置里配置好供应商')
    return
  }
  if (!pendingBeats.value.length && !pendingEntities.value.length) {
    message.info('所有词条都已翻译')
    return
  }
  busy.value = true
  try {
    const res = await pipeline.runGlossary(pendingBeats.value, pendingEntities.value, settings.value)
    if (res.beats.length) {
      await beats.patchBeats(
        res.beats.map((b) => ({
          id: b.id,
          patch: { titleEn: b.title || undefined, directionEn: b.direction || undefined, visualDescEn: b.visualDesc || undefined }
        }))
      )
    }
    if (res.entities.length) {
      await registry.patchEntities(
        res.entities.map((e) => ({
          id: e.id,
          patch: { nameEn: e.name || undefined, voiceDescEn: e.voiceDesc || undefined, textDescEn: e.textDesc || undefined }
        }))
      )
    }
    message.success(`词条已翻译：实体 ${res.entities.length} 条、片段 ${res.beats.length} 条`)
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    busy.value = false
  }
}

function tasksFor(targets: SegmentView[]): SegmentLocalizeTask[] {
  const nameMap: Record<string, string> = {}
  for (const e of registry.entities) {
    if (e.nameEn?.trim()) nameMap[e.name] = e.nameEn.trim()
  }
  return targets.map((v) => ({
    id: v.group.id,
    schema: schema.value,
    beats: v.beats,
    entities: registry.entities,
    fields: { ...v.fields },
    index: views.value.findIndex((x) => x.group.id === v.group.id),
    total: views.value.length,
    frames: v.frames
  }))
}

function entityNameMap(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of registry.entities) {
    if (e.nameEn?.trim()) out[e.name] = e.nameEn.trim()
  }
  return out
}

/** summary 有独立的存储位，必须单独写，否则校验与导出都取不到 */
async function writeBack(groupId: ID, fields: Record<string, string>) {
  const pid = project.currentId
  if (!pid || !Object.keys(fields).length) return
  const summary = fields.summary
  const rest: Record<string, string> = { ...fields }
  delete rest.summary
  if (summary) await assembly.setSummary(pid, groupId, summary)
  if (Object.keys(rest).length) await assembly.setFields(pid, groupId, rest)

  // 英文段字段也是"基于某份内容"生成的，同样要记指纹
  const v = views.value.find((x) => x.group.id === groupId)
  if (v) await assembly.markGenerated(pid, groupId, v.beats, registry.entities)
}

async function localizeSegments(targets: SegmentView[], label: string) {
  if (!provider.ready) {
    message.warning('请先在模型设置里配置好供应商')
    return
  }
  if (!targets.length) {
    message.info('没有需要本地化的段')
    return
  }
  if (!llmFields.value.length) {
    message.warning('当前字段配置里没有「模型生成」类型的字段，无需逐段翻译')
    return
  }
  failed.value = {}
  busy.value = true
  try {
    const res = await pipeline.localizeSegments(
      tasksFor(targets),
      settings.value,
      entityNameMap(),
      async (taskId, fields, err) => {
        if (err) {
          failed.value = { ...failed.value, [taskId]: err }
          return
        }
        await writeBack(taskId, fields)
      },
      concurrency.value
    )
    if (res.failed) message.warning(`${label}：成功 ${res.ok} 段，失败 ${res.failed} 段`)
    else message.success(`${label}：${res.ok} 段已转为英文`)
  } finally {
    busy.value = false
  }
}

/** 切到英文终稿：清掉被锁定的派生字段，让引擎用英文词条重新渲染 */
async function applyEnglish() {
  const pid = project.currentId
  if (!pid) return
  const keys = derivedKeys.value
  if (keys.length) {
    for (const v of views.value) await assembly.clearFields(pid, v.group.id, keys)
  }
  await project.updateSettings({ workLanguage: 'en' })
  message.success('已切换到英文终稿：派生字段由引擎用英文词条重新生成')
}

/** 切回中文工作稿：英文词条保留，随时可再切回来 */
async function backToChinese() {
  await project.updateSettings({ workLanguage: 'zh' })
  message.info('已切回中文工作稿（英文词条仍然保留）')
}

/** 一键本地化：词条 → 段字段 → 切换英文模式 */
async function runAll() {
  if (!provider.ready) {
    message.warning('请先在模型设置里配置好供应商')
    return
  }
  busy.value = true
  try {
    if (glossaryStats.value.todo) {
      const res = await pipeline.runGlossary(pendingBeats.value, pendingEntities.value, settings.value)
      if (res.beats.length) {
        await beats.patchBeats(
          res.beats.map((b) => ({
            id: b.id,
            patch: {
              titleEn: b.title || undefined,
              directionEn: b.direction || undefined,
              visualDescEn: b.visualDesc || undefined
            }
          }))
        )
      }
      if (res.entities.length) {
        await registry.patchEntities(
          res.entities.map((e) => ({
            id: e.id,
            patch: {
              nameEn: e.name || undefined,
              voiceDescEn: e.voiceDesc || undefined,
              textDescEn: e.textDesc || undefined
            }
          }))
        )
      }
    }

    const targets = views.value.filter((v) => pendingFields(v).length > 0)
    if (targets.length && llmFields.value.length) {
      await pipeline.localizeSegments(
        tasksFor(targets),
        settings.value,
        entityNameMap(),
        async (taskId, fields, err) => {
          if (err) {
            failed.value = { ...failed.value, [taskId]: err }
            return
          }
          await writeBack(taskId, fields)
        },
        concurrency.value
      )
    }

    await applyEnglish()
    message.success('本地化完成')
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    busy.value = false
  }
}

/* --------------------------- 词条编辑 --------------------------- */

async function editEntityName(e: Entity, value: string) {
  await registry.updateEntity(e.id, { nameEn: value.trim() || null })
}

async function editEntityVoice(e: Entity, value: string) {
  await registry.updateEntity(e.id, { voiceDescEn: value.trim() || null })
}

async function editEntityText(e: Entity, value: string) {
  await registry.updateEntity(e.id, { textDescEn: value.trim() || null })
}

async function editBeat(kind: 'titleEn' | 'directionEn' | 'visualDescEn', b: Beat, value: string) {
  await beats.updateBeat(b.id, { [kind]: value.trim() || undefined } as Partial<Beat>)
}

function segLabel(index: number) {
  return `seg${String(index + 1).padStart(2, '0')}`
}

function fieldLabel(key: string): string {
  return schema.value.find((f) => f.key === key)?.label ?? key
}
</script>

<template>
  <div style="height: 100%; display: flex; flex-direction: column">
    <div class="panel-head" style="border-radius: 0">
      <div class="row" style="gap: 10px; flex-wrap: wrap">
        <span>阶段五 · 中英本地化</span>
        <n-tag size="small" :bordered="false" :type="finalMode ? 'success' : 'default'">
          {{ finalMode ? '英文终稿模式' : '中文工作稿模式' }}
        </n-tag>
        <n-tag size="small" :bordered="false">词条 {{ glossaryStats.done }}/{{ glossaryStats.total }}</n-tag>
        <n-tag size="small" :bordered="false">段字段 {{ segStats.done }}/{{ segStats.total }}</n-tag>
      </div>
      <div class="row" style="gap: 8px">
        <span class="muted" style="font-size: 12.5px">每批词条</span>
        <n-select
          size="small"
          style="width: 92px"
          :value="settings.glossaryBatchSize"
          :options="GLOSSARY_BATCH_OPTIONS"
          @update:value="setGlossaryBatch"
        />
        <span class="muted" style="font-size: 12px; white-space: nowrap">{{ glossaryBatches }} 批</span>
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
          type="primary"
          :disabled="!views.length && !glossaryStats.todo"
          :loading="busy"
          @click="runAll"
        >
          一键本地化
        </n-button>
      </div>
    </div>

    <div style="padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line)">
      <n-progress type="line" :percentage="progressPercent" :height="6" :show-indicator="false" />
      <div class="row-between" style="margin-top: 6px">
        <div class="muted" style="font-size: 12px">
          阶段①~④ 全程中文，这里一次性转成英文终稿。结构锚点
          <span class="mono">&lt;Subject N&gt; / (Sx) / &lt;Picture N&gt; / &lt;d&gt; / 时间码</span>
          由引擎拼装、不经过模型，所以翻译改不坏格式
        </div>
        <span class="muted mono" style="font-size: 12px">
          {{ pipeline.running ? pipeline.progress : `${progressPercent}%` }}
        </span>
      </div>
    </div>

    <div class="scroll-pane" style="flex: 1; padding: 16px">
      <n-alert v-if="pipeline.error" type="error" :bordered="false" style="margin-bottom: 12px">
        {{ pipeline.error }}
      </n-alert>

      <n-alert v-if="finalMode" type="success" :bordered="false" style="margin-bottom: 12px">
        <div class="row-between" style="gap: 12px">
          <span>
            当前已是英文终稿模式。派生字段由引擎用英文词条实时渲染，改了片段会自动跟着变；
            仅模型字段（{{ llmFields.map((f) => f.key).join(' / ') }}）是翻译结果，改动时点「重译」。
          </span>
          <n-button size="tiny" quaternary @click="backToChinese">切回中文工作稿</n-button>
        </div>
      </n-alert>
      <n-alert v-else type="info" :bordered="false" style="margin-bottom: 12px">
        三步走：① 翻译词条表（实体名 / 音色 / 外观 + 片段标题 / 运镜 / 画面）→
        ② 逐段翻译模型字段 → ③ 切换到英文终稿。词条是逐条落库的，可先人工修正再点第 ② 步。
      </n-alert>

      <!-- ① 词条表 -->
      <div class="panel" style="padding: 12px 14px; margin-bottom: 12px">
        <div class="row-between" style="gap: 10px">
          <div class="row" style="gap: 8px">
            <n-button size="tiny" quaternary @click="showGlossary = !showGlossary">
              {{ showGlossary ? '收起' : '展开' }}
            </n-button>
            <span style="font-weight: 600">① 词条表</span>
            <n-tag v-if="glossaryStats.todo" size="small" type="warning" :bordered="false">
              待翻译 {{ glossaryStats.todo }}
            </n-tag>
            <n-tag v-else size="small" type="success" :bordered="false">已全部翻译</n-tag>
          </div>
          <n-button
            size="tiny"
            :loading="busy"
            :disabled="!glossaryStats.todo || !provider.ready"
            @click="localizeGlossary"
          >
            翻译词条表
          </n-button>
        </div>

        <div v-if="showGlossary" class="stack" style="gap: 12px; margin-top: 12px">
          <div>
            <div class="muted" style="font-size: 12px; margin-bottom: 6px">
              实体名 / 音色 / 外观 —— 音色描述必须跨段逐字一致，这里定稿后全片复用
            </div>
            <div class="stack" style="gap: 6px">
              <div
                v-for="e in registry.sortedEntities"
                :key="e.id"
                style="border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px"
              >
                <div class="row" style="gap: 8px; align-items: center">
                  <span class="mono" style="font-size: 12px; color: #5b6273; white-space: nowrap">
                    &lt;Subject {{ e.subjectN ?? '?' }}&gt;
                  </span>
                  <span style="font-size: 13px">{{ e.name }}</span>
                  <span class="muted">→</span>
                  <n-input
                    size="small"
                    style="flex: 1"
                    :value="e.nameEn ?? ''"
                    placeholder="英文名"
                    @update:value="(v: string) => editEntityName(e, v)"
                  />
                  <n-tag v-if="!e.nameEn" size="tiny" type="warning" :bordered="false">缺</n-tag>
                </div>
                <div
                  v-if="e.kind === 'speaking'"
                  class="row"
                  style="gap: 8px; margin-top: 6px; align-items: center"
                >
                  <span class="muted" style="font-size: 12px; width: 42px; white-space: nowrap">音色</span>
                  <span class="muted" style="font-size: 12px; flex: 1">{{ e.voiceDesc || '（未填写）' }}</span>
                  <span class="muted">→</span>
                  <n-input
                    size="small"
                    style="flex: 1"
                    :value="e.voiceDescEn ?? ''"
                    placeholder="a young male voice, slightly hoarse"
                    @update:value="(v: string) => editEntityVoice(e, v)"
                  />
                </div>
                <div v-if="e.textDesc" class="row" style="gap: 8px; margin-top: 6px; align-items: center">
                  <span class="muted" style="font-size: 12px; width: 42px; white-space: nowrap">外观</span>
                  <span class="muted" style="font-size: 12px; flex: 1">{{ e.textDesc }}</span>
                  <span class="muted">→</span>
                  <n-input
                    size="small"
                    style="flex: 1"
                    :value="e.textDescEn ?? ''"
                    placeholder="dark robe, pale skin"
                    @update:value="(v: string) => editEntityText(e, v)"
                  />
                </div>
              </div>
            </div>
          </div>

          <div>
            <div class="muted" style="font-size: 12px; margin-bottom: 6px">
              片段标题 / 运镜 / 画面 —— 这些会直接进 detailed_description 的镜头行
            </div>
            <div class="stack" style="gap: 6px">
              <div
                v-for="(b, i) in beats.ordered"
                :key="b.id"
                style="border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px"
              >
                <div class="row" style="gap: 8px; align-items: center">
                  <span class="muted mono" style="font-size: 12px; width: 32px">{{ String(i + 1).padStart(2, '0') }}</span>
                  <span class="mono" style="font-size: 12px; color: #5b6273; white-space: nowrap">{{ b.kind }}</span>
                  <span style="font-size: 13px; flex: 1">{{ b.title }}</span>
                  <span class="muted">→</span>
                  <n-input
                    size="small"
                    style="flex: 1"
                    :value="b.titleEn ?? ''"
                    placeholder="英文标题"
                    @update:value="(v: string) => editBeat('titleEn', b, v)"
                  />
                </div>
                <div v-if="b.direction" class="row" style="gap: 8px; margin-top: 6px; align-items: center">
                  <span class="muted" style="font-size: 12px; width: 76px; white-space: nowrap">运镜</span>
                  <span class="muted" style="font-size: 12px; flex: 1">{{ b.direction }}</span>
                  <span class="muted">→</span>
                  <n-input
                    size="small"
                    style="flex: 1"
                    :value="b.directionEn ?? ''"
                    placeholder="medium shot, slow push in"
                    @update:value="(v: string) => editBeat('directionEn', b, v)"
                  />
                </div>
                <div v-if="b.visualDesc" class="row" style="gap: 8px; margin-top: 6px; align-items: center">
                  <span class="muted" style="font-size: 12px; width: 76px; white-space: nowrap">画面</span>
                  <span class="muted" style="font-size: 12px; flex: 1">{{ b.visualDesc }}</span>
                  <span class="muted">→</span>
                  <n-input
                    size="small"
                    style="flex: 1"
                    :value="b.visualDescEn ?? ''"
                    placeholder="visual details"
                    @update:value="(v: string) => editBeat('visualDescEn', b, v)"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style="margin-bottom: 12px">
        <StageAdvice
          stage="localize"
          :presets="['某个角色的译名不合适', '英文太啰嗦，压短一点', '音色描述要统一说法']"
        />
      </div>

      <!-- ② 段字段 -->
      <div class="panel" style="padding: 12px 14px">
        <div class="row-between" style="gap: 10px; flex-wrap: wrap">
          <div class="row" style="gap: 8px">
            <span style="font-weight: 600">② 段字段</span>
            <n-tag v-if="segStats.todo" size="small" type="warning" :bordered="false">
              待翻译 {{ segStats.todo }} 段
            </n-tag>
            <n-tag v-else size="small" type="success" :bordered="false">已全部翻译</n-tag>
            <span class="muted" style="font-size: 12px">
              仅 {{ llmFields.map((f) => f.key).join(' / ') || '（无）' }}；其余字段由引擎派生
            </span>
          </div>
          <div class="row" style="gap: 6px">
            <n-button
              size="tiny"
              :loading="busy"
              :disabled="!segStats.todo || !provider.ready"
              @click="localizeSegments(views.filter((v) => pendingFields(v).length > 0), '翻译段字段')"
            >
              翻译待处理段
            </n-button>
            <n-button
              size="tiny"
              :loading="busy"
              :disabled="!views.length || !provider.ready"
              @click="localizeSegments(views, '全部重译')"
            >
              全部重译
            </n-button>
            <n-button size="tiny" :type="finalMode ? 'default' : 'primary'" :disabled="finalMode" @click="applyEnglish">
              ③ 切换到英文终稿
            </n-button>
          </div>
        </div>

        <div v-if="!views.length" class="empty" style="margin-top: 12px">
          <div>还没有组合好的段，先到「组合与缝合」生成方案</div>
        </div>

        <div class="stack" style="gap: 8px; margin-top: 12px">
          <div v-for="(v, i) in views" :key="v.group.id" class="panel" style="padding: 10px 12px">
            <div class="row-between" style="gap: 10px">
              <div class="row" style="gap: 8px; min-width: 0">
                <span style="font-weight: 600">{{ segLabel(i) }}</span>
                <span class="muted mono" style="font-size: 12px">{{ v.frames }}f</span>
                <n-tag v-if="failed[v.group.id]" size="small" type="error" :bordered="false">翻译失败</n-tag>
                <n-tag
                  v-else-if="pendingFields(v).length"
                  size="small"
                  type="warning"
                  :bordered="false"
                >
                  待翻译 {{ pendingFields(v).length }}
                </n-tag>
                <n-tag
                  v-else-if="residualFields(v).length"
                  size="small"
                  type="warning"
                  :bordered="false"
                  style="cursor: help"
                >
                  词条缺 {{ residualFields(v).length }}
                </n-tag>
                <n-tag v-else size="small" type="success" :bordered="false">已英文化</n-tag>
              </div>
              <div class="row" style="gap: 6px">
                <n-button
                  size="tiny"
                  quaternary
                  @click="expanded = expanded === v.group.id ? null : v.group.id"
                >
                  {{ expanded === v.group.id ? '收起' : '对照' }}
                </n-button>
                <n-button
                  size="tiny"
                  :loading="busy"
                  :disabled="!provider.ready"
                  @click="localizeSegments([v], 'seg 重译')"
                >
                  重译
                </n-button>
              </div>
            </div>

            <div v-if="failed[v.group.id]" class="issue error" style="margin-top: 8px">
              {{ failed[v.group.id] }}
            </div>

            <div
              v-if="residualFields(v).length && !pendingFields(v).length"
              class="issue warn"
              style="margin-top: 8px"
            >
              这些字段里还有中文，多半是词条表没翻全：
              <span class="mono">{{ residualFields(v).join('、') }}</span>
            </div>

            <div v-if="expanded === v.group.id" class="stack" style="gap: 8px; margin-top: 10px">
              <div v-for="key in llmFields.map((f) => f.key)" :key="key" class="field-card">
                <div class="field-head">
                  <span class="mono" style="font-weight: 600">{{ key }}</span>
                  <span
                    v-if="hasCjkOutsideD(v.fields[key])"
                    class="tag-chip"
                    style="background: #fff4e5; color: #b06a12"
                  >
                    中文原稿
                  </span>
                  <span v-else class="tag-chip" style="background: #e9f7ef; color: #217a52">英文终稿</span>
                </div>
                <div class="field-body">
                  <div
                    class="mono"
                    style="font-size: 12.5px; line-height: 1.65; white-space: pre-wrap; word-break: break-word"
                  >
                    {{ v.fields[key] || '（空）' }}
                  </div>
                </div>
              </div>
              <div class="muted" style="font-size: 12px">
                派生字段（{{ derivedKeys.map(fieldLabel).join(' / ') }}）不在这里翻译：
                切到英文终稿后由引擎用英文词条重新渲染，改动片段会自动跟着更新
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
