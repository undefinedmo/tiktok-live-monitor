// Which lots have already had a label printed. Every close source auto-prints and this
// arbitrates between them: exactly one label per lot number, whatever source reports it
// and whether or not the sources agree on the winner.
//
// Three failure modes have shipped here. All of them are encoded below; read them before
// changing the key.
//
//   1. Keying on winner+lot double-printed a snipe. The pin's last leader is not the
//      auction_result winner when a lot is sniped (observed live: #252 printed twice —
//      "Liz" via pin swap-close, "Amy891" via the order row), so a winner-keyed guard saw
//      two distinct keys and both paths printed. Key on the LOT, never the winner.
//
//   2. Keying on the lot alone, with a reset driven by close events, deduped NOTHING.
//      Lot numbers restart per listing (variant #1..#K under each auction product), so
//      some reset is needed — but a close event's `auctionConfigId` is per-listing ONLY
//      for pin-sourced closes. Main sends auctionIm's `auctionId` for auction.end and
//      `skuId` for result_update, both per-AUCTION (core/auctionIm.ts: "NOT the roster's
//      auction_config_id"). So the scope reset on EVERY close, before every check:
//      auction.end printed the label and result_update reprinted it ~5s later, with the
//      order row good for a third. That was the v1.3.7–v1.3.14 double-print.
//
//   3. Reset-on-listing-change, with a lot-number heuristic as backstop, had a hole in
//      the exact case the backstop existed for. The listing id comes from pin/roster, and
//      TikTok answers every poll with a bare {"code":0} while a verification puzzle is
//      pending — so during that blackout no listing id arrives at all. The heuristic
//      ("a return to lot #1 or #2 means a new listing") assumed the new listing's FIRST
//      OBSERVED lot is #1 or #2, but the early closes are exactly what the blackout eats.
//      A listing whose first seen lot was #3+ collided with the previous listing and every
//      label was suppressed until pin recovered.
//
// The fix for (3) is to stop detecting restarts at all. Scope the key instead: a lot is
// identified by the listing it belongs to, so lot #3 of listing B and lot #3 of listing A
// are simply different keys and nothing ever has to be cleared. The scope comes from the
// listing id when pin/roster has given us one, and falls back to the lot's product name —
// which every print source carries (pin roster name, im Manager title, auction_result
// product_name) and which changes when the seller moves to a new listing. Normalized, so
// the same sale reported by different sources still collapses to one key.
//
// This is what the older `printKey` comment in the renderer already argued for; the
// listing-reset design lost it. There is no clearing, no heuristic, and no blackout
// window — the degraded case (no listing id AND no product name) falls back to a bare lot
// number, which is the old behaviour and no worse.

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')

export class PrintDedup {
  private listingId = ''
  private printed = new Set<string>()
  private orderIds = new Set<string>()

  /**
   * Point the guard at the current listing. Feed this ONLY from pin/roster
   * (`PinnedAuction.auctionConfigId`), never from a close event — see (2) above.
   * Unknown ids are ignored rather than treated as a new scope, so an empty
   * `{"code":0}` body during a verification gate is a no-op, not a scope change.
   */
  setListing(listingId?: string): void {
    if (!listingId) return
    this.listingId = listingId
  }

  /**
   * The key a lot is remembered under: listing id when known, else the product name.
   * Both identify the listing; the id is authoritative, the name is what survives a
   * pin blackout. A lot with neither degrades to a bare lot number.
   */
  private keyFor(lot: string, productName?: string): string {
    const scope = this.listingId || norm(productName ?? '')
    return `${scope}|${lot}`
  }

  /**
   * Claim a lot for printing. Returns true if the caller should print — that is, if no
   * label has been produced for this lot under this listing yet — and records it.
   *
   * One atomic call rather than a `has()` predicate plus a separate `add()`: the previous
   * split let a check and its record drift apart, and (worse) `has()` carried a
   * destructive reset side effect, so asking whether a lot had printed could change the
   * answer for every other lot. Claiming is the only mutation.
   */
  claim(lot: string, productName?: string): boolean {
    const key = this.keyFor(lot, productName)
    if (this.printed.has(key)) return false
    this.printed.add(key)
    return true
  }

  /**
   * Has this lot printed, WITHOUT claiming it? Only for the held swap-close timer, which
   * must re-check just before firing to see whether a confirmed source got there first.
   * Everything else calls claim().
   */
  printedAlready(lot: string, productName?: string): boolean {
    return this.printed.has(this.keyFor(lot, productName))
  }

  /**
   * Fallback for order rows with no lot number: dedupe on the order id, which is globally
   * unique, so it is NOT listing-scoped. Bounded, since a long show produces thousands.
   * Returns true if this order has been seen before.
   */
  seenOrder(orderId: string): boolean {
    if (this.orderIds.has(orderId)) return true
    this.orderIds.add(orderId)
    if (this.orderIds.size > 5000) this.orderIds.delete(this.orderIds.values().next().value as string)
    return false
  }

  /** Current listing scope — for diagnostics and tests. */
  get listing(): string {
    return this.listingId
  }
}
