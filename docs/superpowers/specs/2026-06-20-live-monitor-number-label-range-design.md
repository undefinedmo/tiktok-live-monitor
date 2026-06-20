# Live Monitor — Print Number-Label Range

**Date:** 2026-06-20
**Status:** Approved, ready for implementation plan
**Area:** `desktop/` (SellerFolio Desktop v2) — `src/pages/LiveMonitor.tsx`

## Problem

Live Monitor can already print a single item-number label on demand via the "Quick
Print" panel ("Print Next" and "Print Custom"). Sellers prepping for a show want to
print a *batch* of sequential number labels (e.g. `#10` through `#50`) in one action,
without being connected to a stream.

## Goal

Add an always-available control in Live Monitor that opens a popup where the user
enters a **Start #** and **End #** and prints one item-number label per number in the
range. Available whether or not a stream is connected.

## Non-goals

- Generating a copyable text list of numbers (output is physical labels only).
- Changing what a single label contains — it reuses the existing label format
  (`itemNumber` only, empty `buyerUsername`).
- Any new Electron IPC — reuses `window.labelAPI.print` and `getPrinters`.

## Existing behavior this builds on

- `window.labelAPI.print({ itemNumber: String(n), buyerUsername: '' }, printerName)`
  prints one label (`desktop/electron/preload.ts`).
- `printers` / `selectedPrinter` are loaded on mount by `loadPrinters()`, independent of
  connection state — so range printing works while disconnected as long as a printer is
  configured.
- The **Connection Panel** at the top of `LiveMonitor.tsx` is the only section rendered
  when disconnected (stats, sales feed, and the printer/Quick-Print panel are all gated
  behind `isConnected`). The always-available button therefore lives in the Connection
  Panel action row.
- `addToPrintQueue` / `updateQueueStatus` track prints in the Print Queue panel (visible
  only when connected); `lastPrintedNumber` drives the "Print Next" button.

## Design

### 1. New component: `src/components/live-monitor/PrintRangeModal.tsx`

A self-contained modal, decoupled from Electron (the parent supplies the print action).

**Props**

```ts
interface PrintRangeModalProps {
  open: boolean;
  onClose: () => void;
  printers: string[];
  defaultPrinter: string;
  // Prints a single label; resolves on success, rejects on failure.
  onPrintItem: (itemNumber: number, printer: string) => Promise<void>;
  // Called after the run with the last number reached (for "Print Next").
  onComplete: (lastNumber: number) => void;
}
```

**Internal state:** `start`, `end` (string inputs), `printer` (defaults to
`defaultPrinter`), `running`, `cancelRequested`, and `progress`
(`{ current, total, printed, errors, done }`).

**UI**

- Two number inputs: **Start #** and **End #**.
- A **printer** `<select>` populated from `printers` (so the modal is usable when the
  printer panel is hidden, i.e. disconnected).
- A live count line: "Will print N labels" or an inline validation error.
- Primary **Print** button; **Cancel** (closes when idle, stops after current label
  when running).
- While running: a progress line ("Printing 12 of 41…"). When done: a summary
  ("Printed 41 · 0 errors") and a **Close** button.

**Behavior**

- Print is sequential: `for n = start..end`, `await onPrintItem(n, printer)`, update
  `progress`. A rejected `onPrintItem` increments `errors` and the loop continues.
- **Cancel** sets `cancelRequested`; the loop checks it before each label and stops.
- On finish (or cancel), call `onComplete(lastSuccessfullyPrintedNumber)`.

### 2. Pure helper: `buildRange(start, end)`

In a small module (e.g. `src/components/live-monitor/printRange.ts`) so it is
unit-testable independent of React.

```ts
type RangeResult =
  | { ok: true; numbers: number[] }
  | { ok: false; error: string };

function buildRange(start: number, end: number): RangeResult;
```

Rules:
- Both must be integers ≥ 1 → otherwise `{ ok: false, error }`.
- `start` ≤ `end` → otherwise error.
- Count (`end - start + 1`) must be ≤ **1000** → otherwise error (runaway guard).
- On success returns the inclusive ascending list `[start … end]`.

The modal uses `buildRange` for both the live count/validation display and to drive the
print loop.

### 3. `LiveMonitor.tsx` wiring

- New state: `rangeModalOpen: boolean`.
- A **"Number Labels"** button (icon: `ListOrdered`, already imported) added to the
  Connection Panel action row in **both** the `!isConnected` and connected branches, so
  it shows in either state. Disabled only while a range print is in flight is unnecessary
  — the modal owns the running state — so the button stays enabled.
- Render `<PrintRangeModal>` with:
  - `printers={printers}`, `defaultPrinter={selectedPrinter}`.
  - `onPrintItem={async (n, printer) => { const id = addToPrintQueue(String(n), '',
    \`Range #${n}\`, 'printing'); try { await window.labelAPI.print({ itemNumber:
    String(n), buyerUsername: '' }, printer); updateQueueStatus(id, 'printed'); } catch
    (e) { updateQueueStatus(id, 'error'); throw e; } }}`.
  - `onComplete={(last) => setLastPrintedNumber(last)}`.

This keeps the Electron/print-queue concerns in `LiveMonitor` and the range-driving
concerns in the modal.

## Error handling

- Invalid input (non-integer, start > end, count > 1000): inline error, Print disabled.
- No printer selected / none available: Print disabled with a hint.
- A failed individual label: counted in the summary; the run continues.
- Cancel: stops cleanly after the current label; partial result summarized.

## Testing

- **`buildRange`** (unit, TDD): valid ranges, single-number range (start == end),
  non-integers, start > end, count exactly 1000 (ok) and 1001 (error), values < 1.
- **`PrintRangeModal`** (component): renders count, disables Print on invalid input and
  when no printer, calls `onPrintItem` once per number in order, surfaces errors in the
  summary, Cancel halts the loop, `onComplete` receives the last printed number.

## Open questions

None. Button label "Number Labels" and the 1000 cap are approved.
