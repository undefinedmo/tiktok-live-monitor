import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AuctionResults } from '../auctionResults'

const rest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/rest-samples.json', import.meta.url)), 'utf8'),
)
const rows = rest.auctionResultRows as Record<string, unknown>[]
const wrap = (data: unknown[]) => ({ code: 0, msg: 'success', auction_result_data: data })

describe('payment expiry', () => {
  // Shape from the 2026-08-12 HAR: an unpaid win carries a ms-string deadline a flat
  // 5 minutes past order_create_time; a row that has paid carries "0".
  const pending = { ...rows[0], order_id: 'p1', is_payment_successful: false, order_status: 4, order_create_time: 1786559167598, payment_expire_timestamp: '1786559467502' }
  const paid = { ...rows[0], order_id: 'p2', is_payment_successful: true, payment_expire_timestamp: '0' }

  it('parses the deadline on an unpaid win', () => {
    const { newSales } = new AuctionResults().ingest(wrap([pending]), 1000)
    expect(newSales[0]!.paymentStatus).toBe('pending')
    expect(newSales[0]!.paymentExpiresAt).toBe(1786559467502)
    expect(Math.round((newSales[0]!.paymentExpiresAt! - newSales[0]!.createdAt) / 1000)).toBe(300)
  })

  it('treats "0" on a paid row as absent, not as the epoch', () => {
    const { newSales } = new AuctionResults().ingest(wrap([paid]), 1000)
    expect(newSales[0]!.paymentStatus).toBe('paid')
    expect(newSales[0]!.paymentExpiresAt).toBeUndefined()
  })

  it('leaves the field off when the API omits it', () => {
    const { newSales } = new AuctionResults().ingest(wrap([rows[0]]), 1000)
    expect(newSales[0]!.paymentExpiresAt).toBeUndefined()
  })
})

describe('AuctionResults', () => {
  it('parses a sale row into a normalized Sale (buyer, price cents, order, payment)', () => {
    const { newSales } = new AuctionResults().ingest(wrap([rows[0]]), 1000)
    expect(newSales[0]).toMatchObject({
      orderId: '577442704719844041',
      productId: '1732451632603436003',
      productName: 'Bin B - Alo Yoga and More, No Cancels',
      skuDesc: '#33',
      paymentStatus: 'paid',
      buyer: { ttuid: '6745304592617112582', username: 'Cristina 🌺', handle: 'cristinas.diary' },
    })
    expect(newSales[0]!.price.cents).toBe(8200) // "$82.00"
    expect(newSales[0]!.buyer.avatarUrl).toContain('tiktokcdn-us.com')
  })

  it('aggregates buyers, totals, unique count, and failed payments on first poll', () => {
    const u = new AuctionResults().ingest(wrap(rows), 1000)
    expect(u.newSales).toHaveLength(8)
    expect(u.totalSales).toBe(7) // 7 paid, 1 failed
    expect(u.totalCents).toBe(43000) // sum of the 7 paid selling_prices
    expect(u.uniqueBuyers).toBe(7)
    expect(u.failedPayments.map((s) => s.buyer.username)).toEqual(['Taralynn0216']) // order_status 2
    expect(u.topBuyers[0]).toMatchObject({ username: 'Cristina 🌺', itemCount: 1, totalCents: 8200 })
    // sorted descending by spend
    const cents = u.topBuyers.map((b) => b.totalCents)
    expect([...cents]).toEqual([...cents].sort((a, b) => b - a))
  })

  it('classifies order_status 4 as pending — not failed, and not a paid sale', () => {
    const pending = { ...rows[0], order_id: 'pend-1', order_status: 4, is_payment_successful: false, user_name: 'Pending Patty' }
    const u = new AuctionResults().ingest(wrap([...rows, pending]), 1000)
    const p = u.recentSales.find((s) => s.orderId === 'pend-1')!
    expect(p.paymentStatus).toBe('pending')
    expect(u.failedPayments.map((s) => s.buyer.username)).toEqual(['Taralynn0216']) // pending NOT counted as failed
    expect(u.totalSales).toBe(7) // pending NOT counted as a paid sale
    expect(u.topBuyers.some((b) => b.username === 'Pending Patty')).toBe(false)
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

  it('refreshes a pending order to paid on a later poll (without re-emitting it as new)', () => {
    const ar = new AuctionResults()
    const pending = { ...rows[0], order_id: 'p9', order_status: 4, is_payment_successful: false, user_name: 'Later Larry', selling_price: '$50.00' }
    const first = ar.ingest(wrap([pending]), 1000)
    expect(first.totalSales).toBe(0)
    expect(first.recentSales[0]!.paymentStatus).toBe('pending')
    // same order comes back paid
    const paid = { ...pending, order_status: 3, is_payment_successful: true }
    const second = ar.ingest(wrap([paid]), 2000)
    expect(second.newSales).toHaveLength(0) // not a NEW order
    expect(second.recentSales.find((s) => s.orderId === 'p9')!.paymentStatus).toBe('paid')
    expect(second.totalSales).toBe(1) // now counts
    expect(second.topBuyers.some((b) => b.username === 'Later Larry')).toBe(true)
  })

  it('moves a pending order into failed when it later fails', () => {
    const ar = new AuctionResults()
    const pending = { ...rows[0], order_id: 'p10', order_status: 4, is_payment_successful: false, user_name: 'Nope Nora' }
    ar.ingest(wrap([pending]), 1000)
    const failed = ar.ingest(wrap([{ ...pending, order_status: 2 }]), 2000)
    expect(failed.failedPayments.map((s) => s.buyer.username)).toContain('Nope Nora')
  })

  it('rolls up per-product paid/failed/pending consistently with the failed total', () => {
    const pending = { ...rows[3], order_id: 'pp', order_status: 4, is_payment_successful: false } // product B
    const u = new AuctionResults().ingest(wrap([...rows, pending]), 1000)
    const byId = Object.fromEntries(u.byProduct.map((p) => [p.productId, p]))
    // product A (…436003): 3 paid (Cristina, Nancy, BK) + 1 failed (Taralynn)
    expect(byId['1732451632603436003']).toMatchObject({ paid: 3, failed: 1, pending: 0 })
    // product B (…715107): 4 paid + 1 pending (the synthetic), 0 failed
    expect(byId['1732451632602715107']).toMatchObject({ paid: 4, failed: 0, pending: 1 })
    // the Failed-Payments total equals the sum of the per-product failed column
    expect(u.failedPayments.length).toBe(u.byProduct.reduce((n, p) => n + p.failed, 0))
  })

  it('keeps recentSales newest-first by order_create_time', () => {
    const u = new AuctionResults().ingest(wrap(rows), 1000)
    const times = u.recentSales.map((s) => s.createdAt)
    expect([...times]).toEqual([...times].sort((a, b) => b - a))
  })

  // Phase 4 Unit B: enriched fields
  it('populates skuId on a paid row', () => {
    const { newSales } = new AuctionResults().ingest(wrap([rows[0]]), 1000)
    // first row is order 577442704719844041 (Cristina)
    expect(newSales[0]!.skuId).toBe('1732451642461426659')
  })

  it('populates auctionEndMs only when > 0 (failed row has timestamp; paid rows have 0 → undefined)', () => {
    const u = new AuctionResults().ingest(wrap(rows), 1000)
    const failed = u.recentSales.find((s) => s.orderId === '577442705728508863')!
    expect(failed.auctionEndMs).toBe(1781991300607)
    // first paid row has auction_end_timestamp 0 → should be undefined
    const paid = u.recentSales.find((s) => s.orderId === '577442704719844041')!
    expect(paid.auctionEndMs).toBeUndefined()
  })

  it('puts totalResultCount from response-level total_result_count onto SalesUpdate', () => {
    const input = { auction_result_data: rest.auctionResultRows, total_result_count: rest.auctionResultTotal }
    const u = new AuctionResults().ingest(input, 1000)
    expect(u.totalResultCount).toBe(88)
  })
})
