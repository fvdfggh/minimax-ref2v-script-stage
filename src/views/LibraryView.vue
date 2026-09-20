<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NEmpty, NInput, NModal, NPopconfirm, useMessage } from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useProviderStore } from '@/stores/provider'
import ProviderDialog from '@/components/ProviderDialog.vue'

const router = useRouter()
const project = useProjectStore()
const provider = useProviderStore()
const message = useMessage()

const showCreate = ref(false)
const showProvider = ref(false)
const newName = ref('')
const newStory = ref('')

onMounted(async () => {
  await Promise.all([project.loadAll(), provider.load()])
})

async function create() {
  if (!newName.value.trim()) {
    message.warning('请填写项目名称')
    return
  }
  const p = await project.create(newName.value.trim(), newStory.value)
  showCreate.value = false
  newName.value = ''
  newStory.value = ''
  router.push(`/p/${p.id}`)
}

function open(id: string) {
  router.push(`/p/${id}`)
}

async function remove(id: string, name: string) {
  await project.remove(id)
  message.success(`已删除「${name}」`)
}

function stageLabel(stage: string) {
  return (
    {
      split: '① 拆解',
      enrich: '② 细节填充',
      assemble: '③ 组合与缝合',
      complete: '④ 字段补全',
      localize: '⑤ 中英本地化',
      deliver: '⑥ 交付'
    } as Record<string, string>
  )[stage] ?? stage
}
</script>

<template>
  <div style="max-width: 1080px; margin: 0 auto; padding: 32px 20px 64px">
    <div class="row-between" style="margin-bottom: 6px">
      <div>
        <h1 style="margin: 0; font-size: 24px; letter-spacing: -0.01em">剧本台</h1>
        <div class="muted" style="margin-top: 4px">
          Ref2VA 分镜工作台 · 原子片段 → 自定义组合 → 缝合自动判定
        </div>
      </div>
      <div class="row">
        <n-button quaternary @click="showProvider = true">
          模型设置
          <span
            class="tag-chip"
            :style="{
              marginLeft: '6px',
              background: provider.ready ? 'var(--accent-soft)' : '#fdecec',
              color: provider.ready ? 'var(--accent)' : 'var(--err)'
            }"
          >
            {{ provider.ready ? '已连接' : '未配置' }}
          </span>
        </n-button>
        <n-button type="primary" @click="showCreate = true">新建项目</n-button>
      </div>
    </div>

    <div v-if="!project.projects.length" class="panel" style="margin-top: 28px">
      <div class="empty">
        <div style="font-size: 15px; margin-bottom: 6px">还没有项目</div>
        <div>新建一个项目，粘贴故事原文，让模型拆成分镜片段</div>
      </div>
    </div>

    <div
      v-else
      style="
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 14px;
        margin-top: 24px;
      "
    >
      <div v-for="p in project.projects" :key="p.id" class="panel" style="padding: 16px">
        <div class="row-between">
          <div style="font-weight: 600; font-size: 15px">{{ p.name }}</div>
          <span
            class="tag-chip"
            style="background: var(--accent-soft); color: var(--accent)"
          >
            {{ stageLabel(p.stage) }}
          </span>
        </div>
        <div
          class="muted"
          style="
            margin-top: 8px;
            height: 42px;
            overflow: hidden;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            line-clamp: 2;
            -webkit-box-orient: vertical;
          "
        >
          {{ p.story ? p.story.slice(0, 80) : '（还没有输入故事）' }}
        </div>
        <div class="row-between" style="margin-top: 14px">
          <n-button size="small" type="primary" ghost @click="open(p.id)">打开</n-button>
          <n-popconfirm @positive-click="remove(p.id, p.name)">
            <template #trigger>
              <n-button size="small" quaternary type="error">删除</n-button>
            </template>
            同时删除该项目的所有片段与方案，确定？
          </n-popconfirm>
        </div>
      </div>
    </div>

    <n-modal v-model:show="showCreate" preset="card" title="新建项目" style="max-width: 560px">
      <div class="stack">
        <div>
          <div class="muted" style="margin-bottom: 6px">项目名称</div>
          <n-input v-model:value="newName" placeholder="例如：毒尊归来 第 01 集" />
        </div>
        <div>
          <div class="muted" style="margin-bottom: 6px">故事原文（可稍后填写）</div>
          <n-input
            v-model:value="newStory"
            type="textarea"
            :rows="8"
            placeholder="把故事、剧本或分场稿粘贴进来，稍后由模型拆解成原子片段"
          />
        </div>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button @click="showCreate = false">取消</n-button>
          <n-button type="primary" @click="create">创建并打开</n-button>
        </div>
      </template>
    </n-modal>

    <ProviderDialog v-model:show="showProvider" />
  </div>
</template>

<style scoped>
:deep(.n-empty) {
  --n-icon-color: #b9bfca;
}
</style>
