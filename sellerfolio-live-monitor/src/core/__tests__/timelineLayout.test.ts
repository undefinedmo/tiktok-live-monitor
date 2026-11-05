import { describe, it, expect } from 'vitest'
import {
  axisTicks, barAria, DEFAULT_RUN_MS, fitLabel, followScroll, kindClass, layoutBars, layoutChat, makeScale, MIN_HIT_PX, MIN_MS,
  parseTimeline, placeMarkers, priceOf, productOf, saidRuns, scrollForZoom, timeDomain, timelineSummary, type TimelineAuction,
} from '../timelineLayout'

const T0 = Date.UTC(2026, 10, 5, 18, 0, 0)
const run = (o: Partial<TimelineAuction> & Pick<TimelineAuction, 'lot' | 'endMs'>): TimelineAuction => ({
  startMs: null, outcome: 'sold', priceCents: 3500, productName: 'UGG Tasman', bids: 4, orderId: 'o1', buyerUserId: 'b1', buyerName: 'Ann', item: null, ...o,
})
const empty = { hasJournal: true, startMs: null, endMs: null, auctions: [], chatBuckets: [], questions: [], flags: [] }

describe('parseTimeline', () => {
  it('reads { timeline } and drops malformed entries', () => {
    const t = parseTimeline({
      timeline: {
        hasJournal: true, startMs: T0, endMs: T0 + 3_600_000,
        auctions: [{ lot: '#1', endMs: T0 + 60_000, outcome: 'sold', priceCents: 1200, startMs: T0 }, { lot: '#2' }, null, { lot: '#3', endMs: T0 + 120_000, outcome: 'weird' }],
        chatBuckets: [{ atMs: T0, viewerLines: 5, questions: 1 }, { viewerLines: 3 }],
        questions: [{ eventId: 'q1', atMs: T0 + 5, lot: '#1', text: 'size?', kind: 'size' }, { text: 'no time' }],
        flags: 'nope',
      },
    })!
    expect(t.auctions.map((a) => [a.lot, a.outcome])).toEqual([['#1', 'sold'], ['#3', 'unknown']])
    expect(t.auctions[1]!.priceCents).toBeNull()
    expect(t.chatBuckets).toHaveLength(1)
    expect(t.questions).toHaveLength(1)
    expect(t.flags).toEqual([])
  })
  it('null for a non-timeline body', () => {
    expect(parseTimeline(null)).toBeNull()
    expect(parseTimeline({ error: 'not_available' })).toBeNull()
  })
})

describe('timeDomain', () => {
  it('null when there is nothing with a time', () => { expect(timeDomain(empty)).toBeNull() })
  it('widens the stated span to every mark and enforces a minute', () => {
    expect(timeDomain({ ...empty, startMs: T0, endMs: T0 + 10_000, questions: [{ eventId: 'q', atMs: T0 - 5_000, lot: null, text: '', kind: 'size' }] }))
      .toEqual({ t0: T0 - 5_000, t1: T0 - 5_000 + MIN_MS })
    expect(timeDomain({ ...empty, auctions: [run({ lot: '#1', endMs: T0 + 600_000, startMs: T0 })] })).toEqual({ t0: T0, t1: T0 + 600_000 })
  })
})

describe('layoutBars', () => {
  const s = makeScale(T0, T0 + 600_000, 624, 12) // 1 px per second inside the padding
  it('a run without a start begins at the previous end; the first gets DEFAULT_RUN_MS', () => {
    const b = layoutBars([run({ lot: '#2', endMs: T0 + 200_000 }), run({ lot: '#1', endMs: T0 + 100_000 })], s)
    expect(b.map((x) => x.run.lot)).toEqual(['#1', '#2'])
    expect(b[0]!.startMs).toBe(T0 + 100_000 - DEFAULT_RUN_MS)
    expect(b[1]!.startMs).toBe(T0 + 100_000)
    expect(b[1]!.x).toBeCloseTo(112)
    expect(b[1]!.w).toBeCloseTo(100)
  })
  it('a start after the end collapses; tiny bars get a minimum hit width', () => {
    const [b] = layoutBars([run({ lot: '#1', endMs: T0 + 100_000, startMs: T0 + 150_000 })], s)
    expect(b!.startMs).toBe(T0 + 100_000)
    expect(b!.w).toBe(1)
    expect(b!.hw).toBe(MIN_HIT_PX)
    expect(b!.hx).toBeCloseTo(b!.x + 0.5 - MIN_HIT_PX / 2)
  })
})

describe('labels', () => {
  it('product prefers what the transcription identified', () => {
    expect(productOf(run({ lot: '#1', endMs: 0, item: { brand: 'UGG', item: 'Tazz', size: '8', color: null, summary: null } }))).toBe('UGG Tazz')
    expect(productOf(run({ lot: '#1', endMs: 0 }))).toBe('UGG Tasman')
    expect(productOf(run({ lot: '#1', endMs: 0, productName: null }))).toBeNull()
  })
  it('price never fabricates a zero', () => {
    expect(priceOf({ priceCents: null })).toBeNull()
    expect(priceOf({ priceCents: 3500 })).toBe('$35.00')
  })
  it('fitLabel degrades: full → lot → nothing', () => {
    const a = run({ lot: '#42', endMs: 0 })
    expect(fitLabel(a, 200)).toBe('#42 · $35.00')
    expect(fitLabel(a, 30)).toBe('#42')
    expect(fitLabel(a, 10)).toBeNull()
  })
  it('aria and summary', () => {
    expect(barAria(run({ lot: '#42', endMs: 0, outcome: 'unsold', priceCents: null }))).toBe('Lot 42, Unsold, UGG Tasman')
    expect(timelineSummary({ auctions: [run({ lot: '#1', endMs: 1 }), run({ lot: '#2', endMs: 2, outcome: 'unsold' })] })).toBe('2 runs · 1 sold')
    expect(timelineSummary({ auctions: [run({ lot: '#1', endMs: 1 })] })).toBe('1 run · 1 sold')
    expect(kindClass('Fit_Fabric"><x')).toBe('fit_fabricx')
    expect(kindClass('***')).toBe('other')
  })
})

describe('chat, markers, ticks, said', () => {
  const s = makeScale(T0, T0 + 30 * MIN_MS, 1824, 12) // 1 px per second
  it('columns scale to the busiest minute; questions on the same scale', () => {
    const { cols, max } = layoutChat([{ atMs: T0, viewerLines: 10, questions: 2 }, { atMs: T0 + MIN_MS, viewerLines: 5, questions: 9 }], s, 40)
    expect(max).toBe(10)
    expect(cols[0]!.hLines).toBe(40)
    expect(cols[0]!.hQuestions).toBe(8)
    expect(cols[1]!.hQuestions).toBe(20) // capped at its own lines
    expect(cols[0]!.w).toBeCloseTo(59)
  })
  it('markers sorted by time', () => {
    const m = placeMarkers([{ eventId: 'b', atMs: T0 + 2000, lot: null, text: '', kind: 'x' }, { eventId: 'a', atMs: T0 + 1000, lot: null, text: '', kind: 'x' }], s)
    expect(m.map((p) => p.m.eventId)).toEqual(['a', 'b'])
  })
  it('ticks land on round minutes with room between labels', () => {
    const t = axisTicks(s)
    expect(t.length).toBeGreaterThan(2)
    expect(t.every((x) => x.ms % (2 * MIN_MS) === 0)).toBe(true) // 60 px/min → 2-minute step at 72 px
  })
  it('said = sold runs whose transcript has a summary', () => {
    const bars = layoutBars([
      run({ lot: '#1', endMs: T0 + 60_000, item: { brand: null, item: null, size: null, color: null, summary: 'Size 8, new' } }),
      run({ lot: '#2', endMs: T0 + 120_000, outcome: 'unsold', item: { brand: null, item: null, size: null, color: null, summary: 'x' } }),
      run({ lot: '#3', endMs: T0 + 180_000, item: { brand: null, item: null, size: null, color: null, summary: '  ' } }),
    ], s)
    expect(saidRuns(bars).map((b) => b.run.lot)).toEqual(['#1'])
  })
})

describe('scrolling', () => {
  it('zoom keeps the centre', () => {
    expect(scrollForZoom(0, 500, 500, 1000)).toBe(250)
    expect(scrollForZoom(500, 500, 1000, 500)).toBe(0)
  })
  it('a view on the live edge stays on it as the plot grows; otherwise it holds', () => {
    expect(followScroll({ scrollLeft: 500, viewW: 500, plotW: 1000 }, 1200)).toBe(700)
    expect(followScroll({ scrollLeft: 100, viewW: 500, plotW: 1000 }, 1200)).toBe(100)
    expect(followScroll({ scrollLeft: 900, viewW: 500, plotW: 2000 }, 1000)).toBe(500)
  })
})
