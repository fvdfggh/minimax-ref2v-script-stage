import { uid } from '@/core/id'
import type { Beat, Entity, Group, ID } from './types'

/* ------------------------------------------------------------------ *
 * 级联（cascade）
 *
 * 前面阶段一改，后面阶段必须跟着变。这里解决两件靠"自动派生"解决不了的事：
 *
 * 1. 分组归位：片段增删之后，分组要重新对齐。
 *    否则新片段不在任何分组里，会在后面所有阶段里静默消失。
 * 2. 内容指纹：段字段（summary / overall_soundscape / non_diegetic_music）
 *    是模型基于「当时的片段序列 + 实体词条」生成的，不是派生字段，
 *    引擎没法自动重算。生成时记下指纹，之后每次渲染都重算比对，
 *    不一致就是「上游改过、这段该重生成了」。
 * ------------------------------------------------------------------ */

function hash32(str: string, seed: number, prime: number): number {
  let h = seed >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, prime) >>> 0
  }
  return h >>> 0
}

/** 双散列拼接，32 位碰撞概率对"启发式过期判定"来说已经足够 */
export function fingerprint(text: string): string {
  const a = hash32(text, 2166136261, 16777619)
  const b = hash32(text, 5381, 33)
  return `${a.toString(36)}${b.toString(36)}`
}

/**
 * 段内容指纹：把「模型实际看到的那部分输入」压成一个短串。
 * 片段自身的字段 + 本段用到的实体词条（名字/音色/外观/参考图）都要计入，
 * 任何一项变了，段字段就不再可信。
 *
 * 注意：英文词条（titleEn / directionEn / visualDescEn / nameEn / voiceDescEn /
 * textDescEn）同样要计入 —— 英文终稿模式下派生字段是用英文词条渲染的，
 * 改了英文词条而指纹不跟着变，段字段就会悄悄停留在旧词条上。
 */
/** 一个片段参与指纹的那一行。字段顺序固定 —— 改动会让所有旧指纹失效。 */
function beatLine(b: Beat): string {
  return [
    b.id,
    b.kind,
    b.title,
    b.titleEn ?? '',
    b.dialogue ?? '',
    b.direction ?? '',
    b.directionEn ?? '',
    b.visualDesc ?? '',
    b.visualDescEn ?? '',
    b.sceneId ?? '',
    b.speakerId ?? '',
    b.focusEntityId ?? '',
    (b.entities ?? []).join(',')
  ].join('\u0001')
}

/* ------------------------------------------------------------------ *
 * 指纹口径的版本
 *
 * 参与指纹的字段一旦增减，同一份内容的指纹就会变 —— 所有历史生成记录会在
 * 一瞬间被判成「上游改过」，而内容其实一个字都没动。这个坑已经踩过一次：
 * 实体行临时加进 costumeDesc，一集 7 段全部变红，用户以为稿子被谁改了。
 *
 * 规矩：
 *   1. 口径任何变化都要升 FINGERPRINT_VERSION，并把旧口径留在 HASH_SPECS 里；
 *   2. 比对时新旧口径都算一遍，任一命中就算没过期（legacySegmentSourceHashes）。
 *
 * v2 = 片段全部字段 + 实体（不含服装）        ← 现行
 * v3 = 实体加入服装（已废弃）
 *      这三个模型字段写的是「发生了什么 / 听见什么」，跟穿什么无关；
 *      服装只影响派生的画面描述，那一条本来就每次都重算，不需要过期检测。
 *      把服装塞进指纹，只会换来升级期的假过期。
 * ------------------------------------------------------------------ */
export const FINGERPRINT_VERSION = 2

interface HashSpec {
  /** 实体行是否计入服装（上一版留档，别删） */
  costume: boolean
}

const HASH_SPECS: Record<number, HashSpec> = {
  2: { costume: false },
  3: { costume: true }
}

/** 一个实体参与指纹的那一行。同上，顺序固定。 */
function entityLine(e: Entity, spec: HashSpec): string {
  const head = [
    e.id,
    e.name,
    e.nameEn ?? '',
    e.type,
    e.kind,
    e.voiceDesc ?? '',
    e.voiceDescEn ?? '',
    e.textDesc ?? '',
    e.textDescEn ?? ''
  ]
  // 服装按口径追加：字段顺序即口径，改动必须升版本
  if (spec.costume) head.push(e.costumeDesc ?? '', e.costumeDescEn ?? '')
  head.push(String(e.pictureN ?? ''))
  return head.join('\u0001')
}

/**
 * 这一段用到了哪些实体（按 id 排序）。
 *
 * 排序是为了指纹稳定：实体的遍历顺序一变，指纹就变，所有段会被误判成过期。
 */
export function sourceEntitiesOf(beats: Beat[], entities: Entity[]): Entity[] {
  const byId = new Map(entities.map((e) => [e.id, e]))
  const used = new Set<ID>()
  for (const b of beats) {
    for (const id of b.entities ?? []) used.add(id)
    if (b.speakerId) used.add(b.speakerId)
    if (b.sceneId) used.add(b.sceneId)
    if (b.focusEntityId) used.add(b.focusEntityId)
  }
  const out: Entity[] = []
  for (const id of [...used].sort()) {
    const e = byId.get(id)
    if (e) out.push(e)
  }
  return out
}

/**
 * 把「模型实际看到的那部分输入」按某个口径压成短串。
 *
 * `version` 只在做跨版本比对时显式传旧值，正常调用一律用现行口径。
 */
export function segmentSourceHash(
  beats: Beat[],
  entities: Entity[],
  version: number = FINGERPRINT_VERSION
): string {
  return hashLines(hashLinesOf(beats, entities, HASH_SPECS[version] ?? HASH_SPECS[FINGERPRINT_VERSION]))
}

function hashLines(parts: string[]): string {
  return fingerprint('v2\u0002' + parts.join('\u0002'))
}

function hashLinesOf(beats: Beat[], entities: Entity[], spec: HashSpec): string[] {
  return [
    ...beats.map(beatLine),
    ...sourceEntitiesOf(beats, entities).map((e) => entityLine(e, spec))
  ]
}

/**
 * 用**除现行口径以外**的所有历史口径各算一遍。
 *
 * 生成记录是哪个口径写下的，只有它的指纹能对上。放行历史口径是为了
 * 让「口径升级」不表现为「所有段一起过期」—— 内容没变就不该报警。
 */
export function legacySegmentSourceHashes(beats: Beat[], entities: Entity[]): string[] {
  return Object.keys(HASH_SPECS)
    .map(Number)
    .filter((v) => v !== FINGERPRINT_VERSION)
    .map((v) => segmentSourceHash(beats, entities, v))
}

/**
 * 分段指纹：总指纹 + 逐片段 / 逐实体指纹。
 *
 * 为什么要拆开：只存一个总指纹，过期时只能说「这段的输入变了」——
 * 用户看到这句话根本不知道去改哪儿。拆成逐项之后，比对一次就能说出
 * 「第 3 拍的画面描述改了」「陈默的服装改了」，界面才能直接指出来。
 *
 * `hash` 必须与 `segmentSourceHash` 逐字节一致（同一套行、同一个拼接顺序），
 * 否则老记录会全部被判成过期。
 */
export interface SegmentSourceFingerprint {
  hash: string
  beats: Record<ID, string>
  entities: Record<ID, string>
}

export function segmentSourceParts(beats: Beat[], entities: Entity[]): SegmentSourceFingerprint {
  const spec = HASH_SPECS[FINGERPRINT_VERSION]
  const beatLines = beats.map(beatLine)
  const usedEntities = sourceEntitiesOf(beats, entities)
  const entityLines = usedEntities.map((e) => entityLine(e, spec))

  const beatPrints: Record<ID, string> = {}
  beats.forEach((b, i) => (beatPrints[b.id] = fingerprint(beatLines[i])))
  const entityPrints: Record<ID, string> = {}
  usedEntities.forEach((e, i) => (entityPrints[e.id] = fingerprint(entityLines[i])))

  return {
    hash: hashLines([...beatLines, ...entityLines]),
    beats: beatPrints,
    entities: entityPrints
  }
}

/** 过期原因：哪几拍、哪几个主体跟生成时不一样了 */
export interface SourceDiff {
  /** 内容变过的片段（含新增） */
  beats: ID[]
  /** 内容变过的实体（含这一段新引用的） */
  entities: ID[]
  /** 生成时还在、现在没了 */
  removed: ID[]
  /**
   * 老记录里没有逐项指纹（只有总指纹），只能判断"变了"、说不出"哪里变了"。
   * 界面要据此换一句更保守的话，不能瞎指。
   */
  unknown: boolean
}

/**
 * 比对「生成时的内容」与「现在的内容」。
 *
 * meta 为空的细分指纹时退回 unknown：老记录是这次改动之前存下的，
 * 硬猜一个原因比不说更糟。
 */
export function staleDiffOf(
  meta: { beatHashes?: Record<ID, string>; entityHashes?: Record<ID, string>; beatIds: ID[] } | null | undefined,
  beats: Beat[],
  entities: Entity[]
): SourceDiff {
  const now = segmentSourceParts(beats, entities)
  const curIds = new Set(beats.map((b) => b.id))
  // 少掉几拍这件事，老记录（只有 beatIds）也能说 —— 所以放在细分指纹判断之前
  const removed = (meta?.beatIds ?? []).filter((id) => !curIds.has(id))

  const prevBeats = meta?.beatHashes
  const prevEntities = meta?.entityHashes
  if (!prevBeats || !prevEntities) {
    return { beats: [], entities: [], removed, unknown: true }
  }

  const changedBeats: ID[] = []
  for (const b of beats) if (prevBeats[b.id] !== now.beats[b.id]) changedBeats.push(b.id)

  const changedEntities: ID[] = []
  const entityIds = new Set([...Object.keys(prevEntities), ...Object.keys(now.entities)])
  for (const id of entityIds) if (prevEntities[id] !== now.entities[id]) changedEntities.push(id)

  return { beats: changedBeats, entities: changedEntities, removed, unknown: false }
}

/* --------------------------- 分组归位 --------------------------- */

export interface ReconcileResult {
  groups: Group[]
  /** 新纳入分组的片段数 */
  adopted: number
  /** 因片段被删而从分组里清掉的引用数 */
  dropped: number
  /** 被并入其他段之后丢弃的空段数 */
  removedGroups: number
  changed: boolean
}

/**
 * 把分组重新对齐到当前片段序列：
 *   - 已被删除的片段，从所属分组里移除
 *   - 不在任何分组里的片段（上游新增的），按 order 插到
 *     「它前一个片段所在的段」里紧随其后；前面没有片段就放到后面最近的段的开头
 *   - 过滤掉空段
 * 结果是任何位置新增的片段都会被自动吸收，不会静默丢内容。
 */
export function reconcileGroups(groups: Group[], beats: Beat[]): ReconcileResult {
  const ordered = [...beats].sort((a, b) => a.order - b.order)
  const liveIds = new Set(ordered.map((b) => b.id))
  const orderOf = new Map(ordered.map((b, i) => [b.id, i]))

  let dropped = 0
  const kept: Group[] = []
  for (const g of groups) {
    const ids = g.beatIds.filter((id) => liveIds.has(id))
    dropped += g.beatIds.length - ids.length
    if (ids.length) kept.push({ ...g, beatIds: ids })
  }

  const removedGroups = groups.length - kept.length
  const assigned = new Set(kept.flatMap((g) => g.beatIds))
  const orphans = ordered.filter((b) => !assigned.has(b.id))

  if (!orphans.length) {
    return {
      groups: kept,
      adopted: 0,
      dropped,
      removedGroups,
      changed: dropped > 0 || removedGroups > 0
    }
  }

  let out = kept.map((g) => ({ ...g, beatIds: [...g.beatIds] }))
  const groupIndexOf = (beatId: ID) => out.findIndex((g) => g.beatIds.includes(beatId))

  for (const b of orphans) {
    const at = orderOf.get(b.id) ?? 0

    // 找它前面最近的、已经入组的片段
    let prevGroup = -1
    let prevId: ID | null = null
    for (let i = at - 1; i >= 0; i--) {
      const k = groupIndexOf(ordered[i].id)
      if (k >= 0) {
        prevGroup = k
        prevId = ordered[i].id
        break
      }
    }

    if (prevGroup >= 0) {
      const g = out[prevGroup]
      const pos = prevId ? g.beatIds.indexOf(prevId) : -1
      g.beatIds.splice(pos >= 0 ? pos + 1 : g.beatIds.length, 0, b.id)
      continue
    }

    // 前面没有已入组片段：挂到后面最近的段开头；一段都没有就自己开一段
    let nextGroup = -1
    for (let i = at + 1; i < ordered.length; i++) {
      const k = groupIndexOf(ordered[i].id)
      if (k >= 0) {
        nextGroup = k
        break
      }
    }
    if (nextGroup >= 0) {
      out[nextGroup].beatIds.unshift(b.id)
    } else if (out.length) {
      out[0].beatIds.unshift(b.id)
    } else {
      out = [{ id: uid('grp'), beatIds: [b.id] }]
    }
  }

  return {
    groups: out,
    adopted: orphans.length,
    dropped,
    removedGroups,
    changed: true
  }
}
