<script setup lang="ts">
/**
 * 「细节填充」里的单个片段卡片。
 *
 * 这个组件的存在理由：以前的细节填充只能看一行摘要，点「详情」弹窗才出字段，
 * 而弹窗一次只装一个片段 —— 二十段就要开二十次弹窗、关二十次、滚动二十次。
 * 现在字段直接铺在卡片里，一屏能同时看到、改到好几段。
 *
 * 两种形态：
 *   full    —— 全部字段平铺（场景 / 主体 / 说话人 / 聚焦 / 镜头描述 / 画面描述）。
 *              文本字段用本地草稿 + 防抖提交，否则每敲一个字都全表落库。
 *   compact —— 只读摘要，一行看完绑定与素材，点「展开编辑」切回 full。
 *
 * 两种形态下面都挂一条**素材带**，只放**关键帧素材** —— 这一段自己的、落在
 * 时间轴上的东西：关键帧图片（锁在某一帧）、台词配音 / 音视频（从某一帧起生效）。
 * 参考素材**不在素材带里**，它走下面那一行「引用」：主体自带的参考图跟着主体走、
 * 占 Picture 槽跨段共用；本段另外勾的参考也只借给模型看 / 听。引用不占素材位、
 * 不排帧位、没有占位，只回答"这一段借了谁"。
 *
 * 关键帧素材有三颗口，按"手里有没有文件"分工：
 *   上传口 ＋关键帧 —— 已经有成品，直接传（图片 / 音频 / 视频都收）；
 *   配置口 ＋图片配置 / ＋音频配置 —— 还没有本体，先写图片提示词 / 配音文本与音色。
 * 配置保存后才在素材带里出现一格**待合成占位**（一条 draft 素材，记着配置）；
 * 点占位回到同一个配置弹窗改，点「保存并出图 / 保存并配音」就地合成，
 * 合成成功后占位换成真素材。上传与合成都在卡上完成，弹窗留给"调帧位"。
 *
 * 两条贯穿全卡的口径：
 *   1. **关键帧素材能选到任意帧**：图片选落点（段首 / 段尾 / 指定帧），音视频选
 *      起始帧。帧位在缩略图下沿、占位格底部、配置弹窗里都能改，写的是同一个 frameIdx。
 *      参考素材不排帧位 —— 它不落在这一段的任何一帧上，只是被引用。
 *   2. **台词段自带一格配音配置**：文本对齐台词、音色取说话人，打开就能合成；
 *      台词改了它跟着改（用户自己改过文本的除外）。所以"每段有没有配音要合成"
 *      看的是占位，不再靠别处猜。
 *
 * 键盘：镜头描述里 Enter、画面描述里 Ctrl/Cmd+Enter，跳到**下一段的同一个字段**，
 * 这样一列填下来不用碰鼠标（Tab 仍是段内跳转）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NPopover, NSelect, NTag, NButton, NInput, useMessage } from 'naive-ui'
import { BEAT_KIND_COLOR, BEAT_KIND_LABEL, beatIssueLabel, resolveSubjectId } from '@/domain/beats'
import { beatFrames, secondsFromFrames } from '@/domain/timing'
import {
  PLACEMENT_LABEL,
  STRENGTH_HARD,
  actAsOf,
  beatRefSummary,
  beatTrackOf,
  frameLabel,
  frameOf,
  keyframesOf,
  refImagesOf,
  refMaterialsOf,
  slotDraftsOf,
  startFrameLabel,
  materialFrameOf,
  mediaFileSupported,
  mediaKindOf,
  placementOf,
  roleOfPlacement,
  strengthHint,
  strengthLabel,
  strengthOf,
  suggestPlacement
} from '@/domain/references'
import { AUTO_KINDS } from '@/domain/types'
import type { Asset, AssetActAs, Beat, Entity, ID, ProjectSettings } from '@/domain/types'
import AiWrite from '@/components/common/AiWrite.vue'
import { usePipelineStore } from '@/stores/pipeline'
import { useProviderStore } from '@/stores/provider'
import type { BeatWriteField } from '@/core/llm/assist'
import { useAudioPlayback } from '@/composables/useAudioPlayback'
import { useProjectStore } from '@/stores/project'
import { useRegistryStore } from '@/stores/registry'
import { voiceSpeak } from '@/core/voice'
import { VOICEOVER_LABEL, hasVoiceover, isVoiceover, voiceoverCheck } from '@/domain/voiceover'
import { secondsLabel, speechFitOf, speechFramePatch } from '@/domain/audioFrames'
import { keyframeDrift } from '@/domain/keyframeDrift'
import { useImageStore } from '@/stores/images'
import StrengthPopover from '@/components/common/StrengthPopover.vue'
import PickTiles from '@/components/common/PickTiles.vue'
import ImageGenModal from '@/components/ImageGenModal.vue'
import SlotConfigDialog, { type SlotConfig } from '@/components/SlotConfigDialog.vue'
import { useBeatKeyframeGen } from '@/composables/useBeatKeyframeGen'
import { useSlotBatch } from '@/composables/useSlotBatch'

const props = defineProps<{
  beat: Beat
  index: number
  settings: ProjectSettings
  variant: 'full' | 'compact'
  entityById: Map<ID, Entity>
  sceneOptions: Array<{ label: string; value: ID }>
  entityOptions: Array<{ label: string; value: ID }>
  speakerOptions: Array<{ label: string; value: ID }>
  /** 「过长被迫拆开」时第几段 / 共几段 */
  splitPiece?: { index: number; total: number } | null
  /** 批量出图的挑选态：卡片头部出一颗勾选框 */
  pickable?: boolean
  picked?: boolean
  /** 前后各一拍的标题：只喂给单点 AI 判断这一拍的来去，不显示 */
  prevTitle?: string
  nextTitle?: string
}>()

const emit = defineEmits<{
  patch: [id: ID, patch: Partial<Beat>]
  preview: [asset: Asset]
  expand: [id: ID]
  /** 勾选 / 取消勾选（批量出图用） */
  pick: [id: ID, next: boolean]
  /** 卡片上直接上传 / 合成 / 改了配置：让上层刷新打包 / 提示等派生状态 */
  changed: []
}>()

const registry = useRegistryStore()
const images = useImageStore()
const pipeline = usePipelineStore()
const provider = useProviderStore()
/** 合成动作与页面顶部「批量出图 / 批量合成」共用同一份（见 useSlotBatch） */
const slotBatch = useSlotBatch()

const b = computed(() => props.beat)
const isAuto = computed(() => AUTO_KINDS.includes(b.value.kind))
const frames = computed(() => beatFrames(b.value, props.settings))
const seconds = computed(() => secondsFromFrames(frames.value, props.settings.fps))

/*
 * 帧数在卡上直接改（原来只有拆解 / 详情里能改，细节填充看到"这段 96 帧太短"
 * 还得跑去别的页签）。
 *
 * 改帧数必须同时打上 manualFrames —— 不然台词段那套"按台词时长自动推算"会
 * 立刻把你的数字改回去。
 * 用草稿 + 失焦 / 回车提交：直接落库的话，敲 "128" 会先写 1、再写 12、再写 128，
 * 每一下都会牵动关键帧落点与音视频起始帧的夹取，中间态白抖三次。
 */
const dFrames = ref(String(frames.value))
/** 焦点态自己记：naive 的 .n-input--focus 类在程序化聚焦时不出现，靠它画框 */
const durFocus = ref(false)
let framesDirty = false
watch(frames, (v) => {
  if (!framesDirty) dFrames.value = String(v)
})
watch(
  () => b.value.id,
  () => {
    framesDirty = false
    dFrames.value = String(frames.value)
  }
)

function onFramesInput(v: string) {
  framesDirty = true
  dFrames.value = v
}

function commitFrames() {
  const digits = dFrames.value.replace(/[^\d]/g, '')
  framesDirty = false
  // 清空 = 不改（别把 1 帧写进去，那会整段塌掉）
  if (!digits) {
    dFrames.value = String(frames.value)
    return
  }
  const n = Math.min(2000, Math.max(1, Math.round(Number(digits))))
  dFrames.value = String(n)
  if (n === frames.value) return
  emit('patch', b.value.id, { estFrames: n, manualFrames: true })
}

function onFramesKey(ev: KeyboardEvent) {
  if (ev.key !== 'Enter' || ev.isComposing) return
  ev.preventDefault()
  commitFrames()
  ;(ev.target as HTMLElement | null)?.blur()
}

function onFramesBlur() {
  durFocus.value = false
  commitFrames()
}

/** 退回自动推算（台词段按台词时长，其余按默认拍长） */
function resetFrames() {
  framesDirty = false
  emit('patch', b.value.id, { estFrames: undefined, manualFrames: false })
}

const framesTip = computed(
  () =>
    `帧数：${frames.value} 帧 ≈ ${seconds.value.toFixed(2)}s（${props.settings.fps}fps）` +
    `${b.value.manualFrames ? ' · 手动设定' : ' · 自动推算'}；改完按回车或点空白处生效`
)
const issue = computed(() => beatIssueLabel(b.value))
const kindColor = computed(() => BEAT_KIND_COLOR[b.value.kind] ?? '#6b7280')

const stateLabel = computed(() => {
  if (issue.value) return issue.value
  if (isAuto.value) return '自动生成'
  return b.value.enriched ? '已确认' : '待确认'
})
const stateClass = computed(() => {
  if (issue.value) return 'is-err'
  if (isAuto.value) return 'is-auto'
  return b.value.enriched ? 'is-ok' : 'is-warn'
})

/* ---------------------------- 展示用派生 ---------------------------- */

const sceneName = computed(() => {
  const id = b.value.sceneId
  const e = id ? props.entityById.get(id) : undefined
  return e ? `${e.name}${e.subjectN != null ? ` S${e.subjectN}` : ''}` : null
})

const speakerName = computed(() => {
  const id = b.value.speakerId
  const e = id ? props.entityById.get(id) : undefined
  return e ? e.name : null
})

/** 实体 → 图块（名字 / S 编号 / P 编号 / 缩略图）：卡片上凡是"显示一个主体"的地方都走它 */
function tileOf(e: Entity) {
  // 参考图挂在实体上：选上它就等于带上图，这里只负责把图取出来
  const img = registry.subjectImageFor(e.id)
  return {
    id: e.id,
    name: e.name,
    sub: e.subjectN != null ? `S${e.subjectN}` : '',
    img: img ? registry.assetUrl(img) : null,
    badge: e.pictureN != null ? `P${e.pictureN}` : undefined
  }
}

/*
 * 主体沿用一条乐观草稿：连点两下加号时，父组件的 patch 还在落库路上，
 * props.beat 还没换，直接读 b.value.entities 会把第一下覆盖掉。
 * 草稿在 props 真正变化后清空，下一轮又回到以数据为准。
 */
const draftEntities = ref<ID[] | null>(null)
watch(
  () => b.value.entities,
  () => {
    draftEntities.value = null
  }
)
const curEntities = computed(() => draftEntities.value ?? b.value.entities ?? [])

/** 主体图块：顺序跟 beat.entities 一致，所以卡片上的排列和出图时的引用顺序对得上 */
const subjectTiles = computed(() =>
  curEntities.value
    .map((id) => props.entityById.get(id))
    .filter((e): e is Entity => !!e)
    .map(tileOf)
)

/** 场景图块：只有一个（单选），没绑就是空 */
const sceneTiles = computed(() => {
  const e = b.value.sceneId ? props.entityById.get(b.value.sceneId) : undefined
  return e ? [tileOf(e)] : []
})

/** 说话人图块：单选，没选就是空（台词段必填，空着会描黄边） */
const speakerTiles = computed(() => {
  const e = b.value.speakerId ? props.entityById.get(b.value.speakerId) : undefined
  return e ? [tileOf(e)] : []
})

/** 聚焦主体图块：单选；空 = 跟随自动推断（台词段跟说话人，其余跟画面主体） */
const focusTiles = computed(() => {
  const e = b.value.focusEntityId ? props.entityById.get(b.value.focusEntityId) : undefined
  return e ? [tileOf(e)] : []
})

/** 候选：场景 / 主体 / 说话人 / 聚焦各一份，图都取实体自己的参考图（面板里也能看出是谁） */
const scenePickOptions = computed(() =>
  props.sceneOptions
    .map((o) => props.entityById.get(o.value))
    .filter((e): e is Entity => !!e)
    .map(tileOf)
)
const entityPickOptions = computed(() =>
  props.entityOptions
    .map((o) => props.entityById.get(o.value))
    .filter((e): e is Entity => !!e)
    .map(tileOf)
)
const speakerPickOptions = computed(() =>
  props.speakerOptions
    .map((o) => props.entityById.get(o.value))
    .filter((e): e is Entity => !!e)
    .map(tileOf)
)

/** 紧凑形态那一行摘要用的名字（带 S 编号与有没有图） */
const subjectChips = computed(() =>
  subjectTiles.value.map((s) => ({
    id: s.id,
    text: `${s.name}${s.sub ? ` ${s.sub}` : ''}`,
    pic: s.badge ?? null,
    img: s.img,
    isSpeaker: s.id === b.value.speakerId
  }))
)

/** 聚焦主体：没显式选时系统会回退（台词→说话人，其余→画面主体），要说明白 */
const focusText = computed(() => {
  const id = resolveSubjectId(b.value)
  const e = id ? props.entityById.get(id) : undefined
  if (!e) return null
  return b.value.focusEntityId ? e.name : `${e.name}（自动）`
})

const focusPickOptions = computed(() => {
  const ids = [...(b.value.entities ?? [])]
  if (b.value.sceneId && !ids.includes(b.value.sceneId)) ids.unshift(b.value.sceneId)
  return ids
    .map((id) => props.entityById.get(id))
    .filter((e): e is Entity => !!e)
    .map(tileOf)
})

const refSum = computed(() => beatRefSummary(b.value, props.entityById, registry.assets))

/**
 * 紧凑形态那一行摘要：只说**这一段专属**的素材。
 * 主体的参考图已经贴在主体摘要里（带 P 编号），这里再数一遍会让人以为
 * 素材带里还能看到它们；零项的也不列，免得出现「参考图 0 · 音 0 · 视 0」。
 */
const compactRefText = computed(() => {
  const r = refSum.value
  const bits: string[] = []
  if (r.keyframes) bits.push(`关键帧 ${r.keyframes}`)
  if (r.references) bits.push(`参考图 ${r.references}`)
  if (r.audio) bits.push(`音 ${r.audio}`)
  if (r.video) bits.push(`视 ${r.video}`)
  return bits.join(' · ')
})

/* ------------------------------ 素材带 ------------------------------ */

/** 素材：关键帧 + 音视频混排，按生效帧排序（图片是落点，音视频是起始帧） */
const track = computed(() => beatTrackOf(registry.assets, b.value.id, frames.value))

/**
 * 素材带分成上下两块，分法不是按文件类型，是按**作用方式**：
 *   关键帧：这一段自己的内容，落在时间轴上 —— 关键帧图片（占某一帧）、
 *           台词配音 / 音视频（从某一帧起生效）。错了整段就歪。
 *   参考素材：只借给模型看或听 —— 参考图（占 <Picture N> 槽）、参考音视频
 *           （只进 refAudios / refVideos）。少一条只是"没那么像"。
 *
 * ★ 两块**都收任意种类**：一段声音同样可以是"参考音色"而不是"这段的台词"，
 * 一段视频也可以只借动作。所以判据只有一个 —— actAs，和打包走同一口径
 * （见 references.onTimelineOf / pack 的通道选择），不会出现卡片在参考块、
 * 包里却占住音轨这种对不上的情况。
 */
const timelineAssets = computed(() => track.value.filter(isOnTimeline))

/**
 * 引用到的素材：参考图（占 P 编号）+ 参考音视频（只进参考通道）。
 *
 * 它们不占这一段的时间轴，所以不进素材带 —— 只在下面的「引用」行里露一颗小胶囊，
 * 回答"这一段借了谁"。真正的「素材」是 timelineAssets 那些。
 */
const refAssets = computed(() => [
  ...refImagesOf(registry.assets, b.value.id),
  ...refMaterialsOf(registry.assets, b.value.id)
])

/** 落在这一段的时间轴上吗（判据同打包，见 references.onTimelineOf） */
function isOnTimeline(a: Asset): boolean {
  return actAsOf(a) === 'keyframe'
}

/** 这一段落在时间轴上的图片 / 声音各有几条（占位只在"这一类一条都没有"时出现） */

/**
 * 这段"现在"的样子：模板提示词 + 台词。
 *
 * 出图之后改了台词或画面描述，卡片上的图不会自己变，但已经对不上了。
 * 每次渲染拿它跟关键帧出图时的快照比一次，变了的就在缩略图上打个「旧」。
 */
const kfNow = computed(() => ({
  context: images.keyframePrompt(b.value.id, 'at'),
  dialogue: (b.value.dialogue ?? '').trim()
}))

function driftOf(a: Asset) {
  return keyframeDrift(a, kfNow.value)
}

/** 关键帧角标：44 宽的缩略图里塞不下"第 12 帧"，用 首 / 尾 / F12 */
/** 关键帧角标：永远是具体的帧号，不再出现「首 / 尾」这种相对说法 */
function kfBadge(a: Asset): string {
  return `F${kfFrame(a)}`
}

/** 音视频角标：从第几帧起生效 */
function mediaBadge(a: Asset): string {
  const f = startFrame(a)
  return f === 0 ? '段首' : `F${f}`
}

function mediaKindLabel(a: Asset): string {
  return a.media === 'video' ? '视' : '音'
}

/**
 * 紧凑形态没有底行（帧位行整个隐藏了），强度 + 起始帧都并进右上角的徽标里：
 * 「100·F12」「60·段首」。强度一律写出来 —— 满强度也得看得见"这条是钉死的"，
 * 否则调软过的和没调过的在紧凑态长得一样。
 */
function mediaBadgeText(a: Asset): string {
  const base = mediaBadge(a)
  return props.variant === 'compact' ? `${strengthOf(a)}·${base}` : base
}

/** 段内最后一帧的下标（帧位合法区间是 0..lastFrame） */
const lastFrame = computed(() => Math.max(0, frames.value - 1))

/**
 * 起始帧始终从 store 里取最新的那条。
 * track 里拿到的 a 是渲染那一刻的快照，连点 −/+ 时它还是旧值，
 * 三次点击会都算成 0+1，最后只前进一帧。
 */
function startFrame(a: Asset): number {
  const fresh = registry.assets.find((x) => x.id === a.id) ?? a
  return materialFrameOf(fresh, frames.value)
}

/** 卡上改起始帧：夹在 0..最后一帧，越界不报错、直接吸附到边上 */
async function setStart(a: Asset, v: number | null) {
  const n = Math.min(Math.max(0, Math.round(Number(v) || 0)), lastFrame.value)
  if (n === startFrame(a)) return
  try {
    await registry.setMaterialStartFrame(a.id, n, frames.value)
  } catch (e) {
    message.error((e as Error).message || '起始帧没保存上')
  }
}

/* ------------------------ 关键帧落点：只有帧位 ------------------------ */

/**
 * 和 startFrame 同理：帧位一律从 store 取最新的，别用渲染快照。
 * 早期数据里可能还留着 head/tail（段首/段尾贴边），frameOf 会把它们
 * 换算成实际帧号；用户一动 −/+ 就落成具体帧位。
 */
function kfFrame(a: Asset): number {
  const fresh = registry.assets.find((x) => x.id === a.id) ?? a
  return frameOf(fresh, frames.value)
}

async function setKfFrame(a: Asset, v: number | null) {
  const n = Math.min(Math.max(0, Math.round(Number(v) || 0)), lastFrame.value)
  if (n === kfFrame(a)) return
  try {
    await registry.setKeyframePlacement(a.id, 'at', n)
    emit('changed')
  } catch (e) {
    message.error((e as Error).message || '帧位没保存上')
  }
}

/* ------------------------ 段内素材：起始帧 + 强度 ------------------------ */

/**
 * 强度描述的是"这东西钉不钉得住"，和"落在第几帧"是两个独立参数：
 *   100 → visual_noise_aug 0.999，钉死在这一帧
 *   <100 → 仍在同一帧上，按比例混噪，越低越像参考
 * 声音没有视觉混噪这条路，所以音频满强度才固定音轨、否则走参考音色。
 */
function strengthText(a: Asset): string {
  return `${strengthOf(a)}`
}

function strengthTip(a: Asset): string {
  const s = strengthOf(a)
  return `${strengthLabel(s)}（强度 ${s}）：${strengthHint(s)}`
}

async function setStrength(a: Asset, v: number | [number, number]): Promise<void> {
  const next = typeof v === 'number' ? v : v[0]
  try {
    await registry.setAssetStrength(a.id, next)
    emit('changed')
  } catch (e) {
    message.error((e as Error).message || '强度没保存上')
  }
}

/** 紧凑态里角标是强度入口，别让点击穿透到"看大图"；展开态它只是提示 */
function onMediaBadgeClick(ev: MouseEvent) {
  if (props.variant === 'compact') ev.stopPropagation()
}

/**
 * 换作用方式：关键帧 ↔ 参考。
 *
 * 图片：切到参考会腾出帧位、分一个 Picture 编号，切回关键帧会把编号交回去。
 * 音视频：只改"占不占这段的时间轴"（占 → kfAudios / kfVideos，不占 → 参考通道），
 * 帧位保留 —— 只当参考时那个帧位是"从第几帧起比对"。
 * 所以这里等 store 落库完再刷新，别提前把 UI 画成新样子。
 */
async function setActAs(a: Asset, v: AssetActAs): Promise<void> {
  try {
    await registry.setBeatAssetActAs(a.id, v)
    if (a.kind === 'material') {
      message.success(
        v === 'reference'
          ? '已改为参考素材：不占这段的时间轴，只进参考通道（音色 / 动作）'
          : '已改为这段的内容：从起始帧起占住这段的音轨 / 画面'
      )
    } else {
      message.success(
        v === 'reference'
          ? '已改为参考图：不再锁这一帧，占一个 Picture 槽跟本段走'
          : '已改为关键帧：重新落在帧位上'
      )
    }
    emit('changed')
  } catch (e) {
    message.error((e as Error).message || '作用方式没保存上')
  }
}

/* ------------------------------ 台词配音 ------------------------------ */

/**
 * 台词是**文字**，段内要的是**声音**。这一颗按钮把两者搭起来：
 * 用这个镜头说话人已经固定下来的音色包，把台词合成一条 wav，
 * 直接落成段内「素材」（音频），起始帧默认段首、随时能改。
 *
 * 判定（能不能配 / 为什么不能）走 domain/voiceover，和整页批量配音共用一套 ——
 * 否则迟早出现"卡片能点、批量跳过"这种说不清的不一致。
 *
 * 重配时先删掉上一版：段内轨道上留两条一模一样的台词，只会让人不敢动。
 */

const voicing = ref(false)

const voiceCheck = computed(() => voiceoverCheck(b.value, props.entityById))
const canVoice = computed(() => !!voiceCheck.value.target)
const voiceHint = computed(() => {
  const t = voiceCheck.value.target
  return t ? `用「${t.speaker.name}」的固定音色合成这句台词（${t.voiceId}）` : voiceCheck.value.reason ?? ''
})

const hasVoiceoverNow = computed(() => hasVoiceover(registry.assets, b.value.id))

/**
 * 按配音算出来的应有帧长。
 *
 * 字数估算（汉字数 ÷ 5 秒）只是平均值：音色慢一点、句中有停顿，就会被截断。
 * 合成audio 的真实时长是最准的答案，这里把它折算成帧，给按钮和提示共用。
 */
const voiceFit = computed(() => speechFitOf(b.value, registry.assets, props.settings))

const voiceFitHint = computed(() => {
  const f = voiceFit.value
  if (!f) return ''
  const delta = f.frames - f.current
  const tail = `配音 ${secondsLabel(f.plan.seconds)}，从第 ${f.plan.startFrame} 帧起，` +
    `需 ${f.frames} 帧（当前 ${f.current}${delta > 0 ? `，+${delta}` : delta < 0 ? `，${delta}` : ''}）`
  return f.plan.overLimit ? `${tail}。超过单段 ${props.settings.maxSegmentFrames} 帧，会被拆成多段` : tail
})

/** 精确按配音对齐：可以延长，也可以收紧（用户主动点的） */
function alignToSpeech(): void {
  const f = voiceFit.value
  if (!f) return
  if (f.frames === f.current) {
    message.info(`当前就是配音长度（${f.frames} 帧）`)
    return
  }
  emit('patch', b.value.id, { estFrames: f.frames, manualFrames: true })
  message.success(
    f.longer
      ? `按配音延长：${f.current} → ${f.frames} 帧`
      : `按配音收紧：${f.current} → ${f.frames} 帧`
  )
}

async function makeVoiceover() {
  /*
   * 台词段默认带着一格配音配置（文本跟着台词走）。这一颗按钮就**合成那一格**：
   * 用格里的文本 / 音色 / 起始帧 —— 用户在配置里改过字，按钮就得念他改过的字，
   * 而不是回头去念 beat.dialogue（那是两套口径，迟早对不上）。
   * 只有这一格被删掉时才退回"按台词直接合成"。
   */
  const slot = slotDrafts.value.find((a) => a.media === 'audio' && actAsOf(a) === 'keyframe')
  if (slot) {
    if (hasVoiceoverNow.value) {
      for (const old of registry.materialsFor(b.value.id).filter(isVoiceover)) {
        await registry.removeAsset(old.id)
      }
    }
    await synthSlot(slot)
    return
  }
  const t = voiceCheck.value.target
  if (!t) return
  voicing.value = true
  try {
    const blob = await voiceSpeak(t.voiceId, t.text)
    for (const old of registry.materialsFor(b.value.id).filter(isVoiceover)) {
      await registry.removeAsset(old.id)
    }
    const file = new File([blob], `voice_${t.voiceId}.wav`, { type: 'audio/wav' })
    const asset = await registry.addBeatAsset(b.value.projectId, b.value.id, file, {
      kind: 'material',
      frameIdx: 0,
      label: VOICEOVER_LABEL
    })
    /*
     * 帧长交给这句配音来定（speechFramePatch 里有分寸）：
     * 没手动调过就完全按音频来；手调过只补不足的，不擅自砍掉留白。
     */
    const fit = speechFitOf(b.value, registry.assets, props.settings)
    const framePatch = speechFramePatch(b.value, fit)
    if (framePatch) emit('patch', b.value.id, framePatch)
    const sec = secondsLabel(asset.durationSec)
    const how = !framePatch
      ? `当前 ${frames.value} 帧够用`
      : framePatch.estFrames > (fit?.current ?? 0)
        ? `本段延长到 ${framePatch.estFrames} 帧`
        : `本段收紧到 ${framePatch.estFrames} 帧`
    message.success(`「${t.speaker.name}」的台词已合成（${sec || '时长未知'}），${how}`)
    emit('changed')
  } catch (e) {
    message.error(e instanceof Error ? e.message : '配音失败')
  } finally {
    voicing.value = false
  }
}

/* ---------------------- 素材带：上传口 + 配置口 ---------------------- */

/**
 * 每块两颗口，**分工不同**：
 *   上传口（＋关键帧 / ＋参考）—— 手里已经有文件，直接传进来；
 *   配置口（＋图片配置 / ＋音频配置）—— 手里还没有本体，先把"要合成什么"写下来。
 *
 * 配置保存后生成一条 **draft 素材**（见 registry.createDraftAsset），在素材带上
 * 就是一格虚线占位：它记着提示词 / 配音文本与音色，点它回来改，合成成功后替换成
 * 真素材。占位因此是**有内容的**，刷新、换设备都还在，批量合成也读得到。
 */
const slotDrafts = computed(() => slotDraftsOf(registry.assets, b.value.id))

/** 这一段的占位按作用方式分到两块（判据和真素材同一个 actAs） */
function slotsOf(actAs: AssetActAs): Asset[] {
  return slotDrafts.value.filter((a) => actAsOf(a) === actAs)
}

/* --------------------------- 配置弹窗 --------------------------- */

const slotOpen = ref(false)
const slotActAs = ref<AssetActAs>('keyframe')
const slotMedia = ref<'image' | 'audio'>('image')
/** 正在改的那格占位；null = 新建 */
const slotEditing = ref<Asset | null>(null)

function openSlotConfig(actAs: AssetActAs, media: 'image' | 'audio', slot: Asset | null = null): void {
  slotActAs.value = actAs
  slotMedia.value = media
  slotEditing.value = slot
  slotOpen.value = true
}

/**
 * 保存配置。新建走 createDraftAsset（占位从这里出现），已有就改那条草稿。
 * 「保存并合成」= 保存后顺手跑一次合成：图片走唯一那条出图流程，
 * 音频直接在这里合成（没有批量弹窗）。
 */
async function onSlotSubmit(cfg: SlotConfig, andRun: boolean): Promise<void> {
  const pid = project.currentId
  if (!pid) return
  try {
    let target: Asset
    if (slotEditing.value) {
      const patch: Partial<Asset> = {}
      if (cfg.prompt !== undefined) patch.prompt = cfg.prompt
      if (cfg.promptBrief !== undefined) patch.promptBrief = cfg.promptBrief
      if (cfg.refAssetIds) patch.refAssetIds = cfg.refAssetIds
      if (cfg.voiceText !== undefined) {
        patch.voiceText = cfg.voiceText
        /*
         * 台词段默认那格（auto）的文本是**跟着台词走**的：台词一改它就跟着改。
         * 用户在配置里自己动了文本，这格就归他 —— 再跟台词同步等于把人家写的字
         * 覆盖掉，所以 auto 落成 false。
         */
        if (
          slotEditing.value.auto &&
          cfg.voiceText.trim() !== (slotEditing.value.voiceText ?? '').trim()
        ) {
          patch.auto = false
        }
      }
      if (cfg.voiceSpeakerId) patch.voiceSpeakerId = cfg.voiceSpeakerId
      if (cfg.placement) {
        patch.placement = cfg.placement
        patch.role = roleOfPlacement(cfg.placement)
      }
      if (cfg.frameIdx !== undefined) patch.frameIdx = cfg.frameIdx
      await registry.updateAsset(slotEditing.value.id, patch)
      target = { ...slotEditing.value, ...patch }
    } else {
      target = await registry.createDraftAsset(pid, b.value.id, {
        actAs: slotActAs.value,
        media: slotMedia.value,
        placement: cfg.placement,
        frameIdx: cfg.frameIdx,
        prompt: cfg.prompt,
        promptBrief: cfg.promptBrief,
        refAssetIds: cfg.refAssetIds,
        voiceText: cfg.voiceText,
        voiceSpeakerId: cfg.voiceSpeakerId
      })
    }
    slotOpen.value = false
    message.success(slotMedia.value === 'audio' ? '已保存配音配置（素材带里出现一格占位）' : '已保存出图提示词（素材带里出现一格占位）')
    emit('changed')
    if (!andRun) return
    if (slotMedia.value === 'audio') await synthSlot(target)
    else openGenForAsset(target)
  } catch (e) {
    message.error((e as Error).message || '保存失败')
  }
}

/**
 * 按一格的配置合成语音，合成成功后占位换成真素材。
 *
 * 真正的动作在 useSlotBatch.synthOne —— 页面顶部的「批量合成」走的是同一份，
 * 否则"卡片上合成"和"批量合成"在落帧、改段长、删占位上迟早不一致。
 */
async function synthSlot(slot: Asset): Promise<void> {
  voicing.value = true
  try {
    const asset = await slotBatch.synthOne(slot, b.value)
    message.success(`「${props.entityById.get(slot.voiceSpeakerId ?? '')?.name ?? '语音'}」已合成（${secondsLabel(asset.durationSec) || '时长未知'}）`)
    emit('changed')
  } catch (e) {
    message.error(e instanceof Error ? e.message : '合成失败')
  } finally {
    voicing.value = false
  }
}

/** 删掉一格占位（只是配置，没有本体，删了不影响已经合成好的素材） */
async function removeSlot(slot: Asset): Promise<void> {
  try {
    await registry.removeAsset(slot.id)
    /*
     * 台词段删掉那格默认配音 = 这一段不要配音（画外音 / 留白）。
     * 记一笔，否则下次打开页面它又自动建回来 —— 那会让人觉得"删不掉"。
     */
    if (b.value.kind === 'dialogue' && slot.media === 'audio') {
      emit('patch', b.value.id, { voiceSkipped: true })
    }
    emit('changed')
  } catch (e) {
    message.error((e as Error).message || '删除失败')
  }
}

/** 占位格上直接改帧位：和配置弹窗里那颗下拉写的是同一个 frameIdx */
async function setSlotFrame(slot: Asset, v: number | null): Promise<void> {
  const n = Math.min(Math.max(0, Math.round(Number(v) || 0)), lastFrame.value)
  if (n === slotFrame(slot)) return
  try {
    await registry.setAssetFrameAt(slot.id, n, frames.value)
    emit('changed')
  } catch (e) {
    message.error((e as Error).message || '帧位没保存上')
  }
}

/**
 * 出图：走唯一那条关键帧出图流程（ImageGenModal + useBeatKeyframeGen），
 * 提示词取这一格自己写的那句；出完图草稿自己让位成真素材。
 */
const kfList = computed(() => keyframesOf(registry.assets, b.value.id))
const { genPlacement, genBaseUrl, genPrompt, genDefaultRefs, openGenForAsset, closeGen, onGenerated } =
  useBeatKeyframeGen({
    beatId: () => b.value.id,
    keyframes: () => kfList.value,
    lastFrame: () => Math.max(0, frames.value - 1),
    onDone: () => emit('changed')
  })

/** 占位格的显示文案：说清"等什么"，并带上配置的前半句，一眼知道写的是什么 */
function slotTitle(a: Asset): string {
  if (a.media === 'audio') return a.voiceSpeakerId && props.entityById.get(a.voiceSpeakerId)?.name
    ? `待配音 · ${props.entityById.get(a.voiceSpeakerId)!.name}`
    : '待配音'
  return '待出图'
}

function slotText(a: Asset): string {
  if (a.media === 'audio') return (a.voiceText ?? '').trim()
  return (a.prompt ?? '').trim()
}

/** 占位格落在第几帧（图片=落点，音频=起始帧） */
function slotFrame(a: Asset): number {
  return a.media === 'image' ? kfFrame(a) : startFrame(a)
}

/**
 * 素材带两块：**关键帧素材** / **参考素材**。
 *
 * 分法不是按文件类型（图一档、声一档），而是按**作用方式**：
 *   关键帧素材 —— 这一段自己的内容，落在时间轴上：关键帧图片、台词配音、音视频；
 *   参考素材   —— 只借给模型看 / 听、不占时间轴：参考图、参考音视频。
 *
 * 两块都有两颗**配置口**（＋图片配置 / ＋音频配置）：还没有本体，先写提示词 /
 * 配音文本与音色，保存后各自出现一格虚线占位，点那格回来改、也能直接合成。
 *
 * 区别只在"已经传好的成品怎么摆"：
 *   关键帧素材 —— 成品直接排在块里（缩略图 / 音条 + 帧位），它占时间轴、要看帧；
 *   参考素材   —— 成品走下面那一行**引用**（P 编号的小缩略 + 参考胶囊），
 *                 不占时间轴、不排帧位，所以这块只放"还没出图的占位"。
 */
interface MatModule {
  key: 'keyframe' | 'ref'
  label: string
  tip: string
  /** 上传口。参考素材没有：成品走下面的引用行（＋参考） */
  upload: { text: string; tip: string; run: () => void } | null
  configs: { key: string; text: string; tip: string; run: () => void }[]
  items: Asset[]
  slots: Asset[]
}

const matModules = computed<MatModule[]>(() => [
  {
    key: 'keyframe',
    label: '关键帧素材',
    tip: '关键帧素材：这一段自己的素材，落在时间轴上。图片锁在某一帧（能当首尾画面，强度决定钉得多死）；配音 / 音视频从选定的那一帧起生效',
    upload: {
      text: '关键帧',
      tip: '上传现成的材料（图片 / 音频 / 视频）：图片按项目策略找落点，音视频从段首起生效，只作用于这一段',
      run: pickKeyframes
    },
    configs: [
      {
        key: 'kf-img',
        text: '图片配置',
        tip: '先不传文件，写清这一帧要画什么：保存后素材带里出现一格待出图占位，点它可改，也可直接出图',
        run: () => openSlotConfig('keyframe', 'image')
      },
      {
        key: 'kf-aud',
        text: '音频配置',
        tip: '先不传文件，写清要念什么、用谁的音色：保存后出一格待配音占位，点它可改，也可直接合成',
        run: () => openSlotConfig('keyframe', 'audio')
      }
    ],
    items: timelineAssets.value,
    slots: slotsOf('keyframe')
  },
  {
    key: 'ref',
    label: '参考素材',
    tip: '参考素材：只借给模型看 / 听，不占时间轴。上传的参考图占 Picture 槽、参考音视频只进参考通道；配置的两颗口先写提示词 / 配音文本，保存后出占位',
    upload: {
      text: '参考',
      tip: '上传现成的参考材料（图片 / 音频 / 视频）：只借给模型看或听，不占这一段的时间轴',
      run: pickRefs
    },
    configs: [
      {
        key: 'ref-img',
        text: '图片配置',
        tip: '先不传文件，写清这张参考图要画什么：保存后出一格待出图占位，占 Picture 槽、只借画面',
        run: () => openSlotConfig('reference', 'image')
      },
      {
        key: 'ref-aud',
        text: '音频配置',
        tip: '先不传文件，写清这段参考语音要念什么：保存后出一格待配音占位，只进参考通道、不占时间轴',
        run: () => openSlotConfig('reference', 'audio')
      }
    ],
    items: refAssets.value,
    slots: slotsOf('reference')
  }
])

/*
 * 参考素材的成品从哪来：
 *   1. 本段自己传的参考图 / 参考音视频 —— 只借给模型看或听，占 Picture 槽 / 参考通道；
 *   2. 主体自带的参考图**不在这里复述**：主体格里已经显示过，主体选择时就看见了。
 * 所以卡片上只留「参考素材」这一块：传 / 配的东西都在块里，没有额外的引用行。
 */

/** 参考素材的类型字：图 / 视 / 音 */
function refKindText(a: Asset): string {
  return a.media === 'image' ? '图' : a.media === 'video' ? '视' : '音'
}

/* ------------------------------ 删除 ------------------------------ */

const removing = ref<ID | null>(null)

/**
 * 删一条段内素材。
 * 参考图不在这里删 —— 它挂在主体上，删了会影响所有用到这个主体的段，
 * 要删得去「素材与音色」里动主体。
 */
async function removeMaterial(a: Asset) {
  const what =
    a.kind === 'material' ? (a.media === 'video' ? '视频' : '音频') : '关键帧'
  removing.value = a.id
  try {
    await registry.removeAsset(a.id)
    message.success(`已删除${what}「${a.label || a.originalName}」`)
    emit('changed')
  } catch (e) {
    message.error((e as Error).message || '删除失败')
  } finally {
    removing.value = null
  }
}

/** 预览交给外层统一弹窗（AssetPreview）：新开标签页会把列表位置丢掉 */
function openAsset(a: Asset) {
  emit('preview', a)
}

/* ---------------------------- 帧号选择器 ---------------------------- */

/*
 * 帧位是"第几帧"这个有限集合里的一个值，让人用输入框敲数字是没有道理的：
 * 敲 999 要夹、敲空要兜、还得自己记住共几帧。所以关键帧落点、音视频起始帧
 * 都改成下拉选帧，选项就是 0..末帧。
 */
const frameOptions = computed(() =>
  Array.from({ length: Math.max(1, frames.value) }, (_, i) => ({
    label: `第 ${i} 帧`,
    value: i
  }))
)

/**
 * 关键帧 tile 里的帧位选择器只剩 ~70px 宽（左边还被强度按钮占了），
 * 「第 12 帧」会被截成「第..」。这里用 F12 这种短标号 —— 和音视频卡右上角
 * 的 F12 是同一套写法，全帧号仍然在 title 里写着。
 */
const frameOptionsShort = computed(() =>
  frameOptions.value.map((o) => ({ label: `F${o.value}`, value: o.value }))
)

/* ------------------------------ 卡上试听 ------------------------------ */

const { isPlaying, togglePlay, stopPlay, progress: playProgress, elapsed: playElapsed, total: playTotal, clockOf } =
  useAudioPlayback()

/**
 * 音频在卡片上就地放 —— 试听一条 3 秒的参考音，不该付出"开弹窗 + 关弹窗"的成本。
 * 视频要一块屏幕才看得见，仍然交给预览弹窗。
 */
async function onPlay(a: Asset) {
  if (a.media === 'video') {
    openAsset(a)
    return
  }
  const url = registry.assetUrl(a)
  if (!url) {
    message.error('这条音频还没落到后端，稍等一下再试')
    return
  }
  try {
    await togglePlay(a.id, url)
  } catch {
    message.error('浏览器放不了这个格式，可点文件名用弹窗打开')
  }
}

/* ------------------------------ 上传 ------------------------------ */

/*
 * 两个**上传口**，对应素材带的两个模块 —— 传之前就知道它会被放进哪一格：
 *   ＋关键帧 = 这一段的内容：图片按项目策略找落点（首 / 尾 / 中间某一帧），
 *             音频 / 视频从段首起生效，占这段的音轨 / 画面；
 *   ＋参考   = 只借给模型看 / 听：图片占一个 Picture 槽、不锁帧；音频 / 视频
 *             进 refAudios / refVideos，不占时间轴。
 * 两个口都收任意种类（图片 / 音频 / 视频），区别只在作用方式。
 * 主体的参考图仍然不在这里传：它挂在主体上，走 attachEntityPicture。
 *
 * 另外**两个配置口**（每块各一）不传文件，是给"还没有本体、先定内容"的那一步：
 *   ＋图片配置 = 写图片合成提示词 → 存成图片草稿（占位）→ 出图后转正；
 *   ＋音频配置 = 写语音合成文本 + 选音色 → 存成音频草稿（占位）→ 合成后转正。
 */
const project = useProjectStore()
const message = useMessage()

const kfInput = ref<HTMLInputElement | null>(null)
const refInput = ref<HTMLInputElement | null>(null)
const picInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const picBusy = ref(false)
const picTarget = ref<Entity | null>(null)

function pickKeyframes() {
  kfInput.value?.click()
}

function pickRefs() {
  refInput.value?.click()
}

function pickEntityPicture(e: Entity) {
  picTarget.value = e
  picInput.value?.click()
}

/** 图片逐张找位置：用一份虚拟列表推进，别把用户已经手动摆好的图挪走 */
async function addImages(files: File[], pid: ID): Promise<number> {
  const virt = registry
    .keyframesFor(b.value.id)
    .map((a) => ({ placement: placementOf(a), role: a.role, frameIdx: a.frameIdx }))
  for (const f of files) {
    const slot = suggestPlacement(virt, frames.value, project.settings.keyframeLayout ?? 'head_tail')
    await registry.addBeatAsset(pid, b.value.id, f, {
      kind: 'keyframe',
      placement: slot.placement,
      frameIdx: slot.frameIdx
    })
    virt.push({
      placement: slot.placement,
      role: roleOfPlacement(slot.placement),
      frameIdx: slot.frameIdx
    })
  }
  return files.length
}

/** 参考方式收进来的图片：不落帧、不抢首尾，只占一个 <Picture N> 槽 */
async function addRefImages(files: File[], pid: ID): Promise<number> {
  for (const f of files) {
    await registry.addBeatAsset(pid, b.value.id, f, { kind: 'keyframe', actAs: 'reference' })
  }
  return files.length
}

/** 分拣一批文件：图片 / 音视频 / 不支持的格式（两个上传口共用） */
function splitPicked(all: File[]) {
  const images = all.filter((f) => mediaKindOf(f.name, f.type) === 'image')
  const bad: string[] = []
  const media = all
    .filter((f) => mediaKindOf(f.name, f.type) !== 'image')
    .filter((f) => {
      if (mediaFileSupported(f.name, f.type)) return true
      bad.push(f.name)
      return false
    })
  return { images, media, bad }
}

function takeFiles(ev: Event): File[] {
  const input = ev.target as HTMLInputElement
  const all = input.files ? Array.from(input.files) : []
  input.value = ''
  return all
}

function warnBad(bad: string[]) {
  if (!bad.length) return
  message.warning(`跳过不支持的格式：${bad.join('、')}（音频用 mp3/wav/m4a，视频用 mp4/mov/webm）`)
}

/**
 * 关键帧口：什么都收 —— 图片按项目策略逐张找落点，音频 / 视频（含台词配音）
 * 从段首起生效。它们都属于这一段的时间轴，都归这块。
 */
async function onKeyframeFiles(ev: Event) {
  const pid = project.currentId
  const all = takeFiles(ev)
  if (!all.length || !pid) return
  const { images, media, bad } = splitPicked(all)
  warnBad(bad)
  if (!images.length && !media.length) return

  uploading.value = true
  try {
    if (images.length) await addImages(images, pid)
    // 音视频默认从段首起，往后挪到弹窗里拖轨道
    for (const f of media) {
      await registry.addBeatAsset(pid, b.value.id, f, { kind: 'material', frameIdx: 0 })
    }
    const bits: string[] = []
    if (images.length) bits.push(`${images.length} 张关键帧`)
    if (media.length) bits.push(`${media.length} 个音视频`)
    message.success(`已添加 ${bits.join(' + ')}（只作用于这一段）`)
    emit('changed')
  } catch (e) {
    message.error((e as Error).message || '上传失败')
  } finally {
    uploading.value = false
  }
}

/**
 * 参考素材口：图片、音频、视频都收，一律标成"只当参考"（actAs = reference）。
 *
 *   图片 → 占一个 <Picture N> 槽，不锁帧；
 *   音频 / 视频 → 仍然记一个起始帧（参考也要知道从第几帧开始比对），
 *                 但只进 refAudios / refVideos，不占这段的音轨 / 画面。
 *
 * 想改回来就点素材上的「参」/ 强度面板里的作用方式，不用删了重传。
 */
async function onRefFiles(ev: Event) {
  const pid = project.currentId
  const all = takeFiles(ev)
  if (!all.length || !pid) return
  const { images, media, bad } = splitPicked(all)
  warnBad(bad)
  if (!images.length && !media.length) return

  uploading.value = true
  try {
    if (images.length) await addRefImages(images, pid)
    for (const f of media) {
      await registry.addBeatAsset(pid, b.value.id, f, {
        kind: 'material',
        actAs: 'reference',
        frameIdx: 0
      })
    }
    const bits: string[] = []
    if (images.length) bits.push(`${images.length} 张参考图`)
    if (media.length) bits.push(`${media.length} 个参考音视频`)
    message.success(`已添加 ${bits.join(' + ')}（不占时间轴，只作用于这一段）`)
    emit('changed')
  } catch (e) {
    message.error((e as Error).message || '上传失败')
  } finally {
    uploading.value = false
  }
}

/** 补 / 换主体的参考图：落在主体上，所有用到他的段一起变 */
async function onEntityPicture(ev: Event) {
  const input = ev.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  const target = picTarget.value
  picTarget.value = null
  const pid = project.currentId
  if (!f || !target || !pid) return
  picBusy.value = true
  try {
    await registry.attachEntityImage(pid, target.id, f, f.name)
    message.success(`已给「${target.name}」挂上参考图 —— 用到他的段都会自动带上`)
    emit('changed')
  } catch (e) {
    message.error((e as Error).message || '上传失败')
  } finally {
    picBusy.value = false
  }
}

/* --------------------------- 文本草稿与提交 --------------------------- */

/**
 * 镜头描述 / 画面描述走本地草稿：直接绑 store 的话，每敲一个字符都会
 * 走一次全表 bulkPut（后端是 HTTP），几十段一起编会明显发涩。
 */
const dDirection = ref(b.value.direction ?? '')
const dVisual = ref(b.value.visualDesc ?? '')
let dirty = false
let timer: ReturnType<typeof setTimeout> | null = null

function sync() {
  dDirection.value = b.value.direction ?? ''
  dVisual.value = b.value.visualDesc ?? ''
  dirty = false
}

watch(() => b.value.id, sync)

// 外部改动（AI 重填 / 别的面板改了）时同步过来；自己提交的回声因为值相同，不会打架
watch(
  () => b.value.direction,
  (v) => {
    if (!dirty) dDirection.value = v ?? ''
  }
)
watch(
  () => b.value.visualDesc,
  (v) => {
    if (!dirty) dVisual.value = v ?? ''
  }
)

function flush() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!dirty) return
  dirty = false
  const patch: Partial<Beat> = {}
  if (dDirection.value !== (b.value.direction ?? '')) patch.direction = dDirection.value
  if (dVisual.value !== (b.value.visualDesc ?? '')) patch.visualDesc = dVisual.value
  if (Object.keys(patch).length) emit('patch', b.value.id, patch)
}

function touch() {
  dirty = true
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, 600)
}

/* ------------------------------ 单点 AI ------------------------------ */

/**
 * 卡片上的 ✨：只写**这一个字段**，不跑整批。
 *
 * 和顶部「阶段二：AI 填充细节」的分工：
 *   那颗是"从零铺满一页"（一次几十段，按批跑，慢且会顺手改别处）；
 *   这颗是"我已经看着这一拍了，把这一项补好"（改完立刻能看见）。
 * 两个入口都存在，因为它们对应的时刻不一样 —— 一个是开工，一个是返工。
 *
 * 同一张卡上两颗按钮各转各的：所以 busy 记的是"哪个字段在跑"，不是布尔。
 */
const aiBusy = ref<'' | BeatWriteField>('')

/** 这一拍出场的角色（长相 / 服装一起给，保证跨拍的描述不会自己变一套） */
const aiCast = computed(() => {
  const ids = new Set<ID>(b.value.entities ?? [])
  if (b.value.speakerId) ids.add(b.value.speakerId)
  if (b.value.focusEntityId) ids.add(b.value.focusEntityId)
  return [...ids]
    .map((id) => props.entityById.get(id))
    .filter((e): e is Entity => !!e && e.id !== b.value.sceneId)
    .map((e) => ({
      name: e.name,
      look: (e.textDesc ?? '').trim() || undefined,
      costume: (e.costumeDesc ?? '').trim() || undefined,
      pictureN: e.pictureN ?? 0,
      speaking: e.id === b.value.speakerId
    }))
})

const AI_PRESETS: Record<BeatWriteField, string[]> = {
  direction: ['换个更近的景别', '固定机位，不要运动', '手持跟拍，带一点晃'],
  visualDesc: ['别写动作，只写表情和视线', '补上环境里的具体物件', '台词拍：只写说话那一瞬间']
}

async function aiWrite(field: BeatWriteField, brief: string) {
  if (!provider.ready) {
    message.warning('请先在「模型设置」里配置文本模型')
    return
  }
  aiBusy.value = field
  try {
    const text = await pipeline.writeBeatField({
      field,
      beat: {
        title: b.value.title,
        kind: b.value.kind,
        dialogue: b.value.dialogue,
        frames: frames.value,
        fps: props.settings.fps,
        current: field === 'direction' ? dDirection.value : dVisual.value
      },
      scene: sceneName.value ?? undefined,
      cast: aiCast.value,
      prevTitle: props.prevTitle,
      nextTitle: props.nextTitle,
      requirement: brief || undefined,
      language: props.settings.workLanguage
    })
    // 写本地草稿再 flush：store 那一路有防抖，直接 emit 会被下一拍的回声盖掉
    if (field === 'direction') dDirection.value = text
    else dVisual.value = text
    dirty = true
    flush()
    message.success(field === 'direction' ? '镜头描述已写入' : '画面描述已写入')
  } catch (e) {
    message.error((e as Error).message || '生成失败', { duration: 8000 })
  } finally {
    aiBusy.value = ''
  }
}

onBeforeUnmount(() => {
  flush()
  for (const a of track.value) stopPlay(a.id)
})

/* ------------------------------ 键盘串联 ------------------------------ */

function jumpToNext(field: 'direction' | 'visualDesc', ev: KeyboardEvent) {
  flush()
  const nodes = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      `[data-ef="${field}"] input, [data-ef="${field}"] textarea`
    )
  )
  const i = nodes.indexOf(ev.target as HTMLInputElement)
  if (i < 0 || i >= nodes.length - 1) return
  const next = nodes[i + 1]
  next.focus()
  next.select()
}

function onDirectionKey(ev: KeyboardEvent) {
  // 输入法组词时的回车是选词，不是"跳下一段"
  if (ev.key !== 'Enter' || ev.isComposing) return
  ev.preventDefault()
  jumpToNext('direction', ev)
}

function onVisualKey(ev: KeyboardEvent) {
  if (ev.key !== 'Enter' || ev.isComposing) return
  if (!(ev.ctrlKey || ev.metaKey)) return
  ev.preventDefault()
  jumpToNext('visualDesc', ev)
}

/* ------------------------------- 写入 ------------------------------- */

function patch(p: Partial<Beat>) {
  emit('patch', b.value.id, p)
}

/* ------------------------- 场景 / 主体的加号挑选 ------------------------- */

/** 追加一个主体：先写进草稿再落库，连点两下不会互相覆盖 */
function addEntity(id: ID) {
  const cur = curEntities.value
  if (cur.includes(id)) return
  const next = [...cur, id]
  draftEntities.value = next
  patch({ entities: next })
}

/** 移出一个主体（只影响这一段，实体本身还在注册表里） */
function removeEntity(id: ID) {
  const next = curEntities.value.filter((x) => x !== id)
  draftEntities.value = next
  patch({ entities: next })
}

/**
 * 换场景：同样只换"这一段拍哪儿"，不动主体。
 * 场景是单选，没有顺序可继承，所以不需要像主体那样原位替换。
 */
function replaceScene(_from: ID, to: ID) {
  patch({ sceneId: to })
}

/** 换说话人：只换台词归属，主体列表里有没有这个人由"主体"那格自己管 */
function replaceSpeaker(_from: ID, to: ID) {
  patch({ speakerId: to })
}

/** 换聚焦主体：只是把镜头中心挪到别人身上，不动主体绑定 */
function replaceFocus(_from: ID, to: ID) {
  patch({ focusEntityId: to })
}

/**
 * 换主体：把 from 原位换成 to。
 * 原位替换而不是"先删再加"——主体顺序就是出图时的引用顺序（<Subject 1> 之类），
 * 删了再追加会把新主体挤到末尾，画面里"谁是主角"就跟着变了。
 */
function replaceEntity(from: ID, to: ID) {
  if (from === to) return
  const next: ID[] = []
  for (const id of curEntities.value) {
    const v = id === from ? to : id
    if (!next.includes(v)) next.push(v)
  }
  if (!next.includes(to)) next.push(to)
  draftEntities.value = next
  patch({ entities: next })
}

/** 换某个实体的参考图：落在实体上，所有用到它的段一起变 */
function swapPicture(id: ID) {
  const e = props.entityById.get(id)
  if (e) pickEntityPicture(e)
}

/** 点图块看大图（和素材缩略图同一套预览弹窗） */
function previewPicture(id: ID) {
  const a = registry.subjectImageFor(id)
  if (a) openAsset(a)
}

function setEnriched(v: boolean) {
  patch({ enriched: v })
}
</script>

<template>
  <article
    :id="'en-b-' + beat.id"
    class="ebc"
    :class="[`v-${variant}`, { 'is-auto': isAuto, 'is-todo': !!issue, 'is-picked': pickable && picked }]"
    :style="{ '--ebc-kind': kindColor }"
  >
    <header class="ebc-h">
      <!-- 批量出图：勾上就是"这一段要出图"，勾选态整张卡片描边，不用逐张确认 -->
      <label
        v-if="pickable"
        class="ebc-pick"
        :title="picked ? '取消勾选' : '勾上：批量出图时给这一段出关键帧'"
        @click.stop
      >
        <input
          type="checkbox"
          :checked="picked"
          @change="(e: Event) => emit('pick', beat.id, (e.target as HTMLInputElement).checked)"
        />
      </label>
      <span class="ebc-idx mono">{{ String(index + 1).padStart(2, '0') }}</span>
      <span class="tag-chip" :style="{ background: kindColor + '18', color: kindColor }">
        {{ BEAT_KIND_LABEL[beat.kind] }}
      </span>
      <n-tag
        v-if="splitPiece"
        size="tiny"
        type="warning"
        :bordered="false"
        :title="`原片段过长，被迫拆成 ${splitPiece.total} 段，这是第 ${splitPiece.index} 段`"
      >
        拆 {{ splitPiece.index }}/{{ splitPiece.total }}
      </n-tag>
      <span class="ebc-title">{{ beat.title || '（未命名）' }}</span>
      <n-tag v-if="isAuto" size="tiny" :bordered="false">自动</n-tag>
      <!--
        帧数就地改：这段够不够长，在细节填充里就能判断，为它切去拆解 / 详情改一趟不值当。
        平时长得跟原来那串「128f · 4.27s」一样，指上去才现边框；紧凑态只读。
      -->
      <div
        v-if="variant === 'full'"
        class="ebc-dur-edit"
        :class="{ 'is-focus': durFocus }"
        :title="framesTip"
      >
        <n-input
          class="ebc-dur-in"
          size="tiny"
          :value="dFrames"
          :allow-input="(v: string) => /^\d*$/.test(v)"
          :input-props="{ onKeydown: onFramesKey, inputmode: 'numeric' }"
          @update:value="onFramesInput"
          @focus="durFocus = true"
          @blur="onFramesBlur"
        />
        <span class="ebc-dur-unit mono">f</span>
        <span class="ebc-dur-sep mono">·</span>
        <span class="ebc-dur-sec mono">{{ seconds.toFixed(2) }}s</span>
        <!-- 手动过就留个退路：台词段能退回"按台词时长自动推算" -->
        <button
          v-if="beat.manualFrames"
          type="button"
          class="ebc-dur-reset"
          title="恢复自动推算（台词段按台词时长）"
          @click.stop="resetFrames"
        >
          ↺
        </button>
      </div>
      <span v-else class="ebc-dur mono">{{ frames }}f · {{ seconds.toFixed(2) }}s</span>
      <!-- 配音比片段长 = 话会被截断。这是硬错误，点一下就能按配音延长 -->
      <button
        v-if="voiceFit && voiceFit.longer"
        type="button"
        class="ebc-dur-warn mono"
        :title="`${voiceFitHint}。点一下按配音延长`"
        @click.stop="alignToSpeech"
      >
        配音长 {{ voiceFit.frames - voiceFit.current }}f
      </button>
      <span class="ebc-state" :class="stateClass">{{ stateLabel }}</span>
      <n-button
        v-if="variant === 'compact'"
        size="tiny"
        quaternary
        title="展开成全部字段"
        @click="emit('expand', beat.id)"
      >
        展开
      </n-button>
    </header>

    <!-- ------------------------------ 紧凑：只读摘要 ------------------------------ -->
    <div v-if="variant === 'compact'" class="ebc-compact">
      <span v-if="beat.kind === 'dialogue'" class="ebc-quote-t compact">
        「{{ beat.dialogue || '（无台词）' }}」
        <b v-if="speakerName">— {{ speakerName }}</b>
      </span>
      <span class="ebc-kv" :class="{ warn: !sceneName }">
        <i>场景</i>{{ sceneName ?? '未指定' }}
      </span>
      <span v-for="s in subjectChips" :key="s.id" class="ebc-kv">
        <i>主体</i>
        <span
          class="ebc-av"
          :class="{ 'is-none': !s.img }"
          :title="s.img ? `参考图自动跟随主体（${s.pic ?? '未编号'}）` : '这个主体还没有参考图'"
        >
          <img v-if="s.img" :src="s.img" alt="" />
        </span>
        {{ s.text }}<em v-if="s.pic">·{{ s.pic }}</em>
      </span>
      <span v-if="!subjectChips.length && !isAuto" class="ebc-kv dim"><i>主体</i>纯场景镜</span>
      <span v-if="compactRefText" class="ebc-kv dim"><i>素材</i>{{ compactRefText }}</span>
      <span v-else class="ebc-kv dim"><i>素材</i>没有段内素材</span>
    </div>

    <!-- ------------------------------ 展开：全字段 ------------------------------ -->
    <div v-else class="ebc-body">
      <div v-if="beat.kind === 'dialogue'" class="ebc-quote">
        <span class="ebc-quote-t">「{{ beat.dialogue || '（无台词）' }}」</span>
        <span v-if="speakerName" class="ebc-quote-s">— {{ speakerName }}</span>
        <span v-else class="ebc-quote-s warn">还没选说话人</span>
      </div>

      <div class="ebc-grid" :class="beat.kind === 'dialogue' ? 'n4' : 'n3'">
        <div class="ebc-f is-single-pick" data-ef="scene">
          <span class="ebc-lb">
            场景<i v-if="!sceneName" class="ebc-need">必填</i>
          </span>
          <!--
            场景是单选，只有一张图，所以这一列不参与分摊（宽度 auto），
            空出来的横向空间全给右边的多选主体。
            选上之后「＋」就收走：一个位置只放一个场景，留着加号点开也只是把原来那个顶掉，
            换场景走图块上的「换」——同样是弹出这个候选面板，只换场景、不动主体。
          -->
          <PickTiles
            :selected="sceneTiles"
            :options="scenePickOptions"
            :warn="!sceneName"
            :hide-add="sceneTiles.length > 0"
            swap-to="entity"
            placeholder="选场景"
            title="场景"
            @pick="(id: ID) => patch({ sceneId: id })"
            @unpick="patch({ sceneId: undefined })"
            @replace="replaceScene"
            @swap="swapPicture"
            @preview="previewPicture"
          />
        </div>

        <div class="ebc-f" data-ef="subjects">
          <span class="ebc-lb">主体</span>
          <!--
            主体那颗「换」不是换图，是**换人**：弹出同一个选择器，点谁就把谁顶掉。
            换参考图是实体层面的事（一处改、用到它的段全变），不该混在"这一段用谁"里。
          -->
          <PickTiles
            :selected="subjectTiles"
            :options="entityPickOptions"
            multiple
            swap-to="entity"
            placeholder="角色 / 道具"
            title="主体（角色 / 道具 / 场景物件）"
            @pick="addEntity"
            @unpick="removeEntity"
            @replace="replaceEntity"
            @swap="swapPicture"
            @preview="previewPicture"
          />
        </div>

        <div v-if="beat.kind === 'dialogue'" class="ebc-f" data-ef="speaker">
          <span class="ebc-lb">
            说话人<i v-if="!beat.speakerId" class="ebc-need">必填</i>
          </span>
          <!-- 说话人也是"选一个具体的人"：图块比下拉框多给一张脸，选之前就知道是谁 -->
          <PickTiles
            :selected="speakerTiles"
            :options="speakerPickOptions"
            :warn="!beat.speakerId"
            :hide-add="speakerTiles.length > 0"
            swap-to="entity"
            placeholder="谁说的"
            title="说话人（会说话的角色）"
            @pick="(id: ID) => patch({ speakerId: id })"
            @unpick="patch({ speakerId: undefined })"
            @replace="replaceSpeaker"
            @swap="swapPicture"
            @preview="previewPicture"
          />
        </div>

        <div class="ebc-f" data-ef="focus">
          <span class="ebc-lb">
            聚焦主体
            <i v-if="focusText && !beat.focusEntityId" class="ebc-lb-sub" :title="`不选就是自动：${focusText}`">
              自动 · {{ focusText }}
            </i>
          </span>
          <!-- 空着不是"没填"，是"跟随自动"：所以空态那颗虚线块直接写「自动」 -->
          <PickTiles
            :selected="focusTiles"
            :options="focusPickOptions"
            :hide-add="focusTiles.length > 0"
            swap-to="entity"
            placeholder="自动"
            title="聚焦主体（本段出现的角色 / 场景）"
            @pick="(id: ID) => patch({ focusEntityId: id })"
            @unpick="patch({ focusEntityId: undefined })"
            @replace="replaceFocus"
            @swap="swapPicture"
            @preview="previewPicture"
          />
        </div>
      </div>

      <div class="ebc-texts">
        <div class="ebc-f" data-ef="direction">
          <!--
            这两个框没有标签：一个摄像机、一个图片，图标自己就把"写机位还是写画面"
            说完了，再压一行「镜头描述（英文）」纯属重复 —— 卡片本来就窄，
            两行标签占掉的高度够多写一行的。英文这件事交给占位文案和 title。
          -->
          <n-input
            class="ebc-in"
            size="small"
            :value="dDirection"
            title="镜头描述（英文）：景别 / 机位 / 运镜"
            placeholder="medium shot, slow push in"
            :input-props="{ onKeydown: onDirectionKey }"
            @update:value="(v: string) => { dDirection = v; touch() }"
            @blur="flush"
          >
            <template #prefix>
              <span class="ebc-in-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="m22 8-6 4 6 4V8Z" />
                  <rect width="14" height="12" x="2" y="6" rx="2" ry="2" />
                </svg>
              </span>
            </template>
            <template #suffix>
              <AiWrite
                title="镜头描述"
                hint="只写景别 + 角度 + 一个运镜，不碰动作和台词。"
                :presets="AI_PRESETS.direction"
                :busy="aiBusy === 'direction'"
                :disabled="!provider.ready || (!!aiBusy && aiBusy !== 'direction')"
                :disabled-reason="provider.ready ? '另一个字段正在生成' : '还没配置文本模型'"
                :placement="'bottom-end'"
                @run="(brief: string) => aiWrite('direction', brief)"
              />
            </template>
          </n-input>
        </div>
        <div class="ebc-f" data-ef="visualDesc">
          <n-input
            class="ebc-in is-area"
            size="small"
            type="textarea"
            :rows="2"
            :value="dVisual"
            title="画面描述（英文）：这一帧里发生什么"
            placeholder="she leans against the wall, retaining the reference costume details"
            :input-props="{ onKeydown: onVisualKey }"
            @update:value="(v: string) => { dVisual = v; touch() }"
            @blur="flush"
          >
            <template #prefix>
              <span class="ebc-in-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
                </svg>
              </span>
            </template>
            <template #suffix>
              <AiWrite
                title="画面描述"
                hint="只写画面上看得见的东西：姿态、表情、道具、光线；不写机位与台词。"
                :presets="AI_PRESETS.visualDesc"
                :busy="aiBusy === 'visualDesc'"
                :disabled="!provider.ready || (!!aiBusy && aiBusy !== 'visualDesc')"
                :disabled-reason="provider.ready ? '另一个字段正在生成' : '还没配置文本模型'"
                :placement="'bottom-end'"
                @run="(brief: string) => aiWrite('visualDesc', brief)"
              />
            </template>
          </n-input>
        </div>
      </div>
    </div>

    <!--
      素材带：上下两块 —— **关键帧素材** / **参考素材**。

      分法不是"图片一档、声音一档"，而是**作用方式**：
        关键帧素材：这一段自己的内容，落在时间轴上 —— 关键帧图片（锁在某一帧）、
                    台词配音 / 音视频（从某一帧起生效）；
        参考素材：  只借给模型看或听、不占时间轴 —— 参考图（占 Picture 槽）、
                    参考音视频（只进参考通道）。

      两块都有三颗口：
        ＋关键帧 / ＋参考 —— **上传**：已经有成品文件，直接传进来（图 / 音频 / 视频都收）；
        ＋图片配置 / ＋音频配置 —— **先配置**：没有本体，先写图片提示词 / 配音文本与音色，
                                  保存后出现一格虚线占位，点那格回来改，也能直接合成。

      主体自带的参考图**不在这张卡上**：它在主体格里，主体选择时已经看见了，
      这里不再复述一遍；这里只放"这一段自己传的 / 自己配的"。
    -->
    <div class="ebc-mats">
      <section v-for="m in matModules" :key="m.key" class="ebc-mat-sec" :data-mat="m.key">
        <header class="ebc-mat-hd">
          <span class="ebc-mat-lb" :title="m.tip">{{ m.label }}</span>
          <!-- 上传口 + 两个配置口：收文件的在左，配置的在右，两块按钮竖着对得齐 -->
          <div class="ebc-mat-adds">
            <button
              v-if="m.upload"
              type="button"
              class="ebc-mat-add is-txt is-upload"
              :disabled="uploading"
              :title="m.upload.tip"
              :data-ebc-upload="m.key"
              @click="m.upload.run()"
            >
              <span class="ebc-mat-plus">＋</span><span>{{ uploading ? '传中' : m.upload.text }}</span>
            </button>
            <button
              v-for="c in m.configs"
              :key="c.key"
              type="button"
              class="ebc-mat-add is-txt is-config"
              :title="c.tip"
              :data-ebc-config="c.key"
              @click="c.run"
            >
              <span class="ebc-mat-plus">＋</span><span>{{ c.text }}</span>
            </button>
          </div>
        </header>
        <div v-if="m.items.length" class="ebc-mat-items">
          <div v-for="a in m.items" :key="a.id" class="ebc-mat-cell">
            <!--
              参考素材：它是"引用"进来的东西 —— 只借给模型看 / 听，不占时间轴。
              所以这一支刻意比关键帧那支轻：图片就是一张小缩略 + P 编号（没有帧位条，
              参考不锁帧），音视频就是一条能试听的窄卡 + 「参」，不给"从第 N 帧起"。
              要成为这一段的画面，把作用方式切成关键帧，它才会搬到上面那块去。
            -->
            <template v-if="m.key === 'ref'">
              <div
                v-if="a.media === 'image'"
                class="ebc-mat-tile is-ref"
                role="button"
                tabindex="0"
                :title="`参考图 · ${a.label || a.originalName}${a.pictureN ? ` · P${a.pictureN}` : ''} · 只借给模型看，不锁帧`"
                @click="openAsset(a)"
                @keydown.enter.prevent="openAsset(a)"
              >
                <img :src="registry.assetUrl(a) ?? undefined" alt="" />
                <b class="ebc-mat-badge is-refbadge">
                  {{ a.pictureN ? `P${a.pictureN}` : '参' }}
                </b>
              </div>
              <div
                v-else
                class="ebc-mat-card is-ref"
                :class="{ 'is-video': a.media === 'video', 'is-playing': isPlaying(a.id) }"
                :title="`参考${refKindText(a)} · ${a.label || a.originalName} · 只借给模型听 / 看，不占时间轴`"
              >
                <div class="ebc-mat-card-top" @click="openAsset(a)">
                  <button
                    type="button"
                    class="ebc-mat-play"
                    :class="{ on: isPlaying(a.id) }"
                    :title="
                      a.media === 'video'
                        ? '打开预览播放视频'
                        : isPlaying(a.id)
                          ? `暂停（${clockOf(playElapsed)} / ${clockOf(playTotal)}）`
                          : '就地试听这条参考音频'
                    "
                    @click.stop="onPlay(a)"
                  >
                    <i v-if="isPlaying(a.id)" class="ico-pause" />
                    <i v-else class="ico-play" />
                  </button>
                  <span class="ebc-mat-kind">{{ mediaKindLabel(a) }}</span>
                  <span class="ebc-mat-card-name">{{ a.label || a.originalName }}</span>
                  <b class="ebc-mat-media-badge is-refbadge" title="参考素材：只进参考通道，不占时间轴">
                    参
                  </b>
                </div>
                <span
                  v-if="isPlaying(a.id)"
                  class="ebc-mat-progress"
                  :style="{ width: `${Math.round(playProgress * 100)}%` }"
                />
              </div>
              <button
                type="button"
                class="ebc-mat-del"
                :disabled="removing === a.id"
                title="删掉这条参考素材（只影响这一段）"
                @click.stop="removeMaterial(a)"
              >
                ×
              </button>
            </template>

            <!--
              音视频（台词配音也走这条）：左上角那颗 ▶ 直接在卡上放，试听一条配音
              不该付出"开弹窗 + 关弹窗"；下面一行「从 [第 N 帧] 起」，起始帧同样是选的。
            -->
            <template v-else-if="a.media !== 'image'">
              <div
                class="ebc-mat-card"
                :class="{
                  'is-video': a.media === 'video',
                  'is-playing': isPlaying(a.id)
                }"
                :title="`${a.media === 'video' ? '视频' : '音频'} · ${a.label || a.originalName} · ${startFrameLabel(a, frames)}`"
              >
                <div class="ebc-mat-card-top" @click="openAsset(a)">
                  <button
                    type="button"
                    class="ebc-mat-play"
                    :class="{ on: isPlaying(a.id) }"
                    :title="
                      a.media === 'video'
                        ? '打开预览播放视频'
                        : isPlaying(a.id)
                          ? `暂停（${clockOf(playElapsed)} / ${clockOf(playTotal)}）`
                          : '就地试听这条音频'
                    "
                    @click.stop="onPlay(a)"
                  >
                    <i v-if="isPlaying(a.id)" class="ico-pause" />
                    <i v-else class="ico-play" />
                  </button>
                  <span class="ebc-mat-kind">{{ mediaKindLabel(a) }}</span>
                  <span class="ebc-mat-card-name">{{ a.label || a.originalName }}</span>
                  <!-- 紧凑形态：强度 + 起始帧都并进这颗角标，点开就是同一条素材的强度面板 -->
                  <n-popover
                    trigger="click"
                    placement="top"
                    :show-arrow="false"
                    :disabled="variant !== 'compact'"
                    raw
                  >
                    <template #trigger>
                      <b
                        class="ebc-mat-media-badge"
                        :class="{
                          'is-usage': variant === 'compact',
                          'is-soft': strengthOf(a) < STRENGTH_HARD
                        }"
                        :title="variant === 'compact' ? `${strengthTip(a)}；点这里改强度 / 参考` : undefined"
                        @click="onMediaBadgeClick"
                      >
                        {{ mediaBadgeText(a) }}
                      </b>
                    </template>
                    <StrengthPopover
                      :asset="a"
                      :media-act-as="true"
                      @change="(v: number) => setStrength(a, v)"
                      @act-as="(v: AssetActAs) => setActAs(a, v)"
                    />
                  </n-popover>
                </div>
                <div class="ebc-mat-card-bot">
                  <n-popover trigger="click" placement="top" :show-arrow="false" raw>
                    <template #trigger>
                      <button
                        type="button"
                        class="ebc-usage"
                        :class="{ 'is-soft': strengthOf(a) < STRENGTH_HARD }"
                        :title="strengthTip(a)"
                        @click.stop
                      >
                        {{ strengthText(a) }}
                      </button>
                    </template>
                    <StrengthPopover
                      :asset="a"
                      :media-act-as="true"
                      @change="(v: number) => setStrength(a, v)"
                      @act-as="(v: AssetActAs) => setActAs(a, v)"
                    />
                  </n-popover>
                  <span class="ebc-mat-card-lb">从</span>
                  <n-select
                    size="tiny"
                    class="ebc-mat-sel is-media"
                    :value="startFrame(a)"
                    :options="frameOptions"
                    :consistent-menu-width="false"
                    @update:value="(v: number) => setStart(a, v)"
                  />
                  <span class="ebc-mat-card-lb">帧起</span>
                </div>
                <span
                  v-if="isPlaying(a.id)"
                  class="ebc-mat-progress"
                  :style="{ width: `${Math.round(playProgress * 100)}%` }"
                />
              </div>
              <button
                type="button"
                class="ebc-mat-del"
                :disabled="removing === a.id"
                title="删掉这条音视频（只影响这一段）"
                @click.stop="removeMaterial(a)"
              >
                ×
              </button>
            </template>

            <!--
              关键帧图片：帧位就叠在图里选。
              底下再挂一条独立行的话，缩略图永远只有 46 高、还要多占一行空白，
              所以把"第几帧"做成图内下沿的选择器，一格里把话说全。
              参考图不在这条路上：它不落在任何一帧上，在上面的「引用」行里。
            -->
            <template v-else>
              <div
                class="ebc-mat-tile is-kf"
                role="button"
                tabindex="0"
                :title="`关键帧 · ${a.label || a.originalName}；点开看大图，下面选落点`"
                @click="openAsset(a)"
                @keydown.enter.prevent="openAsset(a)"
              >
                <img :src="registry.assetUrl(a) ?? undefined" alt="" />
                <!-- 出图之后这段的提示词或台词改过：这张图是旧的，悬停看是哪一个变了 -->
                <span v-if="driftOf(a).any" class="ebc-mat-stale" :title="driftOf(a).text">旧</span>
                <!--
                  紧凑形态没有底行：强度并进角标（`60·F12`），而且角标本身可点 ——
                  每一张关键帧都能就地拨「强制 / 参考」，不至于为了改一条强度切回展开态。
                -->
                <n-popover
                  v-if="variant === 'compact'"
                  trigger="click"
                  placement="top"
                  :show-arrow="false"
                  raw
                >
                  <template #trigger>
                    <b
                      class="ebc-mat-badge is-btn"
                      role="button"
                      tabindex="0"
                      :title="`${strengthTip(a)}；点这里改强度 / 参考`"
                      @click.stop
                      @keydown.stop
                    >
                      {{ strengthOf(a) }}·{{ kfBadge(a) }}
                    </b>
                  </template>
                  <StrengthPopover
                    :asset="a"
                    @change="(v: number) => setStrength(a, v)"
                    @act-as="(v: AssetActAs) => setActAs(a, v)"
                  />
                </n-popover>
                <div
                  v-else
                  class="ebc-mat-frbar"
                  :title="`落点：第 ${kfFrame(a)} 帧（共 ${frames} 帧）· 两张图落同一帧只有一张生效`"
                  @click.stop
                  @keydown.stop
                >
                  <n-popover trigger="click" placement="top" :show-arrow="false" raw>
                    <template #trigger>
                      <button
                        type="button"
                        class="ebc-usage"
                        :class="{ 'is-soft': strengthOf(a) < STRENGTH_HARD }"
                        :title="strengthTip(a)"
                        @click.stop
                      >
                        {{ strengthText(a) }}
                      </button>
                    </template>
                    <StrengthPopover
                      :asset="a"
                      @change="(v: number) => setStrength(a, v)"
                      @act-as="(v: AssetActAs) => setActAs(a, v)"
                    />
                  </n-popover>
                  <n-select
                    size="tiny"
                    class="ebc-mat-sel"
                    :value="kfFrame(a)"
                    :options="frameOptionsShort"
                    :consistent-menu-width="false"
                    @update:value="(v: number) => setKfFrame(a, v)"
                  />
                </div>
              </div>
              <!-- 删除：只动这一段的素材，参考图不在这里删（它挂在主体上） -->
              <button
                type="button"
                class="ebc-mat-del"
                :disabled="removing === a.id"
                title="删掉这张关键帧（只影响这一段）"
                @click.stop="removeMaterial(a)"
              >
                ×
              </button>
            </template>
          </div>
        </div>
        <!--
          待合成占位：**配置完之后才出现的一格**（不是"这一类空着就画一格"）。
          它对应一条 draft 素材 —— 提示词 / 配音文本与音色都存在里面，所以刷新、
          换设备都还在，点它回到同一个配置弹窗继续改；右下角 × 只删这格配置。
        -->
        <div v-if="m.slots.length" class="ebc-mat-slots">
          <div v-for="s in m.slots" :key="s.id" class="ebc-mat-slot" :class="`is-${s.media}`">
            <button
              type="button"
              class="ebc-mat-slot-main"
              :title="`${slotTitle(s)}：点这一格继续改配置（图片写提示词 / 音频写要念的文本与音色）`"
              :data-ebc-slot="s.media"
              @click="openSlotConfig(actAsOf(s), s.media === 'audio' ? 'audio' : 'image', s)"
            >
              <span class="ebc-mat-slot-ico">
                <svg
                  v-if="s.media === 'image'"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
                </svg>
                <svg
                  v-else
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              </span>
              <span class="ebc-mat-slot-lb">{{ slotTitle(s) }}</span>
              <span class="ebc-mat-slot-txt">{{
                slotText(s) || (s.media === 'audio' ? '还没写要念的文本' : '还没写提示词')
              }}</span>
            </button>
            <!--
              帧位：占位格上就能选，不用为了改一帧再开一次弹窗。
              它和弹窗里那颗下拉写的是同一个 frameIdx —— 里面改外面立刻变，
              外面改里面打开也是这个值（"内外互联"就是这么落实的）。
            -->
            <div class="ebc-mat-slot-bot" @click.stop>
              <span class="ebc-mat-card-lb">{{ s.media === 'audio' ? '从' : '' }}</span>
              <n-select
                size="tiny"
                class="ebc-mat-sel is-slot"
                :value="slotFrame(s)"
                :options="frameOptionsShort"
                :consistent-menu-width="false"
                :title="s.media === 'audio' ? `合成后从第 ${slotFrame(s)} 帧起生效` : `合成后落在第 ${slotFrame(s)} 帧`"
                :data-ebc-slot-frame="s.id"
                @update:value="(v: number) => setSlotFrame(s, v)"
              />
              <span class="ebc-mat-card-lb">{{ s.media === 'audio' ? '帧起' : '帧' }}</span>
            </div>
            <button
              type="button"
              class="ebc-mat-slot-del"
              title="删掉这格配置（它还没有本体，不影响已合成好的素材）"
              @click.stop="removeSlot(s)"
            >
              ×
            </button>
          </div>
        </div>
      </section>
    </div>

    <!-- 动作行收尾：素材带看清了再决定"这段确认" -->
    <footer v-if="variant === 'full'" class="ebc-foot">
      <n-button
        v-if="beat.kind === 'dialogue'"
        size="tiny"
        quaternary
        :loading="voicing"
        :disabled="!canVoice || voicing"
        :title="voiceHint"
        @click="makeVoiceover"
      >
        {{ hasVoiceoverNow ? '重配台词' : '合成台词' }}
      </n-button>
      <!-- 帧长由这句配音决定：按钮上直接给应到的帧数，省得去猜差多少 -->
      <n-button
        v-if="voiceFit"
        size="tiny"
        quaternary
        :disabled="voiceFit.frames === voiceFit.current"
        :title="voiceFitHint"
        @click="alignToSpeech"
      >
        按配音 {{ voiceFit.frames }}f
      </n-button>
      <div style="flex: 1" />
      <n-button
        size="tiny"
        :type="beat.enriched ? 'success' : 'default'"
        :quaternary="!beat.enriched"
        :ghost="beat.enriched"
        @click="setEnriched(!beat.enriched)"
      >
        {{ beat.enriched ? '已确认' : '标记已确认' }}
      </n-button>
    </footer>

    <!-- 两个上传口：都收任意材料（图 / 音频 / 视频），落在哪一块由按钮决定 -->
    <input
      ref="kfInput"
      data-ebc-files
      type="file"
      accept="image/*,audio/*,video/*"
      multiple
      style="display: none"
      @change="onKeyframeFiles"
    />
    <input
      ref="refInput"
      data-ebc-refs
      type="file"
      accept="image/*,audio/*,video/*"
      multiple
      style="display: none"
      @change="onRefFiles"
    />
    <input
      ref="picInput"
      data-ebc-pic
      type="file"
      accept="image/*"
      style="display: none"
      @change="onEntityPicture"
    />

    <!-- 出图：唯一那条关键帧出图流程，提示词取这一格占位自己写的那句 -->
    <ImageGenModal
      v-if="genPlacement"
      :show="true"
      :title="`关键帧 · ${PLACEMENT_LABEL[genPlacement]}`"
      :default-prompt="genPrompt"
      :base-image-url="genBaseUrl"
      :refs="images.refCandidatesFor(beat.id)"
      :default-picked="genDefaultRefs"
      default-size="1280x720"
      @done="onGenerated"
      @update:show="(v: boolean) => { if (!v) closeGen() }"
    />

    <!-- 配置弹窗：新建 / 改某一格占位，保存后才出现那格虚线占位 -->
    <SlotConfigDialog
      v-model:show="slotOpen"
      :beat="beat"
      :act-as="slotActAs"
      :media="slotMedia"
      :slot="slotEditing"
      :entity-by-id="entityById"
      :frames="frames"
      @submit="onSlotSubmit"
    />
  </article>
</template>

<style scoped>
.ebc {
  padding: 8px 12px 9px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-left: 3px solid var(--ebc-kind, var(--line));
  border-radius: 10px;
  box-shadow: var(--shadow);
  /*
   * 进度条式的"看视口"在分栏后会失灵：窗口 1600 宽时卡片只有 ~540 宽，
   * 媒体查询还以为很宽，于是字段仍按三四栏挤在一格里。这里按卡片自身宽度降列。
   */
  container-type: inline-size;
}
.ebc.is-todo {
  border-color: var(--err-line);
}
.ebc.is-auto {
  background: var(--panel-2);
}

/* 头 */
.ebc-h {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-height: 24px;
}
/* 批量勾选：只占一个方块，不挤掉序号与标题 */
.ebc-pick {
  display: inline-flex;
  align-items: center;
  margin-right: -2px;
  cursor: pointer;
}
.ebc-pick input {
  width: 15px;
  height: 15px;
  margin: 0;
  cursor: pointer;
  accent-color: var(--accent);
}
.ebc.is-picked {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(47, 111, 237, 0.14), var(--shadow);
}
.ebc-idx {
  color: var(--muted);
  font-size: 11.5px;
  min-width: 18px;
}
.ebc-title {
  font-weight: 600;
  font-size: 13.5px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ebc-dur {
  margin-left: auto;
  color: var(--muted);
  font-size: 11.5px;
  white-space: nowrap;
}
/*
 * 帧数输入：不做成"可见的输入框"——标题行已经够挤，一个带底色的框会把
 * 眼睛从标题上拽走。平时透明无边框、右对齐（数字位不跳），
 * 指上去给一条弱边框、获焦给主色边框，才显出"这里能改"。
 *
 * 必须 !important：naive-ui 把这套主题变量算好后内联写在 .n-input 上。
 */
.ebc-dur-edit {
  display: flex;
  align-items: center;
  flex: none;
  gap: 2px;
  margin-left: auto;
  color: var(--muted);
  font-size: 11.5px;
  white-space: nowrap;
}
.ebc-dur-in {
  width: 42px;
  --n-height: 20px !important;
  --n-font-size: 11.5px !important;
  --n-padding-left: 3px !important;
  --n-padding-right: 2px !important;
  --n-color: transparent !important;
  --n-color-focus: var(--panel) !important;
  --n-border: 1px solid transparent !important;
  --n-border-hover: 1px solid var(--line-strong) !important;
  --n-border-focus: 1px solid var(--accent) !important;
  --n-text-color: var(--muted) !important;
  --n-text-color-focus: var(--text) !important;
}
.ebc-dur-in :deep(.n-input__input-el) {
  padding: 0 !important;
  text-align: right;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-size: 11.5px;
}
/*
 * 焦点态兜底：naive-ui 靠 JS 打上的 .n-input--focus 类来翻底色 / 描边，
 * 某些环境（程序化聚焦、无头截图）那个类根本不出现，光标都在这儿了框还是平的。
 * 所以自己盯着 @focus / @blur 换 class，不依赖它的状态类。
 */
.ebc-dur-edit.is-focus .ebc-dur-in {
  background-color: var(--panel) !important;
}
.ebc-dur-edit.is-focus .ebc-dur-in :deep(.n-input__state-border) {
  border-color: var(--accent) !important;
}
.ebc-dur-in:focus-within {
  background-color: var(--panel) !important;
}
.ebc-dur-in:focus-within :deep(.n-input__state-border) {
  border-color: var(--accent) !important;
}
.ebc-dur-unit {
  color: var(--muted);
  font-size: 11.5px;
}
.ebc-dur-sep {
  color: var(--line-strong);
  font-size: 11px;
}
.ebc-dur-sec {
  color: var(--muted-3);
  font-size: 10.5px;
}
.ebc-dur-reset {
  width: 14px;
  height: 14px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--muted-3);
  font-size: 11px;
  line-height: 14px;
  cursor: pointer;
}
.ebc-dur-reset:hover {
  background: var(--hover);
  color: var(--text-2);
}
/* 配音比片段长：台词会被截断，点一下按配音延长 */
.ebc-dur-warn {
  flex: none;
  margin-left: 4px;
  height: 16px;
  padding: 0 4px;
  border: 1px solid var(--err-line);
  border-radius: 3px;
  background: var(--err-soft);
  color: var(--err-ink);
  font-size: 10px;
  line-height: 14px;
  white-space: nowrap;
  cursor: pointer;
}
.ebc-dur-warn:hover {
  filter: brightness(0.96);
}
.ebc-state {
  flex: none;
  font-size: 11px;
  line-height: 17px;
  padding: 0 8px;
  border-radius: 999px;
  white-space: nowrap;
}
.ebc-state.is-err {
  background: var(--err-soft);
  color: var(--err-ink);
}
.ebc-state.is-warn {
  background: var(--warn-soft);
  color: var(--warn-ink);
}
.ebc-state.is-ok {
  background: var(--ok-line);
  color: var(--ok-ink);
}
.ebc-state.is-auto {
  background: var(--panel-3);
  color: var(--label);
}

/* 紧凑摘要 */
.ebc-compact {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.ebc-kv {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  font-size: 11.5px;
  line-height: 18px;
  color: var(--text);
  background: var(--panel-2);
  border-radius: 5px;
  white-space: nowrap;
  /* 分栏后一行只有 ~440 宽：允许换行，但别把芯片压扁 —— 压扁后 nowrap 的文字会溢出去盖住隔壁 */
  flex: none;
}
.ebc-kv i {
  font-style: normal;
  color: var(--muted-3);
  font-size: 10.5px;
}
.ebc-kv em {
  font-style: normal;
  color: var(--muted);
  font-size: 10.5px;
}
.ebc-kv.dim {
  background: transparent;
  color: var(--muted);
}
.ebc-kv.warn {
  background: var(--err-soft);
  color: var(--err-ink);
}

/* 主体参考图缩略：14px 小圆点，够看出"有没有图"，不占行高 */
.ebc-av {
  width: 14px;
  height: 14px;
  flex: none;
  border-radius: 3px;
  overflow: hidden;
  background: var(--hover);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);
  display: inline-block;
  vertical-align: -2px;
}
.ebc-av img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
/* 没图：虚线圈，比"空白"更明确地表示"这个主体缺图" */
.ebc-av.is-none {
  background: transparent;
  border: 1px dashed var(--warn);
  box-shadow: none;
}

/* 展开正文 */
.ebc-body {
  margin-top: 7px;
}
.ebc-quote {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 7px;
  padding: 4px 9px;
  background: var(--ok-soft);
  border: 1px solid var(--ok-soft);
  border-radius: 7px;
}
.ebc-quote-t {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ok-ink);
  font-family: var(--mono);
  word-break: break-word;
}
.ebc-quote-t.compact {
  color: var(--ok);
  flex: 1 1 220px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ebc-quote-s {
  font-size: 11.5px;
  color: var(--muted);
  flex: none;
}
.ebc-quote-s.warn {
  color: var(--err);
}

.ebc-grid {
  display: grid;
  gap: 7px 10px;
}
/* 台词段多一栏「说话人」；按字段数给不同列宽，别让最后一个字段右边空一列 */
.ebc-grid.n3 {
  /*
   * 场景 / 聚焦主体都是单选图块（各一张 92 的图），列宽用 auto 就够，
   * 剩下的宽度全给多选的主体 —— 它才是会被图块塞满的那一格。
   */
  grid-template-columns: auto minmax(0, 1fr) auto;
}
.ebc-grid.n4 {
  grid-template-columns: auto minmax(0, 1fr) auto auto;
}
.ebc-f {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ebc-lb {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--muted);
  line-height: 16px;
  white-space: nowrap;
}
.ebc-lb-sub {
  font-style: normal;
  font-size: 10.5px;
  color: var(--muted-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 标签栏被挤窄时让"自动 · 某某"先省略，别把标签本身顶成两行 */
  flex: 0 1 auto;
  min-width: 0;
  /* 聚焦主体那一列是 auto 宽：这句提示不封顶的话，整行会被它顶宽 */
  max-width: 78px;
}
.ebc-need {
  font-style: normal;
  font-size: 10px;
  padding: 0 5px;
  color: var(--err-ink);
  background: var(--err-soft);
  border-radius: 3px;
}

.ebc-texts {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
  /* 标签去掉之后，两个框之间就只剩这点间隙了：跟下面「素材」块的 9px 对齐，
     整张卡从上到下一个节奏，不会有一处突然贴住。 */
  gap: 9px 10px;
  margin-top: 9px;
}

/*
 * 镜头 / 画面描述：填色框 + 框内图标。
 *
 * 底色：白卡上再放一个白框，只剩一圈 1px 线，两个框跟卡片糊成一片；
 * 换成 panel-2 的浅底（和下面「素材」那块同一个底），框才"凹"进去。
 * 边框仍留一根 --line 的细线：只填底不描边会像一条只读的文字条。
 * 获焦时底翻回白 + 主色描边，正在编辑的那一段自己浮起来。
 * 图标走 n-input 的 prefix 槽：槽本身没有样式，宽度由图标撑开，
 * 不另起一列、不动外面的网格。
 *
 * 必须 !important：naive-ui 把这套主题变量算好后**内联**写在 .n-input 的
 * style 上，内联声明压过类选择器 —— 不加 !important 就是写了个寂寞。
 */
.ebc-in {
  --n-color: var(--panel-2) !important;
  --n-color-hover: var(--panel-2) !important;
  --n-color-focus: var(--panel) !important;
  --n-border: 1px solid var(--line) !important;
  --n-border-hover: 1px solid var(--line-strong) !important;
  --n-border-focus: 1px solid var(--accent) !important;
}
/* 焦点态自己再兜一层：naive-ui 靠 n-input--focus 类，这里按下标走 :focus-within，
   两边值一样，谁先到都是「白底 + 主色描边」，不指望内部状态类一定准时。 */
.ebc-in:focus-within {
  --n-color: var(--panel) !important;
  --n-border: 1px solid var(--accent) !important;
}
.ebc-in-ico {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  margin-right: 5px;
  color: var(--muted-2);
  transition: color 0.15s ease;
}
.ebc-in-ico svg {
  width: 13px;
  height: 13px;
}
.ebc-in:focus-within .ebc-in-ico {
  color: var(--accent);
}
/* 多行框：图标对齐第一行，跟着框高居中会飘到两行正中间，像另一个控件。
   7px = 框内上内边距 + 半行高，减图标半高（实测对齐第一行文字中线）。 */
.ebc-in.is-area :deep(.n-input__prefix) {
  align-self: flex-start;
}
.ebc-in.is-area .ebc-in-ico {
  margin-top: 7px;
}
.ebc-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px dashed var(--line);
}

/* ------------------------------ 素材带 ------------------------------ */

/*
 * 素材带只剩一行：这一段专属的关键帧 / 音视频 / 段级参考图。
 * 主体的参考图已经在主体格里，不在这里重复。
 */
/*
 * 素材带：一个灰底盒子，里面上下两个模块（关键帧 / 参考素材），虚线分开。
 * 每个模块自己的标题行带上传口 —— 老版是左列 42px 里塞"标签 + 上传"，
 * 两个模块各有各的口，那点宽度放不下两个"＋上传"，标题也会被截。
 */
.ebc-mats {
  display: flex;
  flex-direction: column;
  margin-top: 9px;
  padding: 5px 8px 6px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.ebc-mat-sec {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 2px 0 3px;
  min-width: 0;
}
.ebc-mat-sec + .ebc-mat-sec {
  margin-top: 3px;
  padding-top: 6px;
  border-top: 1px dashed var(--line-strong);
}
.ebc-mat-hd {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ebc-mat-lb {
  flex: none;
  font-size: 11px;
  line-height: 15px;
  color: var(--muted-2);
  white-space: nowrap;
}
/* 三颗口推到右端：标题在左、动作在右，两个模块的按钮竖着对得齐。
   窄卡片时允许折行 —— 宁可折成两行，也不要挤到标题上或者溢出卡片。 */
.ebc-mat-adds {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 4px;
  margin-left: auto;
  flex: none;
  max-width: 100%;
}
.ebc-mat-items {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
/*
 * 待合成占位：虚线 + 中性色，和真素材格大致同尺寸，但写得下"要合成什么"。
 *
 * 它不是"空着就画一格"的占位，而是一条 draft 素材的样子 —— 提示词 / 配音文本
 * 存在里面，所以格子里直接露出配置的前两行：一眼能认出这是在等哪一张图、哪句话。
 * 画成实心卡会让人以为已经合成好了，所以只用虚线。
 */
.ebc-mat-slots {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
.ebc-mat-slot {
  position: relative;
  width: 118px;
  /* 比真素材格高 8px：底下一行放帧位选择器，格子里仍写得下两行配置 */
  height: 64px;
  flex: none;
  border: 1px dashed var(--line-strong);
  border-radius: 6px;
  background: var(--panel-2);
}
.ebc-mat-slot:hover {
  border-color: var(--accent);
  background: var(--hover);
}
.ebc-mat-slot-main {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  height: calc(100% - 18px);
  padding: 5px 6px 2px;
  border: none;
  background: transparent;
  color: var(--muted);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
}
/* 帧位条：和图片格下沿那条同一个写法，但落在虚线框内部 */
.ebc-mat-slot-bot {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 1px;
  height: 18px;
  padding: 0 3px;
  border-top: 1px dashed var(--line-strong);
}
.ebc-mat-slot-bot .ebc-mat-card-lb {
  flex: none;
}
.ebc-mat-slot-bot .ebc-mat-sel {
  flex: 1;
  min-width: 0;
}
.ebc-mat-slot-ico {
  position: absolute;
  top: 5px;
  left: 6px;
  display: flex;
  color: var(--muted-3);
}
.ebc-mat-slot-ico svg {
  width: 12px;
  height: 12px;
}
.ebc-mat-slot-lb {
  padding-left: 16px;
  font-size: 10px;
  line-height: 13px;
  color: var(--text-2);
}
.ebc-mat-slot-txt {
  /* 配置内容只露两行：它是"认格子"的线索，不是编辑器 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 9.5px;
  line-height: 12px;
  color: var(--muted-3);
  word-break: break-word;
}
.ebc-mat-slot-del {
  position: absolute;
  top: 1px;
  right: 1px;
  width: 14px;
  height: 14px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--muted-3);
  font-size: 12px;
  line-height: 12px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s;
}
.ebc-mat-slot:hover .ebc-mat-slot-del {
  opacity: 1;
}
.ebc-mat-slot-del:hover {
  background: var(--danger-soft, rgba(208, 48, 80, 0.12));
  color: var(--danger, #d03050);
}

.ebc-mat-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: none;
}
/*
 * 强度按钮：显示当前强度（100 = 钉死，<100 越软越偏参考），点开滑杆。
 * 和帧位并排 —— 一个是"落在哪一帧"，一个是"有多硬"，两件事互不替代。
 */
.ebc-usage {
  flex: none;
  height: 14px;
  min-width: 22px;
  padding: 0 3px;
  margin-right: 2px;
  border: 1px solid var(--accent-line);
  border-radius: 3px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 9.5px;
  font-weight: 600;
  line-height: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.ebc-usage.is-soft {
  border-color: var(--warn-line);
  background: var(--warn-soft);
  color: var(--warn-ink);
}
.ebc-usage:hover {
  filter: brightness(0.96);
}
/* 强度面板本体在 common/StrengthPopover.vue 里，这里只留触发按钮 */
/* 紧凑形态里强度并进了角标：角标就是入口，点开拨「强制 / 参考」 */
.ebc-mat-badge[role='button'],
.ebc-mat-media-badge.is-usage {
  cursor: pointer;
}
/* 角标默认 pointer-events: none（压在图上看大图用），可点的那种要放出来 */
.ebc-mat-badge.is-btn {
  pointer-events: auto;
  box-shadow: inset 0 0 0 1px rgba(43, 86, 184, 0.16);
}
.ebc-mat-badge.is-btn:hover {
  background: #fff;
  box-shadow: inset 0 0 0 1px var(--accent-line);
}
.ebc-mat-media-badge.is-soft {
  background: var(--warn-soft);
  color: var(--warn-ink);
}
.ebc-mat-frbar .ebc-mat-sel {
  flex: 1;
  min-width: 0;
}

/* 关键帧的落点条：叠在图片下沿，选的是帧号，也就是落点 */
.ebc-mat-frbar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  height: 18px;
  padding: 0 2px;
  background: rgba(255, 255, 255, 0.92);
  border-top: 1px solid rgba(226, 232, 242, 0.9);
  backdrop-filter: blur(3px);
}

/*
 * 帧号选择器：触发器压到 18px 贴着图沿，菜单按内容宽展开（不吃 92px 的卡宽）。
 * 帧位是"第几帧"这个有限集合里的一个值，选比敲省事 —— 不用夹、不用记共几帧。
 */
.ebc-mat-sel {
  display: flex;
  width: 100%;
  font-variant-numeric: tabular-nums;
}
/*
 * naive 的 size=tiny 是 22px，比这条 18px 的图内条还高，会把选择器顶出图片下沿。
 * 组件把 --n-height 写在行内，所以这里只能 !important 压平。
 */
.ebc-mat-sel :deep(.n-base-selection) {
  --n-height: 18px !important;
  height: 18px !important;
  min-height: 18px !important;
  background: transparent !important;
}
.ebc-mat-sel :deep(.n-base-selection-label) {
  background: transparent !important;
}
.ebc-mat-sel :deep(.n-base-selection-label) {
  height: 18px !important;
  padding: 0 12px 0 2px;
}
.ebc-mat-sel :deep(.n-base-selection-input__content) {
  line-height: 18px;
}
.ebc-mat-sel :deep(.n-base-selection-label),
.ebc-mat-sel :deep(.n-base-selection-input),
.ebc-mat-sel :deep(.n-base-selection-input__content),
.ebc-mat-sel :deep(.n-base-selection-placeholder) {
  font-size: 10.5px !important;
  font-weight: 600;
  color: var(--accent-ink);
  line-height: 18px;
}
.ebc-mat-sel :deep(.n-base-selection__border),
.ebc-mat-sel :deep(.n-base-selection__state-border) {
  display: none !important;
}
.ebc-mat-sel :deep(*) {
  outline: none !important;
}
.ebc-mat-sel :deep(.n-base-selection--active),
.ebc-mat-sel :deep(.n-base-selection--focus),
.ebc-mat-sel :deep(.n-base-selection:focus-within) {
  box-shadow: none !important;
}
.ebc-mat-frbar:focus-within {
  background: rgba(238, 244, 255, 0.96);
}
/* 参考图那条：帧位 + 作用方式挤在同一行，右侧那颗「参」不另占浮块 */
.ebc-mat-frbar.is-ref {
  padding-right: 2px;
}
.ebc-mat-act-inline {
  flex: none;
  margin-left: 1px;
  padding: 0 3px;
  border: 1px solid rgba(122, 100, 64, 0.4);
  border-radius: 3px;
  background: rgba(250, 244, 232, 0.95);
  color: var(--warn-ink);
  font-size: 9px;
  line-height: 12px;
  font-weight: 600;
  cursor: pointer;
}
.ebc-mat-act-inline:hover {
  border-color: var(--warn-ink);
}
.ebc-mat-sel :deep(.n-base-selection-indicator) {
  color: var(--muted);
}
.ebc-mat-sel :deep(.n-base-suffix) {
  height: 18px;
}
.ebc-mat-sel :deep(.n-base-suffix .n-base-icon) {
  font-size: 11px;
}

/* 删除：悬停才露，避免一排 × 抢注意力 */
.ebc-mat-del {
  position: absolute;
  right: -5px;
  top: -5px;
  z-index: 2;
  width: 15px;
  height: 15px;
  padding: 0;
  border: 1px solid var(--err-line);
  border-radius: 50%;
  background: #fff;
  color: var(--err-ink);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s;
}
.ebc-mat-cell:hover .ebc-mat-del {
  opacity: 1;
}
.ebc-mat-del:hover:not(:disabled) {
  background: var(--err-soft);
  border-color: var(--err-line);
}
.ebc-mat-del:disabled {
  opacity: 0.45;
  cursor: default;
}

.ebc-mat-tile {
  position: relative;
  display: block;
  width: 104px;
  height: 56px;
  padding: 0;
  flex: none;
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
  background: var(--hover);
  cursor: zoom-in;
}
.ebc-mat-tile.is-kf {
  cursor: zoom-in;
}
/* 失效角标：右上角一颗小「旧」，压在图上看大图时也不挡落点角标 */
.ebc-mat-stale {
  position: absolute;
  right: 2px;
  top: 2px;
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(255, 232, 191, 0.96);
  border: 1px solid rgba(201, 138, 22, 0.55);
  color: var(--warn-ink);
  font-size: 9px;
  font-weight: 600;
  line-height: 12px;
  pointer-events: none;
}
.ebc-mat-tile.is-kf:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.ebc-mat-tile > img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.ebc-mat-tile:hover {
  border-color: var(--accent);
}
/* 编号角标在左上：底部要留给主体名 */
.ebc-mat-badge {
  position: absolute;
  left: 2px;
  top: 2px;
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.92);
  color: var(--accent-ink);
  font-size: 10px;
  line-height: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
/* 参考方式的角标：同样压左上，但用暖色区分 —— 它说的是"占第几个 Picture 槽"，
   不是"落在第几帧"，两种数字长得一样会看串 */
.ebc-mat-badge.is-refbadge {
  color: var(--warn-ink);
  background: rgba(250, 244, 232, 0.95);
}
/* 参考方式的图：虚线边 —— 它不进时间轴，和轨道上的实心格子区分开 */
.ebc-mat-tile.is-ref {
  border-style: dashed;
  border-color: var(--warn-line);
}

.ebc-mat-plus {
  font-size: 15px;
  line-height: 14px;
  color: inherit;
}

/*
 * 音视频：一张小卡装两行 —— 上行是「音/视 + 文件名」（点开播放），
 * 下行是起始帧调节器。挪帧是最常做的事，放在卡上比"开弹窗再拖轨道"快得多。
 */
.ebc-mat-card {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  width: 186px;
  height: 56px;
  padding: 2px 5px;
  flex: none;
  border: 1px solid var(--ok-line);
  border-radius: 6px;
  background: var(--ok-soft);
  color: var(--ok-ink);
  overflow: hidden;
}
/* 正在放：描边加亮，进度条压在卡底 */
.ebc-mat-card.is-playing {
  border-color: var(--ok);
  box-shadow: 0 0 0 2px rgba(107, 191, 149, 0.16);
}
.ebc-mat-card.is-video.is-playing {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 2px rgba(143, 171, 221, 0.18);
}
.ebc-mat-card.is-video {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.ebc-mat-card-top {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-width: 0;
  padding: 0;
  color: inherit;
  cursor: zoom-in;
}

/* 卡上试听：圆钮，播放时变成暂停并反色 */
.ebc-mat-play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  flex: none;
  border: 1px solid var(--ok-line);
  border-radius: 50%;
  background: #fff;
  color: var(--ok-ink);
  cursor: pointer;
}
.ebc-mat-play:hover {
  border-color: var(--ok-ink);
  background: var(--ok-soft);
}
.ebc-mat-card.is-video .ebc-mat-play {
  border-color: var(--accent-line);
  color: var(--accent-ink);
}
.ebc-mat-card.is-video .ebc-mat-play:hover {
  border-color: var(--accent-ink);
  background: var(--accent-soft);
}
.ebc-mat-play.on,
.ebc-mat-card.is-video .ebc-mat-play.on {
  border-color: var(--ok-ink);
  background: var(--ok-ink);
  color: #fff;
}
.ico-play {
  width: 0;
  height: 0;
  margin-left: 1px;
  border-left: 6px solid currentColor;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
}
.ico-pause {
  width: 7px;
  height: 8px;
  border-left: 2px solid currentColor;
  border-right: 2px solid currentColor;
}
.ebc-mat-progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  background: var(--ok);
  transition: width 0.12s linear;
  pointer-events: none;
}
.ebc-mat-card.is-video .ebc-mat-progress {
  background: var(--accent-ink);
}
.ebc-mat-kind {
  flex: none;
  font-style: normal;
  padding: 0 3px;
  border-radius: 3px;
  background: var(--ok-line);
  font-size: 9.5px;
  line-height: 14px;
}
.ebc-mat-card.is-video .ebc-mat-kind {
  background: var(--accent-soft);
}
.ebc-mat-card-name {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  line-height: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 紧凑形态没有调节器，用角标代替"从第几帧起" */
.ebc-mat-media-badge {
  display: none;
  flex: none;
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.85);
  font-size: 9px;
  line-height: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
/*
 * 「参」角标：这条音视频只当参考（不占这段的时间轴）。
 * 必须常显 —— 判断一条声音"是不是这段的台词"靠的就是它，
 * 藏在紧凑态里等于没有。
 */
.ebc-mat-media-badge.is-refbadge {
  display: inline-block;
  background: var(--warn-soft);
  color: var(--warn-ink);
}
/*
 * 参考用的音视频换一身皮：内容用绿（这一段的东西），参考用中性虚线。
 * 两种东西在包里落的是两套槽位，长得一样只会让人以为"传上去都一样"。
 */
.ebc-mat-card.is-ref {
  border-style: dashed;
  border-color: var(--line-strong);
  background: var(--panel);
  color: var(--text-2);
}
.ebc-mat-card-bot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  width: 100%;
}
.ebc-mat-sel.is-media {
  width: 98px;
  flex: none;
}
.ebc-mat-card-lb {
  flex: none;
  font-size: 9.5px;
  line-height: 14px;
  color: var(--ok-ink);
}
.ebc-mat-card-bot > .ebc-mat-card-lb:first-child {
  margin-right: 1px;
}
.ebc-mat-card-bot > .ebc-mat-card-lb:last-child {
  margin-left: 4px;
}

.ebc-mat-add {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0;
  width: 58px;
  height: 56px;
  padding: 0;
  flex: none;
  border: 1px dashed var(--line-strong);
  border-radius: 6px;
  background: #fff;
  color: var(--muted);
  font-size: 10.5px;
  cursor: pointer;
}
.ebc-mat-add .ebc-mat-plus {
  font-size: 15px;
  line-height: 15px;
}
.ebc-mat-add > span:last-child {
  line-height: 14px;
  white-space: nowrap;
}
/* 标题行里的口：文字按钮，不占一格图的位置（"收什么"必须读得出来，不能只剩一个＋） */
.ebc-mat-add.is-txt {
  width: auto;
  height: 20px;
  padding: 0 6px;
  flex-direction: row;
  gap: 1px;
  border-radius: 5px;
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;
}
.ebc-mat-add.is-txt .ebc-mat-plus {
  font-size: 11px;
  line-height: 1;
}
/* 配置口用实线：它不传文件，是"先把要什么写下来"，和上传口长得一样会点错 */
.ebc-mat-add.is-txt.is-config {
  border-style: solid;
  color: var(--muted-2);
}
.ebc-mat-add:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.ebc-mat-add:disabled {
  opacity: 0.6;
  cursor: default;
}

/* 紧凑形态：卡片只有一行高，素材带缩一号，主要用来"扫一眼有没有图"。
   标题行（含上传口与配置口）和待合成占位直接藏掉 —— 紧凑态是"看"，不是"补"；
   空模块整块不占高度。两个模块在紧凑态**并排**一条线：全尺寸下上下分栏是为了
   各带一排按钮，这里没有标题行，再竖着堆就成了两行，紧凑的意义就没了。 */
.v-compact .ebc-mats {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  margin-top: 5px;
  padding: 2px 6px 3px;
}
.v-compact .ebc-mat-hd {
  display: none;
}
.v-compact .ebc-mat-sec {
  gap: 2px;
  padding: 1px 0;
}
.v-compact .ebc-mat-sec + .ebc-mat-sec {
  margin-top: 0;
  padding-top: 0;
  border-top: none;
}
.v-compact .ebc-mat-sec:not(:has(.ebc-mat-cell)) {
  display: none;
}
.v-compact .ebc-mat-items {
  gap: 4px;
}
.v-compact .ebc-mat-tile {
  width: 46px;
  height: 27px;
}
.v-compact .ebc-mat-badge {
  left: 1px;
  top: 1px;
  padding: 0 2px;
  font-size: 8.5px;
  line-height: 11px;
}
.v-compact .ebc-mat-cell {
  gap: 1px;
}
.v-compact .ebc-mat-del {
  right: -4px;
  top: -4px;
  width: 13px;
  height: 13px;
  font-size: 10px;
}
.v-compact .ebc-mat-card {
  width: auto;
  max-width: 188px;
  height: 27px;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  padding: 0 5px;
}
.v-compact .ebc-mat-card-bot {
  display: none;
}
.v-compact .ebc-mat-media-badge {
  display: inline-block;
}
.v-compact .ebc-mat-card-name {
  font-size: 10px;
  line-height: 12px;
}
.v-compact .ebc-mat-play {
  width: 16px;
  height: 16px;
}
.v-compact .ebc-mat-play .ico-play {
  border-left-width: 5px;
  border-top-width: 3.5px;
  border-bottom-width: 3.5px;
}
.v-compact .ebc-mat-play .ico-pause {
  width: 6px;
  height: 7px;
}
.v-compact .ebc-mat-adds,
.v-compact .ebc-mat-slots {
  display: none;
}
/* 紧凑态：引用行跟素材排在同一条线上；「＋参考」是"补"，紧凑态是"看"，收起来 */

/* ---------------------------- 窄卡降列 ---------------------------- */

/*
 * 三列排布时卡片只有 ~440 宽（内容区 ~416）：
 *   场景 / 主体 并排，聚集主体占满第二行（非台词段只有三个字段，占满才不留空格子）；
 *   台词段四栏正好排成 2×2；文本域上下叠，不然 180px 宽的输入框读不下去。
 * 容器查询统一放在文件末尾：它与基础规则同权重，靠顺序取胜。
 */
@container (max-width: 560px) {
  .ebc-grid.n3,
  .ebc-grid.n4 {
    /* 场景列继续 auto（只有一张图宽），剩下的全给主体，两列时主体才放得下三个图块 */
    grid-template-columns: auto minmax(0, 1fr);
  }
  .ebc-grid.n3 > .ebc-f:nth-child(3) {
    grid-column: 1 / -1;
  }
}
@container (max-width: 460px) {
  .ebc-texts {
    grid-template-columns: minmax(0, 1fr);
  }
}
@container (max-width: 380px) {
  .ebc-grid.n3,
  .ebc-grid.n4 {
    grid-template-columns: minmax(0, 1fr);
  }
  .ebc-grid.n3 > .ebc-f:nth-child(3) {
    grid-column: auto;
  }
}
</style>
