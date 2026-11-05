// LANE D — the past-order badge on a SALE row (feed, payment issues, top buyers; NEVER chat),
// and the batching for the hq lookup. Pure: unit-test in src/core/__tests__/buyerTags.test.ts.
//
// SCAFFOLD STUB: buyerTag() returns null (no badge) and batchBuyerIds() returns nothing.

/** hq's per-request cap for POST /api/desktop/buyer-history. */
export const BUYER_HISTORY_MAX_IDS = 200

/** What a badge shows. The renderer turns it into `<span class="tag …">`. */
export interface BuyerTag {
  /** 'new' → green NEW; 'count' → the number. */
  kind: 'new' | 'count'
  /** "NEW", "1".."99", or "99+". */
  text: string
  /** Exact wording for title + aria-label: "1 past order", "240 past orders", "No past orders". */
  title: string
}

/**
 * Format a buyer's past-order count (non-cancelled orders placed BEFORE this show started,
 * from hq). BUILD.md decision 5:
 * - `undefined` (not looked up yet / lookup failed) → `null`: show no badge rather than guess.
 * - `0` → `{ kind: 'new', text: 'NEW' }`.
 * - `1..99` → the number; `> 99` → `'99+'` with the exact count in `title`.
 */
export function buyerTag(count: number | undefined): BuyerTag | null {
  void count
  return null
}

/**
 * The ids still to ask hq about: de-duplicated, empty ids dropped, ids already in `known`
 * skipped, split into chunks of at most `max`. Order of first appearance is kept.
 */
export function batchBuyerIds(ids: readonly (string | undefined)[], known: ReadonlySet<string>, max = BUYER_HISTORY_MAX_IDS): string[][] {
  void ids; void known; void max
  return []
}
