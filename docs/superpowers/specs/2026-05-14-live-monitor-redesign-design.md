# Live Monitor Redesign

**Date:** 2026-05-14
**Status:** Approved
**Scope:** Desktop v2 — `desktop/src/pages/LiveMonitor.tsx`, supporting electron IPC for auction backfill, and a new web API endpoint for unique-buyer rehydration.

Companion mockup: `docs/superpowers/mockups/2026-05-14-live-monitor-redesign.html`

## Problem

Three issues with the current Live Monitor:

1. **No buyer visibility.** Stats row shows items/revenue/pending but not how many unique people bought, nor who they are. During a show the operator can't tell at a glance whether 100 items went to 12 whales or 80 different buyers.
2. **Printer panel always renders.** Printer Settings, Quick Print, and Troll Detection occupy the full right column for the entire show even after the printer is configured and auto-print is humming. That's prime screen real estate being burned on rarely-changed settings.
3. **Auctions table shows phantom zeros.** When the WebSocket connects mid-show and the listener never sees an auction's `auction_started` or bid events, `finalizeAuction()` falls back to an empty record (`bids=[]`, `uniqueBidders=new Set()`, `startTime=null`). Persisted rows then show `0 bids · 0 bidders · 0s` even though the auction had a winner and a final price. Visually indistinguishable from a real "no bidders" auction.

## Design

### 1. Stats row: add Unique Buyers

`grid-cols-2 lg:grid-cols-5` → `grid-cols-2 lg:grid-cols-6`. New card between **Net Earned** and **Pending**:

- **Label:** "Unique Buyers"
- **Value:** count of distinct buyer usernames seen during this live show
- **Sub-line:** `${(itemsSold / uniqueBuyers).toFixed(1)} items/buyer` (omit when `uniqueBuyers === 0`)

**Data source — hybrid in-memory + DB rehydrate:**

A new piece of state, `uniqueBuyers: Set<string>`, lives in `LiveMonitor.tsx`. It's populated from two sources:

1. **On connect / `liveId` change:** fetch all persisted auctions for the show (already happens via `apiClient.get('/api/live-auctions', { showId })`) and seed the set with every non-null `winnerUsername`. This survives reconnects and page reloads.
2. **On each `sale_detected` event:** `setUniqueBuyers(prev => new Set(prev).add(sale.buyer.username))`.

The seed runs in the same `useEffect` that already rehydrates auctions — no second round-trip. Sales-feed adds during the session are merged in addition to the seed (a buyer can win an auction we missed and later be seen again in the sales feed; the Set deduplicates).

**On disconnect:** clear the set (matches existing `sessionItemCount` / `sessionRevenue` reset behavior).

### 2. Top Buyers panel

New panel in the right rail, below the collapsed Printer strip. Header: "Top Buyers" + a small `$` / `items` segmented toggle (default: `$`).

**Data source:** derived from the same persisted-auctions + in-session-sales merge as Unique Buyers. We build a per-buyer aggregate:

```ts
type BuyerAgg = { username: string; itemCount: number; totalCents: number };
```

- From persisted auctions: each row with `winnerUsername` and `finalPriceCents` contributes 1 item and `finalPriceCents`.
- From in-session sales: each `LiveSale` contributes 1 item and `price.amount` (already cents).

To avoid double-counting a sale that's both a persisted auction and a sales-feed event during the same session, we key the contribution by `auctionId` when available; sales without a matching `auctionId` (manual buys, BIN purchases) are added as-is. This is consistent with how the existing auction de-dupe works in `LiveMonitor.tsx:387-396` (match by `auctionId`).

**Render:** top 5 by the selected metric. Rank number, `@username`, item count, total. Truncate username at panel width.

**Toggle state:** local `useState<'spend' | 'items'>('spend')`. No persistence — resets on page reload (acceptable for a live-show UI).

### 3. Collapsed Printer strip

Replace the three right-column cards (Printer Settings, Quick Print) with a single `<details>` element that collapses to a one-line summary:

```
🖨  ZDesigner ZD420  ·  Auto · On  ·  last #27         ⌄
```

When expanded, the same controls render that exist today (printer select, auto-print toggle, quick-print next/custom). Print Queue remains its own always-visible panel — operators watch it during a show.

**Default state:** collapsed on mount. Persisted in `localStorage` under `liveMonitor.printerPanelOpen` so a user who likes it expanded keeps it expanded across sessions.

**Troll Detection panel:** same treatment — collapsed `<details>` summary shows on/off state. Default collapsed.

**Implementation:** native HTML `<details>`/`<summary>` keeps it accessible and avoids a controlled-state React boilerplate. Style summary to match the existing card chrome.

### 4. Auctions table: em-dash + missing-data flag

**Display fix (immediate):** in `LiveMonitor.tsx:1042-1046`, treat `0` and `null`/`undefined` the same — render `—` for `totalBids`, `uniqueBidders`, and `durationSeconds` whenever the value is falsy. The winner column already does this correctly.

```tsx
{a.totalBids ? a.totalBids : '—'}
{a.uniqueBidders ? a.uniqueBidders : '—'}
{a.durationSeconds ? `${a.durationSeconds}s` : '—'}
```

This is purely cosmetic but immediately stops the false-zero noise.

**Why no GraphQL backfill:** the original spec proposed querying `auctionDetails(id:)` to recover bid history for auctions we joined mid-stream. Investigation against v0 (`app/src/ipc/label-generator.js`) and v1 (`sellerfolio-desktop/electron/ipc/label-generator.ts`) confirmed that **bids are captured only from WebSocket events** (`new_bid`, `bid_placed`, `product_changed.highestBid`). Both legacy versions have a `backfillSales()` function, but it queries `LiveShopSold` for sales backfill only — neither version has ever queried Whatnot for post-hoc bid history, and no such endpoint is known to exist. Bids missed are unrecoverable.

**Compromise — make "missed" visible:** when `finalizeAuction()` in `desktop/electron/ipc/label-generator.ts` hits the `!auction` fallback branch (line 152), we know the listener never observed the auction's bid stream. Set a `needsBackfill: true` flag on the emitted payload so the renderer can distinguish "we know we missed this" from "this auction genuinely had no bids."

**Flow:**

1. `finalizeAuction()` sets `needsBackfill: true` on the fallback branch.
2. Layout-level listener persists the row via existing `/api/live-auctions` POST, including the flag.
3. Renderer reads the flag and renders an amber clock icon next to the "Bids" cell with tooltip "Bid data missing — joined mid-auction." Header subtitle shows `(N auctions · M missing bid data)`. The flag never clears for that row — it's a permanent record of "we don't know."

**Schema change:** add `needs_backfill BOOLEAN DEFAULT FALSE` to the `live_auctions` table. Migration is additive and safe.

**Future work:** if a Whatnot endpoint for archived bid history is ever discovered (e.g. via mobile app reverse engineering or a replay-mode GraphQL query), the flag becomes the trigger for an opt-in "Recover bid data" button per row. Not in scope here.

### 5. Layout summary

```
┌───────────────────────────────────────────────────────────┐
│ Connection panel (unchanged)                              │
├───────────────────────────────────────────────────────────┤
│ Items | Gross | Net | Unique Buyers | Pending | Failed    │
├──────────────────────────────────┬────────────────────────┤
│                                  │  🖨 Printer strip ⌄    │
│         Sales Feed (2/3)         │  Top Buyers ($ |items) │
│                                  │  Print Queue           │
│                                  │  🛡 Troll Detection ⌄  │
├──────────────────────────────────┴────────────────────────┤
│ Auctions (full width)                                     │
└───────────────────────────────────────────────────────────┘
```

Failed Payments today renders as both a stats card and a full right-rail panel. The card stays in the stats row and turns red when count > 0. The panel becomes a collapsed `<details>` element placed below the Auctions table — same expand/collapse pattern as the Printer and Troll strips, default collapsed, auto-expands the first time `failedPayments.length` transitions from 0 to non-zero.

## Files Modified

| File | Change |
|------|--------|
| `desktop/src/pages/LiveMonitor.tsx` | Add `uniqueBuyers` state + seed from persisted auctions; add Top Buyers panel + toggle; collapse Printer + Troll into `<details>`; em-dash for zero/null auction metrics; render amber clock for `needsBackfill` rows |
| `desktop/electron/ipc/label-generator.ts` | `finalizeAuction()` sets `needsBackfill: true` when the active-auction record is missing; payload includes the flag |
| `web/src/app/api/live-auctions/route.ts` | Accept `needsBackfill` on POST |
| `web/prisma/schema.prisma` | Add `needsBackfill Boolean @default(false)` to `LiveAuction` |
| `web/prisma/migrations/<timestamp>_live_auction_backfill_flag/migration.sql` | New migration |

## Out of Scope

- Failed Payments detail panel layout (collapses; not redesigned).
- Sales Feed row design (unchanged — only the surrounding chrome changes).
- OBS overlay (untouched).
- Per-buyer drill-down ("click buyer to see their items") — defer; Top Buyers list is read-only for now.
- Recovering bid history for auctions joined mid-stream — not feasible with any known Whatnot endpoint (see Section 4).
- Persisting Top Buyers toggle preference across reloads.
