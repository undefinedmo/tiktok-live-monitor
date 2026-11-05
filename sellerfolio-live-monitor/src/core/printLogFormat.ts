// Print log formatting (lane E) — pure, no DOM. The renderer's printLog.ts draws what this returns.
//
// One line per finished print job, newest first:
//   "14:03:07  #78 Jo tag sent in 51 ms"   OK, main reported the spool time
//   "14:03:09  #81 Jo printed"             OK, no spool time (shouldn't happen, but never lie about it)
//   "14:03:12  #82 Ann failed to print"    failure; the error text rides along for the hover
//
// The cap: the log keeps the newest PRINT_LOG_CAP (200) lines. When it is full, the OLDEST
// SUCCESSFUL line goes first, so a failure is never pushed out by later good prints — failures
// only leave once there are more than PRINT_LOG_FAILED_CAP (50) of them, oldest first. A failed
// tag is a physical label someone still has to reprint; it must not scroll away during a busy show.

export const PRINT_LOG_CAP = 200
export const PRINT_LOG_FAILED_CAP = 50

/** The label fields the log reads (a subset of electron/label's LabelData). */
export interface PrintLogLabel {
  itemNumber?: string
  buyer?: string
  /** The QR payload (core/labelCode). Only read to recognise the designer's sample label. */
  code?: string
}

export interface PrintLogInput {
  data: PrintLogLabel
  ok: boolean
  error?: string
  spoolMs?: number
  at: number
}

export interface PrintLogEntry {
  /** Increasing per entry; stable key for the renderer. */
  seq: number
  at: number
  ok: boolean
  /** "14:03:07" — local clock. */
  time: string
  /** "#78 Jo tag sent in 51 ms" — without the time. */
  text: string
  /** Failure detail for the hover; absent on OK lines. */
  error?: string
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local wall-clock HH:MM:SS (24 h), the same clock the operator's PC shows. */
export function clockTime(at: number): string {
  const d = new Date(at)
  if (!Number.isFinite(d.getTime())) return '--:--:--'
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** "#78 Jo", "#78", "Jo", or "Tag" when the label carries neither. */
export function labelName(d: PrintLogLabel): string {
  const num = String(d.itemNumber ?? '').trim().replace(/^#/, '')
  const buyer = String(d.buyer ?? '').trim()
  const parts = [num ? `#${num}` : '', buyer].filter(Boolean)
  return parts.length ? parts.join(' ') : 'Tag'
}

/** "51 ms" under 10 s, "12.3 s" above (a stuck spooler). Undefined for a missing/invalid value. */
export function spoolText(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 10_000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

export function printLogText(r: PrintLogInput): string {
  const name = labelName(r.data)
  if (!r.ok) return `${name} failed to print`
  const spool = spoolText(r.spoolMs)
  return spool ? `${name} tag sent in ${spool}` : `${name} printed`
}

/** One-line error for the hover; a generic one when main gave none. */
export function errorText(error: string | undefined): string {
  const e = String(error ?? '').replace(/\s+/g, ' ').trim()
  return e || 'The printer did not say why.'
}

export function toEntry(r: PrintLogInput, seq: number): PrintLogEntry {
  const entry: PrintLogEntry = { seq, at: r.at, ok: r.ok, time: clockTime(r.at), text: printLogText(r) }
  if (!r.ok) entry.error = errorText(r.error)
  return entry
}

/**
 * Prepend `entry` to the newest-first `list` and apply the cap (see the header). Returns a new
 * array; never mutates `list`.
 */
export function pushEntry(
  list: readonly PrintLogEntry[],
  entry: PrintLogEntry,
  cap = PRINT_LOG_CAP,
  failedCap = PRINT_LOG_FAILED_CAP,
): PrintLogEntry[] {
  const all = [entry, ...list]
  // Too many failures: keep only the newest `failedCap` of them.
  let failedKept = 0
  const out = all.filter((e) => e.ok || ++failedKept <= failedCap)
  // Over the cap: drop the oldest OK lines first, then (only if the log is all failures) the oldest.
  let excess = out.length - cap
  if (excess <= 0) return out
  const trimmed: PrintLogEntry[] = []
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i] as PrintLogEntry
    if (excess > 0 && e.ok) { excess--; continue }
    trimmed.push(e)
  }
  trimmed.reverse()
  if (trimmed.length > cap) trimmed.length = cap
  return trimmed
}

export function failedCount(list: readonly PrintLogEntry[]): number {
  return list.reduce((n, e) => n + (e.ok ? 0 : 1), 0)
}

/** "1 failed", "3 failed" — the head chip. */
export function failedChipText(n: number): string {
  return `${n} failed`
}

// ── Print last [F14] ─────────────────────────────────────────────────────────
//
// Print last is the recovery button during a show: #81 jams or errors, the host presses F14,
// and #81 must come out. So "last" is the last label we TRIED to print — set on every result,
// ok or failed — never "the last one that printed OK" (that reprinted #80 and left #81 with no
// label). Test / sample tags are not lots and never become "last": a mid-show "Print test tag"
// must not turn F14 into a "#141 Sarah D." sample.

/**
 * The QR code on the designer's sample label (renderer/designer.ts sampleLabelData():
 * labelCode('1732451642461557731')). The sample's title and buyer are editable by the
 * operator, so they cannot identify it; this code is fixed. A test pins the two together.
 */
export const SAMPLE_LABEL_CODE = 'SF1:T:1732451642461557731'

/** True for a designer / Settings test tag (the sample sale), which Print last must ignore. */
export function isSampleLabel(d: PrintLogLabel | undefined): boolean {
  return !!d && d.code === SAMPLE_LABEL_CODE
}

/**
 * What Print last holds after a print result: the result's label (a copy) whether it printed
 * or failed, unless it is a sample/test tag, which leaves `prev` untouched.
 */
export function nextPrintLast<T extends PrintLogLabel>(prev: T | undefined, r: { data: T; ok: boolean }): T | undefined {
  if (!r || !r.data || isSampleLabel(r.data)) return prev
  return { ...r.data }
}

/** The button text: "Print last #81", "Print last" when nothing (or no lot number) is held. */
export function printLastText(d: PrintLogLabel | undefined): string {
  const num = String(d?.itemNumber ?? '').trim().replace(/^#/, '')
  if (!num) return 'Print last'
  return `Print last #${num.length > 8 ? num.slice(0, 7) + '…' : num}`
}
