<script setup lang="ts">
/**
 * 二采放大（MiniMaxH3LatentUpscaleModelOpt）专用面板。
 *
 * 为什么这个节点要单独写而不是用通用表单：
 *
 * 1. `mode` 是 DynamicCombo，三套子参数互斥。通用表单会把 mode 渲染成一个
 *    普通下拉，然后把 scale/width/height/megapixels 四个全平铺出来 —— 用户
 *    看到的是「四个都填了但只有一个是生效的」，必错。
 * 2. 它的参数组合决定了**二采的真实输出尺寸**，这个结果用户必须能当场看见，
 *    而不是跑完 20 分钟才发现给的是 896×512 而不是以为的 1728×960。
 * 3. `align` 会改写最终尺寸（向上取整到 32 的倍数），面板要能把这个偏移显示出来。
 */
import { computed } from 'vue'
import { NAlert, NButton, NRadioButton, NRadioGroup } from 'naive-ui'
import ParamField from './ParamField.vue'
import {
  UPSCALE_MODES,
  UPSCALE_MODE_LABELS,
  estimateUpscaleSize,
  upscaleParamSpecs
} from '@/domain/workflow'
import { useLocalStore } from '@/stores/local'
import type { ParamValue } from '@/domain/workflow'
import InfoTip from '@/components/common/InfoTip.vue'

const props = defineProps<{
  values: Record<string, ParamValue>
  baseWidth: number
  baseHeight: number
  present: boolean
}>()

const emit = defineEmits<{
  update: [param: string, value: ParamValue]
  reset: []
}>()

const local = useLocalStore()

const specs = upscaleParamSpecs()

/** 当前模式下要显示的子参数。 */
const modeChild = computed(() => {
  const mode = String(props.values.mode ?? 'megapixels')
  if (mode === 'scale by multiplier') return ['scale']
  if (mode === 'target dimensions') return ['width', 'height']
  return ['megapixels']
})

const shownParams = computed(() =>
  specs.filter((s) => {
    if (s.key === 'mode') return false
    if (['scale', 'width', 'height', 'megapixels'].includes(s.key)) {
      return modeChild.value.includes(s.key)
    }
    return true
  })
)

const estimate = computed(() =>
  estimateUpscaleSize(props.baseWidth, props.baseHeight, props.values)
)

const sameSize = computed(
  () => estimate.value.width === props.baseWidth && estimate.value.height === props.baseHeight
)

const ratio = computed(() => {
  if (!props.baseWidth || !props.baseHeight) return 0
  return (estimate.value.width * estimate.value.height) / (props.baseWidth * props.baseHeight)
})
</script>

<template>
  <div>
    <n-alert v-if="!present" type="warning" :show-icon="false" style="margin-bottom: 12px">
      模板还没导入 API 工作流，这里改的值暂时存着
      <InfoTip :width="320" text="导入包含 MiniMaxH3LatentUpscaleModelOpt 的工作流后才会真正生效。" />
    </n-alert>

    <div class="up-mode">
      <n-radio-group
        :value="String(values.mode ?? 'megapixels')"
        size="small"
        @update:value="(v: string) => emit('update', 'mode', v)"
      >
        <n-radio-button v-for="m in UPSCALE_MODES" :key="m" :value="m">
          {{ UPSCALE_MODE_LABELS[m] ?? m }}
        </n-radio-button>
      </n-radio-group>
    </div>

    <div class="up-grid">
      <ParamField
        v-for="spec in shownParams"
        :key="spec.key"
        :spec="spec"
        :value="values[spec.key] as ParamValue"
        :candidates="local.candidatesFor(spec.key)"
        @update:value="(v: ParamValue) => emit('update', spec.key, v)"
      />
    </div>

    <div class="up-estimate">
      <div class="up-est-main">
        <span class="up-est-from">{{ baseWidth }} × {{ baseHeight }}</span>
        <span class="up-est-arrow">→</span>
        <span class="up-est-to">{{ estimate.width }} × {{ estimate.height }}</span>
        <span class="up-est-mp">{{ estimate.megapixels }} MP</span>
        <span v-if="ratio > 1" class="up-est-ratio">{{ ratio.toFixed(2) }}× 像素</span>
      </div>
      <div class="up-est-note">
        <template v-if="sameSize">
          与一采同尺寸：二采只是重采样，不会带来分辨率收益。
        </template>
        <template v-else>
          已按 <code>align={{ values.align ?? 32 }}</code> 对齐；实际写入的二采画布就是这个尺寸。
        </template>
      </div>
    </div>

    <div class="row" style="justify-content: flex-end; margin-top: 10px">
      <n-button size="small" quaternary @click="emit('reset')">恢复默认</n-button>
    </div>
  </div>
</template>

<style scoped>
.up-mode {
  padding: 4px 0 12px;
}
.up-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 0 22px;
  border-top: 1px solid var(--line);
  padding-top: 8px;
}
.up-estimate {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--panel-2);
  border: 1px solid var(--line);
}
.up-est-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}
.up-est-from {
  font-family: var(--mono);
  color: var(--muted);
}
.up-est-arrow {
  color: var(--muted);
}
.up-est-to {
  font-family: var(--mono);
  font-size: 15px;
  font-weight: 500;
  color: var(--accent);
}
.up-est-mp {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--muted);
}
.up-est-ratio {
  font-size: 11.5px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
}
.up-est-note {
  margin-top: 5px;
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.5;
}
code {
  font-family: var(--mono);
  font-size: 11.5px;
  background: var(--hover);
  padding: 0 4px;
  border-radius: 4px;
}
</style>
