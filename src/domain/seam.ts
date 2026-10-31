import { now } from '@/core/id'
import { beatFrames, timecode } from './timing'
import {
  collectEntities,
  dominantScene,
  entityIdsOf,
  firstNarrativeBeat,
  firstSpeakerId,
  hasSceneChange,
  lastNarrativeBeat,
  resolveSubjectId
} from './beats'
import type {
  Beat,
  GuideStrength,
  ID,
  ProjectSettings,
  SeamAnalysis,
  SeamIssue,
  SeamKind,
  SeamOverride,
  Entity
} from './types'
import { AUTO_KINDS, DEFAULT_SETTINGS } from './types'
import { beatShotText, blackText, langOf, preshootText, tailCutText } from './lang'

/* ------------------------------------------------------------------ *
 * 缝合引擎
 *
 * 判定依据：缝合处左右两边绑定的实体
 *   L = 左段最后一个有主体的 Beat  -> lastSubject
 *   R = 右段第一个 Beat            -> firstSubject
 *   X = 右段首个说话人（无台词则为 firstSubject）
 *
 * 规则：
 *   1. lastSubject === X                  -> 不需要尾帧切镜，只加预备镜头
 *   2. X ∈ 左段已出现实体                  -> 尾帧最后 0.3s 切镜到 X
 *   3. X ∉ 左段                            -> 无法合法切镜 -> 黑屏兜底
 *      保证左段最后一帧黑屏，右段自己决定开头，连续性参数一律 false
 * ------------------------------------------------------------------ */

export interface SeamContext {
  settings: ProjectSettings
  entityById?: Map<ID, Entity>
  /**
   * 冻结的段尾处理（出片时那份判定）。
   *
   * 段一旦出片，尾帧去向就已经烤进画面里了。之后邻居变了（插了新段、删了下一段），
   * 实时重算会把尾巴改掉 —— 等于让已出的片作废。传了 freeze 就照快照复现，
   * 保证本段的镜头序列逐字节不变。
   */
  freeze?: { tail: 'none' | 'black' | 'cut'; tailCutTargetId?: ID | null; preshoot?: boolean }
  /** 人工指定本处怎么接（Group.seamToNext），auto / 缺省 = 按结构化字段自动判 */
  override?: SeamOverride
}

export const SEAM_KIND_LABEL: Record<SeamKind, string> = {
  transition: '转场',
  cut: '镜切',
  take: '顺接'
}

/** 引用强度由接缝类型直接映射，别在别处再写一份 */
export const STRENGTH_OF_KIND: Record<SeamKind, GuideStrength> = {
  transition: 0,
  cut: 1,
  take: 2
}

export interface SeamClass {
  kind: SeamKind
  strength: GuideStrength
  /** 判定理由，中文一句话，直接上界面 */
  reason: string
}

/**
 * 接缝分类：只用**可直接比较的结构化字段**，不猜文本。
 *
 * 判据来源就四个：场景实体（sceneId）、镜头主体（resolveSubjectId）、
 * 出场主体集（entities）、镜头类型（kind）。四条按"越确定越优先"排列：
 *
 *   0. 人工指定            —— 定死，覆盖一切
 *   1. 首拍标了 transitionIn —— 阶段一读完整原文时给的，现场判不出来
 *   2. 场景实体变了         —— 换地方，铁证
 *   3. 首拍是 scene_switch  —— 拆解阶段已经标过换场
 *   4. 首拍是 establishing  —— 重新建立环境，仍算同场镜切，但保留首帧锚点
 *   5. 镜头主体相同         —— 顺接
 *   6. 其余（主体有交集 / 无交集）—— 同场镜切
 *
 * 注意第 6 条：**主体不重叠不等于转场**。左段林晚、右段陈默，还在同一间店里，
 * 环境与光位同源，引用上段依然有参考价值。只有场景实体变了才是真换地方。
 * 判不出来（场景缺失、没有片段）时一律落到镜切 —— 引用是安全侧。
 */
export function classifySeam(
  leftBeats: Beat[],
  rightBeats: Beat[],
  ctx: { override?: SeamOverride; entityById?: Map<ID, Entity> } = {}
): SeamClass {
  const last = lastNarrativeBeat(leftBeats)
  const first = firstNarrativeBeat(rightBeats)

  const nameOf = (id: ID | null | undefined): string => {
    if (!id) return '未标场景'
    return ctx.entityById?.get(id)?.name ?? id
  }

  if (!last || !first) {
    return { kind: 'cut', strength: STRENGTH_OF_KIND.cut, reason: '接缝一侧没有可用片段，按镜切处理' }
  }

  if (ctx.override && ctx.override !== 'auto') {
    return {
      kind: ctx.override,
      strength: STRENGTH_OF_KIND[ctx.override],
      reason: `人工指定为${SEAM_KIND_LABEL[ctx.override]}`
    }
  }

  if (first.transitionIn) {
    return {
      kind: 'transition',
      strength: 0,
      reason: `「${first.title || first.id}」标了转场进入`
    }
  }

  const lScene = last.sceneId ?? null
  const rScene = first.sceneId ?? null
  if (lScene && rScene && lScene !== rScene) {
    return { kind: 'transition', strength: 0, reason: `换场：${nameOf(lScene)} → ${nameOf(rScene)}` }
  }

  if (first.kind === 'scene_switch') {
    return {
      kind: 'transition',
      strength: 0,
      reason: `「${first.title || first.id}」是换场镜头`
    }
  }

  if (first.kind === 'establishing') {
    return {
      kind: 'cut',
      strength: STRENGTH_OF_KIND.cut,
      reason: `「${first.title || first.id}」重新建立环境，保留首帧锚点`
    }
  }

  const lSubject = resolveSubjectId(last)
  const rSubject = resolveSubjectId(first)
  if (lSubject && rSubject && lSubject === rSubject) {
    return {
      kind: 'take',
      strength: STRENGTH_OF_KIND.take,
      reason: `同一主体 ${nameOf(lSubject)} 连着演`
    }
  }

  const lSet = new Set(entityIdsOf(last))
  const shared = entityIdsOf(first).find((id) => lSet.has(id))
  const pair = `${nameOf(lSubject)} → ${nameOf(rSubject)}`
  return {
    kind: 'cut',
    strength: STRENGTH_OF_KIND.cut,
    reason: shared ? `同场镜切：${pair}（${nameOf(shared)} 两边都在）` : `同场镜切：${pair}`
  }
}

export function analyzeSeam(
  leftBeats: Beat[],
  rightBeats: Beat[],
  ctx: SeamContext = { settings: DEFAULT_SETTINGS }
): SeamAnalysis {
  const settings = ctx.settings
  const legacy = (settings.seamPolicy ?? 'guide') === 'legacy'

  const leftEntities = collectEntities(leftBeats)
  const rightEntities = collectEntities(rightBeats)

  const lastBeat = lastNarrativeBeat(leftBeats)
  const firstBeat = firstNarrativeBeat(rightBeats)

  const lastSubjectId = lastBeat ? resolveSubjectId(lastBeat) : null
  const firstSubjectId = firstBeat ? resolveSubjectId(firstBeat) : null
  const speakerId = firstSpeakerId(rightBeats)

  /*
   * 接缝两侧的场景：优先取**边界那一拍**的 sceneId。
   *
   * 以前用整段的 dominantScene（众数），段内跨场景时众数会把接缝处的真实
   * 场景盖掉 —— 左段最后三拍已经进了天台，众数还是便利店，于是判成同场。
   * 真正贴在一起的是这两拍，就该看这两拍。取不到再退回众数。
   */
  const leftSceneId = lastBeat?.sceneId ?? dominantScene(leftBeats)
  const rightSceneId = firstBeat?.sceneId ?? dominantScene(rightBeats)
  const sceneChanged = !!leftSceneId && !!rightSceneId && leftSceneId !== rightSceneId

  const cls = classifySeam(leftBeats, rightBeats, {
    override: ctx.override,
    entityById: ctx.entityById
  })

  const issues: SeamIssue[] = []

  const result: SeamAnalysis = {
    leftGroupId: '',
    rightGroupId: '',
    kind: cls.kind,
    strength: cls.strength,
    reason: cls.reason,
    lastSubjectId,
    firstSubjectId,
    firstSpeakerId: speakerId,
    tailCutTargetId: null,
    needsTailCut: false,
    needsPreshoot: false,
    blackFallback: false,
    continuityToNext: false,
    continuityFromPrev: false,
    leftEntities,
    leftSceneId,
    rightSceneId,
    sceneChanged,
    scenePriorityApplied: false,
    issues
  }

  if (leftBeats.length === 0 || rightBeats.length === 0) {
    issues.push({
      code: 'seam:empty',
      level: 'error',
      message: '缝合处有一侧为空，无法判定'
    })
    return result
  }

  /* ---------------- guide：段间引导，段内不放补丁 ---------------- */

  if (!legacy) {
    // 引用与否只看强度：transition 0 不引导，cut 1 / take 2 都引导
    result.continuityToNext = cls.strength > 0
    result.continuityFromPrev = cls.strength > 0

    issues.push({
      code: `seam:${cls.kind}`,
      level: 'info',
      message: cls.reason
    })

    if (cls.kind === 'transition') {
      issues.push({
        code: 'seam:transition-needs-head',
        level: 'info',
        message: '转场进入：不引导下段，一致性由本段首帧关键帧 + 主体参考图负责'
      })
    }

    if (!lastBeat?.sceneId || !firstBeat?.sceneId) {
      issues.push({
        code: 'seam:missing-scene',
        level: 'warn',
        message: '接缝处有一侧没标场景，转场只能按主体 / 镜头判；同场景内的时间跳跃请在该拍标「转场进入」'
      })
    }

    // 段内跨场景：本段自己要拆，接缝判得再准也救不了
    if (hasSceneChange(rightBeats)) {
      issues.push({
        code: 'seam:right-multi-scene',
        level: 'warn',
        message: '右段内部包含多个场景，建议按场景拆段'
      })
    }
    return result
  }

  /* ---------------- legacy：旧行为，一字不改 ---------------- */

  result.needsPreshoot = speakerId != null

  if (sceneChanged && settings.scenePriorityOnSeam && rightSceneId) {
    result.scenePriorityApplied = true
    result.needsTailCut = true
    result.tailCutTargetId = rightSceneId
    result.continuityToNext = false
    result.continuityFromPrev = false

    issues.push({
      code: 'seam:scene-transition',
      level: 'info',
      message: `检测到换场（${subjectLabel(leftSceneId, ctx)} → ${subjectLabel(rightSceneId, ctx)}），左段末尾插入 0.3s 换场镜头切至 ${subjectLabel(rightSceneId, ctx)}，连续性参数置 false`
    })

    if (firstBeat && firstBeat.kind === 'dialogue') {
      issues.push({
        code: 'seam:scene-change-no-establish',
        level: 'warn',
        message: '换场后首个叙事镜头就是台词，新环境尚未建立；建议在右段开头加一个场景铺垫片段'
      })
    }
    if (hasSceneChange(rightBeats)) {
      issues.push({
        code: 'seam:right-multi-scene',
        level: 'warn',
        message: '右段内部包含多个场景，建议按场景拆段'
      })
    }
    return result
  }

  const targetId = speakerId ?? firstSubjectId

  if (targetId == null) {
    issues.push({
      code: 'seam:no-target',
      level: 'warn',
      message: '右段首个片段既没有说话人也没有场景，无法判定切镜目标'
    })
    return result
  }

  if (sceneChanged) {
    issues.push({
      code: 'seam:scene-change-ignored',
      level: 'warn',
      message: `本次为换场（${subjectLabel(leftSceneId, ctx)} → ${subjectLabel(rightSceneId, ctx)}），但已关闭"换场场景优先"，仍按说话人 / 主体判定`
    })
  }

  if (lastSubjectId === targetId) {
    result.needsTailCut = false
    result.continuityToNext = true
    result.continuityFromPrev = true
    issues.push({
      code: 'seam:aligned',
      level: 'info',
      message: `左段末帧主体即 ${subjectLabel(targetId, ctx)}，无需切镜`
    })
  } else if (leftEntities.includes(targetId)) {
    result.needsTailCut = true
    result.tailCutTargetId = targetId
    result.continuityToNext = true
    result.continuityFromPrev = true
    issues.push({
      code: 'seam:tail-cut',
      level: 'info',
      message: `左段尾帧最后 ${(settings.seamFrames / settings.fps).toFixed(1)}s 切镜至 ${subjectLabel(targetId, ctx)}`
    })
    const focused = leftBeats.some((b) => resolveSubjectId(b) === targetId)
    if (!focused) {
      issues.push({
        code: 'seam:defined-but-not-focused',
        level: 'warn',
        message: `${subjectLabel(targetId, ctx)} 在左段已绑定但从未成为镜头主体，切镜可能缺少铺垫`
      })
    }
  } else {
    result.blackFallback = true
    result.needsTailCut = false
    result.continuityToNext = false
    result.continuityFromPrev = false
    issues.push({
      code: 'seam:black-fallback',
      level: 'warn',
      message: `左段未包含 ${subjectLabel(targetId, ctx)}，无法合法切镜 -> 左段最后一帧黑屏，右段自行决定开头`
    })
  }

  if (rightEntities.length === 0) {
    issues.push({
      code: 'seam:right-empty-entities',
      level: 'warn',
      message: '右段没有任何绑定实体'
    })
  }

  return result
}

function subjectLabel(id: ID, ctx: SeamContext): string {
  const e = ctx.entityById?.get(id)
  if (!e) return id
  return `${e.name}${e.subjectN != null ? ` (S${e.subjectN})` : ''}`
}

/** 缝合代价：供组合引擎打分用 */
export function seamCost(analysis: SeamAnalysis, settings: ProjectSettings): {
  black: boolean
  cut: boolean
  preshoot: boolean
  /** guide 策略下的真实口径：转场才是硬代价 */
  transition: boolean
  kind: SeamKind
} {
  return {
    black: analysis.blackFallback,
    cut: analysis.needsTailCut,
    preshoot: analysis.needsPreshoot,
    /** guide 策略下的真实口径：转场才是硬代价 */
    transition: analysis.kind === 'transition',
    kind: analysis.kind
  }
}

/* ------------------------------------------------------------------ *
 * 素材化：把一段 Beat 序列 + 缝合结论
 * 展开成真正会被写进提示词的片段序列（含自动生成的拼接片段）
 * ------------------------------------------------------------------ */

export interface MaterializeResult {
  beats: Beat[]
  /** 该段实际占用帧数 */
  frames: number
  /** 生成的片段（便于界面高亮） */
  generated: Beat[]
}

export function materializeSegment(
  narrativeBeats: Beat[],
  seam: SeamAnalysis | null,
  ctx: SeamContext = { settings: DEFAULT_SETTINGS }
): MaterializeResult {
  const settings = ctx.settings
  const policy = settings.seamPolicy ?? 'guide'
  const generated: Beat[] = []
  const out: Beat[] = []

  /*
   * 出过片的段按冻结快照复现，否则切策略（legacy ↔ guide）会把老片的
   * 段内容改掉 —— 那等于让已经渲染好的片子失效。
   * 所以只要 ctx.freeze 在，仍然按旧方式补齐段首 / 段尾的自动片段。
   */
  const keepAuto = policy === 'legacy' || !!ctx.freeze

  const speakerId = firstSpeakerId(narrativeBeats)
  const lastBeat = narrativeBeats[narrativeBeats.length - 1]

  /*
   * 段首预备镜头插不插，只看「出片那一刻它有没有」：
   *   · 有冻结快照 → 按快照记的来（老数据没记，当时只有 legacy，所以按 true 推）
   *   · 没快照     → 新内容，按当前策略
   */
  const wantPreshoot = ctx.freeze
    ? (ctx.freeze.preshoot ?? policy === 'legacy')
    : policy === 'legacy'

  // 1) 预备镜头：每段第一个说话镜头之前
  if (wantPreshoot && settings.autoPreshoot && speakerId) {
    const first = firstNarrativeBeat(narrativeBeats)
    const preshoot: Beat = {
      // ★ id 必须可复现：这些自动片段每次渲染都会重建，用随机 uid 会让
      //   segmentSourceHash 每次都变 —— 结果是模型字段永远被判成「已过期」，
      //   「新增/删除片段」的对比也永远把自动片段算成新增。
      id: `beat_preshoot_${first?.id ?? 'segment'}`,
      projectId: first?.projectId ?? '',
      order: -1,
      kind: 'preshoot',
      title: '预备镜头',
      entities: [speakerId],
      focusEntityId: speakerId,
      estFrames: settings.preshootFrames,
      manualFrames: true,
      enriched: true,
      locked: false,
      sceneId: first?.sceneId,
      createdAt: now(),
      updatedAt: now()
    }
    generated.push(preshoot)
    out.push(preshoot)
  }

  out.push(...narrativeBeats)

  /*
   * 2) 段尾处理。
   *
   * guide 策略下什么都不插：不引导下段时，右段本来就能自己决定开头，
   * 不需要"切过去"也不需要"黑屏兜底"—— 那条 0.3s 的黑屏本身就是旧思路的补丁。
   */
  if (keepAuto) {
    const blackTail = ctx.freeze ? ctx.freeze.tail === 'black' : !!seam?.blackFallback
    const tailCut = ctx.freeze
      ? ctx.freeze.tail === 'cut'
        ? (ctx.freeze.tailCutTargetId ?? null)
        : null
      : seam?.needsTailCut
        ? (seam?.tailCutTargetId ?? null)
        : null

    if (blackTail) {
      const black: Beat = {
        id: `beat_black_${lastBeat?.id ?? 'segment'}`,
        projectId: lastBeat?.projectId ?? '',
        order: 9999,
        kind: 'black',
        title: '尾帧黑屏',
        entities: [],
        estFrames: settings.blackTailFrames,
        manualFrames: true,
        enriched: true,
        locked: false,
        sceneId: lastBeat?.sceneId,
        createdAt: now(),
        updatedAt: now()
      }
      generated.push(black)
      out.push(black)
    } else if (tailCut && settings.autoTailCut) {
      const cut: Beat = {
        id: `beat_tailcut_${lastBeat?.id ?? 'segment'}`,
        projectId: lastBeat?.projectId ?? '',
        order: 9999,
        kind: 'tail_cut',
        title: '尾帧切镜',
        entities: [tailCut],
        focusEntityId: tailCut,
        estFrames: settings.seamFrames,
        manualFrames: true,
        enriched: true,
        locked: false,
        sceneId: lastBeat?.sceneId,
        createdAt: now(),
        updatedAt: now()
      }
      generated.push(cut)
      out.push(cut)
    }
  }

  const frames = out.reduce((sum, b) => sum + beatFrames(b, settings), 0)
  return { beats: out, frames, generated }
}

/** 生成 detailed_description 里每一拍的文本（供派生与预览共用） */
export function beatShotLine(
  beat: Beat,
  shotNo: number,
  cursorFrames: number,
  ctx: SeamContext,
  nameOf: (id: ID | null | undefined) => string,
  subjectTagOf: (id: ID | null | undefined) => string,
  sxTagOf: (id: ID | null | undefined) => string
): string {
  const settings = ctx.settings
  const lang = langOf(settings)
  const at = timecode(cursorFrames, settings.fps)
  const head = `[Shot ${shotNo}] At ${at},`

  switch (beat.kind) {
    case 'dialogue': {
      const who = beat.speakerId
      const tag = subjectTagOf(who)
      const sx = sxTagOf(who)
      // says: / <d> 是结构锚点，只有台词本体保持中文
      return `${head} Only ${nameOf(who)} is in frame. ${tag} ${sx} says: <d>[Chinese] ${(beat.dialogue ?? '').trim()}</d>`
    }
    case 'preshoot':
      return `${head} ${preshootText(lang, nameOf(beat.focusEntityId ?? beat.entities[0]))}`
    case 'tail_cut': {
      const target = beat.focusEntityId ?? beat.entities[0] ?? null
      // 换场时切的是"新环境"，措辞要区别于人物入画
      const isScene = target ? ctx.entityById?.get(target)?.type === 'scene' : false
      return `${head} ${tailCutText(lang, subjectTagOf(target), isScene)}`
    }
    case 'black':
      return `${head} ${blackText(lang)}`
    default: {
      const text = beatShotText(beat, lang)
      const focus = resolveSubjectId(beat)
      const only = focus && beat.entities.length > 1 ? ` Only ${nameOf(focus)} is in frame.` : ''
      return `${head} ${text.replace(/\.?$/, '.')}${only}`
    }
  }
}

export function autoGeneratedCount(beats: Beat[]): number {
  return beats.filter((b) => AUTO_KINDS.includes(b.kind)).length
}
