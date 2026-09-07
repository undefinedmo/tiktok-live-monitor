import { describe, expect, it } from 'vitest'
import { PrintDedup } from '../printDedup'

// Real ids from the 2026-09-06 flight log (A3.sample lines): one show, two listings,
// the config id held constant across lots #1..#5 under each.
const LISTING_A = '1286104811014'
const LISTING_B = '1288914577158'

describe('PrintDedup', () => {
  it('prints a lot once and suppresses the repeat', () => {
    const d = new PrintDedup()
    d.setListing(LISTING_A)
    expect(d.has('35')).toBe(false)
    d.add('35')
    expect(d.has('35')).toBe(true)
  })

  it('suppresses the auction.end → result_update double-print (the v1.3.7 regression)', () => {
    // Both events are the same sale ~5s apart. They used to carry DIFFERENT per-auction
    // ids (auctionId vs skuId) as `auctionConfigId`; feeding those to the guard is what
    // wiped the set between them. The listing scope must come from pin only.
    const d = new PrintDedup()
    d.setListing(LISTING_A) // pin/get, per-listing

    expect(d.has('35')).toBe(false) // A4 ws-end #35   → print
    d.add('35')
    expect(d.has('35')).toBe(true) // A4 ws-result #35 → suppressed
    expect(d.has('35')).toBe(true) // order row later  → suppressed
  })

  it('is not reset by repeated pin samples within one listing', () => {
    const d = new PrintDedup()
    d.setListing(LISTING_A)
    d.add('35')
    for (let i = 0; i < 50; i++) expect(d.setListing(LISTING_A)).toBe(false)
    expect(d.has('35')).toBe(true)
  })

  it('ignores an absent listing id rather than resetting', () => {
    // pin/get can arrive before the auction card is populated (cfg=- in the flight log).
    const d = new PrintDedup()
    d.setListing(LISTING_A)
    d.add('35')
    expect(d.setListing(undefined)).toBe(false)
    expect(d.setListing('')).toBe(false)
    expect(d.has('35')).toBe(true)
  })

  it('clears when the seller switches listings, so restarted lot numbers still print', () => {
    const d = new PrintDedup()
    d.setListing(LISTING_A)
    d.add('1')
    d.add('2')
    d.add('3')
    expect(d.has('3')).toBe(true)

    expect(d.setListing(LISTING_B)).toBe(true) // seller moves to the next auction product
    expect(d.has('1')).toBe(false) // lot #1 of listing B is a NEW lot
    expect(d.has('3')).toBe(false)
    expect(d.listing).toBe(LISTING_B)
  })

  it('dedupes lot-less order rows by order id, across listing changes', () => {
    const d = new PrintDedup()
    d.setListing(LISTING_A)
    expect(d.seenOrder('577000000000000001')).toBe(false)
    expect(d.seenOrder('577000000000000001')).toBe(true)
    d.setListing(LISTING_B)
    expect(d.seenOrder('577000000000000001')).toBe(true) // order ids are global, not per-listing
    expect(d.seenOrder('577000000000000002')).toBe(false)
  })

  it('dedupes a lot whose sources disagree on the winner (snipe)', () => {
    // #252: "Liz" via pin swap-close, "Amy891" via the order row. One lot, one label.
    const d = new PrintDedup()
    d.setListing(LISTING_A)
    expect(d.has('252')).toBe(false)
    d.add('252')
    expect(d.has('252')).toBe(true)
  })

  // ── backstop: pin is the listing-id source, and it goes dark whenever TikTok serves a
  // verification puzzle (every REST poll returns an empty {"code":0} until it is solved —
  // observed live, 2231 of 2300 pin responses in one show). Without a second reset signal
  // a listing switch during that window suppresses every lot.
  describe('lot-restart backstop (dead pin)', () => {
    it('rolls over on a return to #1 when the listing id never arrives', () => {
      const d = new PrintDedup() // no setListing() at all — pin is serving empty bodies
      for (const lot of ['1', '2', '3', '4', '5', '6']) { expect(d.has(lot)).toBe(false); d.add(lot) }
      expect(d.has('6')).toBe(true) // still deduping within the listing
      expect(d.has('1')).toBe(false) // new listing restarted → must print, not suppress
      d.add('1')
      expect(d.has('1')).toBe(true) // ...and dedupes again under the new scope
    })

    it('does NOT roll over on newest-first order backfill', () => {
      // A real run queued #65, #64, #63 in that order off one auction_result page. A plain
      // "any lower lot number" rule would roll over here and reprint the whole show.
      const d = new PrintDedup()
      d.setListing(LISTING_A)
      for (let i = 60; i <= 68; i++) d.add(String(i))
      for (const lot of ['65', '64', '63']) expect(d.has(lot)).toBe(true)
      expect(d.has('60')).toBe(true) // deep sweep reaching further back still suppressed
    })

    it('does not roll over on a short listing, where the id reset suffices', () => {
      const d = new PrintDedup()
      d.setListing(LISTING_A)
      d.add('1')
      d.add('2')
      expect(d.has('1')).toBe(true) // max lot 2 < RESTART_MIN_MAX — no rollover
    })

    it('still dedupes the double-print after a backstop rollover', () => {
      const d = new PrintDedup()
      for (let i = 1; i <= 8; i++) d.add(String(i))
      expect(d.has('1')).toBe(false) // rollover
      d.add('1') // ws-end #1 prints
      expect(d.has('1')).toBe(true) // ws-result #1 suppressed
    })

    it('ignores non-numeric lot numbers rather than rolling over', () => {
      const d = new PrintDedup()
      d.setListing(LISTING_A)
      for (let i = 1; i <= 8; i++) d.add(String(i))
      expect(d.has('')).toBe(false)
      expect(d.has('abc')).toBe(false)
      expect(d.has('8')).toBe(true) // scope survived — no accidental rollover
    })
  })

  it('bounds the order-id set on a long show', () => {
    const d = new PrintDedup()
    for (let i = 0; i < 5200; i++) d.seenOrder(`order-${i}`)
    expect(d.seenOrder('order-5199')).toBe(true) // recent orders still guarded
  })
})
