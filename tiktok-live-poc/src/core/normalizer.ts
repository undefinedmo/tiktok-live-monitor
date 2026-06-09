import type { SaleEvent } from './types'

export class SaleDeduper {
  private lastSeen = new Map<string, number>()
  constructor(private windowMs = 30_000) {}

  /** Returns true if this sale is new (should be emitted), false if it's a duplicate. */
  accept(sale: SaleEvent): boolean {
    const key = `${sale.product.auctionConfigId}:${sale.status}`
    const prev = this.lastSeen.get(key)
    if (prev !== undefined && sale.ts - prev < this.windowMs) {
      // Do NOT update lastSeen here: a run of near-window duplicates must not
      // roll the window forward and suppress a later legitimate re-auction.
      return false
    }
    this.lastSeen.set(key, sale.ts)
    return true
  }
}
