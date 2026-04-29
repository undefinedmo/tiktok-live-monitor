# Sync & Session Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix seven verified sync/session vulnerabilities identified in code review — session model drift, global scheduler broadcast, optimistic session recovery, lossy cookie restoration, inverted token expiry, localStorage key mismatch, and predictable store encryption.

**Architecture:** Targeted hardening pass on existing code. No new tables, no new endpoints, no architecture changes. Supplements the approved desktop-led sync migration (2026-03-27).

**Tech Stack:** Prisma (schema migration), TypeScript, Electron (safeStorage API), Socket.io (room enumeration)

**Spec:** `docs/superpowers/specs/2026-03-30-sync-session-hardening-design.md`

---

### Task 1: Session Model — Enforce One Session Per Tenant

**Files:**
- Modify: `middleware/prisma/schema.prisma:738` (unique constraint)
- Modify: `middleware/src/auth/cookieStore.ts:156-176` (storeCookies upsert)
- Modify: `middleware/src/lib/resolveUserId.ts:8` (add assumption comment)

- [ ] **Step 1: Update the unique constraint in schema.prisma**

In `middleware/prisma/schema.prisma`, change the WhatnotSession model's unique constraint:

```prisma
// Before (line 738):
  @@unique([userId, platform, tenantId])

// After:
  @@unique([tenantId, platform])
```

- [ ] **Step 2: Generate the Prisma migration**

Run:
```bash
cd middleware && npx prisma migrate dev --name session-unique-by-tenant-platform
```

If this fails because existing data violates the new constraint, run the following SQL first to clean up duplicates (keep only the most recently used session per tenant+platform):

```sql
DELETE FROM whatnot_sessions
WHERE id NOT IN (
  SELECT DISTINCT ON (tenant_id, platform) id
  FROM whatnot_sessions
  ORDER BY tenant_id, platform, last_used DESC
);
```

Then re-run the migration.

- [ ] **Step 3: Update storeCookies() upsert logic**

In `middleware/src/auth/cookieStore.ts`, replace lines 156-176:

```typescript
// Before:
  // Upsert session by userId+platform+tenantId (matches DB unique constraint)
  const existing = await prisma.whatnotSession.findFirst({
    where: {
      tenantId,
      platform,
      userId: resolvedUserId,
    },
  });

  const session = existing
    ? await prisma.whatnotSession.update({
        where: { id: existing.id },
        data: { ...sessionData, lastRefreshed: new Date() },
      })
    : await prisma.whatnotSession.create({
        data: {
          ...sessionData,
          userId: resolvedUserId,
          platform,
        },
      });

// After:
  // Invalidate any other valid sessions for this tenant (single-user-per-tenant)
  await prisma.whatnotSession.updateMany({
    where: { tenantId, isValid: true },
    data: { isValid: false },
  });

  // Upsert session by tenantId+platform (matches DB unique constraint)
  const session = await prisma.whatnotSession.upsert({
    where: { tenantId_platform: { tenantId, platform } },
    update: {
      ...sessionData,
      userId: resolvedUserId,
      lastRefreshed: new Date(),
    },
    create: {
      ...sessionData,
      userId: resolvedUserId,
      platform,
    },
  });
```

- [ ] **Step 4: Add assumption comment to resolveUserId.ts**

In `middleware/src/lib/resolveUserId.ts`, update the JSDoc comment:

```typescript
// Before (lines 3-7):
/**
 * Resolve the userId associated with a tenant's active Whatnot session.
 * Business tables (Customer, Conversation, Order, Shipment, Message, etc.)
 * still reference userId, so sync operations need this lookup.
 */

// After:
/**
 * Resolve the userId associated with a tenant's active Whatnot session.
 * Business tables (Customer, Conversation, Order, Shipment, Message, etc.)
 * still reference userId, so sync operations need this lookup.
 *
 * ASSUMPTION: Single Whatnot user per tenant. If multi-user tenants are
 * needed, this function must accept a userId parameter instead of
 * picking the most recently used session.
 */
```

- [ ] **Step 5: Verify the middleware builds**

Run:
```bash
cd middleware && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add middleware/prisma/schema.prisma middleware/prisma/migrations/ middleware/src/auth/cookieStore.ts middleware/src/lib/resolveUserId.ts
git commit -m "fix: enforce one Whatnot session per tenant in schema and upsert logic

Single-user-per-tenant assumption: replace @@unique([userId, platform, tenantId])
with @@unique([tenantId, platform]). Update storeCookies() to use Prisma upsert
on the new constraint and invalidate stale sessions before writing."
```

---

### Task 2: Scheduler — Broadcast Per Tenant, Not Globally

**Files:**
- Modify: `middleware/src/websocket/broadcaster.ts:84` (add helper after broadcastToAll)
- Modify: `middleware/src/jobs/scheduler.ts:5,87-106` (import + replace broadcastToAll calls)

- [ ] **Step 1: Add getTenantsWithConnectedClients() to broadcaster.ts**

In `middleware/src/websocket/broadcaster.ts`, add after the `broadcastToAll` function (after line 84):

```typescript
/**
 * Get all tenant IDs that have at least one connected WebSocket client.
 * Uses Socket.io room membership — rooms named "tenant:{id}".
 */
export function getTenantsWithConnectedClients(): string[] {
  const io = getIO();
  if (!io) return [];

  const tenantIds: string[] = [];
  const rooms = io.sockets.adapter.rooms;

  for (const [roomName, members] of rooms) {
    if (roomName.startsWith('tenant:') && members.size > 0) {
      tenantIds.push(roomName.slice('tenant:'.length));
    }
  }

  return tenantIds;
}
```

- [ ] **Step 2: Update scheduler.ts imports**

In `middleware/src/jobs/scheduler.ts`, change line 5:

```typescript
// Before:
import { broadcastToAll } from '../websocket/broadcaster.js';

// After:
import { broadcastToTenant, getTenantsWithConnectedClients } from '../websocket/broadcaster.js';
```

- [ ] **Step 3: Replace the three broadcastToAll calls**

In `middleware/src/jobs/scheduler.ts`, replace lines 87-106:

```typescript
// Before:
async function scheduleMessageSyncs(): Promise<void> {
  logger.info('Broadcasting message sync request');
  broadcastToAll('sync:request', { type: 'messages', force: false });
}

/**
 * Broadcast order sync request to all connected clients
 */
async function scheduleOrderSyncs(): Promise<void> {
  logger.info('Broadcasting order sync request');
  broadcastToAll('sync:request', { type: 'orders', force: false });
}

/**
 * Broadcast shipment sync request to all connected clients
 */
async function scheduleShipmentSyncs(): Promise<void> {
  logger.info('Broadcasting shipment sync request');
  broadcastToAll('sync:request', { type: 'shipments', force: false });
}

// After:
async function scheduleMessageSyncs(): Promise<void> {
  const tenantIds = getTenantsWithConnectedClients();
  logger.info({ tenantCount: tenantIds.length }, 'Broadcasting message sync request per tenant');
  for (const tenantId of tenantIds) {
    broadcastToTenant(tenantId, 'sync:request', { type: 'messages', force: false });
  }
}

async function scheduleOrderSyncs(): Promise<void> {
  const tenantIds = getTenantsWithConnectedClients();
  logger.info({ tenantCount: tenantIds.length }, 'Broadcasting order sync request per tenant');
  for (const tenantId of tenantIds) {
    broadcastToTenant(tenantId, 'sync:request', { type: 'orders', force: false });
  }
}

async function scheduleShipmentSyncs(): Promise<void> {
  const tenantIds = getTenantsWithConnectedClients();
  logger.info({ tenantCount: tenantIds.length }, 'Broadcasting shipment sync request per tenant');
  for (const tenantId of tenantIds) {
    broadcastToTenant(tenantId, 'sync:request', { type: 'shipments', force: false });
  }
}
```

- [ ] **Step 4: Verify the middleware builds**

Run:
```bash
cd middleware && npx tsc --noEmit
```

Expected: no errors. If `broadcastToAll` is still imported elsewhere, the unused import removal may cause a warning but not an error. Check if anything else imports `broadcastToAll` — if not, leave it exported (other code may use it later).

- [ ] **Step 5: Commit**

```bash
git add middleware/src/websocket/broadcaster.ts middleware/src/jobs/scheduler.ts
git commit -m "fix: scope scheduled sync broadcasts to tenant rooms instead of global

Add getTenantsWithConnectedClients() that reads Socket.io room membership.
Scheduler now iterates connected tenants and uses broadcastToTenant() per tenant
instead of broadcastToAll()."
```

---

### Task 3: Session Recovery — Confirmation Handshake

**Files:**
- Modify: `middleware/src/api/routes/auth.routes.ts:68-74` (emit session:refreshed after registration)
- Modify: `desktop/electron/main.ts:254-264` (wait for registration before finish)
- Modify: `desktop/src/components/Layout.tsx:199-201` (don't set connected on local success)

- [ ] **Step 1: Emit notifySessionRefreshed after cookie registration**

In `middleware/src/api/routes/auth.routes.ts`, add the import at the top (after existing imports around line 10):

```typescript
import { notifySessionRefreshed } from '../../websocket/broadcaster.js';
```

Then add the notification call after line 67 (after the "Cookies registered" log), before the `return reply.send(...)`:

```typescript
        logger.info(
          { tenantId, authenticatedBy, platform: body.platform, cookieCount: body.cookies.length, isValid },
          'Cookies registered via service token'
        );

        // Notify connected clients that session has been refreshed
        if (isValid) {
          notifySessionRefreshed(tenantId, expiresAt);
        }

        return reply.send({
```

- [ ] **Step 2: Update silent login to wait for cookie registration**

In `desktop/electron/main.ts`, replace the `finish(true)` block inside `attemptSilentWhatnotLogin` (lines 254-259):

```typescript
// Before:
      if (success) {
        console.log('[App] Silent login succeeded');
        mainWindow?.webContents.send('whatnot-auth-status', {
          connected: true,
          message: 'Connected to Whatnot'
        });
      }

// After:
      if (success) {
        console.log('[App] Silent login succeeded — registering cookies with middleware');
        // Don't send connected status yet — wait for middleware confirmation
        // The renderer will transition to connected when it receives session:refreshed
      }
```

- [ ] **Step 3: Update handleSessionRefreshRequest to wait for registration response**

In `desktop/electron/main.ts`, replace the `handleSessionRefreshRequest` function (lines 286-307):

```typescript
// Before:
async function handleSessionRefreshRequest(): Promise<boolean> {
  console.log('[App] Middleware requested session refresh — attempting silent login');
  const success = await attemptSilentWhatnotLogin();

  if (success) {
    // Re-register cookies immediately
    try {
      const cookies = await session.defaultSession.cookies.get({ url: 'https://www.whatnot.com' });
      const structured = cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.whatnot.com',
        path: c.path || '/',
        secure: c.secure ?? true,
        httpOnly: c.httpOnly ?? true,
        sameSite: c.sameSite === 'no_restriction' ? 'None' : c.sameSite === 'lax' ? 'Lax' : 'Strict',
        expirationDate: c.expirationDate || undefined,
      }));

      // Send cookies to renderer so it can forward to web app -> middleware
      mainWindow?.webContents.send('force-register-cookies', { cookies: structured });
      console.log('[App] Fresh cookies sent to renderer for registration');
    } catch (error) {
      console.error('[App] Failed to get cookies after silent login:', error);
    }
  }

  return success;
}

// After:
async function handleSessionRefreshRequest(): Promise<boolean> {
  console.log('[App] Middleware requested session refresh — attempting silent login');
  const success = await attemptSilentWhatnotLogin();

  if (success) {
    try {
      const cookies = await session.defaultSession.cookies.get({ url: 'https://www.whatnot.com' });
      const structured = cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.whatnot.com',
        path: c.path || '/',
        secure: c.secure ?? true,
        httpOnly: c.httpOnly ?? true,
        sameSite: c.sameSite === 'no_restriction' ? 'None' : c.sameSite === 'lax' ? 'Lax' : 'Strict',
        expirationDate: c.expirationDate || undefined,
      }));

      // Send cookies to renderer for registration with middleware
      // Renderer forwards to web app -> middleware -> middleware emits session:refreshed
      mainWindow?.webContents.send('force-register-cookies', { cookies: structured });
      console.log('[App] Fresh cookies sent to renderer for registration');

      // Wait for middleware to confirm (session:refreshed event will update UI)
      // Don't send connected status here — Layout.tsx handles it via session:refreshed
      return true;
    } catch (error) {
      console.error('[App] Failed to get cookies after silent login:', error);
      return false;
    }
  }

  return false;
}
```

- [ ] **Step 4: Update Layout.tsx session refresh handler**

In `desktop/src/components/Layout.tsx`, replace the `onSessionNeedsRefresh` handler (lines 195-204):

```typescript
// Before:
    const unsubRefresh = onSessionNeedsRefresh(async () => {
      setSessionHealth('reconnecting');
      if (window.whatnotAPI?.handleSessionRefresh) {
        const success = await window.whatnotAPI.handleSessionRefresh();
        if (success) {
          setSessionHealth('connected');
          setWhatnotAuth({ checked: true, authenticated: true });
        }
        // Don't set expired here — wait for middleware to confirm via session:expired
      }
    });

// After:
    const unsubRefresh = onSessionNeedsRefresh(async () => {
      setSessionHealth('reconnecting');
      if (window.whatnotAPI?.handleSessionRefresh) {
        await window.whatnotAPI.handleSessionRefresh();
        // Don't set connected here — wait for session:refreshed from middleware
      }
    });

    const unsubRefreshed = onSessionRefreshed(() => {
      setSessionHealth('connected');
      setWhatnotAuth({ checked: true, authenticated: true });
    });
```

Also update the cleanup return to include the new listener:

```typescript
// Before:
    return () => { unsubRefresh(); unsubExpired(); };

// After:
    return () => { unsubRefresh(); unsubRefreshed(); unsubExpired(); };
```

- [ ] **Step 5: Verify onSessionRefreshed exists in middleware socket helpers**

Check that `onSessionRefreshed` is exported from `desktop/src/lib/middlewareSocket.ts`. If it doesn't exist, add it following the same pattern as `onSessionNeedsRefresh` and `onSessionExpired`:

```typescript
export function onSessionRefreshed(callback: () => void): () => void {
  listeners.sessionRefreshed.add(callback);
  return () => { listeners.sessionRefreshed.delete(callback); };
}
```

And ensure the socket handler forwards the event:

```typescript
socket.on('session:refreshed', () => {
  for (const cb of listeners.sessionRefreshed) cb();
});
```

- [ ] **Step 6: Verify both projects build**

Run:
```bash
cd middleware && npx tsc --noEmit
cd ../desktop && npx tsc --noEmit
```

Expected: no errors in either project.

- [ ] **Step 7: Commit**

```bash
git add middleware/src/api/routes/auth.routes.ts desktop/electron/main.ts desktop/src/components/Layout.tsx desktop/src/lib/middlewareSocket.ts
git commit -m "fix: require middleware confirmation before marking session as connected

Cookie registration endpoint now emits session:refreshed after successful store.
Desktop no longer flips UI to connected on local token detection — waits for
session:refreshed event from middleware. Closes optimistic session recovery gap."
```

---

### Task 4: Cookie Restoration — Restore All Attributes

**Files:**
- Modify: `desktop/electron/main.ts:1620-1621` (cookie restore)

- [ ] **Step 1: Fix the cookie restoration call**

In `desktop/electron/main.ts`, replace lines 1615-1621:

```typescript
// Before:
        await ses.cookies.set({
          url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`,
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path || '/',
          secure: cookie.secure ?? true,
          httpOnly: cookie.httpOnly ?? false,
          expirationDate: cookie.expirationDate || now + 365 * 24 * 60 * 60,
        });

// After:
        await ses.cookies.set({
          url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`,
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path || '/',
          secure: cookie.secure ?? true,
          httpOnly: cookie.httpOnly ?? true,
          sameSite: cookie.sameSite ?? 'no_restriction',
          expirationDate: cookie.expirationDate || now + 365 * 24 * 60 * 60,
        });
```

Two changes:
- `httpOnly`: default changed from `false` to `true` (Whatnot auth cookies are httpOnly)
- `sameSite`: added, defaults to `'no_restriction'` (Electron's equivalent of `SameSite=None`)

- [ ] **Step 2: Verify the desktop builds**

Run:
```bash
cd desktop && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add desktop/electron/main.ts
git commit -m "fix: restore sameSite and correct httpOnly default in cookie persistence

Cookie restoration now round-trips sameSite (was saved but not restored) and
defaults httpOnly to true instead of false for Whatnot auth cookies."
```

---

### Task 5: Token Expiry Buffer Fix

**Files:**
- Modify: `desktop/src/contexts/AuthContext.tsx:59`

- [ ] **Step 1: Fix the expiry check**

In `desktop/src/contexts/AuthContext.tsx`, change line 59:

```typescript
// Before:
  return payload.exp * 1000 < Date.now() - 30000;

// After:
  return payload.exp * 1000 < Date.now() + 30000;
```

- [ ] **Step 2: Update the comment for clarity**

Change line 58:

```typescript
// Before:
  // Add 30 second buffer

// After:
  // Expire 30 seconds early to allow time for refresh
```

- [ ] **Step 3: Verify the desktop builds**

Run:
```bash
cd desktop && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/contexts/AuthContext.tsx
git commit -m "fix: expire JWT 30 seconds early instead of 30 seconds late

isTokenExpired() was checking Date.now() - 30000 (grace after expiry) instead of
Date.now() + 30000 (buffer before expiry). Tokens now trigger refresh before
they actually expire."
```

---

### Task 6: localStorage Key Mismatch Fix

**Files:**
- Modify: `desktop/src/lib/apiClient.ts:90`

- [ ] **Step 1: Fix the key name**

In `desktop/src/lib/apiClient.ts`, change line 90:

```typescript
// Before:
        localStorage.removeItem('auth_token');

// After:
        localStorage.removeItem('authToken');
```

- [ ] **Step 2: Verify the desktop builds**

Run:
```bash
cd desktop && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add desktop/src/lib/apiClient.ts
git commit -m "fix: clear correct localStorage key on 401

401 handler was removing 'auth_token' (snake_case) while the app stores under
'authToken' (camelCase), leaving stale auth state after expiry."
```

---

### Task 7: Migrate Electron Store to safeStorage

**Files:**
- Modify: `desktop/electron/lib/store.ts` (rewrite)
- Modify: `desktop/electron/main.ts` (add migration call at startup)

- [ ] **Step 1: Rewrite store.ts with two-tier storage**

Replace the entire contents of `desktop/electron/lib/store.ts`:

```typescript
// Electron Store - Two-tier storage
// Secrets: encrypted via Electron safeStorage (OS keychain)
// Settings: plain electron-store (no encryption needed)
import Store from 'electron-store';
import { safeStorage, app } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

// ─── Secure Store (safeStorage-backed) ───

const SECURE_STORE_PATH = path.join(app.getPath('userData'), 'secure-store.json');

type SecureKey =
  | 'authToken'
  | 'openaiKey'
  | 'geminiKey'
  | 'whatnotCookies'
  | 'middlewareUrl'
  | 'middlewareToken'
  | 'dbPassword'
  | 'uspsConsumerKey'
  | 'uspsConsumerSecret'
  | 'shippoApiToken';

const SECURE_KEYS: Set<string> = new Set<string>([
  'authToken', 'openaiKey', 'geminiKey', 'whatnotCookies',
  'middlewareUrl', 'middlewareToken', 'dbPassword',
  'uspsConsumerKey', 'uspsConsumerSecret', 'shippoApiToken',
]);

function isSecureKey(key: string): key is SecureKey {
  return SECURE_KEYS.has(key);
}

function readSecureFile(): Record<string, string> {
  try {
    if (!fs.existsSync(SECURE_STORE_PATH)) return {};
    const raw = fs.readFileSync(SECURE_STORE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeSecureFile(data: Record<string, string>): void {
  fs.writeFileSync(SECURE_STORE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

let safeStorageAvailable: boolean | null = null;

function isSafeStorageReady(): boolean {
  if (safeStorageAvailable === null) {
    safeStorageAvailable = safeStorage.isEncryptionAvailable();
    if (!safeStorageAvailable) {
      console.warn('[Store] safeStorage not available — falling back to legacy encryption');
    }
  }
  return safeStorageAvailable;
}

function encryptValue(value: string): string {
  if (isSafeStorageReady()) {
    return safeStorage.encryptString(value).toString('base64');
  }
  // Fallback: legacy derivation (for headless Linux without keyring)
  return legacyEncrypt(value);
}

function decryptValue(encrypted: string): string {
  if (isSafeStorageReady()) {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  }
  return legacyDecrypt(encrypted);
}

// Legacy fallback (same derivation as old store, for environments without keyring)
function legacyDeriveKey(): string {
  const machineId = `${os.hostname()}-${os.platform()}-${os.arch()}`;
  const appSalt = 'sellerfolio-2024';
  return crypto.createHash('sha256').update(`${machineId}-${appSalt}`).digest('hex').substring(0, 32);
}

function legacyEncrypt(text: string): string {
  const key = legacyDeriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'hex').subarray(0, 32), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function legacyDecrypt(text: string): string {
  const key = legacyDeriveKey();
  const [ivHex, encrypted] = text.split(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex').subarray(0, 32), Buffer.from(ivHex, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export const secureStore = {
  get(key: SecureKey): string {
    const data = readSecureFile();
    const encrypted = data[key];
    if (!encrypted) return '';
    try {
      return decryptValue(encrypted);
    } catch {
      console.error(`[SecureStore] Failed to decrypt key: ${key}`);
      return '';
    }
  },

  getJSON<T>(key: SecureKey): T | null {
    const raw = this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },

  set(key: SecureKey, value: string): void {
    const data = readSecureFile();
    data[key] = encryptValue(value);
    writeSecureFile(data);
  },

  setJSON(key: SecureKey, value: unknown): void {
    this.set(key, JSON.stringify(value));
  },

  delete(key: SecureKey): void {
    const data = readSecureFile();
    delete data[key];
    writeSecureFile(data);
  },

  has(key: SecureKey): boolean {
    const data = readSecureFile();
    return key in data;
  },
};

// ─── Settings Store (plain, no encryption) ───

export interface SettingsSchema {
  tenantId: string;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  defaultBrands: string;
  transcriptionDuration: number;
  showHiddenShows: boolean;
  videoSeekBuffer: number;
  webUserId: number;
  labelPrinter: string;
  clvTiers: {
    platinum: { minSpent: number; minOrders: number };
    gold: { minSpent: number; minOrders: number };
    silver: { minSpent: number; minOrders: number };
    bronze: { minSpent: number; minOrders: number };
  };
  costTemplates: Array<{
    id: number;
    name: string;
    type: 'percent' | 'flat' | 'minus';
    value: number;
  }>;
  labelTemplate: {
    labelSize: '1x1' | '2x1' | '2.25x1.25';
    itemNumber: { enabled: boolean; fontSize: number };
    buyerUsername: { enabled: boolean; fontSize: number };
    barcode: { enabled: boolean };
    price: { enabled: boolean; fontSize: number };
    fontFamily: 'Arial' | 'Courier New' | 'Helvetica' | 'Times New Roman' | 'Verdana';
  };
  shippoTestMode: boolean;
  shippoLabelFormat: string;
  shippoSenderName: string;
  shippoSenderCompany: string;
  shippoSenderStreet1: string;
  shippoSenderStreet2: string;
  shippoSenderCity: string;
  shippoSenderState: string;
  shippoSenderZip: string;
  shippoSenderCountry: string;
  shippoSenderPhone: string;
  shippoSenderEmail: string;
}

export const settingsStore = new Store<SettingsSchema>({
  name: 'settings',
  defaults: {
    tenantId: '',
    dbHost: '',
    dbPort: 5432,
    dbName: 'sellerfolio',
    dbUser: 'postgres',
    defaultBrands: '',
    transcriptionDuration: 45,
    showHiddenShows: false,
    videoSeekBuffer: 30,
    webUserId: 1,
    labelPrinter: '',
    clvTiers: {
      platinum: { minSpent: 1000, minOrders: 15 },
      gold: { minSpent: 500, minOrders: 10 },
      silver: { minSpent: 200, minOrders: 5 },
      bronze: { minSpent: 50, minOrders: 2 },
    },
    costTemplates: [],
    labelTemplate: {
      labelSize: '1x1' as const,
      itemNumber: { enabled: true, fontSize: 20 },
      buyerUsername: { enabled: true, fontSize: 7 },
      barcode: { enabled: true },
      price: { enabled: false, fontSize: 8 },
      fontFamily: 'Arial' as const,
    },
    shippoTestMode: true,
    shippoLabelFormat: 'PDF_4x6',
    shippoSenderName: '',
    shippoSenderCompany: '',
    shippoSenderStreet1: '',
    shippoSenderStreet2: '',
    shippoSenderCity: '',
    shippoSenderState: '',
    shippoSenderZip: '',
    shippoSenderCountry: 'US',
    shippoSenderPhone: '',
    shippoSenderEmail: '',
  },
});

// ─── Unified API (backwards-compatible) ───

// The default export provides a unified get/set that routes to the correct store.
// This maintains backwards compatibility with existing `store.get('key')` calls.
const store = {
  get(key: string): any {
    if (isSecureKey(key)) return secureStore.get(key);
    return settingsStore.get(key as keyof SettingsSchema);
  },

  set(key: string, value: any): void {
    if (isSecureKey(key)) {
      secureStore.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    } else {
      settingsStore.set(key as keyof SettingsSchema, value);
    }
  },

  delete(key: string): void {
    if (isSecureKey(key)) {
      secureStore.delete(key);
    } else {
      settingsStore.delete(key as keyof SettingsSchema);
    }
  },

  has(key: string): boolean {
    if (isSecureKey(key)) return secureStore.has(key);
    return settingsStore.has(key as keyof SettingsSchema);
  },
};

export default store;
export { store };
```

- [ ] **Step 2: Add migration logic to main.ts**

In `desktop/electron/main.ts`, add a migration function and call it during app startup (after `app.whenReady()`). Find the existing store import and add the migration:

```typescript
import Store from 'electron-store';
import crypto from 'crypto';
import os from 'os';

/**
 * One-time migration from old encrypted electron-store to new two-tier storage.
 * Reads values from old store using legacy key derivation, writes them to new stores.
 */
function migrateFromLegacyStore(): void {
  const legacyStorePath = path.join(app.getPath('userData'), 'config.json');
  if (!fs.existsSync(legacyStorePath)) return;

  // Check if migration already happened (secure-store.json exists with data)
  const secureStorePath = path.join(app.getPath('userData'), 'secure-store.json');
  if (fs.existsSync(secureStorePath)) return;

  console.log('[Migration] Migrating from legacy encrypted store to two-tier storage...');

  try {
    // Read old store using legacy encryption key
    const machineId = `${os.hostname()}-${os.platform()}-${os.arch()}`;
    const appSalt = 'sellerfolio-2024';
    const legacyKey = crypto.createHash('sha256').update(`${machineId}-${appSalt}`).digest('hex').substring(0, 32);

    const legacyStore = new Store({ encryptionKey: legacyKey, name: 'config' });

    // Migrate each key to the appropriate new store
    const secureKeys = ['authToken', 'openaiKey', 'geminiKey', 'whatnotCookies',
      'middlewareUrl', 'middlewareToken', 'dbPassword', 'uspsConsumerKey',
      'uspsConsumerSecret', 'shippoApiToken'] as const;

    for (const key of secureKeys) {
      const value = legacyStore.get(key);
      if (value !== undefined && value !== '') {
        store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
    }

    // Settings keys go to settingsStore
    const settingsKeys = ['tenantId', 'dbHost', 'dbPort', 'dbName', 'dbUser',
      'defaultBrands', 'transcriptionDuration', 'showHiddenShows', 'videoSeekBuffer',
      'webUserId', 'labelPrinter', 'clvTiers', 'costTemplates', 'labelTemplate',
      'shippoTestMode', 'shippoLabelFormat', 'shippoSenderName', 'shippoSenderCompany',
      'shippoSenderStreet1', 'shippoSenderStreet2', 'shippoSenderCity', 'shippoSenderState',
      'shippoSenderZip', 'shippoSenderCountry', 'shippoSenderPhone', 'shippoSenderEmail'] as const;

    for (const key of settingsKeys) {
      const value = legacyStore.get(key);
      if (value !== undefined && value !== '') {
        store.set(key, value);
      }
    }

    console.log('[Migration] Legacy store migration complete');
  } catch (error) {
    console.error('[Migration] Failed to migrate legacy store:', error);
    // Non-fatal — user can re-enter settings
  }
}
```

Call `migrateFromLegacyStore()` early in the `app.whenReady()` handler, before any store reads.

- [ ] **Step 3: Update all store imports across the desktop codebase**

Search for all files that import from `'../lib/store'` or `'../../lib/store'` or `'./store'` in the desktop electron code. The unified `store` default export maintains the same `.get()` / `.set()` API, so most callers won't need code changes — just verify imports still resolve.

Run:
```bash
cd desktop && grep -r "from.*store" electron/ --include="*.ts" | grep -v node_modules | grep -v ".d.ts"
```

For each importing file, verify the import path and the keys used. The unified `store` API handles routing automatically, so `store.get('authToken')` will transparently use secureStore and `store.get('tenantId')` will use settingsStore.

- [ ] **Step 4: Handle the whatnotCookies special case**

The `whatnotCookies` key stores an array, not a string. The `saveCookies` function in `main.ts` calls `store.set('whatnotCookies', toSave)` where `toSave` is an array. The unified store's `set()` method handles this by JSON-stringifying non-string values for secure keys.

Verify cookie restore reads correctly: find where `store.get('whatnotCookies')` is called (around line 1600 in main.ts). If it returns a string (from JSON.stringify), update the read to parse it:

```typescript
// The unified store returns the encrypted string for secure keys.
// For whatnotCookies, use secureStore.getJSON() directly:
import { secureStore } from './lib/store';

const savedCookies = secureStore.getJSON<Array<{...}>>('whatnotCookies') ?? [];
```

- [ ] **Step 5: Verify the desktop builds**

Run:
```bash
cd desktop && npx tsc --noEmit
```

Fix any type errors from the store API changes.

- [ ] **Step 6: Commit**

```bash
git add desktop/electron/lib/store.ts desktop/electron/main.ts
git commit -m "feat: migrate Electron store to safeStorage for secret encryption

Split into secureStore (safeStorage-backed, OS keychain) for secrets and
settingsStore (plain) for preferences. Unified default export maintains
backwards-compatible get/set API. One-time migration from legacy store
runs on first launch."
```

---

### Task 8: Update Desktop-Led Sync Design Doc

**Files:**
- Modify: `docs/superpowers/specs/2026-03-27-desktop-led-sync-design.md:207-209,26`

- [ ] **Step 1: Update Scheduler Changes section**

In `docs/superpowers/specs/2026-03-27-desktop-led-sync-design.md`, replace lines 207-209:

```markdown
// Before:
```typescript
// On interval, broadcast to connected desktops
broadcastToAll('sync:request', { type: 'orders', force: false });
```

// After:
```typescript
// On interval, broadcast to each tenant's connected desktops
const tenantIds = getTenantsWithConnectedClients();
for (const tenantId of tenantIds) {
  broadcastToTenant(tenantId, 'sync:request', { type: 'orders', force: false });
}
```

Sync requests are scoped to tenant rooms — only desktops belonging to that tenant receive the event.
```

- [ ] **Step 2: Add session confirmation note to Data Flow sections**

In the "Data Flow — Scheduled Sync" section (around line 26), add after step 2:

```markdown
2. Broadcasts `sync:request` event via WebSocket to the tenant's room (not globally)
2a. Desktop does NOT proceed until middleware has confirmed session validity via `session:refreshed`
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-03-27-desktop-led-sync-design.md
git commit -m "docs: amend desktop-led sync design with tenant-scoped broadcasts

Update scheduler section to use broadcastToTenant instead of broadcastToAll.
Add session confirmation handshake note to data flow sections."
```

---

### Task 9: Final Verification

- [ ] **Step 1: Build all projects**

Run:
```bash
cd middleware && npx tsc --noEmit && echo "Middleware OK"
cd ../desktop && npx tsc --noEmit && echo "Desktop OK"
```

Expected: both projects compile without errors.

- [ ] **Step 2: Verify Prisma schema is valid**

Run:
```bash
cd middleware && npx prisma validate
```

Expected: "The schema at ... is valid."

- [ ] **Step 3: Verify no remaining references to old patterns**

Run these checks:
```bash
# Should find zero results (old unique constraint reference):
grep -r "userId_platform_tenantId" middleware/src/ --include="*.ts"

# Should find zero results (old global broadcast in scheduler):
grep "broadcastToAll" middleware/src/jobs/scheduler.ts

# Should find zero results (wrong localStorage key):
grep "auth_token" desktop/src/ -r --include="*.ts" --include="*.tsx"

# Should find "Date.now() + 30000" (not minus):
grep "Date.now()" desktop/src/contexts/AuthContext.tsx
```

- [ ] **Step 4: Commit any remaining fixes**

If any checks from step 3 reveal issues, fix them and commit.
