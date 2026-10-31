<script setup lang="ts">
/**
 * ② 细节填充。
 *
 * 这里的工作量是"逐段核对 + 微调"，不是"逐段打开再关上"：
 *   - 字段全部铺在卡片上（场景 / 主体 / 说话人 / 聚焦 / 镜头描述 / 画面描述）
 *   - 主体自带的参考图就贴在主体格里（选上主体等于带上图），缺图就地补；
 *     卡片底部那条素材带按**作用方式**分上下两格，各有各的上传口：
 *     关键帧（这一段自己的内容，落在时间轴上：图片锁帧、配音 / 音视频从某一帧起）/
 *     参考素材（只借给模型看或听、不占时间轴：参考图、参考音频 / 视频）
 *     —— 两格都收图片 / 音频 / 视频，别按文件类型去猜它该去哪一格
 *   - 「待补」筛选直接把缺绑定的一段段捞出来，填完自动从列表消失
 *   - 镜头描述 Enter、画面描述 Ctrl+Enter 跳到下一段同一栏，一列填到底
 *   - 「紧凑」形态保留一眼扫全片的能力（只看摘要，不占屏）
 *   - 列表按**自己的宽度**自动铺列（每列至少 430，窗口越宽越多列），
 *     一屏能同时照看的段数翻几倍；卡片内部再按"卡有多宽"自行降字段列数
 *
 * 片段的标题 / 类型 / 台词 / 帧数属于拆解阶段，这里不重复放，避免两处都能改。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NProgress, NSelect, NTag, useMessage } from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { useImageStore } from '@/stores/images'
import { usePipelineStore } from '@/stores/pipeline'
import { useProviderStore } from '@/stores/provider'
import SectionNav, { type SectionNavItem } from '@/components/SectionNav.vue'
import StageAdvice from '@/components/StageAdvice.vue'
import EnrichBeatCard from '@/components/EnrichBeatCard.vue'
import BatchKeyframeDialog from '@/components/BatchKeyframeDialog.vue'
import AssetPreview from '@/components/AssetPreview.vue'
import { beatIssueLabel, isSplitPair, makeEntityResolver, splitPieceMap } from '@/domain/beats'
import { frameLabel, keyframesOf, slotDraftsOf, startFrameLabel } from '@/domain/references'
import { keyframeDrift } from '@/domain/keyframeDrift'
import { beatFrames } from '@/domain/timing'
import { useSlotBatch, type SlotPair } from '@/composables/useSlotBatch'
import { needsVoiceSlot } from '@/domain/voiceover'
import type { Asset, Beat, ID } from '@/domain/types'

const emit = defineEmits<{ changed: [] }>()

const project = useProjectStore()
const beats = useBeatStore()
const registry = useRegistryStore()
const images = useImageStore()
const pipeline = usePipelineStore()
const provider = useProviderStore()
const message = useMessage()

const settings = computed(() => project.settings)
const list = computed(() => beats.ordered)

/* ------------------------------ 视图状态 ------------------------------ */

type Variant = 'full' | 'compact'
const VARIANT_KEY = 'enrich:variant'

/**
 * 默认展开：字段平铺才是这个页面的本来面目。
 * 「紧凑」是给"片段太多、先扫一遍"用的，记住上次选择，别每次切回来都重置。
 */
const variant = ref<Variant>(
  localStorage.getItem(VARIANT_KEY) === 'compact' ? 'compact' : 'full'
)
watch(variant, (v) => localStorage.setItem(VARIANT_KEY, v))

type FilterMode = 'all' | 'todo' | 'ready'
const filterMode = ref<FilterMode>('all')

const hasIssue = (b: Beat) => !!beatIssueLabel(b)

const missingCount = computed(() => list.value.filter(hasIssue).length)
const readyCount = computed(() => list.value.length - missingCount.value)
const confirmedCount = computed(() => list.value.filter((b) => !hasIssue(b) && b.enriched).length)

/* --------------------- 待合成占位：批量出图 / 批量合成 --------------------- */

/*
 * 页面顶部只留两颗**批量**按钮，跑的是卡片上那些配置好的占位（draft 素材）：
 *   ＋图片配置 → 一格待出图；＋音频配置（台词段自带）→ 一格待配音。
 * 真正的跑法在 useSlotBatch（卡片上的「保存并出图 / 保存并配音」走同一份），
 * 这里只负责"喂哪一批"和把结果通知出去。
 */
const slotBatch = useSlotBatch()

/** 全片所有占位，按段排 */
const slotPairs = computed<SlotPair[]>(() => {
  const out: SlotPair[] = []
  for (const b of list.value) {
    for (const slot of slotDraftsOf(registry.assets, b.id)) out.push({ slot, beat: b })
  }
  return out
})

const imgPairs = computed(() => slotPairs.value.filter((p) => p.slot.media !== 'audio'))
const audPairs = computed(() => slotPairs.value.filter((p) => p.slot.media === 'audio'))

async function runGenSlots() {
  if (!imgPairs.value.length) {
    message.info('还没有待出图的格子：在卡片上点「＋图片配置」写一句提示词，保存后这里就有数了')
    return
  }
  const r = await slotBatch.runGen(imgPairs.value)
  if (r?.ok) emit('changed')
}

async function runSynthSlots() {
  if (!audPairs.value.length) {
    message.info('还没有待配音的格子：台词段会自动带一格，别的段点「＋音频配置」写要念的文本')
    return
  }
  const r = await slotBatch.runSynth(audPairs.value)
  if (r?.ok) emit('changed')
}

/* -------------------- 台词段默认带一格待配音 -------------------- */

/*
 * 台词段天生有一句话要说：打开 ② 就该看到「待配音 · 某人 F0」，文本已经对齐
 * 台词，点开能改、点「批量合成」就出声 —— 不该让人先点「＋音频配置」再把台词
 * 抄一遍。
 *
 * 三件事一次扫描做完（不各写一套）：
 *   1. 该有却没有 → 建一格（needsVoiceSlot 判断"该不该"）；
 *   2. 已有的自动格 → 台词改了就跟着改（用户改过文本的 auto 已落成 false）；
 *   3. 用户删掉的 → 段上记了 voiceSkipped，不再建回来。
 *
 * 依赖里带 assets.length：项目刚打开时片段先到、素材后到，只盯台词会在素材还
 * 没加载时误判"这段没有配音"，凭空多建一格。
 */
const ensuring = ref(false)
/** 本次会话已经处理过的段：资产每次变化不必重复走一遍 */
const ensured = new Set<ID>()
const voiceSig = computed(() =>
  list.value
    .filter((b) => b.kind === 'dialogue')
    .map((b) => `${b.id}|${(b.dialogue ?? '').trim()}|${b.speakerId ?? ''}`)
    .join('\n')
)

async function ensureVoiceSlots() {
  const pid = project.currentId
  // 素材还没加载完时不要动：空数组 ≠ 没有配音，否则会给已有配音的段多建一格
  if (!pid || ensuring.value || registry.loadedProjectId !== pid) return
  ensuring.value = true
  let touched = false
  try {
    for (const b of list.value) {
      const text = (b.dialogue ?? '').trim()
      // ① 已有的自动格：台词改了就跟上（用户改过文本的 auto 已为 false）
      for (const a of registry.assets) {
        if (a.refId !== b.id || !a.draft || !a.auto || a.media !== 'audio') continue
        if (text && (a.voiceText ?? '').trim() !== text) {
          await registry.updateAsset(a.id, { voiceText: text })
          touched = true
        }
      }
      // ② 该有却没有：建一格，文本对齐台词、音色取说话人
      if (!needsVoiceSlot(b, registry.assets) || ensured.has(b.id)) continue
      ensured.add(b.id)
      await registry.createDraftAsset(pid, b.id, {
        media: 'audio',
        actAs: 'keyframe',
        voiceText: text,
        voiceSpeakerId: b.speakerId,
        frameIdx: 0,
        auto: true
      })
      touched = true
    }
  } finally {
    ensuring.value = false
  }
  if (touched) emit('changed')
}

watch(
  [() => project.currentId, voiceSig, () => registry.assets.length, () => registry.loadedProjectId],
  () => {
    void ensureVoiceSlots()
  }
)
onMounted(() => {
  void ensureVoiceSlots()
})

/**
 * 进度按"无硬性问题"算（缺场景 / 台词缺说话人），
 * 而不是按 enriched 标志 —— 否则一批没手动确认过的片段永远显示 0%。
 */
const progress = computed(() =>
  list.value.length ? Math.round((readyCount.value / list.value.length) * 100) : 0
)

const visible = computed(() => {
  if (filterMode.value === 'todo') return list.value.filter(hasIssue)
  if (filterMode.value === 'ready') return list.value.filter((b) => !hasIssue(b))
  return list.value
})

/** 侧边目录跟可见列表走，否则点过滤后目录里的项根本不在 DOM 里 */
const beatNav = computed<SectionNavItem[]>(() =>
  visible.value.map((b) => {
    const issue = beatIssueLabel(b)
    return {
      id: `en-b-${b.id}`,
      label: `${list.value.indexOf(b) + 1} ${b.title || '（未命名）'}`,
      hint: issue ?? '已就绪',
      tone: issue ? 'err' : 'ok'
    }
  })
)

/** "过长被迫拆开"的分片血缘：beatId -> {index, total} */
const splitPieces = computed(() => splitPieceMap(list.value))

/** 同一个镜头因过长被迫拆开：在父子之间画一条承接线 */
function connectorOf(i: number): { index: number; total: number } | null {
  const b = visible.value[i]
  const prev = visible.value[i - 1]
  if (!b || !prev || !isSplitPair(prev, b)) return null
  return splitPieces.value.get(b.id) ?? null
}

/** 同一镜头的相邻拍标题：只喂给卡片上的单点 AI 判断来去，界面上不显示 */
function neighborTitle(beat: Beat, dir: -1 | 1): string | undefined {
  const i = list.value.findIndex((x) => x.id === beat.id)
  const target = i < 0 ? undefined : list.value[i + dir]
  return target?.title || undefined
}

function setFilter(v: FilterMode) {
  filterMode.value = v
  void nextTick(() => document.getElementById('en-list')?.scrollTo({ top: 0 }))
}

/** 紧凑模式点「展开编辑」：切到全字段，并把这一定位到视野中间 */
async function expandTo(id: ID) {
  variant.value = 'full'
  await nextTick()
  document.getElementById('en-b-' + id)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

/* ------------------------------ 批量出图 ------------------------------ */

/*
 * 批量不是"把所有段都出图"：得先勾。勾选态本身也是一份自检清单 ——
 * 卡片描边一亮，就知道这几段要出、其余不动。
 *
 * 默认全选"还没有任何关键帧"的段（重复出图只会覆盖用户挑好的图）；
 * 想覆盖、想在某段再加一张，在弹窗里自己勾上并把帧号填到想要的位置。
 */
const pickMode = ref(false)
const picked = ref<Set<ID>>(new Set())
const batchOpen = ref(false)

const pickedBeats = computed(() => list.value.filter((b) => picked.value.has(b.id)))

function togglePick(id: ID, next: boolean) {
  const set = new Set(picked.value)
  if (next) set.add(id)
  else set.delete(id)
  picked.value = set
}

function pickMissing() {
  const set = new Set<ID>()
  for (const b of list.value) {
    // 判"这一段有没有关键帧"，不是"有没有首帧"：帧位是任意的，
    // 只在中间挂了图也算已经有图了。
    if (!keyframesOf(registry.assets, b.id).length) set.add(b.id)
  }
  picked.value = set
  if (!set.size) message.info('每一段都有图了：想再添一张就在弹窗里逐段勾')
}

function startPick() {
  pickMode.value = true
  pickMissing()
}

/**
 * 已经失效的段：这一段的某张关键帧出图之后，提示词或台词又改过。
 *
 * 这不是"错误"，但成片会明显地不对 —— 画面还是旧文本的样子。
 * 单独给一个入口，改完文本的人能一键把它们挑出来重出。
 */
const staleBeatIds = computed(() => {
  const out = new Set<ID>()
  for (const b of list.value) {
    const now = {
      context: images.keyframePrompt(b.id, 'at'),
      dialogue: (b.dialogue ?? '').trim()
    }
    if (keyframesOf(registry.assets, b.id).some((a) => keyframeDrift(a, now).any)) out.add(b.id)
  }
  return out
})

function pickStale() {
  pickMode.value = true
  picked.value = new Set(staleBeatIds.value)
  if (!picked.value.size) message.info('没有失效的关键帧：改了提示词或台词之后才会出现')
}

function stopPick() {
  pickMode.value = false
  picked.value = new Set()
}

/** 出完就把这几段从勾选里摘掉：留着勾只会让"还要出哪几段"看不清 */
function onBatchDone(ids: ID[]) {
  batchOpen.value = false
  if (!ids.length) return
  const set = new Set(picked.value)
  for (const id of ids) set.delete(id)
  picked.value = set
  emit('changed')
}

/* ---------------------------- 素材预览 ---------------------------- */

/*
 * 点缩略图弹这里，而不是 window.open 一个新标签 —— 新标签会把列表位置、
 * 过滤条件全丢掉，核对十几段就是十几个标签页。
 */
const previewAsset = ref<Asset | null>(null)
const previewOpen = computed({
  get: () => previewAsset.value !== null,
  set: (v: boolean) => {
    if (!v) previewAsset.value = null
  }
})

/** 帧位说明只有这一层算得出来（要拿拍的帧数） */
const previewHint = computed(() => {
  const a = previewAsset.value
  if (!a) return ''
  if (a.kind === 'material' || a.kind === 'keyframe') {
    const beat = list.value.find((b) => b.id === a.refId)
    const f = beat ? beatFrames(beat, settings.value) : 0
    return a.kind === 'material' ? startFrameLabel(a, f) : `本段落点 · ${frameLabel(a, f)}`
  }
  const pic = a.pictureN ? `P${a.pictureN} · ` : ''
  return `${pic}主体参考图 · 跨段共用`
})

/* ------------------------------ 选项表 ------------------------------ */

const entityOptions = computed(() =>
  registry.sortedEntities.map((e) => ({
    label: `${e.name}${e.subjectN != null ? `（S${e.subjectN}）` : ''}${e.kind === 'speaking' ? ' · 说话' : ''}`,
    value: e.id
  }))
)

const speakerOptions = computed(() =>
  registry.speakingEntities.map((e) => ({
    label: `${e.name}${e.sx != null ? `（S${e.sx}）` : ''}`,
    value: e.id
  }))
)

/** 场景候选只取 type = scene 的实体 */
const sceneOptions = computed(() =>
  registry.sortedEntities
    .filter((e) => e.type === 'scene')
    .map((e) => ({ label: `${e.name}${e.subjectN != null ? `（S${e.subjectN}）` : ''}`, value: e.id }))
)

/* ------------------------------ 写入 ------------------------------ */

async function patch(id: ID, p: Partial<Beat>) {
  await beats.updateBeat(id, p)
  emit('changed')
}

/* --------------------------- 分批填充 --------------------------- */

const BATCH_OPTIONS = [6, 8, 12, 16, 24, 40].map((n) => ({ label: `${n} 拍`, value: n }))

const needsFill = (b: Beat) => !b.enriched || !b.entities.length

/** 本次填充会被切成几批（与 runFill 的目标选择保持一致） */
const fillBatches = computed(() => {
  const pending = list.value.filter(needsFill).length
  const count = pending || list.value.length
  if (!count) return 0
  return Math.ceil(count / Math.max(1, settings.value.beatBatchSize))
})

async function setBatchSize(v: number) {
  await project.updateSettings({ beatBatchSize: v })
}

async function runFill() {
  if (!provider.ready) {
    message.warning('请先在模型设置里配置好供应商')
    return
  }
  if (!registry.entities.length) {
    message.warning('请先在「主体登记」tab 里登记角色、场景等主体')
    return
  }
  const pending = list.value.filter(needsFill)
  const targets = pending.length ? pending : list.value
  if (!targets.length) return

  try {
    const details = await pipeline.runStage2(targets, registry.entities, project.settings)
    // 精确匹配优先；模糊匹配留痕提醒；没命中的不绑（该片段保持未就绪状态）
    const fuzzyPairs: string[] = []
    const unmatched = new Set<string>()
    const resolveWith = makeEntityResolver(registry.entities, (raw, hit) => {
      fuzzyPairs.push(`${raw} → ${hit}`)
    })
    const touched = await beats.applyDetails(project.currentId!, details, (name) => {
      const r = resolveWith(name)
      if (r.match === 'none' && name.trim()) unmatched.add(name.trim())
      return r.id
    })
    emit('changed')
    message.success(`已填充 ${touched} / ${targets.length} 个片段`)
    if (fuzzyPairs.length || unmatched.size) {
      const bits: string[] = []
      if (fuzzyPairs.length)
        bits.push(
          `${fuzzyPairs.length} 个实体名是模糊匹配（${fuzzyPairs.slice(0, 3).join('，')}${
            fuzzyPairs.length > 3 ? '…' : ''
          }），可能绑错，请复核`
        )
      if (unmatched.size)
        bits.push(
          `${unmatched.size} 个实体名未登记（${[...unmatched].slice(0, 4).join('，')}${
            unmatched.size > 4 ? '…' : ''
          }），对应片段绑定不完整`
        )
      message.warning(bits.join('；'))
    }
  } catch (e) {
    message.error((e as Error).message)
  }
}

async function confirmAllReady() {
  const ids = list.value.filter((b) => !hasIssue(b) && !b.enriched).map((b) => b.id)
  if (!ids.length) {
    message.info('没有需要确认的片段')
    return
  }
  await beats.updateMany(ids, { enriched: true })
  message.success(`已确认 ${ids.length} 个片段`)
}
</script>

<template>
  <div style="height: 100%; display: flex; flex-direction: column">
    <div class="panel-head" style="border-radius: 0">
      <div class="row" style="gap: 10px">
        <span>细节填充</span>
        <n-tag size="small" :bordered="false">{{ readyCount }} / {{ list.length }} 无问题</n-tag>
        <n-tag v-if="missingCount" size="small" type="error" :bordered="false">
          {{ missingCount }} 个待补
        </n-tag>
        <span class="muted" style="font-size: 12px">已确认 {{ confirmedCount }}</span>
      </div>
      <div class="row" style="gap: 8px">
        <span class="muted" style="font-size: 12.5px">每批</span>
        <n-select
          size="small"
          style="width: 92px"
          :value="settings.beatBatchSize"
          :options="BATCH_OPTIONS"
          @update:value="setBatchSize"
        />
        <span class="muted" style="font-size: 12px; white-space: nowrap">
          {{ fillBatches }} 批
        </span>
        <n-button size="small" quaternary @click="confirmAllReady">全部确认</n-button>
        <n-button
          size="small"
          type="primary"
          :loading="pipeline.running"
          :disabled="!provider.ready"
          @click="runFill"
        >
          {{ pipeline.running ? pipeline.progress : '阶段二：AI 填充细节' }}
        </n-button>
      </div>
    </div>

    <!-- 筛选 + 密度：把"要改哪几段"和"一段占屏幕多少"放在同一行 -->
    <div class="en-bar">
      <div class="en-chips">
        <button class="en-chip" :class="{ on: filterMode === 'all' }" @click="setFilter('all')">
          全部<span>{{ list.length }}</span>
        </button>
        <button class="en-chip err" :class="{ on: filterMode === 'todo' }" @click="setFilter('todo')">
          待补<span>{{ missingCount }}</span>
        </button>
        <button class="en-chip" :class="{ on: filterMode === 'ready' }" @click="setFilter('ready')">
          无问题<span>{{ readyCount }}</span>
        </button>
      </div>

      <!--
        两颗批量：跑的是卡片上**配置好的占位**，不是"猜哪些段缺东西"。
        数字就是还等着合成的格子数，跑完归零 —— 这是这张表最实在的进度。

        它们得**一眼看出来是按钮**：之前和筛选统计（全部 12 / 待补 0）并排、
        用最淡的 tertiary、字还小，数到 0 时整颗灰掉 —— 实机看就是一行统计文字，
        谁也不觉得那能点。现在单独成一区（左边一条分隔线），带图标 + 数量徽标。
      -->
      <div class="en-batch">
        <n-button
          size="small"
          type="primary"
          secondary
          class="en-act"
          :loading="slotBatch.genning.value"
          :disabled="slotBatch.genning.value"
          :title="
            imgPairs.length
              ? `按配置把 ${imgPairs.length} 格图片一次出完（每格用自己的提示词与参考图，落在自己配的那一帧）`
              : '还没有待出图的格子：在卡片上点「＋图片配置」写一句提示词'
          "
          data-en-batch="gen"
          @click="runGenSlots"
        >
          <template #icon>
            <svg class="en-act-ico" viewBox="0 0 16 16" aria-hidden="true">
              <rect
                x="1.7"
                y="2.7"
                width="12.6"
                height="10.6"
                rx="2.1"
                fill="none"
                stroke="currentColor"
                stroke-width="1.25"
              />
              <circle cx="5.5" cy="6.1" r="1.15" fill="currentColor" />
              <path
                d="M2.8 11.4 6.2 8.2l2.3 2.1 1.9-1.6 2.3 2.1"
                fill="none"
                stroke="currentColor"
                stroke-width="1.25"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </template>
          <span v-if="slotBatch.genning.value">{{ slotBatch.genLabel.value }}</span>
          <template v-else>
            批量出图<b class="en-act-n" :class="{ zero: !imgPairs.length }">{{ imgPairs.length }}</b>
          </template>
        </n-button>
        <n-button
          size="small"
          type="primary"
          secondary
          class="en-act"
          :loading="slotBatch.synthing.value"
          :disabled="slotBatch.synthing.value"
          :title="
            audPairs.length
              ? `按配置把 ${audPairs.length} 格语音一次合成（每格用自己的文本与音色，从自己配的那一帧起）`
              : '还没有待配音的格子：台词段会自动带一格，动作段点「＋音频配置」'
          "
          data-en-batch="synth"
          @click="runSynthSlots"
        >
          <template #icon>
            <svg class="en-act-ico" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M2.2 6.1h1.9l3.2-2.7v9.2L4.1 9.9H2.2z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.25"
                stroke-linejoin="round"
              />
              <path
                d="M10.1 5.6a3.3 3.3 0 0 1 0 4.8M12.2 3.6a6 6 0 0 1 0 8.8"
                fill="none"
                stroke="currentColor"
                stroke-width="1.25"
                stroke-linecap="round"
              />
            </svg>
          </template>
          <span v-if="slotBatch.synthing.value">{{ slotBatch.synthLabel.value }}</span>
          <template v-else>
            批量合成<b class="en-act-n" :class="{ zero: !audPairs.length }">{{ audPairs.length }}</b>
          </template>
        </n-button>
      </div>

      <!-- 按模板批量出图：勾段 → 一次提交 → 结果各自挂回原段（没有配置时的老路子） -->
      <template v-if="!pickMode">
        <n-button
          size="small"
          quaternary
          title="按模板批量出图：勾选若干段，一次出多张关键帧（不用先在卡上写配置）"
          @click="startPick"
        >
          勾选出图
        </n-button>
        <!-- 出图之后改了台词 / 画面描述的段：图还在，但已经不是这一段现在的样子 -->
        <n-button
          v-if="staleBeatIds.size"
          size="small"
          tertiary
          type="warning"
          :title="`${staleBeatIds.size} 段的关键帧已经跟不上现在的提示词 / 台词：点一下把它们挑出来重出`"
          @click="pickStale()"
        >
          失效 {{ staleBeatIds.size }}
        </n-button>
      </template>
      <template v-else>
        <span class="en-picked mono">已选 {{ picked.size }}</span>
        <n-button size="small" quaternary @click="pickMissing()">选空缺</n-button>
        <n-button
          size="small"
          quaternary
          :disabled="!staleBeatIds.size"
          :title="`挑出关键帧已失效的 ${staleBeatIds.size} 段`"
          @click="pickStale()"
        >
          选失效 {{ staleBeatIds.size || '' }}
        </n-button>
        <n-button size="small" quaternary @click="picked = new Set()">清空</n-button>
        <n-button
          size="small"
          type="primary"
          :disabled="!picked.size"
          @click="batchOpen = true"
        >
          出图 {{ picked.size || '' }}
        </n-button>
        <n-button size="small" quaternary @click="stopPick">退出</n-button>
      </template>

      <div class="en-bar-mid">
        <div class="en-progress">
          <n-progress type="line" :percentage="progress" :height="5" :show-indicator="false" />
        </div>
        <span class="muted" style="font-size: 11.5px; white-space: nowrap">
          镜头描述 Enter / 画面描述 Ctrl+Enter 跳到下一段的同一栏
        </span>
      </div>

      <div class="en-seg" title="展开后字段全部铺在卡片上；紧凑只显示摘要">
        <button :class="{ on: variant === 'full' }" @click="variant = 'full'">展开</button>
        <button :class="{ on: variant === 'compact' }" @click="variant = 'compact'">紧凑</button>
      </div>
    </div>

    <StageAdvice
      stage="enrich"
      scope="beats"
      :presets="[
        '运镜太单一了，多换几种景别',
        '有几个片段的主体绑错了',
        '画面描述太空，补上参考图里的特征'
      ]"
      @applied="emit('changed')"
    />

    <div style="flex: 1; min-height: 0; position: relative; display: flex">
      <div class="scroll-pane" id="en-list" style="flex: 1; padding: 14px 16px 40px">
        <n-alert v-if="pipeline.error" type="error" :bordered="false" style="margin-bottom: 12px">
          {{ pipeline.error }}
        </n-alert>

        <div v-if="!list.length" class="empty">
          <div>还没有片段，先回到阶段一拆解</div>
        </div>

        <div v-else-if="!visible.length" class="empty">
          <div v-if="filterMode === 'todo'">没有待补的片段，全部绑定完整</div>
          <div v-else>没有符合筛选的片段</div>
          <div class="muted" style="font-size: 12.5px; margin-top: 6px">
            <n-button size="tiny" quaternary @click="setFilter('all')">看全部</n-button>
          </div>
        </div>

        <div v-else class="en-grid" :class="`v-${variant}`">
          <template v-for="(b, i) in visible" :key="b.id">
            <div v-if="connectorOf(i)" class="split-connector">
              <span class="split-connector-line" />
              <span class="split-connector-label">
                同一镜头承接 · 第 {{ connectorOf(i)!.index }}/{{ connectorOf(i)!.total }} 段
              </span>
              <span class="split-connector-line" />
            </div>
            <EnrichBeatCard
              :beat="b"
              :index="list.indexOf(b)"
              :settings="settings"
              :variant="variant"
              :entity-by-id="registry.entityById"
              :scene-options="sceneOptions"
              :entity-options="entityOptions"
              :speaker-options="speakerOptions"
              :split-piece="splitPieces.get(b.id) ?? null"
              :pickable="pickMode"
              :picked="picked.has(b.id)"
              :prev-title="neighborTitle(b, -1)"
              :next-title="neighborTitle(b, 1)"
              @pick="togglePick"
              @patch="patch"
              @preview="(a: Asset) => (previewAsset = a)"
              @expand="expandTo"
              @changed="emit('changed')"
            />
          </template>
        </div>
      </div>

      <SectionNav v-if="visible.length >= 2" title="片段" container="#en-list" :items="beatNav" />
    </div>

    <!-- 参考素材：段内素材（关键帧 / 音视频）/ 主体绑定图，各有各的槽位 -->
    <AssetPreview
      v-model:show="previewOpen"
      :asset="previewAsset"
      :hint="previewHint"
      :prompt="previewAsset?.genPrompt ?? ''"
    />

    <BatchKeyframeDialog
      v-model:show="batchOpen"
      :beats="pickedBeats"
      @done="onBatchDone"
    />
  </div>
</template>

<style scoped>
.en-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: none;
  padding: 7px 16px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
}
.en-chips {
  display: flex;
  gap: 4px;
  flex: none;
}
/*
 * 批量的两颗单独成一区：左边一条竖分隔，和「全部 / 待补 / 无问题」这些
 * 只读统计分开 —— 一边是"看数据"，一边是"干活"。按钮本身不许被压扁。
 */
.en-batch {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding-left: 12px;
  border-left: 1px solid var(--line);
}
.en-batch :deep(.n-button) {
  flex: none;
  font-weight: 600;
  font-size: 12.5px;
}
.en-act-ico {
  width: 14px;
  height: 14px;
  opacity: 0.9;
}
/*
 * 还有几格等着合成 / 出图：跑完归零，就是这一页最实在的进度。
 * 底色不能写 currentColor —— 那取的是**自己**的 color，会白底白字看不见，
 * 直接给实心主色 + 白字。
 */
.en-act-n {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  margin-left: 6px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 10.5px;
  font-weight: 700;
  line-height: 1;
}
.en-act-n.zero {
  opacity: 0.38;
}
/* 批量勾选的计数：不是按钮，只是"勾了几段"的读数 */
.en-picked {
  font-size: 12px;
  color: var(--accent);
  background: rgba(47, 111, 237, 0.09);
  border-radius: 4px;
  padding: 2px 7px;
  white-space: nowrap;
}
.en-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  font-size: 12px;
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 999px;
  cursor: pointer;
}
.en-chip > span {
  font-size: 10.5px;
  opacity: 0.8;
}
.en-chip:hover {
  color: var(--text);
  border-color: var(--line-strong);
}
.en-chip.on {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: var(--accent-line);
}
.en-chip.err:hover {
  color: var(--err);
  border-color: var(--err-line);
}
.en-chip.err.on {
  color: var(--err-ink);
  background: var(--err-soft);
  border-color: var(--err-line);
}
.en-bar-mid {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}
/* 进度条自己撑满会横穿整条工具条，用一个定宽壳子收住 */
.en-progress {
  width: 120px;
  flex: none;
}
.en-seg {
  display: inline-flex;
  flex: none;
  padding: 2px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 7px;
}
.en-seg button {
  padding: 1px 10px;
  font-size: 12px;
  color: var(--muted);
  background: transparent;
  border: 0;
  border-radius: 5px;
  cursor: pointer;
}
.en-seg button.on {
  color: var(--text);
  background: var(--panel);
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.08);
}

/* ------------------------------ 分栏 ------------------------------ */

/*
 * 一屏只装三段太浪费横向空间。按**列表自身**的宽度自动铺列
 * （auto-fill + 每列最小 430），窗口/侧栏/目录怎么变都不用改代码；
 * 卡片内部再按"卡有多宽"自行把字段降列（见 EnrichBeatCard 的容器查询）。
 */

.en-grid {
  display: grid;
  /*
   * 自动铺列：每列至少 430px，能塞几列塞几列（1380 的列表宽 = 三列 444）。
   * 写死"两列/三列"在换屏幕时总有一档不合身，这里让宽度自己决定。
   */
  /* 用 min(430px, 100%) 兜住窄窗口：否则容器比 430 还窄时轨道会把内容顶出横向滚动条 */
  grid-template-columns: repeat(auto-fill, minmax(min(430px, 100%), 1fr));
  gap: 8px;
  align-items: start;
}

/* 承接线要横穿整行，否则会把分栏拆得七零八落 */
.en-grid .split-connector {
  grid-column: 1 / -1;
}
</style>
