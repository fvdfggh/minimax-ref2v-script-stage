/* ------------------------------------------------------------------ *
 * 最小 ZIP 写入器（STORE，不压缩）
 *
 * 导演包必须是一个 zip。素材是 PNG/JPG，本身已经压过，
 * 再跑一遍 deflate 收益极小，所以这里只写 STORE 条目 ——
 * 换来的是不用引第三方库，也不用管压缩流。
 *
 * 包内路径必须全 ASCII（导入端 ASCII_PATH_RE 校验，非 ASCII 直接抛错），
 * 所以这里也顺手挡一道。
 * ------------------------------------------------------------------ */

export interface ZipEntry {
  /** 包内路径，必须 ASCII */
  path: string
  data: Uint8Array | Blob | string
}

// 与导入端 pack_format.ASCII_PATH_RE 保持一致（注意不含 -）
const ASCII_PATH_RE = /^[A-Za-z0-9_./]+$/

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function dosStamp(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

async function toBytes(data: Uint8Array | Blob | string): Promise<Uint8Array> {
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (data instanceof Uint8Array) return data
  return new Uint8Array(await data.arrayBuffer())
}

interface Prepared {
  nameBytes: Uint8Array
  data: Uint8Array
  crc: number
  offset: number
}

export async function zipToBlob(entries: ZipEntry[]): Promise<Blob> {
  const stamp = dosStamp(new Date())
  const chunks: Uint8Array[] = []
  const prepared: Array<Prepared & { time: number; date: number }> = []

  let offset = 0
  for (const entry of entries) {
    if (!ASCII_PATH_RE.test(entry.path)) {
      throw new Error(`包内路径必须全 ASCII：${entry.path}`)
    }
    const nameBytes = new TextEncoder().encode(entry.path)
    const data = await toBytes(entry.data)
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true) // local file header signature
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0, true) // flags
    lv.setUint16(8, 0, true) // method: store
    lv.setUint16(10, stamp.time, true)
    lv.setUint16(12, stamp.date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true) // compressed size
    lv.setUint32(22, data.length, true) // uncompressed size
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true) // extra length
    local.set(nameBytes, 30)

    chunks.push(local, data)
    prepared.push({ nameBytes, data, crc, offset, time: stamp.time, date: stamp.date })
    offset += local.length + data.length
  }

  const cdStart = offset
  for (const p of prepared) {
    const cd = new Uint8Array(46 + p.nameBytes.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true) // central directory signature
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0, true)
    cv.setUint16(10, 0, true) // method: store
    cv.setUint16(12, p.time, true)
    cv.setUint16(14, p.date, true)
    cv.setUint32(16, p.crc, true)
    cv.setUint32(20, p.data.length, true)
    cv.setUint32(24, p.data.length, true)
    cv.setUint16(28, p.nameBytes.length, true)
    cv.setUint16(30, 0, true) // extra
    cv.setUint16(32, 0, true) // comment
    cv.setUint16(34, 0, true) // disk number start
    cv.setUint16(36, 0, true) // internal attrs
    cv.setUint32(38, 0, true) // external attrs
    cv.setUint32(42, p.offset, true)
    cd.set(p.nameBytes, 46)
    chunks.push(cd)
    offset += cd.length
  }

  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true) // end of central directory
  ev.setUint16(4, 0, true)
  ev.setUint16(6, 0, true)
  ev.setUint16(8, prepared.length, true)
  ev.setUint16(10, prepared.length, true)
  ev.setUint32(12, offset - cdStart, true) // central directory size
  ev.setUint32(16, cdStart, true)
  ev.setUint16(20, 0, true)
  chunks.push(end)

  return new Blob(chunks as BlobPart[], { type: 'application/zip' })
}

/** 把 JS 对象写成包内 json 条目 */
export function jsonEntry(path: string, value: unknown): ZipEntry {
  return { path, data: `${JSON.stringify(value, null, 2)}\n` }
}
