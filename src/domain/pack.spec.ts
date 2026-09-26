import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './types'
import type { Asset, Entity } from './types'
import {
  alignMiniMaxFrameCount,
  buildDirectorPack,
  durationToMiniMaxFrames,
  MAX_REFERENCE_IMAGES,
  PACK_FORMAT,
  preferredDurationSecFromFrames,
  R2V_TASK_TYPE,
  snapCanvas,
  extractPictureNumbers
} from './pack'

function ent(patch: Partial<Entity> & { id: string }): Entity {
  return {
    projectId: 'p1',
    name: patch.id,
    type: 'character',
    kind: 'non_speaking',
    subjectN: null,
    sx: null,
    pictureN: null,
    voiceDesc: null,
    textDesc: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch
  } as Entity
}

function asset(pictureN: number): Asset {
  return {
    id: `a${pictureN}`,
    projectId: 'p1',
    pictureN,
    fileName: `Picture${pictureN}.png`,
    originalName: `角色${pictureN}.png`,
    label: `角色${pictureN}`,
    // 打不进包的素材等于没有素材：导入端会把对应槽位静默清空
    blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]),
    createdAt: 1
  }
}

const seg = (patch: Partial<Parameters<typeof buildDirectorPack>[0]['segments'][number]> = {}) => ({
  id: 'g1',
  frames: 141,
  prompt: 'subject_definitions:\n<Subject 1> is A in <Picture 1>.',
  refPrev: false,
  continuityFromPrev: false,
  continuityToNext: false,
  entities: [],
  ...patch
})

describe('帧长度换算', () => {
  it('durationToMiniMaxFrames 永远落在 17k+5 网格上', () => {
    for (let s = 0.2; s <= 6; s += 0.1) {
      const fc = durationToMiniMaxFrames(s)
      expect(fc % 17).toBe(5)
      expect(fc).toBeGreaterThanOrEqual(5)
    }
  })

  it('preferredDurationSecFromFrames 能被对面算回原帧数', () => {
    for (let k = 0; k <= 8; k++) {
      const frames = 5 + 17 * k
      const sec = preferredDurationSecFromFrames(frames)
      expect(durationToMiniMaxFrames(sec)).toBe(frames)
    }
  })

  // 5.875 也能算回 141，但对面的 preferredDurationSecFromFrames 先试整数秒、
  // 再按 0.1 步长从 5.6 开始扫，第一个命中的就是 5.6。我们发的必须和它一致，
  // 否则导入瞬间 frameCount 会被对面 UI 重算覆盖。
  it('141 帧写成 5.6s，与对面反解算法一致', () => {
    expect(preferredDurationSecFromFrames(141)).toBe(5.6)
    expect(durationToMiniMaxFrames(5.6)).toBe(141)
    expect(durationToMiniMaxFrames(5.875)).toBe(141)
  })

  it('引用上段（17k）家族会被向上对齐到 17k+5', () => {
    expect(alignMiniMaxFrameCount(136)).toBe(141)
    expect(alignMiniMaxFrameCount(141)).toBe(141)
    expect(alignMiniMaxFrameCount(3)).toBe(5)
  })
})

describe('画布尺寸', () => {
  it('必须是 32 的倍数且不小于 32', () => {
    expect(snapCanvas(864, 864)).toBe(864)
    expect(snapCanvas(850, 864)).toBe(864) // 向上就近取整
    expect(snapCanvas(1, 864)).toBe(32)
    expect(snapCanvas(-100, 864)).toBe(32) // 负数也不能低于下限
  })

  it('空值走默认尺寸，不当成 0', () => {
    expect(snapCanvas(0, 864)).toBe(864)
    expect(snapCanvas(Number.NaN, 864)).toBe(864)
  })
})

describe('参考图编号提取', () => {
  it('从提示词里读 <Picture N>', () => {
    expect(extractPictureNumbers('<Picture 1> 和 <Picture 3>')).toEqual([1, 3])
    expect(extractPictureNumbers('<Picture 2><Picture 2>')).toEqual([2])
    expect(extractPictureNumbers('没有参考')).toEqual([])
  })
})

describe('buildDirectorPack', () => {
  it('包内路径全部 ASCII', () => {
    const res = buildDirectorPack({
      projectName: '楚辞 · 第一集',
      settings: DEFAULT_SETTINGS,
      segments: [seg(), seg({ id: 'g2', prompt: '<Picture 2>', frames: 124 })],
      assets: [asset(1), asset(2)]
    })
    for (const e of res.entries) {
      expect(e.path).toMatch(/^[A-Za-z0-9_./]+$/)
    }
  })

  it('timeline 是 version 5 / prompt_batch / segment 编辑模式', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [seg()],
      assets: [asset(1)]
    })
    expect(res.timeline.version).toBe(5)
    expect(res.timeline.timelineMode).toBe('prompt_batch')
    expect(res.timeline.editMode).toBe('segment')
    expect(res.timeline.totalFrames).toBe(141)
  })

  it('参考图写在每个 segment 上，且 index = N - 1', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [seg()],
      assets: [asset(1), asset(2)]
    })
    const segments = res.timeline.segments as Array<Record<string, any>>
    expect(segments[0].refs).toEqual([
      {
        index: 0,
        imageFile: 'shared_params/Picture1.png',
        fileName: 'Picture1.png',
        type: 'input',
        subfolder: 'shared_params'
      }
    ])
    // global 兜底：commonEnabled 打开，全部素材都进 global.refs
    expect((res.timeline.global as any).commonEnabled).toBe(true)
    expect((res.timeline.global as any).refs).toHaveLength(2)
  })

  it('提示词引用了没有素材的编号会告警，且不写空槽位', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [seg({ prompt: '<Picture 5>' })],
      assets: [asset(1)]
    })
    expect(res.warnings.some((w) => w.includes('5'))).toBe(true)
    const segments = res.timeline.segments as Array<Record<string, any>>
    expect(segments[0].refs).toHaveLength(0)
  })

  it('超过 9 号素材会被提示', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [seg({ prompt: `<Picture ${MAX_REFERENCE_IMAGES + 1}>` })],
      assets: [asset(MAX_REFERENCE_IMAGES + 1)]
    })
    expect(res.warnings.some((w) => w.includes(String(MAX_REFERENCE_IMAGES)))).toBe(true)
  })

  it('segments 的帧数落在 17k+5 上，durationSec 能算回来', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [seg({ frames: 136 }), seg({ id: 'g2', frames: 141 })],
      assets: [asset(1)]
    })
    const segments = res.timeline.segments as Array<Record<string, any>>
    for (const s of segments) {
      expect(s.frameCount % 17).toBe(5)
      expect(durationToMiniMaxFrames(s.durationSec)).toBe(s.frameCount)
    }
    expect(res.warnings.some((w) => w.includes('136'))).toBe(true)
  })

  it('只要有连续性就打开总开关；单段强制关闭', () => {
    const two = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [seg(), seg({ id: 'g2', continuityFromPrev: true, continuityToNext: true })],
      assets: []
    })
    expect((two.timeline.output as any).continuityEnabled).toBe(true)
    const segments = two.timeline.segments as Array<Record<string, any>>
    expect(segments[0].continuityFromPrev).toBe(false)
    expect(segments[1].continuityFromPrev).toBe(true)

    const one = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [seg({ continuityToNext: true })],
      assets: []
    })
    expect((one.timeline.output as any).continuityEnabled).toBe(false)
  })

  it('pack.json 用对面的 format 与任务类型标签', () => {
    const res = buildDirectorPack({ settings: DEFAULT_SETTINGS, segments: [seg()], assets: [] })
    expect(res.packJson.format).toBe(PACK_FORMAT)
    expect(res.packJson.formatVersion).toBe(1)
    expect((res.packJson.widgets as any).task_type).toBe(R2V_TASK_TYPE)
    expect(R2V_TASK_TYPE.split(' — ')[0]).toBe('r2v')
  })

  it('必备条目齐全', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [seg()],
      assets: [asset(1)]
    })
    const paths = res.entries.map((e) => e.path)
    expect(paths).toContain('pack.json')
    expect(paths).toContain('timeline.json')
    expect(paths).toContain('shared_params/shared_params.json')
    expect(paths).toContain('shared_params/Picture1.png')
    expect(paths).toContain('asset_groups/01/group.json')
  })

  it('实体绑定的素材编号也会进 refs（提示词没写 <Picture N> 时）', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [seg({ prompt: 'subject_definitions:\n纯文本', entities: [ent({ id: 'e1', pictureN: 3 })] })],
      assets: [asset(3)]
    })
    const segments = res.timeline.segments as Array<Record<string, any>>
    expect(segments[0].refs).toHaveLength(1)
    expect(segments[0].refs[0].imageFile).toBe('shared_params/Picture3.png')
  })
})
