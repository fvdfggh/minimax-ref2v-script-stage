<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NInput, NInputNumber, NModal, NSelect, NTag } from 'naive-ui'
import { BEAT_KIND_COLOR, BEAT_KIND_LABEL, beatIssueLabel, resolveSubjectId } from '@/domain/beats'
import { beatFrames, dialogueFrames, secondsFromFrames } from '@/domain/timing'
import type { Beat, BeatKind, Entity, ID, ProjectSettings } from '@/domain/types'
import { AUTO_KINDS } from '@/domain/types'

const props = defineProps<{
  show: boolean
  beat: Beat | null
  settings: ProjectSettings
  entities: Entity[]
  entityById: Map<ID, Entity>
}>()

const emit = defineEmits<{
  'update:show': [boolean]
  patch: [id: ID, patch: Partial<Beat>]
}>()

const kindOptions = [
  { label: '台词', value: 'dialogue' },
  { label: '动作', value: 'action' },
  { label: '换场', value: 'scene_switch' },
  { label: '铺垫', value: 'establishing' },
  { label: '反应', value: 'reaction' },
  { label: '特写', value: 'insert' }
]

const beat = computed(() => props.beat)
const isAuto = computed(() => (beat.value ? AUTO_KINDS.includes(beat.value.kind) : false))

const frames = computed(() => (beat.value ? beatFrames(beat.value, props.settings) : 0))
const seconds = computed(() => secondsFromFrames(frames.value, props.settings.fps))
const autoFrames = computed(() =>
  beat.value ? dialogueFrames(beat.value.dialogue, props.settings.fps) : 0
)
const issue = computed(() => (beat.value ? beatIssueLabel(beat.value) : null))

function labelOf(e: Entity) {
  return `${e.name}${e.subjectN != null ? `（S${e.subjectN}）` : ''}`
}

const entityList = computed(() => beat.value?.entities ?? [])

const entityOptions = computed(() => {
  const needSpeaking = beat.value?.kind === 'dialogue'
  const list = needSpeaking ? props.entities.filter((e) => e.kind === 'speaking') : props.entities
  return list.map((e) => ({ label: labelOf(e), value: e.id }))
})

const speakerOptions = computed(() =>
  props.entities.filter((e) => e.kind === 'speaking').map((e) => ({ label: labelOf(e), value: e.id }))
)

/** 聚焦主体候选 = 其他主体 + 场景（纯场景镜的聚焦主体就是场景） */
const focusOptions = computed(() => {
  const ids = [...entityList.value]
  if (beat.value?.sceneId && !ids.includes(beat.value.sceneId)) ids.unshift(beat.value.sceneId)
  return ids
    .map((id) => props.entityById.get(id))
    .filter((e): e is Entity => !!e)
    .map((e) => ({ label: labelOf(e), value: e.id }))
})

/** 场景候选只取 type = scene 的实体 */
const sceneOptions = computed(() =>
  props.entities.filter((e) => e.type === 'scene').map((e) => ({ label: labelOf(e), value: e.id }))
)

const sceneEntity = computed(() => {
  const id = beat.value?.sceneId
  return id ? props.entityById.get(id) ?? null : null
})

const sceneIsValid = computed(() => !!sceneEntity.value && sceneEntity.value.type === 'scene')

const kindColor = computed(() =>
  beat.value ? BEAT_KIND_COLOR[beat.value.kind as BeatKind] ?? '#6b7280' : '#6b7280'
)

const focusName = computed(() => {
  const id = beat.value ? resolveSubjectId(beat.value) : null
  const e = id ? props.entityById.get(id) : undefined
  return e ? labelOf(e) : '—'
})

/** naive-ui 的多选/单选清空会 emit null，这里统一收敛 */
function patch(p: Partial<Beat>) {
  if (!beat.value) return
  const next: Partial<Beat> = { ...p }
  if ('entities' in next) next.entities = Array.isArray(next.entities) ? next.entities : []
  if ('speakerId' in next && !next.speakerId) next.speakerId = undefined
  if ('focusEntityId' in next && !next.focusEntityId) next.focusEntityId = undefined
  if ('sceneId' in next && !next.sceneId) next.sceneId = undefined
  if ('kind' in next && next.kind !== 'dialogue') next.speakerId = undefined
  emit('patch', beat.value.id, next)
}

function resetFrames() {
  if (!beat.value) return
  emit('patch', beat.value.id, { estFrames: undefined, manualFrames: false })
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    style="max-width: 760px"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <template #header>
      <div class="row" style="gap: 8px">
        <span
          v-if="beat"
          class="tag-chip"
          :style="{ background: kindColor + '18', color: kindColor }"
        >
          {{ BEAT_KIND_LABEL[beat.kind as BeatKind] }}
        </span>
        <span style="font-weight: 600">{{ beat?.title || '编辑片段' }}</span>
        <n-tag v-if="issue" size="small" type="error" :bordered="false">{{ issue }}</n-tag>
      </div>
    </template>

    <div v-if="!beat" class="empty">没有选中片段</div>

    <div v-else class="stack" style="gap: 14px">
      <div v-if="isAuto" class="issue info">
        这是引擎自动生成的拼接片段（预备镜头 / 尾帧切镜 / 黑屏），字段由缝合结论决定，一般不需要手改。
      </div>

      <div class="beat-editor-grid">
        <div>
          <div class="muted beat-label">标题</div>
          <n-input
            size="small"
            :value="beat.title"
            placeholder="一句话说明这个镜头做什么"
            @update:value="(v: string) => patch({ title: v })"
          />
        </div>
        <div>
          <div class="muted beat-label">类型</div>
          <n-select
            size="small"
            :value="beat.kind"
            :options="kindOptions"
            @update:value="(v: string) => patch({ kind: v as BeatKind })"
          />
        </div>
      </div>

      <div v-if="beat.kind === 'dialogue'">
        <div class="muted beat-label">纯台词（不写角色名、不加格式标记）</div>
        <n-input
          type="textarea"
          :rows="2"
          :value="beat.dialogue ?? ''"
          placeholder="我不信这世上没有解药。"
          @update:value="(v: string) => patch({ dialogue: v })"
        />
        <div class="muted" style="font-size: 12px; margin-top: 4px">
          汉字 {{ (beat.dialogue ?? '').replace(/[^\u4e00-\u9fff]/g, '').length }} 字 →
          自动推算 {{ autoFrames }} 帧 / {{ secondsFromFrames(autoFrames, settings.fps).toFixed(2) }}s
        </div>
      </div>

      <!-- 场景：必填，放在最前面 -->
      <div class="beat-editor-grid">
        <div>
          <div class="muted beat-label">
            场景（必填）
            <span
              v-if="!sceneEntity"
              class="tag-chip"
              style="background: #fdecec; color: #a12d2d"
            >
              未指定
            </span>
            <span
              v-else-if="!sceneIsValid"
              class="tag-chip"
              style="background: #fdecec; color: #a12d2d"
            >
              类型不是场景
            </span>
          </div>
          <n-select
            size="small"
            :value="beat.sceneId ?? null"
            :options="sceneOptions"
            placeholder="这个镜头发生在哪"
            :status="sceneIsValid ? undefined : 'warning'"
            @update:value="(v: string | null) => patch({ sceneId: v ?? undefined })"
          />
          <div v-if="!sceneOptions.length" class="muted" style="font-size: 12px; margin-top: 4px">
            注册表里还没有场景实体，去「实体与素材」新建一个（类型选场景）
          </div>
        </div>
        <div>
          <div class="muted beat-label">
            其他主体（可选）
          </div>
          <n-select
            size="small"
            multiple
            :value="entityList"
            :options="entityOptions"
            placeholder="角色 / 道具 / 界面，纯场景镜可以留空"
            :max-tag-count="2"
            @update:value="(v: string[] | null) => patch({ entities: v ?? [] })"
          />
        </div>
      </div>

      <div class="beat-editor-grid-3">
        <div v-if="beat.kind === 'dialogue'">
          <div class="muted beat-label">说话人</div>
          <n-select
            size="small"
            :value="beat.speakerId ?? null"
            :options="speakerOptions"
            placeholder="选一个会说话的角色"
            @update:value="(v: string | null) => patch({ speakerId: v ?? undefined })"
          />
        </div>
        <div>
          <div class="muted beat-label">镜头聚焦主体</div>
          <n-select
            size="small"
            :value="beat.focusEntityId ?? null"
            :options="focusOptions"
            placeholder="画面中心主体，纯场景镜选场景"
            clearable
            @update:value="(v: string | null) => patch({ focusEntityId: v ?? undefined })"
          />
        </div>
        <div>
          <div class="muted beat-label">
            帧数
            <span v-if="beat.manualFrames" class="tag-chip" style="background: #fff3e0; color: #b06a12">
              手动
            </span>
          </div>
          <div class="row" style="gap: 6px">
            <n-input-number
              size="small"
              style="flex: 1"
              :value="frames"
              :min="1"
              :max="2000"
              :show-button="false"
              @update:value="(v: number | null) => patch({ estFrames: v ?? 1, manualFrames: true })"
            />
            <n-button size="small" :disabled="!beat.manualFrames" @click="resetFrames">
              恢复自动
            </n-button>
          </div>
        </div>
      </div>

      <div class="beat-editor-grid">
        <div>
          <div class="muted beat-label">镜头描述（英文）</div>
          <n-input
            size="small"
            :value="beat.direction ?? ''"
            placeholder="medium shot, slow push in"
            @update:value="(v: string) => patch({ direction: v })"
          />
        </div>
        <div>
          <div class="muted beat-label">画面描述（英文）</div>
          <n-input
            size="small"
            :value="beat.visualDesc ?? ''"
            placeholder="retaining the reference costume details"
            @update:value="(v: string) => patch({ visualDesc: v })"
          />
        </div>
      </div>

      <div>
        <div class="muted beat-label">备注（仅自己看，不写进提示词）</div>
        <n-input
          size="small"
          :value="beat.note ?? ''"
          placeholder="例如：这句台词待确认"
          @update:value="(v: string) => patch({ note: v })"
        />
      </div>

      <div class="panel" style="padding: 10px 12px; background: var(--panel-2)">
        <div class="muted" style="font-size: 12px; margin-bottom: 4px">本镜头将交给流水线的信息</div>
        <div class="mono" style="font-size: 12px; line-height: 1.8">
          <div>主体（用于缝合判定 / Only X is in frame）　<span style="color: #2b56b8">{{ focusName }}</span></div>
          <div>
            绑定实体　
            <span style="color: #5b6273">
              {{ entityList.map((id) => entityById.get(id)?.name ?? id).join('、') || '—' }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="row" style="justify-content: space-between">
        <span class="muted" style="font-size: 12.5px">改动会立即保存</span>
        <n-button type="primary" @click="emit('update:show', false)">完成</n-button>
      </div>
    </template>
  </n-modal>
</template>
