// Parses a `pin/get` response into a PinState (current-auction card with server-time anchor).
// Shares latest_auction_item parsing with roster.ts via ./auctionItem. Portable: no electron/DOM.

import type { PinnedAuction, PinState } from './types'
import { parseLatestAuctionItem } from './auctionItem'

type Json = Record<string, unknown>
const obj = (v: unknown): Json | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

// auction_config_id arrives as a STRING live but a NUMBER in some payloads; normalize
// so it can key a Set of already-handled lots.
const idStr = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined

function toCurrent(c: Json, auctionItemId: string | undefined): PinnedAuction {
  return {
    productId: str(c['product_id']) ?? '',
    productName: str(c['product_name']) ?? '',
    skuId: str(c['sku_id']),
    auctionConfigId: idStr(c['auction_config_id']),
    variantDesc: str(c['variant_desc']),
    auctionItemId,
    startingBid: str(c['formatted_starting_bid_price']) || undefined,
    durationSec: num(c['duration']),
    extendedDurationSec: num(c['extended_auction_duration']),
    ...parseLatestAuctionItem(c),
  }
}

export function parsePin(raw: unknown, ts: number): PinState {
  const root = obj(raw) ?? {}
  const cardType = num(root['card_type'])
  const c = obj(root['auction_config'])
  // Only the v2 block carries the per-RUN id; the classic block has just the listing id.
  const v2Item = obj(obj(root['auction_config_v2'])?.['latest_auction_item'])
  const auctionItemId = v2Item ? idStr(v2Item['auction_item_id']) : undefined
  const meta = obj(root['resp_meta_data'])
  const respServerTime = meta ? Number(str(meta['resp_server_time'])) || undefined : undefined
  const serverTimeOffsetMs = respServerTime != null ? respServerTime - ts : undefined
  return {
    kind: 'pin',
    cardType,
    current: c ? toCurrent(c, auctionItemId) : undefined,
    serverTimeOffsetMs,
    ts,
  }
}
