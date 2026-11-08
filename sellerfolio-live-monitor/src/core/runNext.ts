// Run next lot: decide whether a press may start an auction, and on which listing.
// Pure (no Electron, no DOM): electron/runNext.ts asks this before every start, tested in vitest.
//
// The rule is the owner's (2026-11-08): "same listing, next number". A listing (one TikTok auction
// product, e.g. "Mystery bag") holds many lots (#35, #36…); Run next presses TikTok's own Start on
// the listing that just ran, and TikTok runs its next lot. When the listing runs out, the host picks
// the next listing in TikTok themselves — this never moves down the list on its own.
//
// TikTok's call (found in Streamer Desktop's own bundle, 2026-11-08):
//   POST /api/v1/streamer_desktop/live_auction/start_auction
//   { auction_config_id, room_id, session_id, fe_start_timestamp }
// auction_config_id is the LISTING id (shared by every lot under it), which is what pin/get reports
// as the current auction's auctionConfigId.
//
// It refuses rather than guesses: anything it cannot see clearly (no recent pin sample, a lot still
// bidding, a status it does not know) is a "not now" with the reason in plain words. A wrong start
// on a live show sells an item; a refused press costs one more click in TikTok.

import type { PinState, RosterSnapshot } from './types'

export const STATUS_BIDDING = 1
export const STATUS_ENDED = 3
/** pin/get is polled about once a second; older than this and we no longer know what is running. */
export const PIN_FRESH_MS = 15_000
/** After a start, refuse another until pin/get shows the new lot bidding, or this long passes. */
export const START_SETTLE_MS = 6_000

export type RunNextPlan =
  | { ok: true; auctionConfigId: string; listing: string; after?: string }
  | { ok: false; reason: string }

export interface RunNextInput {
  pin: PinState | null
  roster: RosterSnapshot | null
  roomId?: string
  sessionId?: string
  /** When the last start was sent, and the pin sample time it was sent against. */
  lastStart?: { atMs: number; pinTs: number } | null
  nowMs: number
}

const name = (s: string | undefined): string => (s && s.trim() ? s.trim() : 'this listing')

export function planRunNext(i: RunNextInput): RunNextPlan {
  if (!i.roomId || !i.sessionId) return { ok: false, reason: 'No live show found yet.' }
  const pin = i.pin
  if (!pin || i.nowMs - pin.ts > PIN_FRESH_MS) return { ok: false, reason: 'Waiting for TikTok to report the current auction.' }
  const c = pin.current
  if (!c?.auctionConfigId) return { ok: false, reason: 'Start the first lot in TikTok. Run next lot then continues that listing.' }
  const listing = name(c.productName)

  const running = `${c.variantDesc?.trim() || 'The current lot'} is still running.`
  // A start was just sent: until TikTok reports the new lot bidding, the last sample still says
  // "ended", so without this a second press would start a second lot.
  if (i.lastStart && i.nowMs - i.lastStart.atMs < START_SETTLE_MS) {
    const seenSince = pin.ts > i.lastStart.pinTs
    return { ok: false, reason: seenSince && c.status === STATUS_BIDDING ? running : 'Starting…' }
  }
  if (c.status === STATUS_BIDDING) return { ok: false, reason: running }
  if (c.status !== STATUS_ENDED) return { ok: false, reason: `Waiting for ${listing} to finish.` }

  const p = i.roster?.products.find((x) => x.auctionConfigId === c.auctionConfigId)
  if (p?.statusError) return { ok: false, reason: `TikTok says: ${p.statusError}` }
  if (p && typeof p.stockNum === 'number' && p.stockNum <= 0) {
    return { ok: false, reason: `${listing} has no lots left. Start the next listing in TikTok.` }
  }
  return { ok: true, auctionConfigId: c.auctionConfigId, listing, after: c.variantDesc?.trim() || undefined }
}

/** The request body TikTok's own page sends (field names verbatim). */
export function startAuctionBody(auctionConfigId: string, roomId: string, sessionId: string, nowMs: number) {
  return { auction_config_id: auctionConfigId, room_id: roomId, session_id: sessionId, fe_start_timestamp: String(nowMs) }
}

/** The button text: what a press would start, or why it won't. */
export function runNextTitle(plan: RunNextPlan): string {
  if (!plan.ok) return plan.reason
  return `Start the next lot of ${plan.listing}${plan.after ? ` (after ${plan.after})` : ''}`
}
