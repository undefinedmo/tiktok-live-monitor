// The request/response layer for the live identification endpoint (POST /api/capture/live-identify
// on the Linux worker). Pure, like journalSync: no fetch, no electron, no logging -- the caller owns
// the network, and this file never sees anything it must not print except the token, which only
// ever goes into the Authorization header.
import type { ExtractedClip } from './clipRecorder'

/** The sale to identify. Deliberately carries NO clip window: see IdentifyClip. */
export type IdentifyJob = {
  orderId: string
  roomId: string | null
  saleEpochSec: number
  auctionStartEpochSec?: number | null
  prevBoundaryEpochSec?: number | null
}

/**
 * The clip to send: the extracted clip ITSELF, whole. Not loose numbers and not a pick of its
 * fields, because the clip store does not trim -- `startEpochSec` / `durationSec` describe the BYTES
 * in `blob`, not the window that was asked for, and the server plans against the audio it receives.
 * Hand-building `{blob, startEpochSec: want.start, durationSec: want.end - want.start}` would type-check
 * and pass every runtime check yet put the server's window on the wrong lot, and nothing short of
 * parsing the WebM can catch it. Requiring the whole ExtractedClip (with `leadInSec`, `truncated`) is
 * the only lever: such a literal is visibly wrong. Take it from `extract`, unchanged.
 */
export type IdentifyClip = ExtractedClip

export type IdentifyConfig = { baseUrl: string; token: string }

export const IDENTIFY_PATH = '/api/capture/live-identify'

// Every real epoch in SECONDS is below this (year 5138); every real epoch in MILLISECONDS since 1973
// is above it. The server only rejects epochs that are too SMALL, so a millisecond value sails
// through and plans a window in the far future -- a plausible-looking wrong clip. Refuse it here.
const MAX_EPOCH_SEC = 1e11

function epochSec(name: string, v: number): number {
  if (!Number.isFinite(v) || v >= MAX_EPOCH_SEC) {
    throw new RangeError(`${name} must be epoch SECONDS, got ${v}`)
  }
  return v
}

export function buildIdentifyRequest(
  job: IdentifyJob,
  clip: IdentifyClip,
  cfg: IdentifyConfig,
): { url: string; headers: Record<string, string>; form: FormData } {
  // Optional fields are OMITTED when absent, not sent as null. (The server reads both as absent.)
  const meta: Record<string, string | number> = {
    orderId: job.orderId,
    saleEpochSec: epochSec('saleEpochSec', job.saleEpochSec),
    clipStartEpochSec: epochSec('clipStartEpochSec', clip.startEpochSec),
    clipDurationSec: clip.durationSec,
  }
  if (job.roomId) meta.roomId = job.roomId
  if (job.auctionStartEpochSec != null) {
    meta.auctionStartEpochSec = epochSec('auctionStartEpochSec', job.auctionStartEpochSec)
  }
  if (job.prevBoundaryEpochSec != null) {
    meta.prevBoundaryEpochSec = epochSec('prevBoundaryEpochSec', job.prevBoundaryEpochSec)
  }
  const form = new FormData()
  form.append('meta', JSON.stringify(meta))
  form.append('audio', clip.blob, 'clip.webm')
  return {
    url: cfg.baseUrl.replace(/\/+$/, '') + IDENTIFY_PATH,
    // No Content-Type: fetch must set it itself, because the multipart boundary is in it.
    headers: { Authorization: `Bearer ${cfg.token}` },
    form,
  }
}

/**
 * What an identification attempt came to. `abandoned` is never produced here -- the queue makes it
 * when a show ends with the sale still waiting -- but it belongs to the same type so a row can hold
 * any of the four. Extra fields ride along; `status` and `reason` match the queue's own Outcome.
 */
export type IdentifyFailed = {
  status: 'failed'
  /** A stable code, never free text from the server: safe to store and to branch on. */
  reason: string
  /**
   * Whether sending the SAME request again could plausibly succeed. Always set by
   * `readIdentifyResponse`; ABSENT on a failure the queue manufactured when `run` threw (the network
   * was unreachable), which `isRetryable` reads as retryable. Optional so that failure still fits.
   */
  retryable?: boolean
  /** The server's own wording, kept only where it is ours and useful (a 400). */
  detail?: string
}
export type IdentifyAnswer =
  | { status: 'identified'; attempts?: number; escalated?: boolean; identity?: IdentifiedFields }
  | { status: 'skipped'; reason: string }
  | IdentifyFailed
export type IdentifyOutcome = IdentifyAnswer | { status: 'abandoned'; reason: string }

/** What the server says was identified, as it PERSISTED it — a human's earlier correction already
 *  wins there, so this is the name the host should read, not whatever the model last answered.
 *  Every field is optional on the wire: an older worker sends none, and a row must still settle. */
export type IdentifiedFields = { brand: string | null; item: string | null; color: string | null; size: string | null }

/** Reads the identity defensively. A non-object is ignored entirely; a field of the wrong type
 *  becomes null rather than reaching the screen as `7` or `[object Object]`. */
function readIdentity(v: unknown): IdentifiedFields | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  const str = (k: string): string | null => (typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : null)
  return { brand: str('brand'), item: str('item'), color: str('color'), size: str('size') }
}

/**
 * Should the app try again? Only a `failed` outcome can be retried, and only when `retryable` does
 * not say otherwise. A failed outcome WITHOUT the flag is one the queue manufactured because `run`
 * threw -- the network was unreachable (tailscale down, worker restarting) -- which is exactly the
 * case worth retrying.
 */
export function isRetryable(o: { status: string; reason?: string; retryable?: boolean }): boolean {
  return o.status === 'failed' && o.retryable !== false
}

const failed = (reason: string, retryable: boolean, detail?: string): IdentifyFailed =>
  detail === undefined ? { status: 'failed', reason, retryable } : { status: 'failed', reason, retryable, detail }

// 502 reasons the server hands out because it wrote them (live-identify-route LIVE_IDENTIFY_REASONS)
// for which asking again changes nothing: the cap stays reached, the order stays the wrong lot.
const TERMINAL_502 = new Set(['quota_reached', 'order-sale-mismatch'])

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/**
 * Read the server's answer. `status` is the HTTP status, `body` the parsed JSON (or whatever came
 * back -- a proxy's HTML page is fine). Never throws.
 *
 * Retry policy by status, decided by "could the SAME request succeed later?":
 *   200            settled (identified / skipped), or `bad_response` if unreadable -- not retried
 *   400, 413       terminal: the same bytes get the same answer
 *   401            terminal: the token is wrong; only a settings change helps
 *   403, 404, ...  other 4xx terminal, except 408/425/429 which are asking us to slow down
 *   503            retry: the worker is up but has no Gemini key yet -- a server-side fix lands mid-show
 *   502            by reason: terminal for quota_reached and order-sale-mismatch; retry for
 *                  order-not-found (the order may not have synced yet), identification_failed, and any
 *                  code not known yet
 *   5xx            retry
 * Every retry costs a model call on the server, so Task 5 must cap attempts.
 */
export function readIdentifyResponse(status: number, body: unknown): IdentifyAnswer {
  const b = asRecord(body)
  if (status === 200) {
    if (b?.status === 'identified') {
      const out: Extract<IdentifyAnswer, { status: 'identified' }> = { status: 'identified' }
      if (typeof b.attempts === 'number') out.attempts = b.attempts
      if (typeof b.escalated === 'boolean') out.escalated = b.escalated
      const identity = readIdentity((b as { identity?: unknown }).identity)
      if (identity) out.identity = identity
      return out
    }
    if (b?.status === 'skipped' && typeof b.reason === 'string') return { status: 'skipped', reason: b.reason }
    return failed('bad_response', false)
  }
  if (status === 401) return failed('bad_token', false)
  if (status === 413) return failed('audio_too_large', false)
  if (status === 503) return failed('live_identify_unavailable', true)
  if (status === 400) {
    return failed('bad_request', false, typeof b?.error === 'string' ? b.error : undefined)
  }
  if (status === 502) {
    const reason = typeof b?.reason === 'string' && b.reason ? b.reason : 'identification_failed'
    return failed(reason, !TERMINAL_502.has(reason))
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) return failed(`http_${status}`, true)
  return failed(`http_${status}`, false)
}
