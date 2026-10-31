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

function sceneAsset(): Asset {
  return {
    id: 'scene0',
    projectId: 'p1',
    pictureN: 0,
    fileName: 'scene_b1_12345.png',
    originalName: 'scene.png',
    label: '场景图',
    blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]),
    kind: 'scene',
    refId: 'b1',
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

  it('连续性默认不焊（对齐下段默认关）；只有显式 weldSeams 才打开总开关', () => {
    const segments = [seg(), seg({ id: 'g2', continuityFromPrev: true, continuityToNext: true })]

    // 首跑/普通出片：导演节点的「对齐下段」默认关，包里也不写 —— 否则会因
    // "下一段没有首帧缓存"在 Phase 1 之前直接中止。
    const plain = buildDirectorPack({ settings: DEFAULT_SETTINGS, segments, assets: [] })
    expect((plain.timeline.output as any).continuityEnabled).toBe(false)
    const plainSegs = plain.timeline.segments as Array<Record<string, any>>
    expect(plainSegs[0].continuityFromPrev).toBe(false)
    expect(plainSegs[1].continuityFromPrev).toBe(false)

    // 重抽某段、要接到已出片的下一段时才显式焊接。
    const welded = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments,
      assets: [],
      weldSeams: true
    })
    expect((welded.timeline.output as any).continuityEnabled).toBe(true)
    const weldedSegs = welded.timeline.segments as Array<Record<string, any>>
    expect(weldedSegs[0].continuityFromPrev).toBe(false)
    expect(weldedSegs[1].continuityFromPrev).toBe(true)

    const one = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [seg({ continuityToNext: true })],
      assets: [],
      weldSeams: true
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

  it('场景图（pictureN=0, kind=scene）不进 reference 槽、不打包、不触发告警', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [seg()], // 默认 prompt 里有 <Picture 1>
      assets: [asset(1), sceneAsset()]
    })
    // global.refs 只有真正的主体参考图
    const globalRefs = (res.timeline.global as any).refs as Array<{ imageFile: string }>
    expect(globalRefs).toHaveLength(1)
    expect(globalRefs[0].imageFile).toBe('shared_params/Picture1.png')
    // 场景图文件不写进包
    const paths = res.entries.map((e) => e.path)
    expect(paths).toContain('shared_params/Picture1.png')
    expect(paths.some((p) => p.startsWith('shared_params/scene_'))).toBe(false)
    // 不应因场景图触发任何缺素材 / 超 9 告警
    expect(res.warnings).toHaveLength(0)
  })
})

describe('段级参考素材（关键帧 / 音视频）', () => {
  const blob = (s: string) => new Blob([new Uint8Array([1, 2, 3])], { type: s })

  it('首帧 → genImage / startImage，尾帧 → endImage，锚点 → kfImages（带帧位）', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [
        seg({
          frames: 141,
          keyframes: [
            { originalName: 'a.png', blob: blob('image/png'), role: 'start' },
            { originalName: 'b.jpg', blob: blob('image/jpeg'), role: 'anchor', frameIdx: 40 },
            { originalName: 'c.png', blob: blob('image/png'), role: 'end' }
          ]
        })
      ],
      assets: []
    })
    const segments = res.timeline.segments as Array<Record<string, any>>
    expect(segments[0].genImage.imageFile).toBe('asset_groups/seg01/start.png')
    expect(segments[0].startImage.imageFile).toBe('asset_groups/seg01/start.png')
    expect(segments[0].endImage.imageFile).toBe('asset_groups/seg01/end.png')
    // r2v 只认 kfImages：首帧 / 尾帧也必须以锚点身份出现
    expect(segments[0].kfImages.map((k: any) => [k.index, k.frameIdx, k.imageFile])).toEqual([
      [0, 0, 'asset_groups/seg01/start.png'],
      // jpeg 统一成 jpg（导入端按扩展名判断能不能解码）
      [1, 40, 'asset_groups/seg01/kf1.jpg'],
      [2, 140, 'asset_groups/seg01/end.png']
    ])

    const paths = res.entries.map((e) => e.path)
    expect(paths).toContain('asset_groups/seg01/start.png')
    expect(paths).toContain('asset_groups/seg01/end.png')
    expect(paths).toContain('asset_groups/seg01/kf1.jpg')
    // group.json 里也要有同样一套，原版插件只认它
    const group = res.entries.find((e) => e.path === 'asset_groups/01/group.json')
    expect(group).toBeTruthy()
    // 默认提示词里写着 <Picture 1> 而没有素材，这条老告警不算关键帧的锅
    expect(res.warnings.join('\n')).not.toContain('关键帧')
  })

  it('链内段又挂了段首关键帧：提醒"上段尾帧 + 本段首帧"两个起点会打架', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      // 只有显式焊接（weldSeams）时，continuityFromPrev 才真的当"链内"
      weldSeams: true,
      segments: [
        seg({ id: 'g1', frames: 141 }),
        seg({
          id: 'g2',
          frames: 141,
          refPrev: true,
          continuityFromPrev: true,
          keyframes: [{ originalName: 's.png', blob: blob('image/png'), role: 'start' }]
        })
      ],
      assets: []
    })
    expect(res.warnings.join('\n')).toContain('链内')
  })

  it('锚点帧位夹到段内，越界不会丢锚点', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [
        seg({
          frames: 124,
          keyframes: [
            { originalName: 'a.png', blob: blob('image/png'), role: 'start' },
            { originalName: 'b.png', blob: blob('image/png'), role: 'anchor', frameIdx: 9999 }
          ]
        })
      ],
      assets: []
    })
    const s = (res.timeline.segments as Array<Record<string, any>>)[0]
    // [0] 是首帧，[1] 才是被夹住的锚点
    expect(s.kfImages.map((k: any) => k.frameIdx)).toEqual([0, 123])
  })

  it('首帧带真实帧位（段首有预备镜头）时按帧位落点，不再写死 0', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [
        seg({
          frames: 141,
          keyframes: [
            { originalName: 'a.png', blob: blob('image/png'), role: 'start', frameIdx: 7 },
            { originalName: 'b.png', blob: blob('image/png'), role: 'end', frameIdx: 120 }
          ]
        })
      ],
      assets: []
    })
    const s = (res.timeline.segments as Array<Record<string, any>>)[0]
    // 段首 / 段尾的身份照旧（genImage / endImage 还在），但 kfImages 里是真实帧位
    expect(s.startImage.imageFile).toBe('asset_groups/seg01/start.png')
    expect(s.endImage.imageFile).toBe('asset_groups/seg01/end.png')
    expect(s.kfImages.map((k: any) => k.frameIdx)).toEqual([7, 120])
  })

  it('只有指定帧时不造 startImage / endImage，帧位照样进 kfImages', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [
        seg({
          frames: 124,
          keyframes: [
            { originalName: 'a.png', blob: blob('image/png'), role: 'anchor', frameIdx: 0 },
            { originalName: 'b.png', blob: blob('image/png'), role: 'anchor', frameIdx: 60 }
          ]
        })
      ],
      assets: []
    })
    const s = (res.timeline.segments as Array<Record<string, any>>)[0]
    // 没有"段首 / 段尾"身份就不写起始 / 收尾画面（r2v 只吃 kfImages）
    expect(s.startImage).toBeNull()
    expect(s.endImage).toBeNull()
    expect(s.genImage.imageFile).toBe('')
    expect(s.kfImages.map((k: any) => [k.frameIdx, k.imageFile])).toEqual([
      [0, 'asset_groups/seg01/kf1.png'],
      [60, 'asset_groups/seg01/kf2.png']
    ])
  })

  it('音视频进 refAudios / refVideos，各自从 0 编槽', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [
        seg({
          materials: [
            { originalName: 'voice.wav', blob: blob('audio/wav'), media: 'audio' },
            { originalName: 'ref.mov', blob: blob('video/quicktime'), media: 'video' },
            { originalName: 'voice2.mp3', blob: blob('audio/mpeg'), media: 'audio' }
          ]
        })
      ],
      assets: []
    })
    const s = (res.timeline.segments as Array<Record<string, any>>)[0]
    expect(s.refAudios.map((x: any) => [x.index, x.audioFile])).toEqual([
      [0, 'asset_groups/seg01/Audio1.wav'],
      [1, 'asset_groups/seg01/Audio2.mp3']
    ])
    expect(s.refVideos.map((x: any) => [x.index, x.videoFile])).toEqual([
      [0, 'asset_groups/seg01/Video1.mov']
    ])
    const paths = res.entries.map((e) => e.path)
    expect(paths).toContain('asset_groups/seg01/Audio1.wav')
    expect(paths).toContain('asset_groups/seg01/Video1.mov')
  })

  it('音视频带上作用起始帧（段内绝对帧位，越界夹到最后一帧）', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [
        seg({
          frames: 141,
          materials: [
            { originalName: 'voice.wav', blob: blob('audio/wav'), media: 'audio', frameIdx: 36 },
            { originalName: 'ref.mp4', blob: blob('video/mp4'), media: 'video', frameIdx: 9999 }
          ]
        })
      ],
      assets: []
    })
    const s = (res.timeline.segments as Array<Record<string, any>>)[0]
    expect(s.refAudios[0].startFrameIdx).toBe(36)
    expect(s.refVideos[0].startFrameIdx).toBe(140)
  })

  it('主体没参考图时给一条汇总警告（按名字去重，不逐段刷屏）', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [
        seg({
          entities: [ent({ id: 'c1', name: '楚辞', pictureN: null }), ent({ id: 'c2', name: '毒尊', pictureN: 9 })],
          prompt: 'subject_definitions://n无图'
        }),
        seg({
          id: 'g2',
          entities: [ent({ id: 'c1', name: '楚辞', pictureN: null })],
          prompt: 'subject_definitions://n无图'
        })
      ],
      assets: []
    })
    const text = res.warnings.join('\n')
    expect(text).toContain('这些主体还没有参考图：楚辞、毒尊')
    // 同一个主体只出现一次
    expect(text.match(/楚辞/g)?.length).toBe(1)
  })

  it('主体有参考图（Picture N 有素材）时不报这条警告', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [
        seg({
          entities: [ent({ id: 'c1', name: '楚辞', pictureN: 1 })],
          prompt: 'subject_definitions://n<Subject 1> is 楚辞 in <Picture 1>.'
        })
      ],
      assets: [asset(1)]
    })
    expect(res.warnings.join('\n')).not.toContain('还没有参考图')
  })

  it('没有本体时给警告，而不是假装打进包了', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [
        seg({
          keyframes: [{ originalName: 'a.png', role: 'start' }],
          materials: [{ originalName: 'v.mp4', media: 'video' }]
        })
      ],
      assets: []
    })
    expect(res.warnings.join('\n')).toContain('首帧关键帧没有图片本体')
    expect(res.warnings.join('\n')).toContain('参考视频')
  })

  it('同角色重复的关键帧降级成锚点，不静默丢失', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [
        seg({
          frames: 141,
          keyframes: [
            { originalName: 'a.png', blob: blob('image/png'), role: 'start' },
            { originalName: 'b.png', blob: blob('image/png'), role: 'start', frameIdx: 20 }
          ]
        })
      ],
      assets: []
    })
    const s = (res.timeline.segments as Array<Record<string, any>>)[0]
    expect(s.startImage.imageFile).toBe('asset_groups/seg01/start.png')
    // 首帧 + 被降级的重复项
    expect(s.kfImages.map((k: any) => k.frameIdx)).toEqual([0, 20])
  })

  /* ---------------- 起始帧 + 强度：两个正交参数，不再二选一 ---------------- */

  it('强度低于满值的关键帧仍进 kfImages，只改 visual_noise_aug，不抢 Picture 编号', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [
        seg({
          frames: 141,
          prompt: 'plain text',
          keyframes: [
            { originalName: 'a.png', blob: blob('image/png'), role: 'anchor', frameIdx: 40, strength: 50 }
          ]
        })
      ],
      assets: []
    })
    const s = (res.timeline.segments as Array<Record<string, any>>)[0]
    // 段内素材不再挤进 refs：编号留给主体参考图
    expect(s.refs).toEqual([])
    expect(s.kfImages.map((k: any) => [k.fileName, k.frameIdx, k.strength, k.visualNoiseAug]))
      .toEqual([['kf1.png', 40, 50, 0.5]])
  })

  it('满强度关键帧写 0.999（与 ComfyUI 默认一致），起始帧照旧生效', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [
        seg({
          frames: 141,
          prompt: 'plain text',
          keyframes: [
            { originalName: 'a.png', blob: blob('image/png'), role: 'anchor', frameIdx: 17, strength: 100 }
          ]
        })
      ],
      assets: []
    })
    const s = (res.timeline.segments as Array<Record<string, any>>)[0]
    expect(s.kfImages[0].frameIdx).toBe(17)
    expect(s.kfImages[0].visualNoiseAug).toBe(0.999)
  })

  it('强度调低的图片仍占首尾身份（强度不改变它落在哪一帧）', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [
        seg({
          frames: 141,
          prompt: 'plain text',
          keyframes: [
            { originalName: 'a.png', blob: blob('image/png'), role: 'start', strength: 40 }
          ]
        })
      ],
      assets: []
    })
    const s = (res.timeline.segments as Array<Record<string, any>>)[0]
    expect(s.startImage.imageFile).toBe('asset_groups/seg01/start.png')
    expect(s.kfImages.map((k: any) => [k.fileName, k.frameIdx, k.visualNoiseAug])).toEqual([
      ['start.png', 0, 0.4]
    ])
  })

  it('视频按强度进 kfVideos；音频满强度固定音轨、低于满值走 refAudios', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [
        seg({
          prompt: 'plain text',
          materials: [
            {
              originalName: 'clip.mp4',
              blob: blob('video/mp4'),
              media: 'video',
              frameIdx: 30,
              strength: 90
            },
            {
              originalName: 'line.wav',
              blob: blob('audio/wav'),
              media: 'audio',
              frameIdx: 12,
              strength: 100
            },
            {
              originalName: 'tone.wav',
              blob: blob('audio/wav'),
              media: 'audio',
              frameIdx: 20,
              strength: 20
            }
          ]
        })
      ],
      assets: []
    })
    const s = (res.timeline.segments as Array<Record<string, any>>)[0]
    // 关键帧通道读 frameIdx（段内像素帧），不是 startFrameIdx
    expect(s.kfVideos.map((v: any) => [v.index, v.frameIdx, v.fileName, v.visualNoiseAug])).toEqual([
      [0, 30, 'KfVideo1.mp4', 0.899]
    ])
    expect(s.kfAudios.map((a: any) => [a.index, a.frameIdx, a.fileName])).toEqual([
      [0, 12, 'KfAudio1.wav']
    ])
    // 低强度音频只能走参考音色，但起始帧照样写下来
    expect(s.refAudios.map((a: any) => [a.index, a.startFrameIdx, a.fileName])).toEqual([
      [0, 20, 'Audio1.wav']
    ])
  })

  it('作用方式 = 参考的音视频不占时间轴：强度调满也走参考通道', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [
        seg({
          prompt: 'plain text',
          materials: [
            {
              originalName: 'timbre.wav',
              blob: blob('audio/wav'),
              media: 'audio',
              frameIdx: 0,
              strength: 100,
              actAs: 'reference'
            },
            {
              originalName: 'motion.mp4',
              blob: blob('video/mp4'),
              media: 'video',
              frameIdx: 18,
              strength: 100,
              actAs: 'reference'
            }
          ]
        })
      ],
      assets: []
    })
    const s = (res.timeline.segments as Array<Record<string, any>>)[0]
    // 参考音色：进 refAudios，绝不抢这段的音轨
    expect(s.kfAudios).toEqual([])
    expect(s.refAudios.map((a: any) => [a.index, a.startFrameIdx, a.fileName])).toEqual([
      [0, 0, 'Audio1.wav']
    ])
    // 参考动作同理：强度 100 也不进 kfVideos
    expect(s.kfVideos).toEqual([])
    expect(s.refVideos.map((v: any) => [v.index, v.startFrameIdx, v.fileName])).toEqual([
      [0, 18, 'Video1.mp4']
    ])
  })
})

/**
 * 段级「参考方式」素材：不落帧位，靠 Picture 编号进本段 refs。
 *
 * 它和提示词里的 <Picture N> 是同一个池子，所以最容易出错的不是"有没有带"，
 * 而是"带了几遍"和"提示词没点名"——这两件事导入端都不会报错，只会静默忽略。
 */
describe('段级参考方式素材', () => {
  const refImg = (pictureN: number) => ({ pictureN, fileName: `Picture${pictureN}.png`, blob: new Blob(['x']) })

  it('并进本段 refs，index 按 pictureN-1，文件写进 shared_params', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [seg({ prompt: 'subject_definitions:/n<Subject 1> is A in <Picture 1>.', refImages: [refImg(3)] })],
      assets: [asset(1), asset(3)]
    })
    const s = (res.timeline.segments as Array<Record<string, any>>)[0]
    expect(s.refs.map((r: any) => r.index)).toEqual([0, 2])
    expect(s.refs.find((r: any) => r.index === 2).imageFile).toBe('shared_params/Picture3.png')
    expect(res.entries.map((e) => e.path)).toContain('shared_params/Picture3.png')
    // 参考方式不落帧位：不进 kfImages
    expect(s.kfImages).toEqual([])
  })

  it('提示词里已经点名过的编号不重复塞进 refs', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [seg({ prompt: '<Picture 3> 站在门口。', refImages: [refImg(3)] })],
      assets: [asset(3)]
    })
    const s = (res.timeline.segments as Array<Record<string, any>>)[0]
    expect(s.refs.filter((r: any) => r.index === 2)).toHaveLength(1)
    // 点名了就不用提醒
    expect(res.warnings.some((w) => w.includes('没有出现 <Picture 3>'))).toBe(false)
  })

  it('提示词没点名就报警告：有图没点名，模型会当它不存在', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [seg({ prompt: '一扇门被推开。', refImages: [refImg(2)] })],
      assets: [asset(2)]
    })
    expect(res.warnings.some((w) => w.includes('Picture2') && w.includes('没有出现'))).toBe(true)
  })

  it('编号越过 9 个槽位时不进 refs，并明说要压缩编号', () => {
    const over = MAX_REFERENCE_IMAGES + 1
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [seg({ prompt: '一扇门被推开。', refImages: [refImg(over)] })],
      assets: [asset(over)]
    })
    const s = (res.timeline.segments as Array<Record<string, any>>)[0]
    expect(s.refs).toEqual([])
    expect(res.warnings.some((w) => w.includes('超过'))).toBe(true)
  })
})

/**
 * 包内文件名与编号的关系。
 *
 * 编号压缩重排后行里的 pictureN 变了，但磁盘上的文件不会改名（改了图就 404）。
 * 所以包内名字必须**按 pictureN 现算**，并且要核对 fileName 里的编号：
 * 只看"像不像 PictureN"会把 3 号图按 3 号写进包，而它已经是 4 号了。
 */
describe('包内文件名按 pictureN 现算', () => {
  it('fileName 的编号和 pictureN 一致时沿用原名', () => {
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [seg({ prompt: '<Picture 2> 站在门口。' })],
      assets: [asset(2)]
    })
    expect(res.entries.map((e) => e.path)).toContain('shared_params/Picture2.png')
  })

  it('对不上时按 pictureN 重命名，不会把旧编号写进包', () => {
    const stale = { ...asset(4), fileName: 'Picture3.png' }
    const res = buildDirectorPack({
      settings: DEFAULT_SETTINGS,
      segments: [seg({ prompt: '<Picture 4> 站在门口。' })],
      assets: [stale]
    })
    const paths = res.entries.map((e) => e.path)
    expect(paths).toContain('shared_params/Picture4.png')
    expect(paths).not.toContain('shared_params/Picture3.png')
  })
})
