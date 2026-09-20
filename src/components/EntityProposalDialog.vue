<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NAlert, NButton, NCheckbox, NInput, NModal, NSelect, NTag, useMessage } from 'naive-ui'
import type { EntityKind, EntityType } from '@/domain/types'
import type { EntityProposal } from '@/stores/pipeline'
import { ENTITY_TYPE_LABEL } from '@/domain/registry'

const props = defineProps<{
  show: boolean
  proposals: EntityProposal[]
}>()

const emit = defineEmits<{
  'update:show': [boolean]
  confirm: [accepted: EntityProposal[]]
}>()

const message = useMessage()
const draft = ref<EntityProposal[]>([])

watch(
  () => props.show,
  (v) => {
    if (v) draft.value = props.proposals.map((p) => ({ ...p }))
  }
)

const typeOptions = (Object.keys(ENTITY_TYPE_LABEL) as EntityType[]).map((t) => ({
  label: ENTITY_TYPE_LABEL[t],
  value: t
}))

const createCount = computed(() => draft.value.filter((d) => d.accepted && !d.exists).length)
const speakingMissingVoice = computed(() =>
  draft.value.filter(
    (d) => d.accepted && !d.exists && d.kind === 'speaking' && !(d.voiceDesc ?? '').trim()
  )
)

function toggleAll(value: boolean) {
  draft.value = draft.value.map((d) => ({ ...d, accepted: d.exists ? false : value }))
}

function confirm() {
  if (!createCount.value) {
    message.warning('没有选中任何要创建的实体')
    return
  }
  if (speakingMissingVoice.value.length) {
    message.warning(`有 ${speakingMissingVoice.value.length} 个说话角色还没写音色描述`)
    return
  }
  emit(
    'confirm',
    draft.value.filter((d) => d.accepted && !d.exists)
  )
  emit('update:show', false)
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="阶段一产出的实体"
    style="max-width: 940px"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <n-alert type="info" :bordered="false" style="margin-bottom: 12px">
      <div style="font-size: 12.5px; line-height: 1.7">
        模型在拆解时顺手把实体登记了出来，并已让每个片段绑定了对应实体。
        确认后会写入实体注册表并自动分配 <code>&lt;Subject N&gt;</code> / <code>(Sx)</code> 编号。<br />
        会说话的角色必须有固定音色描述，之后跨段逐字复用；素材图片可以稍后在注册表里补绑。
      </div>
    </n-alert>

    <div class="row-between" style="margin-bottom: 10px">
      <div class="row" style="gap: 10px">
        <span class="muted" style="font-size: 12.5px">共 {{ draft.length }} 个</span>
        <n-tag size="small" type="info" :bordered="false">
          待创建 {{ createCount }}
        </n-tag>
        <n-tag v-if="draft.some((d) => d.exists)" size="small" :bordered="false">
          已存在 {{ draft.filter((d) => d.exists).length }}
        </n-tag>
      </div>
      <div class="row" style="gap: 6px">
        <n-button size="small" quaternary @click="toggleAll(true)">全选</n-button>
        <n-button size="small" quaternary @click="toggleAll(false)">全不选</n-button>
      </div>
    </div>

    <div style="max-height: 460px; overflow: auto">
      <div
        v-for="(p, i) in draft"
        :key="p.name"
        class="panel"
        :style="{ padding: '10px 12px', marginBottom: '8px', opacity: p.exists ? 0.55 : 1 }"
      >
        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <n-checkbox
            :checked="p.accepted"
            :disabled="p.exists"
            @update:checked="(v: boolean) => (draft[i].accepted = v)"
          />
          <n-input
            size="small"
            style="width: 150px"
            :value="p.name"
            placeholder="实体名"
            :disabled="p.exists"
            @update:value="(v: string) => (draft[i].name = v)"
          />
          <n-select
            size="small"
            style="width: 100px"
            :value="p.type"
            :options="typeOptions"
            :disabled="p.exists"
            @update:value="(v: string) => (draft[i].type = v as EntityType)"
          />
          <n-select
            size="small"
            style="width: 110px"
            :value="p.kind"
            :options="[
              { label: '会说话', value: 'speaking' },
              { label: '不说话', value: 'non_speaking' }
            ]"
            :disabled="p.exists"
            @update:value="(v: string) => (draft[i].kind = v as EntityKind)"
          />
          <n-tag v-if="p.exists" size="small" :bordered="false">注册表已有</n-tag>
          <n-tag v-else-if="p.refCount" size="small" type="success" :bordered="false">
            被 {{ p.refCount }} 个片段引用
          </n-tag>
          <n-tag v-if="p.firstAppear" size="small" :bordered="false">{{ p.firstAppear }}</n-tag>
        </div>

        <div v-if="p.kind === 'speaking'" style="margin-top: 8px">
          <div class="muted" style="font-size: 12px; margin-bottom: 4px">
            音色描述（英文，全片逐字复用，不要写 (Sx)）
          </div>
          <n-input
            size="small"
            :value="p.voiceDesc ?? ''"
            :disabled="p.exists"
            :status="
              !p.exists && p.accepted && !p.voiceDesc?.trim() ? 'warning' : undefined
            "
            placeholder="speaking with a young male voice, slightly hoarse, tired but determined"
            @update:value="(v: string) => (draft[i].voiceDesc = v)"
          />
        </div>

        <div style="margin-top: 8px">
          <div class="muted" style="font-size: 12px; margin-bottom: 4px">
            外观描述（英文，无参考图时使用）
          </div>
          <n-input
            size="small"
            :value="p.textDesc ?? ''"
            :disabled="p.exists"
            placeholder="dark robe, pale skin, faint purple mist around the shoulders"
            @update:value="(v: string) => (draft[i].textDesc = v)"
          />
        </div>

        <div v-if="p.note" class="muted" style="font-size: 12px; margin-top: 6px">
          {{ p.note }}
        </div>
      </div>

      <div v-if="!draft.length" class="empty">
        <div>模型没有登记新实体，全部引用都来自已有注册表</div>
      </div>
    </div>

    <template #footer>
      <div class="row-between">
        <span class="muted" style="font-size: 12.5px">
          {{ speakingMissingVoice.length ? `${speakingMissingVoice.length} 个说话角色缺音色` : '音色已齐' }}
        </span>
        <div class="row" style="gap: 8px">
          <n-button @click="emit('update:show', false)">跳过</n-button>
          <n-button type="primary" @click="confirm">创建并绑定</n-button>
        </div>
      </div>
    </template>
  </n-modal>
</template>
