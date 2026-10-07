import { describe, it, expect } from 'vitest'
import { buildIdentifyRequest, isRetryable, readIdentifyResponse, type IdentifyAnswer, type IdentifyOutcome } from '../identifyClient'
import type { ExtractedClip } from '../clipRecorder'
import { makeIdentifyQueue } from '../identifyQueue'

const job = {
  orderId: 'o1',
  roomId: 'r1',
  saleEpochSec: 1700000000,
  auctionStartEpochSec: 1699999970,
  prevBoundaryEpochSec: null,
}
// Built the way the clip store returns it: the bytes' own start/duration, plus how they relate to the request.
const clip: ExtractedClip = { blob: new Blob(['x']), startEpochSec: 1699999965, durationSec: 40, leadInSec: 2, truncated: false, gapSec: 0 }
const cfg = { baseUrl: 'http://100.68.11.76:8099', token: 't' }

const metaOf = (form: FormData) => JSON.parse(form.get('meta') as string) as Record<string, unknown>

describe('buildIdentifyRequest', () => {
  it('posts to the worker with a Bearer token and no hand-set content type', () => {
    const { url, headers } = buildIdentifyRequest(job, clip, cfg)
    expect(url).toBe('http://100.68.11.76:8099/api/capture/live-identify')
    expect(headers).toEqual({ Authorization: 'Bearer t' })
  })

  it('sends every epoch in SECONDS under the exact keys the server parses', () => {
    const meta = metaOf(buildIdentifyRequest(job, clip, cfg).form)
    expect(meta).toMatchObject({
      orderId: 'o1',
      roomId: 'r1',
      saleEpochSec: 1700000000,
      clipStartEpochSec: 1699999965,
      clipDurationSec: 40,
      auctionStartEpochSec: 1699999970,
    })
    for (const k of ['saleEpochSec', 'clipStartEpochSec', 'auctionStartEpochSec']) {
      expect(String(meta[k]), k).toHaveLength(10) // seconds, not milliseconds
    }
  })

  it('omits an absent optional field instead of sending null', () => {
    // The server treats both the same today; omitting keeps the wire format to what was known.
    const meta = metaOf(buildIdentifyRequest({ ...job, roomId: null, auctionStartEpochSec: null }, clip, cfg).form)
    expect(Object.keys(meta).sort()).toEqual(['clipDurationSec', 'clipStartEpochSec', 'orderId', 'saleEpochSec'])
    const bare = metaOf(buildIdentifyRequest({ orderId: 'o2', roomId: null, saleEpochSec: 1700000000 }, clip, cfg).form)
    expect(bare).not.toHaveProperty('prevBoundaryEpochSec')
    expect(bare).not.toHaveProperty('auctionStartEpochSec')
  })

  it('sends prevBoundaryEpochSec when it is known', () => {
    const meta = metaOf(buildIdentifyRequest({ ...job, prevBoundaryEpochSec: 1699999900 }, clip, cfg).form)
    expect(meta.prevBoundaryEpochSec).toBe(1699999900)
  })

  it("describes the clip's own bytes, never a window the job happens to carry", () => {
    // A job smuggling the originally requested window (a caller that spread a bigger object in)
    // must not override what the clip says about itself.
    const sneaky = { ...job, clipStartEpochSec: 1, clipDurationSec: 999 } as typeof job
    const meta = metaOf(buildIdentifyRequest(sneaky, { ...clip, startEpochSec: 1699999961, durationSec: 44 }, cfg).form)
    expect(meta.clipStartEpochSec).toBe(1699999961)
    expect(meta.clipDurationSec).toBe(44)
  })

  it('attaches the clip bytes as the audio part', async () => {
    const audio = buildIdentifyRequest(job, { ...clip, blob: new Blob(['abc'], { type: 'audio/webm' }) }, cfg).form.get('audio') as File
    expect(audio).toBeInstanceOf(File)
    expect(audio.size).toBe(3)
  })

  it('does not double the slash when the base URL ends in one', () => {
    expect(buildIdentifyRequest(job, clip, { ...cfg, baseUrl: 'http://100.68.11.76:8099/' }).url).toBe(
      'http://100.68.11.76:8099/api/capture/live-identify',
    )
  })

  it('refuses an epoch that is really milliseconds rather than ship a plausible wrong window', () => {
    const ms = 1700000000 * 1000
    expect(() => buildIdentifyRequest({ ...job, saleEpochSec: ms }, clip, cfg)).toThrow(/saleEpochSec/)
    expect(() => buildIdentifyRequest(job, { ...clip, startEpochSec: ms }, cfg)).toThrow(/clipStartEpochSec/)
    expect(() => buildIdentifyRequest({ ...job, auctionStartEpochSec: ms }, clip, cfg)).toThrow(/auctionStartEpochSec/)
    expect(() => buildIdentifyRequest({ ...job, prevBoundaryEpochSec: ms }, clip, cfg)).toThrow(/prevBoundaryEpochSec/)
    expect(() => buildIdentifyRequest({ ...job, saleEpochSec: NaN }, clip, cfg)).toThrow(/saleEpochSec/)
  })

  it('never puts the token anywhere but the Authorization header', async () => {
    const { url, headers, form } = buildIdentifyRequest(job, clip, { ...cfg, token: 'SECRET-TOKEN' })
    expect(url).not.toContain('SECRET-TOKEN')
    expect(headers).toEqual({ Authorization: 'Bearer SECRET-TOKEN' })
    // Every multipart entry, field or file: a body is logged and stored wherever it travels.
    const entries = [...form.entries()]
    expect(entries.map(([k]) => k).sort()).toEqual(['audio', 'meta'])
    for (const [k, v] of entries) {
      const text = typeof v === 'string' ? v : await v.text()
      expect(text, k).not.toContain('SECRET-TOKEN')
      expect(k).not.toContain('SECRET-TOKEN')
      if (typeof v !== 'string') expect(v.name, `${k} filename`).not.toContain('SECRET-TOKEN')
    }
    const thrown = (): unknown => {
      try {
        buildIdentifyRequest({ ...job, saleEpochSec: 1e15 }, clip, { ...cfg, token: 'SECRET-TOKEN' })
      } catch (e) {
        return e
      }
      return undefined
    }
    expect(thrown()).toBeInstanceOf(RangeError)
    expect(String(thrown())).not.toContain('SECRET-TOKEN')
  })
})

describe('readIdentifyResponse', () => {
  it('reads a 200 identified, keeping the spend facts', () => {
    expect(readIdentifyResponse(200, { status: 'identified', attempts: 2, escalated: true })).toEqual({
      status: 'identified',
      attempts: 2,
      escalated: true,
    })
  })

  it('reads a 200 skipped as settled, not failed: the lot already has its answer', () => {
    expect(readIdentifyResponse(200, { status: 'skipped', reason: 'already-identified' })).toEqual({
      status: 'skipped',
      reason: 'already-identified',
    })
  })

  it('names each refusal with a reason a human can act on', () => {
    expect(readIdentifyResponse(401, { error: 'unauthorized' })).toMatchObject({ status: 'failed', reason: 'bad_token' })
    expect(readIdentifyResponse(413, { error: 'audio_too_large', maxBytes: 26214400 })).toMatchObject({
      status: 'failed',
      reason: 'audio_too_large',
    })
    expect(readIdentifyResponse(503, { error: 'live_identify_unavailable' })).toMatchObject({
      status: 'failed',
      reason: 'live_identify_unavailable',
    })
  })

  it('keeps the reason the server gave on a 502 instead of flattening it', () => {
    expect(readIdentifyResponse(502, { status: 'failed', reason: 'quota_reached' })).toMatchObject({ reason: 'quota_reached' })
    expect(readIdentifyResponse(502, { status: 'failed', reason: 'order-not-found' })).toMatchObject({ reason: 'order-not-found' })
    expect(readIdentifyResponse(502, { status: 'failed', reason: 'identification_failed' })).toMatchObject({
      reason: 'identification_failed',
    })
  })

  it('carries the wording of a 400 as detail, so the row says WHY it was refused', () => {
    expect(readIdentifyResponse(400, { error: 'clipDurationSec out of range' })).toEqual({
      status: 'failed',
      reason: 'bad_request',
      detail: 'clipDurationSec out of range',
      retryable: false,
    })
  })

  // The policy Task 5 reads. Retrying only helps when the SAME request could succeed later.
  it.each([
    [401, { error: 'unauthorized' }, false], // wrong token: only a settings change helps
    [400, { error: 'meta is required' }, false], // same bytes, same answer
    [413, { error: 'audio_too_large' }, false], // same clip, same size
    [503, { error: 'live_identify_unavailable' }, true], // the worker has no Gemini key YET: a deploy fixes it
    [502, { status: 'failed', reason: 'identification_failed' }, true], // ffmpeg/Gemini hiccup
    [502, { status: 'failed', reason: 'order-not-found' }, true], // the order may simply not have synced yet
    [502, { status: 'failed', reason: 'quota_reached' }, false], // the monthly cap: retrying burns time, not money
    [502, { status: 'failed', reason: 'order-sale-mismatch' }, false], // wrong order for that moment: stays wrong
    [502, { status: 'failed', reason: 'some_future_code' }, true], // an unknown failure code: bounded retry
    [500, { error: 'boom' }, true],
    [504, '<html>gateway timeout</html>', true], // a proxy's page, not our JSON
    [408, {}, true],
    [425, {}, true],
    [429, {}, true],
    [404, {}, false], // wrong host or path: the same request cannot succeed
  ])('status %i %j -> retryable %s', (status, body, retryable) => {
    const o = readIdentifyResponse(status, body)
    expect(o.status).toBe('failed')
    expect(isRetryable(o)).toBe(retryable)
  })

  it('reads a bare 200 identified (no spend facts) as identified', () => {
    expect(readIdentifyResponse(200, { status: 'identified' })).toEqual({ status: 'identified' })
  })
  // The station exists to tell the host WHAT just sold. The server now returns the identity it
  // persisted, so an identified row must carry it instead of showing em dashes.
  it('keeps the identity the server reports, so the row can say what sold', () => {
    expect(readIdentifyResponse(200, {
      status: 'identified', attempts: 1, escalated: false,
      identity: { brand: 'Alo Yoga', item: 'Airlift Legging', color: 'black', size: 'M' },
    })).toEqual({
      status: 'identified', attempts: 1, escalated: false,
      identity: { brand: 'Alo Yoga', item: 'Airlift Legging', color: 'black', size: 'M' },
    })
  })

  it('tolerates a server that sends no identity, and a malformed one', () => {
    // An older worker, or a partial write: the row still settles as identified rather than failing.
    expect(readIdentifyResponse(200, { status: 'identified' })).toEqual({ status: 'identified' })
    expect(readIdentifyResponse(200, { status: 'identified', identity: 'nonsense' })).toEqual({ status: 'identified' })
    expect(readIdentifyResponse(200, { status: 'identified', identity: { brand: 7 } }))
      .toEqual({ status: 'identified', identity: { brand: null, item: null, color: null, size: null } })
  })

  it('does not leak a body it cannot read into a crash or a success', () => {
    for (const body of [null, undefined, 'x', 42, [], { status: 'weird' }, {}]) {
      const o = readIdentifyResponse(200, body)
      expect(o.status, JSON.stringify(body)).toBe('failed')
      expect(o).toMatchObject({ reason: 'bad_response', retryable: false })
    }
    expect(readIdentifyResponse(502, null)).toMatchObject({ status: 'failed', reason: 'identification_failed' })
  })
})

describe('isRetryable', () => {
  it('retries a failure the queue itself manufactured (a thrown run is a network problem)', () => {
    expect(isRetryable({ status: 'failed', reason: 'fetch failed' })).toBe(true)
  })

  it('never retries a settled, skipped or abandoned outcome', () => {
    expect(isRetryable({ status: 'identified' })).toBe(false)
    expect(isRetryable({ status: 'skipped', reason: 'in-flight' })).toBe(false)
    expect(isRetryable({ status: 'abandoned', reason: 'show ended' })).toBe(false)
  })
})

describe('fit with the identification queue', () => {
  it('lets the queue settle a waiting sale as abandoned, in the same outcome type', async () => {
    const settled: IdentifyOutcome[] = []
    const q = makeIdentifyQueue<{ orderId: string }, IdentifyAnswer>({
      run: () => new Promise(() => {}), // never settles: the first job holds the slot
      onSettled: (_job, outcome) => settled.push(outcome),
    })
    q.enqueue({ orderId: 'a' })
    q.enqueue({ orderId: 'b' })
    q.abandonAll('show ended')
    expect(settled).toEqual([{ status: 'abandoned', reason: 'show ended' }])
    expect(isRetryable(settled[0]!)).toBe(false)
  })
})
