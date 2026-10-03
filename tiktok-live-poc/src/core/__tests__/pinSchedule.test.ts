import { describe, it, expect } from 'vitest'
import {
  nextPinDelayMs,
  FINALIZE_LAG_MS,
  LATE_RETRY_MS,
  MAX_LATE_RETRIES,
  PIN_IDLE_MS,
  PIN_LIVE_MS,
} from '../pinSchedule'

const END = 100_000 // expected end, server clock
const TARGET = END + FINALIZE_LAG_MS
const live = (serverNowMs: number, lateTries = 0) =>
  nextPinDelayMs({ live: true, expectedEndMs: END, serverNowMs, lateTries })

describe('nextPinDelayMs', () => {
  it('polls lazily when no lot is live', () => {
    expect(nextPinDelayMs({ live: false, lateTries: 0 })).toBe(PIN_IDLE_MS)
    expect(nextPinDelayMs({ live: false, expectedEndMs: END, serverNowMs: END - 500, lateTries: 0 })).toBe(PIN_IDLE_MS)
  })

  it('keeps the flat cadence when the end time or the server clock is unknown', () => {
    expect(nextPinDelayMs({ live: true, lateTries: 0 })).toBe(PIN_LIVE_MS)
    expect(nextPinDelayMs({ live: true, expectedEndMs: END, lateTries: 0 })).toBe(PIN_LIVE_MS)
  })

  it('keeps the flat cadence while the end is far off', () => {
    expect(live(TARGET - 7000)).toBe(PIN_LIVE_MS)
    expect(live(TARGET - 2 * PIN_LIVE_MS)).toBe(PIN_LIVE_MS)
  })

  it('lands exactly on expected end + finalize lag when within one interval', () => {
    expect(live(TARGET - 900)).toBe(900)
    expect(live(TARGET - PIN_LIVE_MS)).toBe(PIN_LIVE_MS)
  })

  it('shortens the wait before the last one so the last one lands on the target', () => {
    // 2000ms out: wait 800, leaving exactly one 1200ms interval.
    expect(live(TARGET - 2000)).toBe(800)
    expect(live(TARGET - 2000 + 800)).toBe(PIN_LIVE_MS)
  })

  it('never fires back-to-back', () => {
    expect(live(TARGET - 20)).toBe(150)
    expect(live(TARGET - 1250)).toBe(300)
  })

  it('reaches the target from any phase, costing a 7s auction at most one extra request', () => {
    for (let phase = 0; phase < PIN_LIVE_MS; phase += 50) {
      let now = END - 7000 + phase
      let polls = 0
      while (now < TARGET) { now += live(now); polls++ }
      expect(now).toBe(TARGET)
      // The flat cadence spends ceil((8000 − phase) / 1200) polls getting past the target.
      expect(polls).toBeLessThanOrEqual(Math.ceil((8000 - phase) / PIN_LIVE_MS) + 1)
    }
  })

  it('retries quickly, a bounded number of times, when a past-due lot still reads bidding', () => {
    expect(live(TARGET, 0)).toBe(LATE_RETRY_MS)
    expect(live(TARGET + 900, MAX_LATE_RETRIES - 1)).toBe(LATE_RETRY_MS)
    expect(live(TARGET + 2500, MAX_LATE_RETRIES)).toBe(PIN_LIVE_MS)
  })

  it('follows an anti-snipe extension: a later end time resets the approach', () => {
    const extended = nextPinDelayMs({ live: true, expectedEndMs: END + 3000, serverNowMs: TARGET - 100, lateTries: 0 })
    expect(extended).toBe(PIN_LIVE_MS)
  })
})
