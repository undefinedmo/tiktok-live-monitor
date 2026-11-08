import { describe, it, expect } from 'vitest'
import { planRunNext, startAuctionBody, runNextTitle, PIN_FRESH_MS, START_SETTLE_MS, type RunNextInput } from '../runNext'
import type { PinState, RosterSnapshot, RosterProduct } from '../types'

const NOW = 1_000_000
const pin = (current: Partial<NonNullable<PinState['current']>> | undefined, ts = NOW - 1000): PinState =>
  ({ kind: 'pin', ts, current: current ? { productId: 'p1', productName: 'Mystery bag', ...current } : undefined })
const product = (o: Partial<RosterProduct>): RosterProduct =>
  ({ productId: 'p1', auctionConfigId: 'cfg1', name: 'Mystery bag', numSold: 0, numFailed: 0, ...o })
const roster = (products: RosterProduct[]): RosterSnapshot =>
  ({ kind: 'roster', products, totalSold: 0, totalFailed: 0, ts: NOW } as RosterSnapshot)
const base = (o: Partial<RunNextInput> = {}): RunNextInput => ({
  pin: pin({ auctionConfigId: 'cfg1', status: 3, variantDesc: '#35' }),
  roster: roster([product({ stockNum: 12 })]),
  roomId: 'r1', sessionId: 's1', lastStart: null, nowMs: NOW, ...o,
})

describe('planRunNext — same listing, next number', () => {
  it('restarts the listing that just ended', () => {
    expect(planRunNext(base())).toEqual({ ok: true, auctionConfigId: 'cfg1', listing: 'Mystery bag', after: '#35' })
  })
  it('works without a roster row (the roster poll can lag); TikTok decides the stock', () => {
    expect(planRunNext(base({ roster: null })).ok).toBe(true)
  })
  it('refuses while a lot is bidding', () => {
    const r = planRunNext(base({ pin: pin({ auctionConfigId: 'cfg1', status: 1, variantDesc: '#36' }) }))
    expect(r).toEqual({ ok: false, reason: '#36 is still running.' })
  })
  it('runs again after an unsold lot (status 2, no winner) — the Flic stopped working here on 2026-11-08', () => {
    expect(planRunNext(base({ pin: pin({ auctionConfigId: 'cfg1', status: 2, variantDesc: '#97' }) }))).toEqual({ ok: true, auctionConfigId: 'cfg1', listing: 'Mystery bag', after: '#97' })
  })
  it('refuses a status it does not know rather than guess', () => {
    const r = planRunNext(base({ pin: pin({ auctionConfigId: 'cfg1', status: 4 }) }))
    expect(r.ok).toBe(false)
    expect(planRunNext(base({ pin: pin({ auctionConfigId: 'cfg1' }) })).ok).toBe(false)
  })
  it('stops when the listing is out of lots — it never moves down the list on its own', () => {
    const r = planRunNext(base({ roster: roster([product({ stockNum: 0 }), product({ auctionConfigId: 'cfg2', name: 'Next', stockNum: 5 })]) }))
    expect(r).toEqual({ ok: false, reason: 'Mystery bag has no lots left. Start the next listing in TikTok.' })
  })
  it('passes on TikTok’s own error for the listing', () => {
    const r = planRunNext(base({ roster: roster([product({ stockNum: 3, statusError: 'Product under review' })]) }))
    expect(r).toEqual({ ok: false, reason: 'TikTok says: Product under review' })
  })
  it('refuses with no show, no recent pin sample, or nothing ever started', () => {
    expect(planRunNext(base({ sessionId: undefined })).ok).toBe(false)
    expect(planRunNext(base({ pin: null })).ok).toBe(false)
    expect(planRunNext(base({ pin: pin({ auctionConfigId: 'cfg1', status: 3 }, NOW - PIN_FRESH_MS - 1) })).ok).toBe(false)
    expect(planRunNext(base({ pin: pin(undefined) }))).toEqual({ ok: false, reason: 'Start the first lot in TikTok. Run next lot then continues that listing.' })
  })
})

describe('planRunNext — one start at a time', () => {
  it('a second press before TikTok reports the new lot is refused, even though the last sample says ended', () => {
    const r = planRunNext(base({ lastStart: { atMs: NOW - 500, pinTs: NOW - 1000 } }))
    expect(r).toEqual({ ok: false, reason: 'Starting…' })
  })
  it('once TikTok reports the new lot bidding, it says so', () => {
    const r = planRunNext(base({
      pin: pin({ auctionConfigId: 'cfg1', status: 1, variantDesc: '#36' }, NOW - 100),
      lastStart: { atMs: NOW - 1500, pinTs: NOW - 2000 },
    }))
    expect(r).toEqual({ ok: false, reason: '#36 is still running.' })
  })
  it('the guard lapses after the settle window (a start TikTok silently dropped can be retried)', () => {
    expect(planRunNext(base({ lastStart: { atMs: NOW - START_SETTLE_MS, pinTs: NOW - START_SETTLE_MS } })).ok).toBe(true)
  })
})

describe('startAuctionBody / runNextTitle', () => {
  it('sends exactly the fields Streamer Desktop sends', () => {
    expect(startAuctionBody('cfg1', 'r1', 's1', 1234)).toEqual({ auction_config_id: 'cfg1', room_id: 'r1', session_id: 's1', fe_start_timestamp: '1234' })
  })
  it('says what a press would do, or why not', () => {
    expect(runNextTitle({ ok: true, auctionConfigId: 'c', listing: 'Mystery bag', after: '#35' })).toBe('Start the next lot of Mystery bag (after #35)')
    expect(runNextTitle({ ok: false, reason: 'Starting…' })).toBe('Starting…')
  })
})
