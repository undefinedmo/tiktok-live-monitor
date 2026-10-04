// Pure pieces of the journal → SellerFolio upload. The journal is the outbox: each file is
// read forward from a saved byte offset, complete lines are sent in batches, and the offset
// only moves once the server has accepted them. Every line carries a stable id and the
// server upserts on it, so a batch re-sent after a crash or a timeout is harmless.
//
// Portable: no electron/DOM, no fs, no network.

export interface Batch {
  /** Complete, valid JSON lines, ready to be joined into an array body. */
  lines: string[]
  /** Bytes to advance the offset by — through the newline of the last line LOOKED AT. */
  consumed: number
  /** Lines that were complete but not valid JSON objects (a torn write); skipped, not sent. */
  skipped: number
}

/**
 * Take up to `maxLines` complete lines from `chunk`, which was read from a journal file
 * starting at the saved offset. A trailing partial line (the writer is mid-append, or the
 * read window ended inside a line) is left for the next read: `consumed` stops before it.
 */
export function takeLines(chunk: Uint8Array, maxLines: number): Batch {
  const lines: string[] = []
  let consumed = 0
  let skipped = 0
  let start = 0
  const dec = new TextDecoder('utf-8')
  while (lines.length < maxLines) {
    const nl = chunk.indexOf(10, start)
    if (nl === -1) break
    const text = dec.decode(chunk.subarray(start, nl)).trim()
    start = nl + 1
    consumed = start
    if (!text) continue
    if (isJsonObject(text)) lines.push(text)
    else skipped++
  }
  return { lines, consumed, skipped }
}

function isJsonObject(text: string): boolean {
  if (text[0] !== '{') return false
  try {
    const v: unknown = JSON.parse(text)
    return !!v && typeof v === 'object' && !Array.isArray(v)
  } catch {
    return false
  }
}

/** The request body for a batch — built by joining, so lines are never re-serialized. */
export function batchBody(deviceId: string, lines: string[]): string {
  return `{"device":${JSON.stringify(deviceId)},"events":[${lines.join(',')}]}`
}

const BASE_MS = 5_000
const MAX_MS = 5 * 60_000
/** Wait before retrying after `failures` consecutive failed uploads: 5s, 10s, 20s … 5 min. */
export function backoffMs(failures: number): number {
  if (failures <= 0) return 0
  return Math.min(MAX_MS, BASE_MS * 2 ** Math.min(failures - 1, 10))
}

export type UploadVerdict = 'ok' | 'retry' | 'auth' | 'rejected'
/**
 * What an HTTP status means for the batch.
 *   ok       — accepted; advance the offset
 *   retry    — server/network trouble; keep the offset, back off
 *   auth     — the token is wrong or revoked; stop until the settings change
 *   rejected — the server refuses this batch's shape (4xx); retrying the same bytes cannot
 *              succeed, so back off hard and surface it rather than spin
 */
export function verdictFor(status: number): UploadVerdict {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 401 || status === 403) return 'auth'
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retry'
  if (status >= 400) return 'rejected'
  return 'retry'
}
