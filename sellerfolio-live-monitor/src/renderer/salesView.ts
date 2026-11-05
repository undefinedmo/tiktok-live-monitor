// LANE B — the sales side of the Show screen: the feed shows the LAST 10 sales, with a search box
// that queries the worker store (window.storeAPI.searchSales) for the rest; Payment issues from
// the store (window.storeAPI.failedPayments); top buyers; past-order badges on every sale row via
// lane D (./buyerHistory badgeFor + core/buyerTags). The WHALE tag is dropped.
//
// Lane B MOVES renderFeed / renderFailed / renderTopBuyer (renderer.ts, inside the
// "lane B" fences) into this file.
// Fills: index.html #feedSearch; CSS block "lane B".
// SCAFFOLD STUB: no-ops. renderer.ts calls initSalesView() once and onSales() at the END of the
// 'sales' handler — after every print has been dispatched and after the existing UI paint.

import type { Sale, SalesUpdate } from '../core/types'

export interface SalesViewDeps {
  /** renderer.ts printSale — the feed / payment-issue row's reprint button. */
  printSale: (s: Sale) => void
}

let deps: SalesViewDeps | null = null

/** Called once by renderer.ts at startup. */
export function initSalesView(d: SalesViewDeps): void {
  deps = d
}

/**
 * Called once per 'sales' event, AFTER printing and after renderer.ts's own paint. `fresh` are the
 * rows saleSeed judged new this poll. Must not block: no awaits on anything renderer.ts waits for.
 */
export function onSales(ev: SalesUpdate, fresh: Sale[]): void {
  void ev; void fresh; void deps
}
