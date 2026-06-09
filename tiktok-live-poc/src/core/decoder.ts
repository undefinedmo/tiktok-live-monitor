export type PbValue = string | PbNode | PbValue[]
export interface PbNode { [field: string]: PbValue }

function readVarint(b: Uint8Array, p: number): [bigint, number] {
  let result = 0n
  let shift = 0n
  let byte = 0
  do {
    byte = b[p++]!
    result |= BigInt(byte & 0x7f) << shift
    shift += 7n
  } while ((byte & 0x80) !== 0 && p < b.length)
  return [result, p]
}

function isPrintable(b: Uint8Array, s: number, e: number): boolean {
  if (e - s === 0) return false
  for (let i = s; i < e; i++) {
    const c = b[i]!
    if (c < 9 || (c > 13 && c < 32) || c > 126) return false
  }
  return true
}

export function walk(b: Uint8Array, start = 0, end = b.length, depth = 0): PbNode {
  const node: PbNode = {}
  let p = start
  const put = (k: string, v: PbValue) => {
    const existing = node[k]
    if (existing === undefined) node[k] = v
    else if (Array.isArray(existing)) existing.push(v)
    else node[k] = [existing, v]
  }
  while (p < end) {
    let tagVal: bigint
    ;[tagVal, p] = readVarint(b, p)
    const field = Number(tagVal >> 3n)
    const wire = Number(tagVal & 7n)
    if (field === 0 || p > end) break
    if (wire === 0) {
      let v: bigint
      ;[v, p] = readVarint(b, p)
      put(String(field), v.toString())
    } else if (wire === 1) {
      put(String(field), 'f64')
      p += 8
    } else if (wire === 5) {
      put(String(field), 'f32')
      p += 4
    } else if (wire === 2) {
      let len: bigint
      ;[len, p] = readVarint(b, p)
      const L = Number(len)
      const s = p
      const e = Math.min(p + L, end)
      p = e
      if (isPrintable(b, s, e) && L < 300) {
        let str = ''
        for (let i = s; i < e; i++) str += String.fromCharCode(b[i]!)
        put(String(field), str)
      } else if (L > 0 && depth < 7) {
        const sub = walk(b, s, e, depth + 1)
        put(String(field), Object.keys(sub).length ? sub : `bytes${L}`)
      } else {
        put(String(field), `bytes${L}`)
      }
    } else break
  }
  return node
}

export interface StreamMessage { method: string; payload: PbNode }

export function decodeFrame(b: Uint8Array): StreamMessage[] {
  const out: StreamMessage[] = []
  let cur = ''
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!
    if (c >= 32 && c < 127) {
      cur += String.fromCharCode(c)
      continue
    }
    // c is the byte that terminated the ASCII run; outer message => c === 0x12 (field 2, wire 2)
    if (c === 0x12 && /^[A-Za-z]{3,40}Message$/.test(cur)) {
      let q = i + 1
      let len: bigint
      ;[len, q] = readVarint(b, q)
      const L = Number(len)
      const end = Math.min(q + L, b.length)
      out.push({ method: cur, payload: walk(b, q, end, 0) })
      i = end - 1 // skip the payload bytes we just consumed (the for-loop does i++)
    }
    cur = ''
  }
  return out
}
