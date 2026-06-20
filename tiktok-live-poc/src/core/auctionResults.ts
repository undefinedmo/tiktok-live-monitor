// Ingests `auction_result/get` polls into a SalesUpdate: normalizes each sale
// row, dedupes by order_id across polls (emitting only genuinely new sales),
// and aggregates buyers (Top/Unique) + failed payments. Stateful — one instance
// per session. Portable: no electron/DOM.

import type { Buyer, BuyerAgg, ProductRollup, Sale, SalesUpdate } from './types'
import { parseMoney } from './money'

type Json = Record<string, unknown>
const obj = (v: unknown): Json | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

// order_status 2 = payment failed (matches roster.num_auction_payment_failed);
// is_payment_successful true (status 3) = paid; anything else (e.g. status 4) is
// a win awaiting payment → pending, NOT a failure.
function paymentStatusOf(r: Json): Sale['paymentStatus'] {
  if (r['is_payment_successful'] === true) return 'paid'
  if (num(r['order_status']) === 2) return 'failed'
  return 'pending'
}

function toSale(r: Json): Sale | null {
  const orderId = str(r['order_id'])
  if (!orderId) return null
  const buyer: Buyer = {
    ttuid: str(r['ttuid']),
    username: str(r['user_name']) ?? '',
    handle: str(r['user_display_id']),
    avatarUrl: str(r['user_profile_image_url']),
  }
  return {
    orderId,
    buyer,
    productId: str(r['product_id']) ?? '',
    productName: str(r['product_name']) ?? '',
    productImageUrl: str(r['product_image_url']),
    skuDesc: str(r['sku_desc']),
    price: parseMoney(str(r['selling_price']) ?? ''),
    paymentStatus: paymentStatusOf(r),
    orderStatus: num(r['order_status']),
    createdAt: num(r['order_create_time']) ?? 0,
  }
}

const RECENT_CAP = 200

export class AuctionResults {
  private byOrder = new Map<string, Sale>()

  ingest(raw: unknown, ts: number): SalesUpdate {
    const rows = arr(obj(raw)?.['auction_result_data'])
    const newSales: Sale[] = []
    for (const row of rows) {
      const sale = toSale(obj(row) ?? {})
      if (!sale) continue
      const prev = this.byOrder.get(sale.orderId)
      if (!prev) {
        // genuinely new order
        this.byOrder.set(sale.orderId, sale)
        newSales.push(sale)
      } else if (prev.paymentStatus !== sale.paymentStatus) {
        // a previously-seen order changed status (e.g. pending → paid/failed):
        // refresh the stored record so totals/buyers re-aggregate, but it is not
        // a NEW sale. (auction_result/get re-returns it while it's in the window.)
        this.byOrder.set(sale.orderId, sale)
      }
    }

    const all = [...this.byOrder.values()]
    const successful = all.filter((s) => s.paymentStatus === 'paid')

    // Aggregate buyers by stable id (ttuid → username) over successful sales.
    const aggs = new Map<string, BuyerAgg>()
    for (const s of successful) {
      const key = s.buyer.ttuid || s.buyer.username
      const a = aggs.get(key)
      if (a) {
        a.itemCount += 1
        a.totalCents += s.price.cents
      } else {
        aggs.set(key, {
          ttuid: s.buyer.ttuid,
          username: s.buyer.username,
          handle: s.buyer.handle,
          avatarUrl: s.buyer.avatarUrl,
          itemCount: 1,
          totalCents: s.price.cents,
        })
      }
    }
    const topBuyers = [...aggs.values()].sort((a, b) => b.totalCents - a.totalCents)

    // Per-product rollup — same source as failedPayments, so the Products table
    // and the Failed-Payments total are guaranteed consistent.
    const rollups = new Map<string, ProductRollup>()
    for (const s of all) {
      let p = rollups.get(s.productId)
      if (!p) {
        p = { productId: s.productId, productName: s.productName, paid: 0, failed: 0, pending: 0, cents: 0 }
        rollups.set(s.productId, p)
      }
      if (s.paymentStatus === 'paid') { p.paid += 1; p.cents += s.price.cents }
      else if (s.paymentStatus === 'failed') p.failed += 1
      else p.pending += 1
    }
    const byProduct = [...rollups.values()].sort((a, b) => b.paid - a.paid)

    return {
      kind: 'sales',
      newSales,
      recentSales: [...all].sort((a, b) => b.createdAt - a.createdAt).slice(0, RECENT_CAP),
      topBuyers,
      byProduct,
      uniqueBuyers: aggs.size,
      totalSales: successful.length,
      totalCents: successful.reduce((n, s) => n + s.price.cents, 0),
      failedPayments: all.filter((s) => s.paymentStatus === 'failed'),
      ts,
    }
  }
}
