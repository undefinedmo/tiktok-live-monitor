# Inventory Scan Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Inventory screen clearly distinct scan sounds and a single large, room-readable scan-result modal that shows product info and old→new quantity, auto-closes, refreshes on rescan, and pauses for new items only in plain-scan mode.

**Architecture:** Approach B from the spec — behavior lives in hooks, rendering in a presentational component. `useScanSounds` centralizes Web-Audio cues; `useScanFeedback` owns the single modal event + auto-close timer; `ScanResultModal` renders it. `Inventory.tsx` wires them into both scan handlers and drops the old small-pill feedback.

**Tech Stack:** React 19 + TypeScript, Vite, Web Audio API, lucide-react icons, Tailwind CSS, vitest (node env).

**Spec:** `docs/superpowers/specs/2026-06-17-inventory-scan-feedback-design.md`

## Global Constraints

- **Working directory:** all commands and git operations run from `desktop/` (it is its own git repo, gitignored by the platform root). Use `cd desktop` first, or `git -C desktop ...`.
- **Tests run in node env** (`vitest.config` `environment: 'node'`). No jsdom, no `@testing-library`. Test **exported pure functions** only — do not write `renderHook`/DOM tests. (Pattern: `desktop/src/hooks/useCaptureQueue.test.ts` tests the exported `reduce` function.)
- **Data access pattern unchanged:** no new API routes; `scanBarcode` semantics are fixed (`{ success, item, isNew }`; on existing-item bump `item.qty` is the NEW qty so `oldQty = item.qty - 1`).
- **Behavior change (confirmed):** `enqueueVoice` fires only when `activeSession != null`. New items in plain scan (no session) show the blocking modal and do not record voice.
- **Auto-close dwell:** 2000 ms.
- **Verification commands:** unit tests `npm test`; typecheck `npm run typecheck`; run app `npm run dev`.

---

## File Structure

**Create:**
- `desktop/src/hooks/useScanSounds.ts` — Web-Audio cue definitions + play functions.
- `desktop/src/hooks/useScanSounds.test.ts` — pure-data tests asserting cue distinctness.
- `desktop/src/hooks/useScanFeedback.ts` — `ScanEvent` type, pure decision functions, the feedback hook.
- `desktop/src/hooks/useScanFeedback.test.ts` — pure-function tests.
- `desktop/src/components/inventory/ScanResultModal.tsx` — presentational full-screen modal.

**Modify:**
- `desktop/src/pages/Inventory.tsx` — use the new hooks, rewrite both scan handlers, drop old `scanFeedback`/`notFoundUpc` state + pills + handlers, render `<ScanResultModal>`, update the Scan-mode focus trap.

---

### Task 1: `useScanSounds` hook + cue definitions

Centralizes audio. Redesigns the existing/new cues to be obviously distinct (the spec's audio goal), and moves the unchanged chime/mic-arm cues used by the voice queue into one place.

**Files:**
- Create: `desktop/src/hooks/useScanSounds.ts`
- Test: `desktop/src/hooks/useScanSounds.test.ts`

**Interfaces:**
- Produces:
  - `interface ToneSpec { freq: number; durationMs: number; type: OscillatorType; at: number }`
  - `const EXISTING_CUE: ToneSpec[]`, `NEW_CUE: ToneSpec[]`, `ERROR_CUE: ToneSpec[]`, `CHIME_CUE: ToneSpec[]`, `MIC_ARM_CUE: ToneSpec[]`
  - `function useScanSounds(): { playExisting(): void; playNew(): void; playError(): void; playChime(): void; playMicArm(): void }`

- [ ] **Step 1: Write the failing test**

Create `desktop/src/hooks/useScanSounds.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EXISTING_CUE, NEW_CUE, ERROR_CUE } from './useScanSounds';

describe('scan sound cues', () => {
  it('existing-item cue rises in pitch', () => {
    expect(EXISTING_CUE.length).toBeGreaterThanOrEqual(2);
    expect(EXISTING_CUE[EXISTING_CUE.length - 1].freq).toBeGreaterThan(EXISTING_CUE[0].freq);
  });

  it('new-item cue is three separated pulses', () => {
    expect(NEW_CUE).toHaveLength(3);
    // each pulse starts after the previous one ends → audibly "beep-beep-beep"
    expect(NEW_CUE[1].at).toBeGreaterThanOrEqual(NEW_CUE[0].at + NEW_CUE[0].durationMs);
    expect(NEW_CUE[2].at).toBeGreaterThanOrEqual(NEW_CUE[1].at + NEW_CUE[1].durationMs);
  });

  it('error cue descends in pitch', () => {
    expect(ERROR_CUE[ERROR_CUE.length - 1].freq).toBeLessThan(ERROR_CUE[0].freq);
  });

  it('new and existing cues are clearly distinct (waveform + pulse count differ)', () => {
    expect(NEW_CUE[0].type).not.toBe(EXISTING_CUE[0].type);
    expect(NEW_CUE.length).not.toBe(EXISTING_CUE.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && npx vitest run src/hooks/useScanSounds.test.ts`
Expected: FAIL — cannot resolve `./useScanSounds` (module not yet created).

- [ ] **Step 3: Write the implementation**

Create `desktop/src/hooks/useScanSounds.ts`:

```ts
import { useCallback, useRef } from 'react';

/** One tone in a cue. `at` is milliseconds after the cue starts. */
export interface ToneSpec {
  freq: number;
  durationMs: number;
  type: OscillatorType;
  at: number;
}

// Existing item (qty bumped): smooth, pleasant two-note rise — "counted it".
export const EXISTING_CUE: ToneSpec[] = [
  { freq: 784,  durationMs: 90,  type: 'sine', at: 0 },
  { freq: 1175, durationMs: 130, type: 'sine', at: 90 },
];

// New (unknown) item: three short square pulses — unmistakable "beep-beep-beep".
export const NEW_CUE: ToneSpec[] = [
  { freq: 587, durationMs: 70, type: 'square', at: 0 },
  { freq: 587, durationMs: 70, type: 'square', at: 130 },
  { freq: 587, durationMs: 70, type: 'square', at: 260 },
];

// Genuine scan failure: low descending buzz.
export const ERROR_CUE: ToneSpec[] = [
  { freq: 330, durationMs: 150, type: 'square', at: 0 },
  { freq: 220, durationMs: 250, type: 'square', at: 150 },
];

// Voice AI fill complete (unchanged behavior — formerly playChime).
export const CHIME_CUE: ToneSpec[] = [
  { freq: 1320, durationMs: 80,  type: 'sine', at: 0 },
  { freq: 1760, durationMs: 100, type: 'sine', at: 80 },
];

// Mic armed for recording (unchanged behavior — formerly playMicArm).
export const MIC_ARM_CUE: ToneSpec[] = [
  { freq: 660, durationMs: 70, type: 'sine', at: 0 },
  { freq: 990, durationMs: 90, type: 'sine', at: 70 },
];

export function useScanSounds() {
  const ctxRef = useRef<AudioContext | null>(null);

  const getCtx = useCallback(() => {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    return ctxRef.current;
  }, []);

  const playCue = useCallback((cue: ToneSpec[]) => {
    try {
      const ctx = getCtx();
      if (ctx.state === 'suspended') void ctx.resume();
      const base = ctx.currentTime;
      for (const t of cue) {
        const startAt = base + t.at / 1000;
        const dur = t.durationMs / 1000;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = t.type;
        osc.frequency.value = t.freq;
        gain.gain.value = 0.3;
        gain.gain.exponentialRampToValueAtTime(0.01, startAt + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startAt);
        osc.stop(startAt + dur);
      }
    } catch {
      /* audio unavailable */
    }
  }, [getCtx]);

  return {
    playExisting: useCallback(() => playCue(EXISTING_CUE), [playCue]),
    playNew:      useCallback(() => playCue(NEW_CUE), [playCue]),
    playError:    useCallback(() => playCue(ERROR_CUE), [playCue]),
    playChime:    useCallback(() => playCue(CHIME_CUE), [playCue]),
    playMicArm:   useCallback(() => playCue(MIC_ARM_CUE), [playCue]),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && npx vitest run src/hooks/useScanSounds.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd desktop && git add src/hooks/useScanSounds.ts src/hooks/useScanSounds.test.ts && git commit -m "feat(inventory): centralized scan sound cues with distinct existing/new tones

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `useScanFeedback` hook + pure decision functions

Owns the single modal event and the auto-close timer (latest-scan-wins). The branching logic is exported as pure functions so it can be unit-tested in the node env.

**Files:**
- Create: `desktop/src/hooks/useScanFeedback.ts`
- Test: `desktop/src/hooks/useScanFeedback.test.ts`

**Interfaces:**
- Consumes: `InventoryItem` from `./useInventory`; `ScanSoundPlayers` = `{ playExisting, playNew, playError }` (a subset of Task 1's `useScanSounds` return).
- Produces:
  - `type ScanEvent = { kind: 'existing'; item: InventoryItem; oldQty: number; newQty: number } | { kind: 'new'; item: InventoryItem; blocking: boolean } | { kind: 'error'; upc: string }`
  - `const SCAN_AUTOCLOSE_MS = 2000`
  - `function scanEventSound(e: ScanEvent): 'existing' | 'new' | 'error'`
  - `function scanEventAutoCloses(e: ScanEvent): boolean`
  - `function useScanFeedback(sounds: ScanSoundPlayers): { event: ScanEvent | null; show(e: ScanEvent): void; dismiss(): void }`

- [ ] **Step 1: Write the failing test**

Create `desktop/src/hooks/useScanFeedback.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  scanEventSound,
  scanEventAutoCloses,
  SCAN_AUTOCLOSE_MS,
  type ScanEvent,
} from './useScanFeedback';
import type { InventoryItem } from './useInventory';

function item(qty: number): InventoryItem {
  return {
    id: 1, upc: '12345', brand: null, title: null, styleCode: null, colorCode: null,
    colorName: null, retailPrice: null, salePrice: null, cost: null, qty, notes: null,
    createdAt: '', updatedAt: '',
  };
}

const existing: ScanEvent = { kind: 'existing', item: item(2), oldQty: 1, newQty: 2 };
const newBlocking: ScanEvent = { kind: 'new', item: item(1), blocking: true };
const newOpen: ScanEvent = { kind: 'new', item: item(1), blocking: false };
const err: ScanEvent = { kind: 'error', upc: '999' };

describe('scanEventSound', () => {
  it('existing -> existing', () => expect(scanEventSound(existing)).toBe('existing'));
  it('new -> new', () => expect(scanEventSound(newBlocking)).toBe('new'));
  it('error -> error', () => expect(scanEventSound(err)).toBe('error'));
});

describe('scanEventAutoCloses', () => {
  it('existing auto-closes', () => expect(scanEventAutoCloses(existing)).toBe(true));
  it('non-blocking new auto-closes', () => expect(scanEventAutoCloses(newOpen)).toBe(true));
  it('blocking new does NOT auto-close', () => expect(scanEventAutoCloses(newBlocking)).toBe(false));
  it('error auto-closes', () => expect(scanEventAutoCloses(err)).toBe(true));
});

describe('SCAN_AUTOCLOSE_MS', () => {
  it('is 2 seconds', () => expect(SCAN_AUTOCLOSE_MS).toBe(2000));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && npx vitest run src/hooks/useScanFeedback.test.ts`
Expected: FAIL — cannot resolve `./useScanFeedback`.

- [ ] **Step 3: Write the implementation**

Create `desktop/src/hooks/useScanFeedback.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InventoryItem } from './useInventory';

export type ScanEvent =
  | { kind: 'existing'; item: InventoryItem; oldQty: number; newQty: number }
  | { kind: 'new'; item: InventoryItem; blocking: boolean }
  | { kind: 'error'; upc: string };

export const SCAN_AUTOCLOSE_MS = 2000;

/** Which sound cue a scan event triggers. Pure. */
export function scanEventSound(e: ScanEvent): 'existing' | 'new' | 'error' {
  switch (e.kind) {
    case 'existing': return 'existing';
    case 'new':      return 'new';
    case 'error':    return 'error';
  }
}

/** Whether a scan event auto-closes. Blocking new-item events stay until dismissed. Pure. */
export function scanEventAutoCloses(e: ScanEvent): boolean {
  return !(e.kind === 'new' && e.blocking);
}

export interface ScanSoundPlayers {
  playExisting: () => void;
  playNew: () => void;
  playError: () => void;
}

export function useScanFeedback(sounds: ScanSoundPlayers) {
  const [event, setEvent] = useState<ScanEvent | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the latest sound players without making `show` change identity.
  const soundsRef = useRef(sounds);
  soundsRef.current = sounds;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    setEvent(null);
  }, [clearTimer]);

  const show = useCallback((next: ScanEvent) => {
    clearTimer();                 // latest-scan-wins: cancel any pending close
    setEvent(next);
    const which = scanEventSound(next);
    const s = soundsRef.current;
    if (which === 'existing') s.playExisting();
    else if (which === 'new') s.playNew();
    else s.playError();
    if (scanEventAutoCloses(next)) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setEvent(null);
      }, SCAN_AUTOCLOSE_MS);
    }
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]); // clear pending timer on unmount

  return { event, show, dismiss };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && npx vitest run src/hooks/useScanFeedback.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
cd desktop && git add src/hooks/useScanFeedback.ts src/hooks/useScanFeedback.test.ts && git commit -m "feat(inventory): useScanFeedback hook with auto-close + latest-scan-wins

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `ScanResultModal` presentational component

The big, room-readable overlay. Pure presentation driven by `ScanEvent`. No unit test (no DOM/RTL in this project) — verified by `npm run typecheck` here and manual QA in Task 4.

**Files:**
- Create: `desktop/src/components/inventory/ScanResultModal.tsx`

**Interfaces:**
- Consumes: `ScanEvent` from `../../hooks/useScanFeedback`; `InventoryItem` from `../../hooks/useInventory`.
- Produces: `function ScanResultModal(props: { event: ScanEvent | null; onAddDetails: (item: InventoryItem) => void; onDismiss: () => void }): JSX.Element | null`

- [ ] **Step 1: Write the component**

Create `desktop/src/components/inventory/ScanResultModal.tsx`:

```tsx
import { ArrowUp, PackagePlus, AlertTriangle } from 'lucide-react';
import type { ScanEvent } from '../../hooks/useScanFeedback';
import type { InventoryItem } from '../../hooks/useInventory';

interface Props {
  event: ScanEvent | null;
  onAddDetails: (item: InventoryItem) => void;
  onDismiss: () => void;
}

export function ScanResultModal({ event, onAddDetails, onDismiss }: Props) {
  if (!event) return null;

  const blocking = event.kind === 'new' && event.blocking;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={() => { if (!blocking) onDismiss(); }}
    >
      <div
        className="relative w-[min(90vw,760px)] rounded-3xl border border-border-subtle bg-bg-secondary shadow-2xl px-12 py-12 text-center"
        onClick={(e) => e.stopPropagation()}
      >
        {event.kind === 'existing' && <ExistingBody event={event} />}
        {event.kind === 'new' && (
          <NewBody event={event} onAddDetails={onAddDetails} onSkip={onDismiss} />
        )}
        {event.kind === 'error' && <ErrorBody upc={event.upc} />}
      </div>
    </div>
  );
}

function ExistingBody({ event }: { event: Extract<ScanEvent, { kind: 'existing' }> }) {
  const { item, oldQty, newQty } = event;
  return (
    <div className="flex flex-col items-center gap-8">
      <div className="space-y-2">
        <h2 className="text-4xl font-bold text-text-primary leading-tight">
          {item.title || 'Unknown item'}
        </h2>
        <p className="text-2xl text-text-secondary">
          {item.brand || '—'}
          {item.styleCode ? <span className="text-text-tertiary"> · {item.styleCode}</span> : null}
        </p>
        <p className="text-sm font-mono text-text-tertiary">{item.upc}</p>
      </div>
      <div className="flex items-end justify-center gap-6">
        <span className="text-5xl font-semibold text-text-tertiary line-through leading-none">{oldQty}</span>
        <ArrowUp className="w-12 h-12 text-success mb-2" />
        <span className="text-8xl font-black text-success leading-none">{newQty}</span>
      </div>
      <p className="text-lg uppercase tracking-[0.3em] text-text-tertiary">Quantity</p>
    </div>
  );
}

function NewBody({
  event,
  onAddDetails,
  onSkip,
}: {
  event: Extract<ScanEvent, { kind: 'new' }>;
  onAddDetails: (item: InventoryItem) => void;
  onSkip: () => void;
}) {
  const { item, blocking } = event;
  return (
    <div className="flex flex-col items-center gap-6">
      <PackagePlus className="w-20 h-20 text-warning" />
      <div className="space-y-2">
        <h2 className="text-5xl font-black text-warning leading-tight">NEW ITEM</h2>
        <p className="text-xl text-text-secondary">Not previously in inventory</p>
        <p className="text-2xl font-mono text-text-primary mt-2">{item.upc}</p>
      </div>
      {blocking ? (
        <div className="flex items-center gap-4 mt-2">
          <button
            onClick={() => onAddDetails(item)}
            className="px-8 py-4 rounded-2xl bg-accent text-white text-xl font-bold hover:bg-accent/90"
          >
            Add Details
          </button>
          <button
            onClick={onSkip}
            className="px-8 py-4 rounded-2xl bg-bg-tertiary border border-border-subtle text-text-secondary text-xl font-semibold hover:bg-bg-primary"
          >
            Skip
          </button>
        </div>
      ) : (
        <p className="text-lg text-text-secondary">Capturing details by voice…</p>
      )}
    </div>
  );
}

function ErrorBody({ upc }: { upc: string }) {
  return (
    <div className="flex flex-col items-center gap-6">
      <AlertTriangle className="w-20 h-20 text-danger" />
      <h2 className="text-5xl font-black text-danger leading-tight">Scan failed</h2>
      <p className="text-2xl font-mono text-text-primary">{upc}</p>
      <p className="text-lg text-text-secondary">Try scanning again</p>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd desktop && npm run typecheck`
Expected: PASS — no type errors (the file resolves `ScanEvent`/`InventoryItem` and lucide icons).

- [ ] **Step 3: Commit**

```bash
cd desktop && git add src/components/inventory/ScanResultModal.tsx && git commit -m "feat(inventory): large room-readable ScanResultModal (existing/new/error)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Integrate into `Inventory.tsx`

Wire the hooks into both scan paths, render the modal, and remove the now-redundant small-pill feedback (`scanFeedback`, `notFoundUpc`, and their handlers). One cohesive task — intermediate splits would leave the file not compiling.

**Files:**
- Modify: `desktop/src/pages/Inventory.tsx`

**Interfaces:**
- Consumes: `useScanSounds` (Task 1), `useScanFeedback` + `ScanEvent` (Task 2), `ScanResultModal` (Task 3).

- [ ] **Step 1: Add imports**

In `desktop/src/pages/Inventory.tsx`, in the existing lucide import (currently `import { Search, Plus, Package, X, Minus, ScanBarcode, PackagePlus } from 'lucide-react';`), **remove `Package`** (its only use is the removed `scanFeedback` pill):

```tsx
import { Search, Plus, X, Minus, ScanBarcode, PackagePlus } from 'lucide-react';
```

Add these three imports alongside the other hook/component imports near the top:

```tsx
import { ScanResultModal } from '../components/inventory/ScanResultModal';
import { useScanSounds } from '../hooks/useScanSounds';
import { useScanFeedback } from '../hooks/useScanFeedback';
```

- [ ] **Step 2: Remove dead feedback state**

Delete these two state declarations (currently lines ~42–43):

```tsx
const [notFoundUpc, setNotFoundUpc]     = useState<string | null>(null);
const [scanFeedback, setScanFeedback]   = useState<string | null>(null);
```

Keep `scanMode`, `setScanMode`, `scanLog`, `setScanLog`.

- [ ] **Step 3: Replace the inline audio block with the hooks**

Delete the entire inline audio block — `audioCtxRef`, `getAudioCtx`, `playTone`, `playSuccess`, `playAlert`, `playChime`, `playMicArm` (currently lines ~180–214) — and replace with:

```tsx
const { playExisting, playNew, playError, playChime, playMicArm } = useScanSounds();
const feedback = useScanFeedback({ playExisting, playNew, playError });
```

Place this block **above** the `useVoiceQueue(...)` call so `playChime`/`playMicArm` are in scope for its callbacks. (Their existing call sites inside `useVoiceQueue` — `playMicArm()` in `onRecordingStart`, `playChime()` in `onResult` — stay unchanged.)

- [ ] **Step 4: Rewrite `handleSearchKeyDown`**

Replace the whole `handleSearchKeyDown` callback (currently lines ~243–268) with:

```tsx
const handleSearchKeyDown = useCallback(async (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key !== 'Enter' && e.key !== 'Tab') return;
  const value = (e.target as HTMLInputElement).value.trim();
  if (!value || !/^\d+$/.test(value)) return;
  e.preventDefault();
  const result = await scanBarcode(value);
  if (result.success && result.item) {
    queueDispatch({ type: 'scanned', upc: value, item: result.item });
    if (result.isNew) {
      feedback.show({ kind: 'new', item: result.item, blocking: !activeSession });
      if (activeSession) enqueueVoice(value);
    } else {
      feedback.show({
        kind: 'existing', item: result.item,
        oldQty: result.item.qty - 1, newQty: result.item.qty,
      });
    }
  } else {
    feedback.show({ kind: 'error', upc: value });
  }
  if (searchInputRef.current) searchInputRef.current.value = '';
  setSearch('');
  reloadItems();
  if (activeSession) refreshStats();
}, [scanBarcode, reloadItems, feedback, activeSession, refreshStats, queueDispatch, enqueueVoice]);
```

- [ ] **Step 5: Rewrite `handleScanModeKeyDown`**

Replace the whole `handleScanModeKeyDown` callback (currently lines ~270–289) with:

```tsx
const handleScanModeKeyDown = useCallback(async (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key !== 'Enter' && e.key !== 'Tab') return;
  e.preventDefault();
  const upc = (e.target as HTMLInputElement).value.trim();
  if (!upc) return;
  if (scanInputRef.current) scanInputRef.current.value = '';

  const result = await scanBarcode(upc);
  let blockingNew = false;
  if (result.success && result.item) {
    queueDispatch({ type: 'scanned', upc, item: result.item });
    if (result.isNew) {
      blockingNew = !activeSession;
      feedback.show({ kind: 'new', item: result.item, blocking: blockingNew });
      if (activeSession) enqueueVoice(upc);
    } else {
      feedback.show({
        kind: 'existing', item: result.item,
        oldQty: result.item.qty - 1, newQty: result.item.qty,
      });
    }
    setScanLog(prev => [
      { title: result.item!.title || upc, qty: result.item!.qty, isNew: !!result.isNew },
      ...prev.slice(0, 19),
    ]);
    reloadItems();
    if (activeSession) refreshStats();
  } else {
    feedback.show({ kind: 'error', upc });
  }
  // Keep scanning unless a blocking new-item modal needs the operator's choice.
  if (!blockingNew) setTimeout(() => scanInputRef.current?.focus(), 50);
}, [scanBarcode, reloadItems, feedback, activeSession, refreshStats, queueDispatch, enqueueVoice]);
```

- [ ] **Step 6: Remove the not-found handlers**

Delete `handleNotFoundSkip` and `handleNotFoundAdd` (currently lines ~291–304) entirely. They are replaced by the modal's new-item Add Details / Skip buttons.

- [ ] **Step 7: Add the modal handlers**

Immediately after `openDetailPanel`/`closeDetailPanel` are defined (currently ~line 323), add:

```tsx
const handleModalDismiss = useCallback(() => {
  feedback.dismiss();
  if (scanMode) setTimeout(() => scanInputRef.current?.focus(), 50);
}, [feedback, scanMode]);

const handleModalAddDetails = useCallback((item: InventoryItem) => {
  feedback.dismiss();
  openDetailPanel(item);
}, [feedback]);
```

- [ ] **Step 8: Update the Scan-mode focus trap**

In the `useEffect` that runs while `scanMode` is on (currently ~lines 222–237), replace the trap so it no longer references `notFoundUpc` and instead yields focus while a blocking modal or the detail panel is open:

```tsx
useEffect(() => {
  if (scanMode) {
    setTimeout(() => scanInputRef.current?.focus(), 100);
    const trap = (e: MouseEvent) => {
      // Don't steal focus while a blocking modal or the detail panel is open.
      if ((feedback.event?.kind === 'new' && feedback.event.blocking) || selectedItem) return;
      const target = e.target as HTMLElement;
      if (target.closest('button')) return;
      e.preventDefault();
      scanInputRef.current?.focus();
    };
    document.addEventListener('mousedown', trap);
    return () => document.removeEventListener('mousedown', trap);
  } else {
    searchInputRef.current?.focus();
  }
}, [scanMode, feedback.event, selectedItem]);
```

- [ ] **Step 9: Replace the old feedback pills with the scanLog-only block**

Replace the entire feedback block (currently lines ~476–503, the `{(scanFeedback || notFoundUpc || (scanMode && scanLog.length > 0)) && ( ... )}` region) with a block that renders only the running tally:

```tsx
{scanMode && scanLog.length > 0 && (
  <div className="space-y-1.5">
    <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-secondary/50 border border-border-subtle rounded-lg text-xs">
      <span className="font-medium truncate">{scanLog[0].title}</span>
      {scanLog[0].isNew ? (
        <span className="text-success font-bold">NEW</span>
      ) : (
        <span className="text-text-secondary">was {scanLog[0].qty - 1}</span>
      )}
      <span className="text-accent font-semibold">now {scanLog[0].qty}</span>
      {scanLog.length > 1 && <span className="text-text-tertiary ml-auto">{scanLog.length} scanned</span>}
    </div>
  </div>
)}
```

- [ ] **Step 10: Render the modal**

Just before the closing `</div>` of the top-level return (next to `<StartReceivingModal ... />` at the end), add:

```tsx
<ScanResultModal
  event={feedback.event}
  onAddDetails={handleModalAddDetails}
  onDismiss={handleModalDismiss}
/>
```

- [ ] **Step 11: Typecheck + run unit tests**

Run: `cd desktop && npm run typecheck && npm test`
Expected: typecheck PASS (no references to removed `Package`, `scanFeedback`, `notFoundUpc`, `playSuccess`, `playAlert`, `handleNotFound*`); all vitest suites PASS.

If typecheck reports an unused symbol or a dangling reference, it points at a leftover from a deleted block — remove that reference.

- [ ] **Step 12: Manual QA**

Run: `cd desktop && npm run dev` (Electron launches automatically). Open the Inventory screen and verify:

1. **Existing item:** scan a known UPC → rising chime; big green modal shows title/brand and `old → new` qty; auto-closes after ~2s.
2. **Refresh on rescan:** scan two known items quickly → modal contents switch to the second item and the close timer resets (it does not close 2s after the first scan).
3. **New item during receiving:** Start Receiving, then scan an unknown UPC → triple beep; amber "NEW ITEM" modal that is non-blocking and auto-closes; voice recording still starts (CaptureQueue shows the row recording).
4. **New item in plain scan:** with no session, scan an unknown UPC → triple beep; amber "NEW ITEM" modal stays open with Add Details / Skip. **Add Details** opens the right-side edit panel for the item; **Skip** closes the modal and returns focus to the scan input. Confirm no voice recording started.
5. **Failed scan:** (e.g., temporarily point the app at an unreachable API, or stop the web API) scan anything → low buzz; red "Scan failed" modal with the UPC; auto-closes.
6. Both entry points: repeat 1 via the **search box** (not in Scan mode) and via **Scan mode**.

- [ ] **Step 13: Commit**

```bash
cd desktop && git add src/pages/Inventory.tsx && git commit -m "feat(inventory): big scan-result modal + context-aware new-item flow

Wires useScanSounds/useScanFeedback into both scan paths, renders ScanResultModal,
gates voice capture behind an active receiving session, and removes the old
scanFeedback/notFoundUpc pills.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Distinct sounds → Task 1 (`EXISTING_CUE` vs `NEW_CUE`, asserted distinct) + Task 2 sound selection. ✅
- Big modal with product info + old→new qty → Task 3 `ExistingBody`. ✅
- Auto-close ~2s → Task 2 `SCAN_AUTOCLOSE_MS` + timer. ✅
- Refresh on rescan (timer reset) → Task 2 `show` clears timer first; verified in QA step 12.2. ✅
- New item: big modal, blocking only in plain scan / non-blocking + voice during session → Task 4 steps 4–5 (`blocking: !activeSession`, `enqueueVoice` gated on `activeSession`) + Task 3 `NewBody`. ✅
- Failure handling → `error` variant (Task 2/3) + Task 4. ✅
- Both scan entry points → Task 4 steps 4 and 5. ✅
- Focus trap not stealing focus from blocking modal / detail panel → Task 4 step 8. ✅
- Remove redundant pills/handlers → Task 4 steps 2, 6, 9. ✅

**2. Placeholder scan:** No TBD/TODO; every code step has complete code. ✅

**3. Type consistency:** `ScanEvent` shape, `scanEventSound`/`scanEventAutoCloses`/`SCAN_AUTOCLOSE_MS`, and `useScanFeedback({ playExisting, playNew, playError })` match across Tasks 1, 2, 3, 4. `oldQty = item.qty - 1` is consistent with the spec and the retained `scanLog` "was qty-1" line. `ScanSoundPlayers` is a subset of `useScanSounds`'s return — compatible. ✅

**Note (optional, not in scope):** the spec mentioned an optional 2s countdown progress bar in the modal. Omitted to keep the modal purely presentational without Tailwind keyframe config; can be added later as polish.
