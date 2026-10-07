// Clips that failed to identify, kept so that Retry still has the audio. WHY THIS EXISTS: a failed row's
// Retry used to re-cut the clip from the live buffer, which holds 5 minutes and is gone on a restart. So
// after a ten-minute connection blip in the middle of a show, the lots that failed during it could only
// be retried if they were still inside the buffer, and a row restored from disk could not be retried at
// all. Keeping the clip itself (the audio and the job that was sent with it, exactly) makes a retry the
// same request the first attempt made, whenever it is pressed.
//
// This file is the pure half: what is kept, what a file is called, what is read back from it (untrusted),
// and what is thrown away. The disk half is electron/identifyClips. Portable: no electron, no fs.
//
// Nothing here is a secret: the job is ids and times, the audio is a public live stream, and the token
// never reaches this layer. Only failed or abandoned clips are kept, they are bounded by count, size and
// age, and the folder is emptied when identification is switched off ("off means off" covers audio at rest).
import { hash53 } from './chatJournal'
import type { IdentifyJob } from './identifyClient'
import type { WireClip } from './identifySend'

export const KEPT_VERSION = 1
/** Clips kept: enough for every lot of a long outage, and the next one. */
export const MAX_KEPT_CLIPS = 60
/** Total audio kept on disk. */
export const MAX_KEPT_BYTES = 150 * 1024 * 1024
/** One clip larger than this is not kept (the server refuses a clip that size in any case). */
export const MAX_KEPT_CLIP_BYTES = 16 * 1024 * 1024
/** A clip this old is no longer worth retrying: the row it belongs to is long past. */
export const MAX_KEPT_AGE_MS = 7 * 24 * 60 * 60 * 1000

const MAX_ID = 120
// Every real epoch in SECONDS is below this; one in MILLISECONDS is above it (see identifyClient).
const MAX_EPOCH_SEC = 1e11

/** Does an outcome leave its clip on disk? A failure or an abandonment can be retried; a settled one cannot need it. */
export function shouldKeepClip(status: string): boolean {
  return status === 'failed' || status === 'abandoned'
}

/**
 * The file name stem for an order. The order id itself when it is plainly safe, else a hash of it: an id
 * is never trusted to be a name, so nothing in it can climb out of the folder or name a device. The first
 * letter differs between the two forms, so a safe id and a hashed one cannot collide.
 */
export function keptStem(orderId: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(orderId) ? `k${orderId}` : `h${hash53(orderId)}`
}

export type KeptClipFields = { startEpochSec: number; durationSec: number; leadInSec: number; truncated: boolean; gapSec: number }
/** `byteLength` is the audio file's length: a meta that does not match the file beside it (a crash between the two writes) is not trusted. */
export type KeptMeta = { v: 1; orderId: string; savedAtMs: number; byteLength: number; job: IdentifyJob; clip: KeptClipFields }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isEpoch = (v: unknown): v is number => isNum(v) && v < MAX_EPOCH_SEC
const optEpoch = (v: unknown): number | null | undefined => (v === null || v === undefined ? null : isEpoch(v) ? v : undefined)

/** The job rebuilt from known fields only, or null when it is not one. */
function readJob(raw: unknown): IdentifyJob | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.orderId !== 'string' || !o.orderId || o.orderId.length > MAX_ID) return null
  if (!isEpoch(o.saleEpochSec)) return null
  const start = optEpoch(o.auctionStartEpochSec)
  const prev = optEpoch(o.prevBoundaryEpochSec)
  if (start === undefined || prev === undefined) return null
  const roomId = typeof o.roomId === 'string' && o.roomId.length <= MAX_ID ? o.roomId : null
  return { orderId: o.orderId, roomId, saleEpochSec: o.saleEpochSec, auctionStartEpochSec: start, prevBoundaryEpochSec: prev }
}

function readClipFields(raw: unknown): KeptClipFields | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (!isEpoch(o.startEpochSec) || !isNum(o.durationSec) || o.durationSec < 0 || !isNum(o.leadInSec)) return null
  if (typeof o.truncated !== 'boolean') return null
  // A clip kept before the timeline check existed has no gap to report: 0, not a refusal.
  const gapSec = o.gapSec === undefined ? 0 : o.gapSec
  if (!isNum(gapSec)) return null
  return { startEpochSec: o.startEpochSec, durationSec: o.durationSec, leadInSec: o.leadInSec, truncated: o.truncated, gapSec }
}

/**
 * What to write beside the audio for a payload on its way to the server, or null when it is not worth (or
 * safe) keeping: anything malformed, no audio, or audio over the per-clip cap. The bytes are not part of it.
 */
export function metaFromWire(p: { job?: unknown; clip?: WireClip } | null | undefined, nowMs: number): KeptMeta | null {
  const job = readJob(p?.job)
  const clip = readClipFields(p?.clip)
  const bytes = p?.clip?.bytes
  if (!job || !clip || !(bytes instanceof Uint8Array)) return null
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_KEPT_CLIP_BYTES) return null
  return { v: KEPT_VERSION, orderId: job.orderId, savedAtMs: nowMs, byteLength: bytes.byteLength, job, clip }
}

/** The file's text, parsed: the meta it holds, or null for anything this version cannot trust. */
export function parseKeptMeta(raw: unknown): KeptMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.v !== KEPT_VERSION) return null
  if (typeof o.orderId !== 'string' || !isNum(o.savedAtMs) || !isNum(o.byteLength) || o.byteLength <= 0) return null
  const job = readJob(o.job)
  const clip = readClipFields(o.clip)
  if (!job || !clip || job.orderId !== o.orderId) return null
  return { v: KEPT_VERSION, orderId: o.orderId, savedAtMs: o.savedAtMs, byteLength: o.byteLength, job, clip }
}

/** The payload in the form that crosses IPC, from a kept file's meta and its bytes. */
export function wireFromKept(meta: KeptMeta, bytes: Uint8Array<ArrayBuffer>): { job: IdentifyJob; clip: WireClip } {
  return { job: meta.job, clip: { ...meta.clip, bytes } }
}

/**
 * Which kept clips to delete: anything past the age limit, then the OLDEST until the count and the total size
 * fit. Order of the input does not matter. The newest is never the one to go.
 */
export function chooseEvictions(
  entries: ReadonlyArray<{ stem: string; savedAtMs: number; bytes: number }>,
  nowMs: number,
): string[] {
  const out: string[] = []
  const live: Array<{ stem: string; savedAtMs: number; bytes: number }> = []
  for (const e of entries) {
    if (nowMs - e.savedAtMs > MAX_KEPT_AGE_MS) out.push(e.stem)
    else live.push(e)
  }
  live.sort((a, b) => b.savedAtMs - a.savedAtMs) // newest first
  let total = 0
  let kept = 0
  let full = false
  for (const e of live) {
    // Once a limit is hit, everything OLDER goes too: a small old clip never outlives a newer big one.
    if (full || kept + 1 > MAX_KEPT_CLIPS || total + e.bytes > MAX_KEPT_BYTES) {
      full = true
      out.push(e.stem)
    } else {
      kept++
      total += e.bytes
    }
  }
  return out
}
