// Decodes viewer comments from the webcast/im/fetch protobuf stream
// (WebcastResponse → repeated messages). Self-contained protobuf reader that
// reads the comment text + user as proper UTF-8 (so emoji survive). Portable.
//
// WebcastChatMessage payload shape (field numbers):
//   1 = common  { 4 = timestamp ms }
//   2 = user    { 1 = id, 3 = nickname, 9 = avatar { 1 = repeated url } }
//   3 = content (the comment text)

import type { ChatMessage } from './types'

const utf8 = (b: Uint8Array, s: number, e: number) => new TextDecoder().decode(b.subarray(s, e))

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

/** Iterate top-level protobuf fields, calling back with (field, wire, start, end). */
function fields(b: Uint8Array, start: number, end: number, cb: (field: number, wire: number, s: number, e: number) => void) {
  let p = start
  while (p < end) {
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
      const e = Math.min(p + len, end)
      cb(field, wire, p, e)
      p = e
    } else if (wire === 1) {
      p += 8
    } else if (wire === 5) {
      p += 4
    } else {
      break
    }
  }
}

function varintField(b: Uint8Array, start: number, end: number, target: number): number {
  let out = 0
  let p = start
  while (p < end) {
    let tag: number
    ;[tag, p] = readVarint(b, p)
    const field = tag >> 3
    const wire = tag & 7
    if (field === 0) break
    if (wire === 0) {
      let v: number
      ;[v, p] = readVarint(b, p)
      if (field === target) out = v
    } else if (wire === 2) {
      let len: number
      ;[len, p] = readVarint(b, p)
      p = Math.min(p + len, end)
    } else if (wire === 1) p += 8
    else if (wire === 5) p += 4
    else break
  }
  return out
}

function parseUser(b: Uint8Array, s: number, e: number): { id?: string; nickname: string; avatarUrl?: string } {
  let id = ''
  let nickname = ''
  let avatarUrl = ''
  fields(b, s, e, (field, wire, fs, fe) => {
    if (field === 1 && wire === 2) id = utf8(b, fs, fe) // sometimes string-encoded; fine either way
    else if (field === 3 && wire === 2) nickname = utf8(b, fs, fe)
    else if (field === 9 && wire === 2 && !avatarUrl) {
      // avatar message: field 1 = repeated url string → take the first
      fields(b, fs, fe, (af, aw, as, ae) => {
        if (af === 1 && aw === 2 && !avatarUrl) avatarUrl = utf8(b, as, ae)
      })
    }
  })
  return { id: id || undefined, nickname, avatarUrl: avatarUrl || undefined }
}

function parseChatPayload(b: Uint8Array, s: number, e: number): ChatMessage | null {
  let text = ''
  let ts = 0
  let user: { id?: string; nickname: string; avatarUrl?: string } = { nickname: '' }
  fields(b, s, e, (field, wire, fs, fe) => {
    if (field === 3 && wire === 2) text = utf8(b, fs, fe) // content
    else if (field === 2 && wire === 2) user = parseUser(b, fs, fe)
    else if (field === 1 && wire === 2) ts = varintField(b, fs, fe, 4) // common.timestamp
  })
  if (!text) return null
  return { userId: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl, text, ts }
}

/** Find every WebcastChatMessage in a WebcastResponse frame and decode it.
 *  Uses the method-name marker (followed by tag 0x12 = field 2, the payload),
 *  same frame-split heuristic the auction decoder used. */
export function decodeChat(b: Uint8Array): ChatMessage[] {
  const out: ChatMessage[] = []
  let cur = ''
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!
    if (c >= 32 && c < 127) {
      cur += String.fromCharCode(c)
      continue
    }
    if (c === 0x12 && cur === 'WebcastChatMessage') {
      let q = i + 1
      let len: number
      ;[len, q] = readVarint(b, q)
      const msg = parseChatPayload(b, q, Math.min(q + len, b.length))
      if (msg) out.push(msg)
    }
    cur = ''
  }
  return out
}
