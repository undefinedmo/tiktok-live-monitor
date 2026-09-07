import { describe, expect, it } from 'vitest'
import { PrintDedup } from '../printDedup'

// Real ids from the 2026-09-06/07 flight logs (A3.sample lines): the config id holds
// constant across lots #1..#K under one listing and changes when the seller moves on.
const LISTING_A = '1286104811014'
const LISTING_B = '1288914577158'

describe('PrintDedup', () => {
  it('claims a lot once and refuses the repeat', () => {
    const d = new PrintDedup()
    d.setListing(LISTING_A)
    expect(d.claim('35')).toBe(true)
    expect(d.claim('35')).toBe(false)
  })

  it('suppresses the auction.end → result_update double-print (the v1.3.7 regression)', () => {
    // The same sale ~5s apart. These used to arrive carrying DIFFERENT per-auction ids
    // (auctionId vs skuId) as `auctionConfigId`; feeding those to the guard is what wiped
    // the scope between them. Close events no longer touch the scope at all.
    const d = new PrintDedup()
    d.setListing(LISTING_A) // pin/get, per-listing
    expect(d.claim('35')).toBe(true) // A4 ws-end #35   → print
    expect(d.claim('35')).toBe(false) // A4 ws-result #35 → suppressed
    expect(d.claim('35')).toBe(false) // order row later  → suppressed
  })

  it('separates the same lot number across two listings', () => {
    const d = new PrintDedup()
    d.setListing(LISTING_A)
    expect(d.claim('1')).toBe(true)
    expect(d.claim('2')).toBe(true)
    d.setListing(LISTING_B) // seller moves to the next auction product
    expect(d.claim('1')).toBe(true) // lot #1 of listing B is a different lot
    expect(d.claim('2')).toBe(true)
    expect(d.claim('1')).toBe(false) // ...and still dedupes within B
  })

  it('is unaffected by repeated pin samples for the same listing', () => {
    const d = new PrintDedup()
    d.setListing(LISTING_A)
    expect(d.claim('35')).toBe(true)
    for (let i = 0; i < 50; i++) d.setListing(LISTING_A)
    expect(d.claim('35')).toBe(false)
  })

  it('ignores an absent listing id rather than changing scope', () => {
    // pin/get answers {"code":0} with no auction_config while a verification puzzle is
    // pending (cfg=- in the flight log). That is missing evidence, not a new listing.
    const d = new PrintDedup()
    d.setListing(LISTING_A)
    expect(d.claim('35')).toBe(true)
    d.setListing(undefined)
    d.setListing('')
    expect(d.listing).toBe(LISTING_A)
    expect(d.claim('35')).toBe(false)
  })

  it('dedupes a lot whose sources disagree on the winner (snipe)', () => {
    // #252: "Liz" via pin swap-close, "Amy891" via the order row. One lot, one label.
    const d = new PrintDedup()
    d.setListing(LISTING_A)
    expect(d.claim('252')).toBe(true)
    expect(d.claim('252')).toBe(false)
  })

  it('printedAlready does not claim', () => {
    const d = new PrintDedup()
    d.setListing(LISTING_A)
    expect(d.printedAlready('7')).toBe(false)
    expect(d.printedAlready('7')).toBe(false) // still unclaimed — no side effect
    expect(d.claim('7')).toBe(true)
    expect(d.printedAlready('7')).toBe(true)
  })

  // ── the blackout hole that v1.3.18 shipped ────────────────────────────────
  // pin/get is the listing-id source and goes dark for minutes whenever TikTok serves a
  // verification puzzle. The old backstop assumed a new listing's first OBSERVED lot is
  // #1 or #2 — but the blackout eats exactly those early closes.
  describe('pin blackout (no listing id at all)', () => {
    it('does not suppress a new listing whose first seen lot is #3', () => {
      const d = new PrintDedup() // pin never delivered an id
      for (let i = 1; i <= 68; i++) d.claim(String(i), 'Bin A - Alo Yoga')
      // listing B starts; #1 and #2 close during the blackout and never reach us
      expect(d.claim('3', 'Bin B - Skims Bras')).toBe(true) // must print
      expect(d.claim('4', 'Bin B - Skims Bras')).toBe(true)
      expect(d.claim('3', 'Bin B - Skims Bras')).toBe(false) // still dedupes within B
    })

    it('keeps deduping within one listing with no id, via product name', () => {
      const d = new PrintDedup()
      expect(d.claim('12', 'Bin A - Alo Yoga')).toBe(true)
      expect(d.claim('12', 'Bin A - Alo Yoga')).toBe(false)
      expect(d.claim('12', '  bin a - ALO YOGA  ')).toBe(false) // normalized: same lot
    })

    it('does not roll over on newest-first order backfill', () => {
      // A real run queued #65, #64, #63 in that order off one auction_result page. Any
      // restart heuristic keyed on a descending lot number reprints the whole show here.
      const d = new PrintDedup()
      d.setListing(LISTING_A)
      for (let i = 60; i <= 68; i++) d.claim(String(i))
      for (const lot of ['65', '64', '63', '60']) expect(d.claim(lot)).toBe(false)
    })

    it('degrades to a bare lot number when neither id nor name is known', () => {
      const d = new PrintDedup()
      expect(d.claim('9')).toBe(true)
      expect(d.claim('9')).toBe(false)
    })

    it('a listing id, once it arrives, takes over from the product name', () => {
      const d = new PrintDedup()
      d.claim('3', 'Bin B - Skims Bras') // blackout: scoped by name
      d.setListing(LISTING_B) // pin recovers
      // Same lot, now scoped by id — a re-report right after recovery prints once more.
      // Accepted: one extra label at a recovery boundary beats suppressing a listing.
      expect(d.claim('3', 'Bin B - Skims Bras')).toBe(true)
      expect(d.claim('3', 'Bin B - Skims Bras')).toBe(false)
    })
  })

  describe('lot-less order rows', () => {
    it('dedupes by order id, across listing changes', () => {
      const d = new PrintDedup()
      d.setListing(LISTING_A)
      expect(d.seenOrder('577000000000000001')).toBe(false)
      expect(d.seenOrder('577000000000000001')).toBe(true)
      d.setListing(LISTING_B)
      expect(d.seenOrder('577000000000000001')).toBe(true) // order ids are global
      expect(d.seenOrder('577000000000000002')).toBe(false)
    })

    it('bounds the order-id set on a long show', () => {
      const d = new PrintDedup()
      for (let i = 0; i < 5200; i++) d.seenOrder(`order-${i}`)
      expect(d.seenOrder('order-5199')).toBe(true) // recent orders still guarded
    })
  })
})
