// Getting an operator's correction back to SellerFolio.
//
// An override used to live only in this station's identifications.jsonl, so the server kept the
// model's answer and every screen built on it carried a brand the operator already knew was wrong.
// The rules for sending it are here, where they are tested; the renderer only turns the handle.
//
// THE STORE IS THE QUEUE. There is no second file and no in-memory list of outstanding work: a row
// owes SellerFolio a correction when it says so on disk, which is what makes a correction typed
// during an outage — or before the app was last closed — go out on the next launch with nothing to
// replay by hand.
import type { IdentificationRow, RowFields } from './identifyStore'

/** The identity fields the server accepts. `summary` is in the row but is not one of them. */
export const CORRECTION_FIELDS = ['brand', 'item', 'color', 'size', 'retailPrice'] as const

/** Waits between attempts on a correction that could still succeed. Rising, and ending well short
 *  of a show's length: a station whose uplink comes back should not sit on a full backlog. */
export const CORRECTION_BACKOFF_MS: readonly number[] = [2000, 5000, 15_000, 60_000]

/** How long to let corrections settle before sending. Correcting four fields on one lot should be
 *  one request carrying all four, not four racing each other — and each field saves as the caret
 *  leaves it, so they arrive a second or two apart. */
export const CORRECTION_SETTLE_MS = 1500

/** How long a correction waits for an answer. Short: it is one small JSON body, and a station with
 *  a backlog should move on to the next lot rather than hold the queue on one. */
export const CORRECTION_TIMEOUT_MS = 15_000

/** Where a correction goes. The same base URL and token identification already uses — there is no
 *  second address and no second credential to configure. */
export const CORRECTION_PATH = '/api/capture/live-correct'

/**
 * The request for one correction. Built here, tested here: the renderer never assembles what goes
 * over the network, for the same reason it never assembles an identification's window.
 */
export function buildCorrectionRequest(
  cfg: { baseUrl: string; token: string },
  orderId: string,
  patch: Record<string, string>,
): { url: string; headers: Record<string, string>; body: string } {
  return {
    url: cfg.baseUrl.replace(/\/+$/, '') + CORRECTION_PATH,
    headers: { Authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ orderId, fields: patch }),
  }
}

export type CorrectionOutcome =
  /** SellerFolio has it. */
  | { kind: 'sent' }
  /** A fact about this row, not about the network: never retried, and the reason is shown. */
  | { kind: 'refused'; note: string }
  /** Could succeed later — keep it queued. */
  | { kind: 'retry' }
  /** Nothing will get through until a person changes something. Stop, and say so. */
  | { kind: 'stop'; note: string }

/**
 * The fields of a corrected row that are worth sending, or null when there are none.
 *
 * A BLANKED field is carried, not dropped. "The model said Phoenix and the colour was never said"
 * is a real correction, and an empty box is how the app records it. What is left out is a field the
 * row never held, because the server merges: a patch naming only `brand` must leave `item` as the
 * server already has it.
 */
export function correctionPatch(row: IdentificationRow): Record<string, string> | null {
  const f: RowFields | undefined = row.fields
  if (!f) return null
  const patch: Record<string, string> = {}
  for (const key of CORRECTION_FIELDS) {
    const v = f[key]
    if (typeof v === 'string') patch[key] = v
  }
  return Object.keys(patch).length ? patch : null
}

/**
 * The rows that still owe SellerFolio a correction, oldest sale first.
 *
 * Oldest first so a backlog from an earlier show drains in the order the lots sold. A row is done
 * with when it has a `syncedAt` (accepted) or a `syncNote` (refused for a reason retrying cannot
 * change) — the two states that must survive a restart, which is why they live on the row.
 */
export function pendingCorrections(rows: readonly IdentificationRow[]): IdentificationRow[] {
  return rows
    .filter((r) => r.edited === true && !r.syncedAt && !r.syncNote && !!r.orderId && correctionPatch(r) !== null)
    .slice()
    .sort((a, b) => a.atEpochSec - b.atEpochSec)
}

/**
 * What to do about an answer. `status` is null when the request got none at all (the uplink dropped,
 * the worker is not listening).
 *
 * Anything unrecognised is RETRIED rather than treated as sent. Reading an unexpected status as
 * success would mark a correction as landed when nothing was written — the one failure here that
 * destroys work silently, which is the whole class of bug this feature exists to close.
 */
export function readCorrectionOutcome(status: number | null): CorrectionOutcome {
  if (status === null) return { kind: 'retry' }
  if (status >= 200 && status < 300) return { kind: 'sent' }
  if (status === 404) return { kind: 'refused', note: 'SellerFolio has no record of this lot' }
  if (status === 400) return { kind: 'refused', note: 'SellerFolio would not accept this correction' }
  if (status === 401 || status === 403) return { kind: 'stop', note: 'the capture token was refused — check Settings' }
  return { kind: 'retry' }
}
