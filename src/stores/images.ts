import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useProviderStore } from './provider'
import { useRegistryStore } from './registry'
import { useProjectStore } from './project'
import { useBeatStore } from './beats'
import { generateImage, editImage } from '@/core/llm/image'
import {
  comfyImageBatch,
  comfyImageRun,
  comfyImageWorkflows,
  type ComfyRef,
  type ComfyWorkflowEntry
} from '@/core/comfyImage'
import { kvGet, kvSet } from '@/db'
import { PLACEMENT_LABEL, frameOf, keyframesOf } from '@/domain/references'
import {
  PLATE_HEIGHT,
  PLATE_WIDTH,
  castOfScene,
  groupByScene,
  layoutSlots,
  planForBeat,
  planLabel,
  plateEditPromptOf,
  platePromptOf,
  type PlateRect,
  type PlateSlot
} from '@/domain/plate'
import { beatFrames } from '@/domain/timing'
import { BEAT_KIND_LABEL } from '@/domain/beats'
import { MAX_SHOTS_PER_BEAT, parseKeyframePlan, type KeyframePlanRow } from '@/domain/keyframePlan'
import { buildAssetPromptMessages, buildKeyframePlanMessages, type KeyframePlanBeat } from '@/core/llm/prompts'
import {
  composeMaterialPrompt,
  promptRefsOf,
  stripReferenceSection,
  unnumberedRefs,
  type PromptRef
} from '@/domain/assetPrompt'
import type {
  Asset,
  AssetActAs,
  Beat,
  Entity,
  ID,
  KeyframePlacement,
  Provider,
  SheetSlot
} from '@/domain/types'
import { sheetPromptOf } from '@/domain/refSheet'

/* ------------------------------------------------------------------ *
 * 图片生成编排：
 *   subjectPrompt / scenePrompt  —— 由实体 / 片段构造英文生图提示词
 *   generate                     —— 纯调用，返回 Blob（不持久化）
 *   attachSubjectImage           —— 存为主体参考图（PictureN）并回写 entity
 *   attachSceneImage             —— 存为片段场景图（pictureN=0，不进 reference 槽）
 * ------------------------------------------------------------------ */

/**
 * 出图的第二条通道：本地 ComfyUI 工作流。
 *
 * 云端 HTTP 生图（/images/generations）和本地工作流是**同一件事的两种实现**：
 * 一段提示词进去、一张图出来。所以通道只影响 generate()，提示词拼装、
 * 落库、图生图底图全都不用分叉 —— 别在这里长出第二套关键帧逻辑。
 *
 * 配置放 KV 而不是 Provider：Provider 是「文本模型」那套（apiKey + model），
 * ComfyUI 没有 Key、模型名也换成了工作流名，塞进去会把 ready 判断弄乱。
 */
export interface ComfyImageConfig {
  channel: 'http' | 'comfy'
  /** ComfyUI 地址，经后端转发 */
  base: string
  /** workflows 目录里的相对名（不含 .json） */
  workflow: string
  /** 覆盖工作流里的步数；null = 用工作流原值 */
  steps: number | null
  /** 默认负向提示词（可留空，那就沿用工作流自己的负向） */
  negative: string
}

const KV_IMAGEGEN = 'imagegen:config'

const DEFAULT_COMFY: ComfyImageConfig = {
  channel: 'http',
  base: 'http://127.0.0.1:8188',
  workflow: '',
  steps: null,
  negative: ''
}

/** '1280x720' → {width: 1280, height: 720}；给 ComfyUI 的 width/height 用。认不出就都不传 */
export function sizeToWH(size?: string): { width?: number; height?: number } {
  const m = String(size ?? '').match(/^\s*(\d+)\s*[x×*]\s*(\d+)\s*$/i)
  if (!m) return {}
  return { width: Number(m[1]), height: Number(m[2]) }
}

/**
 * 一张可当参考图的素材。
 *
 * 参考图不是"随便一张图"，而是**这一段的出场主体长什么样**：人物的 Picture N、
 * 场景图。后端会把它传进 ComfyUI 的 LoadImage，再挂到编码器的 images.image_N 上
 * —— 这样同一个角色跨关键帧才是同一张脸，而不是每张随机长一个人。
 */
export interface RefCandidate {
  /** 素材 id，勾选状态就按它记 */
  key: ID
  label: string
  /**
   * plate = 场景总图（整场一张，带人物站位）。
   * 它的地位比普通参考图高：编辑时**只许动机位**，场景和人不许重画。
   */
  kind: 'subject' | 'scene' | 'plate'
  /** 直接交给后端的形状：后端自己从数据目录读文件，前端不用转 base64 */
  ref: ComfyRef
  url: string | null
}

export const useImageStore = defineStore('images', () => {
  const provider = useProviderStore()
  const registry = useRegistryStore()
  const project = useProjectStore()
  const beats = useBeatStore()

  const busy = ref(false)
  const lastError = ref<string | null>(null)

  /* --------------------------- 出图通道 --------------------------- */

  const comfy = ref<ComfyImageConfig>({ ...DEFAULT_COMFY })
  const workflows = ref<ComfyWorkflowEntry[]>([])
  const workflowsDir = ref('')
  const workflowsRoot = ref('')
  const workflowsBusy = ref(false)
  const workflowsError = ref<string | null>(null)

  const usingComfy = computed(() => comfy.value.channel === 'comfy')

  /** 配置是懒加载的：只有真要出图 / 打开生成弹窗时才读，别拖慢首屏 */
  let configLoaded = false

  /** 上一次本地出图的回执：耗时、prompt_id、注入说明。出图慢，得让人看见它跑过 */
  const lastRun = ref<{ seconds: number; promptId: string; workflow: string; notes: string[] } | null>(null)

  async function loadComfy(): Promise<void> {
    if (configLoaded) return
    configLoaded = true
    const saved = await kvGet<Partial<ComfyImageConfig> | null>(KV_IMAGEGEN, null)
    comfy.value = { ...DEFAULT_COMFY, ...(saved ?? {}) }
  }

  async function patchComfy(patch: Partial<ComfyImageConfig>): Promise<void> {
    await loadComfy()
    comfy.value = { ...comfy.value, ...patch }
    await kvSet(KV_IMAGEGEN, comfy.value)
  }

  /** 拉工作流列表。refresh 会顺便让后端丢掉 /object_info 缓存（装了新节点后点它） */
  async function refreshWorkflows(refresh = false): Promise<void> {
    await loadComfy()
    workflowsBusy.value = true
    workflowsError.value = null
    try {
      const res = await comfyImageWorkflows({ base: comfy.value.base, refresh })
      workflows.value = res.workflows ?? []
      workflowsDir.value = res.dir ?? ''
      workflowsRoot.value = res.root ?? ''
      // 选中的工作流被删了 / 第一次进来：落到第一个像文生图的
      if (!workflows.value.some((w) => w.name === comfy.value.workflow)) {
        const first = workflows.value.find((w) => w.t2i) ?? workflows.value[0]
        if (first) await patchComfy({ workflow: first.name })
      }
    } catch (e) {
      workflowsError.value = e instanceof Error ? e.message : String(e)
    } finally {
      workflowsBusy.value = false
    }
  }

  function resolved(): Provider | null {
    const p = provider.resolved()
    if (!p) return null
    if (!provider.ready) {
      lastError.value = '模型未配置完整（缺 Base URL / Key / 模型名）'
      return null
    }
    return p
  }

  /* --------------------------- 提示词 --------------------------- */

  /**
   * 主体参考图：角色给"头肩特写（基模头）"，场景实体给"空镜环境"，道具给"物件定妆照"。
   *
   * 角色的这一句**只用来出基模头**。真正的参考图是"设定图组"：
   *   基模头 → 编辑 → 组头 → 编辑 → 三视图（见 domain/refSheet.ts）
   * 所以这里不能再说"全身正面"——那是三视图那一步的事，写在这里会让
   * 模型把有限的一张画布分给全身，脸就糊了。三视图 / 组头的提示词走 sheetPrompt()。
   */
  function subjectPrompt(entity: Entity): string {
    const name = (entity.nameEn ?? '').trim() || entity.name
    const desc = ((entity.textDescEn ?? '') || (entity.textDesc ?? '')).trim()
    if (entity.type === 'scene') {
      return [
        'Cinematic environment reference image, wide establishing shot, no people',
        `Location: ${name}`,
        desc || 'Detailed, atmospheric lighting, realistic.',
        'High detail, film still.'
      ].join('. ')
    }
    // 道具要的是"物件定妆照"：全身正面 + 棚拍背景用在道具上，会生成一个奇怪的拟人化东西
    if (entity.type === 'prop') {
      return [
        'Product-style reference photo of a single object, isolated on a neutral seamless background',
        `Object: ${name}`,
        desc || 'Clean edges, accurate material, even soft lighting.',
        'High detail, no people, no text overlay.'
      ].join('. ')
    }
    return sheetPromptOf('master', { name, design: desc })
  }

  /** 设定图三步（基模头 / 组头 / 三视图）的提示词，界面只调这一个入口 */
  function sheetPrompt(entityId: ID, slot: SheetSlot, variant?: string): string {
    const e = registry.entityById.get(entityId)
    if (!e) return ''
    return sheetPromptOf(slot, {
      name: (e.nameEn ?? '').trim() || e.name,
      // 长相只进头部两步，服装只进三视图 —— 两者的分工在 refSheet.ts 里定，
      // 这里各取各的字段，别再拼成一句
      design: ((e.textDescEn ?? '') || (e.textDesc ?? '')).trim(),
      costume: ((e.costumeDescEn ?? '') || (e.costumeDesc ?? '')).trim(),
      variant
    })
  }

  /** 片段场景图：场景 + 画面 + 运镜 + 出场主体 */
  function scenePrompt(beatId: ID): string {
    const beat = beats.ordered.find((b) => b.id === beatId)
    if (!beat) return 'Cinematic film still, 16:9 widescreen, detailed lighting, photorealistic.'
    const scene = beat.sceneId ? registry.entityById.get(beat.sceneId) : undefined
    const sceneName = scene ? (scene.nameEn ?? '').trim() || scene.name : ''
    const vis = ((beat.visualDescEn ?? '') || (beat.visualDesc ?? '') || (beat.title ?? '')).trim()
    const dir = ((beat.directionEn ?? '') || (beat.direction ?? '')).trim()
    const subjects = (beat.entities ?? [])
      .map((id) => registry.entityById.get(id))
      .filter((e): e is Entity => !!e)
      .map((e) => (e.nameEn ?? '').trim() || e.name)
      .filter(Boolean)
      .join(', ')
    return [
      'Cinematic film still, 16:9 widescreen',
      dir ? `Shot: ${dir}` : '',
      sceneName ? `Setting: ${sceneName}` : '',
      vis ? `Scene: ${vis}` : '',
      subjects ? `With: ${subjects}` : '',
      'Detailed lighting, photorealistic.'
    ]
      .filter(Boolean)
      .join('. ')
  }

  /**
   * 段级关键帧：和"场景图"不是一回事。
   *
   *   场景图（scene）  —— 这个地点长什么样，宽幅空镜，给整段做环境参考；
   *   关键帧（keyframe）—— 这一拍的第 N 帧就该长这样，要带上景别、动作、
   *                        出场主体，并强调与主体参考图一致（它会被导演台
   *                        当成画面锚点，人物长相跑偏会直接毁掉这一段）。
   */
  /**
   * 一段的场景与出场主体。
   * keyframePrompt（模板拼词）和 AI 排关键帧（喂给模型）共用这一份，
   * 免得两边对"这段里有谁、在哪儿"各说一套。
   */
  function beatContextOf(beat: Beat): { scene?: Entity; cast: Entity[] } {
    const scene = beat.sceneId ? registry.entityById.get(beat.sceneId) : undefined
    const cast = (beat.entities ?? [])
      .map((id) => registry.entityById.get(id))
      .filter((e): e is Entity => !!e && e.type !== 'scene')
    return { scene, cast }
  }

  function entityName(e: Entity): string {
    return (e.nameEn ?? '').trim() || e.name
  }

  /**
   * 关键帧 / 场景总图里"这个人长什么样"的一句话。
   *
   * 长相和穿着都要带上：这些图没有走设定图组，文字就是唯一依据；
   * 只写脸的话每张关键帧都会自己配一套衣服。
   */
  function entityDesc(e: Entity): string {
    const look = ((e.textDescEn ?? '') || (e.textDesc ?? '')).trim()
    const wear = ((e.costumeDescEn ?? '') || (e.costumeDesc ?? '')).trim()
    return [look, wear].filter(Boolean).join(', ')
  }

  function keyframePrompt(beatId: ID, placement: KeyframePlacement = 'head'): string {
    const beat = beats.ordered.find((b) => b.id === beatId)
    if (!beat) return 'Cinematic film still, 16:9 widescreen, detailed lighting, photorealistic.'
    const { scene, cast } = beatContextOf(beat)
    const sceneName = scene ? entityName(scene) : ''
    const sceneDesc = scene ? entityDesc(scene) : ''
    const vis = ((beat.visualDescEn ?? '') || (beat.visualDesc ?? '') || (beat.title ?? '')).trim()
    const dir = ((beat.directionEn ?? '') || (beat.direction ?? '')).trim()
    const subjects = cast.map(entityName).filter(Boolean).join(', ')
    // 外观描述必须带上：本地工作流没有「参考图」这一路，模型只知道提示词里的长相。
    // 只写名字的话，同一个人每张关键帧都会长得不一样。
    const look = cast
      .map((e) => {
        const desc = entityDesc(e)
        return desc ? `${entityName(e)} (${desc})` : ''
      })
      .filter(Boolean)
      .join('; ')
    const phase =
      placement === 'tail'
        ? 'Final frame of the shot, the moment just before the cut'
        : placement === 'at'
          ? 'Key frame inside the shot'
          : 'Opening frame of the shot, first frame'
    return [
      'Cinematic film still, 16:9 widescreen',
      phase,
      dir ? `Shot: ${dir}` : '',
      sceneName ? `Setting: ${sceneName}${sceneDesc ? ` — ${sceneDesc}` : ''}` : '',
      vis ? `Action: ${vis}` : '',
      subjects ? `Characters on screen: ${subjects}` : '',
      look ? `Character design: ${look}` : '',
      'Keep faces, costumes and props consistent with the reference subject images, detailed lighting, photorealistic.'
    ]
      .filter(Boolean)
      .join('. ')
  }

  /** 纯生成 / 编辑，返回 Blob（不落库）。baseImage 传入则走图生图 */
  async function generate(opts: {
    prompt: string
    size?: string
    baseImage?: Blob | string
    model?: string
    /** 参考图（本地通道的「按主体图编辑」用；云端通道会忽略） */
    refs?: ComfyRef[]
  }): Promise<Blob> {
    await loadComfy()
    busy.value = true
    lastError.value = null
    try {
      if (usingComfy.value) return await generateWithComfy(opts)
      const p = resolved()
      if (!p) throw new Error(lastError.value || '未配置模型供应商')
      const res = opts.baseImage
        ? await editImage(p, { prompt: opts.prompt, size: opts.size, model: opts.model, image: opts.baseImage })
        : await generateImage(p, { prompt: opts.prompt, size: opts.size, model: opts.model })
      return res.blob
    } catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      busy.value = false
    }
  }

  /**
   * 走本地 ComfyUI 工作流出图。
   *
   * 种子每次随机：同一句提示词连点两次应该得到两个候选，而不是同一张图 ——
   * 工作流里写死的种子会让"再生成一张"看起来像没反应。
   */
  async function generateWithComfy(opts: {
    prompt: string
    size?: string
    baseImage?: Blob | string
    refs?: ComfyRef[]
  }): Promise<Blob> {
    await loadComfy()
    if (!comfy.value.workflow) {
      throw new Error('还没选工作流：刷新一下，从 ComfyUI 的 workflows 目录里挑一份')
    }
    // 参考图（主体的人像 / 场景图）走的是工作流的 LoadImage 那一路：
    // 后端在提交前把图传进 ComfyUI，再挂到编码器的 images.image_N 上。
    // 工作流不吃图时后端会记一笔 note，图不会把这次出图弄失败。
    const { width, height } = sizeToWH(opts.size)
    const res = await comfyImageRun({
      base: comfy.value.base,
      workflow: comfy.value.workflow,
      prompt: opts.prompt,
      negative: comfy.value.negative.trim() || undefined,
      width,
      height,
      steps: comfy.value.steps ?? undefined,
      seed: Math.floor(Math.random() * 2 ** 31),
      refs: opts.refs?.length ? opts.refs : undefined
    })
    lastRun.value = {
      seconds: res.seconds,
      promptId: res.promptId,
      workflow: comfy.value.workflow,
      notes: res.report.notes ?? []
    }
    return res.blob
  }

  /* ----------------------------- 批量出图 ----------------------------- */

  /**
   * 批量：本地通道一次提交所有提示词；云端通道只能一条条来。
   *
   * 差别不只是快慢：本地通道里 N 条提示词是同一张图里的 N 条支路，
   * 文本编码器只加载一次、所有提示词先编码完再逐张采样（后端 build_batch）。
   * 云端没有这个机制，只能循环调用，所以进度按条数走。
   */
  const batchRunning = ref(false)
  const batchLabel = ref('')
  const batchDone = ref(0)
  const batchTotal = ref(0)

  async function generateBatch(
    items: { key: string; prompt: string; seed?: number; refs?: ComfyRef[] }[],
    opts: { size?: string } = {}
  ): Promise<{ key: string; blob?: Blob; error?: string }[]> {
    await loadComfy()
    if (!items.length) return []
    batchRunning.value = true
    batchDone.value = 0
    batchTotal.value = items.length
    batchLabel.value = ''
    lastError.value = null
    try {
      if (usingComfy.value) {
        if (!comfy.value.workflow) {
          throw new Error('还没选工作流：刷新一下，从 ComfyUI 的 workflows 目录里挑一份')
        }
        batchLabel.value = `一次提交 ${items.length} 张 · 先统一编码，再逐张采样`
        const { width, height } = sizeToWH(opts.size)
        const res = await comfyImageBatch({
          base: comfy.value.base,
          workflow: comfy.value.workflow,
          negative: comfy.value.negative.trim() || undefined,
          width,
          height,
          steps: comfy.value.steps ?? undefined,
          items: items.map((it) => ({
            key: it.key,
            prompt: it.prompt,
            seed: it.seed ?? Math.floor(Math.random() * 2 ** 31),
            refs: it.refs?.length ? it.refs : undefined
          }))
        })
        lastRun.value = {
          seconds: res.seconds,
          promptId: res.promptId,
          workflow: comfy.value.workflow,
          notes: res.report.notes ?? []
        }
        batchDone.value = items.length
        const byKey = new Map(res.items.map((x) => [x.key, x.blob]))
        return items.map((it) => {
          const blob = byKey.get(it.key)
          return blob ? { key: it.key, blob } : { key: it.key, error: '后端没有返回这一张' }
        })
      }

      // 云端通道：一条条来，进度就是"第几条"
      const out: { key: string; blob?: Blob; error?: string }[] = []
      for (const [i, it] of items.entries()) {
        batchLabel.value = `云端生成 ${i + 1}/${items.length}`
        try {
          const blob = await generate({ prompt: it.prompt, size: opts.size })
          out.push({ key: it.key, blob })
        } catch (e) {
          out.push({ key: it.key, error: e instanceof Error ? e.message : String(e) })
        }
        batchDone.value = i + 1
      }
      return out
    } catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      batchRunning.value = false
      batchLabel.value = ''
    }
  }

  /* ----------------------------- 参考图 ----------------------------- */

  /** 当前选中的工作流最多能挂几张参考图（0 = 这份工作流是纯文生图） */
  const refSupport = computed(() => {
    const w = workflows.value.find((x) => x.name === comfy.value.workflow)
    return Number(w?.refs ?? 0)
  })

  /**
   * 这一段能用哪些图当参考：**场景总图排第一**，然后是出场主体，最后是场景空镜。
   *
   * 总图必须排最前：提示词里 "<image1> 就是这场戏" 是整段编辑的锚点，
   * 顺序变了这句话就指到别人的脸上去了。
   */
  function refCandidatesFor(beatId: ID): RefCandidate[] {
    const beat = beats.ordered.find((b) => b.id === beatId)
    if (!beat) return []
    const out: RefCandidate[] = []
    const seen = new Set<ID>()
    const plate = plateRefFor(beatId)
    if (plate) {
      seen.add(plate.key)
      out.push(plate)
    }
    for (const id of beat.entities ?? []) {
      const ent = registry.entityById.get(id)
      if (!ent || ent.type === 'scene') continue
      const asset = registry.subjectImageFor(id)
      if (!asset || seen.has(asset.id)) continue
      seen.add(asset.id)
      out.push({
        key: asset.id,
        label: ent.name,
        kind: 'subject',
        ref: { projectId: asset.projectId, fileName: asset.fileName },
        url: registry.assetUrl(asset)
      })
    }
    const scene = registry.sceneImageFor(beatId)
    if (scene && !seen.has(scene.id)) {
      out.push({
        key: scene.id,
        label: '场景图',
        kind: 'scene',
        ref: { projectId: scene.projectId, fileName: scene.fileName },
        url: registry.assetUrl(scene)
      })
    }
    return out
  }

  /** 这一段的场景总图（没有就 null） */
  function plateRefFor(beatId: ID): RefCandidate | null {
    const beat = beats.ordered.find((b) => b.id === beatId)
    const sceneId = beat?.sceneId
    if (!sceneId) return null
    const asset = registry.plateFor(sceneId)
    if (!asset) return null
    return {
      key: asset.id,
      label: '场景总图',
      kind: 'plate',
      ref: { projectId: asset.projectId, fileName: asset.fileName },
      url: registry.assetUrl(asset)
    }
  }

  /**
   * 按场景总图编辑这一镜的提示词（没有总图时返回空串，调用方退回文生图）。
   *
   * action 给 AI 排布的行用：模型对画面的描述比字段更具体，把它接在
   * "动作"那一句里，比整段丢掉强。
   */
  function plateEditPromptFor(beatId: ID, action?: string): string {
    const beat = beats.ordered.find((b) => b.id === beatId)
    if (!beat || !beat.sceneId) return ''
    if (!registry.plateFor(beat.sceneId)) return ''
    const plan = planForBeat(beatId, beats.ordered, registry.entityById)
    if (!plan) return ''
    const scene = registry.entityById.get(beat.sceneId)
    const { cast } = beatContextOf(beat)
    const fallback = (beat.visualDescEn ?? '') || (beat.visualDesc ?? '') || (beat.title ?? '')
    const vis = (action ?? fallback).trim()
    return plateEditPromptOf({
      sceneName: scene ? entityName(scene) : 'the location',
      sceneDesc: scene ? entityDesc(scene) : '',
      subjectName: plan.subject ? entityName(plan.subject) : '',
      otherName: plan.other ? entityName(plan.other) : '',
      scale: plan.scale,
      tilt: plan.tilt,
      side: plan.side,
      turn: plan.turn,
      action: vis,
      dialogue: (beat.dialogue ?? '').trim(),
      cast: cast.filter((e) => e.type === 'character').map(entityName)
    })
  }

  /** 这一镜的中文机位说明（界面上显示："中近景 · 右侧机位 · 正面"） */
  function shotLabelFor(beatId: ID): string {
    const plan = planForBeat(beatId, beats.ordered, registry.entityById)
    return plan ? planLabel(plan) : ''
  }

  /**
   * 默认勾哪些：出场主体的图全勾上，场景图**不**默认勾。
   *
   * 理由：主体图决定"这个人长什么样"，是编辑的目的；场景图是氛围参考，
   * 默认塞进去会让模型把构图也一起搬过来，反而限制住运镜。
   */
  function defaultRefsFor(beatId: ID): ComfyRef[] {
    return refCandidatesFor(beatId)
      .filter((c) => c.kind === 'subject')
      .map((c) => c.ref)
  }

  /* --------------------------- 场景占位图 --------------------------- */

  /** 一个场景下的片段（按片序），以及它们出场的主体 */
  function sceneCastOf(sceneId: ID): Entity[] {
    const group = groupByScene(beats.ordered, registry.entityById).find((g) => g.sceneId === sceneId)
    return group ? castOfScene(group.beats, registry.entityById) : []
  }

  /** 站位表：先出场的角色站左边，后面的往右排 —— 与 plate.ts 的提示词用同一份 */
  function plateSlotsOf(sceneId: ID): PlateSlot[] {
    const cast = sceneCastOf(sceneId).filter((e) => e.type === 'character')
    const xs = layoutSlots(cast.length)
    return cast.map((e, i) => ({
      name: entityName(e),
      desc: entityDesc(e) || undefined,
      x: xs[i] ?? 0.5
    }))
  }

  /** 场景占位图的默认提示词：地点 + 全员站位，人物要全身站开（后面才裁得动） */
  function platePrompt(sceneId: ID): string {
    const scene = registry.entityById.get(sceneId)
    const props = sceneCastOf(sceneId)
      .filter((e) => e.type === 'prop')
      .map((e) => entityName(e))
    return platePromptOf({
      sceneName: scene ? entityName(scene) : 'the location',
      sceneDesc: scene ? entityDesc(scene) : '',
      slots: plateSlotsOf(sceneId),
      props,
      width: PLATE_WIDTH,
      height: PLATE_HEIGHT
    })
  }

  /**
   * 出占位图时能挂哪些参考图：**地点自己**排第一（先给环境），再是全员。
   *
   * 都标成 subject 而不是 scene：ImageGenModal 会默认勾上 subject 那一路，
   * 而占位图恰恰需要"照着这个地点画"；标成 scene 会被默认排除，出出来的
   * 便利店跟用户已经定好的门面完全不是一间。
   */
  function plateRefCandidates(sceneId: ID): RefCandidate[] {
    const out: RefCandidate[] = []
    const seen = new Set<ID>()
    const push = (ent: Entity, label: string) => {
      const asset = registry.subjectImageFor(ent.id)
      if (!asset || seen.has(asset.id)) return
      seen.add(asset.id)
      out.push({
        key: asset.id,
        label,
        kind: 'subject',
        ref: { projectId: asset.projectId, fileName: asset.fileName },
        url: registry.assetUrl(asset)
      })
    }
    const scene = registry.entityById.get(sceneId)
    if (scene) push(scene, `场景·${scene.name}`)
    for (const e of sceneCastOf(sceneId)) push(e, e.name)
    return out
  }

  /** 存为该场景的占位图（一个场景只留最新一张：旧的留着只会让人点错） */
  async function attachPlateImage(sceneId: ID, blob: Blob): Promise<Asset> {
    const pid = project.currentId
    if (!pid) throw new Error('当前没有项目')
    const scene = registry.entityById.get(sceneId)
    const prev = registry.plateFor(sceneId)
    const asset = await registry.addGeneratedImage(pid, blob, {
      label: `${scene?.name || '场景'} · 占位图`,
      kind: 'plate',
      refId: sceneId
    })
    // 新图已经存好了，旧图删不掉不该让这次"换底图"失败：plateFor 取的是最新一张，
    // 旧图留着最多占点磁盘，界面上不会用错
    if (prev && prev.id !== asset.id) {
      try {
        await registry.removeAsset(prev.id)
      } catch {
        /* 忽略 */
      }
    }
    return asset
  }

  /* --------------------------- AI 排关键帧 --------------------------- */

  /**
   * 让文本模型给这些片段排关键帧：哪几帧、每帧画什么。
   *
   * 只出**建议**：不落库、不出图。用户看完、改完、点「开始出图」才真的跑 ——
   * 一张图要几十秒，绝不能因为"AI 觉得该有"就自己开跑。
   */
  const planBusy = ref(false)
  const planNote = ref('')

  async function planKeyframes(beatIds: ID[], note = ''): Promise<KeyframePlanRow[]> {
    if (!provider.ready) throw new Error('请先在模型设置里配置供应商：AI 排关键帧要用文本模型')
    const list = beatIds
      .map((id) => beats.ordered.find((b) => b.id === id))
      .filter((b): b is Beat => !!b)
    if (!list.length) return []

    // 模型看不见片子，只能靠这些文字判断"哪一帧发生了变化"
    const briefs: KeyframePlanBeat[] = list.map((b, i) => {
      const frames = beatFrames(b, project.settings)
      const { scene, cast } = beatContextOf(b)
      const sceneText = scene
        ? entityDesc(scene)
          ? `${entityName(scene)} — ${entityDesc(scene)}`
          : entityName(scene)
        : ''
      return {
        index: i + 1,
        title: b.title || '',
        kind: BEAT_KIND_LABEL[b.kind] ?? String(b.kind),
        frames,
        fps: project.settings.fps,
        direction: ((b.directionEn ?? '') || (b.direction ?? '')).trim(),
        visualDesc: ((b.visualDescEn ?? '') || (b.visualDesc ?? '')).trim(),
        dialogue: (b.dialogue ?? '').trim(),
        scene: sceneText,
        cast: cast.map((e) => (entityDesc(e) ? `${entityName(e)}（${entityDesc(e)}）` : entityName(e))),
        existingFrames: keyframesOf(registry.assets, b.id).map((a) => frameOf(a, frames))
      }
    })

    planBusy.value = true
    planNote.value = ''
    lastError.value = null
    try {
      const raw = await provider.callJson<unknown>(
        buildKeyframePlanMessages({ beats: briefs, maxPerBeat: MAX_SHOTS_PER_BEAT, note })
      )
      const rows = parseKeyframePlan(
        raw,
        list.map((b, i) => ({ id: b.id, frames: briefs[i].frames }))
      )
      const total = rows.reduce((n, r) => n + r.shots.length, 0)
      planNote.value = total
        ? `AI 排了 ${total} 张，覆盖 ${rows.length}/${list.length} 段`
        : 'AI 没有给出可用建议：可以自己填帧位与提示词'
      return rows
    } catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      planBusy.value = false
    }
  }

  /** 存为主体参考图：占 PictureN 并回写 entity.pictureN（替换旧图） */  async function attachSubjectImage(entityId: ID, blob: Blob): Promise<void> {
    const pid = project.currentId
    if (!pid) throw new Error('当前没有项目')
    const entity = registry.entityById.get(entityId)
    if (!entity) return
    const prev = registry.subjectImageFor(entityId)
    const asset = await registry.addGeneratedImage(pid, blob, {
      label: entity.name,
      kind: 'subject',
      refId: entityId
    })
    await registry.updateEntity(entityId, { pictureN: asset.pictureN })
    if (prev && prev.id !== asset.id) await registry.removeAsset(prev.id)
  }

  /** 存为片段场景图：pictureN=0，不进 reference 槽（替换同一片段旧图） */
  async function attachSceneImage(beatId: ID, blob: Blob): Promise<void> {
    const pid = project.currentId
    if (!pid) throw new Error('当前没有项目')
    const beat = beats.ordered.find((b) => b.id === beatId)
    const prev = registry.sceneImageFor(beatId)
    await registry.addGeneratedImage(pid, blob, {
      label: beat?.title || '场景图',
      kind: 'scene',
      refId: beatId
    })
    if (prev) await registry.removeAsset(prev.id)
  }

  /**
   * 存为本段的关键帧。
   *
   * 与场景图的区别：它属于**这一段**，会被导演台当成画面锚点（首帧 / 中间 / 尾帧），
   * 不占 <Picture N>、不写进提示词；换一段不受影响。
   */
  /* --------------------------- 素材提示词 --------------------------- */

  /** 素材 id → 素材 / 实体：引用段现拼，不改库里的正文 */
  const promptLookup = {
    assetOf: (id: ID) => registry.assets.find((a) => a.id === id),
    entityOf: (id: ID) => registry.entityById.get(id)
  }

  /**
   * 一条素材**最终会发出去**的那句：正文 + 参考图引用段。
   *
   * 参考方式的素材这里会带上 `<Picture N> 名字 — 外观`：导演包的正文要求
   * 出现 <Picture N>，不写的话那张图进了参考槽却没被点名（打包会警告，
   * 成片里等于白给）。
   */
  function materialPrompt(asset: Asset): string {
    return composeMaterialPrompt(asset, promptLookup)
  }

  /** 这条素材引用了哪几张图（含"没有 Picture 编号"的，UI 要提醒） */
  function materialRefs(asset: Asset): PromptRef[] {
    return promptRefsOf(asset, promptLookup)
  }

  /** 引用了但没有编号的那些：不会进参考槽，只会以名字 + 外观出现在提示词里 */
  function materialUnnumberedRefs(asset: Asset): PromptRef[] {
    return unnumberedRefs(materialRefs(asset))
  }

  /** 正文（不含引用段）—— 编辑器里只该看到这段，引用段是另外生成的 */
  function materialPromptBody(asset: Asset): string {
    return stripReferenceSection(asset.prompt ?? '').trim()
  }

  /**
   * 让模型把用户那句要求写成一条英文出图提示词。
   *
   * 只返回文本，不落库：写不写、改不改，由用户在编辑器里按「采用」决定。
   * 直接覆盖用户手写的提示词是最容易招骂的一种"贴心"。
   */
  async function suggestAssetPrompt(opts: {
    beatId: ID
    /** 用户那句口语要求（必填，否则模型只会把画面描述复述一遍） */
    brief: string
    /** 勾上的参考图（素材 id） */
    refAssetIds?: ID[]
    /** 参考方式：正文里要写 <Picture N> */
    asReference?: boolean
    note?: string
  }): Promise<string> {
    if (!provider.ready) throw new Error('请先在模型设置里配置供应商：AI 写提示词要用文本模型')
    const brief = (opts.brief ?? '').trim()
    if (!brief) throw new Error('先写一句要求，比如"雨夜巷口，他回头看一眼"')
    const beat = beats.ordered.find((b) => b.id === opts.beatId)
    if (!beat) throw new Error('这一段已经不存在了')

    const { scene, cast } = beatContextOf(beat)
    const refs = promptRefsOf({ refAssetIds: opts.refAssetIds ?? [] }, promptLookup)
    const raw = await provider.callText(
      buildAssetPromptMessages({
        brief,
        beat: {
          title: beat.title || '',
          kind: BEAT_KIND_LABEL[beat.kind] ?? String(beat.kind),
          frames: beatFrames(beat, project.settings),
          fps: project.settings.fps,
          direction: ((beat.directionEn ?? '') || (beat.direction ?? '')).trim(),
          visualDesc: ((beat.visualDescEn ?? '') || (beat.visualDesc ?? '')).trim(),
          dialogue: (beat.dialogue ?? '').trim(),
          scene: scene
            ? entityDesc(scene)
              ? `${entityName(scene)} — ${entityDesc(scene)}`
              : entityName(scene)
            : ''
        },
        cast: cast.map((e) => (entityDesc(e) ? `${entityName(e)}（${entityDesc(e)}）` : entityName(e))),
        refs: refs.map((r) => ({ pictureN: r.pictureN, name: r.name, desc: r.desc })),
        asReference: !!opts.asReference,
        note: opts.note
      }),
      { temperature: 0.7 }
    )
    return cleanPromptText(raw)
  }

  /** 模型偶尔会套一层 ``` 或 "Prompt:" 前缀，去掉再给用户看 */
  function cleanPromptText(raw: string): string {
    let t = (raw ?? '').trim()
    t = t.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '')
    t = t.replace(/^(prompt|提示词)\s*[:：]\s*/i, '')
    t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    // 单段：模型偶尔分行，分行在本地工作流里不会出错，但会让人以为有好几个版本
    return t.replace(/\s*\n+\s*/g, ' ').trim()
  }

  async function attachBeatKeyframe(
    beatId: ID,
    blob: Blob,
    placement: KeyframePlacement = 'head',
    frameIdx?: number,
    /** 真正发给模型的那句提示词（用户可能改过）；不传就按模板算 */
    prompt?: string,
    /** 少量附加溯源：从场景占位图裁出来的图要记下它来自哪张、哪个框 */
    extra?: {
      plateId?: ID
      plateRect?: PlateRect
      /** 作用方式：参考图生成后还是参考图，不能悄悄变成关键帧 */
      actAs?: AssetActAs
      /** 这条素材自己的提示词（正文）与那句口语要求 */
      prompt?: string
      promptBrief?: string
      /** 出图时选用的参考图：留着下次重出用同一批 */
      refAssetIds?: ID[]
    }
  ): Promise<Asset> {
    const pid = project.currentId
    if (!pid) throw new Error('当前没有项目')
    const beat = beats.ordered.find((b) => b.id === beatId)
    const isRef = extra?.actAs === 'reference'
    const label = isRef ? '参考图' : PLACEMENT_LABEL[placement]
    /*
     * 存一份"当时的上下文"。
     *
     * 统一按 'at' 算指纹而不是按实际 placement：段首 / 段尾 / 中间只差一句
     * "这是第几帧"的措辞，同一张图换个落点不该被判成"提示词变了"。
     */
    const context = keyframePrompt(beatId, 'at')
    return registry.addGeneratedKeyframe(pid, beatId, blob, {
      placement,
      frameIdx,
      label: beat?.title ? `${beat.title} · ${label}` : label,
      actAs: extra?.actAs,
      genPrompt: (prompt ?? '').trim() || keyframePrompt(beatId, placement),
      genContext: context,
      genDialogue: (beat?.dialogue ?? '').trim(),
      plateId: extra?.plateId,
      plateRect: extra?.plateRect,
      prompt: extra?.prompt,
      promptBrief: extra?.promptBrief,
      refAssetIds: extra?.refAssetIds
    })
  }

  return {
    busy,
    lastError,
    subjectPrompt,
    sheetPrompt,
    scenePrompt,
    keyframePrompt,
    generate,
    generateBatch,
    batchRunning,
    batchLabel,
    batchDone,
    batchTotal,
    /* 参考图（按主体图片编辑） */
    refSupport,
    refCandidatesFor,
    defaultRefsFor,
    /* 场景总图 → 按图编辑各镜 */
    plateEditPromptFor,
    plateRefFor,
    shotLabelFor,
    /* 场景占位图（一个场景一张，供各片段裁起始帧） */
    platePrompt,
    plateRefCandidates,
    attachPlateImage,
    sceneCastOf,
    /* AI 排关键帧（只出建议，出图仍由用户点按钮触发） */
    planKeyframes,
    planBusy,
    planNote,
    /* 素材提示词：正文 + 参考图引用段（参考方式带 <Picture N>） */
    materialPrompt,
    materialRefs,
    materialUnnumberedRefs,
    materialPromptBody,
    suggestAssetPrompt,
    attachSubjectImage,
    attachSceneImage,
    attachBeatKeyframe,
    /* 出图通道 */
    comfy,
    usingComfy,
    loadComfy,
    patchComfy,
    workflows,
    workflowsDir,
    workflowsRoot,
    workflowsBusy,
    workflowsError,
    refreshWorkflows,
    lastRun
  }
})
