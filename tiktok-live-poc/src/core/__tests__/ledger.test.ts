import { describe, it, expect } from 'vitest'
import { statusLabel, profitCents, marginPct, computeKpis, filterRows, sortRows, type LedgerRow } from '../ledger'
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
  it('profit is null until costed, then total − cost', () => {
    expect(profitCents(sale({ costCents: undefined }))).toBeNull()
    expect(profitCents(sale({ price: { cents: 5000, formatted: '$50' }, costCents: 1500 }))).toBe(3500)
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
})

describe('sortRows', () => {
  const rows = [sale({ orderId: 'a', createdAt: 3000, price: { cents: 1000, formatted: '$10' } }), sale({ orderId: 'b', createdAt: 1000, price: { cents: 9000, formatted: '$90' } })]
  it('sorts by date and total', () => {
    expect(sortRows(rows, 'date', -1).map((r) => r.orderId)).toEqual(['a', 'b'])
    expect(sortRows(rows, 'total', -1).map((r) => r.orderId)).toEqual(['b', 'a'])
  })
})
