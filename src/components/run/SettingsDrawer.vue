<script setup lang="ts">
/**
 * 运行设置抽屉 —— 装的是「配一次基本不动」的东西。
 *
 * 从前这三块（ComfyUI 连接、缓存分集、提交方式）和「采样步数」长得一模一样、
 * 平等地堆在运行配置首页最前面。结果是：最不常改的东西占了第一屏，
 * 用户每次跑都要滚过一遍连接地址和两段技术说明。
 *
 * 现在它们收进抽屉，顶栏只留一个连接状态灯；需要动的人才点进来。
 * 判断标准很简单：**每次运行都要看一眼的 → 留在页面；一个月改一次的 → 进这里。**
 */
import { computed } from 'vue'
import { NButton, NInput, NSelect, NSwitch, NTag } from 'naive-ui'
import { useRunStore } from '@/stores/run'
import { useMessage } from 'naive-ui'
import InfoTip from '@/components/common/InfoTip.vue'
import { resolveWorkflowName, type RunConfig } from '@/domain/run'

const run = useRunStore()
const message = useMessage()

const cfg = computed(() => run.active)

function set(key: keyof RunConfig, value: unknown) {
  if (!cfg.value) return
  run.patch(cfg.value.id, { [key]: value } as Partial<RunConfig>)
}

async function doProbe() {
  const ok = await run.probe(cfg.value?.baseUrl ?? '')
  if (ok) message.success('ComfyUI 已连上')
  else message.error(`连不上 ComfyUI：${run.onlineDetail || '未知原因'}`, { duration: 8000 })
}

/** 缓存目录预览 —— 按集分缓存全靠这个值，必须让用户看见它落到哪 */
const workflowNamePreview = computed(() => {
  if (!cfg.value) return ''
  return resolveWorkflowName(cfg.value, '第 01 集 · 夜班')
})

const devices = computed(() => {
  const s = run.stats as { devices?: Array<{ name: string; vram_total: number }> } | null
  if (!s?.devices) return []
  return s.devices.map((d) => `${d.name} ${(d.vram_total / 1024 ** 3).toFixed(0)}G`)
})
</script>

<template>
  <div v-if="!cfg" class="empty">没有运行配置</div>

  <div v-else class="sd">
    <section class="sd-sec">
      <div class="sd-head">
        <span>ComfyUI 连接</span>
        <div class="row" style="gap: 6px">
          <n-tag v-if="run.online === true" size="small" type="success" :bordered="false">已连上</n-tag>
          <n-tag v-else-if="run.online === false" size="small" type="error" :bordered="false">未连上</n-tag>
          <n-tag v-else size="small" :bordered="false">未探测</n-tag>
          <n-button size="tiny" quaternary :loading="run.probing" @click="doProbe">测试连接</n-button>
        </div>
      </div>
      <div class="sd-body">
        <label class="f">
          <span class="f-label">
            地址
            <InfoTip
              text="请求经剧本台后端转发，不走浏览器直连 —— 否则会被 CORS 和本机代理拦掉。进度用 WebSocket 直连，所以这里填的地址要能被浏览器访问到。"
            />
          </span>
          <n-input
            :value="cfg.baseUrl"
            size="small"
            placeholder="http://127.0.0.1:8188"
            @update:value="(v: string) => set('baseUrl', v)"
          />
        </label>
        <div v-if="devices.length" class="f-hint mono">可见显卡：{{ devices.join(' · ') }}</div>
        <div v-if="run.online === false && run.onlineDetail" class="f-hint warn">
          {{ run.onlineDetail }}
        </div>
      </div>
    </section>

    <section class="sd-sec">
      <div class="sd-head">
        <span>缓存分集</span>
        <span class="muted mono" style="font-size: 12px">{{ workflowNamePreview }}</span>
      </div>
      <div class="sd-body">
        <label class="f">
          <span class="f-label">命名</span>
          <n-select
            :value="cfg.workflowNameMode"
            :options="[
              { label: '按集名（推荐）', value: 'episode' },
              { label: '自定义', value: 'custom' }
            ]"
            size="small"
            @update:value="(v: 'episode' | 'custom') => set('workflowNameMode', v)"
          />
        </label>
        <label v-if="cfg.workflowNameMode === 'custom'" class="f">
          <span class="f-label">目录名</span>
          <n-input
            :value="cfg.workflowNameCustom"
            size="small"
            placeholder="ep01"
            @update:value="(v: string) => set('workflowNameCustom', v)"
          />
        </label>
        <label class="f f-switch">
          <span class="f-label">提交前清缓存</span>
          <n-switch
            :value="cfg.clearCacheOnSubmit"
            @update:value="(v: boolean) => set('clearCacheOnSubmit', v)"
          />
        </label>
        <div class="f-hint" style="display: flex; align-items: center; gap: 4px">
          缓存按这个值分目录
          <InfoTip
            size="sm"
            :width="380"
            text="一采 seg_*、二采 seg2_*；_reflat 全局共享。&#10;视觉塔输出只在内存里，不落盘；换过 TE kernel 或量化之后要清一次 —— 文本编码现在也只驻留进程内存。"
          />
        </div>
      </div>
    </section>

    <section class="sd-sec">
      <div class="sd-head"><span>提交方式</span></div>
      <div class="sd-body">
        <label class="f f-switch">
          <span class="f-label">
            经 pack 导入
            <InfoTip
              text="开：把导演包 zip 交给 ComfyUI 的 /minimax/director_opt/import_pack，用对面解出来的时间线（参考图路径是它落盘的，最稳）。关：直接用剧本台自己生成的时间线（ComfyUI 没装导演包时用它）。"
            />
          </span>
          <n-switch :value="cfg.usePackImport" @update:value="(v: boolean) => set('usePackImport', v)" />
        </label>
      </div>
    </section>
  </div>
</template>

<style scoped>
.sd {
  padding: 4px 16px 24px;
}
.sd-sec {
  margin-bottom: 20px;
}
.sd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
  font-weight: 500;
  padding: 6px 0 8px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 10px;
}
.sd-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
}
.f {
  display: flex;
  flex-direction: column;
  gap: 4px;
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
  display: flex;
  align-items: center;
  font-size: 11.5px;
  color: var(--muted);
}
.f-hint {
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
