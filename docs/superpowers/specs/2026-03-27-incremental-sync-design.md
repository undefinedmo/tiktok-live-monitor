# Incremental Sync Design

## Problem

All sync types (orders, shipments, messages, shows) re-fetch every record from scratch on every sync. This causes:
- 10+ minute sync times for orders and shipments (~2500 records each)
- Whatnot access token expires after ~2 minutes, causing auth failures mid-sync
- Unnecessary API load and DB churn for data that hasn't changed

The DB write path is the primary bottleneck: each record is upserted individually in a sequential loop. For 2500 orders, that's ~10,000 sequential DB queries (customer upsert + order upsert + item upsert + seek calculation per order), each taking 100-280ms.

## Solution

Two complementary fixes:
1. **Incremental sync** — paginate newest-first and stop when we hit records already in the DB. A `force` flag bypasses this for full re-syncs.
2. **Batch DB operations** — replace sequential individual upserts with batched bulk operations using `prisma.$transaction` and raw SQL `INSERT ... ON CONFLICT` for bulk upserts.

## Detection Strategy

Each page of API results is checked against the DB by Whatnot ID. If every record on a page already exists, pagination stops. If even one record is new, keep paginating. No new DB tables or cursor tracking needed.

## Per-Type Behavior

### Orders (currently ~50 pages, ~2500 records, ~10 min)
- API: `sortDirection: desc` (newest first)
- Check: each page's order UUIDs against `orders` table
- Stop: when a full page of orders already exists in DB
- Expected incremental: 1-2 pages (~10-20s)

### Shipments (currently ~50 pages, ~2500 records, ~10 min)
- API: newest first (default order)
- Check: each page's shipment IDs against `shipments` table
- Stop: when a full page already exists
- Expected incremental: 1-2 pages (~10-20s)

### Shows (currently ~3 pages, ~131 records, ~8s)
- API: `reverse: true` (newest first)
- Check: each page's livestream IDs against `shows` table
- Stop: when a full page already exists
- Already fast; incremental keeps it consistent

### Messages (currently 100 pages convos + 422 individual fetches, ~2+ min)
- **Phase 1:** Always fetch full conversation list (cheap, ~4 pages). Upsert all conversations to DB as today.
- **Phase 2:** For each conversation, compare API's `mostRecentDirectMessage.serverTimeUTC` against DB's `lastMessageAt`.
- **Skip** conversations where timestamps match (no new messages).
- **Fetch messages** only for conversations with newer timestamps.
- Expected incremental: full convo list + 5-10 message fetches instead of 422 (~15-30s)

### Customers / Products
- Map to orders sync. Inherit the same incremental behavior.

## Force Sync

`force: true` bypasses the stop-early check. Same behavior as the current full sync.

Triggered by:
- Per-type "Force Full Sync" button in Sync Center
- "Force Full Re-Sync All" option
- Never by the scheduler (always incremental)

## API Changes

### Middleware `POST /api/sync/trigger`

Request body adds optional `force` field:
```json
{ "type": "orders", "force": true }
```
Defaults to `false` (incremental). Existing callers unaffected.

### `SyncJobData` type

Add `force?: boolean` field. Passed through the chain:
```
web route → middleware route → queueSyncJob → SyncJobData → syncWorker → operation function
```

### `SyncJobResult` type

Add fields for logging:
```typescript
{
  wasIncremental: boolean;
  newRecords: number;
  skippedPages: number;
}
```

## Code Changes

### 1. Data types (`queue.ts`)
- Add `force?: boolean` to `SyncJobData`
- Add `wasIncremental`, `newRecords`, `skippedPages` to `SyncJobResult`

### 2. Trigger routes
- `middleware/src/api/routes/sync.routes.ts`: accept `force` in Zod schema, pass to `queueSyncJob`
- `web/src/app/api/sync/trigger/route.ts`: accept `force`, forward to middleware
- `queueSyncJob`: pass `force` into job data

### 3. Sync worker (`syncWorker.ts`)
- Extract `force` from `job.data`
- Pass to each operation function

### 4. Fetch functions (add `incremental` option)

Each paginated fetch function gets an `incremental?: boolean` option (default `true` when `force` is false):

**`fetchOrders(tenantId, { incremental })`**
- After each page, batch-check order UUIDs against DB
- If all exist on a page, stop and return what we have
- Track `newRecords` and `skippedPages`

**`fetchLivestreams(tenantId, { incremental })`**
- Same pattern with livestream IDs

**`fetchShipments(tenantId, { incremental })`**
- Same pattern with shipment IDs

**`fetchAllConversations(tenantId)`**
- Always fetch all (cheap). No incremental change here.

### 5. Message sync (`fullMessageSync`)
- After fetching all conversations, load existing conversations from DB with `lastMessageAt`
- For each conversation, compare API's `mostRecentDirectMessage.serverTimeUTC` with DB's `lastMessageAt`
- Skip `fetchMessages` call for conversations where timestamps match
- When `force: true`, fetch messages for all conversations (current behavior)

### 6. `executePaginatedGraphQL` enhancement
- Add optional `shouldStop` callback: `(edges: unknown[]) => Promise<boolean>`
- Called after each page with that page's edges
- If returns `true`, stop pagination early
- Existing `refreshCookies` callback unaffected

### 7. Batch DB operations

Replace sequential `for` loop + individual `prisma.*.upsert()` with bulk operations:

**Strategy:** Use `prisma.$transaction` with raw SQL `INSERT ... ON CONFLICT DO UPDATE` for true bulk upserts. Prisma's `createMany` doesn't support upsert natively, so we use `$executeRawUnsafe` for bulk upserts in chunks of 500.

**`syncOrdersToDb` (orders.ts) — currently ~10,000 sequential queries for 2500 orders:**
1. **Batch customer upsert:** Collect unique buyers, bulk `INSERT ... ON CONFLICT` into `customers` table. One query for all customers instead of 2500.
2. **Batch order upsert:** Bulk `INSERT ... ON CONFLICT` into `orders` table. One query per chunk of 500 instead of 2500 individual upserts.
3. **Batch item upsert:** Same bulk approach for items table.
4. **Batch seek time calculation:** Collect all showIds, batch-query show start times, batch-update seek times.
5. Wrap all batches in a single `prisma.$transaction` for atomicity.

**`syncShipmentsToDb` (shipments.ts) — currently ~5,000 sequential queries for 2500 shipments:**
1. **Batch shipment upsert:** Bulk `INSERT ... ON CONFLICT` into `shipments` table.
2. **Batch order status update:** Collect all orderUuids, single `UPDATE orders SET status = 'shipped' WHERE whatnot_order_id IN (...)`.

**`syncConversationsToDb` (messages.ts) — currently ~850 sequential queries for 422 conversations:**
1. **Batch customer upsert:** Same as orders.
2. **Batch conversation upsert:** Bulk `INSERT ... ON CONFLICT` into `conversations` table.

**`syncMessagesToDb` (messages.ts) — per-conversation, typically small:**
- Keep as-is (usually <100 messages per conversation, already fast enough).
- With incremental sync skipping unchanged conversations, this path is called rarely.

**Helper function:** Create a reusable `bulkUpsert(tableName, records, conflictKeys, updateKeys)` utility that generates and executes the bulk SQL. Used by all sync operations.

### 8. Desktop Sync Center UI
- Existing sync button per type: triggers incremental (default)
- Add context menu or secondary action: "Force Full Sync"
- Existing "Sync All" button: incremental
- Add "Force Full Re-Sync" option (dropdown or separate button)
- Sync history logs show "Incremental" vs "Full" badge

## Performance Impact

### Incremental sync (typical daily use)

| Type | Current | Incremental | Improvement |
|------|---------|-------------|-------------|
| Orders | ~10 min (50 pages, 10K queries) | ~10-20s (1-2 pages) | ~30-60x faster |
| Shipments | ~10 min (50 pages, 5K queries) | ~10-20s (1-2 pages) | ~30-60x faster |
| Messages | ~2+ min (422 fetches) | ~15-30s (5-10 fetches) | ~4-8x faster |
| Shows | ~8s (3 pages) | ~5s (1-2 pages) | ~1.5x faster |

Token expiration is no longer a concern for incremental syncs since they complete well within the ~2 minute window.

### Force full sync (new client onboard)

| Type | Current | With batch DB | Improvement |
|------|---------|---------------|-------------|
| Orders (2500) | ~10 min (10K sequential queries) | ~30-60s (API fetch + ~5 bulk queries) | ~10-20x faster |
| Shipments (2500) | ~10 min (5K sequential queries) | ~30-45s (API fetch + ~3 bulk queries) | ~13-20x faster |
| Messages (422 convos) | ~2+ min | ~45-90s (bulk convo upsert + selective message fetch) | ~2-3x faster |
| Shows (131) | ~8s | ~5s (already fast) | ~1.5x faster |

Full onboard sync (all types): **~2-3 minutes** instead of **~25+ minutes**.

## What Doesn't Change
- Upsert semantics (insert or update) stay the same — just batched
- DB schema unchanged (no cursor table needed)
- Scheduler intervals unchanged
- Data correctness — same records, same fields, same conflict resolution
