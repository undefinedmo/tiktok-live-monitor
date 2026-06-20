import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parsePushFrame } from '../pushFrame'
import { bytes, vField, sField, mField } from './pbEncode'

const frames = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/ws-frames.json', import.meta.url)), 'utf8'),
)
const text = (u: Uint8Array) => new TextDecoder().decode(u)

describe('parsePushFrame', () => {
  it('extracts the field-8 payload bytes from a PushFrame envelope', () => {
    // seqId(1), logId(2), one header(5), payloadType(7), payload(8)
    const header = mField(5, [...sField(1, 'is_ack'), ...sField(2, '1')])
    const frame = bytes(vField(1, 123), vField(2, 456), header, sField(7, 'msg'), sField(8, '{"hello":"world"}'))
    const out = parsePushFrame(frame)
    expect(out).not.toBeNull()
    expect(text(out!.payload)).toBe('{"hello":"world"}')
    expect(out!.payloadType).toBe('msg')
  })

  it('reads payloadEncoding (field 6)', () => {
    const frame = bytes(vField(1, 1), sField(6, 'gzip'), sField(8, 'x'))
    expect(parsePushFrame(frame)!.payloadEncoding).toBe('gzip')
  })

  it('returns null when there is no payload field', () => {
    const frame = bytes(vField(1, 1), vField(2, 2))
    expect(parsePushFrame(frame)).toBeNull()
  })

  it('decodes a real captured frontier frame to its JSON payload', () => {
    const raw = Uint8Array.from(Buffer.from(frames.productStats.b64, 'base64'))
    const out = parsePushFrame(raw)
    expect(out).not.toBeNull()
    const payload = JSON.parse(text(out!.payload))
    expect(payload.live_room_info.room_id).toBe('7653571353936759566')
    expect(payload.live_product_stats.product_stats['1732451632603436003'].sales).toBe(22)
  })
})
