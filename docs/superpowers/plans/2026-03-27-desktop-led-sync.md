# Desktop-Led Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all Whatnot API fetching from middleware to desktop. Desktop fetches data using its real browser cookies, sends raw results to middleware ingest endpoints. Middleware only stores data — no more token management.

**Architecture:** Desktop's Electron main process calls Whatnot's GraphQL API using `session.defaultSession.fetch()` (real browser cookies, auto-refresh). Raw results are posted to new `/api/sync/ingest/{type}` middleware endpoints that bulk-upsert to PostgreSQL. Middleware scheduler broadcasts `sync:request` events via WebSocket to trigger desktop syncs.

**Tech Stack:** TypeScript, Electron (session.fetch), Socket.io, Fastify, Prisma (raw SQL bulk upserts), PostgreSQL

**Spec:** `docs/superpowers/specs/2026-03-27-desktop-led-sync-design.md`

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `desktop/electron/lib/whatnot-sync.ts` | Paginated GraphQL fetching using Electron session cookies |
| `desktop/electron/ipc/sync.ts` | IPC handlers + sync coordinator (WebSocket listener, fetch orchestration, ingest posting) |
| `middleware/src/api/routes/ingest.routes.ts` | Ingest endpoints that receive raw data and bulk-upsert to DB |

### Modified Files
| File | Changes |
|------|---------|
| `desktop/electron/main.ts` | Register sync IPC handlers, init sync coordinator |
| `desktop/electron/lib/whatnot-api.ts` | Export GraphQL helper + add session.fetch-based request function |
| `desktop/src/hooks/useSync.ts` | Trigger syncs via IPC instead of web API |
| `desktop/src/pages/SyncCenter.tsx` | Wire up to new IPC-based triggers |
| `middleware/src/websocket/events.ts` | Add `sync:request` server-to-client event |
| `middleware/src/websocket/hub.ts` | Remove `trigger:sync` handler (desktop drives syncs now) |
| `middleware/src/jobs/scheduler.ts` | Simplify to broadcast WebSocket events instead of queueing BullMQ jobs |
| `middleware/src/api/server.ts` (or equivalent) | Register ingest routes |

### Files to Delete (Phase 3 — after verification)
| File | Reason |
|------|--------|
| `middleware/src/auth/tokenRefresher.ts` | No more server-side token refresh |
| `middleware/src/auth/cookieStore.ts` | No more cookie storage (keep getTenantsWithValidSessions temporarily) |
| `middleware/src/whatnot/client.ts` | GraphQL client moves to desktop |
| `middleware/src/whatnot/operations/*.ts` | Fetch logic moves to desktop, DB logic moves to ingest routes |
| `middleware/src/jobs/workers/syncWorker.ts` | No more BullMQ sync jobs |

---

### Task 1: Desktop Whatnot Fetch Module

**Files:**
- Modify: `desktop/electron/lib/whatnot-api.ts`
- Create: `desktop/electron/lib/whatnot-sync.ts`

This task builds the core fetching module that uses Electron's session cookies to call Whatnot's GraphQL API with pagination.

- [ ] **Step 1: Add `sessionFetch` helper to `whatnot-api.ts`**

Add a new exported function that uses `session.defaultSession.fetch` to make requests with real browser cookies. This is the foundation — no cookie extraction needed.

```typescript
// Add to desktop/electron/lib/whatnot-api.ts

import { session } from 'electron';

/**
 * Make a fetch request using the Electron session's cookies.
 * Cookies are attached automatically — no extraction needed.
 */
export async function sessionFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  return session.defaultSession.fetch(url, init);
}
```

- [ ] **Step 2: Create `whatnot-sync.ts` with GraphQL queries and paginated fetch**

```typescript
// desktop/electron/lib/whatnot-sync.ts
import { sessionFetch } from './whatnot-api';

const GRAPHQL_URL = 'https://www.whatnot.com/services/graphql/';

interface GraphQLResponse<T = Record<string, unknown>> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/**
 * Execute a GraphQL query using Electron's session cookies.
 */
async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  operationName: string
): Promise<GraphQLResponse<T>> {
  const url = `${GRAPHQL_URL}?operationName=${operationName}`;

  const response = await sessionFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ query, variables, operationName }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { errors: [{ message: `HTTP ${response.status}: ${body}` }] };
  }

  return response.json();
}

/**
 * Paginate a GraphQL query, collecting all edges.
 */
async function paginate<T>(
  query: string,
  variables: Record<string, unknown>,
  operationName: string,
  options: {
    maxPages: number;
    pageSize?: number;
    getPageInfo: (data: T) => { hasNextPage: boolean; endCursor: string | null };
    getEdges: (data: T) => unknown[];
    delayMs?: number;
  }
): Promise<{ edges: unknown[]; pages: number; errors: string[] }> {
  const { maxPages, pageSize = 50, getPageInfo, getEdges, delayMs = 100 } = options;
  const edges: unknown[] = [];
  const errors: string[] = [];
  let cursor: string | null = null;

  for (let page = 1; page <= maxPages; page++) {
    const vars = { ...variables, first: pageSize, after: cursor };
    const result = await graphql<T>(query, vars, operationName);

    if (result.errors?.length) {
      errors.push(...result.errors.map((e) => e.message));
      break;
    }
    if (!result.data) {
      errors.push('No data returned');
      break;
    }

    const pageEdges = getEdges(result.data);
    edges.push(...pageEdges);

    const pageInfo = getPageInfo(result.data);
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;

    cursor = pageInfo.endCursor;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  return { edges, pages: Math.min(maxPages, edges.length > 0 ? Math.ceil(edges.length / (pageSize)) : 1), errors };
}

// ─── GraphQL Queries ───────────────────────────────────

const GET_ORDERS_QUERY = `
  query SellerHubGetMyOrders($first: Int, $after: String, $salesChannels: [SalesChannelInfoInput!]) {
    me {
      id
      orders(first: $first, after: $after, salesChannels: $salesChannels, sortField: DATE, sortDirection: desc) {
        totalCount
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id uuid createdAt prettyStatus salesChannel
            videoReceipt { videoUrl expirationMessage status }
            subtotal { amount currency }
            buyer { id username }
            shippingAddress { fullName line1 line2 city state postalCode countryCode }
            items(first: 50) {
              edges {
                node {
                  id quantity
                  listing { id title }
                  livestreamProduct { id livestream { id title startTime } }
                  sellerReceipt { netEarnings { amount } earningsStatus { badgeLabel } adjustedEarningsDetails { netAdjustedEarnings { amount } } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const GET_SHIPMENTS_QUERY = `
  query GetMyShipments($first: Int, $after: String) {
    myShipments2(first: $first, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges {
        cursor
        node {
          id status createdAt trackingUrl trackingCode
          addressFullName addressCountryCode totalItemQuantity
          totalOrderValue { amount currency }
          buyer { id username }
          fileUrl bundledFileUrl courier
          method
          weight { amount scale }
          dimensions { length width height scale }
          orderItems { id quantity order { uuid videoReceipt { videoUrl expirationMessage status } } listing { id title } }
        }
      }
    }
  }
`;

const GET_SHOWS_QUERY = `
  query GetLivestreams($first: Int, $after: String) {
    livestreamsByUserId(statuses: [PLAYING, STOPPED, ENDED], first: $first, after: $after, reverse: true) {
      edges { node { id title startTime endTime status isHiddenBySeller } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const GET_CONVERSATIONS_QUERY = `
  query GetInboxConversationsV2($first: Int, $after: String) {
    me {
      id username
      inbox {
        conversationsV2(first: $first, after: $after) {
          edges { node { id mostRecentDirectMessage { id serverTimeUTC } participant { id username } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const GET_MESSAGES_QUERY = `
  query GetInboxV2ConversationMessages($conversationId: ID!, $first: Int) {
    conversation(id: $conversationId) {
      id
      messages(first: $first) {
        edges { node { id body serverTimeUTC sender { id username } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

// ─── Public Fetch Functions ────────────────────────────

export async function fetchOrders(maxPages: number, showIds?: string[]): Promise<{ records: unknown[]; errors: string[] }> {
  const variables: Record<string, unknown> = {};
  if (showIds?.length) variables.salesChannels = showIds.map((id) => ({ type: 'LIVE', id }));

  const { edges, errors } = await paginate(GET_ORDERS_QUERY, variables, 'SellerHubGetMyOrders', {
    maxPages,
    getPageInfo: (data: any) => data.me?.orders?.pageInfo ?? { hasNextPage: false, endCursor: null },
    getEdges: (data: any) => data.me?.orders?.edges?.map((e: any) => e.node) ?? [],
  });

  return { records: edges, errors };
}

export async function fetchShipments(maxPages: number): Promise<{ records: unknown[]; errors: string[] }> {
  const { edges, errors } = await paginate(GET_SHIPMENTS_QUERY, {}, 'GetMyShipments', {
    maxPages,
    getPageInfo: (data: any) => data.myShipments2?.pageInfo ?? { hasNextPage: false, endCursor: null },
    getEdges: (data: any) => data.myShipments2?.edges?.map((e: any) => e.node) ?? [],
  });

  return { records: edges, errors };
}

export async function fetchShows(maxPages: number): Promise<{ records: unknown[]; errors: string[] }> {
  const { edges, errors } = await paginate(GET_SHOWS_QUERY, {}, 'GetLivestreams', {
    maxPages,
    getPageInfo: (data: any) => data.livestreamsByUserId?.pageInfo ?? { hasNextPage: false, endCursor: null },
    getEdges: (data: any) => data.livestreamsByUserId?.edges?.map((e: any) => e.node) ?? [],
  });

  return { records: edges, errors };
}

export async function fetchConversations(maxPages: number): Promise<{ records: unknown[]; errors: string[] }> {
  const { edges, errors } = await paginate(GET_CONVERSATIONS_QUERY, {}, 'GetInboxConversationsV2', {
    maxPages,
    pageSize: 50,
    getPageInfo: (data: any) => data.me?.inbox?.conversationsV2?.pageInfo ?? { hasNextPage: false, endCursor: null },
    getEdges: (data: any) => data.me?.inbox?.conversationsV2?.edges?.map((e: any) => e.node) ?? [],
  });

  return { records: edges, errors };
}

export async function fetchMessagesForConversation(conversationId: string, limit = 100): Promise<{ records: unknown[]; errors: string[] }> {
  const result = await graphql(GET_MESSAGES_QUERY, { conversationId, first: limit }, 'GetInboxV2ConversationMessages');

  if (result.errors?.length) {
    return { records: [], errors: result.errors.map((e) => e.message) };
  }

  const messages = (result.data as any)?.conversation?.messages?.edges?.map((e: any) => e.node) ?? [];
  return { records: messages, errors: [] };
}
```

- [ ] **Step 3: Verify desktop compiles**

Run: `cd desktop && npx tsc --noEmit 2>&1 | grep -E "whatnot-sync|whatnot-api" | head -5`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add desktop/electron/lib/whatnot-api.ts desktop/electron/lib/whatnot-sync.ts
git commit -m "feat: desktop whatnot fetch module using session cookies"
```

---

### Task 2: Middleware Ingest Endpoints

**Files:**
- Create: `middleware/src/api/routes/ingest.routes.ts`
- Modify: `middleware/src/api/server.ts` (or wherever routes are registered)

These endpoints receive raw Whatnot data from the desktop and bulk-upsert to the database. They reuse the `bulkUpsert` utility already built.

- [ ] **Step 1: Create ingest routes**

```typescript
// middleware/src/api/routes/ingest.routes.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createChildLogger } from '../../lib/logger.js';
import prisma from '../../lib/prisma.js';
import { bulkUpsert } from '../../lib/bulkUpsert.js';
import { requireServiceAuth } from '../../auth/requireServiceAuth.js';

const logger = createChildLogger('ingest-routes');

export async function ingestRoutes(app: FastifyInstance): Promise<void> {

  /**
   * POST /api/sync/ingest/orders
   * Receives raw order data from desktop, bulk-upserts customers + orders + items
   */
  app.post(
    '/api/sync/ingest/orders',
    { preHandler: requireServiceAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tenantId = request.tenantId!;
      const userId = request.serviceUserId!;
      const { records, force } = request.body as { records: any[]; force?: boolean };

      const startTime = Date.now();
      logger.info({ tenantId, recordCount: records.length, force }, 'Ingesting orders');

      // Create sync job record
      const job = await prisma.syncJob.create({
        data: { tenantId, userId, type: 'orders', status: 'active', startedAt: new Date() },
      });

      try {
        const now = new Date();

        // 1. Bulk upsert customers
        const buyerMap = new Map<string, { totalOrders: number; totalSpent: number; lastOrderAt: Date }>();
        for (const order of records) {
          const username = order.buyer?.username;
          if (!username) continue;
          const subtotalRaw = order.subtotal?.amount || 0;
          const netEarnings = typeof subtotalRaw === 'number' ? subtotalRaw / 100 : 0;
          const existing = buyerMap.get(username);
          if (existing) {
            existing.totalOrders += 1;
            existing.totalSpent += netEarnings;
          } else {
            buyerMap.set(username, { totalOrders: 1, totalSpent: netEarnings, lastOrderAt: new Date(order.createdAt) });
          }
        }

        const customerRecords = Array.from(buyerMap.entries()).map(([username, stats]) => ({
          username,
          whatnot_username: username,
          display_name: username,
          total_orders: stats.totalOrders,
          total_spent: stats.totalSpent,
          last_order_at: stats.lastOrderAt,
          created_at: now,
          updated_at: now,
          user_id: userId,
          tenant_id: tenantId || null,
        }));

        if (customerRecords.length > 0) {
          await bulkUpsert('customers', customerRecords, ['whatnot_username', 'tenant_id'], ['total_orders', 'total_spent', 'last_order_at', 'updated_at']);
        }

        // Fetch customer IDs for FK
        const customerIdMap = new Map<string, number>();
        if (buyerMap.size > 0) {
          const usernames = Array.from(buyerMap.keys());
          const ph = usernames.map((_, i) => `$${i + 1}`).join(', ');
          const rows = await prisma.$queryRawUnsafe<Array<{ id: number; whatnot_username: string }>>(
            `SELECT "id", "whatnot_username" FROM "customers" WHERE "whatnot_username" IN (${ph}) AND "tenant_id" = $${usernames.length + 1}::uuid`,
            ...usernames, tenantId
          );
          for (const row of rows) customerIdMap.set(row.whatnot_username, row.id);
        }

        // 2. Bulk upsert orders
        const orderRecords = records.map((order: any) => {
          const subtotalRaw = order.subtotal?.amount || 0;
          const netEarnings = typeof subtotalRaw === 'number' ? subtotalRaw / 100 : 0;
          const addr = order.shippingAddress;
          const shippingAddress = addr
            ? [addr.line1, addr.line2, `${addr.city}, ${addr.state} ${addr.postalCode}`, addr.countryCode].filter(Boolean).join('\n')
            : null;
          return {
            id: order.uuid,
            whatnot_order_id: order.uuid,
            buyer_username: order.buyer?.username || '',
            item_title: 'Order',
            item_count: 1,
            total_amount: netEarnings,
            status: order.prettyStatus?.toLowerCase() || 'unknown',
            shipping_name: addr?.fullName || null,
            shipping_address: shippingAddress,
            ordered_at: new Date(order.createdAt),
            customer_id: customerIdMap.get(order.buyer?.username) || null,
            created_at: now,
            updated_at: now,
            user_id: userId,
            tenant_id: tenantId || null,
          };
        });

        await bulkUpsert('orders', orderRecords, ['whatnot_order_id'], ['status', 'customer_id', 'updated_at']);

        // 3. Bulk upsert items
        const parseAmount = (val: unknown, isCents = false): number => {
          if (typeof val === 'number') return isCents ? val / 100 : val;
          if (typeof val !== 'string') return 0;
          const cleaned = val.replace(/[$,]/g, '');
          const num = parseFloat(cleaned);
          return Number.isFinite(num) ? num : 0;
        };

        const itemRecords: Record<string, unknown>[] = [];
        for (const order of records) {
          const itemEdges = order.items?.edges ?? [];
          const itemCount = itemEdges.length;
          for (const edge of itemEdges) {
            const node = edge.node;
            const itemId = `${order.uuid}-${node.id}`;
            const listing = node.listing || { id: '', title: 'Unknown item' };
            const ls = node.livestreamProduct?.livestream || { id: '', title: 'Unknown show' };
            const receipt = node.sellerReceipt;
            const grossPerItem = itemCount > 0 ? parseAmount(order.subtotal?.amount, true) / itemCount : 0;
            const adjustedNet = parseAmount(receipt?.adjustedEarningsDetails?.netAdjustedEarnings?.amount);
            const rawNet = parseAmount(receipt?.netEarnings?.amount);
            const netEarnings = adjustedNet || rawNet || grossPerItem;
            const isGiveaway = (listing.title || '').toLowerCase().includes('giveaway');

            itemRecords.push({
              id: itemId, order_id: order.uuid, show_id: ls.id || null,
              show_title: ls.title || 'Unknown show', item_title: listing.title || 'Unknown item',
              quantity: node.quantity || 1, order_date: new Date(order.createdAt),
              gross_amount: grossPerItem, net_earnings: netEarnings,
              buyer: order.buyer?.username || null, video_url: order.videoReceipt?.videoUrl || null,
              stream_id: ls.id || null, is_giveaway: isGiveaway, channel: 'whatnot',
              created_at: now, updated_at: now, user_id: userId, tenant_id: tenantId || null,
            });
          }
        }

        if (itemRecords.length > 0) {
          await bulkUpsert('items', itemRecords, ['id'], ['net_earnings', 'gross_amount', 'show_title', 'updated_at']);
        }

        const duration = Date.now() - startTime;
        const counts = { orders: records.length, items: itemRecords.length, customers: buyerMap.size };

        await prisma.syncJob.update({
          where: { id: job.id },
          data: { status: 'completed', completedAt: new Date(), progress: 100, result: { type: 'orders', success: true, counts, errors: [], duration } },
        });

        logger.info({ tenantId, counts, duration }, 'Orders ingested');
        return reply.send({ success: true, jobId: job.id, counts });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        await prisma.syncJob.update({
          where: { id: job.id },
          data: { status: 'failed', completedAt: new Date(), error: msg },
        });
        logger.error({ error, tenantId }, 'Order ingest failed');
        return reply.status(500).send({ success: false, error: msg });
      }
    }
  );

  /**
   * POST /api/sync/ingest/shipments
   */
  app.post(
    '/api/sync/ingest/shipments',
    { preHandler: requireServiceAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tenantId = request.tenantId!;
      const userId = request.serviceUserId!;
      const { records } = request.body as { records: any[] };
      const startTime = Date.now();
      logger.info({ tenantId, recordCount: records.length }, 'Ingesting shipments');

      const job = await prisma.syncJob.create({
        data: { tenantId, userId, type: 'shipments', status: 'active', startedAt: new Date() },
      });

      try {
        const now = new Date();
        const seen = new Set<string>();
        const unique = records.filter((s: any) => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });

        const shipmentRecords = unique.map((node: any) => {
          const firstItem = node.orderItems?.[0];
          return {
            id: node.id,
            whatnot_shipment_id: node.id,
            show_id: null,
            status: (node.status || 'unknown').toLowerCase(),
            buyer_username: node.buyer?.username || null,
            address_full_name: node.addressFullName || null,
            address_country_code: node.addressCountryCode || null,
            total_items: node.totalItemQuantity || node.orderItems?.length || 0,
            total_value_cents: Math.round((node.totalOrderValue?.amount || 0) * 100),
            tracking_url: node.trackingUrl || null,
            tracking_code: node.trackingCode || null,
            label_url: node.fileUrl || null,
            bundled_label_url: node.bundledFileUrl || null,
            courier: node.courier || null,
            shipped_at: new Date(node.createdAt),
            synced_at: now, created_at: now, updated_at: now,
            user_id: userId, tenant_id: tenantId || null,
          };
        });

        await bulkUpsert('shipments', shipmentRecords, ['id'],
          ['status', 'whatnot_shipment_id', 'buyer_username', 'address_full_name', 'address_country_code',
           'total_items', 'total_value_cents', 'tracking_url', 'tracking_code', 'label_url', 'bundled_label_url',
           'courier', 'synced_at', 'updated_at']);

        // Batch update order statuses
        const orderUuids = unique.map((n: any) => n.orderItems?.[0]?.order?.uuid).filter(Boolean);
        let ordersUpdated = 0;
        if (orderUuids.length > 0) {
          const result = await prisma.order.updateMany({
            where: { whatnotOrderId: { in: orderUuids } },
            data: { status: 'shipped', shippedAt: now },
          });
          ordersUpdated = result.count;
        }

        const duration = Date.now() - startTime;
        const counts = { shipments: unique.length, ordersUpdated };

        await prisma.syncJob.update({
          where: { id: job.id },
          data: { status: 'completed', completedAt: new Date(), progress: 100, result: { type: 'shipments', success: true, counts, errors: [], duration } },
        });

        logger.info({ tenantId, counts, duration }, 'Shipments ingested');
        return reply.send({ success: true, jobId: job.id, counts });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        await prisma.syncJob.update({ where: { id: job.id }, data: { status: 'failed', completedAt: new Date(), error: msg } });
        logger.error({ error, tenantId }, 'Shipment ingest failed');
        return reply.status(500).send({ success: false, error: msg });
      }
    }
  );

  /**
   * POST /api/sync/ingest/shows
   */
  app.post(
    '/api/sync/ingest/shows',
    { preHandler: requireServiceAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tenantId = request.tenantId!;
      const userId = request.serviceUserId!;
      const { records } = request.body as { records: any[] };
      const startTime = Date.now();
      logger.info({ tenantId, recordCount: records.length }, 'Ingesting shows');

      const job = await prisma.syncJob.create({
        data: { tenantId, userId, type: 'shows', status: 'active', startedAt: new Date() },
      });

      try {
        for (const ls of records) {
          await prisma.show.upsert({
            where: { id: ls.id },
            update: {
              title: ls.title,
              startTime: ls.startTime ? BigInt(new Date(ls.startTime).getTime()) : null,
              endTime: ls.endTime ? BigInt(new Date(ls.endTime).getTime()) : null,
              tenantId,
              updatedAt: new Date(),
            },
            create: {
              id: ls.id,
              title: ls.title,
              startTime: ls.startTime ? BigInt(new Date(ls.startTime).getTime()) : null,
              endTime: ls.endTime ? BigInt(new Date(ls.endTime).getTime()) : null,
              userId,
              tenantId,
            },
          });
        }

        const duration = Date.now() - startTime;
        await prisma.syncJob.update({
          where: { id: job.id },
          data: { status: 'completed', completedAt: new Date(), progress: 100, result: { type: 'shows', success: true, counts: { shows: records.length }, errors: [], duration } },
        });

        logger.info({ tenantId, count: records.length, duration }, 'Shows ingested');
        return reply.send({ success: true, jobId: job.id, counts: { shows: records.length } });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        await prisma.syncJob.update({ where: { id: job.id }, data: { status: 'failed', completedAt: new Date(), error: msg } });
        logger.error({ error, tenantId }, 'Show ingest failed');
        return reply.status(500).send({ success: false, error: msg });
      }
    }
  );

  /**
   * POST /api/sync/ingest/conversations
   */
  app.post(
    '/api/sync/ingest/conversations',
    { preHandler: requireServiceAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tenantId = request.tenantId!;
      const userId = request.serviceUserId!;
      const { records } = request.body as { records: any[] };
      const startTime = Date.now();
      logger.info({ tenantId, recordCount: records.length }, 'Ingesting conversations');

      const job = await prisma.syncJob.create({
        data: { tenantId, userId, type: 'messages', status: 'active', startedAt: new Date() },
      });

      try {
        let synced = 0;
        for (const conv of records) {
          const participant = conv.participant;
          if (!participant) continue;

          // Upsert customer
          let customerId: number | null = null;
          if (participant.username) {
            const customer = await prisma.customer.upsert({
              where: { whatnotUsername_tenantId: { whatnotUsername: participant.username, tenantId: tenantId || '' } },
              create: { username: participant.username, whatnotUsername: participant.username, displayName: participant.username, userId, tenantId },
              update: {},
            });
            customerId = customer.id;
          }

          let lastMessageAt: Date | null = null;
          if (conv.mostRecentDirectMessage?.serverTimeUTC) {
            try { lastMessageAt = new Date(conv.mostRecentDirectMessage.serverTimeUTC); } catch {}
          }

          await prisma.conversation.upsert({
            where: { whatnotId_tenantId: { whatnotId: conv.id, tenantId: tenantId || '' } },
            create: {
              whatnotId: conv.id,
              participantId: participant.id || '',
              participantUsername: participant.username || '',
              participantName: participant.username,
              hasUnread: false,
              lastMessageAt,
              customerId,
              userId,
              tenantId,
            },
            update: { lastMessageAt, customerId: customerId || undefined },
          });
          synced++;
        }

        const duration = Date.now() - startTime;
        await prisma.syncJob.update({
          where: { id: job.id },
          data: { status: 'completed', completedAt: new Date(), progress: 100, result: { type: 'messages', success: true, counts: { conversations: synced }, errors: [], duration } },
        });

        logger.info({ tenantId, synced, duration }, 'Conversations ingested');
        return reply.send({ success: true, jobId: job.id, counts: { conversations: synced } });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        await prisma.syncJob.update({ where: { id: job.id }, data: { status: 'failed', completedAt: new Date(), error: msg } });
        logger.error({ error, tenantId }, 'Conversation ingest failed');
        return reply.status(500).send({ success: false, error: msg });
      }
    }
  );

  /**
   * POST /api/sync/ingest/messages
   * On-demand: receives messages for a single conversation
   */
  app.post(
    '/api/sync/ingest/messages',
    { preHandler: requireServiceAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tenantId = request.tenantId!;
      const userId = request.serviceUserId!;
      const { conversationWhatnotId, messages, myUsername } = request.body as {
        conversationWhatnotId: string;
        messages: any[];
        myUsername: string;
      };

      logger.info({ tenantId, conversationWhatnotId, messageCount: messages.length }, 'Ingesting messages');

      try {
        const dbConv = await prisma.conversation.findFirst({
          where: { whatnotId: conversationWhatnotId, tenantId },
          select: { id: true },
        });

        if (!dbConv) {
          return reply.status(404).send({ success: false, error: 'Conversation not found' });
        }

        let synced = 0;
        for (const msg of messages) {
          const senderType = msg.sender.username === myUsername ? 'me' : 'them';
          let sentAt = new Date();
          try { sentAt = new Date(msg.serverTimeUTC); } catch {}

          await prisma.message.upsert({
            where: { whatnotId_tenantId: { whatnotId: msg.id, tenantId: tenantId || '' } },
            create: {
              whatnotId: msg.id,
              conversationId: dbConv.id,
              body: msg.body || '',
              senderType,
              senderUsername: msg.sender.username || '',
              sentAt,
              userId,
              tenantId,
            },
            update: { body: msg.body || '' },
          });
          synced++;
        }

        logger.info({ tenantId, conversationWhatnotId, synced }, 'Messages ingested');
        return reply.send({ success: true, counts: { messages: synced } });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, tenantId }, 'Message ingest failed');
        return reply.status(500).send({ success: false, error: msg });
      }
    }
  );
}
```

- [ ] **Step 2: Register ingest routes in the server**

Read `middleware/src/api/server.ts` (or wherever routes are registered), find where `syncRoutes` is registered, and add `ingestRoutes` alongside it:

```typescript
import { ingestRoutes } from './routes/ingest.routes.js';
// ... in the route registration section:
await ingestRoutes(app);
```

- [ ] **Step 3: Verify middleware compiles**

Run: `cd middleware && npx tsc --noEmit 2>&1 | grep ingest`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add middleware/src/api/routes/ingest.routes.ts middleware/src/api/server.ts
git commit -m "feat: add ingest endpoints for desktop-led sync"
```

---

### Task 3: Desktop Sync Coordinator + IPC Handlers

**Files:**
- Create: `desktop/electron/ipc/sync.ts`
- Modify: `desktop/electron/main.ts`

- [ ] **Step 1: Create sync coordinator**

```typescript
// desktop/electron/ipc/sync.ts
import { ipcMain, session } from 'electron';
import { fetchOrders, fetchShipments, fetchShows, fetchConversations, fetchMessagesForConversation } from '../lib/whatnot-sync';
import { getWhatnotAuthState } from '../lib/whatnot-api';

// Will be set by main.ts
let getApiClient: () => { post: (path: string, body: unknown) => Promise<any> };
let getMainWindow: () => Electron.BrowserWindow | null;
let attemptSilentLogin: () => Promise<boolean>;

interface SyncProgress {
  type: string;
  status: 'fetching' | 'uploading' | 'complete' | 'error';
  progress: number;
  message: string;
  counts?: Record<string, number>;
  error?: string;
}

function sendProgress(progress: SyncProgress) {
  getMainWindow()?.webContents.send('sync:progress', progress);
}

/**
 * Run a single sync type: fetch from Whatnot, post to middleware.
 */
async function runSync(type: string, force: boolean): Promise<{ success: boolean; counts?: Record<string, number>; error?: string }> {
  const pages = force ? 50 : 5;

  // Check auth first
  const auth = await getWhatnotAuthState();
  if (!auth.authenticated) {
    sendProgress({ type, status: 'fetching', progress: 10, message: 'Token expired, attempting refresh...' });
    const refreshed = await attemptSilentLogin();
    if (!refreshed) {
      sendProgress({ type, status: 'error', progress: 0, message: 'Not authenticated — please log in to Whatnot' });
      return { success: false, error: 'Not authenticated' };
    }
  }

  try {
    // Phase 1: Fetch from Whatnot
    sendProgress({ type, status: 'fetching', progress: 20, message: `Fetching ${type}...` });

    let fetchResult: { records: unknown[]; errors: string[] };

    switch (type) {
      case 'orders':
      case 'customers':
      case 'products':
        fetchResult = await fetchOrders(pages);
        break;
      case 'shipments':
        fetchResult = await fetchShipments(pages);
        break;
      case 'shows':
        fetchResult = await fetchShows(force ? 20 : 5);
        break;
      case 'messages':
        fetchResult = await fetchConversations(100); // Always fetch all conversations (cheap)
        break;
      default:
        return { success: false, error: `Unknown sync type: ${type}` };
    }

    if (fetchResult.errors.length > 0 && fetchResult.records.length === 0) {
      // Check if auth error — retry once with silent login
      const hasAuthError = fetchResult.errors.some((e) => e.includes('401') || e.includes('Invalid token'));
      if (hasAuthError) {
        sendProgress({ type, status: 'fetching', progress: 15, message: 'Auth error, refreshing token...' });
        const refreshed = await attemptSilentLogin();
        if (refreshed) {
          // Retry fetch
          switch (type) {
            case 'orders': case 'customers': case 'products':
              fetchResult = await fetchOrders(pages); break;
            case 'shipments':
              fetchResult = await fetchShipments(pages); break;
            case 'shows':
              fetchResult = await fetchShows(force ? 20 : 5); break;
            case 'messages':
              fetchResult = await fetchConversations(100); break;
          }
        }
      }

      if (fetchResult.errors.length > 0 && fetchResult.records.length === 0) {
        sendProgress({ type, status: 'error', progress: 0, message: fetchResult.errors[0] });
        return { success: false, error: fetchResult.errors.join(', ') };
      }
    }

    sendProgress({ type, status: 'uploading', progress: 60, message: `Uploading ${fetchResult.records.length} ${type} to server...` });

    // Phase 2: Post to middleware ingest endpoint
    const ingestType = type === 'customers' || type === 'products' ? 'orders' : type === 'messages' ? 'conversations' : type;
    const api = getApiClient();
    const result = await api.post(`/api/sync/ingest/${ingestType}`, {
      records: fetchResult.records,
      force,
    });

    sendProgress({ type, status: 'complete', progress: 100, message: 'Done', counts: result.counts });
    return { success: true, counts: result.counts };

  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Sync failed';
    sendProgress({ type, status: 'error', progress: 0, message: msg, error: msg });
    return { success: false, error: msg };
  }
}

/**
 * Register sync IPC handlers.
 * Call from main.ts after creating the main window.
 */
export function registerSyncHandlers(deps: {
  apiClientFactory: () => { post: (path: string, body: unknown) => Promise<any> };
  mainWindowFactory: () => Electron.BrowserWindow | null;
  silentLogin: () => Promise<boolean>;
}) {
  getApiClient = deps.apiClientFactory;
  getMainWindow = deps.mainWindowFactory;
  attemptSilentLogin = deps.silentLogin;

  ipcMain.handle('sync:trigger', async (_event, { type, force }: { type: string; force?: boolean }) => {
    return runSync(type, force ?? false);
  });

  ipcMain.handle('sync:trigger-all', async (_event, { force }: { force?: boolean } = {}) => {
    const types = ['shows', 'orders', 'shipments', 'messages'];
    const results: Record<string, { success: boolean; counts?: Record<string, number>; error?: string }> = {};

    for (const type of types) {
      results[type] = await runSync(type, force ?? false);
    }

    return results;
  });

  ipcMain.handle('sync:fetch-messages', async (_event, { conversationId, myUsername }: { conversationId: string; myUsername: string }) => {
    const auth = await getWhatnotAuthState();
    if (!auth.authenticated) {
      const refreshed = await attemptSilentLogin();
      if (!refreshed) return { success: false, error: 'Not authenticated' };
    }

    const { records, errors } = await fetchMessagesForConversation(conversationId);
    if (errors.length > 0 && records.length === 0) {
      return { success: false, error: errors.join(', ') };
    }

    // Post to middleware
    const api = getApiClient();
    const result = await api.post('/api/sync/ingest/messages', {
      conversationWhatnotId: conversationId,
      messages: records,
      myUsername,
    });

    return { success: true, counts: result.counts };
  });
}
```

- [ ] **Step 2: Register in main.ts**

Add import and registration. Find the `registerIpcHandlers` function in `desktop/electron/main.ts` and add at the end:

```typescript
import { registerSyncHandlers } from './ipc/sync';

// Inside registerIpcHandlers(), at the end:
registerSyncHandlers({
  apiClientFactory: () => ({
    post: async (path: string, body: unknown) => {
      const token = store.get('authToken') as string;
      const tenantId = store.get('tenantId') as string;
      const baseUrl = 'http://localhost:3001'; // middleware URL
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Tenant-Id': tenantId,
        },
        body: JSON.stringify(body),
      });
      return response.json();
    },
  }),
  mainWindowFactory: () => mainWindow,
  silentLogin: attemptSilentWhatnotLogin,
});
```

Note: The API client here talks directly to the middleware (port 3001) with a service token, not through the web app. You may need to generate a service token similar to how the web app does it — check how `requireServiceAuth` validates tokens and match that format.

- [ ] **Step 3: Verify desktop compiles**

Run: `cd desktop && npx tsc --noEmit 2>&1 | grep -E "sync.ts|main.ts" | head -5`

- [ ] **Step 4: Commit**

```bash
git add desktop/electron/ipc/sync.ts desktop/electron/main.ts
git commit -m "feat: desktop sync coordinator with IPC handlers"
```

---

### Task 4: Add `sync:request` WebSocket Event + Simplify Scheduler

**Files:**
- Modify: `middleware/src/websocket/events.ts`
- Modify: `middleware/src/jobs/scheduler.ts`

- [ ] **Step 1: Add `sync:request` to ServerToClientEvents**

In `middleware/src/websocket/events.ts`, add to the `ServerToClientEvents` interface:

```typescript
  'sync:request': (data: { type: string; force: boolean }) => void;
```

- [ ] **Step 2: Simplify scheduler to broadcast WebSocket events**

Replace the `scheduleMessageSyncs`, `scheduleOrderSyncs`, `scheduleShipmentSyncs` functions to broadcast via WebSocket instead of queueing BullMQ jobs:

```typescript
import { broadcastToAll } from '../websocket/broadcaster.js';

async function scheduleMessageSyncs(): Promise<void> {
  logger.info('Broadcasting message sync request');
  broadcastToAll('sync:request', { type: 'messages', force: false });
}

async function scheduleOrderSyncs(): Promise<void> {
  logger.info('Broadcasting order sync request');
  broadcastToAll('sync:request', { type: 'orders', force: false });
}

async function scheduleShipmentSyncs(): Promise<void> {
  logger.info('Broadcasting shipment sync request');
  broadcastToAll('sync:request', { type: 'shipments', force: false });
}
```

Remove imports of `queueSyncJob`, `getTenantsWithValidSessions` that are no longer needed.

- [ ] **Step 3: Commit**

```bash
git add middleware/src/websocket/events.ts middleware/src/jobs/scheduler.ts
git commit -m "feat: scheduler broadcasts sync:request via WebSocket"
```

---

### Task 5: Desktop Listens for `sync:request` Events

**Files:**
- Modify: `desktop/src/lib/middlewareSocket.ts`
- Modify: `desktop/electron/ipc/sync.ts`

- [ ] **Step 1: Forward `sync:request` events from WebSocket to IPC**

In `desktop/src/lib/middlewareSocket.ts`, add a listener for `sync:request` inside the `connectToMiddleware` function:

```typescript
    socket.on('sync:request' as any, (data: { type: string; force: boolean }) => {
      console.log('[Middleware] Sync request:', data.type, data.force ? '(force)' : '(incremental)');
      // Forward to main process via IPC — main process will handle the fetch
      if (window.electronAPI?.syncTrigger) {
        window.electronAPI.syncTrigger(data.type, data.force);
      }
    });
```

Alternatively, if the WebSocket connection is in the main process (not renderer), add the listener directly in `sync.ts`'s coordinator.

- [ ] **Step 2: Commit**

```bash
git add desktop/src/lib/middlewareSocket.ts
git commit -m "feat: desktop listens for sync:request WebSocket events"
```

---

### Task 6: Update Desktop UI to Use IPC-Based Sync

**Files:**
- Modify: `desktop/src/hooks/useSync.ts`
- Modify: `desktop/src/pages/SyncCenter.tsx`

- [ ] **Step 1: Update `useSync.ts` to trigger via IPC**

Replace the web API calls with IPC calls:

```typescript
  const trigger = useCallback(
    async (syncType: string, force?: boolean): Promise<{ success: boolean; error?: string }> => {
      try {
        setStatus((prev) => ({ ...prev, isRunning: true, currentType: syncType, error: undefined }));

        // Call desktop main process directly via IPC
        const result = await window.electronAPI.invoke('sync:trigger', { type: syncType, force: force ?? false });

        // Refresh status from web API (middleware has updated SyncJob records)
        await Promise.all([loadStatus(), loadLogs({ limit: 20 })]);

        setStatus((prev) => ({ ...prev, isRunning: false, currentType: undefined }));
        return result;
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Sync failed';
        setStatus((prev) => ({ ...prev, isRunning: false, error }));
        return { success: false, error };
      }
    },
    [loadStatus, loadLogs]
  );
```

Similarly update `triggerAll`:

```typescript
  const triggerAll = useCallback(async (force?: boolean): Promise<{ success: boolean; error?: string }> => {
    try {
      setStatus((prev) => ({ ...prev, isRunning: true, currentType: 'all', error: undefined }));
      const result = await window.electronAPI.invoke('sync:trigger-all', { force: force ?? false });
      await Promise.all([loadStatus(), loadLogs({ limit: 20 })]);
      setStatus((prev) => ({ ...prev, isRunning: false, currentType: undefined }));
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Sync failed';
      setStatus((prev) => ({ ...prev, isRunning: false, error }));
      return { success: false, error };
    }
  }, [loadStatus, loadLogs]);
```

- [ ] **Step 2: Listen for `sync:progress` IPC events for real-time UI updates**

Add an effect that listens for progress events from the main process:

```typescript
  useEffect(() => {
    const handleProgress = (_event: any, progress: SyncProgress) => {
      setStatus((prev) => ({
        ...prev,
        isRunning: progress.status === 'fetching' || progress.status === 'uploading',
        currentType: progress.type,
        progress: progress.progress,
        error: progress.status === 'error' ? progress.message : undefined,
      }));

      if (progress.status === 'complete' || progress.status === 'error') {
        loadStatus();
        loadLogs({ limit: 20 });
      }
    };

    window.electronAPI?.on('sync:progress', handleProgress);
    return () => { window.electronAPI?.off('sync:progress', handleProgress); };
  }, [loadStatus, loadLogs]);
```

- [ ] **Step 3: Commit**

```bash
git add desktop/src/hooks/useSync.ts desktop/src/pages/SyncCenter.tsx
git commit -m "feat: desktop UI triggers syncs via IPC"
```

---

### Task 7: Smoke Test

- [ ] **Step 1: Restart middleware and desktop**

- [ ] **Step 2: Test manual sync from Sync Center**

1. Click Shows sync button
2. Desktop should: fetch from Whatnot API → post to middleware ingest endpoint
3. Middleware logs should show "Ingesting shows" + "Shows ingested"
4. UI should update with fresh timestamp

- [ ] **Step 3: Test orders incremental**

1. Click Orders sync button (not force)
2. Desktop fetches 5 pages max (~250 orders)
3. Middleware bulk-upserts
4. Should complete in ~5-10s

- [ ] **Step 4: Test force sync**

1. Click "Force Full Re-Sync" on orders
2. Desktop fetches all pages (50 max)
3. Should complete in ~30-60s with batch upserts

- [ ] **Step 5: Test scheduled sync**

1. Wait for scheduler interval (messages = 5 min)
2. Middleware broadcasts `sync:request`
3. Desktop receives, fetches, posts to ingest
4. Check middleware logs for "Broadcasting message sync request" + "Conversations ingested"

- [ ] **Step 6: Test auth recovery**

1. Wait for token to expire (~2 min)
2. Trigger a sync
3. Desktop should detect 401, do silent login, retry
4. All local to desktop — no middleware involvement

---

### Task 8: Cleanup Old Code (Phase 3)

**Do this AFTER Tasks 1-7 are verified working.**

- [ ] **Step 1: Remove old middleware fetch/sync code**

Delete or gut:
- `middleware/src/whatnot/operations/orders.ts` — remove fetch functions, keep only if ingest routes don't cover seek time calculation
- `middleware/src/whatnot/operations/shipments.ts` — remove
- `middleware/src/whatnot/operations/messages.ts` — remove
- `middleware/src/whatnot/client.ts` — remove
- `middleware/src/auth/tokenRefresher.ts` — delete
- `middleware/src/auth/cookieStore.ts` — remove cookie storage functions (may keep `getTenantsWithValidSessions` temporarily or replace with checking SyncJob table)
- `middleware/src/jobs/workers/syncWorker.ts` — remove BullMQ worker
- Remove BullMQ dependency if no longer used

- [ ] **Step 2: Remove old trigger routes**

The old `POST /api/sync/trigger` route that queued BullMQ jobs is no longer needed for desktop syncs. Keep it temporarily if the web app still uses it, or replace with a WebSocket broadcast.

- [ ] **Step 3: Remove cookie registration endpoints**

The desktop no longer needs to register cookies with the middleware. Remove:
- `POST /api/auth/register-cookies` handler
- Desktop cookie registration code in `SyncCenter.tsx` and `main.ts`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove old middleware-led sync code"
```
