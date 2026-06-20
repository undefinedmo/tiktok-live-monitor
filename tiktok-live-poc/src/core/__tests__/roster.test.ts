import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseRoster } from '../roster'
import type { RosterSnapshot } from '../types'

const rest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/rest-samples.json', import.meta.url)), 'utf8'),
)

describe('parseRoster', () => {
  it('parses the product roster with names, images and sold/failed counts', () => {
    const snap = parseRoster(rest.roster, 1000)
    expect(snap.kind).toBe('roster')
    expect(snap.products).toHaveLength(2)
    expect(snap.products[0]).toMatchObject({
      productId: '1732451632603436003',
      name: '#35 Bin B - Alo Yoga and More, No Cancels',
      variantDesc: '#35',
      numSold: 33,
      numFailed: 1,
      stockNum: 266,
    })
    expect(snap.products[0]!.imageUrl).toContain('ttcdn-us.com')
  })

  it('totals sold/failed across products and reads payment failures', () => {
    const snap = parseRoster(rest.roster, 1000)
    expect(snap.totalSold).toBe(83) // 33 + 50
    expect(snap.totalFailed).toBe(5) // 1 + 4
    expect(snap.paymentFailed).toBe(2) // auction_payment_failure_info
  })

  it('extracts the pinned auction live bid state', () => {
    const snap = parseRoster(rest.roster, 1000)
    expect(snap.pinned).toMatchObject({
      productId: '1732451632603436003',
      productName: '#35 Bin B - Alo Yoga and More, No Cancels',
      winUsername: 'Sarah Dukofsky',
      maxBiddingPrice: '$61.00',
      numBids: 20,
    })
    expect(snap.pinned!.winAvatarUrl).toContain('tiktokcdn-us.com')
    expect(snap.pinned!.expectedEndMs).toBe(1781991035496) // for the countdown timer
  })

  it('returns an empty snapshot for a missing/garbage payload', () => {
    const snap = parseRoster({}, 1000) as RosterSnapshot
    expect(snap.products).toEqual([])
    expect(snap.pinned).toBeUndefined()
    expect(snap.totalSold).toBe(0)
  })
})
