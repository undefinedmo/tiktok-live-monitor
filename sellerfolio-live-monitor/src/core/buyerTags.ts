// LANE D — the past-order badge on a SALE row (feed, payment issues, top buyers; NEVER chat),
// and the batching for the hq lookup. Pure: unit-tested in src/core/__tests__/buyerTags.test.ts.

/** hq's per-request cap for POST /api/desktop/buyer-history. */
export const BUYER_HISTORY_MAX_IDS = 200

/** Longest id we will send. A TikTok ttuid is ~19 digits; anything far longer is not one. */
export const BUYER_ID_MAX_LEN = 64

/** What a badge shows. The renderer turns it into `<span class="tag …">`. */
export interface BuyerTag {
  /** 'new' → green NEW; 'count' → the number. */
  kind: 'new' | 'count'
  /** "NEW", "1".."99", or "99+". */
  text: string
  /** Exact wording for title + aria-label: "First order", "1 past order", "240 past orders". */
  title: string
}

/**
 * Format a buyer's past-order count (non-cancelled orders placed BEFORE this show started,
 * from hq). BUILD.md decision 5:
 * - `undefined` (not looked up yet / lookup failed) or not a usable number → `null`: no badge
 *   rather than a guess.
 * - `0` → `{ kind: 'new', text: 'NEW', title: 'First order' }`.
 * - `1..99` → the number; `> 99` → `'99+'`, the exact count always in `title`.
 */
export function buyerTag(count: number | undefined): BuyerTag | null {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null
  const n = Math.floor(count)
  if (n === 0) return { kind: 'new', text: 'NEW', title: 'First order' }
  return { kind: 'count', text: n > 99 ? '99+' : String(n), title: `${n} past order${n === 1 ? '' : 's'}` }
}

/** A string that could be a buyer id worth asking hq about. */
export function isBuyerId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= BUYER_ID_MAX_LEN && id.trim() === id
}

/**
 * The ids still to ask hq about: de-duplicated, empty/invalid ids dropped, ids already in `known`
 * skipped, split into chunks of at most `max`. Order of first appearance is kept.
 */
export function batchBuyerIds(ids: readonly (string | undefined)[], known: ReadonlySet<string>, max = BUYER_HISTORY_MAX_IDS): string[][] {
  const size = Math.max(1, Math.floor(max))
  const seen = new Set<string>()
  const out: string[][] = []
  for (const id of ids) {
    if (!isBuyerId(id) || known.has(id) || seen.has(id)) continue
    seen.add(id)
    const last = out[out.length - 1]
    if (last && last.length < size) last.push(id)
    else out.push([id])
  }
  return out
}

/**
 * The `counts` of an hq answer, keeping only well-formed entries (a known id → a non-negative
 * integer). Anything else in the body is ignored; a body that is not an answer gives `{}`.
 */
export function parseCounts(body: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!body || typeof body !== 'object') return out
  const counts = (body as { counts?: unknown }).counts
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return out
  for (const [id, v] of Object.entries(counts as Record<string, unknown>)) {
    if (isBuyerId(id) && typeof v === 'number' && Number.isFinite(v) && v >= 0) out[id] = Math.floor(v)
  }
  return out
}

/**
 * Delay before retrying after the `failures`-th consecutive failure (1-based): 5 s, 10 s, 20 s …
 * capped at 5 minutes. Polite to hq and still recovers within a show.
 */
export function backoffMs(failures: number, baseMs = 5_000, capMs = 300_000): number {
  const f = Math.max(1, Math.floor(failures))
  return Math.min(capMs, baseMs * 2 ** Math.min(f - 1, 20))
}

/** What to do with an hq HTTP status (or 'network' for a throw / timeout). */
export type BuyerHistoryOutcome =
  | 'ok' //          use the counts
  | 'unavailable' // 404/405/501 — an hq without the endpoint: stay quiet for a long while
  | 'auth' //        401/403 — not (or no longer) allowed: back off hard; main's own whoami handles it
  | 'bad' //         400/413/422 — this batch is unacceptable: don't send these ids again this show
  | 'retry' //       network, 408, 429, 5xx, anything else — retry later with backoff

export function classifyStatus(status: number | 'network'): BuyerHistoryOutcome {
  if (status === 'network') return 'retry'
  if (status >= 200 && status < 300) return 'ok'
  if (status === 404 || status === 405 || status === 501) return 'unavailable'
  if (status === 401 || status === 403) return 'auth'
  if (status === 400 || status === 413 || status === 422) return 'bad'
  return 'retry'
}
