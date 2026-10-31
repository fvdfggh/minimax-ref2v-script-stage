<script setup lang="ts">
/**
 * 主体管理（项目层 / 集层通用）。
 *
 * 两个作用域用同一个组件，但语义严格分开：
 *   项目层（scope=project）—— 大主体，跨集复用的"唯一真相源"。
 *     这里改描述/换图不会动到任何一集，要下发必须显式「取到某一集」。
 *   集层（scope=episode）—— 本集主体，独立编号、独立参考图、独立打包。
 *     本集怎么改都不影响项目，只有显式「推送至项目」才会写回。
 *
 * 图片走的是 PictureN（主体参考图），不是段级的关键帧/素材 ——
 * 后者属于某个片段，在「细节填充」里管理。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  NButton,
  NCheckbox,
  NDrawer,
  NInput,
  NModal,
  NPopconfirm,
  NSelect,
  NSwitch,
  NTag,
  useMessage
} from 'naive-ui'
import { useEntityRegister } from '@/composables/useEntityRegister'
import { countMentions, pendingSubjects, type PendingSubject, type SubjectPreset } from '@/domain/subjectScan'
import { usePipelineStore } from '@/stores/pipeline'
import { useProviderStore } from '@/stores/provider'
import SubjectCard from './SubjectCard.vue'
import InfoTip from './common/InfoTip.vue'
import AiWrite from './common/AiWrite.vue'
import type { EntityWriteField } from '@/core/llm/assist'
import {
  VOICE_SEEDS,
  freshSeeds,
  voiceDesign,
  voiceFix,
  voiceSpeak,
  voiceStatus,
  voiceWavUrl
} from '@/core/voice'
import type { VoiceCandidate, VoiceStatus } from '@/core/voice'
import { useAudioPlayback } from '@/composables/useAudioPlayback'
import { ENTITY_TYPE_HINT, ENTITY_TYPE_LABEL, normalizeVoiceDesc, stripSxSuffix } from '@/domain/registry'
import { costumeLeakInFace } from '@/domain/refSheet'
import { ENTITY_TYPES } from '@/domain/types'
import type { Asset, Entity, EntityKind, EntityType, ID } from '@/domain/types'
import { useBeatStore } from '@/stores/beats'
import { useProjectStore } from '@/stores/project'
import { useImageStore } from '@/stores/images'
import { useRegistryStore } from '@/stores/registry'
import { useSeriesStore } from '@/stores/series'
import ImageGenModal from './ImageGenModal.vue'
import SubjectSheetPanel from './SubjectSheetPanel.vue'

const props = withDefaults(
  defineProps<{
    scope: 'project' | 'episode'
    /** 当前作用域的项目 id：项目层 = series.id，集层 = episode.id */
    projectId: ID
    /** 集层必传：所属项目 id，用于「取 / 推送」 */
    seriesId?: ID
    /**
     * 这一页当前是不是可见的。
     *
     * 工作台用 v-show 挂它（切换 tab 只是隐藏，组件不销毁），而详情是 n-drawer：
     * 抽屉会 teleport 到 body，父容器隐藏管不到它 —— 不主动关，切到别的 tab
     * 会留一个浮在半空的抽屉。
     */
    active?: boolean
  }>(),
  { seriesId: '', active: true }
)

const registry = useRegistryStore()
const series = useSeriesStore()
/** 读故事原文（「按原文找主体」与原文提及统计），不在这里改项目 */
const project = useProjectStore()
const beats = useBeatStore()
const images = useImageStore()
const provider = useProviderStore()
const pipeline = usePipelineStore()
const message = useMessage()

const isEpisode = computed(() => props.scope === 'episode')

/* ------------------------------- 列表 ------------------------------- */

const q = ref('')
const filter = ref<'all' | EntityType>('all')
const selectedId = ref<ID | null>(null)

/**
 * 三类主体的固定顺序：角色 → 场景 → 道具。
 * 排序和分组都走这一份，别在页面里另立一套。
 */
function typeRank(t: EntityType): number {
  const i = ENTITY_TYPES.indexOf(t)
  return i < 0 ? 90 : i
}

const sorted = computed(() =>
  [...registry.entities].sort(
    (a, b) => typeRank(a.type) - typeRank(b.type) || a.name.localeCompare(b.name, 'zh')
  )
)

const filtered = computed(() => {
  const kw = q.value.trim().toLowerCase()
  return sorted.value.filter((e) => {
    if (filter.value !== 'all' && e.type !== filter.value) return false
    if (!kw) return true
    return (
      e.name.toLowerCase().includes(kw) ||
      (e.textDesc ?? '').toLowerCase().includes(kw) ||
      (e.voiceDesc ?? '').toLowerCase().includes(kw)
    )
  })
})

const typeFilters = computed(() => {
  const count = (t: EntityType) => registry.entities.filter((e) => e.type === t).length
  // 三类固定都在，0 也显示：分类本身就是信息（"这个项目还没有道具"）
  return [
    { key: 'all' as const, label: '全部', n: registry.entities.length },
    ...ENTITY_TYPES.map((t) => ({
      key: t,
      label: ENTITY_TYPE_LABEL[t],
      n: count(t)
    }))
  ]
})

/** 按类型分组；筛选到某一类时只留那一组，方便一眼看出哪类还是空的 */
const groups = computed(() => {
  const list = ENTITY_TYPES.filter((t) => filter.value === 'all' || filter.value === t)
  return list.map((t) => ({
    type: t,
    label: ENTITY_TYPE_LABEL[t],
    items: filtered.value.filter((e) => e.type === t)
  }))
})

const cur = computed(() => registry.entities.find((e) => e.id === selectedId.value) ?? null)

/** 记住每个项目上次选中的主体：改完刷新回来还停在同一个身上 */
const selKey = () => `subjectManager:sel:${props.projectId}`
watch(selectedId, (v) => {
  if (v) localStorage.setItem(selKey(), v)
})

// 选中的主体被删 / 换了作用域时，兜底选第一个
watch(
  () => [filtered.value.map((e) => e.id).join(','), props.projectId].join('|'),
  () => {
    if (cur.value) return
    selectedId.value = filtered.value[0]?.id ?? null
  }
)

/* ------------------------------- 图片 ------------------------------- */

const imgInput = ref<HTMLInputElement | null>(null)
/** 覆盖同名 PictureN 后浏览器会拿缓存，这里用版本号破掉 */
const cacheBust = ref(0)
/** 正在生成参考图的主体 */
const genTarget = ref<Entity | null>(null)

function assetOf(e: Entity | null): Asset | null {
  if (!e || !e.pictureN) return null
  return registry.assets.find((a) => a.pictureN === e.pictureN) ?? null
}

function imageUrlOf(e: Entity | null): string | null {
  const a = assetOf(e)
  return a ? `${registry.assetUrl(a)}?v=${cacheBust.value}` : null
}

const curAsset = computed(() => assetOf(cur.value))
const curImageUrl = computed(() => imageUrlOf(cur.value))

/**
 * 头部描述里混进了穿着。只对角色有意义 —— 场景 / 道具没有"头"这一步，
 * 它们只有一张参考图，写什么都在同一张里。
 */
const costumeLeak = computed(() => {
  const e = cur.value
  if (!e || e.type !== 'character') return []
  // 检查的必须是**真正进提示词的那一段**（英文优先），不然英文里写了穿着会漏报
  return costumeLeakInFace(((e.textDescEn ?? '') || (e.textDesc ?? '')).trim())
})

function pickImage() {
  if (!cur.value) return
  imgInput.value?.click()
}

async function attachImageTo(e: Entity, file: Blob, originalName: string) {
  // 挂图逻辑（已有图就覆盖同一个 Picture N，没有就新建并回写编号）收在 registry 里，
  // 段内素材面板的「就地补图」也走同一个入口，避免两处各写一遍慢慢漂移
  await registry.attachEntityImage(props.projectId, e.id, file, originalName)
  cacheBust.value += 1
}

async function onPickImage(ev: Event) {
  const input = ev.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (!f || !cur.value) return
  const e = cur.value
  await attachImageTo(e, f, f.name)
  message.success(`「${e.name}」的参考图已更新`)
}

async function onGenerated(blob: Blob) {
  const e = genTarget.value
  genTarget.value = null
  if (!e) return
  await attachImageTo(e, blob, 'generated.png')
  message.success(`「${e.name}」的参考图已更新`)
}

async function clearImage() {
  const e = cur.value
  const a = curAsset.value
  if (!e || !a) return
  await registry.removeEntityImage(e.id, a.id)
  cacheBust.value += 1
  message.success('参考图已移除')
}

/* --------------------------- 描述 / 声音描述 --------------------------- */

const voiceDraft = ref('')
let voiceTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => cur.value?.id,
  () => {
    voiceDraft.value = stripSxSuffix(cur.value?.voiceDesc ?? '')
  },
  { immediate: true }
)

function flushVoice() {
  if (voiceTimer) {
    clearTimeout(voiceTimer)
    voiceTimer = null
  }
  const e = cur.value
  if (!e) return
  const next = normalizeVoiceDesc(voiceDraft.value)
  if ((e.voiceDesc ?? '') !== next) void registry.updateEntity(e.id, { voiceDesc: next || null })
}

function onVoiceInput() {
  if (voiceTimer) clearTimeout(voiceTimer)
  voiceTimer = setTimeout(flushVoice, 500)
}

/* --------------------------- 单点 AI：写一段描述 --------------------------- */

/**
 * 长相 / 服装 / 音色三颗 ✨，各写各的字段。
 *
 * 为什么不合成一颗「AI 补全主体」：
 *   这三段进的是不同下游（长相 → 基模头与组头；服装 → 三视图；音色 → 音色设计），
 *   混在一次生成里，模型为了"写完整"必然把衣服写进长相 —— 那正是这套拆分
 *   要修的病。所以一次只给一个字段、一句要求。
 */
const aiDescBusy = ref<'' | EntityWriteField>('')

const AI_DESC_PRESETS: Record<EntityWriteField, string[]> = {
  textDesc: ['描述得更具体一点', '加一个标志性细节', '别写年纪，写骨相'],
  costumeDesc: ['这套造型写全套', '换一套更旧的', '别写和剧情相关的状态'],
  voiceDesc: ['声音再低一点', '加一点沙哑', '语速慢，尾音压着']
}

/** 原文里提到这个名字的一小段：有原文就以原文为准，没有就让模型合理设定 */
function storyExcerptOf(name: string): string | undefined {
  const story = (isEpisode.value ? storyDraft.value : project.current?.story) ?? ''
  const at = story.indexOf(name)
  if (at < 0) return undefined
  return story.slice(Math.max(0, at - 90), at + name.length + 140).trim()
}

async function aiEntityDesc(field: EntityWriteField, brief: string) {
  const e = cur.value
  if (!e) return
  if (!provider.ready) {
    message.warning('请先在「模型设置」里配置文本模型')
    return
  }
  aiDescBusy.value = field
  try {
    const text = await pipeline.writeEntityDesc({
      field,
      entity: {
        name: e.name,
        type: e.type,
        kind: e.kind,
        textDesc: e.textDesc,
        costumeDesc: e.costumeDesc,
        voiceDesc: e.voiceDesc
      },
      storyExcerpt: storyExcerptOf(e.name),
      peers: registry.entities
        .filter((x) => x.id !== e.id)
        .slice(0, 8)
        .map((x) => x.name),
      requirement: brief.trim() || undefined,
      language: project.settings.workLanguage
    })
    if (field === 'voiceDesc') {
      voiceDraft.value = stripSxSuffix(text)
      flushVoice()
    } else {
      await registry.updateEntity(e.id, field === 'textDesc' ? { textDesc: text } : { costumeDesc: text })
    }
    const label = field === 'textDesc' ? '长相' : field === 'costumeDesc' ? '服装与身形' : '声音描述'
    message.success(`${label}已写入`)
  } catch (err) {
    message.error((err as Error).message || '生成失败', { duration: 8000 })
  } finally {
    aiDescBusy.value = ''
  }
}

/** 常用音色短语：导演台读英文，点一下插到末尾，再按需微调 */
const VOICE_SAMPLES = [
  'a young male voice, clear and steady',
  'a young female voice, soft but firm',
  'a middle-aged male voice, low and gravelly',
  'an elderly female voice, slow and warm'
]

function addVoiceSample(s: string) {
  voiceDraft.value = voiceDraft.value ? `${stripSxSuffix(voiceDraft.value)}, ${s}` : s
  flushVoice()
}

onBeforeUnmount(flushVoice)

/* ------------------------------ 音色包 ------------------------------ */

/*
 * 三段式，别跳步：
 *   ① 设计 —— qwen3 按描述造 3 条候选（只是候选，谁也没绑上）
 *   ② 试听 —— 就地放，听到哪条合适
 *   ③ 固定 —— s2 把那条编码成 .s2voice，之后段内配音都用它
 *
 * 为什么不在"设计"这一步就自动固定：音色设计出来的东西没法预判，
 * 十个描述九条不对味，自动固定等于每次都要删一遍。固定必须是人按下的。
 */

const voiceCands = ref<VoiceCandidate[]>([])
const voiceBusy = ref(false)
const voiceFixId = ref('')
const voiceSeeds = ref<number[]>([...VOICE_SEEDS])
const voiceErr = ref('')
const voiceSvc = ref<VoiceStatus | null>(null)
const packBusy = ref(false)

/** 试听固定音色时念的那句话：挑一句有停顿、有起伏的，才听得出口型和语气 */
const VOICE_PREVIEW_TEXT = '风从北边来了，今晚怕是要下雨。你先坐，我去把灯点上。'

const { isPlaying, togglePlay, stopPlay } = useAudioPlayback()

/** 设计用的描述：去掉 (Sx) 后缀 —— 那是给导演模型的编号，念出来只会干扰；
 *  顺手把"中文句号 + 英文句号"叠在一起的尾巴收掉（老数据里很常见，写进提示词很丑） */
const voiceDescPlain = computed(() =>
  stripSxSuffix(voiceDraft.value)
    .replace(/。\s*\.+\s*$/, '。')
    .trim()
)

const packPlayId = computed(() => (cur.value?.voicePack ? `pack:${cur.value.voicePack.id}` : ''))

/** 会话内的固定音色试听缓存：合成一次（3 秒）就够了，反复点播放不该反复合成 */
const packUrl = ref('')
const packUrlId = ref('')

async function loadVoiceStatus() {
  try {
    voiceSvc.value = await voiceStatus()
  } catch {
    voiceSvc.value = null
  }
}

onMounted(loadVoiceStatus)

watch(
  () => cur.value?.id,
  () => {
    voiceCands.value = []
    voiceErr.value = ''
    voiceFixId.value = ''
    voiceSeeds.value = [...VOICE_SEEDS]
    if (packPlayId.value) stopPlay(packPlayId.value)
  }
)

async function designVoice(fresh = false) {
  const desc = voiceDescPlain.value
  if (!cur.value || !desc) {
    message.warning('先在「声音描述」里写清这是什么声音，再设计')
    return
  }
  if (fresh) voiceSeeds.value = freshSeeds()
  voiceBusy.value = true
  voiceErr.value = ''
  voiceCands.value = []
  stopPlay()
  try {
    // 一条条来：服务是单请求的，并发只会一起排队还看不到进度
    for (const seed of voiceSeeds.value) {
      const c = await voiceDesign(desc, seed)
      voiceCands.value = [...voiceCands.value, c]
    }
    if (!voiceCands.value.length) voiceErr.value = '没有生成出候选，检查 qwen3 设计服务'
  } catch (e) {
    voiceErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    voiceBusy.value = false
    void loadVoiceStatus()
  }
}

async function fixCandidate(c: VoiceCandidate) {
  if (!cur.value) return
  voiceFixId.value = c.name
  voiceErr.value = ''
  try {
    const pack = await voiceFix(c.name, c.desc, c.seed)
    await registry.updateEntity(cur.value.id, {
      // 描述也一起落一份：之后改 voiceDesc 不该让已固定的音色"变得来路不明"
      voicePack: {
        id: pack.id,
        desc: pack.desc || c.desc,
        sample: pack.sample || c.name,
        seed: pack.seed ?? c.seed,
        text: pack.text,
        fixedAt: pack.fixedAt || Date.now()
      }
    })
    voiceCands.value = []
    packUrl.value = ''
    packUrlId.value = ''
    message.success(`已固定音色 ${pack.id}${pack.cached ? '（复用已有音色包）' : ''}`)
  } catch (e) {
    voiceErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    voiceFixId.value = ''
  }
}

async function clearVoicePack() {
  if (!cur.value) return
  if (packPlayId.value) stopPlay(packPlayId.value)
  packUrl.value = ''
  packUrlId.value = ''
  await registry.updateEntity(cur.value.id, { voicePack: null })
  message.success('已取消固定（音色包文件还留在磁盘上）')
}

/** 固定音色的试听：第一次合成后缓存 blob URL，再点就只是重放 */
async function playPack() {
  const pack = cur.value?.voicePack
  if (!pack) return
  if (!packUrl.value || packUrlId.value !== pack.id) {
    packBusy.value = true
    try {
      const blob = await voiceSpeak(pack.id, VOICE_PREVIEW_TEXT)
      if (packUrl.value) URL.revokeObjectURL(packUrl.value)
      packUrl.value = URL.createObjectURL(blob)
      packUrlId.value = pack.id
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
      return
    } finally {
      packBusy.value = false
    }
  }
  await togglePlay(packPlayId.value, packUrl.value)
}

async function playCandidate(c: VoiceCandidate) {
  try {
    await togglePlay(c.name, voiceWavUrl(c.name))
  } catch {
    message.error('浏览器放不了这条候选音频')
  }
}

onBeforeUnmount(() => {
  if (packUrl.value) URL.revokeObjectURL(packUrl.value)
  stopPlay()
})

/**
 * 集层的编号（<Subject N> / (Sx)）是按"会说话 → 不说话 → 场景"排的，
 * 一改类型或会说话开关，编号就该重排。不重排的话，新开的说话角色没有 (Sx)，
 * 降成道具的还留着 (S2)，包里就自相矛盾了。项目层没有片段，编号到取用时才算，
 * 所以只在集层重算。
 */
async function renumberIfEpisode() {
  if (!isEpisode.value || !beats.beats.length) return
  await registry.renumber(beats.beats)
}

function setKind(v: boolean) {
  if (!cur.value) return
  void registry
    .updateEntity(cur.value.id, {
      kind: (v ? 'speaking' : 'non_speaking') as EntityKind,
      // 不发声就不该留着配音用的音色包：留着会让"这段能不能配音"的判定两头不是人
      ...(v ? {} : { voicePack: null })
    })
    .then(renumberIfEpisode)
}

/**
 * 改类型时顺手把"会说话"关掉：场景和道具不发声，留着 speaking 会白占一个 (Sx)，
 * 在音色表里也显得莫名其妙。角色 → 非角色是真降级，所以只在这一侧收口。
 */
function setType(v: EntityType) {
  const e = cur.value
  if (!e || e.type === v) return
  const patch: Partial<Entity> = { type: v }
  if (!ENTITY_TYPE_HINT[v].canSpeak && e.kind === 'speaking') {
    patch.kind = 'non_speaking'
    // 先摘掉 (Sx)，别等重排：重排失败时也不该留下"道具带音色编号"
    patch.sx = null
    patch.voicePack = null
  }
  void registry.updateEntity(e.id, patch).then(renumberIfEpisode)
}

function setName(v: string) {
  if (!cur.value) return
  void registry.updateEntity(cur.value.id, { name: v })
}

const typeOptions = ENTITY_TYPES.map((t) => ({
  label: ENTITY_TYPE_LABEL[t],
  value: t
}))

/** 当前主体这一类的填写口径（描述该写什么、能不能说话） */
const typeHint = computed(() => ENTITY_TYPE_HINT[cur.value?.type ?? 'character'])

/* ------------------------------ 新增 / 删除 ------------------------------ */

const nameInput = ref<InstanceType<typeof NInput> | null>(null)

async function removeCur() {
  const e = cur.value
  if (!e) return
  const a = assetOf(e)
  await registry.removeEntity(e.id)
  if (a) await registry.removeAsset(a.id)
  selectedId.value = null
  detailOpen.value = false
  message.success(`已删除「${e.name}」`)
}

/* --------------------------- 项目 ↔ 集的流转 --------------------------- */

/** 集层：项目里的主体（取用来源） */
const remoteEntities = ref<Entity[]>([])
/** 项目层：谁取用过 / 谁推送来的 */
const usedBy = ref<Record<ID, ID[]>>({})
const origin = ref<Record<ID, ID>>({})

const episodeName = (id: ID) => series.episodes.find((e) => e.id === id)?.name ?? '某一集'

async function loadRemote() {
  if (!isEpisode.value || !props.seriesId) {
    remoteEntities.value = []
    return
  }
  remoteEntities.value = await registry.listEntitiesOf(props.seriesId)
}

async function loadUsage() {
  if (isEpisode.value || !props.projectId) return
  const res = await series.usageOf(props.projectId)
  usedBy.value = res.usedBy
  origin.value = res.origin
}

async function reload() {
  await registry.load(props.projectId)
  await Promise.all([loadRemote(), loadUsage()])
  const saved = localStorage.getItem(selKey())
  if (saved && registry.entities.some((e) => e.id === saved)) {
    selectedId.value = saved
  } else if (!registry.entities.some((e) => e.id === selectedId.value)) {
    selectedId.value = registry.entities[0]?.id ?? null
  }
}

onMounted(reload)
watch(() => props.projectId, reload)

/* ------------------------------ 登记 ------------------------------ */

/**
 * 这一页就是登记台：所有主体（已登记 + 待登记）直接铺成卡片，不再有穿梭框弹窗。
 *
 * 待登记那批按原文算：母版里有、本集还没取用的，拆解时对不上号的名字，
 * 模型按原文找出来的候选 —— 每个都带「原文提到几次」，提到过的排前面。
 * 一次点击 = 登记一个主体，没有「选中 → 移到右栏 → 确认」这套中间动作。
 */
const detailOpen = ref(false)
/** 新主体先建到项目层：母版是跨集复用的唯一真相源，默认建母版 */
const toProject = ref(true)
const extracting = ref(false)
/** 按原文找出来的候选：只活在这次会话里，点了「登记」才落库 */
const modelPresets = ref<SubjectPreset[]>([])
const registeringName = ref('')
const registeringAll = ref(false)
/** 正在批量的是哪一段（取用 / 新建），用来只让那一段的按钮转圈 */
const bulkKey = ref<'' | 'matched' | 'create'>('')
/** 卡片区：全部 / 只看待登记 —— 两条视图共用同一份筛选与统计 */
const viewMode = ref<'all' | 'pending'>('all')
/**
 * 候选卡上临时改的类型。
 *
 * 不能直接改 candidate.type：pending 是 computed，任何上游变化都会重算出新对象，
 * 人挑好的类型会在下一次重算里被悄悄还原 —— 那种「刚才明明选了场景」的错最难查。
 */
const typeOverride = ref<Record<string, EntityType>>({})
const cardsEl = ref<HTMLElement | null>(null)
const { presets: handedPresets, seq: registerSeq } = useEntityRegister()

/**
 * 这一集的原文。
 *
 * 左栏和「② 拆解」读写的是同一份 project.story —— 主体拆分必须先有原文，
 * 让人为了粘一段稿子来回切页没道理。
 *
 * 本地留一份草稿而不是直接绑 project.current.story：用户正在往框里粘的时候，
 * 别处（拆解页 / 后端推送）改了一次，直接同步会把正在输入的内容冲掉。
 * 只有「本地没动过」才跟着外部变。
 */
const storyDraft = ref('')
const storyDirty = ref(false)
const story = computed(() => storyDraft.value)

function loadStory() {
  storyDraft.value = project.current?.story ?? ''
  storyDirty.value = false
}

onMounted(loadStory)
watch(() => project.currentId, loadStory)
watch(
  () => project.current?.story,
  (v) => {
    if (v === undefined || storyDirty.value) return
    if (v !== storyDraft.value) storyDraft.value = v
  }
)

function onStoryInput(v: string) {
  storyDraft.value = v
  storyDirty.value = true
}

async function saveStory() {
  if (!project.current) return
  await project.patch(project.current.id, { story: storyDraft.value })
  storyDirty.value = false
  message.success('原文已保存')
}

const pending = computed<PendingSubject[]>(() => {
  if (!isEpisode.value) return []
  return pendingSubjects({
    locals: registry.entities,
    // 只算本项目的母版：series.subjectsOf 已经按 seriesId 取过，这里再挡一道
    masters: remoteEntities.value.filter((m) => m.projectId === props.seriesId),
    story: story.value,
    presets: modelPresets.value
  })
})

const mentionedPending = computed(() => pending.value.filter((p) => p.mentions > 0).length)

const visiblePending = computed(() => {
  const kw = q.value.trim().toLowerCase()
  return pending.value.filter((p) => {
    if (filter.value !== 'all' && p.type !== filter.value) return false
    return !kw || p.name.toLowerCase().includes(kw)
  })
})

/**
 * 待登记按「项目里有没有」劈成两段 —— 这是两件不同的事，不能混在一个列表里：
 *   有母版 → 匹配到了，动作是「取用」（描述/参考图直接带过来）
 *   没母版 → 项目里没有，动作是「新建」（写进母版，下一集才能取）
 * 混着排的时候人得逐张读来源标签才知道点下去会发生什么，等于把判断推给了用户。
 */
const pendMatched = computed(() => visiblePending.value.filter((p) => !!p.masterId))
const pendCreate = computed(() => visiblePending.value.filter((p) => !p.masterId))

/**
 * 左栏的批量动作作用于**全部**待登记，不受搜索 / 类型筛选影响。
 * 右栏段头的批量仍按可见集走 —— 那里人正开着筛选，只处理眼前这几张才符合直觉。
 */
const pendMatchedAll = computed(() => pending.value.filter((p) => !!p.masterId))
const pendCreateAll = computed(() => pending.value.filter((p) => !p.masterId))

/** 项目母版数量：左栏要在拆分前就说清「能撞的是哪一份名单」 */
const masterCount = computed(
  () => remoteEntities.value.filter((m) => m.projectId === props.seriesId).length
)

interface PendSection {
  key: 'matched' | 'create'
  title: string
  hint: string
  btn: string
  items: PendingSubject[]
}

const pendSections = computed<PendSection[]>(() => [
  {
    key: 'matched',
    title: '匹配到项目主体',
    hint: '母版里已有，取用就带着描述和参考图进本集；原文提到过的排前面',
    btn: '取用',
    items: pendMatched.value
  },
  {
    key: 'create',
    title: '项目里没有',
    hint: '原文里有、项目里还没建过 —— 新建会写进项目母版，下一集能直接取',
    btn: '新建',
    items: pendCreate.value
  }
])

/**
 * 名字在原文里第一次出现的位置，前后各留 22 字。
 *
 * 判断「这名字真是个人/场景吗」靠的就是这一句上下文 —— 只给名字和次数，
 * 遇到「老周」这种既能是人也可能是店名的，人没法决定要不要建。
 */
function contextOf(name: string): string {
  const s = story.value
  const n = (name ?? '').trim()
  if (!s || !n) return ''
  const at = s.indexOf(n)
  if (at < 0) return ''
  const from = Math.max(0, at - 22)
  const to = Math.min(s.length, at + n.length + 22)
  return `${from > 0 ? '…' : ''}${s.slice(from, to).replace(/\s+/g, ' ')}${to < s.length ? '…' : ''}`
}

/** 已登记的主体在原文里出现几次：一眼看出谁是这一集真正在场的人 */
function mentionOf(name: string): number {
  return countMentions(story.value, name)
}

/** 本集多少片段引用了它 —— 被引用的主体不能随手删 */
function refsOf(id: ID): number {
  return beats.ordered.filter(
    (b) =>
      b.sceneId === id ||
      b.speakerId === id ||
      b.focusEntityId === id ||
      (b.entities ?? []).includes(id)
  ).length
}

function openDetail(e: Entity) {
  selectedId.value = e.id
  detailOpen.value = true
}

watch(
  () => props.active,
  (v) => {
    if (!v) detailOpen.value = false
  }
)

/** 候选卡左上角那句来源：母版能取 / 模型按原文找的 / 只有名字 */
function pendingSrcText(p: PendingSubject): string {
  if (p.source === 'master') return '项目母版'
  if (p.source === 'model') return '按原文找到'
  return '仅原文提到'
}

/**
 * 落库一条登记。三条路按「有没有母版」分：
 *   · 母版里有 → 取用（带描述带图）
 *   · 母版里没有 + 勾了先建项目层 → 先建母版再取用（下一集能直接取）
 *   · 没挂项目 / 取消勾选 → 只建在本集
 */
async function applyRegister(items: PendingSubject[]): Promise<string> {
  let injected = 0
  let synced = 0
  let createdInProject = 0
  let createdLocal = 0
  const done = new Set<string>()

  for (const p of items) {
    const type = typeOverride.value[p.name] ?? p.type
    const brief = {
      name: p.name,
      type,
      kind: type === 'character' ? p.kind : 'non_speaking',
      voiceDesc: p.voiceDesc ?? null,
      textDesc: p.textDesc ?? null,
      costumeDesc: p.costumeDesc ?? null,
      note: p.note ?? null
    }
    if (!props.seriesId || !toProject.value) {
      await registry.addEntitiesBulk(props.projectId, [{ ...brief, note: p.note ?? undefined }])
      createdLocal += 1
    } else if (p.masterId) {
      const r = await series.injectToEpisode(props.seriesId, p.masterId, props.projectId)
      if (r.reused) synced += 1
      else injected += 1
    } else {
      // 母版里没有：先建母版再取用，这一集的登记顺带把母版补齐
      const r = await series.publishToEpisode(props.seriesId, props.projectId, [brief])
      createdInProject += r.createdInProject
      // 母版里其实已有同名（只是本地没取用）时 createdInProject 为 0，那就是纯取用
      if (!r.createdInProject) injected += r.injected
      else synced += r.synced
    }
    done.add(p.name)
  }

  modelPresets.value = modelPresets.value.filter((m) => !done.has((m.name ?? '').trim()))
  for (const name of done) delete typeOverride.value[name]
  await reload()

  const parts: string[] = []
  if (createdInProject) parts.push(`项目里新建 ${createdInProject} 个并取到本集`)
  if (injected) parts.push(`取用 ${injected} 个`)
  if (synced) parts.push(`同步 ${synced} 个已有副本`)
  if (createdLocal) parts.push(`本集新建 ${createdLocal} 个`)
  return parts.join(' · ') || '没有改动'
}

async function registerOne(p: PendingSubject) {
  if (registeringName.value || registeringAll.value) return
  registeringName.value = p.name
  try {
    const done = await applyRegister([p])
    // 最后一个登记完就切回「全部」：否则刚取用的主体被"待登记"视图挡在外面，
    // 看起来像点了个空按钮
    if (!pending.value.length) viewMode.value = 'all'
    message.success(done)
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    registeringName.value = ''
  }
}

/** 分段批量：取用 / 新建各走各的，不把两件事混进一个「全部登记」 */
async function bulkRegister(key: 'matched' | 'create', list?: PendingSubject[]) {
  if (registeringAll.value || registeringName.value) return
  const items = list ?? (key === 'matched' ? pendMatched.value : pendCreate.value)
  if (!items.length) return
  registeringAll.value = true
  bulkKey.value = key
  try {
    const done = await applyRegister(items)
    if (!pending.value.length) viewMode.value = 'all'
    message.success(done)
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    registeringAll.value = false
    bulkKey.value = ''
  }
}

/**
 * 第 1 步：拆分主体。
 *
 * 顺序是「先按原文拆 → 再登记」，不是三颗并列的按钮：拆一次之后，
 * 结果要能停在左栏里（匹配到几个、几个要新建），人接着往下登记，
 * 而不是点完 toast 一飘就得自己在右边卡片里找刚才发生了什么。
 */
const lastSplit = ref<{ matched: number; create: number; quiet: number } | null>(null)

/** 左栏实时读数：原文里点名到的母版、项目里没有的名字、这一集还没出现的母版 */
const splitCounts = computed(() => {
  const m = pending.value.filter((p) => p.masterId && p.mentions > 0).length
  const c = pending.value.filter((p) => !p.masterId && p.mentions > 0).length
  const quiet = pending.value.filter((p) => p.mentions === 0).length
  return { matched: m, create: c, quiet }
})

function splitSubjects() {
  if (!isEpisode.value) return
  if (!storyDraft.value.trim()) {
    message.warning('先在左边粘上这一集的故事原文')
    return
  }
  const m = splitCounts.value.matched
  const c = splitCounts.value.create
  const quiet = splitCounts.value.quiet
  lastSplit.value = { matched: m, create: c, quiet }

  /*
   * 一个候选都没有时不要切到「待登记」视图 —— 那里是空的，已登记的主体
   * 会被一起藏起来，看起来像"点了一下把东西弄没了"。
   */
  if (!m && !c) {
    viewMode.value = 'all'
    message.info(
      quiet
        ? `原文里没提到项目里的主体；另有 ${quiet} 个项目母版这一集没出现`
        : '原文里没认出新名字，可以让模型再找一遍'
    )
    return
  }

  viewMode.value = 'pending'
  filter.value = 'all'
  q.value = ''
  void nextTick(() => cardsEl.value?.scrollTo({ top: 0, behavior: 'smooth' }))
  message.success(
    `原文里匹配到 ${m} 个项目主体${c ? ` · ${c} 个名字项目里没有，要新建` : ''}`
  )
}

/*
 * 左栏空间只够两三行：结论压成一句话，拆之前干脆不占位。
 * 完整解释在标题的 ? 里，这里只说「这次拆出了什么」。
 */
const splitNote = computed(() => {
  if (!storyDraft.value.trim()) return '先粘原文'
  if (!lastSplit.value) return ''
  const { matched, create, quiet } = splitCounts.value
  if (matched + create) return `拆出 ${matched + create} 个候选${quiet ? `，${quiet} 个母版没出现` : ''}`
  if (registry.entities.length) return '无新候选'
  return `原文没点到母版名${quiet ? `（${quiet} 个没出现）` : ''}`
})

const pendNote = computed(() => {
  if (pending.value.length) return ''
  if (lastSplit.value && registry.entities.length) return `该登记的都在了 · ${registry.entities.length} 个`
  return '第 1 步拆完才有候选'
})

/* ------------------------- 按文本新建主体 ------------------------- */

const newOpen = ref(false)
const newName = ref('')
const newType = ref<EntityType>('character')
const newBusy = ref(false)
const newNameEl = ref<InstanceType<typeof NInput> | null>(null)

/** 判重 / 找近似的名单：集层看项目母版，项目层看本页（本页就是母版） */
const masterPool = computed(() =>
  isEpisode.value
    ? remoteEntities.value.filter((m) => m.projectId === props.seriesId)
    : registry.entities
)

/** 项目里已有同名：新建直接变成取用，别再建一份 */
const newHit = computed(() => {
  const n = newName.value.trim()
  if (!n) return null
  return masterPool.value.find((m) => m.name === n) ?? null
})

const newMentions = computed(() => countMentions(story.value, newName.value.trim()))

/**
 * 名字对不上但像是同一个人的情况：「陈默」/「陈默声」、「林晚」/「林小晚」。
 * 剧本里同一人换个写法很常见，直接当新主体建会得到两个各写一半设定的半成品。
 */
const newAlias = computed(() => {
  const n = newName.value.trim()
  if (n.length < 2 || newHit.value) return null
  return (
    masterPool.value.find((m) => {
      const a = (m.name ?? '').trim()
      if (a.length < 2 || a === n) return false
      if (Math.abs(a.length - n.length) > 2) return false
      return a.includes(n) || n.includes(a)
    }) ?? null
  )
})

function useAlias() {
  if (newAlias.value) newName.value = newAlias.value.name
}

function openNew(type: EntityType = 'character') {
  newOpen.value = true
  newName.value = ''
  newType.value = type
  void nextTick(() => newNameEl.value?.focus())
}

async function createNamed() {
  const name = newName.value.trim()
  if (!name) {
    message.warning('先给它起个名字')
    return
  }
  if (registry.entities.some((e) => e.name === name)) {
    message.warning(isEpisode.value ? `本集已经有「${name}」了` : `已经有「${name}」了`)
    return
  }
  newBusy.value = true
  try {
    const hit = newHit.value
    const p: PendingSubject = hit
      ? {
          name,
          type: hit.type,
          kind: hit.kind,
          source: 'master',
          masterId: hit.id,
          mentions: newMentions.value,
          hasPicture: (hit.pictureN ?? 0) > 0,
          textDesc: hit.textDesc ?? null,
          voiceDesc: hit.voiceDesc ?? null,
          costumeDesc: hit.costumeDesc ?? null,
          note: hit.note ?? null
        }
      : {
          name,
          type: newType.value,
          kind: 'non_speaking',
          source: 'text',
          mentions: newMentions.value,
          hasPicture: false
        }
    message.success(await applyRegister([p]))
    newOpen.value = false
    newName.value = ''
    viewMode.value = 'all'
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    newBusy.value = false
  }
}

/** 让模型按原文挑一遍：结果进「待登记」，人点一下才落库 */
async function extractFromStory() {
  if (!isEpisode.value) return
  if (!storyDraft.value.trim()) {
    message.warning('先在左边粘上这一集的故事原文')
    return
  }
  if (!provider.ready) {
    message.warning('请先在模型设置里填好 Base URL / Key / 模型名')
    return
  }
  extracting.value = true
  try {
    const list = await pipeline.runEntityExtract(
      story.value,
      registry.entities.map((e) => e.name),
      project.settings,
      {
        projectSubjects: remoteEntities.value
          .filter((m) => m.projectId === props.seriesId)
          .map((m) => ({
            id: m.id,
            name: m.name,
            type: m.type,
            kind: m.kind,
            textDesc: m.textDesc,
            costumeDesc: m.costumeDesc,
            voiceDesc: m.voiceDesc,
            note: m.note
          }))
      }
    )
    const known = new Set([
      ...registry.entities.map((e) => e.name),
      ...pending.value.map((p) => p.name)
    ])
    let added = 0
    for (const p of list) {
      const name = (p.name ?? '').trim()
      if (!name || known.has(name)) continue
      known.add(name)
      modelPresets.value = [...modelPresets.value, { ...p, name }]
      added += 1
    }
    viewMode.value = 'pending'
    if (!added) message.info('模型没找到新的主体')
    else message.success(`按原文找到 ${added} 个候选，在「项目里没有」那一段，点「新建」落库`)
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    extracting.value = false
  }
}

// 别处（拆解）发现「这些名字没登记」：接过来放进待登记，并切到那一栏
watch(registerSeq, () => {
  if (!isEpisode.value) return
  const incoming = handedPresets.value.filter((p) => (p.name ?? '').trim())
  if (incoming.length) {
    modelPresets.value = [...modelPresets.value, ...incoming]
    message.info(`${incoming.length} 个名字还没登记，已在「待登记」里等你确认`)
  }
  viewMode.value = 'pending'
  filter.value = 'all'
  q.value = ''
  void nextTick(() => cardsEl.value?.scrollTo({ top: 0, behavior: 'smooth' }))
})

async function pushToProject() {
  const e = cur.value
  if (!e) return
  if (!isEpisode.value) return
  if (!props.seriesId) {
    message.warning('这一集不属于任何项目，无法推送')
    return
  }
  try {
    const res = await series.promoteToSeries(props.projectId, e.id, props.seriesId)
    await loadRemote()
    message.success(
      res.reused
        ? `项目里已有「${res.entity.name}」，已同步最新描述`
        : `已把「${e.name}」推送至项目（项目里保留独立副本）`
    )
  } catch (err) {
    message.error((err as Error).message)
  }
}

/** 项目层：把大主体下发到某几集 */
const injectOpen = ref(false)
const injectIds = ref<ID[]>([])
const injectTarget = ref<Entity | null>(null)

function openInject() {
  injectTarget.value = cur.value
  // 已经取过的集先勾上：再确认一次就是"同步最新描述"
  const id = cur.value?.id
  injectIds.value = id ? [...(usedBy.value[id] ?? [])] : []
  injectOpen.value = true
}

function toggleInject(id: ID, v: boolean) {
  injectIds.value = v ? [...injectIds.value, id] : injectIds.value.filter((x) => x !== id)
}

async function confirmInject() {
  const e = injectTarget.value
  if (!e) return
  if (!injectIds.value.length) {
    message.warning('先勾选要下发的集')
    return
  }
  let created = 0
  let synced = 0
  for (const eid of injectIds.value) {
    const res = await series.injectToEpisode(props.projectId, e.id, eid)
    if (res.reused) synced += 1
    else created += 1
  }
  injectOpen.value = false
  await loadUsage()
  const parts = []
  if (created) parts.push(`下发到 ${created} 集`)
  if (synced) parts.push(`同步 ${synced} 个已有副本`)
  message.success(parts.join('，') || '已下发')
}

/* ------------------------------ 展示辅助 ------------------------------ */

function sourceLabel(e: Entity): string | null {
  if (!e.sourceId) return null
  if (isEpisode.value) return '取自项目'
  const ep = origin.value[e.id]
  return ep ? `由 ${episodeName(ep)} 推送` : '来自其它集'
}

const usageOfCur = computed(() => {
  const id = cur.value?.id
  return id ? usedBy.value[id] ?? [] : []
})
</script>

<template>
  <div class="sm-wrap">
    <!--
      左栏：和「② 拆解」同一个形状 —— 上面是原文，下面是这一步要做的事。
      主体得先从原文里拆出来（第 1 步），才有东西可登记（第 2 步）。
      三步并排摆在顶部条上时，看起来像"随便点哪个都行"，其实顺序是固定的。
    -->
    <aside v-if="isEpisode" class="sm-side">
      <div class="sm-side-head">
        <span class="row" style="gap: 0; align-items: center">
          故事原文
          <InfoTip :width="300" text="先在这里把这一集有谁拆出来，再去「② 拆解」分镜。" />
        </span>
        <span v-if="storyDirty" class="sm-side-dirty">未保存</span>
        <n-button size="tiny" quaternary @click="saveStory">保存</n-button>
      </div>

      <div class="scroll-pane sm-side-body">
        <div class="sm-side-story">
          <n-input
            :value="storyDraft"
            type="textarea"
            size="small"
            placeholder="粘贴故事 / 剧本 / 分场稿"
            :input-props="{ style: 'height:100%; font-size:12.5px; line-height:1.75' }"
            @update:value="onStoryInput"
          />
        </div>

        <!-- 第 1 步：拆分主体。动作挂在标题行右侧，省掉一整行 -->
        <section class="sm-step">
          <div class="sm-step-h">
            <span class="sm-step-n" :class="{ 'is-done': !!lastSplit }">{{ lastSplit ? '✓' : '1' }}</span>
            <span class="sm-step-t">拆分主体</span>
            <InfoTip
              :width="330"
              text="按原文认人，纯本地完成：拿项目母版名单去撞这一集的故事原文，不花额度。&#10;本地认不出的名字，再点「模型认」交给模型。"
            />
            <span class="sm-step-sp" />
            <n-button
              size="small"
              type="primary"
              :disabled="!storyDraft.trim()"
              :title="storyDraft.trim() ? '拿这一集的故事原文去撞项目母版，不花额度' : '还没有故事原文'"
              @click="splitSubjects"
            >
              拆分
            </n-button>
            <n-button
              size="small"
              quaternary
              :loading="extracting"
              :disabled="!storyDraft.trim()"
              title="本地认不出的名字，交给模型再挑一遍"
              @click="extractFromStory"
            >
              模型认
            </n-button>
          </div>
          <div class="sm-step-b">
            <div class="sm-side-tags">
              <span class="sm-side-tag">本集 <b>{{ registry.entities.length }}</b></span>
              <span class="sm-side-tag">母版 <b>{{ masterCount }}</b></span>
              <span v-if="splitCounts.matched" class="sm-side-tag is-hit">
                点名 <b>{{ splitCounts.matched }}</b>
              </span>
              <span v-if="splitCounts.create" class="sm-side-tag is-new">
                新建 <b>{{ splitCounts.create }}</b>
              </span>
            </div>
            <div v-if="splitNote" class="sm-step-note">{{ splitNote }}</div>
          </div>
        </section>

        <!-- 第 2 步：登记到本集 -->
        <section class="sm-step">
          <div class="sm-step-h">
            <span class="sm-step-n" :class="{ 'is-idle': !pending.length }">2</span>
            <span class="sm-step-t">登记到本集</span>
            <InfoTip
              :width="330"
              text="只在拆解里用到的名字，必须先在登记表里有一份，否则片段落库后全是未绑定。&#10;母版里已有的直接取用（带描述和参考图），母版里没有的才新建。"
            />
            <span class="sm-step-sp" />
            <n-button size="tiny" quaternary title="原文里有母版没收录的名字，就在这里加" @click="openNew()">
              ＋ 新建
            </n-button>
          </div>
          <div class="sm-step-b">
            <div v-if="pendMatchedAll.length" class="sm-step-row">
              <span class="sm-step-row-t">
                匹配到项目主体 <b>{{ pendMatchedAll.length }}</b>
              </span>
              <n-button
                size="tiny"
                type="primary"
                ghost
                :loading="bulkKey === 'matched'"
                @click="bulkRegister('matched', pendMatchedAll)"
              >
                全部取用
              </n-button>
            </div>
            <div v-if="pendCreateAll.length" class="sm-step-row">
              <span class="sm-step-row-t">
                项目里没有 <b>{{ pendCreateAll.length }}</b>
              </span>
              <n-button
                size="tiny"
                ghost
                :loading="bulkKey === 'create'"
                :disabled="registeringAll"
                @click="bulkRegister('create', pendCreateAll)"
              >
                全部新建
              </n-button>
            </div>
            <div v-if="pendNote" class="sm-step-note">{{ pendNote }}</div>

            <!-- 新建主体：就地竖排一行，不弹窗 —— 名字照原文写 -->
            <div v-if="newOpen" class="sm-newrow is-side">
              <n-input
                ref="newNameEl"
                v-model:value="newName"
                size="small"
                placeholder="名字，和原文里写的一致"
                @keyup.enter="createNamed"
              />
              <div class="sm-newrow-foot">
                <n-select v-model:value="newType" size="small" :options="typeOptions" style="width: 84px; flex: none" />
                <n-button size="small" type="primary" :loading="newBusy" @click="createNamed">创建</n-button>
                <n-button size="small" quaternary @click="newOpen = false">取消</n-button>
              </div>
              <n-checkbox v-if="seriesId" v-model:checked="toProject" size="small" title="存进项目母版，下一集能直接取用">
                同时存进项目层
              </n-checkbox>
              <div v-if="newHit" class="sm-newrow-hit">项目里已有同名，会直接取用</div>
              <div v-else-if="newAlias" class="sm-newrow-alias">
                项目里有「{{ newAlias.name }}」，<button @click="useAlias">用它</button>
              </div>
              <div v-else-if="newMentions" class="sm-newrow-ctx">原文提到 {{ newMentions }} 次</div>
              <div v-else-if="newName.trim()" class="sm-newrow-miss">原文里没找到这个名字</div>
            </div>
          </div>
        </section>
      </div>
    </aside>

    <!-- 右：卡片流。项目层没有左栏，这一块就是整页 -->
    <div class="sm-body">
      <!-- 项目层：母版说明条（集层的信息在左栏两步里） -->
      <header v-if="!isEpisode" class="sm-band">
        <div class="sm-band-main">
          <div class="sm-band-t row" style="gap: 0; align-items: center">
            项目主体
            <InfoTip
              :width="330"
              text="跨集复用的母版：改这里不会自动影响已经取用的集，要下发得显式「下发到集」。"
            />
          </div>
          <div class="sm-band-s">
            <span>{{ registry.entities.length }} 个主体</span>
          </div>
        </div>
        <div class="sm-band-act">
          <n-button size="small" @click="openNew()">＋ 新建主体</n-button>
        </div>
      </header>

      <!-- 项目层的新建行：横排就够宽 -->
      <div v-if="newOpen && !isEpisode" class="sm-newrow">
        <span class="sm-newrow-t">新建主体</span>
        <n-input
          ref="newNameEl"
          v-model:value="newName"
          size="small"
          class="sm-newrow-name"
          placeholder="名字，和原文里写的一致"
          @keyup.enter="createNamed"
        />
        <n-select v-model:value="newType" size="small" :options="typeOptions" style="width: 92px; flex: none" />
        <span v-if="newHit" class="sm-newrow-hit">项目里已有同名，会直接取用</span>
        <span v-else-if="newAlias" class="sm-newrow-alias">
          项目里有「{{ newAlias.name }}」，<button @click="useAlias">用它</button>
        </span>
        <div style="flex: 1" />
        <n-button size="small" quaternary @click="newOpen = false">取消</n-button>
        <n-button size="small" type="primary" :loading="newBusy" @click="createNamed">创建</n-button>
      </div>

      <div class="panel-head" style="border-radius: 0">
        <div class="row" style="gap: 10px; min-width: 0">
          <span>{{ isEpisode ? '本集主体' : '主体清单' }}</span>
          <n-tag size="small" :bordered="false">已登记 {{ registry.entities.length }}</n-tag>
          <n-tag v-if="isEpisode && pending.length" size="small" :bordered="false" type="warning">
            待登记 {{ pending.length }}<template v-if="mentionedPending"> · 原文提到 {{ mentionedPending }}</template>
          </n-tag>
        </div>
        <div v-if="isEpisode" class="sm-seg">
          <button class="sm-seg-b" :class="{ on: viewMode === 'all' }" @click="viewMode = 'all'">全部</button>
          <button class="sm-seg-b" :class="{ on: viewMode === 'pending' }" @click="viewMode = 'pending'">
            待登记<span v-if="pending.length" class="sm-seg-n">{{ pending.length }}</span>
          </button>
        </div>
      </div>

      <!-- 工具条：搜索 / 类型 -->
      <div class="sm-tool">
        <n-input
          v-model:value="q"
          size="small"
          clearable
          class="sm-tool-q"
          placeholder="搜索名称 / 描述 / 音色"
        />
        <div class="sm-chips">
          <button
            v-for="f in typeFilters"
            :key="f.key"
            class="sm-chip"
            :class="{ on: filter === f.key }"
            @click="filter = f.key"
          >
            {{ f.label }}<span class="sm-chip-n">{{ f.n }}</span>
          </button>
        </div>
        <div style="flex: 1" />
      </div>

      <!-- 主体卡片：已登记按类型分区一排排铺开，待登记的放在最上面 -->
      <div ref="cardsEl" class="sm-cards scroll-pane">
      <!--
        待登记分两段：能匹配到母版的（取用）和匹配不到的（新建）。
        动作词直接写在按钮上，点之前就知道会发生什么。
      -->
      <section v-for="sec in pendSections" v-show="isEpisode && sec.items.length" :key="sec.key" class="sm-grp">
        <div class="sm-grp-h">
          <span class="sm-grp-t">{{ sec.title }}</span>
          <span class="sm-grp-n">{{ sec.items.length }}</span>
          <span class="sm-grp-s">{{ sec.hint }}</span>
          <div style="flex: 1" />
          <n-button
            size="tiny"
            type="primary"
            ghost
            :loading="bulkKey === sec.key"
            :disabled="registeringAll && bulkKey !== sec.key"
            @click="bulkRegister(sec.key)"
          >
            全部{{ sec.btn }}
          </n-button>
        </div>
        <div class="sm-cards-grid">
          <article
            v-for="p in sec.items"
            :key="p.name"
            class="sm-pend"
            :class="{ 'is-new': sec.key === 'create' }"
          >
            <div class="sm-pend-top">
              <span class="sm-pend-type">{{ ENTITY_TYPE_LABEL[typeOverride[p.name] ?? p.type] }}</span>
              <span class="sm-pend-src" :class="`is-${p.source}`">{{ pendingSrcText(p) }}</span>
              <span v-if="p.mentions" class="sm-pend-hit">原文 ×{{ p.mentions }}</span>
            </div>
            <div class="sm-pend-name">{{ p.name }}</div>
            <div class="sm-pend-desc">
              {{ p.textDesc || (p.masterId ? '母版里也还没写描述，取用后在这里补' : '还没有描述，' + sec.btn + '后补') }}
            </div>
            <div v-if="sec.key === 'create' && contextOf(p.name)" class="sm-pend-ctx">
              {{ contextOf(p.name) }}
            </div>
            <div class="sm-pend-foot">
              <span v-if="p.hasPicture" class="sm-pend-flag">带参考图</span>
              <span v-if="p.kind === 'speaking'" class="sm-pend-flag">会说话</span>
              <div style="flex: 1" />
              <n-select
                v-if="!p.masterId"
                :value="typeOverride[p.name] ?? p.type"
                size="tiny"
                :options="typeOptions"
                style="width: 76px; flex: none"
                @update:value="(v: EntityType) => (typeOverride[p.name] = v)"
              />
              <n-button
                size="tiny"
                type="primary"
                :loading="registeringName === p.name"
                :disabled="registeringAll"
                @click="registerOne(p)"
              >
                {{ sec.btn }}
              </n-button>
            </div>
          </article>
        </div>
      </section>

      <template v-if="viewMode !== 'pending'">
        <section v-for="g in groups" :key="g.type" class="sm-grp">
          <div class="sm-grp-h">
            <span class="sm-grp-t">{{ g.label }}</span>
            <span class="sm-grp-n">{{ g.items.length }}</span>
            <div style="flex: 1" />
            <button class="sm-grp-add" :data-add="g.type" @click="openNew(g.type)">
              ＋ 新建{{ g.label }}
            </button>
          </div>
          <div v-if="g.items.length" class="sm-cards-grid">
            <SubjectCard
              v-for="e in g.items"
              :key="e.id"
              :entity="e"
              :img="imageUrlOf(e)"
              :mentions="mentionOf(e.name)"
              :refs="refsOf(e.id)"
              :scope="scope"
              :used="usedBy[e.id]?.length ?? 0"
              @open="openDetail(e)"
            />
          </div>
          <div v-else class="sm-grp-empty">
            {{ q ? '没有匹配的' : '还没有' }}{{ g.label }}
          </div>
        </section>
      </template>

      <div v-if="viewMode === 'pending' && !visiblePending.length" class="sm-grp">
        <div class="sm-grp-empty">
          没有待登记的候选
          <InfoTip
            size="sm"
            :width="320"
            text="左边第 1 步点「拆分主体」，按原文撞一遍项目母版；本地认不出的名字，再点「模型再认一遍」。"
          />
        </div>
      </div>

      <div v-if="!registry.entities.length && !visiblePending.length && viewMode !== 'pending'" class="sm-empty">
        <div class="sm-empty-t row" style="justify-content: center; gap: 0; align-items: center">
          还没有主体
          <InfoTip
            :width="360"
            :text="
              '主体分三类：角色（可以说话、带音色描述）、场景（每个片段必有一个）、道具（物件不发声）。' +
              (isEpisode ? '先建好描述与参考图，项目里的主体也能直接取用。' : '先建好描述与参考图，再下发到各个集里取用。')
            "
          />
        </div>
        <div class="row" style="gap: 8px; justify-content: center">
          <n-button size="small" type="primary" @click="openNew('character')">＋ 角色</n-button>
          <n-button size="small" @click="openNew('scene')">＋ 场景</n-button>
          <n-button size="small" @click="openNew('prop')">＋ 道具</n-button>
        </div>
      </div>
      </div>
    </div>

    <!-- 详情抽屉：卡片只做「看」，改描述 / 音色 / 设定图在这里 -->
    <n-drawer v-model:show="detailOpen" :width="1040" placement="right">
      <!-- 右：详情 -->
      <section class="sm-main scroll-pane">
      <template v-if="cur">
        <div class="sm-title">
          <n-input
            ref="nameInput"
            :value="cur.name"
            size="large"
            placeholder="主体名称"
            :bordered="false"
            style="flex: 1; min-width: 120px; font-size: 17px; font-weight: 600"
            @update:value="setName"
          />
          <n-select
            :value="cur.type"
            size="small"
            :options="typeOptions"
            style="width: 96px; flex: none"
            @update:value="setType"
          />
          <div v-if="typeHint.canSpeak" class="sm-kind">
            <n-switch :value="cur.kind === 'speaking'" size="small" @update:value="setKind" />
            <span>会说话</span>
          </div>
          <span v-else class="sm-kind sm-kind-off" :title="`${ENTITY_TYPE_LABEL[cur.type]}不发声，不占 (Sx)`">
            不发声
          </span>
        </div>

        <div class="sm-tags">
          <n-tag v-if="cur.subjectN != null" size="small" :bordered="false" type="info">
            S{{ cur.subjectN }}
          </n-tag>
          <n-tag v-if="cur.pictureN" size="small" :bordered="false">
            &lt;Picture {{ cur.pictureN }}&gt;
          </n-tag>
          <n-tag v-else size="small" :bordered="false" type="warning">纯文本（无参考图）</n-tag>
          <n-tag v-if="sourceLabel(cur)" size="small" :bordered="false">{{ sourceLabel(cur) }}</n-tag>
          <span v-if="!isEpisode && usageOfCur.length" class="muted" style="font-size: 12px">
            已被 {{ usageOfCur.map(episodeName).join('、') }} 取用
          </span>
          <span v-if="!isEpisode && !usageOfCur.length" class="muted" style="font-size: 12px">
            还没有集取用
          </span>
        </div>

        <div class="sm-grid" :class="{ 'sm-grid-char': cur.type === 'character' }">
          <!-- 参考图：角色走「设定图组」（基模头 → 组头 → 三视图），场景 / 道具一张就够 -->
          <div class="sm-card">
            <div v-if="cur.type !== 'character'" class="sm-card-h">参考图</div>
            <SubjectSheetPanel v-if="cur.type === 'character'" :entity="cur" />
            <template v-else>
              <div class="sm-img-wrap" @click="pickImage">
                <img v-if="curImageUrl" :src="curImageUrl" alt="" />
                <div v-else class="sm-img-empty">
                  <div>点这里上传参考图</div>
                  <div class="sm-img-empty-sub">有图会占一个 &lt;Picture N&gt; 槽位</div>
                </div>
              </div>
              <div class="row" style="gap: 6px; flex-wrap: wrap">
                <n-button size="small" @click="pickImage">{{ curImageUrl ? '换一张' : '上传' }}</n-button>
                <n-button size="small" @click="genTarget = cur">AI 生成 / 图生图</n-button>
                <n-button v-if="curAsset" size="small" quaternary type="error" @click="clearImage">
                  移除
                </n-button>
              </div>
              <input
                ref="imgInput"
                type="file"
                accept="image/*"
                style="display: none"
                @change="onPickImage"
              />
              <template v-if="curAsset">
                <n-input
                  class="sm-imgdesc"
                  type="textarea"
                  size="small"
                  :rows="2"
                  :value="curAsset.desc ?? ''"
                  placeholder="图片说明：图里到底画了什么（供大模型理解参考图，不进最终提示词）"
                  style="margin-top: 8px"
                  @update:value="(v: string) => curAsset && registry.updateAsset(curAsset.id, { desc: v })"
                />
              </template>
            </template>
          </div>

          <!-- 描述 / 声音 -->
          <div class="sm-card">
            <div class="sm-card-h row" style="gap: 0; align-items: center">
              长相
              <InfoTip
                v-if="cur.type === 'character'"
                :width="340"
                text="只写长相：脸型、五官、发型、肤色、年龄、骨架、标志性细节。&#10;基模头与组头都只用这段，写进来的衣服会挤进头肩构图 —— 穿着写到下面的「服装与身形」。"
              />
              <InfoTip
                v-else
                :width="340"
                :text="`${typeHint.desc}。这一段直接拼进出图提示词，穿着 / 人物关系都别写在这里。`"
              />
              <span style="flex: 1" />
              <AiWrite
                title="写长相"
                hint="只写脸与身形，不许写穿着 —— 穿着在下面单独一段。"
                :presets="AI_DESC_PRESETS.textDesc"
                :busy="aiDescBusy === 'textDesc'"
                :disabled="!provider.ready || (!!aiDescBusy && aiDescBusy !== 'textDesc')"
                :disabled-reason="provider.ready ? '另一段描述正在生成' : '还没配置文本模型'"
                variant="chip"
                label="AI 写"
                @run="(brief: string) => aiEntityDesc('textDesc', brief)"
              />
            </div>
            <n-input
              class="sm-desc"
              type="textarea"
              :rows="5"
              size="small"
              :value="cur.textDesc ?? ''"
              :placeholder="typeHint.placeholder"
              @update:value="(v: string) => registry.updateEntity(cur!.id, { textDesc: v || null })"
            />
            <!-- 串味提示：头部描述里写了穿着，两边出图一定会打架。动态内容，必须留在页面上 -->
            <div v-if="costumeLeak.length" class="sm-warn">
              这里写了穿着（{{ costumeLeak.join('、') }}）
              <InfoTip
                size="sm"
                :width="330"
                text="头部两步（基模头 / 组头）生成时会自动略过这几句，三视图仍照它画全身 —— 不改也能出对图。&#10;想让不同组换不同造型时，再把穿什么拆到下面的「服装与身形」。"
              />
            </div>

            <template v-if="cur.type === 'character'">
              <div class="sm-grp-h row" style="gap: 0; align-items: center">
                服装与身形
                <InfoTip size="sm" :width="280" text="只进三视图：全身才装得下一套衣服。" />
                <span style="flex: 1" />
                <AiWrite
                  title="写服装与身形"
                  hint="款式、颜色、材质、鞋、配饰 + 高矮胖瘦；不写长相与剧情状态。"
                  :presets="AI_DESC_PRESETS.costumeDesc"
                  :busy="aiDescBusy === 'costumeDesc'"
                  :disabled="!provider.ready || (!!aiDescBusy && aiDescBusy !== 'costumeDesc')"
                  :disabled-reason="provider.ready ? '另一段描述正在生成' : '还没配置文本模型'"
                  variant="chip"
                  label="AI 写"
                  @run="(brief: string) => aiEntityDesc('costumeDesc', brief)"
                />
              </div>
              <n-input
                class="sm-desc"
                type="textarea"
                :rows="3"
                size="small"
                :value="cur.costumeDesc ?? ''"
                placeholder="这一套造型穿什么：深灰工装夹克、磨白牛仔裤、旧帆布鞋；身高 178，偏瘦，肩窄"
                @update:value="(v: string) => registry.updateEntity(cur!.id, { costumeDesc: v || null })"
              />
            </template>

            <template v-if="cur.kind === 'speaking'">
              <div class="sm-grp-h row" style="gap: 0; align-items: center">
                声音描述
                <InfoTip
                  size="sm"
                  :width="300"
                  :text="`跨段逐字复用，末尾 (S${cur.subjectN ?? '?'}) 自动追加。`"
                />
                <span style="flex: 1" />
                <AiWrite
                  title="写音色"
                  hint="给音色设计模型看的一句话：年龄性别、音高、音质、说话方式、气质。"
                  :presets="AI_DESC_PRESETS.voiceDesc"
                  :busy="aiDescBusy === 'voiceDesc'"
                  :disabled="!provider.ready || (!!aiDescBusy && aiDescBusy !== 'voiceDesc')"
                  :disabled-reason="provider.ready ? '另一段描述正在生成' : '还没配置文本模型'"
                  variant="chip"
                  label="AI 写"
                  @run="(brief: string) => aiEntityDesc('voiceDesc', brief)"
                />
              </div>
              <n-input
                v-model:value="voiceDraft"
                class="sm-voice"
                type="textarea"
                :rows="3"
                size="small"
                placeholder="speaking with a young male voice, slightly hoarse, tired but determined"
                @update:value="onVoiceInput"
                @blur="flushVoice"
              />
              <div class="sm-samples">
                <button
                  v-for="s in VOICE_SAMPLES"
                  :key="s"
                  class="sm-sample"
                  :title="`插入：${s}`"
                  @click="addVoiceSample(s)"
                >
                  {{ s }}
                </button>
              </div>

              <!-- 音色包：描述 → 候选 → 试听 → 固定 -->
              <div class="sm-grp-h row" style="gap: 0; align-items: center">
                音色包
                <span v-if="cur.voicePack" class="sm-card-h-sub">已固定 · {{ cur.voicePack.id }}</span>
                <InfoTip
                  size="sm"
                  :width="320"
                  text="设计只出候选，听过再固定。&#10;固定后段内「合成台词」用的就是它：同一角色每段都念同一个声音；取消固定要重新设计一次才能用。"
                />
              </div>

              <div v-if="cur.voicePack" class="sm-vp is-fixed">
                <div class="sm-vp-row">
                  <button
                    type="button"
                    class="sm-vp-play"
                    :class="{ on: isPlaying(packPlayId), busy: packBusy }"
                    :title="packBusy ? '正在用这个音色合成试听…' : '用固定音色念一句试听'"
                    :disabled="packBusy"
                    @click="playPack"
                  >
                    <span v-if="packBusy" class="sm-vp-dot" />
                    <span v-else>{{ isPlaying(packPlayId) ? '❚❚' : '▶' }}</span>
                  </button>
                  <div class="sm-vp-main">
                    <div class="sm-vp-t">固定音色 · {{ cur.voicePack.id }}</div>
                    <div class="sm-vp-s">{{ cur.voicePack.desc || '（没有记录描述）' }}</div>
                  </div>
                  <n-button size="tiny" quaternary :disabled="voiceBusy" @click="designVoice()">
                    重新设计
                  </n-button>
                  <n-popconfirm @positive-click="clearVoicePack">
                    <template #trigger>
                      <n-button size="tiny" quaternary type="error">取消固定</n-button>
                    </template>
                    取消固定后，段内配音要重新设计一次音色才能用。
                  </n-popconfirm>
                </div>
              </div>

              <div v-else class="sm-vp">
                <div class="sm-vp-row">
                  <n-button
                    size="tiny"
                    type="primary"
                    ghost
                    :loading="voiceBusy"
                    :disabled="!voiceDescPlain"
                    @click="designVoice()"
                  >
                    {{ voiceBusy ? '正在设计…' : voiceCands.length ? '按当前描述重做' : '① 按描述设计音色' }}
                  </n-button>
                  <n-button
                    v-if="voiceCands.length"
                    size="tiny"
                    quaternary
                    :disabled="voiceBusy"
                    @click="designVoice(true)"
                  >
                    换一批
                  </n-button>
                  <span class="sm-vp-s">
                    {{ voiceDescPlain ? '一次出 3 条候选，听完点「固定这个」' : '先写声音描述' }}
                  </span>
                </div>

                <div
                  v-if="voiceSvc && !voiceSvc.hub?.on && (!voiceSvc.qwen3.ok || !voiceSvc.s2.ok)"
                  class="sm-vp-warn"
                >
                  音色服务没起全：
                  <b :class="{ bad: !voiceSvc.qwen3.ok }">qwen3 设计{{ voiceSvc.qwen3.ok ? '在线' : '离线' }}</b>
                  ·
                  <b :class="{ bad: !voiceSvc.s2.ok }">s2 合成{{ voiceSvc.s2.ok ? '在线' : '离线' }}</b>
                  （跑 start_both_services.bat，或起运行前服务让它在单卡上按需加载）
                </div>

                <div v-if="voiceErr" class="sm-vp-err">{{ voiceErr }}</div>

                <div v-for="c in voiceCands" :key="c.name" class="sm-vp-cand">
                  <button
                    type="button"
                    class="sm-vp-play"
                    :class="{ on: isPlaying(c.name) }"
                    title="试听这条候选"
                    @click="playCandidate(c)"
                  >
                    {{ isPlaying(c.name) ? '❚❚' : '▶' }}
                  </button>
                  <div class="sm-vp-main">
                    <div class="sm-vp-t">候选 · 种子 {{ c.seed }}</div>
                    <div class="sm-vp-s">{{ c.seconds }}s · {{ c.cached ? '之前生成过' : '刚生成' }}</div>
                  </div>
                  <n-button
                    size="tiny"
                    type="primary"
                    :loading="voiceFixId === c.name"
                    :disabled="!!voiceFixId"
                    @click="fixCandidate(c)"
                  >
                    ② 固定这个
                  </n-button>
                </div>
              </div>
            </template>
            <div v-else class="sm-hint" style="margin-top: 12px">
              <template v-if="typeHint.canSpeak">打开「会说话」后出现声音描述与 (Sx) 编号。</template>
              <template v-else>{{ ENTITY_TYPE_LABEL[cur.type] }}不发声，也不占 (Sx)。</template>
            </div>

            <div class="sm-grp-h">备注</div>
            <n-input
              class="sm-note"
              type="textarea"
              :rows="2"
              size="small"
              :value="cur.note ?? ''"
              placeholder="给自己看的备注（不进提示词）"
              @update:value="(v: string) => registry.updateEntity(cur!.id, { note: v || undefined })"
            />
          </div>
        </div>

        <div class="sm-foot">
          <template v-if="isEpisode">
            <n-button size="small" type="primary" ghost @click="pushToProject">
              推送至项目
            </n-button>
            <InfoTip
              :width="330"
              :text="
                cur.sourceId
                  ? '本集主体取自项目 —— 推送会同步回项目里的同一个主体。'
                  : '只在项目里留一份母版，之后别的集也能取。'
              "
            />
          </template>
          <template v-else>
            <n-button size="small" type="primary" ghost @click="openInject">取到某一集…</n-button>
            <InfoTip :width="300" text="下发到集是复制：集里改描述 / 换图不会回写这里。" />
          </template>
          <div style="flex: 1" />
          <n-popconfirm @positive-click="removeCur">
            <template #trigger>
              <n-button size="small" quaternary type="error">删除主体</n-button>
            </template>
            删除「{{ cur.name }}」及其参考图？
          </n-popconfirm>
        </div>
      </template>

      <div v-else class="sm-empty">
        <template v-if="!registry.entities.length">
          <div class="sm-empty-t row" style="justify-content: center; gap: 0; align-items: center">
            还没有主体
            <InfoTip
              :width="360"
              :text="
                '主体分三类：角色（可以说话、带音色描述）、场景（每个片段必有一个）、道具（物件不发声）。' +
                (isEpisode ? '先建好描述与参考图，项目里的主体也可以直接取用。' : '先建好描述与参考图，再下发到各个集里取用。')
              "
            />
          </div>
          <div class="row" style="gap: 8px; justify-content: center">
            <n-button size="small" type="primary" @click="openNew('character')">＋ 角色</n-button>
            <n-button size="small" @click="openNew('scene')">＋ 场景</n-button>
            <n-button size="small" @click="openNew('prop')">＋ 道具</n-button>
          </div>
        </template>
        <div v-else class="sm-empty-s">左侧选一个主体，或在分组标题上点「＋」新建</div>
      </div>
    </section>
    </n-drawer>

    <!-- 下发：项目 → 集 -->
    <n-modal v-model:show="injectOpen" preset="card" title="取到某一集" style="max-width: 420px">
      <div class="muted" style="font-size: 12.5px; line-height: 1.8; margin-bottom: 10px">
        把「{{ injectTarget?.name }}」复制到选中的集。已勾选的是已经取过的集，再确认一次会同步最新描述。
      </div>
      <div class="stack" style="gap: 8px">
        <n-checkbox
          v-for="ep in series.episodes"
          :key="ep.id"
          :checked="injectIds.includes(ep.id)"
          @update:checked="(v: boolean) => toggleInject(ep.id, v)"
        >
          {{ ep.name }}
          <span v-if="injectIds.includes(ep.id) && (usedBy[injectTarget?.id ?? ''] ?? []).includes(ep.id)" class="muted">
            · 已取用
          </span>
        </n-checkbox>
        <div v-if="!series.episodes.length" class="muted" style="font-size: 12.5px">这个项目还没有集</div>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end; gap: 8px">
          <n-button @click="injectOpen = false">取消</n-button>
          <n-button type="primary" @click="confirmInject">确认下发</n-button>
        </div>
      </template>
    </n-modal>

    <ImageGenModal
      v-if="genTarget"
      :show="true"
      title="主体参考图"
      :default-prompt="images.subjectPrompt(genTarget)"
      :base-image-url="curImageUrl"
      default-size="1280x720"
      @done="onGenerated"
      @update:show="(v: boolean) => { if (!v) genTarget = null }"
    />
  </div>
</template>

<style scoped>
/* 页 = 左栏（原文 / 第 1 步 / 第 2 步）+ 右栏卡片流。
   项目层没有左栏，.sm-body 自己就是整页。 */
.sm-wrap {
  height: 100%;
  min-height: 0;
  display: flex;
  background: var(--panel);
}

/* 左栏：宽度和「② 拆解」的原文栏一致，切页时视线不用重新适应 */
.sm-side {
  width: 380px;
  flex: 0 0 380px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line);
  background: var(--panel);
}
.sm-side-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--line);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}
.sm-side-head > .row {
  flex: 1;
  min-width: 0;
}
.sm-side-dirty {
  margin-left: 6px;
  font-size: 10.5px;
  color: var(--warn-ink);
}
.sm-side-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding-bottom: 6px;
}
/*
 * 原文吃掉剩下的高度：窗口高时一屏能看完，不用在框里再滚一次。
 * 两步加起来是定高，所以这里只留 min-height 兜底（窗口很矮时整体滚动）。
 */
.sm-side-story {
  flex: 1 1 auto;
  min-height: 132px;
  padding: 8px 10px;
  display: flex;
  border-bottom: 1px solid var(--line);
}

/* 右栏：工具条 + 卡片流 */
.sm-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 步骤块：圆号 + 标题 + 右侧动作，下面最多两行读数 */
.sm-step {
  flex: none;
  padding: 8px 12px 9px;
  border-bottom: 1px solid var(--line);
}
.sm-step-h {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 7px;
}
.sm-step-n {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
}
.sm-step-n.is-done {
  background: var(--ok);
}
.sm-step-n.is-idle {
  background: var(--panel-3);
  color: var(--muted);
}
.sm-step-t {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}
.sm-step-sp {
  flex: 1;
  min-width: 0;
}
.sm-step-b {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.sm-side-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.sm-side-tag {
  padding: 0 5px;
  border-radius: var(--r-pill);
  background: var(--panel-3);
  font-size: 10px;
  line-height: 16px;
  color: var(--muted);
}
.sm-side-tag b {
  font-weight: 600;
  color: var(--text);
}
.sm-side-tag.is-hit {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.sm-side-tag.is-hit b {
  color: var(--accent-ink);
}
.sm-side-tag.is-new {
  background: var(--warn-soft);
  color: var(--warn-ink);
}
.sm-side-tag.is-new b {
  color: var(--warn-ink);
}
.sm-step-note {
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--muted-3);
}
.sm-step-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 3px 2px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-2);
}
.sm-step-row-t {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sm-step-row-t b {
  margin-left: 3px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text);
}

/* 登记条：这一页的主动作 */
.sm-band {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-2);
}
.sm-band-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.sm-band-t {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}
.sm-band-s {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--muted-3);
}
.sm-band-warn {
  color: var(--warn-ink);
}
.sm-band-act {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 新建行：就地填名字和类型，不弹窗 */
.sm-newrow {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--accent-soft);
}
.sm-newrow-t {
  flex: none;
  font-size: 11.5px;
  color: var(--muted);
}
.sm-newrow-name {
  width: 200px;
  flex: none;
}
.sm-newrow-hit {
  font-size: 11px;
  color: var(--accent-ink);
}
.sm-newrow-ctx {
  font-size: 11px;
  color: var(--muted-3);
}
.sm-newrow-miss {
  font-size: 11px;
  color: var(--warn-ink);
}
.sm-newrow-alias {
  font-size: 11px;
  color: var(--muted);
}
.sm-newrow-alias button {
  padding: 0 2px;
  color: var(--accent);
  background: transparent;
  border: 0;
  font-size: 11px;
  text-decoration: underline;
  cursor: pointer;
}

/* 左栏里的新建行：380px 放不下一整排，改竖排 */
.sm-newrow.is-side {
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
  padding: 7px;
  border: 1px solid var(--accent-line);
  border-radius: 8px;
  background: var(--accent-soft);
}
.sm-newrow-foot {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sm-newrow-foot > :nth-child(2) {
  margin-left: auto;
}

/* 工具条：搜索 / 类型 / 视图切换 */
.sm-tool {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line);
}
.sm-tool-q {
  width: 220px;
  flex: none;
}
.sm-seg {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--panel-3);
}
.sm-seg-b {
  padding: 2px 10px;
  font-size: 11.5px;
  line-height: 18px;
  color: var(--muted);
  background: transparent;
  border: 0;
  border-radius: 5px;
  cursor: pointer;
}
.sm-seg-b.on {
  background: var(--panel);
  color: var(--text);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}
.sm-seg-n {
  margin-left: 4px;
  font-size: 10.5px;
  opacity: 0.8;
}

/* 卡片流：分区（待登记 / 角色 / 场景 / 道具），每区一排排方块 */
.sm-cards {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 14px 20px;
}
.sm-grp + .sm-grp {
  margin-top: 14px;
}
.sm-grp-h {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 7px;
}
.sm-grp-t {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.sm-grp-n {
  padding: 0 6px;
  border-radius: var(--r-pill);
  background: var(--panel-3);
  font-size: 10.5px;
  line-height: 16px;
  color: var(--muted);
}
.sm-grp-s {
  font-size: 11px;
  color: var(--muted-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sm-grp-add {
  padding: 1px 8px;
  font-size: 11px;
  line-height: 18px;
  color: var(--muted);
  background: transparent;
  border: 1px dashed var(--line-strong);
  border-radius: 5px;
  cursor: pointer;
}
.sm-grp-add:hover {
  color: var(--accent);
  border-color: var(--accent-line);
  background: var(--accent-soft);
}
.sm-grp-empty {
  padding: 4px 2px 8px;
  font-size: 11.5px;
  color: var(--muted-3);
}

/* 卡片宽度自适应：宽屏一行五六张，窄屏两三张，不写死列数 */
.sm-cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(178px, 1fr));
  gap: 10px;
}

/* 待登记卡片：虚线框 + 无图，一眼区别于「已经在本集里的」 */
.sm-pend {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 9px 7px;
  border: 1px dashed var(--line-strong);
  border-radius: 10px;
  background: var(--panel-2);
  min-width: 0;
}
.sm-pend.is-new {
  border-style: dotted;
}
.sm-pend-top {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.sm-pend-type {
  padding: 0 5px;
  border-radius: 4px;
  background: var(--panel-3);
  font-size: 10.5px;
  line-height: 16px;
  color: var(--muted);
}
.sm-pend-src {
  font-size: 10.5px;
  line-height: 16px;
  color: var(--muted-3);
}
.sm-pend-src.is-model {
  color: var(--accent-ink);
}
.sm-pend-hit {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--warn-ink);
}
.sm-pend-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sm-pend-desc {
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--muted-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 34px;
}
.sm-pend-foot {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
}
.sm-pend-flag {
  padding: 0 5px;
  border-radius: 4px;
  background: var(--panel-3);
  font-size: 10px;
  line-height: 15px;
  color: var(--muted);
}
/* 原文片段：判断「这名字真是个人吗」的唯一依据，压两行就够了 */
.sm-pend-ctx {
  padding: 3px 6px;
  border-left: 2px solid var(--line-strong);
  border-radius: 0 4px 4px 0;
  background: var(--panel-3);
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--muted-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.sm-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.sm-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 11.5px;
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 999px;
  cursor: pointer;
}
.sm-chip:hover {
  color: var(--text);
  border-color: var(--line-strong);
}
.sm-chip.on {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: var(--accent-line);
}
.sm-chip-n {
  font-size: 10.5px;
  opacity: 0.75;
}
.sm-item.on::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: var(--accent);
}

/* 右侧详情 */
.sm-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  /* 抽屉里滚动的是这一层：高度锁在抽屉上，内容再长也不会把抽屉撑出屏幕 */
  height: 100%;
  overflow: auto;
  padding: 6px 12px 12px;
}
.sm-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sm-kind {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  flex: none;
}
.sm-kind-off {
  padding: 1px 7px;
  font-size: 11px;
  color: var(--muted-3);
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 999px;
}
.sm-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin: 4px 0 10px;
  padding-left: 2px;
}
.sm-grid {
  display: grid;
  grid-template-columns: minmax(220px, 300px) minmax(280px, 1fr);
  gap: 14px;
  align-items: start;
}
/* 角色的参考图是一整块"设定图组"（左 1/3 组头 + 右 2/3 三视图），整行铺开会把
   下面「长相 / 声音」全推出一屏 —— 抽屉够宽时改成左右两列：左边看图，右边写字。 */
.sm-grid-char {
  grid-template-columns: minmax(0, 1fr) minmax(300px, 372px);
}
@media (max-width: 1100px) {
  .sm-grid-char {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 900px) {
  .sm-grid {
    grid-template-columns: 1fr;
  }
}
/* 卡片：和全项目 .card 同一套壳（白底 + 1px 边 + 浅阴影 + 统一圆角），
   卡头用负 margin 顶到边缘，卡片内部保持 12px 内距。 */
.sm-card {
  padding: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}
.sm-card-h {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: -12px -12px 10px;
  padding: 7px 12px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--line);
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text);
}
/* 卡片内部的分段标题（声音描述 / 音色包 / 备注）：不是卡头，是卡内的一道分隔，
   和交付页 .fieldset-head 同一套：小字 + 前面一道模块色短横。 */
.sm-grp-h {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 14px 0 6px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--label);
}
.sm-grp-h::before {
  content: '';
  width: 12px;
  height: 3px;
  border-radius: 2px;
  background: var(--stage, var(--accent));
  opacity: 0.85;
  transform: translateY(-3px);
}
.sm-card-h-sub {
  font-weight: 400;
  font-size: 11px;
  color: var(--muted);
}
.sm-img-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel-3);
  cursor: pointer;
  margin-bottom: 8px;
  border: 1px dashed var(--line-strong);
}
.sm-img-wrap img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.sm-img-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 12.5px;
  color: var(--muted);
  text-align: center;
  padding: 12px;
}
.sm-img-empty-sub {
  font-size: 11px;
  color: var(--muted-3);
}
.sm-hint {
  margin-top: 5px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--muted);
}
/**
 * 串味警告：长短与 sm-hint 对齐，颜色走 warn 三件套。
 * 不用 n-alert —— 它是卡片级组件，塞进表单里会把整列撑高。
 */
.sm-warn {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: var(--r-sm, 4px);
  border: 1px solid var(--warn-line);
  background: var(--warn-soft);
  color: var(--warn-ink);
  font-size: 11.5px;
  line-height: 1.6;
}
/* 示例短语是一串长句子：换行会把 4 条摞成 4 行（84px），一行横滚只要 24px */
.sm-samples {
  display: flex;
  flex-wrap: nowrap;
  gap: 4px;
  margin-top: 4px;
  overflow-x: auto;
  padding-bottom: 2px;
}
.sm-samples::-webkit-scrollbar {
  height: 4px;
}
.sm-sample {
  flex: none;
  white-space: nowrap;
  font-size: 10.5px;
  padding: 2px 7px;
  color: var(--muted);
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 999px;
  cursor: pointer;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sm-sample:hover {
  color: var(--accent);
  border-color: var(--accent-line);
}

/* 音色包：候选 / 已固定共用一个方框，靠 is-fixed 换边框色 */
.sm-vp {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
  padding: 8px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.sm-vp.is-fixed {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}
.sm-vp-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sm-vp-play {
  flex: none;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  line-height: 1;
  color: var(--accent);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 999px;
  cursor: pointer;
}
.sm-vp-play:hover {
  border-color: var(--accent-line);
}
.sm-vp-play.on {
  color: #fff;
  background: var(--accent);
  border-color: var(--accent);
}
.sm-vp-play:disabled {
  cursor: progress;
  opacity: 0.7;
}
/* 正在合成试听：转圈，别让按钮看着像卡死 */
.sm-vp-dot {
  width: 10px;
  height: 10px;
  border: 2px solid var(--accent);
  border-top-color: transparent;
  border-radius: 999px;
  animation: sm-vp-spin 0.7s linear infinite;
}
@keyframes sm-vp-spin {
  to {
    transform: rotate(360deg);
  }
}
.sm-vp-main {
  flex: 1;
  min-width: 0;
}
.sm-vp-t {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sm-vp-s {
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sm-vp-cand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.sm-vp-cand:hover {
  border-color: var(--accent-line);
}
.sm-vp-err {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--err-ink);
  word-break: break-word;
}
.sm-vp-warn {
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--muted);
}
.sm-vp-warn b {
  color: var(--ok-ink);
  font-weight: 600;
}
.sm-vp-warn b.bad {
  color: var(--err-ink);
}
.sm-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.sm-empty {
  height: 100%;
  min-height: 320px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
}
.sm-empty-t {
  font-size: 14px;
  font-weight: 600;
}
.sm-empty-s {
  max-width: 380px;
  font-size: 12.5px;
  line-height: 1.9;
  color: var(--muted);
}
</style>
