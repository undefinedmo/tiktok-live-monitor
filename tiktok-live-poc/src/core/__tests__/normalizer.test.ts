import { describe, it, expect } from 'vitest'
import { SaleDeduper } from '../normalizer'
import type { SaleEvent } from '../types'

const sale = (over: Partial<SaleEvent>): SaleEvent => ({
  kind: 'sale', status: 'sold', source: 'stream',
  product: { auctionConfigId: '8656', name: 'Item' },
  price: { cents: 1500, formatted: '$15.00' }, dedupeKey: '8656', ts: 1000, ...over,
})

describe('SaleDeduper', () => {
  it('passes the first sale for an auction+status', () => {
    const d = new SaleDeduper()
    expect(d.accept(sale({ source: 'stream', ts: 1000 }))).toBe(true)
  })
  it('drops a duplicate sale from the other source within the window', () => {
    const d = new SaleDeduper()
    d.accept(sale({ source: 'stream', ts: 1000 }))
    expect(d.accept(sale({ source: 'roster', ts: 1500 }))).toBe(false)
  })
  it('accepts a second sale of the same auction after the window (re-auction)', () => {
    const d = new SaleDeduper(60_000)
    d.accept(sale({ source: 'stream', ts: 1000 }))
    expect(d.accept(sale({ source: 'roster', ts: 1000 + 60_001 }))).toBe(true)
  })
  it('treats sold and payment_failed independently', () => {
    const d = new SaleDeduper()
    d.accept(sale({ status: 'sold', ts: 1000 }))
    expect(d.accept(sale({ status: 'payment_failed', ts: 1000 }))).toBe(true)
  })
})
