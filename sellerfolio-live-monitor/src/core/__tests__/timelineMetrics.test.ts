import { describe, expect, it } from 'vitest'
import { fmtLotTime, timelineMetrics } from '../timelineMetrics'
import type { ShowTimeline, TimelineAuction } from '../timelineLayout'

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 5, 23, 0)

function run(lot: string, startMin: number, endMin: number, outcome: TimelineAuction['outcome'], priceCents: number | null = null): TimelineAuction {
  return { lot, startMs: T0 + startMin * MIN, endMs: T0 + endMin * MIN, outcome, priceCents, productName: null, bids: null, orderId: null, buyerUserId: null, buyerName: null, item: null }
}

const show: ShowTimeline = {
  hasJournal: true, startMs: T0, endMs: T0 + 60 * MIN,
  auctions: [
    run('#1', 0, 1, 'sold', 2000),
    run('#2', 1, 2, 'unsold'),
    run('#3', 2, 3, 'unknown'),
    run('#4', 50, 51, 'sold', 5000),
    run('#5', 59, 60, 'sold', null),
  ],
  chatBuckets: [{ atMs: T0, viewerLines: 12, questions: 2 }, { atMs: T0 + MIN, viewerLines: 30, questions: 1 }],
  questions: [{ eventId: 'q1', atMs: T0, lot: '#1', text: 'size?', kind: 'size' }],
  flags: [],
}

const byKey = (cells: ReturnType<typeof timelineMetrics>) => Object.fromEntries(cells.map((c) => [c.key, c]))

describe('timelineMetrics', () => {
  it('counts unknown closes as not sold and sell-through over all runs', () => {
    const m = byKey(timelineMetrics(show, T0 + 60 * MIN))
    expect(m.runs!.value).toBe('5')
    expect(m.sold!.value).toBe('3')
    expect(m.unsold!.value).toBe('2')
    expect(m.st!.value).toBe('60%')
  })
  it('averages only sold runs with a known price', () => {
    const m = byKey(timelineMetrics(show, T0 + 60 * MIN))
    expect(m.avg!.value).toBe('$35.00')
    expect(m.top!.value).toBe('$50.00')
  })
  it('reads the last 15 minutes against nowMs', () => {
    const m = byKey(timelineMetrics(show, T0 + 60 * MIN))
    expect(m.recent!.value).toBe('100%')
    expect(m.recent!.sub).toBe('2 of 2 sold')
  })
  it('sums chat and finds the peak minute', () => {
    const m = byKey(timelineMetrics(show, T0 + 60 * MIN))
    expect(m.chat!.value).toBe('42')
    expect(m.peak!.value).toBe('30/min')
    expect(m.qs!.value).toBe('1')
    expect(m.flags!.value).toBe('0')
  })
  it('shows dashes for an empty show instead of zeros that look like data', () => {
    const m = byKey(timelineMetrics({ ...show, auctions: [], chatBuckets: [] }, T0))
    expect(m.st!.value).toBe('—')
    expect(m.avg!.value).toBe('—')
    expect(m.lot!.value).toBe('—')
    expect(m.peak!.value).toBe('—')
  })
  it('formats lot time as m:ss', () => {
    expect(fmtLotTime(65)).toBe('1:05')
    expect(fmtLotTime(720)).toBe('12:00')
  })
})
