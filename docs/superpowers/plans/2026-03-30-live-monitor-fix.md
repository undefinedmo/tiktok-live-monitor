# Live Monitor Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the desktop v2 Live Monitor by creating the missing API window, fixing the preload path, adding GraphQL fetch fallback, and improving WebSocket reconnect stability.

**Architecture:** Port the off-screen BrowserWindow pattern from the working app into a new `api-window.ts` module. Fix the preload path so sale detection works. Replace the brittle Apollo `.gql` call with the working app's fallback chain. Add exponential backoff and a silent-disconnect watchdog to the WebSocket listener.

**Tech Stack:** Electron (BrowserWindow, session), TypeScript, WebSocket (Phoenix channels), GraphQL

**Spec:** `docs/superpowers/specs/2026-03-30-live-monitor-fix-design.md`

---

### Task 1: Create API Window Module

**Files:**
- Create: `desktop/electron/lib/api-window.ts`

- [ ] **Step 1: Create the api-window.ts file**

Create `desktop/electron/lib/api-window.ts` with the following content. This is ported from `app/src/main.js:3187-3340`, adapted to TypeScript:

```typescript
import { BrowserWindow, session } from 'electron';
import path from 'path';

let apiWindow: BrowserWindow | null = null;
let apiWindowReady = false;
let apiWindowPromise: Promise<BrowserWindow | null> | null = null;

/**
 * Create (or reuse) an off-screen BrowserWindow loaded with Whatnot's dashboard.
 * This window provides window.__APOLLO_CLIENT__ for GraphQL queries and
 * authenticated fetch() for fallback queries.
 *
 * Singleton — only one API window exists at a time.
 */
export async function createApiWindow(): Promise<BrowserWindow | null> {
  // Already have a ready window
  if (apiWindow && !apiWindow.isDestroyed() && apiWindowReady) {
    return apiWindow;
  }

  // Creation already in progress — wait for it
  if (apiWindowPromise) {
    return apiWindowPromise;
  }

  apiWindowPromise = new Promise<BrowserWindow | null>((resolve) => {
    apiWindowReady = false;
    let resolved = false;
    const finish = (win: BrowserWindow | null) => {
      if (resolved) return;
      resolved = true;
      apiWindowPromise = null;
      resolve(win);
    };

    console.log('[ApiWindow] Creating off-screen API window...');

    const newWindow = new BrowserWindow({
      width: 800,
      height: 600,
      x: -10000,
      y: -10000,
      show: true,          // Prevent Chromium throttling
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
      paintWhenInitiallyHidden: true,
    });

    apiWindow = newWindow;

    newWindow.loadURL('https://www.whatnot.com/dashboard/home');

    const timeout = setTimeout(() => {
      if (!resolved) {
        console.log('[ApiWindow] Creation timed out (90s) — using window as-is');
        apiWindowReady = true;
        finish(newWindow.isDestroyed() ? null : newWindow);
      }
    }, 90000);

    newWindow.webContents.once('dom-ready', () => {
      if (resolved) return;
      if (newWindow.isDestroyed()) {
        clearTimeout(timeout);
        finish(null);
        return;
      }

      const url = newWindow.webContents.getURL();
      console.log('[ApiWindow] dom-ready:', url);

      // Session expired — redirected to login
      if (url.includes('/login') || url.includes('/signin')) {
        console.log('[ApiWindow] Redirected to login — session expired');
        clearTimeout(timeout);
        newWindow.close();
        apiWindow = null;
        apiWindowReady = false;
        finish(null);
        return;
      }

      // Wait 3 seconds for Apollo client to initialize after DOM ready
      setTimeout(() => {
        if (resolved) return;
        if (newWindow.isDestroyed()) {
          clearTimeout(timeout);
          finish(null);
          return;
        }
        console.log('[ApiWindow] Ready');
        clearTimeout(timeout);
        apiWindowReady = true;
        finish(newWindow);
      }, 3000);
    });

    newWindow.on('closed', () => {
      if (apiWindow === newWindow) {
        apiWindow = null;
        apiWindowReady = false;
      }
    });
  });

  return apiWindowPromise;
}

/**
 * Synchronous getter for the current API window.
 * Returns null if not created yet or destroyed.
 */
export function getApiWindow(): BrowserWindow | null {
  if (apiWindow && !apiWindow.isDestroyed()) return apiWindow;
  return null;
}

/**
 * Destroy the API window and clean up.
 */
export function destroyApiWindow(): void {
  if (apiWindow && !apiWindow.isDestroyed()) {
    apiWindow.close();
  }
  apiWindow = null;
  apiWindowReady = false;
  apiWindowPromise = null;
}
```

- [ ] **Step 2: Verify the file compiles**

Run:
```bash
cd desktop && npx tsc --noEmit 2>&1 | grep api-window
```

Expected: no errors from api-window.ts.

- [ ] **Step 3: Commit**

```bash
git add desktop/electron/lib/api-window.ts
git commit -m "feat: add API window module for Whatnot GraphQL queries

Off-screen BrowserWindow that loads Whatnot dashboard, providing
window.__APOLLO_CLIENT__ and authenticated fetch() for GraphQL.
Ported from working app's createApiWindow()."
```

---

### Task 2: Wire API Window into main.ts

**Files:**
- Modify: `desktop/electron/main.ts:29,1552-1553`

- [ ] **Step 1: Add imports**

In `desktop/electron/main.ts`, add the import after the existing IPC handler imports (around line 32):

```typescript
import { createApiWindow, getApiWindow, destroyApiWindow } from './lib/api-window';
```

- [ ] **Step 2: Create API window during startup**

Find the cookie restoration section in `app.whenReady()` (the `migrateFromLegacyStore()` call is around line 1722). After cookie restoration completes and before the IPC handler registrations (line 1548), add:

```typescript
  // Create off-screen API window for Whatnot GraphQL queries
  // Must run after cookie restoration so the window has auth
  createApiWindow().then((win) => {
    if (win) {
      console.log('[App] API window ready for GraphQL queries');
    } else {
      console.warn('[App] API window creation failed — live monitor/overlay will not work until Whatnot login');
    }
  });
```

- [ ] **Step 3: Pass apiWindowGetter to IPC handlers**

Change lines 1552-1553 from:

```typescript
  registerOverlayHandlers();
  registerLiveStatsHandlers(() => mainWindow);
```

To:

```typescript
  registerOverlayHandlers(getApiWindow);
  registerLiveStatsHandlers(() => mainWindow, getApiWindow);
```

- [ ] **Step 4: Clean up on app quit**

Find the `app.on('window-all-closed'` or `app.on('before-quit'` handler. Add `destroyApiWindow()` to cleanup:

```typescript
app.on('before-quit', () => {
  destroyApiWindow();
});
```

If no `before-quit` handler exists, add one.

- [ ] **Step 5: Verify build**

Run:
```bash
cd desktop && npx tsc --noEmit 2>&1 | grep -E "main\.ts|api-window"
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add desktop/electron/main.ts
git commit -m "fix: wire API window to live stats and overlay handlers

Create API window during startup after cookie restoration.
Pass getApiWindow to registerLiveStatsHandlers and registerOverlayHandlers
so GraphQL queries have a browser context to execute in."
```

---

### Task 3: Fix Preload Path for Monitor Window

**Files:**
- Modify: `desktop/electron/ipc/label-generator.ts:702`

- [ ] **Step 1: Fix the preload path**

In `desktop/electron/ipc/label-generator.ts`, find line 702:

```typescript
          preload: path.join(__dirname, 'whatnot-monitor-preload.js')
```

Change to:

```typescript
          preload: path.join(__dirname, '..', 'whatnot-monitor-preload.js')
```

The preload file is at `desktop/electron/whatnot-monitor-preload.ts`, but `__dirname` inside `ipc/label-generator.ts` resolves to the `ipc/` subdirectory. Going up one level (`..`) reaches the correct location.

- [ ] **Step 2: Verify the preload file exists at the expected location**

Run:
```bash
ls -la "desktop/electron/whatnot-monitor-preload.ts"
```

Expected: file exists.

- [ ] **Step 3: Commit**

```bash
git add desktop/electron/ipc/label-generator.ts
git commit -m "fix: correct preload path for Whatnot monitor window

Preload was referencing __dirname (ipc/) but the file lives one level up
at electron/whatnot-monitor-preload.ts. Sale detection was silently broken
because the preload bridge never loaded."
```

---

### Task 4: Add GraphQL Fetch Fallback

**Files:**
- Modify: `desktop/electron/ipc/live-stats.ts:48-66` (executeGraphQLViaWindow)
- Modify: `desktop/electron/ipc/overlay.ts:107-124` (fetchBinItemsViaApollo)

- [ ] **Step 1: Replace executeGraphQLViaWindow in live-stats.ts**

In `desktop/electron/ipc/live-stats.ts`, replace lines 48-66 (the `executeJavaScript` block inside `executeGraphQLViaWindow`) with the working app's fallback chain:

```typescript
    // Execute via Apollo client with fetch fallback
    const result = await apiWindow.webContents.executeJavaScript(`
      (async () => {
        try {
          const client = window.__APOLLO_CLIENT__;
          if (!client) {
            // No Apollo — fall back to fetch
            throw new Error('no-apollo');
          }

          const queryString = ${JSON.stringify(query)};
          const variables = ${JSON.stringify(variables)};
          const operationName = ${JSON.stringify(operationName)};

          // Try to find gql parser in window scope (Whatnot bundles it)
          let queryDoc;
          if (window.gql) {
            queryDoc = window.gql(queryString);
          } else if (window.__gql) {
            queryDoc = window.__gql(queryString);
          } else {
            // gql not available — fall back to fetch
            throw new Error('no-gql');
          }

          const result = await client.query({
            query: queryDoc,
            variables: variables,
            fetchPolicy: 'network-only',
            errorPolicy: 'all'
          });

          return { data: result.data, errors: result.errors };
        } catch (apolloError) {
          // Fallback: direct fetch with browser cookies
          try {
            const queryString = ${JSON.stringify(query)};
            const variables = ${JSON.stringify(variables)};
            const operationName = ${JSON.stringify(operationName)};

            const response = await fetch(
              '/services/graphql/?operationName=' + encodeURIComponent(operationName) + '&ssr=0',
              {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'Content-Type': 'application/json',
                  'Accept': 'application/json',
                },
                body: JSON.stringify({
                  operationName: operationName,
                  query: queryString,
                  variables: variables
                })
              }
            );

            if (!response.ok) {
              return { error: 'HTTP ' + response.status };
            }
            return await response.json();
          } catch (fetchError) {
            return { error: fetchError.message };
          }
        }
      })()
    `);

    return result;
```

This replaces the old block that was:
```typescript
    const result = await apiWindow.webContents.executeJavaScript(`
      (async () => {
        const query = ${JSON.stringify(query)};
        ...
            query: window.__APOLLO_CLIENT__.gql\`\${query}\`,
        ...
      })()
    `);

    return result;
```

- [ ] **Step 2: Replace fetchBinItemsViaApollo GraphQL block in overlay.ts**

In `desktop/electron/ipc/overlay.ts`, replace lines 107-124 (the `executeJavaScript` block inside `fetchBinItemsViaApollo`) with the same fallback pattern:

```typescript
    // Execute the GraphQL query via Apollo client with fetch fallback
    const result = await apiWindow.webContents.executeJavaScript(`
      (async () => {
        try {
          const client = window.__APOLLO_CLIENT__;
          if (!client) throw new Error('no-apollo');

          const queryString = ${JSON.stringify(query)};
          const variables = ${JSON.stringify({ livestreamId })};

          let queryDoc;
          if (window.gql) {
            queryDoc = window.gql(queryString);
          } else if (window.__gql) {
            queryDoc = window.__gql(queryString);
          } else {
            throw new Error('no-gql');
          }

          const result = await client.query({
            query: queryDoc,
            variables: variables,
            fetchPolicy: 'network-only',
            errorPolicy: 'all'
          });

          return { data: result.data, errors: result.errors };
        } catch (apolloError) {
          try {
            const queryString = ${JSON.stringify(query)};
            const variables = ${JSON.stringify({ livestreamId })};

            const response = await fetch(
              '/services/graphql/?operationName=LivestreamShop&ssr=0',
              {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'Content-Type': 'application/json',
                  'Accept': 'application/json',
                },
                body: JSON.stringify({
                  operationName: 'LivestreamShop',
                  query: queryString,
                  variables: variables
                })
              }
            );

            if (!response.ok) {
              return { error: 'HTTP ' + response.status };
            }
            return await response.json();
          } catch (fetchError) {
            return { error: fetchError.message };
          }
        }
      })()
    `);

    return result;
```

- [ ] **Step 3: Verify build**

Run:
```bash
cd desktop && npx tsc --noEmit 2>&1 | grep -E "live-stats|overlay"
```

Expected: no errors from our changed files.

- [ ] **Step 4: Commit**

```bash
git add desktop/electron/ipc/live-stats.ts desktop/electron/ipc/overlay.ts
git commit -m "fix: add fetch() fallback for GraphQL queries in live stats and overlay

Apollo's gql tag may not be available on Whatnot's bundled client.
Now tries Apollo with gql/window.gql first, falls back to raw fetch()
with credentials: 'include' (browser sends cookies automatically).
Matches the working app's fallback chain."
```

---

### Task 5: WebSocket Reconnect Stability

**Files:**
- Modify: `desktop/electron/ipc/label-generator.ts` (generateListenerScript function, lines 313-468)

- [ ] **Step 1: Add reconnect state variables**

In `desktop/electron/ipc/label-generator.ts`, inside `generateListenerScript()`, find the variable declarations near the top of the IIFE (around lines 55-65). After the existing declarations, the generated script should include reconnect tracking. Find:

```typescript
    let isReconnecting = false;
```

Replace with:

```typescript
    let isReconnecting = false;
    let reconnectAttempt = 0;
    const MAX_RECONNECT = 10;
    const getBackoff = () => Math.min(1000 * Math.pow(2, reconnectAttempt), 30000);
    let lastMessageTime = Date.now();
    let watchdog;
```

- [ ] **Step 2: Add message timestamp tracking in onmessage**

Find the `socket.onmessage` handler (around line 348). Add `lastMessageTime = Date.now();` as the first line inside it:

```typescript
        socket.onmessage = async (e) => {
          lastMessageTime = Date.now();
          try {
```

- [ ] **Step 3: Reset reconnect counter and start watchdog in onopen**

Find `socket.onopen` (around line 334). Add reconnect reset and watchdog after the existing code:

```typescript
        socket.onopen = async () => {
          reconnectAttempt = 0;
          lastMessageTime = Date.now();
          log('Connected to Whatnot auction socket');
          sendStatus('connected');
          send('commerce:' + LIVESTREAM_ID, 'phx_join', { token: sessionData.session_extension_token });

          clearInterval(heartbeat);
          heartbeat = setInterval(() => send('phoenix', 'heartbeat', {}), 3000);

          clearInterval(watchdog);
          watchdog = setInterval(() => {
            if (Date.now() - lastMessageTime > 30000) {
              log('No messages for 30s — forcing reconnect');
              socket.close();
            }
          }, 10000);

          if (isReconnecting) {
            await backfillSales();
            isReconnecting = false;
          }
        };
```

- [ ] **Step 4: Replace onclose with exponential backoff**

Find `socket.onclose` (around line 449). Replace:

```typescript
        socket.onclose = () => {
          log('Disconnected from auction socket');
          sendStatus('disconnected');
          clearInterval(heartbeat);
          if (reconnectEnabled) {
            isReconnecting = true;
            setTimeout(connect, 1000);
          }
        };

        socket.onerror = () => socket.close();
```

With:

```typescript
        socket.onclose = () => {
          clearInterval(heartbeat);
          clearInterval(watchdog);
          if (reconnectEnabled && reconnectAttempt < MAX_RECONNECT) {
            isReconnecting = true;
            const delay = getBackoff();
            log('Reconnecting in ' + (delay / 1000) + 's (attempt ' + (reconnectAttempt + 1) + '/' + MAX_RECONNECT + ')');
            sendStatus('reconnecting');
            reconnectAttempt++;
            setTimeout(connect, delay);
          } else if (reconnectAttempt >= MAX_RECONNECT) {
            log('Max reconnect attempts reached (' + MAX_RECONNECT + ')');
            sendStatus('disconnected');
          } else {
            log('Disconnected (reconnect disabled)');
            sendStatus('disconnected');
          }
        };

        socket.onerror = () => socket.close();
```

- [ ] **Step 5: Clean up watchdog in stop function**

Find the `window.stopSellerFolioListener` function (around line 477). Add `clearInterval(watchdog)`:

```typescript
    window.stopSellerFolioListener = () => {
      reconnectEnabled = false;
      clearInterval(heartbeat);
      clearInterval(watchdog);
      clearInterval(pollingInterval);
      if (socket) socket.close();
      window.__sellerfolioLabelListenerActive = false;
      log('Stopped');
      sendStatus('stopped');
    };
```

- [ ] **Step 6: Verify build**

Run:
```bash
cd desktop && npx tsc --noEmit 2>&1 | grep label-generator
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add desktop/electron/ipc/label-generator.ts
git commit -m "fix: add exponential backoff and silent disconnect watchdog to WebSocket

Reconnect now uses exponential backoff (1s -> 30s cap) with max 10 attempts.
Added 30-second watchdog that detects silent disconnects (no messages received,
including heartbeat replies) and forces reconnect. Counter resets on success."
```

---

### Task 6: Final Verification

- [ ] **Step 1: Build the desktop project**

Run:
```bash
cd desktop && npx tsc --noEmit 2>&1 | grep -E "api-window|main\.ts|label-generator|live-stats|overlay"
```

Expected: no errors from any changed files.

- [ ] **Step 2: Verify API window module exports**

Run:
```bash
grep -n "export" desktop/electron/lib/api-window.ts
```

Expected: `createApiWindow`, `getApiWindow`, `destroyApiWindow` all exported.

- [ ] **Step 3: Verify preload path**

Run:
```bash
grep "whatnot-monitor-preload" desktop/electron/ipc/label-generator.ts
```

Expected: `path.join(__dirname, '..', 'whatnot-monitor-preload.js')`

- [ ] **Step 4: Verify no remaining .gql usage**

Run:
```bash
grep -n "\.gql\`" desktop/electron/ipc/live-stats.ts desktop/electron/ipc/overlay.ts
```

Expected: no matches (old `.gql\`` pattern removed, replaced with `window.gql()` function call).

- [ ] **Step 5: Verify getApiWindow is passed to handlers**

Run:
```bash
grep "registerOverlayHandlers\|registerLiveStatsHandlers" desktop/electron/main.ts
```

Expected: both calls include `getApiWindow` as argument.
