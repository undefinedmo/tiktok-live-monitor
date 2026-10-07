import { describe, it, expect } from 'vitest'
import { createClipWindow, pruneChunks } from '../clipBuffer'

const chunks = (n: number, t0 = 1000, dur = 1) =>
  Array.from({ length: n }, (_, i) => ({ startEpochSec: t0 + i * dur, durationSec: dur, seq: i }))

describe('createClipWindow', () => {
  it('returns exactly the chunks covering the requested window', () => {
    const w = createClipWindow(chunks(60), { startEpochSec: 1010, endEpochSec: 1020 }, 300)
    expect(w).not.toBeNull()
    expect(w!.startEpochSec).toBe(1010)
    expect(w!.durationSec).toBe(10)
    expect(w!.truncated).toBe(false)
    expect(w!.chunks.map((c) => c.seq)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  })

  // The spec's rule: a short buffer must be VISIBLE in the data, never silently indistinguishable
  // from a tight window.
  it('marks truncated when the buffer does not reach back far enough', () => {
    const w = createClipWindow(chunks(10), { startEpochSec: 900, endEpochSec: 1005 }, 300)
    expect(w!.startEpochSec).toBe(1000) // cut at the buffer start, not 900
    expect(w!.truncated).toBe(true)
  })

  it('returns null when the window lies entirely outside the buffer', () => {
    expect(createClipWindow(chunks(10), { startEpochSec: 500, endEpochSec: 600 }, 300)).toBeNull()
  })

  // The window can never claim audio the buffer does not hold.
  it('stops at the end of the buffer when the request runs past it', () => {
    const w = createClipWindow(chunks(10), { startEpochSec: 1005, endEpochSec: 1100 }, 300)
    expect(w!.startEpochSec).toBe(1005)
    expect(w!.durationSec).toBe(5)
    expect(w!.truncated).toBe(false)
  })
})

describe('pruneChunks', () => {
  it('keeps only the cap, dropping oldest first', () => {
    const kept = pruneChunks(chunks(600), 300) // 600 one-second chunks, 300s cap
    expect(kept).toHaveLength(300)
    expect(kept[0]!.seq).toBe(300) // oldest dropped
  })
})
