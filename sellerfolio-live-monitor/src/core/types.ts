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

export interface PriceBreakdown {
  grandTotalCents: number
  subtotalCents?: number
  originSaleCents?: number
  sellerDiscountCents?: number
  platformDiscountCents?: number
  shippingFeeCents?: number
  shippingDiscountCents?: number
  taxCents?: number
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

/** Source 2b: an auction winner read off the on-screen "won" feed (DOM), painted
 *  sub-second — before the auction_result/get order row exists (~4s floor). Carries
 *  exactly the packing-label fields; drives the fast-path (opt-in) label print. */
export interface WonFeedEvent {
  kind: 'won-feed'
  name: string
  auctionNo: string
  price?: string
  ts: number
}

/**
 * An auction observed closing — the low-latency close signal, ~6-7s ahead of the same
 * sale appearing in auction_result/get. Drives the lot overlay and auto-print;
 * auction_result/get later backfills order id + payment.
 *
 * Sources:
 *   'pin'       — pin/get status 1→3 edge (AuctionWatch). Only fires for PINNED lots.
 *   'im'        — auction.end decoded from the webcast/im/fetch stream. Fires for EVERY
 *                 auction ~0.3-1.2s after the gavel, but carries no lot number; main
 *                 fills lotNumber from the current pin state when the winner matches.
 *   'im-result' — the auction.result_update companion (Manager message) ~6s later;
 *                 carries the lot number + product + username, so it prints the lots
 *                 the fast paths couldn't attribute.
 */
/** Watchdog edge (raise/clear/change): degraded signal paths the seller should see. */
export interface WatchdogEvent {
  kind: 'watchdog'
  alerts: { code: string; message: string }[]
  ts: number
}

export interface AuctionClosedEvent {
  kind: 'auction-closed'
  auctionConfigId: string
  lotNumber?: string // variant_desc ("#17") from pin; bare ("17") from im-result
  productName?: string
  skuId?: string // the lot's sku_id — the label QR's key (core/labelCode); absent when unattributed
  winner: string
  price?: string
  username?: string // im-result only: the winner's @handle
  source?: 'pin' | 'pin-swap' | 'im' | 'im-result' | 'ws'
  ts: number
}

/** Per-bid update from the webcast stream's Manager message — fires on EVERY bid,
 *  for pinned AND unpinned lots (unlike pin/get, which only covers the pinned card).
 *  Carries the lot currently being bid (number, product, leader, price) but no order
 *  time and no countdown anchor (expected_end_time_ms is pin-only). */
export interface BidUpdateEvent {
  kind: 'bid'
  lotNumber?: string // "17" — bare, no '#' prefix (variant_desc carries it)
  productName?: string
  leader: string // current high bidder (nickname)
  username?: string // the leader's @handle
  price?: string // formatted, e.g. "$27.00"
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
  createdAt?: number // room create_timestamp (unix s) — the ACTUAL go-live, vs the scheduled session start_time
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
  /** TikTok's own id for this message (a decimal string: it is past 2^53). Unique per message. */
  msgId?: string
  /** The viewer's TikTok user id, a decimal string. */
  userId?: string
  nickname: string
  /** The viewer's @handle (unique, unlike the nickname). */
  handle?: string
  avatarUrl?: string
  text: string
  /** TikTok's clock, milliseconds (common.timestamp). NOT this machine's clock. 0 when absent. */
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
  // ── Phase 4 enrichment (added_auction_product/list) ──
  skuId?: string
  durationSec?: number // auction window length
  extendedDurationSec?: number // extension granted on a late bid
  auctionMode?: number
  auctionConfigType?: number
  auctionCardType?: number
  productStatus?: number // TikTok productStatus enum
  statusError?: string // auction_product_status_error_message, when non-empty (failed/invalid product)
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
  // ── Phase 4 enrichment ──
  auctionConfigId?: string // per-LISTING id — SHARED by every lot (variant) under one auction product, NOT unique per lot. Dedupe closes by auctionConfigId+variantDesc (see AuctionWatch.lotKeyOf), not this alone.
  variantDesc?: string // the lot number, e.g. "#35" — the real per-lot key (restarts per listing)
  skuId?: string
  actualStartMs?: number // latest_auction_item.actual_start_time (sec→ms; 0 = not started)
  actualEndMs?: number // latest_auction_item.actual_end_time (sec→ms)
  auctionBidTimestampMs?: number // latest_auction_item.auction_bid_timestamp (ms) — the START while bids = 0, then the last bid
  // ── per-run identity + terms (pin/get) ──
  auctionItemId?: string // auction_config_v2.latest_auction_item.auction_item_id — unique per auction RUN
  startingBid?: string // formatted_starting_bid_price, e.g. "$22.00"
  durationSec?: number // auction window length
  extendedDurationSec?: number // extension granted on a late bid
}

/** Current-auction state from `pin/get`, with a server-time anchor for countdown accuracy. */
export interface PinState {
  kind: 'pin'
  cardType?: number // pin response card_type
  current?: PinnedAuction // the pinned auction_config + latest_auction_item
  serverTimeOffsetMs?: number // resp_server_time − local receive time; serverNow ≈ clientNow + offset
  ts: number
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
  skuId?: string
  priceBreakdown?: PriceBreakdown
  skuDesc?: string
  price: Money
  // paid = is_payment_successful; failed = order_status 2 (matches the roster's
  // num_auction_payment_failed); pending = won but not yet paid (e.g. status 4).
  paymentStatus: 'paid' | 'failed' | 'pending'
  orderStatus?: number
  createdAt: number // order_create_time (ms)
  // payment_expire_timestamp (ms) — the hard deadline for an unpaid win. Observed as a
  // flat 5 min from order_create_time. 0/absent on paid rows. Drives the pending
  // countdown and the failed-payment sweep; it does NOT gate printing.
  paymentExpiresAt?: number
  auctionEndMs?: number // auction_result_data.auction_end_timestamp (ms); 0/undefined when not provided
  liveTag?: string // Seller-Center live-show tag (from order/list); groups synced orders by show
  roomId?: string // live_room_id — the stable TikTok LIVE room key (groups orders into a real show)
  deadlines?: OrderDeadlines // Phase 2: ship-by / auto-cancel SLA windows
  fulfillment?: FulfillmentInfo // Phase 2: package / tracking / warehouse / label state
  flags?: OrderFlags // Phase 3: risk / replacement / note / insurance exception signals
  detail?: OrderDetailInfo // richer Seller-Center fields, shown when the ledger row is expanded
}

/** Exception signals for the pack/print "needs attention" queue (Phase 3).
 *  Excludes signals already modeled elsewhere (isReversed→paymentStatus, isAuction→detail,
 *  isSplitOrCombined→fulfillment) and hasUnreadBuyerMessage (needs a runtime-only endpoint). */
export interface OrderFlags {
  isRiskOrder?: boolean
  isReplacement?: boolean
  hasBuyerNote?: boolean
  hasSellerNote?: boolean
  hasSellerFlag?: boolean
  hasInsurance?: boolean
}

// ─── Phase 2: fulfillment + SLA (parsed from the order/list response) ─────────

/** How close an order is to its ship deadline. Computed at render time from
 *  OrderDeadlines + the current clock (NOT stored — it goes stale). */
export type Urgency = 'ok' | 'ship-soon' | 'overdue' | 'auto-cancel-risk'

/** Operational ship-by deadlines from trade_order_module / processing_time_info_module. */
export interface OrderDeadlines {
  latestRtsMs?: number // latest_rts_time — latest ready-to-ship
  latestTtsMs?: number // latest_tts_time — latest time-to-ship
  autoCancelMs?: number // ship_cancellation_plan_time — order auto-cancels if unshipped by then
  deliverySla?: string // delivery_sla (free text)
  processingDueMs?: number // processing_time_info.latest_processing_timestamp
}

/** Package / tracking / warehouse / label state for the pack-ship workflow. */
export interface FulfillmentInfo {
  packageId?: string
  fulfillUnitId?: string
  trackingNo?: string
  warehouseId?: string
  warehouseName?: string
  logisticsProviderName?: string // carrier
  shippingServiceName?: string
  packageStatus?: number
  labelStatus?: number
  pickingListStatus?: number
  packingListStatus?: number
  isSplitOrCombined?: boolean
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
  totalResultCount?: number // total_result_count from the response — for load-completeness checks
  ts: number
}

// ─── Status ──────────────────────────────────────────────────────────────────

export interface StatusEvent {
  kind: 'status'
  status: 'connecting' | 'connected' | 'idle' | 'needs-login' | 'error'
  detail?: string
}

/** Synced order book from Seller-Center order/list (cookie auth, no live stream). */

/** Whole-show aggregates from TikTok's own insights series (trend/chart + room/status).
 *  Authoritative for the FULL session — unlike totals derived from the sales this app
 *  captured, which start at whenever it attached. */
export interface ShowTotalsEvent {
  kind: 'show_totals'
  gmv: Money
  orders?: number
  pace?: Money // GMV per hour over the show's real elapsed time
  elapsedSec?: number
  ts: number
}

export type LiveEvent =
  | ShowTotalsEvent
  | ProductStatsSnapshot
  | SaleEvent
  | WonFeedEvent
  | AuctionClosedEvent
  | BidUpdateEvent
  | WatchdogEvent
  | CoreStatsEvent
  | SessionEvent
  | RoomEvent
  | StreamEvent
  | ChatEvent
  | RosterSnapshot
  | SalesUpdate
  | StatusEvent
  | PinState
