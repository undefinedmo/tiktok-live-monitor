# Inventory capture rework — design

**Date:** 2026-05-12
**Status:** Draft for review
**Scope:** Desktop Inventory screen + supporting v2 web API + Prisma schema additions.

## Goal

Make the Inventory screen as fast as possible for three scenarios, weighted equally:

1. **Receiving new stock** — scan and capture brand/style/color/size/price for dozens of new items in one session.
2. **Adding singletons** — capture full tag detail for one-off thrift/consignment finds.
3. **Spot-counts and adjustments** — walk a rack, adjust qty, fix typos, mark items removed.

The operator inputs supported in v1 are a USB/Bluetooth barcode scanner and a microphone (voice). Phone-camera scanning is deferred. Manual typing must remain a fast fallback.

## Pain points being addressed

The current desktop Inventory screen already supports scan mode, search-bar scan, receiving sessions, a "Read tag" voice button inside a right-side detail panel, and bulk operations. The four pain points driving this rework:

1. **New-UPC interruption breaks scan rhythm.** The current "Add Details" flow stops the scan stream; the operator must switch hands, edit a panel, save, and resume.
2. **Voice round-trip is too many clicks.** Today: open panel → Read tag → review → fix → Save.
3. **No visible queue.** The one-line scan log is too thin to review or correct recent scans.
4. **Detail panel field layout is slow.** Wrong order for how the eye reads a hang tag; too many low-value fields.

Additionally: the v2 web app has no `/api/inventory/*` routes today, so every desktop call 404s. This rework includes scaffolding those routes.

## Approach (chosen)

**Inline capture queue is the primary surface.** During a receiving session, every scan adds a row to a queue rendered above the existing inventory table. Rows are inline-editable like a spreadsheet. Voice auto-triggers on unknown UPCs and AI fills cells in the background while the operator keeps scanning. The right-side detail panel survives, demoted to a "full details + history" view for rare cases.

Two alternates considered and rejected:

- **Split-pane Capture / Library:** cramped capture queue, doesn't address field-layout pain.
- **Mode toggle Capture / Browse:** "all three scenarios equally" requires too much mode-flipping (e.g. spot-counts during receiving).

## Screen layout

```
┌─────────────────────────────────────────────────────────────┐
│ [Scan ▢]  [🔍 Search inventory or scan barcode...]   [+ New]│  ← Top bar (always visible)
│  Receiving: "Spring '26 / Nike box" · 47 scans · 38 SKUs   │  ← Session bar (only when active)
├─────────────────────────────────────────────────────────────┤
│ CAPTURE QUEUE                                  ⌨ kbd hints │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ UPC          Brand   Title       Style  Color  Sz  $ │  │  ← One row per UPC in this session
│  │ 884726…      Nike    Air Max…    DV3505 White  10 145│  │
│  │ ▶ 884802… [🎤 listening…]                            │  │  ← Just-scanned, voice capturing
│  │ 884801…  ⟳ Nike    Air Force…  CW230… Black  9  120│  │  ← AI fill in progress
│  └──────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│ INVENTORY (1,284 items · 3,612 units)                       │  ← Existing table; filters; bulk-select
│  ☐ Product            Brand    Style    Retail   Qty       │
│  ☐ Air Force 1 Low    Nike     CW2288   $120     14        │
│  ☐ …                                                        │
└─────────────────────────────────────────────────────────────┘
```

**Behavior:**

- **Top bar** is always present. The Scan toggle reuses today's barcode focus-trap. The search box is dual-mode: letters filter the inventory table; digits + Enter fire a scan (preserves today's behavior). `+ New` opens an empty queue row (creates an ad-hoc session if none active).
- **Session bar** appears under the top bar only when a receiving session is active. Shows vendor, scan count, distinct SKUs, and a Close button.
- **Capture queue** is hidden when no session is active and no recent scans exist. The first scan expands the queue above the inventory table. Newest row on top. Rows persist for the life of the session.
- **Inventory table** is the persistent surface for browse/search/spot-counts. Today's bulk select, brand filter, and pagination stay. Row click → inline expand (qty +/-, brand edit). "Open full details" link in the expanded row opens today's right-side panel for history.

The queue lifecycle is tied to the receiving session: queue = session. Closing the session clears the queue. With no active session, the queue still works ad-hoc but does not persist across page reload. Receiving sessions are one-at-a-time per tenant.

## Queue row anatomy

One row per UPC scanned in this session. Multiple scans of the same UPC update the same row (qty bumps, last-scanned time moves to "now").

**Columns (left to right, matching how the eye reads a hang tag):**

| Col | Field | Width | Notes |
|---|---|---|---|
| Status | dot/icon | 24px | ● new · ◐ enriching · ✓ known · ⚠ failed voice |
| UPC | upc | 110px | mono; read-only after creation |
| Brand | brand | 120px | autocomplete from existing brands |
| Title | title | flex (40%) | longest column; truncates |
| Style | styleCode | 90px | mono |
| Color | colorName | 90px | tooltip shows colorCode |
| Size | size | 60px | new field (see Schema) |
| Retail | retailPrice | 80px | right-aligned $ |
| Cost | cost | 70px | right-aligned $; hidden on narrow widths |
| Qty | qty | 60px | inline +/− buttons; click number to type |
| ⋯ | actions | 32px | menu: Re-mic, Open full details, Remove from queue |

Narrow-window collapse order: drop Cost → drop Color → drop Size (folded into Title).

**Row states (the status dot tells the story):**

1. **● new** — just scanned, UPC unknown, mic listening (or queued for mic if a previous row is still recording).
2. **◐ enriching** — mic stopped, audio uploading to AI extractor. Spinner. Fields locked except qty.
3. **✓ known** — fields populated (either from catalog or freshly extracted). Fully editable.
4. **⚠ failed voice** — extraction failed or returned nothing. Operator can re-mic, type fields, or leave the stub.

**Interaction model:**

- Click any field → inline edit (input replaces the cell, autofocus, Enter saves, Esc cancels, Tab moves to the next cell in this row).
- Tab from last cell → first cell of the row below.
- Arrow keys (when not mid-edit on an input) → move row focus up/down.
- Qty cell has +/− buttons firing immediately (debounced PATCH to `/api/inventory/:id/qty`). Typing in the cell sets explicit qty on blur/Enter.
- AI-extracted fields show a subtle violet underline until accepted (Enter) or edited (the "needs glance" affordance).
- ⋯ menu: Re-mic; Open full details (today's panel); Remove from queue (does not delete the inventory item).

**Auto-save model:** field edits save on blur/Enter (no Save button per row). Optimistic UI; revert on error. Voice-extracted fields save immediately when AI returns.

**Visual hierarchy:** new + enriching rows pinned to the top with a colored left-border (amber for new, violet for enriching). Known rows fade to neutral after ~2s of no activity, then sort by most-recent-scan descending. Within a session, rows never disappear unless explicitly removed.

## Voice trigger model

Voice is the primary entry method for unknown UPCs.

**Auto-trigger rules:**

- A row is created with status **new** the moment an unknown UPC is scanned. The mic auto-arms after a 250ms grace window (lets the beep finish and the operator's hand settle on the tag).
- If a prior row is still recording, the new row's mic stays **queued**. Recording is strict FIFO — one mic active at a time. A small "🎤 next" badge marks queued rows.
- Known-UPC scans never trigger the mic.
- An ad-hoc `+ New` row also auto-arms the mic.

**End-of-recording rules (first to fire wins):**

1. Silence ≥ 1.2s after detected speech onset (VAD via WebAudio RMS thresholding; configurable).
2. Hard cap 12s — prevents the mic from running forever if VAD misfires.
3. Manual stop — Space bar or click on the row's mic icon.
4. New scan — scanning the next barcode stops the current recording, submits whatever audio was captured, and arms the next row immediately.

If a recording captured less than 400ms of speech, it is discarded and the row goes to **⚠ failed voice** with no AI call (saves a credit, avoids garbage).

**Background AI pipeline:**

- Recording is serial (one mic at a time, FIFO).
- Extraction is parallel — each clip uploads + extracts independently, capped at 3 concurrent extractions.
- A row stays in **◐ enriching** until its extraction returns. Multiple rows can be enriching simultaneously.

**Operator-facing affordances:**

- Pulsing red dot on the recording row. Below the row, a thin level meter (last ~2s of audio RMS).
- Esc during recording cancels the audio (no submission), beeps softly.
- Soft chime when a row jumps from ◐ → ✓.

**Failure and recovery:**

- Network failure: row stays in **◐ enriching** with a Retry button. After 3 retries → **⚠ failed**.
- All audio is streamed to the web API; no audio is persisted server-side beyond the AI call.

**Credits:** each successful extraction deducts AI credits via the existing credits system (`deductCredits(ctx, 'inventory.voice-extract')`). If credits exhausted, the row goes to **⚠ failed** with a "credits required" tooltip; scanning still works.

## AI confidence + accept/undo

**Per-field confidence affordance:**

- AI-filled cells show a violet bottom-border underline (the "needs glance" state) until the operator either edits the cell or hits Enter to accept-as-is.
- After confirm/edit, the underline disappears — that field is "owned" by the operator. Re-mic on the row will not overwrite confirmed fields unless the operator opts in via a dialog.
- Low-confidence fields (extractor confidence < 0.6) get a thicker amber underline + a tooltip "AI wasn't sure". These auto-focus when the operator hits Enter on the row.

**Accept-row shortcut:** Cmd/Ctrl+Enter on a focused row accepts all AI fields (clears all underlines).

**Undo model:**

- Every field edit (manual and AI-applied) is undoable with Cmd/Ctrl+Z. Stack is per-row, ~10 deep, cleared on session close.
- A single Cmd/Ctrl+Z after AI fills a row reverts all of that row's AI changes (treats AI fill as one operation). Subsequent undos walk back manual edits one at a time.
- Cmd/Ctrl+Shift+Z redoes.

**Re-mic interaction:** ⋯ → Re-mic resets the row to ◐ enriching, records again, applies new fields only to unconfirmed cells unless the operator opts in to overwrite.

**Brand normalization:** the Brand cell has autocomplete from the tenant's existing brand list. AI-extracted brand strings are matched fuzzy-first (similarity ≥ 0.85 wins). Otherwise the brand is saved verbatim and added to the tenant's brand list.

## Keyboard map

Hands-on-scanner ergonomics. Most of the time the operator only touches the keyboard for occasional edits. An overlay (triggered by `?`) shows the full map.

**Global (anywhere on the page):**

| Key | Action |
|---|---|
| `/` | Focus the search box (preserves today's search-as-scan duality) |
| `s` | Toggle Scan mode |
| `n` | New empty queue row (autofocus first field; mic arms after 250ms) |
| `r` | Start receiving session (opens modal) |
| `Esc` | If recording → cancel mic. Else if a row is focused → drop focus. Else no-op. |
| `?` | Show the keyboard overlay |

**While in Scan mode (scanner has focus):**

- The barcode scanner generates digits + Enter/Tab — that flows through unchanged.
- Space → stop the currently recording row's mic (manual stop).
- Esc → cancel the currently recording row's mic (no audio submitted).

**While editing a queue cell:**

| Key | Action |
|---|---|
| Enter | Save the cell. Move focus to the next empty/low-confidence field in this row. If none, move to the row below. |
| Tab / Shift+Tab | Save and move to the next/previous cell (left-to-right column order). Tab from the last cell wraps to the first cell of the row below. |
| Esc | Revert the cell to the value before this edit. Focus stays on the cell. |
| ↑ / ↓ | (When not mid-edit) Move focus to the same column in the row above/below. |
| `+` / `-` | (When the qty cell is focused, not in edit mode) bump qty +1 / −1. |
| Cmd/Ctrl+Enter | Save the entire row immediately, drop focus. |

**Row-level (row focused, not editing a cell):**

| Key | Action |
|---|---|
| Enter | Open the first empty field for editing. |
| `m` | Re-mic this row. |
| `d` | Open the full details panel. |
| Delete / Backspace | Remove from queue (does NOT delete the inventory item). |

**Conflict-avoidance:**

- Single-letter hotkeys (`s`, `n`, `r`, `m`, `d`, `?`) only fire when no text input has focus.
- Settings toggle "Treat letter keystrokes as input only" for scanners that emit alphabetic codes.

**Visual hint:** a subtle "Press `?` for shortcuts" pill in the bottom-right of the queue. Click → overlay. Hidden after first dismissal (remembered in localStorage).

## API contract

All routes follow `web/CLAUDE.md`: `getTenantContext()` + `requirePermission()` + `where: { tenantId }` on every query + `{ success, data?, error? }` response shape. Permission keys: `inventory.view`, `inventory.write`.

### Inventory items

```
GET    /api/inventory                  → { items, stats, total, filters: { brands } }
       ?search=&brand=&sortBy=&sortDir=&limit=&offset=
       Permission: inventory.view

POST   /api/inventory                  → { item }
       body: Partial<InventoryItem>     Permission: inventory.write

PATCH  /api/inventory/:id              → { item }
       body: editable fields            Permission: inventory.write

POST   /api/inventory/scan             → { item, isNew }
       body: { upc, sessionId? }        Permission: inventory.write
       Side-effect: bumps qty +1; if isNew, creates stub with qty=1, enrichmentStatus='basic';
       logs movement; if sessionId, attaches movement to that session.

PATCH  /api/inventory/:id/qty          → { ok }
       body: { qty, sourceType }        Permission: inventory.write
       Side-effect: writes a movement row (sourceType: 'adjusted' | 'manual_count' | 'scan' | 'voice_create').

POST   /api/inventory/bulk             → { ok, affected }
       body: { ids, action: 'delete' | 'set_qty' | 'set_brand', value? }
       Permission: inventory.write
```

### Brands

```
GET    /api/inventory/brands           → { brands: string[] }
       Permission: inventory.view
       Sourced from DISTINCT brand on Inventory WHERE tenantId = ctx.tenantId.
```

### Movements (history)

```
GET    /api/inventory/:id/movements    → { movements: [{ id, qty, sourceType, sessionId?, note?, createdAt, createdBy }] }
       ?limit=50&offset=0               Permission: inventory.view
```

### Receiving sessions

```
GET    /api/inventory/receipts         → { receipts: [...], active?: ReceivingSession }
       ?active=true                     Permission: inventory.view

POST   /api/inventory/receipts         → { receipt }
       body: { vendor?, receivedAt?, notes? }
       Permission: inventory.write
       Returns 409 with the active session in the response if one already exists for this tenant.

GET    /api/inventory/receipts/:id     → { receipt, stats: { totalScans, distinctUpcs, rows: [...] } }
       Permission: inventory.view
       `rows` is the queue contents (one entry per UPC scanned in this session, with current item state) — drives the queue re-hydration on page reload.

PATCH  /api/inventory/receipts/:id     → { receipt }
       body: { close?: true, vendor?, notes? }
       Permission: inventory.write
```

### Voice extraction

```
POST   /api/inventory/voice-extract    → { fields: ExtractedFields, confidence: Record<keyof ExtractedFields, number> }
       Content-Type: multipart/form-data
       fields: audio (blob, webm/opus or wav, ≤12s), upc? (string, for context)
       Permission: inventory.write
       Credits: 1 × inventory.voice-extract
       No audio persistence.
```

### Response shapes (canonical)

```ts
interface InventoryItem {
  id: number;
  tenantId: string;
  upc: string;
  brand: string | null;
  title: string | null;
  styleCode: string | null;
  colorCode: string | null;
  colorName: string | null;
  size: string | null;            // NEW
  retailPrice: string | null;     // Prisma Decimal as string
  salePrice:   string | null;
  cost:        string | null;
  qty: number;
  notes: string | null;
  enrichmentStatus: 'basic' | 'enriched' | 'failed';
  createdAt: string;
  updatedAt: string;
}

interface ReceivingSession {
  id: number;
  tenantId: string;
  vendor: string | null;
  receivedAt: string;
  notes: string | null;
  closedAt: string | null;
  createdAt: string;
  createdBy: string;              // userId
}

interface ExtractedFields {
  upc?: string;
  brand?: string;
  title?: string;
  styleCode?: string;
  colorCode?: string;
  colorName?: string;
  size?: string;                  // NEW
  retailPrice?: number;
  salePrice?: number;
  cost?: number;
}
```

**Backward compat:** the desktop's `useInventory` / `useReceiving` / `useVoiceExtract` hooks already expect these exact paths and shapes — except for `size`, `enrichmentStatus`, and the per-field `confidence` map. Existing hooks work unchanged; new fields are additive.

**Permission keys to add** in `web/src/lib/permissions.ts`: `inventory.view`, `inventory.write` (Owner / Admin / Manager → write; Viewer → view only).

## Schema deltas

Three new Prisma models. Multi-tenant; indexed for the queries above.

```prisma
model Inventory {
  id               Int       @id @default(autoincrement())
  tenantId         String    @map("tenant_id")
  upc              String
  brand            String?
  title            String?
  styleCode        String?   @map("style_code")
  colorCode        String?   @map("color_code")
  colorName        String?   @map("color_name")
  size             String?
  retailPrice      Decimal?  @map("retail_price")  @db.Decimal(10, 2)
  salePrice        Decimal?  @map("sale_price")    @db.Decimal(10, 2)
  cost             Decimal?  @db.Decimal(10, 2)
  qty              Int       @default(0)
  notes            String?
  enrichmentStatus String    @default("basic") @map("enrichment_status")  // basic | enriched | failed
  createdAt        DateTime  @default(now())  @map("created_at")
  updatedAt        DateTime  @updatedAt       @map("updated_at")

  tenant     Tenant                 @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  movements  InventoryMovement[]

  @@unique([tenantId, upc])
  @@index([tenantId, updatedAt(sort: Desc)])
  @@index([tenantId, brand])
  @@index([tenantId, styleCode])
  @@map("inventory")
}

model InventoryMovement {
  id           BigInt   @id @default(autoincrement())
  tenantId     String   @map("tenant_id")
  inventoryId  Int      @map("inventory_id")
  delta        Int                                       // +N / -N
  qtyAfter     Int      @map("qty_after")                // snapshot after this movement
  sourceType   String   @map("source_type")              // scan | voice_create | adjusted | manual_count | bulk
  sessionId    Int?     @map("session_id")
  note         String?
  createdBy    String   @map("created_by")               // userId
  createdAt    DateTime @default(now()) @map("created_at")

  tenant     Tenant            @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  inventory  Inventory         @relation(fields: [inventoryId], references: [id], onDelete: Cascade)
  session    ReceivingSession? @relation(fields: [sessionId], references: [id], onDelete: SetNull)

  @@index([tenantId, inventoryId, createdAt(sort: Desc)])
  @@index([tenantId, sessionId])
  @@map("inventory_movements")
}

model ReceivingSession {
  id          Int       @id @default(autoincrement())
  tenantId    String    @map("tenant_id")
  vendor      String?
  receivedAt  DateTime  @default(now()) @map("received_at")
  notes       String?
  closedAt    DateTime? @map("closed_at")
  createdAt   DateTime  @default(now()) @map("created_at")
  createdBy   String    @map("created_by")

  tenant     Tenant               @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  movements  InventoryMovement[]

  @@index([tenantId, closedAt])
  @@map("receiving_sessions")
}
```

**Schema choices:**

1. `@@unique([tenantId, upc])` — same UPC can exist across tenants but one row per tenant. Matches scan upsert semantics.
2. `InventoryMovement` is append-only. Every qty change writes a row (delta + post-snapshot). Drives history, audit, future "undo scan". `BigInt` because this table grows fast.
3. `enrichmentStatus` — `basic` after a stub creation (UPC-only), `enriched` once fields are filled, `failed` if all attempts failed.
4. **One active session per tenant** — enforced by a partial unique index added in raw SQL alongside the migration:
   ```sql
   CREATE UNIQUE INDEX uniq_active_session_per_tenant
     ON receiving_sessions (tenant_id) WHERE closed_at IS NULL;
   ```
5. Decimals as `Decimal(10,2)` — matches the existing money pattern in the v2 schema.
6. `Tenant` relation back-refs — add `inventory`, `inventoryMovements`, `receivingSessions` fields to the existing `Tenant` model.
7. **RLS policies** mirror the existing v2 pattern on other tenant-scoped tables, added in the same migration.

**Voice-extract prompt** (constant in `web/src/lib/inventory/voice-extract-prompt.ts`):

> You are reading a clothing/footwear hang tag from an audio recording. Extract only what is explicitly said. Return JSON: `{ brand?, title?, styleCode?, colorCode?, colorName?, size?, retailPrice?, salePrice?, cost?, upc? }` plus `confidence` per field on 0..1. Do not invent values. Prefer alphanumeric style codes verbatim. Size: keep as spoken (e.g. '10', '10.5', 'M', 'L/XL').

The prompt + provider config (Gemini default, OpenAI fallback) lives in `web/src/lib/inventory/voice-extract.ts`. The route is a thin wrapper that handles auth, credits, multipart parsing.

**Migration order (single Prisma migration):**

1. Create the three tables + standard indexes.
2. Add Tenant back-relations.
3. (Raw SQL appended) partial unique index for active session.
4. (Raw SQL appended) RLS policies (mirroring v2 pattern).

## Implementation phases

Each phase is a shippable PR. Phases 1–3 unblock the desktop's existing 404s; phases 4–6 deliver the new UX.

### Phase 1 — Schema + base API (unblocks desktop's 404s)

- Prisma migration: 3 new models + Tenant back-refs + partial unique index + RLS policies.
- Add `inventory.view` / `inventory.write` permission keys to `web/src/lib/permissions.ts` (Owner / Admin / Manager → write; Viewer → view).
- Routes in `web/src/app/api/inventory/`:
  - `route.ts` (GET, POST)
  - `[id]/route.ts` (PATCH)
  - `[id]/qty/route.ts` (PATCH)
  - `[id]/movements/route.ts` (GET)
  - `scan/route.ts` (POST)
  - `bulk/route.ts` (POST)
  - `brands/route.ts` (GET)
  - `receipts/route.ts` (GET, POST)
  - `receipts/[id]/route.ts` (GET, PATCH)
- Delete the malformed `web/src/app/api/inventory/receipts/[id` and `]` stub dirs.

### Phase 2 — Voice-extract endpoint

- `web/src/lib/inventory/voice-extract.ts` (provider wrapper, Gemini default).
- `web/src/lib/inventory/voice-extract-prompt.ts` (prompt constant).
- `web/src/app/api/inventory/voice-extract/route.ts` (POST, multipart, credits-deducting).

### Phase 3 — Desktop capture queue UI

- New `desktop/src/components/inventory/CaptureQueue.tsx`.
- New `desktop/src/components/inventory/CaptureRow.tsx`.
- New `desktop/src/hooks/useCaptureQueue.ts` — owns local queue state, hydrates from `/api/inventory/receipts/:id` on session resume.
- New `desktop/src/hooks/useVoiceQueue.ts` — FIFO mic queue (serial recording, parallel extraction) wrapping `useVoiceExtract`.
- `desktop/src/pages/Inventory.tsx` — restructured to render queue above the existing table; right-side panel survives for "Open full details".

### Phase 4 — Keyboard model + accept/undo

- New `desktop/src/hooks/useKeyboardShortcuts.ts` — global + scoped handlers.
- Per-row undo stack in `useCaptureQueue` (10 deep, cleared on session close).
- Confidence underline component + Cmd/Ctrl+Enter accept-row.
- Settings toggle: "Treat letter keystrokes as input only".

### Phase 5 — Polish + edge cases

- Brand fuzzy-match autocomplete (existing brand list + small string-similarity helper).
- Re-mic dialog ("Overwrite confirmed fields?").
- Waveform / level meter while recording (cheap WebAudio analyser).
- Soft chime on AI completion.
- `?` overlay for keyboard shortcuts.

### Phase 6 — Web inventory parity (deferred)

The web `/inventory` page (currently `/api/products`-backed) gets a separate decision: either point it at the new `/api/inventory` endpoints, or keep the products page as a higher-level "catalog rollup" view distinct from raw inventory. **Out of scope for this design.**

## What stays the same

- Today's scan-mode focus trap, audio beeps, search-as-scan-on-digits behavior, bulk-select toolbar, brand filter, +/− qty buttons in the detail panel.
- The right-side detail panel (kept; demoted to "Open full details" affordance for history + danger zone).
- `apiClient` auth/tenant header injection.

## Out of scope (explicit)

- Phone-camera scanning (deferred per user direction; revisit in a future release).
- Per-field push-to-talk voice (deferred; ⋯ → Re-mic covers the rare "fix one field" case).
- Photo capture / image-based field extraction.
- Reconciliation reports (received vs sold deltas).
- Multi-warehouse / multi-location inventory.
- Web inventory page rework.

## Testing

- **API:** integration tests per route against a real Postgres test database (no mocks) — tenant scoping, permission denial, scan upsert semantics, partial unique index enforcement (concurrent session-start race), bulk-action atomicity.
- **Desktop hooks:** unit tests for `useCaptureQueue` state transitions and `useVoiceQueue` FIFO semantics.
- **Manual smoke:** scan known UPC × 5; scan new UPC + voice; scan unknown then scan again mid-recording; close-and-reopen session (hydration); credits-exhausted scenario.

## Risks and open items

1. **Active-session uniqueness race.** Addressed by partial unique index, but the POST `/receipts` handler must catch the unique violation and return a 409 with the active session payload.
2. **AI extraction latency.** If Gemini round-trip averages > 3s per row, queues will pile up. Mitigation: parallel extraction (cap 3), visible per-row spinner, scanning never blocked.
3. **Audio MIME drift.** Chromium/Electron records webm/opus by default; the route must accept that explicitly. Mitigation: `Content-Type` allow-list with fail-fast error.
4. **Confidence scores from Gemini.** Gemini doesn't natively return per-field confidence. We prompt it to estimate and parse from JSON. If unreliable, fall back to a single "AI filled this row" indicator instead of per-field underlines (small UX hit; not blocking).
