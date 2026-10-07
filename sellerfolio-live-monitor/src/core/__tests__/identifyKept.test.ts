import { describe, expect, it } from 'vitest'
import type { WireClip } from '../identifySend'
import {
  MAX_KEPT_AGE_MS,
  MAX_KEPT_BYTES,
  MAX_KEPT_CLIPS,
  MAX_KEPT_CLIP_BYTES,
  chooseEvictions,
  keptStem,
  metaFromWire,
  parseKeptMeta,
  shouldKeepClip,
  wireFromKept,
} from '../identifyKept'
import { fromWirePayload } from '../identifySend'

// A clip that failed to identify is kept on disk so that Retry still has the audio after a restart (or
// after the 5-minute buffer has rolled past it). This is the pure half: what is kept, how a file is named,
// what is read back, and what is thrown away. The disk half is electron/identifyClips.
const NOW = 1_800_000_000_000
const bytes = (n: number) => new Uint8Array(n).fill(7) as Uint8Array<ArrayBuffer>
const wireClip = (o: Partial<WireClip> = {}): WireClip => ({ bytes: bytes(10), startEpochSec: 1_799_999_900, durationSec: 80, leadInSec: 1.5, truncated: false, gapSec: 0, ...o })
const job = { orderId: '576460752303423488', roomId: 'r1', saleEpochSec: 1_799_999_980, auctionStartEpochSec: 1_799_999_950, prevBoundaryEpochSec: 1_799_999_900 }
const payload = (o: { job?: object; clip?: Partial<WireClip> } = {}) => ({ job: { ...job, ...(o.job ?? {}) }, clip: wireClip(o.clip) })

describe('shouldKeepClip: which outcomes leave a clip on disk', () => {
  it('keeps what failed or was abandoned (the audio is what a retry needs)', () => {
    expect(shouldKeepClip('failed')).toBe(true)
    expect(shouldKeepClip('abandoned')).toBe(true)
  })
  it('does not keep what settled: identified, or nothing to identify in it', () => {
    expect(shouldKeepClip('identified')).toBe(false)
    expect(shouldKeepClip('skipped')).toBe(false)
  })
  it('does not keep a status it has never heard of', () => {
    expect(shouldKeepClip('something-new')).toBe(false)
  })
})

describe('keptStem: a file name that cannot escape the folder', () => {
  it('is the order id itself when that is plainly safe', () => {
    expect(keptStem('576460752303423488')).toBe('k576460752303423488')
    expect(keptStem('ab_C-9')).toBe('kab_C-9')
  })
  it.each([['../../etc/passwd'], ['a/b'], ['a\\b'], ['C:evil'], ['con.txt'], ['a b'], ['x'.repeat(65)], ['é'], ['']])('hashes %j instead of using it', (id) => {
    const stem = keptStem(id)
    expect(stem).toMatch(/^h[0-9a-z]+$/)
    expect(stem).not.toMatch(/[./\\:\s]/)
  })
  it('is stable, and different ids get different names', () => {
    expect(keptStem('../x')).toBe(keptStem('../x'))
    expect(keptStem('../x')).not.toBe(keptStem('../y'))
  })
  it('names two long unsafe ids that differ only far into them differently (the whole id is hashed)', () => {
    const a = '../../a-very-long-order-id/with/slashes/1'
    const b = '../../a-very-long-order-id/with/slashes/2'
    expect(keptStem(a)).not.toBe(keptStem(b))
  })
  it('a safe id and a hashed one can never collide (different first letter)', () => {
    expect(keptStem('abc')[0]).toBe('k')
    expect(keptStem('a b')[0]).toBe('h')
  })
})

describe('metaFromWire: what is written beside the audio', () => {
  it('carries the job and the clip fields as sent, the time, and the version -- and not the bytes', () => {
    const m = metaFromWire(payload(), NOW)!
    expect(m).toEqual({
      v: 1,
      orderId: job.orderId,
      savedAtMs: NOW,
      byteLength: 10,
      job,
      clip: { startEpochSec: 1_799_999_900, durationSec: 80, leadInSec: 1.5, truncated: false, gapSec: 0 },
    })
    expect(JSON.stringify(m)).not.toContain('bytes')
  })
  it('rebuilds the job from known fields only: nothing else rides into the file', () => {
    const m = metaFromWire(payload({ job: { token: 'sfc_SECRET', extra: 1 } }), NOW)!
    expect(JSON.stringify(m)).not.toContain('SECRET')
    expect(Object.keys(m.job).sort()).toEqual(['auctionStartEpochSec', 'orderId', 'prevBoundaryEpochSec', 'roomId', 'saleEpochSec'])
  })
  it('a room id is kept up to 120 characters and dropped (null) beyond that, like an order id', () => {
    expect(metaFromWire(payload({ job: { roomId: 'r'.repeat(120) } }), NOW)!.job.roomId).toBe('r'.repeat(120))
    expect(metaFromWire(payload({ job: { roomId: 'r'.repeat(121) } }), NOW)!.job.roomId).toBeNull()
    expect(metaFromWire(payload({ job: { roomId: 7 } }), NOW)!.job.roomId).toBeNull()
  })
  it('keeps a missing boundary as null, and a null room as null', () => {
    const m = metaFromWire(payload({ job: { roomId: null, auctionStartEpochSec: null, prevBoundaryEpochSec: undefined } }), NOW)!
    expect(m.job).toEqual({ orderId: job.orderId, roomId: null, saleEpochSec: job.saleEpochSec, auctionStartEpochSec: null, prevBoundaryEpochSec: null })
  })
  it.each([
    ['no job', { job: undefined }],
    ['an empty order id', { job: { orderId: '' } }],
    ['an order id that is not a string', { job: { orderId: 5 } }],
    ['an over-long order id', { job: { orderId: 'x'.repeat(121) } }],
    ['a sale time in milliseconds', { job: { saleEpochSec: 1.8e12 } }],
    ['a sale time that is not a number', { job: { saleEpochSec: '1799999980' } }],
    ['a clip start in milliseconds', { clip: { startEpochSec: 1.8e12 } }],
    ['an auction start in milliseconds', { job: { auctionStartEpochSec: 1.8e12 } }],
    ['a wall in milliseconds', { job: { prevBoundaryEpochSec: 1.8e12 } }],
    ['a negative clip duration', { clip: { durationSec: -1 } }],
    ['a clip duration that is NaN', { clip: { durationSec: NaN } }],
    ['no audio bytes', { clip: { bytes: new Uint8Array(0) as Uint8Array<ArrayBuffer> } }],
    ['bytes that are not bytes', { clip: { bytes: 'abc' as never } }],
    ['audio over the per-clip cap', { clip: { bytes: new Uint8Array(MAX_KEPT_CLIP_BYTES + 1) as Uint8Array<ArrayBuffer> } }],
    ['a truncated flag that is not a boolean', { clip: { truncated: 'yes' as never } }],
  ])('refuses %s', (_n, over) => {
    const p = payload(over as never)
    if ('job' in over && over.job === undefined) (p as { job?: unknown }).job = undefined
    expect(metaFromWire(p as never, NOW)).toBeNull()
  })
  it('the per-clip cap is a number someone chose, and a clip exactly at it is kept', () => {
    expect(MAX_KEPT_CLIP_BYTES).toBe(16 * 1024 * 1024)
    expect(metaFromWire(payload({ clip: { bytes: new Uint8Array(MAX_KEPT_CLIP_BYTES) as Uint8Array<ArrayBuffer> } }), NOW)).not.toBeNull()
  })
})

describe('parseKeptMeta: the file is not trusted', () => {
  const good = () => JSON.parse(JSON.stringify(metaFromWire(payload(), NOW)))
  it('reads back exactly what metaFromWire wrote', () => {
    expect(parseKeptMeta(good())).toEqual(metaFromWire(payload(), NOW))
  })
  it.each([[null], [undefined], ['x'], [42], [[]], [{}]])('is null for %j', (v) => {
    expect(parseKeptMeta(v)).toBeNull()
  })
  it('is null for a version it does not know, in either direction', () => {
    expect(parseKeptMeta({ ...good(), v: 2 })).toBeNull()
    expect(parseKeptMeta({ ...good(), v: 0 })).toBeNull()
    expect(parseKeptMeta({ ...good(), v: undefined })).toBeNull()
  })
  it('is null when a field is the wrong type', () => {
    expect(parseKeptMeta({ ...good(), orderId: 7 })).toBeNull()
    expect(parseKeptMeta({ ...good(), savedAtMs: 'x' })).toBeNull()
    expect(parseKeptMeta({ ...good(), byteLength: 'x' })).toBeNull()
    expect(parseKeptMeta({ ...good(), byteLength: 0 })).toBeNull()
    expect(parseKeptMeta({ ...good(), job: null })).toBeNull()
    expect(parseKeptMeta({ ...good(), clip: { ...good().clip, startEpochSec: 'x' } })).toBeNull()
  })
  it('is null when the job names a different order than the file does', () => {
    expect(parseKeptMeta({ ...good(), job: { ...good().job, orderId: 'someone-else' } })).toBeNull()
  })
  it('a clip written before gapSec existed reads as gapSec 0', () => {
    const g = good()
    delete g.clip.gapSec
    expect(parseKeptMeta(g)!.clip.gapSec).toBe(0)
  })
})

describe('every clip field survives the round trip, with values that are not the defaults', () => {
  const odd = payload({ clip: { startEpochSec: 1_799_999_901.25, durationSec: 77.5, leadInSec: 1.75, truncated: true, gapSec: -3.5 } })

  it('metaFromWire -> JSON -> parseKeptMeta -> wireFromKept gives the clip back field for field', () => {
    const meta = parseKeptMeta(JSON.parse(JSON.stringify(metaFromWire(odd, NOW))))!
    const back = wireFromKept(meta, odd.clip.bytes)
    expect(back.clip).toEqual(odd.clip)
    expect(back.job).toEqual(odd.job)
  })
  it('and fromWirePayload rebuilds each of them on the clip the queue sends', () => {
    const p = fromWirePayload(odd)
    expect({ startEpochSec: p.clip.startEpochSec, durationSec: p.clip.durationSec, leadInSec: p.clip.leadInSec, truncated: p.clip.truncated, gapSec: p.clip.gapSec }).toEqual({
      startEpochSec: 1_799_999_901.25, durationSec: 77.5, leadInSec: 1.75, truncated: true, gapSec: -3.5,
    })
    expect(p.job).toBe(odd.job)
  })
})

describe('wireFromKept / fromWirePayload: back to what the queue sends', () => {
  it('is the payload that was kept: same job, same clip fields, the same bytes', async () => {
    const original = payload()
    const meta = metaFromWire(original, NOW)!
    const back = wireFromKept(meta, original.clip.bytes)
    expect(back.job).toEqual(original.job)
    expect({ ...back.clip, bytes: undefined }).toEqual({ ...original.clip, bytes: undefined })
    const p = fromWirePayload(back)
    expect(p.job).toBe(back.job)
    expect(p.clip.startEpochSec).toBe(original.clip.startEpochSec)
    expect(p.clip.durationSec).toBe(80)
    expect(p.clip.gapSec).toBe(0)
    expect(new Uint8Array(await p.clip.blob.arrayBuffer())).toEqual(original.clip.bytes)
  })
})

describe('chooseEvictions: what to delete', () => {
  const e = (stem: string, ageH: number, mb = 1) => ({ stem, savedAtMs: NOW - ageH * 3_600_000, bytes: mb * 1024 * 1024 })

  it('names the limits', () => {
    expect([MAX_KEPT_CLIPS, MAX_KEPT_BYTES, MAX_KEPT_AGE_MS]).toEqual([60, 150 * 1024 * 1024, 7 * 24 * 3_600_000])
  })
  it('deletes nothing when everything fits', () => {
    expect(chooseEvictions([e('a', 1), e('b', 2)], NOW)).toEqual([])
  })
  it('deletes what is older than the age limit, and keeps what is exactly at it', () => {
    const atLimit = { stem: 'edge', savedAtMs: NOW - MAX_KEPT_AGE_MS, bytes: 10 }
    const over = { stem: 'over', savedAtMs: NOW - MAX_KEPT_AGE_MS - 1, bytes: 10 }
    expect(chooseEvictions([atLimit, over], NOW)).toEqual(['over'])
  })
  it('keeps the newest MAX_KEPT_CLIPS and deletes the oldest beyond that', () => {
    const many = Array.from({ length: MAX_KEPT_CLIPS + 3 }, (_, i) => ({ stem: `s${i}`, savedAtMs: NOW - i * 1000, bytes: 10 })) // s0 newest
    expect(chooseEvictions(many, NOW).sort()).toEqual([`s${MAX_KEPT_CLIPS}`, `s${MAX_KEPT_CLIPS + 1}`, `s${MAX_KEPT_CLIPS + 2}`].sort())
  })
  it('exactly MAX_KEPT_CLIPS is kept', () => {
    const exact = Array.from({ length: MAX_KEPT_CLIPS }, (_, i) => ({ stem: `s${i}`, savedAtMs: NOW - i * 1000, bytes: 10 }))
    expect(chooseEvictions(exact, NOW)).toEqual([])
  })
  it('deletes the oldest until the total fits the byte limit, never the newest first', () => {
    const mb = 1024 * 1024
    const entries = [
      { stem: 'newest', savedAtMs: NOW - 1000, bytes: 100 * mb },
      { stem: 'middle', savedAtMs: NOW - 2000, bytes: 40 * mb },
      { stem: 'oldest', savedAtMs: NOW - 3000, bytes: 40 * mb },
    ]
    expect(chooseEvictions(entries, NOW)).toEqual(['oldest']) // 100 + 40 = 140 <= 150 < 180
  })
  it('once a limit is hit everything older goes too: a small old clip never outlives a newer big one', () => {
    const mb = 1024 * 1024
    const entries = [
      { stem: 'newest', savedAtMs: NOW - 1000, bytes: 100 * mb },
      { stem: 'overflow', savedAtMs: NOW - 2000, bytes: 100 * mb },
      { stem: 'tiny-old', savedAtMs: NOW - 3000, bytes: 1 * mb }, // 101 MB would fit, but it is older than what overflowed
    ]
    expect(chooseEvictions(entries, NOW).sort()).toEqual(['overflow', 'tiny-old'])
  })
  it('exactly the byte limit is kept', () => {
    expect(chooseEvictions([{ stem: 'a', savedAtMs: NOW, bytes: MAX_KEPT_BYTES }], NOW)).toEqual([])
    expect(chooseEvictions([{ stem: 'a', savedAtMs: NOW, bytes: MAX_KEPT_BYTES + 1 }], NOW)).toEqual(['a'])
  })
  it('does not depend on the order it is given', () => {
    const entries = [e('b', 2), e('a', 1), e('c', 24 * 8)]
    expect(chooseEvictions(entries, NOW)).toEqual(chooseEvictions([...entries].reverse(), NOW))
    expect(chooseEvictions(entries, NOW)).toEqual(['c'])
  })
})
