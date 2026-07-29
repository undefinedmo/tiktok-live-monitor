// Detects auction CLOSES from successive `pin/get` snapshots, two ways:
//
//  1. status transition: latest_auction_item.status 1 (bidding) → 3 (ended) on the
//     SAME lot, within ~0.5s of the gavel (~6-7s before auction_result/get).
//  2. swap-close: in back-to-back auctions the seller starts the next lot within
//     seconds, so the pinned card swaps to the new lot BEFORE the 700ms poll ever
//     samples the old lot's ended state — the 1→3 transition is never visible
//     (measured live 2026-07-24: only lots followed by a pause produced closes).
//     A lot that vanishes while bidding with a leader and its countdown (nearly)
//     run out closed naturally; one that vanishes mid-countdown was canceled or
//     reset and must NOT print.
//
// Stateful (holds per-lot status) — one instance per session. Portable: no
// electron/DOM.

import type { AuctionClosedEvent, PinnedAuction, PinState } from './types'

const STATUS_BIDDING = 1
const STATUS_ENDED = 3
// How close to its expected end a vanished lot must have been to count as a natural
// close. Must cover the 700ms poll gap + response latency + anti-snipe end-time slop
// (extensions update expectedEndMs on each poll, so the last snapshot carries the
// final clock), while excluding deliberate mid-flight cancels.
const SWAP_CLOSE_GRACE_MS = 3000

export class AuctionWatch {
  private seen = new Map<string, number>() // auctionConfigId → last observed status
  private emitted = new Set<string>() // auctionConfigId already reported closed
  // Latest snapshot of the current lot while it was BIDDING, on the server clock —
  // what we judge a swap-close by when the lot disappears.
  private lastBidding: { lot: PinnedAuction; atServerMs: number } | null = null

  ingest(pin: PinState): AuctionClosedEvent[] {
    const out: AuctionClosedEvent[] = []
    const c = pin.current
    const id = c?.auctionConfigId

    // ── swap-close: the lot we were watching was replaced or unpinned ─────────
    const prev = this.lastBidding
    if (prev && prev.lot.auctionConfigId !== id) {
      const pid = prev.lot.auctionConfigId!
      const remaining = (prev.lot.expectedEndMs ?? Infinity) - prev.atServerMs
      if (!this.emitted.has(pid) && prev.lot.winUsername && remaining <= SWAP_CLOSE_GRACE_MS) {
        this.emitted.add(pid)
        out.push({
          kind: 'auction-closed',
          auctionConfigId: pid,
          lotNumber: prev.lot.variantDesc,
          productName: prev.lot.productName,
          winner: prev.lot.winUsername,
          price: prev.lot.maxBiddingPrice,
          source: 'pin-swap',
          ts: pin.ts,
        })
      }
      this.lastBidding = null
    }

    if (!c || !id) return out

    const prevStatus = this.seen.get(id)
    this.seen.set(id, c.status ?? -1)
    if (c.status === STATUS_BIDDING) this.lastBidding = { lot: c, atServerMs: pin.ts + (pin.serverTimeOffsetMs ?? 0) }

    // ── rotated-id close: TikTok (since ~2026-07-28) can reissue the ended state
    // under a NEW auctionConfigId, so the same lot arrives "first seen already
    // closed" and the transition rule below suppresses it. If we were just watching
    // this exact lot number bidding and it now shows ended-with-winner under a new
    // id, that IS our close. (A different lot number ending under a fresh id is a
    // stale card at app start — still suppressed.)
    if (
      prevStatus === undefined &&
      c.status === STATUS_ENDED &&
      c.winUsername &&
      prev &&
      prev.lot.auctionConfigId !== id &&
      prev.lot.variantDesc !== undefined &&
      prev.lot.variantDesc === c.variantDesc &&
      !this.emitted.has(prev.lot.auctionConfigId!) &&
      !this.emitted.has(id)
    ) {
      this.emitted.add(prev.lot.auctionConfigId!)
      this.emitted.add(id)
      this.lastBidding = null
      out.push({
        kind: 'auction-closed',
        auctionConfigId: id,
        lotNumber: c.variantDesc,
        productName: c.productName,
        winner: c.winUsername,
        price: c.maxBiddingPrice,
        source: 'pin',
        ts: pin.ts,
      })
      return out
    }

    // ── status transition: only a TRANSITION into ended counts. A lot first seen
    // already closed ended before we were watching — printing it would spam stale
    // labels on app start. An unsold lot (no winner) closes without a sale.
    if (prevStatus === undefined || prevStatus === STATUS_ENDED) return out
    if (c.status !== STATUS_ENDED || !c.winUsername) return out
    if (this.emitted.has(id)) return out
    this.emitted.add(id)

    out.push({
      kind: 'auction-closed',
      auctionConfigId: id,
      lotNumber: c.variantDesc,
      productName: c.productName,
      winner: c.winUsername,
      price: c.maxBiddingPrice,
      source: 'pin',
      ts: pin.ts,
    })
    return out
  }
}
