/**
 * 卡片上的试听：全页共用一个 `<audio>`。
 *
 * 每张卡各自 `new Audio()` 的话，点两段就会一起响，切段、筛段、关卡片都不会停；
 * 播放器本来就该只有一台，所以这里把它放在模块作用域，跨实例共享。
 *
 * 只暴露状态和开关，不管业务 —— URL 由调用方给（后端素材地址）。
 * 同一时刻只有一条在放：换段时先换 src，天然互斥。
 */
import { ref } from 'vue'
import type { ID } from '@/domain/types'

const el: HTMLAudioElement | null = typeof Audio === 'undefined' ? null : new Audio()

/** 正在播的那条素材 id（null = 没在播） */
const playingId = ref<ID | null>(null)
/** 0..1，卡上那条细进度条用 */
const progress = ref(0)
const elapsed = ref(0)
const total = ref(0)

if (el) {
  el.preload = 'metadata'
  el.addEventListener('timeupdate', () => {
    elapsed.value = el.currentTime
    progress.value = el.duration ? el.currentTime / el.duration : 0
  })
  el.addEventListener('loadedmetadata', () => {
    total.value = Number.isFinite(el.duration) ? el.duration : 0
  })
  el.addEventListener('ended', () => {
    playingId.value = null
    progress.value = 0
    elapsed.value = 0
  })
  el.addEventListener('error', () => {
    // 容器解不了时别让按钮一直挂着"播放中"的样子
    if (playingId.value) playingId.value = null
  })
}

function isPlaying(id: ID): boolean {
  return playingId.value === id
}

/** 播放 / 暂停同一条；换条时先换源，旧的自动停 */
async function togglePlay(id: ID, url: string): Promise<void> {
  if (!el) throw new Error('当前环境不支持音频播放')
  if (playingId.value === id) {
    el.pause()
    playingId.value = null
    return
  }
  if (el.getAttribute('src') !== url) {
    el.src = url
    progress.value = 0
    elapsed.value = 0
    total.value = 0
  }
  await el.play()
  playingId.value = id
}

/** 停掉；传 id 只停那一条，不传就全停 */
function stopPlay(id?: ID): void {
  if (!el) return
  if (id && playingId.value !== id) return
  el.pause()
  playingId.value = null
  progress.value = 0
  elapsed.value = 0
}

/** 0:07 这种，只用在悬停提示里 */
function clockOf(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function useAudioPlayback() {
  return { playingId, progress, elapsed, total, isPlaying, togglePlay, stopPlay, clockOf }
}
