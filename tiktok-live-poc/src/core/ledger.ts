// Order-ledger view-model, ported from live-ledger/web/src/viewmodel.ts and
// adapted to the PoC's Sale rows. Profit math, KPI aggregation, filter + sort.
// We don't have settlement fees here (like live-ledger pre-settlement), so
// profit = revenue − cost. Portable: no electron/DOM.

import type { Sale } from './types'

export interface LedgerTranscript {
  brand?: string
  item?: string
  color?: string
  size?: string
  retailPrice?: string
  summary?: string
}

/** A ledger row = a captured sale + manually-entered cost + optional AI transcript. */
export type LedgerRow = Sale & { costCents?: number; transcript?: LedgerTranscript }

export interface LedgerFilters {
  q: string
  status: string // exact statusLabel, or '' for all
  cost: '' | 'missing'
}

export type SortKey = 'id' | 'date' | 'buyer' | 'product' | 'total' | 'status'

export function statusLabel(s: Sale): string {
  return s.paymentStatus === 'paid' ? 'Paid' : s.paymentStatus === 'failed' ? 'Failed' : 'Unpaid'
}

/** Revenue counted toward profit — a failed payment yields nothing. */
export const revenueCents = (r: LedgerRow): number => (r.paymentStatus === 'failed' ? 0 : r.price.cents)

export const profitCents = (r: LedgerRow): number | null =>
  r.costCents == null ? null : revenueCents(r) - r.costCents

export const marginPct = (r: LedgerRow): number | null => {
  const p = profitCents(r)
  const base = revenueCents(r)
  return p == null || base <= 0 ? null : (p / base) * 100
}

export interface Kpis {
  orders: number
  grossCents: number
  units: number
  avgCents: number
  refunds: number
  refundPct: number
  costed: number
  uncosted: number
  profitCents: number
  marginPct: number | null
}

export function computeKpis(rows: LedgerRow[]): Kpis {
  const orders = rows.length
  const grossCents = rows.reduce((n, r) => n + r.price.cents, 0)
  const refunds = rows.filter((r) => r.paymentStatus === 'failed').length
  const costed = rows.filter((r) => r.costCents != null).length
  let profit = 0
  let profitBase = 0
  for (const r of rows) {
    const p = profitCents(r)
    if (p != null) {
      profit += p
      profitBase += revenueCents(r)
    }
  }
  return {
    orders,
    grossCents,
    units: orders, // one item per TikTok auction order
    avgCents: orders ? Math.round(grossCents / orders) : 0,
    refunds,
    refundPct: orders ? (refunds / orders) * 100 : 0,
    costed,
    uncosted: orders - costed,
    profitCents: profit,
    marginPct: profitBase > 0 ? (profit / profitBase) * 100 : null,
  }
}

export function filterRows(rows: LedgerRow[], f: LedgerFilters): LedgerRow[] {
  const q = f.q.trim().toLowerCase()
  return rows.filter((r) => {
    if (f.status && statusLabel(r) !== f.status) return false
    if (f.cost === 'missing' && r.costCents != null) return false
    if (!q) return true
    const t = r.transcript
    const hay = [
      r.orderId, r.buyer.username, r.buyer.handle, r.productName, r.skuDesc,
      t?.brand, t?.item, t?.color, t?.size, t?.summary,
    ].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(q)
  })
}

export function sortRows(rows: LedgerRow[], key: SortKey, dir: 1 | -1): LedgerRow[] {
  const cmp = (a: LedgerRow, b: LedgerRow): number => {
    switch (key) {
      case 'date': return a.createdAt - b.createdAt
      case 'total': return a.price.cents - b.price.cents
      case 'buyer': return (a.buyer.username || a.buyer.handle || '').localeCompare(b.buyer.username || b.buyer.handle || '')
      case 'product': return a.productName.localeCompare(b.productName)
      case 'status': return statusLabel(a).localeCompare(statusLabel(b))
      default: return a.orderId.localeCompare(b.orderId)
    }
  }
  return [...rows].sort((a, b) => cmp(a, b) * dir)
}
