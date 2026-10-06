import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTrend, paceCentsPerHour, formatCents, STATS_GMV, STATS_ORDERS } from '../liveTrend'

// Real capture: shop.tiktok.com HAR, 2026-08-12 show, ~31 minutes in.
const sample = JSON.parse(readFileSync(join(__dirname, '../../../fixtures/trend-chart-sample.json'), 'utf8'))

describe('parseTrend', () => {
  it('sums the whole session into GMV, not just the buckets we watched', () => {
    const t = parseTrend(sample, 1000)!
    expect(t.gmv).toEqual({ cents: 57190, formatted: '$571.90' })
    expect(t.orders).toBe(73)
  })

  it('exposes every requested series with per-point buckets', () => {
    const t = parseTrend(sample, 1000)!
    expect(t.series.map((s) => s.statsType).sort((a, b) => a - b)).toEqual([51, 84, 341, 342])
    const gmv = t.series.find((s) => s.statsType === STATS_GMV)!
    expect(gmv.isMoney).toBe(true)
    expect(gmv.points).toHaveLength(31)
    // scalar series keep raw numbers, money series are converted to cents
    const orders = t.series.find((s) => s.statsType === STATS_ORDERS)!
    expect(orders.isMoney).toBe(false)
    expect(orders.total).toBe(73)
  })

  it('reports the window anchor so a capped series can be detected', () => {
    const t = parseTrend(sample, 1000)!
    expect(t.firstPointMs).toBe(1786557240000)
    expect(t.lastPointMs).toBe(1786559040000)
    // 31 one-minute buckets → 30 minutes of span
    expect((t.lastPointMs! - t.firstPointMs!) / 60000).toBe(30)
  })

  it('sums money per-point in cents (no float drift across the session)', () => {
    const t = parseTrend(sample, 1000)!
    const gmv = t.series.find((s) => s.statsType === STATS_GMV)!
    expect(gmv.total).toBe(gmv.points.reduce((a, p) => a + p.value, 0))
    expect(Number.isInteger(gmv.total)).toBe(true)
  })

  it('returns null on an empty or malformed payload', () => {
    expect(parseTrend({}, 1)).toBeNull()
    expect(parseTrend({ data: { trend_data: [] } }, 1)).toBeNull()
    expect(parseTrend(null, 1)).toBeNull()
  })
})

describe('paceCentsPerHour', () => {
  it('extrapolates GMV over the real elapsed show time', () => {
    // $571.90 in 30 min → $1143.80/hr
    expect(paceCentsPerHour(57190, 1800)).toBe(114380)
  })
  it('uses the whole-show duration, so a late attach does not inflate pace', () => {
    // same GMV, but the show has been running 2h → a much lower true pace
    expect(paceCentsPerHour(57190, 7200)).toBe(28595)
  })
  it('suppresses a nonsense rate in the first minute', () => {
    expect(paceCentsPerHour(57190, 30)).toBeUndefined()
    expect(paceCentsPerHour(57190, undefined)).toBeUndefined()
  })
})

describe('formatCents', () => {
  it('formats with the session currency symbol', () => {
    expect(formatCents(57190)).toBe('$571.90')
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(1234, '£')).toBe('£12.34')
  })
})
