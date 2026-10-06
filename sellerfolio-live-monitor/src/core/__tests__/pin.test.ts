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

  it('extracts variantDesc (the lot number) from auction_config', () => {
    // fixture: auction_config.variant_desc = "#35" — the number printed on the label.
    const state = parsePin(rest.pin, TS)
    expect(state.current?.variantDesc).toBe('#35')
  })

  it('extracts auctionConfigId as a string, whatever its JSON type', () => {
    // The fixture carries it as a NUMBER (1047740030982); live pin/get sends a
    // STRING ("1158840125190"). Both must normalize to string so it can key a Set.
    const state = parsePin(rest.pin, TS)
    expect(state.current?.auctionConfigId).toBe('1047740030982')
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

// Shape captured from the live console 2026-10-03 (lot #131, bidding, no bids yet).
const LIVE_PIN = {
  code: 0,
  card_type: 4,
  auction_config: {
    auction_config_id: '1906833274118', product_id: '1732717994938504163', sku_id: '1732718003940463587',
    product_name: 'SKIMS INTIMATES - FINAL SALE', variant_desc: '#131', duration: 7, extended_auction_duration: 3,
    starting_bid_price: '22', formatted_starting_bid_price: '$22.00',
    latest_auction_item: {
      auction_config_id: '1906833274118', status: 1, actual_start_time: 0, num_of_bids: 0, win_username: '',
      max_bidding_price: '$22.00', expected_end_time_ms: '1791059280151', auction_bid_timestamp: '1791059273151',
    },
  },
  auction_config_v2: { latest_auction_item: { auction_config_id: '1906833274118', auction_item_id: '8661032858290852374', status: 1 } },
  resp_meta_data: { resp_server_time: '1791059275253' },
}

describe('parsePin — per-run identity and auction terms', () => {
  it('reads the per-run auction_item_id from the v2 block', () => {
    expect(parsePin(LIVE_PIN, TS).current?.auctionItemId).toBe('8661032858290852374')
  })

  it('reads starting price, duration and extension', () => {
    const c = parsePin(LIVE_PIN, TS).current
    expect(c?.startingBid).toBe('$22.00')
    expect(c?.durationSec).toBe(7)
    expect(c?.extendedDurationSec).toBe(3)
  })

  it('auction_bid_timestamp is the start while there are no bids: exactly duration before the end', () => {
    const c = parsePin(LIVE_PIN, TS).current!
    expect(c.numBids).toBe(0)
    expect(c.expectedEndMs! - c.auctionBidTimestampMs!).toBe(7000)
  })

  it('leaves the new fields undefined on a response without them', () => {
    const c = parsePin({ auction_config: { product_id: 'p', product_name: 'n', latest_auction_item: { status: 1 } } }, TS).current
    expect(c?.auctionItemId).toBeUndefined()
    expect(c?.startingBid).toBeUndefined()
    expect(c?.durationSec).toBeUndefined()
  })
})

