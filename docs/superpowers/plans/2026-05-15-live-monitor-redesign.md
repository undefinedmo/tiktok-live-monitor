# Live Monitor Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Live Monitor redesign — add Unique Buyers + Top Buyers, collapse settings panels into header strips, em-dash + GraphQL backfill for auctions with missing bid data.

**Architecture:** Mostly renderer-side changes in `desktop/src/pages/LiveMonitor.tsx`, with a small extracted helper for Top Buyers aggregation. Backfill spans Prisma schema, two web API routes, the Whatnot listener script, a new IPC handler, and a renderer-side single-flight queue.

**Tech Stack:** React 19 + TypeScript (renderer), Electron 33 (main), Next.js 16 + Prisma 7 (web API), Vitest (web tests).

**Source spec:** `docs/superpowers/specs/2026-05-14-live-monitor-redesign-design.md`

---

## File Structure

| File | Status | Responsibility |
|------|--------|---------------|
| `desktop/src/lib/buyer-stats.ts` | Create | Pure helper: aggregate per-buyer item count + spend from auctions + sales |
| `desktop/src/lib/buyer-stats.test.ts` | Create | Vitest unit tests for the helper |
| `desktop/vitest.config.ts` | Create | Minimal vitest config so the helper test runs |
| `desktop/package.json` | Modify | Add `test` script + vitest devDep |
| `desktop/src/pages/LiveMonitor.tsx` | Modify | Stats card, Top Buyers panel, collapsed `<details>` strips, em-dash, backfill effect, layout reorder |
| `desktop/electron/ipc/label-generator.ts` | Modify | `finalizeAuction()` sets `needsBackfill: true` on the fallback branch |
| `desktop/electron/ipc/live-stats.ts` | Modify | New `whatnot-auction-backfill` IPC handler |
| `desktop/electron/preload.ts` | Modify | Expose `liveStatsAPI.backfillAuction()` + window type |
| `web/src/app/api/live-auctions/route.ts` | Modify | Accept `needsBackfill` on POST |
| `web/src/app/api/live-auctions/[id]/route.ts` | Create | PATCH handler for backfill updates |
| `web/tests/api/live-auctions/post.test.ts` | Create | Test that POST persists `needsBackfill` |
| `web/tests/api/live-auctions/patch.test.ts` | Create | Test that PATCH updates an existing auction's totals |
| `web/prisma/schema.prisma` | Modify | Add `needsBackfill Boolean @default(false)` to `LiveAuction` |
| `web/prisma/migrations/<ts>_live_auction_backfill_flag/migration.sql` | Create | Additive column migration |

Top Buyers aggregation is the only piece of derivation logic worth extracting — it's pure, has clear inputs/outputs, and benefits from unit tests. Everything else stays inline in `LiveMonitor.tsx` since pulling it out would obscure rather than clarify.

---

## Conventions

**Test commands** (run from the indicated directory):
- Web: `cd web && npx vitest run tests/api/live-auctions` — runs the new API tests
- Desktop: `cd desktop && npm test` — runs the buyer-stats helper tests
- Type-check: `cd desktop && npm run typecheck`

**Commit cadence:** every task ends in a commit. Use the trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

**Branch:** continue on `feature/sales-foundation` (current branch).

---

## Phase 1 — Quick UI wins (no backend changes)

### Task 1: Em-dash for falsy auction metrics

**Files:**
- Modify: `desktop/src/pages/LiveMonitor.tsx:1042-1046`

The auctions table currently renders `0` for `totalBids`, `uniqueBidders`, and `durationSeconds` as the literal `0` because the existing checks use `??` (nullish coalescing) — only `null`/`undefined` fall through to `—`. We want `0` to also render as `—` since a finalized auction with zero bids almost always means we missed the bid stream, not that nobody bid.

- [ ] **Step 1.1: Apply the change**

Edit `desktop/src/pages/LiveMonitor.tsx` lines 1042-1046:

```tsx
<td className="px-4 py-2 text-right text-text-primary">{a.totalBids ? a.totalBids : '—'}</td>
<td className="px-4 py-2 text-right text-text-primary">{a.uniqueBidders ? a.uniqueBidders : '—'}</td>
<td className="px-4 py-2 text-right text-text-tertiary">
  {a.durationSeconds ? `${a.durationSeconds}s` : '—'}
</td>
```

The change is `??` → ternary that treats `0` as falsy. The `finalPriceCents` cell (line 1040) keeps `!= null` because `$0.00` is a meaningful display value for free items, distinct from "we don't know."

- [ ] **Step 1.2: Type-check**

```
cd desktop && npm run typecheck
```

Expected: no errors.

- [ ] **Step 1.3: Commit**

```
git add desktop/src/pages/LiveMonitor.tsx
git commit -m "fix(live-monitor): render em-dash for zero bid counts and durations"
```

---

### Task 2: Unique Buyers state + stat card

**Files:**
- Modify: `desktop/src/pages/LiveMonitor.tsx`

Add a `uniqueBuyers: Set<string>` state, seed it from persisted auctions when the show changes, add to it on each `sale_detected`, clear on disconnect. Render as a new `StatCard` between Net Earned and Pending. Change the stats grid from `lg:grid-cols-5` to `lg:grid-cols-6`.

- [ ] **Step 2.1: Add the state**

Insert near line 116 (after `recentSales` state):

```tsx
// Distinct buyer usernames seen during this session (seeded from persisted
// auctions on connect, added to on each sale_detected). Cleared on disconnect.
const [uniqueBuyers, setUniqueBuyers] = useState<Set<string>>(new Set());
```

- [ ] **Step 2.2: Seed from persisted auctions**

In the existing rehydrate `useEffect` at lines 402-431, after `setAuctions(result.auctions)` (line 417), seed the set:

```tsx
if (result.success && result.auctions) {
  setAuctions(result.auctions);
  const seeded = new Set<string>();
  for (const a of result.auctions) {
    if (a.winnerUsername) seeded.add(a.winnerUsername);
  }
  setUniqueBuyers(seeded);
} else if (result.error) {
```

Also add `setUniqueBuyers(new Set())` immediately above the `if (!liveId)` early-return reset at line 404 — when liveId becomes null we clear:

```tsx
if (!liveId) {
  setAuctions([]);
  setUniqueBuyers(new Set());
  return;
}
```

- [ ] **Step 2.3: Add to set on each sale**

In the `onSaleDetected` handler around line 348-352, after `setRecentSales(...)`:

```tsx
setRecentSales((prev) => [sale, ...prev].slice(0, 50));

// Track unique buyer usernames for this session
setUniqueBuyers((prev) => {
  if (prev.has(sale.buyer.username)) return prev;
  const next = new Set(prev);
  next.add(sale.buyer.username);
  return next;
});

// Update session stats
```

The `if (prev.has(...)) return prev` is important — returning the same Set reference when the value is already present avoids triggering re-renders downstream.

- [ ] **Step 2.4: Reset on disconnect**

Find the disconnect handler (`handleDisconnect`) and the disconnect listener (`onMonitorDisconnected` around line 297-306). In both places where `sessionItemCount`/`sessionRevenue` are reset, also reset `setUniqueBuyers(new Set())`. Use Grep to locate both:

```
grep -n "setSessionItemCount(0)" desktop/src/pages/LiveMonitor.tsx
```

For each match, add the line `setUniqueBuyers(new Set());` immediately after.

- [ ] **Step 2.5: Add the stat card and bump the grid**

At line 670, change `lg:grid-cols-5` → `lg:grid-cols-6`. Insert the new card between Net Earned (ends line 688) and Pending (starts line 689):

```tsx
<StatCard
  label="Unique Buyers"
  value={uniqueBuyers.size}
  format="number"
  icon={<Package className="w-5 h-5 text-accent" />}
/>
```

Sub-line (`items/buyer`) is rendered using StatCard's existing API. Check whether StatCard accepts a `subValue`/`description` prop:

```
grep -n "interface StatCardProps\|StatCard:" packages/shared/src/components/StatCard.tsx 2>/dev/null || \
grep -rn "StatCard" packages/shared/src/components/ 2>/dev/null | head
```

If StatCard supports an optional sub-line prop (e.g. `description` or `subtext`), pass `${(itemsSold / uniqueBuyers.size).toFixed(1)} items/buyer` when `uniqueBuyers.size > 0`. If it does not, leave it as the bare count for now and add the sub-line in a follow-up — do NOT modify shared-package StatCard for this; that's out of scope.

`itemsSold` is available as `liveStats?.totalCount || sessionItemCount` (same expression used by the Items Sold card on line 673).

- [ ] **Step 2.6: Type-check**

```
cd desktop && npm run typecheck
```

Expected: no errors.

- [ ] **Step 2.7: Commit**

```
git add desktop/src/pages/LiveMonitor.tsx
git commit -m "feat(live-monitor): add Unique Buyers stat card with persisted-auction seeding"
```

---

### Task 3: Top Buyers aggregation helper (extracted + tested)

**Files:**
- Create: `desktop/src/lib/buyer-stats.ts`
- Create: `desktop/src/lib/buyer-stats.test.ts`
- Create: `desktop/vitest.config.ts`
- Modify: `desktop/package.json`

Top Buyers requires merging persisted auctions with in-session sales without double-counting. This is the only chunk of derivation logic worth extracting + testing; the rest of the changes are presentational.

- [ ] **Step 3.1: Add vitest to desktop**

Modify `desktop/package.json` — add to `devDependencies`:

```json
"vitest": "^2.1.0"
```

Add to `scripts`:

```json
"test": "vitest run"
```

Then install:

```
cd desktop && npm install
```

Expected: vitest is added to `node_modules`.

- [ ] **Step 3.2: Create vitest config**

Create `desktop/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
```

- [ ] **Step 3.3: Write the failing test**

Create `desktop/src/lib/buyer-stats.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { aggregateBuyers, type AuctionLike, type SaleLike } from './buyer-stats';

describe('aggregateBuyers', () => {
  it('returns empty array when no auctions or sales', () => {
    expect(aggregateBuyers([], [])).toEqual([]);
  });

  it('aggregates a single buyer across one auction', () => {
    const auctions: AuctionLike[] = [
      { auctionId: 'a1', winnerUsername: 'alice', finalPriceCents: 1500 },
    ];
    expect(aggregateBuyers(auctions, [])).toEqual([
      { username: 'alice', itemCount: 1, totalCents: 1500 },
    ]);
  });

  it('skips auctions with no winner', () => {
    const auctions: AuctionLike[] = [
      { auctionId: 'a1', winnerUsername: null, finalPriceCents: 500 },
      { auctionId: 'a2', winnerUsername: 'bob', finalPriceCents: 200 },
    ];
    expect(aggregateBuyers(auctions, [])).toEqual([
      { username: 'bob', itemCount: 1, totalCents: 200 },
    ]);
  });

  it('treats null finalPriceCents as zero contribution', () => {
    const auctions: AuctionLike[] = [
      { auctionId: 'a1', winnerUsername: 'alice', finalPriceCents: null },
    ];
    expect(aggregateBuyers(auctions, [])).toEqual([
      { username: 'alice', itemCount: 1, totalCents: 0 },
    ]);
  });

  it('merges sales with no auctionId as separate contributions', () => {
    const sales: SaleLike[] = [
      { auctionId: null, buyerUsername: 'carol', priceCents: 800 },
      { auctionId: null, buyerUsername: 'carol', priceCents: 200 },
    ];
    expect(aggregateBuyers([], sales)).toEqual([
      { username: 'carol', itemCount: 2, totalCents: 1000 },
    ]);
  });

  it('de-duplicates a sale that matches a persisted auction by auctionId', () => {
    const auctions: AuctionLike[] = [
      { auctionId: 'a1', winnerUsername: 'dave', finalPriceCents: 1200 },
    ];
    const sales: SaleLike[] = [
      { auctionId: 'a1', buyerUsername: 'dave', priceCents: 1200 },
    ];
    // The sale and auction describe the same purchase — only count once.
    expect(aggregateBuyers(auctions, sales)).toEqual([
      { username: 'dave', itemCount: 1, totalCents: 1200 },
    ]);
  });

  it('aggregates multiple buyers and orders deterministically by username', () => {
    const auctions: AuctionLike[] = [
      { auctionId: 'a1', winnerUsername: 'alice', finalPriceCents: 100 },
      { auctionId: 'a2', winnerUsername: 'bob', finalPriceCents: 200 },
      { auctionId: 'a3', winnerUsername: 'alice', finalPriceCents: 300 },
    ];
    expect(aggregateBuyers(auctions, [])).toEqual([
      { username: 'alice', itemCount: 2, totalCents: 400 },
      { username: 'bob', itemCount: 1, totalCents: 200 },
    ]);
  });
});
```

- [ ] **Step 3.4: Run the test to verify it fails**

```
cd desktop && npm test
```

Expected: FAIL — `Cannot find module './buyer-stats'` or similar.

- [ ] **Step 3.5: Implement the helper**

Create `desktop/src/lib/buyer-stats.ts`:

```ts
export interface AuctionLike {
  auctionId: string | null;
  winnerUsername: string | null;
  finalPriceCents: number | null;
}

export interface SaleLike {
  auctionId: string | null;
  buyerUsername: string;
  priceCents: number;
}

export interface BuyerAgg {
  username: string;
  itemCount: number;
  totalCents: number;
}

/**
 * Merge persisted auctions and in-session sales into per-buyer totals.
 *
 * Sales that share an auctionId with a persisted auction describe the same
 * purchase and are dropped to avoid double-counting. Sales with no auctionId
 * (manual buys, BIN purchases) are always included.
 *
 * Result is sorted by username for deterministic ordering; the caller is
 * responsible for re-sorting by spend or item count when rendering.
 */
export function aggregateBuyers(
  auctions: AuctionLike[],
  sales: SaleLike[],
): BuyerAgg[] {
  const totals = new Map<string, BuyerAgg>();
  const auctionIdsSeen = new Set<string>();

  for (const a of auctions) {
    if (!a.winnerUsername) continue;
    if (a.auctionId) auctionIdsSeen.add(a.auctionId);
    const existing = totals.get(a.winnerUsername) ?? {
      username: a.winnerUsername,
      itemCount: 0,
      totalCents: 0,
    };
    existing.itemCount += 1;
    existing.totalCents += a.finalPriceCents ?? 0;
    totals.set(a.winnerUsername, existing);
  }

  for (const s of sales) {
    if (s.auctionId && auctionIdsSeen.has(s.auctionId)) continue;
    const existing = totals.get(s.buyerUsername) ?? {
      username: s.buyerUsername,
      itemCount: 0,
      totalCents: 0,
    };
    existing.itemCount += 1;
    existing.totalCents += s.priceCents;
    totals.set(s.buyerUsername, existing);
  }

  return Array.from(totals.values()).sort((a, b) =>
    a.username.localeCompare(b.username),
  );
}
```

- [ ] **Step 3.6: Run the tests to verify they pass**

```
cd desktop && npm test
```

Expected: all 7 tests PASS.

- [ ] **Step 3.7: Commit**

```
git add desktop/package.json desktop/package-lock.json desktop/vitest.config.ts desktop/src/lib/buyer-stats.ts desktop/src/lib/buyer-stats.test.ts
git commit -m "feat(live-monitor): add aggregateBuyers helper with tests"
```

If `desktop/` uses pnpm-lock.yaml at the workspace root rather than its own package-lock.json, substitute that path. Run `git status` first to see what was actually changed.

---

### Task 4: Top Buyers panel

**Files:**
- Modify: `desktop/src/pages/LiveMonitor.tsx`

Render the panel in the right rail, using `aggregateBuyers` against `auctions` + `recentSales`. Add a `'spend' | 'items'` toggle.

- [ ] **Step 4.1: Import the helper and useMemo**

Near the top of the file, add to existing imports:

```tsx
import { useEffect, useState, useCallback, useMemo } from 'react';
import { aggregateBuyers, type SaleLike } from '../lib/buyer-stats';
```

- [ ] **Step 4.2: Add the toggle state**

Near the other live-show useState declarations (around line 119):

```tsx
const [topBuyersSort, setTopBuyersSort] = useState<'spend' | 'items'>('spend');
```

- [ ] **Step 4.3: Compute the top-5 list**

Add this `useMemo` block after the state declarations (the exact insertion point isn't critical; near where other derived values would naturally sit, e.g. just above `playTrollAlert` definition around line 140):

```tsx
const topBuyers = useMemo(() => {
  const sales: SaleLike[] = recentSales.map((s) => ({
    auctionId: null, // sale-feed events don't carry auctionId today
    buyerUsername: s.buyer.username,
    priceCents: s.price.amount, // already in cents (see line 321)
  }));
  const aggregated = aggregateBuyers(auctions, sales);
  const sorted = [...aggregated].sort((a, b) =>
    topBuyersSort === 'spend'
      ? b.totalCents - a.totalCents
      : b.itemCount - a.itemCount,
  );
  return sorted.slice(0, 5);
}, [auctions, recentSales, topBuyersSort]);
```

Note on `auctionId: null` for sales: the current `LiveSale` shape (line 44-58) does not carry `auctionId`. The de-dup-by-auctionId path in `aggregateBuyers` will be a no-op until sales are enriched with auctionId in a future pass — that enrichment is out of scope for this plan. For now, in-session sales contribute alongside persisted auctions; a sale that is also a persisted auction may double-count for the few seconds before the auction record arrives. Acceptable trade-off given how brief that window is.

- [ ] **Step 4.4: Add the panel JSX**

In the right column (the `<div className="space-y-4">` starting around line 771), insert the Top Buyers panel between Quick Print and Print Queue (so the order is: Printer Settings, Quick Print, **Top Buyers**, Print Queue, Troll Detection, Failed Payments). Final placement after the next tasks reorganize this column will be: Printer strip, **Top Buyers**, Print Queue, Troll strip — but for this task, just insert it where it belongs:

```tsx
{/* Top Buyers */}
<div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
  <div className="flex items-center justify-between mb-4">
    <div className="flex items-center gap-2">
      <TrendingUp className="w-5 h-5 text-accent" />
      <h3 className="font-semibold text-text-primary">Top Buyers</h3>
    </div>
    <div className="inline-flex rounded-md border border-border-subtle overflow-hidden text-xs">
      <button
        onClick={() => setTopBuyersSort('spend')}
        className={`px-2 py-1 transition-colors ${
          topBuyersSort === 'spend'
            ? 'bg-accent text-white'
            : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
        }`}
        aria-pressed={topBuyersSort === 'spend'}
      >
        $
      </button>
      <button
        onClick={() => setTopBuyersSort('items')}
        className={`px-2 py-1 transition-colors ${
          topBuyersSort === 'items'
            ? 'bg-accent text-white'
            : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
        }`}
        aria-pressed={topBuyersSort === 'items'}
      >
        items
      </button>
    </div>
  </div>

  {topBuyers.length === 0 ? (
    <p className="text-sm text-text-tertiary text-center py-4">
      No buyers yet
    </p>
  ) : (
    <ol className="space-y-2">
      {topBuyers.map((b, idx) => (
        <li
          key={b.username}
          className="flex items-center gap-2 p-2 bg-bg-tertiary rounded-lg text-sm"
        >
          <span className="w-5 text-center font-semibold text-text-tertiary">
            {idx + 1}
          </span>
          <span className="flex-1 truncate text-accent" title={`@${b.username}`}>
            @{b.username}
          </span>
          <span className="text-text-tertiary text-xs">
            {b.itemCount} {b.itemCount === 1 ? 'item' : 'items'}
          </span>
          <span className="font-medium text-text-primary tabular-nums">
            {formatCurrency(b.totalCents / 100)}
          </span>
        </li>
      ))}
    </ol>
  )}
</div>
```

- [ ] **Step 4.5: Type-check**

```
cd desktop && npm run typecheck
```

Expected: no errors.

- [ ] **Step 4.6: Commit**

```
git add desktop/src/pages/LiveMonitor.tsx
git commit -m "feat(live-monitor): add Top Buyers panel with $/items toggle"
```

---

### Task 5: Collapse Printer Settings + Quick Print into a `<details>` strip

**Files:**
- Modify: `desktop/src/pages/LiveMonitor.tsx`

Replace the two right-column cards (Printer Settings at lines 772-812 and Quick Print at lines 814-858) with a single `<details>` element. The summary line shows a one-line status; expanded content has the same controls as today.

- [ ] **Step 5.1: Add localStorage-backed open state**

Near other useState declarations (around line 132):

```tsx
const [printerPanelOpen, setPrinterPanelOpen] = useState<boolean>(() => {
  return localStorage.getItem('liveMonitor.printerPanelOpen') === 'true';
});
```

Add an effect to persist:

```tsx
useEffect(() => {
  localStorage.setItem('liveMonitor.printerPanelOpen', String(printerPanelOpen));
}, [printerPanelOpen]);
```

- [ ] **Step 5.2: Replace the two cards**

Delete the existing Printer Settings card (lines 772-812) and Quick Print card (lines 814-858). Insert in their place:

```tsx
{/* Printer (collapsed) */}
<details
  open={printerPanelOpen}
  onToggle={(e) => setPrinterPanelOpen((e.currentTarget as HTMLDetailsElement).open)}
  className="bg-bg-secondary border border-border-subtle rounded-xl group"
>
  <summary className="flex items-center justify-between px-4 py-3 cursor-pointer list-none">
    <div className="flex items-center gap-2 text-sm text-text-primary min-w-0">
      <Printer className="w-4 h-4 text-accent flex-shrink-0" />
      <span className="truncate">{selectedPrinter || 'No printer selected'}</span>
      <span className="text-text-tertiary">·</span>
      <span className="text-text-tertiary whitespace-nowrap">
        Auto · {autoPrintEnabled ? 'On' : 'Off'}
      </span>
      {lastPrintedNumber != null && (
        <>
          <span className="text-text-tertiary">·</span>
          <span className="text-text-tertiary whitespace-nowrap">
            last #{lastPrintedNumber}
          </span>
        </>
      )}
    </div>
    <span className="text-text-tertiary text-xs ml-2 group-open:rotate-180 transition-transform">⌄</span>
  </summary>

  <div className="px-4 pb-4 pt-2 border-t border-border-subtle space-y-3">
    <div>
      <label className="block text-sm text-text-secondary mb-1">Select Printer</label>
      <select
        value={selectedPrinter}
        onChange={(e) => {
          setSelectedPrinter(e.target.value);
          window.labelAPI.savePrinter(e.target.value);
        }}
        className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-sm text-text-primary focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none"
      >
        {printers.length === 0 ? (
          <option value="">No printers found</option>
        ) : (
          printers.map((printer) => (
            <option key={printer} value={printer}>
              {printer}
            </option>
          ))
        )}
      </select>
    </div>

    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={autoPrintEnabled}
        onChange={(e) => setAutoPrintEnabled(e.target.checked)}
        className="w-4 h-4 rounded border-border-subtle text-accent focus:ring-accent/20"
      />
      <span className="text-sm text-text-primary">Auto-print on sale</span>
    </label>

    <div className="pt-2 border-t border-border-subtle">
      <div className="flex items-center gap-2 mb-2">
        <Zap className="w-4 h-4 text-accent" />
        <h4 className="text-sm font-medium text-text-primary">Quick Print</h4>
      </div>
      <p className="text-xs text-text-tertiary mb-3">
        Print a label manually if one was dropped during reconnection
      </p>

      <div className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">Last printed:</span>
          <span className="font-medium text-text-primary">
            {lastPrintedNumber ? `#${lastPrintedNumber}` : 'None'}
          </span>
        </div>

        <button
          onClick={handlePrintNext}
          disabled={printLoading || !lastPrintedNumber || !selectedPrinter}
          className="w-full px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Print Next (#{lastPrintedNumber ? lastPrintedNumber + 1 : '—'})
        </button>

        <div className="flex gap-2">
          <input
            type="number"
            value={customPrintNumber}
            onChange={(e) => setCustomPrintNumber(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handlePrintCustom()}
            placeholder="Item #"
            className="flex-1 px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none"
          />
          <button
            onClick={handlePrintCustom}
            disabled={printLoading || !customPrintNumber || !selectedPrinter}
            className="px-4 py-2 bg-bg-tertiary border border-border-subtle text-text-primary rounded-lg hover:bg-bg-primary transition-colors disabled:opacity-50"
          >
            Print Custom
          </button>
        </div>
      </div>
    </div>
  </div>
</details>
```

- [ ] **Step 5.3: Type-check**

```
cd desktop && npm run typecheck
```

Expected: no errors.

- [ ] **Step 5.4: Commit**

```
git add desktop/src/pages/LiveMonitor.tsx
git commit -m "feat(live-monitor): collapse Printer + Quick Print into a header strip"
```

---

### Task 6: Collapse Troll Detection into a `<details>` strip

**Files:**
- Modify: `desktop/src/pages/LiveMonitor.tsx`

Same pattern as Task 5. Default collapsed; no localStorage persistence required.

- [ ] **Step 6.1: Replace the Troll Detection card**

Replace lines 905-958 (current Troll Detection card) with:

```tsx
{/* Troll Detection (collapsed) */}
<details className="bg-bg-secondary border border-border-subtle rounded-xl group">
  <summary className="flex items-center justify-between px-4 py-3 cursor-pointer list-none">
    <div className="flex items-center gap-2 text-sm text-text-primary min-w-0">
      <Shield className="w-4 h-4 text-accent flex-shrink-0" />
      <span>Troll Detection</span>
      <span className="text-text-tertiary">·</span>
      <span className="text-text-tertiary whitespace-nowrap">
        {trollDetectionEnabled
          ? `On · >$${trollMaxPrice || '—'}`
          : 'Off'}
      </span>
    </div>
    <span className="text-text-tertiary text-xs ml-2 group-open:rotate-180 transition-transform">⌄</span>
  </summary>

  <div className="px-4 pb-4 pt-2 border-t border-border-subtle space-y-3">
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={trollDetectionEnabled}
        onChange={(e) => setTrollDetectionEnabled(e.target.checked)}
        className="w-4 h-4 rounded border-border-subtle text-accent focus:ring-accent/20"
      />
      <span className="text-sm text-text-primary">Enable troll detection</span>
    </label>

    {trollDetectionEnabled && (
      <>
        <div>
          <label className="block text-sm text-text-secondary mb-1">
            Max price threshold
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary">
              $
            </span>
            <input
              type="number"
              value={trollMaxPrice}
              onChange={(e) => setTrollMaxPrice(e.target.value)}
              placeholder="500"
              className="w-full pl-7 pr-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none"
            />
          </div>
          <p className="text-xs text-text-tertiary mt-1">
            Alert when bid exceeds this amount
          </p>
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={trollSoundEnabled}
            onChange={(e) => setTrollSoundEnabled(e.target.checked)}
            className="w-4 h-4 rounded border-border-subtle text-accent focus:ring-accent/20"
          />
          <span className="text-sm text-text-primary">Play alert sound</span>
        </label>
      </>
    )}
  </div>
</details>
```

- [ ] **Step 6.2: Type-check + commit**

```
cd desktop && npm run typecheck
git add desktop/src/pages/LiveMonitor.tsx
git commit -m "feat(live-monitor): collapse Troll Detection into a header strip"
```

---

### Task 7: Move Failed Payments below auctions, collapsed

**Files:**
- Modify: `desktop/src/pages/LiveMonitor.tsx`

Failed Payments today appears as both a stats card (kept) and a right-column panel (move). Move the panel out of the right column to its own row below Auctions, render as a `<details>` element default-collapsed, auto-expand the first time `failedPayments.length` transitions from 0 to non-zero.

- [ ] **Step 7.1: Add auto-expand state**

Near other useState declarations:

```tsx
const [failedPaymentsOpen, setFailedPaymentsOpen] = useState(false);
const prevFailedCountRef = useRef(0);
```

Add to the top of the file:

```tsx
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
```

Add an effect to auto-expand on the 0→N transition:

```tsx
useEffect(() => {
  if (prevFailedCountRef.current === 0 && failedPayments.length > 0) {
    setFailedPaymentsOpen(true);
  }
  prevFailedCountRef.current = failedPayments.length;
}, [failedPayments.length]);
```

- [ ] **Step 7.2: Delete the right-column Failed Payments card**

Remove lines 960-986 (the existing Failed Payments panel inside the right column).

- [ ] **Step 7.3: Add a new full-width row below Auctions**

After the Auctions panel (which ends around line 1056, just before `</div>` that closes the lg:grid-cols-3 wrapper), insert a new full-width row:

```tsx
{/* Failed Payments (collapsed, full width, below auctions) */}
<details
  open={failedPaymentsOpen}
  onToggle={(e) => setFailedPaymentsOpen((e.currentTarget as HTMLDetailsElement).open)}
  className={`lg:col-span-3 bg-bg-secondary border rounded-xl group ${
    failedPayments.length > 0 ? 'border-red-500/30' : 'border-border-subtle'
  }`}
>
  <summary className="flex items-center justify-between px-5 py-3 cursor-pointer list-none">
    <div className="flex items-center gap-2 text-sm">
      <AlertTriangle
        className={`w-4 h-4 ${failedPayments.length > 0 ? 'text-red-500' : 'text-text-tertiary'}`}
      />
      <span className={`font-semibold ${failedPayments.length > 0 ? 'text-red-500' : 'text-text-primary'}`}>
        Failed Payments
      </span>
      <span className="text-text-tertiary">·</span>
      <span className="text-text-tertiary">
        {failedPayments.length === 0 ? 'None' : `${failedPayments.length} affected`}
      </span>
    </div>
    <span className="text-text-tertiary text-xs ml-2 group-open:rotate-180 transition-transform">⌄</span>
  </summary>

  <div className="px-5 pb-4 pt-2 border-t border-border-subtle space-y-2 max-h-64 overflow-y-auto">
    {failedPayments.length === 0 ? (
      <p className="text-sm text-text-tertiary text-center py-4">No failed payments</p>
    ) : (
      failedPayments.map((payment, idx) => (
        <div
          key={idx}
          className="flex items-center justify-between p-2 bg-red-500/5 rounded-lg text-sm"
        >
          <span className="text-text-primary truncate flex-1">{payment.name}</span>
          <span className="font-medium text-red-500 ml-2">
            {formatCurrency(payment.soldPrice.amount / 100)}
          </span>
        </div>
      ))
    )}
  </div>
</details>
```

- [ ] **Step 7.4: Type-check + commit**

```
cd desktop && npm run typecheck
git add desktop/src/pages/LiveMonitor.tsx
git commit -m "feat(live-monitor): move Failed Payments below auctions as collapsible strip"
```

---

## Phase 2 — Backfill backend (Prisma + web API)

### Task 8: GraphQL discovery — capture the actual Whatnot auction-details query

**Files:** none (manual investigation)

The spec assumes a query named `auctionDetails(id: $auctionId)`. We have not verified this exists in Whatnot's GraphQL schema. Before writing the IPC handler, capture the actual query Whatnot's own dashboard fires when an operator views a single auction's bid history.

- [ ] **Step 8.1: Capture the live request**

While running the desktop app and connected to a Whatnot show (any show, even a recent one):

1. Open Chrome DevTools on the Whatnot monitor window (`Ctrl+Shift+I` while it's focused).
2. Open the Network tab, filter by `graphql`.
3. In the Whatnot dashboard, click into an auction's bid detail view (or expand a sold item).
4. Locate the GraphQL request that returns bid count / unique bidder count / duration.
5. Copy the request payload (operationName, query string, variables).

- [ ] **Step 8.2: Record findings**

Append a short section to the spec at `docs/superpowers/specs/2026-05-14-live-monitor-redesign-design.md` titled `## Implementation notes (added during Task 8)` with:

- The actual operationName (e.g. `BidHistory`, `AuctionPostMortem`, etc.)
- The query string verbatim
- The variables shape (e.g. `{ auctionId: ID! }` vs `{ id: String! }`)
- The response shape — specifically which fields map to `totalBids`, `uniqueBidders`, `durationSeconds`

If the query expects a different ID format than what we store as `auctionId` (e.g. base64-encoded GraphQL ID), note the encoding step needed.

If no such query exists (the dashboard computes it client-side from a stream of bid events), STOP and flag this — the backfill design needs revision. In that case, fall back to displaying em-dashes only (Task 1 already covers that) and skip Tasks 9-16.

- [ ] **Step 8.3: Commit the spec update**

```
git add docs/superpowers/specs/2026-05-14-live-monitor-redesign-design.md
git commit -m "docs(live-monitor): record discovered Whatnot auction-details GraphQL query"
```

---

### Task 9: Prisma migration — add `needs_backfill` column

**Files:**
- Modify: `web/prisma/schema.prisma:1037`
- Create: `web/prisma/migrations/<timestamp>_live_auction_backfill_flag/migration.sql`

- [ ] **Step 9.1: Update the schema**

In `web/prisma/schema.prisma`, inside the `LiveAuction` model (lines 1021-1045), add this line right after the `tenantId` field (line 1037):

```prisma
  needsBackfill   Boolean   @default(false) @map("needs_backfill")
```

- [ ] **Step 9.2: Generate the migration**

```
cd web && npx prisma migrate dev --name live_auction_backfill_flag
```

Expected: prisma creates `web/prisma/migrations/<timestamp>_live_auction_backfill_flag/migration.sql` containing roughly:

```sql
ALTER TABLE "live_auctions" ADD COLUMN "needs_backfill" BOOLEAN NOT NULL DEFAULT false;
```

The migration runs against the dev database. Verify it applied with no errors. If the dev DB has data, the column gets `false` for all existing rows, which is correct (those old auctions either have real bid data or already got their final values).

- [ ] **Step 9.3: Commit**

```
git add web/prisma/schema.prisma web/prisma/migrations/
git commit -m "feat(live-auctions): add needs_backfill flag to schema"
```

---

### Task 10: POST /api/live-auctions accepts `needsBackfill`

**Files:**
- Modify: `web/src/app/api/live-auctions/route.ts`
- Create: `web/tests/api/live-auctions/post.test.ts`

- [ ] **Step 10.1: Write the failing test**

Create `web/tests/api/live-auctions/post.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ctxHolder: { tenantId: string; userId: number } = {
  tenantId: '00000000-0000-0000-0000-000000000000',
  userId: 1,
};

vi.mock('@/lib/tenant', () => {
  class AuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'AuthError';
      this.status = status;
    }
  }
  return {
    AuthError,
    getTenantContext: vi.fn(async () => ({
      tenantId: ctxHolder.tenantId,
      userId: ctxHolder.userId,
      role: 'owner' as const,
      overrides: [],
    })),
    requirePermission: vi.fn(() => undefined),
    requireMasterAdmin: vi.fn(),
    handleAuthError: (error: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { NextResponse } = require('next/server');
      if (error instanceof AuthError) {
        return NextResponse.json(
          { success: false, error: error.message },
          { status: error.status },
        );
      }
      console.error('Unexpected error:', error);
      return NextResponse.json(
        { success: false, error: 'Internal server error' },
        { status: 500 },
      );
    },
  };
});

import { POST } from '@/app/api/live-auctions/route';
import { prisma } from '@/lib/prisma';
import { mockTenantContext } from '../../helpers/api';
import { NextRequest } from 'next/server';

function postReq(tenantId: string, body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/live-auctions', {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/live-auctions', () => {
  let tenantId: string;

  beforeEach(async () => {
    tenantId = await mockTenantContext();
    ctxHolder.tenantId = tenantId;
  });

  afterEach(async () => {
    await prisma.liveAuction.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  });

  it('persists needsBackfill=true when provided', async () => {
    const res = await POST(
      postReq(tenantId, {
        showId: 'show-1',
        auctionId: 'auction-1',
        itemName: 'Mystery item',
        finalPriceCents: 1500,
        winnerUsername: 'alice',
        needsBackfill: true,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    const row = await prisma.liveAuction.findFirst({
      where: { tenantId, auctionId: 'auction-1' },
    });
    expect(row).not.toBeNull();
    expect(row?.needsBackfill).toBe(true);
  });

  it('defaults needsBackfill to false when omitted', async () => {
    const res = await POST(
      postReq(tenantId, {
        showId: 'show-1',
        auctionId: 'auction-2',
        itemName: 'Item',
        finalPriceCents: 500,
        winnerUsername: 'bob',
        totalBids: 4,
        uniqueBidders: 2,
        durationSeconds: 12,
      }),
    );
    expect(res.status).toBe(200);

    const row = await prisma.liveAuction.findFirst({
      where: { tenantId, auctionId: 'auction-2' },
    });
    expect(row?.needsBackfill).toBe(false);
  });
});
```

- [ ] **Step 10.2: Run test to verify it fails**

```
cd web && npx vitest run tests/api/live-auctions/post.test.ts
```

Expected: FAIL — `needsBackfill` field is dropped because the route doesn't read it.

- [ ] **Step 10.3: Update the route**

In `web/src/app/api/live-auctions/route.ts`:

Add to the `AuctionPayload` interface (line 5-21):

```ts
  needsBackfill?: boolean;
```

Add to the `data` object inside the POST handler (line 44-58), at the end before the closing brace:

```ts
      bidderMaxBids: (body.bidderMaxBids ?? null) as never,
      needsBackfill: body.needsBackfill ?? false,
    };
```

- [ ] **Step 10.4: Run test to verify it passes**

```
cd web && npx vitest run tests/api/live-auctions/post.test.ts
```

Expected: both tests PASS.

- [ ] **Step 10.5: Commit**

```
git add web/src/app/api/live-auctions/route.ts web/tests/api/live-auctions/post.test.ts
git commit -m "feat(api): accept needsBackfill on POST /api/live-auctions"
```

---

### Task 11: PATCH /api/live-auctions/:id endpoint

**Files:**
- Create: `web/src/app/api/live-auctions/[id]/route.ts`
- Create: `web/tests/api/live-auctions/patch.test.ts`

- [ ] **Step 11.1: Write the failing test**

Create `web/tests/api/live-auctions/patch.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ctxHolder: { tenantId: string; userId: number } = {
  tenantId: '00000000-0000-0000-0000-000000000000',
  userId: 1,
};

vi.mock('@/lib/tenant', () => {
  class AuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'AuthError';
      this.status = status;
    }
  }
  return {
    AuthError,
    getTenantContext: vi.fn(async () => ({
      tenantId: ctxHolder.tenantId,
      userId: ctxHolder.userId,
      role: 'owner' as const,
      overrides: [],
    })),
    requirePermission: vi.fn(() => undefined),
    requireMasterAdmin: vi.fn(),
    handleAuthError: (error: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { NextResponse } = require('next/server');
      if (error instanceof AuthError) {
        return NextResponse.json(
          { success: false, error: error.message },
          { status: error.status },
        );
      }
      return NextResponse.json(
        { success: false, error: 'Internal server error' },
        { status: 500 },
      );
    },
  };
});

import { PATCH } from '@/app/api/live-auctions/[id]/route';
import { prisma } from '@/lib/prisma';
import { mockTenantContext } from '../../helpers/api';
import { NextRequest } from 'next/server';

function patchReq(tenantId: string, body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/live-auctions/123', {
    method: 'PATCH',
    headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/live-auctions/[id]', () => {
  let tenantId: string;
  let auctionRowId: number;

  beforeEach(async () => {
    tenantId = await mockTenantContext();
    ctxHolder.tenantId = tenantId;
    const row = await prisma.liveAuction.create({
      data: {
        tenantId,
        showId: 'show-1',
        auctionId: 'auction-1',
        itemName: 'Item',
        finalPriceCents: 500,
        winnerUsername: 'alice',
        needsBackfill: true,
      },
    });
    auctionRowId = row.id;
  });

  afterEach(async () => {
    await prisma.liveAuction.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  });

  it('updates totals and clears needsBackfill', async () => {
    const res = await PATCH(
      patchReq(tenantId, {
        totalBids: 7,
        uniqueBidders: 4,
        durationSeconds: 25,
      }),
      { params: Promise.resolve({ id: String(auctionRowId) }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    const row = await prisma.liveAuction.findUnique({ where: { id: auctionRowId } });
    expect(row?.totalBids).toBe(7);
    expect(row?.uniqueBidders).toBe(4);
    expect(row?.durationSeconds).toBe(25);
    expect(row?.needsBackfill).toBe(false);
  });

  it('returns 404 for an unknown id within this tenant', async () => {
    const res = await PATCH(
      patchReq(tenantId, { totalBids: 1 }),
      { params: Promise.resolve({ id: '99999999' }) },
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 for an id that belongs to a different tenant', async () => {
    const otherTenantId = await mockTenantContext();
    const otherRow = await prisma.liveAuction.create({
      data: {
        tenantId: otherTenantId,
        showId: 'show-x',
        auctionId: 'auction-x',
        finalPriceCents: 100,
        needsBackfill: true,
      },
    });

    const res = await PATCH(
      patchReq(tenantId, { totalBids: 1 }),
      { params: Promise.resolve({ id: String(otherRow.id) }) },
    );
    expect(res.status).toBe(404);

    // cleanup
    await prisma.liveAuction.deleteMany({ where: { tenantId: otherTenantId } });
    await prisma.tenant.delete({ where: { id: otherTenantId } });
  });
});
```

- [ ] **Step 11.2: Run test to verify it fails**

```
cd web && npx vitest run tests/api/live-auctions/patch.test.ts
```

Expected: FAIL — module `@/app/api/live-auctions/[id]/route` not found.

- [ ] **Step 11.3: Implement the route**

Create `web/src/app/api/live-auctions/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';

interface PatchPayload {
  totalBids?: number | null;
  uniqueBidders?: number | null;
  durationSeconds?: number | null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getTenantContext(request);
    requirePermission(ctx, 'live_auctions.write');

    const { id: rawId } = await params;
    const id = parseInt(rawId, 10);
    if (Number.isNaN(id)) {
      return NextResponse.json(
        { success: false, error: 'Invalid id' },
        { status: 400 },
      );
    }

    const body = (await request.json()) as PatchPayload;

    // Tenant-scoped lookup before update — prevents cross-tenant writes
    // even if the model didn't have RLS as a backstop.
    const existing = await prisma.liveAuction.findFirst({
      where: { id, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'Not found' },
        { status: 404 },
      );
    }

    const auction = await prisma.liveAuction.update({
      where: { id },
      data: {
        totalBids: body.totalBids ?? null,
        uniqueBidders: body.uniqueBidders ?? null,
        durationSeconds: body.durationSeconds ?? null,
        needsBackfill: false,
      },
    });

    return NextResponse.json({ success: true, auction });
  } catch (error) {
    return handleAuthError(error);
  }
}
```

- [ ] **Step 11.4: Run tests to verify they pass**

```
cd web && npx vitest run tests/api/live-auctions/patch.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 11.5: Commit**

```
git add web/src/app/api/live-auctions/ web/tests/api/live-auctions/patch.test.ts
git commit -m "feat(api): add PATCH /api/live-auctions/[id] for backfill writes"
```

---

## Phase 3 — Backfill desktop side

### Task 12: Listener script flags partial auctions with `needsBackfill`

**Files:**
- Modify: `desktop/electron/ipc/label-generator.ts:149-187`

When `finalizeAuction()` is called for an auction the listener never observed start (`!auction` branch at line 152), the resulting payload currently has `bids: []`, `totalBids: 0`, `uniqueBidders: 0`. Tag this case so the renderer can request backfill.

- [ ] **Step 12.1: Add the flag in the fallback branch**

In the listener template string in `desktop/electron/ipc/label-generator.ts`, modify `finalizeAuction()` (lines 149-187). Track whether the fallback branch was hit and propagate that into the result:

```js
function finalizeAuction(auctionId, finalData) {
  let auction = activeAuctions.get(auctionId);
  let needsBackfill = false;

  if (!auction) {
    needsBackfill = true;
    auction = {
      auctionId,
      itemName: finalData.name || 'Unknown Item',
      showId: LIVESTREAM_ID,
      startTime: null,
      startPriceCents: finalData.startPriceCents || 100,
      bids: [],
      bidderMaxBids: {},
      uniqueBidders: new Set()
    };
  }

  const endTime = new Date();
  const durationMs = auction.startTime ? endTime - new Date(auction.startTime) : 0;

  const auctionResult = {
    auctionId: auction.auctionId,
    itemName: finalData.name || auction.itemName,
    showId: LIVESTREAM_ID,
    startTime: auction.startTime,
    endTime,
    durationSeconds: Math.round(durationMs / 1000),
    startPriceCents: auction.startPriceCents || 100,
    finalPriceCents: finalData.priceCents || 0,
    winner: finalData.winner || null,
    totalBids: auction.bids.length,
    uniqueBidders: auction.uniqueBidders.size,
    bids: auction.bids,
    bidderMaxBids: auction.bidderMaxBids,
    needsBackfill: needsBackfill
  };

  window.postMessage({ type: 'sellerfolio-auction', auction: auctionResult }, '*');
  activeAuctions.delete(auctionId);
  return auctionResult;
}
```

The `Layout.tsx` listener (line 251) already POSTs the entire payload to `/api/live-auctions`, so `needsBackfill` flows through unchanged once Task 10 is in place.

- [ ] **Step 12.2: Update the AuctionData TypeScript interface**

In the same file, add `needsBackfill: boolean;` to the `AuctionData` interface (line 33-47):

```ts
interface AuctionData {
  showId: string;
  auctionId: string;
  itemName: string;
  startTime: string | null;
  endTime: Date;
  durationSeconds: number;
  startPriceCents: number;
  finalPriceCents: number;
  winner: string | null;
  totalBids: number;
  uniqueBidders: number;
  bids: unknown[];
  bidderMaxBids: Record<string, number>;
  needsBackfill: boolean;
}
```

- [ ] **Step 12.3: Update the renderer-side `PersistedAuction` and `AuctionDataPayload` types**

In `desktop/src/pages/LiveMonitor.tsx`, add `needsBackfill: boolean | null;` to `PersistedAuction` (lines 71-84) and `needsBackfill?: boolean | null;` to `AuctionDataPayload` (lines 86-98).

In the optimistic-add code (lines 373-385), include the flag:

```tsx
const optimistic: PersistedAuction = {
  // ... existing fields ...
  uniqueBidders: payload.uniqueBidders ?? null,
  needsBackfill: payload.needsBackfill ?? false,
};
```

- [ ] **Step 12.4: Type-check + commit**

```
cd desktop && npm run typecheck
git add desktop/electron/ipc/label-generator.ts desktop/src/pages/LiveMonitor.tsx
git commit -m "feat(live-monitor): flag auctions finalized without observed bid stream"
```

---

### Task 13: Add `whatnot-auction-backfill` IPC handler

**Files:**
- Modify: `desktop/electron/ipc/live-stats.ts`

Use the query captured in Task 8. The handler returns `{ success: true, totals: { totalBids, uniqueBidders, durationSeconds } }` or `{ success: false, error }`.

This task assumes Task 8 produced a working query. If Task 8 found no usable query, skip Tasks 13-16 and stop after Phase 2.

- [ ] **Step 13.1: Add the handler**

Inside `registerLiveStatsHandlers` in `desktop/electron/ipc/live-stats.ts`, before the closing `}` of the function (around line 313), add:

```ts
  // Backfill bid totals for an auction the listener never observed start.
  // Uses the GraphQL query captured during Task 8 of the Live Monitor redesign.
  ipcMain.handle('whatnot-auction-backfill', async (_event, { auctionId }: { auctionId: string }) => {
    if (!auctionId) {
      return { success: false, error: 'auctionId required' };
    }

    // TODO(Task 8): replace placeholders with the captured query/operationName/variable shape
    const query = `<INSERT QUERY FROM TASK 8>`;
    const operationName = `<INSERT OPERATION NAME FROM TASK 8>`;
    const variables = { /* INSERT VARIABLES SHAPE FROM TASK 8 */ auctionId };

    try {
      const result = await executeGraphQLViaWindow(query, variables, operationName);
      if (result.error || result.errors) {
        return { success: false, error: result.error || result.errors?.[0]?.message };
      }

      // TODO(Task 8): map response.data fields to totals based on the captured response shape
      const data = result.data as Record<string, unknown> | undefined;
      if (!data) {
        return { success: false, error: 'No data in response' };
      }

      // Example shape — adjust to actual:
      //   const node = (data.auctionDetails ?? data.auction) as Record<string, unknown> | undefined;
      //   const totals = {
      //     totalBids: node?.totalBids ?? null,
      //     uniqueBidders: node?.uniqueBidders ?? null,
      //     durationSeconds: node?.durationSeconds ?? null,
      //   };

      return { success: true, totals: { totalBids: null, uniqueBidders: null, durationSeconds: null } };
    } catch (error) {
      console.error('[AuctionBackfill] Error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });
```

The `<INSERT ...>` placeholders must be replaced with the concrete values discovered in Task 8 before this task is committable. Do not commit with placeholders left in.

- [ ] **Step 13.2: Verify by type-check**

```
cd desktop && npm run typecheck
```

Expected: no errors. (The handler doesn't return until the placeholders are filled — this is intentional. It will type-check fine; manual smoke test happens in Task 17.)

- [ ] **Step 13.3: Commit**

```
git add desktop/electron/ipc/live-stats.ts
git commit -m "feat(live-stats): add whatnot-auction-backfill IPC handler"
```

---

### Task 14: Expose `liveStatsAPI.backfillAuction` in preload

**Files:**
- Modify: `desktop/electron/preload.ts`

There is no `liveStatsAPI` bridge today — live-stats IPCs are exposed under `liveMonitorAPI`. Add the new method to `liveMonitorAPI` to keep it consistent with the rest of the file. (The spec calls it `liveStatsAPI.backfillAuction`; we adapt to the existing bridge name to avoid creating a parallel surface.)

- [ ] **Step 14.1: Expose the IPC**

In `desktop/electron/preload.ts`, inside the `liveMonitorAPI` `contextBridge.exposeInMainWorld` block (lines 158-190), add this method (anywhere inside the object, e.g. between `stopPolling` and `onSaleDetected`):

```ts
  backfillAuction: (auctionId: string) =>
    ipcRenderer.invoke('whatnot-auction-backfill', { auctionId }),
```

In the `liveMonitorAPI` window type declaration (lines 360-372), add:

```ts
  backfillAuction: (auctionId: string) => Promise<{
    success: boolean;
    totals?: { totalBids: number | null; uniqueBidders: number | null; durationSeconds: number | null };
    error?: string;
  }>;
```

- [ ] **Step 14.2: Type-check + commit**

```
cd desktop && npm run typecheck
git add desktop/electron/preload.ts
git commit -m "feat(preload): expose backfillAuction on liveMonitorAPI"
```

---

### Task 15: Renderer-side backfill effect

**Files:**
- Modify: `desktop/src/pages/LiveMonitor.tsx`

Watch `auctions` for any with `needsBackfill: true`, dispatch a single backfill at a time, PATCH the row on success, drop the flag locally on the row regardless of outcome (success → updated totals + cleared flag; failure → keep flag in DB but stop retrying within this session).

- [ ] **Step 15.1: Add backfill state**

Near other useState declarations:

```tsx
// Set of auctionIds we've already attempted to backfill in this session
// (success or failure — either way, don't retry until next reload).
const [backfillAttempted, setBackfillAttempted] = useState<Set<string>>(new Set());
const [backfillingId, setBackfillingId] = useState<string | null>(null);
```

- [ ] **Step 15.2: Add the effect**

Below the rehydrate effect (line 431), add:

```tsx
// Single-flight backfill loop. Walks the auctions list each render, picks
// the first auction that needs backfill and hasn't been attempted, fires
// the IPC, PATCHes the row, marks attempted. Throttled by `backfillingId`
// being non-null while a request is in flight.
useEffect(() => {
  if (backfillingId !== null) return;

  const next = auctions.find(
    (a) =>
      a.needsBackfill === true &&
      a.auctionId != null &&
      a.id > 0 && // skip optimistic rows (negative ids) — wait for real DB id
      !backfillAttempted.has(a.auctionId),
  );
  if (!next || !next.auctionId) return;

  const auctionId = next.auctionId;
  const rowId = next.id;
  setBackfillingId(auctionId);

  (async () => {
    try {
      const result = await window.liveMonitorAPI.backfillAuction(auctionId);
      if (result.success && result.totals) {
        const patch = await apiClient.patch<{ success: boolean; error?: string }>(
          `/api/live-auctions/${rowId}`,
          result.totals,
        );
        if (patch.success) {
          setAuctions((prev) =>
            prev.map((a) =>
              a.id === rowId
                ? {
                    ...a,
                    totalBids: result.totals!.totalBids,
                    uniqueBidders: result.totals!.uniqueBidders,
                    durationSeconds: result.totals!.durationSeconds,
                    needsBackfill: false,
                  }
                : a,
            ),
          );
        } else {
          console.error('[Backfill] PATCH failed:', patch.error);
        }
      } else {
        console.warn('[Backfill] Failed:', auctionId, result.error);
      }
    } catch (err) {
      console.error('[Backfill] Unexpected error:', err);
    } finally {
      setBackfillAttempted((prev) => {
        const nextSet = new Set(prev);
        nextSet.add(auctionId);
        return nextSet;
      });
      setBackfillingId(null);
    }
  })();
}, [auctions, backfillingId, backfillAttempted]);
```

- [ ] **Step 15.3: Add `apiClient.patch`**

Check whether `apiClient` already has a `patch` method:

```
grep -n "patch:" desktop/src/lib/apiClient.ts
```

If it doesn't exist, add it. In `desktop/src/lib/apiClient.ts`, add a wrapper analogous to the existing `post`:

```ts
patch<T>(path: string, body?: unknown): Promise<T> {
  return this.request<T>('PATCH', path, { body });
}
```

If `get`/`post` are defined as arrow methods on the singleton instance, follow that exact pattern.

- [ ] **Step 15.4: Reset attempted-set on disconnect**

In the disconnect locations identified in Task 2 (where `setUniqueBuyers(new Set())` was added), also add:

```tsx
setBackfillAttempted(new Set());
setBackfillingId(null);
```

- [ ] **Step 15.5: Type-check + commit**

```
cd desktop && npm run typecheck
git add desktop/src/pages/LiveMonitor.tsx desktop/src/lib/apiClient.ts
git commit -m "feat(live-monitor): backfill missing auction totals via single-flight queue"
```

---

### Task 16: UI signals for backfill state

**Files:**
- Modify: `desktop/src/pages/LiveMonitor.tsx`

Show an amber clock icon next to the Bids cell for rows that need backfill. Show `(N auctions · M missing bid data)` in the auctions header subtitle. Show a footer line `Backfilling K auctions…` while requests are in flight.

- [ ] **Step 16.1: Compute counts**

Add near the `topBuyers` useMemo:

```tsx
const missingBackfillCount = useMemo(
  () => auctions.filter((a) => a.needsBackfill).length,
  [auctions],
);
```

`backfillingCount` is effectively `backfillingId ? 1 : 0` because we throttle to one in flight; we display "Backfilling…" rather than a count.

- [ ] **Step 16.2: Update the auctions header subtitle**

Find the subtitle around line 995-997:

```tsx
<span className="text-sm text-text-tertiary">
  ({auctions.length} {auctions.length === 1 ? 'auction' : 'auctions'})
</span>
```

Replace with:

```tsx
<span className="text-sm text-text-tertiary">
  ({auctions.length} {auctions.length === 1 ? 'auction' : 'auctions'}
  {missingBackfillCount > 0 && ` · ${missingBackfillCount} missing bid data`})
</span>
```

- [ ] **Step 16.3: Add amber clock to the Bids cell**

Find the Bids cell (after Task 1 it reads `{a.totalBids ? a.totalBids : '—'}` around line 1042). Replace with:

```tsx
<td className="px-4 py-2 text-right text-text-primary">
  <span className="inline-flex items-center justify-end gap-1">
    {a.needsBackfill && (
      <Clock
        className={`w-3 h-3 ${
          backfillingId === a.auctionId ? 'text-amber-500 animate-pulse' : 'text-amber-500/60'
        }`}
        aria-label={
          backfillingId === a.auctionId ? 'Backfilling…' : 'Bid data missing — queued for backfill'
        }
      />
    )}
    {a.totalBids ? a.totalBids : '—'}
  </span>
</td>
```

`Clock` is already imported (line 11).

- [ ] **Step 16.4: Add footer line for in-flight backfill**

After the `<table>` closing tag inside the auctions panel (around line 1053), but still inside the auctions container, add:

```tsx
{backfillingId !== null && (
  <div className="px-5 py-2 border-t border-border-subtle bg-bg-tertiary/40 text-xs text-text-tertiary flex items-center gap-2">
    <Loader2 className="w-3 h-3 animate-spin" />
    Backfilling auction {backfillingId}…
  </div>
)}
```

`Loader2` is already imported.

- [ ] **Step 16.5: Type-check + commit**

```
cd desktop && npm run typecheck
git add desktop/src/pages/LiveMonitor.tsx
git commit -m "feat(live-monitor): show backfill status in auctions header, rows, and footer"
```

---

## Phase 4 — Verify and wrap up

### Task 17: Manual end-to-end smoke test

**Files:** none

The desktop app has no automated UI tests. Run through the redesigned screen manually before declaring done.

- [ ] **Step 17.1: Build and launch**

```
cd desktop && npm run electron:dev
```

- [ ] **Step 17.2: Connect to a live (or recently-ended) Whatnot show**

In the app:
1. Log in (web app must be running on port 3000 or the URL set in localStorage `webAppUrl`).
2. Navigate to Live Monitor.
3. Paste a Whatnot show URL. Click Connect.

- [ ] **Step 17.3: Verify each redesign element**

Walk through and confirm each:

- [ ] Stats row shows 6 cards: Items Sold, Gross Revenue, Net Earned, **Unique Buyers**, Pending, Failed Payments.
- [ ] Unique Buyers count matches the number of distinct usernames in the Auctions table (winners) plus any from sales since connect.
- [ ] Top Buyers panel renders with correct top-5, $ toggle works, items toggle works.
- [ ] Printer strip is collapsed by default, summary shows printer/auto/last#, expand shows full controls.
- [ ] Open/close state of printer strip persists across page reload (check by navigating away and back).
- [ ] Troll Detection strip is collapsed by default, summary shows on/off + threshold.
- [ ] Auctions table shows `—` for any row with 0 bids/0 bidders/0 duration (not literal `0`).
- [ ] If at least one auction has `needs_backfill=true` (you may need to disconnect mid-show and let an auction end while disconnected to reproduce), the header subtitle shows the missing-data count, the row has an amber clock, and the footer shows "Backfilling…" while requests are in flight.
- [ ] After backfill completes successfully, the clock disappears, the totals populate, and the row no longer counts toward missing.
- [ ] Failed Payments now appears below the Auctions table, collapsed by default. Auto-expands on first failed payment.

- [ ] **Step 17.4: Note any issues**

Capture any deviations from the spec in `docs/superpowers/specs/2026-05-14-live-monitor-redesign-design.md` under a new `## Implementation Notes — Smoke test findings` section. Decide which to fix in this PR vs file as follow-up.

---

### Task 18: Final type-check + push

- [ ] **Step 18.1: Full type-check**

```
cd desktop && npm run typecheck
cd ../web && npx tsc --noEmit
```

Expected: no errors in either.

- [ ] **Step 18.2: Run all tests one final time**

```
cd desktop && npm test
cd ../web && npx vitest run tests/api/live-auctions
```

Expected: all PASS.

- [ ] **Step 18.3: Push the branch**

```
git push origin feature/sales-foundation
```
