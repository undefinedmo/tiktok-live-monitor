// When to send the next `pin/get`. Portable: no electron/DOM.
//
// A flat 1.2s cadence samples a lot at a random phase against its gavel, so the ended state
// is caught anywhere from 0 to 1.2s after it becomes visible — and the last look at the
// leader is equally random. But the end is not random: `expected_end_time_ms` is on every
// response, on the server clock. So aim one poll at the moment the ended state can first
// exist instead of adding polls.
//
// Measured 2026-10-03 (10 flight logs, 1,449 closes; live console, 6 closes): TikTok shows
// status 3 no sooner than ~1.0s after the timer reaches zero — the fastest 10% of detections
// landed at +1.09s and none earlier — and the median detection was +1.78s, i.e. ~0.6s of
// pure phase wait. Landing a poll on expected end + 1.0s removes that wait for at most one
// extra request per auction: the poll that would have fallen just before the end is moved.

export const PIN_LIVE_MS = 1200 // a lot is bidding and its end is not close
export const PIN_IDLE_MS = 6000 // no live lot; nothing to detect until one starts
/** How long after the timer hits zero TikTok first reports the lot ended. */
export const FINALIZE_LAG_MS = 1000
/** The lot is past due but still reads "bidding": TikTok is late, look again soon. */
export const LATE_RETRY_MS = 400
/** Bounded, so a lot stuck in status 1 cannot hold the loop at the retry rate. */
export const MAX_LATE_RETRIES = 5
const MIN_DELAY_MS = 150 // never fire back-to-back; a response takes ~0.5s anyway
const MIN_APPROACH_MS = 300

export interface PinScheduleInput {
  /** latest_auction_item.status === 1 on the last response. */
  live: boolean
  /** expected_end_time_ms of the live lot (server clock). */
  expectedEndMs?: number
  /** Local now + (resp_server_time − local receive time). */
  serverNowMs?: number
  /** Late retries already spent on this lot. */
  lateTries: number
}

export function nextPinDelayMs(i: PinScheduleInput): number {
  if (!i.live) return PIN_IDLE_MS
  if (i.expectedEndMs === undefined || i.serverNowMs === undefined) return PIN_LIVE_MS
  const remaining = i.expectedEndMs + FINALIZE_LAG_MS - i.serverNowMs
  if (remaining <= 0) return i.lateTries < MAX_LATE_RETRIES ? LATE_RETRY_MS : PIN_LIVE_MS
  if (remaining <= PIN_LIVE_MS) return Math.max(MIN_DELAY_MS, remaining)
  // One interval out or less: shorten THIS wait so the next one is a full interval that
  // lands on the target, rather than arriving early and then overshooting by up to 1.2s.
  if (remaining < 2 * PIN_LIVE_MS) return Math.max(MIN_APPROACH_MS, remaining - PIN_LIVE_MS)
  return PIN_LIVE_MS
}
