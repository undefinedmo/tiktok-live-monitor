// Parses a `pin/get` response into a PinState (current-auction card with server-time anchor).
// Independent of roster.ts — intentional duplication of latest_auction_item parsing;
// the controller will DRY in a later simplify pass. Portable: no electron/DOM deps.

import type { PinnedAuction, PinState } from './types'

type Json = Record<string, unknown>
const obj = (v: unknown): Json | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function toCurrent(c: Json): PinnedAuction {
  const item = obj(c['latest_auction_item']) ?? {}
  const actualEndSec = num(item['actual_end_time'])
  const actualStartSec = num(item['actual_start_time'])
  return {
    productId: str(c['product_id']) ?? '',
    productName: str(c['product_name']) ?? '',
    skuId: str(c['sku_id']),
    winUsername: str(item['win_username']),
    winAvatarUrl: str(item['win_user_profile_image_url']),
    maxBiddingPrice: str(item['max_bidding_price']),
    numBids: num(item['num_of_bids']),
    status: num(item['status']),
    expectedEndMs: Number(str(item['expected_end_time_ms'])) || undefined,
    actualEndMs: actualEndSec != null ? actualEndSec * 1000 : undefined,
    actualStartMs: actualStartSec != null && actualStartSec > 0 ? actualStartSec * 1000 : undefined,
    auctionBidTimestampMs: Number(str(item['auction_bid_timestamp'])) || undefined,
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
