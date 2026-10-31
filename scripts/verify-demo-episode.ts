/**
 * 冒烟校验：用真实 store 打开刚播种的剧集，确认前端会看到的样子。
 *   npx vite-node scripts/verify-demo-episode.ts
 */

import { createPinia, setActivePinia } from 'pinia'
import { setBackendBase, setBackendProject } from '@/core/backend'
import { useProjectStore } from '@/stores/project'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { useAssemblyStore } from '@/stores/assembly'
import { buildDirectorPack } from '@/domain/pack'
import { composeSegmentText } from '@/domain/derive'

const PID = 'epi_demo_nightshift'

async function main(): Promise<void> {
  setBackendBase(process.env.STAGE_BACKEND || 'http://127.0.0.1:8787')
  setBackendProject(PID)
  setActivePinia(createPinia())

  const project = useProjectStore()
  const beats = useBeatStore()
  const registry = useRegistryStore()
  const assembly = useAssemblyStore()

  await project.loadAll()
  await project.select(PID)
  await Promise.all([beats.load(PID), registry.load(PID), assembly.load(PID)])

  const current = project.current
  console.log('项目：', current?.name, '| stage =', current?.stage)
  console.log('故事字符数：', project.current?.story.length ?? 0)
  console.log('片段：', beats.ordered.length, '| 实体：', registry.entities.length, '| 方案：', assembly.assemblies.length)

  const asm = assembly.current
  if (!asm) throw new Error('没有组合方案')

  const views = assembly.buildSegmentViews(
    asm,
    beats.ordered,
    project.settings,
    registry.entityById,
    project.fieldSchema
  )

  console.log('\n段视图：')
  for (const [i, v] of views.entries()) {
    const errors = v.issues.filter((x) => x.level === 'error')
    const warns = v.issues.filter((x) => x.level === 'warn')
    console.log(
      `  段${i + 1}  ${v.frames} 帧  ${v.beats.length} 拍  stale=${v.stale}  错误=${errors.length} 警告=${warns.length}  字段=${Object.keys(v.fields).length}`
    )
    for (const e of [...errors, ...warns]) console.log(`       [${e.level}] ${e.message}`)
  }

  const hydrated = await registry.hydrateAssetBlobs()
  const pack = buildDirectorPack({
    projectName: current?.name ?? '',
    settings: project.settings,
    segments: views.map((v) => ({
      id: v.group.id,
      frames: v.frames,
      prompt: composeSegmentText(project.fieldSchema, v.fields),
      refPrev: v.refPrev,
      continuityFromPrev: v.seam?.continuityFromPrev ?? false,
      continuityToNext: v.nextSeam?.continuityToNext ?? false,
      entities: [...v.narrativeBeats.flatMap((b) => b.entities), ...v.narrativeBeats.map((b) => b.sceneId)]
        .filter((x): x is string => !!x)
        .map((id) => registry.entityById.get(id))
        .filter((e): e is NonNullable<typeof e> => !!e)
    })),
    assets: registry.assets,
    width: project.settings.outputWidth,
    height: project.settings.outputHeight
  })

  const images = pack.entries.filter((e) => e.path.startsWith('shared_params/Picture'))
  const segs = (pack.timeline as { segments: Array<{ refs: unknown[]; prompt: string }> }).segments
  console.log('\n导演包：')
  console.log('  补回参考图：', hydrated, '张')
  console.log('  包内图片：', images.map((e) => e.path).join(', ') || '(无)')
  console.log('  段数：', segs.length, '| 每段 refs：', segs.map((s) => s.refs.length).join('/'))
  console.log('  警告：', pack.warnings.length ? pack.warnings : '无')
  console.log('  提示词长度：', segs.map((s) => s.prompt.length).join(' / '))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
