// Pure view-helpers for the Ledger screen (select-similar, duplicates, health counts, cost
// suggestions, filter chips). Zero electron/DOM deps so they stay unit-testable.
import type { LedgerRow, LedgerFilters } from './ledger'

const buyerKey = (r: LedgerRow): string => r.buyer.ttuid || r.buyer.username

export type SimilarBy = 'buyer' | 'product' | 'show'

/** Order ids matching the anchor by buyer / product / derived show. Includes the anchor.
 *  Empty when the anchor isn't in `rows`. */
export function selectSimilar(
  rows: LedgerRow[], anchorId: string, by: SimilarBy, showIdByOrder: Map<string, string>,
): string[] {
  const anchor = rows.find((r) => r.orderId === anchorId)
  if (!anchor) return []
  if (by === 'buyer') {
    const k = buyerKey(anchor)
    return rows.filter((r) => buyerKey(r) === k).map((r) => r.orderId)
  }
  if (by === 'product') {
    return rows.filter((r) => r.productId === anchor.productId).map((r) => r.orderId)
  }
  const sid = showIdByOrder.get(anchorId)
  return rows.filter((r) => showIdByOrder.get(r.orderId) === sid).map((r) => r.orderId)
}

/** Order ids sharing the anchor's productId — only when ≥2 (else []). */
export function duplicateOrderIds(rows: LedgerRow[], anchorId: string): string[] {
  const anchor = rows.find((r) => r.orderId === anchorId)
  if (!anchor) return []
  const matches = rows.filter((r) => r.productId === anchor.productId).map((r) => r.orderId)
  return matches.length >= 2 ? matches : []
}
