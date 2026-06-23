import { describe, it, expect } from 'vitest'
import { statusLabel, profitCents, marginPct, computeKpis, filterRows, sortRows, applyCost, toCsv, parseRetailCents, groupForPicklist, type LedgerRow } from '../ledger'
import type { Sale } from '../types'

const sale = (over: Partial<Sale> & Partial<LedgerRow>): LedgerRow => ({
  orderId: 'o1', buyer: { username: 'Ann', handle: 'ann1' }, productId: 'p1',
  productName: 'Bin A - Alo Yoga', skuDesc: '#34', price: { cents: 5000, formatted: '$50.00' },
  paymentStatus: 'paid', createdAt: 1000, ...over,
})

describe('profit math', () => {
  it('labels payment status', () => {
    expect(statusLabel(sale({ paymentStatus: 'paid' }))).toBe('Paid')
    expect(statusLabel(sale({ paymentStatus: 'failed' }))).toBe('Failed')
    expect(statusLabel(sale({ paymentStatus: 'pending' }))).toBe('Unpaid')
  })
  it('profit is null until costed, then subtotal − cost (falls back to total when no breakdown)', () => {
    expect(profitCents(sale({ costCents: undefined }))).toBeNull()
    // live-auction row: no breakdown → price.cents is the item price, use it
    expect(profitCents(sale({ price: { cents: 5000, formatted: '$50' }, costCents: 1500 }))).toBe(3500)
  })
  it('profit excludes tax and shipping — revenue is the item subtotal, not the order total', () => {
    // Subtotal $19.00, Shipping $4.58, Tax $1.67 → Total $25.25; Cost $8.00.
    // Tax is remitted and shipping offsets the label, so profit = 1900 − 800, NOT 2525 − 800.
    const r = sale({
      price: { cents: 2525, formatted: '$25.25' },
      priceBreakdown: { grandTotalCents: 2525, subtotalCents: 1900, shippingFeeCents: 458, taxCents: 167 },
      costCents: 800,
    })
    expect(profitCents(r)).toBe(1100)
    expect(marginPct(r)).toBeCloseTo(57.89, 1) // 1100 / 1900, not 1725 / 2525 (68%)
  })
  it('uses detail.subtotalCents when priceBreakdown is absent', () => {
    const r = sale({
      price: { cents: 2525, formatted: '$25.25' },
      detail: { subtotalCents: 1900, shippingCents: 458, taxCents: 167 },
      costCents: 800,
    })
    expect(profitCents(r)).toBe(1100)
  })
  it('a failed payment has zero revenue → profit is −cost', () => {
    expect(profitCents(sale({ paymentStatus: 'failed', price: { cents: 5000, formatted: '$50' }, costCents: 1500 }))).toBe(-1500)
  })
  it('margin is profit / revenue', () => {
    expect(marginPct(sale({ price: { cents: 5000, formatted: '$50' }, costCents: 1500 }))).toBeCloseTo(70, 5)
  })
})

describe('computeKpis', () => {
  const rows = [
    sale({ orderId: 'a', price: { cents: 5000, formatted: '$50' }, costCents: 1500, paymentStatus: 'paid' }),
    sale({ orderId: 'b', price: { cents: 3000, formatted: '$30' }, paymentStatus: 'paid' }), // uncosted
    sale({ orderId: 'c', price: { cents: 2000, formatted: '$20' }, costCents: 1000, paymentStatus: 'failed' }),
  ]
  it('aggregates orders, gross, refunds, cost coverage and profit', () => {
    const k = computeKpis(rows)
    expect(k.orders).toBe(3)
    expect(k.grossCents).toBe(10000) // 5000+3000+2000
    expect(k.refunds).toBe(1)
    expect(k.costed).toBe(2)
    expect(k.uncosted).toBe(1)
    expect(k.profitCents).toBe(2500) // (5000-1500) + (0-1000) for the failed
  })
})

describe('filterRows', () => {
  const rows = [
    sale({ orderId: 'a', buyer: { username: 'Cristina', handle: 'cris' }, productName: 'Bin A', paymentStatus: 'paid', costCents: 100 }),
    sale({ orderId: 'b', buyer: { username: 'Bob', handle: 'bob' }, productName: 'Bin B', paymentStatus: 'failed' }),
  ]
  it('searches across order, buyer and product', () => {
    expect(filterRows(rows, { q: 'cris', status: '', cost: '' }).map((r) => r.orderId)).toEqual(['a'])
    expect(filterRows(rows, { q: 'bin b', status: '', cost: '' }).map((r) => r.orderId)).toEqual(['b'])
  })
  it('filters by status and missing-cost', () => {
    expect(filterRows(rows, { q: '', status: 'Failed', cost: '' }).map((r) => r.orderId)).toEqual(['b'])
    expect(filterRows(rows, { q: '', status: '', cost: 'missing' }).map((r) => r.orderId)).toEqual(['b'])
  })
  it('filters by costed', () => {
    expect(filterRows(rows, { q: '', status: '', cost: 'costed' }).map((r) => r.orderId)).toEqual(['a'])
  })
  it('filters by profit sign (only costed rows count)', () => {
    const pr = [
      sale({ orderId: 'win', price: { cents: 5000, formatted: '$50' }, costCents: 1000 }), // +4000
      sale({ orderId: 'loss', price: { cents: 2000, formatted: '$20' }, costCents: 3000 }), // -1000
      sale({ orderId: 'unc', price: { cents: 5000, formatted: '$50' } }), // uncosted → excluded by both
    ]
    expect(filterRows(pr, { q: '', status: '', cost: '', profit: 'pos' }).map((r) => r.orderId)).toEqual(['win'])
    expect(filterRows(pr, { q: '', status: '', cost: '', profit: 'neg' }).map((r) => r.orderId)).toEqual(['loss'])
  })
  it('filters by total min/max (dollars)', () => {
    const pr = [
      sale({ orderId: 'lo', price: { cents: 1000, formatted: '$10' } }),
      sale({ orderId: 'mid', price: { cents: 5000, formatted: '$50' } }),
      sale({ orderId: 'hi', price: { cents: 12000, formatted: '$120' } }),
    ]
    expect(filterRows(pr, { q: '', status: '', cost: '', min: 20 }).map((r) => r.orderId)).toEqual(['mid', 'hi'])
    expect(filterRows(pr, { q: '', status: '', cost: '', max: 100 }).map((r) => r.orderId)).toEqual(['lo', 'mid'])
    expect(filterRows(pr, { q: '', status: '', cost: '', min: 20, max: 100 }).map((r) => r.orderId)).toEqual(['mid'])
  })
})

describe('toCsv', () => {
  const rows = [
    sale({ orderId: 'a1', buyer: { username: 'Cris, Q', handle: 'cris' }, productName: 'Bin A', price: { cents: 5000, formatted: '$50' }, costCents: 1500, paymentStatus: 'paid', createdAt: 0 }),
  ]
  it('emits a header and one row per order, quoting commas', () => {
    const csv = toCsv(rows)
    const lines = csv.trim().split('\n')
    expect(lines[0]).toContain('Order')
    expect(lines[0]).toContain('Profit')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('"Cris, Q"') // comma-bearing field is quoted
    expect(lines[1]).toContain('35.00') // profit = 50 - 15
  })
})

describe('applyCost (bulk)', () => {
  const r = sale({ price: { cents: 5000, formatted: '$50' } })
  it('sets a flat dollar cost in cents', () => {
    expect(applyCost(r, { mode: 'flat', value: 12 })).toBe(1200)
  })
  it('sets a percent of the order total', () => {
    expect(applyCost(r, { mode: 'percent', value: 30 })).toBe(1500) // 30% of $50
  })
  it('clears the cost', () => {
    expect(applyCost(r, { mode: 'clear', value: 0 })).toBeUndefined()
  })
  it('sets a percent of the AI retail price when present', () => {
    const withRetail = sale({ price: { cents: 5000, formatted: '$50' }, transcript: { retailPrice: '$120.00' } })
    expect(applyCost(withRetail, { mode: 'retail', value: 25 })).toBe(3000) // 25% of $120
  })
  it('retail mode yields undefined when no retail price is known', () => {
    expect(applyCost(r, { mode: 'retail', value: 25 })).toBeUndefined()
  })
})

describe('parseRetailCents', () => {
  it('parses common money formats to cents', () => {
    expect(parseRetailCents('$120.00')).toBe(12000)
    expect(parseRetailCents('120')).toBe(12000)
    expect(parseRetailCents('$1,250')).toBe(125000)
    expect(parseRetailCents('approx $89.99 retail')).toBe(8999)
  })
  it('returns null for missing or unparseable values', () => {
    expect(parseRetailCents(undefined)).toBeNull()
    expect(parseRetailCents('n/a')).toBeNull()
  })
})

describe('groupForPicklist', () => {
  const rows = [
    sale({ orderId: 'a', buyer: { username: 'Ann', handle: 'ann1' }, liveTag: 'Show 1', price: { cents: 5000, formatted: '$50' }, paymentStatus: 'paid' }),
    sale({ orderId: 'b', buyer: { username: 'Ann', handle: 'ann1' }, liveTag: 'Show 2', price: { cents: 3000, formatted: '$30' }, paymentStatus: 'pending' }),
    sale({ orderId: 'c', buyer: { username: 'Bob', handle: 'bob1' }, liveTag: 'Show 1', price: { cents: 2000, formatted: '$20' }, paymentStatus: 'paid' }),
    sale({ orderId: 'x', buyer: { username: 'Zoe', handle: 'zoe1' }, liveTag: 'Show 1', price: { cents: 9000, formatted: '$90' }, paymentStatus: 'failed' }),
  ]
  it('groups by buyer, excluding failed payments', () => {
    const g = groupForPicklist(rows, 'buyer')
    expect(g.map((x) => x.key)).toEqual(['ann1', 'bob1']) // Zoe excluded (failed), Ann first (2 units)
    expect(g[0]!.units).toBe(2)
    expect(g[0]!.totalCents).toBe(8000)
  })
  it('groups by show, excluding failed payments', () => {
    const g = groupForPicklist(rows, 'show')
    expect(g.map((x) => x.key)).toEqual(['Show 1', 'Show 2']) // Show 1 first (a + c; Zoe's failed excluded)
    expect(g[0]!.label).toBe('Show 1')
    expect(g[0]!.units).toBe(2)
  })
  it('orders without a show tag fall under "Other orders"', () => {
    const g = groupForPicklist([sale({ orderId: 'n', paymentStatus: 'paid' })], 'show')
    expect(g[0]!.key).toBe('Other orders')
  })
})

describe('sortRows', () => {
  const rows = [sale({ orderId: 'a', createdAt: 3000, price: { cents: 1000, formatted: '$10' } }), sale({ orderId: 'b', createdAt: 1000, price: { cents: 9000, formatted: '$90' } })]
  it('sorts by date and total', () => {
    expect(sortRows(rows, 'date', -1).map((r) => r.orderId)).toEqual(['a', 'b'])
    expect(sortRows(rows, 'total', -1).map((r) => r.orderId)).toEqual(['b', 'a'])
  })
})

describe('filterRows: transcript', () => {
  it("'missing' keeps only rows with no transcript", () => {
    const rows = [sale({ orderId: 'a', transcript: { brand: 'Nike' } }), sale({ orderId: 'b' })]
    const out = filterRows(rows, { q: '', status: '', cost: '', transcript: 'missing' })
    expect(out.map((r) => r.orderId)).toEqual(['b'])
  })
  it("'' (default) keeps all", () => {
    const rows = [sale({ orderId: 'a', transcript: { brand: 'Nike' } }), sale({ orderId: 'b' })]
    expect(filterRows(rows, { q: '', status: '', cost: '' })).toHaveLength(2)
  })
})

describe('computeKpis: excludeFailed', () => {
  const rows = [
    sale({ orderId: 'a', price: { cents: 1000, formatted: '$10' } }),
    sale({ orderId: 'b', paymentStatus: 'failed', price: { cents: 500, formatted: '$5' } }),
  ]
  it('default counts every row', () => {
    const k = computeKpis(rows)
    expect(k.orders).toBe(2)
    expect(k.grossCents).toBe(1500)
    expect(k.refunds).toBe(1)
  })
  it('excludeFailed drops failed from the headline but still counts refunds', () => {
    const k = computeKpis(rows, { excludeFailed: true })
    expect(k.orders).toBe(1)
    expect(k.grossCents).toBe(1000)
    expect(k.refunds).toBe(1)
    expect(k.refundPct).toBeCloseTo(50) // 1 failed / 2 total
  })
})
