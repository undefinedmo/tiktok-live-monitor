// LANE D — renderer side of the past-order badge. Lane B calls requestCounts() with the ttuids it
// is about to paint and badgeFor() per sale row (feed, payment issues, top buyers — NEVER chat).
// Counts arrive through window.buyerAPI (lookup → cached now; onCounts → pushed later); a push
// calls the listeners so lane B can repaint.
//
// SCAFFOLD STUB: no counts are ever known, so badgeFor() returns null (no badge).

/** Called once by renderer.ts at startup (subscribe to window.buyerAPI.onCounts). */
export function initBuyerHistory(): void {}

/** Ask for these buyers' counts (deduped, batched in main). Fire-and-forget; never throws. */
export function requestCounts(ttuids: readonly (string | undefined)[]): void {
  void ttuids
}

/** The past-order count for a buyer, if known. */
export function pastOrdersOf(ttuid: string | undefined): number | undefined {
  void ttuid
  return undefined
}

/** `<span class="tag …">` for a sale row's buyer (core/buyerTags.buyerTag), or null for no badge. */
export function badgeFor(ttuid: string | undefined): HTMLElement | null {
  void ttuid
  return null
}

/** Called after new counts arrive, so the sales view can repaint its badges. */
export function onCountsChanged(cb: () => void): void {
  void cb
}
