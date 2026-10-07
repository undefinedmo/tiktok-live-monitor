// Turns successive `pin/get` snapshots into one START and one END record per auction run —
// including the runs AuctionWatch deliberately ignores: a lot that closes with no bidder.
//
// AuctionWatch exists to print labels, so an unsold lot is correctly nothing to it. But
// "what was offered and nobody bid" is the single biggest lever on a show's GMV per hour
// (48 shows, 2026-10-03: unsold share against GMV/hr, partial r −0.49; every unsold run drew
// zero bids), and it leaves no trace anywhere else — no order, no result row. This is the
// only place it can be written down.
//
// Stateful, one instance per session. Portable: no electron/DOM.

import type { PinState, PinnedAuction } from './types'

/** pin/get auction status: the card is taking bids / the lot has closed. */
export const STATUS_BIDDING = 1
export const STATUS_ENDED = 3

export interface AuctionStartRecord {
  type: 'auction_start'
  lot?: string
  skuId?: string
  auctionItemId?: string
  auctionConfigId?: string
  productName: string
  startingBid?: string
  durationSec?: number
  extendedDurationSec?: number
  /** Server clock. Exact when the first sample had no bids; otherwise expected end − duration. */
  startedAtMs?: number
  expectedEndMs?: number
}

export interface AuctionEndRecord {
  type: 'auction_end'
  lot?: string
  skuId?: string
  auctionItemId?: string
  auctionConfigId?: string
  productName: string
  startingBid?: string
  /**
   * sold    — ended with a winner
   * unsold  — ended with no bidder
   * unknown — the card moved to another lot before the ended state was sampled; the last
   *           bidding snapshot is all there is (winner/price are then the last LEADER's)
   */
  outcome: 'sold' | 'unsold' | 'unknown'
  winner?: string
  price?: string
  bids?: number
  /** The end time moved after the lot started: a late bid extended it. */
  extended: boolean
  expectedEndMs?: number
  /** Server clock at the sample that showed the close (or the lot's replacement). */
  seenAtMs: number
}

export type AuctionRecord = AuctionStartRecord | AuctionEndRecord

interface Open {
  key: string
  lot: PinnedAuction
  firstExpectedEndMs?: number
}

// auction_item_id is unique per run and is the right key when TikTok sends it. Without it,
// fall back to listing + lot number — a re-run of the same lot then reads as a new run only
// because the previous one was closed first (open is null), which is the behaviour we want.
const keyOf = (c: PinnedAuction): string => c.auctionItemId ?? `${c.auctionConfigId ?? ''}|${c.variantDesc ?? ''}`

export class AuctionJournal {
  private open: Open | null = null

  ingest(pin: PinState): AuctionRecord[] {
    const out: AuctionRecord[] = []
    const c = pin.current
    const serverNow = pin.ts + (pin.serverTimeOffsetMs ?? 0)
    const key = c ? keyOf(c) : null

    // The lot we were following is no longer the one on the card.
    if (this.open && key !== this.open.key) {
      // TikTok can reissue an ended lot under a new id (AuctionWatch's rotated-id case): same
      // lot number, now ended. That is our lot's end, not a different lot.
      const rotatedEnd = !!c && c.status === STATUS_ENDED && c.variantDesc !== undefined && c.variantDesc === this.open.lot.variantDesc
      if (rotatedEnd) {
        out.push(this.end(this.open, c!, serverNow))
        this.open = null
        return out
      }
      out.push(this.end(this.open, null, serverNow))
      this.open = null
    }

    if (!c || !key) return out

    if (c.status === STATUS_BIDDING) {
      if (!this.open) {
        this.open = { key, lot: c, firstExpectedEndMs: c.expectedEndMs }
        out.push({
          type: 'auction_start',
          lot: c.variantDesc,
          skuId: c.skuId,
          auctionItemId: c.auctionItemId,
          auctionConfigId: c.auctionConfigId,
          productName: c.productName,
          startingBid: c.startingBid,
          durationSec: c.durationSec,
          extendedDurationSec: c.extendedDurationSec,
          startedAtMs: startOf(c),
          expectedEndMs: c.expectedEndMs,
        })
      } else {
        this.open.lot = c // keep the latest leader / bid count / end time
      }
      return out
    }

    if (c.status === STATUS_ENDED && this.open) {
      out.push(this.end(this.open, c, serverNow))
      this.open = null
    }
    // A lot first seen already ended closed before we were watching: nothing to record.
    return out
  }

  private end(open: Open, ended: PinnedAuction | null, seenAtMs: number): AuctionEndRecord {
    const last = ended ?? open.lot
    const outcome: AuctionEndRecord['outcome'] = !ended ? 'unknown' : ended.winUsername ? 'sold' : 'unsold'
    return {
      type: 'auction_end',
      lot: open.lot.variantDesc,
      skuId: open.lot.skuId,
      auctionItemId: open.lot.auctionItemId,
      auctionConfigId: open.lot.auctionConfigId,
      productName: open.lot.productName,
      startingBid: open.lot.startingBid,
      outcome,
      winner: last.winUsername || undefined,
      price: last.winUsername ? last.maxBiddingPrice : undefined,
      bids: last.numBids,
      extended: open.firstExpectedEndMs !== undefined && last.expectedEndMs !== undefined && last.expectedEndMs > open.firstExpectedEndMs,
      expectedEndMs: last.expectedEndMs ?? open.lot.expectedEndMs,
      seenAtMs,
    }
  }
}

function startOf(c: PinnedAuction): number | undefined {
  // While a lot has no bids, auction_bid_timestamp is its start (measured: exactly
  // duration before expected_end). After the first bid it becomes the last bid's time.
  if (!c.numBids && c.auctionBidTimestampMs) return c.auctionBidTimestampMs
  if (c.expectedEndMs && c.durationSec) return c.expectedEndMs - c.durationSec * 1000
  return undefined
}
