<script setup lang="ts">
/*
 * 「换一台设备接着做」的入口。
 *
 * 项目包 = 项目 + 各集（分镜/主体/素材文件）+ 用到的音色包，导入后 id 全部重映射，
 * 所以不会跟本机已有项目打架。这里只管挑文件、报结果，打包逻辑在 server/store.py。
 */
import { computed, ref } from 'vue'
import { NButton, NModal, NSpin, useMessage } from 'naive-ui'
import { importWorkspace } from '@/db'
import type { ImportResult } from '@/core/backend'
import ImportReport from '@/components/ImportReport.vue'
import InfoTip from '@/components/common/InfoTip.vue'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const show = computed({
  get: () => props.show,
  set: (v: boolean) => emit('update:show', v)
})

const message = useMessage()
const busy = ref(false)
const dragging = ref(false)
const result = ref<ImportResult | null>(null)
const fileName = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

async function take(file: File | undefined | null): Promise<void> {
  if (!file) return
  if (!/\.(zip|json)$/i.test(file.name)) {
    message.warning('请选择项目包（.zip）或旧版备份')
    return
  }
  busy.value = true
  fileName.value = file.name
  try {
    result.value = await importWorkspace(file)
    const r = result.value
    message.success(`已导入「${r.name || fileName.value}」：${r.projects ?? 1} 个项目`)
  } catch (err) {
    message.error(`导入失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    busy.value = false
  }
}

function onPick(ev: Event): void {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  void take(file)
}

function onDrop(ev: DragEvent): void {
  dragging.value = false
  void take(ev.dataTransfer?.files?.[0])
}

function reload(): void {
  location.reload()
}

function close(): void {
  show.value = false
  if (result.value) location.reload()
}
</script>

<template>
  <n-modal v-model:show="show" preset="card" title="导入项目" style="max-width: 560px">
    <div class="stack" style="gap: 12px">
      <div
        class="panel"
        :style="{
          padding: '26px 18px',
          textAlign: 'center',
          borderStyle: 'dashed',
          borderColor: dragging ? 'var(--accent)' : undefined,
          background: dragging ? 'var(--accent-soft)' : undefined
        }"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <n-spin v-if="busy" size="small" />
        <template v-else>
          <div style="font-size: 13.5px; margin-bottom: 6px">把项目包拖到这里</div>
          <div class="muted" style="font-size: 12px">
            或点下面按钮选文件（.zip）
            <InfoTip size="sm" :width="280" text="项目包里有项目、各集、素材和音色包；导入是新建一份，不会覆盖本机已有的同名项目。" />
          </div>
          <input
            ref="fileInput"
            type="file"
            accept=".zip,.json"
            style="display: none"
            @change="onPick"
          />
          <n-button size="small" type="primary" style="margin-top: 12px" @click="fileInput?.click()">
            选择项目包…
          </n-button>
        </template>
      </div>

      <ImportReport v-if="result" :result="result" @reload="reload" />
    </div>

    <template #footer>
      <div class="row" style="justify-content: flex-end">
        <n-button v-if="result" type="primary" @click="close">完成</n-button>
        <n-button v-else @click="show = false">关闭</n-button>
      </div>
    </template>
  </n-modal>
</template>
