// Detects auction CLOSES from successive `pin/get` snapshots. pin/get flips
// latest_auction_item.status 1 (bidding) → 3 (ended) within ~0.5s of the gavel —
// roughly 6-7s before the winner appears in auction_result/get — so this is the
// low-latency signal for both the UI and auto-print. Stateful (holds per-lot
// status) — one instance per session. Portable: no electron/DOM.

import type { AuctionClosedEvent, PinState } from './types'

const STATUS_ENDED = 3

export class AuctionWatch {
  private seen = new Map<string, number>() // auctionConfigId → last observed status
  private emitted = new Set<string>() // auctionConfigId already reported closed

  ingest(pin: PinState): AuctionClosedEvent[] {
    const c = pin.current
    const id = c?.auctionConfigId
    if (!c || !id) return []

    const prev = this.seen.get(id)
    this.seen.set(id, c.status ?? -1)

    // Only a TRANSITION into ended counts. A lot first seen already closed is one
    // that ended before we were watching — printing it would spam stale labels on
    // app start. An unsold lot (no winner) closes without a sale.
    if (prev === undefined || prev === STATUS_ENDED) return []
    if (c.status !== STATUS_ENDED || !c.winUsername) return []
    if (this.emitted.has(id)) return []
    this.emitted.add(id)

    return [
      {
        kind: 'auction-closed',
        auctionConfigId: id,
        lotNumber: c.variantDesc,
        productName: c.productName,
        winner: c.winUsername,
        price: c.maxBiddingPrice,
        source: 'pin',
        ts: pin.ts,
      },
    ]
  }
}
