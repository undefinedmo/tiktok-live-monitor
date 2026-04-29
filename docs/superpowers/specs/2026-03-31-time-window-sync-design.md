# Time-Window Sync Engine Design

**Date:** 2026-03-31
**Status:** Approved
**Scope:** Desktop sync engine, middleware ingest, Sync Center UI, settings

## Problem

The current sync engine uses arbitrary page counts as stop conditions (5 pages incremental, 50 pages force). This means:

1. Incremental sync fetches a fixed number of recent records regardless of time coverage
2. Refunded/cancelled orders outside the page window are never caught — Whatnot allows refunds up to 30 days from transaction or 14 days after receipt
3. "Customers" and "Products" are fake sync types that just call the orders fetch with more pages
4. No way for the user to control sync depth

## Solution

Replace page-count-based pagination with **time-window-based pagination**. Sync fetches all records within a configurable lookback window (default 30 days). Merge orders/customers/products into a single "Sales Data" sync type.

## Sync Types

| UI Card | Subtitle | Ingest Endpoint | What it syncs | Stop condition |
|---------|----------|-----------------|---------------|----------------|
| Sales Data | Syncs orders, customers, and products | `/api/sync/ingest/orders` | Orders + items + customers + products | Date-based: oldest record < cutoff |
| Shows | Sync live and past show data | `/api/sync/ingest/shows` | Livestream shows | All pages (shows dataset is small) |
| Shipments | Sync shipment and tracking data | `/api/sync/ingest/shipments` | Shipments + order status | Date-based: oldest record < cutoff |
| Messages | Sync conversations | `/api/sync/ingest/conversations` | Conversations | All pages (lightweight) |

## Pagination Stop Condition

**Current:** `page <= maxPages` — stops after N pages regardless of date coverage.

**New:**

```
cutoffDate = now - syncWindowDays
maxPages = 200  // safety cap to prevent runaway syncs

for each page:
  fetch page from Whatnot API (newest first)
  collect records
  oldestRecordDate = min(record.createdAt for record in page)
  if oldestRecordDate < cutoffDate: stop  // covered the full window
  if !hasNextPage: stop                    // no more data
  if page >= maxPages: stop               // safety cap
```

**Force sync:** Ignores `cutoffDate` — fetches all pages up to `maxPages` safety cap.

**Which sync types use date cutoff:**
- Sales Data (orders): YES — 30-day default covers the refund window
- Shipments: YES — 30-day default matches the order window
- Shows: NO — fetches all (small dataset, typically <200 shows)
- Messages: NO — fetches all conversations (lightweight, no date on conversation edges)

## Settings

**New setting:** `syncWindowDays`
- **Storage:** `settingsStore` in Electron store (non-secret, plain)
- **Default:** `30` (not hardcoded — stored as default value in settingsStore)
- **UI location:** Desktop Settings page
- **Label:** "Sync Lookback Window (days)"
- **Note:** "Whatnot allows refunds up to 30 days from transaction date. Orders and shipments within this window are re-synced to catch refunds, cancellations, and payment status changes."
- **Input type:** Number input, min 7, max 365

## Desktop Changes

### `desktop/electron/lib/whatnot-sync.ts`

**`fetchOrders()`** — Change signature from `fetchOrders(maxPages: number)` to `fetchOrders(options: { cutoffDate?: Date; maxPages?: number })`.

The paginate function already receives edges per page. After each page, check the oldest record's `createdAt`. If it's before `cutoffDate`, stop paginating. The 200-page safety cap remains as `maxPages` default.

**`fetchShipments()`** — Same change. Check oldest shipment's `createdAt` against cutoff.

### `desktop/electron/ipc/sync.ts`

- Remove `customers` and `products` from the switch statement — they no longer exist as separate types
- Read `syncWindowDays` from store at sync start
- Calculate `cutoffDate = new Date(Date.now() - syncWindowDays * 24 * 60 * 60 * 1000)`
- Pass `{ cutoffDate }` to `fetchOrders()` and `fetchShipments()`
- Force sync passes `{ cutoffDate: undefined }` (no cutoff)
- `trigger-all` runs: `['shows', 'orders', 'shipments', 'messages']` (no customers/products)

### `desktop/src/pages/SyncCenter.tsx`

- Remove "Customers" and "Products" sync type cards
- Rename "Orders" card to "Sales Data" with subtitle "Syncs orders, customers, and products"
- Remove the `customers` and `products` entries from the `syncTypes` array

### `desktop/src/pages/Settings.tsx` (or equivalent settings page)

- Add "Sync Lookback Window (days)" number input
- Reads/writes `syncWindowDays` from store via IPC
- Show note text below the input

### `desktop/electron/lib/store.ts`

- Add `syncWindowDays: number` to `SettingsSchema` with default `30`

## Middleware Changes

### `middleware/src/api/routes/ingest.routes.ts`

- Orders ingest: SyncJob `type` stays as `'orders'` (no more `syncType` override — there's only one type that calls this endpoint now)

## Web Changes

### `web/src/app/api/sync/status/route.ts`

- Remove `'customers'` and `'products'` from the `syncTypes` array — they no longer exist as separate sync types
- Keep `['orders', 'shows', 'shipments', 'messages']`

## What Doesn't Change

- The ingest endpoints themselves — same payload format, same processing logic
- bulkUpsert with ON CONFLICT — already handles re-syncing existing records (updates status, amounts, etc.)
- The middleware's SyncJob tracking — still creates/completes jobs per sync
- The desktop's shared sync state (useSync/useSyncTrigger) — same progress flow
- Shows and Messages sync — no date cutoff, unchanged behavior
- USPS tracking polling — separate mechanism, unaffected

## Migration

No database migration needed. The sync window setting is desktop-only (Electron store). Existing SyncJob records with `type: 'customers'` or `type: 'products'` become orphaned but harmless — they'll just never match a status query again.
