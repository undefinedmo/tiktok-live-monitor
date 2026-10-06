import { describe, expect, it } from 'vitest'
import { PrintDedup } from '../printDedup'

// Real ids from the 2026-09-06/07 flight logs (A3.sample lines): the config id holds
// constant across lots #1..#K under one listing and changes when the seller moves on.
const LISTING_A = '1286104811014'
const LISTING_B = '1288914577158'
const T = 1_000_000 // fixed clock; the listing TTL is relative, so any stable base works
const NAME_A = 'Bin A - Alo Yoga'
const NAME_B = 'Bin B - Skims Bras'

describe('PrintDedup', () => {
  it('claims a lot once and refuses the repeat', () => {
    const d = new PrintDedup()
    d.setListing(LISTING_A, T)
    expect(d.claim('35', NAME_A, T)).toBe(true)
    expect(d.claim('35', NAME_A, T)).toBe(false)
  })

  it('suppresses the auction.end → result_update double-print (the v1.3.7 regression)', () => {
    // The same sale ~5s apart. These used to arrive carrying DIFFERENT per-auction ids
    // (auctionId vs skuId) as `auctionConfigId`; feeding those to the guard is what wiped
    // the scope between them. Close events no longer touch the scope at all.
    const d = new PrintDedup()
    d.setListing(LISTING_A, T)
    expect(d.claim('35', NAME_A, T)).toBe(true) // A4 ws-end #35   → print
    expect(d.claim('35', NAME_A, T + 5000)).toBe(false) // A4 ws-result #35 → suppressed
    expect(d.claim('35', NAME_A, T + 9000)).toBe(false) // order row later  → suppressed
  })

  it('separates the same lot number across two listings', () => {
    const d = new PrintDedup()
    d.setListing(LISTING_A, T)
    expect(d.claim('1', NAME_A, T)).toBe(true)
    expect(d.claim('2', NAME_A, T)).toBe(true)
    d.setListing(LISTING_B, T) // seller moves to the next auction product
    expect(d.claim('1', NAME_B, T)).toBe(true) // lot #1 of listing B is a different lot
    expect(d.claim('2', NAME_B, T)).toBe(true)
    expect(d.claim('1', NAME_B, T)).toBe(false) // ...and still dedupes within B
  })

  it('is unaffected by repeated pin samples for the same listing', () => {
    const d = new PrintDedup()
    d.setListing(LISTING_A, T)
    expect(d.claim('35', NAME_A, T)).toBe(true)
    for (let i = 0; i < 50; i++) d.setListing(LISTING_A, T + i * 700)
    expect(d.claim('35', NAME_A, T + 35000)).toBe(false)
  })

  it('ignores an absent listing id rather than changing scope', () => {
    // pin/get answers {"code":0} with no auction_config while a puzzle is pending (cfg=- in
    // the flight log). That is missing evidence, not a new listing.
    const d = new PrintDedup()
    d.setListing(LISTING_A, T)
    expect(d.claim('35', NAME_A, T)).toBe(true)
    d.setListing(undefined, T)
    d.setListing('', T)
    expect(d.listing).toBe(LISTING_A)
    expect(d.claim('35', NAME_A, T)).toBe(false)
  })

  it('dedupes a lot whose sources disagree on the winner (snipe)', () => {
    // #252: "Liz" via pin swap-close, "Amy891" via the order row. One lot, one label.
    const d = new PrintDedup()
    d.setListing(LISTING_A, T)
    expect(d.claim('252', NAME_A, T)).toBe(true)
    expect(d.claim('252', NAME_A, T)).toBe(false)
  })

  it('printedAlready does not claim', () => {
    const d = new PrintDedup()
    d.setListing(LISTING_A, T)
    expect(d.printedAlready('7', NAME_A, T)).toBe(false)
    expect(d.printedAlready('7', NAME_A, T)).toBe(false) // still unclaimed — no side effect
    expect(d.claim('7', NAME_A, T)).toBe(true)
    expect(d.printedAlready('7', NAME_A, T)).toBe(true)
  })

  // ── the blackout hole that v1.3.18 shipped ────────────────────────────────
  // pin/get is the listing-id source and goes dark for minutes whenever TikTok serves a
  // verification puzzle. The old backstop assumed a new listing's first OBSERVED lot is
  // #1 or #2 — but the blackout eats exactly those early closes.
  describe('pin blackout, app started inside the gate (no id ever seen)', () => {
    it('does not suppress a new listing whose first seen lot is #3', () => {
      const d = new PrintDedup() // pin never delivered an id
      for (let i = 1; i <= 68; i++) d.claim(String(i), NAME_A, T)
      // listing B starts; #1 and #2 close during the blackout and never reach us
      expect(d.claim('3', NAME_B, T)).toBe(true) // must print
      expect(d.claim('4', NAME_B, T)).toBe(true)
      expect(d.claim('3', NAME_B, T)).toBe(false) // still dedupes within B
    })

    it('keeps deduping within one listing with no id, via product name', () => {
      const d = new PrintDedup()
      expect(d.claim('12', NAME_A, T)).toBe(true)
      expect(d.claim('12', NAME_A, T)).toBe(false)
      expect(d.claim('12', '  bin a - ALO YOGA  ', T)).toBe(false) // normalized: same lot
    })

    it('does not roll over on newest-first order backfill', () => {
      // A real run queued #65, #64, #63 in that order off one auction_result page. Any
      // restart heuristic keyed on a descending lot number reprints the whole show here.
      const d = new PrintDedup()
      d.setListing(LISTING_A, T)
      for (let i = 60; i <= 68; i++) d.claim(String(i), NAME_A, T)
      for (const lot of ['65', '64', '63', '60']) expect(d.claim(lot, NAME_A, T)).toBe(false)
    })

    it('degrades to a bare lot number when neither id nor name is known', () => {
      const d = new PrintDedup()
      expect(d.claim('9', undefined, T)).toBe(true)
      expect(d.claim('9', undefined, T)).toBe(false)
    })
  })

  // ── the gate arriving MID-SHOW, which the first fix missed ────────────────
  // setListing ignores empty ids, so a latched id goes STALE rather than empty during a
  // blackout, and the scope kept preferring it over the product name. A listing change
  // inside that window put listing B's lots under listing A's scope and suppressed them —
  // the same class of bug as the one above, just entered from the other direction.
  describe('pin blackout arriving mid-show (id latched, then stale)', () => {
    it('suppresses correctly while the latched id is still fresh', () => {
      const d = new PrintDedup()
      d.setListing(LISTING_A, T)
      expect(d.claim('40', NAME_A, T)).toBe(true)
      // 20s later, still inside the TTL: same listing, same lot, no reprint.
      expect(d.claim('40', NAME_A, T + 20000)).toBe(false)
    })

    it('does not suppress a new listing once the latched id has gone stale', () => {
      const d = new PrintDedup()
      d.setListing(LISTING_A, T)
      for (let i = 1; i <= 40; i++) d.claim(String(i), NAME_A, T)
      // The gate goes up. pin stops confirming the id. Seller starts listing B, whose lots
      // restart at #1 — under the stale id these all collided and printed nothing.
      const later = T + 45000
      expect(d.claim('1', NAME_B, later)).toBe(true)
      expect(d.claim('2', NAME_B, later)).toBe(true)
      expect(d.claim('40', NAME_B, later)).toBe(true) // collided hardest before
    })

    it('still dedupes within the new listing while the gate is up', () => {
      const d = new PrintDedup()
      d.setListing(LISTING_A, T)
      const later = T + 45000
      expect(d.claim('1', NAME_B, later)).toBe(true)
      expect(d.claim('1', NAME_B, later + 5000)).toBe(false) // ws-end then ws-result
    })

    // Regression, observed live on v1.3.26 and caused by the TTL fix above.
    //   22:02:58  pin goes bare (gate up)
    //   22:03:58  #267 prints from an order row — id stale, so scoped by product name
    //   22:04:00  pin recovers, id becomes authoritative again
    //   22:04:00  A3 pin #267 close — new scope, new key, SECOND label
    // Two seconds apart. With gating around 25% a "recovery boundary" happens every couple
    // of minutes, so this was not the rare edge the earlier version of this test accepted.
    it('does not reprint a lot when pin recovers between its two reports', () => {
      const d = new PrintDedup()
      d.setListing(LISTING_A, T)
      const gateUp = T + 60000 // id now stale
      expect(d.claim('267', NAME_A, gateUp)).toBe(true) // order row, name-scoped
      d.setListing(LISTING_A, gateUp + 2000) // pin recovers, id fresh again
      expect(d.claim('267', NAME_A, gateUp + 2100)).toBe(false) // close event — must NOT reprint
    })

    it('does not reprint when the gate falls between a lot\'s two reports either', () => {
      const d = new PrintDedup()
      d.setListing(LISTING_A, T)
      expect(d.claim('300', NAME_A, T)).toBe(true) // id-scoped
      // gate arrives; 60s later the id is stale and the scope falls back to the name
      expect(d.claim('300', NAME_A, T + 60000)).toBe(false) // must NOT reprint
    })

    it('still separates listings across a recovery', () => {
      const d = new PrintDedup()
      d.setListing(LISTING_A, T)
      d.claim('1', NAME_A, T)
      const later = T + 45000
      d.setListing(LISTING_B, later) // new listing, new product
      expect(d.claim('1', NAME_B, later)).toBe(true) // different lot, must print
      expect(d.claim('1', NAME_B, later)).toBe(false)
    })
  })

  describe('lot-less order rows', () => {
    it('dedupes by order id, across listing changes', () => {
      const d = new PrintDedup()
      d.setListing(LISTING_A, T)
      expect(d.seenOrder('577000000000000001')).toBe(false)
      expect(d.seenOrder('577000000000000001')).toBe(true)
      d.setListing(LISTING_B, T)
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
