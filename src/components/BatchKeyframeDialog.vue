<script setup lang="ts">
/**
 * 批量出素材。
 *
 * 三件事，顺序不能反：
 *   1. **补场景总图**（缺就先补）：每一镜都是"按本场总图编辑一版机位"，
 *      没有总图就没有底图 —— 这里**不做纯文生图**，纯文本那条路只留给「主体」
 *      的资料图（人脸/服装不依赖任何场景）。
 *   2. **AI 排布**（用户点）：模型读这一段的运镜 / 画面 / 台词 / 时长，给出
 *      「第几帧、画什么」的建议。一段一张够就放开场，有转折才补中间帧。
 *      模型给的不合适，可以在"补充要求"里直接说（多给两张、别给特写……）。
 *   3. **用户过一遍 → 点「开始出图」**：这才真的跑。AI 只给建议，不落库、不出图 ——
 *      一张图几十秒，绝不能因为"模型觉得该有"就自己开跑。
 *
 * ★ 出图的需求粒度是**链**，不是段：
 *   段与段靠「引用上段」串成链，上游尾帧直接喂给下游当首帧引导，所以一条链
 *   只有链头要一张起始图。链内行默认不勾（勾了也能单出，但一般不该）。
 *
 * 落点是每行自己的帧号，不是全局的"首帧 / 尾帧"：每段长度不一样，
 * "第 40 帧"在各段里根本不是同一件事。没有 AI 建议时也能自己填。
 *
 * 本地通道下 N 条提示词是同一张图里的 N 条支路，共用一套加载器 ——
 * 文本编码器只加载一次、所有提示词先编码完再逐张采样（见 server/imagegen.py）。
 * 所以这里不能做成"循环调用单张生成"，否则就退化成 N 次独立任务了。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NAlert, NButton, NInput, NInputNumber, NModal, NSelect, NSpin, useMessage } from 'naive-ui'
import { DEFAULT_SIZE, normalizeSize, sizeOptions } from '@/domain/imageSize'
import { useImageStore, type RefCandidate } from '@/stores/images'
import { useRegistryStore } from '@/stores/registry'
import { useProjectStore } from '@/stores/project'
import { useProviderStore } from '@/stores/provider'
import { useGateStore } from '@/stores/gate'
import { useBeatStore } from '@/stores/beats'
import { PLATE_SIZE } from '@/domain/plate'
import {
  autoFrameOf,
  clampFrame,
  frameOf,
  innerFramesOf,
  keyframesOf,
  placementOf,
  refClause
} from '@/domain/references'
import { beatFrames } from '@/domain/timing'
import type { ComfyRef } from '@/core/comfyImage'
import type { Asset, Beat, ID } from '@/domain/types'
import InfoTip from '@/components/common/InfoTip.vue'

const props = defineProps<{
  show: boolean
  beats: Beat[]
}>()

const emit = defineEmits<{
  'update:show': [boolean]
  /** 有图落到片段上了：带回成功的片段 id，上层把这几个从勾选里摘掉 */
  done: [ids: ID[]]
}>()

const images = useImageStore()
const registry = useRegistryStore()
const project = useProjectStore()
const provider = useProviderStore()
const gate = useGateStore()
const allBeats = useBeatStore()
const message = useMessage()

/**
 * 出图前的门禁：片段得有、场景与说话人得绑好。
 *
 * 图是照着场景和人物生成的，②没做完时提示词里没有主体、没有场景，
 * 出来的图与剧本无关 —— 那种图比没有图更糟，因为后面还会被当成参考图。
 */
const gateBlockers = computed(() => (props.show ? gate.guard('keyframes') : []))

interface Row {
  /**
   * 一行的身份：同一段可能有多张（AI 常排 2~3 张），所以不能拿 beatId 当 key。
   *
   * 用递增序号而不是 `段#帧`：帧号一改 key 就变，输入框会整个重挂载、光标丢失，
   * 连着敲两下数字就只生效一下。行身份和数据内容必须解耦。
   */
  key: string
  beatId: ID
  title: string
  /** 本段共几帧（落点帧取值 0 .. frames-1） */
  frames: number
  /** 这一张挂到本段第几帧 */
  frame: number
  prompt: string
  /** 提示词已经"定过"（AI 给的，或用户自己改过）：改段时不再用模板覆盖 */
  edited: boolean
  include: boolean
  /** ai = 模型建议；manual = 模板拼的（还没让 AI 排过，或用户自己加的） */
  source: 'ai' | 'manual'
  /** 为什么放这一帧 / 用户自己的备注（中文一句话，只给自己看，不进出图） */
  note?: string
  /**
   * AI 给的"这一帧画什么"（原始描述）。
   *
   * 单独存一份的原因：补总图之前拼不出「编辑总图」的提示词，只能先显示原描述；
   * 总图补上之后要用**同一个描述**重新拼一版带机位的提示词，不能退化成纯文生图。
   */
  aiAction?: string
  /**
   * 这一段的参考图候选：出场人物的 Picture N + 场景图。
   *
   * 为什么放在行上而不是弹窗顶上：同一批里各段绑的人不一样，
   * "A 段的脸贴到 B 段"是最难查的错 —— 只能逐行各自选。
   */
  refs: RefCandidate[]
  /** 勾上的参考图（素材 id）。顺序按 refs 的候选顺序，image_1 就是第一个 */
  picked: ID[]
  /**
   * 这一段是不是链的起点（第 0 段，或没有勾「引用上段」）。
   *
   * 一条链只有链头要一张起始图：链内下游段的首帧由上一段尾帧引导，
   * 再给它单独出图，导演台会同时收到两个起点。所以链内行默认不勾。
   */
  chainHead: boolean
  /** 编辑所依据的场景总图 id（没有就是这段的场景还没合成总图，得先补） */
  plateId: ID | null
  /** 机位说明（中文，只显示）：中近景 · 右侧机位 · 正面 */
  view: string
}

const rows = ref<Row[]>([])
/** 默认 1280×720（16:9，92 万像素）。比例可换，量级不换 —— 见 domain/imageSize.ts */
const size = ref(DEFAULT_SIZE)
const elapsed = ref(0)
let timer: number | null = null
let seq = 0

/** 给 AI 的补充要求：一句话就够，可空 */
const aiNote = ref('')
/** 「加一张」默认加到哪一段 */
const addBeatId = ref<ID | null>(null)

/**
 * 比例档位（像素量级统一 720p = 1280×720 = 92 万）。
 * 末尾单独挂一个「画布同尺寸」：关键帧要跟运行画布对得上，这条不能按预算缩。
 */
const sizeChoices = [
  ...sizeOptions(),
  { label: `864 × 480（与运行画布同尺寸 · 41 万像素）`, value: '864x480' }
]

function setSize(v: string) {
  const fixed = normalizeSize(v)
  size.value = fixed.size
  if (fixed.note) message.info(fixed.note, { duration: 4000 })
}

const beatOptions = computed(() =>
  props.beats.map((b, i) => ({
    label: `${String(i + 1).padStart(2, '0')} · ${b.title || '（未命名）'}`,
    value: b.id
  }))
)

const pickedRows = computed(() => rows.value.filter((r) => r.include))
const overwriteCount = computed(() => pickedRows.value.filter((r) => existingOf(r)).length)
const busy = computed(() => images.batchRunning)
const aiBusy = computed(() => images.planBusy)
const aiRows = computed(() => rows.value.filter((r) => r.source === 'ai').length)

/* ---------------------------- 场景总图 ---------------------------- */

/**
 * 这一批会用到的场景，以及其中还没总图的。
 *
 * 出图顺序是硬的：**先每个场景一张总图（带人物站位），再按这张图编辑各镜**。
 * 反过来做，每段都自己发明一个空间关系，同一个人在两段里会站在两个位置，
 * 剪起来像两个地方。
 */
const sceneIds = computed<ID[]>(() => {
  const out: ID[] = []
  for (const r of pickedRows.value) {
    const sid = allBeats.ordered.find((b) => b.id === r.beatId)?.sceneId
    if (sid && !out.includes(sid)) out.push(sid)
  }
  return out
})
const missingPlateIds = computed(() => sceneIds.value.filter((id) => !registry.plateFor(id)))
const plateRows = computed(() => pickedRows.value.filter((r) => !!r.plateId).length)
/** 勾上的行里还没底图的：这些不能提交，必须先补总图 */
const rowsWithoutPlate = computed(
  () =>
    pickedRows.value.filter((r) => {
      const sid = allBeats.ordered.find((b) => b.id === r.beatId)?.sceneId
      return !!sid && !registry.plateFor(sid)
    }).length
)

/** 参考图这一路能不能用：本地通道 + 工作流编码器吃图 */
const refUsable = computed(() => images.usingComfy && images.refSupport > 0)

/** 勾了参考图的行数：跑之前让人一眼看到"这次有几张是照着人画的" */
const refCount = computed(
  () => pickedRows.value.filter((r) => refUsable.value && r.picked.length).length
)

/** 这一段的参考图候选（场景总图排第一） */
function refsOfBeat(beatId: ID): RefCandidate[] {
  return images.refCandidatesFor(beatId)
}

function plateCardOf(refs: RefCandidate[]): RefCandidate | null {
  return refs.find((c) => c.kind === 'plate') ?? null
}

/**
 * 默认勾哪些：**只勾场景总图**。
 *
 * 整场的人和道具都已经在那张图里了，再把人像图一起塞进去，模型会看到
 * "同一个人的两张图"，很容易串脸 —— 所以不是"取消总图"，而是"只留总图"。
 * 没有总图时返回空：这一行在补上底图之前不能跑（这里不做纯文生图）。
 */
function defaultPicked(beatId: ID): ID[] {
  const plate = plateCardOf(refsOfBeat(beatId))
  return plate ? [plate.key] : []
}

function plateIdOf(beatId: ID): ID | null {
  return plateCardOf(refsOfBeat(beatId))?.key ?? null
}

/**
 * 提示词：一律是「编辑本场总图」。
 *
 * 没有纯文生图这条路：图必须长在这场戏的空间关系上，纯文本起画会让每段
 * 各自发明一间店、一张脸。没有总图时返回空串，界面上会提示先补底图。
 */
function promptOfBeat(beatId: ID, action?: string): string {
  return images.plateEditPromptFor(beatId, action)
}

/** 一行最终勾上的参考图（带 label）：拼提示词要点名，光传图不说话等于白传 */
function rowPicked(row: Row): RefCandidate[] {
  if (!refUsable.value || !row.picked.length) return []
  return row.refs.filter((c) => row.picked.includes(c.key))
}

/** 一行最终交给后端的参考图，顺序 = 候选顺序（image_1 就是第一个） */
function rowRefs(row: Row): ComfyRef[] {
  return rowPicked(row).map((c) => c.ref)
}

function toggleRowRef(row: Row, key: ID) {
  const plate = row.refs.find((c) => c.kind === 'plate')
  /*
   * 总图是底图，不是可选参考图：取消它这一行就没得编辑了。
   * 想换底图只能重合成 / 换场景，不该在行上"不勾"。
   */
  if (plate && key === plate.key) return
  row.picked = row.picked.includes(key)
    ? row.picked.filter((k) => k !== key)
    : [...row.picked, key]
}

const channelText = computed(() =>
  images.usingComfy
    ? `本地 ComfyUI · ${images.comfy.workflow || '未选工作流'}`
    : '云端 API · 逐张生成（本地通道才能"先统一编码再采样"）'
)

const runHint = computed(() => {
  if (aiBusy.value) return '模型正在读这几段的运镜 / 画面 / 台词，排帧位……'
  if (!rows.value.length) return '没有要出图的片段：先在下面「加一张」，或者回去勾选片段'
  if (!pickedRows.value.length) return '至少勾一张再开始：AI 只给建议，出图由你点'
  const n = pickedRows.value.length
  const head = `已勾 ${n} 张${aiRows.value ? `（${aiRows.value} 张来自 AI 建议，可改可退）` : '，还没让 AI 排过：也可以自己填帧位'}`
  // 总图这步必须写在明面上：它会真的花显卡，而且出完会停下来让人过目
  const plateBit = missingPlateIds.value.length
    ? `；开跑先出 ${missingPlateIds.value.length} 张场景总图（这是各镜的编辑底图），出完会停下让你过目`
    : plateRows.value
      ? `；${plateRows.value} 张按场景总图编辑（只动机位）`
      : ''
  if (images.usingComfy) {
    if (!images.comfy.workflow) {
      return `${head}${plateBit}；还没选工作流：先去任意一段的「生成首帧」弹窗里挑一份（选过一次就记住了）`
    }
    const refBit = refUsable.value
      ? refCount.value
        ? `；其中 ${refCount.value} 张另挂了人物参考图`
        : '；只挂场景总图（人物已经在总图里）'
      : '；这份工作流的编码器不吃参考图：只能按纯文本编辑，底图会被系统拦下'
    return `${head}${plateBit}${refBit}；开跑后一次提交，先统一编码，再逐张采样，每张按自己的帧号落位`
  }
  return `${head}${plateBit}；云端通道会一条条生成 ${n} 张`
})

function nextKey(): string {
  seq += 1
  return `k${seq}`
}

function lastOf(frames: number): number {
  return Math.max(0, frames - 1)
}

/** 某一段的第 frame 帧上已经躺着哪张图 */
function existingIn(beatId: ID, frames: number, frame: number): Asset | null {
  const hit = keyframesOf(registry.assets, beatId).find((a) => frameOf(a, frames) === frame)
  return hit ?? null
}

/** 行上的"这一帧已有图"是算出来的：改了帧号或换了段，它就得跟着变 */
function existingOf(row: Row): Asset | null {
  return existingIn(row.beatId, row.frames, row.frame)
}

/** 这一行挂到某段之后，提示词 / 帧数 / 标题都要跟着这一段走 */
function applyBeat(row: Row, beat: Beat) {
  row.beatId = beat.id
  row.title = beat.title || '（未命名）'
  row.frames = beatFrames(beat, project.settings)
  row.frame = clampFrame(row.frame, row.frames)
  row.chainHead = isChainHead(beat)
  // 参考图跟着段走：换了段就是换了人，旧的勾选不能留着（那是别人脸上的特征）
  row.refs = refsOfBeat(beat.id)
  row.picked = defaultPicked(beat.id)
  row.plateId = plateIdOf(beat.id)
  row.view = images.shotLabelFor(beat.id)
  // AI 给的、或用户自己润色过的提示词不能被模板冲掉；纯模板行才跟着段更新
  if (!row.edited) row.prompt = promptOfBeat(beat.id)
}

/**
 * 这一段是不是链头（= 需要自己一张起始图）。
 *
 * 口径与门禁**必须是同一份**：链是段级的，用 gate 算好的「段 → beat」
 * 映射来判，而不是在弹窗里另猜一遍。
 *
 *   该段是链头（第 0 段或不引用上段）→ 段内第一个 beat 要图
 *   段内其余 beat、以及链内段的所有 beat → 不需要
 *
 * 拿不到段信息时按链头算 —— 保守方向，宁可多要一张也不漏。
 */
function isChainHead(beat: Beat): boolean {
  const segs = gate.input.segments
  const idx = segs.findIndex((s) => s.beatIds?.includes(beat.id))
  if (idx < 0) return true
  const seg = segs[idx]
  const head = idx === 0 || !seg.refPrev
  return head && seg.beatIds?.[0] === beat.id
}

/** 换段：帧数变了，帧号夹回新段范围；已有图标记跟着重算 */
function changeBeat(row: Row, v: ID | null) {
  const beat = props.beats.find((b) => b.id === v)
  if (!beat) return
  applyBeat(row, beat)
  if (!row.include) return
  // 换到一段、这一帧恰好已经有图：默认不覆盖（用户想要覆盖就自己再勾）
  if (existingOf(row)) message.info('这一段这一帧已经有图了：勾着出图会覆盖它')
}

/** 没有 AI 建议时的兜底行：模板提示词 + 段内中点（离已有图最近的那个空格） */
function manualRow(b: Beat): Row {
  const frames = beatFrames(b, project.settings)
  const kfs = keyframesOf(registry.assets, b.id)
  /*
   * 已经有图时**落在它那一帧上重出**，不在旁边再补一张。
   *
   * 一张图几十秒，而导演台只认其中一张：多出来那张构图不同，这一段就会
   * 在锚点之间来回跳。要补中间帧是"加一张"的动作，不该是默认。
   */
  const anchor = kfs.find((a) => placementOf(a) === 'at') ?? kfs.find((a) => placementOf(a) === 'head')
  const frame = anchor
    ? placementOf(anchor) === 'at'
      ? frameOf(anchor, frames)
      : 0
    : autoFrameOf(kfs, frames)
  // 旧图不是从场景总图来的（上一版逐段文生图）→ 默认勾上，重出一遍
  const legacy = kfs.some((a) => !a.plateId)
  const refs = refsOfBeat(b.id)
  const plateId = plateCardOf(refs)?.key ?? null
  const chainHead = isChainHead(b)
  return {
    key: nextKey(),
    beatId: b.id,
    title: b.title || '（未命名）',
    frames,
    frame,
    prompt: promptOfBeat(b.id),
    edited: false,
    // 链内下游段默认不出图：它的首帧由上一段尾帧引导
    include: chainHead && (!kfs.length || legacy),
    source: 'manual',
    refs,
    picked: defaultPicked(b.id),
    chainHead,
    plateId,
    view: images.shotLabelFor(b.id)
  }
}

function buildRows() {
  rows.value = props.beats.map(manualRow)
  addBeatId.value = props.beats[0]?.id ?? null
}

watch(
  () => props.show,
  async (v) => {
    if (v) {
      rows.value = []
      elapsed.value = 0
      buildRows()
      // 通道配置是懒加载的：不先读回来，界面会先显示"云端 API"，
      // 而真正开跑时又按本地通道走 —— 说的和做的对不上。
      await images.loadComfy()
      if (images.usingComfy && !images.workflows.length) void images.refreshWorkflows()
    } else {
      stopTimer()
    }
  },
  { immediate: true }
)

/* ------------------------------- 增删行 ------------------------------- */

/** 手加一张：默认落在本段空格上（先避开已有图，再避开本次已经排的帧） */
function addRow(beatId?: ID) {
  const beat = props.beats.find((b) => b.id === (beatId ?? addBeatId.value)) ?? props.beats[0]
  if (!beat) return
  const frames = beatFrames(beat, project.settings)
  const last = lastOf(frames)
  const taken = new Set(rows.value.filter((r) => r.beatId === beat.id).map((r) => r.frame))
  let frame = autoFrameOf(keyframesOf(registry.assets, beat.id), frames)
  if (taken.has(frame)) {
    frame = last + 1
    for (let d = 0; d <= last; d += 1) {
      const mid = Math.round(last / 2)
      const cands = [mid - d, mid + d]
      const hit = cands.find((f) => f >= 0 && f <= last && !taken.has(f))
      if (hit !== undefined) {
        frame = hit
        break
      }
    }
  }
  rows.value.push({
    key: nextKey(),
    beatId: beat.id,
    title: beat.title || '（未命名）',
    frames,
    frame: Math.min(last, Math.max(0, frame)),
    prompt: promptOfBeat(beat.id),
    edited: false,
    // 手动"加一张"是明确要出这张，链内段也照做
    include: true,
    source: 'manual',
    refs: refsOfBeat(beat.id),
    picked: defaultPicked(beat.id),
    chainHead: isChainHead(beat),
    plateId: plateIdOf(beat.id),
    view: images.shotLabelFor(beat.id)
  })
  if (!isChainHead(beat)) {
    message.info('这一段在链内（引用上段）：它的首帧本该由上一段尾帧引导，单出一张会和引导打架')
  }
}

function removeRow(row: Row) {
  const i = rows.value.findIndex((r) => r.key === row.key)
  if (i >= 0) rows.value.splice(i, 1)
}

/* ------------------------------- AI 排布 ------------------------------ */

/**
 * 让 AI 排一遍。
 *
 * 只排**勾上的段**：没勾的说明这次不想要，没必要花 token 去算。
 * 排完替换掉这些段的旧行，其余段原样保留 —— 用户可能只对其中两段想重排。
 */
async function askAi() {
  if (!provider.ready) {
    message.warning('请先在「模型设置」里配置文本模型：AI 排布要用它读分镜')
    return
  }
  const order: ID[] = []
  for (const r of rows.value) if (!order.includes(r.beatId)) order.push(r.beatId)
  const ids = [...new Set((pickedRows.value.length ? pickedRows.value : rows.value).map((r) => r.beatId))]
  if (!ids.length) {
    message.warning('先勾上要排的片段')
    return
  }
  try {
    const plan = await images.planKeyframes(ids, aiNote.value.trim())
    const byBeat = new Map(plan.map((p) => [p.beatId, p]))
    const next: Row[] = []
    let added = 0
    for (const beatId of order) {
      const keep = rows.value.filter((r) => r.beatId === beatId)
      const p = byBeat.get(beatId)
      if (!ids.includes(beatId) || !p) {
        next.push(...keep)
        continue
      }
      const beatOf = props.beats.find((b) => b.id === beatId)
      const title = beatOf?.title || keep[0]?.title || ''
      const chainHead = beatOf ? isChainHead(beatOf) : true
      for (const s of p.shots) {
        /*
         * AI 给的是"这一帧画什么"。不能整段照用 —— 那等于让它重新设计一间店。
         * 把它的描述接在"编辑总图"的动作那一句里，机位仍然按这一场的站位表算。
         *
         * 总图还没补时 editPrompt 是空串：原始描述留在 aiAction 上，
         * 补完总图 rebaseRows 会用同一个描述重新拼一版带机位的提示词。
         */
        const editPrompt = images.plateEditPromptFor(beatId, s.prompt)
        next.push({
          key: nextKey(),
          beatId,
          title,
          frames: p.frames,
          frame: s.frame,
          prompt: editPrompt || s.prompt,
          aiAction: s.prompt,
          edited: true,
          // AI 建议只对链头有意义；链内段的起始图由上一段尾帧引导
          include: chainHead,
          source: 'ai',
          note: s.reason,
          refs: refsOfBeat(beatId),
          picked: defaultPicked(beatId),
          chainHead,
          plateId: plateIdOf(beatId),
          view: images.shotLabelFor(beatId)
        })
        added += 1
      }
    }
    if (!added) {
      message.warning(images.planNote || 'AI 没有给出可用建议：可以自己填帧位与提示词')
      return
    }
    rows.value = next
    message.success(`${images.planNote || `AI 排了 ${added} 张`}；改完再点「开始出图」`)
  } catch (e) {
    message.error((e as Error).message || 'AI 排布失败', { duration: 9000 })
  }
}

/**
 * 按顺序铺开：把勾上的行按**段**分组，各自摊在段内的 1/(n+1) … n/(n+1) 上。
 *
 * 只对"手动行"有用 —— AI 排过的行有它自己的帧位，一键铺平等于把建议冲掉。
 * 所以按钮只在还没 AI 排布时可用。
 */
function spread() {
  const on = pickedRows.value
  if (!on.length) return
  const byBeat = new Map<ID, Row[]>()
  for (const row of on) {
    const list = byBeat.get(row.beatId)
    if (list) list.push(row)
    else byBeat.set(row.beatId, [row])
  }
  for (const list of byBeat.values()) {
    const slots = innerFramesOf(list[0].frames, list.length)
    list.forEach((row, i) => {
      row.frame = slots[i] ?? Math.round(lastOf(row.frames) / 2)
    })
  }
  message.info(`已铺到各自段内（避开首尾）：共 ${on.length} 张`)
}

/**
 * 提交前收敛成"一段一帧一张"：
 * 同一段同一帧有两行（用户手改撞到一起）时只留第一行 ——
 * 同帧两张图在导演台里后一张会盖掉前一张，多跑一次采样纯属浪费。
 */
function dedupe(): { rows: Row[]; dropped: number } {
  const seen = new Set<string>()
  const out: Row[] = []
  for (const r of pickedRows.value) {
    const k = `${r.beatId}#${r.frame}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return { rows: out, dropped: pickedRows.value.length - out.length }
}

/**
 * 补齐缺的场景总图：一次提交，N 个场景共用一套加载器。
 *
 * 总图画的是"这一场所有人站在哪儿"—— 人物用各自的主体图当参考，
 * 地点排第一。它比成片宽得多（2.4:1），因为后面每一镜都要从它这里取景。
 */
async function genMissingPlates(): Promise<{ ok: number; fail: number }> {
  const ids = missingPlateIds.value.slice()
  if (!ids.length) return { ok: 0, fail: 0 }
  const items = ids.map((id) => ({
    key: id,
    prompt: images.platePrompt(id),
    /*
     * 这里**不挂**人物参考图。
     *
     * 总图要的是"这场戏的空间与站位"，人物靠文字描述就能站到位；一旦把
     * 角色参考图塞进去，模型会照抄参考图的样子 —— 参考图若是占位剪影，
     * 总图里就会出现色块人，而后面每一镜都是从这张图编辑出来的，
     * 那张色块脸会被一路继承下去。要照着真人画，去「按场景」页手动勾。
     */
    refs: []
  }))
  const results = await images.generateBatch(items, { size: PLATE_SIZE })
  let ok = 0
  let fail = 0
  for (const r of results) {
    if (!r.blob) {
      fail += 1
      continue
    }
    try {
      await images.attachPlateImage(r.key, r.blob)
      ok += 1
    } catch {
      fail += 1
    }
  }
  return { ok, fail }
}

/**
 * 总图刚补上，把行切到"编辑"：提示词、参考图、机位说明都要跟着换。
 *
 * 提示词的处理分三种，别一刀切：
 *   用户自己改过          → 保留他的文字（他把场景写进去了也说不定）
 *   AI 拍的行（有 aiAction）→ 用同一个动作描述重拼一版带机位的
 *   纯模板行              → 交给 applyBeat 重算
 *
 * 中间这条不能省：补总图前 AI 行只能显示原始描述，不重拼就退化成纯文生图，
 * 那正是这次要消掉的东西。
 */
function rebaseRows() {
  for (const row of rows.value) {
    const beat = allBeats.ordered.find((b) => b.id === row.beatId)
    if (!beat) continue
    const pid = plateIdOf(row.beatId)
    if (pid === row.plateId) continue
    const keepPicked = row.edited ? row.picked : null
    applyBeat(row, beat)
    if (keepPicked) {
      // 底图是必需的：换底图后把新总图补进勾选，人物参考图按用户原来的选择留
      row.picked = pid
        ? Array.from(new Set([pid, ...keepPicked]))
        : keepPicked
    }
    if (row.source === 'ai' && row.aiAction) {
      row.prompt = images.plateEditPromptFor(row.beatId, row.aiAction) || row.prompt
    }
  }
}

async function onGenPlates() {
  if (!missingPlateIds.value.length) return
  try {
    const r = await genMissingPlates()
    if (r.ok) message.success(`已生成 ${r.ok} 张场景总图，各行已切到「按总图编辑」`)
    if (r.fail) message.warning(`${r.fail} 张场景总图没生成出来`)
    rebaseRows()
  } catch (e) {
    message.error((e as Error).message || '场景总图生成失败', { duration: 9000 })
  }
}

function stopTimer() {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

function startTimer() {
  stopTimer()
  elapsed.value = 0
  timer = window.setInterval(() => (elapsed.value += 1), 1000)
}

function close() {
  if (busy.value) return
  emit('update:show', false)
}

async function run() {
  /*
   * 门禁先于一切：AI 排布只是建议，这一步才是真的花显卡。
   * 卡在这里不是"不让用"，而是把「②还没做完」这件事摆在点按钮的当下。
   */
  if (gateBlockers.value.length) {
    message.error(`还不能出图：${gateBlockers.value[0]}`, { duration: 8000 })
    return
  }
  startTimer()
  try {
    /*
     * 第一步：场景总图 —— **出完就停**。
     *
     * 不能"总图出来顺手把 11 镜全跑了"：总图一旦有问题（人物画成色块、
     * 站位反了、光不对），后面每一镜都是从它编辑出来的，11 张全废。
     * 所以这里按"先过目、再开跑"的规矩来，和阶段门禁同一套逻辑。
     *
     * 没有开关：这一版**没有纯文生图**这条路，缺底图就出不了图。
     */
    if (missingPlateIds.value.length) {
      const n = missingPlateIds.value.length
      try {
        const r = await genMissingPlates()
        if (r.ok && !r.fail) {
          message.success(
            `已生成 ${r.ok} 张场景总图 —— 先看一眼（不对就在「按场景」页重合成）；确认后再次点「开始出图」就按它编辑各镜`,
            { duration: 12000 }
          )
        } else if (r.ok) {
          message.warning(
            `${r.ok} 张总图已生成，${r.fail} 张失败。先看总图，确认后再点一次开始出图`,
            { duration: 12000 }
          )
        } else {
          message.error(`${n} 张场景总图都没生成出来：先查 ComfyUI，再试一次`, { duration: 12000 })
        }
      } catch (e) {
        message.error(`场景总图没生成出来：${(e as Error).message || '失败'}`, { duration: 12000 })
      }
      rebaseRows()
      return
    }

    /*
     * 兜到这里的最后一道：还有勾选行找不到底图（场景没绑、或总图被人删了）。
     * 没有底图就不能编辑，硬跑会退化成纯文生图 —— 那正是这一版要消掉的路。
     */
    if (rowsWithoutPlate.value) {
      message.error(
        `有 ${rowsWithoutPlate.value} 张勾选行所在场景还没有总图：先补底图，或在「② 细节填充」里把场景绑上`,
        { duration: 9000 }
      )
      return
    }

    const { rows: items, dropped } = dedupe()
    if (!items.length) {
      message.warning('先勾上要出图的片段')
      return
    }
    if (dropped) message.info(`有 ${dropped} 张与本段另一张撞在同一帧，已跳过`)
    /*
     * 每条提示词都要带上「哪张图是谁」（Reference images: <image1> = ...）。
     * 只把图塞进工作流、不点名，模型不知道该照哪张的脸 —— 最容易出的错就是
     * 两个人的身份互换。所以这句话在这里拼，且下面溯源存的就是拼好的这句：
     * 存原始短句的话，卡片会误判成"提示词被改过、这张图过期了"。
     */
    const sentOf = new Map<string, string>()
    for (const r of items) {
      const key = `${r.beatId}#${r.frame}`
      sentOf.set(key, [r.prompt.trim(), refClause(rowPicked(r))].filter(Boolean).join(' '))
    }
    const results = await images.generateBatch(
      items.map((r) => {
        const key = `${r.beatId}#${r.frame}`
        return {
          key,
          prompt: sentOf.get(key) ?? r.prompt,
          refs: rowRefs(r)
        }
      }),
      { size: size.value }
    )
    let ok = 0
    let replaced = 0
    let fail = 0
    let firstError = ''
    const okIds: ID[] = []
    for (const res of results) {
      const row = items.find((r) => `${r.beatId}#${r.frame}` === res.key)
      if (!res.blob) {
        fail += 1
        if (!firstError) firstError = res.error || '生成失败'
        continue
      }
      if (!row) continue
      try {
        // 同一帧只能有一张：先删旧的，再按这一行的帧号写回（与"重新合成"同一套语义）
        const old = existingOf(row)
        if (old) {
          await registry.removeAsset(old.id)
          replaced += 1
        }
        // 正好覆盖原来那张、且它本来就贴边（段首 / 段尾）时，身份留着 ——
        // 覆盖一张尾帧不该把它悄悄降成普通锚点。其余一律按指定帧写。
        const keep = old && placementOf(old) !== 'at' ? placementOf(old) : 'at'
        // 第五个参数把**这一行真正发出的提示词**带进去：之后这段文本一改，
        // 卡片上就能算出"这张图是旧的"，而不会把用户自己润色的词当成改动。
        await images.attachBeatKeyframe(
          row.beatId,
          res.blob,
          keep,
          keep === 'at' ? row.frame : undefined,
          sentOf.get(res.key) ?? row.prompt
        )
        ok += 1
        if (!okIds.includes(row.beatId)) okIds.push(row.beatId)
      } catch (e) {
        fail += 1
        if (!firstError) firstError = e instanceof Error ? e.message : String(e)
      }
    }
    const bits = [`${ok} 张已挂到片段`]
    if (replaced) bits.push(`覆盖了 ${replaced} 张旧的`)
    if (fail) bits.push(`${fail} 张失败${firstError ? `：${firstError}` : ''}`)
    const text = bits.join('，')
    if (fail) message.error(text, { duration: 9000 })
    else message.success(text)
    emit('done', okIds)
  } catch (e) {
    message.error((e as Error).message || '批量出图失败', { duration: 9000 })
  } finally {
    stopTimer()
  }
}

onBeforeUnmount(stopTimer)
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="批量出素材"
    style="width: 900px; max-width: 94vw"
    :mask-closable="!busy"
    :closable="!busy"
    @update:show="(v: boolean) => (v ? null : close())"
  >
    <n-alert
      v-if="gateBlockers.length"
      type="error"
      :bordered="false"
      style="margin-bottom: 10px"
    >
      <div style="font-weight: 600; font-size: 13px; margin-bottom: 4px">
        还不能出图：前面的阶段没做完
      </div>
      <ul style="margin: 0; padding-left: 18px; font-size: 12.5px; line-height: 1.8">
        <li v-for="(b, i) in gateBlockers" :key="i">{{ b }}</li>
      </ul>
    </n-alert>

    <div class="bkd-bar">
      <n-button
        size="small"
        type="primary"
        secondary
        :loading="aiBusy"
        :disabled="busy || !rows.length"
        @click="askAi"
      >
        {{ aiBusy ? 'AI 排布中…' : 'AI 排布' }}
      </n-button>
      <span class="bkd-sub">
        让模型定第几帧画什么
        <InfoTip
          size="sm"
          :width="320"
          text="读这几段的画面描述来排帧位；出图仍由你点（按参考图方式用的素材不在这里出图）。"
        />
      </span>
      <div class="bkd-spacer" />
      <n-button
        size="tiny"
        quaternary
        :disabled="busy || !pickedRows.length || aiRows > 0"
        :title="aiRows ? 'AI 排过的帧位是有理由的，一键铺平会把它冲掉' : '按段内比例铺开，避开首尾'"
        @click="spread"
      >
        按顺序铺开
      </n-button>
      <div class="bkd-field">
        <span class="bkd-lb">尺寸</span>
        <n-select v-model:value="size" :options="sizeChoices" filterable tag size="small" style="width: 250px" :disabled="busy" @update:value="setSize" />
      </div>
      <div class="bkd-field bkd-channel" :title="channelText">
        <span class="bkd-lb">通道</span>
        <b>{{ images.usingComfy ? '本地 ComfyUI' : '云端 API' }}</b>
      </div>
    </div>

    <!--
      场景总图：一个场景一张，带人物站位。各镜都从它编辑出来，
      所以它排在"出关键帧"前面 —— 没有它，每一镜的空间关系都是模型现编的。
      它只当**编辑底图**：不参与段间引导，也不默认当生图参考图。
    -->
    <div v-if="sceneIds.length" class="bkd-plates">
      <span class="bkd-lb">场景总图</span>
      <span class="bkd-note">{{ sceneIds.length }} 个场景</span>
      <span v-if="missingPlateIds.length" class="bkd-tag">{{ missingPlateIds.length }} 个还没总图</span>
      <span v-else class="bkd-tag bkd-tag-ok">齐了</span>
      <n-button
        size="tiny"
        tertiary
        :disabled="busy || !missingPlateIds.length"
        @click="onGenPlates"
      >
        先生成缺失的总图
      </n-button>
      <span class="bkd-sub">
        先出整场的人和环境
        <InfoTip size="sm" :width="300" text="每镜只动机位；底图不进段间引导。" />
      </span>
    </div>

    <!--
      开口就能说：模型排出来的东西总有些地方不对（张数、景别、光线），
      与其让用户改十几行，不如让他在跑之前先说一句。
    -->
    <div class="bkd-ai-note">
      <span class="bkd-lb">给 AI 的补充要求</span>
      <n-input
        v-model:value="aiNote"
        size="small"
        :disabled="busy || aiBusy"
        placeholder="可空。例如：动作大的段多排两张；别给人物特写；统一夜景冷光"
        @keydown.enter="!busy && !aiBusy && askAi()"
      />
    </div>

    <div class="bkd-hint">{{ runHint }}</div>

    <div class="bkd-list">
      <div
        v-for="row in rows"
        :key="row.key"
        class="bkd-row"
        :class="{ 'is-off': !row.include, 'is-ai': row.source === 'ai' }"
        :data-beat-id="row.beatId"
        :data-frame="row.frame"
      >
        <label class="bkd-check" @click.stop>
          <input v-model="row.include" type="checkbox" :disabled="busy" />
        </label>
        <div class="bkd-main">
          <div class="bkd-title">
            <!-- 挂到哪一段：AI 把一段的画面排到另一段去了，直接改这里 -->
            <n-select
              class="bkd-beat"
              size="tiny"
              filterable
              :value="row.beatId"
              :options="beatOptions"
              :disabled="busy"
              @update:value="(v: ID) => changeBeat(row, v)"
            />
            <span class="bkd-frame">
              <span class="bkd-lb">第</span>
              <n-input-number
                :value="row.frame"
                size="tiny"
                :min="0"
                :max="lastOf(row.frames)"
                :disabled="busy"
                :show-button="false"
                style="width: 64px"
                @update:value="(v: number | null) => (row.frame = clampFrame(v ?? 0, row.frames))"
              />
              <span class="bkd-lb">帧 / 共 {{ row.frames }} 帧</span>
            </span>
            <span v-if="row.source === 'ai'" class="bkd-tag bkd-tag-ai">AI 建议</span>
            <span v-if="row.plateId" class="bkd-tag bkd-tag-plate" title="按本场总图编辑：地点 / 人 / 道具沿用，只动机位">
              编辑 · 场景总图
            </span>
            <span v-else class="bkd-tag bkd-tag-text" title="这个场景还没有总图：先补底图，这一行才能出">
              缺场景总图
            </span>
            <span v-if="!row.chainHead" class="bkd-tag" title="链内下游段：首帧由上一段尾帧引导，默认不出图">
              链内
            </span>
            <span v-if="row.view" class="bkd-view" :title="`机位：${row.view}`">{{ row.view }}</span>
            <span v-if="existingOf(row)" class="bkd-tag">这一帧已有图 · 勾上则覆盖</span>
            <span v-else class="bkd-note">这一帧还空着</span>
            <button
              type="button"
              class="bkd-del"
              :disabled="busy"
              title="删掉这一行（不出这张）"
              @click="removeRow(row)"
            >
              ×
            </button>
          </div>
          <n-input
            v-model:value="row.prompt"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 5 }"
            size="small"
            :disabled="busy"
            :placeholder="
              row.plateId
                ? '按这一场的总图编辑：机位 / 动作 / 光线'
                : '这个场景还没有总图：先补底图，这里会自动填上「按总图编辑」的提示词'
            "
            @update:value="row.edited = true"
          />
          <!-- 参考图：勾上就是照这个人画。逐行各自选，绝不能一批共用一套 -->
          <div v-if="refUsable && row.refs.length" class="bkd-refs">
            <span class="bkd-lb">参考</span>
            <button
              v-for="c in row.refs"
              :key="c.key"
              type="button"
              class="bkd-ref"
              :class="{ 'is-on': row.picked.includes(c.key) }"
              :data-kind="c.kind"
              :disabled="busy"
              :title="
                c.kind === 'plate'
                  ? '场景总图（编辑底图）：整场的人和位置都在这张图里，只改机位。它是这一行的底图，不能取消'
                  : c.kind === 'scene'
                    ? '场景图：只给氛围，默认不勾'
                    : `主体参考图：${c.label}`
              "
              @click="toggleRowRef(row, c.key)"
            >
              <img v-if="c.url" :src="c.url" alt="" />
              <span class="bkd-ref-lb">{{ c.label }}</span>
            </button>
            <span v-if="!row.plateId" class="bkd-note">还没有场景总图：先补底图</span>
            <span v-else-if="!row.picked.length" class="bkd-note">只挂底图也可以出</span>
          </div>          <!-- 理由 / 备注：默认看起来像一行灰字，点上去就能改 -->
          <n-input
            v-model:value="row.note"
            class="bkd-why"
            size="tiny"
            :bordered="false"
            :disabled="busy"
            placeholder="＋ 理由 / 备注（只给自己看，不进出图）"
          />
        </div>
      </div>
    </div>

    <div class="bkd-add">
      <n-select
        v-model:value="addBeatId"
        size="tiny"
        filterable
        :options="beatOptions"
        :disabled="busy"
        style="width: 240px"
        placeholder="加到哪一段"
      />
      <n-button size="tiny" :disabled="busy || !props.beats.length" @click="addRow()">＋ 加一张</n-button>
      <span class="bkd-sub">
        默认落在还空着的帧上
        <InfoTip size="sm" :width="240" text="落在你把「加到哪一段」选中的那一段。" />
      </span>
    </div>

    <div v-if="busy || images.lastError" class="bkd-progress">
      <template v-if="busy">
        <n-spin size="small" />
        <span>{{ images.batchLabel || '提交中…' }}</span>
        <span class="muted mono">{{ elapsed }}s</span>
        <span v-if="images.batchDone" class="muted">已回 {{ images.batchDone }}/{{ images.batchTotal }}</span>
      </template>
      <span v-else class="bkd-err">{{ images.lastError }}</span>
    </div>

    <template #footer>
      <div class="bkd-foot">
        <span class="muted">
          已勾 {{ pickedRows.length }} 张<template v-if="overwriteCount"> · 其中 {{ overwriteCount }} 张会覆盖同帧旧图</template>
        </span>
        <div class="bkd-actions">
          <n-button :disabled="busy" @click="close">取消</n-button>
          <n-button
            type="primary"
            :loading="busy"
            :disabled="!pickedRows.length || gateBlockers.length > 0"
            @click="run"
          >
            开始出图 {{ pickedRows.length || '' }}
          </n-button>
        </div>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.bkd-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.bkd-field {
  display: flex;
  align-items: center;
  gap: 7px;
}
.bkd-spacer {
  flex: 1;
  min-width: 8px;
}
.bkd-lb {
  font-size: 12px;
  color: var(--muted, var(--muted));
}
.bkd-sub {
  font-size: 12px;
  color: var(--muted, var(--muted));
}
.bkd-channel b {
  font-size: 12.5px;
}
.bkd-ai-note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.bkd-ai-note .bkd-lb {
  flex: 0 0 auto;
}
.bkd-hint {
  font-size: 12px;
  color: var(--muted, var(--muted));
  line-height: 1.45;
  margin-bottom: 10px;
}
.bkd-list {
  max-height: 44vh;
  overflow: auto;
  border: 1px solid var(--line, var(--line-strong));
  border-radius: 8px;
}
.bkd-row {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line, var(--line-strong));
  background: var(--panel, #fff);
}
.bkd-row.is-ai {
  box-shadow: inset 3px 0 0 var(--accent);
}
.bkd-row:last-child {
  border-bottom: none;
}
.bkd-row.is-off {
  background: var(--panel-2, var(--panel-2));
  opacity: 0.62;
}
.bkd-check {
  display: flex;
  align-items: flex-start;
  padding-top: 3px;
}
.bkd-check input {
  width: 15px;
  height: 15px;
  margin: 0;
  cursor: pointer;
  accent-color: var(--accent);
}
.bkd-main {
  flex: 1;
  min-width: 0;
}
.bkd-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 3px;
  flex-wrap: wrap;
}
.bkd-beat {
  width: 200px;
}
.bkd-frame {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.bkd-tag {
  font-size: 11px;
  color: var(--warn-ink);
  background: var(--warn-soft);
  border-radius: 4px;
  padding: 1px 5px;
}
.bkd-tag-ai {
  color: var(--accent-ink);
  background: var(--accent-soft);
}
.bkd-tag-plate {
  color: var(--ok-ink);
  background: var(--ok-line);
}
.bkd-tag-text {
  color: var(--muted);
  background: var(--panel-3);
}
.bkd-tag-ok {
  color: var(--ok-ink);
  background: var(--ok-line);
}
.bkd-view {
  font-size: 11px;
  color: var(--accent, var(--accent));
  background: var(--accent-soft);
  border-radius: 4px;
  padding: 1px 5px;
}
.bkd-plates {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 9px;
  margin-bottom: 8px;
  border: 1px solid var(--line, var(--line-strong));
  border-radius: 8px;
  background: var(--panel-2, var(--panel-2));
}
.bkd-auto {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--muted, var(--muted));
  cursor: pointer;
}
.bkd-auto input {
  accent-color: var(--accent);
}
.bkd-note {
  font-size: 11px;
  color: var(--muted, var(--muted));
}
.bkd-del {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--muted, var(--muted));
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
}
.bkd-del:hover {
  color: var(--err);
}
.bkd-why {
  margin-top: 2px;
}
.bkd-refs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 5px;
  flex-wrap: wrap;
}
.bkd-ref {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px 1px 1px;
  border: 1px solid var(--line, var(--line-strong));
  border-radius: 999px;
  background: #fff;
  cursor: pointer;
  opacity: 0.5;
  font-size: 11px;
  line-height: 1;
  color: inherit;
}
.bkd-ref:hover {
  opacity: 0.8;
}
.bkd-ref.is-on {
  opacity: 1;
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}
.bkd-ref img {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--panel-3);
}
.bkd-ref-lb {
  max-width: 76px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bkd-why :deep(.n-input__placeholder) {
  font-size: 11px;
  opacity: 0.8;
}
.bkd-add {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.bkd-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 12.5px;
}
.bkd-err {
  color: var(--err);
  font-size: 12.5px;
}
.bkd-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.bkd-actions {
  display: flex;
  gap: 8px;
}
</style>
