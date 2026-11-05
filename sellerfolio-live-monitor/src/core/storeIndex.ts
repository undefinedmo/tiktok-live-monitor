// LANE B — the show store: an in-memory index rebuilt from the JSONL journal, living in the
// journal WORKER thread (BUILD.md decision 1 — no SQLite, no sql.js, no native module). The
// worker feeds it every journal line it writes (and, at start, the lines already on disk for the
// current room), and answers queries posted from main (journal.ts queryStore → worker
// 'store-query' → 'store-result'). Pure: unit-test in src/core/__tests__/storeIndex.test.ts.
//
// SCAFFOLD STUB: StoreIndex ingests nothing and every query answers empty.

/** A sale as the journal records it (main.ts `record('sale', …)` + `payment_failed`). */
export interface StoreSale {
  orderId: string
  lot?: string // "#42"
  skuId?: string
  productId?: string
  productName?: string
  buyer?: string // display name
  handle?: string
  buyerId?: string // ttuid — the key for the past-order badge
  price?: string // formatted
  cents?: number
  payment?: 'paid' | 'failed' | 'pending'
  createdAt?: number
}

/** A chat line as the journal records it (core/chatJournal.ts). */
export interface StoreChat {
  id: string
  nickname: string
  handle?: string
  userId?: string
  text: string
  ts: number
  lot?: string | null
}

export type StoreQuery =
  /** Full-text over lot, buyer, handle, product name, price. Empty text → the newest `limit`. */
  | { kind: 'sales'; text: string; limit?: number }
  /** Full-text over nickname, handle and text. */
  | { kind: 'chat'; text: string; limit?: number }
  /** Sales whose payment failed this show (newest first). */
  | { kind: 'failed'; limit?: number }

export type StoreResult =
  | { kind: 'sales'; rows: StoreSale[]; total: number }
  | { kind: 'chat'; rows: StoreChat[]; total: number }
  | { kind: 'failed'; rows: StoreSale[]; total: number }

/** The answer when there is no store (no worker, timeout, stub): the right kind, no rows. */
export function emptyStoreResult(q: StoreQuery): StoreResult {
  return { kind: q.kind, rows: [], total: 0 } as StoreResult
}

export class StoreIndex {
  /**
   * Take one journal line (the exact JSONL string the worker writes). Must be cheap and must
   * never throw: a bad line is skipped. Keys: `sale` / `payment_failed` / `chat` records, and
   * the room — a line for a different room than the current one starts a fresh index.
   */
  ingest(line: string): void {
    void line
  }

  /** Answer one query from memory. Never throws. */
  query(q: StoreQuery): StoreResult {
    return emptyStoreResult(q)
  }
}
