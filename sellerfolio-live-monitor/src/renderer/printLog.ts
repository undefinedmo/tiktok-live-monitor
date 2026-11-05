// LANE E — the Print log panel that replaced the Thermal print queue: one line per finished job,
// newest first, "HH:MM:SS  #80 tag sent in 50 ms" (spoolMs from main's print-label reply),
// failures in red with the error on hover. Also remembers the last SALE label we tried to print
// — ok or failed, never a sample/test tag (core/printLogFormat nextPrintLast) — for
// Print last [F14] (lane A reads printLastLabel() and repaints on onPrintLastChange()).
//
// Observe only: renderer.ts calls onPrintResult() AFTER each print attempt, inside a try/catch.
// Nothing here runs on, awaits on, or changes the print path.
//
// Failures stay visible: the cap (core/printLogFormat — 200 lines) evicts good lines before
// failures, the head shows an "N failed" chip, and clicking it filters the log to failures only.
// The head's in-flight count ("N printing…") and the "Set printer" chip are kept current by
// renderQueue() inside the lane E fence in renderer.ts (it owns the facts they need).

import type { LabelData } from '../electron/label'
import { failedChipText, failedCount, nextPrintLast, pushEntry, toEntry, type PrintLogEntry } from '../core/printLogFormat'

export interface PrintResult {
  data: LabelData
  ok: boolean
  error?: string
  /** queue → spooler, from main. Absent when the IPC threw. */
  spoolMs?: number
  /** Date.now() when the result came back. */
  at: number
}

let entries: PrintLogEntry[] = []
let seq = 0
let failedOnly = false
let last: LabelData | undefined
const lastListeners: Array<(d: LabelData | undefined) => void> = []

let logEl: HTMLElement | null = null
let failedBtn: HTMLButtonElement | null = null

/** Called once by renderer.ts at startup. */
export function initPrintLog(): void {
  logEl = document.getElementById('printLog')
  failedBtn = document.getElementById('printLogFailed') as HTMLButtonElement | null
  failedBtn?.addEventListener('click', () => {
    failedOnly = !failedOnly
    render()
  })
  render()
}

/** Called by renderer.ts printLabel() after EVERY print attempt (auto, manual, sample, reprint). */
export function onPrintResult(r: PrintResult): void {
  const before = last
  last = nextPrintLast(last, r)
  if (last !== before) {
    for (const fn of lastListeners) { try { fn(last ? { ...last } : undefined) } catch { /* UI only */ } }
  }
  const entry = toEntry(r, ++seq)
  entries = pushEntry(entries, entry)
  // Common case: add just the new line, so the log's live region announces one line, not all.
  if (!failedOnly && logEl && logEl.querySelector('.plog-line')) {
    logEl.prepend(lineFor(entry))
    const keep = new Set(entries.map((e) => String(e.seq)))
    for (const row of Array.from(logEl.querySelectorAll<HTMLElement>('.plog-line'))) {
      if (!keep.has(row.dataset.seq ?? '')) row.remove()
    }
    renderHead()
    return
  }
  render()
}

/**
 * The label Print last [F14] reprints: the last sale label this session tried to print, whether
 * it printed or failed (so a failed #81 is what F14 recovers), never a sample/test tag. A copy.
 */
export function printLastLabel(): LabelData | undefined {
  return last ? { ...last } : undefined
}

/** Called with a copy of the new Print last label whenever it changes (lane A's button text). */
export function onPrintLastChange(fn: (d: LabelData | undefined) => void): void {
  lastListeners.push(fn)
}

/** Tests only. */
export function _resetPrintLogForTests(): void {
  entries = []; seq = 0; failedOnly = false; last = undefined
  lastListeners.length = 0
  logEl = null; failedBtn = null
}

function renderHead(): void {
  const failed = failedCount(entries)
  if (failed === 0) failedOnly = false

  if (failedBtn) {
    failedBtn.hidden = failed === 0
    failedBtn.textContent = failedChipText(failed)
    failedBtn.setAttribute('aria-pressed', failedOnly ? 'true' : 'false')
    failedBtn.title = failedOnly ? 'Showing failed tags only. Click to show all.' : 'Show only the tags that failed to print'
  }
}

function lineFor(e: PrintLogEntry): HTMLElement {
  const row = document.createElement('div')
  row.className = e.ok ? 'plog-line' : 'plog-line bad'
  row.dataset.seq = String(e.seq)
  const t = document.createElement('span')
  t.className = 'plog-t'
  t.textContent = e.time
  const msg = document.createElement('span')
  msg.textContent = e.text
  row.append(t, msg)
  if (e.error) {
    row.title = e.error
    row.setAttribute('aria-label', `${e.time} ${e.text}: ${e.error}`)
  }
  return row
}

function render(): void {
  renderHead()
  if (!logEl) return
  const shown = failedOnly ? entries.filter((e) => !e.ok) : entries
  if (!shown.length) {
    const empty = document.createElement('div')
    empty.className = 'plog-empty'
    empty.textContent = 'No labels yet'
    logEl.replaceChildren(empty)
    return
  }
  const frag = document.createDocumentFragment()
  for (const e of shown) frag.appendChild(lineFor(e))
  logEl.replaceChildren(frag)
}
