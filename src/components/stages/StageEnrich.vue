<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NAlert,
  NButton,
  NCard,
  NInput,
  NProgress,
  NSelect,
  NTag,
  useMessage
} from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { usePipelineStore } from '@/stores/pipeline'
import { useProviderStore } from '@/stores/provider'
import StageAdvice from '@/components/StageAdvice.vue'
import { BEAT_KIND_COLOR, BEAT_KIND_LABEL, beatIssueLabel } from '@/domain/beats'
import { beatFrames, secondsFromFrames } from '@/domain/timing'
import type { Beat, Entity, ID } from '@/domain/types'

const emit = defineEmits<{ changed: [] }>()

const project = useProjectStore()
const beats = useBeatStore()
const registry = useRegistryStore()
const pipeline = usePipelineStore()
const provider = useProviderStore()
const message = useMessage()

const expanded = ref<ID | null>(null)

const settings = computed(() => project.settings)
const list = computed(() => beats.ordered)

const enrichedCount = computed(() => list.value.filter((b) => b.enriched && b.entities.length).length)
const missingCount = computed(() => list.value.filter((b) => beatIssueLabel(b)).length)
const progress = computed(() =>
  list.value.length ? Math.round((enrichedCount.value / list.value.length) * 100) : 0
)

/* --------------------------- 分批填充 --------------------------- */

const BATCH_OPTIONS = [6, 8, 12, 16, 24, 40].map((n) => ({ label: `${n} 拍`, value: n }))

/** 本次填充会被切成几批（与 runFill 的目标选择保持一致） */
const fillBatches = computed(() => {
  const pending = list.value.filter((b) => !b.enriched || !b.entities.length).length
  const count = pending || list.value.length
  if (!count) return 0
  return Math.ceil(count / Math.max(1, settings.value.beatBatchSize))
})

async function setBatchSize(v: number) {
  await project.updateSettings({ beatBatchSize: v })
}

const entityOptions = computed(() =>
  registry.sortedEntities.map((e) => ({
    label: `${e.name}${e.subjectN != null ? `（S${e.subjectN}）` : ''}${e.kind === 'speaking' ? ' · 说话' : ''}`,
    value: e.id
  }))
)

const speakerOptions = computed(() =>
  registry.speakingEntities.map((e) => ({
    label: `${e.name}${e.sx != null ? `（S${e.sx}）` : ''}`,
    value: e.id
  }))
)

/** 场景候选只取 type = scene 的实体 */
const sceneOptions = computed(() =>
  registry.sortedEntities
    .filter((e) => e.type === 'scene')
    .map((e) => ({ label: `${e.name}${e.subjectN != null ? `（S${e.subjectN}）` : ''}`, value: e.id }))
)

function frames(beat: Beat) {
  return beatFrames(beat, settings.value)
}

function entityOf(id: ID | undefined | null): Entity | undefined {
  return id ? registry.entityById.get(id) : undefined
}

async function patch(id: ID, p: Partial<Beat>) {
  await beats.updateBeat(id, p)
  emit('changed')
}

async function runFill() {
  if (!provider.ready) {
    message.warning('请先在模型设置里配置好供应商')
    return
  }
  if (!registry.entities.length) {
    message.warning('请先在「实体与素材」里登记角色、场景等实体')
    return
  }
  const pending = list.value.filter((b) => !b.enriched || !b.entities.length)
  const targets = pending.length ? pending : list.value
  if (!targets.length) return

  try {
    const details = await pipeline.runStage2(targets, registry.entities, project.settings)
    const touched = await beats.applyDetails(project.currentId!, details, (name) => {
      const byName = registry.entities.find((e) => e.name === name)
      if (byName) return byName.id
      const fuzzy = registry.entities.find((e) => name.includes(e.name) || e.name.includes(name))
      return fuzzy?.id
    })
    emit('changed')
    message.success(`已填充 ${touched} / ${targets.length} 个片段`)
  } catch (e) {
    message.error((e as Error).message)
  }
}

async function markAllEnriched() {
  await beats.updateMany(
    list.value.filter((b) => b.entities.length).map((b) => b.id),
    { enriched: true }
  )
  message.success('已把绑定完整的片段标记为就绪')
}
</script>

<template>
  <div style="height: 100%; display: flex; flex-direction: column">
    <div class="panel-head" style="border-radius: 0">
      <div class="row" style="gap: 10px">
        <span>细节填充</span>
        <n-tag size="small" :bordered="false">{{ enrichedCount }} / {{ list.length }} 已绑定</n-tag>
        <n-tag v-if="missingCount" size="small" type="error" :bordered="false">
          {{ missingCount }} 个待补
        </n-tag>
      </div>
      <div class="row" style="gap: 8px">
        <span class="muted" style="font-size: 12.5px">每批</span>
        <n-select
          size="small"
          style="width: 92px"
          :value="settings.beatBatchSize"
          :options="BATCH_OPTIONS"
          @update:value="setBatchSize"
        />
        <span class="muted" style="font-size: 12px; white-space: nowrap">
          {{ fillBatches }} 批
        </span>
        <n-button size="small" quaternary @click="expanded = null">收起全部</n-button>
        <n-button size="small" quaternary @click="markAllEnriched">全部标记就绪</n-button>
        <n-button
          size="small"
          type="primary"
          :loading="pipeline.running"
          :disabled="!provider.ready"
          @click="runFill"
        >
          {{ pipeline.running ? pipeline.progress : '阶段二：AI 填充细节' }}
        </n-button>
      </div>
    </div>

    <div style="padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line)">
      <n-progress type="line" :percentage="progress" :height="6" :show-indicator="false" />
      <div class="muted" style="font-size: 12px; margin-top: 6px">
        模型会为每个片段补上：绑定实体、说话人、聚焦主体、场景、镜头描述、画面描述
      </div>
    </div>

    <StageAdvice
      stage="enrich"
      scope="beats"
      :presets="[
        '运镜太单一了，多换几种景别',
        '有几个片段的主体绑错了',
        '画面描述太空，补上参考图里的特征'
      ]"
      @applied="emit('changed')"
    />

    <div class="scroll-pane" style="flex: 1; padding: 16px">
      <n-alert v-if="pipeline.error" type="error" :bordered="false" style="margin-bottom: 12px">
        {{ pipeline.error }}
      </n-alert>

      <div v-if="!list.length" class="empty">
        <div>还没有片段，先回到阶段一拆解</div>
      </div>

      <div class="stack" style="gap: 8px">
        <div
          v-for="(b, i) in list"
          :key="b.id"
          class="panel"
          :style="{
            borderLeft: `3px solid ${BEAT_KIND_COLOR[b.kind]}`,
            padding: '10px 12px'
          }"
        >
          <div class="row-between" style="gap: 10px">
            <div class="row" style="gap: 8px; min-width: 0">
              <span class="muted mono" style="font-size: 11.5px">{{ i + 1 }}</span>
              <span
                class="tag-chip"
                :style="{ background: BEAT_KIND_COLOR[b.kind] + '18', color: BEAT_KIND_COLOR[b.kind] }"
              >
                {{ BEAT_KIND_LABEL[b.kind] }}
              </span>
              <span style="font-weight: 500; font-size: 13.5px">{{ b.title }}</span>
              <span v-if="b.kind === 'dialogue'" class="mono" style="color: #2f9e6f; font-size: 12.5px">
                「{{ b.dialogue }}」
              </span>
            </div>
            <div class="row" style="gap: 6px">
              <span class="muted mono" style="font-size: 11.5px">
                {{ frames(b) }}帧 / {{ secondsFromFrames(frames(b), settings.fps).toFixed(2) }}s
              </span>
              <n-button
                size="tiny"
                quaternary
                @click="expanded = expanded === b.id ? null : b.id"
              >
                {{ expanded === b.id ? '收起' : '展开' }}
              </n-button>
            </div>
          </div>

          <div class="row" style="gap: 8px; margin-top: 8px; flex-wrap: wrap">
            <n-select
              size="small"
              :value="b.sceneId ?? null"
              :options="sceneOptions"
              placeholder="场景（必填）"
              style="width: 190px"
              :status="b.sceneId ? undefined : 'warning'"
              @update:value="(v: string | null) => patch(b.id, { sceneId: v ?? undefined })"
            />
            <n-select
              size="small"
              multiple
              :value="b.entities ?? []"
              :options="entityOptions"
              placeholder="其他主体（可选）"
              style="min-width: 220px; flex: 1"
              :max-tag-count="3"
              @update:value="(v: string[] | null) => patch(b.id, { entities: v ?? [] })"
            />
            <n-select
              v-if="b.kind === 'dialogue'"
              size="small"
              :value="b.speakerId ?? null"
              :options="speakerOptions"
              placeholder="说话人"
              style="width: 150px"
              @update:value="(v: string | null) => patch(b.id, { speakerId: v ?? undefined })"
            />
            <n-tag
              v-if="beatIssueLabel(b)"
              size="small"
              type="error"
              :bordered="false"
            >
              {{ beatIssueLabel(b) }}
            </n-tag>
            <n-tag v-else size="small" type="success" :bordered="false">已就绪</n-tag>
          </div>

          <div v-if="expanded === b.id" class="stack" style="gap: 8px; margin-top: 10px">
            <div v-if="b.entities.length" class="row" style="gap: 6px; flex-wrap: wrap">
              <span
                v-for="e in b.entities.map(entityOf).filter(Boolean)"
                :key="e!.id"
                class="tag-chip"
                :style="{ background: '#f2f4f7', color: '#5b6273' }"
              >
                {{ e!.name }} · S{{ e!.subjectN ?? '?' }}
                {{ e!.pictureN != null ? `· P${e!.pictureN}` : '· 纯文本' }}
              </span>
            </div>

            <div class="two-col">
              <div>
                <div class="muted" style="font-size: 12px; margin-bottom: 4px">镜头描述（英文）</div>
                <n-input
                  size="small"
                  :value="b.direction ?? ''"
                  placeholder="medium shot, slow push in"
                  @update:value="(v: string) => patch(b.id, { direction: v })"
                />
              </div>
              <div>
                <div class="muted" style="font-size: 12px; margin-bottom: 4px">聚焦主体</div>
                <n-select
                  size="small"
                  :value="b.focusEntityId ?? null"
                  :options="(b.entities ?? []).map((id) => ({
                    label: entityOf(id)?.name ?? id,
                    value: id
                  }))"
                  placeholder="本镜头画面中心主体"
                  clearable
                  @update:value="(v: string | null) => patch(b.id, { focusEntityId: v ?? undefined })"
                />
              </div>
            </div>

            <div>
              <div class="muted" style="font-size: 12px; margin-bottom: 4px">画面描述（英文）</div>
              <n-input
                size="small"
                type="textarea"
                :rows="2"
                :value="b.visualDesc ?? ''"
                placeholder="楚辞 leaning against the cavern wall, retaining the reference costume details"
                @update:value="(v: string) => patch(b.id, { visualDesc: v })"
              />
            </div>

            <div class="row" style="gap: 8px">
              <n-button size="tiny" quaternary @click="patch(b.id, { enriched: true })">
                标记为已填充
              </n-button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
