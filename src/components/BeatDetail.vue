<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NInput, NInputNumber, NSelect } from 'naive-ui'
import { BEAT_KIND_COLOR, BEAT_KIND_LABEL, beatIssueLabel, resolveSubjectId } from '@/domain/beats'
import { beatFrames, dialogueFrames, secondsFromFrames } from '@/domain/timing'
import type { Beat, BeatKind, Entity, ID, ProjectSettings } from '@/domain/types'
import { AUTO_KINDS } from '@/domain/types'
import { useRegistryStore } from '@/stores/registry'
import { useImageStore } from '@/stores/images'
import ImageGenModal from './ImageGenModal.vue'
import InfoTip from './common/InfoTip.vue'

/**
 * 片段（Beat）的详情表单 —— 全项目共用。
 * ①②③ 用它在弹窗/Tab 里编辑同一个片段；改字段即时通过 patch 事件冒泡出去。
 *
 * 版式：五段，每段一个颜色身份（内容蓝 / 归属青 / 画面紫 / 时长琥珀 / 流水线灰），
 * 段标题用同色短横，字段两列排布、长字段通栏。配色只由 --mod 系列变量决定。
 */
const props = defineProps<{
  beat: Beat
  settings: ProjectSettings
  entities: Entity[]
  entityById: Map<ID, Entity>
  /**
   * 外层是否已经显示了「类型 + 标题」。
   * 弹窗标题栏 / 视频段 Tab 标签里已经有了，就传 false，避免同一个名字出现两遍；
   * 校验提示（issue）不受影响，始终显示。
   */
  showHead?: boolean
}>()

const emit = defineEmits<{
  patch: [id: ID, patch: Partial<Beat>]
}>()

const beat = computed(() => props.beat)
const isAuto = computed(() => AUTO_KINDS.includes(beat.value.kind))

/* 场景图：为这个镜头生成 / 编辑一张画面参考（pictureN=0，不进 reference 槽） */
const registry = useRegistryStore()
const images = useImageStore()
const sceneModal = ref(false)
function sceneImageUrl(): string | null {
  const a = registry.sceneImageFor(beat.value.id)
  return a ? registry.assetUrl(a) : null
}

const frames = computed(() => beatFrames(beat.value, props.settings))
const autoFrames = computed(() => dialogueFrames(beat.value.dialogue, props.settings.fps))
const issue = computed(() => beatIssueLabel(beat.value))

const kindOptions = [
  { label: '台词', value: 'dialogue' },
  { label: '动作', value: 'action' },
  { label: '换场', value: 'scene_switch' },
  { label: '铺垫', value: 'establishing' },
  { label: '反应', value: 'reaction' },
  { label: '特写', value: 'insert' }
]

function labelOf(e: Entity) {
  return `${e.name}${e.subjectN != null ? `（S${e.subjectN}）` : ''}`
}

const entityList = computed(() => beat.value.entities)

const entityOptions = computed(() => {
  const needSpeaking = beat.value.kind === 'dialogue'
  const list = needSpeaking ? props.entities.filter((e) => e.kind === 'speaking') : props.entities
  return list.map((e) => ({ label: labelOf(e), value: e.id }))
})

const speakerOptions = computed(() =>
  props.entities.filter((e) => e.kind === 'speaking').map((e) => ({ label: labelOf(e), value: e.id }))
)

/** 聚焦主体候选 = 其他主体 + 场景（纯场景镜的聚焦主体就是场景） */
const focusOptions = computed(() => {
  const ids = [...entityList.value]
  if (beat.value.sceneId && !ids.includes(beat.value.sceneId)) ids.unshift(beat.value.sceneId)
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
  const id = beat.value.sceneId
  return id ? props.entityById.get(id) ?? null : null
})

const sceneIsValid = computed(() => !!sceneEntity.value && sceneEntity.value.type === 'scene')

const kindColor = computed(() => BEAT_KIND_COLOR[beat.value.kind as BeatKind] ?? '#6b7280')

const focusName = computed(() => {
  const id = resolveSubjectId(beat.value)
  const e = id ? props.entityById.get(id) : undefined
  return e ? labelOf(e) : '—'
})

/** naive-ui 的多选/单选清空会 emit null，这里统一收敛 */
function patch(p: Partial<Beat>) {
  const next: Partial<Beat> = { ...p }
  if ('entities' in next) next.entities = Array.isArray(next.entities) ? next.entities : []
  if ('speakerId' in next && !next.speakerId) next.speakerId = undefined
  if ('focusEntityId' in next && !next.focusEntityId) next.focusEntityId = undefined
  if ('sceneId' in next && !next.sceneId) next.sceneId = undefined
  if ('kind' in next && next.kind !== 'dialogue') next.speakerId = undefined
  emit('patch', beat.value.id, next)
}

function resetFrames() {
  emit('patch', beat.value.id, { estFrames: undefined, manualFrames: false })
}
</script>

<template>
  <div class="bd">
    <header v-if="showHead !== false || issue" class="bd-head">
      <template v-if="showHead !== false">
        <span
          class="bd-kind"
          :style="{ background: kindColor + '16', borderColor: kindColor + '38', color: kindColor }"
        >
          {{ BEAT_KIND_LABEL[beat.kind as BeatKind] }}
        </span>
        <span class="bd-title">{{ beat.title || '未命名片段' }}</span>
      </template>
      <span v-if="issue" class="chip err">{{ issue }}</span>
    </header>

    <p v-if="isAuto" class="bd-auto">
      引擎自动生成的拼接片段，字段由缝合结论决定
      <InfoTip size="sm" :width="280" text="预备镜头 / 尾帧切镜 / 黑屏，一般不需要手改。" />
    </p>

    <!-- 内容 -->
    <section class="bd-sec t-blue">
      <div class="bd-sec-h">内容</div>
      <div class="bd-grid">
        <div class="bd-f">
          <div class="bd-l">标题</div>
          <n-input
            size="small"
            :value="beat.title"
            placeholder="一句话说明这个镜头做什么"
            @update:value="(v: string) => patch({ title: v })"
          />
        </div>
        <div class="bd-f">
          <div class="bd-l">类型</div>
          <n-select
            size="small"
            :value="beat.kind"
            :options="kindOptions"
            @update:value="(v: string) => patch({ kind: v as BeatKind })"
          />
        </div>

        <div v-if="beat.kind === 'dialogue'" class="bd-f wide">
          <div class="bd-l">纯台词<span class="bd-hint">不写角色名、不加格式标记</span></div>
          <n-input
            type="textarea"
            :rows="2"
            :value="beat.dialogue ?? ''"
            placeholder="我不信这世上没有解药。"
            @update:value="(v: string) => patch({ dialogue: v })"
          />
          <div class="bd-help">
            汉字 {{ (beat.dialogue ?? '').replace(/[^\u4e00-\u9fff]/g, '').length }} 字 →
            自动推算 {{ autoFrames }} 帧 / {{ secondsFromFrames(autoFrames, settings.fps).toFixed(2) }}s
          </div>
        </div>

        <div class="bd-f wide">
          <div class="bd-l">备注<span class="bd-hint">仅自己看，不写进提示词</span></div>
          <n-input
            size="small"
            :value="beat.note ?? ''"
            placeholder="例如：这句台词待确认"
            @update:value="(v: string) => patch({ note: v })"
          />
        </div>
      </div>
    </section>

    <!-- 归属 -->
    <section class="bd-sec t-teal">
      <div class="bd-sec-h">归属</div>
      <div class="bd-grid">
        <div class="bd-f">
          <div class="bd-l">
            场景
            <span class="bd-req">必填</span>
            <span v-if="!sceneEntity" class="chip err">未指定</span>
            <span v-else-if="!sceneIsValid" class="chip err">类型不是场景</span>
          </div>
          <n-select
            size="small"
            :value="beat.sceneId ?? null"
            :options="sceneOptions"
            placeholder="这个镜头发生在哪"
            :status="sceneIsValid ? undefined : 'warning'"
            @update:value="(v: string | null) => patch({ sceneId: v ?? undefined })"
          />
          <div v-if="!sceneOptions.length" class="bd-help">
            主体里还没有场景，去「主体登记」新建一个（类型选场景）
          </div>
        </div>
        <div class="bd-f">
          <div class="bd-l">其他主体<span class="bd-hint">可选</span></div>
          <n-select
            size="small"
            multiple
            :value="entityList"
            :options="entityOptions"
            placeholder="角色 / 道具，纯场景镜可以留空"
            :max-tag-count="2"
            @update:value="(v: string[] | null) => patch({ entities: v ?? [] })"
          />
        </div>
        <div v-if="beat.kind === 'dialogue'" class="bd-f">
          <div class="bd-l">说话人</div>
          <n-select
            size="small"
            :value="beat.speakerId ?? null"
            :options="speakerOptions"
            placeholder="选一个会说话的角色"
            @update:value="(v: string | null) => patch({ speakerId: v ?? undefined })"
          />
        </div>
        <div class="bd-f">
          <div class="bd-l">镜头聚焦主体</div>
          <n-select
            size="small"
            :value="beat.focusEntityId ?? null"
            :options="focusOptions"
            placeholder="画面中心主体，纯场景镜选场景"
            clearable
            @update:value="(v: string | null) => patch({ focusEntityId: v ?? undefined })"
          />
        </div>
      </div>
    </section>

    <!-- 画面 -->
    <section class="bd-sec t-violet">
      <div class="bd-sec-h">画面</div>

      <div class="bd-scene">
        <div class="bd-thumb">
          <img v-if="sceneImageUrl()" :src="sceneImageUrl() ?? undefined" alt="场景图" />
          <span v-else class="bd-thumb-empty">无</span>
        </div>
        <div class="bd-scene-body">
          <div class="bd-l">
            场景图
            <InfoTip size="sm" :width="260" text="此镜头的画面参考，用于对照生成 / 编辑。" />
          </div>
          <p class="bd-help">
            {{
              sceneImageUrl()
                ? '已有一张参考图，可以重新生成，或基于它做图生图微调。'
                : '暂无。按提示词生成一张，或基于已有图做图生图微调。'
            }}
          </p>
          <div class="bd-scene-actions">
            <n-button size="tiny" quaternary @click="sceneModal = true">
              {{ sceneImageUrl() ? '重新生成 / 编辑' : '生成场景图' }}
            </n-button>
          </div>
        </div>
      </div>

      <div class="bd-grid">
        <div class="bd-f">
          <div class="bd-l">镜头描述<span class="bd-hint">英文</span></div>
          <n-input
            size="small"
            :value="beat.direction ?? ''"
            placeholder="medium shot, slow push in"
            @update:value="(v: string) => patch({ direction: v })"
          />
        </div>
        <div class="bd-f">
          <div class="bd-l">画面描述<span class="bd-hint">英文</span></div>
          <n-input
            size="small"
            :value="beat.visualDesc ?? ''"
            placeholder="retaining the reference costume details"
            @update:value="(v: string) => patch({ visualDesc: v })"
          />
        </div>
      </div>
    </section>

    <!-- 时长 -->
    <section class="bd-sec t-amber">
      <div class="bd-sec-h">时长</div>
      <div class="bd-grid">
        <div class="bd-f">
          <div class="bd-l">
            帧数
            <span v-if="beat.manualFrames" class="chip warn">手动</span>
          </div>
          <div class="bd-inline">
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
          <div class="bd-help">
            {{ frames }} 帧 ≈ {{ secondsFromFrames(frames, settings.fps).toFixed(2) }}s
            <template v-if="beat.kind === 'dialogue'">· 台词自动推算 {{ autoFrames }} 帧</template>
          </div>
        </div>
      </div>
    </section>

    <!-- 流水线 -->
    <section class="bd-sec t-slate bd-pipe">
      <div class="bd-sec-h">本镜头将交给流水线的信息</div>
      <dl class="bd-kv">
        <dt>主体</dt>
        <dd class="accent">{{ focusName }}</dd>
        <dt>绑定实体</dt>
        <dd>{{ entityList.map((id) => entityById.get(id)?.name ?? id).join('、') || '—' }}</dd>
      </dl>
      <p class="bd-help">
        主体用于缝合判定与 “Only X is in frame” 的生成约束
        <InfoTip size="sm" :width="280" text="段里引用了谁，决定这段能不能和相邻段缝上，也决定生成时限定画面里有谁。" />
      </p>
    </section>

    <ImageGenModal
      v-if="sceneModal"
      :show="true"
      title="场景图"
      :default-prompt="images.scenePrompt(beat.id)"
      :base-image-url="sceneImageUrl()"
      default-size="1280x720"
      @done="(blob: Blob) => images.attachSceneImage(beat.id, blob)"
      @update:show="(v: boolean) => { if (!v) sceneModal = false }"
    />
  </div>
</template>

<style scoped>
.bd {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

/* ---------- 头 ---------- */
.bd-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.bd-kind {
  flex: 0 0 auto;
  padding: 0 8px;
  border-radius: var(--r-pill);
  font-size: 11px;
  line-height: 19px;
  font-weight: 600;
  border: 1px solid transparent;
}
.bd-title {
  min-width: 0;
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 自动片段提示：琥珀软底 + 左侧色条 */
.bd-auto {
  margin: 0;
  padding: 7px 10px;
  border-radius: var(--r-sm);
  border: 1px solid var(--warn-line);
  border-left: 3px solid var(--warn);
  background: var(--warn-soft);
  color: var(--warn-ink);
  font-size: var(--fs-sm);
  line-height: 1.6;
}

/* ---------- 段 ---------- */
.bd-sec {
  --mod: var(--m-blue);
  --mod-soft: var(--m-blue-soft);
  --mod-line: var(--m-blue-line);
  --mod-ink: var(--m-blue-ink);
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
}
.bd-sec + .bd-sec {
  border-top: 1px dashed var(--line);
  padding-top: 12px;
}
.bd-sec.t-violet {
  --mod: var(--m-violet);
  --mod-soft: var(--m-violet-soft);
  --mod-line: var(--m-violet-line);
  --mod-ink: var(--m-violet-ink);
}
.bd-sec.t-teal {
  --mod: var(--m-teal);
  --mod-soft: var(--m-teal-soft);
  --mod-line: var(--m-teal-line);
  --mod-ink: var(--m-teal-ink);
}
.bd-sec.t-amber {
  --mod: var(--m-amber);
  --mod-soft: var(--m-amber-soft);
  --mod-line: var(--m-amber-line);
  --mod-ink: var(--m-amber-ink);
}
.bd-sec.t-slate {
  --mod: var(--m-slate);
  --mod-soft: var(--m-slate-soft);
  --mod-line: var(--m-slate-line);
  --mod-ink: var(--m-slate-ink);
}

.bd-sec-h {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.4px;
  color: var(--mod-ink);
}
.bd-sec-h::before {
  content: '';
  width: 14px;
  height: 3px;
  border-radius: 2px;
  background: var(--mod);
}

/* ---------- 字段 ---------- */
.bd-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 11px 12px;
  min-width: 0;
}
.bd-f {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.bd-f.wide {
  grid-column: 1 / -1;
}
.bd-l {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: var(--fs-sm);
  color: var(--label);
  line-height: 1.3;
}
.bd-hint {
  font-size: 10.5px;
  color: var(--muted);
}
.bd-req {
  font-size: 10.5px;
  font-style: normal;
  font-weight: 600;
  color: var(--err-ink);
}
.bd-help {
  margin: 2px 0 0;
  font-size: 10.8px;
  line-height: 1.6;
  color: var(--muted);
}
.bd-inline {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

/* ---------- 场景图 ---------- */
.bd-scene {
  display: flex;
  align-items: stretch;
  gap: 10px;
  padding: 8px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel-2);
}
.bd-thumb {
  flex: 0 0 128px;
  align-self: stretch;
  min-height: 72px;
  border-radius: var(--r-sm);
  overflow: hidden;
  background: var(--panel-3);
  border: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: center;
}
.bd-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.bd-thumb-empty {
  font-size: 11px;
  color: var(--muted);
}
.bd-scene-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.bd-scene-actions {
  margin-top: auto;
  padding-top: 4px;
}

/* ---------- 流水线信息 ---------- */
.bd-pipe {
  padding: 9px 12px;
  border: 1px solid var(--m-slate-line);
  border-left: 3px solid var(--m-slate);
  border-radius: var(--r-md);
  background: var(--m-slate-soft);
}
.bd-kv {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 3px 10px;
  margin: 0;
  font-size: var(--fs-sm);
}
.bd-kv dt {
  color: var(--label);
}
.bd-kv dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text);
}
.bd-kv dd.accent {
  color: var(--accent-ink);
  font-weight: 600;
}

@media (max-width: 720px) {
  .bd-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
