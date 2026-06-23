import { describe, it, expect } from 'vitest'
import type { LedgerRow } from '../ledger'
import { selectSimilar, duplicateOrderIds, healthCounts, costSuggestions, activeFilterChips } from '../ledgerView'

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

describe('healthCounts', () => {
  it('counts uncosted, no-transcript, failed', () => {
    const rows = [
      row('a', { costCents: 100, transcript: { brand: 'N' } }),
      row('b'),
      row('c', { paymentStatus: 'failed' }),
    ]
    expect(healthCounts(rows)).toEqual({ uncosted: 2, noTranscript: 2, failed: 1 })
  })
})

describe('costSuggestions', () => {
  it('returns distinct same-product costs with counts, template first', () => {
    const rows = [
      row('a', { productId: 'P', costCents: 1200 }),
      row('b', { productId: 'P', costCents: 1200 }),
      row('c', { productId: 'P', costCents: 800 }),
      row('d', { productId: 'Q', costCents: 999 }),
    ]
    const out = costSuggestions(rows, 'P', 1000)
    expect(out[0]).toEqual({ cents: 1000, count: 0, isTemplate: true })
    expect(out.find((s) => s.cents === 1200)).toEqual({ cents: 1200, count: 2, isTemplate: false })
    expect(out.some((s) => s.cents === 999)).toBe(false) // other product excluded
  })
  it('returns [] when no same-product costs and no template', () => {
    expect(costSuggestions([row('a', { productId: 'P' })], 'P')).toEqual([])
  })
})

describe('activeFilterChips', () => {
  it('emits a chip per active filter, none when empty', () => {
    expect(activeFilterChips({ q: '', status: '', cost: '' }, null)).toEqual([])
    const chips = activeFilterChips(
      { q: 'nike', status: 'Paid', cost: 'missing', transcript: 'missing', profit: 'neg', min: 5, max: 50 },
      'LIVE · Jun 22',
    )
    expect(chips.map((c) => c.key).sort()).toEqual(
      ['cost', 'min-max', 'profit', 'q', 'show', 'status', 'transcript'].sort(),
    )
    expect(chips.find((c) => c.key === 'min-max')!.label).toBe('$5–50')
  })
})
