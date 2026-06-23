# Room-ID Show Capture + Filter-by-Show — Design

**Date:** 2026-06-23
**Target system:** `tiktok-live-poc` (Electron main + portable `core/` + renderer)
**Status:** Approved design, pending implementation plan
**Reference implementation:** `LuxeSense/live-ledger` (`server/src/tiktok.ts`, `sessions.ts`, `shows-rebuild.ts`, `web/src/components/ShowSelect.tsx`)

---

## 1. Problem & context

The synced order book (historical orders pulled from Seller-Center `order/list`) needs to be **grouped into the real LIVE shows they belong to**, and the Ledger / Picklist must let the user **filter by show**. Today the PoC groups synced orders by a fragile *text tag* instead of the stable LIVE room id, so the filter is unreliable.

`live-ledger` already solved this. We are porting its approach into the PoC.

### How `live-ledger` captures the show (verified against its code)

Two-tier strategy, both keyed on the **TikTok LIVE room id**:

1. **Authoritative key — `live_room_id`** (`server/src/tiktok.ts`): read from the `order/get` detail call at `auction_module.live_room_id` (a 19-digit id, quoted before `JSON.parse` so V8 doesn't round it past 2^53). Stored as `Show.externalShowId` — *"the real TikTok LIVE room the order belongs to (stable show key)."* `order/list` can also filter `condition_list.live_room_id` to pull exactly one show.
2. **Fallback — time-gap clustering** (`sessions.ts` + `shows-rebuild.ts`): orders without a room id are clustered into sessions by a **2.5h gap** (`SESSION_GAP_MS`); each cluster becomes a derived, date-titled show (`deriveTitle` → `LIVE · <date>`), keyed idempotently on the session-start second (`derivedShowId` → `live-<startSec>`). A cluster that already contains a known show keeps its title.

Its filter UI (`ShowSelect.tsx`) labels each show with *date · item-count · duration*.

### Current state of the PoC (verified against the code)

- `tiktok-orders.ts` **already extracts `roomId`** from `auction_module.live_room_id` on both `order/list` (`mapTiktokOrder`, `:164`) and `order/get` (`fetchOrderDetails`, `:334`).
- `db.ts` **already stores `room_id`** as an `orders` column (`:25`, `:91`).
- **Gap 1:** the renderer groups by text — `SHOW_OF(s) = s.liveTag || 'Other orders'` (`renderer.ts:715`). Orders without that `sales_source_live_tag` text collapse into one "Other orders" bucket; the room id is ignored.
- **Gap 2:** `roomId` is **not on the `Sale` type** (`core/types.ts`), so it never reaches the renderer in `sale_json` — the renderer literally cannot group by it.
- **Gap 3:** there is **no time-gap fallback** for orders missing a room id.

### Decisions taken during brainstorming

| Decision | Choice |
|---|---|
| Live monitor vs synced shows | **Keep separate.** The live monitor keeps its own `current_session`-keyed "Live (current)" entry; synced orders group by room id independently. No live-session ↔ room-id mapping. |
| Show label/title | **Date/time-derived** (`LIVE · <date>, <time>`). *(Brainstorming chose "liveTag text else date"; revised 2026-06-23 after reviewing the live dropdown — the real `sales_source_live_tag` is generic boilerplate ("Order contains one or more items from LIVE streams by …"), identical per show, so the date/time title is the scannable one.)* |
| Persistence | **In-memory derivation at render time.** Orders already store `room_id`; no new `Show` table. |
| Where the code lives | **Graduate `tiktok-live-poc` in place** (consistent with the order-data-foundation spec). |

### Scope

**In scope:**
- Expose `roomId` on `Sale`; populate it through `orderToSale`; overlay the existing `room_id` DB column onto hydrated sales for pre-change rows.
- A pure `core/sessions.ts` (port of `clusterByTime` / `derivedShowId` / `deriveTitle`).
- A pure `deriveShowsFromOrders(sales)` that groups by room id with a time-gap fallback and computes per-show metadata + an order→show map.
- Rewire the synced-orders branch of the Ledger/Picklist show filter to use the derivation.

**Out of scope:** unifying the live monitor's `current_session` show with room-keyed shows; a persisted `Show` table; `order/list` server-side `live_room_id` filtering; any change to the live-capture `showStore` path (`core/shows.ts`).

---

## 2. Goals & success criteria

1. **Room id is the show key.** A synced order with a `live_room_id` is grouped under that room, not its `liveTag` text. Two orders sharing a room id land in the same show even if their text tags differ or are absent.
2. **Graceful fallback.** Orders with no room id are time-gap clustered (2.5h) into date-titled fallback shows — none silently lumped into a single "Other orders" bucket.
3. **Backward compatible.** Orders synced before this change (whose `sale_json` lacks `roomId` but whose `room_id` column is populated) still group correctly, with no forced re-sync.
4. **Filter works on both surfaces.** The Ledger and Picklist show pickers list the derived shows (labeled *title · date · n items · duration*) plus an "All orders" option, and selecting one filters the rows. The two pickers stay in sync (existing `onShowChange`).
5. **Live monitor untouched.** The real-time monitor's `currentShow` / `showStore` capture and its "Live (current)" entry behave exactly as today.
6. **All tests green** (`npm test`), including new `sessions` and `deriveShowsFromOrders` specs. Existing `shows.test.ts` still passes.

---

## 3. Architecture & components

### 3.1 `Sale.roomId` — data model (`src/core/types.ts`)

Add one optional field:

```ts
roomId?: string  // live_room_id — the stable TikTok LIVE room key (groups orders into a real show)
```

### 3.2 Capture (`src/electron/tiktok-orders.ts`, `src/electron/db.ts`)

- `orderToSale(o)` sets `roomId: o.roomId ?? undefined` so it persists in `sale_json` on every new sync.
- `getSnapshot` (`db.ts`) overlays the `room_id` column onto each hydrated `Sale` when the parsed JSON lacks `roomId` — i.e. `SELECT sale_json, room_id …` and `roomId ??= room_id`. This makes pre-change rows group correctly without re-syncing.

### 3.3 `core/sessions.ts` — pure clustering (new; port of live-ledger)

```ts
export const SESSION_GAP_MS = 2.5 * 60 * 60 * 1000
export interface ClusterItem { id: string; t: number }      // t = epoch ms
export interface Session { startMs: number; endMs: number; ids: string[] }
export function clusterByTime(items: ClusterItem[], gapMs?: number): Session[]
export function derivedShowId(startMs: number): string       // `live-${floor(startMs/1000)}`
export function deriveTitle(startMs: number): string          // `LIVE · <date>`
```

`deriveTitle` uses `toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' })`. Timezone handling from live-ledger (`orgTimeZone`, `retitleAllShows`) is **omitted** — the PoC is single-tenant/local and has no org settings; the local zone is correct.

### 3.4 `deriveShowsFromOrders` — pure derivation (new; in `core/sessions.ts`, so `core/shows.ts` stays untouched)

```ts
export interface DerivedShow {
  id: string        // roomId, or `live-<sec>` for a fallback cluster
  title: string     // group's liveTag text if present, else deriveTitle(startMs)
  startMs: number   // min createdAt in the group
  endMs: number     // max createdAt in the group
  count: number     // number of orders
}
export function deriveShowsFromOrders(sales: Sale[]): {
  shows: DerivedShow[]                  // sorted by startMs desc (most recent first)
  showIdByOrder: Map<string, string>    // orderId → show id
}
```

Algorithm (revised 2026-06-23 after real-data review — see §6):
1. **With room id:** group `sales` strictly by `roomId` (authoritative — different rooms are always different shows; a room's orders re-merge even across a long gap). Each room → one `DerivedShow{ id: roomId, … }`.
2. **Attach room-less orders:** compute each room show's `[start, end]` window. Cancelled / non-auction orders carry no `live_room_id`; assign each such order to the room show whose window contains its `createdAt`, else the nearest room within `SESSION_GAP_MS`. This keeps a live's cancelled/room-less orders in the **same** show as its paid orders (instead of splitting a duplicate show per live).
3. **Orphans → fallback:** room-less orders matching no room are `clusterByTime`'d; each `Session` → one `DerivedShow{ id: derivedShowId(startMs), … }`.
4. **Title:** always `deriveTitle(startMs)` (`LIVE · <date>, <time>`). The real `sales_source_live_tag` is generic boilerplate, so it is not used as a title.
5. Build `showIdByOrder` for every order; sort `shows` by `startMs` desc.

### 3.5 Filter wiring (`src/renderer/renderer.ts`) — synced-orders branch only

- Remove `SHOW_OF`. Compute `const { shows, showIdByOrder } = deriveShowsFromOrders(syncedOrders)` once per render of the options/source.
- `refreshShowOptions` (synced branch): `All orders (n)` first, then one option per `DerivedShow` labeled ``${title} · ${date} · ${count} items · ${dur}`` (reuse the existing `fmtDur`; `date` from `startMs`).
- `sourceSales` (synced branch): `selectedShowId === 'all' | 'live'` → all synced orders; otherwise `syncedOrders.filter(s => showIdByOrder.get(s.orderId) === selectedShowId)`.
- The non-synced (live-capture) branch — `listShows(showStore)` / `salesForShow` — is **unchanged**.
- `onShowChange`, the Ledger ⇄ Picklist picker sync, and the default-selection logic (`selectedShowId === 'live' && syncedOrders.length` → `'all'`) are unchanged.

---

## 4. Data flow

```
order/list + order/get  ──►  mapTiktokOrder (roomId)  ──►  orderToSale (Sale.roomId)
        │                                                        │
        ▼                                                        ▼
   db.orders.room_id  ──(getSnapshot overlay)──►  syncedOrders: Sale[]  (renderer)
                                                          │
                                  deriveShowsFromOrders(syncedOrders)
                                       │                       │
                                  shows[] (picker)      showIdByOrder (filter)
                                       │                       │
                              refreshShowOptions          sourceSales ──► Ledger / Picklist
```

---

## 5. Testing

Pure vitest specs (no DOM/electron):

- **`sessions.test.ts`** — `clusterByTime`: single cluster, split on gap > threshold, items dropped when `t` non-finite, boundary at exactly the gap; `derivedShowId` stable on the same start second; `deriveTitle` shape.
- **`deriveShowsFromOrders` tests** — all-room-id grouping; all-fallback clustering; mixed (some room ids, some not); title precedence (liveTag wins, else date); `showIdByOrder` covers every order; `shows` sorted by `startMs` desc; empty input → `{ shows: [], showIdByOrder: empty }`.

`shows.test.ts` is unchanged and must still pass. Renderer wiring is verified manually (synced order book filter) — consistent with the PoC's existing renderer test coverage.

---

## 6. Risks & mitigations

- **`roomId` precision.** `live_room_id` is a 19-digit number; `tiktok-orders.ts` already stringifies it on ingest (`String(get(o,'auction_module.live_room_id'))`) and the `order/get` path quotes it pre-parse. Treated as an opaque string throughout — no numeric handling. ✓
- **A room spanning multiple calendar days.** Room id is authoritative: one room id = one show (matching live-ledger), regardless of span. Accepted.
- **Order timestamp source.** Clustering uses `Sale.createdAt` (ms). `mapTiktokOrder` already populates it from `trade_order_module.create_time` (falling back to `Date.now()`); fallback orders with a degenerate timestamp simply cluster together — acceptable for the no-room-id tail.
- **Pre-change rows without `roomId` in `sale_json`.** Closed by the `getSnapshot` column overlay (§3.2).
