/**
 * 产物识别回归。
 *
 * 这里锁的是真机踩过的坑：ComfyUI 的 `SaveVideo` 把成片放在 history 的
 * **`images`** 键下（不是 `videos`）。以前的实现按键名判类型，mp4 被标成
 * image，运行台就拿它去渲染 `<img>` —— 一片黑，"产物识别不到、播不了"。
 */
import { describe, expect, it } from 'vitest'
import { collectOutputs, kindOfFile } from './run'

const BASE = 'http://127.0.0.1:8188'

function hist(outputs: Record<string, unknown>) {
  return { p1: { outputs } }
}

describe('kindOfFile', () => {
  it('视频按扩展名判，大小写无关', () => {
    expect(kindOfFile('a.mp4')).toBe('video')
    expect(kindOfFile('a.MP4')).toBe('video')
    expect(kindOfFile('a.webm')).toBe('video')
    expect(kindOfFile('a.mkv')).toBe('video')
  })
  it('图片保持图片', () => {
    expect(kindOfFile('a.png')).toBe('image')
    expect(kindOfFile('a.jpg')).toBe('image')
    expect(kindOfFile('noext')).toBe('image')
  })
  it('纯音频也交给 video 元素（播得出来，别渲染成破图）', () => {
    expect(kindOfFile('a.mp3')).toBe('video')
    expect(kindOfFile('a.wav')).toBe('video')
  })
})

describe('collectOutputs', () => {
  it('SaveVideo 的 mp4 在 images 键下也要认成视频', () => {
    const out = collectOutputs(
      hist({
        '14': {
          images: [{ filename: 'MiniMaxH3_Director_r2v_00092_.mp4', subfolder: 'video', type: 'output' }],
          animated: [true]
        }
      }),
      'p1',
      BASE
    )
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('video')
    expect(out[0].subfolder).toBe('video')
    expect(out[0].nodeId).toBe('14')
    expect(out[0].url).toContain('filename=MiniMaxH3_Director_r2v_00092_.mp4')
  })

  it('图片不受影响', () => {
    const out = collectOutputs(
      hist({ '9': { images: [{ filename: 'ref.png', subfolder: '', type: 'temp' }] } }),
      'p1',
      BASE
    )
    expect(out[0].kind).toBe('image')
    expect(out[0].type).toBe('temp')
  })

  it('自定义节点把产物放在任意键下都收得到', () => {
    const out = collectOutputs(
      hist({
        '9': { files: [{ filename: 'x.mp4' }] },
        '10': { outputs: { '0': { filename: 'y.png' } } },
        '11': { text: ['只是文本，不是文件'] }
      }),
      'p1',
      BASE
    )
    expect(out.map((o) => o.filename).sort()).toEqual(['x.mp4', 'y.png'])
    expect(out.find((o) => o.filename === 'x.mp4')?.kind).toBe('video')
  })

  it('同一文件重复出现只算一次（images + animated 是常态）', () => {
    const f = { filename: 'dup.mp4', subfolder: 'video', type: 'output' }
    const out = collectOutputs(hist({ '1': { images: [f, f] }, '2': { gifs: [f] } }), 'p1', BASE)
    expect(out).toHaveLength(1)
  })

  it('没有 filename 的条目、非数组、空 outputs 都不炸', () => {
    expect(collectOutputs(undefined, 'p1', BASE)).toEqual([])
    expect(collectOutputs(hist({ '1': {} }), 'p1', BASE)).toEqual([])
    expect(
      collectOutputs(hist({ '1': { images: [{ subfolder: 'video' }] } }), 'p1', BASE)
    ).toEqual([])
  })
})
