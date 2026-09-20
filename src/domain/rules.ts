import { AUTO_KINDS } from './types'
import { beatFrames, isOverLimit, countHanzi, dialogueFrames, timecode } from './timing'
import {
  familyLabel,
  fitSegmentFrames,
  isAligned,
  padTotalOf,
  paddedBeatFrames,
  sumPaddedFrames
} from './frames'
import {
  allEntityIdsOf,
  collectEntities,
  collectScenes,
  sceneIdOf,
  firstNarrativeBeat,
  firstSpeakerId,
  lastNarrativeBeat,
  resolveSubjectId
} from './beats'
import { computeNumbering, normalizeVoiceDesc, pictureTag, subjectTag, sxTag } from './registry'
import { entityVoiceDesc, hasCjkOutsideD, isZh, langOf } from './lang'
import type { Beat, Entity, FieldSchema, ID, Lang, ProjectSettings, SeamAnalysis } from './types'
import { DEFAULT_SETTINGS, isSceneEntity } from './types'

/* ------------------------------------------------------------------ *
 * 校验引擎 —— 把「检查清单」变成可执行代码
 * 约束已前移到结构里（Beat 级实体绑定），这里做兜底
 * ------------------------------------------------------------------ */

export type RuleLevel = 'error' | 'warn' | 'info'

export interface RuleIssue {
  ruleId: string
  level: RuleLevel
  field?: string
  beatId?: ID
  message: string
}

export interface ValidateContext {
  settings: ProjectSettings
  entityById: Map<ID, Entity>
  schema: FieldSchema[]
  /**
   * 本段字段「应当处于」的语言。
   * zh = 还在中文工作阶段，跳过中英校验；en = 必须已是规范英文终稿。
   * 缺省跟随 settings.workLanguage；已本地化的段由调用方显式传 en。
   */
  lang?: Lang
}

/** 解析本段应校验的语言 */
export function contextLang(ctx: ValidateContext): Lang {
  return ctx.lang ?? langOf(ctx.settings)
}

const D = '<d>[Chinese] '

const REVERSE_PATTERNS = [
  /离开/,
  /消失/,
  /淡出/,
  /\bleaves?\b/i,
  /\bleaving\b/i,
  /\bfades?\s+out\b/i,
  /\bfading\b/i,
  /\bdisappears?\b/i,
  /\bwalks?\s+away\b/i
]

const TIMECODE_RE = /\[Shot\s+\d+\]\s+At\s+\d{2}:\d{2}\.\d{3},/
const DIALOGUE_RE = /<Subject\s+(\d+)>\s*\(S(\d+)\)\s+says:\s*<d>\[Chinese\][\s\S]*?<\/d>/g

/* --------------------------- 单段校验 --------------------------- */

export interface SegmentValidateInput {
  /** 已素材化：含 preshoot / tail_cut / black */
  beats: Beat[]
  /** 纯叙事片段 */
  narrativeBeats: Beat[]
  fields: Record<string, string>
  seam: SeamAnalysis | null
  nextSeam?: SeamAnalysis | null
  /** 本段是否引用上一段（决定帧长度家族） */
  refPrev?: boolean
  /** 额外副帧 */
  pad?: Record<ID, number> | null
}

export function validateSegment(input: SegmentValidateInput, ctx: ValidateContext): RuleIssue[] {
  const { beats, narrativeBeats, fields } = input
  const issues: RuleIssue[] = []
  const settings = ctx.settings
  const lang = contextLang(ctx)
  const zhMode = isZh(lang)

  // --- 字段齐全 ---
  for (const f of [...ctx.schema].sort((a, b) => a.order - b.order)) {
    if (f.required && !(fields[f.key] ?? '').trim()) {
      issues.push({ ruleId: 'field:missing', level: 'error', field: f.key, message: `字段 ${f.key} 为空` })
    }
  }

  // --- 帧数：家族对齐 + 上限 ---
  const refPrev = input.refPrev ?? false
  const pad = input.pad ?? null
  const rawFrames = beats.reduce((s, b) => s + beatFrames(b, settings), 0)
  const frames = sumPaddedFrames(beats, settings, pad)
  // 压缩下限：台词不能短于它自己的台词时长
  const floorFrames = narrativeBeats
    .filter((b) => b.kind === 'dialogue')
    .reduce((s, b) => s + dialogueFrames(b.dialogue, settings.fps), 0)
  const fit = fitSegmentFrames(rawFrames, refPrev, settings.maxSegmentFrames, floorFrames)

  if (!isAligned(frames, refPrev)) {
    const delta = fit.target - frames
    issues.push({
      ruleId: 'frames:not-aligned',
      level: 'error',
      message: `本段 ${frames} 帧不满足 ${familyLabel(refPrev)}（目标 ${fit.target} 帧，还差 ${delta > 0 ? `补 ${delta}` : `压 ${-delta}`} 帧）`
    })
  }

  if (fit.overLimit) {
    issues.push({
      ruleId: 'frames:limit',
      level: 'error',
      message: `本段所需 ${fit.target} 帧，超过该模式下限 ${fit.cap} 帧（上限 ${settings.maxSegmentFrames} 帧），必须拆段`
    })
  } else if (isOverLimit(frames, settings)) {
    issues.push({
      ruleId: 'frames:limit',
      level: 'error',
      message: `本段 ${frames} 帧，超过上限 ${settings.maxSegmentFrames} 帧`
    })
  }

  // --- 副帧合计必须对得上 ---
  if (pad && padTotalOf(pad) !== fit.padTotal) {
    const padTotal = padTotalOf(pad)
    issues.push({
      ruleId: 'frames:pad-mismatch',
      level: 'warn',
      message: `副帧合计 ${padTotal > 0 ? '+' : ''}${padTotal} 与所需补正量 ${fit.padTotal > 0 ? '+' : ''}${fit.padTotal} 不一致（合计应为 ${fit.target} 帧）`
    })
  }

  // --- 台词时长不得超出段时长 ---
  const dialogueTotal = narrativeBeats
    .filter((b) => b.kind === 'dialogue')
    .reduce((s, b) => s + dialogueFrames(b.dialogue, settings.fps), 0)
  if (dialogueTotal > frames) {
    issues.push({
      ruleId: 'frames:dialogue-overflow',
      level: 'error',
      message: `台词总时长 ${dialogueTotal} 帧 > 段时长 ${frames} 帧`
    })
  }

  // --- 汉字数÷5 校验（复算，防手改帧数导致不匹配） ---
  for (const b of narrativeBeats) {
    if (b.kind !== 'dialogue') continue
    const hanzi = countHanzi(b.dialogue)
    const need = dialogueFrames(b.dialogue, settings.fps)
    const actual = paddedBeatFrames(b, settings, pad)
    if (actual + 1 < need) {
      issues.push({
        ruleId: 'dialogue:too-tight',
        level: 'error',
        beatId: b.id,
        message: `台词 ${hanzi} 字需要 ${need} 帧，实际只有 ${actual} 帧`
      })
    }
  }

  // --- subject_definitions ---
  const defs = fields.subject_definitions ?? ''
  const defSubjectNs = new Set<number>()
  for (const m of defs.matchAll(/<Subject\s+(\d+)>/g)) defSubjectNs.add(Number(m[1]))

  const presentEntities = collectEntities(narrativeBeats)
    .map((id) => ctx.entityById.get(id))
    .filter((e): e is Entity => !!e)

  for (const e of presentEntities) {
    if (e.subjectN == null) {
      issues.push({
        ruleId: 'registry:no-number',
        level: 'error',
        beatId: undefined,
        message: `实体「${e.name}」没有分配 <Subject N>`
      })
      continue
    }
    if (!defSubjectNs.has(e.subjectN)) {
      issues.push({
        ruleId: 'defs:missing-entity',
        level: 'error',
        field: 'subject_definitions',
        message: `出场实体 ${subjectTag(e)}（${e.name}）未在 subject_definitions 中定义`
      })
    }
  }

  // 反向：定义了但本段没出场
  for (const n of defSubjectNs) {
    if (!presentEntities.some((e) => e.subjectN === n)) {
      issues.push({
        ruleId: 'defs:unused-entity',
        level: 'warn',
        field: 'subject_definitions',
        message: `<Subject ${n}> 已定义但本段并未出场`
      })
    }
  }

  // 音色描述逐字一致 / speaking 标记正确
  for (const e of presentEntities) {
    const line = findDefinitionLine(defs, e.subjectN)
    if (!line) continue
    const hasSpeaking = /\bspeaking with\b/.test(line)
    if (e.kind === 'speaking') {
      if (!hasSpeaking) {
        issues.push({
          ruleId: 'voice:missing',
          level: 'error',
          field: 'subject_definitions',
          message: `${e.name} 是说话角色，出场必须带 speaking with ... (S${e.subjectN})`
        })
      } else if (e.voiceDesc) {
        // 音色描述必须与注册表逐字一致；英文终稿比对的是英文词条
        const expected = normalizeVoiceDesc(entityVoiceDesc(e, lang))
        if (expected && !line.includes(expected)) {
          issues.push({
            ruleId: 'voice:verbatim-mismatch',
            level: 'error',
            field: 'subject_definitions',
            message: `${e.name} 的音色描述与注册表不一致（必须逐字一致）`
          })
        }
      }
      if (e.sx != null && !new RegExp(`\\(S${e.sx}\\)`).test(line)) {
        issues.push({
          ruleId: 'voice:sx-missing',
          level: 'error',
          field: 'subject_definitions',
          message: `${e.name} 缺少 (S${e.sx}) 标记`
        })
      }
    } else if (hasSpeaking) {
      issues.push({
        ruleId: 'voice:unexpected',
        level: 'error',
        field: 'subject_definitions',
        message: `${e.name} 是不说话角色，不应写 speaking with`
      })
    }

    if (e.pictureN != null && !line.includes(pictureTag(e))) {
      issues.push({
        ruleId: 'defs:picture-missing',
        level: 'error',
        field: 'subject_definitions',
        message: `${e.name} 有素材但未绑定 ${pictureTag(e)}`
      })
    }
  }

  // --- 台词格式 ---
  const dd = fields.detailed_description ?? ''
  const dialogueLines = dd.split('\n').filter((l) => l.includes('says:'))
  for (const line of dialogueLines) {
    if (!/<Subject\s+\d+>\s*\(S\d+\)\s*says:\s*<d>/.test(line)) {
      issues.push({
        ruleId: 'dialogue:format',
        level: 'error',
        field: 'detailed_description',
        message: `台词行格式不正确，应为 <Subject N> (Sx) says: <d>...</d> → ${line.slice(0, 60)}`
      })
    }
    const idx = line.indexOf('<d>')
    if (idx >= 0 && /<Subject\s+\d+>/.test(line.slice(idx))) {
      issues.push({
        ruleId: 'dialogue:id-inside-d',
        level: 'error',
        field: 'detailed_description',
        message: '说话人 ID 写进了 <d> 标签内部'
      })
    }
  }

  // --- 谁说话镜头给谁 ---
  for (const line of dialogueLines) {
    const only = line.match(/Only\s+([^,]+?)\s+is in frame/i)
    const says = line.match(/<Subject\s+(\d+)>\s*\(S(\d+)\)\s+says:/)
    if (!says) continue
    const speakerN = Number(says[1])
    if (!only) {
      issues.push({
        ruleId: 'shot:no-only',
        level: 'warn',
        field: 'detailed_description',
        message: `<Subject ${speakerN}> 的台词镜头未写 Only [说话人] is in frame.`
      })
      continue
    }
    const otherNums = [...line.matchAll(/<Subject\s+(\d+)>/g)].map((m) => Number(m[1]))
    const other = otherNums.find((n) => n !== speakerN)
    if (other != null) {
      issues.push({
        ruleId: 'shot:wrong-speaker',
        level: 'error',
        field: 'detailed_description',
        message: `台词属于 <Subject ${speakerN}>，但镜头里出现了 <Subject ${other}>`
      })
    }
  }

  // --- 预备镜头 ---
  const speaker = firstSpeakerId(narrativeBeats)
  if (speaker && settings.autoPreshoot) {
    const firstShot = beats[0]
    if (!firstShot || firstShot.kind !== 'preshoot') {
      issues.push({
        ruleId: 'shot:missing-preshoot',
        level: 'error',
        field: 'detailed_description',
        message: '每段第一个说话镜头前必须有 0.3 秒说话人独占预备镜头'
      })
    } else if (resolveSubjectId(firstShot) !== speaker) {
      issues.push({
        ruleId: 'shot:preshoot-wrong-subject',
        level: 'error',
        field: 'detailed_description',
        message: '预备镜头的主体不是本段第一个说话人'
      })
    }
  }

  // --- 时间戳格式 ---
  for (const line of dd.split('\n').filter(Boolean)) {
    if (!TIMECODE_RE.test(line)) {
      issues.push({
        ruleId: 'shot:timecode',
        level: 'error',
        field: 'detailed_description',
        message: `镜头行时间戳格式错误：${line.slice(0, 50)}`
      })
    }
  }

  // --- 段尾切镜 / 黑屏兜底 ---
  const tail = beats[beats.length - 1]
  if (input.nextSeam) {
    if (input.nextSeam.blackFallback) {
      if (!tail || tail.kind !== 'black') {
        issues.push({
          ruleId: 'seam:black-required',
          level: 'error',
          field: 'detailed_description',
          message: '本段与下段无法合法切镜，最后一帧必须黑屏'
        })
      }
    } else if (input.nextSeam.needsTailCut) {
      if (!tail || tail.kind !== 'tail_cut') {
        issues.push({
          ruleId: 'seam:tail-cut-required',
          level: 'error',
          field: 'detailed_description',
          message: '段尾最后 0.3 秒需要切到下一段主体，但尾帧切镜片段缺失'
        })
      }
    }
  }

  // --- 反向叙事禁止 ---
  for (const line of dd.split('\n')) {
    for (const p of REVERSE_PATTERNS) {
      if (p.test(line)) {
        issues.push({
          ruleId: 'shot:reverse-narrative',
          level: 'error',
          field: 'detailed_description',
          message: `禁止反向叙事（离开/消失/淡出）：${line.slice(0, 60)}`
        })
        break
      }
    }
  }

  // --- 中文只允许出现在 <d> 内 ---
  // 中文工作阶段（阶段①~④）自由描述本来就是中文，跳过；
  // 本地化完成后（lang = en）这条规则就是「是否还有漏译」的门禁。
  if (!zhMode) {
    if (hasCjkOutsideD(dd)) {
      issues.push({
        ruleId: 'lang:cjk-outside-d',
        level: 'error',
        field: 'detailed_description',
        message: '六段主体必须为英文，中文台词只能写在 <d> 标签内'
      })
    }
    for (const key of ['subject_definitions', 'retention_analysis', 'overall_soundscape']) {
      if (hasCjkOutsideD(fields[key])) {
        issues.push({
          ruleId: 'lang:cjk',
          level: 'error',
          field: key,
          message: `${key} 必须为英文`
        })
      }
    }
  }

  // --- 无配乐写 N/A ---
  const music = (fields.non_diegetic_music ?? '').trim()
  if (!music) {
    issues.push({
      ruleId: 'music:empty',
      level: 'warn',
      field: 'non_diegetic_music',
      message: '无配乐时应填 N/A'
    })
  }

  // --- soundscape 不得重复对白 ---
  const sound = fields.overall_soundscape ?? ''
  for (const b of narrativeBeats.filter((x) => x.kind === 'dialogue')) {
    const d = (b.dialogue ?? '').trim()
    if (d && sound.includes(d)) {
      issues.push({
        ruleId: 'sound:repeat-dialogue',
        level: 'warn',
        field: 'overall_soundscape',
        message: 'overall_soundscape 不应重复对白'
      })
      break
    }
  }

  // --- 场景：必填，且与主体分开综合校验 ---
  for (const b of narrativeBeats) {
    if (!sceneIdOf(b)) {
      issues.push({
        ruleId: 'scene:missing',
        level: 'error',
        beatId: b.id,
        message: `片段「${b.title}」未指定场景（场景是必填项，其他主体可选）`
      })
    }
  }

  const sceneIds = collectScenes(narrativeBeats)
  for (const id of sceneIds) {
    const e = ctx.entityById.get(id)
    if (!e) {
      issues.push({
        ruleId: 'scene:unknown',
        level: 'error',
        message: `引用了一个不存在的场景（${id}）`
      })
      continue
    }
    if (!isSceneEntity(e)) {
      issues.push({
        ruleId: 'scene:not-scene',
        level: 'error',
        field: 'subject_definitions',
        message: `「${e.name}」被当作场景使用，但它在注册表里的类型不是场景`
      })
    }
    if (e.subjectN == null || !defSubjectNs.has(e.subjectN)) {
      issues.push({
        ruleId: 'scene:undefined',
        level: 'error',
        field: 'subject_definitions',
        message: `场景 ${subjectTag(e)}（${e.name}）未在 subject_definitions 中定义（场景同样占 Subject 编号）`
      })
    }
  }

  if (sceneIds.length > 1 && !narrativeBeats.some((b) => b.kind === 'scene_switch')) {
    issues.push({
      ruleId: 'scene:multiple',
      level: 'warn',
      message: `本段跨了 ${sceneIds.length} 个场景，但没有换场片段，建议按场景拆段或补一个换场镜头`
    })
  }

  // --- 台词必须指定说话人（其他主体可选，台词除外） ---
  for (const b of narrativeBeats) {
    if (b.kind === 'dialogue' && !b.speakerId) {
      issues.push({
        ruleId: 'beat:no-speaker',
        level: 'error',
        beatId: b.id,
        message: `台词「${(b.dialogue ?? '').slice(0, 20)}」未指定说话人`
      })
    }
  }

  return issues
}

function findDefinitionLine(defs: string, subjectN: number | null): string | null {
  if (subjectN == null) return null
  const re = new RegExp(`^.*<Subject\\s+${subjectN}>.*$`, 'm')
  const m = defs.match(re)
  return m ? m[0] : null
}

/* --------------------------- 全局校验 --------------------------- */

export interface GlobalValidateInput {
  entities: Entity[]
  beats: Beat[]
  segments: Array<{ beats: Beat[]; fields: Record<string, string> }>
}

export function validateGlobal(input: GlobalValidateInput, ctx: ValidateContext): RuleIssue[] {
  const issues: RuleIssue[] = []

  // 编号是否与规则一致
  const expected = computeNumbering(input.entities, input.beats)
  for (const e of input.entities) {
    const a = expected.get(e.id)
    if (!a) continue
    if (e.subjectN !== a.subjectN) {
      issues.push({
        ruleId: 'registry:stale-number',
        level: 'error',
        message: `实体「${e.name}」编号应为 <Subject ${a.subjectN}>，当前为 ${e.subjectN ?? '未分配'}`
      })
    }
    if (e.kind === 'speaking' && e.sx !== a.subjectN) {
      issues.push({
        ruleId: 'registry:sx-mismatch',
        level: 'error',
        message: `实体「${e.name}」的 (Sx) 与 <Subject N> 不对应`
      })
    }
  }

  // 说话角色必须有音色
  for (const e of input.entities) {
    if (e.kind === 'speaking' && !(e.voiceDesc ?? '').trim()) {
      issues.push({
        ruleId: 'registry:voice-missing',
        level: 'error',
        message: `说话角色「${e.name}」缺少音色描述`
      })
    }
  }

  // 跨段音色逐字一致
  const voiceByEntity = new Map<ID, Set<string>>()
  for (const seg of input.segments) {
    const defs = seg.fields.subject_definitions ?? ''
    for (const e of input.entities) {
      if (e.kind !== 'speaking' || e.subjectN == null) continue
      const line = findDefinitionLine(defs, e.subjectN)
      if (!line) continue
      const m = line.match(/speaking with ([\s\S]*?)\(S\d+\)/)
      if (!m) continue
      const set = voiceByEntity.get(e.id) ?? new Set<string>()
      set.add(m[1].trim())
      voiceByEntity.set(e.id, set)
    }
  }
  for (const [id, set] of voiceByEntity) {
    if (set.size > 1) {
      const e = ctx.entityById.get(id)
      issues.push({
        ruleId: 'voice:drift',
        level: 'error',
        message: `角色「${e?.name ?? id}」的音色描述在不同段落不一致（跨段声音漂移）`
      })
    }
  }

  return issues
}

export function issueSummary(issues: RuleIssue[]): { error: number; warn: number; info: number } {
  return {
    error: issues.filter((i) => i.level === 'error').length,
    warn: issues.filter((i) => i.level === 'warn').length,
    info: issues.filter((i) => i.level === 'info').length
  }
}

/* ------------------------------------------------------------------ *
 * 问题归属：哪些能靠改字段文本修，哪些必须回前面的阶段
 * 交给 AI 之前先分好类，避免模型对结构性问题瞎改字段
 * ------------------------------------------------------------------ */

export type FixScope = 'field' | 'structure' | 'registry'

/** 只靠改写字段文本就能修的规则 */
export const FIELD_FIXABLE_RULES = new Set<string>([
  'field:missing',
  // 实体定义 / 音色
  'voice:missing',
  'voice:verbatim-mismatch',
  'voice:sx-missing',
  'voice:unexpected',
  'voice:drift',
  'defs:missing-entity',
  'defs:unused-entity',
  'defs:picture-missing',
  // 台词包装格式（只修标签，不动台词本身）
  'dialogue:format',
  'dialogue:id-inside-d',
  // 镜头写法
  'shot:no-only',
  'shot:wrong-speaker',
  'shot:preshoot-wrong-subject',
  'shot:timecode',
  'shot:reverse-narrative',
  'seam:tail-cut-required',
  'seam:black-required',
  // 语言
  'lang:cjk',
  'lang:cjk-outside-d',
  // 声场 / 配乐
  'music:empty',
  'sound:repeat-dialogue'
])

/** 场景 / 注册表问题：改字段没用，得回注册表或片段页 */
const REGISTRY_SCOPE_RULES = new Set<string>([
  'scene:unknown',
  'scene:undefined',
  'registry:no-number',
  'registry:stale-number',
  'registry:sx-mismatch',
  'registry:voice-missing'
])

export function issueScope(issue: RuleIssue): FixScope {
  if (FIELD_FIXABLE_RULES.has(issue.ruleId)) return 'field'
  if (issue.ruleId.startsWith('registry:')) return 'registry'
  if (REGISTRY_SCOPE_RULES.has(issue.ruleId)) return 'registry'
  return 'structure'
}

export function splitIssuesByScope(issues: RuleIssue[]): {
  field: RuleIssue[]
  structure: RuleIssue[]
  registry: RuleIssue[]
} {
  const out = { field: [], structure: [], registry: [] } as {
    field: RuleIssue[]
    structure: RuleIssue[]
    registry: RuleIssue[]
  }
  for (const i of issues) out[issueScope(i)].push(i)
  return out
}

/** 结构性问题该去哪儿改 */
export const SCOPE_HINT: Record<FixScope, string> = {
  field: '可由 AI 改写字段修',
  structure: '需回到「③ 组合与缝合」或「① 拆解」「② 细节填充」调整片段',
  registry: '需回到「实体与素材」修正注册表'
}
