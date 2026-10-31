/**
 * 「去修字段」的落点。
 *
 * 字段补全原来是独立一页，工作台的问题条点进去 = 切页。现在它长在 ③ 的段卡片里，
 * 「切页」不再能表达"去看缺字段的那几段" —— 得说清落到哪一层、筛哪一类。
 *
 * 所以这里只放一个待办标记：谁都可以写，③ 页读到就按它设筛选并滚到位，
 * 然后清掉。不做事件总线，因为只有这一件事需要跨页面传，多一层反而难查。
 */
import { ref } from 'vue'

/** 落到段字段时要设的筛选：未补全 / 上游已改 */
export type FieldFocusKind = 'incomplete' | 'stale' | null

const pending = ref<FieldFocusKind>(null)

export function focusSegmentFields(kind: FieldFocusKind = 'incomplete') {
  pending.value = kind
}

export function useAssembleFocus() {
  return { pending }
}
