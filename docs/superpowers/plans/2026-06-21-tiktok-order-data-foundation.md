# TikTok Order Data Foundation + Accuracy (Phase 0+1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move persistence from renderer `localStorage` into a main-process SQLite store, and enrich Seller-Center order parsing so the Ledger keys off stable `product_id`/`sku_id` and a full price breakdown.

**Architecture:** A new `src/electron/db.ts` owns a `better-sqlite3` database in `userData/tiktok.db`. `tiktok-orders.ts` parses richer `order/list` rows. `main.ts` upserts on sync and exposes DB queries over IPC; `preload-viewer.ts` bridges them as `dbAPI`. The renderer hydrates its in-memory working maps from `dbAPI.getSnapshot()` instead of `localStorage`, and persists every edit through `dbAPI.set*` — so `core/ledger.ts`, `ledgerRows()`, and all rendering stay unchanged.

**Tech Stack:** Electron 33, TypeScript, esbuild (bundling), better-sqlite3 (native), vitest (tests).

## Global Constraints

- **All TikTok IDs are stored and compared as `TEXT`/strings** — order, product, SKU, room, and order-line IDs exceed 2^53. Never let one ride through `JSON.parse` as a bare number (use the `res.text()` + quote-regex trick already in `fetchOrderDetails`).
- **Never persist signed URLs or PII** — no receipt `.m3u8` URLs, contact links, addresses, or phone numbers in the DB or fixtures. Store only safe anchors (`room_id`, `video_receipt_ts`).
- **Every new TikTok field is optional with a defensive fallback** (`?? null` / `?? 0`). Modules vary by order status, fulfillment type, and region; absence is normal, not an error.
- **Money is integer cents; times are epoch ms.**
- **`core/ledger.ts` and the Ledger/Picklist UI must not change** — rows still arrive as `LedgerRow[]`.
- **Commit after every task.** Run `npm test` before each commit; it must stay green.
- **Reasoning note (better-sqlite3 ABI):** `npm test` runs under system Node; `npm run dev` runs under Electron. The two need different native ABIs of `better-sqlite3`. `npm run dev` rebuilds for Electron; after running it, restore the Node ABI with `npm rebuild better-sqlite3` before running `npm test`. This dance is expected.

---

### Task 1: Add `better-sqlite3` and prove the native module loads

**Files:**
- Modify: `tiktok-live-poc/package.json`
- Modify: `tiktok-live-poc/esbuild.mjs:4`
- Test: `tiktok-live-poc/src/electron/__tests__/db-smoke.test.ts` (create)

**Interfaces:**
- Produces: a working `better-sqlite3` install + the esbuild `external` entry that every later task depends on.

- [ ] **Step 1: Add the dependency and the Electron rebuild script**

Edit `package.json` — add to `dependencies` and `devDependencies`, and add scripts:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "node esbuild.mjs",
    "dev": "electron-rebuild -w better-sqlite3 && node esbuild.mjs && electron .",
    "rebuild:node": "npm rebuild better-sqlite3"
  },
  "devDependencies": {
    "@electron/rebuild": "^3.6.0",
    "@types/better-sqlite3": "^7.6.11"
  },
  "dependencies": {
    "better-sqlite3": "^11.8.0",
    "flv.js": "^1.6.2"
  }
}
```

(Keep the existing `devDependencies` entries; only add the two new lines.)

- [ ] **Step 2: Mark `better-sqlite3` external in the esbuild Node bundles**

Edit `esbuild.mjs:4`:

```js
const common = { bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['electron', 'better-sqlite3'] }
```

- [ ] **Step 3: Install**

Run: `npm install`
Expected: completes; `node_modules/better-sqlite3/build/Release/better_sqlite3.node` exists.

- [ ] **Step 4: Write the failing smoke test**

Create `src/electron/__tests__/db-smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'

describe('better-sqlite3', () => {
  it('opens an in-memory database and round-trips a row', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)')
    db.prepare('INSERT INTO t (id, n) VALUES (?, ?)').run('a', 1)
    const row = db.prepare('SELECT n FROM t WHERE id = ?').get('a') as { n: number }
    expect(row.n).toBe(1)
    db.close()
  })
})
```

- [ ] **Step 5: Run it**

Run: `npm test -- db-smoke`
Expected: PASS. (If it fails with `NODE_MODULE_VERSION` mismatch, run `npm run rebuild:node` and re-run.)

- [ ] **Step 6: Manually verify the Electron ABI build**

Run: `npm run dev`
Expected: the app launches with no `better_sqlite3.node` load error in the terminal. Close it, then `npm run rebuild:node` to restore the Node ABI for tests.

- [ ] **Step 7: Commit**

```bash
git add tiktok-live-poc/package.json tiktok-live-poc/package-lock.json tiktok-live-poc/esbuild.mjs tiktok-live-poc/src/electron/__tests__/db-smoke.test.ts
git commit -m "build(tiktok): add better-sqlite3 + electron rebuild; smoke test"
```

---

### Task 2: Capture an `order/list` fixture and enrich the per-item parse

**Files:**
- Create: `tiktok-live-poc/fixtures/order-list-sample.json`
- Modify: `tiktok-live-poc/src/electron/tiktok-orders.ts:49-110` (`MappedOrder` + `mapTiktokOrder`)
- Test: `tiktok-live-poc/src/electron/__tests__/tiktok-orders.test.ts` (extend)

**Interfaces:**
- Produces: `MappedOrder.items[]` entries gain `productId`, `skuId`, `orderLineIds: string[]`, `imageUrl`, `unitPriceCents`, `totalPriceCents`; `MappedOrder` gains `platformDiscountCents`, `sellerDiscountCents`, `shippingDiscountCents`, `originSaleCents`.

> **Field-path note:** the field names below (`sku_module.product_id`, `sku_id`, `order_line_ids`, `product_image.url_list`, `sku_unit_price`, `sku_total_price`, `price_module.seller_discount` / `platform_discount` / `shipping_discount` / `origin_sale_price`) come from the `docs/tiktok-har-data-findings.md` inventory of the real HAR. Before this task is considered done, reconcile them against a real capture: run `node scripts/har-endpoint.mjs <path-to seller HAR> order/list` (the existing HAR tool) and confirm each path. Where a real path differs, update the fixture **and** the parser together. The defensive `get()`/`cents()` helpers already degrade to `null`/`0` on a wrong path, so a mismatch weakens data but never crashes.

- [ ] **Step 1: Create the fixture** (synthetic values, faithful shape, no PII)

Create `fixtures/order-list-sample.json`:

```json
{
  "main_order_id": "577000000000000001",
  "order_status_module": [{ "main_order_status": 101 }],
  "buyer_info_module": {
    "buyer_nickname": "shopper_demo",
    "shipping_address": { "items": [{ "key": "name", "value": "Demo Buyer" }, { "key": "city", "value": "Austin" }, { "key": "state", "value": "TX" }, { "key": "zipcode", "value": "78701" }] }
  },
  "price_module": {
    "grand_total": { "price_val": "82.00" },
    "sub_total": { "price_val": "75.00" },
    "shipping_fee": { "price_val": "6.00" },
    "shipping_discount": { "price_val": "0.00" },
    "taxes": { "price_val": "1.00" },
    "seller_discount": { "price_val": "5.00" },
    "platform_discount": { "price_val": "0.00" },
    "origin_sale_price": { "price_val": "80.00" }
  },
  "sku_module": [{
    "product_id": "1729500000000000001",
    "sku_id": "1729500000000099001",
    "product_name": "Bin A - Alo Yoga",
    "sku_name": "M",
    "seller_sku_name": "ALO-M",
    "quantity": 1,
    "product_image": { "url_list": ["https://example.invalid/img/a.jpg"] },
    "sku_unit_price": { "price_val": "75.00" },
    "sku_total_price": { "price_val": "75.00" },
    "order_line_ids": ["577000000000000001-1"]
  }],
  "trade_order_module": { "create_time": 1718900000 },
  "extra_data_map": { "auction_tag": "1", "sales_source_live_tag": { "value": { "v_dynamic_express": { "items": [{ "message_content": "LIVE 6/20" }] } } } }
}
```

- [ ] **Step 2: Write the failing test**

Append to `src/electron/__tests__/tiktok-orders.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('mapTiktokOrder — enriched fields', () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, '../../../fixtures/order-list-sample.json'), 'utf8'))

  it('parses stable product/sku identity and per-item prices', () => {
    const m = mapTiktokOrder(fixture)
    const it = m.items[0]!
    expect(it.productId).toBe('1729500000000000001')
    expect(it.skuId).toBe('1729500000000099001')
    expect(it.orderLineIds).toEqual(['577000000000000001-1'])
    expect(it.imageUrl).toBe('https://example.invalid/img/a.jpg')
    expect(it.unitPriceCents).toBe(7500)
    expect(it.totalPriceCents).toBe(7500)
  })

  it('parses the price breakdown', () => {
    const m = mapTiktokOrder(fixture)
    expect(m.subtotalCents).toBe(7500)
    expect(m.shippingCents).toBe(600)
    expect(m.taxCents).toBe(100)
    expect(m.sellerDiscountCents).toBe(500)
    expect(m.platformDiscountCents).toBe(0)
    expect(m.originSaleCents).toBe(8000)
  })
})
```

- [ ] **Step 3: Run it**

Run: `npm test -- tiktok-orders`
Expected: FAIL — `it.productId` is `undefined`, breakdown fields missing.

- [ ] **Step 4: Extend `MappedOrder`** (`tiktok-orders.ts:49-67`)

Replace the `items` line and add breakdown fields:

```ts
export interface MappedOrder {
  externalOrderId: string
  status: string
  statusCode: string | null
  buyerHandle: string | null
  buyerName: string | null
  subtotalCents: number
  shippingCents: number
  shippingDiscountCents: number
  platformDiscountCents: number
  sellerDiscountCents: number
  taxCents: number
  originSaleCents: number
  totalCents: number
  address: string | null
  carrier: string | null
  tracking: string | null
  liveTag: string | null
  isAuction: boolean
  isReversed: boolean
  placedAt: number | null
  roomId: string | null
  videoReceiptTs: number | null
  items: {
    productId: string | null
    skuId: string | null
    productName: string | null
    variant: string | null
    quantity: number
    unitPriceCents: number
    totalPriceCents: number
    imageUrl: string | null
    orderLineIds: string[]
  }[]
}
```

- [ ] **Step 5: Enrich the item map and breakdown in `mapTiktokOrder`** (`tiktok-orders.ts:81-109`)

Replace the `items` mapping and the returned object's price fields:

```ts
  const skus = (Array.isArray(o.sku_module) ? o.sku_module : []) as Raw[]
  const items = skus.map((s) => ({
    productId: (get(s, 'product_id') ?? null) as string | null,
    skuId: (get(s, 'sku_id') ?? null) as string | null,
    productName: (get(s, 'product_name') ?? null) as string | null,
    variant: (get(s, 'sku_name') ?? get(s, 'seller_sku_name') ?? null) as string | null,
    quantity: num(get(s, 'quantity')) ?? 0,
    unitPriceCents: cents(get(s, 'sku_unit_price')),
    totalPriceCents: cents(get(s, 'sku_total_price')),
    imageUrl: (get(s, 'product_image.url_list.0') ?? null) as string | null,
    orderLineIds: Array.isArray(get(s, 'order_line_ids')) ? (get(s, 'order_line_ids') as unknown[]).map(String) : [],
  }))
```

In the `return { ... }` object add the breakdown + auction-module fields (alongside the existing `subtotalCents`/`shippingCents`/`taxCents`/`totalCents`):

```ts
    shippingDiscountCents: cents(get(o, 'price_module.shipping_discount')),
    platformDiscountCents: cents(get(o, 'price_module.platform_discount')),
    sellerDiscountCents: cents(get(o, 'price_module.seller_discount')),
    originSaleCents: cents(get(o, 'price_module.origin_sale_price')),
    roomId: get(o, 'auction_module.live_room_id') != null ? String(get(o, 'auction_module.live_room_id')) : null,
    videoReceiptTs: num(get(o, 'auction_module.video_receipt_timestamp')) != null ? Math.round(num(get(o, 'auction_module.video_receipt_timestamp'))!) : null,
```

- [ ] **Step 6: Run the test**

Run: `npm test -- tiktok-orders`
Expected: PASS (existing tests still pass too).

- [ ] **Step 7: Commit**

```bash
git add tiktok-live-poc/fixtures/order-list-sample.json tiktok-live-poc/src/electron/tiktok-orders.ts tiktok-live-poc/src/electron/__tests__/tiktok-orders.test.ts
git commit -m "feat(tiktok): parse product_id/sku_id, per-item prices, discounts from order/list"
```

---

### Task 3: Switch `Sale.productId` to `product_id`, add `priceBreakdown`, read `auction_module` inline

**Files:**
- Modify: `tiktok-live-poc/src/core/types.ts:142-157` (add `skuId`, `priceBreakdown` + `PriceBreakdown`)
- Modify: `tiktok-live-poc/src/electron/tiktok-orders.ts:112-141` (`orderToSale`), `:155-194` (`pullTiktokOrders`), `:146-151` (`TT_ORDER_EXTRA_DATA`)
- Test: `tiktok-live-poc/src/electron/__tests__/tiktok-orders.test.ts` (extend)

**Interfaces:**
- Consumes: enriched `MappedOrder` from Task 2.
- Produces: `Sale.productId` = first item's `product_id` (name only as fallback); `Sale.skuId`, `Sale.productImageUrl`, `Sale.priceBreakdown` populated. `PriceBreakdown` interface exported from `core/types.ts`.

- [ ] **Step 1: Write the failing test**

Append to `src/electron/__tests__/tiktok-orders.test.ts`:

```ts
describe('orderToSale — stable identity + breakdown', () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, '../../../fixtures/order-list-sample.json'), 'utf8'))

  it('uses product_id as Sale.productId, not the name', () => {
    const s = orderToSale(mapTiktokOrder(fixture))
    expect(s.productId).toBe('1729500000000000001')
    expect(s.skuId).toBe('1729500000000099001')
    expect(s.productImageUrl).toBe('https://example.invalid/img/a.jpg')
    expect(s.priceBreakdown?.sellerDiscountCents).toBe(500)
    expect(s.priceBreakdown?.subtotalCents).toBe(7500)
  })

  it('falls back to product name when product_id is absent', () => {
    const noId = { ...fixture, sku_module: [{ product_name: 'Legacy Bin', sku_name: 'M' }] }
    expect(orderToSale(mapTiktokOrder(noId)).productId).toBe('Legacy Bin')
  })
})
```

- [ ] **Step 2: Run it**

Run: `npm test -- tiktok-orders`
Expected: FAIL — `s.productId` is the name; `priceBreakdown` undefined.

- [ ] **Step 3: Add `PriceBreakdown` + `Sale` fields** (`core/types.ts`)

Add after the `Money` interface:

```ts
export interface PriceBreakdown {
  grandTotalCents: number
  subtotalCents?: number
  originSaleCents?: number
  sellerDiscountCents?: number
  platformDiscountCents?: number
  shippingFeeCents?: number
  shippingDiscountCents?: number
  taxCents?: number
}
```

In `interface Sale`, add two optional fields (after `productImageUrl?`):

```ts
  skuId?: string
  priceBreakdown?: PriceBreakdown
```

- [ ] **Step 4: Update `orderToSale`** (`tiktok-orders.ts:112-141`)

```ts
export function orderToSale(o: MappedOrder): Sale {
  const item = o.items[0]
  const productName = item?.productName ?? '(item)'
  const productId = item?.productId || productName // stable id when present; name only as fallback
  const paymentStatus: Sale['paymentStatus'] =
    o.isReversed ? 'failed' : o.status === 'Unpaid' ? 'pending' : 'paid'
  return {
    orderId: o.externalOrderId,
    buyer: { username: o.buyerName || o.buyerHandle || '—', handle: o.buyerHandle ?? undefined },
    productId,
    productName,
    productImageUrl: item?.imageUrl ?? undefined,
    skuId: item?.skuId ?? undefined,
    skuDesc: item?.variant ?? (o.items.length > 1 ? `${o.items.length} items` : ''),
    price: { cents: o.totalCents, formatted: '$' + (o.totalCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
    priceBreakdown: {
      grandTotalCents: o.totalCents,
      subtotalCents: o.subtotalCents,
      originSaleCents: o.originSaleCents,
      sellerDiscountCents: o.sellerDiscountCents,
      platformDiscountCents: o.platformDiscountCents,
      shippingFeeCents: o.shippingCents,
      shippingDiscountCents: o.shippingDiscountCents,
      taxCents: o.taxCents,
    },
    paymentStatus,
    createdAt: o.placedAt ?? Date.now(),
    liveTag: o.liveTag ?? undefined,
    detail: {
      status: o.status,
      subtotalCents: o.subtotalCents,
      shippingCents: o.shippingCents,
      taxCents: o.taxCents,
      address: o.address ?? undefined,
      carrier: o.carrier ?? undefined,
      tracking: o.tracking ?? undefined,
      items: o.items.map((it) => ({ productName: it.productName ?? '(item)', variant: it.variant ?? undefined, quantity: it.quantity })),
      isAuction: o.isAuction,
      orderUrl: `https://seller-us.tiktok.com/order/detail?order_no=${o.externalOrderId}`,
    },
  }
}
```

- [ ] **Step 5: Add `replacement_order_tag_v1`** (`tiktok-orders.ts:146-151`)

Append `'replacement_order_tag_v1'` to the `TT_ORDER_EXTRA_DATA` array.

- [ ] **Step 6: Preserve `live_room_id` precision in `pullTiktokOrders`** (`tiktok-orders.ts:180-181`)

Replace the response parse so the 19-digit `live_room_id` in `auction_module` survives (mirrors `fetchOrderDetails:234-236`):

```ts
    if (!res.ok) throw new Error(`order/list HTTP ${res.status}`)
    const text = await res.text()
    const j = JSON.parse(text.replace(/"live_room_id":\s*(\d+)/g, '"live_room_id":"$1"')) as Raw
```

- [ ] **Step 7: Run the test**

Run: `npm test -- tiktok-orders`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tiktok-live-poc/src/core/types.ts tiktok-live-poc/src/electron/tiktok-orders.ts tiktok-live-poc/src/electron/__tests__/tiktok-orders.test.ts
git commit -m "feat(tiktok): Sale keys off product_id + carries priceBreakdown; request replacement tag"
```

---

### Task 4: `db.ts` — schema, `upsertOrders`, `getSnapshot`

**Files:**
- Create: `tiktok-live-poc/src/electron/db.ts`
- Test: `tiktok-live-poc/src/electron/__tests__/db.test.ts` (create)

**Interfaces:**
- Consumes: `MappedOrder` + `orderToSale` (Task 2/3), `Sale` (`core/types`), `LedgerTranscript` (`core/ledger`).
- Produces:
  - `openDb(path: string): Database.Database`
  - `upsertOrders(db, orders: MappedOrder[], now: number): void`
  - `getSnapshot(db): DbSnapshot` where `DbSnapshot = { orders: Sale[]; costs: Record<string,number>; productCosts: Record<string,number>; orderTx: Record<string,LedgerTranscript>; productTx: Record<string,LedgerTranscript>; picked: string[]; shows: unknown }`

- [ ] **Step 1: Write the failing test**

Create `src/electron/__tests__/db.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { openDb, upsertOrders, getSnapshot } from '../db'
import { mapTiktokOrder } from '../tiktok-orders'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const fixture = JSON.parse(readFileSync(join(__dirname, '../../../fixtures/order-list-sample.json'), 'utf8'))

describe('db: orders', () => {
  it('upserts an order and returns it in the snapshot as a Sale', () => {
    const db = openDb(':memory:')
    upsertOrders(db, [mapTiktokOrder(fixture)], 1000)
    const snap = getSnapshot(db)
    expect(snap.orders).toHaveLength(1)
    expect(snap.orders[0]!.orderId).toBe('577000000000000001')
    expect(snap.orders[0]!.productId).toBe('1729500000000000001')
    db.close()
  })

  it('upsert is idempotent (re-sync updates, never duplicates)', () => {
    const db = openDb(':memory:')
    upsertOrders(db, [mapTiktokOrder(fixture)], 1000)
    upsertOrders(db, [mapTiktokOrder(fixture)], 2000)
    const snap = getSnapshot(db)
    expect(snap.orders).toHaveLength(1)
    const items = db.prepare('SELECT COUNT(*) c FROM order_items').get() as { c: number }
    expect(items.c).toBe(1) // not duplicated
    db.close()
  })
})
```

- [ ] **Step 2: Run it**

Run: `npm test -- db.test`
Expected: FAIL — `../db` does not exist.

- [ ] **Step 3: Create `db.ts`**

```ts
// Main-process SQLite store. Owns all persisted order/transaction data; the renderer
// reads/writes through IPC (see main.ts). Pure data access — no TikTok/network logic.
import Database from 'better-sqlite3'
import { orderToSale, type MappedOrder } from './tiktok-orders'
import type { Sale } from '../core/types'
import type { LedgerTranscript } from '../core/ledger'

export type Db = Database.Database

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  status TEXT, status_code TEXT,
  buyer_handle TEXT, buyer_name TEXT,
  total_cents INTEGER, subtotal_cents INTEGER,
  shipping_cents INTEGER, shipping_discount_cents INTEGER,
  platform_discount_cents INTEGER, seller_discount_cents INTEGER,
  tax_cents INTEGER, origin_sale_cents INTEGER,
  live_tag TEXT, room_id TEXT,
  is_auction INTEGER, is_reversed INTEGER,
  placed_at INTEGER, video_receipt_ts INTEGER,
  payment_status TEXT, sale_json TEXT, synced_at INTEGER
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  line_index INTEGER,
  product_id TEXT, sku_id TEXT,
  product_name TEXT, variant TEXT,
  quantity INTEGER,
  unit_price_cents INTEGER, total_price_cents INTEGER,
  image_url TEXT, order_line_ids TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_product ON order_items(product_id);
CREATE TABLE IF NOT EXISTS costs (scope TEXT, key TEXT, cents INTEGER, updated_at INTEGER, PRIMARY KEY (scope, key));
CREATE TABLE IF NOT EXISTS transcripts (scope TEXT, key TEXT, brand TEXT, item TEXT, color TEXT, size TEXT, retail_price TEXT, summary TEXT, updated_at INTEGER, PRIMARY KEY (scope, key));
CREATE TABLE IF NOT EXISTS picks (order_id TEXT PRIMARY KEY, picked_at INTEGER);
CREATE TABLE IF NOT EXISTS product_aliases (name TEXT PRIMARY KEY, product_id TEXT, created_at INTEGER);
`

export interface DbSnapshot {
  orders: Sale[]
  costs: Record<string, number>
  productCosts: Record<string, number>
  orderTx: Record<string, LedgerTranscript>
  productTx: Record<string, LedgerTranscript>
  picked: string[]
  shows: unknown
}

export function openDb(path: string): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('schema_version', '1')").run()
  return db
}

const UPSERT_ORDER = `
INSERT INTO orders (order_id,status,status_code,buyer_handle,buyer_name,total_cents,subtotal_cents,shipping_cents,shipping_discount_cents,platform_discount_cents,seller_discount_cents,tax_cents,origin_sale_cents,live_tag,room_id,is_auction,is_reversed,placed_at,video_receipt_ts,payment_status,sale_json,synced_at)
VALUES (@order_id,@status,@status_code,@buyer_handle,@buyer_name,@total_cents,@subtotal_cents,@shipping_cents,@shipping_discount_cents,@platform_discount_cents,@seller_discount_cents,@tax_cents,@origin_sale_cents,@live_tag,@room_id,@is_auction,@is_reversed,@placed_at,@video_receipt_ts,@payment_status,@sale_json,@synced_at)
ON CONFLICT(order_id) DO UPDATE SET
  status=@status,status_code=@status_code,buyer_handle=@buyer_handle,buyer_name=@buyer_name,
  total_cents=@total_cents,subtotal_cents=@subtotal_cents,shipping_cents=@shipping_cents,shipping_discount_cents=@shipping_discount_cents,
  platform_discount_cents=@platform_discount_cents,seller_discount_cents=@seller_discount_cents,tax_cents=@tax_cents,origin_sale_cents=@origin_sale_cents,
  live_tag=@live_tag,room_id=@room_id,is_auction=@is_auction,is_reversed=@is_reversed,placed_at=@placed_at,video_receipt_ts=@video_receipt_ts,
  payment_status=@payment_status,sale_json=@sale_json,synced_at=@synced_at`

export function upsertOrders(db: Db, orders: MappedOrder[], now: number): void {
  const up = db.prepare(UPSERT_ORDER)
  const delItems = db.prepare('DELETE FROM order_items WHERE order_id = ?')
  const insItem = db.prepare('INSERT INTO order_items (order_id,line_index,product_id,sku_id,product_name,variant,quantity,unit_price_cents,total_price_cents,image_url,order_line_ids) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  const run = db.transaction((list: MappedOrder[]) => {
    for (const o of list) {
      const sale = orderToSale(o)
      up.run({
        order_id: o.externalOrderId,
        status: o.status, status_code: o.statusCode,
        buyer_handle: o.buyerHandle, buyer_name: o.buyerName,
        total_cents: o.totalCents, subtotal_cents: o.subtotalCents,
        shipping_cents: o.shippingCents, shipping_discount_cents: o.shippingDiscountCents,
        platform_discount_cents: o.platformDiscountCents, seller_discount_cents: o.sellerDiscountCents,
        tax_cents: o.taxCents, origin_sale_cents: o.originSaleCents,
        live_tag: o.liveTag, room_id: o.roomId,
        is_auction: o.isAuction ? 1 : 0, is_reversed: o.isReversed ? 1 : 0,
        placed_at: o.placedAt, video_receipt_ts: o.videoReceiptTs,
        payment_status: sale.paymentStatus, sale_json: JSON.stringify(sale), synced_at: now,
      })
      delItems.run(o.externalOrderId)
      o.items.forEach((it, i) =>
        insItem.run(o.externalOrderId, i, it.productId, it.skuId, it.productName, it.variant, it.quantity, it.unitPriceCents, it.totalPriceCents, it.imageUrl, it.orderLineIds.length ? JSON.stringify(it.orderLineIds) : null))
    }
  })
  run(orders)
}

interface CostRow { scope: string; key: string; cents: number }
interface TxRow { scope: string; key: string; brand: string | null; item: string | null; color: string | null; size: string | null; retail_price: string | null; summary: string | null }

export function getSnapshot(db: Db): DbSnapshot {
  const orders = (db.prepare('SELECT sale_json FROM orders ORDER BY placed_at DESC').all() as { sale_json: string }[])
    .map((r) => JSON.parse(r.sale_json) as Sale)
  const costs: Record<string, number> = {}
  const productCosts: Record<string, number> = {}
  for (const r of db.prepare('SELECT scope,key,cents FROM costs').all() as CostRow[]) {
    (r.scope === 'product' ? productCosts : costs)[r.key] = r.cents
  }
  const orderTx: Record<string, LedgerTranscript> = {}
  const productTx: Record<string, LedgerTranscript> = {}
  for (const r of db.prepare('SELECT * FROM transcripts').all() as TxRow[]) {
    const t: LedgerTranscript = {
      brand: r.brand ?? undefined, item: r.item ?? undefined, color: r.color ?? undefined,
      size: r.size ?? undefined, retailPrice: r.retail_price ?? undefined, summary: r.summary ?? undefined,
    }
    ;(r.scope === 'product' ? productTx : orderTx)[r.key] = t
  }
  const picked = (db.prepare('SELECT order_id FROM picks').all() as { order_id: string }[]).map((r) => r.order_id)
  const showsRow = db.prepare("SELECT v FROM meta WHERE k = 'shows'").get() as { v: string } | undefined
  return { orders, costs, productCosts, orderTx, productTx, picked, shows: showsRow ? JSON.parse(showsRow.v) : {} }
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- db.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tiktok-live-poc/src/electron/db.ts tiktok-live-poc/src/electron/__tests__/db.test.ts
git commit -m "feat(tiktok): db.ts schema + upsertOrders + getSnapshot"
```

---

### Task 5: `db.ts` — user-owned setters (cost, transcript, pick, shows)

**Files:**
- Modify: `tiktok-live-poc/src/electron/db.ts`
- Test: `tiktok-live-poc/src/electron/__tests__/db.test.ts` (extend)

**Interfaces:**
- Produces:
  - `setCost(db, scope: 'order'|'product', key: string, cents: number | null, now: number): void`
  - `setTranscript(db, scope: 'order'|'product', key: string, t: LedgerTranscript | null, now: number): void`
  - `setPicked(db, orderId: string, picked: boolean, now: number): void`
  - `getShows(db): unknown` / `setShows(db, store: unknown): void`

- [ ] **Step 1: Write the failing test**

Append to `db.test.ts`:

```ts
import { setCost, setTranscript, setPicked, getShows, setShows } from '../db'

describe('db: user-owned data', () => {
  it('sets and clears an order-level cost', () => {
    const db = openDb(':memory:')
    setCost(db, 'order', 'O1', 1234, 1)
    expect(getSnapshot(db).costs.O1).toBe(1234)
    setCost(db, 'order', 'O1', null, 2)
    expect(getSnapshot(db).costs.O1).toBeUndefined()
    db.close()
  })

  it('stores a product transcript and a pick and shows blob', () => {
    const db = openDb(':memory:')
    setTranscript(db, 'product', 'P1', { brand: 'Alo', item: 'Leggings' }, 1)
    setPicked(db, 'O9', true, 1)
    setShows(db, { s1: { name: 'Show 1' } })
    const snap = getSnapshot(db)
    expect(snap.productTx.P1!.brand).toBe('Alo')
    expect(snap.picked).toContain('O9')
    expect(getShows(db)).toEqual({ s1: { name: 'Show 1' } })
    db.close()
  })
})
```

- [ ] **Step 2: Run it**

Run: `npm test -- db.test`
Expected: FAIL — setters not exported.

- [ ] **Step 3: Add the setters to `db.ts`**

```ts
export function setCost(db: Db, scope: 'order' | 'product', key: string, cents: number | null, now: number): void {
  if (cents == null) db.prepare('DELETE FROM costs WHERE scope=? AND key=?').run(scope, key)
  else db.prepare('INSERT INTO costs (scope,key,cents,updated_at) VALUES (?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET cents=excluded.cents,updated_at=excluded.updated_at').run(scope, key, cents, now)
}

export function setTranscript(db: Db, scope: 'order' | 'product', key: string, t: LedgerTranscript | null, now: number): void {
  if (t == null) { db.prepare('DELETE FROM transcripts WHERE scope=? AND key=?').run(scope, key); return }
  db.prepare(`INSERT INTO transcripts (scope,key,brand,item,color,size,retail_price,summary,updated_at)
    VALUES (@scope,@key,@brand,@item,@color,@size,@retail_price,@summary,@now)
    ON CONFLICT(scope,key) DO UPDATE SET brand=excluded.brand,item=excluded.item,color=excluded.color,size=excluded.size,retail_price=excluded.retail_price,summary=excluded.summary,updated_at=excluded.updated_at`)
    .run({ scope, key, brand: t.brand ?? null, item: t.item ?? null, color: t.color ?? null, size: t.size ?? null, retail_price: t.retailPrice ?? null, summary: t.summary ?? null, now })
}

export function setPicked(db: Db, orderId: string, picked: boolean, now: number): void {
  if (picked) db.prepare('INSERT OR IGNORE INTO picks (order_id,picked_at) VALUES (?,?)').run(orderId, now)
  else db.prepare('DELETE FROM picks WHERE order_id=?').run(orderId)
}

export function getShows(db: Db): unknown {
  const r = db.prepare("SELECT v FROM meta WHERE k = 'shows'").get() as { v: string } | undefined
  return r ? JSON.parse(r.v) : {}
}

export function setShows(db: Db, store: unknown): void {
  db.prepare("INSERT INTO meta (k,v) VALUES ('shows',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify(store))
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- db.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tiktok-live-poc/src/electron/db.ts tiktok-live-poc/src/electron/__tests__/db.test.ts
git commit -m "feat(tiktok): db.ts cost/transcript/pick/shows setters"
```

---

### Task 6: `db.ts` — legacy import + product-template re-keying

**Files:**
- Modify: `tiktok-live-poc/src/electron/db.ts`
- Test: `tiktok-live-poc/src/electron/__tests__/db.test.ts` (extend)

**Interfaces:**
- Consumes: `upsertOrders` (Task 4), setters (Task 5).
- Produces:
  - `LegacyBlob = { cost?, productCost?, orderTx?, productTx?, orders?: Sale[], shows?, picked?: string[] }`
  - `isMigrated(db): boolean`
  - `importLegacy(db, blob: LegacyBlob, now: number): void` (one-shot, guarded)
  - `rekeyProductTemplates(db, now: number): void` (call after each enriched sync)

- [ ] **Step 1: Write the failing test**

Append to `db.test.ts`:

```ts
import { importLegacy, isMigrated, rekeyProductTemplates } from '../db'

describe('db: legacy migration + re-key', () => {
  it('imports localStorage blobs once and is idempotent', () => {
    const db = openDb(':memory:')
    const blob = { cost: { O1: 500 }, productCost: { 'Bin A - Alo Yoga': 2000 }, productTx: { 'Bin A - Alo Yoga': { brand: 'Alo' } }, picked: ['O1'], shows: { a: 1 } }
    expect(isMigrated(db)).toBe(false)
    importLegacy(db, blob, 1)
    importLegacy(db, blob, 2) // second call is a no-op
    expect(isMigrated(db)).toBe(true)
    const snap = getSnapshot(db)
    expect(snap.costs.O1).toBe(500)
    expect(snap.productCosts['Bin A - Alo Yoga']).toBe(2000)
    expect(snap.picked).toEqual(['O1'])
    db.close()
  })

  it('re-keys name-keyed product templates to product_id after a sync', () => {
    const db = openDb(':memory:')
    importLegacy(db, { productCost: { 'Bin A - Alo Yoga': 2000 }, productTx: { 'Bin A - Alo Yoga': { brand: 'Alo' } } }, 1)
    upsertOrders(db, [mapTiktokOrder(fixture)], 1) // order_items now maps "Bin A - Alo Yoga" -> 1729500000000000001
    rekeyProductTemplates(db, 2)
    const snap = getSnapshot(db)
    expect(snap.productCosts['1729500000000000001']).toBe(2000)
    expect(snap.productCosts['Bin A - Alo Yoga']).toBeUndefined()
    expect(snap.productTx['1729500000000000001']!.brand).toBe('Alo')
    db.close()
  })
})
```

- [ ] **Step 2: Run it**

Run: `npm test -- db.test`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Add migration + re-key to `db.ts`**

```ts
export interface LegacyBlob {
  cost?: Record<string, number>
  productCost?: Record<string, number>
  orderTx?: Record<string, LedgerTranscript>
  productTx?: Record<string, LedgerTranscript>
  orders?: Sale[]
  shows?: unknown
  picked?: string[]
}

export function isMigrated(db: Db): boolean {
  const r = db.prepare("SELECT v FROM meta WHERE k = 'legacy_migrated'").get() as { v: string } | undefined
  return r?.v === '1'
}

export function importLegacy(db: Db, blob: LegacyBlob, now: number): void {
  if (isMigrated(db)) return
  const run = db.transaction(() => {
    for (const [k, c] of Object.entries(blob.cost ?? {})) setCost(db, 'order', k, c, now)
    for (const [k, c] of Object.entries(blob.productCost ?? {})) setCost(db, 'product', k, c, now)
    for (const [k, t] of Object.entries(blob.orderTx ?? {})) setTranscript(db, 'order', k, t, now)
    for (const [k, t] of Object.entries(blob.productTx ?? {})) setTranscript(db, 'product', k, t, now)
    for (const id of blob.picked ?? []) setPicked(db, id, true, now)
    if (blob.shows) setShows(db, blob.shows)
    // cached orders: keep the Sale blob so the ledger renders before the first re-sync.
    const ins = db.prepare("INSERT INTO orders (order_id,total_cents,payment_status,live_tag,placed_at,is_auction,is_reversed,sale_json,synced_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(order_id) DO NOTHING")
    for (const s of blob.orders ?? []) {
      ins.run(s.orderId, s.price.cents, s.paymentStatus, s.liveTag ?? null, s.createdAt, s.detail?.isAuction ? 1 : 0, 0, JSON.stringify(s), now)
    }
    db.prepare("INSERT INTO meta (k,v) VALUES ('legacy_migrated','1') ON CONFLICT(k) DO UPDATE SET v='1'").run()
  })
  run()
}

/** After an enriched sync, re-key name-keyed product cost/transcript rows to product_id. */
export function rekeyProductTemplates(db: Db, now: number): void {
  const rows = db.prepare('SELECT DISTINCT product_name, product_id FROM order_items WHERE product_id IS NOT NULL AND product_name IS NOT NULL').all() as { product_name: string; product_id: string }[]
  const run = db.transaction(() => {
    for (const { product_name: name, product_id: pid } of rows) {
      if (name === pid) continue
      const c = db.prepare("SELECT cents FROM costs WHERE scope='product' AND key=?").get(name) as { cents: number } | undefined
      if (c) {
        db.prepare("INSERT INTO costs (scope,key,cents,updated_at) VALUES ('product',?,?,?) ON CONFLICT(scope,key) DO UPDATE SET cents=excluded.cents,updated_at=excluded.updated_at").run(pid, c.cents, now)
        db.prepare("DELETE FROM costs WHERE scope='product' AND key=?").run(name)
      }
      const t = db.prepare("SELECT * FROM transcripts WHERE scope='product' AND key=?").get(name) as TxRow | undefined
      if (t) {
        db.prepare(`INSERT INTO transcripts (scope,key,brand,item,color,size,retail_price,summary,updated_at) VALUES ('product',?,?,?,?,?,?,?,?)
          ON CONFLICT(scope,key) DO UPDATE SET brand=excluded.brand,item=excluded.item,color=excluded.color,size=excluded.size,retail_price=excluded.retail_price,summary=excluded.summary,updated_at=excluded.updated_at`)
          .run(pid, t.brand, t.item, t.color, t.size, t.retail_price, t.summary, now)
        db.prepare("DELETE FROM transcripts WHERE scope='product' AND key=?").run(name)
      }
      db.prepare("INSERT OR IGNORE INTO product_aliases (name,product_id,created_at) VALUES (?,?,?)").run(name, pid, now)
    }
  })
  run()
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- db.test`
Expected: PASS. Then full run: `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add tiktok-live-poc/src/electron/db.ts tiktok-live-poc/src/electron/__tests__/db.test.ts
git commit -m "feat(tiktok): db.ts legacy import + product-template re-keying"
```

---

### Task 7: Wire the DB into `main.ts` (init, sync upsert, IPC handlers)

**Files:**
- Modify: `tiktok-live-poc/src/electron/main.ts` (imports `:1-13`; app-ready init; `tt-sync` handler `:280-302`; new IPC handlers)

**Interfaces:**
- Consumes: all `db.ts` exports (Tasks 4-6).
- Produces IPC channels: `tt-db:getSnapshot`, `tt-db:setCost`, `tt-db:setProductCost`, `tt-db:setTranscript`, `tt-db:setPicked`, `tt-db:getShows`, `tt-db:setShows`, `tt-db:importLegacy`.

> **Testing note:** `main.ts` is Electron-bound and not unit-tested in this repo (consistent with existing `main.ts`). All DB logic it calls is already covered by `db.test.ts`; `main.ts` only delegates. Verify via the manual checklist in Step 5.

- [ ] **Step 1: Add the import and open the DB**

Add to the imports (`main.ts:11`):

```ts
import { openDb, upsertOrders, getSnapshot, setCost, setTranscript, setPicked, getShows, setShows, importLegacy, rekeyProductTemplates, type LegacyBlob } from './db'
```

Add a module-level handle near the other `let` declarations (`main.ts:23-28`):

```ts
let db: ReturnType<typeof openDb> | null = null
```

In the app-ready flow (where windows are created — find `app.whenReady().then(...)` / the existing init), open the DB before creating the viewer:

```ts
  db = openDb(join(app.getPath('userData'), 'tiktok.db'))
```

- [ ] **Step 2: Upsert on sync** — replace the body of the `tt-sync` handler (`main.ts:286-301`)

```ts
  orderSyncing = true
  try {
    const cookieHeader = await tiktokCookieHeader()
    const { orders, total } = await pullTiktokOrders(cookieHeader)
    const now = Date.now()
    if (db) { upsertOrders(db, orders, now); rekeyProductTemplates(db, now) }
    debug(`[tt] synced ${orders.length}/${total} orders`)
    return { ok: true, count: orders.length }
  } catch (e) {
    const msg = (e as Error).message
    if (/code\s|HTTP 401|session may be expired/i.test(msg)) openSellerLogin()
    return { ok: false, reason: msg.slice(0, 160) }
  } finally {
    orderSyncing = false
  }
```

(The `send({ kind: 'orders', ... })` push is removed — the renderer re-hydrates via `tt-db:getSnapshot` after a successful sync, Task 8.)

- [ ] **Step 3: Register the DB IPC handlers** — add near the other `ipcMain.handle` blocks (e.g. after `save-printer`, `main.ts:249`)

```ts
ipcMain.handle('tt-db:getSnapshot', () => (db ? getSnapshot(db) : { orders: [], costs: {}, productCosts: {}, orderTx: {}, productTx: {}, picked: [], shows: {} }))
ipcMain.handle('tt-db:setCost', (_e, p: { orderId: string; cents: number | null }) => { if (db) setCost(db, 'order', p.orderId, p.cents, Date.now()); return true })
ipcMain.handle('tt-db:setProductCost', (_e, p: { productId: string; cents: number | null }) => { if (db) setCost(db, 'product', p.productId, p.cents, Date.now()); return true })
ipcMain.handle('tt-db:setTranscript', (_e, p: { scope: 'order' | 'product'; key: string; transcript: unknown | null }) => { if (db) setTranscript(db, p.scope, p.key, p.transcript as never, Date.now()); return true })
ipcMain.handle('tt-db:setPicked', (_e, p: { orderId: string; picked: boolean }) => { if (db) setPicked(db, p.orderId, p.picked, Date.now()); return true })
ipcMain.handle('tt-db:getShows', () => (db ? getShows(db) : {}))
ipcMain.handle('tt-db:setShows', (_e, store: unknown) => { if (db) setShows(db, store); return true })
ipcMain.handle('tt-db:importLegacy', (_e, blob: LegacyBlob) => { if (db) importLegacy(db, blob, Date.now()); return true })
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: `build complete`, no type errors.

- [ ] **Step 5: Manual verification (deferred to Task 8)**

The handlers have no renderer caller yet; Task 8 wires them and provides the end-to-end checklist. For now confirm the build passes and `npm run dev` still launches without errors (then `npm run rebuild:node`).

- [ ] **Step 6: Commit**

```bash
git add tiktok-live-poc/src/electron/main.ts
git commit -m "feat(tiktok): open SQLite in main; upsert on sync; DB query IPC"
```

---

### Task 8: Renderer hydrates from SQLite via IPC; one-shot legacy import

**Files:**
- Modify: `tiktok-live-poc/src/electron/preload-viewer.ts` (add `dbAPI`)
- Modify: `tiktok-live-poc/src/renderer/renderer.ts` (hydrate + persist; `:538-549`, `:567-569`, `:545`, `:854-857`, `:1308-1316`, the sync handler `:1045-1047`, the `window.d.ts`-style global decl near `:17-31`)

**Interfaces:**
- Consumes: `tt-db:*` IPC (Task 7).
- Produces: renderer reads/writes all order/cost/transcript/pick/show data through `window.dbAPI` instead of `localStorage`.

> **Testing note:** the renderer is browser-bundled and not unit-tested here. Verify via the manual checklist in Step 8.

- [ ] **Step 1: Expose `dbAPI` in the preload** — add to `preload-viewer.ts`:

```ts
contextBridge.exposeInMainWorld('dbAPI', {
  getSnapshot: () => ipcRenderer.invoke('tt-db:getSnapshot'),
  setCost: (orderId: string, cents: number | null) => ipcRenderer.invoke('tt-db:setCost', { orderId, cents }),
  setProductCost: (productId: string, cents: number | null) => ipcRenderer.invoke('tt-db:setProductCost', { productId, cents }),
  setTranscript: (scope: 'order' | 'product', key: string, transcript: unknown | null) => ipcRenderer.invoke('tt-db:setTranscript', { scope, key, transcript }),
  setPicked: (orderId: string, picked: boolean) => ipcRenderer.invoke('tt-db:setPicked', { orderId, picked }),
  getShows: () => ipcRenderer.invoke('tt-db:getShows'),
  setShows: (store: unknown) => ipcRenderer.invoke('tt-db:setShows', store),
  importLegacy: (blob: unknown) => ipcRenderer.invoke('tt-db:importLegacy', blob),
})
```

- [ ] **Step 2: Declare the global** — add to the `declare global { interface Window { ... } }` block in `renderer.ts` (near `:17`):

```ts
    dbAPI?: {
      getSnapshot: () => Promise<{ orders: Sale[]; costs: Record<string, number>; productCosts: Record<string, number>; orderTx: Record<string, LedgerTranscript>; productTx: Record<string, LedgerTranscript>; picked: string[]; shows: unknown }>
      setCost: (orderId: string, cents: number | null) => Promise<boolean>
      setProductCost: (productId: string, cents: number | null) => Promise<boolean>
      setTranscript: (scope: 'order' | 'product', key: string, transcript: unknown | null) => Promise<boolean>
      setPicked: (orderId: string, picked: boolean) => Promise<boolean>
      getShows: () => Promise<unknown>
      setShows: (store: unknown) => Promise<boolean>
      importLegacy: (blob: unknown) => Promise<boolean>
    }
```

- [ ] **Step 3: Stop seeding the data maps from `localStorage`** (`renderer.ts:540-549`)

Change the seven data globals to start empty (they are hydrated in Step 5). Replace:

```ts
const costMap: Record<string, number> = {}
const productCostMap: Record<string, number> = {}
const transcriptsByOrder = new Map<string, string>()
const productTx: Record<string, LedgerTranscript> = {}
const orderTx: Record<string, LedgerTranscript> = {}
let syncedOrders: Sale[] = []
```

Delete the now-unused `loadJson` data reads for these keys and the `saveSyncedOrders`/`saveOrderTx` localStorage writers — they are replaced by IPC in Steps 4 and 6. (Keep `loadJson` itself if other call sites use it; keep `tt-label-template`, `tt-feed-size`, `tt-autoprint`.)

- [ ] **Step 4: Replace the `save*` writers with IPC** (`renderer.ts:545,567-569`)

```ts
const saveCosts = () => { /* persisted per-edit via dbAPI; see editCost / applyBulkCost */ }
const saveProductCosts = () => {}
const saveProductTx = () => {}
const saveOrderTx = () => {}
```

Then at each mutation site, add the matching IPC call:
- After `costMap[r.orderId] = …` / `delete costMap[r.orderId]` (in `editCost`, `:692-693`): `void window.dbAPI?.setCost(r.orderId, costMap[r.orderId] ?? null)`.
- After `productCostMap[pid] = …` / `delete productCostMap[pid]` (in `applyBulkCost`, `:593-594`): `void window.dbAPI?.setProductCost(pid, productCostMap[pid] ?? null)`.
- After `orderTx[r.orderId] = next` (`:857`): `void window.dbAPI?.setTranscript('order', r.orderId, next)`.
- After `productTx[productId] = …` (`:389-390`): `void window.dbAPI?.setTranscript('product', productId, productTx[productId])`.
- Where `pickedOrders` is saved (`savePicked`, `:934`): replace the `localStorage.setItem('tt-picked', …)` with per-toggle `void window.dbAPI?.setPicked(orderId, isPicked)` at the toggle site.
- Where shows are saved (the `tt-shows` writer in the show-store code): replace with `void window.dbAPI?.setShows(showStore)`.

- [ ] **Step 5: Hydrate from the DB at boot + run the one-shot legacy import**

Add a `boot()` that runs before first render (call it where the renderer currently kicks off its initial `renderLedger()`/init). Place near the bottom, replacing the synchronous init entry:

```ts
async function migrateLegacyOnce(): Promise<void> {
  if (!window.dbAPI || localStorage.getItem('tt-migrated') === '1') return
  const ls = <T,>(k: string, fb: T): T => { try { return JSON.parse(localStorage.getItem(k) || '') as T } catch { return fb } }
  const blob = {
    cost: ls('tt-cost', {}), productCost: ls('tt-product-cost', {}),
    orderTx: ls('tt-order-tx', {}), productTx: ls('tt-product-tx', {}),
    orders: ls('tt-orders', [] as Sale[]), shows: ls('tt-shows', {}), picked: ls('tt-picked', [] as string[]),
  }
  await window.dbAPI.importLegacy(blob)
  localStorage.setItem('tt-migrated', '1') // keep old keys one release as backup
}

async function hydrateFromDb(): Promise<void> {
  if (!window.dbAPI) return
  const s = await window.dbAPI.getSnapshot()
  syncedOrders = s.orders
  Object.assign(costMap, s.costs)
  Object.assign(productCostMap, s.productCosts)
  Object.assign(orderTx, s.orderTx)
  Object.assign(productTx, s.productTx)
  pickedOrders.clear(); for (const id of s.picked) pickedOrders.add(id)
  // s.shows → feed the existing show store loader if present
}

async function boot(): Promise<void> {
  await migrateLegacyOnce()
  await hydrateFromDb()
  if (selectedShowId === 'live' && syncedOrders.length) selectedShowId = 'all'
  refreshShowOptions(); renderLedger(); renderPicklist()
}
void boot()
```

- [ ] **Step 6: Re-hydrate after a successful sync** — in the sync click handler (`renderer.ts:1045-1047`), after `res.ok`:

```ts
      const res = await window.syncAPI.now()
      if (res?.ok) { await hydrateFromDb(); refreshShowOptions(); renderLedger(); renderPicklist() }
```

- [ ] **Step 7: Drop the `orders` live-event persistence** (`renderer.ts:1308-1316`)

The `case 'orders':` block is obsolete (sync now flows through the DB). Replace its body with a no-op comment, or remove the case:

```ts
    case 'orders':
      // Orders are persisted in SQLite and hydrated via dbAPI; no live-event handling needed.
      break
```

- [ ] **Step 8: Build + manual end-to-end verification**

Run: `npm run build` (expected `build complete`), then `npm run dev`.

Verify:
1. App launches; existing cost/AI templates from before still appear in the Ledger (legacy import worked).
2. `Sync orders` (log into Seller Center if prompted) → orders appear with product images and correct totals.
3. Edit an order cost → close the app → `npm run dev` again → the cost persists (now from SQLite, `userData/tiktok.db`).
4. A product-level cost set before this build still applies to its bin after the first sync (re-keying worked).
5. `npm run rebuild:node` afterward so tests run.

- [ ] **Step 9: Commit**

```bash
git add tiktok-live-poc/src/electron/preload-viewer.ts tiktok-live-poc/src/renderer/renderer.ts
git commit -m "feat(tiktok): renderer reads/writes order data via SQLite IPC; one-shot localStorage migration"
```

---

## Self-Review

**Spec coverage** (against `2026-06-21-tiktok-order-data-foundation-design.md`):
- §A architecture (`db.ts` + IPC + pure core) → Tasks 4-8. ✓
- §B schema (orders/order_items/costs/transcripts/picks/product_aliases/meta, IDs as TEXT) → Task 4 (+ shows stored as a `meta` blob, a deliberate simplification of the spec's per-key `shows` table — the renderer treats `tt-shows` as one blob). ✓
- §C legacy migration + re-keying → Task 6 (logic) + Task 8 (one-shot trigger). ✓
- §D enrichment (product_id/sku_id/line ids/image/item prices/discounts; productId switch; `auction_module` inline; `replacement_order_tag_v1`) → Tasks 2-3. ✓
- §E data flow (sync → upsert → getSnapshot → unchanged ledger) → Tasks 7-8. ✓
- §F testing (parser fixture, DB join/idempotency, migration+re-key) → Tasks 2,4,5,6. ✓
- §G risks (better-sqlite3 ABI, re-keying, no signed URLs, TEXT ids) → Task 1 (ABI), Task 6 (re-key), Global Constraints (URLs/ids). ✓
- Verification gap (capture real `order/list` fixture) → Task 2 field-path note + `har-endpoint.mjs` reconcile step. ✓

**Placeholder scan:** No "TBD"/"handle errors"-style placeholders; every code step shows complete code. The empty `saveCosts = () => {}` shims in Task 8 are intentional (persistence moved to per-edit IPC), annotated as such.

**Type consistency:** `MappedOrder` fields added in Task 2 (`roomId`, `videoReceiptTs`, `items[].productId/skuId/...`) are consumed verbatim by `upsertOrders` in Task 4. `DbSnapshot` shape defined in Task 4 matches the global decl in Task 8 Step 2 and the hydrate in Step 5. `setCost(scope,key,cents,now)` / `setTranscript(scope,key,t,now)` signatures match their callers in Tasks 7-8. `LedgerTranscript` (from `core/ledger.ts`) is the transcript type throughout.

**Known residual risk:** the `order/list` field paths in Task 2 are from the findings-doc HAR inventory, not a committed capture — the reconcile step (Task 2 note) closes this before the data is trusted in production.
