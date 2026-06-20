// Parser for the frontier WebSocket envelope (a protobuf "PushFrame"):
//   field 1 seqId, 2 logId, 5 repeated headers, 6 payloadEncoding,
//   7 payloadType, 8 payload (bytes). For the streamer dashboard the payload
//   is a UTF-8 JSON string; callers decompress (when payloadEncoding=gzip)
//   then JSON.parse. Pure + dependency-free so it ports into the desktop app.

export interface PushFrame {
  payloadType?: string
  payloadEncoding?: string
  payload: Uint8Array
}

function readVarint(b: Uint8Array, p: number): [number, number] {
  let result = 0
  let shift = 0
  let byte = 0
  do {
    byte = b[p++]!
    result += (byte & 0x7f) * 2 ** shift
    shift += 7
  } while ((byte & 0x80) !== 0 && p < b.length)
  return [result, p]
}

const utf8 = (b: Uint8Array, s: number, e: number) => new TextDecoder().decode(b.subarray(s, e))

export function parsePushFrame(b: Uint8Array): PushFrame | null {
  let p = 0
  let payload: Uint8Array | undefined
  let payloadType: string | undefined
  let payloadEncoding: string | undefined
  while (p < b.length) {
    let tag: number
    ;[tag, p] = readVarint(b, p)
    const field = tag >> 3
    const wire = tag & 7
    if (field === 0) break
    if (wire === 0) {
      ;[, p] = readVarint(b, p)
    } else if (wire === 2) {
      let len: number
      ;[len, p] = readVarint(b, p)
      const end = Math.min(p + len, b.length)
      if (field === 6) payloadEncoding = utf8(b, p, end)
      else if (field === 7) payloadType = utf8(b, p, end)
      else if (field === 8) payload = b.subarray(p, end)
      p = end
    } else if (wire === 1) {
      p += 8
    } else if (wire === 5) {
      p += 4
    } else {
      break
    }
  }
  if (!payload) return null
  return { payload, payloadType, payloadEncoding }
}
