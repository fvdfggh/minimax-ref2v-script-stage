<script setup lang="ts">
import { ref, watch } from 'vue'
import { NAlert, NButton, NInput, NModal, NSelect, useMessage } from 'naive-ui'
import { useImageStore } from '@/stores/images'

const props = defineProps<{
  show: boolean
  title: string
  /** 初始提示词（每次打开会重置为它） */
  defaultPrompt: string
  /** 图生图时传入现有图 url：用于预览，也会作为 edits 的原图 */
  baseImageUrl?: string | null
  defaultSize?: string
}>()

const emit = defineEmits<{
  'update:show': [boolean]
  done: [blob: Blob]
}>()

const images = useImageStore()
const message = useMessage()

const prompt = ref('')
const size = ref('1024x1024')
const preview = ref<string | null>(null)
const blob = ref<Blob | null>(null)

const sizeOptions = [
  { label: '1024 × 1024（方图，主体）', value: '1024x1024' },
  { label: '1024 × 576（宽屏 16:9，场景）', value: '1024x576' },
  { label: '576 × 1024（竖屏）', value: '576x1024' },
  { label: '1792 × 1024（超宽）', value: '1792x1024' },
  { label: '512 × 512（小图）', value: '512x512' }
]

function releasePreview() {
  if (preview.value) {
    URL.revokeObjectURL(preview.value)
    preview.value = null
  }
  blob.value = null
}

watch(
  () => props.show,
  (v) => {
    if (v) {
      prompt.value = props.defaultPrompt
      size.value = props.defaultSize ?? '1024x1024'
      releasePreview()
    } else {
      releasePreview()
    }
  }
)

async function gen() {
  if (!prompt.value.trim()) {
    message.warning('先写点提示词')
    return
  }
  try {
    const result = await images.generate({
      prompt: prompt.value.trim(),
      size: size.value,
      baseImage: props.baseImageUrl || undefined
    })
    releasePreview()
    blob.value = result
    preview.value = URL.createObjectURL(result)
  } catch (e) {
    message.error((e as Error).message || '生成失败')
  }
}

function close() {
  emit('update:show', false)
}

function confirm() {
  if (!blob.value) return
  emit('done', blob.value)
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="title"
    style="max-width: 600px"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div class="muted" style="font-size: 12.5px; margin-bottom: 10px">
      {{
        baseImageUrl
          ? '图生图：基于现有图片 + 下方提示词重绘（会走 /images/edits）'
          : '文生图：根据下方提示词从零生成（会走 /images/generations）'
      }}
    </div>

    <div class="row" style="gap: 12px; margin-bottom: 12px">
      <div>
        <div class="muted" style="font-size: 12px; margin-bottom: 4px">原图</div>
        <div
          style="
            width: 128px;
            height: 128px;
            border-radius: 8px;
            background: #f1f3f6;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
          "
        >
          <img
            v-if="baseImageUrl"
            :src="baseImageUrl"
            style="width: 100%; height: 100%; object-fit: cover"
          />
          <span v-else class="muted" style="font-size: 12px">无（全新生成）</span>
        </div>
      </div>
      <div>
        <div class="muted" style="font-size: 12px; margin-bottom: 4px">结果</div>
        <div
          style="
            width: 128px;
            height: 128px;
            border-radius: 8px;
            background: #f1f3f6;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
          "
        >
          <img
            v-if="preview"
            :src="preview"
            style="width: 100%; height: 100%; object-fit: cover"
          />
          <span v-else class="muted" style="font-size: 12px">待生成</span>
        </div>
      </div>
    </div>

    <div>
      <div class="muted" style="margin-bottom: 4px">提示词</div>
      <n-input v-model:value="prompt" type="textarea" :rows="3" placeholder="描述要生成 / 重绘的画面" />
    </div>

    <div style="margin-top: 10px">
      <div class="muted" style="margin-bottom: 4px">尺寸</div>
      <n-select
        :value="size"
        :options="sizeOptions"
        size="small"
        style="width: 240px"
        @update:value="(v: string) => (size = v)"
      />
    </div>

    <n-alert v-if="images.lastError" type="error" :bordered="false" style="margin-top: 12px">
      {{ images.lastError }}
    </n-alert>

    <template #footer>
      <div class="row" style="justify-content: space-between">
        <n-button :loading="images.busy" @click="gen">
          {{ baseImageUrl ? '重新生成 / 编辑' : '生成' }}
        </n-button>
        <div class="row" style="gap: 8px">
          <n-button @click="close">取消</n-button>
          <n-button type="primary" :disabled="!blob" @click="confirm">确认使用</n-button>
        </div>
      </div>
    </template>
  </n-modal>
</template>
