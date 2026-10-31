<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NInput, NProgress, NSelect, NSlider, NTag, useMessage } from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { usePipelineStore } from '@/stores/pipeline'
import { useProviderStore } from '@/stores/provider'
import { useSeriesStore } from '@/stores/series'
import BeatCard from '@/components/BeatCard.vue'
import AiSplitDialog from '@/components/AiSplitDialog.vue'
import type { SplitPart } from '@/domain/beats'
import SectionNav, { type SectionNavItem } from '@/components/SectionNav.vue'
import StageAdvice from '@/components/StageAdvice.vue'
import BeatEditDialog from '@/components/BeatEditDialog.vue'
import InfoTip from '@/components/common/InfoTip.vue'
import { requestEntityRegister } from '@/composables/useEntityRegister'
import { subjectPicturesOf } from '@/domain/references'
import { beatFrames, beatsFrames, countHanzi, secondsFromFrames } from '@/domain/timing'
import { makeEntityResolver, splitPieceMap } from '@/domain/beats'
import { CHARS_PER_BEAT_HINT, splitStory } from '@/domain/chunk'
import type { Beat, Entity, ID } from '@/domain/types'
import type { EntityProposal } from '@/stores/pipeline'
import type { Stage1Beat } from '@/core/llm/prompts'

const emit = defineEmits<{ changed: []; register: [] }>()

const project = useProjectStore()
const beats = useBeatStore()
const registry = useRegistryStore()
const pipeline = usePipelineStore()
const provider = useProviderStore()
const series = useSeriesStore()
const message = useMessage()

const story = ref('')
const appendMode = ref(false)
const selected = ref<ID[]>([])

/**
 * 外部项目（系列）主体 —— 拆解时一起交给模型。
 *
 * 两级结构里，项目层的实体表是跨集复用的母版。第 2 集拆解时如果只看到本集实体，
 * 模型就会把「林医生」再定义一遍，描述还和第 1 集对不上。所以这里先把母版读出来
 * （带设定，不只是名字），模型按名字引用，落库时从项目取用而不是新建。
 */
const seriesId = computed(() => project.current?.seriesId ?? null)
const projectSubjects = ref<Entity[]>([])
/** 真正交给模型的母版：本集已有的同名主体由「本集已有」那一份负责，不再重复列出 */
const masterContext = computed(() => {
  const local = new Set(registry.entities.map((e) => e.name))
  return projectSubjects.value.filter((e) => !local.has(e.name))
})

async function loadProjectSubjects() {
  const sid = seriesId.value
  projectSubjects.value = sid ? await series.subjectsOf(sid) : []
}

const settings = computed(() => project.settings)
const list = computed(() => beats.ordered)

const totalFrames = computed(() => beatsFrames(list.value, settings.value))
const totalSeconds = computed(() => secondsFromFrames(totalFrames.value, settings.value.fps))
const hanzi = computed(() =>
  list.value.filter((b) => b.kind === 'dialogue').reduce((s, b) => s + countHanzi(b.dialogue), 0)
)
const dialogueFrames = computed(() =>
  list.value.filter((b) => b.kind === 'dialogue').reduce((s, b) => s + beatFrames(b, settings.value), 0)
)
const splitHints = computed(() => list.value.filter((b) => beats.shouldSplit(b.id, settings.value)).length)

/**
 * 卡片上要能看出"这一段会自动带哪几张参考图"。
 * 图挂在主体上（entity.pictureN），段里只要用了这个主体就自动带上 ——
 * 这里只是把它显示出来，提供不了"只给这一段换图"这种操作。
 */
const refPics = computed(() => {
  const m = new Map<ID, Array<{ id: string; name: string; url: string | null; pic: number }>>()
  for (const b of list.value) {
    m.set(
      b.id,
      subjectPicturesOf(b, registry.entityById, registry.assets).map((s) => ({
        id: s.entity.id,
        name: s.entity.name,
        url: registry.assetUrl(s.asset),
        pic: s.pictureN
      }))
    )
  }
  return m
})

/* ------------------------------ 选项表 ------------------------------ */
/** 卡片上直接改绑定用：场景 / 主体 / 说话人各一份候选 */

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
const dialogueRatio = computed(() =>
  totalFrames.value ? Math.min(100, (dialogueFrames.value / totalFrames.value) * 100) : 0
)

/** "过长被迫拆开"的分片血缘：beatId -> {index, total} */
const splitPieces = computed(() => splitPieceMap(list.value))

/** 侧边目录：逐片段定位，超长待拆的标黄 */
const beatNav = computed<SectionNavItem[]>(() =>
  list.value.map((b, i) => ({
    id: `sp-b-${b.id}`,
    label: `${String(i + 1).padStart(2, '0')} ${b.title || '（未命名）'}`,
    tone: beats.shouldSplit(b.id, settings.value) ? 'warn' : 'default'
  }))
)

/* --------------------------- 分批拆解 --------------------------- */

const CHUNK_OPTIONS = [800, 1200, 1500, 2000, 3000, 5000].map((n) => ({
  label: `${n} 字`,
  value: n
}))

const chunkChars = computed(() => settings.value.storyChunkChars)

/** 按当前粒度切出来会有多少批 */
const storyBatches = computed(() => splitStory(story.value, chunkChars.value).length)

/** 每批大致对应多少个片段（只做量级提示，不是硬限制） */
const beatsPerBatch = computed(() => Math.max(1, Math.round(chunkChars.value / CHARS_PER_BEAT_HINT)))

async function setChunkChars(v: number) {
  await project.updateSettings({ storyChunkChars: v })
}

onMounted(() => {
  story.value = project.current?.story ?? ''
  void loadProjectSubjects()
})

watch(
  () => project.currentId,
  () => void loadProjectSubjects()
)

watch(
  () => project.current?.story,
  (v) => {
    if (v !== undefined && v !== story.value && !story.value) story.value = v
  }
)

function saveStory() {
  if (!project.current) return
  project.patch(project.current.id, { story: story.value })
}

function guard() {
  if (!story.value.trim()) {
    message.warning('先粘贴故事原文')
    return false
  }
  if (!provider.ready) {
    message.warning('请先在模型设置里填好 Base URL / Key / 模型名')
    return false
  }
  return true
}

/**
 * 实体的增删统一在「主体登记」页做（卡片：已登记 / 待登记一屏铺开）。
 *
 * 拆解这一页只负责切片，但切完要能说清「哪些名字我没见过」：
 * 模型提到的新实体、以及片段里对不上号的名字，都在这里汇总成一条提示，
 * 点「去主体登记」把名字带过去当候选 —— 而不是在这一页再养一个登记弹窗。
 */
const offers = ref<EntityProposal[]>([])
/** 拆解完仍没绑上的实体名 */
const missingNames = ref<string[]>([])

/** 汇总成一份候选：模型给了类型的按模型的，只有名字的按角色猜（到对面能改） */
const pendingRegister = computed<EntityProposal[]>(() => {
  const out: EntityProposal[] = []
  const seen = new Set<string>()
  // 已经登记过的名字不再提示：从「主体登记」回来时，这条提示该自己消失
  const local = new Set(registry.entities.map((e) => e.name))
  for (const o of offers.value) {
    const name = (o.name ?? '').trim()
    if (!name || seen.has(name) || local.has(name)) continue
    seen.add(name)
    out.push({ ...o, name })
  }
  for (const raw of missingNames.value) {
    const name = raw.trim()
    if (!name || seen.has(name) || local.has(name)) continue
    seen.add(name)
    out.push({
      name,
      type: 'character',
      kind: 'non_speaking',
      accepted: true,
      exists: false,
      inProject: false,
      refCount: 0
    })
  }
  return out
})

function gotoRegister() {
  requestEntityRegister(pendingRegister.value)
  emit('register')
}

function dismissRegister() {
  offers.value = []
  missingNames.value = []
}

async function generate() {
  if (!guard()) return
  saveStory()
  // 拆解前重读一次母版：用户可能刚在项目页加过主体，别让模型看到旧清单
  await loadProjectSubjects()
  try {
    const result = await pipeline.runStage1(
      story.value,
      registry.entities.map((e) => e.name),
      project.settings,
      // 带上项目层母版：模型直接按名字引用，不再重复定义
      { projectSubjects: masterContext.value }
    )
    // 模型顺带登记了它没见过的人：记下来，切完在右栏顶上提示「去主体登记」。
    // 片段照常落库 —— 绑不上的名字会以「未绑定」显形，总比压着片段不让人看到强。
    offers.value = result.newEntities ?? []
    await applyBeats(result.beats)
  } catch (e) {
    message.error((e as Error).message)
  }
}

/**
 * 片段落库：片段 → 绑定 → 编号。实体登记在「主体登记」页做过，这里只做三件善后：
 *   1. 兜底取用 —— 片段引用了母版主体、本集却还没有，自动取用，
 *      否则这些片段会以「未绑定」落在 ②③ 里，看起来像模型漏了。
 *   2. 名字 → id 映射 —— 精确匹配优先；模糊匹配留痕；没命中的不绑，
 *      让它以「未绑定」显形，而不是悄悄绑到某个同名近似的人身上。
 *   3. 没绑上的名字记下来，右栏顶上给一条「去主体登记」的入口。
 */
async function applyBeats(drafts: Stage1Beat[]) {
  const pid = project.currentId
  if (!pid) return
  const sid = seriesId.value
  let injected = 0
  let synced = 0

  if (sid && drafts.length) {
    const local = new Set(registry.entities.map((e) => e.name))
    const referenced = new Set<string>()
    for (const d of drafts) {
      if (d.scene) referenced.add(d.scene)
      if (d.speaker) referenced.add(d.speaker)
      for (const n of d.entities ?? []) if (n) referenced.add(n)
    }
    const missing = new Set([...referenced].filter((n) => n && !local.has(n)))
    const masters = masterContext.value.filter((e) => missing.has(e.name))
    if (masters.length) {
      for (const m of masters) {
        const r = await series.injectToEpisode(sid, m.id, pid)
        if (r.reused) synced += 1
        else injected += 1
      }
      await registry.load(pid)
    }
  }

  const fuzzyPairs: string[] = []
  const unmatched = new Set<string>()

  if (drafts.length) {
    if (appendMode.value) await beats.appendDrafts(pid, drafts)
    else await beats.replaceAll(pid, drafts)

    const resolveWith = makeEntityResolver(registry.entities, (raw, hit) => {
      fuzzyPairs.push(`${raw} → ${hit}`)
    })
    const resolve = (name: string): string | undefined => {
      const r = resolveWith(name)
      if (r.match === 'none' && name.trim()) unmatched.add(name.trim())
      return r.id
    }
    const mapping: Record<string, { scene?: string; entities?: string[]; speaker?: string }> = {}
    beats.ordered.forEach((b, i) => {
      const d = drafts[i]
      if (!d) return
      mapping[b.id] = { scene: d.scene, entities: d.entities, speaker: d.speaker }
    })
    await beats.bindEntityNames(mapping, resolve)
  }

  // 编号依赖片段顺序，必须等片段落库后再排
  await registry.renumber(beats.beats)
  await loadProjectSubjects()
  emit('changed')

  const bound = beats.ordered.filter((b) => (b.entities ?? []).length).length
  const parts: string[] = []
  if (drafts.length) parts.push(`已生成 ${drafts.length} 个片段`)
  if (injected) parts.push(`自动取用 ${injected} 个主体`)
  if (synced) parts.push(`同步 ${synced} 个已有副本`)
  if (drafts.length) parts.push(`绑定 ${bound} 个片段`)
  message.success(parts.join(' · ') || '已完成')
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
        }），对应片段未绑定`
      )
    message.warning(bits.join('；'))
  }
  // 没绑上的名字留在这儿：右栏顶部给一条「去主体登记」的入口，别让人自己去文里找
  missingNames.value = [...unmatched]
}

async function update(id: ID, patch: Partial<Beat>) {
  await beats.updateBeat(id, patch)
}

/* ------------------------ 片段编辑弹窗 ------------------------ */

const editingId = ref<ID | null>(null)
const showEditor = ref(false)

const editingBeat = computed(() => (editingId.value ? beats.beatById.get(editingId.value) ?? null : null))

function openEditor(id: ID) {
  editingId.value = id
  showEditor.value = true
}

async function remove(id: ID) {
  await beats.removeBeats([id])
  selected.value = selected.value.filter((x) => x !== id)
}

/* ---------------------- AI 拆细（先预览再应用） ---------------------- */

const aiSplitId = ref<ID | null>(null)
const aiSplitOpen = ref(false)

const aiSplitBeat = computed(() =>
  aiSplitId.value ? beats.beatById.get(aiSplitId.value) ?? null : null
)

/** 前后拍标题 + 场景：只喂给模型判断这一拍在整场里的位置，界面上不显示 */
const aiSplitPrevTitle = computed(() => {
  const i = list.value.findIndex((b) => b.id === aiSplitId.value)
  return i > 0 ? list.value[i - 1]?.title : undefined
})
const aiSplitNextTitle = computed(() => {
  const i = list.value.findIndex((b) => b.id === aiSplitId.value)
  return i >= 0 ? list.value[i + 1]?.title : undefined
})
const aiSplitScene = computed(() => {
  const id = aiSplitBeat.value?.sceneId
  const e = id ? registry.entityById.get(id) : undefined
  return e?.name
})

function openAiSplit(id: ID) {
  aiSplitId.value = id
  aiSplitOpen.value = true
}

async function applyAiSplit(parts: SplitPart[]) {
  const id = aiSplitId.value
  if (!id) return
  const ok = await beats.split(id, settings.value, parts)
  message[ok ? 'success' : 'warning'](ok ? `已拆成 ${parts.length} 拍` : '没有拆出新的片段')
  if (ok) emit('changed')
}

async function split(id: ID) {
  const n = beats.suggestSplit(id, settings.value)
  if (n <= 1) {
    message.info('这个片段时长正常，不需要拆分')
    return
  }
  const ok = await beats.splitAuto(id, settings.value)
  message[ok ? 'success' : 'info'](ok ? `已拆成 ${n} 个片段` : '没有可拆分的内容')
}

async function mergeAdjacent(id: ID) {
  const idx = list.value.findIndex((b) => b.id === id)
  const target = idx < 0 ? -1 : idx === list.value.length - 1 ? idx - 1 : idx + 1
  if (target < 0) {
    message.info('没有可合并的相邻片段')
    return
  }
  const a = list.value[idx]
  const b = list.value[target]
  if (a.kind !== b.kind) {
    message.warning('只能合并相同类型的片段')
    return
  }
  const ok = await beats.merge([a.id, b.id], settings.value)
  message[ok ? 'success' : 'info'](ok ? '已合并' : '合并失败')
}

async function move(from: number, to: number) {
  const item = list.value[from]
  if (!item) return
  const targetIndex = to > from ? to - 1 : to
  await beats.moveBeat(item.id, targetIndex)
}

async function splitAll() {
  const targets = list.value.filter((b) => beats.shouldSplit(b.id, settings.value))
  if (!targets.length) {
    message.info('没有超长的片段')
    return
  }
  for (const t of targets) await beats.splitAuto(t.id, settings.value)
  message.success(`已拆分 ${targets.length} 个超长片段`)
}

function toggleSelect(id: ID) {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((x) => x !== id)
    : [...selected.value, id]
}

async function mergeSelected() {
  if (selected.value.length < 2) {
    message.warning('至少选中 2 个片段')
    return
  }
  const ok = await beats.merge(selected.value, settings.value)
  if (ok) selected.value = []
  message[ok ? 'success' : 'info'](ok ? '已合并' : '合并失败（类型不同）')
}

async function clearAll() {
  await beats.clearAll(project.currentId!)
  selected.value = []
  message.success('已清空全部片段')
}
</script>

<template>
  <div style="height: 100%; display: flex">
    <!-- 左：故事 -->
    <div
      style="
        width: 380px;
        flex: 0 0 380px;
        min-height: 0;
        border-right: 1px solid var(--line);
        background: var(--panel);
        display: flex;
        flex-direction: column;
      "
    >
      <div class="panel-head" style="border-radius: 0">
        <span class="row" style="gap: 0; align-items: center">
          故事原文
          <InfoTip
            :width="360"
            text="粘贴故事 / 剧本 / 分场稿。模型会把它拆成一个个原子片段：动作、换场、台词各自独立，台词只保留纯台词本身。"
          />
        </span>
        <n-button size="tiny" quaternary @click="saveStory">保存</n-button>
      </div>

      <!--
        下半区整体滚动（表头留在外面不跟着滚）。
        textarea 用 min-height 兜底而不是 min-height: 0 —— 窗口变矮时先保住它的可读高度，
        多出来的控制区和意见框靠这一层滚动够到，不会被外层 overflow: hidden 裁掉。
      -->
      <div class="scroll-pane" style="flex: 1; display: flex; flex-direction: column">
      <div style="flex: 1; padding: 12px; min-height: 200px; display: flex">
        <n-input
          v-model:value="story"
          type="textarea"
          placeholder="粘贴故事 / 剧本 / 分场稿"
          style="height: 100%"
          :input-props="{ style: 'height:100%; font-size:13px; line-height:1.7' }"
        />
      </div>
      <div style="padding: 12px; border-top: 1px solid var(--line)">
        <div class="row" style="gap: 8px; margin-bottom: 10px; flex-wrap: wrap">
          <n-tag size="small" :bordered="false">
            本集主体 {{ registry.entities.length }}
          </n-tag>
          <n-tag v-if="seriesId" size="small" type="info" :bordered="false">
            项目主体 {{ projectSubjects.length }}
          </n-tag>
          <n-tag size="small" :bordered="false">
            片段 {{ list.length }}
          </n-tag>
          <n-tag v-if="storyBatches > 1" size="small" type="info" :bordered="false">
            分 {{ storyBatches }} 批
          </n-tag>
        </div>

        <div class="row-between" style="margin-bottom: 10px">
          <span class="row muted" style="font-size: 12px; gap: 0; align-items: center">
            每批原文
            <InfoTip
              placement="top-start"
              :width="360"
              text="原文按自然段聚合到该长度后分批送模型，上一批末尾的片段会作为续接锚点回喂，实体命名跨批保持一致。&#10;批次越少越快，越长越容易在结尾走形。"
            />
          </span>
          <div class="row" style="gap: 6px">
            <n-select
              size="small"
              style="width: 96px"
              :value="chunkChars"
              :options="CHUNK_OPTIONS"
              @update:value="setChunkChars"
            />
            <span class="muted" style="font-size: 12px; white-space: nowrap">
              约 {{ beatsPerBatch }} 个片段
            </span>
          </div>
        </div>
        <!--
          拆解只管切片。这一集有谁是流程第 1 步（主体登记页左边那两步）定下的，
          所以不在这一页再放一颗「实体登记」按钮，两边各养一套只会口径不一。
        -->
        <n-button
          block
          type="primary"
          :loading="pipeline.running"
          :disabled="!provider.ready"
          @click="generate"
        >
          拆解分镜
        </n-button>
        <div v-if="pipeline.running" class="sp-run">{{ pipeline.progress }}</div>
        <div v-else class="sp-act-tip">
          {{
            !registry.entities.length
              ? '本集还没有登记主体：先在「主体登记」左边第 1 步拆分主体，否则片段落库后全是未绑定'
              : `本集 ${registry.entities.length} 个主体可引用${
                  seriesId && masterContext.length ? `，项目母版还有 ${masterContext.length} 个可穿梭` : ''
                }`
          }}
          <button class="sp-goto" @click="emit('register')">主体登记 →</button>
        </div>
        <div class="row" style="gap: 6px; margin-top: 8px; align-items: center">
          <n-button
            size="small"
            :type="appendMode ? 'primary' : 'default'"
            @click="appendMode = !appendMode"
          >
            {{ appendMode ? '追加模式' : '覆盖模式' }}
          </n-button>
          <InfoTip
            :width="280"
            :text="
              appendMode
                ? '新结果追加到现有片段之后。'
                : '新结果会覆盖当前全部片段（实体登记表不受影响）。'
            "
          />
          <n-button size="small" quaternary @click="clearAll">清空</n-button>
        </div>
      </div>
      </div>
      <!-- /下半区滚动 -->

      <StageAdvice
        stage="split"
        :presets="[
          '某些动作太长，帮我拆细',
          '台词和动作应该完全分开',
          '有片段绑错了场景或角色'
        ]"
        @applied="emit('changed')"
      />
    </div>

    <!-- 右：片段流水线 -->
    <div style="flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column">
      <div class="panel-head" style="border-radius: 0">
        <div class="row" style="gap: 10px">
          <span>分镜流水线</span>
          <n-tag size="small" :bordered="false">{{ list.length }} 个片段</n-tag>
          <n-tag size="small" :bordered="false">{{ totalFrames }} 帧 / {{ totalSeconds.toFixed(2) }}s</n-tag>
          <n-tag size="small" :bordered="false" type="info">台词 {{ hanzi }} 字</n-tag>
          <n-tag v-if="splitHints" size="small" type="warning" :bordered="false">
            {{ splitHints }} 个过长待拆
          </n-tag>
        </div>
        <div class="row" style="gap: 8px">
          <n-button size="small" :disabled="splitHints === 0" @click="splitAll">
            一键拆分超长
          </n-button>
          <n-button size="small" :disabled="selected.length < 2" @click="mergeSelected">
            合并选中（{{ selected.length }}）
          </n-button>
        </div>
      </div>

      <div style="padding: 0 14px; border-bottom: 1px solid var(--line); background: var(--panel)">
        <div class="row-between" style="padding: 8px 0 4px">
          <div class="row" style="gap: 10px; min-width: 0; align-items: center">
            <span class="muted" style="font-size: 12.5px; white-space: nowrap">台词时长占比</span>
            <InfoTip size="sm" :width="260" text="标题 / 台词 / 帧数 / 场景 / 主体 都能在卡片上直接改。" />
          </div>
          <span class="muted mono" style="font-size: 12px; white-space: nowrap">
            {{ dialogueFrames }} / {{ totalFrames }} 帧
          </span>
        </div>
        <n-progress
          type="line"
          :percentage="Number(dialogueRatio.toFixed(1))"
          :height="6"
          :show-indicator="false"
          style="margin-bottom: 10px"
        />
      </div>

      <div style="flex: 1; min-height: 0; position: relative; display: flex">
      <div class="scroll-pane" id="sp-beats" style="flex: 1; padding: 14px">
        <n-alert v-if="pipeline.error" type="error" :bordered="false" style="margin-bottom: 12px">
          {{ pipeline.error }}
        </n-alert>

        <!--
          拆解引用的名字没登记上：给一条直达入口，别让人自己去原文里找是哪几个。
          带过去的候选既包括模型提到的新实体（有类型），也包括纯属对不上号的名字。
        -->
        <div v-if="pendingRegister.length" class="sp-miss">
          <span class="sp-miss-t">
            {{ pendingRegister.length }} 个实体还没登记，对应片段现在是未绑定
          </span>
          <span class="sp-miss-l">
            {{ pendingRegister.slice(0, 6).map((p) => p.name).join('、') }}{{ pendingRegister.length > 6 ? '…' : '' }}
          </span>
          <n-button size="tiny" type="primary" ghost @click="gotoRegister">去主体登记</n-button>
          <n-button size="tiny" quaternary @click="dismissRegister">忽略</n-button>
        </div>

        <div v-if="!list.length" class="empty">
          <div style="font-size: 15px; margin-bottom: 6px">还没有片段</div>
          <div>先在「主体登记」左边第 1 步拆分主体，再回来点「拆解分镜」</div>
        </div>

        <div class="sp-grid">
          <BeatCard
            v-for="(b, i) in list"
            :key="b.id"
            :beat="b"
            :index="i"
            :settings="settings"
            :entity-by-id="registry.entityById"
            :scene-options="sceneOptions"
            :entity-options="entityOptions"
            :speaker-options="speakerOptions"
            :ref-pics="refPics.get(b.id) ?? []"
            :selected="selected.includes(b.id)"
            :split-hint="beats.shouldSplit(b.id, settings) ? beats.suggestSplit(b.id, settings) : 0"
            :split-piece="splitPieces.get(b.id) ?? null"
            selectable
            draggable
            @select="toggleSelect"
            @patch="update"
            @edit="openEditor"
            @remove="remove"
            @split="split"
            @ai-split="openAiSplit"
            @merge="mergeAdjacent"
            @move="move"
          />
        </div>
      </div>
      <SectionNav v-if="list.length >= 2" title="片段" container="#sp-beats" :items="beatNav" />
      </div>
    </div>

    <AiSplitDialog
      v-model:show="aiSplitOpen"
      :beat="aiSplitBeat"
      :settings="settings"
      :scene-name="aiSplitScene"
      :prev-title="aiSplitPrevTitle"
      :next-title="aiSplitNextTitle"
      @apply="applyAiSplit"
    />

    <BeatEditDialog
      v-model:show="showEditor"
      :beat="editingBeat"
      :settings="settings"
      :entities="registry.entities"
      :entity-by-id="registry.entityById"
      @patch="update"
    />
  </div>
</template>

<style scoped>
/* 进度条旁的一句提示：比正文小一号、灰色，不抢「台词时长占比」的注意力 */
/* 提示句里的跳转：不抢按钮的分量，但要能点 */
.sp-goto {
  margin-left: 6px;
  border: 0;
  background: none;
  padding: 0;
  font-size: 11.5px;
  color: var(--accent-ink);
  cursor: pointer;
}
.sp-goto:hover {
  text-decoration: underline;
}
.sp-act-tip {
  margin-top: 6px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--muted-3);
}
.sp-run {
  margin-top: 6px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--accent-ink);
}

/* 未登记实体提示条：左红边 + 一行名字，按钮贴右边 */
.sp-miss {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  padding: 8px 10px;
  border: 1px solid var(--warn-line);
  border-left: 3px solid var(--warn);
  border-radius: var(--r-md);
  background: var(--warn-soft);
}
.sp-miss-t {
  font-size: var(--fs-base);
  color: var(--warn-ink);
}
.sp-miss-l {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
