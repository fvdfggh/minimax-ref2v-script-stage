/**
 * 右侧目录（SectionNav）的展开/收起状态。
 *
 * 为什么放在模块里而不是组件内：六个阶段是用 v-show 同时挂载的，
 * 每个阶段各有一个目录实例。状态如果只存在实例里，在「① 拆解」收起后
 * 切到「③ 组合与缝合」下半块的字段补全，那边的目录还是展开的 —— 同一份 UI 两个样。
 * 模块级 ref 让六个实例共用一个开关，顺手写进 localStorage，刷新也记住。
 */
import { ref, watch } from 'vue'

const KEY = 'secnav:open'

function readInitial(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    // 隐私模式 / 非浏览器环境：默认展开
    return true
  }
}

export const navOpen = ref(readInitial())

watch(navOpen, (v) => {
  try {
    localStorage.setItem(KEY, v ? '1' : '0')
  } catch {
    /* 写不进去就只当次生效 */
  }
})
