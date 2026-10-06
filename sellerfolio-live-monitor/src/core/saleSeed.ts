// Decides which order rows are NEW enough to auto-print.
//
// auction_result/get returns history, not a feed: on connect it hands back every order row
// for the session, and the deep sweep re-returns old pages every ~15s to catch payment-status
// flips. So "a row we have not seen before" is NOT the same as "a sale that just happened" —
// on startup every row is unseen. Something has to mark the waterline at connect time, and
// only rows created after it may print.
//
// The failure this encodes: the waterline used to be taken from the FIRST response of any
// kind, including an empty one. TikTok answers a challenged session — and the very first
// poll of a fresh start — with a body carrying no rows, which reduces to a max createdAt of
// 0. Seeding 0 marks the entire order history as newer than the waterline, so the next
// response with real data reprints every recent lot at once. Measured live: ~20 labels
// re-queued 14 seconds after launch, 16 of them already printed by the previous run. It
// happened on EVERY app restart and looked exactly like a printer spitting out a burst.
//
// So: seed from the first response that actually carries rows, and never from an empty one.
// Waiting costs nothing — an empty body has no sales to print either way.

export interface SeedableSale {
  createdAt: number
}

export interface SalesBatch<S extends SeedableSale> {
  /** Rows this ingest had not seen before (on connect: all of them). */
  newSales: S[]
  /** The most recent rows known, newest first. Empty when the body carried nothing. */
  recentSales: S[]
}

export class SaleSeed {
  private seededAt: number | null = null

  /**
   * Given one auction_result batch, return the sales that should auto-print.
   *
   * The first batch WITH ROWS establishes the waterline and prints nothing — those rows
   * are history that happened before we attached. Every batch after prints only rows
   * created strictly after it.
   */
  select<S extends SeedableSale>(batch: SalesBatch<S>): S[] {
    const maxCreated = batch.recentSales.reduce((m, s) => Math.max(m, s.createdAt), 0)
    if (this.seededAt === null) {
      // An empty body proves nothing about where the history ends — leave the waterline
      // unset so the next batch with rows can establish it.
      if (batch.recentSales.length) this.seededAt = maxCreated
      return []
    }
    return batch.newSales.filter((s) => s.createdAt > this.seededAt!)
  }

  /** True once a waterline has been established. For diagnostics and tests. */
  get seeded(): boolean {
    return this.seededAt !== null
  }
}
