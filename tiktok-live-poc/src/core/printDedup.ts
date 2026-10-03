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
// listing-reset design lost it. There is no clearing and no restart heuristic. The
// degraded case (no listing id AND no product name) falls back to a bare lot number,
// which is the old behaviour and no worse.
//
// One caveat, since an earlier version of this comment claimed the blackout window was
// gone outright and it was not: setListing ignores empty ids, so the last id LATCHES
// through a gate instead of clearing, and a listing change inside that window would still
// collide. LISTING_TTL_MS below is what actually closes it.

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * How long a listing id stays trustworthy without being re-confirmed by pin/roster.
 *
 * setListing ignores empty ids (an empty body is missing evidence, not a new listing), so
 * during a verification blackout the last id LATCHES rather than clearing. If the seller
 * starts a new listing inside that window, its lots would claim under the previous
 * listing's scope and be suppressed as already-printed — the very failure the scoped key
 * was meant to end, just moved from "app started gated" to "gate arrived mid-show".
 *
 * So an id that has not been re-confirmed for this long is treated as unknown, and the
 * scope falls back to the product name. Erring this way costs at most one duplicate label
 * at the boundary; erring the other way costs every label until pin recovers.
 */
const LISTING_TTL_MS = 30000

export class PrintDedup {
  private listingId = ''
  private listingSeenAt = 0
  private printed = new Set<string>()
  private orderIds = new Set<string>()

  /**
   * Point the guard at the current listing. Feed this ONLY from pin/roster
   * (`PinnedAuction.auctionConfigId`), never from a close event — see (2) above.
   * Unknown ids are ignored rather than treated as a new scope, so an empty
   * `{"code":0}` body during a verification gate is a no-op, not a scope change.
   */
  setListing(listingId: string | undefined, now: number): void {
    if (!listingId) return
    this.listingId = listingId
    this.listingSeenAt = now // re-confirmed; the TTL above restarts
  }

  /**
   * The key a lot is remembered under: listing id when known, else the product name.
   * Both identify the listing; the id is authoritative, the name is what survives a
   * pin blackout. A lot with neither degrades to a bare lot number.
   */
  /**
   * Every scope this lot could be remembered under — listing id AND product name, not one
   * or the other.
   *
   * Picking a single scope per call looked right and duplicated labels live. During a gate
   * the id goes stale and a lot is claimed under its product name; pin then recovers, the
   * id becomes authoritative again, and the SAME lot reported seconds later computes a
   * different key and prints a second time. Observed at 22:03:58 → 22:04:00, two seconds
   * apart, with gating around 25% — so a "recovery boundary" is not a rare edge, it is
   * every couple of minutes.
   *
   * Recording and checking both scopes makes the guard immune to which source happened to
   * be available. The cost: if the seller relists a product under the SAME name later in
   * the session, its lots match the old name key and are suppressed. That needs an
   * identical product name in one session, against a duplicate every gate recovery.
   */
  private keysFor(lot: string, productName: string | undefined, now: number): string[] {
    const keys: string[] = []
    const fresh = !!this.listingId && now - this.listingSeenAt <= LISTING_TTL_MS
    if (fresh) keys.push(`${this.listingId}|${lot}`)
    const name = norm(productName ?? '')
    if (name) keys.push(`${name}|${lot}`)
    // Neither known: degrade to the bare lot number, the old behaviour and no worse.
    if (!keys.length) keys.push(`|${lot}`)
    return keys
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
  claim(lot: string, productName: string | undefined, now: number): boolean {
    const keys = this.keysFor(lot, productName, now)
    // Seen under ANY scope means a label exists, whichever source reported it.
    if (keys.some((k) => this.printed.has(k))) return false
    // Record under ALL of them, so the same lot is still recognised after the scope
    // changes underneath us — which it does every time a gate lifts.
    for (const k of keys) this.printed.add(k)
    return true
  }

  /**
   * Has this lot printed, WITHOUT claiming it? Only for the held swap-close timer, which
   * must re-check just before firing to see whether a confirmed source got there first.
   * Everything else calls claim().
   */
  printedAlready(lot: string, productName: string | undefined, now: number): boolean {
    return this.keysFor(lot, productName, now).some((k) => this.printed.has(k))
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
