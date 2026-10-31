import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  addGroup,
  addView,
  costumeLeakInFace,
  costumeOnly,
  designIssues,
  dropAsset,
  emptySheet,
  faceOnly,
  groupAssetIds,
  groupHeadPrompt,
  HEAD_GEN_SIZE,
  masterHeadPrompt,
  nextGroupLabel,
  patchGroup,
  refKindOf,
  refProblemOf,
  removeGroup,
  SHEET_LABEL,
  SHEET_LAYOUT,
  sheetAssetIds,
  sheetOf,
  sheetPromptOf,
  splitCostumeOf,
  threeViewPrompt,
  VIEW_GEN_SIZE
} from './refSheet'
import { parseSize } from './imageSize'
import type { RefSheetGroup } from './types'

const g = (id: string, head: string | null = null, views: string[] = []): RefSheetGroup => ({
  id,
  label: `造型 ${id.slice(1)}`,
  headId: head,
  viewIds: views,
  createdAt: 0
})

describe('设定图组：结构', () => {
  it('老实体没有 refSheet 时给一张空表，不返回 undefined', () => {
    const s = sheetOf({})
    expect(s.masterId).toBeNull()
    expect(s.groups).toEqual([])
  })

  it('refSheet 里缺 groups 时补空数组（别让 v-for 炸）', () => {
    const s = sheetOf({ refSheet: { masterId: 'a' } as never })
    expect(s.groups).toEqual([])
    expect(s.masterId).toBe('a')
  })

  it('组名按当前最大序号顺延：删掉中间某组后，新建的仍然往后排', () => {
    let s = emptySheet()
    s = addGroup(s, { ...g('g1'), label: '造型 1' })
    s = addGroup(s, { ...g('g2'), label: '造型 2' })
    s = removeGroup(s, 'g2')
    expect(nextGroupLabel(s)).toBe('造型 2')
    s = addGroup(s, { ...g('g9'), label: '造型 9' })
    expect(nextGroupLabel(s)).toBe('造型 10')
  })

  it('往组里追加三视图不会重复', () => {
    let s = addGroup(emptySheet(), g('g1'))
    s = addView(s, 'g1', 'v1')
    s = addView(s, 'g1', 'v1')
    expect(s.groups[0].viewIds).toEqual(['v1'])
  })

  it('删掉当前在用的那张图，active 要跟着失效（否则界面还挂着已经不存在的图）', () => {
    let s = addGroup(emptySheet(), g('g1', 'h1', ['v1']))
    s = { ...s, active: { groupId: 'g1', assetId: 'v1' } }
    s = dropAsset(s, 'v1')
    expect(s.active).toBeNull()
    expect(s.groups[0].viewIds).toEqual([])
  })

  it('删组时组头 / 三视图的 id 都还在（清文件要按它删），但 active 失效', () => {
    let s = addGroup(emptySheet(), g('g1', 'h1', ['v1', 'v2']))
    s = { ...s, active: { groupId: 'g1', assetId: 'h1' } }
    expect(groupAssetIds(s, 'g1')).toEqual(['h1', 'v1', 'v2'])
    s = removeGroup(s, 'g1')
    expect(s.active).toBeNull()
    expect(s.groups).toEqual([])
  })

  it('改组只动指定的那一组', () => {
    let s = addGroup(addGroup(emptySheet(), g('g1')), g('g2'))
    s = patchGroup(s, 'g2', { label: '雨夜', headId: 'h2' })
    expect(s.groups[0].label).toBe('造型 1')
    expect(s.groups[1]).toMatchObject({ label: '雨夜', headId: 'h2' })
  })

  it('sheetAssetIds 覆盖基模头 + 所有组的所有图', () => {
    let s = addGroup(emptySheet(), g('g1', 'h1', ['v1']))
    s = addGroup(s, g('g2', 'h2', ['v2', 'v3']))
    s = { ...s, masterId: 'm1' }
    expect(sheetAssetIds(s)).toEqual(['m1', 'h1', 'v1', 'h2', 'v2', 'v3'])
  })
})

describe('设定图组：提示词口径', () => {
  it('基模头要"头颈完整可见"，并且明确反对超大脸部特写', () => {
    const p = masterHeadPrompt({ name: 'Chen Mo', design: 'early thirties, short hair' })
    expect(p).toContain('the whole head and the full neck are visible')
    expect(p).toContain('no extreme close-up')
    expect(p).toContain('head-and-shoulders portrait')
  })

  it('基模头不写动作 / 镜头，背景是中性棚拍', () => {
    const p = masterHeadPrompt({ name: 'Chen Mo' })
    expect(p).toContain('Neutral light-gray seamless studio background')
    expect(p).toContain('No action, no gesture')
    expect(p).not.toMatch(/close-up shot|cinematic lighting|film still/i)
  })

  it('组头是"编辑"口气：先锁死不许变的部分，再改一条造型', () => {
    const p = groupHeadPrompt({ name: 'Chen Mo', variant: 'older by ten years' })
    expect(p).toContain('keep the exact same person')
    expect(p).toContain('Must not change')
    expect(p).toContain('Change only this, and only on the head: older by ten years')
    expect(p).toContain('Keep the framing identical to the reference')
  })

  it('组头不填变体时退回"只改造型"的保守指令，不会放任换脸', () => {
    const p = groupHeadPrompt({ name: 'Chen Mo' })
    expect(p).toContain('Change only the head styling on top of the same face')
    expect(p).not.toContain('Change only this,')
  })

  it('头部两步都不读服装：给了一整套衣服也只出现在三视图里', () => {
    const costume = 'grey cotton jacket, worn jeans'
    for (const p of [
      masterHeadPrompt({ name: 'Chen Mo', design: 'short black hair', costume }),
      groupHeadPrompt({ name: 'Chen Mo', design: 'short black hair', costume })
    ]) {
      expect(p).not.toContain(costume)
    }
    // 两步都把"别在这一步设计衣服"写死：头肩构图塞不下一身衣服，模型只会裁人
    expect(masterHeadPrompt({ name: 'Chen Mo' })).toContain('do not design an outfit')
    expect(groupHeadPrompt({ name: 'Chen Mo' })).toContain('do not redesign the outfit')
    expect(masterHeadPrompt({ name: 'Chen Mo' })).toContain('keep the garment out of frame')
  })

  it('长相里写了穿着：剪掉那句，头部两步不会照着画衣服', () => {
    // 项目里真实出现过的一句（陈默），costumeDesc 空、穿着写进了 textDesc
    const zh = '男性，穿着湿透的外套，神情疲惫，身上带有雨水痕迹。'
    expect(faceOnly(zh)).toBe('男性，神情疲惫，身上带有雨水痕迹')
    expect(costumeOnly(zh)).toBe('穿着湿透的外套')

    const en = 'A man wearing a soaked coat, with visible raindrops and an exhausted expression'
    expect(faceOnly(en)).toBe('with visible raindrops and an exhausted expression')
    expect(costumeOnly(en)).toBe('A man wearing a soaked coat')

    const p = masterHeadPrompt({ name: 'Chen Mo', design: en })
    expect(p).toContain('Face and head (appearance only): with visible raindrops')
    expect(p).not.toMatch(/soaked coat|wearing/i)
  })

  it('帽子 / 眼镜留在头部：剪掉就不像这个人了', () => {
    expect(faceOnly('短发，戴一副细框眼镜，左眉一道疤')).toBe('短发，戴一副细框眼镜，左眉一道疤')
    expect(faceOnly('短发，戴着细框眼镜')).toBe('短发，戴着细框眼镜')
  })

  it('整段都在写穿着：脸那行退回兜底，不必留一个空冒号', () => {
    const p = masterHeadPrompt({ name: 'Chen Mo', design: '身穿白大褂，脚踩皮鞋' })
    expect(p).not.toMatch(/white coat|白大褂|皮鞋/)
    expect(p).toContain('Face and head: realistic, consistent, highly detailed')
  })

  it('三视图把剪下来的穿着当兜底：衣服不会因为头部略过就丢', () => {
    const p = threeViewPrompt({ name: 'Chen Mo', design: 'A man wearing a soaked coat, tired eyes' })
    expect(p).toContain('Face and head (appearance only): tired eyes')
    expect(p).toContain('Wardrobe and build (must be identical in all three views): A man wearing a soaked coat')
  })

  it('模型把穿着写进长相：入库时就拆成两个字段', () => {
    const a = splitCostumeOf('character', '男性，穿着湿透的外套，神情疲惫', '')
    expect(a.textDesc).toBe('男性，神情疲惫')
    expect(a.costumeDesc).toBe('穿着湿透的外套')

    // 模型自己填了服装：以它为准，只把长相剪干净
    const b = splitCostumeOf('character', '男性，穿着湿透的外套，神情疲惫', '深灰外套')
    expect(b.textDesc).toBe('男性，神情疲惫')
    expect(b.costumeDesc).toBe('深灰外套')

    // 场景没有"穿"：原样返回，别把"墙上的制服"当成穿着剪掉
    const c = splitCostumeOf('scene', '便利店内部，制服挂在墙上', '')
    expect(c.textDesc).toBe('便利店内部，制服挂在墙上')
    expect(c.costumeDesc).toBe('')
  })

  it('三视图吃服装：长相和穿着分开喂，全身图才装得下', () => {
    const p = threeViewPrompt({
      name: 'Chen Mo',
      design: 'short black hair, pale skin',
      costume: 'grey cotton jacket, worn jeans'
    })
    expect(p).toContain('short black hair, pale skin')
    expect(p).toContain('Wardrobe and build (must be identical in all three views): grey cotton jacket, worn jeans')
  })

  it('三视图固定 正 / 侧 / 背 顺序，要求同高同比例同基线', () => {
    const p = threeViewPrompt({ name: 'Chen Mo', design: 'gray workwear' })
    expect(p).toContain('left to right: FRONT view, SIDE view (true profile), BACK view')
    expect(p).toContain('same height, feet aligned on the same ground line')
    expect(p).toContain('full body from top of head to soles of feet')
    expect(p).toContain('No text, no labels')
  })

  it('三视图不许有走 / 转身这类动作', () => {
    const p = threeViewPrompt({ name: 'Chen Mo' })
    expect(p).toContain('no walking, no gesture')
    expect(p).toContain('relaxed natural A-pose')
  })

  it('sheetPromptOf 按槽位分派，界面只调这一个入口', () => {
    expect(sheetPromptOf('master', { name: 'A' })).toBe(masterHeadPrompt({ name: 'A' }))
    expect(sheetPromptOf('view', { name: 'A' })).toBe(threeViewPrompt({ name: 'A' }))
  })
})

describe('主体描述只写设定', () => {
  it('干净的设定描述不报问题', () => {
    expect(designIssues('三十岁出头，短发，深灰工装外套，右眉一道旧疤')).toEqual([])
  })

  it('写动作 / 表情 / 镜头 / 剧情都要报出来', () => {
    expect(designIssues('正在转身回头')).toContain('动作类')
    expect(designIssues('微微一笑')).toContain('表情 / 情绪')
    expect(designIssues('中景，浅景深')).toContain('镜头 / 机位')
    expect(designIssues('曾经是一名警察')).toContain('剧情')
  })

  it('空描述不报问题（纯文本实体允许不填）', () => {
    expect(designIssues('')).toEqual([])
    expect(designIssues(null)).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * 版式与出图尺寸
 *
 * 这组测试守的是"拼接不能拉伸"这条硬线：出图比例必须贴着拼接槽位，
 * 而且前后端必须是同一组数字 —— 前端算 448、后端算 460，拼出来就会
 * 多一条 12px 的缝，或者把脸裁掉一截，谁都看不出来是哪边错了。
 * ------------------------------------------------------------------ */
describe('拼接版式：1376×768 的 16:9', () => {
  it('画布是 16:9、且正好 1376×768', () => {
    expect(SHEET_LAYOUT.width).toBe(1376)
    expect(SHEET_LAYOUT.height).toBe(768)
    // 1376×768 是需求定死的数；严格 16:9 是 1365.3×768。差 0.8%，
    // 所有编码器都按"最接近 16:9 的 32 倍数"处理，不会当成别的画幅。
    const ar = SHEET_LAYOUT.width / SHEET_LAYOUT.height
    expect(Math.abs(ar - 16 / 9)).toBeLessThan(0.02)
    expect(SHEET_LABEL).toContain('1376×768')
  })

  it('左头右身，两个槽位加起来正好铺满画布', () => {
    const { head, view, width } = SHEET_LAYOUT
    expect(head.x).toBe(0)
    expect(head.w + view.w).toBe(width)
    expect(view.x).toBe(head.w)
    expect(head.y).toBe(0)
    expect(head.h).toBe(768)
    expect(view.h).toBe(768)
  })

  it('左边约 1/3，右边约 2/3', () => {
    const r = SHEET_LAYOUT.head.w / SHEET_LAYOUT.width
    expect(r).toBeGreaterThan(0.3)
    expect(r).toBeLessThan(0.36)
  })

  it('槽位都是 32 的倍数（缩放不会落在半像素上）', () => {
    for (const v of [SHEET_LAYOUT.width, SHEET_LAYOUT.height, SHEET_LAYOUT.head.w, SHEET_LAYOUT.view.w]) {
      expect(v % 32).toBe(0)
    }
  })

  it('前端常量与 server/sheet.py 逐字一致', () => {
    const py = readFileSync(new URL('../../server/sheet.py', import.meta.url), 'utf8')
    expect(py).toContain(`CANVAS_W, CANVAS_H = ${SHEET_LAYOUT.width}, ${SHEET_LAYOUT.height}`)
    expect(py).toContain(`HEAD_W = ${SHEET_LAYOUT.head.w}`)
    expect(py).toContain(`VIEW_W = CANVAS_W - HEAD_W`)
  })
})

describe('出图尺寸必须贴着拼接槽位', () => {
  const aspectError = (size: string, boxW: number, boxH: number) => {
    const p = parseSize(size)!
    return Math.abs(p.w / p.h - boxW / boxH) / (boxW / boxH)
  }

  it('组头 736×1264 ≈ 7:12，和 448:768 差不到 1%', () => {
    expect(aspectError(HEAD_GEN_SIZE, SHEET_LAYOUT.head.w, SHEET_LAYOUT.head.h)).toBeLessThan(0.01)
  })

  it('三视图 1056×880 ≈ 29:24，和 928:768 差不到 1%', () => {
    expect(aspectError(VIEW_GEN_SIZE, SHEET_LAYOUT.view.w, SHEET_LAYOUT.view.h)).toBeLessThan(0.01)
  })

  it('两个尺寸都是 16 的倍数（后端 latent 1/16 下采样，非 16 倍数会被静默改掉）', () => {
    for (const s of [HEAD_GEN_SIZE, VIEW_GEN_SIZE]) {
      const p = parseSize(s)!
      expect(p.w % 16).toBe(0)
      expect(p.h % 16).toBe(0)
    }
  })

  it('两个尺寸都落在 720p 像素量级（出图耗时看总像素，不是宽高）', () => {
    for (const s of [HEAD_GEN_SIZE, VIEW_GEN_SIZE]) {
      const p = parseSize(s)!
      const px = p.w * p.h
      expect(Math.abs(px - 1280 * 720) / (1280 * 720)).toBeLessThan(0.12)
    }
  })
})

describe('长相与服装不许串味', () => {
  it('长相里出现穿着要能点出来（串味会让头部图和全身图打架）', () => {
    expect(costumeLeakInFace('short black hair, pale skin')).toEqual([])
    expect(costumeLeakInFace('short black hair, grey work jacket')).toContain('上装')
    expect(costumeLeakInFace('身穿白大褂，戴口罩')).toContain('上装')
    expect(costumeLeakInFace('他戴着一副细框眼镜')).toContain('鞋帽配饰')
  })

  it('空的 / 缺省的描述不报串味', () => {
    expect(costumeLeakInFace('')).toEqual([])
    expect(costumeLeakInFace(null)).toEqual([])
    expect(costumeLeakInFace(undefined)).toEqual([])
  })
})

describe('参考图必须是「头 + 身子」拼接', () => {
  const sheet = {
    masterId: 'a_master',
    groups: [{ id: 'g1', label: '造型 1', headId: 'a_head', viewIds: ['a_view'], createdAt: 0 }],
    active: null
  }

  it('只给一张头，就明确说缺身高体型和穿着', () => {
    const e = {
      type: 'character',
      pictureN: 3,
      refSheet: { ...sheet, active: { groupId: 'g1', assetId: 'a_head', mode: 'single' as const } }
    }
    expect(refKindOf(e)).toBe('head')
    expect(refProblemOf(e)).toContain('只有一张头')
  })

  it('只给三视图：有穿着但认脸不稳', () => {
    const e = {
      type: 'character',
      pictureN: 3,
      refSheet: { ...sheet, active: { groupId: 'g1', assetId: 'a_view', mode: 'single' as const } }
    }
    expect(refKindOf(e)).toBe('view')
    expect(refProblemOf(e)).toContain('只有三视图')
  })

  it('拼接图才算合格；没有参考图也不算问题（纯文本实体合法）', () => {
    const ok = {
      type: 'character',
      pictureN: 3,
      refSheet: {
        ...sheet,
        active: { groupId: 'g1', assetId: 'a_comp', mode: 'compose' as const, viewId: 'a_view' }
      }
    }
    expect(refKindOf(ok)).toBe('compose')
    expect(refProblemOf(ok)).toBeNull()
    expect(refProblemOf({ type: 'character', pictureN: null })).toBeNull()
  })

  it('场景 / 道具不走设定图组，不该被这条规则误伤', () => {
    const scene = { type: 'scene', pictureN: 1, refSheet: null }
    expect(refProblemOf(scene)).toBeNull()
  })

  it('直接上传、没有设定图组的图：认不出头和身子在不在里面', () => {
    const e = { type: 'character', pictureN: 2, refSheet: null }
    expect(refKindOf(e)).toBe('upload')
    expect(refProblemOf(e)).toContain('单张图')
  })
})
