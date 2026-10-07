// The pure part of wiring a sale to the identification endpoint: which boundaries a sale has.
// Everything here is epoch SECONDS on ONE clock (the caller converts; see serverToLocalSec).

/** One thing that happened in the show, as the renderer saw it. */
export type JournalEvent = {
  type: 'auction_start' | 'auction_end' | 'sale'
  atEpochSec: number
  orderId?: string | null
}

export type SaleBoundaries = {
  saleEpochSec: number
  auctionStartEpochSec: number | null
  prevBoundaryEpochSec: number | null
}

/** The latest of `times`, or null when there are none. */
const latest = (times: number[]): number | null => (times.length ? Math.max(...times) : null)

/**
 * The boundaries the server plans its window from.
 *
 * - `auctionStartEpochSec`: the latest `auction_start` at or before the sale, UNLESS it is older than
 *   the wall (`prevBoundaryEpochSec`). Then it belongs to an earlier lot (this lot's own start was never seen), and
 *   sending it would hand the server the previous lot's window -- the most common identification
 *   failure measured (71% of errors on THE ALO VAULT 10-04). It is dropped (null) and the
 *   previous-sale wall does the work. Not left to the server's clamp.
 * - `prevBoundaryEpochSec`: the wall. The previous auction's END when one was seen at or before this
 *   lot started, else the previous sale. Measured on a real show journal: 25 `auction_end` events
 *   against 919 sales, so the previous-sale fallback is the common path. An end is only usable
 *   when this lot's start is known -- without it an end could be this lot's OWN (it lands just
 *   before the sale) and would put the wall after the whole auction.
 *   A previous sale in the same second as this one is no wall (zero-width): null.
 */
export function boundariesForSale(
  sale: { orderId: string; atEpochSec: number },
  journal: readonly JournalEvent[],
): SaleBoundaries {
  const at = sale.atEpochSec
  const latestStart = latest(journal.filter((e) => e.type === 'auction_start' && e.atEpochSec <= at).map((e) => e.atEpochSec))
  const prevSale = latest(
    journal.filter((e) => e.type === 'sale' && e.orderId !== sale.orderId && e.atEpochSec < at).map((e) => e.atEpochSec),
  )
  const end =
    latestStart === null
      ? null
      : latest(journal.filter((e) => e.type === 'auction_end' && e.atEpochSec <= latestStart).map((e) => e.atEpochSec))
  const wall = end ?? prevSale
  // `end` is at or before the start by construction, so only the previous-sale wall can drop it.
  const start = latestStart !== null && wall !== null && latestStart < wall ? null : latestStart
  return { saleEpochSec: at, auctionStartEpochSec: start, prevBoundaryEpochSec: wall }
}

/** Audio kept ahead of the earliest boundary, so a word spoken as the card flipped is not cut. */
export const CLIP_LEAD_PAD_SEC = 2
/** Audio kept past the sale: the server plans up to SALE_TAIL after the close, and clamps to the clip. */
export const CLIP_TAIL_SEC = 5
/**
 * With no boundary at all (the first lot this app has seen) there is nothing to reach back to. The
 * server owns the window geometry and clamps; this only bounds what is uploaded.
 */
export const NO_BOUNDARY_LOOKBACK_SEC = 60

/**
 * The span of show audio to cut for a sale. Not a window plan -- the server plans, and clamps at the
 * wall -- just "enough to cover whatever it could choose". It begins at the EARLIEST boundary, not the
 * wall: an order row lands seconds after the close, so the previous sale can be later than this lot's
 * own start, and starting at the wall would cut the lot's opening. The clip store returns whole
 * chunks and reports what it really cut; the CLIP's own timestamps are what get sent.
 */
export function clipRequestFor(b: SaleBoundaries): { startEpochSec: number; endEpochSec: number } {
  const known = [b.auctionStartEpochSec, b.prevBoundaryEpochSec].filter((t): t is number => t !== null)
  const startEpochSec = known.length ? Math.min(...known) - CLIP_LEAD_PAD_SEC : b.saleEpochSec - NO_BOUNDARY_LOOKBACK_SEC
  return { startEpochSec, endEpochSec: b.saleEpochSec + CLIP_TAIL_SEC }
}

/** How a settled sale reads on screen. `error` covers every kind of failure; only `done` is a success. */
export type OutcomeView = { status: 'done' | 'skipped' | 'error' | 'abandoned'; text: string }

const FAILURE_TEXT: Record<string, string> = {
  timeout: 'The identification server did not answer',
  network_error: 'Could not reach the identification server',
  bad_token: 'The capture token was rejected -- check it in Settings',
  audio_too_large: 'The clip was too large to send',
  live_identify_unavailable: 'Live identification is unavailable on the server right now',
  quota_reached: 'The server has reached its identification limit',
  'order-sale-mismatch': 'The server does not think this order belongs to this sale',
  'order-not-found': 'The server does not have this order yet',
  no_audio: 'No audio was recorded for this lot',
  bad_request_local: 'The sale times were not valid, so nothing was sent',
  worker_unreachable: 'The identification server is unreachable right now -- press Retry once it is back',
}

/**
 * Settled outcome -> what to show. Total over every status: `abandoned` (the queue's own, when a show
 * ends with a sale still waiting) and anything unrecognised are NEVER `done`.
 */
export function viewOutcome(o: { status: string; reason?: string; tries?: number; attempts?: number }): OutcomeView {
  switch (o.status) {
    case 'identified':
      return { status: 'done', text: 'Identified -- saved to SellerFolio' }
    case 'skipped':
      return { status: 'skipped', text: `Nothing identifiable in this clip (${o.reason ?? 'skipped'})` }
    case 'abandoned':
      return { status: 'abandoned', text: `Not identified: ${o.reason ?? 'the show ended'} before this lot was reached` }
    case 'failed': {
      const reason = o.reason ?? 'unknown'
      const base = FAILURE_TEXT[reason] ?? `Identification failed (${reason})`
      return { status: 'error', text: o.tries !== undefined && o.tries > 1 ? `${base}, after ${o.tries} tries` : base }
    }
    default:
      return { status: 'error', text: `Identification ended in an unexpected state (${o.status})` }
  }
}
