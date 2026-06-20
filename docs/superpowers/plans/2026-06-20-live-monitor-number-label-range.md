# Live Monitor — Print Number-Label Range Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-available "Number Labels" button to Live Monitor that opens a popup to print one item-number label for every number in a Start–End range.

**Architecture:** All testable logic (range building + validation, and the sequential print loop with cancel/progress) lives in a pure module `printRange.ts`. A thin React component `PrintRangeModal.tsx` wraps it. `LiveMonitor.tsx` adds the button to its always-visible Connection Panel and wires the modal's print callback to the existing `window.labelAPI.print` + print-queue helpers.

**Tech Stack:** React 19 + TypeScript + Tailwind CSS, Vitest 2 (pure-logic tests; the repo has no DOM/component test harness — do not add one), Electron IPC via `window.labelAPI`.

## Global Constraints

- Work happens in the `desktop/` repo, which is its **own git repo** — run all `git` commands from `desktop/` (the spec doc was already committed in the platform-root repo; do not touch it here).
- Reuse existing primitives only — **no new npm dependencies**, **no new Electron IPC**. Single-label printing is `window.labelAPI.print({ itemNumber: String(n), buyerUsername: '' }, printerName)`.
- Match existing UI tokens used across the app: `bg-bg-secondary`, `bg-bg-primary`, `bg-bg-tertiary`, `border-border-subtle`, `border-border-medium`, `text-text-primary`, `text-text-secondary`, `text-text-tertiary`, `bg-accent`, `text-accent`. Modal shell mirrors `src/components/PayoutModal.tsx`: `fixed inset-0 bg-black/50 flex items-center justify-center z-50` backdrop containing a `bg-bg-secondary border border-border-medium rounded-xl p-6` card.
- Item numbers are integers ≥ 1; `start ≤ end`; inclusive range count capped at **1000**.
- Tests are pure-logic Vitest files, co-located next to source (pattern: `src/hooks/useScanSounds.test.ts`). Run with `npm test`.

---

### Task 1: `buildRange` — range building + validation (pure, TDD)

**Files:**
- Create: `desktop/src/components/live-monitor/printRange.ts`
- Test: `desktop/src/components/live-monitor/printRange.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  type RangeResult =
    | { ok: true; numbers: number[] }
    | { ok: false; error: string };
  function buildRange(start: number, end: number): RangeResult;
  export const MAX_RANGE = 1000;
  ```

- [ ] **Step 1: Write the failing test**

Create `desktop/src/components/live-monitor/printRange.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildRange, MAX_RANGE } from './printRange';

describe('buildRange', () => {
  it('returns an inclusive ascending list for a valid range', () => {
    const r = buildRange(10, 12);
    expect(r).toEqual({ ok: true, numbers: [10, 11, 12] });
  });

  it('supports a single-number range', () => {
    expect(buildRange(5, 5)).toEqual({ ok: true, numbers: [5] });
  });

  it('rejects start greater than end', () => {
    const r = buildRange(9, 2);
    expect(r.ok).toBe(false);
  });

  it('rejects non-integer input', () => {
    expect(buildRange(1.5, 4).ok).toBe(false);
    expect(buildRange(1, 4.2).ok).toBe(false);
  });

  it('rejects NaN input', () => {
    expect(buildRange(NaN, 4).ok).toBe(false);
  });

  it('rejects numbers below 1', () => {
    expect(buildRange(0, 4).ok).toBe(false);
    expect(buildRange(-3, 4).ok).toBe(false);
  });

  it('allows a count of exactly MAX_RANGE', () => {
    const r = buildRange(1, MAX_RANGE);
    expect(r.ok).toBe(true);
    expect(r.ok && r.numbers.length).toBe(MAX_RANGE);
  });

  it('rejects a count over MAX_RANGE', () => {
    expect(buildRange(1, MAX_RANGE + 1).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && npm test -- printRange`
Expected: FAIL — cannot resolve `./printRange` / `buildRange is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `desktop/src/components/live-monitor/printRange.ts`:

```ts
export const MAX_RANGE = 1000;

export type RangeResult =
  | { ok: true; numbers: number[] }
  | { ok: false; error: string };

export function buildRange(start: number, end: number): RangeResult {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { ok: false, error: 'Enter whole numbers for start and end.' };
  }
  if (start < 1 || end < 1) {
    return { ok: false, error: 'Numbers must be 1 or greater.' };
  }
  if (start > end) {
    return { ok: false, error: 'Start must be less than or equal to end.' };
  }
  const count = end - start + 1;
  if (count > MAX_RANGE) {
    return { ok: false, error: `Range is too large (max ${MAX_RANGE} labels).` };
  }
  const numbers: number[] = [];
  for (let n = start; n <= end; n++) numbers.push(n);
  return { ok: true, numbers };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && npm test -- printRange`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
cd desktop
git add src/components/live-monitor/printRange.ts src/components/live-monitor/printRange.test.ts
git commit -m "feat(live-monitor): buildRange helper for number-label ranges"
```

---

### Task 2: `runPrintRange` — sequential print loop with cancel + progress (pure, TDD)

**Files:**
- Modify: `desktop/src/components/live-monitor/printRange.ts` (append)
- Test: `desktop/src/components/live-monitor/printRange.test.ts` (append)

**Interfaces:**
- Consumes: nothing from Task 1 at runtime (same file).
- Produces:
  ```ts
  interface PrintRangeProgress { current: number; printed: number; errors: number; total: number }
  interface RunPrintRangeArgs {
    numbers: number[];
    printer: string;
    printItem: (itemNumber: number, printer: string) => Promise<void>;
    shouldCancel: () => boolean;
    onProgress: (p: PrintRangeProgress) => void;
  }
  interface PrintRangeSummary { printed: number; errors: number; lastPrinted: number | null; cancelled: boolean }
  function runPrintRange(args: RunPrintRangeArgs): Promise<PrintRangeSummary>;
  ```

- [ ] **Step 1: Write the failing test**

Append to `desktop/src/components/live-monitor/printRange.test.ts`:

```ts
import { runPrintRange } from './printRange';

describe('runPrintRange', () => {
  const noCancel = () => false;
  const noop = () => {};

  it('prints every number in order', async () => {
    const calls: number[] = [];
    const summary = await runPrintRange({
      numbers: [3, 4, 5],
      printer: 'P1',
      printItem: async (n) => { calls.push(n); },
      shouldCancel: noCancel,
      onProgress: noop,
    });
    expect(calls).toEqual([3, 4, 5]);
    expect(summary).toEqual({ printed: 3, errors: 1 - 1, lastPrinted: 5, cancelled: false });
  });

  it('counts errors and keeps going', async () => {
    const summary = await runPrintRange({
      numbers: [1, 2, 3],
      printer: 'P1',
      printItem: async (n) => { if (n === 2) throw new Error('boom'); },
      shouldCancel: noCancel,
      onProgress: noop,
    });
    expect(summary.printed).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.lastPrinted).toBe(3);
  });

  it('lastPrinted is null when nothing succeeds', async () => {
    const summary = await runPrintRange({
      numbers: [1, 2],
      printer: 'P1',
      printItem: async () => { throw new Error('boom'); },
      shouldCancel: noCancel,
      onProgress: noop,
    });
    expect(summary.lastPrinted).toBeNull();
    expect(summary.errors).toBe(2);
  });

  it('stops early when cancel is requested', async () => {
    const calls: number[] = [];
    let printed = 0;
    const summary = await runPrintRange({
      numbers: [1, 2, 3, 4],
      printer: 'P1',
      printItem: async (n) => { calls.push(n); printed++; },
      shouldCancel: () => printed >= 2, // cancel after 2 prints
      onProgress: noop,
    });
    expect(calls).toEqual([1, 2]);
    expect(summary.cancelled).toBe(true);
    expect(summary.printed).toBe(2);
    expect(summary.lastPrinted).toBe(2);
  });

  it('reports progress before each print', async () => {
    const seen: number[] = [];
    await runPrintRange({
      numbers: [7, 8],
      printer: 'P1',
      printItem: async () => {},
      shouldCancel: noCancel,
      onProgress: (p) => seen.push(p.current),
    });
    expect(seen).toEqual([7, 8]);
  });
});
```

> Note: `errors: 1 - 1` is written to read as "zero errors" while making the assertion's intent obvious; it evaluates to `0`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && npm test -- printRange`
Expected: FAIL — `runPrintRange is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `desktop/src/components/live-monitor/printRange.ts`:

```ts
export interface PrintRangeProgress {
  current: number;
  printed: number;
  errors: number;
  total: number;
}

export interface RunPrintRangeArgs {
  numbers: number[];
  printer: string;
  printItem: (itemNumber: number, printer: string) => Promise<void>;
  shouldCancel: () => boolean;
  onProgress: (p: PrintRangeProgress) => void;
}

export interface PrintRangeSummary {
  printed: number;
  errors: number;
  lastPrinted: number | null;
  cancelled: boolean;
}

export async function runPrintRange(args: RunPrintRangeArgs): Promise<PrintRangeSummary> {
  const { numbers, printer, printItem, shouldCancel, onProgress } = args;
  const total = numbers.length;
  let printed = 0;
  let errors = 0;
  let lastPrinted: number | null = null;
  let cancelled = false;

  for (const n of numbers) {
    if (shouldCancel()) {
      cancelled = true;
      break;
    }
    onProgress({ current: n, printed, errors, total });
    try {
      await printItem(n, printer);
      printed += 1;
      lastPrinted = n;
    } catch {
      errors += 1;
    }
  }

  return { printed, errors, lastPrinted, cancelled };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && npm test -- printRange`
Expected: PASS (13 tests total).

- [ ] **Step 5: Commit**

```bash
cd desktop
git add src/components/live-monitor/printRange.ts src/components/live-monitor/printRange.test.ts
git commit -m "feat(live-monitor): sequential runPrintRange with cancel + progress"
```

---

### Task 3: `PrintRangeModal` component

**Files:**
- Create: `desktop/src/components/live-monitor/PrintRangeModal.tsx`

**Interfaces:**
- Consumes (from Task 1 & 2): `buildRange`, `runPrintRange`, `PrintRangeProgress`, `PrintRangeSummary` from `./printRange`.
- Produces (default export, consumed by Task 4):
  ```ts
  interface PrintRangeModalProps {
    onClose: () => void;
    printers: string[];
    defaultPrinter: string;
    onPrintItem: (itemNumber: number, printer: string) => Promise<void>;
    onComplete: (lastNumber: number) => void;
  }
  export default function PrintRangeModal(props: PrintRangeModalProps): JSX.Element;
  ```
  (No `open` prop — parent gates rendering with `{rangeModalOpen && ...}`, matching `PayoutModal` convention.)

- [ ] **Step 1: Write the component**

Create `desktop/src/components/live-monitor/PrintRangeModal.tsx`:

```tsx
import { useState, useRef } from 'react';
import { ListOrdered, Loader2, X } from 'lucide-react';
import {
  buildRange,
  runPrintRange,
  type PrintRangeProgress,
  type PrintRangeSummary,
} from './printRange';

interface PrintRangeModalProps {
  onClose: () => void;
  printers: string[];
  defaultPrinter: string;
  onPrintItem: (itemNumber: number, printer: string) => Promise<void>;
  onComplete: (lastNumber: number) => void;
}

export default function PrintRangeModal({
  onClose,
  printers,
  defaultPrinter,
  onPrintItem,
  onComplete,
}: PrintRangeModalProps) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [printer, setPrinter] = useState(defaultPrinter);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<PrintRangeProgress | null>(null);
  const [summary, setSummary] = useState<PrintRangeSummary | null>(null);
  const cancelRef = useRef(false);

  const range = buildRange(parseInt(start, 10), parseInt(end, 10));
  const hasPrinter = printer !== '' && printers.includes(printer);
  const canPrint = range.ok && hasPrinter && !running;

  const handlePrint = async () => {
    if (!range.ok || !hasPrinter) return;
    cancelRef.current = false;
    setRunning(true);
    setSummary(null);
    const result = await runPrintRange({
      numbers: range.numbers,
      printer,
      printItem: onPrintItem,
      shouldCancel: () => cancelRef.current,
      onProgress: setProgress,
    });
    setRunning(false);
    setProgress(null);
    setSummary(result);
    if (result.lastPrinted != null) onComplete(result.lastPrinted);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-bg-secondary border border-border-medium rounded-xl p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <ListOrdered className="w-5 h-5 text-accent" />
            Number Labels
          </h2>
          <button
            onClick={onClose}
            disabled={running}
            className="p-1 text-text-tertiary hover:text-text-primary rounded disabled:opacity-50"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-text-secondary mb-4">
          Print one item-number label for each number in the range.
        </p>

        {summary ? (
          <div className="space-y-4">
            <div className="text-sm text-text-primary">
              Printed <strong>{summary.printed}</strong> · {summary.errors} error
              {summary.errors === 1 ? '' : 's'}
              {summary.cancelled ? ' · cancelled' : ''}
            </div>
            <button
              onClick={onClose}
              className="w-full px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs text-text-secondary mb-1">Start #</label>
                <input
                  type="number"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  disabled={running}
                  placeholder="1"
                  className="w-full px-3 py-2 bg-bg-primary border border-border-subtle rounded text-text-primary placeholder:text-text-tertiary focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none disabled:opacity-50"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-text-secondary mb-1">End #</label>
                <input
                  type="number"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  disabled={running}
                  placeholder="50"
                  className="w-full px-3 py-2 bg-bg-primary border border-border-subtle rounded text-text-primary placeholder:text-text-tertiary focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none disabled:opacity-50"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-text-secondary mb-1">Printer</label>
              <select
                value={printer}
                onChange={(e) => setPrinter(e.target.value)}
                disabled={running}
                className="w-full px-3 py-2 bg-bg-primary border border-border-subtle rounded text-text-primary disabled:opacity-50"
              >
                {printers.length === 0 ? (
                  <option value="">No printers found</option>
                ) : (
                  printers.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))
                )}
              </select>
            </div>

            {start !== '' && end !== '' &&
              (range.ok ? (
                <p className="text-sm text-text-secondary">
                  Will print {range.numbers.length} label{range.numbers.length === 1 ? '' : 's'}.
                </p>
              ) : (
                <p className="text-sm text-red-500">{range.error}</p>
              ))}
            {!hasPrinter && <p className="text-sm text-red-500">Select a printer to print.</p>}

            {running && progress && (
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <Loader2 className="w-4 h-4 animate-spin" />
                Printing {progress.printed + progress.errors + 1} of {progress.total} (#
                {progress.current})…
              </div>
            )}

            <div className="flex gap-2 pt-1">
              {running ? (
                <button
                  onClick={() => {
                    cancelRef.current = true;
                  }}
                  className="flex-1 px-4 py-2 bg-bg-tertiary border border-border-subtle text-text-primary rounded-lg hover:bg-bg-primary transition-colors"
                >
                  Cancel
                </button>
              ) : (
                <button
                  onClick={handlePrint}
                  disabled={!canPrint}
                  className="flex-1 px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Print
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it typechecks and lints**

Run: `cd desktop && npm run typecheck && npm run lint`
Expected: no errors referencing `PrintRangeModal.tsx` or `printRange.ts`.

> There is no component/DOM test harness in this repo (no jsdom, no @testing-library). The modal's logic is already covered by the `buildRange`/`runPrintRange` unit tests in Tasks 1–2; the JSX is verified by typecheck + lint here and manual QA in Task 4.

- [ ] **Step 3: Commit**

```bash
cd desktop
git add src/components/live-monitor/PrintRangeModal.tsx
git commit -m "feat(live-monitor): PrintRangeModal popup for number-label ranges"
```

---

### Task 4: Wire the button + modal into `LiveMonitor`

**Files:**
- Modify: `desktop/src/pages/LiveMonitor.tsx`

**Interfaces:**
- Consumes (from Task 3): `PrintRangeModal` default export.
- Consumes (existing in `LiveMonitor.tsx`): `printers`, `selectedPrinter`, `setLastPrintedNumber`, `addToPrintQueue`, `updateQueueStatus`, `window.labelAPI.print`, `ListOrdered` (already imported, line 25).

- [ ] **Step 1: Add the modal import**

In `desktop/src/pages/LiveMonitor.tsx`, add after the buyer-stats import block near the top (around line 2):

```tsx
import PrintRangeModal from '../components/live-monitor/PrintRangeModal';
```

- [ ] **Step 2: Add modal state + the per-item print handler**

Inside the component, next to the other printing state (after `const [printQueue, setPrintQueue] = ...` around line 144), add:

```tsx
const [rangeModalOpen, setRangeModalOpen] = useState(false);
```

Then, next to `handlePrintCustom` (after it, around line 596), add the range print handler:

```tsx
// Print a single label as part of a range; mirrors handlePrintCustom but
// reuses the print queue so range prints show up when connected.
const handleRangePrintItem = useCallback(
  async (itemNumber: number, printer: string) => {
    const queueId = addToPrintQueue(String(itemNumber), '', `Range #${itemNumber}`, 'printing');
    try {
      await window.labelAPI.print(
        { itemNumber: String(itemNumber), buyerUsername: '' },
        printer,
      );
      updateQueueStatus(queueId, 'printed');
    } catch (err) {
      updateQueueStatus(queueId, 'error');
      throw err; // let runPrintRange count it as an error
    }
  },
  [addToPrintQueue, updateQueueStatus],
);
```

> `useCallback`, `useState` are already imported (line 1). `addToPrintQueue` and `updateQueueStatus` are existing `useCallback`s in this component.

- [ ] **Step 3: Add the always-visible button to the Connection Panel**

In the Connection Panel header `<div className="flex items-center gap-4">` (starts line 624), insert the button as a sibling immediately **before** the `{!isConnected ? (` ternary (i.e., right after the closing `</div>` of the `flex-1` title block, around line 646–648). The button renders in both connected and disconnected states because it sits outside the ternary:

```tsx
<button
  onClick={() => setRangeModalOpen(true)}
  className="flex items-center gap-2 px-4 py-2 bg-bg-tertiary border border-border-subtle text-text-primary rounded-lg hover:bg-bg-primary transition-colors"
  title="Print a range of item-number labels"
>
  <ListOrdered className="w-4 h-4" />
  Number Labels
</button>
```

The surrounding structure should read:

```tsx
          <div className="flex-1">
            {/* ...existing title/subtitle... */}
          </div>

          <button
            onClick={() => setRangeModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-bg-tertiary border border-border-subtle text-text-primary rounded-lg hover:bg-bg-primary transition-colors"
            title="Print a range of item-number labels"
          >
            <ListOrdered className="w-4 h-4" />
            Number Labels
          </button>

          {!isConnected ? (
            {/* ...existing input + Connect... */}
          ) : (
            {/* ...existing refresh + Stop... */}
          )}
```

- [ ] **Step 4: Render the modal**

Just before the final closing `</div>` of the component's top-level returned element (the `<div className="space-y-4">` opened at line 621), add:

```tsx
{rangeModalOpen && (
  <PrintRangeModal
    onClose={() => setRangeModalOpen(false)}
    printers={printers}
    defaultPrinter={selectedPrinter}
    onPrintItem={handleRangePrintItem}
    onComplete={(last) => setLastPrintedNumber(last)}
  />
)}
```

- [ ] **Step 5: Verify typecheck, lint, and full test suite**

Run: `cd desktop && npm run typecheck && npm run lint && npm test`
Expected: all pass; no errors referencing `LiveMonitor.tsx`, `PrintRangeModal.tsx`, or `printRange.ts`.

- [ ] **Step 6: Manual QA (dev app)**

Run: `cd desktop && npm run dev`
Verify:
1. On the Live Monitor page **while disconnected**, the "Number Labels" button is visible and enabled.
2. Click it → popup opens with Start #, End #, Printer select.
3. Enter e.g. Start 1, End 3 → "Will print 3 labels." appears; Print enabled (with a printer selected).
4. Invalid input (e.g. Start 9, End 2) → red error, Print disabled.
5. Click Print → progress line shows, 3 labels print, summary "Printed 3 · 0 errors", Close works.
6. Connect to a show → button still present; a range print also appears in the Print Queue panel.

- [ ] **Step 7: Commit**

```bash
cd desktop
git add src/pages/LiveMonitor.tsx
git commit -m "feat(live-monitor): always-on Number Labels button opens print-range popup"
```

---

## Self-Review

**Spec coverage:**
- Always-available button in Connection Panel → Task 4 Step 3 (rendered outside the `isConnected` ternary). ✓
- Popup with Start/End + printer select → Task 3. ✓
- Prints one item-number label per number, reusing `window.labelAPI.print` → Task 4 Step 2 `handleRangePrintItem`. ✓
- Works while disconnected (printer loaded on mount; modal carries its own printer select) → Task 3 (`printers`/`defaultPrinter` props) + Task 4 Step 4 wiring. ✓
- Validation: integers ≥ 1, start ≤ end, count ≤ 1000 → Task 1 `buildRange`. ✓
- Sequential print, tolerates failures, cancel, progress, summary → Task 2 `runPrintRange` + Task 3 UI. ✓
- `lastPrintedNumber` updated so "Print Next" continues → Task 4 Step 4 `onComplete`. ✓
- Print queue integration when connected → Task 4 Step 2. ✓
- Tests for range/validation and loop behavior → Tasks 1 & 2. ✓ (Component-level DOM tests omitted: no harness in repo — documented in Task 3 Step 2, consistent with this plan; supersedes the spec's "component test" line, which assumed a harness that does not exist.)

**Placeholder scan:** No TBD/TODO/"add error handling"/"similar to" — all steps contain full code. ✓

**Type consistency:** `buildRange` → `RangeResult` ({ ok, numbers } | { ok, error }); `runPrintRange` args (`numbers`, `printer`, `printItem`, `shouldCancel`, `onProgress`) and return (`printed`, `errors`, `lastPrinted`, `cancelled`) are identical across Task 2 interface block, test, implementation, and the modal's usage in Task 3. `PrintRangeModalProps` (`onClose`, `printers`, `defaultPrinter`, `onPrintItem`, `onComplete`) match Task 4's render site. ✓
