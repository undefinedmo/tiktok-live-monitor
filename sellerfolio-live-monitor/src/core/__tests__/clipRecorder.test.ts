import { describe, it, expect, vi } from 'vitest'
import { makeClipStore, findClusterStart, clipTimingSuspect, CLIP_TIMING_TOLERANCE_SEC } from '../clipRecorder'

// The EBML id of a WebM Cluster: where the init segment (EBML header + Segment + Tracks) ends.
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75]
const HEADER = [0xee, 0xee, 0xee] // stand-in for the init segment's bytes

const blobOf = (...parts: number[][]) => new Blob(parts.map((p) => new Uint8Array(p)))
async function bytes(b: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await b.arrayBuffer()))
}

// A MediaRecorder's first chunk is the init segment (here with nothing after it); every later chunk
// is media. One byte per chunk, valued by the chunk's index, so a blob's bytes name the chunks in it.
async function recordingOf(n: number, opts: { capSec?: number; dur?: number; t0?: number } = {}) {
  const dur = opts.dur ?? 1
  let t = opts.t0 ?? 1000
  const store = makeClipStore({ capSec: opts.capSec ?? 300, now: () => t })
  await store.push(blobOf(HEADER), dur) // chunk [t0-dur, t0): the header, not audio
  for (let i = 0; i < n; i++) { t += dur; await store.push(blobOf([i]), dur) } // chunk i = [t0+dur*i, t0+dur*(i+1))
  return store
}

// A blob whose bytes are not readable until the test says so: holds a push "mid-arrayBuffer()".
function slowBlob(...parts: number[][]) {
  const blob = blobOf(...parts)
  const all = parts.flat()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  Object.defineProperty(blob, 'arrayBuffer', {
    value: async () => { await gate; return new Uint8Array(all).buffer },
  })
  return { blob, release }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('findClusterStart', () => {
  it('finds the first Cluster id, and says -1 when there is none', () => {
    expect(findClusterStart(new Uint8Array([9, 9, ...CLUSTER, 1, ...CLUSTER]))).toBe(2)
    expect(findClusterStart(new Uint8Array([9, 9, 9]))).toBe(-1)
    expect(findClusterStart(new Uint8Array([0x1f, 0x43, 0xb6]))).toBe(-1) // cut short
  })
})

describe('makeClipStore', () => {
  it('reassembles only the requested span, and reports truncation', async () => {
    const store = await recordingOf(30)

    const got = store.extract({ startEpochSec: 1010, endEpochSec: 1015 })
    expect(got!.durationSec).toBe(5)
    expect(got!.truncated).toBe(false)
    expect(got!.blob.size).toBe(HEADER.length + 5) // the init segment, then one byte per second pushed

    const early = store.extract({ startEpochSec: 500, endEpochSec: 1005 })
    expect(early!.truncated).toBe(true)
  })

  it('forgets everything on reset, so a new show cannot inherit the last show audio', async () => {
    const store = await recordingOf(5)
    store.reset()
    expect(store.extract({ startEpochSec: 999, endEpochSec: 1010 })).toBeNull()
  })

  it('has nothing to extract until the init segment has been read', async () => {
    const store = makeClipStore({ capSec: 300, now: () => 1000 })
    const pending = store.push(blobOf(HEADER), 1)
    expect(store.extract({ startEpochSec: 0, endEpochSec: 5000 })).toBeNull()
    await pending
    expect(store.extract({ startEpochSec: 0, endEpochSec: 5000 })).toBeNull() // header only, no audio yet
  })

  // ondataavailable fires when a slice has FINISHED, so a chunk pushed at t covers [t - dur, t).
  it('stamps a chunk as ending when it arrives', async () => {
    const store = makeClipStore({ capSec: 300, now: () => 1002 })
    await store.push(blobOf(HEADER), 1)
    await store.push(blobOf([7]), 2)
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
    const twoSecondChunks = () => recordingOf(10, { dur: 2 }) // chunk i = [1000+2i, 1002+2i)
    const media = async (b: Blob) => (await bytes(b)).slice(HEADER.length)

    it('returns whole chunks and describes the bytes, not the request', async () => {
      const got = (await twoSecondChunks()).extract({ startEpochSec: 1005, endEpochSec: 1009 })
      expect(await media(got!.blob)).toEqual([2, 3, 4]) // [1004,1006) [1006,1008) [1008,1010)
      expect(got!.startEpochSec).toBe(1004)             // the first byte's time, not 1005
      expect(got!.durationSec).toBe(6)                  // 1004..1010: includes the tail past 1009
      expect(got!.leadInSec).toBe(1)                    // 1005 - 1004
      expect(got!.truncated).toBe(false)
    })

    it('has no lead-in when the request lands on a chunk boundary', async () => {
      const got = (await twoSecondChunks()).extract({ startEpochSec: 1006, endEpochSec: 1010 })
      expect(await media(got!.blob)).toEqual([3, 4])
      expect(got!.startEpochSec).toBe(1006)
      expect(got!.leadInSec).toBe(0)
    })

    it('has no lead-in when truncated: the buffer start is the clip start', async () => {
      const got = (await twoSecondChunks()).extract({ startEpochSec: 900, endEpochSec: 1003 })
      expect(got!.truncated).toBe(true)
      expect(got!.startEpochSec).toBe(1000)
      expect(got!.leadInSec).toBe(0)
    })
  })

  it('caps the buffer by total duration, dropping the oldest audio first', async () => {
    const store = await recordingOf(30, { capSec: 10 })
    const got = store.extract({ startEpochSec: 0, endEpochSec: 5000 })
    expect(got!.blob.size).toBe(HEADER.length + 10) // the init segment is not part of the cap
    expect(got!.truncated).toBe(true)
    expect(got!.startEpochSec).toBe(1020) // newest 10 s of a buffer that ends at 1030
  })

  // A pruned ring buffer is not a decodable file: only the recorder's FIRST chunk carries the
  // container header, so a clip cut from later chunks needs that header put back in front.
  describe('the init segment', () => {
    it('leads every clip', async () => {
      const store = await recordingOf(5)
      const got = store.extract({ startEpochSec: 1002, endEpochSec: 1004 })
      expect(await bytes(got!.blob)).toEqual([...HEADER, 2, 3])
    })

    // The minute-five failure: the chunk that held the header has been pruned.
    it('survives the pruning of the chunk it arrived in', async () => {
      let t = 1000
      const store = makeClipStore({ capSec: 10, now: () => t })
      // A real first chunk holds the header AND the start of the first Cluster.
      await store.push(blobOf(HEADER, CLUSTER, [0]), 1)
      for (let i = 1; i < 40; i++) { t += 1; await store.push(blobOf([i]), 1) }

      const got = store.extract({ startEpochSec: 0, endEpochSec: 5000 })
      expect(got!.truncated).toBe(true)
      expect(got!.startEpochSec).toBe(1029) // newest 10 s of chunks ending at 1039: the first chunk is long gone
      expect(await bytes(got!.blob)).toEqual([...HEADER, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39])
    })

    // Chunk 0 is [init][first Cluster]. Keeping it whole AND prepending the init would put the
    // show's opening second in front of every clip, and the timestamps would not describe it.
    it('is cut off the first chunk, so that chunk is not heard twice', async () => {
      let t = 1000
      const store = makeClipStore({ capSec: 300, now: () => t })
      await store.push(blobOf(HEADER, CLUSTER, [0]), 1)
      t += 1
      await store.push(blobOf([1]), 1)
      const got = store.extract({ startEpochSec: 0, endEpochSec: 5000 })
      expect(await bytes(got!.blob)).toEqual([...HEADER, ...CLUSTER, 0, 1])
    })

    // No Cluster id in the first chunk means it is (or may be) all header. Better a slightly long
    // clip than none, so the whole chunk is kept as the init segment.
    it('keeps the whole first chunk when it holds no Cluster id', async () => {
      const store = await recordingOf(2)
      const got = store.extract({ startEpochSec: 0, endEpochSec: 5000 })
      expect(await bytes(got!.blob)).toEqual([...HEADER, 0, 1])
    })

    it('is dropped on reset, and the next recording supplies its own', async () => {
      let t = 1000
      const store = makeClipStore({ capSec: 300, now: () => t })
      await store.push(blobOf(HEADER), 1)
      store.reset()
      await store.push(blobOf([0xdd, 0xdd]), 1)
      t += 1
      await store.push(blobOf([5]), 1)
      const got = store.extract({ startEpochSec: 0, endEpochSec: 5000 })
      expect(await bytes(got!.blob)).toEqual([0xdd, 0xdd, 5])
    })
  })

  // THE TIMELINE MUST AGREE WITH THE BYTES. A chunk is stamped by the clock when it ARRIVES, and its
  // duration is nominal. Two real failures make the two disagree, and the server plans against the
  // timeline: a rebuffer drops the zero-size chunks (the seconds are simply not in the clip but are
  // still in `last.end - first.start`), and a clock that stands still stamps several chunks at one instant.
  // `gapSec` is `(last.end - first.start) - sum(durations)`: how much of the timeline has no audio under it
  // (positive), or how much audio there is beyond the timeline (negative). 0 for a healthy recording.
  describe('the clip timeline against its bytes', () => {
    /** Push 1 s chunks arriving at the given clock readings (a header first). */
    async function arrivingAt(readings: number[], dur = 1) {
      let t = 0
      const store = makeClipStore({ capSec: 300, now: () => t })
      await store.push(blobOf(HEADER), dur)
      for (const r of readings) { t = r; await store.push(blobOf([1]), dur) }
      return store
    }
    const all = { startEpochSec: 1000, endEpochSec: 5000 } // the buffer reaches back this far, so nothing is truncated

    it('is 0 for an unbroken recording', async () => {
      const got = (await recordingOf(30)).extract({ startEpochSec: 1005, endEpochSec: 1020 })!
      expect(got.gapSec).toBe(0)
      expect(clipTimingSuspect(got)).toBe(false)
    })

    // The reviewer's case: five seconds missing in the middle of 3 s of audio.
    it('reports five missing seconds: 8 s of timeline over 3 s of audio', async () => {
      const got = (await arrivingAt([1001, 1002, 1008])).extract(all)! // chunks [1000,1001) [1001,1002) [1007,1008)
      expect(got.durationSec).toBe(8) // the timeline, as before
      expect(got.gapSec).toBe(5) //      ... and now it says it is 5 s longer than the audio
      expect(got.truncated).toBe(false) // a gap is NOT "the buffer began late": that flag keeps its meaning
      expect(clipTimingSuspect(got)).toBe(true)
    })

    // The reviewer's other case: a frozen clock stamps four chunks at one instant.
    it('reports a frozen clock: 1 s of timeline over 4 s of audio', async () => {
      const got = (await arrivingAt([1001, 1001, 1001, 1001])).extract(all)!
      expect(got.durationSec).toBe(1)
      expect(got.gapSec).toBe(-3)
      expect(got.truncated).toBe(false)
      expect(clipTimingSuspect(got)).toBe(true)
    })

    it('counts only the chunks in the clip, not the ones outside it', async () => {
      // a gap of 5 s BEFORE the requested window must not make the window's clip look broken
      const store = await arrivingAt([1001, 1002, 1008, 1009, 1010, 1011])
      const got = store.extract({ startEpochSec: 1007, endEpochSec: 1012 })!
      expect(got.gapSec).toBe(0)
    })

    it('is 0 for a single chunk', async () => {
      expect((await arrivingAt([1001])).extract(all)!.gapSec).toBe(0)
    })

    // 0.1 s chunks: three of them sum to 0.30000000000000004 and span 0.29999999999999954 (measured), so the
    // raw difference is dust of either sign. It must read as exactly 0, and never as -0.
    it.each([3, 7])('is rounded to the millisecond, so float dust (%s chunks of 0.1 s) never reads as a gap', async (n) => {
      const readings = Array.from({ length: n }, (_, i) => 1000 + (i + 1) * 0.1)
      const got = (await arrivingAt(readings, 0.1)).extract({ startEpochSec: 999, endEpochSec: 5000 })!
      expect(got.gapSec).toBe(0) // toBe is Object.is: -0 fails it
    })

    it('keeps a fractional gap as it is (to the millisecond), not rounded to a whole second', async () => {
      const got = (await arrivingAt([1001, 1002, 1005.5])).extract(all)! // chunks [1000,1001) [1001,1002) [1004.5,1005.5)
      expect(got.durationSec).toBe(5.5)
      expect(got.gapSec).toBe(2.5)
      expect((await arrivingAt([1001, 1002, 1005.0004])).extract(all)!.gapSec).toBe(2) // 2.0004 -> 2.000
    })

    // Chunk arrival jitters by a few hundred ms and a recorder's slices are not exactly 1 s; those must
    // not raise the alarm. The tolerance is exact, not a ">= something": it is the line between a clip
    // whose timing is trusted and one that is flagged.
    it('tolerates exactly CLIP_TIMING_TOLERANCE_SEC either way and flags anything beyond it', () => {
      expect(CLIP_TIMING_TOLERANCE_SEC).toBe(2)
      expect(clipTimingSuspect({ gapSec: 2 })).toBe(false)
      expect(clipTimingSuspect({ gapSec: -2 })).toBe(false)
      expect(clipTimingSuspect({ gapSec: 2.001 })).toBe(true)
      expect(clipTimingSuspect({ gapSec: -2.001 })).toBe(true)
      expect(clipTimingSuspect({ gapSec: 0 })).toBe(false)
    })
  })

  // The queue. push is async, so ORDER and the show boundary are both things the code has to hold.
  describe('pushes in flight', () => {
    it('land in call order when none is awaited', async () => {
      let t = 1000
      const store = makeClipStore({ capSec: 300, now: () => t })
      const all = [store.push(blobOf(HEADER), 1)]
      for (let i = 0; i < 4; i++) { t += 1; all.push(store.push(blobOf([i]), 1)) }
      await Promise.all(all)
      const got = store.extract({ startEpochSec: 0, endEpochSec: 5000 })
      expect(await bytes(got!.blob)).toEqual([...HEADER, 0, 1, 2, 3])
    })

    // The show ends mid-queue: a chunk still being read must not turn up in the next show's buffer.
    it('a reset while the first chunk is being read keeps that chunk out of the next show', async () => {
      let t = 1000
      const store = makeClipStore({ capSec: 300, now: () => t })
      const stale = slowBlob([0xaa, 0xaa], CLUSTER, [9])
      const stalePush = store.push(stale.blob, 1)
      await tick() // the old show's first chunk is now mid-arrayBuffer()
      store.reset()

      await store.push(blobOf(HEADER), 1)
      t += 1
      await store.push(blobOf([1]), 1)
      stale.release() // the old read finishes only now
      await stalePush

      const got = store.extract({ startEpochSec: 0, endEpochSec: 5000 })
      expect(await bytes(got!.blob)).toEqual([...HEADER, 1]) // not the stale header, not the stale cluster
    })

    it('a reset drops chunks still queued behind a slow read', async () => {
      let t = 1000
      const store = makeClipStore({ capSec: 300, now: () => t })
      const slow = slowBlob(HEADER)
      const first = store.push(slow.blob, 1)
      t += 1
      const queued = store.push(blobOf([7]), 1) // waits behind the slow read
      store.reset()

      await store.push(blobOf([0xdd]), 1)
      t += 1
      await store.push(blobOf([8]), 1)
      slow.release()
      await Promise.all([first, queued])

      const got = store.extract({ startEpochSec: 0, endEpochSec: 5000 })
      expect(await bytes(got!.blob)).toEqual([0xdd, 8])
    })
  })

  // Without a header nothing decodes, and a Cluster-only chunk promoted to "init" would be an EMPTY
  // header: every clip for the rest of the show silently undecodable. Fail loudly and serve nothing.
  describe('a first chunk that cannot give an init segment', () => {
    const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {})

    it('is not replaced by the next chunk when its read throws', async () => {
      const err = quiet()
      let t = 1000
      const store = makeClipStore({ capSec: 300, now: () => t })
      const broken = blobOf(HEADER)
      Object.defineProperty(broken, 'arrayBuffer', { value: () => Promise.reject(new Error('read failed')) })
      await store.push(broken, 1)
      t += 1
      await store.push(blobOf([1]), 1) // plain media: promoting it would make a headerless recording
      t += 1
      await store.push(blobOf(CLUSTER, [2]), 1) // pure Cluster: promoting it would make an EMPTY init
      for (let i = 3; i < 6; i++) { t += 1; await store.push(blobOf([i]), 1) } // plain chunks that would be served
      expect(store.extract({ startEpochSec: 0, endEpochSec: 5000 })).toBeNull()
      expect(err).toHaveBeenCalled()
      err.mockRestore()
    })

    it('is not accepted when it starts at a Cluster (an empty init)', async () => {
      const err = quiet()
      let t = 1000
      const store = makeClipStore({ capSec: 300, now: () => t })
      await store.push(blobOf(CLUSTER, [0]), 1)
      t += 1
      for (let i = 1; i < 4; i++) { t += 1; await store.push(blobOf([i]), 1) } // plain chunks that would be served
      expect(store.extract({ startEpochSec: 0, endEpochSec: 5000 })).toBeNull()
      expect(err).toHaveBeenCalledTimes(1) // said once, not once per chunk
      err.mockRestore()
    })

    it('recovers on reset, when a new recording supplies a real header', async () => {
      const err = quiet()
      let t = 1000
      const store = makeClipStore({ capSec: 300, now: () => t })
      await store.push(blobOf(CLUSTER, [0]), 1)
      store.reset()
      await store.push(blobOf(HEADER), 1)
      t += 1
      await store.push(blobOf([1]), 1)
      const got = store.extract({ startEpochSec: 0, endEpochSec: 5000 })
      expect(await bytes(got!.blob)).toEqual([...HEADER, 1])
      err.mockRestore()
    })
  })
})
