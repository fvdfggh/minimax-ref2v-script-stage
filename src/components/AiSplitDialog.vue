<script setup lang="ts">
/**
 * 「AI 拆细这一拍」。
 *
 * 为什么要先看再应用：
 *   拆拍会换掉这一拍的 id（原来那条被几条新的取代），已经组合好的段、出过的图
 *   都会跟着失效。所以模型给的方案必须先摊开让人看一眼 —— 这不是"多一步确认"，
 *   这是唯一能让人判断"拆得对不对"的地方。
 *
 * 只拆**这一拍**：整场重拆是另一件事（回到顶部重新拆解），这里点一次只处理一条，
 * 这样才敢在一场戏中间反复点。
 */
import { computed, ref, watch } from 'vue'
import { NButton, NInput, NModal, NTag, useMessage } from 'naive-ui'
import { BEAT_KIND_LABEL, type SplitPart } from '@/domain/beats'
import { beatFrames, secondsFromFrames } from '@/domain/timing'
import { usePipelineStore } from '@/stores/pipeline'
import { useProviderStore } from '@/stores/provider'
import type { BeatSplitPart } from '@/core/llm/assist'
import type { Beat, ProjectSettings } from '@/domain/types'

const props = defineProps<{
  show: boolean
  beat: Beat | null
  settings: ProjectSettings
  sceneName?: string
  prevTitle?: string
  nextTitle?: string
}>()

const emit = defineEmits<{
  'update:show': [boolean]
  /** 用户点了「用这个方案」：交给页面去真正拆 */
  apply: [parts: SplitPart[]]
}>()

const pipeline = usePipelineStore()
const provider = useProviderStore()
const message = useMessage()

const brief = ref('')
const busy = ref(false)
const parts = ref<BeatSplitPart[]>([])
const err = ref('')

const totalFrames = computed(() => (props.beat ? beatFrames(props.beat, props.settings) : 0))

/** 权重 → 帧：两条都必须守恒（和的一半归前几条，余数给最后一条），否则时长会漂 */
const planned = computed(() => {
  const list = parts.value
  if (!list.length) return []
  const weights = list.map((p) => Math.max(1, p.weight ?? 2))
  const sum = weights.reduce((a, b) => a + b, 0)
  const frames = weights.map((w) => Math.max(1, Math.round((w / sum) * totalFrames.value)))
  const drift = totalFrames.value - frames.reduce((a, b) => a + b, 0)
  frames[frames.length - 1] = Math.max(1, frames[frames.length - 1] + drift)
  return list.map((p, i) => ({ ...p, frames: frames[i] }))
})

watch(
  () => props.show,
  (on) => {
    if (!on) return
    brief.value = ''
    parts.value = []
    err.value = ''
  }
)

async function run() {
  const b = props.beat
  if (!b) return
  if (!provider.ready) {
    message.warning('请先在「模型设置」里配置文本模型')
    return
  }
  busy.value = true
  err.value = ''
  try {
    parts.value = await pipeline.splitBeatByAi({
      beat: {
        title: b.title,
        kind: b.kind,
        dialogue: b.dialogue,
        direction: b.direction,
        visualDesc: b.visualDesc,
        frames: totalFrames.value,
        fps: props.settings.fps
      },
      scene: props.sceneName,
      prevTitle: props.prevTitle,
      nextTitle: props.nextTitle,
      requirement: brief.value.trim() || undefined,
      language: props.settings.workLanguage
    })
  } catch (e) {
    err.value = (e as Error).message || '拆细失败'
  } finally {
    busy.value = false
  }
}

function apply() {
  if (planned.value.length < 2) return
  emit('apply', planned.value)
  emit('update:show', false)
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    style="width: 560px"
    :title="`AI 拆细：${beat?.title || ''}`"
    :bordered="false"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div class="asd">
      <div class="asd-orig">
        <span class="asd-kind">{{ beat ? BEAT_KIND_LABEL[beat.kind] : '' }}</span>
        <span class="asd-frames">{{ totalFrames }} 帧 · {{ secondsFromFrames(totalFrames, settings.fps) }}s</span>
        <span v-if="beat?.dialogue" class="asd-dlg">「{{ beat.dialogue }}」</span>
      </div>

      <div class="asd-row">
        <n-input
          v-model:value="brief"
          size="small"
          placeholder="补一句要求（可留空）：比如「按动作拆成三拍」「把动作和台词分开」"
          @keydown.enter.prevent="run"
        />
        <n-button size="small" type="primary" :loading="busy" @click="run">
          {{ parts.length ? '再拆一次' : '让 AI 拆' }}
        </n-button>
      </div>

      <div v-if="err" class="asd-err">{{ err }}</div>

      <div v-if="planned.length" class="asd-list">
        <div class="asd-lb">拆成 {{ planned.length }} 拍（时长按权重分配，总和不变）</div>
        <div v-for="(p, i) in planned" :key="i" class="asd-item">
          <span class="asd-n">{{ i + 1 }}</span>
          <div class="asd-main">
            <div class="asd-t">{{ p.title }}</div>
            <div class="asd-meta">
              <n-tag size="tiny" :bordered="false">{{ BEAT_KIND_LABEL[p.kind as keyof typeof BEAT_KIND_LABEL] ?? p.kind }}</n-tag>
              <span>{{ p.frames }} 帧</span>
              <span v-if="p.dialogue" class="asd-dlg">「{{ p.dialogue }}」</span>
            </div>
          </div>
        </div>
        <div class="asd-warn">应用后这一拍的 id 会变，已经组合进段 / 出过图的引用会失效。</div>
      </div>
    </div>

    <template #footer>
      <div class="asd-foot">
        <n-button size="small" quaternary @click="emit('update:show', false)">取消</n-button>
        <n-button size="small" type="primary" :disabled="planned.length < 2" @click="apply">
          用这个方案
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.asd {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.asd-orig {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-2);
  font-size: 11.5px;
  color: var(--muted);
}
.asd-kind {
  color: var(--accent-ink);
  font-weight: 600;
}
.asd-dlg {
  color: var(--text);
}
.asd-row {
  display: flex;
  gap: 6px;
}
.asd-err {
  font-size: 11.5px;
  color: var(--err-ink);
}
.asd-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow: auto;
}
.asd-lb {
  font-size: 11px;
  color: var(--muted);
}
.asd-item {
  display: flex;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
}
.asd-n {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 10.5px;
  line-height: 18px;
  text-align: center;
}
.asd-main {
  min-width: 0;
  flex: 1;
}
.asd-t {
  font-size: 12.5px;
  color: var(--text);
}
.asd-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  font-size: 11px;
  color: var(--muted);
  flex-wrap: wrap;
}
.asd-warn {
  font-size: 11px;
  color: var(--warn-ink);
}
.asd-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
