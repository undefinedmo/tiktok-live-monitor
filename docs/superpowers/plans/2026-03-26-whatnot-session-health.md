# Whatnot Session Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pre-flight token validation before every sync job, with automated self-healing between middleware and desktop, plus a persistent session health indicator and alert banner in the desktop UI.

**Architecture:** The middleware validates tokens before starting sync jobs. On failure, it asks the desktop to refresh cookies via WebSocket, waits for re-registration, then retries. The desktop UI shows a persistent colored dot for session state and an alert banner when manual login is needed.

**Tech Stack:** TypeScript, Socket.io (WebSocket), Electron IPC, React, Tailwind CSS

---

### Task 1: Add `session:needs-refresh` Event Type (Middleware)

**Files:**
- Modify: `middleware/src/websocket/events.ts:59-62`
- Modify: `middleware/src/websocket/broadcaster.ts:149-158`

- [ ] **Step 1: Add the new event to ServerToClientEvents**

In `middleware/src/websocket/events.ts`, add `session:needs-refresh` to the session events block (after line 61):

```typescript
  // Session events
  'session:expiring': (data: { expiresIn: number }) => void;
  'session:expired': (data: { reason?: string }) => void;
  'session:needs-refresh': (data: { reason: string }) => void;
  'session:refreshed': (data: { expiresAt: string }) => void;
```

- [ ] **Step 2: Add broadcaster helper**

In `middleware/src/websocket/broadcaster.ts`, add after line 151:

```typescript
/**
 * Request tenant clients to refresh their Whatnot session cookies
 */
export function requestSessionRefresh(tenantId: string, reason: string): void {
  broadcastToTenant(tenantId, 'session:needs-refresh', { reason });
}
```

- [ ] **Step 3: Commit**

```bash
git add middleware/src/websocket/events.ts middleware/src/websocket/broadcaster.ts
git commit -m "feat: add session:needs-refresh WebSocket event type"
```

---

### Task 2: Add `validateToken` Function (Middleware)

**Files:**
- Modify: `middleware/src/whatnot/client.ts`
- Modify: `middleware/src/auth/cookieStore.ts` (import only)

- [ ] **Step 1: Add validateToken function**

In `middleware/src/whatnot/client.ts`, add after the `executePaginatedGraphQL` function (after line ~214):

```typescript
/**
 * Validate a set of cookies by making a lightweight GetMe query.
 * Returns true if the token is valid, false if expired/invalid.
 */
export async function validateToken(cookies: StoredCookie[]): Promise<boolean> {
  const query = `query GetMe { me { id } }`;
  const result = await executeGraphQL<{ me?: { id: string } }>(
    query,
    {},
    'GetMe',
    cookies
  );

  // If we got errors (401, invalid token), the token is bad
  if (result.errors && result.errors.length > 0) {
    logger.warn({ errors: result.errors.map(e => e.message) }, 'Token validation failed');
    return false;
  }

  // If we got a user ID back, the token is valid
  return !!result.data?.me?.id;
}
```

- [ ] **Step 2: Commit**

```bash
git add middleware/src/whatnot/client.ts
git commit -m "feat: add validateToken function for pre-flight checks"
```

---

### Task 3: Add Pre-flight Validation to Sync Worker (Middleware)

**Files:**
- Modify: `middleware/src/jobs/workers/syncWorker.ts`

- [ ] **Step 1: Add imports**

In `middleware/src/jobs/workers/syncWorker.ts`, update the imports at lines 7-8:

```typescript
import { broadcastToTenant, notifySessionExpired, requestSessionRefresh } from '../../websocket/broadcaster.js';
import { invalidateSession, getCookies } from '../../auth/cookieStore.js';
```

Add a new import for validateToken:

```typescript
import { validateToken } from '../../whatnot/client.js';
```

- [ ] **Step 2: Add pre-flight validation function**

Add after the `checkAndHandleAuthFailure` function (after line 34):

```typescript
/**
 * Pre-flight: validate the Whatnot token before running a sync.
 * If invalid, request refresh from desktop and wait up to 20s for new cookies.
 * Returns true if we have a valid token (proceed with sync), false otherwise.
 */
async function preflightTokenCheck(tenantId: string): Promise<boolean> {
  const cookieData = await getCookies(tenantId);
  if (!cookieData) {
    logger.warn({ tenantId }, 'Pre-flight: no cookies found');
    return false;
  }

  // First check: is the current token valid?
  const valid = await validateToken(cookieData.cookies);
  if (valid) {
    logger.debug({ tenantId }, 'Pre-flight: token valid');
    return true;
  }

  // Token is bad — ask the desktop to refresh
  logger.info({ tenantId }, 'Pre-flight: token invalid, requesting refresh from desktop');
  requestSessionRefresh(tenantId, 'Token failed pre-flight validation');

  // Wait up to 20s for the desktop to re-register cookies, checking every 2s
  const maxWait = 20_000;
  const interval = 2_000;
  let elapsed = 0;

  while (elapsed < maxWait) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    elapsed += interval;

    const freshCookies = await getCookies(tenantId);
    if (!freshCookies) continue;

    // Check if the cookie hash changed (fresh registration)
    const recheck = await validateToken(freshCookies.cookies);
    if (recheck) {
      logger.info({ tenantId, waitedMs: elapsed }, 'Pre-flight: token refreshed successfully');
      return true;
    }
  }

  logger.warn({ tenantId }, 'Pre-flight: token refresh timed out after 20s');
  return false;
}
```

- [ ] **Step 3: Insert pre-flight check into processSyncJob**

In `processSyncJob`, add the pre-flight check after the progress broadcast at line 78 and before the `switch (type)` at line 80:

```typescript
    // Update progress
    await updateProgress(10, `Starting ${type} sync...`);

    // Pre-flight: validate token before running sync
    const tokenValid = await preflightTokenCheck(tenantId);
    if (!tokenValid) {
      logger.warn({ tenantId, type }, 'Pre-flight token check failed — aborting sync');
      await invalidateSession(tenantId);
      notifySessionExpired(tenantId, 'Token invalid and refresh failed');
      const duration = Date.now() - startTime;
      await updateJobStatus(jobId, {
        status: 'failed',
        completedAt: new Date(),
        error: 'Session expired — please log in to Whatnot',
        result: { type, success: false, counts: {}, errors: ['Session expired'], duration },
      });
      broadcastToTenant(tenantId, 'sync:failed', {
        type,
        jobId,
        error: 'Session expired — please log in to Whatnot',
      });
      return { type, success: false, counts: {}, errors: ['Session expired'], duration };
    }

    switch (type) {
```

- [ ] **Step 4: Commit**

```bash
git add middleware/src/jobs/workers/syncWorker.ts
git commit -m "feat: add pre-flight token validation before sync jobs"
```

---

### Task 4: Handle `session:needs-refresh` on Desktop (Socket + Main Process)

**Files:**
- Modify: `desktop/src/lib/middlewareSocket.ts`
- Modify: `desktop/electron/main.ts`
- Modify: `desktop/electron/preload.ts`

- [ ] **Step 1: Add event listener in middlewareSocket.ts**

In `desktop/src/lib/middlewareSocket.ts`, add a new callback set and export function alongside the existing `onSessionExpired` pattern. After the `sessionExpiredListeners` declarations (around line 10):

```typescript
type SessionNeedsRefreshCallback = (data: { reason: string }) => void;
const sessionNeedsRefreshListeners = new Set<SessionNeedsRefreshCallback>();

export function onSessionNeedsRefresh(callback: SessionNeedsRefreshCallback): () => void {
  sessionNeedsRefreshListeners.add(callback);
  return () => { sessionNeedsRefreshListeners.delete(callback); };
}
```

In the `connectToMiddleware` function, after the `session:expired` listener (around line 55), add:

```typescript
    socket.on('session:needs-refresh' as any, (data: { reason: string }) => {
      console.log('[Middleware] Session needs refresh:', data.reason);
      for (const cb of sessionNeedsRefreshListeners) {
        try { cb(data); } catch { /* ignore listener errors */ }
      }
    });
```

- [ ] **Step 2: Add IPC handler for refresh request in main.ts**

In `desktop/electron/main.ts`, add a function that handles the refresh flow. Add after the `attemptSilentWhatnotLogin` function:

```typescript
/**
 * Handle a session refresh request from the middleware.
 * Performs a silent login and re-registers cookies with the web app.
 */
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
```

- [ ] **Step 3: Expose IPC handler**

In `desktop/electron/main.ts`, add near the other whatnot IPC handlers (after the `silent-whatnot-login` handler):

```typescript
  ipcMain.handle('handle-session-refresh', async () => {
    return await handleSessionRefreshRequest();
  });
```

- [ ] **Step 4: Expose in preload**

In `desktop/electron/preload.ts`, add to the whatnotAPI object (after `silentLogin`):

```typescript
  handleSessionRefresh: () => ipcRenderer.invoke('handle-session-refresh') as Promise<boolean>,
  onForceRegisterCookies: (callback: (data: { cookies: unknown[] }) => void) => {
    const handler = (_event: unknown, data: { cookies: unknown[] }) => callback(data);
    ipcRenderer.on('force-register-cookies', handler);
    return () => ipcRenderer.removeListener('force-register-cookies', handler);
  },
```

Add to the type declaration in the same file:

```typescript
      handleSessionRefresh: () => Promise<boolean>;
      onForceRegisterCookies: (callback: (data: { cookies: unknown[] }) => void) => () => void;
```

- [ ] **Step 5: Commit**

```bash
git add desktop/src/lib/middlewareSocket.ts desktop/electron/main.ts desktop/electron/preload.ts
git commit -m "feat: handle session:needs-refresh from middleware with silent login"
```

---

### Task 5: Wire Desktop Layout to Handle Refresh Requests and Register Cookies

**Files:**
- Modify: `desktop/src/components/Layout.tsx`

- [ ] **Step 1: Add sessionHealth state**

In `Layout.tsx`, replace the existing `whatnotAuth` state (line 124) with:

```typescript
  const [whatnotAuth, setWhatnotAuth] = useState<{ checked: boolean; authenticated: boolean }>({ checked: false, authenticated: false });
  const [sessionHealth, setSessionHealth] = useState<'connected' | 'reconnecting' | 'expired'>('connected');
```

- [ ] **Step 2: Add session:needs-refresh listener**

Import `onSessionNeedsRefresh` alongside `onSessionExpired`:

```typescript
import { onSessionExpired, onSessionNeedsRefresh } from '../lib/middlewareSocket';
```

Replace the existing `session:expired` useEffect (lines 193-218) with a combined handler:

```typescript
  // Handle session:needs-refresh from middleware — silent self-healing
  useEffect(() => {
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

    const unsubExpired = onSessionExpired(async (data) => {
      console.warn('[Layout] Whatnot session expired:', data.reason);
      setSessionHealth('expired');
      setWhatnotAuth({ checked: true, authenticated: false });
    });

    return () => { unsubRefresh(); unsubExpired(); };
  }, []);

  // Listen for force-register-cookies from main process (after silent refresh)
  useEffect(() => {
    if (!window.whatnotAPI?.onForceRegisterCookies) return;
    const cleanup = window.whatnotAPI.onForceRegisterCookies(async () => {
      // Re-register cookies with the web app which forwards to middleware
      await registerWhatnotCookies();
    });
    return cleanup;
  }, [registerWhatnotCookies]);
```

- [ ] **Step 3: Update auth status listener to set sessionHealth**

Update the existing `onAuthStatus` useEffect to also update `sessionHealth`:

```typescript
  useEffect(() => {
    if (!window.whatnotAPI?.onAuthStatus) return;
    const cleanup = window.whatnotAPI.onAuthStatus((data: { connected: boolean; reason?: string; message?: string }) => {
      if (data.connected) {
        setSessionHealth('connected');
        setWhatnotAuth({ checked: true, authenticated: true });
        registerWhatnotCookies();
      } else if (data.reason === 'reconnecting') {
        setSessionHealth('reconnecting');
      } else {
        setWhatnotAuth({ checked: true, authenticated: false });
        // Don't override sessionHealth here — let the dedicated handlers manage it
      }
    });
    return cleanup;
  }, [registerWhatnotCookies]);
```

- [ ] **Step 4: Commit**

```bash
git add desktop/src/components/Layout.tsx
git commit -m "feat: wire Layout to session:needs-refresh with self-healing flow"
```

---

### Task 6: Add Persistent Session Health Dot (Desktop UI)

**Files:**
- Modify: `desktop/src/components/Layout.tsx`

- [ ] **Step 1: Update the sync button status dot**

Find the sync button area where the status class is computed (`getSyncStatusClass` function). Replace it to incorporate `sessionHealth`:

```typescript
  const getSyncStatusClass = () => {
    if (isRunning) return 'syncing';
    if (syncStatus === 'error') return 'error';
    if (sessionHealth === 'expired') return 'error';
    if (sessionHealth === 'reconnecting') return 'syncing';
    if (whatnotAuth.authenticated) return 'connected';
    if (whatnotAuth.checked && !whatnotAuth.authenticated) return 'warning';
    return 'disabled';
  };
```

- [ ] **Step 2: Update the status text in the sync dropdown header**

Find the status text that renders in the dropdown header (the `<span>` that shows "Syncing...", "Ready", "Login Required"). Replace with:

```typescript
                    {isRunning
                      ? `Syncing ${currentType ? (syncTypeLabels[currentType] || currentType) : ''}...`
                      : sessionHealth === 'reconnecting' ? 'Reconnecting...'
                      : sessionHealth === 'expired' ? 'Login Required'
                      : whatnotAuth.authenticated ? 'Ready'
                      : 'Login Required'}
```

- [ ] **Step 3: Update the Whatnot Session badge in the dropdown**

Find the session status badge. Replace the condition to use `sessionHealth`:

```typescript
                    {whatnotAuth.checked && (
                      <span className={cn(
                        'text-xs px-1.5 py-0.5 rounded flex items-center gap-1',
                        sessionHealth === 'connected' && whatnotAuth.authenticated
                          ? 'bg-success/20 text-success'
                          : sessionHealth === 'reconnecting'
                            ? 'bg-accent/20 text-accent'
                            : 'bg-warning/20 text-warning'
                      )}>
                        {sessionHealth === 'connected' && whatnotAuth.authenticated ? (
                          <>
                            <CheckCircle2 className="w-3 h-3" />
                            Connected
                          </>
                        ) : sessionHealth === 'reconnecting' ? (
                          <>
                            <RefreshCw className="w-3 h-3 animate-spin" />
                            Reconnecting...
                          </>
                        ) : (
                          <>
                            <XCircle className="w-3 h-3" />
                            Not logged in
                          </>
                        )}
                      </span>
                    )}
```

- [ ] **Step 4: Commit**

```bash
git add desktop/src/components/Layout.tsx
git commit -m "feat: persistent session health dot driven by sessionHealth state"
```

---

### Task 7: Add Alert Banner (Desktop UI)

**Files:**
- Modify: `desktop/src/components/Layout.tsx`

- [ ] **Step 1: Add the alert banner above Outlet**

Find the `<Outlet />` render (around line 720, inside the `<main>` section). Add the banner just before it:

```typescript
              {/* Session expired banner */}
              {sessionHealth === 'expired' && (
                <div className="mx-4 mt-2 mb-0 px-4 py-2.5 bg-warning/10 border border-warning/30 rounded-lg flex items-center justify-between">
                  <span className="text-sm text-warning font-medium">
                    Login required
                  </span>
                  <button
                    onClick={handleWhatnotLogin}
                    disabled={whatnotLoggingIn}
                    className="flex items-center gap-1.5 px-3 py-1 text-sm font-medium bg-warning/20 text-warning hover:bg-warning/30 rounded transition-colors disabled:opacity-50"
                  >
                    <LogIn className="w-3.5 h-3.5" />
                    Reconnect
                  </button>
                </div>
              )}
              <Outlet />
```

- [ ] **Step 2: Update handleWhatnotLogin to reset sessionHealth on success**

Find the `handleWhatnotLogin` function. After a successful login, set `sessionHealth` to `'connected'`:

```typescript
  const handleWhatnotLogin = async () => {
    setWhatnotLoggingIn(true);
    try {
      const result = await window.whatnotAPI.openLogin();
      if (result?.success) {
        setWhatnotAuth({ checked: true, authenticated: true });
        setSessionHealth('connected');
        await registerWhatnotCookies();
      }
    } catch (err) {
      console.error('[Layout] Whatnot login error:', err);
    } finally {
      setWhatnotLoggingIn(false);
    }
  };
```

- [ ] **Step 3: Commit**

```bash
git add desktop/src/components/Layout.tsx
git commit -m "feat: add session expired alert banner with one-click reconnect"
```

---

### Task 8: Clean Up Old Redundant Code

**Files:**
- Modify: `desktop/src/components/Layout.tsx`

- [ ] **Step 1: Remove the `reconnecting` field from whatnotAuth**

The `reconnecting` state is now handled by `sessionHealth`. Remove `reconnecting?: boolean` from the `whatnotAuth` state type and all references to `whatnotAuth.reconnecting` in the component. The `sessionHealth` state replaces this entirely.

- [ ] **Step 2: Remove redundant session:expired handler that opens sync dropdown**

The old handler at lines 193-218 that called `setSyncDropdownOpen(true)` on session expiry is replaced by the new combined handler from Task 5. The banner is now the prompt mechanism, not the dropdown.

- [ ] **Step 3: Verify no broken references**

Search for `whatnotAuth.reconnecting` in the file and remove any remaining references. All reconnecting UI should reference `sessionHealth === 'reconnecting'` instead.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/components/Layout.tsx
git commit -m "refactor: remove redundant reconnecting state, use sessionHealth"
```

---

### Task 9: Integration Test — Manual Verification

- [ ] **Step 1: Start middleware**

```bash
cd sellerfolio-platform/middleware && npm run dev
```

Verify: starts without errors, scheduler runs.

- [ ] **Step 2: Start desktop app**

```bash
cd sellerfolio-platform/desktop && npm run dev
```

Verify: app loads, sync button shows green dot and "Ready" when connected.

- [ ] **Step 3: Test happy path — trigger a sync**

Click Sync >> Shows. Verify:
- Toast shows "Syncing Shows..."
- Status shows "Syncing Shows..." with accent color
- On completion: toast shows "Shows synced successfully"
- Dot stays green

- [ ] **Step 4: Test pre-flight failure with self-healing**

To simulate: temporarily invalidate the session in the middleware DB, then trigger a sync. Verify:
- Dot turns yellow ("Reconnecting...")
- Middleware logs: "Pre-flight: token invalid, requesting refresh from desktop"
- Desktop performs silent login
- Middleware logs: "Pre-flight: token refreshed successfully"
- Sync proceeds
- Dot returns to green

- [ ] **Step 5: Test expired session with banner**

To simulate: close the Whatnot login in Electron (clear Whatnot cookies), then trigger a sync. Verify:
- Dot turns yellow briefly, then red
- Alert banner appears: "Login required" with "Reconnect" button
- Click "Reconnect" — login window opens
- After login: banner disappears, dot turns green
