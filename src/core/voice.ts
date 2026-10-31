/**
 * 音色：设计（qwen3）→ 固定（s2 音色包）→ 合成（s2）。
 *
 * 和 backend.ts 里那批接口的区别只有一条，但很重要：这三个动作是**分钟级**的。
 * 默认 8 秒超时会把一次正常的固化成"网络错误"，所以这里每个动作单独给超时，
 * 并且把后端那句人话原样抛给界面（"连不上音色服务"比"后端 500"有用得多）。
 */

import { getBackendBase } from './backend'

export interface VoiceCandidate {
  name: string
  seed: number
  desc: string
  text: string
  seconds: number
  bytes: number
  /** true = 同一个描述+种子之前已经生成过，直接用现成文件 */
  cached: boolean
}

export interface VoicePackMeta {
  id: string
  desc: string
  seed: number
  sample: string
  text: string
  bytes: number
  fixedAt: number
  cached: boolean
}

export interface VoiceServiceState {
  ok: boolean
  url: string
  ms: number
  detail: string
}

export interface VoiceStatus {
  s2: VoiceServiceState
  qwen3: VoiceServiceState
  /**
   * 运行前服务（ModelHub）。它在线时，设计和合成都由它在单卡上按需加载，
   * 这时 3030/8080 那两个常驻端口的死活就不重要了 —— 不要再看它们报警。
   */
  hub?: { url: string; on: boolean; gpu: number | null; engine: string }
  /** 设计音色念的那句参考文本；固化时也用它，前后必须逐字一致 */
  designText: string
  packs: string[]
  designs: number
  dirs: { voices: string; packs: string; design: string }
}

const T_DESIGN = 180_000
const T_FIX = 360_000
const T_SPEAK = 300_000

async function call<T>(path: string, body: unknown | null, timeout: number): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  let res: Response
  try {
    res = await fetch(`${getBackendBase()}/api/${path}`, {
      method: body === null ? 'GET' : 'POST',
      headers: body === null ? undefined : { 'Content-Type': 'application/json; charset=utf-8' },
      body: body === null ? undefined : JSON.stringify(body),
      signal: ctrl.signal
    })
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError'
    throw new Error(
      aborted ? `等了 ${Math.round(timeout / 1000)} 秒还没结果：音色服务可能在排队` : '连不上剧本台后端'
    )
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    let detail = ''
    try {
      const data = await res.json()
      detail = typeof data?.error === 'string' ? data.error : ''
    } catch {
      detail = ''
    }
    throw new Error(detail || `后端 ${res.status}`)
  }
  return (await res.json()) as T
}

export function voiceStatus(): Promise<VoiceStatus> {
  return call<VoiceStatus>('voice/status', null, 15_000)
}

export function voiceDesign(desc: string, seed: number): Promise<VoiceCandidate> {
  return call<VoiceCandidate>('voice/design', { desc, seed }, T_DESIGN)
}

export function voiceFix(
  sample: string,
  desc: string,
  seed: number,
  force = false
): Promise<VoicePackMeta> {
  return call<VoicePackMeta>('voice/fix', { sample, desc, seed, force }, T_FIX)
}

/** 用固定音色包合成一段文本，拿回 wav 本体 */
export async function voiceSpeak(voiceId: string, text: string): Promise<Blob> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), T_SPEAK)
  try {
    const res = await fetch(`${getBackendBase()}/api/voice/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ voiceId, text }),
      signal: ctrl.signal
    })
    if (!res.ok) {
      let detail = ''
      try {
        const data = await res.json()
        detail = typeof data?.error === 'string' ? data.error : ''
      } catch {
        detail = ''
      }
      throw new Error(detail || `后端 ${res.status}`)
    }
    return await res.blob()
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('合成超时：s2 可能在跑别的段，稍后再试')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** 候选音色的试听地址（<audio> 直接挂） */
export function voiceWavUrl(name: string): string {
  return `${getBackendBase()}/api/voice/wav?name=${encodeURIComponent(name)}`
}

/**
 * 候选种子。
 *
 * 固定成这三个而不是随机：同一个角色每次点「设计」拿到的还是那三条，
 * 用户"上次听中的是中间那个"才站得住；想换一批再点「换一批」，用随机种子。
 */
export const VOICE_SEEDS = [11, 42, 97]

export function freshSeeds(): number[] {
  const out = new Set<number>()
  while (out.size < 3) out.add(1 + Math.floor(Math.random() * 9000))
  return [...out]
}
