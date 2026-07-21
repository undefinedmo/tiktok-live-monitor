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
