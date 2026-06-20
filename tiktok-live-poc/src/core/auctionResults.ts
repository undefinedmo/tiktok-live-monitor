// Ingests `auction_result/get` polls into a SalesUpdate: normalizes each sale
// row, dedupes by order_id across polls (emitting only genuinely new sales),
// and aggregates buyers (Top/Unique) + failed payments. Stateful — one instance
// per session. Portable: no electron/DOM.

import type { Buyer, BuyerAgg, Sale, SalesUpdate } from './types'
import { parseMoney } from './money'

type Json = Record<string, unknown>
const obj = (v: unknown): Json | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

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
    paymentSuccessful: r['is_payment_successful'] === true,
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
      if (!sale || this.byOrder.has(sale.orderId)) continue
      this.byOrder.set(sale.orderId, sale)
      newSales.push(sale)
    }

    const all = [...this.byOrder.values()]
    const successful = all.filter((s) => s.paymentSuccessful)

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

    return {
      kind: 'sales',
      newSales,
      recentSales: [...all].sort((a, b) => b.createdAt - a.createdAt).slice(0, RECENT_CAP),
      topBuyers,
      uniqueBuyers: aggs.size,
      totalSales: successful.length,
      totalCents: successful.reduce((n, s) => n + s.price.cents, 0),
      failedPayments: all.filter((s) => !s.paymentSuccessful),
      ts,
    }
  }
}
