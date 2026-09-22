<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NInput,
  NModal,
  NPopconfirm,
  NSelect,
  NSlider,
  NSwitch,
  NTag,
  useMessage
} from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { useAssemblyStore, type SegmentView } from '@/stores/assembly'
import SeamPanel from '@/components/SeamPanel.vue'
import StageAdvice from '@/components/StageAdvice.vue'
import { BEAT_KIND_COLOR, BEAT_KIND_LABEL, collectScenes, resolveSubjectId } from '@/domain/beats'
import { beatFrames, secondsFromFrames } from '@/domain/timing'
import { formatPad } from '@/domain/frames'
import type { AssemblyMode, Beat, ID } from '@/domain/types'
import { AUTO_KINDS } from '@/domain/types'

const project = useProjectStore()
const beats = useBeatStore()
const registry = useRegistryStore()
const assembly = useAssemblyStore()
const message = useMessage()

const showCreate = ref(false)
const newName = ref('')
const newMode = ref<AssemblyMode>('scene_first')

const settings = computed(() => project.settings)
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

/* --------------------------- 级联：分组归位 --------------------------- */

/** 不在任何分组里的片段。上游新增的片段如果不归位，会从后面所有阶段里静默消失 */
const orphanIds = computed(() => {
  if (!current.value) return []
  const assigned = new Set(current.value.groups.flatMap((g) => g.beatIds))
  return list.value.filter((b) => !assigned.has(b.id)).map((b) => b.id)
})

const aligning = ref(false)

async function align(notify = true) {
  if (!current.value || !orphanIds.value.length) return
  aligning.value = true
  try {
    const res = await assembly.reconcile(current.value.id, list.value)
    if (notify) {
      const bits: string[] = []
      if (res.adopted) bits.push(`${res.adopted} 个新片段已并入相邻段`)
      if (res.dropped) bits.push(`${res.dropped} 个已删片段的引用已清掉`)
      message.success(bits.join('，') || '已重新对齐')
    }
  } finally {
    aligning.value = false
  }
}

// 上游增删片段之后，进到这个阶段就自动归位一次，避免内容静默丢失
onMounted(() => {
  if (orphanIds.value.length) void align(false)
})

watch(
  () => orphanIds.value.length,
  async (n) => {
    if (n) await align(false)
  }
)

const totals = computed(() => {
  const frames = views.value.reduce((s, v) => s + v.frames, 0)
  const black = views.value.filter((v) => v.nextSeam?.blackFallback).length
  const cut = views.value.filter((v) => v.nextSeam?.needsTailCut).length
  const over = views.value.filter((v) => v.over).length
  const errors = views.value.reduce(
    (s, v) => s + v.issues.filter((i) => i.level === 'error').length,
    0
  )
  return { frames, black, cut, over, errors }
})

const modeOptions: Array<{ label: string; value: AssemblyMode; desc: string }> = [
  { label: '按场景优先', value: 'scene_first', desc: '同场景尽量合并，场景切换处强制拆' },
  { label: '填满优先', value: 'fill_max', desc: '贪心累加到接近上限再拆，段数最少' },
  { label: '按说话人拆', value: 'speaker_split', desc: '说话人变化就拆，音色更集中' },
  { label: '全手工', value: 'manual', desc: '先合成一段，由你手工切' }
]

watch(
  () => assembly.currentId,
  () => {
    /* views 会自动重算 */
  }
)

async function create() {
  if (!newName.value.trim()) {
    message.warning('给方案起个名字')
    return
  }
  const report = await assembly.createAssembly(
    project.currentId!,
    newName.value.trim(),
    newMode.value,
    list.value,
    settings.value,
    registry.entityById
  )
  showCreate.value = false
  newName.value = ''
  message.success(
    `已生成 ${report.groups.length} 段${report.skipped.length ? `，${report.skipped.length} 个片段因未绑定实体被跳过` : ''}`
  )
  if (report.blackFallbacks) {
    message.warning(`有 ${report.blackFallbacks} 个缝合点需要黑屏兜底`)
  }
}

async function regenerate() {
  if (!current.value) return
  const report = await assembly.regenerate(
    current.value.id,
    list.value,
    settings.value,
    registry.entityById
  )
  if (report) {
    message.success(`已重新组合为 ${report.groups.length} 段`)
  }
}

async function updateStrategy(patch: Record<string, unknown>) {
  if (!current.value) return
  await assembly.updateStrategy(current.value.id, patch)
}

async function splitAt(groupId: ID, atIndex: number) {
  if (!current.value) return
  await assembly.splitGroupAt(current.value.id, groupId, atIndex, list.value)
  message.success('已在此处切开')
}

async function mergeWithNext(groupId: ID) {
  if (!current.value) return
  const idx = current.value.groups.findIndex((g) => g.id === groupId)
  if (idx < 0 || idx >= current.value.groups.length - 1) return
  const res = await assembly.mergeGroups(
    current.value.id,
    [groupId, current.value.groups[idx + 1].id],
    list.value,
    settings.value
  )
  if (res.ok && res.frames > settings.value.maxSegmentFrames) {
    message.warning(`合并后 ${res.frames} 帧，超过上限了`)
  } else if (res.ok) {
    message.success('已合并')
  }
}

function beatById(id: ID) {
  return beats.beatById.get(id)
}

function subjectName(id: ID | null) {
  if (!id) return '—'
  const e = registry.entityById.get(id)
  return e ? `${e.name}${e.subjectN != null ? ` S${e.subjectN}` : ''}` : id
}

function barClass(frames: number) {
  if (frames > settings.value.maxSegmentFrames) return 'is-over'
  if (frames > settings.value.maxSegmentFrames * 0.9) return 'is-warn'
  return ''
}

/** 本段涉及的所有场景，按出现顺序 */
function groupScenes(v: SegmentView) {
  return collectScenes(v.narrativeBeats).map((id) => ({
    id,
    name: registry.entityById.get(id)?.name ?? id
  }))
}

/* ---------------------- 帧长度补正 ---------------------- */

/**
 * 只保留叙事片段的副帧。
 * 预备镜头 / 尾帧切镜 / 黑屏每次重建都是新对象，存下来也会失配，
 * 它们始终按占比自动分摊，由差额补偿机制吸收手工改动。
 */
function narrativePad(v: SegmentView): Record<ID, number> {
  const ids = new Set(v.narrativeBeats.map((b) => b.id))
  const out: Record<ID, number> = {}
  for (const [id, n] of Object.entries(v.pad)) {
    if (ids.has(id)) out[id] = n
  }
  return out
}

/** 把当前（可能是自动分摊的）副帧固定下来，之后可以逐拍微调 */
async function pinPad(v: SegmentView) {
  if (!current.value) return
  await assembly.setGroupPad(current.value.id, v.group.id, narrativePad(v))
  message.success('副帧已固定，可逐拍调整')
}

/** 逐拍增减副帧（允许负数压缩） */
async function bumpPad(v: SegmentView, beatId: ID, delta: number) {
  if (!current.value) return
  const next = narrativePad(v)
  next[beatId] = (next[beatId] ?? 0) + delta
  await assembly.setGroupPad(current.value.id, v.group.id, next)
}

async function toggleRefPrev(v: SegmentView, value: boolean) {
  if (!current.value) return
  await assembly.setGroupRefPrev(current.value.id, v.group.id, value)
  message.info(value ? '已改为引用上段（帧长需为 17k）' : '已改为不引用上段（帧长需为 5+17k）')
}

function familyTag(v: SegmentView) {
  return v.refPrev ? '17k' : '5+17k'
}

/** 引擎自动生成的拼接片段不参与副帧分摊 */
function isAutoBeat(b: Beat) {
  return AUTO_KINDS.includes(b.kind)
}
</script>

<template>
  <div style="height: 100%; display: flex; flex-direction: column">
    <div class="panel-head" style="border-radius: 0">
      <div class="row" style="gap: 10px">
        <span>组合方案</span>
        <n-select
          v-if="assembly.assemblies.length"
          size="small"
          style="width: 200px"
          :value="assembly.currentId"
          :options="assembly.assemblies.map((a) => ({ label: a.name, value: a.id }))"
          @update:value="(v: string) => (assembly.currentId = v)"
        />
        <n-tag size="small" :bordered="false">{{ views.length }} 段</n-tag>
        <n-tag size="small" :bordered="false">{{ totals.frames }} 帧</n-tag>
        <n-tag v-if="totals.cut" size="small" type="info" :bordered="false">
          {{ totals.cut }} 处尾帧切镜
        </n-tag>
        <n-tag v-if="totals.black" size="small" type="warning" :bordered="false">
          {{ totals.black }} 处黑屏兜底
        </n-tag>
        <n-tag v-if="totals.over" size="small" type="error" :bordered="false">
          {{ totals.over }} 段超限
        </n-tag>
      </div>
      <div class="row" style="gap: 8px">
        <n-button size="small" :disabled="!current" @click="regenerate">重新组合</n-button>
        <n-popconfirm
          v-if="current"
          @positive-click="assembly.removeAssembly(current!.id)"
        >
          <template #trigger>
            <n-button size="small" quaternary type="error">删除方案</n-button>
          </template>
          删除这个组合方案？
        </n-popconfirm>
        <n-button size="small" type="primary" @click="showCreate = true">新建方案</n-button>
      </div>
    </div>

    <div
      v-if="current"
      style="
        padding: 10px 16px;
        background: var(--panel);
        border-bottom: 1px solid var(--line);
        display: flex;
        gap: 24px;
        align-items: center;
        flex-wrap: wrap;
      "
    >
      <div class="row" style="gap: 8px">
        <span class="muted" style="font-size: 12.5px">策略</span>
        <n-select
          size="small"
          style="width: 130px"
          :value="current.strategy.mode"
          :options="modeOptions.map((m) => ({ label: m.label, value: m.value }))"
          @update:value="(v: string) => updateStrategy({ mode: v as AssemblyMode })"
        />
      </div>
      <div class="row" style="gap: 8px; min-width: 220px; flex: 1">
        <span class="muted" style="font-size: 12.5px; white-space: nowrap">
          场景切分权重 {{ current.strategy.weights.scene }}
        </span>
        <n-slider
          style="flex: 1; min-width: 120px"
          :value="current.strategy.weights.scene"
          :min="0"
          :max="30"
          :step="1"
          @update:value="(v: number) => updateStrategy({ weights: { ...current!.strategy.weights, scene: v } })"
        />
      </div>
      <div class="row" style="gap: 8px; min-width: 220px; flex: 1">
        <span class="muted" style="font-size: 12.5px; white-space: nowrap">
          填满权重 {{ current.strategy.weights.waste }}
        </span>
        <n-slider
          style="flex: 1; min-width: 120px"
          :value="current.strategy.weights.waste"
          :min="0"
          :max="2"
          :step="0.05"
          @update:value="(v: number) => updateStrategy({ weights: { ...current!.strategy.weights, waste: v } })"
        />
      </div>
      <div class="row" style="gap: 8px">
        <n-switch
          size="small"
          :value="settings.scenePriorityOnSeam"
          @update:value="(v: boolean) => project.updateSettings({ scenePriorityOnSeam: v })"
        />
        <span class="muted" style="font-size: 12.5px; white-space: nowrap">
          换场时场景优先切镜
        </span>
      </div>
    </div>

    <div v-if="current && orphanIds.length" style="padding: 12px 16px 0">
      <n-alert type="warning" :bordered="false">
        有 {{ orphanIds.length }} 个片段不在任何段里（上游新增的片段还没归位），
        它们不会出现在后续阶段和交付结果里。
        <n-button size="tiny" :loading="aligning" style="margin-left: 8px" @click="align()">
          并入相邻段
        </n-button>
      </n-alert>
    </div>

    <StageAdvice
      v-if="current"
      stage="assemble"
      scope="groups"
      :presets="[
        '某段太长了，帮我从台词那里切开',
        '这两段应该合成一段',
        '这几段的缝合总要走黑屏，调整一下边界'
      ]"
    />

    <div class="scroll-pane" style="flex: 1; padding: 16px">
      <div v-if="!assembly.assemblies.length" class="empty">
        <div style="font-size: 15px; margin-bottom: 6px">还没有组合方案</div>
        <div>新建一个方案，引擎会把片段切成 ≤141 帧的段，并自动判定每处缝合</div>
        <div style="margin-top: 14px">
          <n-button type="primary" @click="showCreate = true">新建方案</n-button>
        </div>
      </div>

      <template v-else>
        <div v-for="(v, i) in views" :key="v.group.id" style="margin-bottom: 6px">
          <div v-if="v.seam" style="margin-bottom: 6px">
            <SeamPanel :seam="v.seam" :index="i" :entity-by-id="registry.entityById" />
          </div>

          <div class="group-box" :class="{ 'is-over': v.over }">
            <div class="row-between">
              <div class="row" style="gap: 8px">
                <span style="font-weight: 600">seg{{ String(i + 1).padStart(2, '0') }}</span>
                <n-switch
                  size="small"
                  :value="v.refPrev"
                  @update:value="(val: boolean) => toggleRefPrev(v, val)"
                />
                <span class="muted" style="font-size: 12px">引用上段</span>
                <span class="mono" style="font-size: 12px">
                  {{ v.rawFrames }}
                  <span
                    v-if="v.padTotal"
                    :style="{ color: v.padTotal > 0 ? '#b06a12' : '#2b56b8' }"
                  >
                    {{ formatPad(v.padTotal) }}
                  </span>
                  = {{ v.frames }} 帧
                </span>
                <span
                  v-if="v.padTotal < 0"
                  class="tag-chip"
                  style="background: #e7f0ff; color: #2b56b8"
                >
                  压缩 {{ -v.padTotal }}
                </span>
                <span
                  class="tag-chip"
                  :style="
                    v.aligned
                      ? { background: '#e9f7ef', color: '#217a52' }
                      : { background: '#fdecec', color: '#a12d2d' }
                  "
                >
                  {{ familyTag(v) }}
                </span>
                <span class="muted mono" style="font-size: 12px">
                  {{ secondsFromFrames(v.frames, settings.fps).toFixed(3) }}s
                </span>
                <span
                  v-for="s in groupScenes(v)"
                  :key="s.id"
                  class="tag-chip"
                  style="background: #eef4ee; color: #3d6b4a"
                >
                  ▣ {{ s.name }}
                </span>
                <span
                  v-if="!groupScenes(v).length"
                  class="tag-chip"
                  style="background: #fdecec; color: #a12d2d"
                >
                  未指定场景
                </span>
                <n-tag v-if="v.over" size="tiny" type="error" :bordered="false">超限</n-tag>
                <span
                  v-if="v.nextSeam?.blackFallback"
                  class="tag-chip"
                  style="background: #fdf0dc; color: #8a6008"
                >
                  尾帧黑屏
                </span>
                <span
                  v-else-if="v.nextSeam?.needsTailCut"
                  class="tag-chip"
                  style="background: #e7f0ff; color: #2b56b8"
                >
                  尾帧切镜 → {{ subjectName(v.nextSeam.tailCutTargetId) }}
                </span>
                <span
                  v-else-if="v.nextSeam"
                  class="tag-chip"
                  style="background: #e9f7ef; color: #217a52"
                >
                  顺接
                </span>
              </div>
              <div class="row" style="gap: 6px">
                <n-button
                  size="tiny"
                  quaternary
                  :disabled="!v.padAuto"
                  @click="pinPad(v)"
                >
                  固定副帧
                </n-button>
                <n-button
                  size="tiny"
                  quaternary
                  :disabled="v.padAuto"
                  @click="assembly.clearGroupPad(current!.id, v.group.id)"
                >
                  恢复自动
                </n-button>
                <n-button
                  size="tiny"
                  quaternary
                  :disabled="i >= views.length - 1"
                  @click="mergeWithNext(v.group.id)"
                >
                  与下一段合并
                </n-button>
              </div>
            </div>

            <div class="frame-bar" :class="barClass(v.frames)" style="margin: 8px 0">
              <i :style="{ width: Math.min(100, (v.frames / settings.maxSegmentFrames) * 100) + '%' }" />
            </div>

            <div class="lane" style="padding: 4px 0 8px">
              <div v-for="(b, k) in v.beats" :key="b.id" class="lane-cell">
                <div
                  class="beat-card"
                  :style="{
                    borderLeftColor: BEAT_KIND_COLOR[b.kind],
                    opacity: b.kind === 'preshoot' || b.kind === 'tail_cut' || b.kind === 'black' ? 0.82 : 1
                  }"
                >
                  <div class="row-between" style="gap: 4px">
                    <span
                      class="tag-chip"
                      :style="{
                        background: BEAT_KIND_COLOR[b.kind] + '18',
                        color: BEAT_KIND_COLOR[b.kind],
                        fontSize: '11px'
                      }"
                    >
                      {{ BEAT_KIND_LABEL[b.kind] }}
                    </span>
                    <span
                      class="mono"
                      style="font-size: 11px"
                      :style="{ color: v.pad[b.id] ? (v.pad[b.id] > 0 ? '#b06a12' : '#2b56b8') : 'var(--muted)' }"
                    >
                      {{ beatFrames(b, settings)
                      }}<template v-if="v.pad[b.id]">{{ formatPad(v.pad[b.id]) }}</template>f
                    </span>
                  </div>
                  <div style="font-size: 12.5px; margin-top: 4px; word-break: break-word">
                    {{ b.title }}
                  </div>
                  <div v-if="b.kind === 'dialogue'" class="mono" style="font-size: 11.5px; color: #2f9e6f">
                    {{ b.dialogue }}
                  </div>
                  <div class="muted" style="font-size: 11px; margin-top: 3px">
                    {{ subjectName(resolveSubjectId(b)) }}
                  </div>
                </div>
                <div
                  v-if="!isAutoBeat(b)"
                  class="row"
                  style="justify-content: center; gap: 2px; margin-top: 4px"
                >
                  <n-button size="tiny" quaternary @click="bumpPad(v, b.id, -1)">−</n-button>
                  <span
                    class="tag-chip"
                    :style="{
                      background: !v.pad[b.id] ? '#f7f8fa' : v.pad[b.id] > 0 ? '#fff3e0' : '#e7f0ff',
                      color: !v.pad[b.id] ? '#8b93a1' : v.pad[b.id] > 0 ? '#b06a12' : '#2b56b8',
                      fontSize: '11px'
                    }"
                  >
                    副帧 {{ formatPad(v.pad[b.id] ?? 0) }}
                  </span>
                  <n-button size="tiny" quaternary @click="bumpPad(v, b.id, 1)">+</n-button>
                </div>

                <div v-if="k > 0" style="text-align: center; margin-top: 4px">
                  <n-button
                    size="tiny"
                    quaternary
                    style="font-size: 11px"
                    @click="splitAt(v.group.id, k)"
                  >
                    ↑ 在此切开
                  </n-button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <n-modal v-model:show="showCreate" preset="card" title="新建组合方案" style="max-width: 520px">
      <div class="stack">
        <div>
          <div class="muted" style="margin-bottom: 6px">方案名称</div>
          <n-input v-model:value="newName" placeholder="例如：方案A-按场景 / 快剪版" />
        </div>
        <div>
          <div class="muted" style="margin-bottom: 6px">组合策略</div>
          <div class="stack" style="gap: 6px">
            <div
              v-for="m in modeOptions"
              :key="m.value"
              class="panel"
              :style="{
                padding: '8px 12px',
                cursor: 'pointer',
                borderColor: newMode === m.value ? 'var(--accent)' : 'var(--line)',
                background: newMode === m.value ? 'var(--accent-soft)' : 'var(--panel)'
              }"
              @click="newMode = m.value"
            >
              <div style="font-weight: 500; font-size: 13.5px">{{ m.label }}</div>
              <div class="muted" style="font-size: 12px">{{ m.desc }}</div>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button @click="showCreate = false">取消</n-button>
          <n-button type="primary" @click="create">生成方案</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>
