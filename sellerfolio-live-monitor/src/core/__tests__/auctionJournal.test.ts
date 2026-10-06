import { describe, it, expect } from 'vitest'
import { AuctionJournal } from '../auctionJournal'
import type { PinState, PinnedAuction } from '../types'

const END = 1_000_000
function pin(over: Partial<PinnedAuction> | null, ts = END - 5000): PinState {
  return {
    kind: 'pin',
    cardType: 4,
    current: over === null ? undefined : {
      productId: 'p1',
      productName: 'Bin A - Intimates',
      auctionConfigId: 'cfg1',
      auctionItemId: 'item1',
      variantDesc: '#41',
      skuId: 'sku41',
      startingBid: '$22.00',
      durationSec: 7,
      extendedDurationSec: 3,
      status: 1,
      numBids: 0,
      maxBiddingPrice: '$22.00',
      expectedEndMs: END,
      auctionBidTimestampMs: END - 7000,
      ...over,
    },
    serverTimeOffsetMs: 0,
    ts,
  }
}

describe('AuctionJournal', () => {
  it('records the start once, with starting price, duration and the exact start time', () => {
    const j = new AuctionJournal()
    const first = j.ingest(pin({}))
    expect(first).toEqual([
      {
        type: 'auction_start', lot: '#41', skuId: 'sku41', auctionItemId: 'item1', auctionConfigId: 'cfg1',
        productName: 'Bin A - Intimates', startingBid: '$22.00', durationSec: 7, extendedDurationSec: 3,
        startedAtMs: END - 7000, expectedEndMs: END,
      },
    ])
    expect(j.ingest(pin({ numBids: 1, winUsername: 'Ana' }))).toEqual([])
  })

  it('derives the start from end − duration when the first sample already has a bid', () => {
    const j = new AuctionJournal()
    const [s] = j.ingest(pin({ numBids: 2, winUsername: 'Ana', auctionBidTimestampMs: END - 1500 }))
    expect(s).toMatchObject({ type: 'auction_start', startedAtMs: END - 7000 })
  })

  it('records a sold close with winner, price and bid count', () => {
    const j = new AuctionJournal()
    j.ingest(pin({}))
    j.ingest(pin({ numBids: 2, winUsername: 'Ana', maxBiddingPrice: '$24.00' }))
    const out = j.ingest(pin({ status: 3, numBids: 3, winUsername: 'Bea', maxBiddingPrice: '$26.00' }, END + 1200))
    expect(out).toEqual([
      expect.objectContaining({
        type: 'auction_end', outcome: 'sold', lot: '#41', skuId: 'sku41', auctionItemId: 'item1',
        winner: 'Bea', price: '$26.00', bids: 3, startingBid: '$22.00', extended: false, seenAtMs: END + 1200,
      }),
    ])
  })

  it('records an UNSOLD close — the case the label path ignores', () => {
    const j = new AuctionJournal()
    j.ingest(pin({}))
    const out = j.ingest(pin({ status: 3, numBids: 0, winUsername: '' }, END + 1100))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'auction_end', outcome: 'unsold', bids: 0, startingBid: '$22.00' })
    expect((out[0] as { winner?: string }).winner).toBeUndefined()
    expect((out[0] as { price?: string }).price).toBeUndefined()
  })

  it('flags an extended auction', () => {
    const j = new AuctionJournal()
    j.ingest(pin({}))
    j.ingest(pin({ numBids: 1, winUsername: 'Ana', expectedEndMs: END + 3000 }))
    const [e] = j.ingest(pin({ status: 3, numBids: 1, winUsername: 'Ana', expectedEndMs: END + 3000 }, END + 4100))
    expect(e).toMatchObject({ outcome: 'sold', extended: true, expectedEndMs: END + 3000 })
  })

  it('closes a lot as UNKNOWN when the card moves on before the ended state is sampled', () => {
    const j = new AuctionJournal()
    j.ingest(pin({}))
    j.ingest(pin({ numBids: 1, winUsername: 'Ana', maxBiddingPrice: '$22.00' }))
    const out = j.ingest(pin({ auctionItemId: 'item2', variantDesc: '#42', skuId: 'sku42', expectedEndMs: END + 20000, auctionBidTimestampMs: END + 13000 }, END + 14000))
    expect(out.map((r) => r.type)).toEqual(['auction_end', 'auction_start'])
    expect(out[0]).toMatchObject({ outcome: 'unknown', lot: '#41', winner: 'Ana', bids: 1 })
    expect(out[1]).toMatchObject({ lot: '#42', auctionItemId: 'item2' })
  })

  it('closes as UNKNOWN when the card is unpinned mid-auction', () => {
    const j = new AuctionJournal()
    j.ingest(pin({}))
    expect(j.ingest(pin(null))).toEqual([expect.objectContaining({ type: 'auction_end', outcome: 'unknown', lot: '#41' })])
    expect(j.ingest(pin(null))).toEqual([])
  })

  it('treats an ended lot reissued under a new id as the same lot ending', () => {
    const j = new AuctionJournal()
    j.ingest(pin({}))
    const out = j.ingest(pin({ auctionItemId: 'rotated', auctionConfigId: 'cfg9', status: 3, numBids: 1, winUsername: 'Ana' }, END + 1300))
    expect(out).toEqual([expect.objectContaining({ type: 'auction_end', outcome: 'sold', auctionItemId: 'item1', winner: 'Ana' })])
  })

  it('ignores a lot first seen already ended, and an ended lot seen twice', () => {
    const j = new AuctionJournal()
    expect(j.ingest(pin({ status: 3, winUsername: 'Old' }))).toEqual([])
    j.ingest(pin({ auctionItemId: 'item5', variantDesc: '#45' }))
    expect(j.ingest(pin({ auctionItemId: 'item5', variantDesc: '#45', status: 3, winUsername: 'Ana', numBids: 1 }))).toHaveLength(1)
    expect(j.ingest(pin({ auctionItemId: 'item5', variantDesc: '#45', status: 3, winUsername: 'Ana', numBids: 1 }))).toEqual([])
  })

  it('records a re-run of the same lot number as a new auction', () => {
    const j = new AuctionJournal()
    j.ingest(pin({ auctionItemId: undefined }))
    j.ingest(pin({ auctionItemId: undefined, status: 3, winUsername: '' }))
    const again = j.ingest(pin({ auctionItemId: undefined, expectedEndMs: END + 60000, auctionBidTimestampMs: END + 53000 }, END + 54000))
    expect(again).toEqual([expect.objectContaining({ type: 'auction_start', lot: '#41', startedAtMs: END + 53000 })])
  })
})
