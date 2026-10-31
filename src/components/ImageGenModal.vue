<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NAlert, NButton, NInput, NInputNumber, NModal, NSelect, useMessage } from 'naive-ui'
import { useImageStore, type RefCandidate } from '@/stores/images'
import { DEFAULT_SIZE, normalizeSize, sizeOptions } from '@/domain/imageSize'
import { refClause } from '@/domain/references'
import type { ComfyRef } from '@/core/comfyImage'
import type { ID } from '@/domain/types'
import InfoTip from '@/components/common/InfoTip.vue'

const props = defineProps<{
  show: boolean
  title: string
  /** 初始提示词（每次打开会重置为它） */
  defaultPrompt: string
  /** 图生图时传入现有图 url：用于预览，也会作为 edits 的原图 */
  baseImageUrl?: string | null
  defaultSize?: string
  /** 这一段能用哪些图当参考（出场主体的参考图 / 场景图）。空 = 不显示这一栏 */
  refs?: RefCandidate[]
  /**
   * 默认勾哪些（素材 id）。不传就按老规矩：主体图全勾、场景图不勾。
   * 「按场景总图编辑」要传总图自己 —— 它不是 subject，按老规矩会被漏掉。
   */
  defaultPicked?: ID[]
}>()

const emit = defineEmits<{
  'update:show': [boolean]
  /** 第二参数是**真正发出的那句提示词**：关键帧要拿它做溯源（用户可能改过） */
  done: [blob: Blob, prompt: string, refs: ID[]]
}>()

const images = useImageStore()
const message = useMessage()

const prompt = ref('')
const size = ref(DEFAULT_SIZE)
const preview = ref<string | null>(null)
const blob = ref<Blob | null>(null)
/** 真正发出去的那句（含参考图点名）：关键帧溯源要用它，不是你框里看到的那句 */
const sentPrompt = ref('')
/** 勾上的参考图（素材 id）：顺序沿用候选顺序，image_1 就是第一个进提示词的 */
const pickedRefs = ref<Set<ID>>(new Set())

/**
 * 比例档位：像素量级统一锁在 720p（1280×720 = 92 万），换比例不换量级。
 * 想自己填就往下拉输入 `1600x900` 这种 —— 会被对齐到 16 的倍数，
 * 再按同比例拉回 720p 量级（1920×1080 会变成 1280×720）。
 */
const sizeChoices = sizeOptions()

function setSize(v: string) {
  const fixed = normalizeSize(v)
  size.value = fixed.size
  if (fixed.note) message.info(fixed.note, { duration: 4000 })
}

const channelOptions = [
  { label: '云端 API', value: 'http' },
  { label: '本地 ComfyUI 工作流', value: 'comfy' }
]

const workflowOptions = computed(() =>
  images.workflows.map((w) => ({
    label: `${w.t2i ? '✓ ' : ''}${w.name}${w.edit ? ' · 可参考图' : ''}${w.format === 'broken' ? '（文件读不动）' : ''}`,
    value: w.name,
    disabled: w.format === 'broken'
  }))
)

/** 选中的这份工作流到底能不能出图，先说清楚再让人点生成 */
const workflowHint = computed(() => {
  const w = images.workflows.find((x) => x.name === images.comfy.workflow)
  if (!w) return ''
  const bits: string[] = []
  bits.push(w.format === 'ui' ? 'UI 格式，提交前会自动转成 API 格式' : 'API 格式，直接提交')
  if (w.t2i === false) bits.push('没看到采样器或空 latent，可能不是文生图工作流')
  if (w.checkpoints?.length) bits.push(`模型：${w.checkpoints.slice(0, 2).join(' / ')}`)
  if (w.edit) bits.push(`能吃 ${w.refs} 张参考图`)
  return bits.join(' · ')
})

/** 能不能在本地通道挂参考图：工作流得吃图，否则这一栏摆出来只会误导 */
const refUsable = computed(() => images.usingComfy && images.refSupport > 0 && (props.refs?.length ?? 0) > 0)

/** 勾上的参考图，按候选顺序排（image_1 的顺序会影响模型怎么理解） */
const pickedList = computed(() =>
  (props.refs ?? []).filter((c) => pickedRefs.value.has(c.key))
)
const activeRefs = computed<ComfyRef[]>(() => pickedList.value.map((c) => c.ref))

const channelTip = computed(() =>
  images.usingComfy
    ? props.baseImageUrl
      ? '本地工作流：左边原图只作对照，不参与重绘。想按图上的人改，勾下面的主体参考图。提示词 / 尺寸 / 种子会注入工作流，其余节点原样不动。'
      : '提示词 / 尺寸 / 种子会被注入到工作流的文本编码器、空 latent 与采样器；勾了参考图就按图编辑，不勾就是纯文生图。需要 ComfyUI 正在运行。'
    : props.baseImageUrl
      ? '图生图：基于现有图片 + 下方提示词重绘（会走 /images/edits）'
      : '文生图：根据下方提示词从零生成（会走 /images/generations）'
)

/** 「重新合成」时底图只是对照：本地通道不叫"编辑"，别写错按钮 */
const genLabel = computed(() =>
  props.baseImageUrl ? (images.usingComfy ? '重新生成' : '重新生成 / 编辑') : '生成'
)

function toggleRef(key: ID) {
  const set = new Set(pickedRefs.value)
  if (set.has(key)) set.delete(key)
  else set.add(key)
  pickedRefs.value = set
}

function releasePreview() {
  if (preview.value) {
    URL.revokeObjectURL(preview.value)
    preview.value = null
  }
  blob.value = null
}

/**
 * 这个弹窗在调用方是 `v-if` + `show=true` 挂载的（不是常驻再切 show），
 * 所以必须 immediate：否则第一次打开时 show 从没"变"过，watcher 不触发，
 * 提示词空着、通道也停在默认值 —— 看起来像"生成按钮点了没反应"。
 */
watch(
  () => props.show,
  async (v) => {
    if (v) {
      prompt.value = props.defaultPrompt
      // 调用方可能还传着老尺寸（1024x576 之类），统一在这里收口成 720p 量级
      size.value = normalizeSize(props.defaultSize ?? DEFAULT_SIZE).size
      // 默认把出场主体的图都勾上：这一段有谁，就该照着谁画。
      // 按场景总图编辑时由调用方指定 —— 总图不是 subject，用老规矩会被漏掉。
      pickedRefs.value = new Set(
        props.defaultPicked ??
          (props.refs ?? []).filter((c) => c.kind === 'subject').map((c) => c.key)
      )
      sentPrompt.value = ''
      releasePreview()
      // 先读回上次选的通道，不然 ComfyUI 用户每次进来都看到"云端 API"
      await images.loadComfy()
      // 参考图栏能不能出现，取决于"当前工作流吃几张图"；不 await 的话，
      // 第一次打开会先按 0 张算，栏位晚一拍才冒出来（还会把勾选状态冲掉）
      if (images.usingComfy && !images.workflows.length && !images.workflowsBusy) {
        await images.refreshWorkflows()
      }
    } else {
      releasePreview()
    }
  },
  { immediate: true }
)

async function switchChannel(v: 'http' | 'comfy') {
  await images.patchComfy({ channel: v })
  if (v === 'comfy' && !images.workflows.length && !images.workflowsBusy) {
    void images.refreshWorkflows()
  }
}

async function gen() {
  if (!prompt.value.trim()) {
    message.warning('先写点提示词')
    return
  }
  try {
    // 勾了参考图就把"哪张图是谁"拼进提示词：模型靠 <image1> 这些占位认人
    const useRefs = refUsable.value ? pickedList.value : []
    const sent = [prompt.value.trim(), refClause(useRefs)].filter(Boolean).join(' ')
    const result = await images.generate({
      prompt: sent,
      size: size.value,
      baseImage: props.baseImageUrl || undefined,
      refs: useRefs.length ? useRefs.map((c) => c.ref) : undefined
    })
    sentPrompt.value = sent
    releasePreview()
    blob.value = result
    preview.value = URL.createObjectURL(result)
    if (images.usingComfy && images.lastRun) {
      const used = useRefs.length ? ` · 参考图 ${useRefs.length} 张` : ''
      message.success(`本地出图完成：${images.lastRun.seconds}s${used}`)
    }
  } catch (e) {
    message.error((e as Error).message || '生成失败', { duration: 8000 })
  }
}

function close() {
  emit('update:show', false)
}

function confirm() {
  if (!blob.value) return
  // 用 sentPrompt：那张图上真的写进去的是带 <imageN> 点名的长句，不是框里你看的这句。
  // 第三个参数是**最终勾上的参考图**：调用方要把它们存回素材，下次重出用同一批。
  emit('done', blob.value, sentPrompt.value || prompt.value.trim(), pickedList.value.map((c) => c.key))
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="title"
    style="max-width: 620px"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div class="igm-channel">
      <span class="igm-channel-lb">出图通道</span>
      <n-select
        :value="images.comfy.channel"
        :options="channelOptions"
        size="small"
        style="width: 210px"
        @update:value="(v: 'http' | 'comfy') => switchChannel(v)"
      />
      <span class="muted igm-tip">{{ channelTip }}</span>
    </div>

    <template v-if="images.usingComfy">
      <div class="igm-comfy">
        <div class="igm-row">
          <span class="igm-lb">ComfyUI</span>
          <n-input
            :value="images.comfy.base"
            size="small"
            placeholder="http://127.0.0.1:8188"
            style="flex: 1"
            @update:value="(v: string) => images.patchComfy({ base: v })"
          />
          <n-button size="small" :loading="images.workflowsBusy" @click="images.refreshWorkflows(true)">
            刷新工作流
          </n-button>
        </div>
        <div class="igm-row">
          <span class="igm-lb">工作流</span>
          <n-select
            :value="images.comfy.workflow"
            :options="workflowOptions"
            :placeholder="images.workflows.length ? '选一份工作流' : '先点「刷新工作流」'"
            size="small"
            filterable
            style="flex: 1"
            @update:value="(v: string) => images.patchComfy({ workflow: v })"
          />
        </div>
        <div v-if="workflowHint" class="igm-hint muted">{{ workflowHint }}</div>
        <div class="igm-row">
          <span class="igm-lb">步数</span>
          <n-input-number
            :value="images.comfy.steps ?? undefined"
            :min="1"
            :max="60"
            size="small"
            placeholder="跟随工作流"
            style="width: 130px"
            @update:value="(v: number | null) => images.patchComfy({ steps: v ?? null })"
          />
          <span class="igm-lb" style="margin-left: 10px">负向</span>
          <n-input
            :value="images.comfy.negative"
            size="small"
            placeholder="可留空（沿用工作流自己的负向）"
            style="flex: 1"
            @update:value="(v: string) => images.patchComfy({ negative: v })"
          />
        </div>
        <n-alert v-if="images.workflowsError" type="warning" :bordered="false" style="margin-top: 8px">
          {{ images.workflowsError }}
        </n-alert>
        <div v-else-if="images.lastRun" class="igm-hint muted">
          上次：{{ images.lastRun.workflow }} · {{ images.lastRun.seconds }}s ·
          prompt {{ images.lastRun.promptId.slice(0, 8) }}
          <template v-if="images.lastRun.notes.length">· {{ images.lastRun.notes.join('；') }}</template>
        </div>
      </div>
    </template>

    <div class="igm-preview">
      <div>
        <div class="muted" style="font-size: 12px; margin-bottom: 4px">原图</div>
        <div class="igm-ph">
          <img v-if="baseImageUrl" :src="baseImageUrl" />
          <span v-else class="muted" style="font-size: 12px">无（全新生成）</span>
        </div>
      </div>
      <div>
        <div class="muted" style="font-size: 12px; margin-bottom: 4px">结果</div>
        <div class="igm-ph">
          <img v-if="preview" :src="preview" />
          <span v-else class="muted" style="font-size: 12px">待生成</span>
        </div>
      </div>
    </div>

    <div>
      <div class="muted" style="margin-bottom: 4px">提示词</div>
      <n-input v-model:value="prompt" type="textarea" :rows="4" placeholder="描述要生成 / 重绘的画面" />
    </div>

    <div style="margin-top: 10px">
      <div class="muted" style="margin-bottom: 4px">尺寸</div>
      <n-select
        :value="size"
        :options="sizeChoices"
        filterable
        tag
        size="small"
        style="width: 300px"
        placeholder="选比例，或直接填 1280x720"
        @update:value="(v: string) => setSize(v)"
      />
    </div>

    <!-- 参考图：勾上就是「照着这个人画」，不勾就是纯文生图 -->
    <div v-if="refUsable" class="igm-refs">
      <div class="igm-refs-head">
        <span class="muted" style="font-size: 12px">参考图</span>
        <span class="muted igm-refs-tip">
          勾上的图会被当成这一段的「长什么样」：<b>image_1 是第一个勾的</b>，顺序影响模型怎么理解
        </span>
      </div>
      <div class="igm-refs-row">
        <button
          v-for="c in refs"
          :key="c.key"
          type="button"
          class="igm-ref"
          :class="{ 'is-on': pickedRefs.has(c.key) }"
          :data-kind="c.kind"
          :title="c.kind === 'scene' ? '场景图：只给氛围，别默认勾' : `主体参考图：${c.label}`"
          @click="toggleRef(c.key)"
        >
          <img v-if="c.url" :src="c.url" alt="" />
          <span v-else class="igm-ref-ph">无图</span>
          <span class="igm-ref-lb">{{ c.label }}</span>
        </button>
        <span v-if="!refs?.length" class="muted" style="font-size: 12px">
          这一段的主体还没有参考图
          <InfoTip size="sm" :width="300" text="先去「主体登记」里传一张，出来的人才能跨帧保持一致。" />
        </span>
      </div>
      <div v-if="refs?.length" class="muted igm-refs-note">
        已勾 {{ activeRefs.length }} 张<template v-if="!activeRefs.length">（都不勾 = 不参考，纯文生图）</template>
      </div>
    </div>
    <div v-else-if="images.usingComfy && (refs?.length ?? 0) > 0" class="igm-refs-note muted">
      这份工作流的编码器不吃参考图
      <InfoTip
        size="sm"
        :width="300"
        text="想按主体图编辑，换一份支持参考图的工作流（下拉里带「可参考图」的那份）。"
      />
    </div>

    <n-alert v-if="images.lastError" type="error" :bordered="false" style="margin-top: 12px">
      {{ images.lastError }}
    </n-alert>

    <template #footer>
      <div class="row" style="justify-content: space-between">
        <n-button :loading="images.busy" @click="gen">
          {{ genLabel }}
        </n-button>
        <div class="row" style="gap: 8px">
          <n-button @click="close">取消</n-button>
          <n-button type="primary" :disabled="!blob" @click="confirm">确认使用</n-button>
        </div>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.igm-channel {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.igm-channel-lb {
  font-size: 12px;
  color: var(--muted, var(--muted));
}
.igm-tip {
  font-size: 12px;
  line-height: 1.4;
  flex: 1 1 240px;
}
.igm-comfy {
  border: 1px solid var(--line, var(--line-strong));
  border-radius: 8px;
  padding: 9px 10px;
  margin-bottom: 12px;
  background: var(--panel-2, var(--panel-2));
}
.igm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.igm-row:last-child {
  margin-bottom: 0;
}
.igm-lb {
  font-size: 12px;
  color: var(--muted, var(--muted));
  width: 52px;
  flex: 0 0 auto;
}
.igm-hint {
  font-size: 11.5px;
  line-height: 1.4;
  margin: 2px 0 6px 60px;
}
.igm-preview {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}
.igm-ph {
  width: 128px;
  height: 128px;
  border-radius: 8px;
  background: var(--panel-3);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.igm-ph img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.igm-refs {
  margin-top: 10px;
}
.igm-refs-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.igm-refs-tip {
  font-size: 11.5px;
}
.igm-refs-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.igm-ref {
  width: 74px;
  padding: 0;
  border: 1px solid var(--line, var(--line-strong));
  border-radius: 8px;
  background: #fff;
  overflow: hidden;
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 0.12s, border-color 0.12s, box-shadow 0.12s;
}
.igm-ref:hover {
  opacity: 0.85;
}
.igm-ref.is-on {
  opacity: 1;
  border-color: var(--accent, var(--accent));
  box-shadow: 0 0 0 1px var(--accent, var(--accent)) inset;
}
.igm-ref img,
.igm-ref-ph {
  display: block;
  width: 100%;
  height: 62px;
  object-fit: cover;
  background: var(--panel-3);
}
.igm-ref-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--muted, var(--muted));
}
.igm-ref-lb {
  display: block;
  font-size: 11px;
  line-height: 1.5;
  padding: 1px 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.igm-refs-note {
  font-size: 11.5px;
  margin-top: 5px;
}
</style>
