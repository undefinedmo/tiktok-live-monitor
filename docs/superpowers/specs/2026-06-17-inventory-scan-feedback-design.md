# Inventory Scan Feedback — Design

**Date:** 2026-06-17
**Component:** `desktop/` (SellerFolio Desktop v2 — React/Vite/Electron)
**Screen:** Inventory (`desktop/src/pages/Inventory.tsx`)

## Problem

When receiving/counting stock, an operator scans barcodes while standing back from
the laptop. They need to know, without reading the screen up close:

1. **Audibly** whether the scanned item already existed (qty just got bumped) or is
   brand new and needs details entered.
2. **Visually, from across the room**, the product and how its quantity changed.

Today the screen already plays two sounds (`playSuccess` rising chime for an existing
item, `playAlert` low buzz for new/failed), but they are too similar/subtle, and the
visual feedback is a small pill that cannot be read from a distance.

## Goals

- Make the two audio cues clearly, obviously distinct.
- Show a large, room-readable modal on every scan, displaying product info and the
  `old → new` quantity for existing items.
- The modal auto-closes after a short dwell, and **refreshes (resetting its timer)** if
  another scan lands before it closes.
- New (unknown) items get the same big treatment, with behavior that adapts to the
  workflow (see Voice trigger).

## Non-goals

- No change to the barcode scan API (`/api/inventory/scan`) or its semantics.
- No change to the voice-extraction pipeline itself (recording, AI extract, CaptureQueue).
- No new settings screen. The only new control, if needed, is discussed under Voice trigger.

## Scan semantics (existing, unchanged)

`scanBarcode(upc)` → `POST /api/inventory/scan` returns:

- `{ success: true, item, isNew: false }` — UPC already existed; server bumped qty by 1.
  The returned `item.qty` is the **new** quantity, so `oldQty = item.qty - 1`.
- `{ success: true, item, isNew: true }` — UPC was unknown; server **auto-created** a
  record (qty 1) and returned it.
- `{ success: false }` — genuine API/network failure.

There are two scan entry points in `Inventory.tsx`, and this feature applies to **both**:

- `handleSearchKeyDown` — the search box accepts a barcode when not in Scan mode.
- `handleScanModeKeyDown` — the dedicated Scan-mode input.

## Behavior

A scan produces exactly one `ScanEvent`, rendered by a **single shared** full-screen
modal (latest-scan-wins). Each new scan replaces the modal contents.

| Outcome (`scanBarcode` result) | Sound | Modal variant | Auto-close |
|---|---|---|---|
| Existing item (`isNew: false`) | smooth rising chime (`playExisting`) | title/brand + huge `old → new` qty, green | yes, ~2s |
| New item (`isNew: true`), voice active | distinct triple beep (`playNew`) | "NEW ITEM" amber mirror; voice recording starts as today | yes, ~2s (**non-blocking**) |
| New item (`isNew: true`), plain scan | distinct triple beep (`playNew`) | "NEW ITEM" amber; **Add Details** / **Skip** buttons | no — waits for action |
| Failure (`success: false`) | low descending buzz (`playError`) | "Scan failed" red + UPC | yes, ~2s |

**Latest-scan-wins / refresh:** `show(event)` always replaces the current event. For
auto-close variants it clears any pending timer and starts a fresh ~2s timer. The
blocking new-item variant carries no timer; it persists until the operator acts (Add
Details / Skip) or the next scan replaces it.

**Auto-close dwell:** 2000 ms.

## Voice trigger (the context switch)

"Plain scan" vs "voice receiving" is determined by whether a receiving session is open:

> **Voice capture is active when `activeSession != null`.**

- **Receiving session open** → new items auto-create + start voice recording (today's
  behavior) **and** show the non-blocking big modal mirror.
- **No session (plain scan)** → new items show the **blocking** Add Details / Skip modal
  and do **not** auto-record voice.

This is a deliberate behavior change: `enqueueVoice` will be **gated behind
`activeSession`** in both scan handlers, where today it fires for every new item
regardless of session. The change makes the two workflows coherent: "I'm receiving a
shipment" (session on → voice) vs "I'm counting/checking" (session off → no voice,
pause to enter new items).

> If the operator ever needs voice without a formal session, replace the
> `activeSession` trigger with a dedicated "Voice" toggle in the Scan toolbar. Out of
> scope unless requested.

## Architecture (Approach B — hooks own behavior, component renders)

Matches the codebase convention (`useCaptureQueue`, `useVoiceQueue`, `useReceiving`)
and keeps the already-large `Inventory.tsx` from growing further.

### New: `desktop/src/hooks/useScanSounds.ts`

Moves the AudioContext + `playTone` helpers out of `Inventory.tsx` and centralizes all
cue generation (also used by the voice queue, removing duplication). Returns:

- `playExisting()` — 784 Hz → 1175 Hz sine, ~90 ms / ~130 ms. Smooth "counted it."
- `playNew()` — 587 Hz square wave, three short ~70 ms pulses with ~60 ms gaps.
  "Beep-beep-beep" attention cue, unmistakably different from the chime.
- `playError()` — 330 Hz → 220 Hz square, descending. The former alert buzz, now
  reserved for genuine failures.
- `playChime()` — unchanged (voice AI fill complete).
- `playMicArm()` — unchanged (mic armed for recording).

### New: `desktop/src/hooks/useScanFeedback.ts`

Owns the single modal event + timer.

```ts
type ScanEvent =
  | { kind: 'existing'; item: InventoryItem; oldQty: number; newQty: number }
  | { kind: 'new'; item: InventoryItem; blocking: boolean }
  | { kind: 'error'; upc: string };
```

API: `{ event: ScanEvent | null, show(event), dismiss() }`.

- `show(event)`: store the event, play the matching sound (`existing → playExisting`,
  `new → playNew`, `error → playError`), clear any pending timer, and — unless the event
  is `{ kind: 'new', blocking: true }` — start a fresh 2000 ms timer that calls `dismiss`.
- `dismiss()`: clear the event and any pending timer.
- Clears the timer on unmount.

### New: `desktop/src/components/inventory/ScanResultModal.tsx`

Pure presentational full-screen overlay. Props:
`{ event: ScanEvent | null, onAddDetails(item): void, onDismiss(): void }`.

- Renders nothing when `event` is null.
- Fixed overlay above the detail panel (`z-[60]`; detail panel is `z-50`).
- Backdrop click dismisses for auto-close variants; the blocking new-item variant
  requires a button.
- Variants:
  - **existing** (green): product title (≈`text-4xl` bold), brand (≈`text-2xl`) + style
    (small), UPC (small mono); the star is the huge `old → new` quantity (new value
    ≈`text-7xl` green with an ↑ arrow, old value small/struck) under a "Quantity" label;
    optional thin 2s countdown bar.
  - **new** (amber): "NEW ITEM" heading, large UPC, qty 1. When `blocking`, two large
    buttons **Add Details** and **Skip**; when non-blocking, a "Recording…/capturing
    details" hint and the countdown bar.
  - **error** (red): "Scan failed" + UPC, countdown bar.

### Modified: `desktop/src/pages/Inventory.tsx`

- Use `useScanSounds` and `useScanFeedback` hooks.
- `handleSearchKeyDown` and `handleScanModeKeyDown`: replace the inline
  `playSuccess`/`playAlert`/`scanFeedback`/`notFoundUpc` logic with `feedback.show(...)`:
  - `success && !isNew` → `show({ kind: 'existing', item, oldQty: item.qty - 1, newQty: item.qty })`.
  - `success && isNew` → `show({ kind: 'new', item, blocking: !activeSession })`; call
    `enqueueVoice(upc)` **only when `activeSession`**.
  - `!success` → `show({ kind: 'error', upc })`.
- Render `<ScanResultModal event={feedback.event} onAddDetails={openDetailPanel}
  onDismiss={feedback.dismiss} />`. Add Details opens the detail panel for the
  just-created item (and dismisses the modal); Skip dismisses and refocuses the scan input.
- Remove the now-redundant `scanFeedback` state + pill and the `notFoundUpc` pill +
  `handleNotFoundSkip` / `handleNotFoundAdd` (the new-item modal variant subsumes them).
- Keep the `scanLog` running tally (small pill in Scan mode) — independent and still useful.
- Update the Scan-mode focus mouse-trap so it bails (does not steal focus back to the
  scan input) when a blocking modal is showing **or** the detail panel is open, so the
  modal buttons and the Add-Details form remain usable. (Replaces the current
  `if (notFoundUpc) return;` guard.)

## Testing

- **`desktop/src/hooks/useScanFeedback.test.ts`** (vitest + `vi.useFakeTimers()`,
  mirroring `useCaptureQueue.test.ts`):
  - existing/new-nonblocking/error events auto-close after ~2000 ms.
  - a blocking new event sets no timer and persists.
  - a second `show` before close replaces the event and resets the timer
    (advancing past the original deadline does not close the refreshed event).
  - `dismiss` clears the event and cancels the pending timer.
- **Manual QA checklist** (run the app, `npm run dev`):
  1. Scan an existing item → rising chime + green modal showing `old → new`, auto-closes ~2s.
  2. Rapidly scan two existing items → modal refreshes to the second, timer resets.
  3. With a receiving session open, scan an unknown UPC → triple beep, non-blocking
     "NEW ITEM" modal auto-closes, voice recording still starts.
  4. With no session (plain scan), scan an unknown UPC → triple beep, blocking modal;
     Add Details opens the form, Skip returns to scanning. Confirm voice did **not** record.
  5. Simulate a scan failure → low buzz + red "Scan failed" modal, auto-closes.

## Risks / notes

- **Behavior change:** gating `enqueueVoice` behind `activeSession` changes today's
  always-on voice for new scans. Confirmed acceptable; revisit if a session-less voice
  workflow surfaces (→ dedicated toggle).
- AudioContext may start suspended under autoplay policy; scanning is a keyboard gesture
  so it resumes, matching the current working behavior. The shared context lives in
  `useScanSounds`.
