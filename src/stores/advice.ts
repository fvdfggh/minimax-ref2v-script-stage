import { defineStore } from 'pinia'
import { useAssemblyStore } from './assembly'
import { useBeatStore } from './beats'
import { useProjectStore } from './project'
import { useRegistryStore } from './registry'
import type {
  AdviceBeatPatch,
  AdviceEntityPatch,
  AdviceFieldPatch,
  AdviceGroupPatch,
  StageAdvice
} from '@/core/llm/advice'
import type { Beat, BeatKind, EntityKind, EntityType, ID } from '@/domain/types'

/* ------------------------------------------------------------------ *
 * 意见补丁的应用与级联
 *
 * 顺序固定，不能换：
 *   实体 → 片段 → 编号重算 → 分组归位 → 分组边界 → 段字段
 *
 * 三个关键点：
 *   1. 片段补丁里的「序号」是按用户看到的那份清单算的，
 *      所以必须先在快照上把所有序号解析成 id，再动手改。边改边解析必然错位。
 *   2. 一旦动了片段或分组，段字段补丁就作废 —— 那些段号是按旧结构算的，
 *      套到新结构上会改错段。此时改为让受影响的段走"重新生成"。
 *   3. 分组归位不管有没有分组补丁都要做，否则上游新增的片段不在任何段里，
 *      会在后面所有阶段里静默消失。
 * ------------------------------------------------------------------ */

const KINDS: BeatKind[] = [
  'dialogue',
  'action',
  'scene_switch',
  'establishing',
  'reaction',
  'insert'
]

const TYPES: EntityType[] = ['character', 'scene', 'prop', 'ui', 'other']

function asKind(v: string | undefined): BeatKind | undefined {
  return v && KINDS.includes(v as BeatKind) ? (v as BeatKind) : undefined
}

function asType(v: string | undefined): EntityType | undefined {
  return v && TYPES.includes(v as EntityType) ? (v as EntityType) : undefined
}

function asEntityKind(v: string | undefined): EntityKind | undefined {
  return v === 'speaking' || v === 'non_speaking' ? v : undefined
}

export interface AdviceApplyReport {
  entities: { inserted: number; updated: number; deleted: number }
  beats: { inserted: number; updated: number; deleted: number }
  groups: { split: number; merged: number; refPrev: number }
  fields: { updated: number }
  /** 重新分配了编号的实体数 */
  renumbered: number
  /** 自动吸收进分组的散落片段 */
  adopted: number
  /** 因片段被删而从分组里清掉的引用 */
  dropped: number
  /** 没法应用、被跳过的补丁说明 */
  skipped: string[]
}

export const useAdviceStore = defineStore('advice', () => {
  const project = useProjectStore()
  const beats = useBeatStore()
  const registry = useRegistryStore()
  const assembly = useAssemblyStore()

  function resolveByName(name?: string | null): ID | undefined {
    if (!name) return undefined
    return registry.entities.find((e) => e.name === name)?.id
  }

  /* --------------------------- 实体 --------------------------- */

  async function applyEntities(patches: AdviceEntityPatch[], skipped: string[]) {
    const out = { inserted: 0, updated: 0, deleted: 0 }
    const pid = project.currentId ?? ''

    for (const p of patches) {
      const existing = registry.entities.find((e) => e.name === p.name)

      if (p.op === 'insert') {
        if (existing) {
          skipped.push(`新增实体「${p.name}」：已存在同名实体`)
          continue
        }
        // nameEn 等本地化词条不在 addEntity 的入参签名里，建完再补一次
        const created = await registry.addEntity(pid, {
          name: p.name,
          type: asType(p.type) ?? 'character',
          kind: asEntityKind(p.kind) ?? 'non_speaking',
          voiceDesc: p.voiceDesc ?? null,
          textDesc: p.textDesc ?? null
        })
        if (p.nameEn || p.voiceDescEn || p.textDescEn) {
          await registry.updateEntity(created.id, {
            nameEn: p.nameEn ?? null,
            voiceDescEn: p.voiceDescEn ?? null,
            textDescEn: p.textDescEn ?? null
          })
        }
        out.inserted++
        continue
      }

      if (!existing) {
        skipped.push(`${p.op === 'delete' ? '删除' : '修改'}实体「${p.name}」：注册表里找不到`)
        continue
      }

      if (p.op === 'delete') {
        await registry.removeEntity(existing.id)
        out.deleted++
        continue
      }

      await registry.updateEntity(existing.id, {
        ...(asType(p.type) ? { type: asType(p.type) } : {}),
        ...(asEntityKind(p.kind) ? { kind: asEntityKind(p.kind) } : {}),
        ...(p.voiceDesc !== undefined ? { voiceDesc: p.voiceDesc } : {}),
        ...(p.textDesc !== undefined ? { textDesc: p.textDesc } : {}),
        ...(p.nameEn !== undefined ? { nameEn: p.nameEn } : {}),
        ...(p.voiceDescEn !== undefined ? { voiceDescEn: p.voiceDescEn } : {}),
        ...(p.textDescEn !== undefined ? { textDescEn: p.textDescEn } : {})
      })
      out.updated++
    }

    return out
  }

  /* --------------------------- 片段 --------------------------- */

  /**
   * 实体名 → 绑定关系。
   *
   * ★ 补丁是「部分」的：只给 speaker 时，必须把说话人并进**现有**主体列表，
   *   而不是拿空数组重算 —— 否则一句"把说话人改成毒尊"会把这个镜头的
   *   其他主体全部冲掉。
   *
   * 另外注意 normalizeBeat 的约束：说话人必须在 entities 里，场景不能混在 entities 里。
   */
  function bindingsOf(p: AdviceBeatPatch, cur?: Beat) {
    const sceneId = resolveByName(p.scene)
    const speakerId = resolveByName(p.speaker)
    const focusId = resolveByName(p.focus)

    const base =
      p.entities !== undefined
        ? p.entities.map(resolveByName).filter((x): x is ID => !!x)
        : [...(cur?.entities ?? [])]

    // 场景既可能来自本次补丁，也可能是这个片段原本就绑着的
    const effectiveScene = p.scene !== undefined ? sceneId : cur?.sceneId

    const merged = [...new Set([...base, ...(speakerId ? [speakerId] : [])])].filter(
      (x) => x !== effectiveScene
    )
    return { sceneId, speakerId, focusId, entities: merged }
  }

  async function applyBeats(patches: AdviceBeatPatch[], skipped: string[]) {
    const out = { inserted: 0, updated: 0, deleted: 0 }
    if (!patches.length) return out

    // ★ 序号必须在快照上一次性解析完；边改边解析会错位
    const snapshot = [...beats.ordered]
    const idAt = (n: number | undefined) => {
      if (!n || n < 1 || n > snapshot.length) return undefined
      return snapshot[n - 1].id
    }

    const pid = project.currentId ?? ''

    /* --- 删除 --- */
    const toDelete: ID[] = []
    for (const p of patches.filter((x) => x.op === 'delete')) {
      const id = idAt(p.index)
      if (!id) {
        skipped.push(`删除片段 #${p.index}：序号超出范围`)
        continue
      }
      toDelete.push(id)
    }
    if (toDelete.length) {
      await beats.removeBeats(toDelete)
      out.deleted = toDelete.length
    }

    /* --- 修改 --- */
    for (const p of patches.filter((x) => x.op === 'update')) {
      const id = idAt(p.index)
      if (!id) {
        skipped.push(`修改片段 #${p.index}：序号超出范围`)
        continue
      }
      const cur = beats.beatById.get(id)
      const bind = bindingsOf(p, cur)

      // ★ 只写「本次补丁真正提到的字段」。
      //   undefined = 不改；null = 清空；有值 = 改成这个值。
      //   没提到的字段原样保留 —— 这是部分补丁能成立的前提。
      const patch: Partial<Beat> = {}
      if (p.title !== undefined) patch.title = p.title === null ? '' : p.title
      if (asKind(p.kind)) patch.kind = asKind(p.kind)
      if (p.dialogue !== undefined) patch.dialogue = p.dialogue === null ? undefined : p.dialogue.trim() || undefined
      if (p.direction !== undefined) patch.direction = p.direction === null ? undefined : p.direction || undefined
      if (p.visualDesc !== undefined) patch.visualDesc = p.visualDesc === null ? undefined : p.visualDesc || undefined
      if (p.titleEn !== undefined) patch.titleEn = p.titleEn === null ? undefined : p.titleEn || undefined
      if (p.directionEn !== undefined) patch.directionEn = p.directionEn === null ? undefined : p.directionEn || undefined
      if (p.visualDescEn !== undefined) patch.visualDescEn = p.visualDescEn === null ? undefined : p.visualDescEn || undefined
      if (p.scene !== undefined) patch.sceneId = p.scene === null ? undefined : bind.sceneId
      if (p.entities !== undefined || p.speaker !== undefined) {
        patch.entities = bind.entities
        // speakerId 交给 normalizeBeat 兜底：非台词片段会自动清掉
        if (p.speaker !== undefined) patch.speakerId = bind.speakerId
      }
      if (p.focus !== undefined) patch.focusEntityId = bind.focusId
      await beats.updateBeat(id, patch)
      out.updated++
    }

    /* --- 新增 --- */
    for (const p of patches.filter((x) => x.op === 'insert')) {
      const kind = asKind(p.kind) ?? 'action'
      const after = p.afterIndex ?? 0
      const anchor = after > 0 ? idAt(after) : undefined
      // afterIndex === 0 表示插到最前面；给了序号但找不到就退化成追加到末尾
      const at = after <= 0 ? 0 : anchor ? beats.ordered.findIndex((b) => b.id === anchor) + 1 : beats.ordered.length

      const before = new Set(beats.beats.map((b) => b.id))
      const list = await beats.addBeat(
        pid,
        {
          title: p.title ?? '未命名片段',
          kind,
          dialogue: kind === 'dialogue' ? (p.dialogue ?? '').trim() : undefined,
          direction: p.direction || undefined,
          visualDesc: p.visualDesc || undefined,
          entities: []
        },
        at
      )
      const created = list.find((b) => !before.has(b.id))
      if (!created) {
        skipped.push(`新增片段「${p.title}」：写入失败`)
        continue
      }
      const bind = bindingsOf(p)
      await beats.updateBeat(created.id, {
        sceneId: bind.sceneId,
        speakerId: bind.speakerId,
        focusEntityId: bind.focusId,
        entities: bind.entities
      })
      out.inserted++
    }

    return out
  }

  /* --------------------------- 分组 --------------------------- */

  async function applyGroups(patches: AdviceGroupPatch[], skipped: string[]) {
    const out = { split: 0, merged: 0, refPrev: 0 }
    const asm = assembly.current
    if (!asm || !patches.length) return out

    // 段号是按应用前的结构算的，一旦合并就整体失效
    const segmentIds = asm.groups.map((g) => g.id)
    let mergedHappened = false

    for (const p of patches) {
      if (p.op === 'split') {
        const idx = (p.atBeatIndex ?? 0) - 1
        const beatId = beats.ordered[idx]?.id
        if (!beatId) {
          skipped.push(`切开分段：片段序号 ${p.atBeatIndex} 超出范围`)
          continue
        }
        const group = assembly.current?.groups.find((g) => g.beatIds.includes(beatId))
        if (!group) {
          skipped.push(`切开分段：片段 #${p.atBeatIndex} 不在任何段里`)
          continue
        }
        const within = group.beatIds.indexOf(beatId)
        if (within <= 0) {
          skipped.push(`切开分段：片段 #${p.atBeatIndex} 已经是所在段的第一个片段，切不出新段`)
          continue
        }
        await assembly.splitGroupAt(asm.id, group.id, within, beats.ordered)
        mergedHappened = true // 段号同样变了
        out.split++
        continue
      }

      if (p.op === 'merge') {
        const from = p.fromSegment ?? 0
        const to = p.toSegment ?? 0
        if (from < 1 || to > segmentIds.length || to <= from) {
          skipped.push(`合并分段：段号 ${from}~${to} 超出范围`)
          continue
        }
        const ids = segmentIds.slice(from - 1, to)
        const res = await assembly.mergeGroups(asm.id, ids, beats.ordered, project.settings)
        if (!res.ok) {
          skipped.push(`合并分段：段号 ${from}~${to} 合并失败`)
          continue
        }
        mergedHappened = true
        out.merged++
        continue
      }

      if (p.op === 'refPrev') {
        if (mergedHappened) {
          skipped.push(`切换引用上段：段号 ${p.segment} 已因前面的切分/合并失效，已跳过`)
          continue
        }
        const gid = segmentIds[(p.segment ?? 0) - 1]
        if (!gid) {
          skipped.push(`切换引用上段：段号 ${p.segment} 超出范围`)
          continue
        }
        await assembly.setGroupRefPrev(asm.id, gid, !!p.refPrev)
        out.refPrev++
      }
    }

    return out
  }

  /* --------------------------- 段字段 --------------------------- */

  async function applyFields(patches: AdviceFieldPatch[], groupIds: ID[], skipped: string[]) {
    const out = { updated: 0 }
    const pid = project.currentId
    if (!pid || !patches.length) return out

    for (const p of patches) {
      const gid = groupIds[p.segment - 1]
      if (!gid) {
        skipped.push(`修改段字段：段号 ${p.segment} 超出范围`)
        continue
      }
      if (p.key === 'summary') await assembly.setSummary(pid, gid, p.value)
      else await assembly.setField(pid, gid, p.key, p.value)
      out.updated++
    }
    return out
  }

  /* --------------------------- 总入口 --------------------------- */

  async function apply(advice: StageAdvice, groupIds: ID[]): Promise<AdviceApplyReport> {
    const skipped: string[] = []
    const pid = project.currentId

    const entities = await applyEntities(advice.entities ?? [], skipped)
    const beatReport = await applyBeats(advice.beats ?? [], skipped)

    // 片段或实体一变，编号就可能不对。renumber 是幂等的，没有变化会返回 0
    const renumbered = await registry.renumber(beats.ordered)

    // ★ 分组归位：不管有没有分组补丁都要做
    let adopted = 0
    let dropped = 0
    const asm = assembly.current
    if (asm && pid) {
      const res = await assembly.reconcile(asm.id, beats.ordered)
      adopted = res.adopted
      dropped = res.dropped
    }

    const groups = await applyGroups(advice.groups ?? [], skipped)

    const structureChanged =
      beatReport.inserted > 0 ||
      beatReport.deleted > 0 ||
      groups.split > 0 ||
      groups.merged > 0

    if (structureChanged && (advice.fields ?? []).length) {
      skipped.push('片段或分组变了，本次的段字段补丁已跳过（段号按旧结构算的，套用会改错段）')
    }
    const fields = structureChanged
      ? { updated: 0 }
      : await applyFields(advice.fields ?? [], groupIds, skipped)

    return { entities, beats: beatReport, groups, fields, renumbered, adopted, dropped, skipped }
  }

  return { apply }
})
