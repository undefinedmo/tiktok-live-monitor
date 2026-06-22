// Parses a `pin/get` response into a PinState (current-auction card with server-time anchor).
// Shares latest_auction_item parsing with roster.ts via ./auctionItem. Portable: no electron/DOM.

import type { PinnedAuction, PinState } from './types'
import { parseLatestAuctionItem } from './auctionItem'

type Json = Record<string, unknown>
const obj = (v: unknown): Json | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function toCurrent(c: Json): PinnedAuction {
  return {
    productId: str(c['product_id']) ?? '',
    productName: str(c['product_name']) ?? '',
    skuId: str(c['sku_id']),
    ...parseLatestAuctionItem(c),
  }
}

export function parsePin(raw: unknown, ts: number): PinState {
  const root = obj(raw) ?? {}
  const cardType = num(root['card_type'])
  const c = obj(root['auction_config'])
  const meta = obj(root['resp_meta_data'])
  const respServerTime = meta ? Number(str(meta['resp_server_time'])) || undefined : undefined
  const serverTimeOffsetMs = respServerTime != null ? respServerTime - ts : undefined
  return {
    kind: 'pin',
    cardType,
    current: c ? toCurrent(c) : undefined,
    serverTimeOffsetMs,
    ts,
  }
}
