# Live Monitor Fix Design

**Date:** 2026-03-30
**Status:** Approved
**Scope:** Desktop electron — API window, preload path, GraphQL fallback, WebSocket stability

## Problem

The desktop v2 Live Monitor doesn't work. Comparison with the working original app (`LuxeSense/app`) reveals 3 critical bugs and 1 stability issue.

## Fix 1: Create API Window (Critical)

### Current behavior

`live-stats.ts` and `overlay.ts` both expect an `apiWindowGetter` function that returns a BrowserWindow loaded with Whatnot's dashboard (providing `window.__APOLLO_CLIENT__`). But `main.ts` never creates this window and never passes the getter:

```typescript
// main.ts:1552-1553
registerOverlayHandlers();                        // no apiWindowGetter
registerLiveStatsHandlers(() => mainWindow);       // only mainWindowGetter
```

Every GraphQL call returns `"API window getter not set"`.

### Fix

**New file: `desktop/electron/lib/api-window.ts`**

Port `createApiWindow()` from `app/src/main.js:3187-3340`. This function:
1. Creates an off-screen BrowserWindow (`x: -10000, y: -10000`, `show: true`, `skipTaskbar: true`)
2. Loads `https://www.whatnot.com/dashboard/home`
3. Waits for DOM ready
4. Checks for `/login` redirect (session expired → returns null)
5. Waits 3s for Apollo client to initialize
6. Returns the window as a singleton (cached, reused across calls)
7. 90-second timeout for creation

Exports:
- `createApiWindow(): Promise<BrowserWindow | null>` — lazy singleton creation
- `getApiWindow(): BrowserWindow | null` — synchronous getter for current window (null if not created yet)
- `destroyApiWindow(): void` — cleanup

**Modify: `desktop/electron/main.ts`**

- Import `createApiWindow`, `getApiWindow` from `./lib/api-window`
- Call `createApiWindow()` in the `app.whenReady()` handler (after Whatnot cookie restoration, so the window has auth)
- Pass `getApiWindow` to both handlers:

```typescript
registerOverlayHandlers(getApiWindow);
registerLiveStatsHandlers(() => mainWindow, getApiWindow);
```

## Fix 2: Fix Preload Path (Critical)

### Current behavior

```typescript
// label-generator.ts:702
preload: path.join(__dirname, 'whatnot-monitor-preload.js')
```

`__dirname` resolves to the `ipc/` directory in compiled output. The preload file lives at `electron/whatnot-monitor-preload.ts` (one level up). The preload never loads, so the injected WebSocket listener can't communicate sale events back to the main process.

### Fix

```typescript
preload: path.join(__dirname, '..', 'whatnot-monitor-preload.js')
```

## Fix 3: GraphQL Fetch Fallback (Critical)

### Current behavior

Both `live-stats.ts:56-57` and `overlay.ts:114-115` use:
```typescript
window.__APOLLO_CLIENT__.gql`${query}`
```

Whatnot's Apollo client may not expose a `.gql` tagged template function. The working app has a fallback to raw `fetch()` — the desktop v2 does not.

### Fix

In both `live-stats.ts` and `overlay.ts`, replace the `executeJavaScript` block with a two-stage approach matching the working app:

1. Try Apollo client with `gql` tag
2. If that fails, fall back to `fetch('/services/graphql/', { method: 'POST', credentials: 'include', ... })`

The fallback fetch works because the API window is loaded on `whatnot.com` — browser cookies are sent automatically with `credentials: 'include'`.

## Fix 4: WebSocket Reconnect Stability

### Current behavior

The injected listener script in `label-generator.ts` reconnects on WebSocket close with:
- Fixed 1s delay on close, 3s delay on error
- No max retry limit (retries forever)
- No exponential backoff
- No detection of silent disconnects (server stops sending but connection stays open)

The working app has the same logic, which is why it also disconnects frequently.

### Fix

Modify the `generateListenerScript()` function in `label-generator.ts`:

**Exponential backoff:**
```javascript
let reconnectAttempt = 0;
const MAX_RECONNECT = 10;
const getBackoff = () => Math.min(1000 * Math.pow(2, reconnectAttempt), 30000);
```

**On close/error:**
```javascript
socket.onclose = () => {
  clearInterval(heartbeat);
  clearInterval(watchdog);
  if (reconnectEnabled && reconnectAttempt < MAX_RECONNECT) {
    isReconnecting = true;
    const delay = getBackoff();
    log('Reconnecting in ' + delay + 'ms (attempt ' + (reconnectAttempt + 1) + '/' + MAX_RECONNECT + ')');
    reconnectAttempt++;
    setTimeout(connect, delay);
  } else if (reconnectAttempt >= MAX_RECONNECT) {
    log('Max reconnect attempts reached');
    sendStatus('disconnected');
  }
};
```

**Reset on successful connection:**
```javascript
socket.onopen = async () => {
  reconnectAttempt = 0;  // Reset on success
  // ... rest of onopen
};
```

**Silent disconnect watchdog:**
```javascript
let lastMessageTime = Date.now();
let watchdog;

// In onmessage:
lastMessageTime = Date.now();

// After onopen:
watchdog = setInterval(() => {
  if (Date.now() - lastMessageTime > 30000) {
    log('No messages for 30s — forcing reconnect');
    socket.close();
  }
}, 10000);
```

The watchdog checks every 10 seconds. If no messages (including heartbeat replies) arrive for 30 seconds, it forces a reconnect. Since heartbeats are sent every 3 seconds, replies should arrive at least that often — 30s of silence means the connection is dead.

## Files Modified

| File | Fix |
|------|-----|
| `desktop/electron/lib/api-window.ts` (new) | #1 — API window singleton |
| `desktop/electron/main.ts` | #1 — create API window, pass to handlers |
| `desktop/electron/ipc/label-generator.ts:702` | #2 — preload path |
| `desktop/electron/ipc/label-generator.ts` (generateListenerScript) | #4 — reconnect stability |
| `desktop/electron/ipc/live-stats.ts` | #3 — fetch fallback |
| `desktop/electron/ipc/overlay.ts` | #3 — fetch fallback |

## Out of Scope

- Live auctions database (desktop v2 uses web API instead of direct DB)
- OBS overlay HTML/CSS/JS (unchanged)
- Stats polling intervals (already correct at 30s)
- Sale event forwarding (already correct once preload loads)
