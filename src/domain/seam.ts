import { uid, now } from '@/core/id'
import { beatFrames, timecode } from './timing'
import {
  collectEntities,
  dominantScene,
  firstNarrativeBeat,
  firstSpeakerId,
  hasSceneChange,
  lastNarrativeBeat,
  resolveSubjectId
} from './beats'
import type { Beat, ID, ProjectSettings, SeamAnalysis, SeamIssue, Entity } from './types'
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
}

export function analyzeSeam(
  leftBeats: Beat[],
  rightBeats: Beat[],
  ctx: SeamContext = { settings: DEFAULT_SETTINGS }
): SeamAnalysis {
  const settings = ctx.settings
  const leftEntities = collectEntities(leftBeats)
  const rightEntities = collectEntities(rightBeats)

  const lastBeat = lastNarrativeBeat(leftBeats)
  const firstBeat = firstNarrativeBeat(rightBeats)

  const lastSubjectId = lastBeat ? resolveSubjectId(lastBeat) : null
  const firstSubjectId = firstBeat ? resolveSubjectId(firstBeat) : null
  const speakerId = firstSpeakerId(rightBeats)

  // 场景综合判断：换场优先于角色
  const leftSceneId = dominantScene(leftBeats)
  const rightSceneId = dominantScene(rightBeats)
  const sceneChanged = !!leftSceneId && !!rightSceneId && leftSceneId !== rightSceneId

  const issues: SeamIssue[] = []

  const result: SeamAnalysis = {
    leftGroupId: '',
    rightGroupId: '',
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

  // 预备镜头：右段第一个说话镜头之前，必须有一段 0.3s 说话人独占镜头
  result.needsPreshoot = speakerId != null

  /* ---------------- 情况 0：换场 ---------------- */

  if (sceneChanged && settings.scenePriorityOnSeam && rightSceneId) {
    // 换场时"下一段需要的主体"首先是新场景 —— 观众得先看到环境。
    // 引擎会在左段末尾自动插一个 0.3s 的换场镜头展示新场景，
    // 它同时满足"段尾切镜"和"切到的主体在本段已定义并出现"（场景会被写进本段 subject_definitions）。
    result.scenePriorityApplied = true
    result.needsTailCut = true
    result.tailCutTargetId = rightSceneId
    // 换场不做重叠帧，画面差异太大
    result.continuityToNext = false
    result.continuityFromPrev = false

    issues.push({
      code: 'seam:scene-transition',
      level: 'info',
      message: `检测到换场（${subjectLabel(leftSceneId, ctx)} → ${subjectLabel(rightSceneId, ctx)}），左段末尾插入 0.3s 换场镜头切至 ${subjectLabel(rightSceneId, ctx)}，连续性参数置 false`
    })

    // 换场后第一拍就是台词，新环境还没建立
    if (firstBeat && firstBeat.kind === 'dialogue') {
      issues.push({
        code: 'seam:scene-change-no-establish',
        level: 'warn',
        message: '换场后首个叙事镜头就是台词，新环境尚未建立；建议在右段开头加一个场景铺垫片段'
      })
    }
    // 右段自己内部也跨了场景
    if (hasSceneChange(rightBeats)) {
      issues.push({
        code: 'seam:right-multi-scene',
        level: 'warn',
        message: '右段内部包含多个场景，建议按场景拆段'
      })
    }
    return result
  }

  /* ---------------- 情况 1~3：同场，按主体判定 ---------------- */

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
    // 情况 1：左段末帧已经是目标主体，直接顺接
    result.needsTailCut = false
    result.continuityToNext = true
    result.continuityFromPrev = true
    issues.push({
      code: 'seam:aligned',
      level: 'info',
      message: `左段末帧主体即 ${subjectLabel(targetId, ctx)}，无需切镜`
    })
  } else if (leftEntities.includes(targetId)) {
    // 情况 2：目标主体在左段已出现 -> 尾帧最后 0.3s 切镜
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
    // 情况 3：左段没有该主体 -> 黑屏兜底
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
} {
  return {
    black: analysis.blackFallback,
    cut: analysis.needsTailCut,
    preshoot: analysis.needsPreshoot
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
  const generated: Beat[] = []
  const out: Beat[] = []

  const speakerId = firstSpeakerId(narrativeBeats)

  // 1) 预备镜头：每段第一个说话镜头之前
  //    只取决于"本段自己"有没有台词，与缝合结论无关
  if (settings.autoPreshoot && speakerId) {
    const first = firstNarrativeBeat(narrativeBeats)
    const preshoot: Beat = {
      id: uid('beat'),
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

  // 2) 段尾处理
  if (seam?.blackFallback) {
    const last = narrativeBeats[narrativeBeats.length - 1]
    const black: Beat = {
      id: uid('beat'),
      projectId: last?.projectId ?? '',
      order: 9999,
      kind: 'black',
      title: '尾帧黑屏',
      entities: [],
      estFrames: settings.blackTailFrames,
      manualFrames: true,
      enriched: true,
      locked: false,
      sceneId: last?.sceneId,
      createdAt: now(),
      updatedAt: now()
    }
    generated.push(black)
    out.push(black)
  } else if (seam?.needsTailCut && seam.tailCutTargetId && settings.autoTailCut) {
    const last = narrativeBeats[narrativeBeats.length - 1]
    const cut: Beat = {
      id: uid('beat'),
      projectId: last?.projectId ?? '',
      order: 9999,
      kind: 'tail_cut',
      title: '尾帧切镜',
      entities: [seam.tailCutTargetId],
      focusEntityId: seam.tailCutTargetId,
      estFrames: settings.seamFrames,
      manualFrames: true,
      enriched: true,
      locked: false,
      sceneId: last?.sceneId,
      createdAt: now(),
      updatedAt: now()
    }
    generated.push(cut)
    out.push(cut)
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
