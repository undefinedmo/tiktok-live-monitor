import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parsePin } from '../pin'

const rest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/rest-samples.json', import.meta.url)), 'utf8'),
)

const TS = 1781991033508

describe('parsePin', () => {
  it('parses card_type as a number', () => {
    const state = parsePin(rest.pin, TS)
    expect(state.kind).toBe('pin')
    expect(typeof state.cardType).toBe('number')
    expect(state.cardType).toBe(4)
  })

  it('extracts the current winning bidder username', () => {
    const state = parsePin(rest.pin, TS)
    expect(state.current?.winUsername).toBe('Kristine')
  })

  it('extracts the max bidding price', () => {
    const state = parsePin(rest.pin, TS)
    expect(state.current?.maxBiddingPrice).toBe('$64.00')
  })

  it('extracts numBids', () => {
    const state = parsePin(rest.pin, TS)
    expect(state.current?.numBids).toBe(21)
  })

  it('converts actual_end_time (seconds) to ms', () => {
    // fixture: actual_end_time = 1781991037 (seconds)
    const state = parsePin(rest.pin, TS)
    expect(state.current?.actualEndMs).toBe(1781991037000)
  })

  it('omits actualStartMs when actual_start_time is 0', () => {
    // fixture: actual_start_time = 0 → undefined
    const state = parsePin(rest.pin, TS)
    expect(state.current?.actualStartMs).toBeUndefined()
  })

  it('calculates serverTimeOffsetMs as resp_server_time − ts', () => {
    // resp_server_time = "1781991033508", ts = 1781991033508 → offset = 0
    const state = parsePin(rest.pin, TS)
    expect(state.serverTimeOffsetMs).toBe(0)
  })

  it('extracts expectedEndMs from string field', () => {
    // fixture: expected_end_time_ms = "1781991037590"
    const state = parsePin(rest.pin, TS)
    expect(state.current?.expectedEndMs).toBe(1781991037590)
  })

  it('extracts auctionBidTimestampMs from string field', () => {
    // fixture: auction_bid_timestamp = "1781991032590"
    const state = parsePin(rest.pin, TS)
    expect(state.current?.auctionBidTimestampMs).toBe(1781991032590)
  })

  it('returns a safe empty state for missing/garbage payload', () => {
    const state = parsePin({}, 1000)
    expect(state.kind).toBe('pin')
    expect(state.cardType).toBeUndefined()
    expect(state.current).toBeUndefined()
    expect(state.serverTimeOffsetMs).toBeUndefined()
    expect(state.ts).toBe(1000)
  })
})
