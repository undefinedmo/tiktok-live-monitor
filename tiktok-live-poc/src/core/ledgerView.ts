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

export interface HealthCounts { uncosted: number; noTranscript: number; failed: number }

export function healthCounts(rows: LedgerRow[]): HealthCounts {
  let uncosted = 0
  let noTranscript = 0
  let failed = 0
  for (const r of rows) {
    if (r.costCents == null) uncosted++
    if (r.transcript == null) noTranscript++
    if (r.paymentStatus === 'failed') failed++
  }
  return { uncosted, noTranscript, failed }
}

export interface CostSuggestion { cents: number; count: number; isTemplate: boolean }

/** Distinct costs seen on other orders of the same product (each with a count), plus the product
 *  template when provided. Sorted by count desc; the template sorts first. */
export function costSuggestions(
  rows: LedgerRow[], productId: string, templateCents?: number,
): CostSuggestion[] {
  const counts = new Map<number, number>()
  for (const r of rows) {
    if (r.productId !== productId || r.costCents == null) continue
    counts.set(r.costCents, (counts.get(r.costCents) ?? 0) + 1)
  }
  const out: CostSuggestion[] = []
  if (templateCents != null) out.push({ cents: templateCents, count: counts.get(templateCents) ?? 0, isTemplate: true })
  for (const [cents, count] of counts) {
    if (templateCents != null && cents === templateCents) continue
    out.push({ cents, count, isTemplate: false })
  }
  return out.sort((a, b) => (a.isTemplate ? -1 : b.isTemplate ? 1 : b.count - a.count))
}

export interface FilterChip { key: string; label: string }

/** One chip per active filter. `key` maps back to the filter the renderer resets. */
export function activeFilterChips(filters: LedgerFilters, showLabel: string | null): FilterChip[] {
  const chips: FilterChip[] = []
  if (showLabel) chips.push({ key: 'show', label: showLabel })
  if (filters.status) chips.push({ key: 'status', label: filters.status })
  if (filters.cost) chips.push({ key: 'cost', label: filters.cost === 'missing' ? 'Uncosted' : 'Costed' })
  if (filters.transcript === 'missing') chips.push({ key: 'transcript', label: 'No transcript' })
  if (filters.profit) chips.push({ key: 'profit', label: filters.profit === 'pos' ? 'Profit' : 'Loss' })
  if (filters.min != null || filters.max != null) {
    chips.push({ key: 'min-max', label: `$${filters.min ?? 0}–${filters.max ?? '∞'}` })
  }
  if (filters.q.trim()) chips.push({ key: 'q', label: `"${filters.q.trim()}"` })
  return chips
}
