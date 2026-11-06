import { describe, expect, it } from 'vitest'
import { newEcStreamerKey } from '../chat'

describe('newEcStreamerKey', () => {
  it('is a 10-char url-safe id, like Streamer Desktop builds', () => {
    expect(newEcStreamerKey()).toMatch(/^[A-Za-z0-9_-]{10}$/)
  })
  it('is fresh per message', () => {
    const keys = new Set(Array.from({ length: 200 }, () => newEcStreamerKey()))
    expect(keys.size).toBe(200)
  })
})
