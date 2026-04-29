# Incremental Sync + Batch DB Operations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace full re-syncs with incremental pagination (stop when caught up) and replace sequential DB upserts with batched bulk operations. Add `force` flag for full re-syncs.

**Architecture:** Paginated API fetches stop early when a page contains only records already in the DB. DB writes use raw SQL `INSERT ... ON CONFLICT DO UPDATE` in chunks of 500. A `force` boolean flows from trigger → queue → worker → operation functions.

**Tech Stack:** TypeScript, Prisma (raw SQL for bulk upserts), BullMQ, PostgreSQL, React (desktop UI)

**Spec:** `docs/superpowers/specs/2026-03-27-incremental-sync-design.md`

---

### Task 1: Bulk Upsert Utility

**Files:**
- Create: `middleware/src/lib/bulkUpsert.ts`

- [ ] **Step 1: Create the bulk upsert utility**

This utility generates and executes `INSERT ... ON CONFLICT DO UPDATE` SQL for any table. It handles parameterization, chunking, and type safety.

```typescript
// middleware/src/lib/bulkUpsert.ts
import prisma from './prisma.js';
import { createChildLogger } from './logger.js';

const logger = createChildLogger('bulk-upsert');

/**
 * Bulk upsert records using raw SQL INSERT ... ON CONFLICT DO UPDATE.
 * Chunks records into batches of `chunkSize` to avoid query size limits.
 *
 * @param table - The SQL table name (e.g. 'orders', 'customers')
 * @param records - Array of objects to upsert. All must have the same keys.
 * @param conflictColumns - Column(s) that form the unique constraint (e.g. ['whatnot_order_id'])
 * @param updateColumns - Column(s) to update on conflict. If empty, do nothing on conflict.
 * @param chunkSize - Max records per INSERT statement (default 500)
 * @returns Total number of records upserted
 */
export async function bulkUpsert(
  table: string,
  records: Record<string, unknown>[],
  conflictColumns: string[],
  updateColumns: string[],
  chunkSize = 500
): Promise<number> {
  if (records.length === 0) return 0;

  const columns = Object.keys(records[0]);
  let total = 0;

  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);

    // Build parameterized values: ($1, $2, ...), ($N+1, $N+2, ...)
    const valuePlaceholders: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const record of chunk) {
      const placeholders: string[] = [];
      for (const col of columns) {
        placeholders.push(`$${paramIndex}`);
        params.push(record[col] ?? null);
        paramIndex++;
      }
      valuePlaceholders.push(`(${placeholders.join(', ')})`);
    }

    const colList = columns.map((c) => `"${c}"`).join(', ');
    const conflictList = conflictColumns.map((c) => `"${c}"`).join(', ');

    let onConflict: string;
    if (updateColumns.length > 0) {
      const updates = updateColumns
        .map((c) => `"${c}" = EXCLUDED."${c}"`)
        .join(', ');
      onConflict = `ON CONFLICT (${conflictList}) DO UPDATE SET ${updates}`;
    } else {
      onConflict = `ON CONFLICT (${conflictList}) DO NOTHING`;
    }

    const sql = `INSERT INTO "${table}" (${colList}) VALUES ${valuePlaceholders.join(', ')} ${onConflict}`;

    try {
      await prisma.$executeRawUnsafe(sql, ...params);
      total += chunk.length;
    } catch (error) {
      logger.error({ error, table, chunkIndex: i, chunkSize: chunk.length }, 'Bulk upsert chunk failed');
      throw error;
    }
  }

  logger.debug({ table, total }, 'Bulk upsert complete');
  return total;
}

/**
 * Batch check which IDs already exist in a table.
 * Used by incremental sync to detect when to stop pagination.
 *
 * @param table - SQL table name
 * @param idColumn - The column to check (e.g. 'whatnot_order_id', 'id')
 * @param ids - Array of IDs to check
 * @returns Set of IDs that already exist
 */
export async function batchCheckExistence(
  table: string,
  idColumn: string,
  ids: string[]
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();

  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `SELECT "${idColumn}"::text as id FROM "${table}" WHERE "${idColumn}" IN (${placeholders})`;

  const results = await prisma.$queryRawUnsafe<Array<{ id: string }>>(sql, ...ids);
  return new Set(results.map((r) => r.id));
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd middleware && npx tsc --noEmit 2>&1 | grep bulkUpsert`
Expected: No errors from this file.

- [ ] **Step 3: Commit**

```bash
git add middleware/src/lib/bulkUpsert.ts
git commit -m "feat: add bulk upsert and batch existence check utilities"
```

---

### Task 2: Add `force` Flag Through the Chain

**Files:**
- Modify: `middleware/src/jobs/queue.ts` — `SyncJobData`, `SyncJobResult`, `queueSyncJob`
- Modify: `middleware/src/api/routes/sync.routes.ts` — Zod schema
- Modify: `web/src/app/api/sync/trigger/route.ts` — forward `force`
- Modify: `middleware/src/jobs/workers/syncWorker.ts` — pass `force` to operations

- [ ] **Step 1: Update `SyncJobData` and `SyncJobResult` in `queue.ts`**

In `middleware/src/jobs/queue.ts`, add `force` to `SyncJobData`:

```typescript
export interface SyncJobData {
  tenantId: string;
  type: SyncJobType;
  triggeredBy: 'schedule' | 'manual' | 'webhook';
  userId?: number;
  showIds?: string[];
  force?: boolean; // true = full re-sync, false/undefined = incremental
}
```

Add incremental tracking fields to `SyncJobResult`:

```typescript
export interface SyncJobResult {
  success: boolean;
  type: SyncJobType;
  counts?: {
    conversations?: number;
    messages?: number;
    orders?: number;
    items?: number;
    shipments?: number;
    shows?: number;
  };
  errors: string[];
  duration: number;
  wasIncremental?: boolean;
  newRecords?: number;
  skippedPages?: number;
}
```

Update `queueSyncJob` to accept and pass `force`:

```typescript
export async function queueSyncJob(
  tenantId: string,
  type: SyncJobType,
  triggeredBy: 'schedule' | 'manual' | 'webhook' = 'manual',
  userId?: number,
  showIds?: string[],
  force?: boolean
): Promise<string> {
```

And in the `syncQueue.add` call, include `force`:

```typescript
  await syncQueue.add(`${type}-${tenantId}`, {
    tenantId,
    type,
    triggeredBy,
    userId,
    showIds,
    force,
  }, { jobId: job.id });
```

- [ ] **Step 2: Update middleware sync route to accept `force`**

In `middleware/src/api/routes/sync.routes.ts`, update the Zod schema:

```typescript
const triggerSyncSchema = z.object({
  type: z.enum(['messages', 'orders', 'shipments', 'shows', 'customers', 'products', 'all']),
  showIds: z.array(z.string()).optional(),
  force: z.boolean().optional().default(false),
});
```

Update the handler to pass `force`:

```typescript
        const jobId = await queueSyncJob(
          tenantId,
          body.type as SyncJobType,
          'manual',
          request.serviceUserId,
          body.showIds,
          body.force
        );
```

- [ ] **Step 3: Update web trigger route to forward `force`**

In `web/src/app/api/sync/trigger/route.ts`, extract and forward `force`:

```typescript
    const body = await req.json();
    const { type, showIds, force } = body;
    // ... validation ...
    body: JSON.stringify({ type, showIds, force: force ?? false }),
```

- [ ] **Step 4: Update sync worker to pass `force` to operations**

In `middleware/src/jobs/workers/syncWorker.ts`, extract `force` from job data and pass to each operation. Change the destructuring:

```typescript
  const { tenantId, type, triggeredBy, showIds, force } = job.data;
```

Update each case in the switch to pass `force`. Example for orders:

```typescript
      case 'orders': {
        await updateProgress(20, 'Fetching orders...');
        const result = await fullOrderSync(tenantId, showIds, force);
        // ... rest unchanged
      }
```

Do the same for `messages` (`fullMessageSync(tenantId, force)`), `shows` (`fullShowSync(tenantId, force)`), `shipments` (`fullShipmentSync(tenantId, force)`), `customers`, `products`, and the `all` case.

For the scheduler (scheduled syncs), `force` will be `undefined` which defaults to incremental.

- [ ] **Step 5: Verify it compiles**

Run: `cd middleware && npx tsc --noEmit 2>&1 | grep -E "queue|sync.routes|syncWorker"`
Expected: No new errors from these files (existing errors in rulesRunner.ts etc. are pre-existing).

- [ ] **Step 6: Commit**

```bash
git add middleware/src/jobs/queue.ts middleware/src/api/routes/sync.routes.ts middleware/src/jobs/workers/syncWorker.ts web/src/app/api/sync/trigger/route.ts
git commit -m "feat: add force flag through sync trigger chain"
```

---

### Task 3: Add `shouldStop` Callback to `executePaginatedGraphQL`

**Files:**
- Modify: `middleware/src/whatnot/client.ts`

- [ ] **Step 1: Add `shouldStop` option**

In the `options` parameter of `executePaginatedGraphQL`, add:

```typescript
    /** Callback after each page. If it returns true, stop pagination early. */
    shouldStop?: (pageEdges: unknown[]) => Promise<boolean>;
```

In the pagination loop, after collecting edges and before checking `pageInfo`, add:

```typescript
    // Check if incremental sync should stop (all records on this page already exist)
    if (shouldStop) {
      const stop = await shouldStop(edges);
      if (stop) {
        logger.info({ operationName, page, edgesOnPage: edges.length }, 'Incremental stop: all records on page already exist');
        break;
      }
    }
```

Add `shouldStop` to the destructuring at the top of the function:

```typescript
  const {
    maxPages = 100,
    pageSize = 50,
    getPageInfo,
    getEdges,
    delayMs = 100,
    refreshCookies,
    shouldStop,
  } = options;
```

- [ ] **Step 2: Verify it compiles**

Run: `cd middleware && npx tsc --noEmit 2>&1 | grep client.ts`
Expected: Only the pre-existing `findLast` error, no new errors.

- [ ] **Step 3: Commit**

```bash
git add middleware/src/whatnot/client.ts
git commit -m "feat: add shouldStop callback to executePaginatedGraphQL"
```

---

### Task 4: Incremental + Batch Orders Sync

**Files:**
- Modify: `middleware/src/whatnot/operations/orders.ts`

This is the biggest task — orders has the most complex sync logic (customers + orders + items + seek times).

- [ ] **Step 1: Update `fetchOrders` to support incremental stop**

Add `incremental` to the options and use `shouldStop` + `batchCheckExistence`:

```typescript
import { bulkUpsert, batchCheckExistence } from '../../lib/bulkUpsert.js';

export async function fetchOrders(
  tenantId: string,
  options: {
    maxPages?: number;
    showIds?: string[];
    incremental?: boolean;
  } = {}
): Promise<{ orders: WhatnotOrder[]; errors: string[]; stoppedEarly: boolean }> {
```

Add `stoppedEarly` tracking and pass `shouldStop` to `executePaginatedGraphQL`:

```typescript
  let stoppedEarly = false;

  const result = await executePaginatedGraphQL<OrdersQueryResponse>(
    GET_ORDERS_QUERY,
    variables,
    'SellerHubGetMyOrders',
    cookieData.cookies,
    {
      pageSize: 50,
      maxPages: options.maxPages || 20,
      getPageInfo: (data) => data.me?.orders?.pageInfo ?? { hasNextPage: false, endCursor: null },
      getEdges: (data) => data.me?.orders?.edges ?? [],
      refreshCookies: async () => {
        const fresh = await getCookies(tenantId);
        return fresh?.cookies ?? null;
      },
      shouldStop: options.incremental ? async (edges) => {
        const orderIds = edges.map((e) => ((e as { node: WhatnotOrder }).node).uuid);
        const existing = await batchCheckExistence('orders', 'whatnot_order_id', orderIds);
        const allExist = orderIds.length > 0 && orderIds.every((id) => existing.has(id));
        if (allExist) stoppedEarly = true;
        return allExist;
      } : undefined,
    }
  );
```

Return `stoppedEarly`:

```typescript
  return { orders, errors: result.errors, stoppedEarly };
```

- [ ] **Step 2: Replace `syncOrdersToDb` with batch version**

Replace the sequential for-loop with bulk operations:

```typescript
export async function syncOrdersToDb(
  userId: number,
  orders: WhatnotOrder[],
  tenantId?: string
): Promise<{ synced: number; customersUpdated: number }> {
  if (orders.length === 0) return { synced: 0, customersUpdated: 0 };

  const tid = tenantId || '';
  const now = new Date();

  // 1. Batch customer upsert — collect unique buyers
  const buyerMap = new Map<string, { username: string; netEarnings: number; orderDate: string }>();
  for (const order of orders) {
    const username = order.buyer?.username;
    if (!username) continue;
    const subtotalRaw = order.subtotal?.amount || 0;
    const netEarnings = typeof subtotalRaw === 'number' ? subtotalRaw / 100 : 0;
    const existing = buyerMap.get(username);
    if (existing) {
      existing.netEarnings += netEarnings;
    } else {
      buyerMap.set(username, { username, netEarnings, orderDate: order.createdAt });
    }
  }

  const customerRecords = Array.from(buyerMap.values()).map((b) => ({
    username: b.username,
    whatnot_username: b.username,
    display_name: b.username,
    total_orders: 1,
    total_spent: b.netEarnings,
    last_order_at: new Date(b.orderDate),
    created_at: now,
    updated_at: now,
    user_id: userId,
    tenant_id: tid || null,
  }));

  if (customerRecords.length > 0) {
    await bulkUpsert(
      'customers',
      customerRecords,
      ['whatnot_username', 'tenant_id'],
      ['total_orders', 'total_spent', 'last_order_at', 'updated_at']
    );
  }

  // Fetch customer IDs for order FK
  const customerIdMap = new Map<string, number>();
  if (buyerMap.size > 0) {
    const usernames = Array.from(buyerMap.keys());
    const placeholders = usernames.map((_, i) => `$${i + 1}`).join(', ');
    const rows = await prisma.$queryRawUnsafe<Array<{ id: number; whatnot_username: string }>>(
      `SELECT id, whatnot_username FROM customers WHERE whatnot_username IN (${placeholders}) AND tenant_id = $${usernames.length + 1}`,
      ...usernames,
      tid
    );
    for (const row of rows) {
      customerIdMap.set(row.whatnot_username, row.id);
    }
  }

  // 2. Batch order upsert
  const orderRecords = orders.map((order) => {
    const subtotalRaw = order.subtotal?.amount || 0;
    const netEarnings = typeof subtotalRaw === 'number' ? subtotalRaw / 100 : 0;
    const addr = order.shippingAddress;
    const shippingAddress = addr
      ? [addr.line1, addr.line2, `${addr.city}, ${addr.state} ${addr.postalCode}`, addr.countryCode]
          .filter(Boolean)
          .join('\n')
      : null;

    return {
      id: order.uuid,
      whatnot_order_id: order.uuid,
      buyer_username: order.buyer?.username || null,
      item_title: 'Order',
      item_count: 1,
      total_amount: netEarnings,
      status: order.prettyStatus?.toLowerCase() || 'unknown',
      shipping_name: addr?.fullName || null,
      shipping_address: shippingAddress,
      ordered_at: new Date(order.createdAt),
      customer_id: customerIdMap.get(order.buyer?.username || '') || null,
      created_at: now,
      updated_at: now,
      user_id: userId,
      tenant_id: tid || null,
    };
  });

  await bulkUpsert(
    'orders',
    orderRecords,
    ['whatnot_order_id'],
    ['status', 'customer_id', 'updated_at']
  );

  logger.info({ userId, synced: orders.length, customersUpdated: buyerMap.size, total: orders.length }, 'Orders synced to DB (batch)');

  return { synced: orders.length, customersUpdated: buyerMap.size };
}
```

- [ ] **Step 3: Replace item sync loop with batch version**

In `fullOrderSync`, replace the sequential item loop (lines ~332-402) with a batch approach. After `syncOrdersToDb`, add:

```typescript
  // Batch sync items
  const parseAmount = (val: unknown, isCents = false): number => {
    if (typeof val === 'number') return isCents ? val / 100 : val;
    if (typeof val !== 'string') return 0;
    const cleaned = val.replace(/[$,]/g, '');
    const num = parseFloat(cleaned);
    return Number.isFinite(num) ? num : 0;
  };

  const itemRecords: Record<string, unknown>[] = [];
  const syncedItemIds: string[] = [];

  for (const order of orders) {
    const itemEdges = order.items?.edges ?? [];
    const itemCount = itemEdges.length;

    for (const edge of itemEdges) {
      const node = edge.node;
      const itemId = `${order.uuid}-${node.id}`;
      const listing = node.listing || { id: '', title: 'Unknown item' };
      const livestreamProduct = node.livestreamProduct;
      const livestream = livestreamProduct?.livestream || { id: '', title: 'Unknown show' };
      const receipt = node.sellerReceipt;

      const grossPerItem = itemCount > 0 ? parseAmount(order.subtotal?.amount, true) / itemCount : 0;
      const adjustedNet = parseAmount(receipt?.adjustedEarningsDetails?.netAdjustedEarnings?.amount);
      const rawNet = parseAmount(receipt?.netEarnings?.amount);
      const netEarnings = adjustedNet || rawNet || grossPerItem;
      const isGiveaway = (listing.title || '').toLowerCase().includes('giveaway');

      itemRecords.push({
        id: itemId,
        order_id: order.uuid,
        show_id: livestream.id || null,
        show_title: livestream.title || 'Unknown show',
        item_title: listing.title || 'Unknown item',
        quantity: node.quantity || 1,
        order_date: new Date(order.createdAt),
        gross_amount: grossPerItem,
        net_earnings: netEarnings,
        buyer: order.buyer?.username || null,
        video_url: order.videoReceipt?.videoUrl || null,
        stream_id: livestream.id || null,
        is_giveaway: isGiveaway,
        channel: 'whatnot',
        created_at: new Date(),
        updated_at: new Date(),
        user_id: userId,
        tenant_id: tenantId || null,
      });
      syncedItemIds.push(itemId);
    }
  }

  if (itemRecords.length > 0) {
    await bulkUpsert(
      'items',
      itemRecords,
      ['id'],
      ['net_earnings', 'gross_amount', 'show_title', 'updated_at']
    );
  }
  const itemsSynced = itemRecords.length;
```

- [ ] **Step 4: Update `fullOrderSync` signature and pass `force`**

```typescript
export async function fullOrderSync(
  tenantId: string,
  showIds?: string[],
  force?: boolean
): Promise<OrderSyncResult> {
```

Pass `incremental: !force` to `fetchOrders`:

```typescript
  const { orders, errors: orderErrors, stoppedEarly } = await fetchOrders(tenantId, {
    maxPages: 50,
    showIds,
    incremental: !force,
  });
```

- [ ] **Step 5: Update `fullShowSync` similarly**

```typescript
export async function fullShowSync(
  tenantId: string,
  force?: boolean
): Promise<{ success: boolean; showsCount: number; errors: string[] }> {
```

Add incremental stop to `fetchLivestreams`:

```typescript
export async function fetchLivestreams(
  tenantId: string,
  maxPages = 10,
  incremental = false
): Promise<{ livestreams: WhatnotLivestream[]; errors: string[]; stoppedEarly: boolean }> {
```

With `shouldStop`:

```typescript
      shouldStop: incremental ? async (edges) => {
        const showIds = edges.map((e) => ((e as { node: WhatnotLivestream }).node).id);
        const existing = await batchCheckExistence('shows', 'id', showIds);
        const allExist = showIds.length > 0 && showIds.every((id) => existing.has(id));
        if (allExist) stoppedEarly = true;
        return allExist;
      } : undefined,
```

Pass `force` through: `fetchLivestreams(tenantId, 20, !force)`

- [ ] **Step 6: Verify it compiles**

Run: `cd middleware && npx tsc --noEmit 2>&1 | grep orders.ts`
Expected: No new errors.

- [ ] **Step 7: Commit**

```bash
git add middleware/src/whatnot/operations/orders.ts
git commit -m "feat: incremental fetch + batch DB upserts for orders and shows"
```

---

### Task 5: Incremental + Batch Shipments Sync

**Files:**
- Modify: `middleware/src/whatnot/operations/shipments.ts`

- [ ] **Step 1: Update `fetchShipments` for incremental stop**

```typescript
export async function fetchShipments(
  tenantId: string,
  maxPages = 10,
  incremental = false
): Promise<{ shipments: Array<...>; errors: string[]; stoppedEarly: boolean }> {
```

Add `shouldStop` to the `executePaginatedGraphQL` call:

```typescript
  let stoppedEarly = false;

  // In options:
      shouldStop: incremental ? async (edges) => {
        const ids = edges.map((e) => {
          const node = (e as { node: { id: string } }).node;
          return node.id;
        });
        const existing = await batchCheckExistence('shipments', 'id', ids);
        const allExist = ids.length > 0 && ids.every((id) => existing.has(id));
        if (allExist) stoppedEarly = true;
        return allExist;
      } : undefined,
```

Add import: `import { bulkUpsert, batchCheckExistence } from '../../lib/bulkUpsert.js';`

- [ ] **Step 2: Replace `syncShipmentsToDb` with batch version**

```typescript
async function syncShipmentsToDb(
  userId: number,
  shipments: Array<{...}>,
  tenantId?: string
): Promise<{ synced: number; ordersUpdated: number }> {
  if (shipments.length === 0) return { synced: 0, ordersUpdated: 0 };

  // Deduplicate
  const seen = new Set<string>();
  const unique = shipments.filter((s) => {
    if (seen.has(s.shipmentId)) return false;
    seen.add(s.shipmentId);
    return true;
  });

  const now = new Date();
  const tid = tenantId || null;

  // Batch shipment upsert
  const records = unique.map((s) => ({
    id: s.shipmentId,
    whatnot_shipment_id: s.shipmentId,
    show_id: s.showId || null,
    status: s.status.toLowerCase(),
    buyer_username: s.buyerUsername || null,
    address_full_name: s.addressFullName || null,
    address_country_code: s.addressCountryCode || null,
    total_items: s.totalItems,
    total_value_cents: s.totalValueCents,
    tracking_url: s.trackingUrl || null,
    tracking_code: s.trackingCode || null,
    label_url: s.labelUrl || null,
    bundled_label_url: s.bundledLabelUrl || null,
    courier: s.courier || null,
    shipped_at: new Date(s.createdAt),
    synced_at: now,
    created_at: now,
    updated_at: now,
    user_id: userId,
    tenant_id: tid,
  }));

  await bulkUpsert(
    'shipments',
    records,
    ['id'],
    ['status', 'whatnot_shipment_id', 'buyer_username', 'address_full_name', 'address_country_code', 'total_items', 'total_value_cents', 'tracking_url', 'tracking_code', 'label_url', 'bundled_label_url', 'courier', 'synced_at', 'updated_at']
  );

  // Batch order status update
  const orderUuids = unique
    .map((s) => s.orderUuid)
    .filter((u): u is string => !!u);

  let ordersUpdated = 0;
  if (orderUuids.length > 0) {
    const result = await prisma.order.updateMany({
      where: { whatnotOrderId: { in: orderUuids } },
      data: { status: 'shipped', shippedAt: now },
    });
    ordersUpdated = result.count;
  }

  logger.info({ userId, synced: unique.length, ordersUpdated, total: shipments.length }, 'Shipments synced to DB (batch)');

  return { synced: unique.length, ordersUpdated };
}
```

- [ ] **Step 3: Update `fullShipmentSync` signature**

```typescript
export async function fullShipmentSync(
  tenantId: string,
  force?: boolean
): Promise<ShipmentSyncResult> {
```

Pass incremental: `fetchShipments(tenantId, 50, !force)`

- [ ] **Step 4: Verify and commit**

Run: `cd middleware && npx tsc --noEmit 2>&1 | grep shipments.ts`

```bash
git add middleware/src/whatnot/operations/shipments.ts
git commit -m "feat: incremental fetch + batch DB upserts for shipments"
```

---

### Task 6: Incremental Messages Sync

**Files:**
- Modify: `middleware/src/whatnot/operations/messages.ts`

- [ ] **Step 1: Update `fullMessageSync` to skip unchanged conversations**

```typescript
export async function fullMessageSync(
  tenantId: string,
  force?: boolean
): Promise<SyncResult> {
```

After fetching and syncing conversations, add the incremental skip logic before the message fetch loop:

```typescript
  // Build a map of existing conversation timestamps for incremental skip
  let skipMap = new Map<string, Date | null>();
  if (!force) {
    const existingConvos = await prisma.conversation.findMany({
      where: { tenantId },
      select: { whatnotId: true, lastMessageAt: true },
    });
    skipMap = new Map(existingConvos.map((c) => [c.whatnotId, c.lastMessageAt]));
  }
```

Then in the conversation loop, before calling `fetchMessages`:

```typescript
      // Incremental: skip conversations where last message hasn't changed
      if (!force && skipMap.has(conv.id)) {
        const dbLastMessage = skipMap.get(conv.id);
        const apiLastMessage = conv.mostRecentDirectMessage?.serverTimeUTC;
        if (dbLastMessage && apiLastMessage) {
          const dbTime = dbLastMessage.getTime();
          const apiTime = new Date(apiLastMessage).getTime();
          if (dbTime >= apiTime) {
            // No new messages — skip this conversation
            continue;
          }
        }
      }
```

- [ ] **Step 2: Verify and commit**

```bash
git add middleware/src/whatnot/operations/messages.ts
git commit -m "feat: incremental message sync — skip unchanged conversations"
```

---

### Task 7: Update Sync Worker Cases

**Files:**
- Modify: `middleware/src/jobs/workers/syncWorker.ts`

- [ ] **Step 1: Pass `force` to all operation function calls**

Update every case in the switch statement to pass `force`. The sync worker already has `force` from Task 2. Update function calls:

```typescript
      case 'messages': {
        const result = await fullMessageSync(tenantId, force);
        // ...
      }
      case 'shows': {
        const result = await fullShowSync(tenantId, force);
        // ...
      }
      case 'orders': {
        const result = await fullOrderSync(tenantId, showIds, force);
        // ...
      }
      case 'shipments': {
        const result = await fullShipmentSync(tenantId, force);
        // ...
      }
      case 'customers': {
        const result = await fullOrderSync(tenantId, showIds, force);
        // ...
      }
      case 'products': {
        const result = await fullOrderSync(tenantId, showIds, force);
        // ...
      }
      case 'all': {
        const showResult = await fullShowSync(tenantId, force);
        // ...
        const msgResult = await fullMessageSync(tenantId, force);
        // ...
        const orderResult = await fullOrderSync(tenantId, showIds, force);
        // ...
        const shipResult = await fullShipmentSync(tenantId, force);
        // ...
      }
```

- [ ] **Step 2: Verify and commit**

```bash
git add middleware/src/jobs/workers/syncWorker.ts
git commit -m "feat: pass force flag to all sync operations"
```

---

### Task 8: Desktop UI — Force Sync Button

**Files:**
- Modify: `desktop/src/hooks/useSync.ts` — `trigger` accepts `force`
- Modify: `desktop/src/pages/SyncCenter.tsx` — add force sync UI

- [ ] **Step 1: Update `useSync` trigger to accept `force`**

In `desktop/src/hooks/useSync.ts`, update the `trigger` function signature:

```typescript
  trigger: (syncType: string, force?: boolean) => Promise<{ success: boolean; error?: string }>;
```

Update the implementation to pass `force`:

```typescript
  const trigger = useCallback(
    async (syncType: string, force?: boolean): Promise<{ success: boolean; error?: string }> => {
      try {
        setStatus((prev) => ({ ...prev, isRunning: true, currentType: syncType, error: undefined }));

        const result = await apiClient.post<{ success: boolean; error?: string }>('/api/sync/trigger', {
          type: syncType,
          force: force ?? false,
        });
```

Also update `triggerAll` to accept `force`:

```typescript
  triggerAll: (force?: boolean) => Promise<{ success: boolean; error?: string }>;
```

```typescript
  const triggerAll = useCallback(async (force?: boolean): Promise<{ success: boolean; error?: string }> => {
    try {
      setStatus((prev) => ({ ...prev, isRunning: true, currentType: 'all', error: undefined }));
      const result = await apiClient.post<{ success: boolean; error?: string }>('/api/sync/trigger-all', {
        force: force ?? false,
      });
```

- [ ] **Step 2: Add Force Sync button to SyncCenter**

In `desktop/src/pages/SyncCenter.tsx`, replace the single sync button per type with a split button. Update the sync button JSX (around line 391):

```tsx
                  <div className="flex items-center gap-1">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleTriggerSync(syncType.id)}
                      disabled={isDisabled}
                      title="Incremental sync"
                    >
                      {isCurrentlyRunning ? (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleTriggerSync(syncType.id, true)}
                      disabled={isDisabled}
                      title="Force full re-sync"
                      className="px-1.5"
                    >
                      <RefreshCw className="w-3.5 h-3.5 text-text-tertiary" />
                      <span className="text-[10px] text-text-tertiary ml-0.5">ALL</span>
                    </Button>
                  </div>
```

Update `handleTriggerSync` to accept `force`:

```typescript
  const handleTriggerSync = async (syncType: string, force?: boolean) => {
    if (syncType === 'usps_tracking') {
      // ... existing USPS handling unchanged ...
      return;
    }

    const result = await trigger(syncType, force);
    await loadLogs({ limit: 20 });
    if (!result.success && result.error?.includes('Not authenticated')) {
      checkWhatnotStatus();
    }
  };
```

Add a "Force Full Re-Sync" option next to the "Sync All" button:

```tsx
          <Button
            variant="secondary"
            onClick={() => handleSyncAll(true)}
            disabled={status.isRunning || !whatnotStatus.connected}
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Force Full Re-Sync
          </Button>
```

Update `handleSyncAll`:

```typescript
  const handleSyncAll = async (force?: boolean) => {
    if (force) {
      await triggerAll(true);
    } else {
      await triggerAll();
    }
    await loadLogs({ limit: 20 });
  };
```

- [ ] **Step 3: Verify and commit**

```bash
git add desktop/src/hooks/useSync.ts desktop/src/pages/SyncCenter.tsx
git commit -m "feat: add force sync button to desktop Sync Center"
```

---

### Task 9: Update Web Trigger-All Route

**Files:**
- Modify: `web/src/app/api/sync/trigger-all/route.ts`

- [ ] **Step 1: Forward `force` in trigger-all**

```typescript
    const body = await req.json().catch(() => ({}));
    const force = body?.force ?? false;

    const syncTypes = ["orders", "shows", "shipments", "messages", "customers", "products"];
    // ... in the loop:
    body: JSON.stringify({ type, force }),
```

- [ ] **Step 2: Commit**

```bash
git add web/src/app/api/sync/trigger-all/route.ts
git commit -m "feat: forward force flag in trigger-all route"
```

---

### Task 10: Smoke Test

- [ ] **Step 1: Restart middleware and desktop**

```bash
cd middleware && npm run dev
# In another terminal:
cd desktop && npm run dev
```

- [ ] **Step 2: Test incremental sync**

1. Trigger a Shows sync from Sync Center (should be incremental)
2. Check middleware logs — should see "Incremental stop: all records on page already exist" after 1-2 pages
3. Verify it completes in ~5s instead of ~8s
4. Verify the Sync Center timestamp updates to "just now"

- [ ] **Step 3: Test force sync**

1. Click the "ALL" button next to Shows
2. Check middleware logs — should NOT see incremental stop, should fetch all pages
3. Verify all 131 shows synced

- [ ] **Step 4: Test orders incremental**

1. Trigger an Orders sync (incremental)
2. Should stop after 1-2 pages (~50-100 records) if no new orders
3. Should complete in ~10-20s instead of ~10 min

- [ ] **Step 5: Test batch DB performance**

1. Force full sync on Orders
2. Watch middleware logs for "Orders synced to DB (batch)"
3. Verify 2500 orders complete in ~30-60s instead of ~10 min

- [ ] **Step 6: Commit final state**

```bash
git add -A
git commit -m "feat: incremental sync + batch DB operations — complete"
```
