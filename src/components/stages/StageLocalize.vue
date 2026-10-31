<script setup lang="ts">
import { computed, ref } from 'vue'
import { NAlert, NButton, NInput, NModal, NProgress, NSelect, NTag, useMessage } from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { useAssemblyStore, type SegmentView } from '@/stores/assembly'
import { usePipelineStore, type SegmentLocalizeTask } from '@/stores/pipeline'
import { useProviderStore } from '@/stores/provider'
import { useGateStore } from '@/stores/gate'
import SectionNav, { type SectionNavItem } from '@/components/SectionNav.vue'
import StageAdvice from '@/components/StageAdvice.vue'
import DetailModal from '@/components/DetailModal.vue'
import FieldRow from '@/components/FieldRow.vue'
import { hasCjkOutsideD } from '@/domain/lang'
import { useWorkLanguage } from '@/composables/useWorkLanguage'
import { fieldName } from '@/domain/fieldLabels'
import type { Beat, Entity, ID } from '@/domain/types'
import InfoTip from '@/components/common/InfoTip.vue'

const project = useProjectStore()
const beats = useBeatStore()
const registry = useRegistryStore()
const assembly = useAssemblyStore()
const pipeline = usePipelineStore()
const provider = useProviderStore()
const gate = useGateStore()
const message = useMessage()

const concurrency = ref(2)
const busy = ref(false)
const showGlossary = ref(true)
const expanded = ref<ID | null>(null)
const failed = ref<Record<string, string>>({})

/**
 * 通用确认框（Promise 化）：runAll 流程中途也能停下来等用户决定，
 * 而不是静默抹掉手工改过的内容。
 */
const confirmState = ref<{ message: string; resolve: (ok: boolean) => void } | null>(null)

function confirmAction(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.value = { message, resolve }
  })
}

function onConfirm(ok: boolean) {
  const st = confirmState.value
  confirmState.value = null
  st?.resolve(ok)
}

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
    project.fieldSchema,
    registry.assets
  )
})

/* --------------------------- 词条进度 --------------------------- */

/*
 * 切回中文工作稿：已经译成英文的模型字段不会自己变回中文 ——
 * 「英语那一侧有内容、中文那一侧是空的」必须先回写，否则切过去还是英文。
 */
const {
  gapCount: enOnlyCount,
  gapLabelText: enOnlyText,
  backToChinese: switchToChinese
} = useWorkLanguage(views)

function beatNeeds(b: Beat): boolean {
  if (!b.titleEn) return true
  if (b.direction && !b.directionEn) return true
  if (b.visualDesc && !b.visualDescEn) return true
  return false
}

function entityNeeds(e: Entity): boolean {
  if (!e.nameEn) return true
  if (e.textDesc && !e.textDescEn) return true
  if (e.costumeDesc && !e.costumeDescEn) return true
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

/**
 * 该段还有哪些模型字段没英文化。
 *
 * ★ 判断依据是英文那一份空不空，而不是"中文里还有没有中文"——
 *   中文稿本来就该是中文，拿它当进度会永远显示"没翻"。
 */
function pendingFields(v: SegmentView): string[] {
  return llmFields.value
    .map((f) => f.key)
    .filter((k) => (v.fields[k] ?? '').trim() && !(v.fieldsEn[k] ?? '').trim())
}

/** 英文稿里仍残留中文的字段（<d> 之外）：翻译没翻干净 */
function residualFields(v: SegmentView): string[] {
  return schema.value
    .map((f) => f.key)
    .filter((k) => hasCjkOutsideD(v.fieldsEn[k] || v.fields[k]))
}

/** 弹窗正在对照的那一段 */
const detailView = computed<SegmentView | null>(() => {
  if (!expanded.value) return null
  return views.value.find((v) => v.group.id === expanded.value) ?? null
})

const detailIndex = computed(() => {
  if (!expanded.value) return 0
  return views.value.findIndex((v) => v.group.id === expanded.value)
})

/** 弹窗开关。复用 expanded——非空即打开，关闭时清空。 */
const detailOpen = computed({
  get: () => expanded.value !== null,
  set: (v: boolean) => {
    if (!v) expanded.value = null
  }
})

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

/** 侧边目录：词条表三大块 + 逐段定位 */
const navItems = computed<SectionNavItem[]>(() => {
  const out: SectionNavItem[] = []
  if (showGlossary.value) {
    const ents = pendingEntities.value.length
    const bts = pendingBeats.value.length
    out.push({ id: 'lo-g-ents', label: '词条 · 实体', hint: ents ? `${ents}待翻` : '完成', tone: ents ? 'warn' : 'ok' })
    out.push({ id: 'lo-g-beats', label: '词条 · 片段', hint: bts ? `${bts}待翻` : '完成', tone: bts ? 'warn' : 'ok' })
  } else {
    out.push({ id: 'lo-glossary', label: '词条表（已收起）' })
  }
  const todo = segStats.value.todo
  out.push({ id: 'lo-seg-head', label: '段字段', hint: todo ? `${todo}段待翻` : '完成', tone: todo ? 'warn' : 'ok' })
  views.value.forEach((v, i) => {
    const pending = pendingFields(v).length
    out.push({
      id: `lo-g-${v.group.id}`,
      label: `seg${String(i + 1).padStart(2, '0')}`,
      hint: failed.value[v.group.id] ? '失败' : pending ? `缺${pending}` : '已英文化',
      tone: failed.value[v.group.id] ? 'err' : pending ? 'warn' : 'ok'
    })
  })
  return out
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
          patch: {
            nameEn: e.name || undefined,
            voiceDescEn: e.voiceDesc || undefined,
            textDescEn: e.textDesc || undefined,
            costumeDescEn: e.costumeDesc || undefined
          }
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

/**
 * 本地化的产物写进英文那一份。
 *
 * ★ 必须显式传 'en'：默认语言是中文，漏传就会把刚翻译好的英文
 *   写回中文侧，等于又走了一遍"覆盖中文"的老路。
 */
async function writeBack(groupId: ID, fields: Record<string, string>) {
  const pid = project.currentId
  if (!pid || !Object.keys(fields).length) return
  const summary = fields.summary
  const rest: Record<string, string> = { ...fields }
  delete rest.summary
  if (summary) await assembly.setSummary(pid, groupId, summary, 'en')
  if (Object.keys(rest).length) await assembly.setFields(pid, groupId, rest, 'en')

  // 英文段字段也是"基于某份内容"生成的，同样要记指纹
  const v = views.value.find((x) => x.group.id === groupId)
  if (v) {
    await assembly.markGenerated(pid, groupId, v.beats, registry.entities, v.frames)
    /*
     * ★ 记下"刚对齐过"。
     *   没有这条基线，中英两份的修改时间必然不同（一个先写一个后写），
     *   下一次打开页面就会互相判成"对方落后了"，整页红点 —— 而实际上刚翻完。
     */
    await assembly.markSynced(pid, groupId, v.hash)
  }
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

/**
 * 切到英文终稿：清掉被锁定的派生字段，让引擎用英文词条重新渲染。
 * 但「手改锁定」过的派生字段是人工成果，切换会直接抹掉 —— 先确认。
 */
async function applyEnglish() {
  const pid = project.currentId
  if (!pid) return

  const locked = views.value
    .map((v) => ({
      index: views.value.findIndex((x) => x.group.id === v.group.id) + 1,
      keys: assembly.lockedKeys(v.group.id).filter((k) => derivedKeys.value.includes(k))
    }))
    .filter((x) => x.keys.length)

  if (locked.length) {
    const detail = locked
      .slice(0, 5)
      .map((x) => `seg${String(x.index).padStart(2, '0')}（${x.keys.join('/')}）`)
      .join('，')
    const ok = await confirmAction(
      `${locked.length} 段存在「手改锁定」的派生字段（${detail}${locked.length > 5 ? '…' : ''}）。` +
        '切换到英文终稿会清空这些锁定，由引擎用英文词条重新渲染，手工改动不会保留。' +
        '要继续吗？（想保留就先切回自动或手动备份这些字段）'
    )
    if (!ok) {
      message.warning('已取消切换，手工锁定的字段保持不变')
      return
    }
  }

  const keys = derivedKeys.value
  if (keys.length) {
    for (const v of views.value) await assembly.clearFields(pid, v.group.id, keys)
  }
  await project.updateSettings({ workLanguage: 'en' })
  message.success('已切换到英文终稿：派生字段由引擎用英文词条重新生成')
}

/**
 * 切回中文工作稿：英文词条保留，随时可再切回来。
 *
 * ★ 已经译成英文的模型字段（summary / overall_soundscape / non_diegetic_music）
 * 不会跟着回来 —— 界面切到中文，它们还是英文。所以这里先把「只有英文」的项数
 * 摆出来问一句：要顺手回写中文，还是只切语言。
 */
async function backToChinese() {
  if (!enOnlyCount.value) {
    await switchToChinese()
    message.info('已切回中文工作稿（英文那份保留，随时可再切回来）')
    return
  }
  const ok = await confirmAction(
    `有 ${enOnlyCount.value} 项模型字段只有英文（${enOnlyText.value}）。\n` +
      '点「确定」＝ 切回中文，并让模型把它们回写成中文；\n' +
      '点「取消」＝ 只切语言开关，这几项仍然是英文。'
  )
  if (ok && !provider.ready) {
    message.warning('回写中文要调模型，请先在模型设置里配好供应商')
    return
  }
  busy.value = true
  try {
    const res = await switchToChinese({ writeBack: ok })
    if (res.failed.length) {
      message.warning(`已切回中文，但有 ${res.failed.length} 段没回写成功：${res.failed[0]}`)
    } else if (ok) {
      message.success(`已切回中文工作稿，并回写 ${res.translated} 项字段`)
    } else {
      message.info('已切回中文工作稿（已经译成英文的模型字段保持英文）')
    }
  } finally {
    busy.value = false
  }
}

/** 一键本地化：词条 → 段字段 → 切换英文模式 */
async function runAll() {
  // ④ 还有字段空缺 / 过期内容时，翻译的是一份残缺稿，翻完还得再翻一遍
  if (!gate.gates.complete.passed) {
    message.error(`还不能本地化：${gate.gates.complete.errors[0] ?? ''}`, { duration: 8000 })
    return
  }
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
              textDescEn: e.textDesc || undefined,
              costumeDescEn: e.costumeDesc || undefined
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

async function editEntityCostume(e: Entity, value: string) {
  await registry.updateEntity(e.id, { costumeDescEn: value.trim() || null })
}

async function editBeat(kind: 'titleEn' | 'directionEn' | 'visualDescEn', b: Beat, value: string) {
  await beats.updateBeat(b.id, { [kind]: value.trim() || undefined } as Partial<Beat>)
}

function segLabel(index: number) {
  return `seg${String(index + 1).padStart(2, '0')}`
}

</script>

<template>
  <div style="height: 100%; display: flex; flex-direction: column">
    <div class="panel-head" style="border-radius: 0">
      <div class="row" style="gap: 10px; flex-wrap: wrap">
        <span>阶段四 · 中英本地化</span>
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

    <div class="lo-guide">
      <n-progress type="line" :percentage="progressPercent" :height="6" :show-indicator="false" />
      <div class="row-between lo-guide-row">
        <div class="lo-guide-t">
          阶段①~③ 全程中文，这里一次性转成英文终稿
          <InfoTip
            size="sm"
            :width="360"
            text="结构锚点 <Subject N> / (Sx) / <Picture N> / <d> / 时间码 由引擎拼装、不经过模型，所以翻译改不坏格式。"
          />
        </div>
        <span class="lo-guide-pct mono">
          {{ pipeline.running ? pipeline.progress : `${progressPercent}%` }}
        </span>
      </div>
    </div>

    <div style="flex: 1; min-height: 0; position: relative; display: flex">
    <div class="scroll-pane lo-list" id="lo-list">
      <n-alert v-if="pipeline.error" type="error" :bordered="false" style="margin-bottom: 12px">
        {{ pipeline.error }}
      </n-alert>

      <div v-if="finalMode" class="lo-mode is-final">
        英文终稿模式
        <InfoTip
          :width="400"
          :text="`派生字段由引擎用英文词条实时渲染，改了片段会自动跟着变；仅模型字段（${llmFields.map((f) => f.key).join(' / ')}）是翻译结果，改动时点「重译」。`"
        />
        <div style="flex: 1" />
        <n-button size="tiny" quaternary @click="backToChinese">切回中文工作稿</n-button>
      </div>
      <div v-else class="lo-mode">
        中文工作稿 · 三步转英文
        <InfoTip
          :width="400"
          text="① 翻译词条表（实体名 / 音色 / 外观 + 片段标题 / 运镜 / 画面）→ ② 逐段翻译模型字段 → ③ 切换到英文终稿。&#10;词条是逐条落库的，可先人工修正再点第 ② 步。"
        />
      </div>

      <!-- ① 词条表 -->
      <div id="lo-glossary" class="panel lo-card">
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

        <div v-if="showGlossary" class="lo-glossary-body">
          <div id="lo-g-ents">
            <div class="muted row" style="font-size: 12px; margin-bottom: 6px; gap: 0; align-items: center">
              实体名 / 音色 / 外观
              <InfoTip size="sm" :width="280" text="音色描述必须跨段逐字一致，这里定稿后全片复用。" />
            </div>
            <div class="lo-rows">
              <div v-for="e in registry.sortedEntities" :key="e.id" class="lo-item">
                <div class="lo-row lo-row-ent">
                  <span class="lo-k mono">&lt;Subject {{ e.subjectN ?? '?' }}&gt;</span>
                  <span class="lo-zh lo-zh-strong">{{ e.name }}</span>
                  <span class="lo-ar">→</span>
                  <n-input
                    size="small"
                    :value="e.nameEn ?? ''"
                    placeholder="英文名"
                    @update:value="(v: string) => editEntityName(e, v)"
                  />
                  <n-tag v-if="!e.nameEn" size="tiny" type="warning" :bordered="false">缺</n-tag>
                </div>
                <div v-if="e.kind === 'speaking'" class="lo-row">
                  <span class="lo-k">音色</span>
                  <span class="lo-zh">{{e.voiceDesc || '（未填写）'}}</span>
                  <span class="lo-ar">→</span>
                  <n-input
                    size="small"
                    :value="e.voiceDescEn ?? ''"
                    placeholder="a young male voice, slightly hoarse"
                    @update:value="(v: string) => editEntityVoice(e, v)"
                  />
                </div>
                <div v-if="e.textDesc" class="lo-row">
                  <span class="lo-k">长相</span>
                  <span class="lo-zh">{{e.textDesc}}</span>
                  <span class="lo-ar">→</span>
                  <n-input
                    size="small"
                    :value="e.textDescEn ?? ''"
                    placeholder="high cheekbones, pale skin, short black hair"
                    @update:value="(v: string) => editEntityText(e, v)"
                  />
                </div>
                <!-- 服装单独一行：它只进三视图，和长相走的是两条出图通道 -->
                <div v-if="e.costumeDesc" class="lo-row">
                  <span class="lo-k">服装</span>
                  <span class="lo-zh">{{e.costumeDesc}}</span>
                  <span class="lo-ar">→</span>
                  <n-input
                    size="small"
                    :value="e.costumeDescEn ?? ''"
                    placeholder="grey cotton jacket, worn jeans, canvas sneakers"
                    @update:value="(v: string) => editEntityCostume(e, v)"
                  />
                </div>
              </div>
            </div>
          </div>

          <div id="lo-g-beats">
            <div class="muted row" style="font-size: 12px; margin-bottom: 6px; gap: 0; align-items: center">
              片段标题 / 运镜 / 画面
              <InfoTip size="sm" :width="280" text="这些会直接进 detailed_description 的镜头行。" />
            </div>
            <div class="lo-rows">
              <div v-for="(b, i) in beats.ordered" :key="b.id" class="lo-item">
                <div class="lo-row lo-row-beat">
                  <span class="lo-idx mono">{{ String(i + 1).padStart(2, '0') }}</span>
                  <span class="lo-k mono">{{ b.kind }}</span>
                  <span class="lo-zh lo-zh-strong">{{ b.title }}</span>
                  <span class="lo-ar">→</span>
                  <n-input
                    size="small"
                    :value="b.titleEn ?? ''"
                    placeholder="英文标题"
                    @update:value="(v: string) => editBeat('titleEn', b, v)"
                  />
                </div>
                <div v-if="b.direction" class="lo-row lo-row-wide">
                  <span class="lo-k">运镜</span>
                  <span class="lo-zh">{{b.direction}}</span>
                  <span class="lo-ar">→</span>
                  <n-input
                    size="small"
                    :value="b.directionEn ?? ''"
                    placeholder="medium shot, slow push in"
                    @update:value="(v: string) => editBeat('directionEn', b, v)"
                  />
                </div>
                <div v-if="b.visualDesc" class="lo-row lo-row-wide">
                  <span class="lo-k">画面</span>
                  <span class="lo-zh">{{b.visualDesc}}</span>
                  <span class="lo-ar">→</span>
                  <n-input
                    size="small"
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

      <StageAdvice
        stage="localize"
        :presets="['某个角色的译名不合适', '英文太啰嗦，压短一点', '音色描述要统一说法']"
      />

      <!-- ② 段字段 -->
      <div id="lo-seg-head" class="panel lo-card lo-card-last">
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

        <div class="lo-segs">
          <div v-for="(v, i) in views" :key="v.group.id" :id="'lo-g-' + v.group.id" class="panel lo-seg">
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
                <n-button size="tiny" quaternary @click="expanded = v.group.id">
                  对照
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
              这些字段里还有中文
              <span class="mono">{{ residualFields(v).join('、') }}</span>
              <InfoTip size="sm" :width="240" text="多半是词条表没翻全，回上面的「① 词条表」补翻。" />
            </div>
          </div>
        </div>
      </div>
    </div>
    <SectionNav title="目录" container="#lo-list" :items="navItems" />
    </div>

    <n-modal
      :show="!!confirmState"
      preset="dialog"
      title="确认"
      positive-text="继续"
      negative-text="取消"
      @positive-click="onConfirm(true)"
      @negative-click="onConfirm(false)"
    >
      {{ confirmState?.message }}
    </n-modal>

    <!-- 中英对照统一走弹窗 -->
    <DetailModal
      v-model:show="detailOpen"
      :title="`第 ${detailIndex + 1} 段 · 中英对照`"
      :width="820"
    >
      <div v-if="!detailView" class="empty">没有选中视频段</div>
      <div v-else class="stack lo-fields">
        <FieldRow
          v-for="key in llmFields.map((f) => f.key)"
          :key="key"
          :label="fieldName(key)"
          :field-key="key"
          :tone="
            !(detailView.fields[key] ?? '').trim()
              ? 'empty'
              : hasCjkOutsideD(detailView.fields[key])
                ? 'warn'
                : 'plain'
          "
        >
          <span v-if="hasCjkOutsideD(detailView.fields[key])" class="tag-chip warn">中文原稿</span>
          <span v-else class="tag-chip ok">英文终稿</span>
          <div class="lo-fx-val mono">{{ detailView.fields[key] || '（空）' }}</div>
        </FieldRow>
        <div class="muted" style="font-size: 12px">
          派生字段（{{ derivedKeys.map(fieldName).join(' / ') }}）不在这里翻译
          <InfoTip
            size="sm"
            :width="300"
            text="切到英文终稿后由引擎用英文词条重新渲染，改动片段会自动跟着更新。"
          />
        </div>
      </div>
    </DetailModal>
  </div>
</template>

<style scoped>
/*
 * 本地化页原先一个 <style> 都没有 —— 78 处 inline style 散在模板里，
 * 于是"卡片"有四种内距、"提示条"有四种字号。这里统一收成几个类：
 *
 *   .lo-guide  顶部进度条 + 一句说明（不是第二个页头）
 *   .lo-card   主卡（词条表 / ② 段字段），卡头用负 margin 顶到边缘
 *   .lo-seg    单个段的卡片，比主卡小一号
 *   .lo-item   词条表里的一行（实体一条、片段一条）
 *   .lo-row    词条表里的一行对照：左中文 / 箭头 / 右英文，网格列对齐
 */

.lo-guide {
  padding: 8px 16px 10px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
}
.lo-guide-row {
  margin-top: 5px;
  gap: 16px;
  align-items: flex-start;
}
.lo-guide-t {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--muted);
}
.lo-guide-pct {
  flex: none;
  font-size: var(--fs-sm);
  color: var(--label);
}

/* 原来是一整条 alert 讲三种模式。模式名一行，规则收进问号 */
.lo-mode {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-bottom: 10px;
  padding: 5px 10px;
  border-radius: 6px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  font-size: 12px;
  color: var(--muted);
}
.lo-mode.is-final {
  background: var(--ok-soft, rgba(24, 160, 88, 0.1));
  border-color: var(--ok-soft, rgba(24, 160, 88, 0.24));
  color: var(--text);
}

.lo-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px 20px;
}

/* 主卡：面板壳 + 浅灰卡头 + 左侧阶段色条（和交付页模块卡同一套语言） */
.lo-card {
  padding: 12px 14px;
}
.lo-card > .row-between:first-child {
  margin: -12px -14px 12px;
  padding: 7px 14px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--line);
  box-shadow: inset 3px 0 0 var(--stage, var(--accent));
}
.lo-card-last {
  margin-bottom: 4px;
}

.lo-segs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

/* 段卡片：头也是卡头，只是字号和间距小一号 */
.lo-seg {
  padding: 10px 12px;
}
.lo-seg > .row-between:first-child {
  margin: -10px -12px 8px;
  padding: 6px 12px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--line);
  box-shadow: inset 3px 0 0 var(--stage, var(--accent));
}

.lo-glossary-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}

/* 词条表：一行一个薄盒，内部按网格对齐 */
.lo-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.lo-item {
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel-2);
}
.lo-item + .lo-item {
  margin-top: 0;
}

/*
 * 对照网格：左边原文、中间箭头、右边输入框，两列等宽。
 * 原来用 flex + 两边 flex:1，长中文撑住 min-width 后把英文输入框顶出卡片右侧。
 */
.lo-row {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 12px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.lo-row + .lo-row {
  margin-top: 6px;
}
.lo-row-wide {
  grid-template-columns: 42px minmax(0, 1fr) 12px minmax(0, 1fr);
}
.lo-row-ent {
  grid-template-columns: 108px minmax(0, 1fr) 12px minmax(0, 1fr) auto;
}
.lo-row-beat {
  grid-template-columns: 22px 90px minmax(0, 1fr) 12px minmax(0, 1fr);
}

.lo-k {
  font-size: var(--fs-sm);
  color: var(--label);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lo-idx {
  font-size: var(--fs-sm);
  color: var(--muted-3);
}
.lo-zh {
  min-width: 0;
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.lo-zh-strong {
  font-size: var(--fs-md);
  color: var(--text);
}
.lo-ar {
  color: var(--line-strong);
  font-size: var(--fs-sm);
  text-align: center;
}

/* 中英对照弹窗：一条字段 = 徽章 + 条，和其他几个页同一个写法 */
.lo-fields {
  gap: 4px;
}
.lo-fx-val {
  margin-top: 3px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
