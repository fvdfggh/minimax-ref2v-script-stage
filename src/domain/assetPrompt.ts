/**
 * 一条素材的提示词：**用户正文** + **参考图引用段**。
 *
 * 为什么要把这两块分开存：
 *   正文是用户写的 / AI 按他的要求写的，会被反复手改；
 *   引用段是从 `refAssetIds` 推出来的（哪几张、几号槽、这个人长什么样），
 *   一改引用关系就整段作废。如果把引用段直接拼进正文存库，换一次参考图
 *   就在正文里叠一段旧话，改三次之后没人分得清哪句还算数。
 *
 * 所以库里只存正文（asset.prompt），引用段在展示 / 出图时现拼 ——
 * composeMaterialPrompt() 因此天然幂等：同一个 asset 调几次都是同一句。
 *
 * ★ 为什么参考方式**必须**写 `<Picture N>`：
 *   导演包的正文要出现 <Picture N>，才算"这一段用了这张图"。素材以参考方式
 *   进了参考槽、正文却没点名，打包会警告"图进了槽但没被引用"，成片里那张图
 *   等于白给。所以参考方式的素材，引用段里一定带编号。
 *
 * ★ 关键帧方式**不写编号**：关键帧走 kfImages（按帧位），本地工作流用的是
 *   image1 / image2 这种位置参数，`<Picture 3>` 在那条通道上指不到任何东西。
 *   同一个人只写"名字 — 外观"，编号留给真正走参考槽的那条路。
 */

import { actAsOf } from './references'
import type { Asset, Entity, ID } from './types'

/** 引用段的固定表头。去掉旧段时就认这一行，所以它不能随便改文案。 */
export const REF_SECTION_TITLE = 'Reference subjects (identity locked):'
const REF_SECTION_MARK = `\n\n${REF_SECTION_TITLE}\n`

export interface RefLookup {
  assetOf: (id: ID) => Asset | undefined
  entityOf: (id: ID) => Entity | undefined
}

/** 一条被引用的参考图，已经摊平成"写进提示词要用的那几个字" */
export interface PromptRef {
  assetId: ID
  /** <Picture N>；0 = 这张素材没有编号（不会进参考槽） */
  pictureN: number
  entityId: ID | null
  name: string
  desc: string
}

function nameOf(entity: Entity | undefined, asset: Asset): string {
  if (!entity) return (asset.label || asset.originalName || 'reference').trim()
  return ((entity.nameEn ?? '').trim() || entity.name || asset.label || 'reference').trim()
}

function descOf(entity: Entity | undefined, asset: Asset): string {
  // 长相与服装都写进引用行：参考图若是"只有脸"的老数据，这一段就是唯一的穿着依据；
  // 参考图是拼接图时，重复的那半句也只是强化，不会把画面带偏。
  const fromEntity = entity
    ? [
        (entity.textDescEn ?? '').trim() || (entity.textDesc ?? '').trim(),
        (entity.costumeDescEn ?? '').trim() || (entity.costumeDesc ?? '').trim()
      ]
        .filter(Boolean)
        .join(', ')
    : ''
  // 素材自己的 desc 是"这张图里画了什么"，比实体描述更贴这张图；两个都有就并起来
  const fromAsset = (asset.desc ?? '').trim()
  if (fromEntity && fromAsset && fromAsset !== fromEntity) return `${fromEntity}; ${fromAsset}`
  return fromEntity || fromAsset
}

/**
 * 按 refAssetIds 摊平成引用行。
 *
 * 去重规则：同一个 asset 只留一次；同一个 `<Picture N>` 槽也只留一次
 * （两个 asset 抢一个槽是数据坏了，写两行会让模型以为有两张不同的图）。
 */
export function promptRefsOf(
  asset: Pick<Asset, 'refAssetIds'>,
  lookup: RefLookup
): PromptRef[] {
  const out: PromptRef[] = []
  const seenAsset = new Set<ID>()
  const seenPic = new Set<number>()
  for (const id of asset.refAssetIds ?? []) {
    if (seenAsset.has(id)) continue
    seenAsset.add(id)
    const ref = lookup.assetOf(id)
    if (!ref) continue
    const pictureN = Number(ref.pictureN) || 0
    if (pictureN > 0 && seenPic.has(pictureN)) continue
    if (pictureN > 0) seenPic.add(pictureN)
    const entity = ref.refId ? lookup.entityOf(ref.refId) : undefined
    out.push({
      assetId: ref.id,
      pictureN,
      entityId: entity?.id ?? null,
      name: nameOf(entity, ref),
      desc: descOf(entity, ref)
    })
  }
  return out
}

/** 引用行：参考方式带 `<Picture N>`，关键帧方式只写名字与外观 */
export function referenceLines(refs: PromptRef[], numbered: boolean): string[] {
  return refs.map((r) => {
    const head = numbered && r.pictureN > 0 ? `<Picture ${r.pictureN}> ${r.name}` : r.name
    return r.desc ? `${head} — ${r.desc}` : head
  })
}

export function referenceSection(refs: PromptRef[], numbered: boolean): string {
  const lines = referenceLines(refs, numbered)
  if (!lines.length) return ''
  return [REF_SECTION_TITLE, ...lines].join('\n')
}

/**
 * 把正文里**上一次拼进去的**引用段剥掉。
 *
 * 只认末尾那一段（我们永远是追加在最后），不碰正文中间出现的同名文字：
 * 用户真在正文里写了 "Reference subjects" 也不该被吃掉半句。
 */
export function stripReferenceSection(text: string): string {
  const t = (text ?? '').replace(/\r\n/g, '\n')
  const at = t.lastIndexOf(REF_SECTION_MARK)
  if (at >= 0) return t.slice(0, at).replace(/\s+$/, '')
  // 整段就是引用段（正文空着）：表头 + 至少一行"像引用行"的内容。
  // 只认严格的「表头 + 换行」，正文里恰好写到这个词（"…: is written on a wall"）
  // 不会被当成引用段吃掉 —— 这里曾经把整句正文吞成空串。
  const head = `${REF_SECTION_TITLE}\n`
  if (t.startsWith(head)) {
    const lines = t.slice(head.length).split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length && lines.every((l) => l.startsWith('<Picture ') || l.includes(' — '))) return ''
  }
  return t
}

/** 素材正文（不含引用段） */
export function promptBodyOf(asset: Pick<Asset, 'prompt'>): string {
  return stripReferenceSection(asset.prompt ?? '').trim()
}

/**
 * 最终发给模型的那句：正文 + 引用段。
 *
 * 顺序固定为"正文在前、引用在后"：正文是这一镜要画什么，引用是"照着谁画"，
 * 放在后面模型才不会把参考人物的描述当成新出场的人。
 */
export function composeMaterialPrompt(
  asset: Pick<Asset, 'prompt' | 'refAssetIds' | 'actAs' | 'kind'>,
  lookup: RefLookup
): string {
  const body = promptBodyOf(asset)
  const refs = promptRefsOf(asset, lookup)
  const numbered = actAsOf(asset) === 'reference'
  const section = referenceSection(refs, numbered)
  return [body, section].filter(Boolean).join('\n\n')
}

/** 有没有"该编号却没编号"的引用（UI 要提醒它不会进参考槽） */
export function unnumberedRefs(refs: PromptRef[]): PromptRef[] {
  return refs.filter((r) => r.pictureN <= 0)
}
