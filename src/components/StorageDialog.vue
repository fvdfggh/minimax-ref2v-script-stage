<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NInput, NModal, NSpin, NTag, useMessage } from 'naive-ui'
import { useStorageStore } from '@/stores/storage'
import {
  backendChildren,
  backendRoots,
  type FsEntry
} from '@/core/backend'
import { exportWorkspace, importWorkspace } from '@/db'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const storage = useStorageStore()
const message = useMessage()

const show = computed({
  get: () => props.show,
  set: (v: boolean) => emit('update:show', v)
})

const fileInput = ref<HTMLInputElement | null>(null)
const busy = ref(false)

/* ---------------- 目录浏览 ---------------- */

const fsRoots = ref<FsEntry[]>([])
const fsDirs = ref<FsEntry[]>([])
const fsPath = ref('')
const fsParent = ref<string | null>(null)
const fsLoading = ref(false)
const manualPath = ref('')

async function openFs(path = ''): Promise<void> {
  fsLoading.value = true
  try {
    if (!path) {
      fsRoots.value = await backendRoots()
      fsDirs.value = []
      fsPath.value = ''
      fsParent.value = null
      return
    }
    const res = await backendChildren(path)
    fsPath.value = res.path
    fsParent.value = res.parent
    fsDirs.value = res.dirs ?? []
  } catch (err) {
    message.error(`读目录失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    fsLoading.value = false
  }
}

const picking = ref(false)

function startPick(): void {
  picking.value = true
  manualPath.value = storage.dataDir
  void openFs('')
}

async function confirmDir(path: string): Promise<void> {
  if (!path) {
    message.warning('先选一个文件夹')
    return
  }
  busy.value = true
  try {
    await storage.setDataDir(path)
    picking.value = false
    message.success(`数据目录已设为 ${path}`)
  } catch (err) {
    message.error(`设置失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    busy.value = false
  }
}

/* ---------------- 连接 ---------------- */

async function connect(): Promise<void> {
  const ok = await storage.probe(storage.baseUrl)
  if (!ok) {
    message.error(storage.lastError || '连不上后端')
    return
  }
  message.success(`已连上后端，数据目录 ${storage.dataDir}`)
  void openFs('')
}

/* ---------------- 导入导出 ---------------- */

async function doExport(): Promise<void> {
  busy.value = true
  try {
    const { blob, filename } = await exportWorkspace()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
    message.success('已导出')
  } catch (err) {
    message.error(`导出失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    busy.value = false
  }
}

async function onPickFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = true
  try {
    const res = await importWorkspace(file)
    message.success(`已导入 ${res.projects} 个项目`)
    setTimeout(() => location.reload(), 400)
  } catch (err) {
    message.error(`导入失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    busy.value = false
  }
}

watch(show, (v) => {
  if (v && storage.online) void openFs('')
})

onMounted(() => {
  manualPath.value = storage.dataDir
})
</script>

<template>
  <n-modal v-model:show="show" preset="card" title="存储设置" style="max-width: 720px">
    <div class="stack" style="gap: 14px">
      <n-alert type="info" :bordered="false">
        所有数据统一由 Python 后端管理，写进你选的文件夹：素材是真文件，能备份、能进版本管理。
      </n-alert>

      <!-- 存储 -->
      <div>
        <div class="muted" style="font-size: 12.5px; margin-bottom: 6px">当前存储</div>
        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <n-tag type="success" :bordered="false" size="small">后端目录（Python）</n-tag>
          <span class="muted" style="font-size: 12px">
            不再使用浏览器本地存储；后端没起时应用会提示你启动，而不是悄悄退回浏览器。
          </span>
        </div>
      </div>

      <!-- 后端地址 -->
      <div>
        <div class="muted" style="font-size: 12.5px; margin-bottom: 6px">后端地址</div>
        <div class="row" style="gap: 8px">
          <n-input v-model:value="storage.baseUrl" size="small" placeholder="http://127.0.0.1:8787" />
          <n-button size="small" :loading="storage.checking" @click="connect">连接</n-button>
        </div>
        <div v-if="storage.online" class="row" style="gap: 6px; margin-top: 6px">
          <n-tag size="small" type="success" :bordered="false">已连接</n-tag>
          <span class="muted mono" style="font-size: 12px">{{ storage.dataDir }}</span>
        </div>
        <div v-else class="muted" style="font-size: 12px; margin-top: 6px">
          后端没启动的话，先在项目目录跑
          <code>python server/app.py</code>
        </div>
      </div>

      <!-- 数据目录 -->
      <div v-if="storage.online">
        <div class="row-between" style="margin-bottom: 6px">
          <span class="muted" style="font-size: 12.5px">数据目录</span>
          <n-button size="tiny" quaternary @click="startPick">
            {{ picking ? '取消选择' : '选择文件夹' }}
          </n-button>
        </div>

        <div v-if="!picking" class="muted mono" style="font-size: 12px; word-break: break-all">
          {{ storage.dataDir }}
        </div>

        <div v-else class="panel" style="padding: 10px">
          <div class="row-between" style="margin-bottom: 8px">
            <span class="mono" style="font-size: 12px; word-break: break-all">
              {{ fsPath || '（选择盘符）' }}
            </span>
            <div class="row" style="gap: 6px">
              <n-button size="tiny" :disabled="!fsParent" @click="openFs(fsParent || '')">
                上一级
              </n-button>
              <n-button size="tiny" quaternary @click="openFs('')">回到盘符</n-button>
            </div>
          </div>

          <n-spin v-if="fsLoading" size="small" />

          <div v-else style="max-height: 220px; overflow: auto">
            <div
              v-for="d in fsPath ? fsDirs : fsRoots"
              :key="d.path"
              class="row-between"
              style="
                padding: 5px 8px;
                cursor: pointer;
                border-radius: 6px;
                font-size: 13px;
              "
              @click="openFs(d.path)"
            >
              <span>{{ d.name }}</span>
              <span class="muted mono" style="font-size: 11px">{{ d.path }}</span>
            </div>
            <div v-if="fsPath && !fsDirs.length" class="muted" style="padding: 8px">
              这个文件夹里没有子目录
            </div>
          </div>

          <div class="row" style="gap: 8px; margin-top: 10px">
            <n-input
              v-model:value="manualPath"
              size="small"
              placeholder="也可以直接粘贴绝对路径"
              style="flex: 1"
            />
            <n-button size="small" type="primary" :loading="busy" @click="confirmDir(manualPath || fsPath)">
              用这个目录
            </n-button>
          </div>
        </div>
      </div>

      <!-- 导入导出 -->
      <div>
        <div class="muted" style="font-size: 12.5px; margin-bottom: 6px">备份</div>
        <div class="row" style="gap: 8px">
          <n-button size="small" :loading="busy" @click="doExport">导出全部</n-button>
          <n-button size="small" :loading="busy" @click="fileInput?.click()">导入备份</n-button>
          <input
            ref="fileInput"
            type="file"
            accept=".zip,.json"
            style="display: none"
            @change="onPickFile"
          />
        </div>
        <div class="muted" style="font-size: 12px; margin-top: 6px">
          导出的是 zip，含素材文件；导入时支持单项目 / 整库 / 旧版备份三种格式。
        </div>
      </div>
    </div>

    <template #footer>
      <div class="row" style="justify-content: flex-end">
        <n-button @click="show = false">关闭</n-button>
      </div>
    </template>
  </n-modal>
</template>
