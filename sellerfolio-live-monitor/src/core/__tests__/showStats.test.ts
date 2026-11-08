import { describe, it, expect } from 'vitest'
import { buildSalesView, decimalToCents, fmtCents, fmtCentsWhole, fmtRuntime, parseShowStats, runtimeNow, type FeedView, type HqShowStats } from '../showStats'

const wire = {
  roomId: '7300', asOf: '2026-11-05T20:05:00.000Z', gmv: '1234.50', orders: 40, itemsSold: 44, buyers: 31,
  aov: '30.86', firstOrderAt: '2026-11-05T18:00:00.000Z', lastOrderAt: '2026-11-05T20:04:00.000Z', sellingMinutes: 124, tiktok: null,
}

describe('decimalToCents', () => {
  it('parses plain decimals to cents', () => {
    expect(decimalToCents('1234.50')).toBe(123450)
    expect(decimalToCents('0')).toBe(0)
    expect(decimalToCents('-5.25')).toBe(-525)
    expect(decimalToCents(12.2)).toBe(1220)
  })
  it('refuses anything else instead of inventing a zero', () => {
    expect(decimalToCents('$12')).toBeNull()
    expect(decimalToCents('')).toBeNull()
    expect(decimalToCents(null)).toBeNull()
    expect(decimalToCents(NaN)).toBeNull()
  })
})

describe('parseShowStats', () => {
  it('normalises the hq body', () => {
    expect(parseShowStats(wire)).toEqual({
      roomId: '7300', asOfMs: Date.parse(wire.asOf), gmvCents: 123450, orders: 40, itemsSold: 44, buyers: 31, aovCents: 3086,
      firstOrderAtMs: Date.parse(wire.firstOrderAt), lastOrderAtMs: Date.parse(wire.lastOrderAt), sellingMinutes: 124,
    })
  })
  it('a show with no orders: aov null', () => {
    expect(parseShowStats({ ...wire, gmv: '0.00', orders: 0, itemsSold: 0, buyers: 0, aov: null, firstOrderAt: null, lastOrderAt: null, sellingMinutes: null }))
      .toMatchObject({ gmvCents: 0, aovCents: null, firstOrderAtMs: null, sellingMinutes: null })
  })
  it('rejects bodies that are not show stats', () => {
    expect(parseShowStats(null)).toBeNull()
    expect(parseShowStats([])).toBeNull()
    expect(parseShowStats({ error: 'not_available' })).toBeNull()
    expect(parseShowStats({ ...wire, orders: -1 })).toBeNull()
    expect(parseShowStats({ ...wire, gmv: 'lots' })).toBeNull()
  })
})

describe('formatting', () => {
  it('money, pace and runtime', () => {
    expect(fmtCents(123450)).toBe('$1,234.50')
    expect(fmtCents(-500)).toBe('-$5.00')
    expect(fmtCentsWhole(1234567)).toBe('$12,346')
    expect(fmtRuntime(59)).toBe('0m')
    expect(fmtRuntime(45 * 60 + 10)).toBe('45m')
    expect(fmtRuntime(2 * 3600 + 5 * 60)).toBe('2h 05m')
  })
  it('runtime carries room/status duration forward on the local clock, else uses go-live', () => {
    expect(runtimeNow({ sec: 600, atMs: 1_000_000 }, 1_030_000)).toBe(630)
    expect(runtimeNow(null, 1_000_000_000, 999_400)).toBe(600)
    expect(runtimeNow(null, 1_000)).toBeUndefined()
  })
})

describe('buildSalesView', () => {
  const hqOk: FeedView<HqShowStats> = { room: '7300', state: 'ok', data: parseShowStats(wire), at: Date.parse(wire.asOf) }
  const keys = (v: ReturnType<typeof buildSalesView>) => v.cells.map((c) => c.key)

  it('all seven cells with hq; hq ones are flagged and dated', () => {
    const v = buildSalesView({ tiktok: { gmvCents: 130000, orders: 42, paceCents: 6000000 }, local: {}, runtimeSec: 7800, hq: hqOk })
    expect(keys(v)).toEqual(['gmv', 'orders', 'items', 'buyers', 'aov', 'pace'])
    const by = Object.fromEntries(v.cells.map((c) => [c.key, c]))
    expect(by['gmv']!.value).toBe('$1,300.00') //   TikTok's figure wins; hq is the cross-check
    expect(by['gmv']!.title).toContain('SellerFolio: $1,234.50')
    expect(by['orders']!.value).toBe('42')
    expect(by['items']).toMatchObject({ value: '44', hq: true })
    expect(by['buyers']).toMatchObject({ value: '31', hq: true })
    expect(by['aov']).toMatchObject({ value: '$30.86', hq: true })
    expect(by['runtime']).toBeUndefined() // the top bar shows how long the show has run
    expect(by['pace']!.value).toBe('$60,000')
    expect(v.asOf).toMatch(/^as of \d{1,2}:\d{2} [AP]M$/)
  })

  it('hq unavailable: no hq cells, items fall back to TikTok, no as-of', () => {
    const v = buildSalesView({ tiktok: { gmvCents: 1000 }, local: { itemsSold: 7, orders: 3 }, runtimeSec: 30, hq: { room: '7300', state: 'unavailable', data: null, at: null } })
    expect(keys(v)).toEqual(['gmv', 'orders', 'items', 'pace'])
    expect(v.cells.find((c) => c.key === 'items')).toMatchObject({ value: '7', hq: false })
    expect(v.cells.find((c) => c.key === 'orders')!.value).toBe('3')
    expect(v.cells.find((c) => c.key === 'pace')!.value).toBe('—') // under a minute: no rate
    expect(v.asOf).toBeNull()
  })

  it('before anything arrives: dashes, never zeros', () => {
    const v = buildSalesView({ tiktok: {}, local: {}, hq: null })
    expect(keys(v)).toEqual(['gmv', 'orders', 'pace'])
    expect(v.cells.every((c) => c.value === '—')).toBe(true)
  })

  it('local stand-ins until show_totals lands; pace computed from them', () => {
    const v = buildSalesView({ tiktok: {}, local: { gmvCents: 36000, orders: 4 }, runtimeSec: 1800, hq: null })
    expect(v.cells.find((c) => c.key === 'gmv')!.value).toBe('$360.00')
    expect(v.cells.find((c) => c.key === 'gmv')!.title).toMatch(/this app has seen/)
    expect(v.cells.find((c) => c.key === 'pace')!.value).toBe('$720')
  })

  it('says so when hq stops answering or refuses the token', () => {
    expect(buildSalesView({ tiktok: {}, local: {}, hq: { ...hqOk, state: 'error' } }).note).toMatch(/last figures/)
    expect(buildSalesView({ tiktok: {}, local: {}, hq: { room: '7300', state: 'auth', data: null, at: null } }).note).toMatch(/refused/)
  })
})
