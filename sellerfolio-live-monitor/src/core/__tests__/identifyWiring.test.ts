import { describe, expect, it } from 'vitest'
import {
  CLIP_LEAD_PAD_SEC,
  CLIP_TAIL_SEC,
  NO_BOUNDARY_LOOKBACK_SEC,
  boundariesForSale,
  clipRequestFor,
  viewOutcome,
} from '../identifyWiring'

describe('boundariesForSale', () => {
  it('prefers the auction_start event, and falls back to the previous sale', () => {
    const journal = [
      { type: 'auction_start', atEpochSec: 1000, orderId: null },
      { type: 'sale', atEpochSec: 1040, orderId: 'prev' },
    ] as const
    const b = boundariesForSale({ orderId: 'cur', atEpochSec: 1100 }, [...journal])
    expect(b.saleEpochSec).toBe(1100)
    expect(b.auctionStartEpochSec).toBe(1000)
    expect(b.prevBoundaryEpochSec).toBe(1040) // the previous sale is the wall
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
      { type: 'auction_start', atEpochSec: 1010 },
      { type: 'auction_start', atEpochSec: 980 },
    ])
    expect(b.auctionStartEpochSec).toBe(1010)
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
