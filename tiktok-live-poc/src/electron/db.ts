// Main-process SQLite store. Owns all persisted order/transaction data; the renderer
// reads/writes through IPC (see main.ts). Pure data access — no TikTok/network logic.
import Database from 'better-sqlite3'
import { orderToSale, type MappedOrder } from './tiktok-orders'
import type { Sale } from '../core/types'
import type { LedgerTranscript } from '../core/ledger'

export type Db = Database.Database

export type ShowNameStore = Record<string, { sessionId: string; name: string; startMs: number }>

/** Remove address PII before persisting — we never store addresses on disk. */
function stripForStorage(sale: Sale): Sale {
  return sale.detail?.address == null ? sale : { ...sale, detail: { ...sale.detail, address: undefined } }
}

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
  showNames: ShowNameStore
}

function hasColumn(db: Db, table: string, col: string): boolean {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]
  return rows.some((r) => r.name === col)
}

/** Additive v2 migration: order tie columns, pack timestamp, label tables. Idempotent. */
function migrateV2(db: Db): void {
  const vRow = db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get() as { v: string } | undefined
  const alreadyV2 = vRow?.v === '2'
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
  // backfill tie columns from sale_json for rows synced before v2 — skip if already migrated
  if (!alreadyV2) backfillTieColumns(db)
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

export function openDb(path: string): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('schema_version', '1')").run()
  migrateV2(db)
  return db
}

const UPSERT_ORDER = `
INSERT INTO orders (order_id,status,status_code,buyer_handle,buyer_name,total_cents,subtotal_cents,shipping_cents,shipping_discount_cents,platform_discount_cents,seller_discount_cents,tax_cents,origin_sale_cents,live_tag,room_id,is_auction,is_reversed,placed_at,video_receipt_ts,payment_status,sale_json,synced_at,fulfill_unit_id,tracking_no)
VALUES (@order_id,@status,@status_code,@buyer_handle,@buyer_name,@total_cents,@subtotal_cents,@shipping_cents,@shipping_discount_cents,@platform_discount_cents,@seller_discount_cents,@tax_cents,@origin_sale_cents,@live_tag,@room_id,@is_auction,@is_reversed,@placed_at,@video_receipt_ts,@payment_status,@sale_json,@synced_at,@fulfill_unit_id,@tracking_no)
ON CONFLICT(order_id) DO UPDATE SET
  status=@status,status_code=@status_code,buyer_handle=@buyer_handle,buyer_name=@buyer_name,
  total_cents=@total_cents,subtotal_cents=@subtotal_cents,shipping_cents=@shipping_cents,shipping_discount_cents=@shipping_discount_cents,
  platform_discount_cents=@platform_discount_cents,seller_discount_cents=@seller_discount_cents,tax_cents=@tax_cents,origin_sale_cents=@origin_sale_cents,
  live_tag=@live_tag,room_id=@room_id,is_auction=@is_auction,is_reversed=@is_reversed,placed_at=@placed_at,video_receipt_ts=@video_receipt_ts,
  payment_status=@payment_status,sale_json=@sale_json,synced_at=@synced_at,fulfill_unit_id=@fulfill_unit_id,tracking_no=@tracking_no`

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
        payment_status: sale.paymentStatus, sale_json: JSON.stringify(stripForStorage(sale)), synced_at: now,
        fulfill_unit_id: o.fulfillment?.fulfillUnitId ?? null,
        tracking_no: o.fulfillment?.trackingNo ?? o.tracking ?? null,
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
  const orders = (db.prepare('SELECT sale_json, room_id FROM orders ORDER BY placed_at DESC').all() as { sale_json: string; room_id: string | null }[])
    .map((r) => {
      const sale = JSON.parse(r.sale_json) as Sale
      // back-fill rows synced before roomId was added to Sale (sale_json lacks it, column has it)
      if (sale.roomId == null && r.room_id != null) sale.roomId = r.room_id
      return sale
    })
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
  return { orders, costs, productCosts, orderTx, productTx, picked, shows: showsRow ? JSON.parse(showsRow.v) : {}, showNames: getShowNames(db) }
}

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

export function getShowNames(db: Db): ShowNameStore {
  const r = db.prepare("SELECT v FROM meta WHERE k = 'show_names'").get() as { v: string } | undefined
  return r ? (JSON.parse(r.v) as ShowNameStore) : {}
}

/** Merge room→name entries into the persisted store (keyed by room id). */
export function setShowNames(db: Db, map: ShowNameStore): void {
  const merged = { ...getShowNames(db), ...map }
  db.prepare("INSERT INTO meta (k,v) VALUES ('show_names',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify(merged))
}

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
      ins.run(s.orderId, s.price.cents, s.paymentStatus, s.liveTag ?? null, s.createdAt, s.detail?.isAuction ? 1 : 0, 0, JSON.stringify(stripForStorage(s)), now)
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
