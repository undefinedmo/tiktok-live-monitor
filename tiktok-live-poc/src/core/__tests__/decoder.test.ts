import { describe, it, expect } from 'vitest'
import { walk, decodeFrame } from '../decoder'
import { bytes, sField, vField, mField } from './pbEncode'

describe('walk', () => {
  it('decodes varint and string fields into a field tree', () => {
    const buf = bytes(vField(2, 7), sField(3, 'hello'))
    expect(walk(buf)).toEqual({ '2': '7', '3': 'hello' })
  })
  it('decodes nested messages and repeated fields', () => {
    const inner = sField(1, 'action_type').concat(sField(2, 'bid'))
    const buf = bytes(mField(5, inner), mField(5, sField(1, 'platform').concat(sField(2, 'app'))))
    const tree = walk(buf)
    expect(Array.isArray(tree['5'])).toBe(true)
    expect((tree['5'] as any)[0]).toEqual({ '1': 'action_type', '2': 'bid' })
  })
})

describe('decodeFrame', () => {
  it('extracts {method,payload} for an outer message (method followed by 0x12)', () => {
    // outer message: field1 = method string, field2 = payload bytes
    const payload = sField(3, 'auction.new_bid')           // payload.field3 = event name marker
    const msg = sField(1, 'WebcastOecLiveCreatorMessage').concat(mField(2, payload))
    const frame = bytes(mField(1, msg))                    // WebcastResponse.field1 = repeated message
    const out = decodeFrame(frame)
    expect(out).toHaveLength(1)
    expect(out[0]!.method).toBe('WebcastOecLiveCreatorMessage')
    expect(out[0]!.payload['3']).toBe('auction.new_bid')
  })
  it('ignores a method name not followed by a payload tag', () => {
    // method name followed by a varint tag (0x10) — the header echo, not an outer message
    const buf = bytes(sField(1, 'WebcastChatMessage'), vField(2, 1))
    expect(decodeFrame(buf)).toHaveLength(0)
  })
  it('does not emit spurious messages from payload contents', () => {
    // payload embeds "EvilMessage" immediately followed by a 0x12 tag
    const evilPayload = [...sField(7, 'EvilMessage'), ...mField(2, sField(1, 'x'))]
    const msg = [...sField(1, 'WebcastOecLiveCreatorMessage'), ...mField(2, evilPayload)]
    const out = decodeFrame(bytes(mField(1, msg)))
    expect(out).toHaveLength(1)
    expect(out[0]!.method).toBe('WebcastOecLiveCreatorMessage')
  })
})
