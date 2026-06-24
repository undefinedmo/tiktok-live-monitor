# Show-Picker Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Sync open a modal of the seller's real TikTok shows; picking one syncs just that show's orders (time-bounded + room-matched), with a full-history sync still available inside the modal, and real show names threaded into the existing ledger show-filter.

**Architecture:** A pure core (`showList` parsing, `sessions` titling, `tiktok-orders` filter helpers) is unit-tested with fixtures. The signed `live_session/list` call is fired from the monitor window's page context (the TikTok SDK auto-signs `streamer_desktop` calls — see `preload.ts:168`) and round-tripped to main, mirroring the existing `tt-chat-send`/`tt-chat-sent` pattern. Scoped order sync reuses the existing cookie-only `order/list` + `order/get` endpoints, bounded to the show's time window.

**Tech Stack:** TypeScript, Electron 33, better-sqlite3, Vitest 2, esbuild. ESM (`"type":"module"`).

## Global Constraints

- Pure `core/` modules have **zero** Electron/DOM/network imports (keeps them unit-testable). Electron-only code lives under `src/electron/`.
- 19-digit TikTok ids exceed 2^53 — **quote them in the raw response text before `JSON.parse`** (existing precedent: `tiktok-orders.ts:267,322`). For `live_session/list` the unsafe fields are `room_id` and `event_id`.
- Tests run with `npx vitest run <path>`; the full suite is `npm test`. Test files live in `src/**/__tests__/*.test.ts` and import from `vitest` (`import { describe, it, expect } from 'vitest'`).
- Build with `node esbuild.mjs`; run the app with `npm run dev`.
- `order/list` carries **no** `live_room_id`; only `order/get` does. Mapping an order to a show requires the detail pass.
- `order/list` is pulled newest-first (`sort_info:'6'`); early-stop on time bound depends on this ordering.
- Scoped sync **adds to** the order book via upsert (keyed by `externalOrderId`); it never replaces.
- `SHOW_SYNC_BUFFER_MS = 6 * 60 * 60 * 1000` (6h) — the window padding for late payments / unpaid→paid lag.

---

### Task 1: Show-list fixture

**Files:**
- Create: `tiktok-live-poc/fixtures/show-list-sample.json`

**Interfaces:**
- Produces: a real `live_session/list` response body, consumed by Task 2's tests. Contains a multi-room session (`4353398534`, two rooms) and a no-room session (`4523526918`) for edge coverage.

- [ ] **Step 1: Write the fixture file**

Create `tiktok-live-poc/fixtures/show-list-sample.json` with this exact captured response:

```json
{"code":0,"message":"success","data":{"live_sessions":[{"id":"4389560838","name":"Alo Yoga and More - Final Sale","start_time":"1782167400","during_time":"10800","description":"","event_id":"7654248187959443469","session_statistic":{"product_cnt":2,"giveaway_cnt":2,"coupon_cnt":0},"live_room_infos":[{"room_id":"7654357221282777870","start_time":"1782168993","during_time":"6607","statistic":{"product_cnt":2,"giveaway_cnt":2,"coupon_cnt":0}}],"live_session_status":20,"num_reservations":"15"},{"id":"4384835334","name":"Alo Yoga & More - No Cancels","start_time":"1781985600","during_time":"7200","description":"Various comtemporary women clothing including Alo Yoga, Skims, Dairy Boys, Lululemon and more. Fast Pace. No Cancellation or Refunds. Bid Responsibly.","event_id":"7653502863313731598","session_statistic":{"product_cnt":2,"giveaway_cnt":5,"coupon_cnt":0},"live_room_infos":[{"room_id":"7653571353936759566","start_time":"1781986026","during_time":"11513","statistic":{"product_cnt":2,"giveaway_cnt":5,"coupon_cnt":0}}],"live_session_status":20,"num_reservations":"9"},{"id":"4327026182","name":"$15 STARTS WOMEN PREMIUM BRANDS","start_time":"1781298000","during_time":"10800","description":"","event_id":"7650609300968046605","session_statistic":{"product_cnt":1,"giveaway_cnt":2,"coupon_cnt":0},"live_room_infos":[{"room_id":"7650617906618829582","start_time":"1781298393","during_time":"11999","statistic":{"product_cnt":2,"giveaway_cnt":2,"coupon_cnt":0}}],"live_session_status":20,"num_reservations":"1"},{"id":"4523526918","name":"$15 STARTS WOMEN PREMIUM BRANDS","start_time":"1781136000","during_time":"10800","description":"Premium Authentic Women Clothing","event_id":"7649886410563911693","session_statistic":{"product_cnt":2,"giveaway_cnt":0,"coupon_cnt":0},"live_session_status":20,"num_reservations":"4"},{"id":"4323027718","name":"$15 STARTS WOMEN PREMIUM BRANDS","start_time":"1781125200","during_time":"10800","description":"Brands including Lululemon, Alo Yoga, Frame Jeans, Skims, Nike X Skims and more.","event_id":"7649518670955315214","session_statistic":{"product_cnt":1,"giveaway_cnt":1,"coupon_cnt":0},"live_room_infos":[{"room_id":"7649875196014512910","start_time":"1781125431","during_time":"776","statistic":{"product_cnt":0,"giveaway_cnt":1,"coupon_cnt":0}}],"live_session_status":20,"num_reservations":"17"},{"id":"4463472902","name":"$15 STARTS WOMEN PREMIUM BRANDS","start_time":"1780945200","during_time":"7200","description":"","event_id":"7649097615715336205","session_statistic":{"product_cnt":1,"giveaway_cnt":6,"coupon_cnt":0},"live_room_infos":[{"room_id":"7649102219992369933","start_time":"1780945495","during_time":"12579","statistic":{"product_cnt":1,"giveaway_cnt":6,"coupon_cnt":0}}],"live_session_status":20,"num_reservations":"1"},{"id":"4353398534","name":"$5 STARTS WOMEN PREMIUM BRANDS","start_time":"1779404400","during_time":"7200","description":"Premium Brands - No Cancelation","event_id":"7642420902067437581","session_statistic":{"product_cnt":1,"giveaway_cnt":5,"coupon_cnt":0},"live_room_infos":[{"room_id":"7642488665180097311","start_time":"1779405642","during_time":"3031","statistic":{"product_cnt":1,"giveaway_cnt":2,"coupon_cnt":0}},{"room_id":"7642505372850195231","start_time":"1779409508","during_time":"5259","statistic":{"product_cnt":2,"giveaway_cnt":3,"coupon_cnt":0}}],"live_session_status":20,"num_reservations":"4"}],"total":null,"upcoming_total":0,"past_total":7}}
```

- [ ] **Step 2: Commit**

```bash
git add tiktok-live-poc/fixtures/show-list-sample.json
git commit -m "test(poc): add live_session/list fixture for show-picker sync"
```

---

### Task 2: `core/showList.ts` — parse, window, name map

**Files:**
- Create: `tiktok-live-poc/src/core/showList.ts`
- Test: `tiktok-live-poc/src/core/__tests__/showList.test.ts`

**Interfaces:**
- Consumes: `fixtures/show-list-sample.json` (Task 1).
- Produces:
  - `interface ShowListing { sessionId: string; name: string; startTime: number; durationSec: number; description?: string; eventId: string; roomIds: string[]; productCnt?: number; reservations?: number }`
  - `parseShowList(rawText: string): ShowListing[]`
  - `showWindowMs(s: ShowListing): { startMs: number; endMs: number }`
  - `type RoomNameMeta = { sessionId: string; name: string; startMs: number }`
  - `roomNameMap(shows: ShowListing[]): Map<string, RoomNameMeta>`

- [ ] **Step 1: Write the failing test**

Create `tiktok-live-poc/src/core/__tests__/showList.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseShowList, showWindowMs, roomNameMap } from '../showList'

const RAW = readFileSync(join(__dirname, '../../../fixtures/show-list-sample.json'), 'utf8')

describe('parseShowList', () => {
  it('parses every session with name, ids, and times', () => {
    const shows = parseShowList(RAW)
    expect(shows).toHaveLength(7)
    const first = shows[0]!
    expect(first.sessionId).toBe('4389560838')
    expect(first.name).toBe('Alo Yoga and More - Final Sale')
    expect(first.startTime).toBe(1782167400)
    expect(first.durationSec).toBe(10800)
    expect(first.eventId).toBe('7654248187959443469')
    expect(first.roomIds).toEqual(['7654357221282777870'])
    expect(first.reservations).toBe(15)
  })

  it('keeps 19-digit room/event ids exact (no float rounding)', () => {
    const shows = parseShowList(RAW)
    expect(shows.find((s) => s.sessionId === '4463472902')!.roomIds)
      .toEqual(['7649102219992369933'])
  })

  it('handles a multi-room session', () => {
    const shows = parseShowList(RAW)
    expect(shows.find((s) => s.sessionId === '4353398534')!.roomIds)
      .toEqual(['7642488665180097311', '7642505372850195231'])
  })

  it('handles a session with no rooms', () => {
    const shows = parseShowList(RAW)
    expect(shows.find((s) => s.sessionId === '4523526918')!.roomIds).toEqual([])
  })

  it('returns [] on error code or malformed text', () => {
    expect(parseShowList('{"code":1,"message":"nope"}')).toEqual([])
    expect(parseShowList('not json')).toEqual([])
  })
})

describe('showWindowMs', () => {
  it('spans session start to session end in ms', () => {
    const shows = parseShowList(RAW)
    const w = showWindowMs(shows[0]!)
    expect(w.startMs).toBe(1782167400 * 1000)
    expect(w.endMs).toBe((1782167400 + 10800) * 1000)
  })
})

describe('roomNameMap', () => {
  it('keys every room id to its session name', () => {
    const m = roomNameMap(parseShowList(RAW))
    expect(m.get('7654357221282777870')!.name).toBe('Alo Yoga and More - Final Sale')
    expect(m.get('7642505372850195231')!.sessionId).toBe('4353398534')
    expect(m.size).toBe(7) // 6 single-room + 1 two-room − 1 no-room session = 7 rooms
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/__tests__/showList.test.ts`
Expected: FAIL — `Cannot find module '../showList'`.

- [ ] **Step 3: Write the implementation**

Create `tiktok-live-poc/src/core/showList.ts`:

```ts
// Pure parser for TikTok's streamer_desktop/live_session/list response. Turns the raw
// signed-endpoint payload into clean ShowListings, and exposes the time window + the
// roomId→name lookup used to title derived shows. Zero electron/DOM deps.

export interface ShowListing {
  sessionId: string        // session id (short, e.g. "4389560838")
  name: string             // the show name shown in the picker
  startTime: number        // unix SECONDS (session start)
  durationSec: number
  description?: string
  eventId: string          // 19-digit
  roomIds: string[]         // live_room_infos[].room_id (0..n) — matches orders' live_room_id
  productCnt?: number
  reservations?: number
}

export type RoomNameMeta = { sessionId: string; name: string; startMs: number }

type Raw = Record<string, unknown>
function get(o: Raw, path: string): unknown {
  try { return path.split('.').reduce<unknown>((a, k) => (a == null ? a : (a as Raw)[k]), o) } catch { return undefined }
}
function intOr(v: unknown, fallback: number): number {
  const n = parseInt(String(v), 10)
  return Number.isNaN(n) ? fallback : n
}

/** Parse a raw live_session/list response body. 19-digit room_id/event_id are quoted
 *  before JSON.parse so V8 doesn't round them. Returns [] on error code / bad text. */
export function parseShowList(rawText: string): ShowListing[] {
  let j: Raw
  try {
    j = JSON.parse(rawText.replace(/"(room_id|event_id)":\s*(\d+)/g, '"$1":"$2"')) as Raw
  } catch {
    return []
  }
  if (j.code !== 0 && j.code != null) return []
  const sessions = (get(j, 'data.live_sessions') as Raw[]) || []
  return sessions.map((s): ShowListing => {
    const rooms = (get(s, 'live_room_infos') as Raw[]) || []
    const desc = get(s, 'description')
    return {
      sessionId: String(get(s, 'id') ?? ''),
      name: String(get(s, 'name') ?? ''),
      startTime: intOr(get(s, 'start_time'), 0),
      durationSec: intOr(get(s, 'during_time'), 0),
      description: typeof desc === 'string' && desc.length ? desc : undefined,
      eventId: String(get(s, 'event_id') ?? ''),
      roomIds: rooms.map((r) => String((r as Raw).room_id)).filter((id) => id && id !== 'undefined'),
      productCnt: get(s, 'session_statistic.product_cnt') != null ? intOr(get(s, 'session_statistic.product_cnt'), 0) : undefined,
      reservations: get(s, 'num_reservations') != null ? intOr(get(s, 'num_reservations'), 0) : undefined,
    }
  })
}

/** The show's [start, end] in unix MS (used to bound the order pull). */
export function showWindowMs(s: ShowListing): { startMs: number; endMs: number } {
  return { startMs: s.startTime * 1000, endMs: (s.startTime + s.durationSec) * 1000 }
}

/** roomId → {sessionId, name, startMs} for every room across all shows. */
export function roomNameMap(shows: ShowListing[]): Map<string, RoomNameMeta> {
  const m = new Map<string, RoomNameMeta>()
  for (const s of shows) {
    for (const roomId of s.roomIds) {
      m.set(roomId, { sessionId: s.sessionId, name: s.name, startMs: s.startTime * 1000 })
    }
  }
  return m
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/__tests__/showList.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add tiktok-live-poc/src/core/showList.ts tiktok-live-poc/src/core/__tests__/showList.test.ts
git commit -m "feat(poc): parse live_session/list into ShowListings"
```

---

### Task 3: `core/sessions.ts` — title derived shows with real names

**Files:**
- Modify: `tiktok-live-poc/src/core/sessions.ts` (the `deriveShowsFromOrders` signature + step-5 title build, lines ~64 and ~138)
- Test: `tiktok-live-poc/src/core/__tests__/sessions.test.ts` (append a test)

**Interfaces:**
- Consumes: `RoomNameMeta` from `core/showList` (Task 2).
- Produces: `deriveShowsFromOrders(sales: Sale[], names?: Map<string, RoomNameMeta>)` — when a room id matches `names`, the show's `title` is the real name; otherwise the existing `deriveTitle(startMs)`. Return shape unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tiktok-live-poc/src/core/__tests__/sessions.test.ts` (the `sale(...)` helper at line 44 already exists — reuse it):

```ts
describe('deriveShowsFromOrders with names', () => {
  it('titles a room-matched show with the real name, others keep the date title', () => {
    const names = new Map([
      ['room-1', { sessionId: 's1', name: 'Alo Yoga — Final Sale', startMs: 1000 }],
    ])
    const { shows } = deriveShowsFromOrders([
      sale('a', { roomId: 'room-1', createdAt: 1000 }),
      sale('b', { roomId: 'room-2', createdAt: 2000 }),
    ], names)
    expect(shows.find((s) => s.id === 'room-1')!.title).toBe('Alo Yoga — Final Sale')
    expect(shows.find((s) => s.id === 'room-2')!.title).toMatch(/^LIVE · /)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/__tests__/sessions.test.ts`
Expected: FAIL — `deriveShowsFromOrders` ignores the 2nd arg, so `room-1`'s title is `"LIVE · …"`.

- [ ] **Step 3: Write the implementation**

In `tiktok-live-poc/src/core/sessions.ts`, add the import at the top (after the existing `import type { Sale }`):

```ts
import type { RoomNameMeta } from './showList'
```

Change the signature (line ~64) from:

```ts
export function deriveShowsFromOrders(sales: Sale[]): {
  shows: DerivedShow[]
  showIdByOrder: Map<string, string>
} {
```

to:

```ts
export function deriveShowsFromOrders(sales: Sale[], names?: Map<string, RoomNameMeta>): {
  shows: DerivedShow[]
  showIdByOrder: Map<string, string>
} {
```

In the step-5 metadata build (line ~138), change:

```ts
    shows.push({ id, title: deriveTitle(startMs), startMs, endMs, count: g.length })
```

to:

```ts
    const named = names?.get(id)
    shows.push({ id, title: named ? named.name : deriveTitle(startMs), startMs, endMs, count: g.length })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/__tests__/sessions.test.ts`
Expected: PASS (new test + all existing sessions tests still green — the `names` arg is optional).

- [ ] **Step 5: Commit**

```bash
git add tiktok-live-poc/src/core/sessions.ts tiktok-live-poc/src/core/__tests__/sessions.test.ts
git commit -m "feat(poc): title derived shows with real names when room matches"
```

---

### Task 4: `tiktok-orders.ts` — pure scoping helpers

**Files:**
- Modify: `tiktok-live-poc/src/electron/tiktok-orders.ts` (append helpers + constant)
- Test: `tiktok-live-poc/src/electron/__tests__/tiktok-orders.test.ts` (append tests)

**Interfaces:**
- Consumes: `MappedOrder`, `OrderDetail` (already exported from this file).
- Produces:
  - `const SHOW_SYNC_BUFFER_MS = 21_600_000`
  - `pageReachedSince(orders: MappedOrder[], sinceMs: number): boolean`
  - `applyOrderDetails(orders: MappedOrder[], details: Map<string, OrderDetail>): MappedOrder[]`
  - `filterOrdersForShow(orders: MappedOrder[], roomIds: string[], startMs: number, endMs: number): MappedOrder[]`

- [ ] **Step 1: Write the failing test**

Append to `tiktok-live-poc/src/electron/__tests__/tiktok-orders.test.ts`:

```ts
import { SHOW_SYNC_BUFFER_MS, pageReachedSince, applyOrderDetails, filterOrdersForShow } from '../tiktok-orders'
import type { MappedOrder, OrderDetail } from '../tiktok-orders'

function ord(id: string, placedAt: number | null, roomId: string | null = null): MappedOrder {
  return {
    externalOrderId: id, status: 'To ship', statusCode: '102', buyerHandle: null, buyerName: null,
    subtotalCents: 0, shippingCents: 0, shippingDiscountCents: 0, platformDiscountCents: 0,
    sellerDiscountCents: 0, taxCents: 0, originSaleCents: 0, totalCents: 0, address: null,
    carrier: null, tracking: null, liveTag: null, isAuction: false, isReversed: false,
    placedAt, roomId, videoReceiptTs: null, items: [],
  }
}

describe('SHOW_SYNC_BUFFER_MS', () => {
  it('is 6 hours', () => { expect(SHOW_SYNC_BUFFER_MS).toBe(6 * 60 * 60 * 1000) })
})

describe('pageReachedSince', () => {
  it('true once a page contains an order older than sinceMs', () => {
    expect(pageReachedSince([ord('a', 5000), ord('b', 1000)], 2000)).toBe(true)
  })
  it('false when every order is at or after sinceMs', () => {
    expect(pageReachedSince([ord('a', 5000), ord('b', 3000)], 2000)).toBe(false)
  })
  it('ignores orders with no placedAt', () => {
    expect(pageReachedSince([ord('a', null)], 2000)).toBe(false)
  })
})

describe('applyOrderDetails', () => {
  it('merges roomId + videoReceiptTs from details by order id', () => {
    const details = new Map<string, OrderDetail>([['a', { videoUrl: null, roomId: 'room-9', receiptTsMs: 42 }]])
    const out = applyOrderDetails([ord('a', 1000)], details)
    expect(out[0]!.roomId).toBe('room-9')
    expect(out[0]!.videoReceiptTs).toBe(42)
  })
  it('leaves orders without a detail entry unchanged', () => {
    const out = applyOrderDetails([ord('a', 1000, 'keep')], new Map())
    expect(out[0]!.roomId).toBe('keep')
  })
})

describe('filterOrdersForShow', () => {
  const startMs = 10_000, endMs = 20_000
  it('keeps orders whose roomId is in the show', () => {
    const out = filterOrdersForShow([ord('a', 999999, 'room-1'), ord('b', 999999, 'room-x')], ['room-1'], startMs, endMs)
    expect(out.map((o) => o.externalOrderId)).toEqual(['a'])
  })
  it('keeps room-less orders that fall inside the window', () => {
    const out = filterOrdersForShow([ord('c', 15_000, null)], ['room-1'], startMs, endMs)
    expect(out.map((o) => o.externalOrderId)).toEqual(['c'])
  })
  it('drops room-less orders outside the window', () => {
    const out = filterOrdersForShow([ord('d', 999999, null)], ['room-1'], startMs, endMs)
    expect(out).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/electron/__tests__/tiktok-orders.test.ts`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Write the implementation**

Append to `tiktok-live-poc/src/electron/tiktok-orders.ts`:

```ts
// ── Scoped (per-show) sync helpers ───────────────────────────────────────────
// order/list carries no room id and no room filter, so a show's orders are isolated
// by time-bounding the pull then matching room ids resolved via order/get. This buffer
// pads the show window for late payments / unpaid→paid lag.
export const SHOW_SYNC_BUFFER_MS = 6 * 60 * 60 * 1000

/** True once a (newest-first) page contains an order placed before sinceMs — the signal
 *  to stop paging order/list for a time-bounded pull. */
export function pageReachedSince(orders: MappedOrder[], sinceMs: number): boolean {
  return orders.some((o) => o.placedAt != null && o.placedAt < sinceMs)
}

/** Merge order/get detail (roomId + video receipt ts) into the list-derived orders, keyed
 *  by externalOrderId. Returns new objects; inputs untouched. */
export function applyOrderDetails(orders: MappedOrder[], details: Map<string, OrderDetail>): MappedOrder[] {
  return orders.map((o) => {
    const d = details.get(o.externalOrderId)
    if (!d) return o
    return {
      ...o,
      roomId: d.roomId ?? o.roomId,
      videoReceiptTs: d.receiptTsMs ?? o.videoReceiptTs,
    }
  })
}

/** Keep orders belonging to a show: room id in `roomIds`, OR room-less orders placed inside
 *  the [startMs, endMs] window (cancelled / non-auction orders carry no room id). */
export function filterOrdersForShow(
  orders: MappedOrder[],
  roomIds: string[],
  startMs: number,
  endMs: number,
): MappedOrder[] {
  const rooms = new Set(roomIds)
  return orders.filter((o) => {
    if (o.roomId && rooms.has(o.roomId)) return true
    if (!o.roomId && o.placedAt != null && o.placedAt >= startMs && o.placedAt <= endMs) return true
    return false
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/electron/__tests__/tiktok-orders.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tiktok-live-poc/src/electron/tiktok-orders.ts tiktok-live-poc/src/electron/__tests__/tiktok-orders.test.ts
git commit -m "feat(poc): pure helpers for time-bounded per-show order scoping"
```

---

### Task 5: `tiktok-orders.ts` — `pullTiktokOrdersSince`

**Files:**
- Modify: `tiktok-live-poc/src/electron/tiktok-orders.ts` (append the network function)
- Test: `tiktok-live-poc/src/electron/__tests__/tiktok-orders.test.ts` (append a test with a mocked `fetch`)

**Interfaces:**
- Consumes: `ORDER_LIST_URL`, `TT_ORDER_EXTRA_DATA`, `UA`, `mapTiktokOrder`, `pageReachedSince` (this file).
- Produces: `pullTiktokOrdersSince(cookieHeader: string, sinceMs: number, onPage?: (pulled: number, total: number) => void): Promise<{ orders: MappedOrder[]; total: number; stopped: boolean }>`

- [ ] **Step 1: Write the failing test**

Append to `tiktok-live-poc/src/electron/__tests__/tiktok-orders.test.ts` (add `vi` to the existing vitest import: `import { describe, it, expect, vi, afterEach } from 'vitest'`):

```ts
describe('pullTiktokOrdersSince', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  function page(orders: { id: string; t: number }[], has_more: boolean) {
    const main_orders = orders.map((o) => ({
      main_order_id: o.id,
      order_status_module: [{ main_order_status: '102' }],
      trade_order_module: { create_time: o.t }, // seconds
      price_module: {}, sku_module: [],
    }))
    return { ok: true, text: async () => JSON.stringify({ code: 0, data: { main_orders, total_count: 99, has_more } }) }
  }

  it('stops paging once a page reaches before sinceMs', async () => {
    const sinceSec = 1_000_000
    const sinceMs = sinceSec * 1000
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page([{ id: 'a', t: sinceSec + 500 }, { id: 'b', t: sinceSec + 400 }], true))
      .mockResolvedValueOnce(page([{ id: 'c', t: sinceSec + 100 }, { id: 'd', t: sinceSec - 100 }], true))
    vi.stubGlobal('fetch', fetchMock)

    const res = await pullTiktokOrdersSince('cookie=1', sinceMs)

    expect(fetchMock).toHaveBeenCalledTimes(2) // stopped after the page containing 'd'
    expect(res.stopped).toBe(true)
    expect(res.orders.map((o) => o.externalOrderId)).toEqual(['a', 'b', 'c', 'd'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/electron/__tests__/tiktok-orders.test.ts -t pullTiktokOrdersSince`
Expected: FAIL — `pullTiktokOrdersSince` is not defined.

- [ ] **Step 3: Write the implementation**

Append to `tiktok-live-poc/src/electron/tiktok-orders.ts`:

```ts
/** Time-bounded order pull: pages order/list newest-first (sort_info '6') and stops once a
 *  page contains an order placed before `sinceMs`. Cookie auth only — same as pullTiktokOrders.
 *  Returns every order pulled up to (and including) the boundary page; caller filters/enriches. */
export async function pullTiktokOrdersSince(
  cookieHeader: string,
  sinceMs: number,
  onPage?: (pulled: number, total: number) => void,
): Promise<{ orders: MappedOrder[]; total: number; stopped: boolean }> {
  const all: MappedOrder[] = []
  let offset = 0, total = 0, guard = 0, stopped = false
  const count = 50
  while (guard < 400) {
    guard++
    const res = await fetch(ORDER_LIST_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json',
        origin: 'https://seller-us.tiktok.com', referer: 'https://seller-us.tiktok.com/order',
        'user-agent': UA, cookie: cookieHeader,
      },
      body: JSON.stringify({
        sort_info: '6', search_condition: { condition_list: {} },
        count, pagination_type: 0, offset, extra_data_list: TT_ORDER_EXTRA_DATA,
      }),
    })
    if (!res.ok) throw new Error(`order/list HTTP ${res.status}`)
    const text = await res.text()
    const j = JSON.parse(text.replace(/"live_room_id":\s*(\d+)/g, '"live_room_id":"$1"')) as Raw
    if (j.code !== 0 && j.code != null) {
      throw new Error(`order/list code ${j.code} — ${String(j.message ?? 'rejected')} (session may be expired — re-open the monitor and log in)`)
    }
    const data = (j.data as Raw) || {}
    const batch = ((data.main_orders as Raw[]) || []).map(mapTiktokOrder)
    all.push(...batch)
    total = Number(data.total_count || 0)
    onPage?.(all.length, total)
    if (pageReachedSince(batch, sinceMs)) { stopped = true; break }
    offset += count
    if (!(data.has_more && batch.length && offset < total + count)) break
  }
  return { orders: all, total, stopped }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/electron/__tests__/tiktok-orders.test.ts`
Expected: PASS (whole file).

- [ ] **Step 5: Commit**

```bash
git add tiktok-live-poc/src/electron/tiktok-orders.ts tiktok-live-poc/src/electron/__tests__/tiktok-orders.test.ts
git commit -m "feat(poc): pullTiktokOrdersSince time-bounded order pull"
```

---

### Task 6: `db.ts` — persist show names + expose in snapshot

**Files:**
- Modify: `tiktok-live-poc/src/electron/db.ts` (`DbSnapshot`, `getSnapshot`, add `getShowNames`/`setShowNames`)
- Test: `tiktok-live-poc/src/electron/__tests__/db.test.ts` (append a test)

**Interfaces:**
- Produces:
  - `type ShowNameStore = Record<string, { sessionId: string; name: string; startMs: number }>`
  - `getShowNames(db: Db): ShowNameStore`
  - `setShowNames(db: Db, map: ShowNameStore): void` — **merges** into the existing store (keyed by room id).
  - `DbSnapshot.showNames: ShowNameStore`

- [ ] **Step 1: Write the failing test**

Append to `tiktok-live-poc/src/electron/__tests__/db.test.ts` (reuse the file's existing `openDb(':memory:')` setup pattern):

```ts
import { getShowNames, setShowNames } from '../db'

describe('show names store', () => {
  it('merges room→name entries across calls and exposes them in the snapshot', () => {
    const db = openDb(':memory:')
    setShowNames(db, { 'room-1': { sessionId: 's1', name: 'Show One', startMs: 1000 } })
    setShowNames(db, { 'room-2': { sessionId: 's2', name: 'Show Two', startMs: 2000 } })
    const names = getShowNames(db)
    expect(names['room-1']!.name).toBe('Show One')
    expect(names['room-2']!.name).toBe('Show Two')
    expect(getSnapshot(db).showNames['room-1']!.sessionId).toBe('s1')
    db.close()
  })
})
```

> If `db.test.ts` does not already import `openDb`/`getSnapshot`, add them to its existing import from `'../db'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/electron/__tests__/db.test.ts`
Expected: FAIL — `getShowNames`/`setShowNames` not exported (and `snapshot.showNames` undefined).

- [ ] **Step 3: Write the implementation**

In `tiktok-live-poc/src/electron/db.ts`:

Add to `DbSnapshot` (after `shows: unknown`):

```ts
  showNames: ShowNameStore
```

Add the type near the top (after the imports):

```ts
export type ShowNameStore = Record<string, { sessionId: string; name: string; startMs: number }>
```

In `getSnapshot`, change the final return to include `showNames`:

```ts
  return { orders, costs, productCosts, orderTx, productTx, picked, shows: showsRow ? JSON.parse(showsRow.v) : {}, showNames: getShowNames(db) }
```

Add the two functions (next to `getShows`/`setShows`):

```ts
export function getShowNames(db: Db): ShowNameStore {
  const r = db.prepare("SELECT v FROM meta WHERE k = 'show_names'").get() as { v: string } | undefined
  return r ? (JSON.parse(r.v) as ShowNameStore) : {}
}

/** Merge room→name entries into the persisted store (keyed by room id). */
export function setShowNames(db: Db, map: ShowNameStore): void {
  const merged = { ...getShowNames(db), ...map }
  db.prepare("INSERT INTO meta (k,v) VALUES ('show_names',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify(merged))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/electron/__tests__/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tiktok-live-poc/src/electron/db.ts tiktok-live-poc/src/electron/__tests__/db.test.ts
git commit -m "feat(poc): persist roomId→show-name map in db + snapshot"
```

---

### Task 7: `preload.ts` — fire `live_session/list` from the signed page context

**Files:**
- Modify: `tiktok-live-poc/src/electron/preload.ts` (add a `tt-shows-fetch` handler)

**Interfaces:**
- Consumes (from main): IPC `tt-shows-fetch` `{ id: number }`.
- Produces (to main): IPC `tt-shows-result` `{ id: number; ok: boolean; pages: string[]; error?: string }` — `pages` are raw response texts (one per page), parsed by main via `parseShowList`.

> No unit test — this is page-context glue verified in Task 9's manual QA. The TikTok SDK auto-signs `streamer_desktop` calls fired through the page's `window.fetch` (precedent: the chat-send block at `preload.ts:169-187`).

- [ ] **Step 1: Add the handler**

Append to `tiktok-live-poc/src/electron/preload.ts` (top-level, after the existing `ipcRenderer.send('tt-status', { status: 'connecting' })` line or alongside the other top-level `ipcRenderer.on` handlers):

```ts
// ── Show list (streamer_desktop/live_session/list) ───────────────────────────
// Fired on demand from the ledger's Sync modal. Runs in the streamer page so the
// TikTok SDK signs the request (X-Bogus/msToken); we forward raw page texts to main,
// which parses them (parseShowList) and quotes the 19-digit room/event ids.
ipcRenderer.on('tt-shows-fetch', async (_e, req: { id: number }) => {
  const id = req?.id
  const base = 'https://shop.tiktok.com/api/v1/streamer_desktop/live_session/list'
  const q = '?aid=253642&app_name=i18n_ecom_alliance&device_platform=web&user_language=en&locale=en&page_scene=0&carrier_region=us'
  const PAGE = 20
  const fetchPage = (cur: number) =>
    window.fetch(base + q, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tt-store-region': 'us' },
      body: JSON.stringify({ page_size: PAGE, cur_page: cur, search_type: 2, search_order: 2, with_reservations: true }),
    }).then((r) => r.text())
  try {
    const pages: string[] = []
    const first = await fetchPage(1)
    pages.push(first)
    let pastTotal = 0
    try { pastTotal = Number((JSON.parse(first) as { data?: { past_total?: number } })?.data?.past_total ?? 0) } catch { /* ignore */ }
    const lastPage = Math.min(Math.ceil(pastTotal / PAGE), 20) // 20-page guard
    for (let p = 2; p <= lastPage; p++) pages.push(await fetchPage(p))
    ipcRenderer.send('tt-shows-result', { id, ok: true, pages })
  } catch (e) {
    ipcRenderer.send('tt-shows-result', { id, ok: false, pages: [], error: String(e) })
  }
})
```

- [ ] **Step 2: Type-check / build**

Run: `node esbuild.mjs`
Expected: builds with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add tiktok-live-poc/src/electron/preload.ts
git commit -m "feat(poc): fire live_session/list from signed streamer page context"
```

---

### Task 8: `main.ts` — `fetchShowList` + `tt-shows-list` + `tt-sync-show`

**Files:**
- Modify: `tiktok-live-poc/src/electron/main.ts` (imports, a `fetchShowList` helper, two IPC handlers)

**Interfaces:**
- Consumes: `parseShowList`, `roomNameMap`, `type ShowListing` (`core/showList`); `pullTiktokOrdersSince`, `fetchOrderDetails`, `applyOrderDetails`, `filterOrdersForShow`, `SHOW_SYNC_BUFFER_MS` (`tiktok-orders`); `setShowNames`, `upsertOrders`, `rekeyProductTemplates` (`db`); existing `tiktokLoggedIn`, `tiktokCookieHeader`, `openSellerLogin`, the `monitor` window + `openMonitor` logic.
- Produces:
  - IPC `tt-shows-list` → `{ ok: boolean; shows?: ShowListing[]; needsLogin?: boolean; capped?: boolean; reason?: string }`
  - IPC `tt-sync-show` (arg `{ roomIds: string[]; startMs: number; endMs: number }`) → `{ ok: boolean; count?: number; reason?: string }`

> No unit test — integration glue, verified in Task 9 manual QA.

- [ ] **Step 1: Add imports**

In `tiktok-live-poc/src/electron/main.ts`, extend the existing imports:

```ts
import { pullTiktokOrders, fetchOrderDetails, pullTiktokOrdersSince, applyOrderDetails, filterOrdersForShow, SHOW_SYNC_BUFFER_MS } from './tiktok-orders'
import { openDb, upsertOrders, getSnapshot, setCost, setTranscript, setPicked, getShows, setShows, importLegacy, rekeyProductTemplates, setShowNames, type LegacyBlob } from './db'
import { parseShowList, roomNameMap, type ShowListing } from '../core/showList'
```

- [ ] **Step 2: Add the `fetchShowList` helper**

Add near the other TikTok helpers (after `tiktokCookieHeader`, ~line 52). This assumes a `monitor` window that loads the streamer page exists; if your `openMonitor` helper differs, reuse it to create/show the monitor before sending the IPC.

```ts
let showsReqSeq = 0
/** Ask the monitor page (signed streamer context) to fetch live_session/list, parse the
 *  returned pages, persist the roomId→name map, and return the ShowListings. */
async function fetchShowList(): Promise<{ ok: boolean; shows?: ShowListing[]; needsLogin?: boolean; capped?: boolean; reason?: string }> {
  if (!(await tiktokLoggedIn())) { openSellerLogin(); return { ok: false, needsLogin: true } }
  if (!monitor) { openMonitor() }
  if (!monitor) return { ok: false, reason: 'monitor window unavailable' }
  const id = ++showsReqSeq
  const pages: string[] = await new Promise((resolve) => {
    const timer = setTimeout(() => { ipcMain.removeListener('tt-shows-result', onResult); resolve([]) }, 15000)
    const onResult = (_e: unknown, res: { id: number; ok: boolean; pages: string[] }) => {
      if (res.id !== id) return
      clearTimeout(timer); ipcMain.removeListener('tt-shows-result', onResult)
      resolve(res.ok ? res.pages : [])
    }
    ipcMain.on('tt-shows-result', onResult)
    monitor!.webContents.send('tt-shows-fetch', { id })
  })
  if (!pages.length) return { ok: true, shows: [], capped: true }
  const shows = pages.flatMap((p) => parseShowList(p))
  if (db) {
    const names: Record<string, { sessionId: string; name: string; startMs: number }> = {}
    roomNameMap(shows).forEach((v, k) => { names[k] = v })
    setShowNames(db, names)
  }
  return { ok: true, shows }
}
```

- [ ] **Step 3: Add the IPC handlers**

Add next to the existing `tt-sync` handler (~line 325):

```ts
ipcMain.handle('tt-shows-list', async () => {
  try { return await fetchShowList() }
  catch (e) { return { ok: false, reason: (e as Error).message.slice(0, 160) } }
})

ipcMain.handle('tt-sync-show', async (_e, arg: { roomIds: string[]; startMs: number; endMs: number }) => {
  if (orderSyncing) return { ok: false, reason: 'Sync already running' }
  if (!(await tiktokLoggedIn())) { openSellerLogin(); return { ok: false, reason: 'Log into TikTok Seller Center (window opened), then Sync again' } }
  orderSyncing = true
  try {
    const cookieHeader = await tiktokCookieHeader()
    const since = arg.startMs - SHOW_SYNC_BUFFER_MS
    const { orders } = await pullTiktokOrdersSince(cookieHeader, since)
    const details = await fetchOrderDetails(orders.map((o) => o.externalOrderId), cookieHeader)
    const enriched = applyOrderDetails(orders, details)
    const kept = filterOrdersForShow(enriched, arg.roomIds, arg.startMs - SHOW_SYNC_BUFFER_MS, arg.endMs + SHOW_SYNC_BUFFER_MS)
    const now = Date.now()
    if (db) { upsertOrders(db, kept, now); rekeyProductTemplates(db, now) }
    debug(`[tt] show-sync kept ${kept.length}/${orders.length} orders`)
    return { ok: true, count: kept.length }
  } catch (e) {
    const msg = (e as Error).message
    if (/code\s|HTTP 401|session may be expired/i.test(msg)) openSellerLogin()
    return { ok: false, reason: msg.slice(0, 160) }
  } finally {
    orderSyncing = false
  }
})
```

> `orderSyncing`, `openSellerLogin`, `openMonitor`, `monitor`, `db`, and `debug` already exist in `main.ts`. If `openMonitor` is named differently (e.g. the body behind the `tt-open-monitor` handler), extract it into a callable function first and reuse it here.

- [ ] **Step 4: Build to verify it compiles**

Run: `node esbuild.mjs`
Expected: builds with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add tiktok-live-poc/src/electron/main.ts
git commit -m "feat(poc): main IPC for show list + scoped per-show sync"
```

---

### Task 9: Renderer — Sync modal, API wiring, real-name threading

**Files:**
- Modify: `tiktok-live-poc/src/electron/preload-viewer.ts` (add `syncAPI.showList` + `syncAPI.syncShow`)
- Modify: `tiktok-live-poc/src/renderer/index.html` (modal markup + styles)
- Modify: `tiktok-live-poc/src/renderer/renderer.ts` (`runSync` rewrite, modal render, thread `roomNames` into derived shows)

**Interfaces:**
- Consumes: `syncAPI.showList()`, `syncAPI.syncShow(arg)`, `syncAPI.now()`, `dbAPI.getSnapshot()` (`showNames`), `showWindowMs` + `type ShowListing` (`core/showList`), `type RoomNameMeta` (`core/showList`).

> Verified by manual QA (Step 7) — UI glue, no unit test.

- [ ] **Step 1: Extend the renderer-facing API**

In `tiktok-live-poc/src/electron/preload-viewer.ts`, replace the `syncAPI` block:

```ts
contextBridge.exposeInMainWorld('syncAPI', {
  now: () => ipcRenderer.invoke('tt-sync'),
  showList: () => ipcRenderer.invoke('tt-shows-list'),
  syncShow: (arg: { roomIds: string[]; startMs: number; endMs: number }) => ipcRenderer.invoke('tt-sync-show', arg),
  connection: () => ipcRenderer.invoke('tt-connection'),
  openMonitor: () => ipcRenderer.invoke('tt-open-monitor'),
})
```

- [ ] **Step 2: Add the modal markup + styles to `index.html`**

Add before `</body>` in `tiktok-live-poc/src/renderer/index.html`:

```html
<div id="showModal" class="show-modal" style="display:none">
  <div class="show-modal-card">
    <div class="show-modal-top">
      <span>Sync orders — pick a show</span>
      <button id="showModalClose" class="show-modal-x" aria-label="Close">✕</button>
    </div>
    <div class="show-modal-full" id="showFull">
      <div><div class="sm-lbl">↻ Full sync</div><div class="sm-sub">Pull entire order history</div></div>
      <span class="sm-go">Sync all</span>
    </div>
    <div id="showList" class="show-modal-list"><div class="sm-empty">Loading shows…</div></div>
  </div>
</div>
```

Add to the stylesheet (the `<style>` block in `index.html`):

```css
.show-modal { position:fixed; inset:0; background:rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; z-index:1000; }
.show-modal-card { width:560px; max-width:92vw; max-height:80vh; overflow:hidden; display:flex; flex-direction:column; background:#0e0f13; border:1px solid #2a2d36; border-radius:10px; }
.show-modal-top { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-bottom:1px solid #2a2d36; background:#15171d; font-weight:600; }
.show-modal-x { background:none; border:none; color:#7b8090; cursor:pointer; font-size:14px; }
.show-modal-full { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:#161a22; border-bottom:1px solid #2a2d36; cursor:pointer; }
.show-modal-full:hover { background:#1b2030; }
.sm-lbl { font-weight:600; } .sm-sub { color:#7b8090; font-size:11px; } .sm-go { color:#6ea8ff; font-size:11px; }
.show-modal-list { overflow:auto; }
.sm-row { padding:9px 14px; border-bottom:1px solid #20232b; display:flex; align-items:center; gap:10px; cursor:pointer; }
.sm-row:hover { background:#161a22; }
.sm-nm { font-weight:600; } .sm-meta { color:#8a90a0; font-size:11px; }
.sm-right { margin-left:auto; text-align:right; white-space:nowrap; }
.sm-synced { color:#4ec98a; font-size:11px; } .sm-empty { padding:20px 14px; color:#8a90a0; }
```

- [ ] **Step 3: Add the API type to the renderer's window typings**

In `tiktok-live-poc/src/renderer/renderer.ts`, find the `syncAPI?: { … }` typing block (~line 45) and extend it to match the preload:

```ts
    syncAPI?: {
      now: () => Promise<{ ok: boolean; count?: number; reason?: string }>
      showList: () => Promise<{ ok: boolean; shows?: import('../core/showList').ShowListing[]; needsLogin?: boolean; capped?: boolean; reason?: string }>
      syncShow: (arg: { roomIds: string[]; startMs: number; endMs: number }) => Promise<{ ok: boolean; count?: number; reason?: string }>
      connection: () => Promise<{ loggedIn: boolean; hasShow: boolean }>
      openMonitor: () => Promise<unknown>
    }
```

- [ ] **Step 4: Thread real names into derived shows**

In `renderer.ts`, add imports at the top (add a `core/showList` import alongside the existing `core/sessions` one). The renderer only needs the window helper and the name type — main does the parsing:

```ts
import { showWindowMs, type RoomNameMeta } from '../core/showList'
```

Add a module-level names map near `syncedOrders` (~line 716):

```ts
let roomNames = new Map<string, RoomNameMeta>()
```

Change `ensureDerivedShows` (line ~722) to pass the names:

```ts
function ensureDerivedShows(): void {
  if (_derivedShowsSrc === syncedOrders) return
  const r = deriveShowsFromOrders(syncedOrders, roomNames)
  derivedShows = r.shows
  showIdByOrder = r.showIdByOrder
  _derivedShowsSrc = syncedOrders
}
```

In `hydrateFromDb` (where `syncedOrders` is assigned from the snapshot), populate `roomNames` from `snapshot.showNames` and invalidate the cache. Add right after `syncedOrders` is set:

```ts
  // build the roomId→name map so derived shows render real titles
  roomNames = new Map(Object.entries(snapshot.showNames ?? {}).map(([roomId, v]) => [roomId, v as RoomNameMeta]))
  _derivedShowsSrc = null // force re-derive with the names
```

> If `hydrateFromDb` names the snapshot variable differently, adapt the `snapshot.` reference. `DbSnapshot.showNames` exists from Task 6.

- [ ] **Step 5: Rewrite `runSync` to open the modal; add modal render + actions**

Replace `runSync` (lines ~1387-1411) with:

```ts
async function runSync() {
  if (syncing) return
  if (!window.syncAPI) { await new Promise((r) => window.setTimeout(r, 900)); flashSync('✓ Synced'); return }
  openShowModal()
}

function showModalEl(): HTMLElement | null { return document.getElementById('showModal') }

function closeShowModal() { const m = showModalEl(); if (m) m.style.display = 'none' }

async function openShowModal() {
  const modal = showModalEl(); const list = document.getElementById('showList')
  if (!modal || !list) return
  modal.style.display = 'flex'
  list.innerHTML = '<div class="sm-empty">Loading shows…</div>'
  const res = await window.syncAPI!.showList()
  if (res.needsLogin) { list.innerHTML = '<div class="sm-empty">Log into TikTok, then click Sync again.</div>'; return }
  const shows = res.shows ?? []
  if (!shows.length) {
    list.innerHTML = `<div class="sm-empty">${res.capped ? "Couldn't load shows — use Full sync above." : 'No shows found.'}</div>`
    return
  }
  // how many orders we already have per room, to show the synced status
  const haveByRoom = new Map<string, number>()
  for (const s of syncedOrders) if (s.roomId) haveByRoom.set(s.roomId, (haveByRoom.get(s.roomId) ?? 0) + 1)
  const fmtDate = (sec: number) => new Date(sec * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const fmtDur = (sec: number) => { const m = Math.round(sec / 60); const h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : `${m}m` }
  list.innerHTML = ''
  for (const sh of shows) {
    const have = sh.roomIds.reduce((n, r) => n + (haveByRoom.get(r) ?? 0), 0)
    const chips = [sh.productCnt != null ? `${sh.productCnt} products` : '', sh.reservations != null ? `${sh.reservations} reserved` : ''].filter(Boolean).join(' · ')
    const row = document.createElement('div')
    row.className = 'sm-row'
    row.innerHTML =
      `<div style="flex:1;min-width:0"><div class="sm-nm"></div>` +
      `<div class="sm-meta">${fmtDate(sh.startTime)} · ${fmtDur(sh.durationSec)}${chips ? ' · ' + chips : ''}</div></div>` +
      `<div class="sm-right">${have ? `<span class="sm-synced">✓ ${have} orders</span>` : '<span class="sm-go">Sync →</span>'}</div>`
    ;(row.querySelector('.sm-nm') as HTMLElement).textContent = sh.name // textContent avoids HTML injection from names
    row.addEventListener('click', () => void syncOneShow(sh))
    list.appendChild(row)
  }
}

async function syncOneShow(sh: import('../core/showList').ShowListing) {
  if (syncing) return
  syncing = true
  const navSync = document.getElementById('navSync'); navSync?.classList.add('syncing')
  try {
    const { startMs, endMs } = showWindowMs(sh)
    const res = await window.syncAPI!.syncShow({ roomIds: sh.roomIds, startMs, endMs })
    if (res.ok) {
      await hydrateFromDb()
      if (selectedShowId === 'live' && syncedOrders.length) selectedShowId = 'all'
      refreshShowOptions(); renderLedger(); renderPicklist()
      flashSync(`✓ ${res.count ?? 0} orders`)
      closeShowModal()
    } else { flashSync('⚠ ' + (res.reason ?? 'failed')); console.warn('sync-show:', res.reason) }
    await refreshConnection()
  } finally { navSync?.classList.remove('syncing'); syncing = false }
}

async function fullSync() {
  if (syncing) return
  syncing = true
  const navSync = document.getElementById('navSync'); navSync?.classList.add('syncing')
  try {
    const res = await window.syncAPI!.now()
    if (res.ok) {
      await hydrateFromDb()
      if (selectedShowId === 'live' && syncedOrders.length) selectedShowId = 'all'
      refreshShowOptions(); renderLedger(); renderPicklist()
      flashSync(`✓ ${res.count ?? ''} orders`.replace('  ', ' ')); closeShowModal()
    } else { flashSync('⚠ ' + (res.reason ?? 'failed')); console.warn('sync:', res.reason) }
    await refreshConnection()
  } finally { navSync?.classList.remove('syncing'); syncing = false }
}
```

- [ ] **Step 6: Wire the modal's close + full-sync buttons**

In `setupSync` (line ~1413), add after the existing listeners:

```ts
  document.getElementById('showModalClose')?.addEventListener('click', closeShowModal)
  document.getElementById('showFull')?.addEventListener('click', () => void fullSync())
  document.getElementById('showModal')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeShowModal() })
```

- [ ] **Step 7: Build, run, manual QA**

Run: `node esbuild.mjs` (expect clean build), then `npm run dev`.

Manual checklist (log into TikTok when prompted):
- Click **Sync** → modal opens, lists real show names (e.g. "Alo Yoga and More - Final Sale") newest-first, with date/duration and a `Sync →` / `✓ N orders` status.
- Click a show → only that show's orders sync; toast shows the count; modal closes.
- The ledger **Filter by Show** dropdown now shows the **real show name** for that room (not `LIVE · <date>`).
- Click **Sync** again → **Full sync** row → pulls the full history (today's behavior); modal closes.
- Re-sync the same show → no duplicate orders (upsert).

- [ ] **Step 8: Commit**

```bash
git add tiktok-live-poc/src/electron/preload-viewer.ts tiktok-live-poc/src/renderer/index.html tiktok-live-poc/src/renderer/renderer.ts
git commit -m "feat(poc): Sync show-picker modal + real show names in ledger filter"
```

---

## Final verification

- [ ] Run the full suite: `cd tiktok-live-poc && npm test` — expect all green.
- [ ] `node esbuild.mjs` — clean build.
- [ ] Manual QA checklist (Task 9, Step 7) passes end-to-end.
