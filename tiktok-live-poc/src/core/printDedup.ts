// Which lots have already had a label printed. Every close source auto-prints and this
// arbitrates between them: exactly one label per lot number, whatever source reports it
// and whether or not the sources agree on the winner.
//
// Two rules, and they are easy to get backwards — both failure modes have shipped:
//
//   1. Key on the LOT, not winner+lot. A snipe leaves the pin's last leader different from
//      the auction_result winner (observed live: #252 printed twice — "Liz" via pin
//      swap-close, "Amy891" via the order row), so a winner-keyed guard saw two distinct
//      keys and both paths printed.
//
//   2. Reset only on a real LISTING change, and take that id only from pin/roster.
//      Lot numbers restart per listing (variant #1..#K under each auction product), so the
//      set has to clear when the seller moves on — otherwise lot #3 of listing B looks like
//      a re-fire of lot #3 of listing A and printing silently stops. But a close event's
//      `auctionConfigId` is per-listing ONLY for pin-sourced closes: main sends auctionIm's
//      `auctionId` for auction.end and `skuId` for result_update, both per-AUCTION (see
//      core/auctionIm.ts — "NOT the roster's auction_config_id"). Resetting off a close
//      event therefore saw a new id on EVERY close, wiped the set before every check, and
//      deduped nothing: auction.end printed the label, result_update reprinted it ~5s
//      later, and the order row could print a third. That was the v1.3.7–v1.3.14
//      double-print. PinnedAuction.auctionConfigId is the per-listing id; use that.
// A new listing starts at #1. Allow #2 as well, in case #1's close is missed entirely
// (an empty-body stretch) and #2 is the first lot we actually see under the new listing.
const RESTART_LOT = 2
// ...but only treat it as a restart from a listing long enough that a backfilled low lot
// number can't be confused for one. Below this, the ordinary listing-id reset covers it.
const RESTART_MIN_MAX = 5

export class PrintDedup {
  private listingId = ''
  private lots = new Set<string>()
  private orderIds = new Set<string>()
  private maxLot: number | null = null

  /**
   * Point the guard at the current listing. Feed this ONLY from pin/roster
   * (`PinnedAuction.auctionConfigId`), never from a close event.
   * Returns true when the listing actually changed and the lot set was cleared, so the
   * caller can drop anything else scoped to the old listing (e.g. held swap-close prints).
   */
  setListing(listingId?: string): boolean {
    if (!listingId || listingId === this.listingId) return false
    this.listingId = listingId
    this.rollover()
    return true
  }

  /**
   * Has this lot number already printed under the current listing?
   *
   * Backstop for a dead pin: pin/get is the listing-id source, and TikTok serves an empty
   * `{"code":0}` for every REST poll while a verification puzzle is pending — so the reset
   * above can go silent for minutes at a stretch. If it does, and the seller starts a new
   * listing, its lots would be suppressed as already-printed and nothing would print at
   * all. So a return to lot #1 also rolls the scope over: lot numbers run #1..#K per
   * listing, and only a restart goes back to the start.
   *
   * Deliberately NOT "any lower number": the order-row path backfills newest-first (a real
   * run queued #65, #64, #63 in that order), so a plain regression test would roll over on
   * ordinary backfill and reprint the show. Requires a genuine return to the start, from a
   * listing long enough that a restart is the only sane reading. A false rollover costs one
   * duplicate label; a missed one costs every label until the next listing. Bias to print.
   */
  has(lot: string): boolean {
    const n = Number(lot)
    // n >= 1 matters: Number('') is 0, which would otherwise pass as a restart and wipe
    // the scope on any lot-less close.
    if (Number.isFinite(n) && n >= 1 && n <= RESTART_LOT && this.maxLot !== null && this.maxLot >= RESTART_MIN_MAX) {
      this.rollover()
      return false
    }
    return this.lots.has(lot)
  }

  /** Mark a lot as printed. */
  add(lot: string): void {
    this.lots.add(lot)
    const n = Number(lot)
    if (Number.isFinite(n) && (this.maxLot === null || n > this.maxLot)) this.maxLot = n
  }

  private rollover(): void {
    this.lots.clear()
    this.maxLot = null
  }

  /**
   * Fallback for order rows with no lot number: dedupe on the order id, which is globally
   * unique, so it is NOT scoped to a listing and never cleared. Bounded, since a long show
   * can produce thousands. Returns true if this order has been seen before.
   */
  seenOrder(orderId: string): boolean {
    if (this.orderIds.has(orderId)) return true
    this.orderIds.add(orderId)
    if (this.orderIds.size > 5000) this.orderIds.delete(this.orderIds.values().next().value as string)
    return false
  }

  /** Current listing id — exposed for diagnostics/tests. */
  get listing(): string {
    return this.listingId
  }
}
