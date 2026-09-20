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
 */
export function segmentSourceHash(beats: Beat[], entities: Entity[]): string {
  const byId = new Map(entities.map((e) => [e.id, e]))
  const parts: string[] = []

  for (const b of beats) {
    parts.push(
      [
        b.id,
        b.kind,
        b.title,
        b.dialogue ?? '',
        b.direction ?? '',
        b.visualDesc ?? '',
        b.sceneId ?? '',
        b.speakerId ?? '',
        b.focusEntityId ?? '',
        (b.entities ?? []).join(',')
      ].join('\u0001')
    )
  }

  const used = new Set<ID>()
  for (const b of beats) {
    for (const id of b.entities ?? []) used.add(id)
    if (b.speakerId) used.add(b.speakerId)
    if (b.sceneId) used.add(b.sceneId)
    if (b.focusEntityId) used.add(b.focusEntityId)
  }
  for (const id of [...used].sort()) {
    const e = byId.get(id)
    if (!e) continue
    parts.push(
      [id, e.name, e.type, e.kind, e.voiceDesc ?? '', e.textDesc ?? '', String(e.pictureN ?? '')].join('\u0001')
    )
  }

  return fingerprint(parts.join('\u0002'))
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
