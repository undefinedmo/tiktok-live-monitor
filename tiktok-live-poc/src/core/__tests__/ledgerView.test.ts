import { describe, it, expect } from 'vitest'
import type { LedgerRow } from '../ledger'
import { selectSimilar, duplicateOrderIds } from '../ledgerView'

function row(id: string, o: Partial<LedgerRow> = {}): LedgerRow {
  return {
    orderId: id, buyer: { username: 'A' }, productId: 'p', productName: 'X', skuDesc: '#1',
    price: { cents: 100, formatted: '$1' }, paymentStatus: 'paid', createdAt: 1, ...o,
  }
}

describe('selectSimilar', () => {
  const rows = [
    row('o1', { buyer: { username: 'sam', ttuid: 'u1' }, productId: 'A' }),
    row('o2', { buyer: { username: 'sam', ttuid: 'u1' }, productId: 'B' }),
    row('o3', { buyer: { username: 'kim', ttuid: 'u2' }, productId: 'A' }),
  ]
  const showOf = new Map([['o1', 'R1'], ['o2', 'R1'], ['o3', 'R2']])

  it('by buyer matches the anchor buyer (ttuid) including the anchor', () => {
    expect(selectSimilar(rows, 'o1', 'buyer', showOf).sort()).toEqual(['o1', 'o2'])
  })
  it('by product matches the same productId', () => {
    expect(selectSimilar(rows, 'o1', 'product', showOf).sort()).toEqual(['o1', 'o3'])
  })
  it('by show matches the same derived show id', () => {
    expect(selectSimilar(rows, 'o1', 'show', showOf).sort()).toEqual(['o1', 'o2'])
  })
  it('returns [] for an unknown anchor', () => {
    expect(selectSimilar(rows, 'nope', 'buyer', showOf)).toEqual([])
  })
})

describe('duplicateOrderIds', () => {
  it('returns all orders sharing the anchor productId when ≥2', () => {
    const rows = [row('o1', { productId: 'A' }), row('o2', { productId: 'A' }), row('o3', { productId: 'B' })]
    expect(duplicateOrderIds(rows, 'o1').sort()).toEqual(['o1', 'o2'])
  })
  it('returns [] when the product is unique', () => {
    const rows = [row('o1', { productId: 'A' }), row('o2', { productId: 'B' })]
    expect(duplicateOrderIds(rows, 'o1')).toEqual([])
  })
})
