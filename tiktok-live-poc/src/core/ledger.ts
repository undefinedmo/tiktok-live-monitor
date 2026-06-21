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
  cost: '' | 'missing' | 'costed'
  profit?: '' | 'pos' | 'neg' // profitable / loss-making (costed rows only)
  min?: number | null // order total floor, in dollars
  max?: number | null // order total ceiling, in dollars
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
    if (f.cost === 'costed' && r.costCents == null) return false
    if (f.profit) {
      const p = profitCents(r)
      if (p == null) return false // uncosted rows have no profit sign
      if (f.profit === 'pos' && p < 0) return false
      if (f.profit === 'neg' && p >= 0) return false
    }
    if (f.min != null && r.price.cents < f.min * 100) return false
    if (f.max != null && r.price.cents > f.max * 100) return false
    if (!q) return true
    const t = r.transcript
    const hay = [
      r.orderId, r.buyer.username, r.buyer.handle, r.productName, r.skuDesc,
      t?.brand, t?.item, t?.color, t?.size, t?.summary,
    ].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(q)
  })
}

/** Parse a free-text money value (from AI retail, e.g. "$1,250" or "approx $89.99 retail") to cents. */
export function parseRetailCents(s?: string): number | null {
  if (!s) return null
  const m = s.replace(/,/g, '').match(/\d+(\.\d+)?/)
  if (!m) return null
  const n = parseFloat(m[0])
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

/** Bulk cost apply (mirrors the desktop MassEditModal): Fixed $ / % of total / % of AI retail / clear. */
export type CostApply = { mode: 'flat' | 'percent' | 'retail' | 'clear'; value: number }
export function applyCost(row: LedgerRow, a: CostApply): number | undefined {
  if (a.mode === 'clear') return undefined
  if (a.mode === 'flat') return Math.round(a.value * 100)
  if (a.mode === 'retail') {
    const retail = parseRetailCents(row.transcript?.retailPrice)
    return retail == null ? undefined : Math.round((retail * a.value) / 100)
  }
  return Math.round((row.price.cents * a.value) / 100) // percent of order total
}

/** A picklist/packlist bucket — items grouped by show or packed per buyer. */
export interface PickGroup {
  key: string
  label: string
  sub: string
  items: LedgerRow[]
  units: number
  totalCents: number
}

/** Group non-failed orders for the picklist. by 'buyer' = pack per customer; by 'show' = group per live show. */
export function groupForPicklist(rows: LedgerRow[], by: 'buyer' | 'show'): PickGroup[] {
  const map = new Map<string, PickGroup>()
  for (const r of rows) {
    if (r.paymentStatus === 'failed') continue
    const key = by === 'buyer' ? (r.buyer.handle || r.buyer.username || r.buyer.ttuid || '?') : (r.liveTag || 'Other orders')
    let g = map.get(key)
    if (!g) {
      g = {
        key,
        label: by === 'buyer' ? r.buyer.username || r.buyer.handle || '—' : key,
        sub: by === 'buyer' ? '@' + (r.buyer.handle ?? '') : '',
        items: [],
        units: 0,
        totalCents: 0,
      }
      map.set(key, g)
    }
    g.items.push(r)
    g.units++
    g.totalCents += r.price.cents
  }
  return [...map.values()].sort((a, b) => b.units - a.units || b.totalCents - a.totalCents)
}

/** Export rows to CSV (RFC-4180 quoting). Dollars, not cents, for spreadsheet use. */
export function toCsv(rows: LedgerRow[]): string {
  const cols: [string, (r: LedgerRow) => string][] = [
    ['Order', (r) => r.orderId],
    ['Date', (r) => new Date(r.createdAt).toISOString()],
    ['Buyer', (r) => r.buyer.username || ''],
    ['Handle', (r) => (r.buyer.handle ? '@' + r.buyer.handle : '')],
    ['Product', (r) => r.productName],
    ['SKU', (r) => r.skuDesc || ''],
    ['Total', (r) => (r.price.cents / 100).toFixed(2)],
    ['Cost', (r) => (r.costCents != null ? (r.costCents / 100).toFixed(2) : '')],
    ['Profit', (r) => { const p = profitCents(r); return p != null ? (p / 100).toFixed(2) : '' }],
    ['Margin%', (r) => { const m = marginPct(r); return m != null ? m.toFixed(1) : '' }],
    ['Status', (r) => statusLabel(r)],
  ]
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const head = cols.map((c) => c[0]).join(',')
  const body = rows.map((r) => cols.map((c) => esc(c[1](r))).join(','))
  return [head, ...body].join('\n') + '\n'
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
