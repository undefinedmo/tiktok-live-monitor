import { describe, it, expect } from 'vitest'
import { makeClipStore } from '../clipRecorder'

// One byte per chunk, valued by the chunk's index, so a blob's bytes name the chunks inside it.
async function bytes(b: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await b.arrayBuffer()))
}

describe('makeClipStore', () => {
  it('reassembles only the requested span, and reports truncation', () => {
    let t = 1000
    const store = makeClipStore({ capSec: 300, now: () => t })
    for (let i = 0; i < 30; i++) { t += 1; store.push(new Blob([new Uint8Array([i])]), 1) }

    const got = store.extract({ startEpochSec: 1010, endEpochSec: 1015 })
    expect(got!.durationSec).toBe(5)
    expect(got!.truncated).toBe(false)
    expect(got!.blob.size).toBe(5) // one byte per second pushed

    const early = store.extract({ startEpochSec: 500, endEpochSec: 1005 })
    expect(early!.truncated).toBe(true)
  })

  it('forgets everything on reset, so a new show cannot inherit the last show audio', () => {
    const store = makeClipStore({ capSec: 300, now: () => 1000 })
    store.push(new Blob(['a']), 1)
    store.reset()
    expect(store.extract({ startEpochSec: 999, endEpochSec: 1001 })).toBeNull()
  })

  // ondataavailable fires when a slice has FINISHED, so a chunk pushed at t covers [t - dur, t).
  it('stamps a chunk as ending when it arrives', () => {
    const store = makeClipStore({ capSec: 300, now: () => 1002 })
    store.push(new Blob([new Uint8Array([7])]), 2)
    const got = store.extract({ startEpochSec: 1000, endEpochSec: 1002 })
    expect(got!.startEpochSec).toBe(1000)
    expect(got!.durationSec).toBe(2)
    expect(store.extract({ startEpochSec: 1002, endEpochSec: 1004 })).toBeNull() // starts where it ends
  })

  // The lead-in contract. Encoded audio cannot be cut at an arbitrary second, so the store does not
  // trim: the blob holds WHOLE chunks, and startEpochSec / durationSec describe THOSE bytes, not the
  // request. A window that starts mid-chunk therefore reports the chunk's start, and leadInSec says
  // how much earlier than asked that is.
  describe('a window whose edges fall inside a chunk', () => {
    function twoSecondChunks() {
      let t = 1000
      const store = makeClipStore({ capSec: 300, now: () => t })
      for (let i = 0; i < 10; i++) { t += 2; store.push(new Blob([new Uint8Array([i])]), 2) } // chunk i = [1000+2i, 1002+2i)
      return store
    }

    it('returns whole chunks and describes the bytes, not the request', async () => {
      const got = twoSecondChunks().extract({ startEpochSec: 1005, endEpochSec: 1009 })
      expect(await bytes(got!.blob)).toEqual([2, 3, 4])   // [1004,1006) [1006,1008) [1008,1010)
      expect(got!.startEpochSec).toBe(1004)                // the first byte's time, not 1005
      expect(got!.durationSec).toBe(6)                     // 1004..1010: includes the tail past 1009
      expect(got!.leadInSec).toBe(1)                       // 1005 - 1004
      expect(got!.truncated).toBe(false)
    })

    it('has no lead-in when the request lands on a chunk boundary', async () => {
      const got = twoSecondChunks().extract({ startEpochSec: 1006, endEpochSec: 1010 })
      expect(await bytes(got!.blob)).toEqual([3, 4])
      expect(got!.startEpochSec).toBe(1006)
      expect(got!.leadInSec).toBe(0)
    })

    it('has no lead-in when truncated: the buffer start is the clip start', () => {
      const got = twoSecondChunks().extract({ startEpochSec: 900, endEpochSec: 1003 })
      expect(got!.truncated).toBe(true)
      expect(got!.startEpochSec).toBe(1000)
      expect(got!.leadInSec).toBe(0)
    })
  })

  it('caps the buffer by total duration, dropping the oldest audio first', () => {
    let t = 1000
    const store = makeClipStore({ capSec: 10, now: () => t })
    for (let i = 0; i < 30; i++) { t += 1; store.push(new Blob([new Uint8Array([i])]), 1) }
    const got = store.extract({ startEpochSec: 0, endEpochSec: 5000 })
    expect(got!.blob.size).toBe(10)
    expect(got!.truncated).toBe(true)
    expect(got!.startEpochSec).toBe(1020) // newest 10 s of a buffer that ends at 1030
  })
})
