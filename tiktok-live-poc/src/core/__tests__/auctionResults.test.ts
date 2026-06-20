import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AuctionResults } from '../auctionResults'

const rest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/rest-samples.json', import.meta.url)), 'utf8'),
)
const rows = rest.auctionResultRows as Record<string, unknown>[]
const wrap = (data: unknown[]) => ({ code: 0, msg: 'success', auction_result_data: data })

describe('AuctionResults', () => {
  it('parses a sale row into a normalized Sale (buyer, price cents, order, payment)', () => {
    const { newSales } = new AuctionResults().ingest(wrap([rows[0]]), 1000)
    expect(newSales[0]).toMatchObject({
      orderId: '577442704719844041',
      productId: '1732451632603436003',
      productName: 'Bin B - Alo Yoga and More, No Cancels',
      skuDesc: '#33',
      paymentSuccessful: true,
      buyer: { ttuid: '6745304592617112582', username: 'Cristina 🌺', handle: 'cristinas.diary' },
    })
    expect(newSales[0]!.price.cents).toBe(8200) // "$82.00"
    expect(newSales[0]!.buyer.avatarUrl).toContain('tiktokcdn-us.com')
  })

  it('aggregates buyers, totals, unique count, and failed payments on first poll', () => {
    const u = new AuctionResults().ingest(wrap(rows), 1000)
    expect(u.newSales).toHaveLength(8)
    expect(u.totalSales).toBe(7) // 7 successful, 1 failed
    expect(u.totalCents).toBe(43000) // sum of the 7 successful selling_prices
    expect(u.uniqueBuyers).toBe(7)
    expect(u.failedPayments.map((s) => s.buyer.username)).toEqual(['Taralynn0216'])
    expect(u.topBuyers[0]).toMatchObject({ username: 'Cristina 🌺', itemCount: 1, totalCents: 8200 })
    // sorted descending by spend
    const cents = u.topBuyers.map((b) => b.totalCents)
    expect([...cents]).toEqual([...cents].sort((a, b) => b - a))
  })

  it('dedupes by order_id across polls — re-ingesting the same rows yields no new sales', () => {
    const ar = new AuctionResults()
    ar.ingest(wrap(rows), 1000)
    const second = ar.ingest(wrap(rows), 2000)
    expect(second.newSales).toHaveLength(0)
    expect(second.totalSales).toBe(7)
    expect(second.totalCents).toBe(43000)
  })

  it('emits only genuinely new orders and re-aggregates a returning buyer', () => {
    const ar = new AuctionResults()
    ar.ingest(wrap(rows), 1000)
    const again = { ...rows[0], order_id: '999', selling_price: '$18.00' } // Cristina buys again
    const u = ar.ingest(wrap([rows[0], again]), 2000)
    expect(u.newSales.map((s) => s.orderId)).toEqual(['999'])
    expect(u.totalSales).toBe(8)
    const cristina = u.topBuyers.find((b) => b.username === 'Cristina 🌺')
    expect(cristina).toMatchObject({ itemCount: 2, totalCents: 10000 }) // 8200 + 1800
  })

  it('keeps recentSales newest-first by order_create_time', () => {
    const u = new AuctionResults().ingest(wrap(rows), 1000)
    const times = u.recentSales.map((s) => s.createdAt)
    expect([...times]).toEqual([...times].sort((a, b) => b - a))
  })
})
