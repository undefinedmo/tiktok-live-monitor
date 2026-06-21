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
  gpm?: Money // show_gpm_local — GMV per 1,000 views
  avgViewDuration?: number // seconds
  enterRoomRate?: number // impressions → viewers (fraction)
  gmvPerHour?: Money
  auctionGmv?: Money
  nonAuctionGmv?: Money
  auctionSales?: number
  marketCmp?: number // stats_benchmark_data vs market (fraction, +/-)
  ts: number
}

export interface SessionEvent {
  kind: 'session'
  id?: string
  name?: string
  status?: number
  startTime?: number // current_session.start_time (unix seconds)
  durationSeconds?: number // current_session.during_time (scheduled length)
  ts: number
}

export interface RoomEvent {
  kind: 'room'
  roomId: string
  ts: number
}

/** The live HTTP-FLV pull URL (signed, expiring) from insights room/status. */
export interface StreamEvent {
  kind: 'stream'
  url: string
  ts: number
}

/** A viewer comment decoded from the webcast/im/fetch protobuf stream. */
export interface ChatMessage {
  userId?: string
  nickname: string
  avatarUrl?: string
  text: string
  ts: number
}

export interface ChatEvent {
  kind: 'chat'
  items: ChatMessage[]
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
  expectedEndMs?: number // latest_auction_item.expected_end_time_ms — for a countdown
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
  // paid = is_payment_successful; failed = order_status 2 (matches the roster's
  // num_auction_payment_failed); pending = won but not yet paid (e.g. status 4).
  paymentStatus: 'paid' | 'failed' | 'pending'
  orderStatus?: number
  createdAt: number // order_create_time (ms)
  liveTag?: string // Seller-Center live-show tag (from order/list); groups synced orders by show
  detail?: OrderDetailInfo // richer Seller-Center fields, shown when the ledger row is expanded
}

/** Extra Seller-Center order fields surfaced in the expanded ledger row. */
export interface OrderDetailInfo {
  status?: string
  subtotalCents?: number
  shippingCents?: number
  taxCents?: number
  address?: string
  carrier?: string
  tracking?: string
  items?: { productName: string; variant?: string; quantity: number }[]
  isAuction?: boolean
  orderUrl?: string
}

export interface BuyerAgg {
  ttuid?: string
  username: string
  handle?: string
  avatarUrl?: string
  itemCount: number
  totalCents: number
}

/** Per-product rollup derived from the sale history (so the Products table and
 *  the Failed-Payments total come from one consistent source). */
export interface ProductRollup {
  productId: string
  productName: string
  paid: number // paid sales
  failed: number // payment failures (order_status 2)
  pending: number
  cents: number // paid GMV
}

/** Result of ingesting one auction_result/get poll. */
export interface SalesUpdate {
  kind: 'sales'
  newSales: Sale[] // sales whose orderId was not seen before this poll
  recentSales: Sale[] // all sales seen, newest first (capped)
  topBuyers: BuyerAgg[] // aggregated by buyer, desc by totalCents
  byProduct: ProductRollup[] // per-product paid/failed/pending, desc by paid
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

/** Synced order book from Seller-Center order/list (cookie auth, no live stream). */
export interface OrdersEvent {
  kind: 'orders'
  orders: Sale[]
  total: number
  ts: number
}

export type LiveEvent =
  | ProductStatsSnapshot
  | SaleEvent
  | CoreStatsEvent
  | SessionEvent
  | RoomEvent
  | StreamEvent
  | ChatEvent
  | RosterSnapshot
  | SalesUpdate
  | StatusEvent
  | OrdersEvent
