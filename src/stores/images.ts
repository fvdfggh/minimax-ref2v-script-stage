import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useProviderStore } from './provider'
import { useRegistryStore } from './registry'
import { useProjectStore } from './project'
import { useBeatStore } from './beats'
import { generateImage, editImage } from '@/core/llm/image'
import type { Entity, ID, Provider } from '@/domain/types'

/* ------------------------------------------------------------------ *
 * 图片生成编排：
 *   subjectPrompt / scenePrompt  —— 由实体 / 片段构造英文生图提示词
 *   generate                     —— 纯调用，返回 Blob（不持久化）
 *   attachSubjectImage           —— 存为主体参考图（PictureN）并回写 entity
 *   attachSceneImage             —— 存为片段场景图（pictureN=0，不进 reference 槽）
 * ------------------------------------------------------------------ */

export const useImageStore = defineStore('images', () => {
  const provider = useProviderStore()
  const registry = useRegistryStore()
  const project = useProjectStore()
  const beats = useBeatStore()

  const busy = ref(false)
  const lastError = ref<string | null>(null)

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

  /** 主体参考图：角色给"全身 + 中性背景"，场景实体给"空镜环境" */
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
    return [
      'Cinematic character reference, full body, front facing, neutral studio background',
      `Subject: ${name}`,
      desc || 'Highly detailed, realistic appearance.',
      'Film quality, consistent design.'
    ].join('. ')
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

  /** 纯生成 / 编辑，返回 Blob（不落库）。baseImage 传入则走图生图 */
  async function generate(opts: {
    prompt: string
    size?: string
    baseImage?: Blob | string
    model?: string
  }): Promise<Blob> {
    const p = resolved()
    if (!p) throw new Error(lastError.value || '未配置模型供应商')
    busy.value = true
    lastError.value = null
    try {
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

  /** 存为主体参考图：占 PictureN 并回写 entity.pictureN（替换旧图） */
  async function attachSubjectImage(entityId: ID, blob: Blob): Promise<void> {
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

  return {
    busy,
    lastError,
    subjectPrompt,
    scenePrompt,
    generate,
    attachSubjectImage,
    attachSceneImage
  }
})
