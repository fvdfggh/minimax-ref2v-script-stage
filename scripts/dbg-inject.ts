/**
 * 复现「放大节点 mode 丢失」：导入 API → 套模板 → 套运行配置，落盘最终图。
 *
 * 用法：npx vite-node scripts/dbg-inject.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkflowStore } from '@/stores/workflow'
import { applyRunConfigToApi, DEFAULT_RUN_CONFIG } from '@/domain/run'
import type { ApiWorkflow } from '@/domain/workflow'
import type { RunConfig } from '@/domain/run'

setActivePinia(createPinia())
const workflow = useWorkflowStore()

const api = JSON.parse(readFileSync('scripts/_exported_api_fixed.json', 'utf-8')) as ApiWorkflow

const tpl = workflow.create('dbg')
const r = workflow.importApi(tpl.id, JSON.stringify(api))
const t = workflow.templates.find((x) => x.id === tpl.id)!
console.log('导入：', r)

const cfg: RunConfig = {
  ...DEFAULT_RUN_CONFIG,
  baseUrl: 'http://127.0.0.1:8188',
  cards: '0,1',
  width: 864,
  height: 480,
  steps: 3,
  frameRate: 24,
  secondEnabled: false,
  randomSeed: true
}

const a1 = workflow.materialize(tpl.id, api)
const a2 = applyRunConfigToApi(a1.api, cfg, { episodeName: '第 01 集 · 夜班', timelineFrames: 479 })

const upId = Object.keys(a2.api).find((k) => a2.api[k].class_type === 'MiniMaxH3LatentUpscaleModelOpt')!
console.log('\n最终放大节点 inputs:', JSON.stringify(a2.api[upId].inputs, null, 1))

// 和基线逐键 diff
const base = api[upId].inputs as Record<string, unknown>
const now = a2.api[upId].inputs as Record<string, unknown>
console.log('\n-- diff vs 基线 --')
for (const k of new Set([...Object.keys(base), ...Object.keys(now)])) {
  const b = JSON.stringify(base[k])
  const n = JSON.stringify(now[k])
  if (b !== n) console.log(`  ${k}\n    基线 ${b}\n    现在 ${n}`)
}

// 全图 diff：找出所有被改动的节点
console.log('\n-- 全图改动节点 --')
for (const [id, node] of Object.entries(a2.api)) {
  const b = JSON.stringify(api[id]?.inputs ?? {})
  const n = JSON.stringify(node.inputs ?? {})
  if (b !== n) console.log('  ', id, node.class_type)
}

writeFileSync('scripts/_e2e_final_api.json', JSON.stringify(a2.api, null, 1), 'utf-8')
console.log('\n已写出 scripts/_e2e_final_api.json')

// 导演节点的关键开关
const dirId = Object.keys(a2.api).find((k) => a2.api[k].class_type === 'ComfyMiniMaxH3DirectorOpt')!
const di = a2.api[dirId].inputs as Record<string, unknown>
console.log('\n导演节点关键开关：')
for (const k of ['second_enabled', 'second_only', 'second_run_model', 'pipeline_cards', 'total_frames', 'workflow_name', 'width', 'height', 'steps', 'frame_rate']) {
  console.log('  ', k, '=', JSON.stringify(di[k]))
}
