// Normalized live event model for the TikTok Shop streamer dashboard.
// Three data sources, joined on `productId`:
//   1. frontier WebSocket (JSON)  → real-time aggregate stats
//   2. added_auction_product/list → product names/images + auction roster (poll)
//   3. auction_result/get         → per-sale/buyer/order history (poll)
// Portable LiveSource contract — zero electron/DOM deps.

export interface Money {
  cents: number
  formatted: string
}

// ─── Source 1: frontier WebSocket aggregate stats ───────────────────────────

/** One product's live counters (from WS `product_stats[<productId>]`). */
export interface ProductStat {
  productId: string
  sales: number
  clicks: number
}

/** Snapshot of all known products + the show's running sold total (from WS). */
export interface ProductStatsSnapshot {
  kind: 'product_stats'
  products: ProductStat[]
  totalSold: number
  ts: number
}

/** Low-latency "a product's sold count ticked up" pulse from the WS stats
 *  (no buyer/price — auction_result/get is the authoritative per-sale source). */
export interface SaleEvent {
  kind: 'sale'
  productId: string
  delta: number
  totalForProduct: number
  ts: number
}

/** Show-level counters from WS `live_core_stats`. */
export interface CoreStatsEvent {
  kind: 'core_stats'
  viewers?: number
  impressions?: number
  productClicks?: number
  sales?: number
  gmv?: Money
  gpm?: Money
  ts: number
}

export interface SessionEvent {
  kind: 'session'
  id?: string
  name?: string
  status?: number
  ts: number
}

export interface RoomEvent {
  kind: 'room'
  roomId: string
  ts: number
}

// ─── Source 2: auction roster (added_auction_product/list) ───────────────────

export interface RosterProduct {
  productId: string
  auctionConfigId: string
  name: string
  variantDesc?: string
  imageUrl?: string
  numSold: number
  numFailed: number
  stockNum?: number
  startingBid?: string
}

/** The currently pinned/running auction's live bid state. */
export interface PinnedAuction {
  productId: string
  productName: string
  winUsername?: string
  winAvatarUrl?: string
  maxBiddingPrice?: string
  numBids?: number
  status?: number
}

export interface RosterSnapshot {
  kind: 'roster'
  products: RosterProduct[]
  pinned?: PinnedAuction
  totalSold: number
  totalFailed: number
  paymentFailed: number
  ts: number
}

// ─── Source 3: per-sale history (auction_result/get) ─────────────────────────

export interface Buyer {
  ttuid?: string
  username: string
  handle?: string
  avatarUrl?: string
}

export interface Sale {
  orderId: string
  buyer: Buyer
  productId: string
  productName: string
  productImageUrl?: string
  skuDesc?: string
  price: Money
  paymentSuccessful: boolean
  orderStatus?: number
  createdAt: number // order_create_time (ms)
}

export interface BuyerAgg {
  ttuid?: string
  username: string
  handle?: string
  avatarUrl?: string
  itemCount: number
  totalCents: number
}

/** Result of ingesting one auction_result/get poll. */
export interface SalesUpdate {
  kind: 'sales'
  newSales: Sale[] // sales whose orderId was not seen before this poll
  recentSales: Sale[] // all sales seen, newest first (capped)
  topBuyers: BuyerAgg[] // aggregated by buyer, desc by totalCents
  uniqueBuyers: number
  totalSales: number
  totalCents: number
  failedPayments: Sale[]
  ts: number
}

// ─── Status ──────────────────────────────────────────────────────────────────

export interface StatusEvent {
  kind: 'status'
  status: 'connecting' | 'connected' | 'idle' | 'needs-login' | 'error'
  detail?: string
}

export type LiveEvent =
  | ProductStatsSnapshot
  | SaleEvent
  | CoreStatsEvent
  | SessionEvent
  | RoomEvent
  | RosterSnapshot
  | SalesUpdate
  | StatusEvent
