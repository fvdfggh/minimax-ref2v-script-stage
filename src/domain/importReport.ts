/*
 * 导入结果的判定与文案。
 *
 * 为什么要独立成一个纯函数：换设备时最容易踩的坑不是"项目没导进来"，
 * 而是"项目进来了、角色也有描述，但音色包没跟着来，点合成台词才发现"。
 * 这个判断（缺多少包、算不算干净）以前只写在存储弹窗里，现在首页导入
 * 和备份导入共用同一份，避免两边口径不一致。也方便单测。
 */
import type { ImportResult, MissingPack } from '@/core/backend'

/** 包里引用了、但导出时原机器上就没有的音色包 */
export function missingPacksOf(res: ImportResult | null | undefined): MissingPack[] {
  if (!res) return []
  return res.missingPacks ?? res.missing?.voicePacks ?? []
}

/** 干净导入 = 没有缺失、没有同名冲突；此时可以直接刷新页面，不用拦住用户 */
export function importIsClean(res: ImportResult | null | undefined): boolean {
  if (!res) return true
  return !missingPacksOf(res).length && !(res.voicePacks?.conflict?.length ?? 0)
}

/** toast 用的一行摘要：2 个项目 · 5 集 · 8 个素材 · 1 个音色包 */
export function importSummary(res: ImportResult): string {
  const bits = [`${res.projects ?? 1} 个项目`]
  if (res.episodes) bits.push(`${res.episodes} 集`)
  if (res.assets) bits.push(`${res.assets} 个素材`)
  const packs = res.voicePacks?.restored.length ?? 0
  if (packs) bits.push(`${packs} 个音色包`)
  return bits.join(' · ')
}

/** 缺失清单里一项怎么称呼：角色名（哪一集）—— 跨集同名角色也能分清 */
export function packLabel(m: MissingPack): string {
  return m.projectName ? `${m.entity}（${m.projectName}）` : m.entity
}
