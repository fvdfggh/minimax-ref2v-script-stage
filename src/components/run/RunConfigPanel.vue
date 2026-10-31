<script setup lang="ts">
/**
 * 运行配置页。
 *
 * 这里管的全是**导演节点**上的运行旋钮 —— 正是控制台刻意不显示的那部分
 * （一个导演节点就是一个工作台，塞进参数卡片只会变成一堆没上下文的滑杆）。
 * 换 seed、降步数、只用 1 张卡试跑、把缓存指到另一块盘，都在这里。
 *
 * 表单项多，但都是同一个 `patch(key, value)`：配置项是扁平的，逐个写方法不现实。
 */
import { computed, onMounted, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NInput,
  NInputNumber,
  NModal,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSwitch,
  NTag,
  useMessage
} from 'naive-ui'
import { useRunStore } from '@/stores/run'
import { useWorkflowStore } from '@/stores/workflow'
import { useDirectorStore } from '@/stores/director'
import InfoTip from '@/components/common/InfoTip.vue'
import { comfyGpus, type GpuInfo, type GpuSnapshot } from '@/core/comfy'
import { OWNED_DIRECTOR_KEYS } from '@/domain/director'
import type { DirectorInputSpec } from '@/domain/director'
import {
  CARD_OFF,
  RUN_MODEL_CHOICES,
  SAMPLERS,
  SCHEDULERS,
  applyRunConfigToApi,
  defaultRunConfig,
  directorNodeId,
  formatCardList,
  parseCardList,
  SECOND_SAMPLER_FOLLOW,
  SECOND_SEED_FIXED,
  SECOND_STAGE_OPTIONS,
  secondStageOf,
  validateRunConfig,
  type RunConfig,
  type SecondStage
} from '@/domain/run'

const run = useRunStore()
const workflow = useWorkflowStore()
const message = useMessage()

const showRenaming = ref(false)
const renameTo = ref('')

/**
 * 高级参数开关（二级采样 + 导演台其余参数）。
 *
 * 这两块加起来二十多个控件，但多数跑都不动 —— 默认折叠，首屏只留
 * 采样 / 画布 / 选卡三块。注意别按"节点分组"去拆，这是**按改动频率**分的：
 * 二级采样属于高级（大部分跑不开），选卡属于常用（换个卡数就变）。
 */
const advancedOpen = ref(false)

/** 左栏搜索 —— 十几条同名配置时唯一的定位手段 */
const cfgKeyword = ref('')

const filteredConfigs = computed(() => {
  const q = cfgKeyword.value.trim().toLowerCase()
  if (!q) return run.configs
  return run.configs.filter((c) => c.name.toLowerCase().includes(q))
})

/** 有几组重名 —— 历史数据里攒下来的，新建去重管不到它们 */
const dupGroups = computed(() => {
  const m = new Map<string, number>()
  for (const c of run.configs) m.set(c.name, (m.get(c.name) ?? 0) + 1)
  return [...m.values()].filter((n) => n > 1).length
})

function tidy() {
  const n = run.tidyNames()
  if (n) message.success(`已给 ${n} 个重名加序号`)
}

const cfg = computed(() => run.active)

/** 模板里导入的 API 基线：任务类型选项和自检都依赖它 */
const api = computed(() => workflow.active?.api ?? null)

const hasDirector = computed(() => !!directorNodeId(api.value))
const hasUpscale = computed(() =>
  Object.values(api.value ?? {}).some((n) => n?.class_type === 'MiniMaxH3LatentUpscaleModelOpt')
)

/** 任务类型：优先用工作流里的真实选项，没有就用当前值单选 */
const taskTypeOptions = computed(() => {
  const id = directorNodeId(api.value)
  const raw = id ? (api.value?.[id]?.inputs?.task_type as unknown) : undefined
  if (Array.isArray(raw) && raw.length) {
    return raw.map((v) => ({ label: String(v), value: String(v) }))
  }
  const cur = cfg.value?.taskType ?? ''
  return cur ? [{ label: cur, value: cur }] : []
})

function set(key: keyof RunConfig, value: unknown) {
  if (!cfg.value) return
  run.patch(cfg.value.id, { [key]: value } as Partial<RunConfig>)
}

/** 二采三态：改档位时把两个老布尔一起写一致（老配置里可能只有它们） */
/** 二采采样器候选：第一个固定是「跟随一采」（空串 = 交给节点自己决定） */
const secondSamplerOptions = [
  { label: SECOND_SAMPLER_FOLLOW, value: '' },
  ...SAMPLERS.map((s) => ({ label: s, value: s }))
]

const stageValue = computed(() => secondStageOf(cfg.value))
function patchStage(stage: SecondStage) {
  if (!cfg.value) return
  run.patch(cfg.value.id, {
    secondStage: stage,
    secondEnabled: stage !== 'off',
    secondOnly: stage === 'pair'
  })
}

/* ------------------------------ 探活 ------------------------------ */

// 「测试连接」按钮搬到了设置抽屉（SettingsDrawer）；这里只负责进页面时探一次，
// 顶栏那个状态灯读的就是这次的结果。

onMounted(() => {
  if (cfg.value) void run.probe(cfg.value.baseUrl)
  void loadGpus()
  if (cfg.value?.baseUrl) void director.loadSpec(cfg.value.baseUrl, directorClassType.value)
})

watch(
  () => cfg.value?.id,
  () => {
    if (cfg.value) void run.probe(cfg.value.baseUrl)
  }
)

watch(
  () => cfg.value?.baseUrl,
  (url) => {
    void loadGpus()
    if (url) void director.loadSpec(url, directorClassType.value)
  }
)

/* ------------------------------ 配置 CRUD ------------------------------ */

function createConfig() {
  run.create('新运行配置', api.value)
  message.success('已创建')
}

function copyConfig() {
  if (!cfg.value) return
  run.duplicate(cfg.value.id)
  message.success('已复制')
}

function removeConfig() {
  if (!cfg.value) return
  run.remove(cfg.value.id)
  message.success('已删除')
}

function openRename() {
  renameTo.value = cfg.value?.name ?? ''
  showRenaming.value = true
}

function commitRename() {
  if (!cfg.value) return
  run.rename(cfg.value.id, renameTo.value.trim())
  showRenaming.value = false
}

/** 用工作流里的真实值覆盖配置（换过工作流后用它对齐） */
function syncFromWorkflow() {
  if (!cfg.value) return
  if (!api.value) {
    message.warning('当前模板还没有导入 API 工作流')
    return
  }
  run.syncFromApi(cfg.value.id, api.value)
  message.success('已按工作流里的当前值刷新')
}

function resetConfig() {
  if (!cfg.value) return
  const id = cfg.value.id
  const name = cfg.value.name
  run.patch(id, { ...defaultRunConfig(), id, name })
  message.success('已恢复默认')
}

/* ------------------------------ 自检 ------------------------------ */

const problems = computed(() => {
  if (!cfg.value) return []
  return validateRunConfig(cfg.value, {
    hasApi: !!api.value,
    hasDirector: hasDirector.value,
    hasUpscaleNode: hasUpscale.value,
    visibleCards: comfyVisible.value ?? undefined
  })
})

/** 试算：套一次看命中多少参数（换过工作流后这是唯一的提前预警） */
const dry = ref<{ applied: number; skipped: string[] } | null>(null)

function runDry() {
  if (!cfg.value || !api.value) {
    message.warning('先导入 API 工作流才能试算')
    return
  }
  const res = applyRunConfigToApi(api.value, cfg.value, {
    episodeName: '第 01 集 · 夜班',
    timelineFrames: 0
  })
  dry.value = { applied: res.applied, skipped: res.skipped }
}

/* ------------------------------ 显卡 ------------------------------ */

/**
 * 选卡的真相有三个来源，优先级从高到低：
 *   1. ComfyUI 的 /object_info —— 节点此刻真实的枚举（可见卡的全部子集）
 *   2. 本机 nvidia-smi —— ComfyUI 没起时至少知道机器上插了几张
 *   3. 硬编码兜底
 * 关键是**不能写死 0,1**：节点侧是 combinations 全枚举，4 张卡就有 15 种组合，
 * 前端把选项钉死成几个预设等于把用户能选的卡数锁死。
 */
const gpuSnap = ref<GpuSnapshot | null>(null)
const gpuLoading = ref(false)
const gpuError = ref('')

async function loadGpus() {
  gpuLoading.value = true
  gpuError.value = ''
  try {
    gpuSnap.value = await comfyGpus(cfg.value?.baseUrl ?? '')
  } catch (err) {
    gpuError.value = err instanceof Error ? err.message : String(err)
  } finally {
    gpuLoading.value = false
  }
}

/** 本机插着的物理卡（名称/显存） */
const machineGpus = computed<GpuInfo[]>(() => gpuSnap.value?.gpus ?? [])

/** ComfyUI 能看见几张卡；连不上时为 null（此时不校验，别误报） */
const comfyVisible = computed<number | null>(() => {
  const c = gpuSnap.value?.comfy
  if (!c?.online || !c.visible) return null
  return c.visible
})

/** 当前勾选的卡（'关闭' → 空数组） */
const selectedCards = computed<number[]>(() => parseCardList(cfg.value?.cards ?? ''))

/** 物理上存在、但 ComfyUI 这会儿看不见的卡 → 勾不了，并说明为什么 */
const cardDisabled = computed<Set<number>>(() => {
  const vis = comfyVisible.value
  const set = new Set<number>()
  if (vis == null) return set
  for (const g of machineGpus.value) if (g.index >= vis) set.add(g.index)
  return set
})

/** 复选框的行：本机卡为准；本机读不到就用 ComfyUI 报的设备补位 */
const cardRows = computed<GpuInfo[]>(() => {
  if (machineGpus.value.length) return machineGpus.value
  return (gpuSnap.value?.comfy?.devices ?? []).map((d) => ({
    index: d.index,
    name: d.name,
    memoryTotal: Math.round((d.vramTotal ?? 0) / 1024 ** 2),
    memoryUsed: 0,
    util: 0
  }))
})

function toggleCard(index: number, on: boolean) {
  const next = new Set(selectedCards.value)
  if (on) next.add(index)
  else next.delete(index)
  set('cards', formatCardList([...next]))
}

function pickOnly(index: number) {
  set('cards', formatCardList([index]))
}

function pickAllVisible() {
  const n = comfyVisible.value ?? machineGpus.value.length
  set('cards', formatCardList(Array.from({ length: n }, (_, i) => i)))
}

/** 照抄到剪贴板的重启命令 —— 选卡要生效必须让 ComfyUI 看见这些卡 */
const restartCommand = computed(() => {
  const n = Math.max(...selectedCards.value, machineGpus.value.length - 1) + 1
  const all = n > 0 ? Array.from({ length: n }, (_, i) => i).join(',') : '0'
  return `--cuda-device ${all}`
})

async function copyRestart() {
  try {
    await navigator.clipboard.writeText(restartCommand.value)
    message.success('已复制启动参数')
  } catch {
    message.warning('剪贴板不可用，请手动复制')
  }
}

/**
 * 选卡的完整说明。以前这三段话常驻在选卡下面，占掉四行高度；
 * 但它们是"读一次就够"的原理说明，不是每次选卡都要看的信息。
 */
const cardHint = [
  '任意张数都可选：1 张 = 单卡原样不切分；2 张及以上 = 按块静态切分 + 段间波前（2×T10 实测约 1.6×）。',
  '候选是从节点当前枚举实时取的，不是写死的几个预设。',
  '必须让 ComfyUI 用上面的参数启动，卡才对它可见；否则选了不可见的卡会直接报错（不会悄悄降级）。',
  '切分覆盖留 auto 即可。'
].join('\n\n')

/* ------------------------------ 导演台其余参数 ------------------------------ */

/**
 * 导演台 38 个输入里，剧本台没提成一等公民字段的那些。
 *
 * 以前这些在剧本台上根本看不见，用户只能切回 ComfyUI 改 ——
 * 表现就是"导演台有这个、剧本台没有"，看着像漏功能。
 */
const director = useDirectorStore()

/** 当前工作流里导演节点用的 class_type（有两个历史名字，指名取更准） */
const directorClassType = computed(() => {
  const id = directorNodeId(api.value)
  const t = id ? api.value?.[id]?.class_type : undefined
  return typeof t === 'string' ? t : ''
})

/** 排除一等公民字段，剩下的才是"其余参数" */
const extraKnobs = computed(() => director.knobs.filter((s) => !OWNED_DIRECTOR_KEYS.has(s.name)))

const extraFilter = ref('')
const extraShown = computed(() => {
  const q = extraFilter.value.trim().toLowerCase()
  if (!q) return extraKnobs.value
  return extraKnobs.value.filter(
    (s) => s.name.toLowerCase().includes(q) || (s.tooltip ?? '').toLowerCase().includes(q)
  )
})

function extraValue(spec: DirectorInputSpec): unknown {
  const cur = cfg.value?.extras?.[spec.name]
  return cur === undefined ? spec.default : cur
}

function setExtra(name: string, value: unknown) {
  if (!cfg.value) return
  set('extras', { ...(cfg.value.extras ?? {}), [name]: value })
}

function clearExtra(name: string) {
  if (!cfg.value) return
  const next = { ...(cfg.value.extras ?? {}) }
  delete next[name]
  set('extras', next)
}

/** 这个值是不是用户动过（动过的显示"已改"，方便和节点默认区分） */
function isOverridden(spec: DirectorInputSpec): boolean {
  return cfg.value?.extras?.[spec.name] !== undefined
}
</script>

<template>
  <div class="cfg">
    <aside class="side-col" style="width: 250px">
      <div class="side-head">
        <span>
          运行配置
          <span class="muted" style="font-weight: 400">
            {{ filteredConfigs.length }}/{{ run.configs.length }}
          </span>
        </span>
        <n-button size="tiny" tertiary @click="createConfig">新建</n-button>
      </div>
      <div class="side-search">
        <n-input v-model:value="cfgKeyword" size="small" placeholder="搜配置名" clearable />
      </div>
      <div v-if="dupGroups" class="dup-tip">
        <span>{{ dupGroups }} 组重名</span>
        <n-button size="tiny" text type="primary" @click="tidy">加序号</n-button>
      </div>
      <div class="side-list">
        <div
          v-for="c in filteredConfigs"
          :key="c.id"
          class="side-item"
          :class="{ on: c.id === run.activeId }"
          @click="run.select(c.id)"
        >
          <div class="side-name"><span>{{ c.name }}</span></div>
          <div class="side-meta">
            <span>{{ c.steps }} 步</span>
            <span class="dot-sep">{{ c.cards === '关闭' ? '单卡' : `${c.cards.split(',').length} 卡` }}</span>
            <span class="dot-sep">{{ c.width }}×{{ c.height }}</span>
          </div>
        </div>
        <div v-if="!filteredConfigs.length" class="side-empty">
          {{ run.configs.length ? '没有匹配的配置' : '还没有配置，点「新建」' }}
        </div>
      </div>
      <div class="cfg-foot">
        这里管这一跑怎么发
        <InfoTip
          size="sm"
          :width="300"
          text="模板管节点参数（模型 / LoRA / 加速 / 输出）；这里管种子 / 步数 / 选卡。"
        />
      </div>
    </aside>

    <main class="cfg-main">
      <div v-if="!cfg" class="empty">没有运行配置</div>

      <template v-else>
        <!--
          常用区：每次跑都可能动的东西（采样 / 画布 / 选卡）。
          「ComfyUI 连接」「缓存分集」「提交方式」已移到顶栏的设置抽屉 ——
          它们配一次就不动，摆在第一屏只会把常用项挤下去。
        -->
        <!-- 采样 -->
        <section class="panel">
          <div class="panel-head">
            <span>采样（一采）</span>
            <span class="muted" style="font-size: 12px">Director 节点</span>
          </div>
          <div class="panel-body form">
            <label class="f">
              <span class="f-label">任务类型</span>
              <n-select
                :value="cfg.taskType"
                :options="taskTypeOptions"
                size="small"
                @update:value="(v: string) => set('taskType', v)"
              />
            </label>
            <label class="f">
              <span class="f-label">CFG</span>
              <n-input-number
                :value="cfg.cfg"
                size="small"
                :min="0"
                :max="30"
                :step="0.05"
                @update:value="(v: number | null) => set('cfg', v ?? 1)"
              />
            </label>
            <label class="f">
              <span class="f-label">步数</span>
              <n-input-number
                :value="cfg.steps"
                size="small"
                :min="1"
                :max="200"
                :step="1"
                @update:value="(v: number | null) => set('steps', v ?? 25)"
              />
            </label>
            <label class="f">
              <span class="f-label">采样器</span>
              <n-select
                :value="cfg.sampler"
                :options="SAMPLERS.map((s) => ({ label: s, value: s }))"
                size="small"
                filterable
                @update:value="(v: string) => set('sampler', v)"
              />
            </label>
            <label class="f">
              <span class="f-label">调度器</span>
              <n-select
                :value="cfg.scheduler"
                :options="SCHEDULERS.map((s) => ({ label: s, value: s }))"
                size="small"
                filterable
                @update:value="(v: string) => set('scheduler', v)"
              />
            </label>
            <label class="f">
              <span class="f-label">种子</span>
              <n-input-number
                :value="cfg.seed"
                size="small"
                :min="0"
                :step="1"
                :disabled="cfg.randomSeed"
                @update:value="(v: number | null) => set('seed', v ?? 0)"
              />
            </label>
            <label class="f f-switch">
              <span class="f-label">每次随机种子</span>
              <n-switch :value="cfg.randomSeed" @update:value="(v: boolean) => set('randomSeed', v)" />
            </label>
            <label class="f">
              <span class="f-label">shift (video)</span>
              <n-input-number
                :value="cfg.shiftVideo"
                size="small"
                :min="0.01"
                :max="100"
                :step="0.5"
                @update:value="(v: number | null) => set('shiftVideo', v ?? 12)"
              />
            </label>
            <label class="f">
              <span class="f-label">shift (audio)</span>
              <n-input-number
                :value="cfg.shiftAudio"
                size="small"
                :min="0.01"
                :max="100"
                :step="0.5"
                @update:value="(v: number | null) => set('shiftAudio', v ?? 3)"
              />
            </label>
            <label class="f">
              <span class="f-label">用 sigmas</span>
              <n-switch :value="cfg.useSigmas" @update:value="(v: boolean) => set('useSigmas', v)" />
            </label>
            <label class="f">
              <span class="f-label">模型口</span>
              <n-select
                :value="cfg.runModel"
                :options="RUN_MODEL_CHOICES.map((s) => ({ label: s, value: s }))"
                size="small"
                @update:value="(v: string) => set('runModel', v)"
              />
            </label>
          </div>
        </section>

        <!-- 画布 -->
        <section class="panel">
          <div class="panel-head"><span>画布与时长</span></div>
          <div class="panel-body form">
            <label class="f">
              <span class="f-label">宽</span>
              <n-input-number
                :value="cfg.width"
                size="small"
                :min="32"
                :max="8192"
                :step="32"
                @update:value="(v: number | null) => set('width', v ?? 864)"
              />
            </label>
            <label class="f">
              <span class="f-label">高</span>
              <n-input-number
                :value="cfg.height"
                size="small"
                :min="32"
                :max="8192"
                :step="32"
                @update:value="(v: number | null) => set('height', v ?? 480)"
              />
            </label>
            <label class="f">
              <span class="f-label">参考图上限</span>
              <n-input-number
                :value="cfg.refMaxSize"
                size="small"
                :min="32"
                :max="8192"
                :step="32"
                @update:value="(v: number | null) => set('refMaxSize', v ?? 1024)"
              />
            </label>
            <label class="f">
              <span class="f-label">帧率</span>
              <n-input-number
                :value="cfg.frameRate"
                size="small"
                :min="1"
                :max="240"
                :step="1"
                @update:value="(v: number | null) => set('frameRate', v ?? 24)"
              />
            </label>
            <label class="f">
              <span class="f-label">总帧数</span>
              <n-input-number
                :value="cfg.totalFrames"
                size="small"
                :min="0"
                :step="1"
                @update:value="(v: number | null) => set('totalFrames', v ?? 0)"
              />
            </label>
            <div class="f-hint" style="display: flex; align-items: center; gap: 4px">
              填 0 = 跟随时间线的实际总帧数
              <InfoTip size="sm" :width="280" text="宽高必须是 32 的倍数（r2v 后端强校验）。" />
            </div>
          </div>
        </section>

        <!-- 多卡 -->
        <section class="panel">
          <div class="panel-head">
            <span>多卡流水线</span>
            <span class="muted" style="font-size: 12px">pipeline_cards / pipeline_split</span>
          </div>
          <div class="panel-body form">
            <!-- 选卡：任意张数、任意组合 —— 候选直接取自节点此刻的枚举 -->
            <div class="f">
              <div class="row-between" style="margin-bottom: 6px">
                <span class="f-label">选卡（想选几张选几张）</span>
                <span class="muted" style="font-size: 12px">
                  <template v-if="gpuLoading">读取中…</template>
                  <template v-else-if="comfyVisible != null">
                    ComfyUI 可见 {{ comfyVisible }} 张 · 本机 {{ machineGpus.length }} 张
                  </template>
                  <template v-else-if="machineGpus.length">本机 {{ machineGpus.length }} 张（ComfyUI 未连上）</template>
                  <template v-else>读不到显卡</template>
                </span>
              </div>

              <div v-if="cardRows.length" class="card-grid">
                <n-button
                  v-for="g in cardRows"
                  :key="g.index"
                  size="tiny"
                  class="card-chip"
                  :type="selectedCards.includes(g.index) ? 'primary' : 'default'"
                  :secondary="!selectedCards.includes(g.index)"
                  :disabled="cardDisabled.has(g.index)"
                  :title="
                    cardDisabled.has(g.index)
                      ? `卡 ${g.index} 对 ComfyUI 不可见 —— 启动时加 ${restartCommand} 才能选`
                      : `点选卡 ${g.index}；双击=只用这一张`
                  "
                  @click="toggleCard(g.index, !selectedCards.includes(g.index))"
                  @dblclick="pickOnly(g.index)"
                >
                  <span class="card-chip-idx">{{ g.index }}</span>
                  <span class="card-chip-name">{{ g.name || 'GPU' }}</span>
                  <span class="card-chip-meta">
                    {{ (g.memoryTotal / 1024).toFixed(0) }}G<template v-if="g.util != null">
                      · {{ g.util }}%</template
                    >
                  </span>
                </n-button>
              </div>
              <n-alert v-else-if="gpuError" type="warning" :show-icon="false" style="margin-bottom: 8px">
                显卡读取失败：{{ gpuError }}
              </n-alert>

              <div class="row" style="gap: 6px; margin: 6px 0 8px; flex-wrap: wrap">
                <n-button size="tiny" tertiary @click="set('cards', CARD_OFF)">关闭</n-button>
                <n-button size="tiny" tertiary @click="pickAllVisible()">
                  全选可见卡{{ comfyVisible != null ? `（${comfyVisible} 张）` : '' }}
                </n-button>
                <n-button size="tiny" quaternary @click="loadGpus()">重新读取</n-button>
              </div>

              <!--
                以前这里有第三套选卡 UI：一个可搜索、可手填的 n-select。
                芯片已经能表达任意子集（点选/双击单选），下拉只是同一件事的
                另一种说法，还和上面的芯片打架 —— 删掉，只留芯片。
              -->
            </div>
            <label class="f">
              <span class="f-label">切分覆盖</span>
              <n-input
                :value="cfg.split"
                size="small"
                placeholder="auto"
                @update:value="(v: string) => set('split', v)"
              />
            </label>
            <div class="f-hint" style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap">
              <span class="mono cmd">{{ restartCommand }}</span>
              <n-button size="tiny" quaternary @click="copyRestart()">复制启动参数</n-button>
              <InfoTip
                :width="400"
                :text="
                  '改完重启 ComfyUI，再点「重新读取」—— 卡不可见时选了会直接报错，不降级。\n\n' + cardHint
                "
              />
            </div>
          </div>
        </section>

        <!-- 二采（高级，默认折叠） -->
        <section class="panel">
          <div class="fold-head adv" @click="advancedOpen = !advancedOpen">
            <div class="row" style="gap: 8px; min-width: 0">
              <span class="fold-caret" :class="{ open: advancedOpen }">▶</span>
              <span>二级采样</span>
              <span class="adv-tag">高级</span>
            </div>
            <span class="fold-summary">
              {{ hasUpscale ? '图中已接放大节点' : '图中没有放大节点' }}
            </span>
          </div>
          <div v-if="advancedOpen" class="panel-body form">
            <div class="f">
              <span class="f-label">跑到哪一档</span>
              <n-radio-group
                size="small"
                :value="stageValue"
                @update:value="(v: SecondStage) => patchStage(v)"
              >
                <n-radio-button v-for="o in SECOND_STAGE_OPTIONS" :key="o.value" :value="o.value">
                  {{ o.label }}
                </n-radio-button>
              </n-radio-group>
            </div>
            <label class="f">
              <span class="f-label">二采模型口</span>
              <n-select
                :value="cfg.secondRunModel"
                :options="RUN_MODEL_CHOICES.map((s) => ({ label: s, value: s }))"
                size="small"
                @update:value="(v: string) => set('secondRunModel', v)"
              />
            </label>
            <label class="f">
              <span class="f-label">二采种子</span>
              <n-input-number
                :value="cfg.secondSeed"
                size="small"
                :min="0"
                :step="1"
                @update:value="(v: number | null) => set('secondSeed', v ?? SECOND_SEED_FIXED)"
              />
            </label>
            <label class="f">
              <span class="f-label">二采采样器</span>
              <n-select
                :value="cfg.secondSampler"
                :options="secondSamplerOptions"
                size="small"
                @update:value="(v: string) => set('secondSampler', v)"
              />
            </label>
            <label class="f">
              <span class="f-label">二采 sigmas</span>
              <n-input
                :value="cfg.secondSigmas"
                size="small"
                placeholder="留空 = 用图上接线；例：0.85, 0.5"
                @update:value="(v: string) => set('secondSigmas', v)"
              />
            </label>
            <div class="f-hint" style="display: flex; align-items: center; gap: 4px">
              三档 = 节点上三条不同的路径
              <InfoTip
                :width="420"
                text="「仅一采」不碰二采；「一采+二采」同一次里连着跑，一采只采样不解码、二采拿它的 latent 出片（节点侧 second_only）；「仅二采」不跑一采，直接把磁盘上已有的一采缓存 latent 放大重采样（节点侧靠时间线的 secondSample）。&#10;二采的分辨率与 sigmas 在交付页那一组里改。"
              />
            </div>
          </div>
        </section>

        <!-- 导演台其余参数（高级，默认折叠） -->
        <section class="panel">
          <div class="fold-head adv" @click="advancedOpen = !advancedOpen">
            <div class="row" style="gap: 8px; min-width: 0">
              <span class="fold-caret" :class="{ open: advancedOpen }">▶</span>
              <span>导演台其余参数</span>
              <span class="adv-tag">高级</span>
            </div>
            <span class="fold-summary">
              <template v-if="director.specLoading">读取中…</template>
              <template v-else-if="director.knobs.length">
                {{ extraKnobs.length }} 项（共 {{ director.knobs.length }} 项）
              </template>
              <template v-else-if="director.specError">{{ director.specError }}</template>
            </span>
          </div>
          <div v-if="advancedOpen" class="panel-body form">
            <div v-if="extraKnobs.length" class="f" style="grid-column: 1 / -1">
              <n-input
                v-model:value="extraFilter"
                size="small"
                placeholder="搜参数名或说明"
                clearable
              />
            </div>

            <div
              v-if="!director.knobs.length && !director.specLoading && !director.specError"
              class="muted"
              style="grid-column: 1 / -1; font-size: 12px"
            >
              连上 ComfyUI 后列出导演台全部参数
              <InfoTip size="sm" :width="280" text="枚举是实时取的，不是写死的。" />
            </div>

            <template v-for="spec in extraShown" :key="spec.name">
              <!-- 布尔 -->
              <label v-if="spec.type === 'BOOLEAN'" class="f f-switch">
                <span class="f-label" :title="spec.tooltip">
                  {{ spec.name }}
                  <n-tag v-if="isOverridden(spec)" size="tiny" :bordered="false" type="info">已改</n-tag>
                </span>
                <n-switch
                  :value="!!extraValue(spec)"
                  @update:value="(v: boolean) => setExtra(spec.name, v)"
                />
              </label>

              <!-- 枚举 -->
              <label v-else-if="spec.type === 'COMBO'" class="f">
                <span class="f-label" :title="spec.tooltip">
                  {{ spec.name }}
                  <n-tag v-if="isOverridden(spec)" size="tiny" :bordered="false" type="info">已改</n-tag>
                </span>
                <n-select
                  :value="String(extraValue(spec) ?? '')"
                  :options="(spec.options ?? []).map((o) => ({ label: o, value: o }))"
                  size="small"
                  filterable
                  clearable
                  @update:value="(v: string | null) => (v == null ? clearExtra(spec.name) : setExtra(spec.name, v))"
                />
              </label>

              <!-- 数字 -->
              <label v-else-if="spec.type === 'INT' || spec.type === 'FLOAT'" class="f">
                <span class="f-label" :title="spec.tooltip">
                  {{ spec.name }}
                  <n-tag v-if="isOverridden(spec)" size="tiny" :bordered="false" type="info">已改</n-tag>
                </span>
                <n-input-number
                  :value="Number(extraValue(spec) ?? 0)"
                  size="small"
                  :min="spec.min"
                  :max="spec.max"
                  :step="spec.type === 'INT' ? Math.max(1, Math.round(spec.step ?? 1)) : (spec.step ?? 0.01)"
                  @update:value="(v: number | null) => (v == null ? clearExtra(spec.name) : setExtra(spec.name, v))"
                />
              </label>

              <!-- 文本 -->
              <label v-else class="f" style="grid-column: 1 / -1">
                <span class="f-label" :title="spec.tooltip">
                  {{ spec.name }}
                  <n-tag v-if="isOverridden(spec)" size="tiny" :bordered="false" type="info">已改</n-tag>
                </span>
                <n-input
                  :value="String(extraValue(spec) ?? '')"
                  size="small"
                  :type="spec.multiline ? 'textarea' : 'text'"
                  :rows="spec.multiline ? 3 : undefined"
                  :placeholder="spec.multiline ? '（多行）' : ''"
                  @update:value="(v: string) => (v === '' ? clearExtra(spec.name) : setExtra(spec.name, v))"
                />
              </label>
            </template>

            <div v-if="extraKnobs.length" class="f-hint" style="display: flex; align-items: center; gap: 4px">
              其余导演台参数
              <InfoTip
                :width="420"
                text="这些是导演台上没有被提成一等公民字段的输入，改了会随运行配置一起存、一起提交（和 ComfyUI 里改这个是同一个键）。带「已改」的是你动过的；清空即回到节点默认值。&#10;连线口（model / vae / clip / sigmas…）不在这里 —— 它们是图上的线，要在工作流里接。"
              />
            </div>
          </div>
        </section>

        <!-- 自检 -->
        <n-alert
          v-if="problems.length"
          type="warning"
          :show-icon="false"
          style="margin-bottom: 14px"
        >
          <div style="font-size: 13px; font-weight: 500; margin-bottom: 4px">提交前要处理</div>
          <ul style="margin: 0; padding-left: 18px; font-size: 12.5px; line-height: 1.8">
            <li v-for="(p, i) in problems" :key="i">{{ p }}</li>
          </ul>
        </n-alert>

        <n-alert
          v-if="dry"
          :type="dry.skipped.length ? 'warning' : 'success'"
          :show-icon="false"
          closable
          style="margin-bottom: 14px"
          @close="dry = null"
        >
          <div style="font-size: 13px">
            命中 <b>{{ dry.applied }}</b> 个运行参数<template v-if="dry.skipped.length">
              ，{{ dry.skipped.length }} 个在当前工作流里找不到落点</template
            >。
          </div>
          <div v-if="dry.skipped.length" class="muted mono" style="font-size: 11.5px; margin-top: 4px">
            {{ dry.skipped.join('、') }}
          </div>
        </n-alert>

        <!-- 底部常驻：这几个动作以前在内容最后，参数一长就得滚到底才点得到 -->
        <div class="cfg-actions">
          <n-button size="small" quaternary @click="runDry">试算命中</n-button>
          <n-button size="small" quaternary @click="syncFromWorkflow">按工作流刷新</n-button>
          <n-button size="small" quaternary @click="openRename">重命名</n-button>
          <n-button size="small" quaternary @click="copyConfig">复制</n-button>
          <n-button size="small" quaternary @click="resetConfig">恢复默认</n-button>
          <n-button size="small" quaternary type="error" @click="removeConfig">删除</n-button>
        </div>
      </template>
    </main>

    <n-modal v-model:show="showRenaming" preset="card" title="重命名运行配置" style="max-width: 420px">
      <n-input v-model:value="renameTo" placeholder="名称" @keyup.enter="commitRename" />
      <div class="row" style="justify-content: flex-end; margin-top: 14px">
        <n-button type="primary" @click="commitRename">确定</n-button>
      </div>
    </n-modal>
  </div>
</template>

<style scoped>
.cfg {
  display: flex;
  height: 100%;
  min-height: 0;
}
/* 高级区标题上的小标签 */
.adv-tag {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10.5px;
  line-height: 16px;
  color: var(--muted);
  background: var(--hover);
}
.fold-head.adv {
  border-bottom: 1px solid transparent;
}
.cfg-foot {
  flex: 0 0 auto;
  padding: 10px 12px;
  border-top: 1px solid var(--line);
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.6;
}
.cfg-main {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 0;
}
/* 贴底操作条：滚动区里 position:sticky，负左右 margin 抵消父级内距 */
.cfg-actions {
  position: sticky;
  bottom: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 16px -20px 0;
  padding: 10px 20px;
  background: var(--bg);
  border-top: 1px solid var(--line);
}
.form {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 10px 14px;
  padding: 12px 14px;
}
.f {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* 选卡：几张卡就几个开关，不预设"只能选两张" */
.card-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.card-chip {
  height: auto;
  padding: 6px 10px;
  line-height: 1.35;
}
.card-chip-idx {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 700;
}
.card-chip-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-chip-meta {
  opacity: 0.65;
  font-size: 11px;
}
.cmd {
  background: rgba(127, 127, 127, 0.14);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11.5px;
  overflow-wrap: anywhere;
}
.f-switch {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 6px 10px;
}
.f-label {
  font-size: 11.5px;
  color: var(--muted);
}
.f-hint {
  grid-column: 1 / -1;
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.7;
}
.f-hint.warn {
  color: var(--warn);
}
.empty {
  padding: 60px 0;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}
</style>
