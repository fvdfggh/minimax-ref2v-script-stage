<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NInput,
  NModal,
  NSelect,
  NSwitch,
  NTabPane,
  NTabs,
  useMessage
} from 'naive-ui'
import { useProviderStore } from '@/stores/provider'
import type { Provider } from '@/domain/types'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [boolean] }>()

const provider = useProviderStore()
const message = useMessage()
const probing = ref(false)
const modelOptions = ref<Array<{ label: string; value: string }>>([])

const presets: Array<Partial<Provider> & { name: string }> = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com', model: 'gpt-4o-mini' },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' }
]

watch(
  () => props.show,
  (v) => {
    if (v) modelOptions.value = []
  }
)

function applyPreset(p: Partial<Provider> & { name: string }) {
  if (!provider.current) return
  provider.update(provider.current.id, {
    name: p.name,
    baseUrl: p.baseUrl ?? '',
    model: p.model ?? ''
  })
  modelOptions.value = []
}

async function probe() {
  probing.value = true
  try {
    const models = await provider.probeModels()
    modelOptions.value = models.map((m) => ({ label: m, value: m }))
    message.success(`拉取到 ${models.length} 个模型`)
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    probing.value = false
  }
}

function patch(key: keyof Provider, value: unknown) {
  if (!provider.current) return
  provider.update(provider.current.id, { [key]: value } as Partial<Provider>)
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="模型设置"
    style="max-width: 620px"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <n-alert v-if="!provider.current" type="warning" :bordered="false">
      还没有供应商配置
    </n-alert>

    <template v-else>
      <div class="row" style="flex-wrap: wrap; gap: 6px; margin-bottom: 14px">
        <n-button
          v-for="p in presets"
          :key="p.name"
          size="small"
          :type="provider.current.name === p.name ? 'primary' : 'default'"
          @click="applyPreset(p)"
        >
          {{ p.name }}
        </n-button>
      </div>

      <n-tabs type="segment" animated>
        <n-tab-pane name="conn" tab="连接">
          <div class="stack" style="margin-top: 12px">
            <div>
              <div class="muted" style="margin-bottom: 4px">名称</div>
              <n-input
                :value="provider.current.name"
                @update:value="(v: string) => patch('name', v)"
              />
            </div>
            <div>
              <div class="muted" style="margin-bottom: 4px">
                Base URL（带不带 /v1 都可以，会自动补齐）
              </div>
              <n-input
                :value="provider.current.baseUrl"
                placeholder="https://api.deepseek.com"
                @update:value="(v: string) => patch('baseUrl', v)"
              />
            </div>
            <div>
              <div class="muted" style="margin-bottom: 4px">API Key</div>
              <n-input
                :value="provider.current.apiKey"
                type="password"
                show-password-on="click"
                placeholder="sk-..."
                @update:value="(v: string) => patch('apiKey', v)"
              />
              <div class="row" style="margin-top: 8px">
                <n-switch
                  :value="provider.current.sessionOnly"
                  size="small"
                  @update:value="(v: boolean) => patch('sessionOnly', v)"
                />
                <span class="muted" style="font-size: 12.5px">
                  仅本次会话保留 Key（不写入浏览器数据库）
                </span>
              </div>
            </div>
          </div>
        </n-tab-pane>

        <n-tab-pane name="model" tab="模型">
          <div class="stack" style="margin-top: 12px">
            <div>
              <div class="muted" style="margin-bottom: 4px">模型名</div>
              <div class="row">
                <n-select
                  v-if="modelOptions.length"
                  :value="provider.current.model"
                  :options="modelOptions"
                  filterable
                  tag
                  style="flex: 1"
                  @update:value="(v: string) => patch('model', v)"
                />
                <n-input
                  v-else
                  :value="provider.current.model"
                  placeholder="deepseek-chat"
                  style="flex: 1"
                  @update:value="(v: string) => patch('model', v)"
                />
                <n-button :loading="probing" @click="probe">拉取列表</n-button>
              </div>
            </div>
          </div>
        </n-tab-pane>

        <n-tab-pane name="proxy" tab="代理兜底">
          <div class="stack" style="margin-top: 12px">
            <div>
              <div class="muted" style="margin-bottom: 4px">
                代理前缀（浏览器直连被 CORS 拦截时使用）
              </div>
              <n-input
                :value="provider.current.proxyPrefix ?? ''"
                placeholder="https://your-worker.workers.dev/?url="
                @update:value="(v: string) => patch('proxyPrefix', v)"
              />
            </div>
            <n-alert type="info" :bordered="false">
              <div style="font-size: 12.5px; line-height: 1.7">
                目标地址会被拼成 <code>前缀 + encodeURIComponent(真实地址)</code>，
                也可以用 <code>{url}</code> 作为占位符。<br />
                本地 Ollama 请设置环境变量 <code>OLLAMA_ORIGINS=*</code> 后重启。
              </div>
            </n-alert>
          </div>
        </n-tab-pane>
      </n-tabs>
    </template>

    <template #footer>
      <div class="row" style="justify-content: space-between">
        <span class="muted" style="font-size: 12.5px">
          纯前端运行，Key 只存在你的浏览器里
        </span>
        <n-button type="primary" @click="emit('update:show', false)">完成</n-button>
      </div>
    </template>
  </n-modal>
</template>
