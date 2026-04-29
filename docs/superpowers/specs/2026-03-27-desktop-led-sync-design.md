# Desktop-Led Sync Design

## Problem

The middleware makes Whatnot API calls with tokens it can't refresh. Whatnot access tokens expire in ~2 minutes. Only the desktop's Electron BrowserWindow can refresh them via silent page load. This creates a fragile chain: desktop registers cookies → middleware stores/decrypts/uses them → token expires mid-sync → middleware asks desktop to refresh via WebSocket → desktop may or may not respond in time → sync fails → BullMQ retries create zombie jobs.

Layers of retry/refresh/recovery logic (server-side refresh, mid-sync token polling, cookie re-fetch during pagination) have been added but fundamentally can't solve the problem: the middleware cannot refresh tokens.

## Solution

Move all Whatnot API fetching to the desktop. The desktop has a real browser with cookies that Whatnot refreshes automatically. The middleware becomes a data store that receives fetched data and bulk-upserts it to the database.

```
Current (broken):
Desktop → registers cookies → Middleware → calls Whatnot API → stores in DB
                                          ↑ token expires, can't refresh

New (robust):
Desktop → calls Whatnot API → sends raw data → Middleware → stores in DB
        ↑ real browser, tokens auto-refresh     ↑ receives + stores only
```

## Architecture

### Data Flow — Scheduled Sync

1. Middleware scheduler fires on interval
2. Broadcasts `sync:request` event via WebSocket to each tenant's room (not globally): `{ type: 'orders', force: false }`
3. Desktop receives event (only desktops belonging to that tenant)
4. Desktop fetches data from Whatnot API using `session.defaultSession.fetch()` (real browser cookies, no extraction needed)
5. Desktop posts raw data to `POST /api/sync/ingest/{type}`
6. Middleware bulk-upserts to DB
7. Middleware creates SyncJob record, broadcasts `sync:completed`

### Data Flow — Manual Sync

1. User clicks sync button in desktop UI
2. Desktop renderer sends IPC to main process
3. Desktop main process fetches from Whatnot API
4. Posts raw data to middleware ingest endpoint
5. Middleware bulk-upserts, creates SyncJob, broadcasts completion
6. Desktop renderer updates UI from IPC response

### Data Flow — Messages (On-Demand)

Messages are NOT synced in background. When user clicks a conversation:
1. Desktop fetches messages from Whatnot API for that conversation
2. Posts to `POST /api/sync/ingest/messages`
3. Middleware upserts messages for that conversation only

## New Middleware Endpoints

### `POST /api/sync/ingest/orders`

Receives raw order data from desktop. Authenticated via service token.

Request:
```json
{
  "records": [ { WhatnotOrder objects } ],
  "force": false,
  "totalPages": 3
}
```

Processing:
1. Create SyncJob record (status: active)
2. Bulk upsert customers (deduplicated by buyer username)
3. Bulk upsert orders
4. Bulk upsert items (extracted from order.items.edges)
5. Calculate seek times
6. Run system rules
7. Update SyncJob (status: completed, counts)
8. Broadcast sync:completed

Response:
```json
{
  "success": true,
  "jobId": "uuid",
  "counts": { "orders": 50, "items": 50, "customers": 39 }
}
```

### `POST /api/sync/ingest/shipments`

Same pattern. Bulk upserts shipments + batch-updates order statuses.

### `POST /api/sync/ingest/shows`

Same pattern. Bulk upserts shows.

### `POST /api/sync/ingest/conversations`

Same pattern. Bulk upserts conversations + customers.

### `POST /api/sync/ingest/messages`

Receives messages for a single conversation. Upserts messages.

Request:
```json
{
  "conversationId": "whatnot-conv-id",
  "messages": [ { WhatnotMessage objects } ]
}
```

## Desktop Fetch Module

### New file: `desktop/electron/lib/whatnot-sync.ts`

Uses `session.defaultSession.fetch()` for all Whatnot API calls. This attaches the real browser cookies automatically — no cookie extraction, serialization, or encryption needed.

Functions:
- `fetchOrders(maxPages: number): Promise<WhatnotOrder[]>`
- `fetchShipments(maxPages: number): Promise<ShipmentData[]>`
- `fetchShows(maxPages: number): Promise<WhatnotLivestream[]>`
- `fetchConversations(maxPages: number): Promise<WhatnotConversation[]>`
- `fetchMessages(conversationId: string, limit: number): Promise<WhatnotMessage[]>`

Each function:
- Executes paginated GraphQL queries against `https://www.whatnot.com/services/graphql/`
- Handles pagination (cursor-based, same queries as current middleware)
- On 401: attempts silent login (hidden BrowserWindow), retries once
- Returns raw API data (no DB operations)

GraphQL queries and TypeScript types move to `@sellerfolio/shared` (or are duplicated in the desktop — queries are small, ~20 lines each).

### Incremental vs Force

- **Incremental (default):** Desktop fetches 3-5 pages per type. Middleware's bulk upsert with `ON CONFLICT` handles deduplication. No per-page existence checks needed.
- **Force:** Desktop fetches all pages (maxPages: 50+). Same ingest endpoint, just more data.

The middleware doesn't need to know whether a sync was incremental or force — it just receives records and upserts them.

## Desktop Sync Coordinator

### New file: `desktop/electron/lib/sync-coordinator.ts`

Central coordinator for all sync operations.

Responsibilities:
- Listens for `sync:request` WebSocket events from middleware scheduler
- Listens for IPC calls from renderer (manual trigger from UI)
- Calls whatnot-sync.ts fetch functions
- Posts results to middleware ingest endpoints via apiClient
- Reports progress to renderer via IPC events
- Handles errors (auth, network, middleware down)

### IPC Handlers

- `sync:trigger` — renderer requests a sync: `{ type: 'orders', force: false }`
- `sync:trigger-all` — renderer requests all syncs: `{ force: false }`
- `sync:status` — renderer requests current sync status

### IPC Events (to renderer)

- `sync:progress` — `{ type, status: 'fetching' | 'uploading' | 'complete' | 'error', progress, message }`
- `sync:completed` — `{ type, counts, duration }`
- `sync:error` — `{ type, error }`

## What Gets Deleted from Middleware

- `whatnot/client.ts` — GraphQL client (moves to desktop)
- `whatnot/operations/orders.ts` — fetch functions removed, sync-to-DB functions move to ingest route
- `whatnot/operations/shipments.ts` — same
- `whatnot/operations/messages.ts` — same
- `auth/cookieStore.ts` — no more cookie storage/encryption
- `auth/tokenRefresher.ts` — delete entirely
- `auth/sessionManager.ts` — simplified (no cookie validation needed)
- `jobs/workers/syncWorker.ts` — no more background job processing
- `jobs/queue.ts` — BullMQ queue removed (no background jobs)
- All refresh/retry/recovery logic
- Redis dependency for BullMQ (may keep for other uses)

## What Stays in Middleware

- `lib/bulkUpsert.ts` — batch DB operations (working, tested)
- New ingest route handlers — receive data, call bulk upsert, track jobs
- Scheduler — simplified, just broadcasts WebSocket events on intervals
- WebSocket hub — communication with desktop
- SyncJob model — record start/complete/fail for UI display (created by ingest endpoints, not BullMQ)
- Logger with file output

## What Changes in Desktop

### New files:
- `electron/lib/whatnot-sync.ts` — Whatnot API fetch functions
- `electron/lib/sync-coordinator.ts` — sync orchestration

### Modified files:
- `electron/main.ts` — register sync IPC handlers, initialize coordinator
- `src/hooks/useSync.ts` — trigger syncs via IPC instead of web API
- `src/pages/SyncCenter.tsx` — minor (trigger calls change)

### Removed from desktop:
- Cookie registration flow (no longer needed — desktop uses cookies directly)
- `whatnotAPI.getCookies()` usage for middleware
- Cookie re-registration on session refresh events

## Scheduler Changes

The middleware scheduler simplifies to:

```typescript
// On interval, broadcast to each tenant's connected desktops
const tenantIds = getTenantsWithConnectedClients();
for (const tenantId of tenantIds) {
  broadcastToTenant(tenantId, 'sync:request', { type: 'orders', force: false });
}
```

Sync requests are scoped to tenant rooms — only desktops belonging to that tenant receive the event. No `queueSyncJob`, no `getTenantsWithValidSessions`, no BullMQ. If a desktop is connected, it handles the request. If not, nothing happens.

The scheduler still tracks intervals:
- Messages (conversations): 5 min
- Orders: 15 min
- Shipments: 30 min
- Shows: 1 hour

## Sync Type Behavior

| Type | Desktop fetches | Pages (incremental/force) | Middleware stores |
|------|----------------|--------------------------|-------------------|
| Orders | SellerHubGetMyOrders | 3 / 50 | customers + orders + items + seek times |
| Shipments | GetMyShipments | 3 / 50 | shipments + order status updates |
| Shows | GetLivestreams | 3 / 20 | shows |
| Conversations | GetInboxConversationsV2 | all / all | conversations + customers |
| Messages | GetInboxV2ConversationMessages | on-demand per conversation | messages |

## Error Handling

### Desktop offline
Scheduler broadcasts `sync:request`, no desktop connected. Nothing happens. Next interval tries again. No stuck jobs, no zombie processes.

### Whatnot auth expired
Desktop detects 401 during fetch. Does silent login (hidden BrowserWindow to whatnot.com). Retries the fetch. All local to the desktop — no middleware involvement, no WebSocket round-trips, no 20-second timeouts.

### Middleware down
Desktop fetches succeed but ingest POST fails. Desktop shows error in UI. Data is not lost — desktop can retry the POST when middleware recovers.

### Partial data
Bulk upsert processes chunks of 500. Each chunk is atomic. If chunk 3 of 5 fails, chunks 1-2 are committed, 3-5 are not. The next sync will re-fetch and fill the gaps.

## Migration Path

This is a significant refactor. The migration can be done incrementally:

1. **Phase 1:** Build desktop fetch module + middleware ingest endpoints. Run alongside existing system.
2. **Phase 2:** Switch desktop UI to use new IPC-based sync. Verify everything works.
3. **Phase 3:** Remove old middleware fetch code, BullMQ, cookie store, token refresher.

## What Doesn't Change

- Database schema — same tables, same columns
- Bulk upsert utility — same code, already working
- WebSocket hub — same, used for scheduler events and progress
- Desktop UI layout — same Sync Center page, same buttons
- Web app — unaffected (reads from same DB)
