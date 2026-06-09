import type { AuctionState, SaleEvent, StateSnapshot } from './types'
import { parseMoney } from './money'

interface RawAuction {
  auction_config_id?: string
  product_id?: string
  sku_id?: string
  product_name?: string
  variant_desc?: string
  formatted_starting_bid_price?: string
  num_sold?: number
  num_failed?: number
  stock_num?: number
  latest_auction_item?: {
    win_username?: string
    max_bidding_price?: string
    num_of_bids?: number
  }
}
interface RawRoster {
  pinned_auction_config?: RawAuction
  auction_config_list?: RawAuction[]
  auction_payment_failure_info?: { num_auction_payment_failed?: number }
}

function toState(a: RawAuction): AuctionState {
  return {
    auctionConfigId: a.auction_config_id ?? '',
    productName: a.product_name ?? '',
    variantDesc: a.variant_desc,
    formattedStartingBid: a.formatted_starting_bid_price,
    numSold: a.num_sold ?? 0,
    numFailed: a.num_failed ?? 0,
    stockNum: a.stock_num,
    winUsername: a.latest_auction_item?.win_username,
    maxBidPrice: a.latest_auction_item?.max_bidding_price,
    numBids: a.latest_auction_item?.num_of_bids,
  }
}

export class RosterDiffer {
  private prevSold = new Map<string, number>()
  private prevFailed = new Map<string, number>()
  private seeded = false

  ingest(raw: RawRoster, ts: number): { snapshot: StateSnapshot; sales: SaleEvent[] } {
    const list = raw.auction_config_list ?? []
    const products = list.map(toState)
    const totals = {
      sold: products.reduce((n, p) => n + p.numSold, 0),
      failed: products.reduce((n, p) => n + p.numFailed, 0),
      paymentFailed: raw.auction_payment_failure_info?.num_auction_payment_failed ?? 0,
    }
    const snapshot: StateSnapshot = {
      kind: 'state',
      pinnedAuction: raw.pinned_auction_config ? toState(raw.pinned_auction_config) : undefined,
      products,
      totals,
      ts,
    }

    const sales: SaleEvent[] = []
    for (const a of list) {
      const id = a.auction_config_id ?? ''
      const sold = a.num_sold ?? 0
      const failed = a.num_failed ?? 0
      if (this.seeded) {
        const dSold = sold - (this.prevSold.get(id) ?? 0)
        const dFailed = failed - (this.prevFailed.get(id) ?? 0)
        for (let i = 0; i < dSold; i++) sales.push(this.makeSale(a, 'sold', `${id}:sold:${sold - i}`, ts))
        for (let i = 0; i < dFailed; i++)
          sales.push(this.makeSale(a, 'payment_failed', `${id}:failed:${failed - i}`, ts))
      }
      this.prevSold.set(id, sold)
      this.prevFailed.set(id, failed)
    }
    this.seeded = true
    return { snapshot, sales }
  }

  private makeSale(a: RawAuction, status: SaleEvent['status'], dedupeKey: string, ts: number): SaleEvent {
    return {
      kind: 'sale',
      status,
      product: {
        auctionConfigId: a.auction_config_id ?? '',
        productId: a.product_id,
        skuId: a.sku_id,
        name: a.product_name ?? '',
        variantDesc: a.variant_desc,
      },
      price: parseMoney(a.latest_auction_item?.max_bidding_price ?? a.formatted_starting_bid_price ?? ''),
      buyer: a.latest_auction_item?.win_username
        ? { username: a.latest_auction_item.win_username }
        : undefined,
      dedupeKey,
      source: 'roster',
      ts,
    }
  }
}
