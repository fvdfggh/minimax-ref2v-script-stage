<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NSpin, useMessage } from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useRegistryStore } from '@/stores/registry'
import { useBeatStore } from '@/stores/beats'
import { useAssemblyStore } from '@/stores/assembly'
import { useProviderStore } from '@/stores/provider'
import { usePipelineStore } from '@/stores/pipeline'
import { useStorageStore } from '@/stores/storage'
import { useGateStore } from '@/stores/gate'
import { TABLE_LABEL, useSyncStore, type ExternalChange } from '@/stores/sync'
import { setStorageProject } from '@/db'
import { GATE_LABEL, GATE_ORDER, type GateStage, type StageGate } from '@/domain/gate'
import { focusSegmentFields } from '@/composables/useAssembleFocus'
import RegistryPanel from '@/components/RegistryPanel.vue'
import SubjectManager from '@/components/SubjectManager.vue'
import DetailModal from '@/components/DetailModal.vue'
import ProviderDialog from '@/components/ProviderDialog.vue'
import StageSplit from '@/components/stages/StageSplit.vue'
import StageEnrich from '@/components/stages/StageEnrich.vue'
import StageAssemble from '@/components/stages/StageAssemble.vue'
import StageLocalize from '@/components/stages/StageLocalize.vue'
import StageSync from '@/components/stages/StageSync.vue'
import StageDeliver from '@/components/stages/StageDeliver.vue'
import TopTabs from '@/components/TopTabs.vue'
import { useSyncItems } from '@/composables/useSyncItems'
import InfoTip from '@/components/common/InfoTip.vue'

const route = useRoute()
const router = useRouter()
const message = useMessage()

const project = useProjectStore()
const registry = useRegistryStore()
const beats = useBeatStore()
const assembly = useAssemblyStore()
const provider = useProviderStore()
const pipeline = usePipelineStore()
const storage = useStorageStore()
const gate = useGateStore()
const sync = useSyncStore()

const tab = ref<
  | 'subjects'
  | 'split'
  | 'enrich'
  | 'assemble'
  | 'localize'
  | 'sync'
  | 'deliver'
>('split')
const showRegistry = ref(false)
const showProvider = ref(false)
const booted = ref(false)
const backendReady = ref(false)

const projectId = computed(() => String(route.params.id ?? ''))

/**
 * 待同步项。
 *
 * 只看不写：tab 上要能直接看到「有几项对不上」，否则用户得点进去才知道 ——
 * 之前一排 tab 全靠颜色猜，问题就在这儿。
 */
const { stats: syncStats } = useSyncItems()

const projectName = computed(() => project.current?.name ?? '')

/** 本集所属项目（系列）id：主体「取用 / 推送」要用 */
const seriesId = computed(() => project.current?.seriesId ?? '')

/** 弹窗角标：本集有几张图片素材（关键帧/音视频不算） */
const pictureCount = computed(
  () => registry.assets.filter((a) => a.pictureN > 0 && a.kind !== 'keyframe' && a.kind !== 'material').length
)

// 本集属于哪个项目(系列)；有则回到项目页，否则回项目列表
const backTo = computed(() =>
  project.current?.seriesId ? `/s/${project.current.seriesId}` : '/'
)

/**
 * 阶段 tab。
 *
 * 「主体登记」排在 ① 前面，而且明确标成「先」—— 主体拆分是流程起点：
 * 原文先拆出这一集有谁，拆解才有名字可引用。它不是流水线的一关（没有产出物、
 * 不参与阶段闸门），所以不占编号，但也不该看起来像"旁边的资料库"。
 */
interface TabDef {
  key: 'subjects' | 'split' | 'enrich' | 'assemble' | 'localize' | 'sync' | 'deliver'
  label: string
  /** tab 左上角的小标记，用来说清"这一步先做" */
  pre?: string
}

const tabs: TabDef[] = [
  { key: 'subjects', label: '主体登记', pre: '先' },
  { key: 'split', label: '① 拆解' },
  { key: 'enrich', label: '② 细节填充' },
  // ③ 一页管两件事：先组合，再按**整段**补字段（组合定了段，字段才有对象）。
  // 所以 ④ 字段补全不再单独占一页 —— 它就在 ③ 的列表下面接着往下排。
  { key: 'assemble', label: '③ 组合与缝合' },
  // 「素材」也不单独占页面：备图 / 配音就在②每张卡片的素材带上做，
  // 出图、配音的批量入口也都在②的工具条里。这里只保留阶段闸门（gate 仍会
  // 检查素材齐备），页面本身已删。
  { key: 'localize', label: '④ 中英本地化' },
  // 同步不占阶段编号：它不产出内容，只把中英两份对齐
  { key: 'sync', label: '同步' },
  { key: 'deliver', label: '⑤ 交付' }
]

type TabKey = TabDef['key']

/* ------------------------------------------------------------------ *
 * 阶段门禁：顺序执行
 *
 * 判定逻辑全在 domain/gate（纯函数 + 单测），这里只负责把 store 的数据喂进去、
 * 把结果用在两处：导航拦截、页面顶部的问题条。
 *
 * 为什么不在这里写判断：口径必须和「生成」按钮一致。两边各写一套，迟早出现
 * "页面进不去、生成却在跑"。判定与拼装在 stores/gate + domain/gate。
 * ------------------------------------------------------------------ */

/**
 * tab 上的状态标记。
 *
 * 之前的写法只有一个灰/红的数字小点，而且「被上游锁住」和「自己有错」都往同一处
 * 挤 —— 一排 tab 上有好几个点，看不出哪一个才是要动手的地方。
 *
 * 现在分四种，各有明确的读法：
 *   ok     ✓ 绿   这一关过了
 *   warn   · 黄   能过，但有提醒（不拦）
 *   error  ! 红   这一关自己没过 —— **这就是要修的地方**
 *
 * 以前还有一档 lock「上游没过、进不去」。导航不再拦截之后，"进不去"是假话，
 * 但它仍然值得提醒：上游没做完时这一页的内容多半是不完整的。
 * 所以它归到 warn —— 黄点、能进、说明原因。
 */
type TabTone = 'idle' | 'ok' | 'warn' | 'error' | 'lock'

function tabHealth(key: TabKey): { tone: TabTone; hint: string } {
  /*
   * 主体页是流程起点，但不产出内容、也不进阶段闸门 —— 所以它没有 ✓ / ! ，
   * 只用一个「先」标记说明「这一颗先点」。页内左右两栏：左边原文 + 拆分 + 登记。
   */
  if (key === 'subjects')
    return { tone: 'idle', hint: '流程第 1 步：按原文拆出这一集有谁（角色 / 场景 / 道具），登记后「① 拆解」才引用' }

  // 同步不是流水线的一关：只看「有没有对不上的东西」
  if (key === 'sync') {
    const n = syncStats.value.total
    if (!n) return { tone: 'ok', hint: '中英两份内容一致' }
    return {
      tone: 'warn',
      hint: `${n} 项待同步（${syncStats.value.segments} 段）：中文/英文/引用有一边变了`
    }
  }

  // ③ 这一页管两关：组合本身 + 整段字段补全。tab 上的标记要合起来看 ——
  // 否则字段缺一半，tab 却打着勾，人不会想到往下滚。
  const stages: GateStage[] = key === 'assemble' ? ['assemble', 'complete'] : [key as GateStage]

  const blocked = stages.flatMap((k) => gate.blockers[k])
  if (blocked.length) {
    const first = blocked[0]
    return {
      tone: 'warn',
      hint: `上游「${first.label}」还没做完：${first.errors[0] ?? ''}（可以进，内容可能不完整）`
    }
  }
  for (const k of stages) {
    const g = gate.gates[k]
    if (!g.passed) {
      return { tone: 'error', hint: `${g.label}有 ${g.errors.length} 个问题：${g.errors.join('；')}` }
    }
  }
  const warns = stages.flatMap((k) => gate.gates[k].warns)
  if (warns.length) return { tone: 'warn', hint: `${gate.gates[key as GateStage].label}已通过，但有提醒：${warns.join('；')}` }
  return { tone: 'ok', hint: `${gate.gates[key as GateStage].label}已通过` }
}

/** tab 上的小标记：能显示数量的就显示数量，比一个点更有信息 */
function tabMark(key: TabKey): string {
  if (key === 'sync') return syncStats.value.total ? String(syncStats.value.total) : ''
  const tone = tabHealth(key).tone
  return tone === 'ok' ? '✓' : tone === 'error' ? '!' : ''
}

/**
 * 现在**该动手**的阶段：自己没过、且上游没挡着。
 *
 * 顺序执行下这个列表最多只有一条 —— 它就是 header 上那条「去哪修」的依据。
 */
const actionableProblems = computed(() =>
  GATE_ORDER.map((k) => gate.gates[k]).filter((g) => !g.passed && gate.blockers[g.key].length === 0)
)
const firstProblem = computed(() => actionableProblems.value[0] ?? null)

/** 当前页面自己的问题（顶部那条） */
const currentGate = computed<StageGate | null>(() => {
  const k = tab.value
  // 这两页不是流水线的一关，没有"自己的门禁"
  if (k === 'subjects' || k === 'sync') return null
  // ③ 页里两块：组合本身的问题先修，组合过了再提示字段补全
  if (k === 'assemble') {
    const asm = gate.gates.assemble
    return !asm.passed ? asm : gate.gates.complete
  }
  return gate.gates[k]
})

/**
 * 点 tab 就切过去。
 *
 * ★ 不再用「上游没过」拦住导航。
 *   拦住的代价很实：用户想看后面那页长什么样、想对一下字段，都得先把前面修完；
 *   而真正该做的是**让问题被看见**（tab 上的标记、页内的问题条），
 *   不是把人挡在门外。顺序仍然有价值，所以它只做提示，不做闸门。
 */
/**
 * 跳到某一关。
 *
 * 「素材」已经没有自己的页面：备图 / 配音就在 ② 每张卡片的素材带上做。
 * 但闸门里还有 materials 这一项（它管的是"出片前图音齐不齐"），
 * 所以它的问题条点进去落到 ② —— 那里才是能动手的地方。
 */
function goTab(key: TabKey | GateStage) {
  /*
   * materials 的动手点在 ② 的素材带；
   * complete 的动手点已经并进 ③ —— 字段就长在每张段卡里，不再有单独一块列表。
   */
  if (key === 'materials') {
    tab.value = 'enrich'
  } else if (key === 'complete') {
    tab.value = 'assemble'
    /*
     * 只切页不够：③ 一屏十几段，缺字段的可能在第七段。所以顺手把这一页的
     * 字段筛选切成「未补全」，再滚到字段工具条 —— 落点就是"要补的那几段"。
     */
    focusSegmentFields('incomplete')
  } else {
    tab.value = key
  }
}

async function boot() {
  await storage.init()
  backendReady.value = storage.ready
  // 连不上后端就直接拦住，不读库（后端是唯一数据源）
  if (!storage.ready) {
    booted.value = true
    return
  }
  await project.loadAll()
  // 让 current 与路由的集 id 一致（而不是停留在 kv 里的旧值）
  await project.select(projectId.value)
  if (!project.current) {
    message.warning('集不存在')
    router.replace('/')
    return
  }
  // 后端模式下删除操作只给 id，适配器得先知道在哪个项目里
  setStorageProject(projectId.value)
  await Promise.all([
    registry.load(projectId.value),
    beats.load(projectId.value),
    assembly.load(projectId.value),
    provider.load()
  ])
  // 数据同步：从这里开始盯着后端那几份 JSON，别处改了就跟着刷新
  sync.start(projectId.value)
  // 产物不再是独立阶段（它挂在"交付的每一段"上）；历史项目里残留的 'products'
  // 与已删除的 'materials' 页一并落回交付页
  /*
   * 'complete' 已经没有自己的页面了（字段并进 ③）。老项目里存着这个阶段值时，
   * 直接落到 ③ —— 那里就是补字段的地方。
   *
   * 还没拆出片段、也还没登记主体的空项目，落在主体页：它是流程第 1 步，
   * 一进来站在「① 拆解」等于站在一扇等着名单的门前。
   */
  const st = project.current.stage
  if (!beats.beats.length && !registry.entities.length) {
    tab.value = 'subjects'
  } else {
    tab.value =
      st === 'complete'
        ? 'assemble'
        : st === 'split' || st === 'enrich' || st === 'assemble' || st === 'localize'
          ? st
          : 'deliver'
  }
  booted.value = true
}

/* ------------------------------------------------------------------ *
 * 别处改了同一个项目 → 同步刷新
 *
 * 为什么是"自动刷新"而不是"弹窗让你确认"：数据只有后端一份，本页那份
 * 已经是旧的，留着它没有任何好处 —— 用户还在本页继续改，写到旧值上才是
 * 真的丢数据。所以默认同步；只有"你手上有没提交的草稿"时页面自己提示
 * （交付页的未提交输入由它自己看管）。
 * ------------------------------------------------------------------ */

/** 已经替用户刷新过的表，用来显示一条说明（不是错误） */
const syncedTables = ref<string[]>([])

function noteSynced(tables: string[]) {
  const merged = new Set([...syncedTables.value, ...tables])
  syncedTables.value = [...merged]
}

async function handleExternal(change: ExternalChange): Promise<void> {
  const pid = projectId.value
  if (!pid) return
  try {
    if (change.table === 'beats') {
      await beats.load(pid)
      noteSynced(['片段'])
    } else if (change.table === 'entities' || change.table === 'assets') {
      await registry.load(pid)
      noteSynced([TABLE_LABEL[change.table]])
    } else if (change.table === 'assemblies') {
      await assembly.load(pid)
      noteSynced(['段与字段'])
    } else if (change.table === 'projects') {
      await project.loadAll()
      await project.select(pid)
      noteSynced(['项目'])
    } else if (change.table === 'providers') {
      await provider.load()
      noteSynced(['模型配置'])
    }
  } catch (err) {
    message.warning(`同步「${TABLE_LABEL[change.table]}」失败：${(err as Error).message}`)
  }
}

let offExternal: (() => void) | null = null

onUnmounted(() => {
  offExternal?.()
  offExternal = null
  sync.stop()
})

async function retryConnect() {
  const ok = await storage.connect()
  if (ok) location.reload()
}

// 订阅放在 boot 之前：boot 里的 sync.start() 可能立刻发现一次改动
offExternal = sync.onExternal(handleExternal)
onMounted(boot)

watch(projectId, async () => {
  booted.value = false
  syncedTables.value = []
  sync.stop()
  await boot()
})

watch(tab, async (v) => {
  if (!project.current) return
  // 「主体登记」「同步」都不是流水线阶段，不进 project.stage —— 否则刷新后会停在
  // 这两页，让人以为上次的进度丢了
  if (v === 'subjects' || v === 'sync') return
  if (project.current.stage !== v) await project.setStage(v)
})

async function renumberIfNeeded() {
  if (registry.stale(beats.beats)) {
    await registry.renumber(beats.beats)
  }
}
</script>

<template>
  <!-- data-stage 给整页一个"当前阶段色"：面板头左侧色条、片段卡片左边线都用它 -->
  <div :data-stage="tab" style="height: 100%; display: flex; flex-direction: column">
    <!--
      头部两行：第一行是「这是哪一集 / 去哪儿（工作面）」，第二行是阶段 tab。
      ★ 阶段 tab 单独占一行，不再和标题、右侧按钮抢同一行 ——
        以前是在一行里 `overflow-x: auto`，窗口一窄，④⑤⑥ 就被推到看不见的
        地方（滚动条还是隐藏的），用户根本不知道后面还有几页。
        现在宁可折成两行，也不让任何一页消失。
    -->
    <header class="wb-head">
      <div class="wb-head-main">
        <n-button quaternary size="small" @click="router.push(backTo)">← 项目</n-button>
        <div class="wb-title" :title="projectName">{{ projectName }}</div>

        <div class="wb-head-actions">
          <TopTabs />
          <span class="wb-sep" />
          <span
            class="tag-chip"
            :style="{
              background: provider.ready ? 'var(--accent-soft)' : 'var(--err-soft)',
              color: provider.ready ? 'var(--accent)' : 'var(--err)'
            }"
            :title="provider.ready ? '当前模型供应商' : '还没配置模型供应商'"
          >
            {{ provider.current?.name ?? '未配置' }}
          </span>
          <n-button size="small" quaternary @click="showProvider = true">模型设置</n-button>
          <n-button size="small" @click="showRegistry = true">
            素材与音色
            <span
              class="tag-chip"
              style="margin-left: 6px; background: var(--panel-3); color: var(--label)"
            >
              {{ pictureCount }}
            </span>
          </n-button>
        </div>
      </div>

      <div class="stage-tabs">
        <template v-for="t in tabs" :key="t.key">
          <button
            class="stage-tab"
            :class="[`t-${tabHealth(t.key).tone}`, { active: tab === t.key }]"
            :title="tabHealth(t.key).hint"
            @click="goTab(t.key)"
          >
            <span v-if="tabMark(t.key)" class="stage-tab-mark">{{ tabMark(t.key) }}</span>
            <span v-else-if="t.pre" class="stage-tab-pre">{{ t.pre }}</span>
            <span class="stage-tab-label">{{ t.label }}</span>
          </button>
        </template>

        <!--
          哪一关要动手，header 上直说 —— 不能让用户从一排 tab 里猜。
          顺序执行下 actionableProblems 最多一条，所以这里永远是「具体某一关」。
        -->
        <button
          v-if="firstProblem"
          class="stage-alert"
          :title="firstProblem.errors.join('；')"
          @click="goTab(firstProblem.key)"
        >
          <b>!</b>{{ firstProblem.label }} 有 {{ firstProblem.errors.length }} 个问题
        </button>
      </div>
    </header>

    <!--
      数据同步说明。
      不是错误条：数据只有后端一份，本页是旧的那一份，刷新才是对的。
      但必须说出来 —— 否则用户会以为"我明明改了，怎么变回去了"。
    -->
    <div v-if="syncedTables.length" class="gate-bar gate-bar-info">
      <span class="gate-bar-tag">已同步</span>
      <span class="gate-bar-text">
        {{ syncedTables.join(' / ') }} 在别处被修改过，已按后端数据刷新
        <InfoTip size="sm" :width="320" text="你有未提交输入的地方会单独提示。数据只有后端一份，本页是旧的那一份。" />
      </span>
      <span class="gate-bar-note mono">数据以后端为准</span>
      <button class="link-btn" @click="syncedTables = []">知道了</button>
    </div>

    <!--
      当前阶段自己的问题条。
      不拦导航了，但问题还得摆在页面上 —— 否则用户看到一个红色 tab 却不知道为什么。
    -->
    <div
      v-if="currentGate && currentGate.errors.length"
      class="gate-bar gate-bar-error"
    >
      <span class="gate-bar-tag">{{ currentGate.label }}</span>
      <span class="gate-bar-text">{{ currentGate.errors.join('；') }}</span>
      <span class="gate-bar-note">建议先修完；后面几页可以随时去看，不拦导航</span>
    </div>
    <div
      v-else-if="currentGate && currentGate.warns.length"
      class="gate-bar gate-bar-warn"
    >
      <span class="gate-bar-tag">{{ currentGate.label }}</span>
      <span class="gate-bar-text">{{ currentGate.warns.join('；') }}</span>
    </div>

    <main style="flex: 1; min-height: 0; overflow: hidden">
      <div
        v-if="!backendReady"
        style="height: 100%; display: flex; align-items: center; justify-content: center; padding: 24px"
      >
        <div class="panel" style="padding: 40px 28px; text-align: center; max-width: 460px">
          <n-spin v-if="storage.checking" size="large" style="margin-bottom: 12px" />
          <template v-else>
            <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px">后端未连接</div>
            <div class="muted" style="font-size: 13px; line-height: 1.9">
              连不上 Python 后端，暂时打不开这个项目。请先在项目目录运行
              <code>python server/app.py</code>，然后点重试。
            </div>
            <div class="row" style="justify-content: center; gap: 8px; margin-top: 14px">
              <n-button quaternary size="small" @click="router.push('/')">返回项目列表</n-button>
              <n-button type="primary" size="small" @click="retryConnect">重试连接</n-button>
            </div>
          </template>
        </div>
      </div>

      <n-spin v-else-if="!booted" style="height: 100%" content-style="height:100%">
        <div style="height: 100%" />
      </n-spin>

      <template v-else>
        <SubjectManager
          v-show="tab === 'subjects'"
          scope="episode"
          :project-id="projectId"
          :series-id="seriesId"
          :active="tab === 'subjects'"
        />
        <StageSplit
          v-show="tab === 'split'"
          @changed="renumberIfNeeded"
          @register="tab = 'subjects'"
        />
        <StageEnrich v-show="tab === 'enrich'" @changed="renumberIfNeeded" />
        <StageAssemble v-show="tab === 'assemble'" />
        <StageLocalize v-show="tab === 'localize'" />
        <StageSync v-show="tab === 'sync'" />
        <StageDeliver v-show="tab === 'deliver'" :active="tab === 'deliver'" />
      </template>
    </main>

    <!-- 详情统一用弹窗：抽屉会从右侧盖住各阶段的 SectionNav 目录 -->
    <DetailModal
      v-model:show="showRegistry"
      title="素材与音色"
      :width="880"
      hint="改动会立即保存"
    >
      <RegistryPanel />
    </DetailModal>

    <ProviderDialog v-model:show="showProvider" />

  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ *
 * 工作台头部
 *
 * 两行结构：上面「哪一集 + 工作面 + 全局动作」，下面整行放阶段 tab。
 * 阶段 tab 是这一页的主导航，不能因为窗口窄就被挤走 —— 这是它单独占一行
 * 的唯一理由（见模板里的注释）。
 * ------------------------------------------------------------------ */
.wb-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 18px 9px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  flex: 0 0 auto;
}

.wb-head-main {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.wb-title {
  font-weight: 600;
  font-size: 15px;
  color: var(--text);
  min-width: 0;
  max-width: 40vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex: 0 0 auto;
}

.wb-sep {
  width: 1px;
  height: 18px;
  background: var(--line);
  flex: 0 0 auto;
}

/* 窄窗口先把「集名」让出去：它是已知信息，tab 和按钮才是要操作的 */
@media (max-width: 1100px) {
  .wb-title {
    max-width: 22vw;
  }
}
</style>
