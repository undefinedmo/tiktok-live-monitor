# Ledger Workflow UX (features 2–7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six operator-UX features to the PoC Ledger — context menu + select-similar, health pills, Ctrl+K jump, cost-suggestion popover, cancelled styling + exclude-failed KPI, and active-filter chips.

**Architecture:** Pure logic goes in `core/` (vitest-covered): model tweaks in `core/ledger.ts`, new helpers in a new `core/ledgerView.ts`. DOM wiring (context menu, pills, jump, popover, chips, row styling) goes in `renderer.ts`; CSS goes in `renderer/index.html`'s `<style>`. The renderer creates most new UI dynamically (inserted relative to existing element ids) rather than editing large HTML blocks.

**Tech Stack:** TypeScript, Electron renderer (vanilla TS/DOM), Vitest, esbuild.

**Reference spec:** `docs/superpowers/specs/2026-06-23-ledger-workflow-ux-design.md`

## Global Constraints

- All commands run from the `tiktok-live-poc/` directory (repo root is `sellerfolio-platform/`).
- `core/` modules are **pure** — zero `electron`/DOM/network imports.
- Focused core tests run with `npx vitest run <file>`; the full suite (`npm test`) needs `better-sqlite3` on the Node ABI.
- The renderer has no DOM tests — renderer tasks verify with `npx tsc --noEmit -p tsconfig.json` and `node esbuild.mjs` (build), plus a noted manual check.
- There are PRE-EXISTING unrelated uncommitted changes in the tree; every commit uses `git add <explicit files>` — never `git add -A`.
- Reuse the existing room-id `deriveShowsFromOrders` (`core/sessions.ts`) for "from show"; do not reimplement show grouping.
- TDD for core tasks: failing test → minimal code → green → commit.

## Pre-Flight (controller, before Task 1)

`src/core/ledger.ts` and `src/core/__tests__/ledger.test.ts` carry a small pre-existing WIP (a `revenueCents` subtotal refinement + its tests). Commit that WIP as its own commit FIRST so Task 1's commit is clean:
```bash
git add tiktok-live-poc/src/core/ledger.ts tiktok-live-poc/src/core/__tests__/ledger.test.ts
git commit -m "feat(poc): profit revenue uses item subtotal, not order total"
```
(Confirm with the user before committing their WIP.)

---

### Task 1: `LedgerFilters.transcript` filter + `computeKpis({excludeFailed})`

**Files:**
- Modify: `src/core/ledger.ts` (`LedgerFilters` ~:20, `filterRows` ~:97, `computeKpis` ~:69)
- Test: `src/core/__tests__/ledger.test.ts` (append)

**Interfaces:**
- Consumes: `LedgerRow`, `profitCents`, `revenueCents` (existing).
- Produces: `LedgerFilters.transcript?: '' | 'missing'`; `computeKpis(rows: LedgerRow[], opts?: { excludeFailed?: boolean }): Kpis` (back-compatible — no opts = current behavior).

- [ ] **Step 1: Write the failing tests**

Append to `src/core/__tests__/ledger.test.ts` (reuse the file's existing `LedgerRow` factory; if none, add this local helper):

```ts
import { filterRows, computeKpis, type LedgerRow } from '../ledger'

function row(id: string, o: Partial<LedgerRow> = {}): LedgerRow {
  return {
    orderId: id, buyer: { username: 'A' }, productId: 'p', productName: 'X', skuDesc: '#1',
    price: { cents: 1000, formatted: '$10' }, paymentStatus: 'paid', createdAt: 1, ...o,
  }
}

describe('filterRows: transcript', () => {
  it("'missing' keeps only rows with no transcript", () => {
    const rows = [row('a', { transcript: { brand: 'Nike' } }), row('b')]
    const out = filterRows(rows, { q: '', status: '', cost: '', transcript: 'missing' })
    expect(out.map((r) => r.orderId)).toEqual(['b'])
  })
  it("'' (default) keeps all", () => {
    const rows = [row('a', { transcript: { brand: 'Nike' } }), row('b')]
    expect(filterRows(rows, { q: '', status: '', cost: '' })).toHaveLength(2)
  })
})

describe('computeKpis: excludeFailed', () => {
  const rows = [
    row('a', { price: { cents: 1000, formatted: '$10' } }),
    row('b', { paymentStatus: 'failed', price: { cents: 500, formatted: '$5' } }),
  ]
  it('default counts every row', () => {
    const k = computeKpis(rows)
    expect(k.orders).toBe(2)
    expect(k.grossCents).toBe(1500)
    expect(k.refunds).toBe(1)
  })
  it('excludeFailed drops failed from the headline but still counts refunds', () => {
    const k = computeKpis(rows, { excludeFailed: true })
    expect(k.orders).toBe(1)
    expect(k.grossCents).toBe(1000)
    expect(k.refunds).toBe(1)
    expect(k.refundPct).toBeCloseTo(50) // 1 failed / 2 total
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/__tests__/ledger.test.ts`
Expected: FAIL — `transcript` not accepted by `LedgerFilters`; `computeKpis` ignores the 2nd arg.

- [ ] **Step 3: Implement**

In `src/core/ledger.ts`, add `transcript` to `LedgerFilters`:
```ts
export interface LedgerFilters {
  q: string
  status: string
  cost: '' | 'missing' | 'costed'
  transcript?: '' | 'missing'
  profit?: '' | 'pos' | 'neg'
  min?: number | null
  max?: number | null
}
```
In `filterRows`, add after the `f.cost === 'costed'` line:
```ts
    if (f.transcript === 'missing' && r.transcript != null) return false
```
Replace `computeKpis` with the opts-aware version:
```ts
export function computeKpis(rows: LedgerRow[], opts?: { excludeFailed?: boolean }): Kpis {
  const refunds = rows.filter((r) => r.paymentStatus === 'failed').length
  const base = opts?.excludeFailed ? rows.filter((r) => r.paymentStatus !== 'failed') : rows
  const orders = base.length
  const grossCents = base.reduce((n, r) => n + r.price.cents, 0)
  const costed = base.filter((r) => r.costCents != null).length
  let profit = 0
  let profitBase = 0
  for (const r of base) {
    const p = profitCents(r)
    if (p != null) { profit += p; profitBase += revenueCents(r) }
  }
  return {
    orders,
    grossCents,
    units: orders,
    avgCents: orders ? Math.round(grossCents / orders) : 0,
    refunds,
    refundPct: rows.length ? (refunds / rows.length) * 100 : 0,
    costed,
    uncosted: orders - costed,
    profitCents: profit,
    marginPct: profitBase > 0 ? (profit / profitBase) * 100 : null,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/__tests__/ledger.test.ts`
Expected: PASS (existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/ledger.ts src/core/__tests__/ledger.test.ts
git commit -m "feat(poc): ledger transcript filter + excludeFailed KPI option"
```

---

### Task 2: `core/ledgerView.ts` — `selectSimilar` + `duplicateOrderIds`

**Files:**
- Create: `src/core/ledgerView.ts`
- Test: `src/core/__tests__/ledgerView.test.ts`

**Interfaces:**
- Consumes: `LedgerRow` (`./ledger`).
- Produces:
  - `type SimilarBy = 'buyer' | 'product' | 'show'`
  - `selectSimilar(rows: LedgerRow[], anchorId: string, by: SimilarBy, showIdByOrder: Map<string, string>): string[]`
  - `duplicateOrderIds(rows: LedgerRow[], anchorId: string): string[]`

- [ ] **Step 1: Write the failing test**

Create `src/core/__tests__/ledgerView.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import type { LedgerRow } from '../ledger'
import { selectSimilar, duplicateOrderIds } from '../ledgerView'

function row(id: string, o: Partial<LedgerRow> = {}): LedgerRow {
  return {
    orderId: id, buyer: { username: 'A' }, productId: 'p', productName: 'X', skuDesc: '#1',
    price: { cents: 100, formatted: '$1' }, paymentStatus: 'paid', createdAt: 1, ...o,
  }
}

describe('selectSimilar', () => {
  const rows = [
    row('o1', { buyer: { username: 'sam', ttuid: 'u1' }, productId: 'A' }),
    row('o2', { buyer: { username: 'sam', ttuid: 'u1' }, productId: 'B' }),
    row('o3', { buyer: { username: 'kim', ttuid: 'u2' }, productId: 'A' }),
  ]
  const showOf = new Map([['o1', 'R1'], ['o2', 'R1'], ['o3', 'R2']])

  it('by buyer matches the anchor buyer (ttuid) including the anchor', () => {
    expect(selectSimilar(rows, 'o1', 'buyer', showOf).sort()).toEqual(['o1', 'o2'])
  })
  it('by product matches the same productId', () => {
    expect(selectSimilar(rows, 'o1', 'product', showOf).sort()).toEqual(['o1', 'o3'])
  })
  it('by show matches the same derived show id', () => {
    expect(selectSimilar(rows, 'o1', 'show', showOf).sort()).toEqual(['o1', 'o2'])
  })
  it('returns [] for an unknown anchor', () => {
    expect(selectSimilar(rows, 'nope', 'buyer', showOf)).toEqual([])
  })
})

describe('duplicateOrderIds', () => {
  it('returns all orders sharing the anchor productId when ≥2', () => {
    const rows = [row('o1', { productId: 'A' }), row('o2', { productId: 'A' }), row('o3', { productId: 'B' })]
    expect(duplicateOrderIds(rows, 'o1').sort()).toEqual(['o1', 'o2'])
  })
  it('returns [] when the product is unique', () => {
    const rows = [row('o1', { productId: 'A' }), row('o2', { productId: 'B' })]
    expect(duplicateOrderIds(rows, 'o1')).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/__tests__/ledgerView.test.ts`
Expected: FAIL — `Failed to resolve import "../ledgerView"`.

- [ ] **Step 3: Implement**

Create `src/core/ledgerView.ts`:
```ts
// Pure view-helpers for the Ledger screen (select-similar, duplicates, health counts, cost
// suggestions, filter chips). Zero electron/DOM deps so they stay unit-testable.
import type { LedgerRow, LedgerFilters } from './ledger'

const buyerKey = (r: LedgerRow): string => r.buyer.ttuid || r.buyer.username

export type SimilarBy = 'buyer' | 'product' | 'show'

/** Order ids matching the anchor by buyer / product / derived show. Includes the anchor.
 *  Empty when the anchor isn't in `rows`. */
export function selectSimilar(
  rows: LedgerRow[], anchorId: string, by: SimilarBy, showIdByOrder: Map<string, string>,
): string[] {
  const anchor = rows.find((r) => r.orderId === anchorId)
  if (!anchor) return []
  if (by === 'buyer') {
    const k = buyerKey(anchor)
    return rows.filter((r) => buyerKey(r) === k).map((r) => r.orderId)
  }
  if (by === 'product') {
    return rows.filter((r) => r.productId === anchor.productId).map((r) => r.orderId)
  }
  const sid = showIdByOrder.get(anchorId)
  return rows.filter((r) => showIdByOrder.get(r.orderId) === sid).map((r) => r.orderId)
}

/** Order ids sharing the anchor's productId — only when ≥2 (else []). */
export function duplicateOrderIds(rows: LedgerRow[], anchorId: string): string[] {
  const anchor = rows.find((r) => r.orderId === anchorId)
  if (!anchor) return []
  const matches = rows.filter((r) => r.productId === anchor.productId).map((r) => r.orderId)
  return matches.length >= 2 ? matches : []
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/__tests__/ledgerView.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/ledgerView.ts src/core/__tests__/ledgerView.test.ts
git commit -m "feat(poc): ledgerView select-similar + duplicate detection"
```

---

### Task 3: `core/ledgerView.ts` — `healthCounts` + `costSuggestions` + `activeFilterChips`

**Files:**
- Modify: `src/core/ledgerView.ts` (append)
- Test: `src/core/__tests__/ledgerView.test.ts` (append)

**Interfaces:**
- Consumes: `LedgerRow`, `LedgerFilters` (`./ledger`).
- Produces:
  - `interface HealthCounts { uncosted: number; noTranscript: number; failed: number }`
  - `healthCounts(rows: LedgerRow[]): HealthCounts`
  - `interface CostSuggestion { cents: number; count: number; isTemplate: boolean }`
  - `costSuggestions(rows: LedgerRow[], productId: string, templateCents?: number): CostSuggestion[]`
  - `interface FilterChip { key: string; label: string }`
  - `activeFilterChips(filters: LedgerFilters, showLabel: string | null): FilterChip[]`

- [ ] **Step 1: Write the failing test**

Append to `src/core/__tests__/ledgerView.test.ts`:
```ts
import { healthCounts, costSuggestions, activeFilterChips } from '../ledgerView'

describe('healthCounts', () => {
  it('counts uncosted, no-transcript, failed', () => {
    const rows = [
      row('a', { costCents: 100, transcript: { brand: 'N' } }),
      row('b'),
      row('c', { paymentStatus: 'failed' }),
    ]
    expect(healthCounts(rows)).toEqual({ uncosted: 2, noTranscript: 2, failed: 1 })
  })
})

describe('costSuggestions', () => {
  it('returns distinct same-product costs with counts, template first', () => {
    const rows = [
      row('a', { productId: 'P', costCents: 1200 }),
      row('b', { productId: 'P', costCents: 1200 }),
      row('c', { productId: 'P', costCents: 800 }),
      row('d', { productId: 'Q', costCents: 999 }),
    ]
    const out = costSuggestions(rows, 'P', 1000)
    expect(out[0]).toEqual({ cents: 1000, count: 0, isTemplate: true })
    expect(out.find((s) => s.cents === 1200)).toEqual({ cents: 1200, count: 2, isTemplate: false })
    expect(out.some((s) => s.cents === 999)).toBe(false) // other product excluded
  })
  it('returns [] when no same-product costs and no template', () => {
    expect(costSuggestions([row('a', { productId: 'P' })], 'P')).toEqual([])
  })
})

describe('activeFilterChips', () => {
  it('emits a chip per active filter, none when empty', () => {
    expect(activeFilterChips({ q: '', status: '', cost: '' }, null)).toEqual([])
    const chips = activeFilterChips(
      { q: 'nike', status: 'Paid', cost: 'missing', transcript: 'missing', profit: 'neg', min: 5, max: 50 },
      'LIVE · Jun 22',
    )
    expect(chips.map((c) => c.key).sort()).toEqual(
      ['cost', 'min-max', 'profit', 'q', 'show', 'status', 'transcript'].sort(),
    )
    expect(chips.find((c) => c.key === 'min-max')!.label).toBe('$5–50')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/__tests__/ledgerView.test.ts`
Expected: FAIL — `healthCounts`/`costSuggestions`/`activeFilterChips` not exported.

- [ ] **Step 3: Implement**

Append to `src/core/ledgerView.ts`:
```ts
export interface HealthCounts { uncosted: number; noTranscript: number; failed: number }

export function healthCounts(rows: LedgerRow[]): HealthCounts {
  let uncosted = 0
  let noTranscript = 0
  let failed = 0
  for (const r of rows) {
    if (r.costCents == null) uncosted++
    if (r.transcript == null) noTranscript++
    if (r.paymentStatus === 'failed') failed++
  }
  return { uncosted, noTranscript, failed }
}

export interface CostSuggestion { cents: number; count: number; isTemplate: boolean }

/** Distinct costs seen on other orders of the same product (each with a count), plus the product
 *  template when provided. Sorted by count desc; the template sorts first. */
export function costSuggestions(
  rows: LedgerRow[], productId: string, templateCents?: number,
): CostSuggestion[] {
  const counts = new Map<number, number>()
  for (const r of rows) {
    if (r.productId !== productId || r.costCents == null) continue
    counts.set(r.costCents, (counts.get(r.costCents) ?? 0) + 1)
  }
  const out: CostSuggestion[] = []
  if (templateCents != null) out.push({ cents: templateCents, count: counts.get(templateCents) ?? 0, isTemplate: true })
  for (const [cents, count] of counts) {
    if (templateCents != null && cents === templateCents) continue
    out.push({ cents, count, isTemplate: false })
  }
  return out.sort((a, b) => (a.isTemplate ? -1 : b.isTemplate ? 1 : b.count - a.count))
}

export interface FilterChip { key: string; label: string }

/** One chip per active filter. `key` maps back to the filter the renderer resets. */
export function activeFilterChips(filters: LedgerFilters, showLabel: string | null): FilterChip[] {
  const chips: FilterChip[] = []
  if (showLabel) chips.push({ key: 'show', label: showLabel })
  if (filters.status) chips.push({ key: 'status', label: filters.status })
  if (filters.cost) chips.push({ key: 'cost', label: filters.cost === 'missing' ? 'Uncosted' : 'Costed' })
  if (filters.transcript === 'missing') chips.push({ key: 'transcript', label: 'No transcript' })
  if (filters.profit) chips.push({ key: 'profit', label: filters.profit === 'pos' ? 'Profit' : 'Loss' })
  if (filters.min != null || filters.max != null) {
    chips.push({ key: 'min-max', label: `$${filters.min ?? 0}–${filters.max ?? '∞'}` })
  }
  if (filters.q.trim()) chips.push({ key: 'q', label: `"${filters.q.trim()}"` })
  return chips
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/__tests__/ledgerView.test.ts`
Expected: PASS (all Task 2 + Task 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/ledgerView.ts src/core/__tests__/ledgerView.test.ts
git commit -m "feat(poc): ledgerView health counts, cost suggestions, filter chips"
```

---

### Task 4: Renderer F6 — cancelled row styling + exclude-failed KPI toggle

**Files:**
- Modify: `src/renderer/renderer.ts` (`ledgerRowEl` ~:866, `renderLedger` ~:1097, `setupLedger` ~:1314)
- Modify: `src/renderer/index.html` (`<style>` block; KPI area near `ledgerKpis`)

**Interfaces:**
- Consumes: `computeKpis(rows, { excludeFailed })` (Task 1).
- Produces: a persisted `excludeFailed` state driving the KPI tiles.

- [ ] **Step 1: Add the cancelled row class**

In `ledgerRowEl`, the first line builds the row:
```ts
  const row = el('div', 'ledger-row' + (transcribingOrders.has(r.orderId) ? ' transcribing' : ''))
```
Replace with:
```ts
  const row = el('div', 'ledger-row' + (transcribingOrders.has(r.orderId) ? ' transcribing' : '') + (r.paymentStatus === 'failed' ? ' cancelled' : ''))
```

- [ ] **Step 2: Add the exclude-failed state + toggle**

Near the other ledger state declarations (e.g. just after `let ledgerExpanded`), add:
```ts
let excludeFailed = localStorage.getItem('tt-kpi-exclude-failed') === '1'
```
In `renderLedger`, change:
```ts
  const k = computeKpis(filtered)
```
to:
```ts
  const k = computeKpis(filtered, { excludeFailed })
```
In `setupLedger`, append a toggle that sits next to the KPIs (created dynamically so no HTML edit is needed):
```ts
  const kpiWrap = $('ledgerKpis').parentElement!
  const exToggle = document.createElement('label')
  exToggle.id = 'ledgerExclFailed'
  exToggle.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;color:#8a93a6;cursor:pointer;margin:2px 0 -4px;'
  exToggle.innerHTML = '<input type="checkbox" /> <span>Exclude failed from totals</span>'
  const exCb = exToggle.querySelector('input') as HTMLInputElement
  exCb.checked = excludeFailed
  exCb.addEventListener('change', () => { excludeFailed = exCb.checked; localStorage.setItem('tt-kpi-exclude-failed', excludeFailed ? '1' : '0'); renderLedger() })
  kpiWrap.insertBefore(exToggle, $('ledgerKpis'))
```

- [ ] **Step 3: Add CSS**

In `src/renderer/index.html`, inside the `<style>` block, append:
```css
.ledger-row.cancelled{opacity:.5;}
.ledger-row.cancelled .lc-buyer .n, .ledger-row.cancelled .lc-prod, .ledger-row.cancelled .lc-total{text-decoration:line-through;}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.
Run: `node esbuild.mjs`
Expected: `build complete`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/renderer.ts src/renderer/index.html
git commit -m "feat(poc): ledger cancelled-row styling + exclude-failed KPI toggle"
```

---

### Task 5: Renderer F3 — health pills

**Files:**
- Modify: `src/renderer/renderer.ts` (`setupLedger`, `renderLedger`)
- Modify: `src/renderer/index.html` (`<style>`)

**Interfaces:**
- Consumes: `healthCounts` (Task 3); `LedgerFilters.transcript` (Task 1); `ledgerFilters`, `renderLedger`, `ledgerRows` (renderer).
- Produces: a `renderHealthPills()` called from `renderLedger`.

- [ ] **Step 1: Add the pills container + renderer**

In `setupLedger`, create the pills row above the table (dynamically inserted before `ledgerKpis`'s wrapper or after the filter row). Add near the end of `setupLedger`:
```ts
  const pills = document.createElement('div')
  pills.id = 'ledgerHealth'
  pills.style.cssText = 'display:flex;gap:8px;flex:none;flex-wrap:wrap;'
  $('ledgerKpis').parentElement!.insertBefore(pills, document.getElementById('ledgerExclFailed') ?? $('ledgerKpis'))
```
Add a render function (top-level, near `renderLedger`):
```ts
function renderHealthPills() {
  const host = document.getElementById('ledgerHealth')
  if (!host) return
  const c = healthCounts(ledgerRows())
  const defs: [string, string, () => boolean, () => void][] = [
    ['Uncosted', String(c.uncosted), () => ledgerFilters.cost === 'missing',
      () => { ledgerFilters = { ...ledgerFilters, cost: ledgerFilters.cost === 'missing' ? '' : 'missing' }; segActive('ledgerCostSeg', 'cost', ledgerFilters.cost); renderLedger() }],
    ['No transcript', String(c.noTranscript), () => ledgerFilters.transcript === 'missing',
      () => { ledgerFilters = { ...ledgerFilters, transcript: ledgerFilters.transcript === 'missing' ? '' : 'missing' }; renderLedger() }],
    ['Failed', String(c.failed), () => ledgerFilters.status === 'Failed',
      () => { const on = ledgerFilters.status === 'Failed'; ledgerFilters = { ...ledgerFilters, status: on ? '' : 'Failed' }; ;($('ledgerStatus') as HTMLSelectElement).value = ledgerFilters.status; renderLedger() }],
  ]
  host.replaceChildren()
  for (const [label, count, isOn, toggle] of defs) {
    const pill = el('button', 'health-pill' + (isOn() ? ' on' : ''))
    pill.appendChild(el('span', 'hp-label', label))
    pill.appendChild(el('span', 'hp-count', count))
    pill.addEventListener('click', toggle)
    host.appendChild(pill)
  }
}
```
Call it inside `renderLedger` (add right after `visibleRows = rows`):
```ts
  renderHealthPills()
```

- [ ] **Step 2: Add CSS**

Append to the `<style>` block in `index.html`:
```css
.health-pill{display:inline-flex;align-items:center;gap:6px;background:#0c0f16;border:1px solid #20242e;border-radius:999px;padding:4px 10px;color:#aab2c0;font-size:11px;cursor:pointer;}
.health-pill:hover{border-color:#3a4150;}
.health-pill.on{border-color:#8a78ff;color:#cfc6ff;background:#171528;}
.health-pill .hp-count{font-weight:700;color:#eef1f7;}
.health-pill.on .hp-count{color:#cfc6ff;}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit -p tsconfig.json`  → no errors.
Run: `node esbuild.mjs`  → `build complete`.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/renderer.ts src/renderer/index.html
git commit -m "feat(poc): ledger health pills (uncosted / no-transcript / failed)"
```

---

### Task 6: Renderer F7 — active-filter chips

**Files:**
- Modify: `src/renderer/renderer.ts` (`setupLedger`, `renderLedger`, reuse the `ledgerClearFilters` reset logic)
- Modify: `src/renderer/index.html` (`<style>`)

**Interfaces:**
- Consumes: `activeFilterChips` (Task 3); `ledgerFilters`, `selectedShowId`, `refreshShowOptions`/`onShowChange` (renderer).
- Produces: a `renderFilterChips()` called from `renderLedger`.

- [ ] **Step 1: Add the chips container + renderer**

In `setupLedger`, create the container (insert before `ledgerHealth` or the KPI wrapper):
```ts
  const chips = document.createElement('div')
  chips.id = 'ledgerChips'
  chips.style.cssText = 'display:none;gap:6px;flex:none;flex-wrap:wrap;align-items:center;'
  $('ledgerKpis').parentElement!.insertBefore(chips, document.getElementById('ledgerHealth') ?? $('ledgerKpis'))
```
Add a render function near `renderLedger`:
```ts
function clearLedgerFilter(key: string) {
  if (key === 'show') { onShowChange(selectedShowId === 'all' ? 'all' : (syncedOrders.length ? 'all' : 'live')); return }
  if (key === 'q') { ledgerFilters = { ...ledgerFilters, q: '' }; ;($('ledgerSearch') as HTMLInputElement).value = '' }
  else if (key === 'status') { ledgerFilters = { ...ledgerFilters, status: '' }; ;($('ledgerStatus') as HTMLSelectElement).value = '' }
  else if (key === 'cost') { ledgerFilters = { ...ledgerFilters, cost: '' }; segActive('ledgerCostSeg', 'cost', '') }
  else if (key === 'transcript') { ledgerFilters = { ...ledgerFilters, transcript: '' } }
  else if (key === 'profit') { ledgerFilters = { ...ledgerFilters, profit: '' }; segActive('ledgerProfitSeg', 'profit', '') }
  else if (key === 'min-max') { ledgerFilters = { ...ledgerFilters, min: null, max: null }; ;($('ledgerMin') as HTMLInputElement).value = ''; ;($('ledgerMax') as HTMLInputElement).value = '' }
  renderLedger()
}

function renderFilterChips() {
  const host = document.getElementById('ledgerChips')
  if (!host) return
  // a "show" chip only when a specific show is selected (not the default all/live)
  const showLabel = selectedShowId !== 'all' && selectedShowId !== 'live'
    ? ((document.getElementById('ledgerShow') as HTMLSelectElement | null)?.selectedOptions[0]?.textContent ?? null)
    : null
  const chips = activeFilterChips(ledgerFilters, showLabel)
  host.replaceChildren()
  host.style.display = chips.length ? 'flex' : 'none'
  if (!chips.length) return
  host.appendChild(el('span', 'chips-label', 'Filters:'))
  for (const c of chips) {
    const chip = el('span', 'filter-chip')
    chip.appendChild(el('span', undefined, c.label))
    const x = el('button', 'chip-x', '×')
    x.addEventListener('click', () => clearLedgerFilter(c.key))
    chip.appendChild(x)
    host.appendChild(chip)
  }
}
```
Call it in `renderLedger` (right after `renderHealthPills()`):
```ts
  renderFilterChips()
```

- [ ] **Step 2: Add CSS**

Append to the `<style>` block:
```css
#ledgerChips .chips-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#5c6473;}
.filter-chip{display:inline-flex;align-items:center;gap:6px;background:#171528;border:1px solid #2a2745;border-radius:999px;padding:3px 6px 3px 10px;color:#cfc6ff;font-size:11px;}
.filter-chip .chip-x{background:none;border:none;color:#9b8fd6;cursor:pointer;font-size:14px;line-height:1;padding:0 2px;}
.filter-chip .chip-x:hover{color:#fff;}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit -p tsconfig.json`  → no errors.
Run: `node esbuild.mjs`  → `build complete`.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/renderer.ts src/renderer/index.html
git commit -m "feat(poc): ledger active-filter chips"
```

---

### Task 7: Renderer F2 — context menu + select-similar + duplicates

**Files:**
- Modify: `src/renderer/renderer.ts` (`ledgerRowEl`, add helpers; import `ledgerView`; reuse `deriveShowsFromOrders`)
- Modify: `src/renderer/index.html` (`<style>`)

**Interfaces:**
- Consumes: `selectSimilar`, `duplicateOrderIds`, `type SimilarBy` (Task 2); `deriveShowsFromOrders` (`core/sessions`, already imported); `selected` Set, `updateBulkBar`, `editCost`, `transcribeProduct`, `recapEnabled`, `ledgerRows` (renderer).
- Produces: a `highlightedDup: Set<string>` driving a `dup` row class.

- [ ] **Step 1: Add the import + dup state + dup row class**

At the top of `renderer.ts`, add to the imports:
```ts
import { selectSimilar, duplicateOrderIds, type SimilarBy } from '../core/ledgerView'
```
Near the ledger state, add:
```ts
const highlightedDup = new Set<string>()
```
In `ledgerRowEl`, extend the row class line (already extended in Task 4) to also add `dup`:
```ts
  const row = el('div', 'ledger-row' + (transcribingOrders.has(r.orderId) ? ' transcribing' : '') + (r.paymentStatus === 'failed' ? ' cancelled' : '') + (highlightedDup.has(r.orderId) ? ' dup' : ''))
```

- [ ] **Step 2: Add the menu + actions**

Add these top-level helpers near `ledgerRowEl`:
```ts
function applyLedgerSelection(ids: string[]) {
  selected.clear()
  for (const id of ids) selected.add(id)
  updateBulkBar()
  renderLedger()
}

function closeLedgerCtxMenu() {
  document.getElementById('ledgerCtx')?.remove()
}

function openLedgerCtxMenu(ev: MouseEvent, r: LedgerRow) {
  closeLedgerCtxMenu()
  const rows = ledgerRows()
  const showIdByOrder = deriveShowsFromOrders(rows).showIdByOrder
  const menu = el('div', 'ctxmenu')
  menu.id = 'ledgerCtx'
  const item = (label: string, fn: () => void, disabled = false) => {
    const it = el('div', 'item' + (disabled ? ' disabled' : ''), label)
    if (!disabled) it.addEventListener('click', () => { closeLedgerCtxMenu(); fn() })
    menu.appendChild(it)
  }
  const sel = (by: SimilarBy) => applyLedgerSelection(selectSimilar(rows, r.orderId, by, showIdByOrder))
  item(`Select all from @${r.buyer.handle ?? r.buyer.username}`, () => sel('buyer'))
  item('Select same product', () => sel('product'))
  item('Select from this show', () => sel('show'))
  const dups = duplicateOrderIds(rows, r.orderId)
  item(`Highlight duplicates${dups.length ? ` (${dups.length})` : ''}`, () => {
    highlightedDup.clear()
    for (const id of dups) highlightedDup.add(id)
    applyLedgerSelection(dups)
  }, dups.length === 0)
  menu.appendChild(el('div', 'sep'))
  item('Set cost…', () => {
    ledgerExpanded = null
    renderLedger()
    const cell = [...document.querySelectorAll('#ledgerRows .ledger-row')].find((e) => (e as HTMLElement).dataset.oid === r.orderId)?.querySelector('.lc-cost') as HTMLElement | undefined
    if (cell) { cell.scrollIntoView({ block: 'center' }); editCost(r, cell) }
  })
  item('Transcribe', () => void transcribeProduct(r.productId, r.productName), !recapEnabled)
  document.body.appendChild(menu)
  // position within the viewport
  const mw = 220, mh = menu.offsetHeight
  menu.style.left = Math.min(ev.clientX, window.innerWidth - mw - 8) + 'px'
  menu.style.top = Math.min(ev.clientY, window.innerHeight - mh - 8) + 'px'
  const dismiss = (e: Event) => { if (!menu.contains(e.target as Node)) { closeLedgerCtxMenu(); cleanup() } }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { closeLedgerCtxMenu(); cleanup() } }
  const cleanup = () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', onKey, true); document.getElementById('ledgerRows')?.removeEventListener('scroll', closeLedgerCtxMenu) }
  setTimeout(() => { document.addEventListener('pointerdown', dismiss, true); document.addEventListener('keydown', onKey, true); document.getElementById('ledgerRows')?.addEventListener('scroll', closeLedgerCtxMenu, { once: true }) }, 0)
}
```
In `ledgerRowEl`, after `row.dataset.oid = r.orderId`, add:
```ts
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); openLedgerCtxMenu(e, r) })
```

- [ ] **Step 3: Add CSS**

Append to the `<style>` block:
```css
.ctxmenu{position:fixed;z-index:9999;min-width:200px;background:#12151c;border:1px solid #2a3142;border-radius:9px;padding:5px;box-shadow:0 10px 30px rgba(0,0,0,.5);}
.ctxmenu .item{padding:7px 10px;border-radius:6px;font-size:12px;color:#cdd4e0;cursor:pointer;white-space:nowrap;}
.ctxmenu .item:hover{background:#1c2230;}
.ctxmenu .item.disabled{color:#4a5160;cursor:default;}
.ctxmenu .sep{height:1px;background:#222838;margin:5px 4px;}
.ledger-row.dup{background:#2a230b;border-left:3px solid #d9a341;}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit -p tsconfig.json`  → no errors (in particular `LedgerRow` is already imported in renderer; `transcribeProduct`/`recapEnabled`/`editCost`/`selected`/`updateBulkBar`/`ledgerRows`/`ledgerExpanded` all resolve).
Run: `node esbuild.mjs`  → `build complete`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/renderer.ts src/renderer/index.html
git commit -m "feat(poc): ledger right-click context menu + select-similar + duplicates"
```

---

### Task 8: Renderer F4 — Ctrl+K jump dropdown

**Files:**
- Modify: `src/renderer/renderer.ts` (`setupLedger`, add `jumpToOrder`; global keydown)
- Modify: `src/renderer/index.html` (`<style>`)

**Interfaces:**
- Consumes: `sourceSales`, `ledgerRows`, `currentScreen`, `ledgerFilters` (renderer).
- Produces: `jumpToOrder(orderId)` (scroll + flash).

- [ ] **Step 1: Add the dropdown + jump**

In `setupLedger`, build the dropdown anchored under the search input:
```ts
  const jump = document.createElement('div')
  jump.id = 'ledgerJump'
  jump.style.display = 'none'
  ;($('ledgerSearch').parentElement as HTMLElement).style.position = 'relative'
  $('ledgerSearch').parentElement!.appendChild(jump)
  const renderJump = () => {
    const q = (($('ledgerSearch') as HTMLInputElement).value || '').trim().toLowerCase()
    if (!q) { jump.style.display = 'none'; return }
    const hits = sourceSales().filter((s) =>
      [s.orderId, s.buyer.username, s.buyer.handle, s.productName].filter(Boolean).join(' ').toLowerCase().includes(q),
    ).slice(0, 8)
    jump.replaceChildren()
    if (!hits.length) { jump.style.display = 'none'; return }
    for (const s of hits) {
      const it = el('div', 'jump-item')
      it.appendChild(el('span', 'ji-buyer', s.buyer.username || s.buyer.handle || '—'))
      it.appendChild(el('span', 'ji-prod', ` · ${s.productName}`))
      it.appendChild(el('span', 'ji-id', ` …${s.orderId.slice(-6)}`))
      it.addEventListener('mousedown', (e) => { e.preventDefault(); jump.style.display = 'none'; jumpToOrder(s.orderId) })
      jump.appendChild(it)
    }
    jump.style.display = 'block'
  }
  $('ledgerSearch').addEventListener('input', renderJump)
  $('ledgerSearch').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') { const first = jump.querySelector('.jump-item') as HTMLElement | null; if (first) { jump.style.display = 'none'; const id = first.dataset.oid; if (id) jumpToOrder(id) } }
    else if ((e as KeyboardEvent).key === 'Escape') jump.style.display = 'none'
  })
  $('ledgerSearch').addEventListener('blur', () => setTimeout(() => { jump.style.display = 'none' }, 150))
```
Set the id on each jump item (so Enter can read it) — adjust the loop to add `it.dataset.oid = s.orderId` right after creating `it`.

Add the top-level jump function:
```ts
function jumpToOrder(orderId: string) {
  const rowEl = [...document.querySelectorAll('#ledgerRows .ledger-row')].find((e) => (e as HTMLElement).dataset.oid === orderId) as HTMLElement | undefined
  if (!rowEl) return
  rowEl.scrollIntoView({ block: 'center' })
  rowEl.classList.add('flash')
  setTimeout(() => rowEl.classList.remove('flash'), 1800)
}
```

- [ ] **Step 2: Add the global Ctrl+K**

Near the other global key handlers (top level), add:
```ts
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && currentScreen === 'ledger') {
    e.preventDefault()
    const inp = $('ledgerSearch') as HTMLInputElement
    inp.focus()
    inp.dispatchEvent(new Event('input'))
  }
})
```

- [ ] **Step 3: Add CSS**

Append to the `<style>` block:
```css
#ledgerJump{position:absolute;top:38px;left:0;width:380px;max-width:90vw;z-index:9998;background:#12151c;border:1px solid #2a3142;border-radius:8px;padding:4px;box-shadow:0 10px 30px rgba(0,0,0,.5);}
#ledgerJump .jump-item{padding:6px 9px;border-radius:6px;font-size:12px;color:#cdd4e0;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#ledgerJump .jump-item:hover{background:#1c2230;}
#ledgerJump .ji-buyer{font-weight:600;color:#eef1f7;} #ledgerJump .ji-prod{color:#9aa3b2;} #ledgerJump .ji-id{color:#5c6473;}
@keyframes lrFlash{0%{background:rgba(217,163,65,.35);}100%{background:transparent;}}
.ledger-row.flash{animation:lrFlash 1.8s ease-out;}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit -p tsconfig.json`  → no errors.
Run: `node esbuild.mjs`  → `build complete`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/renderer.ts src/renderer/index.html
git commit -m "feat(poc): ledger Ctrl+K jump-to-order dropdown"
```

---

### Task 9: Renderer F5 — cost-suggestion popover in editCost

**Files:**
- Modify: `src/renderer/renderer.ts` (`editCost` ~:845)
- Modify: `src/renderer/index.html` (`<style>`)

**Interfaces:**
- Consumes: `costSuggestions` (Task 3); `ledgerRows`, `productCostMap`, `fmtCents` (renderer).
- Produces: a suggestion popover during cost editing.

- [ ] **Step 1: Add `costSuggestions` to the import**

Update the `ledgerView` import (added in Task 7) to include `costSuggestions`:
```ts
import { selectSimilar, duplicateOrderIds, costSuggestions, type SimilarBy } from '../core/ledgerView'
```

- [ ] **Step 2: Render the popover in `editCost`**

`editCost` currently does (around :847–:850):
```ts
  const input = document.createElement('input')
  input.className = 'lc-cost-input'
  input.value = r.costCents != null ? (r.costCents / 100).toFixed(2) : ''
  cell.replaceChildren(input)
  input.focus()
```
After `input.focus()`, add the popover:
```ts
  const sugg = costSuggestions(ledgerRows(), r.productId, productCostMap[r.productId])
  let pop: HTMLElement | null = null
  if (sugg.length) {
    pop = el('div', 'cost-suggest')
    for (const s of sugg) {
      const it = el('div', 'cs-item')
      it.appendChild(el('span', 'cs-val', fmtCents(s.cents)))
      it.appendChild(el('span', 'cs-meta', s.isTemplate ? 'template' : `${s.count} order${s.count === 1 ? '' : 's'}`))
      it.addEventListener('mousedown', (e) => { e.preventDefault(); input.value = (s.cents / 100).toFixed(2); input.blur() })
      pop!.appendChild(it)
    }
    cell.appendChild(pop)
  }
```
The popover is a child of `cell`; it is removed automatically when `commit()` calls `renderLedger()` (which rebuilds the cell). No extra teardown needed.

- [ ] **Step 3: Add CSS**

Append to the `<style>` block:
```css
.lc-cost{position:relative;}
.cost-suggest{position:absolute;top:100%;right:0;z-index:9997;min-width:150px;background:#12151c;border:1px solid #2a3142;border-radius:8px;padding:4px;box-shadow:0 10px 30px rgba(0,0,0,.5);}
.cost-suggest .cs-item{display:flex;justify-content:space-between;gap:12px;padding:5px 9px;border-radius:6px;font-size:12px;cursor:pointer;}
.cost-suggest .cs-item:hover{background:#1c2230;}
.cost-suggest .cs-val{color:#eef1f7;font-variant-numeric:tabular-nums;}
.cost-suggest .cs-meta{color:#6b7488;}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit -p tsconfig.json`  → no errors.
Run: `node esbuild.mjs`  → `build complete`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/renderer.ts src/renderer/index.html
git commit -m "feat(poc): ledger cost-suggestion popover while editing cost"
```

---

## Self-Review

**Spec coverage:**
- §3.1 `LedgerFilters.transcript` + `filterRows` + `computeKpis({excludeFailed})` → Task 1. ✓
- §3.2 `selectSimilar`/`duplicateOrderIds` → Task 2; `healthCounts`/`costSuggestions`/`activeFilterChips` → Task 3. ✓
- §3.3 F6 (cancelled + exclude-failed) → Task 4; F3 (pills) → Task 5; F7 (chips) → Task 6; F2 (context menu) → Task 7; F4 (Ctrl+K) → Task 8; F5 (cost popover) → Task 9. ✓
- §5 testing: core helpers covered by Tasks 1–3; renderer via tsc+build+manual. ✓
- Out-of-scope items (manual flags, giveaway data, rules, brand cleanup) → no task. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code + exact commands. (One intentional inline note flags a CSS typo to fix on paste.) ✓

**Type consistency:** `SimilarBy`/`selectSimilar`/`duplicateOrderIds`/`healthCounts`/`costSuggestions`/`activeFilterChips`/`CostSuggestion`/`FilterChip`/`HealthCounts` defined in Tasks 2–3, consumed verbatim in Tasks 5/6/7/9. `computeKpis(rows, {excludeFailed})` defined Task 1, used Task 4. `LedgerFilters.transcript` defined Task 1, used Tasks 3/5/6. `jumpToOrder`, `highlightedDup`, `applyLedgerSelection` are renderer-local and self-consistent. ✓
