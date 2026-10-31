import { isRef, toRaw } from 'vue'

const PASS_THROUGH: Array<new (...args: never[]) => unknown> = [
  Blob as never,
  File as never,
  Date as never,
  Map as never,
  Set as never,
  ArrayBuffer as never,
  RegExp as never
]

/**
 * 深度剥掉 Vue 的响应式代理，得到可以安全结构化克隆的普通对象。
 *
 * 为什么必须做：Pinia 的 ref 会把对象包成 Proxy，而 IndexedDB 的写入要经过
 * 结构化克隆，结构化克隆遇到 Proxy 会抛
 *   DataCloneError: #<Object> could not be cloned.
 * 这个错误在异步 store 方法里会变成 rejected promise，被 Vue 报成
 * "Unhandled error during execution of component event handler"，
 * 只看报错完全看不出是写库的问题。
 *
 * 注意：Blob / File / Date 等宿主对象原样返回，它们的原始值本身就是普通值，
 * 不会带代理，交给 structuredClone 处理即可。
 */
export function toPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value

  if (isRef(value)) {
    return toPlain((value as unknown as { value: unknown }).value) as unknown as T
  }

  const raw = toRaw(value as object)

  for (const ctor of PASS_THROUGH) {
    if (raw instanceof (ctor as new (...a: never[]) => unknown)) return raw as unknown as T
  }

  if (Array.isArray(raw)) {
    return raw.map((item) => toPlain(item)) as unknown as T
  }

  const proto = Object.getPrototypeOf(raw)
  if (proto !== Object.prototype && proto !== null) {
    // 未知的类实例，不做深拷贝，避免破坏语义
    return raw as unknown as T
  }

  const out: Record<string, unknown> = {}
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    out[key] = toPlain((raw as Record<string, unknown>)[key])
  }
  return out as T
}

export function toPlainList<T>(rows: T[]): T[] {
  return rows.map((row) => toPlain(row))
}

/**
 * 深拷贝一份可以随便改的普通对象 —— **先剥代理，再克隆**。
 *
 * 为什么不直接 `structuredClone(x)`：从 Pinia / `ref` 里取出来的东西
 * （`store.list[0]`、`computed(() => store.xxx)`、reactive 对象的字段）**一定
 * 是 Proxy**，结构化克隆只认真正的普通对象，遇到 Proxy 直接抛
 *   DataCloneError: Failed to execute 'structuredClone' on 'Window':
 *   #<Object> could not be cloned.
 * 这个报错完全看不出源头，Vue 又会把它包成
 * "Unhandled error during execution of component event handler"，
 * 于是"点一下复制配置"就变成页面报错、什么都没发生。
 *
 * `toPlain` 已经逐层 toRaw 重建过容器，structuredClone 只是再保险一层
 * （Date / Blob / Map 这些宿主对象交给它拷得更干净）。带函数或类实例的值
 * 它不认，那就退回 toPlain 那份 —— 宁可少拷一层，也不能让整条路径炸掉。
 */
export function deepClone<T>(value: T): T {
  const plain = toPlain(value)
  try {
    return structuredClone(plain) as T
  } catch {
    return plain
  }
}
