/**
 * 主体登记 · 按原文扫候选
 *
 * 「这一集有谁」这件事，本来就有两个来源：
 *   1. 项目母版 —— 前几集已经定过的角色，跨集复用的唯一真相源；
 *   2. 故事原文 —— 这一集真正写了谁。
 *
 * 登记页要把两个来源并排摆出来：母版里有、原文也提到的，几乎肯定要登记；
 * 母版里有、原文一次没提的，多半是别的集的常驻角色，先别急着取。
 * 所以这里给每个候选算一个「原文提到几次」，页面上按它排序，
 * 人不用通读剧本就知道该挑谁。
 *
 * 不在这里判「是不是人名」——中文 NER 靠猜，猜错比不猜更烦人。
 * 名字从哪来：母版名单 + 拆解时模型登记过的候选（presets）。
 */
import type { Entity, EntityKind, EntityType, ID } from './types'
import { ENTITY_TYPES } from './types'

/** 候选从哪冒出来的：项目母版 / 模型按原文找的 / 只有名字（拆解时对不上号的） */
export type CandidateSource = 'master' | 'model' | 'text'

export interface PendingSubject {
  name: string
  type: EntityType
  kind: EntityKind
  source: CandidateSource
  /** 母版里已有的那份：登记 = 取用（带图带描述）；没有 = 新建 */
  masterId?: ID
  /** 原文里出现几次（0 = 母版里有但这一集没提到） */
  mentions: number
  /** 母版挂了参考图，取用时会把图一起带过来 */
  hasPicture: boolean
  textDesc?: string | null
  voiceDesc?: string | null
  costumeDesc?: string | null
  note?: string | null
}

/** 模型 / 拆解给的候选（只取用得上的字段，避免 domain 依赖 store 类型） */
export interface SubjectPreset {
  name?: string
  type?: EntityType
  kind?: EntityKind
  textDesc?: string | null
  voiceDesc?: string | null
  costumeDesc?: string | null
  note?: string | null
}

/**
 * 数一个名字在原文里出现几次。
 *
 * 用 indexOf 而不是正则：名字里可能有 `.` `(` `*`，直接塞进 RegExp 会变成元字符，
 * 轻则不匹配、重则抛异常 —— 这种地方不值得为「一行代码」埋雷。
 */
export function countMentions(story: string, name: string): number {
  const s = story ?? ''
  const n = (name ?? '').trim()
  if (!s || !n) return 0
  let hits = 0
  let from = 0
  for (;;) {
    const at = s.indexOf(n, from)
    if (at < 0) break
    hits += 1
    from = at + n.length
  }
  return hits
}

function typeRank(t: EntityType): number {
  const i = ENTITY_TYPES.indexOf(t)
  return i < 0 ? 90 : i
}

/**
 * 候选清单：母版未登记 + 模型候选，按「原文提到几次」优先。
 *
 * 排序意图：原文里真出现了的排前面（这一集用得上），一次没提的沉到后面
 * （大概率是别的集的人，现在取进来只会占编号）。
 */
export function pendingSubjects(opts: {
  locals: Pick<Entity, 'name' | 'sourceId'>[]
  masters: Pick<
    Entity,
    'id' | 'name' | 'type' | 'kind' | 'textDesc' | 'voiceDesc' | 'costumeDesc' | 'note' | 'pictureN'
  >[]
  story: string
  presets?: SubjectPreset[]
}): PendingSubject[] {
  const { locals, masters, story, presets = [] } = opts
  const taken = new Set(locals.map((l) => l.sourceId).filter((x): x is ID => !!x))
  const localNames = new Set(locals.map((l) => (l.name ?? '').trim()))

  const out: PendingSubject[] = []
  const seen = new Set<string>()

  for (const m of masters) {
    const name = (m.name ?? '').trim()
    if (!name || taken.has(m.id) || localNames.has(name) || seen.has(name)) continue
    seen.add(name)
    out.push({
      name,
      type: m.type,
      kind: m.kind,
      source: 'master',
      masterId: m.id,
      mentions: countMentions(story, name),
      hasPicture: (m.pictureN ?? 0) > 0,
      textDesc: m.textDesc ?? null,
      voiceDesc: m.voiceDesc ?? null,
      costumeDesc: m.costumeDesc ?? null,
      note: m.note ?? null
    })
  }

  for (const p of presets) {
    const name = (p.name ?? '').trim()
    if (!name || localNames.has(name) || seen.has(name)) continue
    seen.add(name)
    out.push({
      name,
      // 模型给了类型就照它的；只给了名字（拆解里对不上号）按角色起步，页面上可改
      type: p.type ?? 'character',
      kind: p.kind ?? 'non_speaking',
      source: p.type || p.kind || p.textDesc ? 'model' : 'text',
      mentions: countMentions(story, name),
      hasPicture: false,
      textDesc: p.textDesc ?? null,
      voiceDesc: p.voiceDesc ?? null,
      costumeDesc: p.costumeDesc ?? null,
      note: p.note ?? null
    })
  }

  return out.sort(
    (a, b) =>
      Number(b.mentions > 0) - Number(a.mentions > 0) ||
      b.mentions - a.mentions ||
      typeRank(a.type) - typeRank(b.type) ||
      a.name.localeCompare(b.name, 'zh')
  )
}
