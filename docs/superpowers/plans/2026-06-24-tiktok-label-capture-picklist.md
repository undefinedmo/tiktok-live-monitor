# TikTok Label Capture + Picklist Revamp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the TikTok shipping-label batch PDF passively inside `tiktok-live-poc`, tie each label page to its order record, and surface an interactive picklist console plus the reordered-labels + packing-sheet exports — eliminating the manual upload step of the standalone `tiktok-label-restack` tool.

**Architecture:** A preload on the Seller-Center window intercepts the `shipping_doc/generate` request+response; the main process downloads the pre-signed `doc_url`, ties each page to an order via the ordered `fulfill_unit_id_list` joined to `orders.fulfill_unit_id`, persists batch/page rows to SQLite, and the viewer renders an interactive picklist. The restack ordering/packing-sheet logic is ported to TypeScript and runs in-process. Barcode decode is a verification/fallback path, built last.

**Tech Stack:** Electron 33, TypeScript 5.6, better-sqlite3, esbuild, vitest, `pdf-lib` (new). Barcode fallback (later) adds `zxing-wasm` + a rasterizer.

## Global Constraints

- PoC-only; **no** changes to the shared Postgres schema or the desktop/web/v2 apps.
- Capture is **passive**: the seller still clicks Print in the TikTok dashboard. Never replay/forge `shipping_doc/generate`.
- The label PDF (which contains buyer addresses) is stored under `app.getPath('userData')/labels/<batch_id>.pdf` and is **never** included in any order-data snapshot/sync/export. The existing `stripForStorage` address-stripping for `sale_json` stays intact.
- Primary tie: PDF page `i` → `fulfill_unit_id_list[i]` → `orders.fulfill_unit_id` (fans out to several orders for a combined shipment). Barcode decode is fallback only.
- Restack ordering must be **byte-stable deterministic** (same input → identical sequence). Buyers ordered newest-first by their oldest order; within a buyer, oldest order first; time ties broken by buyer name descending (faithful port of `sortlogic.py`'s single reverse sort).
- Tests live in `__tests__/*.test.ts` next to the module; run with `npx vitest run`.
- Build with `node esbuild.mjs`; the app builds + runs with `npm run dev`.
- Nothing is silently dropped — unmatched pages/orders, missing bins, and count mismatches surface as warnings.

## File Structure

**New files:**
- `src/core/restack/bins.ts` — bin (A/B/?) derivation from product name. Pure.
- `src/core/restack/sortlogic.ts` — buyer grouping + restack ordering. Pure.
- `src/core/restack/tie.ts` — page→unit→order tie resolver. Pure.
- `src/core/restack/capture.ts` — parse the generate request/response into a typed struct. Pure.
- `src/core/restack/__tests__/{bins,sortlogic,tie,capture}.test.ts` — unit tests.
- `src/electron/labels.ts` — capture handler I/O: download `doc_url`, persist, notify.
- `src/electron/label-pdf.ts` — `pdf-lib` reorder / extract / packing-sheet builders.
- `src/electron/label-decode.ts` — **optional** barcode verify/fallback (Task 12).
- `src/electron/preload-seller.ts` — Seller-Center window fetch/XHR interceptor.
- `src/electron/__tests__/{labels,label-pdf}.test.ts` — module tests.
- `src/renderer/picklist.ts` — the picklist view (imported by `renderer.ts`).

**Modified files:**
- `src/electron/db.ts` — migration v2: `orders.fulfill_unit_id`/`tracking_no`, `picks.packed_at`, `label_batch`/`label_page` tables + accessors.
- `src/electron/main.ts` — seller-window preload wiring, `tt-label-batch` handler, picklist IPC handlers, label PDF dir.
- `src/electron/preload-viewer.ts` — `picklistAPI` bridge.
- `src/renderer/renderer.ts` — mount the picklist view + nav.
- `src/renderer/index.html` — picklist container + nav entry.
- `esbuild.mjs` — build `preload-seller.ts`.
- `package.json` — add `pdf-lib`.

---

### Task 1: Add pdf-lib + page-count helper + spike checklist

**Files:**
- Modify: `package.json`
- Create: `src/electron/label-pdf.ts`
- Test: `src/electron/__tests__/label-pdf.test.ts`

**Interfaces:**
- Produces: `pdfPageCount(bytes: Uint8Array): Promise<number>` — used by the tie/capture code to compare page count vs unit count.

- [ ] **Step 1: Install pdf-lib**

Run: `npm install pdf-lib@^1.17.1`
Expected: `package.json` `dependencies` gains `"pdf-lib"`.

- [ ] **Step 2: Write the failing test**

Create `src/electron/__tests__/label-pdf.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { pdfPageCount } from '../label-pdf'

async function makePdf(n: number): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  for (let i = 0; i < n; i++) d.addPage([200, 200])
  return d.save()
}

describe('pdfPageCount', () => {
  it('counts pages of a generated PDF', async () => {
    const bytes = await makePdf(5)
    expect(await pdfPageCount(bytes)).toBe(5)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/electron/__tests__/label-pdf.test.ts`
Expected: FAIL — `pdfPageCount` is not exported / module missing.

- [ ] **Step 4: Implement the helper**

Create `src/electron/label-pdf.ts`:

```ts
import { PDFDocument } from 'pdf-lib'

/** Number of pages in a PDF byte buffer. */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes)
  return doc.getPageCount()
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/electron/__tests__/label-pdf.test.ts`
Expected: PASS.

- [ ] **Step 6: Record the Spike #1 checklist**

Append this block to the top of `src/electron/label-pdf.ts` as a comment so it travels with the code:

```ts
// SPIKE #1 (run once against the first real captured batch, see Task 7):
//   1. label_batch.page_count === label_batch.unit_count  (one page per fulfill_unit)
//   2. each page has exactly one Code 128 barcode (verify in Task 12 once decode exists)
//   3. page order === fulfill_unit_id_list order (decode page barcodes, compare to the
//      tracking numbers of orders joined by fulfill_unit_id in that list order)
// If (1) or (3) fail: barcode decode (Task 12) becomes the PRIMARY tie path. The runtime
// guard in Task 6 (page_count !== unit_count -> mark batch for barcode tie) is the safety net.
```

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/electron/label-pdf.ts src/electron/__tests__/label-pdf.test.ts
git commit -m "feat(poc): add pdf-lib + pdfPageCount helper + spike checklist"
```

---

### Task 2: Bin derivation (pure)

**Files:**
- Create: `src/core/restack/bins.ts`
- Test: `src/core/restack/__tests__/bins.test.ts`

**Interfaces:**
- Produces: `type Bin = 'A' | 'B' | '?'`; `binOf(productName: string | null | undefined): Bin` — used by the packing sheet (Task 9) and picklist (Task 11).

- [ ] **Step 1: Write the failing test**

Create `src/core/restack/__tests__/bins.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { binOf } from '../bins'

describe('binOf', () => {
  it('detects Bin A', () => expect(binOf('Random Premium Pull (Bin A)')).toBe('A'))
  it('detects Bin B case-insensitively', () => expect(binOf('leggings bin b')).toBe('B'))
  it('returns ? when no bin', () => expect(binOf('Handbag')).toBe('?'))
  it('returns ? for null/empty', () => {
    expect(binOf(null)).toBe('?')
    expect(binOf('')).toBe('?')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/restack/__tests__/bins.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/core/restack/bins.ts`:

```ts
export type Bin = 'A' | 'B' | '?'

/** Bin label derived from the product name (mirrors tiktok-label-restack §5.1). */
export function binOf(productName: string | null | undefined): Bin {
  const s = productName ?? ''
  if (/bin\s*a/i.test(s)) return 'A'
  if (/bin\s*b/i.test(s)) return 'B'
  return '?'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/restack/__tests__/bins.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/restack/bins.ts src/core/restack/__tests__/bins.test.ts
git commit -m "feat(poc): restack bin derivation"
```

---

### Task 3: Restack ordering (pure)

**Files:**
- Create: `src/core/restack/sortlogic.ts`
- Test: `src/core/restack/__tests__/sortlogic.test.ts`

**Interfaces:**
- Produces:
  - `interface RestackOrder { orderId: string; buyer: string; createdMs: number | null }`
  - `orderedOrders(orders: RestackOrder[]): RestackOrder[]` — final stack sequence (index 0 = top = newest). Used by the picklist (Task 11) and exports (Tasks 8–9).

- [ ] **Step 1: Write the failing test**

Create `src/core/restack/__tests__/sortlogic.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { orderedOrders, type RestackOrder } from '../sortlogic'

const ids = (os: RestackOrder[]) => os.map((o) => o.orderId)

describe('orderedOrders', () => {
  it('orders newest purchase first when every buyer has one order', () => {
    const seq = orderedOrders([
      { orderId: 'a', buyer: 'amy', createdMs: 100 },
      { orderId: 'b', buyer: 'bob', createdMs: 300 },
      { orderId: 'c', buyer: 'cas', createdMs: 200 },
    ])
    expect(ids(seq)).toEqual(['b', 'c', 'a'])
  })

  it('positions a returning buyer by their OLDEST order and keeps their block contiguous', () => {
    // bob has orders at 50 (oldest) and 400; amy a single order at 300.
    const seq = orderedOrders([
      { orderId: 'bob-old', buyer: 'bob', createdMs: 50 },
      { orderId: 'amy', buyer: 'amy', createdMs: 300 },
      { orderId: 'bob-new', buyer: 'bob', createdMs: 400 },
    ])
    // bob's sortKey = 50 (oldest); amy's = 300. newest-first => amy(300) before bob(50).
    expect(ids(seq)).toEqual(['amy', 'bob-old', 'bob-new'])
    // bob's block is contiguous and oldest-first within the block.
  })

  it('sorts missing times last and is deterministic across runs', () => {
    const input: RestackOrder[] = [
      { orderId: 'x', buyer: 'zoe', createdMs: null },
      { orderId: 'y', buyer: 'ann', createdMs: 100 },
    ]
    expect(ids(orderedOrders(input))).toEqual(['y', 'x'])
    expect(orderedOrders(input)).toEqual(orderedOrders(input))
  })

  it('breaks time ties by buyer name descending', () => {
    const seq = orderedOrders([
      { orderId: 'p', buyer: 'aaa', createdMs: 100 },
      { orderId: 'q', buyer: 'zzz', createdMs: 100 },
    ])
    expect(ids(seq)).toEqual(['q', 'p']) // zzz before aaa
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/restack/__tests__/sortlogic.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/core/restack/sortlogic.ts`:

```ts
// Faithful TypeScript port of tiktok-label-restack/app/sortlogic.py.
// Determinism is a hard requirement: same input -> identical sequence.

export interface RestackOrder {
  orderId: string
  buyer: string
  createdMs: number | null
}

export interface RestackBuyer {
  name: string
  orders: RestackOrder[]
  sortKey: number // = min(createdMs) across the buyer's orders (their OLDEST order)
}

const FAR_PAST = -Infinity // missing times sort last (oldest)

export function groupBuyers(orders: RestackOrder[]): RestackBuyer[] {
  const byName = new Map<string, RestackOrder[]>()
  for (const o of orders) {
    const key = o.buyer || `__noname__:${o.orderId}`
    const arr = byName.get(key)
    if (arr) arr.push(o)
    else byName.set(key, [o])
  }
  const buyers: RestackBuyer[] = []
  for (const [name, list] of byName) {
    const times = list.map((o) => o.createdMs).filter((t): t is number => t != null)
    buyers.push({ name, orders: list, sortKey: times.length ? Math.min(...times) : FAR_PAST })
  }
  return buyers
}

export function orderedOrders(orders: RestackOrder[]): RestackOrder[] {
  const buyers = groupBuyers(orders)
  // Buyers newest-first by their oldest-order time; ties: name descending
  // (matches Python's single `sort(key=(sort_key, name), reverse=True)`).
  buyers.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return b.sortKey - a.sortKey
    return a.name < b.name ? 1 : a.name > b.name ? -1 : 0
  })
  const seq: RestackOrder[] = []
  for (const b of buyers) {
    const within = [...b.orders].sort((x, y) => {
      const xc = x.createdMs ?? FAR_PAST
      const yc = y.createdMs ?? FAR_PAST
      if (xc !== yc) return xc - yc // oldest order first within a buyer's block
      return x.orderId < y.orderId ? -1 : x.orderId > y.orderId ? 1 : 0
    })
    seq.push(...within)
  }
  return seq
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/restack/__tests__/sortlogic.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add src/core/restack/sortlogic.ts src/core/restack/__tests__/sortlogic.test.ts
git commit -m "feat(poc): restack ordering logic (port of sortlogic.py)"
```

---

### Task 4: Parse generate capture (pure)

**Files:**
- Create: `src/core/restack/capture.ts`
- Test: `src/core/restack/__tests__/capture.test.ts`

**Interfaces:**
- Produces:
  - `interface GenerateCapture { fulfillUnitIds: string[]; docUrl: string | null; statsUnitIds: string[] }`
  - `parseGenerateCapture(reqText: string, respText: string): GenerateCapture` — used by the capture handler (Task 7).

- [ ] **Step 1: Write the failing test**

Create `src/core/restack/__tests__/capture.test.ts` (data shape is the real trimmed HAR fixture):

```ts
import { describe, it, expect } from 'vitest'
import { parseGenerateCapture } from '../capture'

const REQ = JSON.stringify({
  op_scene: 2,
  fulfill_unit_id_list: ['1156730386024534712', '1156716186041946310', '1156716231897944200'],
  content_type_list: [1],
})
const RESP = JSON.stringify({
  code: 0,
  data: {
    doc_url: 'https://seller-us.tiktok.com/wsos_v2/oec_fulfillment_doc_tts/object/wsosABC?expire=1&skipCookie=true&sign=x',
    stats: [
      { order_id: '1156730386024534712' },
      { order_id: '1156716186041946310' },
      { order_id: '1156716231897944200' },
    ],
  },
})

describe('parseGenerateCapture', () => {
  it('extracts the ordered unit list, doc_url, and stats unit ids', () => {
    const c = parseGenerateCapture(REQ, RESP)
    expect(c.fulfillUnitIds).toEqual(['1156730386024534712', '1156716186041946310', '1156716231897944200'])
    expect(c.docUrl).toContain('/wsos_v2/')
    expect(c.statsUnitIds).toEqual(c.fulfillUnitIds) // stats order_id === fulfill_unit_id
  })

  it('degrades safely on malformed input', () => {
    const c = parseGenerateCapture('not json', '{}')
    expect(c.fulfillUnitIds).toEqual([])
    expect(c.docUrl).toBeNull()
    expect(c.statsUnitIds).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/restack/__tests__/capture.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/core/restack/capture.ts`:

```ts
export interface GenerateCapture {
  fulfillUnitIds: string[]
  docUrl: string | null
  statsUnitIds: string[]
}

/** Parse the shipping_doc/generate request body + response body into a typed struct.
 *  NB: response stats[].order_id is the fulfill_unit_id (verified), not the main order id. */
export function parseGenerateCapture(reqText: string, respText: string): GenerateCapture {
  let fulfillUnitIds: string[] = []
  let docUrl: string | null = null
  let statsUnitIds: string[] = []
  try {
    const req = JSON.parse(reqText) as { fulfill_unit_id_list?: unknown[] }
    fulfillUnitIds = (req.fulfill_unit_id_list ?? []).map((x) => String(x))
  } catch { /* ignore */ }
  try {
    const data = (JSON.parse(respText) as { data?: { doc_url?: string; stats?: { order_id?: unknown }[] } }).data
    docUrl = data?.doc_url ?? null
    statsUnitIds = (data?.stats ?? []).map((s) => String(s.order_id))
  } catch { /* ignore */ }
  return { fulfillUnitIds, docUrl, statsUnitIds }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/restack/__tests__/capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/restack/capture.ts src/core/restack/__tests__/capture.test.ts
git commit -m "feat(poc): parse shipping_doc/generate capture"
```

---

### Task 5: Tie resolver (pure)

**Files:**
- Create: `src/core/restack/tie.ts`
- Test: `src/core/restack/__tests__/tie.test.ts`

**Interfaces:**
- Produces:
  - `interface LabelPageTie { pageIndex: number; fulfillUnitId: string; orderId: string | null; matchMethod: 'generate-order' | 'barcode' | 'unmatched' }`
  - `tieByGenerateOrder(unitIds: string[], ordersByUnit: Map<string, string[]>): LabelPageTie[]` — used by the capture handler (Task 7).

- [ ] **Step 1: Write the failing test**

Create `src/core/restack/__tests__/tie.test.ts` (uses the real combined-shipment unit from the HAR):

```ts
import { describe, it, expect } from 'vitest'
import { tieByGenerateOrder } from '../tie'

describe('tieByGenerateOrder', () => {
  it('ties each page to the order(s) for its fulfill_unit_id, in page order', () => {
    const unitIds = ['1156730386024534712', '1156716186041946310', '9999999999999999999']
    const ordersByUnit = new Map<string, string[]>([
      // combined shipment: one unit -> two main orders (real HAR example)
      ['1156730386024534712', ['577445740374037176', '577445688654795448']],
      ['1156716186041946310', ['577445688861364422']],
      // 9999... has no synced order
    ])
    const ties = tieByGenerateOrder(unitIds, ordersByUnit)
    expect(ties).toEqual([
      { pageIndex: 0, fulfillUnitId: '1156730386024534712', orderId: '577445740374037176', matchMethod: 'generate-order' },
      { pageIndex: 1, fulfillUnitId: '1156716186041946310', orderId: '577445688861364422', matchMethod: 'generate-order' },
      { pageIndex: 2, fulfillUnitId: '9999999999999999999', orderId: null, matchMethod: 'unmatched' },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/restack/__tests__/tie.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/core/restack/tie.ts`:

```ts
export interface LabelPageTie {
  pageIndex: number
  fulfillUnitId: string
  orderId: string | null // resolved primary order for the 1:1 case; full fan-out is via orders.fulfill_unit_id
  matchMethod: 'generate-order' | 'barcode' | 'unmatched'
}

/** Page i is fulfill_unit_id_list[i]. Resolve order(s) by joining orders.fulfill_unit_id.
 *  A combined shipment maps one unit to several orders; orderId caches the first. */
export function tieByGenerateOrder(unitIds: string[], ordersByUnit: Map<string, string[]>): LabelPageTie[] {
  return unitIds.map((uid, i) => {
    const orders = ordersByUnit.get(uid) ?? []
    return {
      pageIndex: i,
      fulfillUnitId: uid,
      orderId: orders.length ? orders[0]! : null,
      matchMethod: orders.length ? 'generate-order' : 'unmatched',
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/restack/__tests__/tie.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/restack/tie.ts src/core/restack/__tests__/tie.test.ts
git commit -m "feat(poc): label page -> order tie resolver"
```

---

### Task 6: DB migration v2 — orders columns, backfill, picks.packed_at, restack query

**Files:**
- Modify: `src/electron/db.ts`
- Test: `src/electron/__tests__/db.test.ts` (add cases)

**Interfaces:**
- Consumes: existing `openDb`, `upsertOrders`, `MappedOrder` (has `fulfillment?.fulfillUnitId`, `fulfillment?.trackingNo`, `tracking`).
- Produces:
  - migration runs inside `openDb` (idempotent).
  - `setPacked(db: Db, orderId: string, packed: boolean, now: number): void`
  - `interface RestackOrderRow { orderId: string; buyer: string; placedAt: number | null; fulfillUnitId: string | null; trackingNo: string | null; items: { sku: string | null; productName: string | null; quantity: number | null }[] }`
  - `getOrdersForRestack(db: Db): RestackOrderRow[]`
  - `getOrdersByFulfillUnit(db: Db): Map<string, string[]>` — fulfill_unit_id → order ids (for the tie).

- [ ] **Step 1: Write the failing test**

Add to `src/electron/__tests__/db.test.ts` (follow the file's existing import/openDb-in-memory pattern; use `':memory:'` or a tmp path as the existing tests do):

```ts
import { getOrdersForRestack, getOrdersByFulfillUnit, setPacked } from '../db'
// ...within the existing describe, or a new one:

it('migration adds fulfill_unit_id/tracking_no and exposes restack queries', () => {
  const db = openDb(':memory:')
  upsertOrders(db, [
    {
      externalOrderId: 'o1', status: 'TO_SHIP', statusCode: '111', buyerHandle: 'amy', buyerName: 'Amy',
      subtotalCents: 0, shippingCents: 0, shippingDiscountCents: 0, platformDiscountCents: 0,
      sellerDiscountCents: 0, taxCents: 0, originSaleCents: 0, totalCents: 0,
      address: null, carrier: null, tracking: 'TRK1', liveTag: null, isAuction: false, isReversed: false,
      placedAt: 100, roomId: 'r1', videoReceiptTs: null,
      fulfillment: { fulfillUnitId: 'U1', trackingNo: 'TRK1', isSplitOrCombined: false },
      items: [{ productId: 'p1', skuId: 's1', productName: 'Pull (Bin A)', variant: '', quantity: 1, unitPriceCents: 0, totalPriceCents: 0, imageUrl: '', orderLineIds: [] }],
    },
  ] as never, Date.now())

  const rows = getOrdersForRestack(db)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ orderId: 'o1', buyer: 'amy', placedAt: 100, fulfillUnitId: 'U1', trackingNo: 'TRK1' })
  expect(rows[0]!.items[0]).toMatchObject({ sku: 's1', productName: 'Pull (Bin A)', quantity: 1 })

  const byUnit = getOrdersByFulfillUnit(db)
  expect(byUnit.get('U1')).toEqual(['o1'])

  setPacked(db, 'o1', true, Date.now())
  const packed = db.prepare('SELECT packed_at FROM picks WHERE order_id = ?').get('o1') as { packed_at: number | null }
  expect(packed.packed_at).toBeTruthy()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/electron/__tests__/db.test.ts`
Expected: FAIL — `getOrdersForRestack` undefined / columns missing.

- [ ] **Step 3: Add the migration in `openDb`**

In `src/electron/db.ts`, after `db.exec(SCHEMA)` and the schema_version insert in `openDb`, add an idempotent migration:

```ts
  migrateV2(db)
```

And add this function (place near `openDb`):

```ts
function hasColumn(db: Db, table: string, col: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.some((r) => r.name === col)
}

/** Additive v2 migration: order tie columns, pack timestamp, label tables. Idempotent. */
function migrateV2(db: Db): void {
  if (!hasColumn(db, 'orders', 'fulfill_unit_id')) db.exec('ALTER TABLE orders ADD COLUMN fulfill_unit_id TEXT')
  if (!hasColumn(db, 'orders', 'tracking_no')) db.exec('ALTER TABLE orders ADD COLUMN tracking_no TEXT')
  if (!hasColumn(db, 'picks', 'packed_at')) db.exec('ALTER TABLE picks ADD COLUMN packed_at INTEGER')
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_fulfill_unit ON orders(fulfill_unit_id);
    CREATE TABLE IF NOT EXISTS label_batch (
      id TEXT PRIMARY KEY, captured_at INTEGER, room_id TEXT, doc_url TEXT, pdf_path TEXT,
      page_count INTEGER, unit_count INTEGER, request_json TEXT, stats_json TEXT, status TEXT
    );
    CREATE TABLE IF NOT EXISTS label_page (
      batch_id TEXT, page_index INTEGER, fulfill_unit_id TEXT, order_id TEXT,
      tracking_decoded TEXT, match_method TEXT, PRIMARY KEY (batch_id, page_index)
    );
  `)
  // backfill tie columns from sale_json for rows synced before v2
  backfillTieColumns(db)
  db.prepare("INSERT INTO meta (k,v) VALUES ('schema_version','2') ON CONFLICT(k) DO UPDATE SET v='2'").run()
}

function backfillTieColumns(db: Db): void {
  const rows = db.prepare('SELECT order_id, sale_json FROM orders WHERE fulfill_unit_id IS NULL').all() as { order_id: string; sale_json: string }[]
  const up = db.prepare('UPDATE orders SET fulfill_unit_id=?, tracking_no=? WHERE order_id=?')
  const run = db.transaction(() => {
    for (const r of rows) {
      try {
        const sale = JSON.parse(r.sale_json) as { fulfillment?: { fulfillUnitId?: string; trackingNo?: string } }
        const fu = sale.fulfillment?.fulfillUnitId ?? null
        const tn = sale.fulfillment?.trackingNo ?? null
        if (fu || tn) up.run(fu, tn, r.order_id)
      } catch { /* ignore */ }
    }
  })
  run()
}
```

- [ ] **Step 4: Populate the new columns in `upsertOrders`**

In `src/electron/db.ts`, extend `UPSERT_ORDER` to write the two columns and pass them in the `up.run({...})` call. Add `fulfill_unit_id` and `tracking_no` to both the `INSERT` column list/VALUES and the `ON CONFLICT ... DO UPDATE SET`, then in `upsertOrders` add to the run object:

```ts
        fulfill_unit_id: o.fulfillment?.fulfillUnitId ?? null,
        tracking_no: o.fulfillment?.trackingNo ?? o.tracking ?? null,
```

(Match the existing `@name` named-parameter style already used in `UPSERT_ORDER`.)

- [ ] **Step 5: Add the restack queries + setPacked**

Append to `src/electron/db.ts`:

```ts
export interface RestackOrderRow {
  orderId: string
  buyer: string
  placedAt: number | null
  fulfillUnitId: string | null
  trackingNo: string | null
  items: { sku: string | null; productName: string | null; quantity: number | null }[]
}

export function getOrdersForRestack(db: Db): RestackOrderRow[] {
  const orders = db.prepare('SELECT order_id, buyer_handle, placed_at, fulfill_unit_id, tracking_no FROM orders').all() as
    { order_id: string; buyer_handle: string | null; placed_at: number | null; fulfill_unit_id: string | null; tracking_no: string | null }[]
  const itemStmt = db.prepare('SELECT sku_id, product_name, quantity FROM order_items WHERE order_id = ? ORDER BY line_index')
  return orders.map((o) => ({
    orderId: o.order_id,
    buyer: o.buyer_handle ?? '',
    placedAt: o.placed_at,
    fulfillUnitId: o.fulfill_unit_id,
    trackingNo: o.tracking_no,
    items: (itemStmt.all(o.order_id) as { sku_id: string | null; product_name: string | null; quantity: number | null }[])
      .map((it) => ({ sku: it.sku_id, productName: it.product_name, quantity: it.quantity })),
  }))
}

export function getOrdersByFulfillUnit(db: Db): Map<string, string[]> {
  const rows = db.prepare('SELECT order_id, fulfill_unit_id FROM orders WHERE fulfill_unit_id IS NOT NULL ORDER BY placed_at').all() as
    { order_id: string; fulfill_unit_id: string }[]
  const m = new Map<string, string[]>()
  for (const r of rows) {
    const arr = m.get(r.fulfill_unit_id)
    if (arr) arr.push(r.order_id)
    else m.set(r.fulfill_unit_id, [r.order_id])
  }
  return m
}

export function setPacked(db: Db, orderId: string, packed: boolean, now: number): void {
  if (packed) {
    db.prepare('INSERT INTO picks (order_id, packed_at) VALUES (?, ?) ON CONFLICT(order_id) DO UPDATE SET packed_at=excluded.packed_at').run(orderId, now)
  } else {
    db.prepare('UPDATE picks SET packed_at=NULL WHERE order_id=?').run(orderId)
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/electron/__tests__/db.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/electron/db.ts src/electron/__tests__/db.test.ts
git commit -m "feat(poc): db v2 migration + restack order queries + packed state"
```

---

### Task 7: Label batch/page persistence + clear (DB)

**Files:**
- Modify: `src/electron/db.ts`
- Test: `src/electron/__tests__/db.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `interface LabelBatchRow { id: string; capturedAt: number; roomId: string | null; docUrl: string | null; pdfPath: string | null; pageCount: number; unitCount: number; status: string }`
  - `insertLabelBatch(db, batch: LabelBatchRow & { requestJson: string; statsJson: string }): void`
  - `insertLabelPages(db, batchId: string, ties: { pageIndex: number; fulfillUnitId: string; orderId: string | null; matchMethod: string }[]): void`
  - `listLabelBatches(db): LabelBatchRow[]`
  - `getLabelBatch(db, id): (LabelBatchRow & { requestJson: string; statsJson: string }) | null`
  - `getLabelPages(db, batchId): { pageIndex: number; fulfillUnitId: string; orderId: string | null; matchMethod: string }[]`
  - `clearLabels(db): string[]` — deletes all label rows, returns the `pdfPath`s to unlink.
  - `setBatchStatus(db, id, status): void`

- [ ] **Step 1: Write the failing test**

Add to `src/electron/__tests__/db.test.ts`:

```ts
import { insertLabelBatch, insertLabelPages, listLabelBatches, getLabelBatch, getLabelPages, clearLabels } from '../db'

it('persists and clears label batches + pages', () => {
  const db = openDb(':memory:')
  insertLabelBatch(db, {
    id: 'b1', capturedAt: 1000, roomId: 'r1', docUrl: 'http://x', pdfPath: '/tmp/b1.pdf',
    pageCount: 2, unitCount: 2, status: 'tied', requestJson: '[]', statsJson: '[]',
  })
  insertLabelPages(db, 'b1', [
    { pageIndex: 0, fulfillUnitId: 'U1', orderId: 'o1', matchMethod: 'generate-order' },
    { pageIndex: 1, fulfillUnitId: 'U2', orderId: null, matchMethod: 'unmatched' },
  ])
  expect(listLabelBatches(db).map((b) => b.id)).toEqual(['b1'])
  expect(getLabelBatch(db, 'b1')!.pageCount).toBe(2)
  expect(getLabelPages(db, 'b1')).toHaveLength(2)

  const paths = clearLabels(db)
  expect(paths).toEqual(['/tmp/b1.pdf'])
  expect(listLabelBatches(db)).toHaveLength(0)
  expect(getLabelPages(db, 'b1')).toHaveLength(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/electron/__tests__/db.test.ts`
Expected: FAIL — functions undefined.

- [ ] **Step 3: Implement**

Append to `src/electron/db.ts`:

```ts
export interface LabelBatchRow {
  id: string; capturedAt: number; roomId: string | null; docUrl: string | null; pdfPath: string | null
  pageCount: number; unitCount: number; status: string
}

export function insertLabelBatch(db: Db, b: LabelBatchRow & { requestJson: string; statsJson: string }): void {
  db.prepare(`INSERT INTO label_batch (id,captured_at,room_id,doc_url,pdf_path,page_count,unit_count,request_json,stats_json,status)
    VALUES (@id,@capturedAt,@roomId,@docUrl,@pdfPath,@pageCount,@unitCount,@requestJson,@statsJson,@status)
    ON CONFLICT(id) DO UPDATE SET pdf_path=excluded.pdf_path,page_count=excluded.page_count,status=excluded.status`).run(b)
}

export function setBatchStatus(db: Db, id: string, status: string): void {
  db.prepare('UPDATE label_batch SET status=? WHERE id=?').run(status, id)
}

export function insertLabelPages(db: Db, batchId: string, ties: { pageIndex: number; fulfillUnitId: string; orderId: string | null; matchMethod: string }[]): void {
  const ins = db.prepare('INSERT OR REPLACE INTO label_page (batch_id,page_index,fulfill_unit_id,order_id,match_method) VALUES (?,?,?,?,?)')
  const run = db.transaction(() => { for (const t of ties) ins.run(batchId, t.pageIndex, t.fulfillUnitId, t.orderId, t.matchMethod) })
  run()
}

function rowToBatch(r: Record<string, unknown>): LabelBatchRow & { requestJson: string; statsJson: string } {
  return {
    id: r.id as string, capturedAt: r.captured_at as number, roomId: (r.room_id as string) ?? null,
    docUrl: (r.doc_url as string) ?? null, pdfPath: (r.pdf_path as string) ?? null,
    pageCount: r.page_count as number, unitCount: r.unit_count as number, status: r.status as string,
    requestJson: (r.request_json as string) ?? '', statsJson: (r.stats_json as string) ?? '',
  }
}

export function listLabelBatches(db: Db): LabelBatchRow[] {
  return (db.prepare('SELECT * FROM label_batch ORDER BY captured_at DESC').all() as Record<string, unknown>[]).map(rowToBatch)
}

export function getLabelBatch(db: Db, id: string): (LabelBatchRow & { requestJson: string; statsJson: string }) | null {
  const r = db.prepare('SELECT * FROM label_batch WHERE id=?').get(id) as Record<string, unknown> | undefined
  return r ? rowToBatch(r) : null
}

export function getLabelPages(db: Db, batchId: string): { pageIndex: number; fulfillUnitId: string; orderId: string | null; matchMethod: string }[] {
  return (db.prepare('SELECT page_index,fulfill_unit_id,order_id,match_method FROM label_page WHERE batch_id=? ORDER BY page_index').all(batchId) as
    { page_index: number; fulfill_unit_id: string; order_id: string | null; match_method: string }[])
    .map((r) => ({ pageIndex: r.page_index, fulfillUnitId: r.fulfill_unit_id, orderId: r.order_id, matchMethod: r.match_method }))
}

/** Delete all label rows; return the on-disk pdf paths the caller must unlink. */
export function clearLabels(db: Db): string[] {
  const paths = (db.prepare('SELECT pdf_path FROM label_batch WHERE pdf_path IS NOT NULL').all() as { pdf_path: string }[]).map((r) => r.pdf_path)
  const run = db.transaction(() => { db.exec('DELETE FROM label_page; DELETE FROM label_batch;') })
  run()
  return paths
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/electron/__tests__/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/electron/db.ts src/electron/__tests__/db.test.ts
git commit -m "feat(poc): label batch/page persistence + clear"
```

---

### Task 8: PDF reorder + single-page extract

**Files:**
- Modify: `src/electron/label-pdf.ts`
- Test: `src/electron/__tests__/label-pdf.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `reorderLabels(srcBytes: Uint8Array, sequence: number[]): Promise<Uint8Array>` — copy pages in `sequence` order.
  - `extractPage(srcBytes: Uint8Array, pageIndex: number): Promise<Uint8Array>` — one-page PDF for the viewer.

- [ ] **Step 1: Write the failing test**

Add to `src/electron/__tests__/label-pdf.test.ts`:

```ts
import { reorderLabels, extractPage } from '../label-pdf'

describe('reorderLabels / extractPage', () => {
  it('reorders to the given sequence', async () => {
    const src = await makePdf(3)
    const out = await reorderLabels(src, [2, 0]) // keep only pages 2 and 0
    expect(await pdfPageCount(out)).toBe(2)
  })
  it('extracts a single page', async () => {
    const src = await makePdf(4)
    const out = await extractPage(src, 1)
    expect(await pdfPageCount(out)).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/electron/__tests__/label-pdf.test.ts`
Expected: FAIL — functions undefined.

- [ ] **Step 3: Implement**

Add to `src/electron/label-pdf.ts` (import already present for `PDFDocument`):

```ts
export async function reorderLabels(srcBytes: Uint8Array, sequence: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(srcBytes)
  const out = await PDFDocument.create()
  const valid = sequence.filter((i) => i >= 0 && i < src.getPageCount())
  const pages = await out.copyPages(src, valid)
  pages.forEach((p) => out.addPage(p))
  return out.save()
}

export async function extractPage(srcBytes: Uint8Array, pageIndex: number): Promise<Uint8Array> {
  const src = await PDFDocument.load(srcBytes)
  const out = await PDFDocument.create()
  const [p] = await out.copyPages(src, [pageIndex])
  out.addPage(p)
  return out.save()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/electron/__tests__/label-pdf.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/electron/label-pdf.ts src/electron/__tests__/label-pdf.test.ts
git commit -m "feat(poc): PDF reorder + single-page extract"
```

---

### Task 9: Packing sheet builder

**Files:**
- Modify: `src/electron/label-pdf.ts`
- Test: `src/electron/__tests__/label-pdf.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `interface SheetRow { seq: number; buyer: string; purchased: string; items: string; multi: boolean }`
  - `buildPackingSheet(rows: SheetRow[]): Promise<Uint8Array>` — one row per order in sequence; header repeats; multi-item rows flagged.

- [ ] **Step 1: Write the failing test**

Add to `src/electron/__tests__/label-pdf.test.ts`:

```ts
import { buildPackingSheet } from '../label-pdf'

describe('buildPackingSheet', () => {
  it('produces a valid multi-row PDF', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      seq: i + 1, buyer: `buyer${i}`, purchased: '8:36 AM', items: 's1 (Bin A)', multi: i === 0,
    }))
    const out = await buildPackingSheet(rows)
    expect(Buffer.from(out.slice(0, 5)).toString()).toBe('%PDF-')
    expect(await pdfPageCount(out)).toBeGreaterThanOrEqual(1)
  })

  it('paginates large row counts', async () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({ seq: i + 1, buyer: `b${i}`, purchased: '8:36 AM', items: 's', multi: false }))
    const out = await buildPackingSheet(rows)
    expect(await pdfPageCount(out)).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/electron/__tests__/label-pdf.test.ts`
Expected: FAIL — `buildPackingSheet` undefined.

- [ ] **Step 3: Implement**

Add to `src/electron/label-pdf.ts`; extend the top import to `import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'`:

```ts
export interface SheetRow {
  seq: number
  buyer: string
  purchased: string
  items: string
  multi: boolean
}

const ROWS_PER_PAGE = 38
const PAGE_W = 612 // US Letter pt
const PAGE_H = 792

export async function buildPackingSheet(rows: SheetRow[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const flag = rgb(0.9, 0.2, 0.1)
  const ink = rgb(0.09, 0.07, 0.06)
  const cols = [{ x: 40, label: '#' }, { x: 80, label: 'Buyer' }, { x: 250, label: 'Purchased' }, { x: 340, label: 'Items (SKU / Bin)' }, { x: 560, label: 'Pick' }]

  for (let start = 0; start < Math.max(rows.length, 1); start += ROWS_PER_PAGE) {
    const page = doc.addPage([PAGE_W, PAGE_H])
    let y = PAGE_H - 50
    for (const c of cols) page.drawText(c.label, { x: c.x, y, size: 10, font: bold, color: ink })
    y -= 6
    page.drawLine({ start: { x: 40, y }, end: { x: 575, y }, thickness: 1, color: ink })
    y -= 18
    for (const r of rows.slice(start, start + ROWS_PER_PAGE)) {
      page.drawText(String(r.seq), { x: cols[0]!.x, y, size: 9, font, color: ink })
      page.drawText(r.buyer.slice(0, 28), { x: cols[1]!.x, y, size: 9, font, color: ink })
      page.drawText(r.purchased, { x: cols[2]!.x, y, size: 9, font, color: ink })
      page.drawText(r.items.slice(0, 40), { x: cols[3]!.x, y, size: 9, font, color: r.multi ? flag : ink })
      page.drawText('[ ]', { x: cols[4]!.x, y, size: 9, font, color: ink })
      y -= 18
    }
  }
  return doc.save()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/electron/__tests__/label-pdf.test.ts`
Expected: PASS (all label-pdf cases).

- [ ] **Step 5: Commit**

```bash
git add src/electron/label-pdf.ts src/electron/__tests__/label-pdf.test.ts
git commit -m "feat(poc): packing sheet PDF builder"
```

---

### Task 10: Seller-window capture wiring (preload + main download/persist)

**Files:**
- Create: `src/electron/preload-seller.ts`
- Modify: `esbuild.mjs`, `src/electron/main.ts`
- Test: none new (logic covered by Tasks 4/5/8); verified by build + the Task 13 manual run.

**Interfaces:**
- Consumes: `parseGenerateCapture` (Task 4), `tieByGenerateOrder` (Task 5), `pdfPageCount` (Task 1), `getOrdersByFulfillUnit`/`insertLabelBatch`/`insertLabelPages`/`setBatchStatus` (Tasks 6/7).
- Produces: a captured, tied `label_batch` + `label_page` rows on disk; a `tt-label-batch-ready` event sent to the viewer.

- [ ] **Step 1: Create the seller preload**

Create `src/electron/preload-seller.ts`:

```ts
import { ipcRenderer } from 'electron'

// Runs in the Seller-Center window (contextIsolation:false) so it can wrap the
// page's own fetch + XHR. We only care about shipping_doc/generate: forward its
// request body (ordered fulfill_unit_id_list) + response (doc_url, stats).
const GEN_RE = /\/fulfillment\/na\/shipping_doc\/generate/

const OrigFetch = window.fetch
window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
  let url = ''
  try { url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url } catch { /* ignore */ }
  const p = OrigFetch.apply(this as never, arguments as never) as Promise<Response>
  if (GEN_RE.test(url)) {
    const reqBody = typeof init?.body === 'string' ? init.body : ''
    p.then((res) => res.clone().text().then((respBody) => {
      ipcRenderer.send('tt-label-batch', { url, reqBody, respBody })
    }).catch(() => {})).catch(() => {})
  }
  return p
} as typeof window.fetch

// axios/older code paths use XHR; capture the request body in send() and the response on load.
const OrigOpen = XMLHttpRequest.prototype.open
const OrigSend = XMLHttpRequest.prototype.send
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { __genUrl?: string }, method: string, url: string | URL, ...rest: unknown[]) {
  this.__genUrl = GEN_RE.test(String(url)) ? String(url) : undefined
  return (OrigOpen as (...a: unknown[]) => void).call(this, method, url, ...rest)
}
XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { __genUrl?: string }, body?: Document | XMLHttpRequestBodyInit | null) {
  if (this.__genUrl) {
    const reqBody = typeof body === 'string' ? body : ''
    const url = this.__genUrl
    this.addEventListener('load', () => {
      try {
        if (this.responseType === '' || this.responseType === 'text') {
          ipcRenderer.send('tt-label-batch', { url, reqBody, respBody: this.responseText })
        }
      } catch { /* ignore */ }
    })
  }
  return (OrigSend as (b?: unknown) => void).call(this, body as never)
}
```

- [ ] **Step 2: Build the new preload in esbuild**

In `esbuild.mjs`, after the `preload-viewer.ts` build line, add:

```js
await build({ ...common, entryPoints: ['src/electron/preload-seller.ts'], outfile: 'dist/preload-seller.cjs' })
```

- [ ] **Step 3: Attach the preload to the seller window**

In `src/electron/main.ts`, change `openSellerLogin`'s `webPreferences` to load the preload in the page world:

```ts
    webPreferences: {
      session: session.fromPartition(TT_PARTITION),
      contextIsolation: false,
      sandbox: false,
      preload: join(__dirname, 'preload-seller.cjs'),
    },
```

- [ ] **Step 4: Add the label dir + capture handler in main**

In `src/electron/main.ts`, add imports:

```ts
import { writeFileSync as fsWriteFileSync, unlinkSync, rmSync } from 'node:fs'
import { net } from 'electron'
import { parseGenerateCapture } from '../core/restack/capture'
import { tieByGenerateOrder } from '../core/restack/tie'
import { pdfPageCount, reorderLabels, extractPage, buildPackingSheet, type SheetRow } from './label-pdf'
import {
  getOrdersByFulfillUnit, getOrdersForRestack, insertLabelBatch, insertLabelPages, setBatchStatus,
  listLabelBatches, getLabelBatch, getLabelPages, clearLabels, setPacked,
} from './db'
```

Add the label dir helper near the other path constants:

```ts
function labelsDir(): string {
  const d = join(app.getPath('userData'), 'labels')
  try { mkdirSync(d, { recursive: true }) } catch { /* ignore */ }
  return d
}
```

Add the capture handler (near the other `ipcMain.on` sources). It downloads `doc_url` cookie-lessly, ties pages, and persists:

```ts
ipcMain.on('tt-label-batch', async (_e, msg: { url?: string; reqBody?: string; respBody?: string }) => {
  if (!db) return
  const cap = parseGenerateCapture(msg?.reqBody ?? '', msg?.respBody ?? '')
  if (!cap.fulfillUnitIds.length || !cap.docUrl) { debug('[tt] label batch: missing units or doc_url'); return }
  const batchId = String(Date.now())
  const pdfPath = join(labelsDir(), `${batchId}.pdf`)
  try {
    // doc_url is pre-signed (skipCookie=true); fetch via electron net.
    const res = await net.fetch(cap.docUrl)
    if (!res.ok) throw new Error(`doc_url HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length < 5 || Buffer.from(bytes.slice(0, 5)).toString() !== '%PDF-') throw new Error('not a PDF')
    fsWriteFileSync(pdfPath, bytes)
    const pageCount = await pdfPageCount(bytes)
    const ties = tieByGenerateOrder(cap.fulfillUnitIds, getOrdersByFulfillUnit(db))
    const status = pageCount === cap.fulfillUnitIds.length ? 'tied' : 'error' // count mismatch -> needs barcode (Task 12)
    insertLabelBatch(db, {
      id: batchId, capturedAt: Date.now(), roomId: pollRoomId ?? null, docUrl: cap.docUrl, pdfPath,
      pageCount, unitCount: cap.fulfillUnitIds.length, status,
      requestJson: JSON.stringify(cap.fulfillUnitIds), statsJson: JSON.stringify(cap.statsUnitIds),
    })
    insertLabelPages(db, batchId, ties)
    debug(`[tt] label batch ${batchId}: ${pageCount}p / ${cap.fulfillUnitIds.length}u status=${status}`)
    viewer?.webContents.send('tt-label-batch-ready', { batchId, pageCount, unitCount: cap.fulfillUnitIds.length, status })
  } catch (e) {
    insertLabelBatch(db, {
      id: batchId, capturedAt: Date.now(), roomId: pollRoomId ?? null, docUrl: cap.docUrl, pdfPath: null,
      pageCount: 0, unitCount: cap.fulfillUnitIds.length, status: 'error',
      requestJson: JSON.stringify(cap.fulfillUnitIds), statsJson: JSON.stringify(cap.statsUnitIds),
    })
    debug(`[tt] label batch ${batchId} failed: ${(e as Error).message}`)
    viewer?.webContents.send('tt-label-batch-ready', { batchId, status: 'error', error: (e as Error).message })
  }
})
```

- [ ] **Step 5: Build and verify it compiles**

Run: `node esbuild.mjs`
Expected: `build complete`, no TypeScript/bundle errors, `dist/preload-seller.cjs` exists.

- [ ] **Step 6: Commit**

```bash
git add src/electron/preload-seller.ts esbuild.mjs src/electron/main.ts
git commit -m "feat(poc): passive shipping-label capture + tie + persist"
```

---

### Task 11: Picklist IPC surface (main handlers + viewer bridge)

**Files:**
- Modify: `src/electron/main.ts`, `src/electron/preload-viewer.ts`
- Test: build verification.

**Interfaces:**
- Produces (on `window.picklistAPI`):
  - `list(): Promise<LabelBatchSummary[]>` where `LabelBatchSummary = { id; capturedAt; pageCount; unitCount; status }`
  - `get(batchId): Promise<{ batch; pages; orders } | null>` — `pages` are `label_page` rows; `orders` is `getOrdersForRestack` filtered to this batch's units.
  - `pagePdf(batchId, pageIndex): Promise<Uint8Array | null>`
  - `exportDoc(batchId, kind: 'labels' | 'sheet'): Promise<{ ok: boolean; path?: string; error?: string }>`
  - `clear(): Promise<{ ok: boolean }>`
  - `setPacked(orderId, packed): Promise<boolean>`
  - `onBatchReady(cb)` — fires on `tt-label-batch-ready`.

- [ ] **Step 1: Add main handlers**

In `src/electron/main.ts`, add (near the other `ipcMain.handle` DB handlers). Reuse `orderedOrders` + `binOf` for the export sequence:

```ts
import { orderedOrders, type RestackOrder } from '../core/restack/sortlogic'
import { binOf } from '../core/restack/bins'
import { dialog } from 'electron'

ipcMain.handle('tt-label:list', () => (db ? listLabelBatches(db).map((b) => ({ id: b.id, capturedAt: b.capturedAt, pageCount: b.pageCount, unitCount: b.unitCount, status: b.status })) : []))

ipcMain.handle('tt-label:get', (_e, batchId: string) => {
  if (!db) return null
  const batch = getLabelBatch(db, batchId)
  if (!batch) return null
  const pages = getLabelPages(db, batchId)
  const units = new Set(JSON.parse(batch.requestJson) as string[])
  const orders = getOrdersForRestack(db).filter((o) => o.fulfillUnitId && units.has(o.fulfillUnitId))
  return { batch, pages, orders }
})

ipcMain.handle('tt-label:pagePdf', async (_e, p: { batchId: string; pageIndex: number }) => {
  if (!db) return null
  const batch = getLabelBatch(db, p.batchId)
  if (!batch?.pdfPath) return null
  try { return await extractPage(new Uint8Array(readFileSync(batch.pdfPath)), p.pageIndex) } catch { return null }
})

function restackSequence(orders: ReturnType<typeof getOrdersForRestack>): string[] {
  const ro: RestackOrder[] = orders.map((o) => ({ orderId: o.orderId, buyer: o.buyer, createdMs: o.placedAt }))
  return orderedOrders(ro).map((o) => o.orderId)
}

ipcMain.handle('tt-label:export', async (_e, p: { batchId: string; kind: 'labels' | 'sheet' }) => {
  if (!db) return { ok: false, error: 'no db' }
  const batch = getLabelBatch(db, p.batchId)
  if (!batch?.pdfPath) return { ok: false, error: 'batch has no PDF' }
  const pages = getLabelPages(db, p.batchId)
  const orders = getOrdersForRestack(db).filter((o) => o.fulfillUnitId && pages.some((pg) => pg.fulfillUnitId === o.fulfillUnitId))
  const seq = restackSequence(orders)
  // map order -> the page index of its fulfill_unit
  const pageOfUnit = new Map(pages.map((pg) => [pg.fulfillUnitId, pg.pageIndex]))
  const unitOfOrder = new Map(orders.map((o) => [o.orderId, o.fulfillUnitId!]))
  try {
    let bytes: Uint8Array
    let suggested: string
    if (p.kind === 'labels') {
      const pageSeq = seq.map((oid) => pageOfUnit.get(unitOfOrder.get(oid)!)).filter((i): i is number => i != null)
      bytes = await reorderLabels(new Uint8Array(readFileSync(batch.pdfPath)), [...new Set(pageSeq)])
      suggested = 'Labels_sorted_newest_to_oldest.pdf'
    } else {
      const byId = new Map(orders.map((o) => [o.orderId, o]))
      const rows: SheetRow[] = seq.map((oid, i) => {
        const o = byId.get(oid)!
        const items = o.items.map((it) => `${it.sku ?? '?'} (Bin ${binOf(it.productName)})`).join(', ')
        return { seq: i + 1, buyer: o.buyer, purchased: o.placedAt ? new Date(o.placedAt).toLocaleTimeString() : '', items, multi: o.items.length > 1 }
      })
      bytes = await buildPackingSheet(rows)
      suggested = 'Packing_sheet.pdf'
    }
    const save = await dialog.showSaveDialog({ defaultPath: suggested })
    if (save.canceled || !save.filePath) return { ok: false, error: 'cancelled' }
    fsWriteFileSync(save.filePath, bytes)
    setBatchStatus(db, p.batchId, 'exported')
    return { ok: true, path: save.filePath }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
})

ipcMain.handle('tt-label:clear', () => {
  if (!db) return { ok: false }
  for (const path of clearLabels(db)) { try { unlinkSync(path) } catch { /* ignore */ } }
  try { rmSync(labelsDir(), { recursive: true, force: true }) } catch { /* ignore */ }
  return { ok: true }
})

ipcMain.handle('tt-label:setPacked', (_e, p: { orderId: string; packed: boolean }) => { if (db) setPacked(db, p.orderId, p.packed, Date.now()); return true })
```

- [ ] **Step 2: Add the viewer bridge**

In `src/electron/preload-viewer.ts`, add:

```ts
contextBridge.exposeInMainWorld('picklistAPI', {
  list: () => ipcRenderer.invoke('tt-label:list'),
  get: (batchId: string) => ipcRenderer.invoke('tt-label:get', batchId),
  pagePdf: (batchId: string, pageIndex: number) => ipcRenderer.invoke('tt-label:pagePdf', { batchId, pageIndex }),
  exportDoc: (batchId: string, kind: 'labels' | 'sheet') => ipcRenderer.invoke('tt-label:export', { batchId, kind }),
  clear: () => ipcRenderer.invoke('tt-label:clear'),
  setPacked: (orderId: string, packed: boolean) => ipcRenderer.invoke('tt-label:setPacked', { orderId, packed }),
  onBatchReady: (cb: (p: unknown) => void) => ipcRenderer.on('tt-label-batch-ready', (_e, p) => cb(p)),
})
```

- [ ] **Step 3: Build and verify**

Run: `node esbuild.mjs`
Expected: `build complete`, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/electron/main.ts src/electron/preload-viewer.ts
git commit -m "feat(poc): picklist IPC surface (list/get/page/export/clear/pack)"
```

---

### Task 12: Picklist renderer view

**Files:**
- Create: `src/renderer/picklist.ts`
- Modify: `src/renderer/renderer.ts`, `src/renderer/index.html`
- Test: build verification + Task 13 manual run.

**Interfaces:**
- Consumes: `window.picklistAPI` (Task 11), `orderedOrders` + `binOf` (pure modules).
- Produces: `initPicklist(container: HTMLElement): void` — called from `renderer.ts`.

- [ ] **Step 1: Add the container + nav in index.html**

In `src/renderer/index.html`, add a nav entry next to the existing views and a container:

```html
<button id="nav-picklist">Picklist</button>
<section id="picklist" hidden></section>
```

(Match the existing nav/section markup style in the file.)

- [ ] **Step 2: Implement the view**

Create `src/renderer/picklist.ts`:

```ts
import { orderedOrders, type RestackOrder } from '../core/restack/sortlogic'
import { binOf } from '../core/restack/bins'

interface PageRow { pageIndex: number; fulfillUnitId: string; orderId: string | null; matchMethod: string }
interface OrderRow { orderId: string; buyer: string; placedAt: number | null; fulfillUnitId: string | null; trackingNo: string | null; items: { sku: string | null; productName: string | null; quantity: number | null }[] }
interface BatchData { batch: { id: string; status: string; pageCount: number; unitCount: number }; pages: PageRow[]; orders: OrderRow[] }

declare global {
  interface Window {
    picklistAPI: {
      list(): Promise<{ id: string; capturedAt: number; pageCount: number; unitCount: number; status: string }[]>
      get(id: string): Promise<BatchData | null>
      pagePdf(id: string, pageIndex: number): Promise<Uint8Array | null>
      exportDoc(id: string, kind: 'labels' | 'sheet'): Promise<{ ok: boolean; path?: string; error?: string }>
      clear(): Promise<{ ok: boolean }>
      setPacked(orderId: string, packed: boolean): Promise<boolean>
      onBatchReady(cb: (p: unknown) => void): void
    }
  }
}

let host: HTMLElement
let currentBatch: string | null = null

export function initPicklist(container: HTMLElement): void {
  host = container
  window.picklistAPI.onBatchReady(() => void refresh())
  void refresh()
}

async function refresh(): Promise<void> {
  const batches = await window.picklistAPI.list()
  if (!batches.length) { host.innerHTML = '<p class="empty">No label batches captured yet. Print shipping labels in the TikTok Seller window to capture a batch.</p>'; return }
  if (!currentBatch || !batches.some((b) => b.id === currentBatch)) currentBatch = batches[0]!.id
  const data = await window.picklistAPI.get(currentBatch)
  if (!data) return
  render(batches, data)
}

function render(batches: { id: string; pageCount: number; unitCount: number; status: string }[], data: BatchData): void {
  // Restack order from order data we hold; group rendering by buyer block.
  const ro: RestackOrder[] = data.orders.map((o) => ({ orderId: o.orderId, buyer: o.buyer, createdMs: o.placedAt }))
  const seq = orderedOrders(ro)
  const byId = new Map(data.orders.map((o) => [o.orderId, o]))
  const pageOfUnit = new Map(data.pages.map((p) => [p.fulfillUnitId, p.pageIndex]))

  const warnings: string[] = []
  if (data.batch.pageCount !== data.batch.unitCount) warnings.push(`Page count (${data.batch.pageCount}) != unit count (${data.batch.unitCount}) — barcode tie required.`)
  const unmatched = data.pages.filter((p) => p.matchMethod === 'unmatched').length
  if (unmatched) warnings.push(`${unmatched} label page(s) not tied to a synced order.`)

  const sel = batches.map((b) => `<option value="${b.id}"${b.id === currentBatch ? ' selected' : ''}>${b.id} — ${b.pageCount}p (${b.status})</option>`).join('')
  const rows = seq.map((o) => {
    const ord = byId.get(o.orderId)!
    const items = ord.items.map((it) => `${it.sku ?? '?'} (Bin ${binOf(it.productName)})`).join(', ')
    const pageIdx = ord.fulfillUnitId != null ? pageOfUnit.get(ord.fulfillUnitId) : undefined
    const multi = ord.items.length > 1 ? ' class="multi"' : ''
    const view = pageIdx != null ? `<button data-page="${pageIdx}">View label</button>` : '—'
    return `<tr${multi}><td>${ord.buyer}</td><td>${ord.placedAt ? new Date(ord.placedAt).toLocaleTimeString() : ''}</td><td>${items}</td>
      <td><input type="checkbox" class="pack" data-order="${ord.orderId}"></td><td>${view}</td></tr>`
  }).join('')

  host.innerHTML = `
    <div class="picklist-toolbar">
      <select id="batch-sel">${sel}</select>
      <button id="export-labels">Export reordered labels</button>
      <button id="export-sheet">Export packing sheet</button>
      <button id="clear-labels">Clear labels</button>
    </div>
    ${warnings.length ? `<div class="warnings">${warnings.map((w) => `<div>⚠ ${w}</div>`).join('')}</div>` : ''}
    <table class="picklist"><thead><tr><th>Buyer</th><th>Purchased</th><th>Items (SKU / Bin)</th><th>Pack</th><th>Label</th></tr></thead><tbody>${rows}</tbody></table>`

  host.querySelector<HTMLSelectElement>('#batch-sel')!.onchange = (e) => { currentBatch = (e.target as HTMLSelectElement).value; void refresh() }
  host.querySelector('#export-labels')!.addEventListener('click', () => void window.picklistAPI.exportDoc(currentBatch!, 'labels'))
  host.querySelector('#export-sheet')!.addEventListener('click', () => void window.picklistAPI.exportDoc(currentBatch!, 'sheet'))
  host.querySelector('#clear-labels')!.addEventListener('click', async () => { if (confirm('Delete all captured label PDFs and tie data?')) { await window.picklistAPI.clear(); currentBatch = null; void refresh() } })
  host.querySelectorAll<HTMLInputElement>('.pack').forEach((cb) => { cb.onchange = () => void window.picklistAPI.setPacked(cb.dataset.order!, cb.checked) })
  host.querySelectorAll<HTMLButtonElement>('button[data-page]').forEach((b) => {
    b.onclick = async () => {
      const bytes = await window.picklistAPI.pagePdf(currentBatch!, Number(b.dataset.page))
      if (bytes) { const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); window.open(url, '_blank') }
    }
  })
}
```

- [ ] **Step 3: Mount from renderer.ts**

In `src/renderer/renderer.ts`, import and initialize when the picklist nav is shown (follow the file's existing nav/show pattern):

```ts
import { initPicklist } from './picklist'
// after the DOM/nav setup:
const picklistEl = document.getElementById('picklist')
if (picklistEl) initPicklist(picklistEl)
// wire #nav-picklist to unhide #picklist the same way the other nav buttons toggle their sections.
```

- [ ] **Step 4: Build and verify**

Run: `node esbuild.mjs`
Expected: `build complete`, no errors; `dist/renderer.js` rebuilt.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/picklist.ts src/renderer/renderer.ts src/renderer/index.html
git commit -m "feat(poc): interactive picklist view"
```

---

### Task 13: Barcode decode verification/fallback + manual import (optional path)

> Build this only after Spike #1 (Task 1 checklist) is run against a real batch. It is REQUIRED if the spike shows page_count ≠ unit_count or page order ≠ request order; otherwise it remains a verification + a hatch for batches captured without their `generate` request.

**Files:**
- Create: `src/electron/label-decode.ts`
- Test: `src/electron/__tests__/label-decode.test.ts`
- Modify: `src/electron/main.ts` (use as fallback when `status==='error'` due to count mismatch; add manual-import IPC), `package.json`

**Interfaces:**
- Produces:
  - `normalizeDigits(s: string): string`
  - `matchTracking(decoded: string, trackingNos: string[]): string | null` — substring containment of normalized digits (restack §9).
  - `decodeAllPages(pdfBytes: Uint8Array): Promise<(string | null)[]>` — rasterize + Code 128 decode per page.

- [ ] **Step 1: Install decode deps**

Run: `npm install zxing-wasm@^1 pdfjs-dist@^4`
Expected: both added to `dependencies`.

- [ ] **Step 2: Write the failing test for the pure matcher**

Create `src/electron/__tests__/label-decode.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { normalizeDigits, matchTracking } from '../label-decode'

describe('barcode matching (restack §9)', () => {
  it('strips non-digits', () => expect(normalizeDigits('9400 1112 2233')).toBe('9400111122233'))
  it('matches a CSV tracking that is a substring of the Impb-prefixed decode', () => {
    // decoded Impb string is longer than the human tracking number
    expect(matchTracking('420900409400111122233456', ['9400111122233'])).toBe('9400111122233')
  })
  it('returns null when nothing matches', () => expect(matchTracking('123', ['999'])).toBeNull())
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/electron/__tests__/label-decode.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement the matcher + decode**

Create `src/electron/label-decode.ts`:

```ts
const DIGITS = /\D/g

export function normalizeDigits(s: string): string {
  return (s || '').replace(DIGITS, '')
}

/** restack §9: a CSV tracking number is a substring of the (longer) Impb barcode decode. */
export function matchTracking(decoded: string, trackingNos: string[]): string | null {
  const d = normalizeDigits(decoded)
  if (!d) return null
  for (const t of trackingNos) {
    const nt = normalizeDigits(t)
    if (nt && d.includes(nt)) return t
  }
  return null
}

/** Rasterize each page and read its Code 128 barcode. Returns digit strings (or null per page).
 *  Uses pdfjs-dist for raster + zxing-wasm for decode. Heavier than the generate-order path,
 *  so this is fallback/verification only. */
export async function decodeAllPages(pdfBytes: Uint8Array): Promise<(string | null)[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const { readBarcodes } = await import('zxing-wasm/reader')
  const doc = await pdfjs.getDocument({ data: pdfBytes }).promise
  const out: (string | null)[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale: 3 })
    const canvas = new OffscreenCanvas(viewport.width, viewport.height)
    const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
    await page.render({ canvasContext: ctx, viewport }).promise
    const blob = await canvas.convertToBlob()
    const results = await readBarcodes(blob, { formats: ['Code128'] })
    const best = results.map((r) => normalizeDigits(r.text)).sort((a, b) => b.length - a.length)[0]
    out.push(best || null)
  }
  return out
}
```

> Note: `decodeAllPages` runs in the main process. If `OffscreenCanvas`/pdfjs raster is unavailable in the Electron main runtime, render in a hidden `BrowserWindow` instead (same pattern as `print-label` in `main.ts`). Keep `normalizeDigits`/`matchTracking` pure and unit-tested regardless.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/electron/__tests__/label-decode.test.ts`
Expected: PASS (pure matcher cases).

- [ ] **Step 6: Wire fallback + manual import in main**

In `src/electron/main.ts`, in the `tt-label-batch` handler, when `pageCount !== cap.fulfillUnitIds.length`, call `decodeAllPages` and re-tie via `matchTracking` against `orders.tracking_no` (from `getOrdersForRestack`), setting `match_method: 'barcode'`. Add an `ipcMain.handle('tt-label:import', ...)` that takes a file path, reads the PDF, decodes, ties by barcode, and persists a batch with no `generate` request. Add `importFromFile` to `picklistAPI`.

- [ ] **Step 7: Build + test + commit**

```bash
node esbuild.mjs && npx vitest run
git add -A
git commit -m "feat(poc): barcode decode fallback + manual PDF import"
```

---

### Task 14: Acceptance pass

**Files:**
- Test: `src/electron/__tests__/labels.test.ts` (integration over synthetic batch)
- Modify: none expected (fixes only if checks fail).

- [ ] **Step 1: Write an integration test over a synthetic batch**

Create `src/electron/__tests__/labels.test.ts` that: builds a synthetic N-page PDF (via the Task 1 `makePdf` helper, copied locally), inserts matching orders with `fulfill_unit_id`s, runs `tieByGenerateOrder`, persists, then asserts:
- `getLabelPages` count == page count;
- each tied page resolves to the right order via `getOrdersByFulfillUnit`;
- `reorderLabels` over the restack sequence yields a PDF whose page count == number of matched orders;
- `buildPackingSheet` row count matches.

```ts
import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { openDb, upsertOrders, getOrdersByFulfillUnit, insertLabelBatch, insertLabelPages, getLabelPages } from '../db'
import { tieByGenerateOrder } from '../../core/restack/tie'
import { reorderLabels, pdfPageCount } from '../label-pdf'

async function makePdf(n: number) { const d = await PDFDocument.create(); for (let i = 0; i < n; i++) d.addPage([200, 200]); return d.save() }

describe('label batch integration', () => {
  it('ties a synthetic 2-page batch to two orders and reorders', async () => {
    const db = openDb(':memory:')
    upsertOrders(db, [
      { externalOrderId: 'o1', buyerHandle: 'amy', placedAt: 100, tracking: 'T1', fulfillment: { fulfillUnitId: 'U1', trackingNo: 'T1' }, items: [], status: '', statusCode: '', buyerName: '', subtotalCents: 0, shippingCents: 0, shippingDiscountCents: 0, platformDiscountCents: 0, sellerDiscountCents: 0, taxCents: 0, originSaleCents: 0, totalCents: 0, address: null, carrier: null, liveTag: null, isAuction: false, isReversed: false, roomId: 'r', videoReceiptTs: null },
      { externalOrderId: 'o2', buyerHandle: 'bob', placedAt: 200, tracking: 'T2', fulfillment: { fulfillUnitId: 'U2', trackingNo: 'T2' }, items: [], status: '', statusCode: '', buyerName: '', subtotalCents: 0, shippingCents: 0, shippingDiscountCents: 0, platformDiscountCents: 0, sellerDiscountCents: 0, taxCents: 0, originSaleCents: 0, totalCents: 0, address: null, carrier: null, liveTag: null, isAuction: false, isReversed: false, roomId: 'r', videoReceiptTs: null },
    ] as never, Date.now())
    const units = ['U1', 'U2']
    const ties = tieByGenerateOrder(units, getOrdersByFulfillUnit(db))
    insertLabelBatch(db, { id: 'b1', capturedAt: 1, roomId: 'r', docUrl: null, pdfPath: null, pageCount: 2, unitCount: 2, status: 'tied', requestJson: JSON.stringify(units), statsJson: '[]' })
    insertLabelPages(db, 'b1', ties)
    expect(getLabelPages(db, 'b1')).toHaveLength(2)
    const reordered = await reorderLabels(await makePdf(2), [1, 0])
    expect(await pdfPageCount(reordered)).toBe(2)
  })
})
```

- [ ] **Step 2: Run the full suite**

Run: `npx vitest run`
Expected: PASS, all suites green.

- [ ] **Step 3: Manual end-to-end (Spike #1 + acceptance checklist)**

Run: `npm run dev`. Then:
- Open the Seller window (click Sync if not logged in), go to the To-Ship tab, select orders, print shipping labels.
- Confirm a batch appears in the Picklist view with `status: tied` and `pageCount === unitCount` (**Spike #1 check 1**).
- Click "View label" on a row and confirm the page shown is that buyer's label (**Spike #1 check 3**, visual).
- Export reordered labels + packing sheet; confirm the on-screen order matches the PDFs.
- Click "Clear labels"; confirm `userData/labels/` is emptied and the list is empty.
- Confirm `tt-db:getSnapshot` output contains no label data (PII isolation).

Record the Spike #1 result in the PR description. If check 1 or 3 fails, Task 13 (barcode decode) becomes the primary tie path.

- [ ] **Step 4: Commit**

```bash
git add src/electron/__tests__/labels.test.ts
git commit -m "test(poc): label batch integration + acceptance pass"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** capture (§3 → Tasks 4, 10), tie incl. combined fan-out (§4 → Tasks 5, 6), storage/migration/PII (§5 → Tasks 6, 7, 11), modules (§6 → Tasks 2–5, 8, 9, 13), picklist screen (§7 → Task 12), packing sheet (§8 → Task 9), error/edge (§9 → Task 10 status handling, Task 13 fallback, Task 12 warnings), testing/acceptance (§10 → Tasks 1–14), build order (§11 → task sequence). No gaps.
- **Placeholder scan:** all code steps contain real code; no TBD/TODO/"handle errors" placeholders.
- **Type consistency:** `RestackOrder`, `LabelPageTie`, `GenerateCapture`, `SheetRow`, `LabelBatchRow`, `RestackOrderRow` are defined once and consumed with matching shapes; `tieByGenerateOrder`/`orderedOrders`/`binOf`/`parseGenerateCapture` names match across tasks.
