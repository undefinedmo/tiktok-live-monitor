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

// Per-LOT identity. auctionConfigId is per-LISTING, not per-lot: every variant #1..#K
// under one auction product shares it (measured live 2026-08-09: 211 lots across a show
// carried just 2 config ids). Keying dedup state by auctionConfigId alone therefore let
// the FIRST lot of each listing print and suppressed every lot after it (emitted.has(id)
// was already true) — only 2 of 211 closes fired. variant_desc ("#17") is the real
// per-lot key; it restarts per listing, so scope it by config id to stay unique across
// listings. Mirrors the renderer's printKey reasoning (lot numbers restart per LISTING).
const lotKeyOf = (lot: PinnedAuction): string => `${lot.auctionConfigId ?? ''}|${lot.variantDesc ?? ''}`

export class AuctionWatch {
  private seen = new Map<string, number>() // lotKey → last observed status
  private emitted = new Set<string>() // lotKey already reported closed
  // Latest snapshot of the current lot while it was BIDDING, on the server clock —
  // what we judge a swap-close by when the lot disappears.
  private lastBidding: { lot: PinnedAuction; atServerMs: number } | null = null

  ingest(pin: PinState): AuctionClosedEvent[] {
    const out: AuctionClosedEvent[] = []
    const c = pin.current
    const id = c?.auctionConfigId

    // ── swap-close: the lot we were watching was replaced or unpinned ─────────
    // A lot change is a change in lotKey, NOT just auctionConfigId — back-to-back lots
    // in one listing share the config id, so comparing ids alone never saw the swap and
    // let same-listing closes slip through. curKey is null when the card unpinned.
    const prev = this.lastBidding
    const curKey = c && id ? lotKeyOf(c) : null
    if (prev && lotKeyOf(prev.lot) !== (curKey ?? '')) {
      const pkey = lotKeyOf(prev.lot) // dedup key (per-lot); the EVENT keeps the real config id
      const remaining = (prev.lot.expectedEndMs ?? Infinity) - prev.atServerMs
      if (!this.emitted.has(pkey) && prev.lot.winUsername && remaining <= SWAP_CLOSE_GRACE_MS) {
        this.emitted.add(pkey)
        out.push({
          kind: 'auction-closed',
          auctionConfigId: prev.lot.auctionConfigId!, // defined: lastBidding is only set past the `!id` guard
          lotNumber: prev.lot.variantDesc,
          productName: prev.lot.productName,
          skuId: prev.lot.skuId,
          winner: prev.lot.winUsername,
          price: prev.lot.maxBiddingPrice,
          source: 'pin-swap',
          ts: pin.ts,
        })
      }
      this.lastBidding = null
    }

    if (!c || !id) return out

    const key = lotKeyOf(c)
    const prevStatus = this.seen.get(key)
    this.seen.set(key, c.status ?? -1)
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
      !this.emitted.has(lotKeyOf(prev.lot)) &&
      !this.emitted.has(key)
    ) {
      this.emitted.add(lotKeyOf(prev.lot))
      this.emitted.add(key)
      this.lastBidding = null
      out.push({
        kind: 'auction-closed',
        auctionConfigId: id,
        lotNumber: c.variantDesc,
        productName: c.productName,
        skuId: c.skuId,
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
    if (this.emitted.has(key)) return out
    this.emitted.add(key)

    out.push({
      kind: 'auction-closed',
      auctionConfigId: id,
      lotNumber: c.variantDesc,
      productName: c.productName,
      skuId: c.skuId,
      winner: c.winUsername,
      price: c.maxBiddingPrice,
      source: 'pin',
      ts: pin.ts,
    })
    return out
  }
}
