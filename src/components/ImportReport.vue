<script setup lang="ts">
import { computed } from 'vue'
import { NAlert, NButton } from 'naive-ui'
import type { ImportResult } from '@/core/backend'
import { importIsClean, importSummary, missingPacksOf, packLabel } from '@/domain/importReport'

const props = defineProps<{ result: ImportResult; showReload?: boolean }>()
const emit = defineEmits<{ (e: 'reload'): void }>()

const missing = computed(() => missingPacksOf(props.result))
const clean = computed(() => importIsClean(props.result))
</script>

<template>
  <n-alert :type="clean ? 'success' : 'warning'" :bordered="false">
    <div class="ir">
      <p class="ir-l">已导入 {{ importSummary(result) }}。</p>
      <p v-if="result.voicePacks?.restored.length" class="ir-l">
        音色包：写入 {{ result.voicePacks.restored.length }} 个（{{ result.voicePacks.dir }}）
      </p>
      <p v-if="result.voicePacks?.kept.length" class="ir-l">
        音色包：{{ result.voicePacks.kept.length }} 个本机已有，跳过（不覆盖）
      </p>
      <p v-if="result.voicePacks?.conflict.length" class="ir-l">
        音色包：{{ result.voicePacks.conflict.length }} 个同名但内容不同，已保留本机版本
      </p>
      <p v-if="missing.length" class="ir-l">
        缺 {{ missing.length }} 个音色包（导出时原机器上就已经没有）：
        {{ missing.map((m) => packLabel(m)).join('、') }}。这些角色可以改描述，
        但要重新「设计 → 固定」才能合成台词。
      </p>
      <div v-if="!clean && showReload !== false" class="ir-act">
        <n-button size="tiny" type="primary" @click="emit('reload')">刷新页面查看</n-button>
      </div>
    </div>
  </n-alert>
</template>

<style scoped>
.ir {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--fs-base);
  line-height: 1.75;
  color: var(--text-2);
}
.ir-l {
  margin: 0;
}
.ir-act {
  margin-top: 8px;
}
</style>
