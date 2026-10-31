/**
 * 实体登记 · 跨 tab 交接
 *
 * 登记这件事只在一个地方做：主体登记页的卡片。但**发现缺谁**往往发生在别的页 ——
 * 拆解回来一堆名字对不上、②③ 里某个片段的主体是空的。那些地方不该各自再养一个
 * 登记弹窗（同一个动作两个入口，迟早两边判重口径不一样）。
 *
 * 所以这里只传两件事：带过去当候选的名字、以及「请把待登记那一栏翻出来」这个动作本身。
 * 一次请求 = 序号自增，接收方（主体登记页）监听序号变化即可 —— 不用布尔开关，
 * 连点两次也能重新打开，不会因为「已经是 true」而没反应。
 */
import { ref } from 'vue'
import type { EntityProposal } from '@/stores/pipeline'

/** 带过去的候选（拆解时模型提到的、或片段里对不上的名字） */
const presets = ref<EntityProposal[]>([])
/** 请求序号：每次请求 +1，接收方靠它触发（连点两次也能重新响应） */
const seq = ref(0)

export function requestEntityRegister(list: EntityProposal[] = []) {
  presets.value = list
  seq.value += 1
}

export function useEntityRegister() {
  return { presets, seq, requestEntityRegister }
}
