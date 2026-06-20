import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LiveFeed } from '../liveFeed'
import type { CoreStatsEvent, ProductStatsSnapshot, SaleEvent, SessionEvent, RoomEvent } from '../types'

const frames = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/ws-frames.json', import.meta.url)), 'utf8'),
)
const PROD_B = '1732451632603436003'

describe('LiveFeed', () => {
  it('emits a room event with the room id', () => {
    const ev = new LiveFeed().ingest({ live_room_info: { room_id: '999', create_timestamp: '1' } }, 1000)
    expect(ev.find((e) => e.kind === 'room')).toMatchObject({ kind: 'room', roomId: '999' })
  })

  it('maps wrapped live_core_stats to a core_stats event with gmv cents and sales', () => {
    const ev = new LiveFeed().ingest(frames.coreStats.payload, 1000)
    const core = ev.find((e) => e.kind === 'core_stats') as CoreStatsEvent
    expect(core).toMatchObject({ kind: 'core_stats', viewers: 372, sales: 34, impressions: 183918, productClicks: 1022, auctionSales: 34 })
    expect(core.gmv?.cents).toBe(202176) // "$2,021.76"
  })

  it('maps the full set of engagement KPIs from live_core_stats', () => {
    const core = new LiveFeed().ingest(frames.coreStats.payload, 1000).find((e) => e.kind === 'core_stats') as CoreStatsEvent
    expect(core.gpm?.cents).toBe(1099) // show_gpm_local "$10.99"
    expect(core.gmvPerHour?.cents).toBe(292216) // "$2,922.16"
    expect(core.avgViewDuration).toBe(28) // "28.000000"
    expect(core.enterRoomRate).toBeCloseTo(0.036011, 5)
    expect(core.marketCmp).toBeCloseTo(-0.629004, 5) // stats_benchmark_data.market_cmp_data[0].cmp
  })

  it('maps a bare top-level stats frame (no wrapper) to a core_stats event', () => {
    const ev = new LiveFeed().ingest({ current_viewers: 391, gmv_local: { amount_formatted: '$5.00' } }, 1000)
    const core = ev.find((e) => e.kind === 'core_stats') as CoreStatsEvent
    expect(core).toMatchObject({ viewers: 391 })
    expect(core.gmv?.cents).toBe(500)
  })

  it('maps current_session to a session event', () => {
    const ev = new LiveFeed().ingest(frames.session.payload, 1000)
    expect(ev.find((e) => e.kind === 'session')).toMatchObject({
      kind: 'session',
      id: '4384835334',
      name: 'Alo Yoga & More - No Cancels',
      status: 11,
    } satisfies Partial<SessionEvent>)
  })

  it('emits no sale events on the first product_stats frame (baseline)', () => {
    const ev = new LiveFeed().ingest({ product_stats: { a: { sales: 5, product_clicks: 1 } } }, 1000)
    expect(ev.filter((e) => e.kind === 'sale')).toHaveLength(0)
    const snap = ev.find((e) => e.kind === 'product_stats') as ProductStatsSnapshot
    expect(snap.totalSold).toBe(5)
  })

  it('emits a sale event when a product sales count increases', () => {
    const feed = new LiveFeed()
    feed.ingest({ product_stats: { a: { sales: 5 }, b: { sales: 2 } } }, 1000)
    const ev = feed.ingest({ product_stats: { a: { sales: 5 }, b: { sales: 4 } } }, 2000)
    const sales = ev.filter((e) => e.kind === 'sale') as SaleEvent[]
    expect(sales).toHaveLength(1)
    expect(sales[0]).toMatchObject({ productId: 'b', delta: 2, totalForProduct: 4 })
    expect((ev.find((e) => e.kind === 'product_stats') as ProductStatsSnapshot).totalSold).toBe(9)
  })

  it('reads product_stats from both the nested and top-level shapes (real frames)', () => {
    const feed = new LiveFeed()
    // big combined frame: live_product_stats.product_stats (A=12, B=22) → baseline, total 34
    const first = feed.ingest(frames.productStatsSeries[0], 1000)
    expect(first.filter((e) => e.kind === 'sale')).toHaveLength(0)
    expect((first.find((e) => e.kind === 'product_stats') as ProductStatsSnapshot).totalSold).toBe(34)
    // incremental frame: top-level product_stats with B bumped 22 → 23
    const next = feed.ingest(frames.productStatsSeries[2], 2000)
    const sales = next.filter((e) => e.kind === 'sale') as SaleEvent[]
    expect(sales).toHaveLength(1)
    expect(sales[0]).toMatchObject({ productId: PROD_B, delta: 1, totalForProduct: 23 })
    expect((next.find((e) => e.kind === 'product_stats') as ProductStatsSnapshot).totalSold).toBe(35)
  })
})
