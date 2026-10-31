/**
 * 场景占位图（scene plate）与「按片段取视角」。
 *
 * 为什么要有这一层：
 *   一段一张关键帧出图，等于让模型替我们决定"这一段的空间关系是什么"——
 *   同一个便利店，第 3 段门在东边、第 6 段门跑到西边，剪起来就是两个地方。
 *   先给**一个场景**出一张宽幅占位图（人物站位固定），再从这张图上按各片段
 *   的景别 / 机位**裁出取景框**当起始帧，同一场戏的机位关系就天然成立：
 *   远景能看到整间店，近景是同一个人同一个方向的裁切，越轴不会发生。
 *
 * 所以这里的两个概念不要混：
 *   占位图（plate）—— 一个场景一张，宽幅，属于**场景实体**，不进提示词、不占 <Picture N>
 *   取景框（rect）  —— 一个片段一个，归一化坐标（0~1），裁出来的图才是该段的关键帧
 *
 * 全部是纯函数：界面拖框、批量取起始帧、单元测试读的必须是同一份几何，
 * 不然会出现"界面上框在这儿、裁出来在别处"。
 */
import type { Beat, BeatKind, Entity, ID, ProjectSettings } from './types'

/** 归一化取景框：x/y 是左上角，w/h 是宽高，全部按占位图的 0~1 计 */
export interface PlateRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 占位图的出图尺寸：2.4:1 的超宽幅。
 *
 * 比成片（16:9）宽得多，是为了让"近景 / 特写"真的有地方可裁 ——
 * 用 16:9 的图当占位图，裁近景就等于从中间抠一块，横向机位变化全没了。
 * 两个数都是 32 的倍数：后端注入 ComfyUI 的 latent 要求这样。
 */
export const PLATE_WIDTH = 1536
export const PLATE_HEIGHT = 640
export const PLATE_SIZE = `${PLATE_WIDTH}x${PLATE_HEIGHT}`

/**
 * 景别由大到小。顺序就是 `SHOT_SCALE_WIDTH` 的宽度顺序，别按字典序排。
 */
export type ShotScale = 'ews' | 'ws' | 'fs' | 'ms' | 'mcu' | 'cu' | 'ecu' | 'xcu'

export const SHOT_SCALE_LABEL: Record<ShotScale, string> = {
  ews: '大远景',
  ws: '远景',
  fs: '全景',
  ms: '中景',
  mcu: '中近景',
  cu: '近景',
  ecu: '特写',
  xcu: '大特写'
}

/**
 * 各景别在占位图上占多宽（占位图宽度的比例）。
 *
 * 取自常规电影分镜的经验值：全景约占七成，近景三成，大特写一成多。
 * 真实裁切时还会被"占位图高宽比 / 成片高宽比"夹一次（见 viewportFor）——
 * 宽幅占位图上，远景会被高度限制住，这不是 bug，是几何决定的。
 */
export const SHOT_SCALE_WIDTH: Record<ShotScale, number> = {
  ews: 0.92,
  ws: 0.82,
  fs: 0.68,
  ms: 0.52,
  mcu: 0.42,
  cu: 0.32,
  ecu: 0.22,
  xcu: 0.14
}

/**
 * 识别顺序 = 匹配优先级，长的写法必须排在短的写法前面：
 * 「大特写」先于「特写」、「中近景」先于「中景 / 近景」、「大远景」先于「远景」。
 */
const SCALE_RULES: ReadonlyArray<readonly [ShotScale, RegExp]> = [
  ['xcu', /大特写|极特写|extreme\s*close[-\s]?up|\bxcu\b/i],
  // 中近景必须排在特写前面：'medium close-up' 里也含 close-up，
  // 顺序反了会把中近景一律读成特写（框小一号，裁出来只剩一张脸）
  ['mcu', /中近景|medium\s*close[-\s]?up|\bmcu\b/i],
  ['ecu', /特写|close[-\s]?up|\bcu\b/i],
  ['ews', /大远景|极远景|extreme\s*wide|very\s*wide|\bews\b/i],
  ['ws', /远景|大全景|wide\s*shot|long\s*shot|\bws\b/i],
  ['fs', /全景|全身|full\s*shot|full\s*body/i],
  ['ms', /中景|medium\s*shot|\bms\b/i],
  ['cu', /近景|close\s*shot/i]
]

/** 机位俯仰，只影响取景框的上下偏移（人眼高度、略仰、略俯） */
export type Tilt = 'low' | 'high' | 'eye'

export const TILT_LABEL: Record<Tilt, string> = {
  low: '微仰角',
  high: '略俯视',
  eye: ''
}

/** 从一句运镜描述里认景别；认不出返回 null（交给 kind 兜底） */
export function parseScale(text: string): ShotScale | null {
  const s = String(text ?? '')
  if (!s.trim()) return null
  for (const [scale, re] of SCALE_RULES) if (re.test(s)) return scale
  return null
}

export function parseTilt(text: string): Tilt {
  const s = String(text ?? '')
  if (/仰角|仰拍|低角度|low[-\s]?angle|from\s*below/i.test(s)) return 'low'
  if (/俯视|俯拍|高角度|顶拍|航拍|high[-\s]?angle|top[-\s]?down|overhead|bird'?s[-\s]?eye/i.test(s)) {
    return 'high'
  }
  return 'eye'
}

/**
 * 运镜 / 画面里能读到的文字，**中英分开**。
 *
 * 不能拼成一句再匹配：中文写「近景」、英文写 "close-up" 时，拼起来之后
 * 英文的 close-up 会先撞上"特写"规则，于是所有近景都被裁成 22% 的小框。
 * 中文是人工写的、用词更准，必须整段先判完再看英文。
 */
function textsOf(beat: Pick<Beat, 'direction' | 'directionEn' | 'visualDesc' | 'visualDescEn'>): {
  zh: string
  en: string
} {
  const join = (a?: string | null, b?: string | null) =>
    [a, b].filter((x): x is string => !!x && !!x.trim()).join(' ')
  return { zh: join(beat.direction, beat.visualDesc), en: join(beat.directionEn, beat.visualDescEn) }
}

/**
 * 这一段的默认景别。
 *
 * 优先读运镜描述（人写的，最准）；没写就按片段类型兜底 ——
 * insert 是插入特写、reaction 是反应近景、establishing 是远景，这套对应关系
 * 在拆解规则里已经隐含了，不用再让用户填一遍。
 */
export function defaultScaleOf(beat: Pick<Beat, 'kind' | 'direction' | 'directionEn' | 'visualDesc' | 'visualDescEn'>): ShotScale {
  const t = textsOf(beat)
  return parseScale(t.zh) ?? parseScale(t.en) ?? SCALE_BY_KIND[beat.kind] ?? 'ms'
}

/** 这一段的机位俯仰：中文优先，英文兜底 */
export function tiltOfBeat(beat: Pick<Beat, 'direction' | 'directionEn' | 'visualDesc' | 'visualDescEn'>): Tilt {
  const t = textsOf(beat)
  const zh = parseTilt(t.zh)
  return zh !== 'eye' ? zh : parseTilt(t.en)
}

const SCALE_BY_KIND: Partial<Record<BeatKind, ShotScale>> = {
  insert: 'ecu',
  reaction: 'cu',
  establishing: 'ws',
  scene_switch: 'fs',
  dialogue: 'mcu',
  action: 'ms'
}

/**
 * 角色的站位（占位图上的横向锚点）。
 *
 * 一个人站中间，两个人各占一侧，三个人左中右 —— 站位一固定，
 * "这一段镜头给谁" 就能换算成 "框该落在哪"，不用模型猜。
 * 顺序由调用方给（按首次出场），保证同一场戏每次算出来一样。
 */
export function layoutSlots(n: number): number[] {
  if (n <= 0) return []
  if (n === 1) return [0.5]
  if (n === 2) return [0.33, 0.67]
  if (n === 3) return [0.24, 0.5, 0.76]
  if (n === 4) return [0.18, 0.39, 0.61, 0.82]
  const out: number[] = []
  const step = 0.7 / (n - 1)
  for (let i = 0; i < n; i += 1) out.push(Number((0.15 + step * i).toFixed(3)))
  return out
}

/** 站位锚点 → 一句人话（拼提示词用） */
export function slotPhrase(x: number): string {
  if (x < 0.28) return 'at the left edge'
  if (x < 0.42) return 'at the left third'
  if (x < 0.58) return 'in the center'
  if (x < 0.72) return 'at the right third'
  return 'at the right edge'
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

export function normalizeRect(r: PlateRect): PlateRect {
  const w = clamp01(r.w)
  const h = clamp01(r.h)
  return {
    x: clamp01(r.x),
    y: clamp01(r.y),
    w: Math.min(w, 1),
    h: Math.min(h, 1)
  }
}

/**
 * 按景别 + 锚点算一个取景框。
 *
 * 关键一步是**保成片高宽比**：从宽幅占位图上裁出来的必须是 16:9（或项目设置的
 * 出片比例），否则这一段的首帧和别的段拼在一起会被拉变形。
 * 所以宽度先按景别给，再按 `plateAspect / shotAspect` 换算高度；
 * 高度超过整图时反过来按高度夹宽度。
 */
export function viewportFor(opts: {
  scale: ShotScale
  /** 取景锚点（0~1）：通常是被摄主体的站位 */
  anchorX?: number
  tilt?: Tilt
  plateWidth: number
  plateHeight: number
  /** 成片高宽比，默认 16:9 */
  shotAspect?: number
}): PlateRect {
  const shotAspect = opts.shotAspect && opts.shotAspect > 0 ? opts.shotAspect : 16 / 9
  const pw = opts.plateWidth > 0 ? opts.plateWidth : 1536
  const ph = opts.plateHeight > 0 ? opts.plateHeight : 640
  // 占位图比成片更宽 → 同样高度下能装的画面更宽（这个系数 > 1）
  const wide = pw / ph / shotAspect

  let w = SHOT_SCALE_WIDTH[opts.scale] ?? SHOT_SCALE_WIDTH.ms
  let h = w * wide
  if (h > 1) {
    h = 1
    w = h / wide
  }
  w = clamp01(w)
  h = clamp01(h)

  const anchor = typeof opts.anchorX === 'number' ? clamp01(opts.anchorX) : 0.5
  const cy = opts.tilt === 'low' ? 0.56 : opts.tilt === 'high' ? 0.44 : 0.5
  return {
    x: Number(Math.max(0, Math.min(1 - w, anchor - w / 2)).toFixed(4)),
    y: Number(Math.max(0, Math.min(1 - h, cy - h / 2)).toFixed(4)),
    w: Number(w.toFixed(4)),
    h: Number(h.toFixed(4))
  }
}

/** 拖动取景框：整体平移，越界夹回图内（不允许把框拖出去半截） */
export function moveRect(r: PlateRect, dx: number, dy: number): PlateRect {
  return {
    x: Number(Math.max(0, Math.min(1 - r.w, r.x + dx)).toFixed(4)),
    y: Number(Math.max(0, Math.min(1 - r.h, r.y + dy)).toFixed(4)),
    w: r.w,
    h: r.h
  }
}

/**
 * 拖右下角改大小：**只给一个方向的增量**，高度按成片高宽比跟着算。
 *
 * 不做自由拉伸：起始帧必须和出片同比例，让人拉成任意形状再在渲染时被
 * 拉伸变形，比"拉不动"更让人困惑。宽到顶（高度撑满）就停在那一刻。
 */
export function resizeRect(
  r: PlateRect,
  dW: number,
  plateWidth: number,
  plateHeight: number,
  shotAspect?: number
): PlateRect {
  const aspect = shotAspect && shotAspect > 0 ? shotAspect : 16 / 9
  const pw = plateWidth > 0 ? plateWidth : 1536
  const ph = plateHeight > 0 ? plateHeight : 640
  const wide = pw / ph / aspect
  let w = Math.max(0.06, clamp01(r.w + dW))
  let h = w * wide
  if (h > 1) {
    h = 1
    w = 1 / wide
  }
  return {
    x: Number(Math.min(r.x, 1 - w).toFixed(4)),
    y: Number(Math.min(r.y, 1 - h).toFixed(4)),
    w: Number(w.toFixed(4)),
    h: Number(h.toFixed(4))
  }
}

/** 两个框是否几乎相同（判定"同一机位"用，容忍 1.5% 的手抖） */export function sameRect(a: PlateRect, b: PlateRect, tol = 0.015): boolean {
  return (
    Math.abs(a.x - b.x) < tol &&
    Math.abs(a.y - b.y) < tol &&
    Math.abs(a.w - b.w) < tol &&
    Math.abs(a.h - b.h) < tol
  )
}

/**
 * 把撞在一起的取景框错开一点。
 *
 * 两段如果都是"中景 · 同一个角色"，算出来的框会一模一样 —— 那两段的起始帧
 * 就是同一张图，等于没给不同视角。这里按序号左右平移几个百分点：
 * 画面里主体仍在框内，但两段的构图确实不同，且完全可预期（同一份输入永远
 * 得到同一份输出，不会让用户每次点"重算"都跳一下）。
 */
export function spreadViewports<T extends { rect: PlateRect }>(items: T[]): T[] {
  const groups = new Map<string, number[]>()
  items.forEach((it, i) => {
    const k = [it.rect.x, it.rect.y, it.rect.w, it.rect.h].map((n) => n.toFixed(2)).join(':')
    const arr = groups.get(k)
    if (arr) arr.push(i)
    else groups.set(k, [i])
  })
  const out = items.map((it) => ({ ...it, rect: { ...it.rect } }))
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue
    idxs.forEach((idx, k) => {
      const shift = (k - (idxs.length - 1) / 2) * 0.04
      const r = out[idx].rect
      r.x = Number(Math.max(0, Math.min(1 - r.w, r.x + shift)).toFixed(4))
    })
  }
  return out
}

/** 框在画面左 / 中 / 右 —— 列表里一句话说清"这个视角是从哪边看" */
export function frameSideOf(r: PlateRect): '左' | '中' | '右' {
  const c = r.x + r.w / 2
  if (c < 0.4) return '左'
  if (c > 0.6) return '右'
  return '中'
}

/** 「近景 · 微仰角 · 中」 */
export function viewLabel(scale: ShotScale, tilt: Tilt, rect: PlateRect): string {
  return [SHOT_SCALE_LABEL[scale], TILT_LABEL[tilt], frameSideOf(rect)].filter(Boolean).join(' · ')
}

/** 归一化框 → 像素裁切参数（canvas.drawImage 的源矩形） */
export function cropRectPx(
  r: PlateRect,
  width: number,
  height: number
): { sx: number; sy: number; sw: number; sh: number } {
  const n = normalizeRect(r)
  const sx = Math.round(n.x * width)
  const sy = Math.round(n.y * height)
  const sw = Math.max(1, Math.round(n.w * width))
  const sh = Math.max(1, Math.round(n.h * height))
  return {
    sx: Math.min(sx, Math.max(0, width - 1)),
    sy: Math.min(sy, Math.max(0, height - 1)),
    sw: Math.min(sw, width - sx),
    sh: Math.min(sh, height - sy)
  }
}

/** 成片高宽比（来自项目设置；设置坏掉时退回 16:9） */
export function shotAspectOf(settings: Pick<ProjectSettings, 'outputWidth' | 'outputHeight'>): number {
  const w = Number(settings?.outputWidth) || 0
  const h = Number(settings?.outputHeight) || 0
  return w > 0 && h > 0 ? w / h : 16 / 9
}

/* --------------------------- 提示词 --------------------------- */

export interface PlateSlot {
  name: string
  /** 主体外观描述：占位图里"这个人长什么样"全指望它（参考图只保脸和衣服） */
  desc?: string
  /** 站位锚点 0~1 */
  x: number
}

/**
 * 场景占位图的生图提示词。
 *
 * 写这句话的目的是**让模型把整个场景摊平铺开**，而不是构图：
 * 人物要全身、站开、彼此留空，因为这张图后面会被裁成十几个 16:9 的框。
 * 一旦模型把它当"一张好看的剧照"来画（人物挤在中间、大特写、浅景深），
 * 边缘就没有可裁的东西了。
 */
export function platePromptOf(opts: {
  sceneName: string
  sceneDesc?: string
  slots: PlateSlot[]
  /** 在场道具：只提名字，不给站位（道具不站左中右） */
  props?: string[]
  /** 占位图宽高（只用来在提示词里点明"超宽画幅"） */
  width: number
  height: number
}): string {
  const name = (opts.sceneName || 'the location').trim()
  const desc = (opts.sceneDesc ?? '').trim()
  const wide = opts.width / Math.max(1, opts.height)
  const blocking = opts.slots
    .map((s) => {
      const d = (s.desc ?? '').trim()
      return `${s.name}${d ? ` (${d})` : ''} ${slotPhrase(s.x)}`
    })
    .join('; ')
  const props = (opts.props ?? []).map((p) => p.trim()).filter(Boolean)
  return [
    `Wide panoramic blocking plate of one continuous location, ${wide >= 2.2 ? 'ultra-wide 21:9 framing' : 'wide framing'}, camera at eye level, deep focus, no text`,
    `Setting: ${name}${desc ? ` — ${desc}` : ''}`,
    blocking ? `Blocking: ${blocking}` : '',
    props.length ? `Props already in this location: ${props.join(', ')} (keep them where they naturally belong)` : '',
    'Everyone in frame is full body, facing the camera, neutral standing pose, evenly lit, with clear empty space between them',
    'Keep the architecture, materials, props and light sources consistent across the entire frame so any region can be cropped into a 16:9 shot',
    // 明确要"真人"：参考图是占位剪影时，模型很容易顺着画成色块人 ——
    // 总图一旦是色块人，后面所有镜头都会继承这张色块脸
    'Cinematic, photorealistic, real people with real faces, no illustration, no flat shapes'
  ]
    .filter(Boolean)
    .join('. ')
}

/**
 * 占位图的参考图点名句。
 *
 * 与 `refClause` 的区别：这里第一张是**地点**，要的是"照着它的建筑和光"
 * 而不是"照抄它的构图"—— 那张场景图往往是竖构图或近景，抄了就没法裁了。
 */
export function plateRefClause(refs: Array<{ label: string; role: 'set' | 'cast' }>): string {
  if (!refs.length) return ''
  const map = refs
    .map((r, i) =>
      r.role === 'set'
        ? `<image${i + 1}> is this location — keep its architecture, materials and light sources, but widen the framing`
        : `<image${i + 1}> is ${r.label}`
    )
    .join('; ')
  const head = `Reference images: ${map}.`
  if (!refs.some((r) => r.role === 'cast')) return head
  return `${head} Keep each person's face, hair and outfit exactly as in their own reference image; do not swap their identities.`
}

/** 裁出来的起始帧记什么：给卡片上的「出图提示词」看，也给"这张从哪来"溯源 */
export function cropNoteOf(opts: {
  sceneName: string
  scale: ShotScale
  tilt: Tilt
  rect: PlateRect
  plateWidth: number
  plateHeight: number
}): string {
  const r = opts.rect
  return (
    `[场景占位] ${opts.sceneName} · ${viewLabel(opts.scale, opts.tilt, r)}` +
    ` · 取景框 x${Math.round(r.x * 100)}% y${Math.round(r.y * 100)}%` +
    ` w${Math.round(r.w * 100)}% h${Math.round(r.h * 100)}%` +
    `（占位图 ${opts.plateWidth}×${opts.plateHeight}）`
  )
}

/* --------------------------- 镜头机位 --------------------------- */

/**
 * 机位在主体的哪一侧。
 *
 * 这不是"随便换个角度"。它守的是 180 度轴：站在画面左侧的人，机位移到他的
 * **右侧**往左拍，他永远朝画面右边看；站在右侧的人反过来。两个人对话对切时，
 * 观众看到的视线方向始终相对 —— 一旦两侧都从同一侧拍，就是越轴，剪起来像
 * 两个人各看各的。
 */
export type CameraSide = 'left' | 'right' | 'front'

export function cameraSideOf(anchorX: number): CameraSide {
  const x = clamp01(anchorX)
  if (x < 0.42) return 'right'
  if (x > 0.58) return 'left'
  return 'front'
}

export const CAMERA_SIDE_LABEL: Record<CameraSide, string> = {
  left: '左侧机位',
  right: '右侧机位',
  front: '正面机位'
}

/** 机位与主体正面的夹角。同一机位连着给两拍时才往上加，正常情况下都是正面。 */
export type Turn = 'front' | 'three-quarter' | 'profile'

export const TURN_LABEL: Record<Turn, string> = {
  front: '正面',
  'three-quarter': '四分之三侧',
  profile: '侧面'
}

/** 景别的英文写法：提示词里说的是"medium close-up"，不是 "mcu" */
export const SHOT_SCALE_EN: Record<ShotScale, string> = {
  ews: 'extreme wide shot',
  ws: 'wide shot',
  fs: 'full shot',
  ms: 'medium shot',
  mcu: 'medium close-up',
  cu: 'close-up',
  ecu: 'extreme close-up',
  xcu: 'macro close-up'
}

const SCALE_ORDER: ShotScale[] = ['ews', 'ws', 'fs', 'ms', 'mcu', 'cu', 'ecu', 'xcu']

/**
 * 往近推一档。**封顶在近景**：再往上就是特写 / 大特写，
 * 连着两拍同一个人的特写会把场景交代丢掉，那已经不是"换个视角"了。
 *
 * 本来就比近景更紧的（特写 / 大特写）**原样返回** —— 推近不能变成拉远，
 * 否则"第二拍推近一档"会把特写放大成近景，方向反了。
 */
function zoomIn(s: ShotScale): ShotScale {
  const i = SCALE_ORDER.indexOf(s)
  const cap = SCALE_ORDER.indexOf('cu')
  if (i >= cap) return s
  return SCALE_ORDER[i + 1] ?? s
}

export interface ShotPlan {
  beat: Beat
  /** 这一镜的主体（镜头给谁） */
  subject: Entity | null
  /** 对话的另一方：主体看向他（画外） */
  other: Entity | null
  /** 主体站位锚点 0~1 */
  anchorX: number
  scale: ShotScale
  tilt: Tilt
  side: CameraSide
  turn: Turn
}

/**
 * 一场戏里每一拍该怎么拍。
 *
 * 三件事一起定：给谁（focus）、多大（景别）、在哪边（机位）。
 * 同一主体连着两拍时把机位转一点、景别推近一档 —— 否则两拍会得到同一张图，
 * "不同视角"就成了一句空话。**只转不翻**：翻到另一侧就是越轴。
 */
export function planSceneShots(beats: Beat[], entityById: Map<ID, Entity>): ShotPlan[] {
  const cast = charactersOfScene(beats, entityById)
  const xs = layoutSlots(cast.length)
  const slotOf = new Map<ID, number>(cast.map((e, i) => [e.id, xs[i] ?? 0.5]))
  let prevKey = ''
  let run = 0

  return beats.map((b) => {
    const subject = focusOfBeat(b, cast)
    const anchorX = (subject && slotOf.get(subject.id)) ?? 0.5
    let scale = defaultScaleOf(b)
    const tilt = tiltOfBeat(b)
    const side = cameraSideOf(anchorX)

    const key = `${subject?.id ?? '-'}|${scale}|${side}`
    if (key === prevKey) run += 1
    else run = 0
    prevKey = key

    let turn: Turn = 'front'
    if (run === 1) {
      turn = 'three-quarter'
      scale = zoomIn(scale)
    } else if (run >= 2) {
      turn = 'profile'
      scale = zoomIn(scale)
    }

    const other = subject
      ? cast.find((e) => e.id !== subject.id) ?? null
      : cast[0] ?? null
    return { beat: b, subject, other, anchorX, scale, tilt, side, turn }
  })
}

/** 某一段的机位（要按整场算，否则"连着两拍"的判断会失真） */
export function planForBeat(
  beatId: ID,
  beats: Beat[],
  entityById: Map<ID, Entity>
): ShotPlan | null {
  const beat = beats.find((b) => b.id === beatId)
  if (!beat) return null
  const group = groupByScene(beats, entityById).find((g) => g.sceneId === (beat.sceneId ?? ''))
  const list = group?.beats ?? [beat]
  return planSceneShots(list, entityById).find((p) => p.beat.id === beatId) ?? null
}

/** 一行人话：「中近景 · 右侧机位 · 四分之三侧」 */
export function planLabel(p: ShotPlan): string {
  return [SHOT_SCALE_LABEL[p.scale], CAMERA_SIDE_LABEL[p.side], TURN_LABEL[p.turn]].join(' · ')
}

/**
 * 按场景总图编辑的提示词。
 *
 * 和"文生图"的关键区别：这里**不许模型重新设计画面**。地点、道具、光、人在
 * 画面里的位置全部沿用总图，只允许动机位 —— 一句 "Keep ... exactly" 比
 * 十句形容词都管用，模型很擅长在你没明说的地方自由发挥。
 */
export function plateEditPromptOf(o: {
  sceneName: string
  sceneDesc?: string
  subjectName?: string
  otherName?: string
  scale: ShotScale
  tilt: Tilt
  side: CameraSide
  turn: Turn
  /** 这一拍的画面 / 动作（已翻成英文的优先） */
  action?: string
  /** 这一拍有台词：让人物处于说话状态 */
  dialogue?: string
  /** 总图里出现的角色名（强调不增不减） */
  cast?: string[]
}): string {
  const subject = (o.subjectName ?? '').trim()
  const other = (o.otherName ?? '').trim()
  const sceneName = (o.sceneName || 'the location').trim()
  const sceneDesc = (o.sceneDesc ?? '').trim()
  const who = subject || 'the main subject'
  // 全景 / 远景拍的是"整间店 + 人在其中"，不是"某个人的远景"——
  // 写成 "wide shot of 陈默" 模型会把镜头怼到他身上，场景就没了
  const wide = o.scale === 'ews' || o.scale === 'ws' || o.scale === 'fs'

  const side =
    o.side === 'right'
      ? `camera moved round to ${who}'s right`
      : o.side === 'left'
        ? `camera moved round to ${who}'s left`
        : `camera directly in front of ${who}`
  const tilt =
    o.tilt === 'low' ? 'slightly low angle' : o.tilt === 'high' ? 'slightly high angle' : 'eye level'
  const turn =
    o.turn === 'profile' ? 'profile view' : o.turn === 'three-quarter' ? 'three-quarter view' : 'frontal view'

  const camera = (
    wide
      ? [`${SHOT_SCALE_EN[o.scale]} of the whole location`, 'camera pulled back', tilt]
      : [`${SHOT_SCALE_EN[o.scale]}${subject ? ` of ${subject}` : ''}`, side, tilt, turn]
  )
    .filter(Boolean)
    .join(', ')

  const people = (o.cast ?? []).map((n) => n.trim()).filter(Boolean)

  return [
    'Edit <image1> into one shot of this same scene — change the camera only',
    `Keep exactly: the location (${sceneName}${sceneDesc ? ` — ${sceneDesc}` : ''}), its architecture, every prop in place, the light sources and time of day, and every person with the same face, hair, wardrobe and floor position`,
    'Do not redesign the set, do not move furniture, do not add or remove anyone, do not change the colour grade',
    `Camera: ${camera}`,
    subject ? `${subject} stays where they are in the plate and keeps the same body position` : '',
    other && !wide ? `${subject || 'The subject'} looks toward ${other} (at the edge of frame or just off frame)` : '',
    (o.dialogue ?? '').trim() && subject && !wide
      ? `${subject} is speaking to ${other || 'the other person'}, lips moving, natural expression`
      : '',
    (o.action ?? '').trim() ? `Action in this shot: ${(o.action ?? '').trim()}` : '',
    people.length ? `Only these people are in the scene: ${people.join(', ')}` : '',
    'Cinematic film still, 16:9, photorealistic, same colour grade and lighting as <image1>'
  ]
    .filter(Boolean)
    .join('. ')
}

/* --------------------------- 分组 --------------------------- */

export interface SceneGroup {
  sceneId: ID
  scene: Entity | null
  name: string
  beats: Beat[]
}

/**
 * 按场景把片段分组（保持片的原有顺序）。
 *
 * 没绑定场景的片段单独成一组（sceneId = ''）—— 它们没法共享占位图，
 * 但也不能从这一页消失，否则用户看不出"还有几段没有场景"。
 */
export function groupByScene(beats: Beat[], entityById: Map<ID, Entity>): SceneGroup[] {
  const out: SceneGroup[] = []
  const at = new Map<ID, SceneGroup>()
  for (const b of beats) {
    const sid = b.sceneId ?? ''
    let g = at.get(sid)
    if (!g) {
      const scene = sid ? entityById.get(sid) ?? null : null
      g = { sceneId: sid, scene, name: scene?.name || '（未绑定场景）', beats: [] }
      at.set(sid, g)
      out.push(g)
    }
    g.beats.push(b)
  }
  return out
}

/**
 * 一个场景里出场的主体（不含场景自身），按首次出场排序。
 *
 * 站位就按这个顺序排 —— 先出现的人站左边，后来的人往右站。
 * 这比"按 role 排"稳定：同一场戏里焦点切换不会让所有人的站位重排。
 */
export function castOfScene(beats: Beat[], entityById: Map<ID, Entity>): Entity[] {
  const out: Entity[] = []
  const seen = new Set<ID>()
  for (const b of beats) {
    for (const id of b.entities ?? []) {
      if (seen.has(id)) continue
      const e = entityById.get(id)
      if (!e || e.type === 'scene') continue
      seen.add(id)
      out.push(e)
    }
  }
  return out
}

/**
 * 本场有**站位**的主体：只有角色站左中右。
 *
 * 道具不能占站位 —— 一张车票、一个保温柜没有"站左边"这回事，把它塞进
 * Blocking 只会让模型画一个立在画面左侧的大车票。道具改在提示词里
 * 作为「在场物件」提一句就够（它们本来就长在场景里）。
 */
export function charactersOfScene(beats: Beat[], entityById: Map<ID, Entity>): Entity[] {
  return castOfScene(beats, entityById).filter((e) => e.type === 'character')
}

/** 本场出现的道具（不进站位，只进提示词点个名） */
export function propsOfScene(beats: Beat[], entityById: Map<ID, Entity>): Entity[] {
  return castOfScene(beats, entityById).filter((e) => e.type === 'prop')
}

/**
 * 这一段"镜头给谁"：优先 focusEntityId，其次台词说话人，最后第一个出场主体。
 * 返回的实体必须是本场出场的（否则站位表里没有它，锚点会落空）。
 */
export function focusOfBeat(beat: Beat, cast: Entity[]): Entity | null {
  const ids = new Set(cast.map((c) => c.id))
  if (beat.focusEntityId && ids.has(beat.focusEntityId)) {
    return cast.find((c) => c.id === beat.focusEntityId) ?? null
  }
  if (beat.speakerId && ids.has(beat.speakerId)) {
    return cast.find((c) => c.id === beat.speakerId) ?? null
  }
  for (const id of beat.entities ?? []) {
    if (ids.has(id)) return cast.find((c) => c.id === id) ?? null
  }
  return null
}
