import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decodeChat } from '../chat'

const { b64 } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/im-fetch-sample.json', import.meta.url)), 'utf8'),
)
const frame = Uint8Array.from(Buffer.from(b64, 'base64'))

describe('decodeChat', () => {
  it('decodes WebcastChatMessage comments from a real im/fetch protobuf frame', () => {
    const msgs = decodeChat(frame)
    expect(msgs.length).toBeGreaterThanOrEqual(1)
    const m = msgs[0]!
    expect(m.nickname).toBe('Latrice Colburn')
    expect(m.text.length).toBeGreaterThan(0)
    expect(m.avatarUrl).toContain('tiktokcdn-us.com')
    expect(m.ts).toBeGreaterThan(1_700_000_000_000)
  })

  it('returns [] for a frame with no chat messages', () => {
    expect(decodeChat(new Uint8Array([1, 2, 3, 4]))).toEqual([])
  })
})

// ── identity fields ─────────────────────────────────────────────────────────────────────────
// A chat line's stable id comes from TikTok's own message id, and its author from the user's id and
// @handle. All three are 64-bit varints or bare strings in the frame, so they are read exactly or
// not at all: a double loses the low bits of a 19-digit id, and two different viewers would then
// share an id.
const enc = new TextEncoder()
function big(n: bigint): number[] {
  const out: number[] = []
  let v = n
  while (v > 0x7fn) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n }
  out.push(Number(v))
  return out
}
const vBig = (field: number, n: bigint) => [...big(BigInt(field << 3)), ...big(n)]
const lenField = (field: number, body: number[]) => [...big(BigInt((field << 3) | 2)), ...big(BigInt(body.length)), ...body]
const strField = (field: number, s: string) => lenField(field, [...enc.encode(s)])
function chatFrame(parts: { common?: number[]; user?: number[]; text?: string }): Uint8Array {
  const payload = [
    ...(parts.common ? lenField(1, parts.common) : []),
    ...(parts.user ? lenField(2, parts.user) : []),
    ...(parts.text !== undefined ? strField(3, parts.text) : []),
  ]
  const name = [...enc.encode('WebcastChatMessage')]
  return new Uint8Array([0x0a, name.length, ...name, 0x12, ...big(BigInt(payload.length)), ...payload])
}

describe('decodeChat identity', () => {
  it('reads the message id, user id and @handle exactly from the real frame', () => {
    const m = decodeChat(frame)[0]!
    // 19-digit values: a Number would round both of these.
    expect(m.msgId).toBe('7653593120676039438')
    expect(m.userId).toBe('6841363407170978822')
    expect(m.handle).toBe('latricecolburn')
    expect(m.ts).toBe(1781991025523)
  })

  it('keeps ids beyond 2^53 exact (a Number would round 9007199254740993 down)', () => {
    const m = decodeChat(chatFrame({
      common: [...vBig(2, 9007199254740993n), ...vBig(4, 1781991025523n)],
      user: [...vBig(1, 9007199254740995n), ...strField(3, 'A')],
      text: 'hi',
    }))[0]!
    expect(m.msgId).toBe('9007199254740993')
    expect(m.userId).toBe('9007199254740995')
  })

  it('does not take the room id (common field 3) or the log id for the message id', () => {
    const m = decodeChat(chatFrame({
      common: [...vBig(3, 111n), ...vBig(2, 222n), ...strField(12, 'LOGID'), ...vBig(25, 333n)],
      user: strField(3, 'A'),
      text: 'hi',
    }))[0]!
    expect(m.msgId).toBe('222')
  })

  it('leaves the ids undefined when the frame carries none (absent is not "0")', () => {
    const m = decodeChat(chatFrame({ common: vBig(4, 1781991025523n), user: strField(3, 'A'), text: 'hi' }))[0]!
    expect(m.msgId).toBeUndefined()
    expect(m.userId).toBeUndefined()
    expect(m.handle).toBeUndefined()
    const zero = decodeChat(chatFrame({ common: [...vBig(2, 0n), ...vBig(4, 1781991025523n)], user: [...vBig(1, 0n), ...strField(3, 'A')], text: 'hi' }))[0]!
    expect(zero.msgId).toBeUndefined()
    expect(zero.userId).toBeUndefined()
  })

  it('still reads a user id that arrives as a string', () => {
    const m = decodeChat(chatFrame({ user: [...strField(1, '12345'), ...strField(3, 'A')], text: 'hi' }))[0]!
    expect(m.userId).toBe('12345')
  })

  it('reads the handle from field 38 and nothing else', () => {
    const m = decodeChat(chatFrame({ user: [...strField(3, 'Some Nick'), ...strField(38, 'some_handle'), ...strField(46, 'SECUID')], text: 'hi' }))[0]!
    expect(m.nickname).toBe('Some Nick')
    expect(m.handle).toBe('some_handle')
  })

  it('keeps emoji in the text and nickname intact', () => {
    const m = decodeChat(chatFrame({ user: strField(3, 'Saldaña 🍒'), text: 'is this real? 🤔' }))[0]!
    expect(m.nickname).toBe('Saldaña 🍒')
    expect(m.text).toBe('is this real? 🤔')
  })

  it('prefers a string-encoded user id over a varint one when a frame carries both', () => {
    const m = decodeChat(chatFrame({ user: [...vBig(1, 5n), ...strField(1, 'abc'), ...strField(3, 'A')], text: 'hi' }))[0]!
    expect(m.userId).toBe('abc')
  })

  it('skips fixed-width fields (wire types 1 and 5) without losing its place before the id', () => {
    // 8 bytes for field 7 (fixed64) and 4 for field 8 (fixed32); a wrong width would read the id from the wrong byte
    const fixed64 = [...big(BigInt((7 << 3) | 1)), 1, 2, 3, 4, 5, 6, 7, 8]
    const fixed32 = [...big(BigInt((8 << 3) | 5)), 9, 9, 9, 9]
    const m = decodeChat(chatFrame({
      common: [...fixed64, ...fixed32, ...vBig(2, 222n), ...fixed64, ...fixed32, ...vBig(4, 1781991025523n)],
      user: [...fixed64, ...fixed32, ...vBig(1, 333n), ...strField(3, 'A')],
      text: 'hi',
    }))[0]!
    expect(m.msgId).toBe('222')
    expect(m.userId).toBe('333')
    expect(m.ts).toBe(1781991025523)
  })

  it('skips an unrelated length-delimited field before the id without losing its place', () => {
    const m = decodeChat(chatFrame({ common: [...strField(12, 'LOG-ID-0123456789'), ...vBig(2, 222n)], user: [...strField(46, 'SECUID'), ...vBig(1, 333n)], text: 'hi' }))[0]!
    expect(m.msgId).toBe('222')
    expect(m.userId).toBe('333')
  })
})
