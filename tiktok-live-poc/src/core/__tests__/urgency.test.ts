import { describe, it, expect } from 'vitest'
import { urgency } from '../urgency'

const now = 1_000_000_000_000
const H = 3600 * 1000
const DAY = 24 * H

describe('urgency()', () => {
  it('returns ok when deadlines are undefined', () => {
    expect(urgency(undefined, now)).toBe('ok')
  })

  it('returns ok when deadlines object is present but all fields empty', () => {
    expect(urgency({}, now)).toBe('ok')
  })

  it('returns auto-cancel-risk when autoCancelMs is within 24h', () => {
    expect(urgency({ autoCancelMs: now + 12 * H }, now)).toBe('auto-cancel-risk')
  })

  it('auto-cancel-risk takes priority over overdue latestRtsMs', () => {
    expect(urgency({ autoCancelMs: now + 12 * H, latestRtsMs: now - H }, now)).toBe('auto-cancel-risk')
  })

  it('returns overdue when latestRtsMs is in the past (no autoCancelMs)', () => {
    expect(urgency({ latestRtsMs: now - H }, now)).toBe('overdue')
  })

  it('returns overdue when latestRtsMs is in the past and autoCancelMs is far future', () => {
    expect(urgency({ latestRtsMs: now - H, autoCancelMs: now + 10 * DAY }, now)).toBe('overdue')
  })

  it('returns ship-soon when latestRtsMs is within 24h (not overdue)', () => {
    expect(urgency({ latestRtsMs: now + 12 * H }, now)).toBe('ship-soon')
  })

  it('returns ok when latestRtsMs is more than 24h away', () => {
    expect(urgency({ latestRtsMs: now + 48 * H }, now)).toBe('ok')
  })

  it('respects custom shipSoonMs window: deadline within 24h but outside custom 6h window → ok', () => {
    expect(urgency({ latestRtsMs: now + 12 * H }, now, { shipSoonMs: 6 * H })).toBe('ok')
  })

  it('respects custom autoCancelMs window: auto-cancel within 24h but outside custom 6h window → ok (no rts)', () => {
    expect(urgency({ autoCancelMs: now + 12 * H }, now, { autoCancelMs: 6 * H })).toBe('ok')
  })
})
