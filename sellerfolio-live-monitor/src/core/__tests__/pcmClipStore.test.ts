import { describe, expect, it } from 'vitest'
import { CLIP_SAMPLE_RATE, encodeWav, makePcmClipStore } from '../pcmClipStore'

const ascii = (u: Uint8Array, at: number, n: number) =>
  String.fromCharCode(...Array.from(u.slice(at, at + n)))
const u32 = (u: Uint8Array, at: number) => new DataView(u.buffer, u.byteOffset).getUint32(at, true)
const u16 = (u: Uint8Array, at: number) => new DataView(u.buffer, u.byteOffset).getUint16(at, true)
const i16at = (u: Uint8Array, i: number) =>
  new DataView(u.buffer, u.byteOffset).getInt16(44 + i * 2, true)

/** A ramp, so a test can tell WHICH samples it got back, not merely how many. */
const ramp = (n: number, from = 0) => Int16Array.from({ length: n }, (_, i) => from + i)

describe('encodeWav', () => {
  it('writes a mono 16-bit PCM header ffmpeg can read', () => {
    const w = encodeWav(ramp(4), 16000)
    expect(ascii(w, 0, 4)).toBe('RIFF')
    expect(ascii(w, 8, 4)).toBe('WAVE')
    expect(ascii(w, 12, 4)).toBe('fmt ')
    expect(u32(w, 16)).toBe(16) // fmt chunk size
    expect(u16(w, 20)).toBe(1) // PCM, uncompressed
    expect(u16(w, 22)).toBe(1) // mono
    expect(u32(w, 24)).toBe(16000) // sample rate
    expect(u32(w, 28)).toBe(16000 * 2) // byte rate
    expect(u16(w, 32)).toBe(2) // block align
    expect(u16(w, 34)).toBe(16) // bits per sample
    expect(ascii(w, 36, 4)).toBe('data')
  })

  it('states its own lengths, so a reader is never told more audio than it holds', () => {
    const w = encodeWav(ramp(10), 16000)
    expect(w.length).toBe(44 + 20)
    expect(u32(w, 4)).toBe(36 + 20) // RIFF size = everything after this field
    expect(u32(w, 40)).toBe(20) // data size
  })

  it('keeps the samples, little-endian and signed', () => {
    const w = encodeWav(Int16Array.from([0, 1, -1, 32767, -32768]), 8000)
    expect([0, 1, 2, 3, 4].map((i) => i16at(w, i))).toEqual([0, 1, -1, 32767, -32768])
  })
})

describe('makePcmClipStore', () => {
  // A tiny rate keeps the arithmetic readable: 1 sample = 1/8 s.
  const store = (now: () => number, capSec = 10) =>
    makePcmClipStore({ sampleRate: 8, capSec, now })

  it('has nothing to give before any audio arrives', () => {
    const s = store(() => 100)
    expect(s.extract({ startEpochSec: 99, endEpochSec: 100 })).toBeNull()
  })

  it('cuts exactly the window asked for, so there is no lead-in to correct for', async () => {
    let t = 100
    const s = store(() => t)
    t = 101
    s.push(ramp(8)) // covers [100, 101)
    t = 102
    s.push(ramp(8, 8)) // covers [101, 102)
    const clip = s.extract({ startEpochSec: 100.5, endEpochSec: 101.5 })!
    expect(clip.startEpochSec).toBeCloseTo(100.5, 6)
    expect(clip.durationSec).toBeCloseTo(1, 6)
    expect(clip.leadInSec).toBe(0)
    expect(clip.truncated).toBe(false)
    const w = new Uint8Array(await clip.blob.arrayBuffer())
    expect(u32(w, 40)).toBe(8 * 2) // one second at 8 Hz
    expect([0, 1, 2, 3].map((i) => i16at(w, i))).toEqual([4, 5, 6, 7]) // the second half of push 1
  })

  it('says so when the buffer did not reach back far enough', () => {
    let t = 100
    const s = store(() => t)
    t = 101
    s.push(ramp(8))
    const clip = s.extract({ startEpochSec: 80, endEpochSec: 101 })!
    expect(clip.truncated).toBe(true)
    expect(clip.startEpochSec).toBeCloseTo(100, 6)
    expect(clip.durationSec).toBeCloseTo(1, 6)
  })

  it('returns null for a window that ends before any audio it holds', () => {
    let t = 100
    const s = store(() => t)
    t = 101
    s.push(ramp(8))
    expect(s.extract({ startEpochSec: 50, endEpochSec: 60 })).toBeNull()
  })

  it('never claims audio past the newest sample', () => {
    let t = 100
    const s = store(() => t)
    t = 101
    s.push(ramp(8))
    const clip = s.extract({ startEpochSec: 100.5, endEpochSec: 200 })!
    expect(clip.durationSec).toBeCloseTo(0.5, 6)
  })

  it('drops the oldest audio once it is fuller than its cap', async () => {
    let t = 100
    const s = store(() => t, 2) // 2 s cap = 16 samples
    for (let i = 0; i < 5; i++) { t = 101 + i; s.push(ramp(8, i * 8)) }
    // 5 s pushed into a 2 s ring: only [103, 105) survives
    expect(s.extract({ startEpochSec: 100, endEpochSec: 101 })).toBeNull()
    const clip = s.extract({ startEpochSec: 100, endEpochSec: 105 })!
    expect(clip.truncated).toBe(true)
    expect(clip.durationSec).toBeCloseTo(2, 6)
    const w = new Uint8Array(await clip.blob.arrayBuffer())
    expect(i16at(w, 0)).toBe(24) // first surviving sample of the ramp
  })

  // The time axis must stay linear, or every later window is cut from the wrong moment. A stall
  // (a suspended context, a stalled stream) is therefore filled with silence and reported.
  it('fills a stall with silence so the time axis never shifts', async () => {
    let t = 100
    const s = store(() => t)
    t = 101
    s.push(ramp(8, 1)) // non-zero, so silence is distinguishable
    t = 104 // two seconds went by with no audio at all
    s.push(ramp(8, 1))
    const clip = s.extract({ startEpochSec: 100, endEpochSec: 104 })!
    expect(clip.durationSec).toBeCloseTo(4, 6)
    expect(clip.gapSec).toBeCloseTo(2, 6)
    const w = new Uint8Array(await clip.blob.arrayBuffer())
    expect(u32(w, 40)).toBe(32 * 2) // four seconds of samples, not two
    expect(i16at(w, 8)).toBe(0) // the stall reads as silence
    expect(i16at(w, 23)).toBe(0)
    expect(i16at(w, 24)).toBe(1) // and real audio resumes in its right place
  })

  it('is healthy when audio arrives on time', () => {
    let t = 100
    const s = store(() => t)
    t = 101
    s.push(ramp(8))
    t = 102
    s.push(ramp(8))
    expect(s.extract({ startEpochSec: 100, endEpochSec: 102 })!.gapSec).toBe(0)
  })

  it('forgets everything on reset, so one show never inherits another audio', () => {
    let t = 100
    const s = store(() => t)
    t = 101
    s.push(ramp(8))
    s.reset()
    expect(s.extract({ startEpochSec: 100, endEpochSec: 101 })).toBeNull()
  })

  it('is 16 kHz by default: speech, at a third of the bytes of the capture rate', () => {
    expect(CLIP_SAMPLE_RATE).toBe(16000)
  })
})
