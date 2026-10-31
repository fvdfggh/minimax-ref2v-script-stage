<script setup lang="ts">
/**
 * 工作流控制台。
 *
 * 定位：和「剧本台」平级的另一个工作面 —— 剧本台管内容（故事→片段→导演包），
 * 这里管**怎么跑**（模型、LoRA、采样、二采、加速、输出）。
 *
 * 参数来源只有一处：导入的 API format 工作流。不读取界面工作流的
 * widgets_values —— 那个数组靠位置对齐，节点一改就整体错位（见
 * domain/workflow.ts 顶部的说明）。
 *
 * ★ 信息层级（2026-10 重整，改之前先读这段）：
 *   一级  顶栏下划线导航（剧本台 / 控制台 / 运行）—— "我在哪个工作面"
 *   二级  左栏条目（模板）                    —— "我在改哪一套"
 *   三级  主区分区卡片                        —— "改哪一类参数"
 *   「全部参数」（638 项）不再和模板参数抢同一个 tab：它是个**查字典**的动作，
 *   不是常驻视图，收进右侧抽屉。以前它和「模板参数」并排成两个 pill，
 *   用户看到的是一个 638 项的巨长列表，于是"控制台很乱"。
 *
 * 放大节点（MiniMaxH3LatentUpscaleModelOpt）仍然内联展开，但默认折叠、头部
 * 显示目标尺寸摘要 —— 三种尺寸模式互斥且直接决定出片分辨率，藏进弹窗会让用户
 * 忘记自己选的是哪个模式；但整块常驻又太占地方，折中成"摘要 + 展开"。
 */
import { computed, onMounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NDrawer,
  NDrawerContent,
  NDropdown,
  NInput,
  NModal,
  NTag,
  useMessage
} from 'naive-ui'
import type { DropdownOption } from 'naive-ui'
import TopTabs from '@/components/TopTabs.vue'
import NodeDialog from '@/components/workflow/NodeDialog.vue'
import UpscalePanel from '@/components/workflow/UpscalePanel.vue'
import SchemaBrowser from '@/components/workflow/SchemaBrowser.vue'
import { useWorkflowStore } from '@/stores/workflow'
import { useSchemaStore } from '@/stores/schema'
import { useLocalStore } from '@/stores/local'
import { DEFAULT_COMFY_URL } from '@/domain/run'
import { GROUP_LABELS, GROUP_ORDER } from '@/domain/workflow'
import type { NodeGroup, NodeSpec, ParamValue } from '@/domain/workflow'
import InfoTip from '@/components/common/InfoTip.vue'

const workflow = useWorkflowStore()
const local = useLocalStore()
const schema = useSchemaStore()
const message = useMessage()

/** 「全部参数」抽屉：查字典的动作，不再占一个常驻 tab */
const showParams = ref(false)

/** 模板搜索 —— 一列十几条时没有它只能靠眼睛扫 */
const tplKeyword = ref('')

const showImport = ref(false)
const importText = ref('')
const showRenaming = ref(false)
const renameTo = ref('')
const showLocal = ref(false)
const rootInput = ref('')
const historyBase = ref(DEFAULT_COMFY_URL)

const showDialog = ref(false)
const dialogNode = ref<NodeSpec | null>(null)

const dryResult = ref<{ applied: number; skipped: string[] } | null>(null)

/** 放大卡默认折叠：它占半屏，而多数时候用户只想确认"目标尺寸是多少" */
const upscaleOpen = ref(false)

onMounted(async () => {
  await workflow.load()
  await local.load()
  await schema.load()
  // 第一次进来没有缓存，直接扫一次源码（后端有 5 分钟缓存，之后是秒开）。
  // 不这么做的话，用户不点按钮就什么都看不到 —— 而"有没有导入工作流"
  // 根本不该成为能不能配参数的前提。
  if (!schema.all.length && local.root) {
    await schema.scanOffline(local.root)
  }
})

/* ------------------------------ 顶栏菜单 ------------------------------ */

/**
 * 以前「本机模型 / 导入 API 工作流 / 试算命中」三个按钮常驻在顶栏，
 * 加两个页内切换和状态文字，一行挤 7 组控件。它们都是低频动作，
 * 收进菜单后顶栏只剩「导航 + 全部参数 + ⋯」。
 */
const moreMenu = computed<DropdownOption[]>(() => [
  { label: '导入 API 工作流', key: 'import' },
  { label: '本机模型与工作流…', key: 'local' },
  { label: '试算命中（当前模板套一次）', key: 'dry', disabled: !workflow.active?.api },
  { type: 'divider', key: 'd1' },
  { label: '扫描节点定义', key: 'scan' }
])

function onMore(key: string) {
  if (key === 'import') openImport()
  else if (key === 'local') openLocal()
  else if (key === 'dry') runDry()
  else if (key === 'scan') void scanSchema()
}

async function scanSchema() {
  if (!local.root) {
    message.warning('先「本机模型与工作流」里填一次 ComfyUI 根目录')
    openLocal()
    return
  }
  await schema.scanOffline(local.root)
  message.success(`已扫到 ${schema.all.length} 个节点定义`)
}

/* ------------------------------ 节点分组 ------------------------------ */

const upscaleNode = computed(() => workflow.nodes.find((n) => n.panel === 'upscale') ?? null)

const otherNodes = computed(() => workflow.nodes.filter((n) => n.panel !== 'upscale'))

const groupedNodes = computed(() => {
  const out: { group: NodeGroup; label: string; nodes: NodeSpec[] }[] = []
  for (const g of GROUP_ORDER) {
    const list = otherNodes.value.filter((n) => n.group === g)
    if (list.length) out.push({ group: g, label: GROUP_LABELS[g], nodes: list })
  }
  return out
})

/* ------------------------------ 模板 ------------------------------ */

/** 左栏搜索：名字 + 描述 + 是否有 API */
const filteredTemplates = computed(() => {
  const q = tplKeyword.value.trim().toLowerCase()
  if (!q) return workflow.templates
  return workflow.templates.filter(
    (t) => t.name.toLowerCase().includes(q) || (t.desc ?? '').toLowerCase().includes(q)
  )
})

/** 有几组重名（存量数据，新建去重管不到） */
const dupGroups = computed(() => {
  const m = new Map<string, number>()
  for (const t of workflow.templates) m.set(t.name, (m.get(t.name) ?? 0) + 1)
  return [...m.values()].filter((n) => n > 1).length
})

function tidyNames() {
  const n = workflow.tidyNames()
  if (n) message.success(`已给 ${n} 个重名加序号`)
}

/** 相对时间 —— 副行里比绝对时间戳有用得多 */
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

/** 这份模板导入了几个节点（0 = 只有放大参数） */
function nodeCount(api: Record<string, unknown> | null): number {
  return api ? Object.keys(api).length : 0
}

/** 放大卡折叠时的摘要：用户八成只想确认这一句 */
const upscaleSummary = computed(() => {
  const v = workflow.upscaleValues as Record<string, ParamValue>
  const mode = String(v['mode'] ?? '')
  const w = v['width']
  const h = v['height']
  const scale = v['scale']
  if (w != null && h != null && Number(w) > 0) return `目标 ${w} × ${h}`
  if (scale != null) return `按倍率 ${scale}×`
  return mode ? `模式 ${mode}` : '未配置'
})

function selectTemplate(id: string) {
  workflow.select(id)
  dryResult.value = null
}

function createTemplate() {
  const t = workflow.create('新模板')
  message.success(`已创建「${t.name}」`)
}

function copyTemplate() {
  const t = workflow.duplicate(workflow.activeId ?? '')
  if (t) message.success(`已复制为「${t.name}」`)
}

function removeTemplate() {
  const t = workflow.active
  if (!t) return
  workflow.remove(t.id)
  message.success(`已删除「${t.name}」`)
}

function openRename() {
  renameTo.value = workflow.active?.name ?? ''
  showRenaming.value = true
}

function commitRename() {
  if (!workflow.active) return
  workflow.rename(workflow.active.id, renameTo.value.trim())
  showRenaming.value = false
}

/* ------------------------------ 参数 ------------------------------ */

function onNodeChange(nodeKey: string, param: string, value: ParamValue) {
  workflow.setParam(nodeKey, param, value)
}

function onNodeReset(nodeKey: string) {
  workflow.resetNode(nodeKey)
  message.success('已恢复默认值')
}

function onUpscaleReset() {
  workflow.resetNode('MiniMaxH3LatentUpscaleModelOpt#0')
  message.success('放大参数已恢复默认')
}

/* ------------------------------ 导入 ------------------------------ */

function openImport() {
  importText.value = ''
  showImport.value = true
}

function doImport() {
  const t = workflow.active
  if (!t) return
  try {
    const res = workflow.importApi(t.id, importText.value)
    showImport.value = false
    dryResult.value = null
    message.success(`导入成功：${res.nodes} 个节点、${res.params} 个可配参数`)
  } catch (err) {
    message.error((err as Error).message, { duration: 9000 })
  }
}

async function onFile(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importText.value = await file.text()
  input.value = ''
}

/* ------------------------------ 试算 ------------------------------ */

/**
 * 把当前模板套到导入的基线上，看看有多少参数真的命中。
 * 换过工作流之后 skipped 会变多 —— 这是唯一能提前发现"模板失效"的办法，
 * 不能等到跑完 20 分钟才发现参数没生效。
 */
function runDry() {
  const t = workflow.active
  if (!t?.api) {
    message.warning('先导入 API 工作流才能试算')
    return
  }
  const res = workflow.materialize(t.id, t.api)
  dryResult.value = { applied: res.applied, skipped: res.skipped }
}

function openNode(n: NodeSpec) {
  dialogNode.value = n
  showDialog.value = true
}

/* ------------------------------ 本机资源 ------------------------------ */

/**
 * 模型下拉能不能选，取决于有没有扫到本机模型文件。
 * ComfyUI 的 /object_info 也能给候选，但要进程活着；这里直接读盘，
 * 任何时候都能选。
 */
function openLocal() {
  rootInput.value = local.root
  showLocal.value = true
}

async function applyRoot() {
  await local.setRoot(rootInput.value)
  if (local.ready) {
    message.success(
      `已扫描：${local.summary.reduce((n, s) => n + s.count, 0)} 个模型文件`
    )
  } else {
    message.error(local.error || '扫描失败')
  }
}

async function importLocalFile(path: string, name: string) {
  const t = workflow.active
  if (!t) return
  const file = local.workflows.find((f) => f.path === path)
  if (!file) return
  try {
    const text = await local.readWorkflow(file)
    const res = workflow.importApi(t.id, text)
    showLocal.value = false
    showImport.value = false
    dryResult.value = null
    message.success(`已导入「${name}」：${res.nodes} 个节点、${res.params} 个可配参数`)
  } catch (err) {
    message.error((err as Error).message, { duration: 9000 })
  }
}

/**
 * ComfyUI 只在前端 JS 里做 UI→API 转换，服务端没有导出接口 —— 所以离线
 * 拿不到 API 格式（用户目录里几十个工作流全是界面格式就是这个原因）。
 * 但跑过一次的图一定在 /history 里，而且是前端已经转好的 API 格式。
 * 这条路能绕开"回 ComfyUI 点 Export(API)"。
 */
async function importHistory(id: string, label: string) {
  const t = workflow.active
  if (!t) return
  try {
    const text = await local.graphFromHistory(historyBase.value, id)
    const res = workflow.importApi(t.id, text)
    showLocal.value = false
    message.success(`已从历史导入「${label}」：${res.nodes} 节点 / ${res.params} 参数`)
  } catch (err) {
    message.error((err as Error).message, { duration: 9000 })
  }
}

function formatTag(fmt: string): { label: string; type: 'success' | 'warning' | 'default' } {
  if (fmt === 'api') return { label: 'API 格式 · 可用', type: 'success' }
  if (fmt === 'ui') return { label: '界面格式 · 需先导出 API', type: 'warning' }
  if (fmt === 'broken') return { label: 'JSON 损坏', type: 'warning' }
  return { label: '未知格式', type: 'default' }
}
</script>

<template>
  <div class="console">
    <header class="page-head">
      <div class="page-head-left">
        <span class="page-brand">工作流控制台</span>
        <TopTabs />
      </div>
      <div class="page-head-right">
        <span v-if="workflow.saving" class="muted" style="font-size: 12px">保存中…</span>
        <n-button size="small" quaternary @click="showParams = true">
          全部参数<template v-if="schema.all.length"> · {{ schema.all.length }}</template>
        </n-button>
        <n-dropdown trigger="click" :options="moreMenu" @select="onMore">
          <n-button size="small" quaternary title="导入 / 本机模型 / 试算">⋯</n-button>
        </n-dropdown>
      </div>
    </header>

    <div class="console-body">
      <aside class="side-col" style="width: 256px">
        <div class="side-head">
          <span>
            模板
            <span class="muted" style="font-weight: 400">
              {{ filteredTemplates.length }}/{{ workflow.templates.length }}
            </span>
          </span>
          <n-button size="tiny" tertiary @click="createTemplate">新建</n-button>
        </div>
        <div class="side-search">
          <n-input v-model:value="tplKeyword" size="small" placeholder="搜模板名" clearable />
        </div>
        <div v-if="dupGroups" class="dup-tip">
          <span>{{ dupGroups }} 组重名</span>
          <n-button size="tiny" text type="primary" @click="tidyNames">加序号</n-button>
        </div>
        <div class="side-list">
          <div
            v-for="t in filteredTemplates"
            :key="t.id"
            class="side-item"
            :class="{ on: t.id === workflow.activeId }"
            @click="selectTemplate(t.id)"
          >
            <div class="side-name"><span>{{ t.name }}</span></div>
            <div class="side-meta">
              <span v-if="!t.api" class="tpl-badge">未导入</span>
              <span v-else>{{ nodeCount(t.api) }} 节点</span>
              <span class="dot-sep">{{ Object.keys(t.values).length }} 项</span>
              <span class="dot-sep">{{ ago(t.updatedAt) }}</span>
            </div>
          </div>
          <div v-if="!filteredTemplates.length" class="side-empty">
            {{ workflow.templates.length ? '没有匹配的模板' : '还没有模板，点「新建」' }}
          </div>
        </div>
        <div class="tpl-foot">
          模板跨项目共享
          <InfoTip size="sm" :width="240" text="哪一集用哪套，在集列表里选。" />
        </div>
      </aside>

      <main class="console-main">
        <div v-if="!workflow.active" class="empty">没有模板</div>

        <template v-else>
          <div class="panel" style="margin-bottom: 14px">
            <div class="panel-body" style="padding: 12px 14px">
              <div class="row-between">
                <div class="row" style="gap: 10px">
                  <span style="font-size: 15px; font-weight: 500">{{ workflow.active.name }}</span>
                  <span v-if="workflow.active.api" class="tag-chip" style="background: var(--accent-soft); color: var(--accent)">
                    {{ workflow.nodes.length }} 个节点
                  </span>
                  <span v-else class="tag-chip" style="background: var(--warn-soft); color: var(--warn)">
                    未导入 API 工作流
                  </span>
                </div>
                <div class="row" style="gap: 4px">
                  <n-button size="tiny" quaternary @click="openRename">重命名</n-button>
                  <n-button size="tiny" quaternary @click="copyTemplate">复制</n-button>
                  <n-button size="tiny" quaternary @click="removeTemplate">删除</n-button>
                </div>
              </div>
              <div v-if="workflow.active.desc" class="muted" style="font-size: 12px; margin-top: 5px">
                {{ workflow.active.desc }}
              </div>
              <div v-if="!workflow.active.api" class="muted" style="font-size: 12px; margin-top: 6px">
                还没有节点参数入口
                <InfoTip
                  :width="380"
                  text="在 ComfyUI 里打开工作流 → 菜单 Workflow → Export (API)，再回来「导入 API 工作流」。&#10;「本机模型」里可以直接列出本机已存的工作流文件（标「界面格式」的要先导出成 API）。"
                />
              </div>
            </div>
          </div>

          <n-alert
            v-if="dryResult"
            :type="dryResult.skipped.length ? 'warning' : 'success'"
            :show-icon="false"
            closable
            style="margin-bottom: 14px"
            @close="dryResult = null"
          >
            <div style="font-size: 13px">
              命中 <b>{{ dryResult.applied }}</b> 个参数<template v-if="dryResult.skipped.length">
                ，{{ dryResult.skipped.length }} 个没找到落点（换过工作流后正常，
                这些参数会按工作流原值运行）</template
              >。
            </div>
            <div v-if="dryResult.skipped.length" class="muted" style="font-size: 11.5px; margin-top: 4px; font-family: var(--mono)">
              {{ dryResult.skipped.slice(0, 8).join('、') }}
              <template v-if="dryResult.skipped.length > 8">…</template>
            </div>
          </n-alert>

          <div v-if="upscaleNode" class="panel up-card" :class="{ open: upscaleOpen }">
            <div class="fold-head" @click="upscaleOpen = !upscaleOpen">
              <div class="row" style="gap: 8px; min-width: 0">
                <span class="fold-caret" :class="{ open: upscaleOpen }">▶</span>
                <span>二采放大 · Latent Upscaler 3D</span>
                <span class="tag-chip ups-tag">{{ upscaleSummary }}</span>
              </div>
              <span class="fold-summary">
                一采 {{ workflow.baseCanvas.width }} × {{ workflow.baseCanvas.height }}
              </span>
            </div>
            <div v-if="upscaleOpen" class="panel-body" style="padding: 4px 16px 14px">
              <UpscalePanel
                :values="workflow.upscaleValues"
                :base-width="workflow.baseCanvas.width"
                :base-height="workflow.baseCanvas.height"
                :present="upscaleNode.present"
                @update="(p: string, v: ParamValue) => workflow.setUpscale(p, v)"
                @reset="onUpscaleReset"
              />
            </div>
          </div>

          <div v-for="group in groupedNodes" :key="group.group" class="node-group">
            <div class="ng-head">
              <span class="ng-title">{{ group.label }}</span>
              <span class="chip mute">{{ group.nodes.length }}</span>
              <span class="ng-rule"></span>
            </div>
            <div class="node-grid">
              <div
                v-for="n in group.nodes"
                :key="n.key"
                class="node-card"
                :class="{ missing: !n.present }"
                @click="openNode(n)"
              >
                <div class="nc-title">{{ n.title }}</div>
                <div class="nc-type">{{ n.type }}</div>
                <div class="nc-foot">
                  <span>{{ n.params.length }} 个参数</span>
                  <span v-if="!n.present" class="warn-dot">不在图中</span>
                  <span v-else class="nc-edit">点击配置</span>
                </div>
              </div>
            </div>
          </div>

          <div v-if="!groupedNodes.length" class="empty" style="padding: 40px 0">
            导入 API 工作流后，这里会列出所有节点的参数入口。
          </div>
        </template>
      </main>
    </div>

    <n-drawer v-model:show="showParams" :width="980" placement="right">
      <n-drawer-content
        title="全部参数（按节点定义，不依赖已导入的工作流）"
        :native-scrollbar="false"
        body-content-style="padding: 0"
      >
        <SchemaBrowser />
      </n-drawer-content>
    </n-drawer>

    <NodeDialog
      v-model:show="showDialog"
      :node="dialogNode"
      :values="workflow.active?.values ?? {}"
      @change="onNodeChange"
      @reset="onNodeReset"
    />

    <n-modal v-model:show="showImport" preset="card" title="导入 API 工作流" style="max-width: 760px">
      <div class="muted row" style="font-size: 12.5px; margin-bottom: 10px; gap: 0; align-items: center">
        从 ComfyUI 导出 API 格式的 JSON
        <InfoTip
          :width="400"
          text="打开工作流 → 菜单 Workflow → Export (API)（部分版本叫 Save (API Format)）。&#10;得到的是一份 { 节点id: { class_type, inputs } } 的 JSON，粘在下面或选文件都可以。"
        />
      </div>
      <n-input
        v-model:value="importText"
        type="textarea"
        :rows="14"
        placeholder='{ "41": { "class_type": "MiniMaxH3LatentUpscaleModelOpt", "inputs": { ... } } }'
      />
      <div class="row-between" style="margin-top: 12px">
        <input type="file" accept=".json,application/json" style="font-size: 12px" @change="onFile" />
        <n-button type="primary" :disabled="!importText.trim()" @click="doImport">导入并生成参数</n-button>
      </div>
    </n-modal>

    <n-modal v-model:show="showLocal" preset="card" title="本机模型与工作流" style="max-width: 720px">
      <div class="muted row" style="font-size: 12.5px; margin-bottom: 10px; gap: 0; align-items: center">
        填 ComfyUI 的安装根目录
        <InfoTip
          :width="380"
          text="后端直接读 models/ 和 user/default/workflows/。&#10;不需要 ComfyUI 在跑 —— 模型只是磁盘上的文件，先配参数后起服务也一样能选。"
        />
      </div>

      <div class="row" style="gap: 6px">
        <n-input v-model:value="rootInput" placeholder="C:/path/to/ComfyUI" size="small" />
        <n-button size="small" type="primary" :loading="local.loading" @click="applyRoot">
          扫描
        </n-button>
      </div>

      <n-alert v-if="local.error" type="warning" :show-icon="false" style="margin-top: 10px">
        {{ local.error }}
      </n-alert>

      <template v-if="local.ready">
        <div class="local-sec">
          <div class="ls-head">模型文件（{{ local.summary.reduce((n, s) => n + s.count, 0) }}）</div>
          <div class="ls-grid">
            <div v-for="s in local.summary" :key="s.kind" class="ls-item">
              <span>{{ s.label }}</span>
              <b>{{ s.count }}</b>
            </div>
          </div>
          <div v-if="!local.summary.length" class="muted" style="font-size: 12px">
            目录里没找到已知类别的模型文件。
          </div>
        </div>

        <div class="local-sec">
          <div class="ls-head">工作流文件（{{ local.workflows.length }}）</div>
          <div class="muted" style="font-size: 11.5px; margin-bottom: 6px; font-family: var(--mono)">
            {{ local.root }}
          </div>
          <div v-if="!local.workflows.length" class="muted" style="font-size: 12px">
            没找到工作流 json。
          </div>
          <div
            v-for="f in local.workflows"
            :key="f.path"
            class="wf-row"
          >
            <div style="min-width: 0">
              <div class="wf-name">{{ f.name }}</div>
              <div class="muted" style="font-size: 11.5px">
                {{ f.path }} · {{ f.nodes }} 节点
              </div>
            </div>
            <div class="row" style="gap: 6px; flex: 0 0 auto">
              <n-tag :type="formatTag(f.format).type" size="small">
                {{ formatTag(f.format).label }}
              </n-tag>
              <n-button
                size="tiny"
                :disabled="f.format !== 'api'"
                @click="importLocalFile(f.path, f.name)"
              >
                导入
              </n-button>
            </div>
          </div>
          <div class="muted row" style="font-size: 11.5px; margin-top: 8px; gap: 0; align-items: center">
            标「界面格式」的不能导入
            <InfoTip
              size="sm"
              :width="340"
              text="它用 widgets_values 按位置存值，节点一改就整体错位。&#10;在 ComfyUI 里打开它 → Workflow → Export (API)，存一份新的再回来扫。"
            />
          </div>
        </div>

        <div class="local-sec">
          <div class="ls-head">从 ComfyUI 运行历史取图（不用手动导出）</div>
          <div class="muted row" style="font-size: 11.5px; margin-bottom: 6px; gap: 0; align-items: center">
            ComfyUI 在跑就能取
            <InfoTip
              size="sm"
              :width="360"
              text="ComfyUI 只在前端做界面 → API 转换，服务端没有导出接口；但跑过一次的图一定在 /history 里，而且已经是转好的 API 格式。"
            />
          </div>
          <div class="row" style="gap: 6px">
            <n-input v-model:value="historyBase" placeholder="http://127.0.0.1:8188" size="small" />
            <n-button
              size="small"
              :loading="local.historyLoading"
              @click="local.fetchHistory(historyBase)"
            >
              取最近运行
            </n-button>
          </div>
          <n-alert v-if="local.historyError" type="info" :show-icon="false" style="margin-top: 8px">
            {{ local.historyError }}
          </n-alert>
          <div
            v-for="h in local.historyItems"
            :key="h.id"
            class="wf-row"
          >
            <span class="wf-name">{{ h.label }}</span>
            <n-button size="tiny" type="primary" @click="importHistory(h.id, h.label)">
              导入
            </n-button>
          </div>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="showRenaming" preset="card" title="重命名模板" style="max-width: 420px">
      <n-input v-model:value="renameTo" placeholder="模板名称" @keyup.enter="commitRename" />
      <div class="row" style="justify-content: flex-end; margin-top: 14px">
        <n-button type="primary" @click="commitRename">确定</n-button>
      </div>
    </n-modal>
  </div>
</template>

<style scoped>
.console {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.console-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}
/* 未导入 API 的模板在左栏要一眼看出来 —— 光靠"节点数 0"不明显 */
.tpl-badge {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10.5px;
  line-height: 16px;
  color: var(--warn);
  background: var(--warn-soft);
}
.tpl-foot {
  flex: 0 0 auto;
  padding: 10px 12px;
  border-top: 1px solid var(--line);
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.6;
}
.console-main {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 20px 60px;
}
.up-card {
  border-color: var(--accent-line);
}
/* 折叠时头部不留分隔线，展开时才画 */
.up-card.open .fold-head {
  border-bottom: 1px solid var(--line);
}
.ups-tag {
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11.5px;
}
.node-group {
  margin-top: 18px;
}
/* 分组标题：标题 + 数量胶囊 + 一条通到底的细线。
   原来只有"模型 6"两个灰字浮在白底上，和下面的卡片没有从属关系。 */
.ng-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.ng-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.2px;
}
.ng-rule {
  flex: 1 1 auto;
  height: 1px;
  background: var(--line);
}
.node-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}
.node-card {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
  padding: 10px 12px;
  cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.12s;
}
.node-card:hover {
  border-color: var(--line-strong);
  box-shadow: var(--shadow);
}
.node-card.missing {
  background: var(--warn-soft);
  border-color: var(--warn-line);
}
.nc-title {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-type {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 9px;
  font-size: 11.5px;
  color: var(--muted);
}
.nc-edit {
  color: var(--accent);
}
.warn-dot {
  color: var(--warn);
}
code {
  font-family: var(--mono);
  font-size: 11.5px;
  background: var(--hover);
  padding: 0 4px;
  border-radius: 4px;
}
.local-sec {
  margin-top: 16px;
}
.ls-head {
  font-size: 12.5px;
  font-weight: 500;
  margin-bottom: 8px;
}
.ls-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 6px;
}
.ls-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12.5px;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-2);
}
.wf-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  margin-bottom: 6px;
}
.wf-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
