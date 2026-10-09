// The pure part of wiring a sale to the identification endpoint: which boundaries a sale has, which
// audio to cut for it, and the payload that results. Everything here is epoch SECONDS on ONE clock
// (the caller converts; see serverToLocalSec). The renderer only calls these: the hand-off from a sale
// to what the server is sent lives here so that it is tested.
import { clipTimingSuspect, type ExtractedClip } from './clipRecorder'
import type { IdentifyJob } from './identifyClient'
import { serverToLocalSec, type IdentifyPayload } from './identifySend'

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
 * With no boundary at all (the first lot of every show, and the first after every switch off/on)
 * there is nothing to reach back to. The server owns the window geometry and clamps; this only bounds
 * what is uploaded. 30 s, not 60: a 60 s window is what caused the September production incident
 * (80% of it is foreign talk on measured shows), and 30 s is the measured-defensible figure.
 */
export const NO_BOUNDARY_LOOKBACK_SEC = 30
/**
 * The most audio the app asks for before the sale. After a long gap the wall is minutes back, and the
 * whole 5-minute buffer would be both worse input (a 60 s window is already 80% foreign talk on
 * measured shows) and a bigger upload. The server still clamps what it analyses.
 */
export const MAX_LOOKBACK_SEC = 120

// ── STREAM LATENCY ───────────────────────────────────────────────────────────────────────────────
// Two clocks meet here and they are NOT the same clock.
//   - SHOW TIME: when something happened in the show. A sale is stamped TikTok's order_create_time
//     (corrected to this machine's clock by serverToLocalSec); auction starts and ends likewise.
//   - BUFFER TIME: when this machine's recorder delivered a chunk (`Date.now()` at ondataavailable,
//     renderer.ts). The audio is the PLAYED FLV stream, which lags real time by CDN + the player's own
//     buffer: some latency L. So a chunk stamped C holds show-time C - L, and show-time T lives in the
//     chunk stamped T + L.
// Uncorrected, a clip whose first byte is stamped C is sent to the server as starting at C while its
// bytes begin at C - L; the server trims to the lot's start A at offset A - C, which is show-time A - L:
// L seconds into the PREVIOUS lot. The structural clamp cannot help, the wall is on the same clock and
// shifts identically. (A real show's audit found 71% of its identification errors were the previous lot.)
//
// L IS NOT KNOWN. It is a setting (`streamLatencySec`, identify.json, default 0 = exactly the behaviour
// before this existed) to be MEASURED on a real show, so that learning it is a config change and not a
// code change. HOW TO MEASURE IT: watch a show with identification on. For one lot, note the wall-clock
// instant its order row fires (the moment the sale appears in the app: write the time down, or read it
// from the show journal's `sale` record), then find when the gavel / "sold" is AUDIBLE in the captured
// clip (the clip's own start, `clip.startEpochSec`, plus the offset of the gavel in the audio). The
// difference is L: (clip start + offset of the gavel) - (the sale's time). Do it for several lots and
// take the median; it should be a stable few seconds to ~15. Until it has been measured, identifications
// are not trustworthy, and the Settings screen says so.
//
// The correction is applied at exactly TWO places, both here, and they are opposite directions:
//   - clipRequestFor / clipReadyEpochSec: show time -> buffer time, so the REQUEST is `+ L`.
//   - identifyPayloadFor: buffer time -> show time, so the clip's own start LABEL is `- L`.
// Either alone is wrong: the first alone selects the right bytes and still labels them L seconds late;
// the second alone labels the wrong bytes truthfully.

/** The largest correction accepted. A stream a minute behind is a broken stream, not a delay to correct. */
export const MAX_STREAM_LATENCY_SEC = 60

/** A usable latency: a finite number from 0 to MAX_STREAM_LATENCY_SEC. Anything else is "no correction". */
export function safeLatencySec(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_STREAM_LATENCY_SEC ? v : 0
}

/**
 * The span of audio to cut for a sale, in BUFFER TIME. Not a window plan -- the server plans, and
 * clamps at the wall -- just "enough to cover whatever it could choose". It begins at the EARLIEST
 * boundary, not the wall: an order row lands seconds after the close, so the previous sale can be later
 * than this lot's own start, and starting at the wall would cut the lot's opening. The clip store returns
 * whole chunks and reports what it really cut; the CLIP's own timestamps are what get sent.
 *
 * The boundaries are SHOW time; the window is planned in show time (with the lookback caps) and then
 * shifted by `streamLatencySec` into buffer time (see STREAM LATENCY above). 0 shifts nothing.
 */
export function clipRequestFor(b: SaleBoundaries, streamLatencySec = 0): { startEpochSec: number; endEpochSec: number } {
  const L = safeLatencySec(streamLatencySec)
  const known = [b.auctionStartEpochSec, b.prevBoundaryEpochSec].filter((t): t is number => t !== null)
  const wanted = known.length ? Math.min(...known) - CLIP_LEAD_PAD_SEC : b.saleEpochSec - NO_BOUNDARY_LOOKBACK_SEC
  const startEpochSec = Math.max(wanted, b.saleEpochSec - MAX_LOOKBACK_SEC)
  return { startEpochSec: startEpochSec + L, endEpochSec: b.saleEpochSec + CLIP_TAIL_SEC + L }
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
  already_queued: 'This lot is already being identified',
  identification_off: 'Identification was turned off in Settings, so nothing was sent',
  bad_request_local: 'The sale times were not valid, so nothing was sent',
  worker_unreachable: 'The identification server is unreachable right now -- press Retry once it is back',
  too_old: 'This sale reached the app too late to identify on its own -- press Retry to try it now',
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

/** The job for a sale: the sale, its room and its boundaries. It carries NOTHING about the clip. */
export function jobForSale(sale: { orderId: string; roomId: string | null }, b: SaleBoundaries): IdentifyJob {
  return {
    orderId: sale.orderId,
    roomId: sale.roomId,
    saleEpochSec: b.saleEpochSec,
    auctionStartEpochSec: b.auctionStartEpochSec,
    prevBoundaryEpochSec: b.prevBoundaryEpochSec,
  }
}

/**
 * What a row should say about the audio behind an identification, to append to its text: the buffer
 * began late (a short clip), and/or the clip's timeline and its audio disagree (a stalled stream), so the
 * window the server planned may not be the lot. Empty for a healthy clip. A gap is NOT reported as
 * `truncated` -- that flag has one meaning and the clip is sent either way; this is what makes it visible.
 */
export function clipNote(clip: { truncated: boolean; gapSec: number }): string {
  let note = ''
  if (clip.truncated) note += ' (the audio buffer began late, so the clip is short)'
  if (clipTimingSuspect(clip)) {
    const s = Math.round(Math.abs(clip.gapSec))
    note += clip.gapSec > 0
      ? ` (the audio stalled for about ${s} s, so the clip's timing may be off)`
      : ` (the audio's clock stood still for about ${s} s, so the clip's timing may be off)`
  }
  return note
}

/** When the audio after a sale exists in the buffer: the sale, its tail, and the stream's lag. */
export function clipReadyEpochSec(saleEpochSec: number, streamLatencySec = 0): number {
  return saleEpochSec + CLIP_TAIL_SEC + safeLatencySec(streamLatencySec)
}

/**
 * Everything the server is sent for one sale: the job and THE EXTRACTED CLIP (same object, so its own
 * duration describes its own bytes). The boundaries are computed once and feed both the window asked of
 * the store and the job, so the two cannot disagree. Null when there is no audio.
 *
 * With a stream latency the clip's start is relabelled from buffer time to show time (the one field
 * changed; see STREAM LATENCY). With none, the very same object is returned.
 */
export function identifyPayloadFor(
  sale: { orderId: string; roomId: string | null; atEpochSec: number },
  journal: readonly JournalEvent[],
  store: { extract: (want: { startEpochSec: number; endEpochSec: number }) => ExtractedClip | null },
  streamLatencySec = 0,
): IdentifyPayload | null {
  const L = safeLatencySec(streamLatencySec)
  const b = boundariesForSale(sale, journal)
  const clip = store.extract(clipRequestFor(b, L))
  if (!clip) return null
  return { job: jobForSale(sale, b), clip: L === 0 ? clip : { ...clip, startEpochSec: clip.startEpochSec - L } }
}

/** A sale this young, by THIS machine's clock after correcting the server timestamp, is worth identifying. */
export const RECENT_SALE_MAX_AGE_SEC = 60

/**
 * Is the order recent? `createdAtMs` is the SERVER's clock; comparing it with a local `Date.now()`
 * would fail every sale once the station's clock ran a minute off TikTok's, with no row, no job and no log.
 */
export function isRecentSale(createdAtMs: number, nowMs: number, serverOffsetMs: number | undefined): boolean {
  return nowMs / 1000 - serverToLocalSec(createdAtMs, serverOffsetMs) < RECENT_SALE_MAX_AGE_SEC
}

/**
 * Sort a batch of fresh sales into those to identify now and those that reached the app too late. Late-
 * landing order rows are a documented sync behaviour, and the audio buffer holds 300 s, so a late sale is
 * often still identifiable: it is NOT dropped. The caller records a row for each `tooOld` sale (reason
 * `too_old`, with a Retry) and does not send it on its own.
 *
 * Payment status is deliberately NOT consulted. TikTok reports payment late, so a lot reads
 * `failed` the instant it sells and frequently settles moments later — and the sweep re-returns it
 * as history rather than as fresh, so a lot skipped on first sighting was never identified at all.
 * Measured on a live show: an unbroken run of 18 sales all reading `failed`, every one skipped and
 * no row to show for it. Identify the lot; what the payment did afterwards is a separate fact kept
 * on the order.
 */
export function splitSalesByAge<S extends { createdAt: number; paymentStatus?: string }>(
  sales: readonly S[],
  nowMs: number,
  serverOffsetMs: number | undefined,
): { toIdentify: S[]; tooOld: S[] } {
  const toIdentify: S[] = []
  const tooOld: S[] = []
  for (const s of sales) {
    if (isRecentSale(s.createdAt, nowMs, serverOffsetMs)) toIdentify.push(s)
    else tooOld.push(s)
  }
  return { toIdentify, tooOld }
}

/**
 * Orders that must not be identified (uploaded) again. Two kinds, because they have different lives:
 * `sent` are this show's sales, forgotten when the show changes (or the set grows past `cap`); `restored`
 * came back from disk, were identified in an earlier session, and are never forgotten -- a restored order
 * the app is shown again later is not worth a multi-megabyte upload that competes with live sales.
 */
export function createSeenOrders(cap = 2000) {
  const sent = new Set<string>()
  const restored = new Set<string>()
  return {
    has: (id: string): boolean => sent.has(id) || restored.has(id),
    markSent(id: string): void {
      sent.add(id)
      if (sent.size > cap) {
        sent.clear()
        sent.add(id)
      }
    },
    markRestored: (id: string): void => void restored.add(id),
    endShow: (): void => sent.clear(),
  }
}
