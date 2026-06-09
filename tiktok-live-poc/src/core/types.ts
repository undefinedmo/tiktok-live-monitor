export interface Money { cents: number; formatted: string }

export interface Buyer { username: string; displayName?: string; avatarUrl?: string }

export interface ProductRef {
  auctionConfigId: string
  productId?: string
  skuId?: string
  name: string
  variantDesc?: string
  imageUrl?: string
}

export interface AuctionEvent {
  kind: 'auction_started' | 'auction_ended'
  product: ProductRef
  price?: Money
  ts: number
}

export interface BidEvent {
  kind: 'bid'
  auctionConfigId: string
  price: Money
  bidCount: number          // 0 when unknown from stream; roster is authoritative
  bidder?: Buyer
  ts: number
}

export interface SaleEvent {
  kind: 'sale'
  status: 'sold' | 'payment_failed'
  product: ProductRef
  price: Money
  buyer?: Buyer
  dedupeKey: string
  source: 'stream' | 'roster'
  ts: number
}

export interface AuctionState {
  auctionConfigId: string
  productName: string
  variantDesc?: string
  formattedStartingBid?: string
  numSold: number
  numFailed: number
  stockNum?: number
  winUsername?: string
  maxBidPrice?: string
  numBids?: number
}

export interface StateSnapshot {
  kind: 'state'
  pinnedAuction?: AuctionState
  products: AuctionState[]
  totals: { sold: number; failed: number; paymentFailed: number }
  ts: number
}

export interface StatusEvent {
  kind: 'status'
  status: 'connecting' | 'connected' | 'idle' | 'needs-login' | 'error'
  detail?: string
}

export type LiveEvent = AuctionEvent | BidEvent | SaleEvent | StateSnapshot | StatusEvent
