<script setup lang="ts">
/**
 * 一条素材的提示词编辑器（出图弹窗 / 素材详情里那块）。
 *
 * 为什么提示词要挂在**素材**上，而不是段上：
 *   一段可能有三张图（首帧 / 中间锚点 / 尾帧），每张画的东西不一样。
 *   段级只有一个提示词框时，第二张图要么复用第一张的句子，要么另开一个
 *   弹窗临时写 —— 前者画错、后者写完就丢。挂在素材上，一条素材一句话，
 *   刷新、换设备、隔天回来都还在。
 *
 * 一条提示词的三个要素（顺序也是界面上从上到下的顺序）：
 *   ① 正文：这一镜画什么。新增时是**空的** —— 空白提示词是一条待填的活。
 *   ② 一句要求 + AI 生成：用户说人话（"雨夜巷口，他回头看一眼"），
 *      模型把它写成英文画面语言。原话存进 promptBrief，下次还能改一改再生成。
 *   ③ 参考图：这条素材照着哪些主体图来画。参考方式下这些图会以
 *      `<Picture N> 名字 — 外观` 的形式写进提示词末尾（见 domain/assetPrompt）。
 *
 * 为什么引用段是**只读**的：它由 refAssetIds 现拼。让用户手抄编号，
 * 换一张参考图就得回去改一遍，改漏一次导演包就少一张图。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NInput, useMessage } from 'naive-ui'
import { useRegistryStore } from '@/stores/registry'
import { useImageStore } from '@/stores/images'
import { PLACEMENT_LABEL, actAsOf, placementOf } from '@/domain/references'
import { referenceSection } from '@/domain/assetPrompt'
import type { Asset, AssetActAs, Beat, ID } from '@/domain/types'

const props = defineProps<{
  beat: Beat
  asset: Asset
  /** 卡片上已经有一张真图时，「出图」是重出；草稿是第一次出图 */
  hasImage: boolean
}>()

const emit = defineEmits<{
  changed: []
  /** 用这条提示词出图（父级负责弹窗与落库） */
  gen: [asset: Asset]
}>()

const registry = useRegistryStore()
const images = useImageStore()
const message = useMessage()

/* ------------------------------ 正文 ------------------------------ */

const body = ref(images.materialPromptBody(props.asset))
watch(
  () => props.asset.id,
  () => {
    body.value = images.materialPromptBody(props.asset)
  }
)

let timer: ReturnType<typeof setTimeout> | null = null
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

function onBodyInput(v: string) {
  body.value = v
  if (timer) clearTimeout(timer)
  // 防抖：素材列表每敲一个字都往后端写一次，打字会卡，还会把撤销栈打散
  timer = setTimeout(() => void saveBody(), 450)
}

async function saveBody() {
  timer = null
  const next = body.value
  if (images.materialPromptBody(props.asset) === next) return
  try {
    await registry.updateAsset(props.asset.id, { prompt: next })
    emit('changed')
  } catch (e) {
    message.error((e as Error).message || '保存提示词失败')
  }
}

/* ---------------------------- AI 写提示词 ---------------------------- */

const brief = ref(props.asset.promptBrief ?? '')
const writing = ref(false)

async function aiWrite() {
  if (writing.value) return
  writing.value = true
  try {
    const text = await images.suggestAssetPrompt({
      beatId: props.beat.id,
      brief: brief.value,
      refAssetIds: [...picked.value],
      asReference: isRef.value
    })
    body.value = text
    await registry.updateAsset(props.asset.id, {
      prompt: text,
      promptBrief: brief.value.trim()
    })
    message.success('提示词已生成，可以再手改')
    emit('changed')
  } catch (e) {
    message.error((e as Error).message || '生成提示词失败')
  } finally {
    writing.value = false
  }
}

/** 把系统模板填进正文：不想从零写的人拿它当草稿起点 */
async function insertTemplate() {
  const t = images.keyframePrompt(props.beat.id, isRef.value ? 'head' : placementOf(props.asset))
  body.value = t
  await saveBody()
}

/* ------------------------------ 参考图 ------------------------------ */

/**
 * 这一段能用哪些图当参考：场景总图 → 出场主体 → 场景空镜（顺序来自
 * refCandidatesFor，和出图弹窗里那份完全一致）。
 */
const candidates = computed(() =>
  images.refCandidatesFor(props.beat.id).map((c) => ({
    id: c.key,
    label: c.label,
    kind: c.kind,
    pictureN: registry.assets.find((a) => a.id === c.key)?.pictureN ?? 0
  }))
)

const picked = computed(() => new Set(props.asset.refAssetIds ?? []))

async function toggleRef(id: ID) {
  const next = new Set(picked.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  try {
    await registry.updateAsset(props.asset.id, { refAssetIds: [...next] })
    emit('changed')
  } catch (e) {
    message.error((e as Error).message || '保存参考图失败')
  }
}

/** 正文里真正会出现的引用段（只读预览） */
const refs = computed(() => images.materialRefs(props.asset))
const refPreview = computed(() => referenceSection(refs.value, isRef.value))
/** 勾了但没 Picture 编号的：不会进参考槽，只以名字 + 外观出现 */
const uncharted = computed(() => images.materialUnnumberedRefs(props.asset))

/* ------------------------------- 模式 ------------------------------- */

const isRef = computed(() => actAsOf(props.asset) === 'reference')
const modeBusy = ref(false)

async function setMode(v: AssetActAs) {
  if (isRef.value === (v === 'reference') || modeBusy.value) return
  modeBusy.value = true
  try {
    await registry.setBeatAssetActAs(props.asset.id, v)
    emit('changed')
  } catch (e) {
    message.error((e as Error).message || '切换方式失败')
  } finally {
    modeBusy.value = false
  }
}

/* ------------------------------- 删除 ------------------------------- */

async function drop() {
  try {
    await registry.removeAsset(props.asset.id)
    message.success('已删除这条素材')
    emit('changed')
  } catch (e) {
    message.error((e as Error).message || '删除失败')
  }
}

/**
 * 出图前先把正文落库。
 *
 * 正文是防抖保存的（450ms），"改完马上点出图"时 timer 还没到 —— 直接 emit
 * 会让弹窗拿到**上一句**提示词，出的图和屏幕上写的不是一回事。这里 flush
 * 一次，并把最新正文一起递出去（父级不必等 store 回流）。
 */
async function genNow() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const next = body.value
  if (images.materialPromptBody(props.asset) !== next) {
    try {
      await registry.updateAsset(props.asset.id, { prompt: next })
      emit('changed')
    } catch (e) {
      message.error((e as Error).message || '保存提示词失败')
      return
    }
  }
  emit('gen', { ...props.asset, prompt: next })
}

const title = computed(() => {
  if (props.asset.draft) return '待出图'
  return props.asset.pictureN > 0 ? `P${props.asset.pictureN}` : PLACEMENT_LABEL[placementOf(props.asset)]
})
</script>

<template>
  <div class="mpx">
    <div class="mpx-row mpx-row-top">
      <span class="mpx-tag">{{ title }}</span>
      <div class="mpx-modes">
        <button
          type="button"
          class="mpx-mode"
          :class="{ on: !isRef }"
          :disabled="modeBusy"
          title="当关键帧：落在段内某一帧，能当段首 / 段尾画面"
          @click="setMode('keyframe')"
        >
          关键帧
        </button>
        <button
          type="button"
          class="mpx-mode"
          :class="{ on: isRef }"
          :disabled="modeBusy"
          title="当参考图：不占帧位，占一个 <Picture N> 槽跟着本段进参考图通道"
          @click="setMode('reference')"
        >
          参考图
        </button>
      </div>
      <span v-if="isRef" class="mpx-note">参考方式：提示词会自动带上 &lt;Picture N&gt; 与外观</span>
    </div>

    <n-input
      type="textarea"
      size="small"
      :rows="3"
      :value="body"
      placeholder="这一镜画什么？直接写提示词，或下面给一句要求让 AI 写"
      @update:value="onBodyInput"
    />

    <div class="mpx-row">
      <n-input
        size="tiny"
        class="mpx-brief"
        :value="brief"
        placeholder="一句要求，例如：雨夜巷口，他回头看一眼"
        @update:value="(v: string) => (brief = v)"
      />
      <n-button size="tiny" type="primary" ghost :loading="writing" @click="aiWrite">
        AI 写提示词
      </n-button>
      <button type="button" class="mpx-link" title="把系统模板填进上面的框" @click="insertTemplate">
        插模板
      </button>
    </div>

    <div v-if="candidates.length" class="mpx-refs">
      <span class="mpx-refs-lb">参考图</span>
      <button
        v-for="c in candidates"
        :key="c.id"
        type="button"
        class="mpx-ref"
        :class="{ on: picked.has(c.id), bare: c.pictureN <= 0 }"
        :title="
          c.pictureN > 0
            ? `照着 P${c.pictureN}「${c.label}」画（会写进提示词引用段）`
            : `「${c.label}」没有 Picture 编号，只会以名字 + 外观出现`
        "
        @click="toggleRef(c.id)"
      >
        <span v-if="c.pictureN > 0" class="mono">P{{ c.pictureN }}</span>
        {{ c.label }}
      </button>
    </div>

    <div v-if="refPreview" class="mpx-preview">
      <div class="mpx-preview-h">
        提示词末尾会自动带上这段
        <span v-if="!isRef" class="muted">（关键帧方式不写 &lt;Picture N&gt;，只写名字与外观）</span>
      </div>
      <pre class="mpx-preview-body">{{ refPreview }}</pre>
      <div v-if="uncharted.length" class="mpx-warn">
        {{ uncharted.map((r) => r.name).join('、') }} 没有 Picture 编号，不会进参考槽
      </div>
    </div>

    <div class="mpx-row mpx-acts">
      <n-button size="tiny" type="primary" @click="genNow">
        {{ hasImage ? '按这句重出' : '按这句出图' }}
      </n-button>
      <span class="mpx-hint">出图后这条素材会替换成新图，提示词保留</span>
      <n-button size="tiny" quaternary type="error" @click="drop">删</n-button>
    </div>
  </div>
</template>

<style scoped>
.mpx {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.mpx-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-wrap: wrap;
}
.mpx-row-top {
  gap: 8px;
}
.mpx-tag {
  font-size: 10px;
  line-height: 1.6;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--accent-soft, var(--accent-soft));
  color: var(--accent);
  flex: none;
}
.mpx-modes {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 999px;
  overflow: hidden;
  flex: none;
}
.mpx-mode {
  border: none;
  background: var(--panel, #fff);
  color: var(--muted);
  font-size: 10.5px;
  line-height: 1.7;
  padding: 1px 8px;
  cursor: pointer;
}
.mpx-mode.on {
  background: var(--accent);
  color: #fff;
}
.mpx-mode:disabled {
  cursor: progress;
}
.mpx-note {
  font-size: 10px;
  color: var(--muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mpx-brief {
  flex: 1;
  min-width: 140px;
}
.mpx-link {
  border: none;
  background: none;
  padding: 0;
  font-size: 10.5px;
  color: var(--accent);
  cursor: pointer;
  flex: none;
}
.mpx-link:hover {
  text-decoration: underline;
}
.mpx-refs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.mpx-refs-lb {
  font-size: 10.5px;
  color: var(--muted);
  flex: none;
}
.mpx-ref {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10.5px;
  line-height: 1.7;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--panel, #fff);
  color: var(--muted);
  cursor: pointer;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mpx-ref.on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft, var(--accent-soft));
}
/* 没有 Picture 编号的候选：虚线圈起来，点也能点，但先把预期说清 */
.mpx-ref.bare {
  border-style: dashed;
}
.mpx-preview {
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 4px 6px;
  background: var(--panel-2, var(--panel-2));
}
.mpx-preview-h {
  font-size: 10px;
  color: var(--muted);
  margin-bottom: 2px;
}
.mpx-preview-body {
  margin: 0;
  font-family: inherit;
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 84px;
  overflow: auto;
}
.mpx-warn {
  margin-top: 2px;
  font-size: 10px;
  color: var(--warn-ink);
}
.mpx-acts {
  gap: 8px;
}
.mpx-hint {
  font-size: 10px;
  color: var(--muted);
  flex: 1;
  min-width: 0;
}
</style>
