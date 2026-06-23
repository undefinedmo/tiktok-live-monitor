# Ledger Workflow UX (features 2–7) — Design

**Date:** 2026-06-23
**Target system:** `tiktok-live-poc` (Electron main + portable `core/` + vanilla-TS renderer)
**Status:** Approved design, pending implementation plan
**Origin:** Leverage selected UX patterns from the desktop "Sales" screen (`sellerfolio-platform/desktop`, see `tiktok-live-poc/docs/desktop-sales-feature-capture.md`) into the PoC Ledger to speed the sync → cost → transcribe → pick/pack workflow.

---

## 1. Problem & context

The PoC Ledger already has: text search, status/cost/profit/price-range filters, KPI row, bulk cost (flat/percent/retail + whole-product cascade), per-product cost templates, bulk AI transcribe, picklist by show/buyer, label printing, auto exception/urgency flags, and the room-id show filter. The desktop "Sales" screen has more mature operator UX. This spec ports six of those patterns (re-implemented in the PoC's vanilla-TS renderer — the desktop is React/Tailwind, so this is pattern reuse, not code reuse).

### Current state (verified against the code)
- Ledger markup: `index.html` — toolbar row 1 (`ledgerSearch`, `ledgerCount`, `ledgerSync`, `ledgerExport`), row 2 (`ledgerShow`, `ledgerStatus`, `ledgerCostSeg`, `ledgerProfitSeg`, `ledgerMin`, `ledgerMax`, `ledgerClearFilters`), the `ledgerBulk` selection bar, `ledgerKpis` (6-col grid), `ledgerHead`/`ledgerRows`.
- `core/ledger.ts`: `LedgerFilters { q, status, cost, profit?, min?, max? }`, `Kpis`, `computeKpis(rows)`, `filterRows(rows, f)`, `statusLabel`, `profitCents`, `applyCost`.
- `renderer.ts`: `selected: Set<string>` + `updateBulkBar`, `ledgerRowEl(r)`, `editCost(r, cell)`, `renderLedger`, `sourceSales()`, and the room-id `deriveShowsFromOrders` (gives `showIdByOrder`).
- **`Sale` has no giveaway/classification field** — TikTok auction orders are all paid bids. `paymentStatus` is `paid | failed | pending` (`failed` = cancelled/refunded/reversed).

### Decisions taken during brainstorming

| Decision | Choice |
|---|---|
| Feature 6 scope | **Both**: cancelled/refunded rows get line-through + dim, AND an "exclude failed" KPI toggle (drops failed from Orders/Gross/Units/Avg). No giveaway toggle (no data). |
| Feature 4 Ctrl+K | **Jump dropdown + highlight**: focus search, top-8 dropdown, scroll-to + 1.8s flash, without touching show/cost/status filters. |
| Feature 2 context-menu actions | Select-similar (buyer/product/show) + Highlight duplicates + **Set cost** + **Transcribe**. (No print/pick/copy.) |
| Feature 3 health pills | **Uncosted + No-transcript + Failed**. (No "no AI retail".) |
| Where logic lives | New pure helpers in **`core/ledgerView.ts`**; model tweaks in `core/ledger.ts`; DOM wiring in `renderer.ts`. |

### Scope
**In scope:** features 2 (context menu + select-similar), 3 (health pills), 4 (Ctrl+K jump), 5 (cost-suggestion popover), 6 (cancelled styling + exclude-failed KPI), 7 (active-filter chips).
**Out of scope:** feature 1 (manual triage flags), giveaway/classification data, rules engine, brand cleanup/normalization, mass-edit unified modal, cache-vs-refresh modal.

---

## 2. Goals & success criteria
1. Right-clicking a ledger row opens a context menu; "select-similar" populates the existing selection Set and bulk bar; duplicates highlight; set-cost/transcribe shortcuts work.
2. Health pills show live counts and toggle their underlying filters; the new "no transcript" filter works.
3. `Ctrl/Cmd+K` on the Ledger focuses search, shows a top-8 jump dropdown, and selecting a result scrolls to + flashes that row without changing filters.
4. Editing a cost shows a suggestion popover of the product template + prior costs; clicking one fills + commits.
5. Failed/cancelled rows render struck-through + dimmed; an "exclude failed" toggle recomputes the headline KPIs (persisted).
6. An active-filter chips strip lets the user see and remove individual filters.
7. All pure helpers are vitest-covered; `npm test` green; `tsc --noEmit` clean.

---

## 3. Architecture & components

### 3.1 `core/ledger.ts` — model tweaks
- `LedgerFilters` gains `transcript?: '' | 'missing'`.
- `filterRows`: when `f.transcript === 'missing'`, drop rows whose `transcript` is present (a row has a transcript when `r.transcript` is non-null/non-empty — same source the row pill uses).
- `computeKpis(rows, opts?: { excludeFailed?: boolean })`: when `excludeFailed`, compute `orders`, `grossCents`, `units`, `avgCents`, and profit over rows with `paymentStatus !== 'failed'`; `refunds`/`refundPct` still count failed from the full input. Default (no opts) is unchanged.

### 3.2 `core/ledgerView.ts` — new pure helpers (zero DOM/electron deps)
```ts
import type { LedgerRow, LedgerFilters } from './ledger'

// F2 — select-similar + duplicates
export type SimilarBy = 'buyer' | 'product' | 'show'
export function selectSimilar(rows: LedgerRow[], anchorId: string, by: SimilarBy,
  showIdByOrder: Map<string, string>): string[]            // orderIds (incl. anchor)
export function duplicateOrderIds(rows: LedgerRow[], anchorId: string): string[]  // same productId, ≥2

// F3 — health counts
export interface HealthCounts { uncosted: number; noTranscript: number; failed: number }
export function healthCounts(rows: LedgerRow[]): HealthCounts

// F5 — cost suggestions
export interface CostSuggestion { cents: number; count: number; isTemplate: boolean }
export function costSuggestions(rows: LedgerRow[], productId: string,
  templateCents?: number): CostSuggestion[]                // distinct, sorted by count desc

// F7 — active filter chips
export interface FilterChip { key: string; label: string } // key ∈ filter field or 'show'
export function activeFilterChips(filters: LedgerFilters, showLabel: string | null): FilterChip[]
```
- `selectSimilar`: buyer → same `buyer.ttuid || buyer.username`; product → same `productId`; show → same `showIdByOrder.get(orderId)`.
- `duplicateOrderIds`: all rows sharing the anchor's `productId`; returns `[]` if only the anchor matches.
- `costSuggestions`: distinct `costCents` across rows with the same `productId` (each with its order count), plus the product template (`isTemplate: true`) when `templateCents` is provided and not already present; sorted by count desc, template first on ties.
- `activeFilterChips`: one chip per non-empty filter — `show` (when `showLabel` given), `status`, `cost` (`missing`→"Uncosted", `costed`→"Costed"), `transcript` ("No transcript"), `profit` (`pos`→"Profit", `neg`→"Loss"), `min`/`max` (combined "$min–max"), `q` ("\"text\""). Removal is handled by the renderer (maps `key`→reset).

### 3.3 Renderer wiring (`renderer.ts`) + markup (`index.html`) + CSS

**F2 context menu.** `ledgerRowEl`: `row.addEventListener('contextmenu', e => { e.preventDefault(); openLedgerCtxMenu(e, r) })`. `openLedgerCtxMenu` builds a `<div class="ctxmenu">` at the cursor, appended to `body`; dismissed on `pointerdown` outside, `Escape`, or scroll. Items call: `applySelection(selectSimilar(ledgerRows(), r.orderId, by, showIdOfLedger()))` (sets `selected`, `updateBulkBar`, `renderLedger`); `highlightDuplicates(duplicateOrderIds(...))` (sets a `highlightedDup: Set<string>` → amber row class + selects them); "Set cost…" scrolls to the row and calls `editCost`; "Transcribe" calls `transcribeProduct(r.productId, r.productName)` (disabled when `!recapEnabled`). `showIdOfLedger()` computes `deriveShowsFromOrders(sourceSales()).showIdByOrder` once per open.

**F3 health pills.** Add a pills container in the ledger toolbar (new row under row 2). Render three pills from `healthCounts(ledgerRows())`: `Uncosted N`, `No transcript N`, `Failed N`. Click toggles the bound filter (`cost:'missing'`, `transcript:'missing'`, `status:'Failed'`) on/off and re-renders; a pill gets an `on` class when its filter is active. Counts recompute on every `renderLedger`.

**F4 Ctrl+K jump.** Global `keydown`: `(e.ctrlKey||e.metaKey) && e.key==='k'` while `currentScreen==='ledger'` → `e.preventDefault()`, focus `ledgerSearch`, open `#ledgerJump` dropdown. On search `input`, populate the dropdown with up to 8 ranked matches from `sourceSales()` (match the typed query against buyer/handle/product/orderId; rank by index-of). Each item shows buyer · product · `…orderId`. `Enter` picks the top; click picks that one → `jumpToOrder(orderId)`: `scrollIntoView({block:'center'})` + add `flash` class for 1800 ms. `Escape`/blur closes the dropdown. Does not modify filters.

**F5 cost popover.** In `editCost`, after the input is placed, render a `<div class="cost-suggest">` below it from `costSuggestions(ledgerRows(), r.productId, productCostMap[r.productId])`. Each row: formatted cents + (`isTemplate ? 'template' : 'N orders'`). `mousedown` handler fills the input value and commits (sets `skip`-blur guard so the cell commits the chosen value). Empty list → no popover.

**F6 cancelled + exclude-failed.** `ledgerRowEl`: add `'cancelled'` to the row class when `r.paymentStatus==='failed'`; CSS `.ledger-row.cancelled{opacity:.5;text-decoration:line-through;}` (the print/checkbox buttons opt out of the strike via `text-decoration:none`). Add an `excludeFailed` boolean (persisted `localStorage 'tt-kpi-exclude-failed'`), surfaced as a small toggle near `ledgerKpis`; `renderLedger` passes it to `computeKpis(rows, { excludeFailed })`.

**F7 chips.** Add `#ledgerChips` strip below the filter row. On each render, build chips from `activeFilterChips(ledgerFilters, currentShowLabel())`; each chip is `label ×`; clicking × resets that filter (`key`→setter: `status`/`cost`/`transcript`/`profit`→`''`, `min`/`max`→`null`, `q`→`''` + clear input, `show`→reset to default show) then re-renders. Hidden when no chips.

**CSS (index.html `<style>`):** `.ctxmenu`, `.ctxmenu .item`/`.sep`/`.disabled`, `.health-pill`/`.on`, `.ledger-jump`/`.jump-item`, `.cost-suggest`/`.cs-item`, `.filter-chip`/`.chip-x`, `.ledger-row.cancelled`, `.ledger-row.dup`, `@keyframes flash` + `.ledger-row.flash`.

---

## 4. Data flow
```
sourceSales() ──► ledgerRows() (rows + cost/transcript) ──► filterRows(rows, ledgerFilters) ──► visibleRows ──► render
        │                          │                                   │
   deriveShows → showIdByOrder   healthCounts(rows)            activeFilterChips(filters)
        │ (F2 show-similar)        (F3 pills)                   (F7 chips)
  context menu select-similar ──► selected Set ──► existing bulk bar (cost/transcribe/pick)
  computeKpis(rows,{excludeFailed}) ──► ledgerKpis (F6)
```

---

## 5. Testing
Pure vitest specs (`core/__tests__/ledgerView.test.ts` + additions to `ledger.test.ts`):
- `selectSimilar`: by buyer (ttuid vs username fallback), by product, by show (via map); anchor included; no false matches.
- `duplicateOrderIds`: ≥2 same product returns all; lone product returns `[]`.
- `healthCounts`: uncosted/noTranscript/failed counts on a mixed set.
- `costSuggestions`: distinct values, counts, template inclusion + ordering, empty when no same-product costs.
- `activeFilterChips`: a chip per active filter; none when filters empty; min/max combined; show chip only when label given.
- `computeKpis({excludeFailed})`: headline excludes failed, refunds still counted; default unchanged.
- `filterRows` transcript: `'missing'` drops rows with a transcript.

Renderer wiring (context menu, pills, jump, popover, chips, row styling) verified by `npm test` (no regressions) + `tsc --noEmit` + manual GUI pass (user). No DOM tests (the renderer has none).

---

## 6. Risks & notes
- **Renderer growth.** `renderer.ts` is already ~1591 lines; this adds several wiring blocks. Mitigated by putting all logic in pure `core/ledgerView.ts` and keeping renderer functions small and named.
- **Show-similar correctness** depends on `deriveShowsFromOrders` (recently fixed for room-less orders) — reuse it, don't reimplement.
- **Ctrl+K vs live filter.** The existing search filters the list as you type; the jump dropdown is an overlay that scrolls/flashes a specific match — it never changes filters, only the text the user is already typing.
- **Build/test ABI.** `npm test` needs better-sqlite3 on the Node ABI; running the app needs the Electron ABI (see `docs/runtime-verification.md`). Pure-core tests are ABI-independent.
