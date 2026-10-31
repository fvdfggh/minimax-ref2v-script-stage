import type { ID, RefSheet, RefSheetGroup, SheetSlot } from './types'

export type { RefSheet, RefSheetGroup, RefSheetActive, SheetSlot } from './types'

/* ------------------------------------------------------------------ *
 * 设定图组（主体参考图的真正形态）
 *
 * 一张「全身正面」当参考图是不够的：模型只拿得到一张脸和一个站姿，
 * 换机位就编。所以主体的参考图不是一个文件，而是**一组**：
 *
 *   基模头（master）—— 这个人的头本身。正面头肩特写，头颈完整，
 *                      中性背景、平光。只定"脸长什么样"，不参与运镜。
 *      │ 编辑（保持同一张脸，只改造型）
 *      ▼
 *   组头（head）    —— 某一套造型的头。一组一张。
 *      │ 编辑（同一张脸 + 同一套衣服，摊成三视图）
 *      ▼
 *   三视图（view）  —— 正面 / 侧面 / 背面，全身、并排、比例统一。一组可多张。
 *
 * 组 = 1 张组头 + N 张三视图。可以有多个组（不同造型 / 年龄段 / 季节），
 * 基模头只有一张 —— 它是"这个人"的锚，组是"这个人这一次长什么样"。
 *
 * **用的时候拼成一张**：每集从任一组里选一张三视图，把「组头 + 三视图」
 * 拼成 1376×768 的 16:9 参考图（左 1/3 头、右 2/3 三视图），这一集就用它当
 * <Picture N>。拼接在服务端做（`server/sheet.py`），前端只负责挑哪张。
 *
 * 为什么出图尺寸要跟着拼接槽位走（HEAD_GEN_SIZE / VIEW_GEN_SIZE）：
 * 拼的时候绝不允许拉伸，所以源图比例必须约等于槽位比例；差 1% 还能靠
 * contain 补一条同色缝，差 20% 就只能裁头或者留大片空白。**先定版式，
 * 再按版式出图**，比"先随便出图、拼的时候再想办法"省事得多。
 *
 * 为什么还要分三步出图、而不是一句话让模型画"左边头像右边三视图"：
 * 一句话的版式图里，脸只占很小一块，模型会把预算摊给三个全身，脸必然糊。
 * 先单独出一张头（整张画布只画一张脸），再拿它去编辑三视图，身份才稳得住
 * —— 这一步是"像不像"的分水岭，和"最终拼成一张"并不矛盾。
 * ------------------------------------------------------------------ */

export function emptySheet(): RefSheet {
  return { masterId: null, groups: [], active: null }
}

/* --------------------------- 版式 / 尺寸 --------------------------- */

/**
 * 拼接版式：1376×768（16:9），左 448 放组头、右 928 放三视图。
 *
 * ★ 必须与 `server/sheet.py` 的 `CANVAS_W/HEAD_W/VIEW_W` 逐字一致 ——
 *   前端按这个比例决定**出图尺寸**，后端按同一组数字真拼。两边一旦漂移，
 *   拼出来就会多一条缝或者裁掉一截。`refSheet.spec.ts` 里有一条测试
 *   直接读 python 文件核对。
 *
 * 448/1376 = 32.6%（"约 1/3"），928/1376 = 67.4%，四个数都是 32 的倍数。
 */
export const SHEET_LAYOUT = {
  /** 成品画布：1376×768 = 16:9 */
  width: 1376,
  height: 768,
  head: { x: 0, y: 0, w: 448, h: 768 },
  view: { x: 448, y: 0, w: 928, h: 768 }
} as const

/** 给人看的尺寸标签，界面上到处要写，别各写一份 */
export const SHEET_LABEL = `${SHEET_LAYOUT.width}×${SHEET_LAYOUT.height}（16:9）`

/**
 * 组头出图尺寸：736×1264 ≈ 7:12，和 448:768 同比例（误差 0.2%）。
 *
 * 像素量级仍是 720p 那一档（93 万）—— 出图耗时看的是总像素，不是宽高。
 */
export const HEAD_GEN_SIZE = '736x1264'

/**
 * 三视图出图尺寸：1056×880 ≈ 29:24，和 928:768 同比例（误差 0.7%）。
 *
 * 为什么不是 16:9：右侧槽位是 928×768（1.21），三个全身并排需要的是
 * **中等宽**而不是超宽。按 16:9 出图，contain 进 928×768 后上下各留 123px
 * 的空白，三个小人挤在中间一条 —— 白白浪费 1/3 的高度。
 */
export const VIEW_GEN_SIZE = '1056x880'

/** 老数据没有这个字段；顺手把缺字段补齐，读的地方就不用到处 `??` */
export function sheetOf(e: { refSheet?: RefSheet | null }): RefSheet {
  const s = e.refSheet
  if (!s) return emptySheet()
  return {
    masterId: s.masterId ?? null,
    groups: Array.isArray(s.groups) ? s.groups : [],
    active: s.active ?? null
  }
}

/** 组名按「造型 N」顺延，删过组也不会重号（取最大序号 + 1） */
export function nextGroupLabel(sheet: RefSheet): string {
  let max = 0
  for (const g of sheet.groups) {
    const m = g.label.match(/(\d+)\s*$/)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `造型 ${max + 1}`
}

export function findGroup(sheet: RefSheet, groupId: ID | null | undefined): RefSheetGroup | null {
  if (!groupId) return null
  return sheet.groups.find((g) => g.id === groupId) ?? null
}

export function addGroup(sheet: RefSheet, group: RefSheetGroup): RefSheet {
  return { ...sheet, groups: [...sheet.groups, group] }
}

export function removeGroup(sheet: RefSheet, groupId: ID): RefSheet {
  const groups = sheet.groups.filter((g) => g.id !== groupId)
  const active = sheet.active?.groupId === groupId ? null : sheet.active
  return { ...sheet, groups, active: active ?? null }
}

/** 改某一组（组名 / 组头 / 三视图） */
export function patchGroup(
  sheet: RefSheet,
  groupId: ID,
  patch: Partial<Omit<RefSheetGroup, 'id'>>
): RefSheet {
  return {
    ...sheet,
    groups: sheet.groups.map((g) => (g.id === groupId ? { ...g, ...patch } : g))
  }
}

/** 往某组追加一张三视图（同一张不会重复进组） */
export function addView(sheet: RefSheet, groupId: ID, assetId: ID): RefSheet {
  return {
    ...sheet,
    groups: sheet.groups.map((g) =>
      g.id === groupId ? { ...g, viewIds: g.viewIds.includes(assetId) ? g.viewIds : [...g.viewIds, assetId] } : g
    )
  }
}

/** 从某组里摘掉一张图（删素材前先把引用摘干净） */
export function dropAsset(sheet: RefSheet, assetId: ID): RefSheet {
  const groups = sheet.groups.map((g) => ({
    ...g,
    headId: g.headId === assetId ? null : g.headId,
    viewIds: g.viewIds.filter((id) => id !== assetId),
    // 删掉的正好是"拼这张"，就退回第一张；不清的话拼图会一直指向已删的图
    pickedViewId: g.pickedViewId === assetId ? null : (g.pickedViewId ?? null)
  }))
  const active = sheet.active?.assetId === assetId ? null : sheet.active
  return {
    ...sheet,
    masterId: sheet.masterId === assetId ? null : sheet.masterId,
    groups,
    active: active ?? null
  }
}

/** 这一组用到的所有 asset id（清组 / 换组时按它删文件） */
export function groupAssetIds(sheet: RefSheet, groupId: ID): ID[] {
  const g = findGroup(sheet, groupId)
  if (!g) return []
  return [...(g.headId ? [g.headId] : []), ...g.viewIds]
}

/** 整张表用到的所有 asset id（删主体时清理孤儿用） */
export function sheetAssetIds(sheet: RefSheet): ID[] {
  const out: ID[] = []
  if (sheet.masterId) out.push(sheet.masterId)
  for (const g of sheet.groups) {
    if (g.headId) out.push(g.headId)
    out.push(...g.viewIds)
  }
  return out
}

/* --------------------------- 提示词 --------------------------- */

/**
 * 设定 = 长相本身。动作 / 情绪 / 剧情 / 镜头都不是设定：
 * 它们属于**某一拍**（beat.visualDesc / direction），写进主体描述里会变成
 * "这个人永远在回头"—— 三视图和每一张关键帧都会跟着错。
 *
 * 这里只做**提醒**，不自动删词：硬删会把人名、服装上的字误伤掉，
 * 而且用户往往就是想在描述里写"左腿有支架"这种和姿态无关的细节。
 */
const ACTION_HINTS: Array<{ word: string; re: RegExp }> = [
  { word: '动作类', re: /正在|忽然|突然|缓缓|慢慢|转身|回头|走向|跑来|跑去|站起|坐下|举起|抬起|伸手|握着|拿着|推开|拉开车门/ },
  { word: '表情 / 情绪', re: /微笑|笑|皱眉|哭泣|流泪|愤怒|惊讶|恐惧|颤抖|眼神(?!.*(?:疤|痣|色))|怒视|凝视|疲惫/ },
  { word: '镜头 / 机位', re: /特写|近景|中景|远景|全景|俯拍|仰拍|镜头|机位|画外|前景|背景虚化|虚化/ },
  { word: '剧情', re: /刚刚|已经|曾经|后来|然后|此时|此刻|回忆|想起/ }
]

/** 描述里疑似"非设定"的词，空数组 = 干净 */
export function designIssues(desc: string | null | undefined): string[] {
  const s = (desc ?? '').trim()
  if (!s) return []
  return ACTION_HINTS.filter((h) => h.re.test(s)).map((h) => h.word)
}

/** 统一收尾：提示词片段拼接时不留下 ".. " 这种双标点 */
function join(parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join('. ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s+/g, ' ')
}

/**
 * 穿着类词：出现在**长相**描述里就是串味了。
 *
 * 串味的后果不是"多写了一句话"这么轻：基模头是头肩构图，模型为了把这一身
 * 衣服塞进画面，只能缩成半身或者干脆裁掉脑袋；而三视图那边又拿同一句话去画
 * 全身，两边的衣服从此不可能一致。所以这里要**点出来**，而不是默默吞掉。
 */
const COSTUME_HINTS: Array<{ word: string; re: RegExp }> = [
  {
    word: '上装',
    re: /衬衫|T恤|t恤|卫衣|毛衣|针织|西装|外套|风衣|大衣|夹克|皮衣|羽绒|制服|校服|睡衣|吊带|背心|上衣|马甲|冲锋衣|雨衣|白大褂|\b(?:jacket|coat|shirt|tee|hoodie|sweatshirt|sweater|cardigan|blazer|suit|uniform|gown|robe|vest|parka|trench|overalls)\b/i
  },
  {
    word: '下装',
    re: /长裤|短裤|牛仔裤|西裤|工装裤|裙子|连衣裙|半身裙|百褶裙|裤脚|裙摆|\b(?:jeans|trousers|pants|skirt|shorts|leggings|cargos?)\b/i
  },
  {
    word: '鞋帽配饰',
    re: /皮鞋|球鞋|运动鞋|靴子|高跟鞋|凉鞋|拖鞋|帽子|围巾|手套|皮带|腰带|领带|眼镜|耳环|项链|手表|背包|挎包|书包|\b(?:boots?|shoes?|sneakers?|loafers?|heels|hat|beret|scarf|gloves?|belt|necktie|glasses|earrings?|necklace|wristwatch|backpack|handbag)\b/i
  },
  {
    word: '穿着动作',
    re: /穿着|身穿|身着|披着|套着|裹着|戴着|换了(一)?身|一身[^，。；]{0,6}(衣|装|裤|裙)|\b(?:wearing|dressed in|outfit|wardrobe)\b/i
  }
]

/** 长相描述里疑似"穿着"的词，空数组 = 干净 */
export function costumeLeakInFace(desc: string | null | undefined): string[] {
  const s = (desc ?? '').trim()
  if (!s) return []
  return COSTUME_HINTS.filter((h) => h.re.test(s)).map((h) => h.word)
}

/**
 * 分句：逗号 / 顿号 / 分号 / 句号 / 换行，**标点跟着前一句走**。
 *
 * 带着标点分是为了"摘掉中间一句"之后前后能自然接上：
 *   "男性，穿着湿透的外套，神情疲惫" → ["男性，", "穿着湿透的外套，", "神情疲惫"]
 * 去掉第二句直接拼回去，就是"男性，神情疲惫"。
 */
const CLAUSE_RE = /[^，,；;。、\n]+[，,；;。、]?/g

function splitClauses(text: string | null | undefined): string[] {
  const s = (text ?? '').trim()
  if (!s) return []
  // 不 trim：英文"逗号 + 空格"的空格靠它留着，剪掉前一句后还能自然接上
  return (s.match(CLAUSE_RE) ?? [s]).filter((p) => p.trim().length > 0)
}

/**
 * 长在头上的东西：帽子 / 眼镜 / 耳饰 / 围巾 / 发饰。
 *
 * 它们在头肩构图里**看得见**，而且是认人的一部分 —— 从头部描述里剪掉，
 * 摘了眼镜、没了帽子，就不像这个人了。所以这一类不剪。
 */
const HEAD_WEAR_RE =
  /帽子|便帽|鸭舌帽|贝雷帽|毛线帽|头盔|眼镜|墨镜|耳环|耳钉|项链|围巾|头巾|头饰|发带|头绳|\b(?:hat|cap|beret|helmet|glasses|spectacles|sunglasses|earrings?|necklace|scarf|headband|tiara)\b/i

/**
 * 这一句是不是"身上的衣服"（该从头部描述里剪掉的）。
 *
 * 先看有没有头上的东西：有就整句留着（宁多留一句，别把特征剪掉）；
 * 剩下只要命中穿着类词就剪 —— 包括"脚踩皮鞋"这种只有鞋的句子，
 * 头部构图里出现鞋，模型只会把画布拉成全身。
 */
function isBodyCostume(clause: string): boolean {
  if (HEAD_WEAR_RE.test(clause)) return false
  return costumeLeakInFace(clause).length > 0
}

function trimTail(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[，,；;。、\s]+$/, '')
    .trim()
}

/**
 * 模型给的「长相 + 穿着」落地成两个字段。
 *
 * 提示词里已经写死"textDesc 绝不写穿着"，但真实模型（尤其中小模型）经常
 * 一句"男性，穿着湿透的外套，神情疲惫"全塞进 textDesc、costumeDesc 留空。
 * 用户只在前端点几下，没有义务去手工拆字段 —— 所以**入库这一刻就拆开**：
 *
 *   · textDesc  = 长相（把穿着那几句剪掉）
 *   · costumeDesc = 模型自己填的服装；没填就用剪下来的那几句兜底
 *
 * 场景 / 道具原样返回：它们没有"穿"，textDesc 里的"制服挂着"是环境的一部分。
 */
export function splitCostumeOf(
  type: string | null | undefined,
  textDesc: string | null | undefined,
  costumeDesc: string | null | undefined
): { textDesc: string; costumeDesc: string } {
  const face = (textDesc ?? '').trim()
  const wear = (costumeDesc ?? '').trim()
  if (type !== 'character') return { textDesc: face, costumeDesc: wear }
  return { textDesc: faceOnly(face), costumeDesc: wear || costumeOnly(face) }
}

/**
 * 长相里**只该给头部两步看**的那部分：把"穿什么"整句摘掉。
 *
 * 真实数据里极常见：`textDesc` 写成"男性，穿着湿透的外套，神情疲惫"，
 * 而 `costumeDesc` 是空的（模型抽取 / 本地化时没拆开）。头部两步直接吃
 * `textDesc`，提示词里就出现 `Face and head (appearance only): A man wearing
 * a soaked coat` —— 模型照着画了一件湿外套，头肩构图塞不下，只能把脑袋
 * 缩小或者裁掉，脸也就不像了。
 *
 * 所以这里不靠"再加一句别画衣服"（压不住描述原文），而是**把描述本身剪干净**。
 * 剪下来的部分不丢，见 `costumeOnly()` —— 三视图那一步照旧拿它画全身。
 */
export function faceOnly(desc: string | null | undefined): string {
  return trimTail(splitClauses(desc).filter((c) => !isBodyCostume(c)).join(''))
}

/** `faceOnly` 剪下来的那几句（穿什么），给三视图兜底用 */
export function costumeOnly(desc: string | null | undefined): string {
  return trimTail(splitClauses(desc).filter(isBodyCostume).join(''))
}

export interface SheetPromptCtx {
  name: string
  /** 只该是**长相**（脸 / 发型 / 肤色 / 年龄 / 体型骨架），不带穿着、不带动作 */
  design?: string
  /** 这一套造型穿什么。**只有三视图读它**，头部两步不读 */
  costume?: string
}

/**
 * 基模头：整张画布只画一张脸。
 *
 * 版式要求写死了三件事，少一件就会跑偏：
 *   ① 头 + 颈完整进画（"头颈完整可见"）—— 缺了它会裁成超大脸部特写；
 *   ② 正面平视 —— 侧一点都会让后面三视图的侧脸跟着歪；
 *   ③ 中性灰背景 + 平光 —— 有环境光就会把"棚拍"变成"剧照"。
 *
 * ★ 还写死了第四件：**这一步不设计服装**。头肩构图里塞不下整套衣服，模型只
 *   会把构图撑成半身、或者把领口画成一整件外套；穿着是下一步三视图的事。
 */
export function masterHeadPrompt(ctx: SheetPromptCtx): string {
  // 长相里如果混着"穿着湿透的外套"，原样喂进去模型就会画那件外套。
  // 头部这一步只认脸，所以先把衣服那几句剪掉（剪下来的给三视图，见 faceOnly）。
  const face = faceOnly(ctx.design)
  return join([
    'Character design reference, head-and-shoulders portrait, front view, facing the camera squarely',
    'Framing: the whole head and the full neck are visible, shoulders and upper chest included, clear margin above the hair',
    'Vertical 7:12 canvas: the head fills the upper two thirds, neck and shoulders carry the rest, no empty band at the top or bottom',
    'Do not crop the top of the head, do not zoom into the face, no extreme close-up',
    'Neutral light-gray seamless studio background, flat even soft frontal lighting, no colored gel, no rim light, no dramatic shadow',
    `Subject: ${ctx.name}`,
    face
      ? `Face and head (appearance only): ${face}`
      : 'Face and head: realistic, consistent, highly detailed',
    'Wardrobe: this step is about the head only, keep the garment out of frame except for a plain unseen collar line, do not design an outfit, do not invent clothing colors or patterns',
    'Neutral calm expression, eyes open, mouth closed, photorealistic, sharp focus',
    'No action, no gesture, no props, no text, no watermark'
  ])
}

/**
 * 组头：拿基模头当底图**编辑**出来的同一张脸。
 *
 * 编辑类提示词的重点全在"什么不许变"：只放改造型的那一条（variant），
 * 其余照抄基模头的版式。写"重新设计一个人"会直接换脸 —— 组就白建了。
 *
 * 「造型」在这一步只指**头部**（发型 / 胡须 / 妆 / 头饰 / 领口），
 * 一整套衣服留给三视图 —— 否则组头又会撑成半身，和三视图的衣服对不上。
 */
export function groupHeadPrompt(ctx: SheetPromptCtx & { variant?: string }): string {
  const variant = (ctx.variant ?? '').trim()
  return join([
    'Edit the reference portrait, keep the exact same person',
    'Must not change: face shape, bone structure, eyes, nose, mouth, eyebrows, skin tone, hairline, apparent age, gender, ethnicity',
    variant
      ? `Change only this, and only on the head: ${variant}`
      : 'Change only the head styling on top of the same face: hair styling, facial hair, make-up, headwear, collar, and nothing else',
    'Keep the framing identical to the reference: head-and-shoulders portrait, front view, whole head and full neck visible, shoulders included, same margin above the hair',
    'Do not zoom into the face, no extreme close-up',
    'Wardrobe: do not redesign the outfit in this step, the body costume is generated later on the full-body turnaround',
    'Neutral light-gray seamless background, flat even studio lighting',
    'No action, no gesture, no props, no text'
  ])
}

/**
 * 三视图：拿组头当底图**编辑**出来的全身转身图。
 *
 * 顺序固定"正 / 侧 / 背"，因为下游（导演台、关键帧）默认按这个顺序找侧脸与后脑；
 * 三张必须同高同比例，否则裁进画面里人就忽大忽小。
 *
 * ★ 这里是**唯一**读 `costume` 的一步：全身图才装得下一套衣服。没给服装时
 *   退回用长相那句兜底，但会在界面上提示先拆开 —— 长相里往往混着穿着。
 */
export function threeViewPrompt(ctx: SheetPromptCtx): string {
  // 长相和穿着分工：脸只喂 faceOnly，衣服优先用 costume，没填就从长相里
  // 剪下来的那几句兜底（原样喂 design 会把同一句"穿着"重复一遍）
  const face = faceOnly(ctx.design)
  const costume = (ctx.costume ?? '').trim() || costumeOnly(ctx.design)
  return join([
    'Character turnaround sheet of the same person as the reference portrait, full body',
    'Three views side by side on one canvas, left to right: FRONT view, SIDE view (true profile), BACK view',
    'All three views show the identical person: same face, same hairstyle, same costume, same colors, same body proportions, same height, feet aligned on the same ground line',
    'Pose: standing upright, relaxed natural A-pose, arms slightly away from the body, no walking, no gesture, no turning motion blur',
    'Framing: full body from top of head to soles of feet with clear margin, no crop, orthographic look, no perspective distortion',
    'Horizontal 29:24 canvas: the three figures share the width evenly, each occupying about one third, no wide empty margins on either side',
    `Subject: ${ctx.name}`,
    face ? `Face and head (appearance only): ${face}` : '',
    costume
      ? `Wardrobe and build (must be identical in all three views): ${costume}`
      : 'Wardrobe: simple neutral clothing, consistent across all three views',
    'Plain light-gray seamless backdrop, even studio lighting, soft contact shadow only',
    'No text, no labels, no ruler, no props, no extra characters, no dramatic lighting'
  ])
}

/** 三段提示词的口径统一走这里，界面和商店都别各写一份 */
export function sheetPromptOf(
  slot: SheetSlot,
  ctx: SheetPromptCtx & { variant?: string }
): string {
  if (slot === 'master') return masterHeadPrompt(ctx)
  if (slot === 'head') return groupHeadPrompt(ctx)
  return threeViewPrompt(ctx)
}

/* --------------------------- 参考图成色 --------------------------- */

/**
 * 当前挂在 <Picture N> 上的到底是什么。
 *
 *   compose —— 组头 + 三视图拼成的一张（头 + 身形 + 穿着都在里面）
 *   head    —— 单张头部（基模头 / 组头）：只有一张脸
 *   view    —— 单张三视图：有身子，但脸小且常被转过头，认脸不牢
 *   upload  —— 用户直接传的图，无从判断
 *   none    —— 没有参考图
 */
export type RefKind = 'compose' | 'head' | 'view' | 'upload' | 'none'

export function refKindOf(e: {
  pictureN?: number | null
  refSheet?: RefSheet | null
}): RefKind {
  if (!e.pictureN) return 'none'
  const s = sheetOf(e)
  const a = s.active
  if (!a) return 'upload'
  if (a.mode === 'compose') return 'compose'
  const g = findGroup(s, a.groupId)
  if (!g) return a.assetId === s.masterId ? 'head' : 'upload'
  if (g.headId === a.assetId) return 'head'
  if (g.viewIds.includes(a.assetId)) return 'view'
  return 'upload'
}

/**
 * 这个角色的参考图够不够用。返回一句人话，null = 没问题。
 *
 * 口径（2026-10-29 定）：**参考图必须是头 + 身子的拼接图**。
 * 只给一张头，模型拿不到身高、体型、衣服，每一段都会重新编一个穿法；
 * 只给三视图又认不准脸。所以只有 compose 算合格，其余一律提示。
 */
export function refProblemOf(e: {
  pictureN?: number | null
  refSheet?: RefSheet | null
  type?: string
}): string | null {
  if (e.type && e.type !== 'character') return null
  const kind = refKindOf(e)
  if (kind === 'none' || kind === 'compose') return null
  if (kind === 'head') return '参考图只有一张头：拿不到身高、体型和穿着，出片会每段换一套衣服'
  if (kind === 'view') return '参考图只有三视图：全身有穿着，但脸太小且多朝侧面，认脸不稳'
  return '参考图是直接上传的单张图：头和身子是否都在里面无从判断，建议走设定图组拼一张'
}
