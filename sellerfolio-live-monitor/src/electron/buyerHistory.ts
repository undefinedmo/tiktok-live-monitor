// LANE D — buyer past-order counts from SellerFolio hq (BUILD.md "hq endpoint").
// The renderer asks for ttuids (buyerAPI.lookup); this batches them (core/buyerTags.batchBuyerIds,
// ≤ 200 per request), POSTs `{ buyerIds }` to /api/desktop/buyer-history with the computer
// token, caches the answers PER SHOW (a new room clears the cache — counts are "orders before
// this show started"), and pushes new counts to the viewer. Never on the print path: every
// request is async and best-effort; a failure leaves ids unknown (no badge), retried later.
//
// Channels (fixed by the scaffold — keep the names):
//   invoke 'buyer:lookup' (ids: string[]) → { counts: Record<ttuid, number> }  (cached ones, now)
//   event  'buyer:counts' ({ counts })   main → viewer, when a fetch brings new counts
//
// SCAFFOLD STUB: answers from an always-empty cache, never fetches, never pushes.

import { ipcMain } from 'electron'

export const BUYER_HISTORY_PATH = '/api/desktop/buyer-history'

export interface BuyerHistoryDeps {
  /** Full hq URL for BUYER_HISTORY_PATH, or null when the base URL is not one we send a token to. */
  url: () => string | null
  /** Auth headers (Bearer sfm_… + X-SF-Device), or null when this computer has no computer token. */
  headers: () => Record<string, string> | null
  /** The current show's key (room id). A change empties the cache. */
  show: () => string | undefined
  /** main.ts viewerSend. */
  send: (channel: string, ...args: unknown[]) => void
  /** Flight log line. */
  log: (line: string) => void
}

let deps: BuyerHistoryDeps | null = null

/** Called once from main.ts (the "live-ui lanes" block). */
export function registerBuyerHistoryIpc(d: BuyerHistoryDeps): void {
  deps = d
  ipcMain.handle('buyer:lookup', (_e, ids: unknown) => {
    void ids; void deps
    return { counts: {} as Record<string, number> }
  })
}
