// Parses an `added_auction_product/list` response into a RosterSnapshot:
// product names/images + per-product sold/failed counts + the pinned auction's
// live bid state. A full snapshot each poll (no diffing — auction_result/get is
// the authoritative per-sale source). Portable: no electron/DOM.

import type { PinnedAuction, RosterProduct, RosterSnapshot } from './types'
import { parseLatestAuctionItem } from './auctionItem'

type Json = Record<string, unknown>
const obj = (v: unknown): Json | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function coverUrl(a: Json): string | undefined {
  return str(arr(obj(a['cover'])?.['url_list'])[0])
}

function toProduct(a: Json): RosterProduct {
  const errMsg = str(a['auction_product_status_error_message'])
  return {
    productId: str(a['product_id']) ?? '',
    auctionConfigId: str(a['auction_config_id']) ?? '',
    name: str(a['product_name']) ?? '',
    variantDesc: str(a['variant_desc']),
    imageUrl: coverUrl(a),
    numSold: num(a['num_sold']) ?? 0,
    numFailed: num(a['num_failed']) ?? 0,
    stockNum: num(a['stock_num']),
    startingBid: str(a['formatted_starting_bid_price']),
    skuId: str(a['sku_id']),
    durationSec: num(a['duration']),
    extendedDurationSec: num(a['extended_auction_duration']),
    auctionMode: num(a['auction_mode']),
    auctionConfigType: num(a['auction_config_type']),
    auctionCardType: num(a['auction_card_type']),
    productStatus: num(a['productStatus']),
    statusError: errMsg || undefined,
  }
}

function toPinned(p: Json): PinnedAuction {
  return {
    productId: str(p['product_id']) ?? '',
    productName: str(p['product_name']) ?? '',
    skuId: str(p['sku_id']),
    ...parseLatestAuctionItem(p),
  }
}

export function parseRoster(raw: unknown, ts: number): RosterSnapshot {
  const root = obj(raw) ?? {}
  const products = arr(root['auction_config_list']).map((a) => toProduct(obj(a) ?? {}))
  const pinnedRaw = obj(root['pinned_auction_config'])
  return {
    kind: 'roster',
    products,
    pinned: pinnedRaw ? toPinned(pinnedRaw) : undefined,
    totalSold: products.reduce((n, p) => n + p.numSold, 0),
    totalFailed: products.reduce((n, p) => n + p.numFailed, 0),
    paymentFailed: num(obj(root['auction_payment_failure_info'])?.['num_auction_payment_failed']) ?? 0,
    ts,
  }
}
