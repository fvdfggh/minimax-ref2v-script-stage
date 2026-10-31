<script setup lang="ts">
/**
 * 素材预览弹窗。
 *
 * 以前点缩略图是 `window.open(url, '_blank')`：预览完要关掉那个标签、回到列表
 * 还得重新找到刚才那一段。连续核对十几段就是十几个浏览器标签，越看越乱。
 * 现在统一弹在这里，Esc / 点遮罩就回到原来的位置，列表滚动位置也不丢。
 *
 * 图片 / 音频 / 视频共用一层：只看，不改。帧位之类的说明由调用方算好传进来
 * （只有它手上才有那一拍的帧数）。
 */
import { computed, ref } from 'vue'
import { NButton, NModal, useMessage } from 'naive-ui'
import { mediaKindOf } from '@/domain/references'
import type { Asset, MediaKind } from '@/domain/types'
import { useRegistryStore } from '@/stores/registry'

const props = withDefaults(
  defineProps<{
    show: boolean
    asset: Asset | null
    /** 帧位 / 归属等附加说明，由调用方算 */
    hint?: string
    /**
     * 这张图出图时实际发出去的提示词（资产上的 genPrompt）。
     * 上传的手工图没有，留空即可 —— 别拿模板提示词顶替，
     * 那会让人以为这张图是照那句话生成的。
     */
    prompt?: string
  }>(),
  { hint: '', prompt: '' }
)

const emit = defineEmits<{ 'update:show': [boolean] }>()

const registry = useRegistryStore()
const message = useMessage()

const url = computed(() => (props.asset ? registry.assetUrl(props.asset) : null))

const kind = computed<MediaKind>(() => {
  const a = props.asset
  if (!a) return 'image'
  if (a.media) return a.media
  return mediaKindOf(a.fileName, a.blob?.type)
})

const KIND_LABEL: Record<MediaKind, string> = { image: '图片', audio: '音频', video: '视频' }
const kindLabel = computed(() => KIND_LABEL[kind.value])
const name = computed(() => props.asset?.label || props.asset?.originalName || '（未命名素材）')

/** 图片尺寸：占位只在 load 之后才有，换素材时要清掉 */
const dim = ref<{ w: number; h: number } | null>(null)

function onImageLoad(ev: Event) {
  const img = ev.target as HTMLImageElement
  if (img.naturalWidth) dim.value = { w: img.naturalWidth, h: img.naturalHeight }
}

function prettyBytes(n?: number): string {
  const v = Number(n) || 0
  if (!v) return ''
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`
  return `${(v / 1024 / 1024).toFixed(1)} MB`
}

const meta = computed(() => {
  const a = props.asset
  if (!a) return ''
  const bits: string[] = []
  const size = prettyBytes(a.bytes)
  if (size) bits.push(size)
  if (kind.value === 'image' && dim.value) bits.push(`${dim.value.w} × ${dim.value.h}`)
  if (a.originalName && a.originalName !== name.value) bits.push(a.originalName)
  return bits.join(' · ')
})

/** 浏览器解不了的容器（mts / 某些 mov）给一条退路，别让人以为素材坏了 */
function openExternal() {
  if (url.value) window.open(url.value, '_blank')
}

/**
 * 提示词常是几百字：弹窗里先裁 4 行，要看全再点「展开」。
 * 这张图画成什么样，答案全在这句里 —— 旧图对不上文本时，
 * 第一步就是把它和现在的文本比一比。
 */
const promptOpen = ref(false)

async function copyPrompt() {
  const text = (props.prompt ?? '').trim()
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    message.success('已复制提示词')
  } catch {
    message.error('复制失败，请手动选中文本复制')
  }
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :bordered="false"
    :style="{ width: 'min(92vw, 960px)' }"
    class="asset-preview"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <template #header>
      <div class="pv-head">
        <span class="pv-kind" :class="`is-${kind}`">{{ kindLabel }}</span>
        <span class="pv-name" :title="name">{{ name }}</span>
        <span v-if="props.hint" class="pv-hint">{{ props.hint }}</span>
      </div>
    </template>

    <div v-if="!props.asset" class="empty">没有素材</div>

    <div v-else-if="!url" class="empty">素材本体还没就绪（可能还在上传 / 同步）</div>

    <div v-else-if="kind === 'image'" class="pv-stage is-image">
      <img :src="url" :alt="name" @load="onImageLoad" />
    </div>

    <div v-else-if="kind === 'video'" class="pv-stage is-video">
      <video :src="url" controls playsinline preload="metadata" />
    </div>

    <div v-else class="pv-stage is-audio">
      <div class="pv-audio">
        <span class="pv-audio-icon">音</span>
        <span class="pv-audio-name" :title="name">{{ name }}</span>
        <audio :src="url" controls preload="metadata" />
      </div>
      <div v-if="props.hint" class="pv-audio-hint">{{ props.hint }}</div>
    </div>

    <!-- 这张图是用什么提示词出的：素材本身的溯源，比"模板"更能解释现在的画面 -->
    <div v-if="props.asset && kind === 'image' && props.prompt" class="pv-prompt">
      <div class="pv-prompt-head">
        <span class="pv-prompt-label">出图提示词</span>
        <span class="pv-prompt-len mono">{{ props.prompt.length }} 字</span>
        <button type="button" class="pv-prompt-act" @click="promptOpen = !promptOpen">
          {{ promptOpen ? '收起' : '展开全文' }}
        </button>
        <button type="button" class="pv-prompt-act" @click="copyPrompt">复制</button>
      </div>
      <p class="pv-prompt-body" :class="{ 'is-clamp': !promptOpen }">{{ props.prompt }}</p>
    </div>

    <template #footer>
      <div class="pv-foot">
        <span class="muted pv-meta">{{ meta }}</span>
        <div class="row" style="gap: 8px">
          <n-button size="small" quaternary @click="openExternal">在新标签打开</n-button>
          <n-button size="small" type="primary" @click="emit('update:show', false)">关闭</n-button>
        </div>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.pv-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.pv-kind {
  flex: none;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--panel-3);
  color: var(--text-2);
  font-size: 11px;
  line-height: 18px;
  font-weight: 500;
}
.pv-kind.is-audio {
  background: var(--ok-line);
  color: var(--ok-ink);
}
.pv-kind.is-video {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.pv-name {
  font-size: 13.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pv-hint {
  flex: none;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--panel-3);
  color: var(--label);
  font-size: 11px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}

/* 查看区：图片按 contain 铺满，不裁切；底色深一点，浅色素材也能看清边界 */
.pv-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 220px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--text);
}
.pv-stage.is-image img {
  display: block;
  max-width: 100%;
  max-height: 68vh;
  object-fit: contain;
}
.pv-stage.is-video video {
  display: block;
  width: 100%;
  max-height: 68vh;
  background: #000;
}
.pv-stage.is-audio {
  flex-direction: column;
  gap: 10px;
  min-height: 150px;
  padding: 22px 24px;
  background: var(--panel-2);
  border: 1px solid var(--line);
}
.pv-audio {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  max-width: 460px;
}
.pv-audio-icon {
  flex: none;
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--ok-line);
  color: var(--ok-ink);
  font-size: 13px;
  font-weight: 600;
}
.pv-audio-name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pv-audio audio {
  flex: none;
  width: 260px;
  height: 32px;
}
.pv-audio-hint {
  font-size: 11.5px;
  color: var(--muted);
}

.pv-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.pv-meta {
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 出图提示词：单独一块浅底，和图区分开 —— 它是"解释"，不是素材本身 */
.pv-prompt {
  margin-top: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px 10px 9px;
  background: var(--panel-2, var(--panel-2));
}
.pv-prompt-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 5px;
}
.pv-prompt-label {
  font-size: 11px;
  color: var(--muted);
  padding-left: 5px;
  border-left: 2px solid var(--accent);
}
.pv-prompt-len {
  flex: 1;
  font-size: 10.5px;
  color: var(--muted);
}
.pv-prompt-act {
  border: none;
  background: none;
  padding: 0;
  font-size: 11px;
  color: var(--accent);
  cursor: pointer;
}
.pv-prompt-act:hover {
  text-decoration: underline;
}
.pv-prompt-body {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
.pv-prompt-body.is-clamp {
  max-height: 76px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(180deg, #000 62%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 62%, transparent 100%);
}
</style>
