import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RosterDiffer } from '../rosterDiffer'

const roster = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/roster-sample.json', import.meta.url)), 'utf8'),
)

describe('RosterDiffer', () => {
  it('builds a StateSnapshot with totals and pinned auction', () => {
    const d = new RosterDiffer()
    const { snapshot } = d.ingest(roster, 1000)
    expect(snapshot.kind).toBe('state')
    expect(snapshot.totals).toEqual({ sold: 26, failed: 3, paymentFailed: 1 })
    expect(snapshot.pinnedAuction?.winUsername).toBe('Sugarholic Cookies')
    expect(snapshot.products[0]?.auctionConfigId).toBe('10263952440')
  })
  it('emits no sales on first ingest (baseline)', () => {
    const d = new RosterDiffer()
    expect(d.ingest(roster, 1000).sales).toEqual([])
  })
  it('emits a sold SaleEvent when num_sold increases', () => {
    const d = new RosterDiffer()
    d.ingest(roster, 1000)
    const bumped = structuredClone(roster)
    bumped.auction_config_list[0].num_sold = 28 // +2
    const { sales } = d.ingest(bumped, 2000)
    expect(sales.filter((s) => s.status === 'sold')).toHaveLength(2)
    expect(sales[0]).toMatchObject({ kind: 'sale', source: 'roster', status: 'sold' })
  })
  it('emits a payment_failed SaleEvent when num_failed increases', () => {
    const d = new RosterDiffer()
    d.ingest(roster, 1000)
    const bumped = structuredClone(roster)
    bumped.auction_config_list[0].num_failed = 4 // +1
    const { sales } = d.ingest(bumped, 2000)
    expect(sales.filter((s) => s.status === 'payment_failed')).toHaveLength(1)
  })
})
