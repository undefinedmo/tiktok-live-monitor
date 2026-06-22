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
