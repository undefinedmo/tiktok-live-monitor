# Whatnot Session Health: Pre-flight Validation & Self-Healing

**Date:** 2026-03-26
**Status:** Approved
**Scope:** Middleware sync worker, Desktop electron main process, Desktop Layout UI

## Problem

Whatnot access tokens expire silently. The middleware discovers this only after a sync job runs to completion with bad tokens (e.g., 422 failed GraphQL calls for messages). The user has no advance warning and must manually re-login via the desktop app. There is no proactive detection, no self-healing, and no persistent visual indicator of session health.

## Solution

Pre-flight token validation before every sync job, with an automated refresh handshake between middleware and desktop, and a persistent UI indicator so the user always knows session state at a glance.

## Architecture

### 1. Pre-flight Token Validation (Middleware)

Before the sync worker executes any job, it validates the stored cookies with a single lightweight GraphQL query: `GetMe { me { id } }`.

**Token valid:** Proceed with sync as normal.

**Token invalid (401):**
1. Emit `session:needs-refresh` via WebSocket to the desktop.
2. Wait up to 20 seconds for the desktop to re-register fresh cookies.
3. Re-validate with the same test query.
4. If valid now, proceed with sync.
5. If still invalid, mark job as `failed` with reason "Session expired", emit `session:expired`.

This replaces the current behavior where syncs run to completion with bad tokens then detect the failure after the fact.

**Location:** `middleware/src/jobs/workers/syncWorker.ts` — add `validateSession(tenantId)` call at the top of the job processing switch, before any sync type case.

**Test query:** Reuse `verifyWhatnotSession()` logic already in `middleware/src/whatnot/client.ts` or add a dedicated `validateToken(cookies)` function that makes the `GetMe` call and returns `{ valid: boolean }`.

### 2. Self-Healing Flow (Desktop <-> Middleware)

When the desktop receives `session:needs-refresh` via WebSocket:

1. Open a hidden `BrowserWindow` to `https://www.whatnot.com/` (reuse existing `attemptSilentWhatnotLogin()`).
2. Wait up to 15 seconds for `__Secure-access-token` cookie to appear.
3. If token appears, re-register cookies with middleware via `POST /api/auth/register-cookies`.
4. Middleware receives fresh cookies, emits `session:refreshed` back to desktop.
5. Desktop updates UI to green/connected state.

If silent login fails (cookies truly expired, Whatnot requires captcha/2FA):
1. The middleware's 20-second wait times out.
2. Middleware marks the sync job as failed, emits `session:expired`.
3. Desktop shows the alert banner with "Login required" and a one-click "Reconnect" button.
4. User clicks the button, visible login window opens (existing `openWhatnotLoginWindow()` flow).

**Key change from current behavior:** The middleware actively requests fresh cookies when it needs them, rather than the desktop passively re-registering every 30 seconds. The 30-second polling continues as a background safety net but is no longer the primary refresh mechanism.

**Location (desktop):**
- `electron/main.ts` — listen for `session:needs-refresh` in the middleware WebSocket handler, call `attemptSilentWhatnotLogin()`, then re-register cookies.
- `src/components/Layout.tsx` — listen for the new event, update `sessionHealth` state.
- `src/lib/middlewareSocket.ts` — add `session:needs-refresh` and `session:refreshed` event types.

### 3. Persistent Status Indicator (Sidebar)

A small colored dot next to the Sync icon in the sidebar, always visible even when the sidebar is collapsed.

**States:**
| Dot Color | Meaning | Triggered By |
|-----------|---------|-------------|
| Green | Session valid | `session:refreshed`, successful sync, cookie registration success |
| Yellow (pulsing) | Reconnecting | `session:needs-refresh` received |
| Red | Manual login needed | `session:expired`, self-healing failed |

The dot is driven by a `sessionHealth` state: `'connected' | 'reconnecting' | 'expired'`. This state is updated purely by WebSocket events — no additional polling.

**Location:** `src/components/Layout.tsx` — add `sessionHealth` state alongside the existing `whatnotAuth` state. Render the dot as a small `<span>` with conditional Tailwind classes next to the sync button icon.

### 4. Alert Banner

A thin, persistent bar at the top of the main content area. Not a toast (toasts auto-dismiss). Behavior:

- **Shows** when `sessionHealth` is `'expired'`.
- **Content:** "Login required" text + "Reconnect" button.
- **Auto-dismisses** when `sessionHealth` transitions back to `'connected'`.
- **Does NOT show** during `'reconnecting'` state — only after self-healing has failed.

In the happy path (silent login succeeds), the user never sees the banner. They may briefly see the dot go yellow then back to green.

**Location:** `src/components/Layout.tsx` — render a conditional `<div>` above `<Outlet />` when `sessionHealth === 'expired'`.

## Data Flow

```
Middleware starts sync job
  -> validateToken(cookies)
  -> 401? Emit "session:needs-refresh" via WebSocket
       -> Desktop receives event
       -> attemptSilentWhatnotLogin()
       -> Success? POST /api/auth/register-cookies
            -> Middleware gets fresh cookies
            -> Re-validate -> pass -> run sync
            -> Emit "session:refreshed"
       -> Fail? 20s timeout
            -> Middleware marks job failed
            -> Emit "session:expired"
            -> Desktop shows banner
```

## Files to Modify

| File | Change |
|------|--------|
| `middleware/src/jobs/workers/syncWorker.ts` | Add pre-flight `validateToken()` call before sync switch |
| `middleware/src/whatnot/client.ts` | Add `validateToken(cookies)` function |
| `middleware/src/websocket/hub.ts` | Add `session:needs-refresh` and `session:refreshed` event types |
| `desktop/electron/main.ts` | Handle `session:needs-refresh` from middleware socket |
| `desktop/src/lib/middlewareSocket.ts` | Add new event types |
| `desktop/src/components/Layout.tsx` | Add `sessionHealth` state, status dot, alert banner |

## Out of Scope

- Token expiration tracking (Approach C from brainstorm) — can be layered on later.
- Heartbeat polling (Approach A) — unnecessary with pre-flight checks.
- Detailed error messages to user — user preference is minimal ("Login required" + button).
- Changes to the Sync Center page — this design only affects the sidebar/banner and middleware internals.
