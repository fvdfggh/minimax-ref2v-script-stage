<script setup lang="ts">
/**
 * 一条素材的「作用方式 / 强度」面板 —— 每个关键帧、每条音视频都该有一个。
 *
 * 两个维度，别混：
 *   作用方式（图片、音视频都有）——
 *     关键帧 → 这一段的内容：图片落在段内某一帧（能抢首尾、进 kfImages），
 *              音频 / 视频占住这段的音轨 / 画面（kfAudios / kfVideos）
 *     参考   → 只借给模型看 / 听：图片占一个 <Picture N> 槽，音视频只进
 *              refAudios / refVideos，都不占时间轴
 *   强度（关键帧方式才有完整意义）——
 *     强制 → 拨到 100（visual_noise_aug 0.999），钉死在这一帧 / 这一段
 *     参考 → 拨到 30，仍落在同一帧，但按强度混噪，只借构图、动作、音色
 *   中间那些值（比如 60）就用滑杆细调；档位只是两个快捷落点，
 *   所以点「参考」时如果本来就在 0~95 之间，保留你已经调好的数值。
 *
 * 只发出事件，不直接写库：调用方各自有 store（卡片 / 弹窗 / 段详情），
 * 这里只管一个面板长什么样。
 */
import { computed } from 'vue'
import { NSlider } from 'naive-ui'
import { ACT_AS_HINT, ACT_AS_LABEL } from '@/domain/references'
import {
  STRENGTH_HARD,
  STRENGTH_MAX,
  STRENGTH_REF,
  actAsOf,
  clampStrength,
  strengthLabel,
  strengthOf,
  usageOfStrength,
  visualNoiseAugOf
} from '@/domain/references'
import type { Asset, AssetActAs } from '@/domain/types'

/**
 * allowActAs 必须用 withDefaults 给 true：
 * Vue 对未传的 Boolean prop 默认是 **false**（不是 undefined），
 * 写 `props.allowActAs ?? true` 会永远拿到 false —— 整栏作用方式就不见了。
 */
const props = withDefaults(
  defineProps<{
    asset: Asset
    /** 传 false 就只剩强度（老调用方靠这个把作用方式藏掉） */
    allowActAs?: boolean
    /**
     * 音视频也显示作用方式。默认关：多数地方只是"调强度"，
     * 但素材带上要能把一段声音在图块之间搬（这段的台词 ↔ 只借音色），
     * 那里显式打开。
     */
    mediaActAs?: boolean
  }>(),
  { allowActAs: true, mediaActAs: false }
)
const emit = defineEmits<{
  change: [value: number]
  actAs: [value: AssetActAs]
}>()

const value = computed(() => strengthOf(props.asset))
const hard = computed(() => usageOfStrength(value.value) === 'force')
const isMedia = computed(() => props.asset.media === 'audio' || props.asset.media === 'video')
/** 图片一定有作用方式；音视频要看调用方开没开 */
const canSwitch = computed(
  () => props.allowActAs !== false && (!isMedia.value || props.mediaActAs === true)
)
const asRef = computed(() => canSwitch.value && actAsOf(props.asset) === 'reference')

/*
 * 文案按本体分开：图片说"锁一帧 / 只借画面"，音视频说"占时间轴 / 只借声音·动作"。
 * 同样是"参考"，一个是占 Picture 槽，一个是走 refAudios / refVideos，不能混着说。
 */
const actTag = computed(() =>
  isMedia.value
    ? asRef.value
      ? '参考素材'
      : '关键帧'
    : ACT_AS_LABEL[asRef.value ? 'reference' : 'keyframe']
)
const actKeyLabel = computed(() => (isMedia.value ? '关键帧 · 占时间轴' : '关键帧 · 锁一帧'))
const actRefLabel = computed(() => (isMedia.value ? '参考 · 只借声音' : '参考图 · 只借画面'))
const actHint = computed(() => {
  if (!isMedia.value) return ACT_AS_HINT[asRef.value ? 'reference' : 'keyframe']
  return asRef.value
    ? '不占这段的时间轴，只进 refAudios / refVideos：借音色 / 动作，不强绑这一条'
    : '占住这段的音轨 / 画面，从起始帧起生效；强度决定钉得多硬'
})

function set(v: number | [number, number]) {
  emit('change', clampStrength(typeof v === 'number' ? v : v[0]))
}

/** 强制：直接拨满，不记上一次的软值也够用（要回去就点「参考」） */
function toForce() {
  if (!hard.value) set(STRENGTH_HARD)
}

/** 参考：已经是软的就不动，别把用户手调的 60 改成 30 */
function toRef() {
  if (hard.value) set(STRENGTH_REF)
}

function toActAs(v: AssetActAs) {
  if (asRef.value === (v === 'reference')) return
  emit('actAs', v)
}

/**
 * 音频没有视觉混噪这条路：满强度是固定音轨，低了才是参考音色。
 * 图片 / 视频则始终落在起始帧上，靠混噪变软 —— 所以提示要分开写。
 * 这里不直接复用 `strengthHint`：那句自带 visual_noise_aug，面板上已经单列了一行。
 */
const hint = computed(() => {
  const a = props.asset
  if (a.media === 'audio' || a.media === 'video') {
    // 作用方式已经是"只当参考"时，通道已经定了，强度只决定借多少
    if (asRef.value) return '只进参考通道：从起始帧起对齐比对，强度只决定借多少'
    if (a.media === 'audio') {
      return hard.value
        ? '满强度 = 固定音轨（kfAudios），这一段就用这条声音'
        : '低于满强度走参考音色（refAudios）：只借音色，不强绑这一条'
    }
    return hard.value
      ? '钉在这一段的起始帧上，模型必须从它出发'
      : '仍从起始帧起生效，但按强度混噪：越低越会重画，只借动作'
  }
  return hard.value
    ? '钉死在这一帧，模型必须从它出发'
    : '仍落在这一帧，但按强度混噪：越低越会重画，只借构图 / 动作'
})
</script>

<template>
  <div class="str-pop" @click.stop @keydown.stop>
    <!-- 作用方式：决定的不是"多硬"而是"走哪条通道" -->
    <template v-if="canSwitch">
      <div class="str-head">
        <span class="str-lb">作用方式</span>
        <span class="str-tag" :class="asRef ? 'is-soft' : 'is-hard'">
          {{ actTag }}
        </span>
      </div>
      <div class="str-mode">
        <button type="button" class="str-btn" :class="{ on: !asRef }" @click.stop="toActAs('keyframe')">
          {{ actKeyLabel }}
        </button>
        <button type="button" class="str-btn" :class="{ on: asRef }" @click.stop="toActAs('reference')">
          {{ actRefLabel }}
        </button>
      </div>
      <div class="str-hint is-act">
        {{ actHint }}
        <template v-if="asRef && asset.pictureN > 0">（本次占 P{{ asset.pictureN }}）</template>
      </div>
    </template>

    <!-- 强度：参考图方式下没有意义，整段收起；音视频只当参考时强度仍然有用 -->
    <template v-if="!asRef || isMedia">
      <div class="str-head" :class="{ 'is-sub': canSwitch }">
        <span class="str-lb">强度</span>
        <b class="mono str-num">{{ value }}</b>
        <span class="str-tag" :class="hard ? 'is-hard' : 'is-soft'">{{ hard ? '强制' : '参考' }}</span>
      </div>

      <div class="str-mode">
        <button type="button" class="str-btn" :class="{ on: hard }" @click.stop="toForce">
          强制 · 钉住
        </button>
        <button type="button" class="str-btn" :class="{ on: !hard }" @click.stop="toRef">
          参考 · 不钉死
        </button>
      </div>

      <n-slider
        :value="value"
        :min="0"
        :max="STRENGTH_MAX"
        :step="5"
        :tooltip="false"
        @update:value="set"
      />

      <div class="str-aug mono">visual_noise_aug {{ visualNoiseAugOf(value).toFixed(3) }}</div>
      <div class="str-hint">{{ strengthLabel(value) }} —— {{ hint }}</div>
    </template>
  </div>
</template>

<style scoped>
.str-pop {
  width: 236px;
  padding: 9px 11px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: var(--panel);
  box-shadow: 0 6px 18px rgba(20, 30, 50, 0.12);
}

.str-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
}
/* 作用方式下面再接「强度」时，两条标题之间留一点距离，别糊成一段 */
.str-head.is-sub {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px dashed var(--hover);
}
.str-lb {
  color: var(--muted);
}
.str-num {
  font-size: 13px;
  font-weight: 700;
}
.str-tag {
  margin-left: auto;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10.5px;
  line-height: 16px;
}
.str-tag.is-hard {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.str-tag.is-soft {
  background: var(--warn-soft);
  color: var(--warn-ink);
}

/* 两个快捷档位：点一下就把强度拨过去，细调仍然靠下面的滑杆 */
.str-mode {
  display: flex;
  gap: 4px;
  margin: 6px 0 2px;
}
.str-btn {
  flex: 1;
  padding: 3px 0;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  background: #fff;
  color: var(--label);
  font-size: 11px;
  line-height: 15px;
  cursor: pointer;
}
.str-btn:hover {
  border-color: var(--accent-line);
  color: var(--accent-ink);
}
.str-btn.on {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-weight: 600;
}
.str-btn.on:last-child {
  border-color: var(--warn-line);
  background: var(--warn-soft);
  color: var(--warn-ink);
}

.str-aug {
  margin-top: 2px;
  font-size: 10px;
  color: var(--muted);
}
.str-hint {
  margin-top: 3px;
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--muted);
}
.str-hint.is-act {
  margin-top: 4px;
}
</style>
