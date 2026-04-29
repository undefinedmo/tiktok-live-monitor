# Sync & Session Hardening Design

**Date:** 2026-03-30
**Status:** Approved
**Scope:** Middleware session model, scheduler, desktop auth/cookie handling, Electron store security
**Relation:** Supplements approved desktop-led sync design (2026-03-27) and session health design (2026-03-26). Fixes gaps not covered by either.

## Problem

A code review identified seven issues across the sync and session layers. Some are bugs in code that the desktop-led sync migration will delete (tokenRefresher, syncWorker, cookieStore middleware usage). Those are out of scope here — they die with the migration.

The remaining seven issues exist in code that survives the migration and need targeted fixes now:

1. Session model allows multiple active sessions per tenant; reads pick arbitrarily by recency
2. Scheduler broadcasts sync requests to all tenants globally
3. Silent login marks session recovery successful before middleware confirms
4. Cookie restoration on desktop restart drops sameSite and defaults httpOnly to false
5. Token expiry check gives 30s grace after expiry instead of expiring 30s early
6. 401 handler clears wrong localStorage key (`auth_token` vs `authToken`)
7. Electron store encryption uses predictable machine-derived key

## Assumption

**Single Whatnot user per tenant.** The platform does not support multiple Whatnot accounts connected to the same tenant. This assumption simplifies fix #1 significantly. If multi-user tenants become a requirement, the session model will need a more invasive redesign (threading userId through all read paths).

## Fix 1: Session Model — One Session Per Tenant

### Current behavior

Schema: `@@unique([userId, platform, tenantId])`
Reads: `findFirst({ where: { tenantId, isValid: true }, orderBy: { lastUsed: 'desc' } })`

This allows multiple valid sessions per tenant (from different users). Reads return whichever was used most recently, which can drift between users.

### Changes

**`middleware/prisma/schema.prisma` — WhatnotSession model:**
- Replace `@@unique([userId, platform, tenantId])` with `@@unique([tenantId, platform])`
- The `userId` column stays for record-keeping but is no longer part of the uniqueness constraint
- This enforces at the DB level: one session per tenant per platform

**`middleware/src/auth/cookieStore.ts` — `storeCookies()`:**
- Change upsert `where` clause from `{ userId_platform_tenantId }` to `{ tenantId_platform }`
- Before upserting, invalidate any other valid sessions for this tenant: `updateMany({ where: { tenantId, isValid: true, id: { not: existingId } }, data: { isValid: false } })`

**`middleware/src/lib/resolveUserId.ts`:**
- Add a comment documenting the single-user-per-tenant assumption
- No logic change — `findFirst by tenantId` is correct under this assumption

**Migration:** Generate Prisma migration to update the unique constraint. Existing data: if any tenant has multiple sessions, keep the most recently used one, invalidate the rest.

## Fix 2: Scheduler Tenant Scoping

### Current behavior

```typescript
broadcastToAll('sync:request', { type: 'orders', force: false });
```

Every connected desktop across all tenants receives every sync request.

### Changes

**`middleware/src/websocket/broadcaster.ts`:**
- Add `getTenantsWithConnectedClients(): Promise<string[]>` — queries Socket.io rooms or the `ConnectedClient` table for distinct tenantIds with at least one active connection.

**`middleware/src/jobs/scheduler.ts`:**
- Replace `broadcastToAll` with:

```typescript
async function scheduleOrderSyncs(): Promise<void> {
  const tenantIds = await getTenantsWithConnectedClients();
  for (const tenantId of tenantIds) {
    broadcastToTenant(tenantId, 'sync:request', { type: 'orders', force: false });
  }
}
```

- Same pattern for messages, shipments, shows.

## Fix 3: Session Recovery Confirmation Handshake

### Current behavior

Silent login detects `__Secure-access-token` in local cookie jar → calls `finish(true)` → UI sets `sessionHealth: 'connected'`. No confirmation that middleware accepted the cookies.

### Changes

**`desktop/electron/main.ts` — silent login flow:**

After detecting access token locally:
1. POST cookies to middleware (`/api/auth/register-cookies`)
2. Wait for the POST response (success/failure)
3. Only call `finish(true)` if the POST succeeds
4. If POST fails or times out (15s), call `finish(false)` — shorter than middleware's 20s wait window from session health design

```typescript
// Before
if (authState.accessToken) {
  await finish(true); // optimistic
}

// After
if (authState.accessToken) {
  try {
    await registerCookiesWithMiddleware(); // POST + wait
    await finish(true); // confirmed
  } catch {
    await finish(false); // registration failed
  }
}
```

**`desktop/src/components/Layout.tsx`:**
- Don't set `sessionHealth: 'connected'` on local token detection
- Only transition to `'connected'` on `session:refreshed` event from middleware
- Stay in `'reconnecting'` during the gap between local detection and middleware confirmation

**`middleware/src/websocket/broadcaster.ts` and cookie registration endpoint:**
- Verify `notifySessionRefreshed(tenantId, expiresAt)` is called after successful cookie registration
- The session health design doc specifies this event, but it was found to be defined without being emitted — ensure the registration endpoint actually calls it

## Fix 4: Cookie Restoration — Restore All Attributes

### Current behavior

```typescript
// Saving (correct — captures all attributes)
const toSave = cookies.map((c) => ({
  ...
  httpOnly: c.httpOnly,
  sameSite: c.sameSite,
}));

// Restoring (lossy)
await ses.cookies.set({
  ...
  httpOnly: cookie.httpOnly ?? false,  // wrong default
  // sameSite not restored
});
```

### Changes

**`desktop/electron/main.ts` — cookie restoration (~line 1617):**

```typescript
await ses.cookies.set({
  url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`,
  name: cookie.name,
  value: cookie.value,
  domain: cookie.domain,
  path: cookie.path || '/',
  secure: cookie.secure ?? true,
  httpOnly: cookie.httpOnly ?? true,              // changed: safe default
  sameSite: cookie.sameSite ?? 'no_restriction',  // added: was missing
  expirationDate: cookie.expirationDate || now + 365 * 24 * 60 * 60,
});
```

`httpOnly` defaults to `true` (Whatnot auth cookies are httpOnly). `sameSite` defaults to `'no_restriction'` (Electron's equivalent of `SameSite=None`, which matches Whatnot's cross-site cookies).

## Fix 5: Token Expiry Buffer

### Current behavior

```typescript
// AuthContext.tsx
return payload.exp * 1000 < Date.now() - 30000;
// Reads as: "expired more than 30 seconds ago" — gives grace AFTER expiry
```

### Change

```typescript
return payload.exp * 1000 < Date.now() + 30000;
// Reads as: "will expire within 30 seconds" — triggers refresh BEFORE expiry
```

## Fix 6: localStorage Key Mismatch

### Current behavior

```typescript
// apiClient.ts — 401 handler
localStorage.removeItem('auth_token');   // snake_case — wrong

// AuthContext.tsx — everywhere else
localStorage.getItem('authToken');       // camelCase — correct
localStorage.setItem('authToken', ...);
```

### Change

```typescript
// apiClient.ts — 401 handler
localStorage.removeItem('authToken');    // match the key used everywhere else
```

## Fix 7: Migrate to safeStorage

### Current behavior

```typescript
function deriveEncryptionKey(): string {
  const machineId = `${os.hostname()}-${os.platform()}-${os.arch()}`;
  const appSalt = 'sellerfolio-2024';
  return crypto.createHash('sha256')
    .update(`${machineId}-${appSalt}`)
    .digest('hex').substring(0, 32);
}
```

All values discoverable. Any local process can reconstruct the key and decrypt the store.

### Changes

**`desktop/electron/lib/store.ts` — rewrite:**

Split into two stores:

**`secureStore`** — for secrets (authToken, Whatnot cookies, API keys):
- Uses `safeStorage.encryptString()` / `safeStorage.decryptString()`
- Stored as base64-encoded encrypted buffers in a plain JSON file
- Provides typed `get(key)` / `set(key, value)` / `delete(key)` API
- Location: `app.getPath('userData')/secure-store.json`

**`settingsStore`** — for non-secret preferences (window bounds, UI state):
- Plain `electron-store`, no encryption
- Same API as current store for non-sensitive fields

**Sensitive fields (move to secureStore):**
- `authToken`
- `openaiKey`, `geminiKey`
- `whatnotCookies`
- `middlewareUrl`, `middlewareToken`

**Non-sensitive fields (stay in settingsStore):**
- `tenantId`
- Window bounds, UI preferences, feature flags

**Migration logic (runs once on app startup):**
1. Check if old encrypted store exists and new `secure-store.json` does not
2. Read all values from old store using the old `deriveEncryptionKey()`
3. Write sensitive values to new secureStore via `safeStorage`
4. Write non-sensitive values to new settingsStore
5. Delete old store file

**Fallback:** If `safeStorage.isEncryptionAvailable()` returns false (headless Linux without a keyring), fall back to the current derivation method with a startup warning logged.

**Callers:** All imports of the current store need updating. Grep for `import.*store` in the desktop electron code and update to use the appropriate store.

## Design Doc Amendments

### `2026-03-27-desktop-led-sync-design.md`

**Scheduler Changes section (~line 207):** Replace:
```typescript
broadcastToAll('sync:request', { type: 'orders', force: false });
```

With description of per-tenant broadcast loop using `broadcastToTenant`.

**Data Flow — Scheduled Sync section (~line 26):** Add step between 2 and 3: "Middleware broadcasts to each tenant's room individually (not globally)."

**Data Flow — both sections:** Add note that desktop waits for middleware confirmation after cookie registration before proceeding, per Fix 3.

## Files Modified

| File | Fixes |
|------|-------|
| `middleware/prisma/schema.prisma` | #1 |
| `middleware/src/auth/cookieStore.ts` | #1 |
| `middleware/src/lib/resolveUserId.ts` | #1 |
| `middleware/src/websocket/broadcaster.ts` | #2, #3 |
| `middleware/src/jobs/scheduler.ts` | #2 |
| `desktop/electron/main.ts` | #3, #4 |
| `desktop/src/components/Layout.tsx` | #3 |
| `desktop/src/contexts/AuthContext.tsx` | #5 |
| `desktop/src/lib/apiClient.ts` | #6 |
| `desktop/electron/lib/store.ts` | #7 (rewrite) |
| `docs/superpowers/specs/2026-03-27-desktop-led-sync-design.md` | amendments |

## Out of Scope

- Removing old middleware sync code (syncWorker, tokenRefresher, BullMQ) — handled by desktop-led sync migration Phase 3
- Multi-user-per-tenant session model — not a current requirement
- Web middleware auth consolidation (Low finding) — workable as-is, can be addressed separately
- Whatnot API fragility (cookie parsing, GraphQL scraping) — inherent to the platform, not fixable in this pass
