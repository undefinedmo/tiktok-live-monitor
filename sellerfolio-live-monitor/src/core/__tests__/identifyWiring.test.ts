import { describe, expect, it, vi } from 'vitest'
import type { ExtractedClip } from '../clipRecorder'
import {
  CLIP_LEAD_PAD_SEC,
  MAX_LOOKBACK_SEC,
  RECENT_SALE_MAX_AGE_SEC,
  clipReadyEpochSec,
  identifyPayloadFor,
  isRecentSale,
  jobForSale,
  CLIP_TAIL_SEC,
  NO_BOUNDARY_LOOKBACK_SEC,
  boundariesForSale,
  clipRequestFor,
  createSeenOrders,
  viewOutcome,
} from '../identifyWiring'

describe('boundariesForSale', () => {
  it('prefers the auction_start event, and falls back to the previous sale', () => {
    const journal = [
      { type: 'auction_start', atEpochSec: 1050, orderId: null },
      { type: 'sale', atEpochSec: 1040, orderId: 'prev' },
    ] as const
    const b = boundariesForSale({ orderId: 'cur', atEpochSec: 1100 }, [...journal])
    expect(b.saleEpochSec).toBe(1100)
    expect(b.auctionStartEpochSec).toBe(1050)
    expect(b.prevBoundaryEpochSec).toBe(1040) // the previous sale is the wall
  })

  // CHANGED FROM THE BRIEF. The brief's first test used a start at 1000 with a previous sale at 1040
  // and asserted the start was returned. A start BEFORE the previous sale belongs to an earlier lot
  // (this lot's own start was never seen): sending it hands the server the previous lot's window.
  // That is the most common identification failure measured (THE ALO VAULT 10-04: 71% of errors were
  // the previous lot), so it is dropped here rather than left to the server's clamp.
  it('drops an auction_start that is older than the previous sale: it is an earlier lot\'s', () => {
    const b = boundariesForSale({ orderId: 'cur', atEpochSec: 1100 }, [
      { type: 'auction_start', atEpochSec: 1000, orderId: null },
      { type: 'sale', atEpochSec: 1040, orderId: 'prev' },
    ])
    expect(b.auctionStartEpochSec).toBeNull()
    expect(b.prevBoundaryEpochSec).toBe(1040) // the previous-sale fallback still does its job
  })

  // The wall the start is compared with is the REAL one. When the previous auction's end is known the
  // start is this lot's own even though the previous order row landed a few seconds after it.
  it('keeps a start that precedes the previous sale when a known auction_end walls it off', () => {
    const b = boundariesForSale({ orderId: 'cur', atEpochSec: 1100 }, [
      { type: 'auction_end', atEpochSec: 1034 },
      { type: 'auction_start', atEpochSec: 1038 },
      { type: 'sale', atEpochSec: 1040, orderId: 'prev' },
    ])
    expect(b.auctionStartEpochSec).toBe(1038)
    expect(b.prevBoundaryEpochSec).toBe(1034)
  })

  // A stale start only a fraction of a second older than the wall is still an earlier lot's: the
  // comparison is exact, not rounded to the second (epochs are fractional once clock-corrected).
  it.each([0.5, 0.001, 1])('drops an auction_start %s s older than the wall', (gap) => {
    const b = boundariesForSale({ orderId: 'cur', atEpochSec: 1100 }, [
      { type: 'auction_start', atEpochSec: 1040 - gap },
      { type: 'sale', atEpochSec: 1040, orderId: 'prev' },
    ])
    expect(b.auctionStartEpochSec).toBeNull()
  })

  it('keeps an auction_start that is exactly at the previous sale', () => {
    const b = boundariesForSale({ orderId: 'cur', atEpochSec: 1100 }, [
      { type: 'auction_start', atEpochSec: 1040 },
      { type: 'sale', atEpochSec: 1040, orderId: 'prev' },
    ])
    expect(b.auctionStartEpochSec).toBe(1040)
  })

  it('keeps an auction_start when there is no wall to compare it with', () => {
    expect(boundariesForSale({ orderId: 'cur', atEpochSec: 1100 }, [{ type: 'auction_start', atEpochSec: 1000 }]).auctionStartEpochSec).toBe(1000)
  })

  // Measured: auction_end fires for a minority of lots (25 ends against 919 sales on show
  // 7692593218231929613), so the fallback is the common path, not the exception.
  it('works with no auction events at all', () => {
    const b = boundariesForSale({ orderId: 'cur', atEpochSec: 1100 }, [{ type: 'sale', atEpochSec: 1040, orderId: 'prev' }])
    expect(b.auctionStartEpochSec).toBeNull()
    expect(b.prevBoundaryEpochSec).toBe(1040)
  })

  it('has no boundaries at all for an empty journal', () => {
    expect(boundariesForSale({ orderId: 'cur', atEpochSec: 1100 }, [])).toEqual({
      saleEpochSec: 1100, auctionStartEpochSec: null, prevBoundaryEpochSec: null,
    })
  })

  // The previous auction's end is the real wall: an order row lands seconds AFTER the close, so the
  // previous sale sits later than the previous lot's last word and would clip this lot's opening.
  it('prefers the previous auction_end (at or before this lot started) over the previous sale', () => {
    const b = boundariesForSale({ orderId: 'cur', atEpochSec: 1100 }, [
      { type: 'auction_end', atEpochSec: 1034 },
      { type: 'sale', atEpochSec: 1040, orderId: 'prev' },
      { type: 'auction_start', atEpochSec: 1045 },
    ])
    expect(b.auctionStartEpochSec).toBe(1045)
    expect(b.prevBoundaryEpochSec).toBe(1034)
  })

  // This lot's OWN auction_end lands just before its sale. Using it as the wall would put the wall
  // after the lot's whole auction, leaving a clip of nothing but the tail.
  it('never takes its own auction_end as the wall', () => {
    const b = boundariesForSale({ orderId: 'cur', atEpochSec: 1100 }, [
      { type: 'sale', atEpochSec: 1040, orderId: 'prev' },
      { type: 'auction_start', atEpochSec: 1045 },
      { type: 'auction_end', atEpochSec: 1097 },
    ])
    expect(b.prevBoundaryEpochSec).toBe(1040)
  })

  it('without an auction_start, an auction_end is ambiguous and is not used', () => {
    const b = boundariesForSale({ orderId: 'cur', atEpochSec: 1100 }, [
      { type: 'sale', atEpochSec: 1040, orderId: 'prev' },
      { type: 'auction_end', atEpochSec: 1097 },
    ])
    expect(b.auctionStartEpochSec).toBeNull()
    expect(b.prevBoundaryEpochSec).toBe(1040)
  })

  it('picks the latest earlier event whatever order the journal is in, and ignores later ones', () => {
    const b = boundariesForSale({ orderId: 'cur', atEpochSec: 1100 }, [
      { type: 'sale', atEpochSec: 1090, orderId: 'later' },
      { type: 'sale', atEpochSec: 1200, orderId: 'future' },
      { type: 'sale', atEpochSec: 900, orderId: 'old' },
      { type: 'auction_start', atEpochSec: 1300 },
      { type: 'auction_start', atEpochSec: 1095 },
      { type: 'auction_start', atEpochSec: 980 },
    ])
    expect(b.auctionStartEpochSec).toBe(1095)
    expect(b.prevBoundaryEpochSec).toBe(1090)
  })

  // Boundaries are inclusive where an event can share a second with its neighbour.
  it('takes an auction_start in the same second as the sale', () => {
    expect(boundariesForSale({ orderId: 'cur', atEpochSec: 1100 }, [{ type: 'auction_start', atEpochSec: 1100 }]).auctionStartEpochSec).toBe(1100)
  })

  it('takes an auction_end in the same second the lot started', () => {
    const b = boundariesForSale({ orderId: 'cur', atEpochSec: 1100 }, [
      { type: 'auction_end', atEpochSec: 1045 },
      { type: 'auction_start', atEpochSec: 1045 },
      { type: 'sale', atEpochSec: 1040, orderId: 'prev' },
    ])
    expect(b.prevBoundaryEpochSec).toBe(1045)
  })

  it('does not treat the sale itself as its own previous sale', () => {
    const b = boundariesForSale({ orderId: 'cur', atEpochSec: 1100 }, [{ type: 'sale', atEpochSec: 1099, orderId: 'cur' }])
    expect(b.prevBoundaryEpochSec).toBeNull()
  })

  // Two sales within one second: a wall AT the sale leaves a zero-width window. Say nothing instead,
  // and let the server use its own lookback.
  it('gives no wall when the previous sale is not before this one', () => {
    const b = boundariesForSale({ orderId: 'cur', atEpochSec: 1100 }, [{ type: 'sale', atEpochSec: 1100, orderId: 'prev' }])
    expect(b.prevBoundaryEpochSec).toBeNull()
  })
})

describe('clipRequestFor', () => {
  const b = (auctionStartEpochSec: number | null, prevBoundaryEpochSec: number | null) => ({ saleEpochSec: 1100, auctionStartEpochSec, prevBoundaryEpochSec })

  it('uses the named constants', () => {
    expect([CLIP_LEAD_PAD_SEC, CLIP_TAIL_SEC, NO_BOUNDARY_LOOKBACK_SEC]).toEqual([2, 5, 60])
  })

  it('reaches back to the wall and runs past the sale by the tail', () => {
    expect(clipRequestFor(b(null, 1040))).toEqual({ startEpochSec: 1040 - CLIP_LEAD_PAD_SEC, endEpochSec: 1100 + CLIP_TAIL_SEC })
  })

  // An order row lands seconds after the close, so the previous sale can be LATER than this lot's own
  // start. Supplying audio from the wall would cut the lot's opening; the server clamps to the wall itself.
  it('never starts later than the lot started', () => {
    expect(clipRequestFor(b(1000, 1040)).startEpochSec).toBe(1000 - CLIP_LEAD_PAD_SEC)
  })

  it('never starts later than the wall either', () => {
    expect(clipRequestFor(b(1070, 1040)).startEpochSec).toBe(1040 - CLIP_LEAD_PAD_SEC)
  })

  it('falls back to a bounded lookback when nothing is known', () => {
    expect(clipRequestFor(b(null, null))).toEqual({ startEpochSec: 1100 - NO_BOUNDARY_LOOKBACK_SEC, endEpochSec: 1100 + CLIP_TAIL_SEC })
  })

  // A long gap would otherwise ask for the whole 5-minute buffer: worse input (a 60 s window is already
  // 80% foreign talk on measured shows) and a bigger upload.
  it('never reaches back further than MAX_LOOKBACK_SEC before the sale', () => {
    expect(MAX_LOOKBACK_SEC).toBe(120)
    expect(clipRequestFor(b(null, 800)).startEpochSec).toBe(1100 - MAX_LOOKBACK_SEC)
    expect(clipRequestFor(b(700, 800)).startEpochSec).toBe(1100 - MAX_LOOKBACK_SEC)
  })

  it('leaves a request alone that is within the cap, right up to the cap', () => {
    expect(clipRequestFor(b(null, 1100 - MAX_LOOKBACK_SEC + CLIP_LEAD_PAD_SEC)).startEpochSec).toBe(1100 - MAX_LOOKBACK_SEC)
    expect(clipRequestFor(b(null, 1100 - MAX_LOOKBACK_SEC + CLIP_LEAD_PAD_SEC + 1)).startEpochSec).toBe(1100 - MAX_LOOKBACK_SEC + 1)
  })

  it('uses the start alone when there is no wall', () => {
    expect(clipRequestFor(b(1070, null)).startEpochSec).toBe(1070 - CLIP_LEAD_PAD_SEC)
  })
})

describe('viewOutcome', () => {
  it('shows an identification as done', () => {
    expect(viewOutcome({ status: 'identified', attempts: 2 })).toMatchObject({ status: 'done' })
  })

  // The queue's own third status. A show that ends with sales waiting must not read as a success.
  it('never reads an abandoned sale as a success', () => {
    const v = viewOutcome({ status: 'abandoned', reason: 'show ended' })
    expect(v.status).toBe('abandoned')
    expect(v.text).toMatch(/show ended/i)
  })

  it('reads a skipped answer as not identified, with the server reason', () => {
    const v = viewOutcome({ status: 'skipped', reason: 'no_speech' })
    expect(v.status).toBe('skipped')
    expect(v.text).toContain('no_speech')
  })

  it.each([
    ['timeout', /did not answer/i],
    ['network_error', /reach/i],
    ['bad_token', /token/i],
    ['audio_too_large', /too large/i],
    ['live_identify_unavailable', /unavailable/i],
    ['quota_reached', /limit/i],
    ['no_audio', /no audio/i],
    ['order-not-found', /order yet/i],
    ['order-sale-mismatch', /belongs/i],
    ['bad_request_local', /not valid/i],
    ['worker_unreachable', /Retry/],
    ['already_queued', /already being identified/i],
    ['identification_off', /turned off/i],
  ])('explains failure %s in words, not with the raw code', (reason, re) => {
    const v = viewOutcome({ status: 'failed', reason })
    expect(v.status).toBe('error')
    expect(v.text).toMatch(re)
    expect(v.text).not.toContain('Identification failed (') // the generic fallback
  })

  it('still says something for a failure code it does not know yet', () => {
    const v = viewOutcome({ status: 'failed', reason: 'new_thing' })
    expect(v).toEqual({ status: 'error', text: expect.stringContaining('new_thing') })
  })

  it('has words for a failure with no reason, a skip with none, and an abandon with none', () => {
    expect(viewOutcome({ status: 'failed' }).text).toContain('unknown')
    expect(viewOutcome({ status: 'skipped' }).text).toContain('skipped')
    expect(viewOutcome({ status: 'abandoned' }).text).toMatch(/the show ended/)
  })

  it('says how many tries a failure took when it took more than one', () => {
    expect(viewOutcome({ status: 'failed', reason: 'timeout', tries: 2 }).text).toMatch(/2 tries/)
    expect(viewOutcome({ status: 'failed', reason: 'timeout', tries: 3 }).text).toMatch(/3 tries/)
    expect(viewOutcome({ status: 'failed', reason: 'timeout', tries: 1 }).text).not.toMatch(/tries/)
  })

  // A status this code has never heard of is not a success.
  it('treats an unrecognised status as an error, never as done', () => {
    expect(viewOutcome({ status: 'something-new' }).status).toBe('error')
  })
})

// The hand-off from a sale to the payload the server is sent. Defended here, in core, because a
// comment in the renderer does not stop a one-line change there from shipping the previous lot's window
// as the clip's own start with every other test green.
describe('jobForSale', () => {
  const b = { saleEpochSec: 1100, auctionStartEpochSec: 1045, prevBoundaryEpochSec: 1040 }

  it('carries the sale, the room and every boundary, and nothing about the clip', () => {
    expect(jobForSale({ orderId: 'cur', roomId: 'r1' }, b)).toEqual({
      orderId: 'cur', roomId: 'r1', saleEpochSec: 1100, auctionStartEpochSec: 1045, prevBoundaryEpochSec: 1040,
    })
  })

  it('keeps a missing boundary as null, never as a made-up number', () => {
    const job = jobForSale({ orderId: 'cur', roomId: null }, { saleEpochSec: 1100, auctionStartEpochSec: null, prevBoundaryEpochSec: null })
    expect(job).toEqual({ orderId: 'cur', roomId: null, saleEpochSec: 1100, auctionStartEpochSec: null, prevBoundaryEpochSec: null })
  })
})

describe('identifyPayloadFor', () => {
  // What extract() returns for a request landing mid-chunk: it starts EARLIER than asked.
  const clip: ExtractedClip = { blob: new Blob(['x']), startEpochSec: 1035.5, durationSec: 74.5, leadInSec: 2.5, truncated: false }
  const store = (c: ExtractedClip | null) => ({ extract: vi.fn((_want: { startEpochSec: number; endEpochSec: number }) => c) })
  const sale = { orderId: 'cur', roomId: 'r1', atEpochSec: 1100 }

  it('is the extracted clip itself, not a copy with anything changed', () => {
    const st = store(clip)
    const p = identifyPayloadFor(sale, [{ type: 'sale', atEpochSec: 1040, orderId: 'prev' }, { type: 'auction_start', atEpochSec: 1045 }], st)
    expect(p?.clip).toBe(clip)
    expect(p?.clip.startEpochSec).toBe(1035.5)
    expect(p?.clip.durationSec).toBe(74.5)
  })

  it('asks the store for exactly the window clipRequestFor plans, and builds the job from the same boundaries', () => {
    const st = store(clip)
    const p = identifyPayloadFor(sale, [{ type: 'sale', atEpochSec: 1040, orderId: 'prev' }, { type: 'auction_start', atEpochSec: 1045 }], st)
    expect(st.extract).toHaveBeenCalledTimes(1)
    expect(st.extract).toHaveBeenCalledWith({ startEpochSec: 1040 - CLIP_LEAD_PAD_SEC, endEpochSec: 1100 + CLIP_TAIL_SEC })
    expect(p?.job).toEqual({ orderId: 'cur', roomId: 'r1', saleEpochSec: 1100, auctionStartEpochSec: 1045, prevBoundaryEpochSec: 1040 })
  })

  // The 71% failure: a start from the previous lot. It must neither reach the job nor widen the request.
  it('does not send an earlier lot\'s auction_start, and the window follows the wall', () => {
    const st = store(clip)
    const p = identifyPayloadFor(sale, [{ type: 'auction_start', atEpochSec: 990 }, { type: 'sale', atEpochSec: 1040, orderId: 'prev' }], st)
    expect(p?.job.auctionStartEpochSec).toBeNull()
    expect(p?.job.prevBoundaryEpochSec).toBe(1040)
    expect(st.extract).toHaveBeenCalledWith({ startEpochSec: 1040 - CLIP_LEAD_PAD_SEC, endEpochSec: 1105 })
  })

  it('always sends the wall when there is one, so the server can clamp', () => {
    const p = identifyPayloadFor(sale, [{ type: 'sale', atEpochSec: 1060, orderId: 'prev' }], store(clip))
    expect(p?.job.prevBoundaryEpochSec).toBe(1060)
  })

  it('caps the request after a long gap', () => {
    const st = store(clip)
    identifyPayloadFor(sale, [{ type: 'sale', atEpochSec: 600, orderId: 'prev' }], st)
    expect(st.extract).toHaveBeenCalledWith({ startEpochSec: 1100 - MAX_LOOKBACK_SEC, endEpochSec: 1105 })
  })

  it('is null when there is no audio to send', () => {
    expect(identifyPayloadFor(sale, [], store(null))).toBeNull()
  })

  it('uses the journal as it is when asked, so a start seen late is used', () => {
    const journal: Array<{ type: 'auction_start' | 'auction_end' | 'sale'; atEpochSec: number; orderId?: string }> = []
    const st = store(clip)
    expect(identifyPayloadFor(sale, journal, st)?.job.auctionStartEpochSec).toBeNull()
    journal.push({ type: 'auction_start', atEpochSec: 1080 })
    expect(identifyPayloadFor(sale, journal, st)?.job.auctionStartEpochSec).toBe(1080)
  })
})

describe('clipReadyEpochSec', () => {
  it('is when the tail audio exists: the sale plus the tail', () => {
    expect(clipReadyEpochSec(1100)).toBe(1100 + CLIP_TAIL_SEC)
  })
})

// A sale is recent by THIS machine's clock after correcting the server timestamp, not by comparing a
// local millisecond with a server one: a station clock more than a minute off would otherwise fail
// every sale at this gate, silently, with no row and no log.
describe('isRecentSale', () => {
  const NOW = 1_700_000_100_000
  it('has a 60 second limit', () => expect(RECENT_SALE_MAX_AGE_SEC).toBe(60))

  it('accepts a just-created sale when the station clock is well AHEAD of the server', () => {
    // server is 90 s behind this machine: serverNow = clientNow - 90 s
    const offset = -90_000
    const createdAt = NOW + offset - 2000 // created 2 s ago, in server time
    expect(isRecentSale(createdAt, NOW, offset)).toBe(true)
    expect(NOW - createdAt).toBeGreaterThan(60_000) // the uncorrected comparison would have refused it
  })

  it('accepts a just-created sale when the station clock is well BEHIND the server', () => {
    const offset = 90_000
    expect(isRecentSale(NOW + offset - 2000, NOW, offset)).toBe(true)
  })

  it('refuses a sale that is genuinely old, by the corrected clock', () => {
    expect(isRecentSale(NOW - 61_000, NOW, 0)).toBe(false)
    expect(isRecentSale(NOW - 90_000 - 61_000, NOW, -90_000)).toBe(false)
  })

  it('is strict at the limit', () => {
    expect(isRecentSale(NOW - 59_999, NOW, 0)).toBe(true)
    expect(isRecentSale(NOW - 60_000, NOW, 0)).toBe(false)
  })

  it('accepts a sale stamped slightly in the future', () => {
    expect(isRecentSale(NOW + 3000, NOW, 0)).toBe(true)
  })

  it('treats an unknown offset as none', () => {
    expect(isRecentSale(NOW - 2000, NOW, undefined)).toBe(true)
    expect(isRecentSale(NOW - 61_000, NOW, undefined)).toBe(false)
  })
})

describe('createSeenOrders: a sale is identified once', () => {
  it('remembers a sent order, and reports a new one as new', () => {
    const s = createSeenOrders()
    expect(s.has('a')).toBe(false)
    s.markSent('a')
    expect(s.has('a')).toBe(true)
    expect(s.has('b')).toBe(false)
  })
  it('a show change forgets what was SENT this show, but never what was RESTORED from disk', () => {
    const s = createSeenOrders()
    s.markRestored('old')
    s.markSent('new')
    s.endShow()
    expect(s.has('new')).toBe(false)
    expect(s.has('old')).toBe(true) // a restored order re-seen later is not uploaded again
  })
  it('hitting the size cap forgets sent orders, never restored ones', () => {
    const s = createSeenOrders(3)
    s.markRestored('old')
    for (const id of ['a', 'b', 'c', 'd']) s.markSent(id)
    expect(s.has('old')).toBe(true)
    expect(s.has('a')).toBe(false) // the sent set was cleared when it passed the cap
    expect(s.has('d')).toBe(true) // the order that tipped it over is still remembered
  })
  it('an order that is both restored and sent survives a show change', () => {
    const s = createSeenOrders()
    s.markSent('x')
    s.markRestored('x')
    s.endShow()
    expect(s.has('x')).toBe(true)
  })
})
