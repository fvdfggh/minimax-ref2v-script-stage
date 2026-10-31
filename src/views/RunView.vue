<script setup lang="ts">
/**
 * 运行页。
 *
 * ★ 布局（2026-10 重整）：
 *   左：参数（RunConfigPanel 自带"配置列表 + 参数"）
 *   右：运行台 / 导演台（同一个窄栏里切换）
 *
 * 以前是「运行配置 / 运行台 / 导演台」三个平级 tab —— 配完参数要切走才能提交，
 * 提交完要再切一次看进度，来回跳三次，且每次切走都看不到自己刚改的值。
 * 现在参数常驻左侧，右边只切"看什么"，不再切"改什么"。
 *
 * 「ComfyUI 连接 / 缓存分集 / 提交方式」搬到顶栏的设置抽屉：那是配一次就不动的
 * 东西，占着第一屏只会把常用项挤下去。顶栏留一个状态灯就够。
 */
import { computed, onMounted, ref } from 'vue'
import { NButton, NDrawer, NDrawerContent, NRadioButton, NRadioGroup, useMessage } from 'naive-ui'
import TopTabs from '@/components/TopTabs.vue'
import RunConfigPanel from '@/components/run/RunConfigPanel.vue'
import RunJobsPanel from '@/components/run/RunJobsPanel.vue'
import DirectorActionsPanel from '@/components/run/DirectorActionsPanel.vue'
import SettingsDrawer from '@/components/run/SettingsDrawer.vue'
import { useRunStore } from '@/stores/run'
import { useWorkflowStore } from '@/stores/workflow'
import { useStorageStore } from '@/stores/storage'

const run = useRunStore()
const workflow = useWorkflowStore()
const storage = useStorageStore()
const message = useMessage()

/** 右栏看什么：运行台（默认）或导演台动作。左边改什么永远可见。 */
const side = ref<'jobs' | 'director'>('jobs')

const showSettings = ref(false)

const statusKind = computed(() => {
  if (run.online === true) return 'ok'
  if (run.online === false) return 'bad'
  return ''
})

const statusText = computed(() => {
  if (run.online === true) return 'ComfyUI 已连上'
  if (run.online === false) return 'ComfyUI 未连上'
  return '未探测'
})

function openSettings() {
  showSettings.value = true
}

onMounted(async () => {
  await storage.init()
  if (!storage.ready) {
    message.warning('连不上 Python 后端，运行页不可用')
    return
  }
  await workflow.load()
  await run.load()
})
</script>

<template>
  <div class="runview">
    <header class="page-head">
      <div class="page-head-left">
        <span class="page-brand">运行</span>
        <TopTabs />
      </div>
      <div class="page-head-right">
        <span
          class="status-dot"
          :class="statusKind"
          :title="`${run.active?.baseUrl ?? ''}　点开可改地址`"
          style="cursor: pointer"
          @click="openSettings"
        >
          {{ statusText }}
        </span>
        <span
          v-if="run.running.length"
          class="tag-chip"
          style="background: var(--accent-soft); color: var(--accent)"
        >
          {{ run.running.length }} 个在跑
        </span>
        <n-button size="small" quaternary @click="openSettings">设置</n-button>
      </div>
    </header>

    <div class="rv-body">
      <div v-if="!storage.ready" class="rv-block">
        连不上 Python 后端。在项目目录运行
        <code>python server/app.py</code>（地址 <span class="mono">{{ storage.baseUrl }}</span>）后重试。
      </div>

      <template v-else>
        <RunConfigPanel class="rv-cfg" />

        <aside class="rv-side">
          <div class="rv-side-head">
            <n-radio-group v-model:value="side" size="small">
              <n-radio-button value="jobs">
                运行台<template v-if="run.running.length">（{{ run.running.length }}）</template>
              </n-radio-button>
              <n-radio-button value="director">导演台</n-radio-button>
            </n-radio-group>
          </div>
          <div class="rv-side-body">
            <RunJobsPanel v-show="side === 'jobs'" compact />
            <DirectorActionsPanel v-show="side === 'director'" />
          </div>
        </aside>
      </template>
    </div>

    <n-drawer v-model:show="showSettings" :width="520" placement="right">
      <n-drawer-content title="运行设置" :native-scrollbar="false">
        <SettingsDrawer />
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped>
.runview {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.rv-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: stretch;
}
.rv-cfg {
  flex: 1 1 auto;
  min-width: 0;
}
.rv-side {
  flex: 0 0 auto;
  width: 420px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--line);
  background: var(--panel-2);
}
.rv-side-head {
  flex: 0 0 auto;
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.rv-side-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
.rv-block {
  padding: 40px 20px;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.8;
}
code {
  font-family: var(--mono);
  font-size: 12px;
  background: var(--hover);
  padding: 0 4px;
  border-radius: 4px;
}
</style>
