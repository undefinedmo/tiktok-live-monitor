import { describe, it, expect } from 'vitest'
import { AuctionWatch } from '../auctionWatch'
import type { PinState, PinnedAuction } from '../types'

// Build a pin/get snapshot the way parsePin would hand it over.
function pin(over: Partial<PinnedAuction>, ts = 1000): PinState {
  return {
    kind: 'pin',
    cardType: 4,
    current: {
      productId: 'p1',
      productName: '#17 Premium Denim',
      auctionConfigId: 'a1',
      variantDesc: '#17',
      winUsername: 'Elizabeth',
      maxBiddingPrice: '$27.00',
      status: 1,
      ...over,
    },
    ts,
  }
}

describe('AuctionWatch', () => {
  it('emits a close when status transitions 1 → 3', () => {
    const w = new AuctionWatch()
    expect(w.ingest(pin({ status: 1 }, 1000))).toEqual([])

    const closed = w.ingest(pin({ status: 3 }, 1500))

    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({
      kind: 'auction-closed',
      auctionConfigId: 'a1',
      lotNumber: '#17',
      winner: 'Elizabeth',
      price: '$27.00',
      ts: 1500,
    })
  })

  it('emits only once while the lot stays closed', () => {
    const w = new AuctionWatch()
    w.ingest(pin({ status: 1 }, 1000))
    expect(w.ingest(pin({ status: 3 }, 1500))).toHaveLength(1)
    expect(w.ingest(pin({ status: 3 }, 2000))).toEqual([])
    expect(w.ingest(pin({ status: 3 }, 2500))).toEqual([])
  })

  it('does NOT emit for a lot first seen already closed', () => {
    // App starting mid-show must not print a lot that ended before we were watching.
    const w = new AuctionWatch()
    expect(w.ingest(pin({ status: 3 }, 1000))).toEqual([])
  })

  it('tracks each lot separately', () => {
    const w = new AuctionWatch()
    w.ingest(pin({ auctionConfigId: 'a1', variantDesc: '#17', status: 1 }, 1000))
    w.ingest(pin({ auctionConfigId: 'a1', variantDesc: '#17', status: 3 }, 1500))

    w.ingest(pin({ auctionConfigId: 'a2', variantDesc: '#18', winUsername: 'Monique', status: 1 }, 2000))
    const closed = w.ingest(pin({ auctionConfigId: 'a2', variantDesc: '#18', winUsername: 'Monique', status: 3 }, 2500))

    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({ auctionConfigId: 'a2', lotNumber: '#18', winner: 'Monique' })
  })

  it('ignores snapshots with no current auction or no id', () => {
    const w = new AuctionWatch()
    expect(w.ingest({ kind: 'pin', ts: 1000 })).toEqual([])
    expect(w.ingest(pin({ auctionConfigId: undefined, status: 3 }, 1000))).toEqual([])
  })

  it('does not emit a close with no winner (lot ended unsold)', () => {
    const w = new AuctionWatch()
    w.ingest(pin({ status: 1, winUsername: undefined }, 1000))
    expect(w.ingest(pin({ status: 3, winUsername: undefined }, 1500))).toEqual([])
  })
})

// Back-to-back auctions: the seller starts the next lot within seconds of the gavel, so
// the pinned card swaps to the new lot BEFORE the 700ms poll ever samples the old lot's
// ended state — the 1→3 transition is never visible. A lot that vanishes while bidding
// with a leader and its countdown (nearly) run out closed naturally; one that vanishes
// mid-countdown was canceled/reset and must not print.
describe('AuctionWatch swap-close', () => {
  it('fires when the tracked lot is replaced after its countdown ran out', () => {
    const w = new AuctionWatch()
    w.ingest(pin({ status: 1, expectedEndMs: 5000 }, 4900)) // 100ms left at last sighting
    const closed = w.ingest(pin({ auctionConfigId: 'a2', variantDesc: '#18', winUsername: 'Monique', status: 1, expectedEndMs: 40000 }, 6000))
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({
      kind: 'auction-closed',
      auctionConfigId: 'a1',
      lotNumber: '#17',
      winner: 'Elizabeth',
      price: '$27.00',
      source: 'pin-swap',
    })
  })

  it('does NOT fire when the lot vanished mid-countdown (canceled/reset)', () => {
    const w = new AuctionWatch()
    w.ingest(pin({ status: 1, expectedEndMs: 25000 }, 5000)) // 20s left — a cancel, not a close
    expect(w.ingest(pin({ auctionConfigId: 'a2', variantDesc: '#18', status: 1 }, 6000))).toEqual([])
  })

  it('does NOT fire when the vanished lot had no leader', () => {
    const w = new AuctionWatch()
    w.ingest(pin({ status: 1, winUsername: undefined, expectedEndMs: 5000 }, 4900))
    expect(w.ingest(pin({ auctionConfigId: 'a2', variantDesc: '#18', status: 1 }, 6000))).toEqual([])
  })

  it('does NOT fire without an expectedEndMs to judge by', () => {
    const w = new AuctionWatch()
    w.ingest(pin({ status: 1, expectedEndMs: undefined }, 4900))
    expect(w.ingest(pin({ auctionConfigId: 'a2', variantDesc: '#18', status: 1 }, 6000))).toEqual([])
  })

  it('fires when the card unpins entirely near the end', () => {
    const w = new AuctionWatch()
    w.ingest(pin({ status: 1, expectedEndMs: 5000 }, 4800))
    const closed = w.ingest({ kind: 'pin', ts: 6000 })
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({ auctionConfigId: 'a1', winner: 'Elizabeth', source: 'pin-swap' })
  })

  it('never double-fires a lot whose 1→3 transition WAS observed', () => {
    const w = new AuctionWatch()
    w.ingest(pin({ status: 1, expectedEndMs: 5000 }, 4900))
    expect(w.ingest(pin({ status: 3, expectedEndMs: 5000 }, 5400))).toHaveLength(1) // normal close
    expect(w.ingest(pin({ auctionConfigId: 'a2', variantDesc: '#18', status: 1 }, 6000))).toEqual([]) // swap after
  })

  it('judges remaining time on the SERVER clock (serverTimeOffsetMs)', () => {
    const w = new AuctionWatch()
    const skewed = pin({ status: 1, expectedEndMs: 5000 }, 1000) // client clock 3.9s behind
    skewed.serverTimeOffsetMs = 3900 // serverNow = 4900 → 100ms left
    w.ingest(skewed)
    expect(w.ingest(pin({ auctionConfigId: 'a2', variantDesc: '#18', status: 1 }, 2000))).toHaveLength(1)
  })
})
