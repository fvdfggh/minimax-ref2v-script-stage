<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NInput, NProgress, NSlider, NTag, useMessage } from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { usePipelineStore } from '@/stores/pipeline'
import { useProviderStore } from '@/stores/provider'
import BeatCard from '@/components/BeatCard.vue'
import StageAdvice from '@/components/StageAdvice.vue'
import BeatEditDialog from '@/components/BeatEditDialog.vue'
import EntityProposalDialog from '@/components/EntityProposalDialog.vue'
import { beatFrames, beatsFrames, countHanzi, secondsFromFrames } from '@/domain/timing'
import { CHARS_PER_BEAT_HINT, splitStory } from '@/domain/chunk'
import type { Beat, ID } from '@/domain/types'
import type { EntityProposal } from '@/stores/pipeline'
import type { Stage1Beat } from '@/core/llm/prompts'

const emit = defineEmits<{ changed: [] }>()

const project = useProjectStore()
const beats = useBeatStore()
const registry = useRegistryStore()
const pipeline = usePipelineStore()
const provider = useProviderStore()
const message = useMessage()

const story = ref('')
const appendMode = ref(false)
const selected = ref<ID[]>([])

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
const dialogueRatio = computed(() =>
  totalFrames.value ? Math.min(100, (dialogueFrames.value / totalFrames.value) * 100) : 0
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
})

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

/** 待落库的片段草案（等实体确认后一起写入） */
const pendingDrafts = ref<Stage1Beat[]>([])
const proposals = ref<EntityProposal[]>([])
const showProposals = ref(false)

async function generate() {
  if (!guard()) return
  saveStory()
  try {
    const result = await pipeline.runStage1(
      story.value,
      registry.entities.map((e) => e.name),
      project.settings
    )
    if (result.newEntities.length) {
      // 先让用户过一遍模型登记的实体，再一起落库
      pendingDrafts.value = result.beats
      proposals.value = result.newEntities
      showProposals.value = true
      return
    }
    await applyStage1(result.beats, [])
  } catch (e) {
    message.error((e as Error).message)
  }
}

/** 不拆片段，只让模型梳理实体 */
async function extractEntities() {
  if (!guard()) return
  saveStory()
  try {
    const list = await pipeline.runEntityExtract(
      story.value,
      registry.entities.map((e) => e.name),
      project.settings
    )
    if (!list.length) {
      message.info('模型没有发现新实体')
      return
    }
    pendingDrafts.value = []
    proposals.value = list
    showProposals.value = true
  } catch (e) {
    message.error((e as Error).message)
  }
}

/** 先建实体 → 重排编号 → 再按名字回填片段的实体绑定 */
async function applyStage1(drafts: Stage1Beat[], accepted: EntityProposal[]) {
  const pid = project.currentId
  if (!pid) return

  let createdCount = 0
  if (accepted.length) {
    const created = await registry.addEntitiesBulk(
      pid,
      accepted.map((a) => ({
        name: a.name,
        type: a.type,
        kind: a.kind,
        voiceDesc: a.voiceDesc,
        textDesc: a.textDesc,
        note: a.note
      }))
    )
    createdCount = created.length
  }

  if (drafts.length) {
    if (appendMode.value) await beats.appendDrafts(pid, drafts)
    else await beats.replaceAll(pid, drafts)

    // 实体名单 → id 映射（先按名字精确匹配，再退化到包含匹配）
    const resolve = (name: string): string | undefined => {
      const exact = registry.entities.find((e) => e.name === name)
      if (exact) return exact.id
      const fuzzy = registry.entities.find((e) => e.name.includes(name) || name.includes(e.name))
      return fuzzy?.id
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
  emit('changed')

  const bound = beats.ordered.filter((b) => (b.entities ?? []).length).length
  message.success(
    `已生成 ${drafts.length} 个片段 · 新建 ${createdCount} 个实体 · 绑定 ${bound} 个片段`
  )
  pendingDrafts.value = []
  proposals.value = []
}

async function confirmProposals(accepted: EntityProposal[]) {
  await applyStage1(pendingDrafts.value, accepted)
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
        border-right: 1px solid var(--line);
        background: var(--panel);
        display: flex;
        flex-direction: column;
      "
    >
      <div class="panel-head" style="border-radius: 0">
        <span>故事原文</span>
        <n-button size="tiny" quaternary @click="saveStory">保存</n-button>
      </div>
      <div style="flex: 1; padding: 12px; min-height: 0; display: flex">
        <n-input
          v-model:value="story"
          type="textarea"
          placeholder="粘贴故事 / 剧本 / 分场稿。模型会把它拆成一个个原子片段：动作、换场、台词各自独立，台词只保留纯台词本身。"
          style="height: 100%"
          :input-props="{ style: 'height:100%; font-size:13px; line-height:1.7' }"
        />
      </div>
      <div style="padding: 12px; border-top: 1px solid var(--line)">
        <div class="row" style="gap: 8px; margin-bottom: 10px">
          <n-tag size="small" :bordered="false">
            已知实体 {{ registry.entities.length }}
          </n-tag>
          <n-tag size="small" :bordered="false">
            片段 {{ list.length }}
          </n-tag>
          <n-tag v-if="storyBatches > 1" size="small" type="info" :bordered="false">
            分 {{ storyBatches }} 批
          </n-tag>
        </div>
        <div class="row-between" style="margin-bottom: 10px">
          <span class="muted" style="font-size: 12px">每批原文</span>
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
        <div class="muted" style="font-size: 11.5px; margin-bottom: 10px; line-height: 1.6">
          原文按自然段聚合到该长度后分批送模型，上一批末尾的片段会作为续接锚点回喂，
          实体命名跨批保持一致。批次越少越快，越长越容易在结尾走形。
        </div>
        <n-button
          type="primary"
          block
          :loading="pipeline.running"
          :disabled="!provider.ready"
          @click="generate"
        >
          {{ pipeline.running ? pipeline.progress : '阶段一：拆解分镜 + 登记实体' }}
        </n-button>
        <div class="row" style="gap: 8px; margin-top: 8px">
          <n-button
            size="small"
            :loading="pipeline.running"
            :disabled="!provider.ready"
            @click="extractEntities"
          >
            只梳理实体
          </n-button>
          <n-button
            size="small"
            :type="appendMode ? 'primary' : 'default'"
            @click="appendMode = !appendMode"
          >
            {{ appendMode ? '追加模式' : '覆盖模式' }}
          </n-button>
          <n-button size="small" quaternary @click="clearAll">清空</n-button>
        </div>
        <div class="muted" style="font-size: 12px; margin-top: 8px">
          {{
            appendMode
              ? '新结果追加到现有片段之后'
              : '新结果会覆盖当前全部片段（实体注册表不受影响）'
          }}
        </div>
      </div>
      <div style="padding: 12px; border-top: 1px solid var(--line)">
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
    </div>

    <!-- 右：片段流水线 -->
    <div style="flex: 1; min-width: 0; display: flex; flex-direction: column">
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
          <span class="muted" style="font-size: 12.5px">台词时长占比</span>
          <span class="muted mono" style="font-size: 12px">
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

      <div class="scroll-pane" style="flex: 1; padding: 14px">
        <n-alert v-if="pipeline.error" type="error" :bordered="false" style="margin-bottom: 12px">
          {{ pipeline.error }}
        </n-alert>

        <div v-if="!list.length" class="empty">
          <div style="font-size: 15px; margin-bottom: 6px">还没有片段</div>
          <div>在左侧粘贴故事，点击「阶段一：拆解分镜 + 登记实体」</div>
        </div>

        <div class="beat-grid">
          <BeatCard
            v-for="(b, i) in list"
            :key="b.id"
            :beat="b"
            :index="i"
            :settings="settings"
            :entity-by-id="registry.entityById"
            :selected="selected.includes(b.id)"
            :split-hint="beats.shouldSplit(b.id, settings) ? beats.suggestSplit(b.id, settings) : 0"
            selectable
            draggable
            @select="toggleSelect"
            @edit="openEditor"
            @remove="remove"
            @split="split"
            @merge="mergeAdjacent"
            @move="move"
          />
        </div>
      </div>
    </div>

    <EntityProposalDialog
      v-model:show="showProposals"
      :proposals="proposals"
      @confirm="confirmProposals"
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
