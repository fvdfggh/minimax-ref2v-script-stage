<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NInput, NModal, NSpin, useMessage } from 'naive-ui'
import { useStorageStore } from '@/stores/storage'
import {
  backendChildren,
  backendRoots,
  type FsEntry,
  type ImportResult
} from '@/core/backend'
import { importIsClean, importSummary } from '@/domain/importReport'
import ImportReport from '@/components/ImportReport.vue'
import { exportWorkspace, importWorkspace } from '@/db'
import InfoTip from '@/components/common/InfoTip.vue'

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

/** 导入结果留在弹窗里：音色包没跟过来这种事，一闪而过的 toast 会被错过 */
const lastImport = ref<ImportResult | null>(null)

async function doExport(): Promise<void> {
  busy.value = true
  try {
    const { blob, filename } = await exportWorkspace()
    download(blob, filename)
    message.success('已导出')
  } catch (err) {
    message.error(`导出失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    busy.value = false
  }
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

async function onPickFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = true
  try {
    const res = await importWorkspace(file)
    lastImport.value = res
    message.success(`已导入：${importSummary(res)}`)
    // 干净导入就直接刷新；有缺失/冲突就留在弹窗里让用户看完再点刷新
    if (importIsClean(res)) setTimeout(() => location.reload(), 600)
  } catch (err) {
    message.error(`导入失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    busy.value = false
  }
}

function reload(): void {
  location.reload()
}

watch(show, (v) => {
  if (v && storage.online) void openFs('')
})

onMounted(() => {
  manualPath.value = storage.dataDir
})
</script>

<template>
  <n-modal v-model:show="show" preset="card" title="存储设置" style="max-width: 740px">
    <div class="st-body">
      <div class="st-line">
        <span class="chip">存储</span>
        <span class="st-tip">
          数据统一由 Python 后端写进你选的文件夹
          <InfoTip size="sm" :width="280" text="素材是真文件，能备份、能进版本管理。" />
        </span>
      </div>

      <!-- 后端 -->
      <section class="st-sec t-blue">
        <div class="st-sec-h">后端连接</div>

        <div class="st-line">
          <span class="chip ok row" style="gap: 0; align-items: center">
            后端目录（Python）
            <InfoTip
              size="sm"
              :width="300"
              text="不再使用浏览器本地存储；后端没起时应用会提示你启动，而不是悄悄退回浏览器。"
            />
          </span>
        </div>

        <div class="st-field">
          <div class="st-l">后端地址</div>
          <div class="st-inline">
            <n-input v-model:value="storage.baseUrl" size="small" placeholder="留空 = 同源（推荐）" />
            <n-button size="small" :loading="storage.checking" @click="connect">连接</n-button>
          </div>
        </div>

        <div v-if="storage.online" class="st-status ok">
          <span class="chip ok">已连接</span>
          <span class="mono st-path">{{ storage.dataDir }}</span>
        </div>
        <p v-else class="st-help">
          后端没启动的话，在项目目录双击 <code>启动剧本台.bat</code>，或跑 <code>npm start</code>
        </p>
      </section>

      <!-- 数据目录 -->
      <section v-if="storage.online" class="st-sec t-teal">
        <div class="st-sec-h">
          数据目录
          <button v-if="!picking" type="button" class="st-link" @click="startPick">选择文件夹</button>
          <button v-else type="button" class="st-link" @click="picking = false">取消选择</button>
        </div>

        <div v-if="!picking" class="st-path-box mono">{{ storage.dataDir }}</div>

        <div v-else class="st-browser">
          <div class="st-browser-h">
            <span class="mono st-path">{{ fsPath || '（选择盘符）' }}</span>
            <div class="st-inline">
              <n-button size="tiny" :disabled="!fsParent" @click="openFs(fsParent || '')">上一级</n-button>
              <n-button size="tiny" quaternary @click="openFs('')">回到盘符</n-button>
            </div>
          </div>

          <n-spin v-if="fsLoading" size="small" />

          <div v-else class="st-dirs">
            <button
              v-for="d in fsPath ? fsDirs : fsRoots"
              :key="d.path"
              type="button"
              class="st-dir"
              @click="openFs(d.path)"
            >
              <span class="st-dir-n">{{ d.name }}</span>
              <span class="mono st-dir-p">{{ d.path }}</span>
            </button>
            <div v-if="fsPath && !fsDirs.length" class="st-empty">这个文件夹里没有子目录</div>
          </div>

          <div class="st-manual">
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
      </section>

      <!-- 备份 -->
      <section class="st-sec t-violet">
        <div class="st-sec-h">备份</div>
        <div class="st-inline">
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
        <p class="st-help">
          整库备份用「导出全部」，只带走一个项目用「导出项目包」
          <InfoTip size="sm" :width="300" text="项目包连同各集、素材、音色包一起打包。" />
        </p>

        <ImportReport v-if="lastImport" :result="lastImport" @reload="reload" />
      </section>
    </div>

    <template #footer>
      <div class="row" style="justify-content: flex-end">
        <n-button @click="show = false">关闭</n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.st-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

/* ---------- 段 ---------- */
.st-sec {
  --mod: var(--m-blue);
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.st-sec.t-teal {
  --mod: var(--m-teal);
}
.st-sec.t-violet {
  --mod: var(--m-violet);
}
.st-sec + .st-sec {
  border-top: 1px dashed var(--line);
  padding-top: 12px;
}
.st-sec-h {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.4px;
  color: var(--text-2);
}
.st-sec-h::before {
  content: '';
  width: 14px;
  height: 3px;
  border-radius: 2px;
  background: var(--mod);
}
.st-link {
  margin-left: auto;
  padding: 0 7px;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  background: var(--panel-2);
  color: var(--accent-ink);
  font-size: var(--fs-xs);
  line-height: 19px;
  cursor: pointer;
}
.st-link:hover {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}

/* ---------- 行 / 字段 ---------- */
.st-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex-wrap: wrap;
}
.st-tip {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--muted);
}
.st-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.st-l {
  font-size: var(--fs-sm);
  color: var(--label);
}
.st-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.st-status {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 4px 8px;
  border-radius: var(--r-sm);
  background: var(--ok-soft);
  border: 1px solid var(--ok-line);
}
.st-path {
  min-width: 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
  word-break: break-all;
}
.st-path-box {
  padding: 6px 9px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  background: var(--panel-2);
  font-size: var(--fs-sm);
  color: var(--text-2);
  word-break: break-all;
}
.st-help {
  margin: 0;
  font-size: 10.8px;
  line-height: 1.65;
  color: var(--muted);
}
.st-help code {
  padding: 0 4px;
  border-radius: var(--r-xs);
  background: var(--panel-3);
  font-family: var(--mono);
  font-size: 10.5px;
}

/* ---------- 目录浏览 ---------- */
.st-browser {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel-2);
}
.st-browser-h {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.st-dirs {
  max-height: 220px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.st-dir {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}
.st-dir:hover {
  background: var(--panel);
  border-color: var(--line);
}
.st-dir-n {
  min-width: 0;
  font-size: var(--fs-base);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.st-dir-p {
  flex: 0 0 auto;
  font-size: 10.5px;
  color: var(--muted-2);
}
.st-empty {
  padding: 8px;
  font-size: var(--fs-sm);
  color: var(--muted);
  text-align: center;
}
.st-manual {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px dashed var(--line);
}
</style>
