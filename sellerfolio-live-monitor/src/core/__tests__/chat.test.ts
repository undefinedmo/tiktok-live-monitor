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
