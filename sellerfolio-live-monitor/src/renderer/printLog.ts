// LANE E — the Print log panel that replaces the Thermal print queue: one line per finished job,
// newest first, "HH:MM:SS #80 tag sent in 50 ms" (spoolMs from main's print-label reply), failures
// in red. Also remembers the last label that printed OK, for Print last (lane A reads it).
//
// Lane E MOVES the queue (printQueue / renderQueue in renderer.ts, inside the "lane E" fences)
// out and removes the legacy #printQueue from index.html.
// Fills: index.html #printLog; CSS block "lane E".
// SCAFFOLD STUB: no-ops; lastPrintedLabel() is always undefined.

import type { LabelData } from '../electron/label'

export interface PrintResult {
  data: LabelData
  ok: boolean
  error?: string
  /** queue → spooler, from main. Absent when the IPC threw. */
  spoolMs?: number
  /** Date.now() when the result came back. */
  at: number
}

/** Called once by renderer.ts at startup. */
export function initPrintLog(): void {}

/** Called by renderer.ts printLabel() after EVERY print attempt (auto, manual, sample, reprint). */
export function onPrintResult(r: PrintResult): void {
  void r
}

/** The last label that printed successfully this session, for Print last [F14]. */
export function lastPrintedLabel(): LabelData | undefined {
  return undefined
}
