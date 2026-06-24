# Show-Picker Sync — Design

**Date:** 2026-06-24
**Status:** Approved (design); pending implementation plan
**Component:** `tiktok-live-poc` (Electron PoC — Order Ledger)

## Summary

Today, clicking **Sync** pulls the seller's *entire* TikTok order history in one shot
(`pullTiktokOrders`, paginated up to 400 pages) and then reconstructs "shows"
client-side by grouping orders on `live_room_id` and time-clustering the rest
(`deriveShowsFromOrders`). Shows therefore carry **date-derived titles**, never their
real stream names.

This feature changes Sync so it opens a **modal listing the seller's actual shows by
name** (from TikTok's `live_session/list` endpoint). The user picks a show and we sync
**only that show's orders**; a **Full sync** action inside the same modal preserves
today's pull-everything behavior. The real show names are also persisted and threaded
back into the existing show filter, so derived shows are titled with the real stream
name instead of a date.

## Goals

- Show the seller's real show names in a picker when they click Sync.
- Sync only the selected show's orders (scoped/faster), not the whole history.
- Keep a full-history sync available, surfaced inside the modal.
- Upgrade the existing ledger show-filter to display real show names.

## Non-goals

- Revenue/GMV per show in the picker. That figure lives only in the separate, signed
  `insights/creator/live/list` endpoint and cannot be reliably matched to a session
  (no room id in its payload), so it is intentionally excluded from v1.
- Server-side filtering of orders by show — the order API does not support it (see
  Constraints).
- Multi-show selection. One show per sync; Full sync covers "everything."

## Key findings that shape the design

Verified against captured HARs (`shop.tiktok.com-v2-Shows.har`,
`seller-us.tiktok.com*.har`) and the current code.

1. **The Shows list lives behind a signed endpoint.**
   `POST https://shop.tiktok.com/api/v1/streamer_desktop/live_session/list` returns the
   authoritative show list. Request body controls mode:
   - `{"search_type":1,…}` → counts only (`past_total`, `upcoming_total`).
   - `{"page_size":10,"cur_page":1,"search_type":2,"search_order":2,"with_reservations":true}`
     → the actual list.

   Each entry:
   ```jsonc
   {
     "id": "4389560838",                       // live-session id (short)
     "name": "Alo Yoga and More - Final Sale", // the show name
     "start_time": "1782167400", "during_time": "10800",
     "description": "...",
     "event_id": "7654248187959443469",        // 19-digit
     "live_room_infos": [                       // 0..n rooms
       { "room_id": "7654357221282777870", "start_time": "1782168993", "during_time": "6607" }
     ],
     "session_statistic": { "product_cnt": 2, "giveaway_cnt": 2, "coupon_cnt": 0 },
     "num_reservations": "15"
   }
   ```
   This endpoint is **signed** (X-Bogus / X-Gnarly / msToken in the HAR). Unlike the
   seller order endpoints (cookie-only), it cannot be called from the Electron main
   process with cookies alone — TikTok signs API requests in-page
   (`main.ts:33-37`).

2. **`live_room_infos[].room_id` is the same id orders carry as `live_room_id`.**
   Confirmed by cross-referencing: room ids from the Shows response appear verbatim in
   the seller order HARs as `"live_room_id":7649102219992369933` etc. Only
   `live_room_infos[].room_id` matches — the session `id` and `event_id` do not.

3. **A show can span multiple rooms.** `live_room_infos` is an array (a dropped/restarted
   stream produces several rooms in one session). Orders must be matched against *all* of
   a session's room ids.

4. **`order/list` carries no room id; only `order/get` does.** The list response
   (`fulfillment/na/order/list`) contains no `auction_module`/`live_room_id` at all;
   `live_room_id` appears only in the `order/get` detail response. So mapping an order to
   a show requires a detail call — there is no way to know an order's room from the list
   alone, and no server-side room filter (`order/list` filters only by
   `search_tab` / `order_status`).

## Constraints

- **Show list requires an in-page (signed) fetch**, not main-process cookies.
- **Scoped sync cannot be a server-side filter.** The only efficiency lever is
  **time-bounding** the `order/list` pull to the show's window, then detail-resolving and
  filtering that bounded slice.
- **Room-less orders** (cancelled / non-auction) never carry a `live_room_id`. A strict
  room match would drop them; the existing time-window attach in `deriveShowsFromOrders`
  must be reused so cancellations during a show aren't lost.
- **19-digit ids exceed 2^53** — must be quoted before `JSON.parse` (existing guard,
  `tiktok-orders.ts:267,322`).

## Architecture

Pure core (parsing/matching, unit-testable) + thin Electron edges (signed page capture,
order pull) + two IPC calls to the renderer.

### New / changed units

**`src/core/showList.ts`** *(new, pure — no Electron/DOM)*
- Parse a raw `live_session/list` payload → `ShowListing[]`:
  ```ts
  interface ShowListing {
    sessionId: string
    name: string
    startTime: number        // unix sec (session start)
    durationSec: number
    description?: string
    eventId: string
    roomIds: string[]        // live_room_infos[].room_id (0..n)
    productCnt?: number
    reservations?: number
  }
  ```
- `showWindow(s): { startMs, endMs }` — union of session + room windows; bounds the order pull.
- `roomNameMap(shows): Map<roomId, { sessionId, name, startMs }>` — lookup that upgrades
  date-titled derived shows to real names.

**`src/electron/tiktok-shows.ts`** *(new — signed fetch, "capture from page")*
- `fetchShowList(): Promise<{ shows: ShowListing[]; capped?: boolean; needsLogin?: boolean }>`
  1. If not logged in → `{ needsLogin: true }` and trigger `openSellerLogin()`.
  2. Ensure a `shop.tiktok.com` streamer page is loaded in the existing `persist:tiktok`
     partition (reuse/keep a hidden `webContents`; nudge it to the Shows view).
  3. Capture the page's own `live_session/list` response (response intercept).
  4. Probe an in-page `executeJavaScript` `fetch` for pages `2..n` when
     `past_total > pageSize`; if the page does not auto-sign, return what was captured
     with `capped: true` and `log()` the cap.
  5. Parse via `core/showList`.

**`src/electron/tiktok-orders.ts`** *(extend)*
- `pullTiktokOrdersSince(cookieHeader, sinceMs, onPage?)` — like `pullTiktokOrders` but
  early-stops paging once an order's `placedAt < sinceMs` (the caller passes
  `windowStart − BUFFER`). Reuses `fetchOrderDetails` to resolve `live_room_id` on the
  bounded slice.

**`src/electron/main.ts`** *(extend — IPC + orchestration)*
- `tt-shows-list` → `fetchShowList()`.
- `tt-sync-show` (args `{ roomIds: string[], startMs, endMs }`):
  1. `pullTiktokOrdersSince(cookie, startMs − BUFFER)`.
  2. `fetchOrderDetails` on the resulting ids → `live_room_id` per order.
  3. Keep an order if `roomId ∈ roomIds`, OR (`roomId` absent AND
     `placedAt ∈ [startMs − BUFFER, endMs + BUFFER]`).
  4. `upsertOrders(kept)`; persist the `roomId → name` map.
  5. Return `{ ok, count }`.
- `tt-sync` (full) unchanged — backs the modal's Full-sync row.

**`src/electron/db.ts`** *(extend)*
- Persist `roomId → { sessionId, name, startMs }` in the existing shows KV
  (`getShows`/`setShows`) so names survive restart and don't depend on re-opening the
  modal.

**`src/core/sessions.ts`** *(small extend)*
- `deriveShowsFromOrders` (or a thin wrapper) accepts an optional `roomNameMap` and titles
  a show with the real name when a room matches; otherwise keeps today's date title.
  Closes the loop on titling.

**`src/renderer/renderer.ts` + `index.html`** *(extend)*
- `runSync()` opens the modal instead of pulling immediately.
- Modal = **rich rows**: pinned "Full sync" row at top; shows newest-first, each with
  name + date/time + duration + stat chips, and a right-side status (`✓ N orders` when
  that room's orders are already local, else `Sync →`). Loading + degraded states.
- Pick a show → `tt-sync-show` → on success set `selectedShowId` to that show and
  recompute views. Full-sync row → `tt-sync`.

### Boundaries

`showList` is pure and fixture-testable. `tiktok-shows` isolates the one messy concern
(signed page capture) behind `Promise<ShowListing[]>`. The order pull stays in
`tiktok-orders`. The renderer knows only the two IPC calls.

## Data flows

### Flow A — open modal (fetch shows)
```
runSync() → open modal (loading) → IPC tt-shows-list
  main.fetchShowList():
    logged in? no → openSellerLogin(); {needsLogin:true}
    ensure shop.tiktok.com streamer page live in persist:tiktok
    capture page's live_session/list response
    probe in-page fetch for pages 2..n if past_total > pageSize
    parse via core/showList → ShowListing[]
    persist roomId→{sessionId,name,startMs}
  → render rows (most recent first) + Full-sync row
```
If capture yields nothing → `{shows:[], capped:true}`; modal shows only Full sync with a
note. Never hangs.

### Flow B — pick a show (scoped sync)
```
pick show s → IPC tt-sync-show { roomIds, startMs, endMs }
  main:
    cookieHeader (seller-us)
    pullTiktokOrdersSince(cookie, startMs − BUFFER)   // stop when placedAt < startMs − BUFFER
    fetchOrderDetails(thoseIds) → live_room_id per order
    keep if roomId ∈ s.roomIds
        OR (roomId absent AND placedAt ∈ [startMs − BUFFER, endMs + BUFFER])
    upsertOrders(kept); persist names
  → { ok, count } → set selectedShowId = s; recompute views
```
`BUFFER` (≈ a few hours) absorbs late payments and unpaid→paid lag.

### Merge semantics
Scoped sync **adds to** the order book via upsert (keyed by `externalOrderId`); it never
replaces. Syncing show A then show B grows "All orders." Re-syncing a show re-upserts the
same orders (no dupes). Re-opening the modal refreshes names.

## Error handling

- **Not logged in** → `{needsLogin:true}`; modal prompts login; reuse `openSellerLogin()`.
- **Shows fetch fails / not signed / page never fires** → `{shows:[], capped:true}`; modal
  shows Full-sync only. Graceful degradation to today's behavior.
- **Pagination cap** → show first page (most recent) + subtle "older shows not loaded";
  `log()` the cap. No silent truncation.
- **Scoped sync, zero matches** → `{ok:true, count:0}`; modal says "0 orders found for this
  show yet."
- **Session expiry mid-sync** → existing `code/HTTP 401` detection reopens login
  (`main.ts:341`).
- **Big ids** → reuse quote-before-parse guard.
- **Time-bound miss** → documented limitation (BUFFER + room-less-in-window attach
  mitigate), not a silent drop.

## Testing

- **`core/showList.ts`** (bulk of tests): parse a real `live_session/list` fixture →
  assert `ShowListing[]` (multi-room session, no-room session, description present/absent);
  `showWindow` math; `roomNameMap` covers every room.
- **`core/sessions.ts`**: a derived show with a matching room gets the real name; an
  unmatched room keeps the date title.
- **`electron/tiktok-orders.ts`**: `pullTiktokOrdersSince` early-stops at the window
  boundary (mock paged `fetch`); room filter + room-less-in-window attach keep the right
  orders.
- **`electron/tiktok-shows.ts`**: thin smoke test of the parse path; signed capture
  verified manually.
- **Manual QA**: open modal → real names appear → pick a show → only its orders sync →
  ledger show-filter shows the real title → Full sync still works.

## Open implementation risk

The single material risk is **Approach A's signed fetch**: whether the streamer page
reliably fires `live_session/list` (and whether in-page `fetch` auto-signs for
pagination). Probe early in implementation; fall back to Approach B (explicit in-page
fetch) if the page auto-signs, and degrade to Full-sync-only if neither works.
