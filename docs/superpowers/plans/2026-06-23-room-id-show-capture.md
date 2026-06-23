# Room-ID Show Capture + Filter-by-Show Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group the synced TikTok order book into real LIVE shows by `live_room_id` (with a 2.5h time-gap fallback) and drive the Ledger/Picklist show filter from it.

**Architecture:** Add `roomId` to the portable `Sale` model and surface it through the order mapper + SQLite snapshot. A new pure `core/sessions.ts` (ported from `live-ledger`) groups orders by room id, falling back to time-gap clustering for orders with no room id. The renderer's synced-orders show picker and filter consume this derivation. The real-time live-capture path (`core/shows.ts`) is untouched.

**Tech Stack:** TypeScript, Electron (main + preload + renderer), `better-sqlite3`, Vitest, esbuild.

**Reference spec:** `docs/superpowers/specs/2026-06-23-room-id-show-capture-design.md`

## Global Constraints

- All commands run from the `tiktok-live-poc/` directory (repo root is `sellerfolio-platform/`).
- `core/` modules are **pure** — zero `electron`/DOM/network imports (so they stay unit-testable).
- `live_room_id` is treated as an **opaque string** everywhere — never parsed as a number (it exceeds 2^53).
- The live-capture path (`core/shows.ts`, `showStore`, `currentShow`, the `'Live (current)'` / `'All shows'` options) is **not** modified.
- Show label/title = the order group's `liveTag` text when present, else date-derived `LIVE · <date>`.
- TDD throughout: failing test → minimal code → green → commit. Run the full suite with `npm test`.

---

### Task 1: Pure time-gap clustering primitives (`core/sessions.ts`)

Port `live-ledger`'s clustering primitives into the PoC core. No `Sale` dependency yet — just the generic clustering, the stable derived id, and the date title.

**Files:**
- Create: `src/core/sessions.ts`
- Test: `src/core/__tests__/sessions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SESSION_GAP_MS: number` (= `2.5 * 60 * 60 * 1000`)
  - `interface ClusterItem { id: string; t: number }` (`t` = epoch ms)
  - `interface Session { startMs: number; endMs: number; ids: string[] }`
  - `clusterByTime(items: ClusterItem[], gapMs?: number): Session[]`
  - `derivedShowId(startMs: number): string` → `` `live-${Math.floor(startMs/1000)}` ``
  - `deriveTitle(startMs: number): string` → `` `LIVE · <date>` ``

- [ ] **Step 1: Write the failing test**

Create `src/core/__tests__/sessions.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { clusterByTime, derivedShowId, deriveTitle, SESSION_GAP_MS } from '../sessions'

describe('clusterByTime', () => {
  it('groups items within the gap into one session', () => {
    const s = clusterByTime([{ id: 'a', t: 0 }, { id: 'b', t: 1000 }])
    expect(s).toHaveLength(1)
    expect(s[0]!.ids).toEqual(['a', 'b'])
    expect(s[0]!.startMs).toBe(0)
    expect(s[0]!.endMs).toBe(1000)
  })

  it('splits when the gap from the previous item exceeds the threshold', () => {
    const s = clusterByTime([{ id: 'a', t: 0 }, { id: 'b', t: SESSION_GAP_MS + 1 }])
    expect(s).toHaveLength(2)
  })

  it('keeps items exactly at the threshold in the same session (diff == gap, not > gap)', () => {
    const s = clusterByTime([{ id: 'a', t: 0 }, { id: 'b', t: SESSION_GAP_MS }])
    expect(s).toHaveLength(1)
  })

  it('sorts by time and drops non-finite timestamps', () => {
    const s = clusterByTime([{ id: 'b', t: 1000 }, { id: 'a', t: 0 }, { id: 'x', t: NaN }])
    expect(s).toHaveLength(1)
    expect(s[0]!.ids).toEqual(['a', 'b'])
  })
})

describe('derivedShowId', () => {
  it('is keyed on the start second (stable across sub-second re-runs)', () => {
    expect(derivedShowId(1718900000123)).toBe('live-1718900000')
    expect(derivedShowId(1718900000999)).toBe('live-1718900000')
  })
})

describe('deriveTitle', () => {
  it('renders a "LIVE · <date>" label', () => {
    expect(deriveTitle(1718900000000)).toMatch(/^LIVE · /)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/__tests__/sessions.test.ts`
Expected: FAIL — `Failed to resolve import "../sessions"` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/core/sessions.ts`:

```ts
// Pure time-gap clustering of orders into LIVE sessions — ported from live-ledger's sessions.ts.
// A new session starts when the gap from the previous order exceeds the threshold. TikTok orders
// without a live_room_id carry no show key, so a "show" is reconstructed from when they were placed.
// Zero electron/DOM deps so it stays unit-testable.

export const SESSION_GAP_MS = 2.5 * 60 * 60 * 1000 // 2.5h — same threshold live-ledger uses

export interface ClusterItem {
  id: string
  t: number // epoch milliseconds
}

export interface Session {
  startMs: number
  endMs: number
  ids: string[]
}

/** Group items into sessions by time gap. Items without a finite timestamp are dropped. */
export function clusterByTime(items: ClusterItem[], gapMs: number = SESSION_GAP_MS): Session[] {
  const sorted = items.filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t)
  const sessions: Session[] = []
  let cur: Session | null = null
  for (const x of sorted) {
    if (!cur || x.t - cur.endMs > gapMs) {
      cur = { startMs: x.t, endMs: x.t, ids: [] }
      sessions.push(cur)
    }
    cur.endMs = x.t
    cur.ids.push(x.id)
  }
  return sessions
}

/** Stable id for a derived (no-room-id) show, keyed on the session start second so re-clustering
 *  the same orders maps to the same show id (idempotent). */
export function derivedShowId(startMs: number): string {
  return `live-${Math.floor(startMs / 1000)}`
}

/** Human title for a derived show when no live-show tag is available. */
export function deriveTitle(startMs: number): string {
  return 'LIVE · ' + new Date(startMs).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/__tests__/sessions.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/sessions.ts src/core/__tests__/sessions.test.ts
git commit -m "feat(poc): pure time-gap clustering primitives for show derivation"
```

---

### Task 2: `Sale.roomId` + `deriveShowsFromOrders` (room-id grouping with fallback)

Add the `roomId` field to the portable `Sale` model and the pure derivation that groups orders into shows by room id, falling back to time-gap clustering.

**Files:**
- Modify: `src/core/types.ts` (the `Sale` interface, after `liveTag` at `:195`)
- Modify: `src/core/sessions.ts` (append the derivation)
- Test: `src/core/__tests__/sessions.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `clusterByTime`, `derivedShowId`, `deriveTitle` (Task 1); `Sale` (`core/types.ts`).
- Produces:
  - `interface DerivedShow { id: string; title: string; startMs: number; endMs: number; count: number }`
  - `deriveShowsFromOrders(sales: Sale[]): { shows: DerivedShow[]; showIdByOrder: Map<string, string> }`
  - `shows` is sorted by `startMs` **descending**; `id` is the `roomId` or `live-<sec>`; orders without a room id are clustered by `createdAt`.

- [ ] **Step 1: Write the failing test**

Add the `roomId` field first so the test compiles. In `src/core/types.ts`, the `Sale` interface currently has (around `:195`):

```ts
  liveTag?: string // Seller-Center live-show tag (from order/list); groups synced orders by show
```

Add directly below it:

```ts
  roomId?: string // live_room_id — the stable TikTok LIVE room key (groups orders into a real show)
```

Then append to `src/core/__tests__/sessions.test.ts`:

```ts
import type { Sale } from '../types'
import { deriveShowsFromOrders } from '../sessions'

function sale(orderId: string, overrides: Partial<Sale> = {}): Sale {
  return {
    orderId,
    buyer: { username: 'A' },
    productId: 'p',
    productName: 'X',
    skuDesc: '#1',
    price: { cents: 100, formatted: '$1' },
    paymentStatus: 'paid',
    createdAt: 1,
    ...overrides,
  }
}

describe('deriveShowsFromOrders', () => {
  it('groups orders by roomId and sorts shows by startMs desc', () => {
    const { shows, showIdByOrder } = deriveShowsFromOrders([
      sale('o1', { roomId: 'R1', createdAt: 100 }),
      sale('o2', { roomId: 'R1', createdAt: 200 }),
      sale('o3', { roomId: 'R2', createdAt: 300 }),
    ])
    expect(shows.map((s) => s.id)).toEqual(['R2', 'R1']) // R2 startMs 300, R1 startMs 100
    expect(shows.find((s) => s.id === 'R1')!.count).toBe(2)
    expect(showIdByOrder.get('o1')).toBe('R1')
    expect(showIdByOrder.get('o3')).toBe('R2')
  })

  it('time-gap clusters orders with no roomId into live-<sec> shows', () => {
    const { shows, showIdByOrder } = deriveShowsFromOrders([
      sale('a', { createdAt: 0 }),
      sale('b', { createdAt: 1000 }), // same session as a
      sale('c', { createdAt: SESSION_GAP_MS + 2000 }), // new session
    ])
    expect(shows).toHaveLength(2)
    expect(showIdByOrder.get('a')).toBe(showIdByOrder.get('b'))
    expect(showIdByOrder.get('a')).not.toBe(showIdByOrder.get('c'))
    expect(shows.every((s) => s.id.startsWith('live-'))).toBe(true)
  })

  it('handles a mix of room-id and no-room-id orders', () => {
    const { shows, showIdByOrder } = deriveShowsFromOrders([
      sale('o1', { roomId: 'R1', createdAt: 500 }),
      sale('o2', { createdAt: 100 }),
    ])
    expect(shows).toHaveLength(2)
    expect(showIdByOrder.get('o1')).toBe('R1')
    expect(showIdByOrder.get('o2')).toMatch(/^live-/)
  })

  it('titles a show from its liveTag when present, else a derived date', () => {
    const { shows } = deriveShowsFromOrders([
      sale('o1', { roomId: 'R1', liveTag: 'LIVE 6/20', createdAt: 100 }),
      sale('o2', { roomId: 'R2', createdAt: 200 }),
    ])
    expect(shows.find((s) => s.id === 'R1')!.title).toBe('LIVE 6/20')
    expect(shows.find((s) => s.id === 'R2')!.title).toMatch(/^LIVE · /)
  })

  it('maps every order in showIdByOrder', () => {
    const { showIdByOrder } = deriveShowsFromOrders([
      sale('o1', { roomId: 'R1' }),
      sale('o2', { createdAt: 5 }),
    ])
    expect([...showIdByOrder.keys()].sort()).toEqual(['o1', 'o2'])
  })

  it('returns empty results for no orders', () => {
    expect(deriveShowsFromOrders([])).toEqual({ shows: [], showIdByOrder: new Map() })
  })
})
```

> Note: `SESSION_GAP_MS` is already imported at the top of the file from Task 1; do not import it twice.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/__tests__/sessions.test.ts`
Expected: FAIL — `deriveShowsFromOrders is not a function` / `not exported`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/core/sessions.ts`:

```ts
import type { Sale } from './types'

export interface DerivedShow {
  id: string // roomId, or `live-<sec>` for a fallback (no-room-id) cluster
  title: string // group's liveTag text if present, else deriveTitle(startMs)
  startMs: number // earliest createdAt in the group
  endMs: number // latest createdAt in the group
  count: number // number of orders
}

/** Group synced orders into shows. Orders with a live_room_id group by that room (the authoritative
 *  show key); orders without one are time-gap clustered into derived date-titled shows.
 *  Returns the shows (most recent first) plus an orderId -> showId map for filtering. */
export function deriveShowsFromOrders(sales: Sale[]): {
  shows: DerivedShow[]
  showIdByOrder: Map<string, string>
} {
  const showIdByOrder = new Map<string, string>()
  const groups = new Map<string, Sale[]>() // showId -> sales

  // 1. Orders WITH a room id group by room id.
  const noRoom: Sale[] = []
  for (const s of sales) {
    if (s.roomId) {
      const g = groups.get(s.roomId) ?? []
      g.push(s)
      groups.set(s.roomId, g)
      showIdByOrder.set(s.orderId, s.roomId)
    } else {
      noRoom.push(s)
    }
  }

  // 2. Orders WITHOUT a room id: time-gap cluster into fallback shows.
  const saleById = new Map(noRoom.map((s) => [s.orderId, s] as const))
  for (const session of clusterByTime(noRoom.map((s) => ({ id: s.orderId, t: s.createdAt })))) {
    const id = derivedShowId(session.startMs)
    const g = groups.get(id) ?? []
    for (const oid of session.ids) {
      g.push(saleById.get(oid)!)
      showIdByOrder.set(oid, id)
    }
    groups.set(id, g)
  }

  // 3. Build per-group metadata.
  const shows: DerivedShow[] = []
  for (const [id, g] of groups) {
    let startMs = Infinity
    let endMs = -Infinity
    let title = ''
    for (const s of g) {
      if (s.createdAt < startMs) startMs = s.createdAt
      if (s.createdAt > endMs) endMs = s.createdAt
      if (!title && s.liveTag) title = s.liveTag
    }
    if (!title) title = deriveTitle(startMs)
    shows.push({ id, title, startMs, endMs, count: g.length })
  }

  shows.sort((a, b) => b.startMs - a.startMs)
  return { shows, showIdByOrder }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/__tests__/sessions.test.ts`
Expected: PASS (all `clusterByTime`, `derivedShowId`, `deriveTitle`, and `deriveShowsFromOrders` tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/sessions.ts src/core/__tests__/sessions.test.ts
git commit -m "feat(poc): derive shows from orders by room id with time-gap fallback"
```

---

### Task 3: Capture `roomId` into the Sale + overlay the DB column

Populate `roomId` on the `Sale` produced by `orderToSale` so it persists in `sale_json`, and overlay the existing `room_id` column onto sales synced before this change (whose `sale_json` lacks the field).

**Files:**
- Modify: `src/electron/tiktok-orders.ts` (the `orderToSale` return object, after `liveTag` at `:208`)
- Modify: `src/electron/db.ts` (`getSnapshot`, the orders query at `:108-109`)
- Test: `src/electron/__tests__/db.test.ts` (append two tests)

**Interfaces:**
- Consumes: `Sale.roomId` (Task 2); `MappedOrder.roomId` (already exists, `tiktok-orders.ts:70`); `orders.room_id` column (already exists, `db.ts:25`).
- Produces: `getSnapshot(db).orders[i].roomId` is populated whenever the order has a room id (from `sale_json` or the column overlay).

- [ ] **Step 1: Write the failing test**

Append to `src/electron/__tests__/db.test.ts` (inside the existing `describe('db: orders', …)` block, or as a new `describe`):

```ts
describe('db: roomId', () => {
  it('carries roomId from a mapped order into the snapshot Sale', () => {
    const db = openDb(':memory:')
    const o = mapTiktokOrder(fixture)
    o.roomId = '7653571353936759566'
    upsertOrders(db, [o], 1000)
    expect(getSnapshot(db).orders[0]!.roomId).toBe('7653571353936759566')
    db.close()
  })

  it('overlays the room_id column onto a legacy sale_json that lacks roomId', () => {
    const db = openDb(':memory:')
    // a row synced before roomId existed on Sale: sale_json has no roomId, column is set.
    db.prepare('INSERT INTO orders (order_id, room_id, placed_at, payment_status, sale_json) VALUES (?,?,?,?,?)')
      .run('O1', '7653571353936759566', 100, 'paid', JSON.stringify({
        orderId: 'O1', buyer: { username: 'A' }, productId: 'p', productName: 'X',
        price: { cents: 100, formatted: '$1' }, paymentStatus: 'paid', createdAt: 100,
      }))
    expect(getSnapshot(db).orders[0]!.roomId).toBe('7653571353936759566')
    db.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/electron/__tests__/db.test.ts`
Expected: FAIL — both new tests report `roomId` is `undefined` (mapper doesn't copy it; `getSnapshot` doesn't overlay).

- [ ] **Step 3: Write minimal implementation**

In `src/electron/tiktok-orders.ts`, the `orderToSale` return object has (around `:208`):

```ts
    createdAt: o.placedAt ?? Date.now(),
    liveTag: o.liveTag ?? undefined,
```

Add the `roomId` line below `liveTag`:

```ts
    createdAt: o.placedAt ?? Date.now(),
    liveTag: o.liveTag ?? undefined,
    roomId: o.roomId ?? undefined,
```

In `src/electron/db.ts`, `getSnapshot` currently begins (`:108-109`):

```ts
  const orders = (db.prepare('SELECT sale_json FROM orders ORDER BY placed_at DESC').all() as { sale_json: string }[])
    .map((r) => JSON.parse(r.sale_json) as Sale)
```

Replace those two lines with:

```ts
  const orders = (db.prepare('SELECT sale_json, room_id FROM orders ORDER BY placed_at DESC').all() as { sale_json: string; room_id: string | null }[])
    .map((r) => {
      const sale = JSON.parse(r.sale_json) as Sale
      // back-fill rows synced before roomId was added to Sale (sale_json lacks it, column has it)
      if (sale.roomId == null && r.room_id != null) sale.roomId = r.room_id
      return sale
    })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/electron/__tests__/db.test.ts`
Expected: PASS (existing tests + the two new `db: roomId` tests).

- [ ] **Step 5: Commit**

```bash
git add src/electron/tiktok-orders.ts src/electron/db.ts src/electron/__tests__/db.test.ts
git commit -m "feat(poc): persist Sale.roomId and overlay room_id for legacy rows"
```

---

### Task 4: Drive the Ledger/Picklist show filter from room-id shows

Replace the renderer's `liveTag`-text grouping (`SHOW_OF`) with the room-id derivation for the synced order book. The live-capture branch and the Ledger ⇄ Picklist sync are untouched.

**Files:**
- Modify: `src/renderer/renderer.ts` (import `:4`; `SHOW_OF` def `:715`; `sourceSales` `:780-786`; `refreshShowOptions` synced branch `:795-809`)
- Verify: `npm test`, `npx tsc --noEmit`

**Interfaces:**
- Consumes: `deriveShowsFromOrders`, `DerivedShow` (Task 2).
- Produces: no new exported interface — internal renderer wiring only.

- [ ] **Step 1: Add the import**

In `src/renderer/renderer.ts`, after the existing shows import (`:4`):

```ts
import { upsertShow, listShows, salesForShow, type ShowMeta, type ShowStore } from '../core/shows'
```

add:

```ts
import { deriveShowsFromOrders, type DerivedShow } from '../core/sessions'
```

- [ ] **Step 2: Replace `SHOW_OF` with a derived-shows cache**

Current (`:713-715`):

```ts
// Synced order book from Seller-Center order/list (decoupled from the live stream). When present
// it is the Ledger/Picklist source; grouped into "shows" by the live-show tag on each order.
let syncedOrders: Sale[] = []
const SHOW_OF = (s: Sale) => s.liveTag || 'Other orders'
```

Replace with:

```ts
// Synced order book from Seller-Center order/list (decoupled from the live stream). When present
// it is the Ledger/Picklist source; grouped into real shows by live_room_id (time-gap fallback).
let syncedOrders: Sale[] = []
// Derived-shows cache for the synced order book. Recomputed only when the syncedOrders array
// reference changes (it is reassigned on sync/hydrate, never mutated in place).
let _derivedShowsSrc: Sale[] | null = null
let derivedShows: DerivedShow[] = []
let showIdByOrder = new Map<string, string>()
function ensureDerivedShows(): void {
  if (_derivedShowsSrc === syncedOrders) return
  const r = deriveShowsFromOrders(syncedOrders)
  derivedShows = r.shows
  showIdByOrder = r.showIdByOrder
  _derivedShowsSrc = syncedOrders
}
```

- [ ] **Step 3: Filter `sourceSales` by derived show id**

Current (`:780-786`):

```ts
function sourceSales(): Sale[] {
  if (syncedOrders.length) {
    if (selectedShowId === 'live' || selectedShowId === 'all') return syncedOrders
    return syncedOrders.filter((s) => SHOW_OF(s) === selectedShowId)
  }
  return selectedShowId === 'live' ? allSales : salesForShow(showStore, selectedShowId)
}
```

Replace the body's synced branch:

```ts
function sourceSales(): Sale[] {
  if (syncedOrders.length) {
    if (selectedShowId === 'live' || selectedShowId === 'all') return syncedOrders
    ensureDerivedShows()
    return syncedOrders.filter((s) => showIdByOrder.get(s.orderId) === selectedShowId)
  }
  return selectedShowId === 'live' ? allSales : salesForShow(showStore, selectedShowId)
}
```

- [ ] **Step 4: Build the picker options from derived shows**

Current synced branch inside `refreshShowOptions` (`:795-809`):

```ts
  if (syncedOrders.length) {
    const fmtDur = (ms: number) => { if (ms <= 0) return ''; const m = Math.round(ms / 60000); const h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : `${m}m` }
    const agg = new Map<string, { count: number; minT: number; maxT: number }>()
    for (const s of syncedOrders) {
      const tag = SHOW_OF(s)
      const e = agg.get(tag) ?? { count: 0, minT: Infinity, maxT: -Infinity }
      e.count++; if (s.createdAt < e.minT) e.minT = s.createdAt; if (s.createdAt > e.maxT) e.maxT = s.createdAt
      agg.set(tag, e)
    }
    opts.push({ value: 'all', label: `All orders (${syncedOrders.length})` })
    for (const [tag, e] of [...agg.entries()].sort((a, b) => b[1].maxT - a[1].maxT)) {
      const date = Number.isFinite(e.minT) ? new Date(e.minT).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
      const sub = [date, `${e.count} items`, fmtDur(e.maxT - e.minT)].filter(Boolean).join(' · ')
      opts.push({ value: tag, label: sub ? `${tag} · ${sub}` : tag })
    }
  } else {
```

Replace with:

```ts
  if (syncedOrders.length) {
    ensureDerivedShows()
    const fmtDur = (ms: number) => { if (ms <= 0) return ''; const m = Math.round(ms / 60000); const h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : `${m}m` }
    opts.push({ value: 'all', label: `All orders (${syncedOrders.length})` })
    for (const sh of derivedShows) {
      const date = Number.isFinite(sh.startMs) ? new Date(sh.startMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
      const sub = [date, `${sh.count} items`, fmtDur(sh.endMs - sh.startMs)].filter(Boolean).join(' · ')
      opts.push({ value: sh.id, label: sub ? `${sh.title} · ${sub}` : sh.title })
    }
  } else {
```

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS — all suites green (core `sessions`, `shows`, electron `db`, and the rest unchanged).

- [ ] **Step 6: Type-check the renderer**

esbuild does not type-check, so verify types explicitly.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors (in particular, no unused `SHOW_OF`, and `deriveShowsFromOrders`/`DerivedShow` resolve).

- [ ] **Step 7: Manual verification (renderer has no DOM tests)**

Build and launch, then confirm the filter behaves:

Run: `npm run dev`
Then in the app: click **Sync orders**, open the **Ledger**, and open the show dropdown.
Expected:
- The dropdown lists **All orders (N)** plus one entry **per LIVE room** (label `<liveTag or LIVE · date> · <date> · <n> items · <duration>`), most recent first — no single "Other orders" bucket for tagged rooms.
- Selecting a show filters the Ledger rows to that room; the **Picklist** dropdown mirrors the selection.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/renderer.ts
git commit -m "feat(poc): filter Ledger/Picklist by room-id shows instead of live-tag text"
```

---

## Self-Review

**Spec coverage:**
- §3.1 `Sale.roomId` → Task 2 Step 1. ✓
- §3.2 capture (`orderToSale`) + DB overlay (`getSnapshot`) → Task 3. ✓
- §3.3 `core/sessions.ts` clustering primitives → Task 1. ✓
- §3.4 `deriveShowsFromOrders` → Task 2. ✓
- §3.5 renderer filter wiring (synced branch only; live branch untouched) → Task 4. ✓
- §5 testing (sessions + deriveShowsFromOrders specs; shows.test.ts untouched) → Tasks 1–2; DB tests in Task 3. ✓
- §6 risks: opaque string roomId (Task 3 uses strings only), pre-change rows (Task 3 overlay), createdAt clustering source (Task 2). ✓
- Goal 5 "live monitor untouched" → no task modifies `core/shows.ts` / `showStore` / `currentShow`. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code and exact commands. ✓

**Type consistency:** `clusterByTime`/`derivedShowId`/`deriveTitle`/`SESSION_GAP_MS` (Task 1) used verbatim in Task 2. `DerivedShow` fields (`id/title/startMs/endMs/count`) defined in Task 2, consumed identically in Task 4. `deriveShowsFromOrders` return shape `{ shows, showIdByOrder }` consistent across Tasks 2 and 4. `Sale.roomId` defined in Task 2, populated in Task 3, read in Task 4. ✓
