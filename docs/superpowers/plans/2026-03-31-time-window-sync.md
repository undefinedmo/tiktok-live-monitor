# Time-Window Sync Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace page-count sync with date-window sync (default 30 days), merge orders/customers/products into "Sales Data", add configurable sync window setting.

**Architecture:** The `paginate()` function in `whatnot-sync.ts` gains an optional `cutoffDate` parameter. When set, pagination continues until records older than cutoff are found instead of stopping at a page count. Desktop `sync.ts` reads `syncWindowDays` from settings and passes cutoff. UI consolidates three sync types into one.

**Tech Stack:** TypeScript, Electron store, React

**Spec:** `docs/superpowers/specs/2026-03-31-time-window-sync-design.md`

---

### Task 1: Add date-based stop condition to paginate()

**Files:**
- Modify: `desktop/electron/lib/whatnot-sync.ts:72-101`

- [ ] **Step 1: Update paginate() signature and logic**

In `desktop/electron/lib/whatnot-sync.ts`, replace the `paginate` function (lines 72-101) with:

```typescript
async function paginate<T>(
  query: string, variables: Record<string, unknown>, operationName: string,
  options: {
    maxPages?: number; pageSize?: number;
    cutoffDate?: Date;
    getPageInfo: (data: T) => { hasNextPage: boolean; endCursor: string | null };
    getEdges: (data: T) => unknown[];
    getOldestDate?: (edges: unknown[]) => Date | null;
    delayMs?: number;
  }
): Promise<{ edges: unknown[]; pages: number; errors: string[] }> {
  const { maxPages = 200, pageSize = 50, cutoffDate, getPageInfo, getEdges, getOldestDate, delayMs = 100 } = options;
  const edges: unknown[] = [];
  const errors: string[] = [];
  let cursor: string | null = null;
  let pageCount = 0;

  for (let page = 1; page <= maxPages; page++) {
    const vars = { ...variables, first: pageSize, after: cursor };
    const result = await graphql<T>(query, vars, operationName);
    if (result.errors?.length) { errors.push(...result.errors.map((e) => e.message)); break; }
    if (!result.data) { errors.push('No data returned'); break; }
    const pageEdges = getEdges(result.data);
    edges.push(...pageEdges);
    pageCount = page;

    // Date-based stop: if oldest record on this page is before cutoff, we've covered the window
    if (cutoffDate && getOldestDate && pageEdges.length > 0) {
      const oldest = getOldestDate(pageEdges);
      if (oldest && oldest < cutoffDate) {
        break;
      }
    }

    const pageInfo = getPageInfo(result.data);
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
    if (delayMs > 0 && page < maxPages) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { edges, pages: pageCount, errors };
}
```

Key changes:
- `maxPages` now defaults to `200` (safety cap) instead of being required
- New optional `cutoffDate: Date` — when provided, stops paginating when records older than this date are found
- New optional `getOldestDate(edges) => Date | null` — extracts the oldest date from a page of edges

- [ ] **Step 2: Verify it compiles**

Run:
```bash
cd desktop && npx tsc --noEmit 2>&1 | grep whatnot-sync
```

Expected: only the pre-existing `GRAPHQL_URL` unused warning.

- [ ] **Step 3: Commit**

```bash
git add desktop/electron/lib/whatnot-sync.ts
git commit -m "feat: add date-based stop condition to paginate()

paginate() now accepts cutoffDate and getOldestDate options. When set,
pagination stops when the oldest record on a page is older than the
cutoff date instead of after a fixed page count."
```

---

### Task 2: Update fetch functions to accept cutoffDate

**Files:**
- Modify: `desktop/electron/lib/whatnot-sync.ts:196-232`

- [ ] **Step 1: Update fetchOrders()**

Replace lines 196-205:

```typescript
export async function fetchOrders(options: {
  cutoffDate?: Date;
  maxPages?: number;
  showIds?: string[];
} = {}): Promise<{ records: unknown[]; errors: string[] }> {
  const { cutoffDate, maxPages = 200, showIds } = options;
  const variables: Record<string, unknown> = {};
  if (showIds?.length) variables.salesChannels = showIds.map((id) => ({ type: 'LIVE', id }));
  const { edges, errors } = await paginate(GET_ORDERS_QUERY, variables, 'SellerHubGetMyOrders', {
    maxPages,
    cutoffDate,
    getPageInfo: (data: any) => data.me?.orders?.pageInfo ?? { hasNextPage: false, endCursor: null },
    getEdges: (data: any) => data.me?.orders?.edges?.map((e: any) => e.node) ?? [],
    getOldestDate: (edges: unknown[]) => {
      const dates = edges.map((e: any) => new Date(e.createdAt)).filter((d: Date) => !isNaN(d.getTime()));
      return dates.length > 0 ? new Date(Math.min(...dates.map((d: Date) => d.getTime()))) : null;
    },
  });
  return { records: edges, errors };
}
```

- [ ] **Step 2: Update fetchShipments()**

Replace lines 207-214:

```typescript
export async function fetchShipments(options: {
  cutoffDate?: Date;
  maxPages?: number;
} = {}): Promise<{ records: unknown[]; errors: string[] }> {
  const { cutoffDate, maxPages = 200 } = options;
  const { edges, errors } = await paginate(GET_SHIPMENTS_QUERY, {}, 'GetMyShipments', {
    maxPages,
    cutoffDate,
    getPageInfo: (data: any) => data.myShipments2?.pageInfo ?? { hasNextPage: false, endCursor: null },
    getEdges: (data: any) => data.myShipments2?.edges?.map((e: any) => e.node) ?? [],
    getOldestDate: (edges: unknown[]) => {
      const dates = edges.map((e: any) => new Date(e.createdAt)).filter((d: Date) => !isNaN(d.getTime()));
      return dates.length > 0 ? new Date(Math.min(...dates.map((d: Date) => d.getTime()))) : null;
    },
  });
  return { records: edges, errors };
}
```

- [ ] **Step 3: Update fetchShows() — no cutoff, just maxPages**

Replace lines 216-223:

```typescript
export async function fetchShows(maxPages = 20): Promise<{ records: unknown[]; errors: string[] }> {
  const { edges, errors } = await paginate(GET_SHOWS_QUERY, {}, 'GetLivestreams', {
    maxPages,
    getPageInfo: (data: any) => data.livestreamsByUserId?.pageInfo ?? { hasNextPage: false, endCursor: null },
    getEdges: (data: any) => data.livestreamsByUserId?.edges?.map((e: any) => e.node) ?? [],
  });
  return { records: edges, errors };
}
```

- [ ] **Step 4: Update fetchConversations() — no cutoff**

Replace lines 225-232:

```typescript
export async function fetchConversations(maxPages = 100): Promise<{ records: unknown[]; errors: string[] }> {
  const { edges, errors } = await paginate(GET_CONVERSATIONS_QUERY, {}, 'GetInboxConversationsV2', {
    maxPages, pageSize: 50,
    getPageInfo: (data: any) => data.me?.inbox?.conversationsV2?.pageInfo ?? { hasNextPage: false, endCursor: null },
    getEdges: (data: any) => data.me?.inbox?.conversationsV2?.edges?.map((e: any) => e.node) ?? [],
  });
  return { records: edges, errors };
}
```

- [ ] **Step 5: Verify it compiles**

Run:
```bash
cd desktop && npx tsc --noEmit 2>&1 | grep whatnot-sync
```

- [ ] **Step 6: Commit**

```bash
git add desktop/electron/lib/whatnot-sync.ts
git commit -m "feat: update fetch functions to accept cutoffDate

fetchOrders and fetchShipments now accept { cutoffDate, maxPages } options.
They paginate until records older than cutoffDate are found instead of stopping
at a fixed page count. Shows and conversations keep simple maxPages."
```

---

### Task 3: Rewrite sync.ts to use time-window and merged types

**Files:**
- Modify: `desktop/electron/ipc/sync.ts` (full rewrite of runSync + handler registration)
- Modify: `desktop/electron/lib/store.ts` (add syncWindowDays to SettingsSchema)

- [ ] **Step 1: Add syncWindowDays to store settings**

In `desktop/electron/lib/store.ts`, find the `SettingsSchema` interface and add `syncWindowDays`:

```typescript
export interface SettingsSchema {
  tenantId: string;
  syncWindowDays: number;  // <-- ADD THIS
  dbHost: string;
  // ... rest unchanged
```

And add the default in the `settingsStore` constructor:

```typescript
export const settingsStore = new Store<SettingsSchema>({
  name: 'settings',
  defaults: {
    tenantId: '',
    syncWindowDays: 30,  // <-- ADD THIS
    dbHost: '',
    // ... rest unchanged
```

- [ ] **Step 2: Rewrite sync.ts**

Replace the entire contents of `desktop/electron/ipc/sync.ts`:

```typescript
// Sync IPC Handlers — orchestrate fetching from Whatnot and posting to middleware
import { ipcMain, BrowserWindow } from 'electron';
import {
  fetchOrders,
  fetchShipments,
  fetchShows,
  fetchConversations,
  fetchMessagesForConversation,
} from '../lib/whatnot-sync';
import { getWhatnotAuthState } from '../lib/whatnot-api';
import { settingsStore } from '../lib/store';

let getMainWindow: () => BrowserWindow | null;
let silentLogin: () => Promise<boolean>;
let getMiddlewareClient: () => {
  post: (path: string, body: unknown) => Promise<any>;
};

// Track running syncs to prevent duplicates
const runningSyncs = new Set<string>();

interface SyncProgress {
  type: string;
  status: 'fetching' | 'uploading' | 'processing' | 'complete' | 'error';
  progress: number;
  message: string;
  counts?: Record<string, number>;
}

function sendProgress(progress: SyncProgress) {
  getMainWindow()?.webContents.send('sync:progress', progress);
}

async function ensureAuth(): Promise<boolean> {
  const auth = await getWhatnotAuthState();
  if (auth.authenticated) return true;
  return silentLogin();
}

function getCutoffDate(): Date {
  const days = settingsStore.get('syncWindowDays') || 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// Valid sync types — "orders" covers orders + customers + products
const SYNC_TYPES = ['orders', 'shows', 'shipments', 'messages'] as const;
type SyncType = typeof SYNC_TYPES[number];

// Map from ingest endpoint to middleware path
const INGEST_ENDPOINTS: Record<SyncType, string> = {
  orders: '/api/sync/ingest/orders',
  shows: '/api/sync/ingest/shows',
  shipments: '/api/sync/ingest/shipments',
  messages: '/api/sync/ingest/conversations',
};

async function runSync(
  type: SyncType,
  force: boolean
): Promise<{
  success: boolean;
  counts?: Record<string, number>;
  error?: string;
}> {
  // Prevent duplicate syncs of the same type
  if (runningSyncs.has(type)) {
    console.log(`[Sync] ${type} sync already running — skipping`);
    return { success: false, error: `${type} sync is already running` };
  }

  runningSyncs.add(type);
  console.log(`[Sync] runSync: type=${type}, force=${force}`);

  try {
    if (!(await ensureAuth())) {
      sendProgress({ type, status: 'error', progress: 0, message: 'Not authenticated — please log in to Whatnot' });
      return { success: false, error: 'Not authenticated' };
    }

    sendProgress({ type, status: 'fetching', progress: 10, message: `Fetching ${type} from Whatnot...` });

    // Fetch data with date-based stop condition where applicable
    const cutoffDate = force ? undefined : getCutoffDate();
    let fetchResult: { records: unknown[]; errors: string[] };

    switch (type) {
      case 'orders':
        fetchResult = await fetchOrders({ cutoffDate });
        break;
      case 'shipments':
        fetchResult = await fetchShipments({ cutoffDate });
        break;
      case 'shows':
        fetchResult = await fetchShows(force ? 50 : 20);
        break;
      case 'messages':
        fetchResult = await fetchConversations(100);
        break;
    }

    console.log(`[Sync] Fetch complete: ${fetchResult.records.length} records, ${fetchResult.errors.length} errors`);

    // Retry on auth error
    if (fetchResult.records.length === 0 && fetchResult.errors.some((e) => e.includes('401'))) {
      sendProgress({ type, status: 'fetching', progress: 5, message: 'Auth error, refreshing session...' });
      if (await silentLogin()) {
        switch (type) {
          case 'orders':
            fetchResult = await fetchOrders({ cutoffDate });
            break;
          case 'shipments':
            fetchResult = await fetchShipments({ cutoffDate });
            break;
          case 'shows':
            fetchResult = await fetchShows(force ? 50 : 20);
            break;
          case 'messages':
            fetchResult = await fetchConversations(100);
            break;
        }
      }
    }

    if (fetchResult.records.length === 0 && fetchResult.errors.length > 0) {
      sendProgress({ type, status: 'error', progress: 0, message: fetchResult.errors[0] });
      return { success: false, error: fetchResult.errors.join(', ') };
    }

    if (fetchResult.records.length === 0) {
      sendProgress({ type, status: 'complete', progress: 100, message: 'No new records found' });
      return { success: true, counts: {} };
    }

    sendProgress({ type, status: 'uploading', progress: 40, message: `Sending ${fetchResult.records.length} records...` });

    const client = getMiddlewareClient();

    sendProgress({ type, status: 'processing', progress: 70, message: `Processing ${fetchResult.records.length} records...` });

    const result = await client.post(INGEST_ENDPOINTS[type], {
      records: fetchResult.records,
      force,
    });
    console.log(`[Sync] Ingest result:`, JSON.stringify(result).substring(0, 200));

    if (!result.success) {
      sendProgress({ type, status: 'error', progress: 0, message: result.error || 'Ingest failed' });
      return { success: false, error: result.error };
    }

    const totalRecords = Object.values(result.counts || {}).reduce((a: number, b: unknown) => a + (Number(b) || 0), 0);
    sendProgress({ type, status: 'complete', progress: 100, message: `Synced ${totalRecords} records`, counts: result.counts });
    return { success: true, counts: result.counts };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Sync failed';
    console.error(`[Sync] Error in ${type} sync:`, msg);
    sendProgress({ type, status: 'error', progress: 0, message: msg });
    return { success: false, error: msg };
  } finally {
    runningSyncs.delete(type);
  }
}

export function registerSyncHandlers(deps: {
  mainWindowFactory: () => BrowserWindow | null;
  silentLoginFn: () => Promise<boolean>;
  middlewareClientFactory: () => {
    post: (path: string, body: unknown) => Promise<any>;
  };
}) {
  console.log('[Sync] Registering sync IPC handlers');
  getMainWindow = deps.mainWindowFactory;
  silentLogin = deps.silentLoginFn;
  getMiddlewareClient = deps.middlewareClientFactory;

  ipcMain.handle(
    'sync:trigger',
    async (_event, { type, force }: { type: string; force?: boolean }) => {
      // Map legacy types to the canonical type
      const canonical = (type === 'customers' || type === 'products') ? 'orders' : type;
      if (!SYNC_TYPES.includes(canonical as SyncType)) {
        return { success: false, error: `Unknown sync type: ${type}` };
      }
      console.log(`[Sync] IPC sync:trigger: ${type}${type !== canonical ? ` → ${canonical}` : ''}, force=${force}`);
      return runSync(canonical as SyncType, force ?? false);
    }
  );

  ipcMain.handle(
    'sync:trigger-all',
    async (_event, { force }: { force?: boolean } = {}) => {
      const results: Record<string, any> = {};
      for (const t of SYNC_TYPES) {
        results[t] = await runSync(t, force ?? false);
      }
      return results;
    }
  );

  ipcMain.handle(
    'sync:fetch-messages',
    async (
      _event,
      { conversationId, myUsername }: { conversationId: string; myUsername: string }
    ) => {
      if (!(await ensureAuth())) {
        return { success: false, error: 'Not authenticated' };
      }
      const { records, errors } = await fetchMessagesForConversation(conversationId);
      if (records.length === 0 && errors.length > 0) {
        return { success: false, error: errors.join(', ') };
      }
      const client = getMiddlewareClient();
      return client.post('/api/sync/ingest/messages', {
        conversationWhatnotId: conversationId,
        messages: records,
        myUsername,
      });
    }
  );
}
```

- [ ] **Step 3: Verify it compiles**

Run:
```bash
cd desktop && npx tsc --noEmit 2>&1 | grep -E "sync\.ts|store\.ts"
```

Expected: no errors from our files.

- [ ] **Step 4: Commit**

```bash
git add desktop/electron/ipc/sync.ts desktop/electron/lib/store.ts
git commit -m "feat: time-window sync engine with merged order types

Sync uses date-based stop condition (default 30 days from settings).
Orders/customers/products merged into single 'orders' type.
Force sync ignores cutoff. Legacy types mapped to canonical types."
```

---

### Task 4: Update SyncCenter UI

**Files:**
- Modify: `desktop/src/pages/SyncCenter.tsx:32-63`

- [ ] **Step 1: Replace syncTypes array**

In `desktop/src/pages/SyncCenter.tsx`, replace lines 32-63 (the `syncTypes` array):

```typescript
const syncTypes: SyncTypeConfig[] = [
  {
    id: 'orders',
    name: 'Sales Data',
    description: 'Syncs orders, customers, and products',
    icon: ShoppingCart,
  },
  {
    id: 'shows',
    name: 'Shows',
    description: 'Sync live and past show data',
    icon: Calendar,
  },
  {
    id: 'shipments',
    name: 'Shipments',
    description: 'Sync shipment and tracking data',
    icon: Truck,
  },
  {
    id: 'messages',
    name: 'Messages',
    description: 'Sync inbox conversations',
    icon: MessageSquare,
  },
  {
    id: 'usps_tracking',
    name: 'USPS Tracking',
    description: 'Check delivery status for USPS shipments',
    icon: Package,
  },
];
```

- [ ] **Step 2: Add ShoppingCart to the icon imports**

Find the lucide-react import at the top of the file. Add `ShoppingCart` to it. Remove `Users` if it's no longer used elsewhere in the file.

- [ ] **Step 3: Verify it compiles**

Run:
```bash
cd desktop && npx tsc --noEmit 2>&1 | grep SyncCenter
```

- [ ] **Step 4: Commit**

```bash
git add desktop/src/pages/SyncCenter.tsx
git commit -m "feat: consolidate sync UI — replace Customers with Sales Data

Removed separate Customers and Products sync cards. Added 'Sales Data'
card that syncs orders, customers, and products together."
```

---

### Task 5: Update web status endpoint

**Files:**
- Modify: `web/src/app/api/sync/status/route.ts:14`

- [ ] **Step 1: Remove customers and products from syncTypes**

In `web/src/app/api/sync/status/route.ts`, change line 14:

```typescript
// Before:
    const syncTypes = ["orders", "shows", "shipments", "messages", "customers", "products"];

// After:
    const syncTypes = ["orders", "shows", "shipments", "messages"];
```

- [ ] **Step 2: Commit**

```bash
git add web/src/app/api/sync/status/route.ts
git commit -m "fix: remove customers/products from sync status types

These are no longer separate sync types — they're part of the orders sync."
```

---

### Task 6: Revert ingest syncType override

**Files:**
- Modify: `middleware/src/api/routes/ingest.routes.ts:98-116`

- [ ] **Step 1: Remove the syncType parameter from orders ingest**

In `middleware/src/api/routes/ingest.routes.ts`, find the body parsing (around line 98):

```typescript
// Before:
      const { records, force, syncType } = request.body as {
        records: OrderRecord[];
        force?: boolean;
        syncType?: string;
      };
```

Change to:

```typescript
      const { records, force } = request.body as {
        records: OrderRecord[];
        force?: boolean;
      };
```

And find the `jobType` line and the SyncJob create:

```typescript
// Before:
      const jobType = syncType && ['orders', 'customers', 'products'].includes(syncType) ? syncType : 'orders';
      const job = await prisma.syncJob.create({
        data: {
          tenantId,
          userId,
          type: jobType,

// After:
      const job = await prisma.syncJob.create({
        data: {
          tenantId,
          userId,
          type: 'orders',
```

- [ ] **Step 2: Verify middleware compiles**

Run:
```bash
cd middleware && npx tsc --noEmit 2>&1 | grep ingest
```

Expected: only the pre-existing `ShowRecord` unused warning.

- [ ] **Step 3: Commit**

```bash
git add middleware/src/api/routes/ingest.routes.ts
git commit -m "fix: revert syncType override in orders ingest

Orders ingest always creates SyncJob with type 'orders'. The syncType
parameter is no longer needed since customers/products are not separate
sync types."
```

---

### Task 7: Add sync window setting to Settings page

**Files:**
- Modify: `desktop/src/pages/Settings.tsx`
- Modify: `desktop/electron/ipc/settings.ts` (if needed for store read/write)

- [ ] **Step 1: Add syncWindowDays state to Settings page**

In `desktop/src/pages/Settings.tsx`, find the form state declarations (around line 51 where `videoSeekBuffer` is). Add after it:

```typescript
  const [syncWindowDays, setSyncWindowDays] = useState(30);
```

- [ ] **Step 2: Initialize from settings on load**

Find where `setVideoSeekBuffer(settings.videoSeekBuffer ?? 30)` is called (around line 108). Add after it:

```typescript
      setSyncWindowDays(settings.syncWindowDays ?? 30);
```

- [ ] **Step 3: Include in save**

Find where the save function builds the settings object to send (look for `videoSeekBuffer` in the save payload). Add `syncWindowDays` to the same object:

```typescript
        syncWindowDays,
```

- [ ] **Step 4: Add the UI input**

Find the "Advanced" settings section in the JSX (look for where `videoSeekBuffer` input is rendered). Add a new input group before or after it:

```tsx
              {/* Sync Lookback Window */}
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">
                  Sync Lookback Window (days)
                </label>
                <input
                  type="number"
                  min={7}
                  max={365}
                  value={syncWindowDays}
                  onChange={(e) => setSyncWindowDays(parseInt(e.target.value) || 30)}
                  className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
                />
                <p className="mt-1 text-xs text-text-secondary">
                  Whatnot allows refunds up to 30 days from transaction date. Orders and shipments within this window are re-synced to catch refunds, cancellations, and payment status changes.
                </p>
              </div>
```

- [ ] **Step 5: Verify settings IPC handler supports the new field**

Check `desktop/electron/ipc/settings.ts` — the save handler likely does `store.set(key, value)` for each setting. If `syncWindowDays` is in the SettingsSchema and the save handler iterates over all fields, no change is needed. If it has an explicit field list, add `syncWindowDays`.

- [ ] **Step 6: Verify it compiles**

Run:
```bash
cd desktop && npx tsc --noEmit 2>&1 | grep Settings
```

- [ ] **Step 7: Commit**

```bash
git add desktop/src/pages/Settings.tsx desktop/electron/ipc/settings.ts
git commit -m "feat: add sync lookback window setting (default 30 days)

Configurable number of days to look back when syncing orders and shipments.
Defaults to 30 days to cover Whatnot's refund window."
```

---

### Task 8: Final verification

- [ ] **Step 1: Build all projects**

Run:
```bash
cd desktop && npx tsc --noEmit 2>&1 | grep -E "sync|store|Settings|SyncCenter" | grep -v node_modules
cd ../middleware && npx tsc --noEmit 2>&1 | grep ingest
cd ../web && npx tsc --noEmit 2>&1 | grep status
```

Expected: no errors from changed files.

- [ ] **Step 2: Verify no references to old sync types**

```bash
# Desktop — should find no 'customers' or 'products' as sync type IDs:
grep -rn "'customers'" desktop/src/pages/SyncCenter.tsx
grep -rn "'products'" desktop/src/pages/SyncCenter.tsx

# Web — should find 4 types, not 6:
grep "syncTypes" web/src/app/api/sync/status/route.ts
```

Expected: no matches in SyncCenter, status route shows `["orders", "shows", "shipments", "messages"]`.

- [ ] **Step 3: Verify cutoffDate flow**

```bash
# sync.ts should call getCutoffDate() and pass to fetchOrders:
grep "cutoffDate" desktop/electron/ipc/sync.ts

# whatnot-sync.ts should use cutoffDate in paginate:
grep "cutoffDate" desktop/electron/lib/whatnot-sync.ts
```

Expected: both files reference cutoffDate.
