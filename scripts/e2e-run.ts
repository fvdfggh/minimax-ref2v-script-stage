/**
 * 端到端跑一次：剧本台 → 导演包 → ComfyUI 出片。
 *
 * 和 comfy_smoke.py 的区别：那份是直接把导出的 API 图丢给 ComfyUI，验证
 * "ComfyUI 能不能跑"；这一份走剧本台自己的领域逻辑 —— 从剧集数据编出导演包、
 * 上传参考图、套模板参数、套运行配置，再提交。产物才算"剧本台生成的一个"。
 *
 * 用法：npx vite-node scripts/e2e-run.ts
 */
import { readFileSync } from 'node:fs'
import { createPinia, setActivePinia } from 'pinia'
import { useProjectStore } from '@/stores/project'
import { useBeatStore } from '@/stores/beats'
import { useRegistryStore } from '@/stores/registry'
import { useAssemblyStore } from '@/stores/assembly'
import { useWorkflowStore } from '@/stores/workflow'
import { useRunStore } from '@/stores/run'
import { setStorageProject } from '@/db'
import { composeSegmentText } from '@/domain/derive'
import { collectEntities } from '@/domain/beats'
import { buildDirectorPackZip } from '@/domain/pack'
import type { PackBuildInput, PackSegmentInput } from '@/domain/pack'
import type { Entity } from '@/domain/types'

const API_PATH = 'scripts/_exported_api_fixed.json'
const COMFY = 'http://127.0.0.1:8188'
/**
 * 选卡：任意张数、任意组合，默认把本机 4 张全用上。
 *
 * 前提只有一个 —— ComfyUI 启动时必须看得见这些卡（``--cuda-device``）。
 * 节点侧用 ``itertools.combinations`` 枚举可见卡的全部子集，所以 ``0,1,2,3``
 * 这种四卡组合本身是合法的；剧本台只做「所选 ⊆ 可见」的校验。
 * 想只用两张就 ``E2E_CARDS=0,1``，想单卡就 ``E2E_CARDS=0``。
 */
const CARDS = process.env.E2E_CARDS ?? '0,1,2,3'

setActivePinia(createPinia())

const project = useProjectStore()
const beats = useBeatStore()
const registry = useRegistryStore()
const assembly = useAssemblyStore()
const workflow = useWorkflowStore()
const run = useRunStore()

function log(...a: unknown[]) {
  console.log(...a)
}

async function main() {
  await project.loadAll()
  // 系列没有 episodeIds 字段，集是用 seriesId 反指的；优先选播种的那集
  let episodeId: string | undefined
  const preferred = project.projects.find((p) => p.id === 'epi_demo_nightshift')
  if (preferred) {
    episodeId = preferred.id
  } else {
    const series = project.projects.find((p) => p.kind === 'series')
    const child = series
      ? project.projects.find((p) => (p.kind ?? 'episode') === 'episode' && p.seriesId === series.id)
      : undefined
    episodeId = child?.id ?? project.projects.find((p) => (p.kind ?? 'episode') === 'episode')?.id
  }
  if (!episodeId) throw new Error('没有可用的集')
  const series = project.projects.find((p) => p.id === project.projects.find((q) => q.id === episodeId)!.seriesId)
  log(`系列：${series?.name ?? '(无)'} · 集：${episodeId}`)

  await project.select(episodeId)
  setStorageProject(episodeId)
  await Promise.all([registry.load(episodeId), beats.load(episodeId), assembly.load(episodeId)])
  await registry.hydrateAssetBlobs()
  const epName = project.current?.name ?? episodeId
  log(`已载入：拍 ${beats.ordered.length} · 主体 ${registry.entities.length} · 素材 ${registry.assets.length}`)

  // --- 模板：用导出并修好的那份 API 图 ---
  await workflow.load()
  const apiText = readFileSync(API_PATH, 'utf-8')
  const tpl = workflow.create('H3 一采（自动导入）')
  const imported = workflow.importApi(tpl.id, apiText)
  const tpl2 = workflow.templates.find((t) => t.id === tpl.id)!
  log(`模板：导入 ${imported.nodes} 节点 / ${imported.params} 参数`)

  // --- 运行配置 ---
  await run.load()
  const cfg = run.create('e2e 双卡')
  run.patch(cfg.id, {
    baseUrl: COMFY,
    cards: CARDS,
    width: 864,
    height: 480,
    steps: 3, // 工作流用的是 4-step LoRA + ManualSigmas，步数跟着它
    cfg: 1,
    frameRate: 24,
    secondEnabled: false, // 一采先跑通
    randomSeed: true,
    // 上一轮跑到一半崩了，ep1 下留着半截段缓存；旧缓存交接会把导演节点
    // 带进"对齐裁剪"那条分支。用剧本台自己的清缓存开关，不手删文件。
    clearCacheOnSubmit: true
  })
  const cfgUsed = run.configs.find((c) => c.id === cfg.id)!
  log(`配置：${cfgUsed.name} · 卡 ${cfgUsed.cards} · ${cfgUsed.width}x${cfgUsed.height} · ${cfgUsed.steps} 步`)

  // --- 编导演包 ---
  const settings = project.settings
  const schema = project.fieldSchema
  const cur = assembly.current
  if (!cur) throw new Error('这一集还没有装配（没有可交付的段）')
  const views = assembly.buildSegmentViews(cur, beats.ordered, settings, registry.entityById, schema)
  if (!views.length) throw new Error('段视图为空')
  const packInput: PackBuildInput = {
    projectName: project.current?.name ?? '',
    settings,
    segments: views.map((v): PackSegmentInput => {
      const ids = collectEntities(v.narrativeBeats)
      return {
        id: v.group.id,
        frames: v.frames,
        prompt: composeSegmentText(schema, v.fields),
        refPrev: v.refPrev,
        continuityFromPrev: v.seam?.continuityFromPrev ?? false,
        continuityToNext: v.nextSeam?.continuityToNext ?? false,
        entities: ids
          .map((id) => registry.entityById.get(id))
          .filter((e): e is Entity => !!e)
      }
    }),
    assets: registry.assets,
    width: cfgUsed.width,
    height: cfgUsed.height
  }
  const pack = await buildDirectorPackZip(packInput)
  const frames = Number((pack.timeline as Record<string, unknown>).totalFrames ?? 0)
  log(
    `导演包：${pack.filename} · ${(pack.blob.size / 1024 / 1024).toFixed(2)} MB · ${packInput.segments.length} 段 / ${frames} 帧`
  )
  if (pack.warnings.length) log('告警：', pack.warnings.slice(0, 5))

  // --- 提交 ---
  const job = await run.submit({
    episodeId,
    episodeName: epName,
    templateName: tpl2.name,
    api: tpl2.api!,
    values: tpl2.values,
    timeline: pack.timeline,
    packBlob: pack.blob,
    packFilename: pack.filename,
    config: cfgUsed
  })
  log(`已提交：prompt_id=${job.promptId} · 缓存目录 ${job.workflowName} · 命中 ${job.applied} 项`)
  if (job.skipped.length) log('未命中：', job.skipped.slice(0, 8))

  // --- 轮询 ---
  // 顺带验证进度：导演节点发的是**自定义事件** minimax_director_opt_progress，
  // 而且不带 prompt_id。如果这里一直打印 0% / max=0，说明事件还是没接上。
  log(`WebSocket 可用：${typeof WebSocket}`)
  const t0 = Date.now()
  let lastKey = ''
  while (Date.now() - t0 < 1000 * 60 * 60) {
    const jobNow = run.jobs.find((j) => j.id === job.id)
    const res = await fetch(`${COMFY}/history/${job.promptId}`)
    const body = (await res.json()) as Record<string, any>
    const entry = body[job.promptId]
    if (entry) {
      const status = entry.status ?? {}
      log()
      log(`完成（${Math.round((Date.now() - t0) / 1000)}s）：status=${JSON.stringify(status.status_str)}`)
      if (status.status_str === 'error') {
        for (const m of status.messages ?? []) {
          if (m[0] === 'execution_error') {
            log('  节点', m[1].node_id, m[1].node_type)
            log('  ', String(m[1].exception_message ?? '').split('\n')[0])
          }
        }
      }
      for (const [nodeId, out] of Object.entries<any>(entry.outputs ?? {})) {
        for (const [kind, items] of Object.entries<any>(out)) {
          for (const it of Array.isArray(items) ? items : [items]) {
            log(`  产物 ${nodeId}/${kind}: ${JSON.stringify(it)}`)
          }
        }
      }
      log(`  剧本台任务状态：${jobNow?.status ?? '?'} · 进度 ${JSON.stringify(jobNow?.progress ?? {})}`)
      return
    }
    if (jobNow?.status === 'error') {
      log('剧本台侧报错：', jobNow.error)
      return
    }
    const q = (await (await fetch(`${COMFY}/queue`)).json()) as any
    const p = jobNow?.progress
    const pctNow = p?.max ? Math.round((p.value / p.max) * 100) : 0
    const key = `${pctNow}|${p?.phase}|${p?.segment}|${p?.framesLabel}`
    const line =
      `  ${Math.round((Date.now() - t0) / 1000)}s · ${pctNow}% (${p?.value ?? 0}/${p?.max ?? 0})` +
      ` · ${p?.phaseLabel || p?.phase || '尚无进度上报'}` +
      ` · 第 ${p?.segment ?? 0}/${p?.segmentTotal ?? 0} 段` +
      ` · 剩 ${p?.remainingSegments ?? 0}` +
      (p?.framesLabel ? ` · ${p.framesLabel}` : '') +
      ` · 状态 ${jobNow?.status}` +
      ` · 运行 ${(q.queue_running ?? []).length} 排队 ${(q.queue_pending ?? []).length}`
    if (key !== lastKey) {
      lastKey = key
      log(line)
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  log('超时')
}

main().catch((e) => {
  console.error('失败：', e instanceof Error ? e.stack : e)
  process.exit(1)
})
