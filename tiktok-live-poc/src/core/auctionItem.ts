// Shared parse of a `latest_auction_item` bid-state block — used by both the roster's
// pinned auction (added_auction_product/list) and pin/get's current auction, which carry
// the identical sub-object. Portable: no electron/DOM.

import type { PinnedAuction } from './types'

type Json = Record<string, unknown>
const obj = (v: unknown): Json | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * Parse the `latest_auction_item` bid state shared by the roster's pinned auction and
 * pin/get's current auction. `parent` is the object that CONTAINS `latest_auction_item`.
 * Returns only the item-derived fields; the caller supplies productId/productName/skuId.
 *
 * Time fields: `actual_start_time`/`actual_end_time` are SECONDS (×1000, and a 0 is the
 * "not set" sentinel → undefined, so a countdown never anchors on epoch); `auction_bid_timestamp`
 * and `expected_end_time_ms` arrive as MS strings.
 */
export function parseLatestAuctionItem(parent: Json): Partial<PinnedAuction> {
  const item = obj(parent['latest_auction_item']) ?? {}
  const startSec = num(item['actual_start_time'])
  const endSec = num(item['actual_end_time'])
  return {
    winUsername: str(item['win_username']),
    winAvatarUrl: str(item['win_user_profile_image_url']),
    maxBiddingPrice: str(item['max_bidding_price']),
    numBids: num(item['num_of_bids']),
    status: num(item['status']),
    expectedEndMs: Number(str(item['expected_end_time_ms'])) || undefined,
    actualStartMs: startSec != null && startSec > 0 ? startSec * 1000 : undefined,
    actualEndMs: endSec != null && endSec > 0 ? endSec * 1000 : undefined,
    auctionBidTimestampMs: Number(str(item['auction_bid_timestamp'])) || undefined,
  }
}
