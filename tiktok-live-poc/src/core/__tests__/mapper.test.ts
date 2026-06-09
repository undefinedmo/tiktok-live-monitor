import { describe, it, expect } from 'vitest'
import { mapCreatorMessage, parseManagerEnrichment } from '../mapper'
import type { PbNode } from '../decoder'

const creator = (eventName: string, auctionState: PbNode): PbNode => ({
  '1': { '1': 'WebcastOecLiveCreatorMessage', '4': '1780000000000' },
  '3': { '2': { '1': auctionState } },
  '4': { '3': eventName, '4': [{ '1': 'action_type', '2': eventName.split('.')[1] ?? '' }] },
})

describe('mapCreatorMessage', () => {
  it('maps auction.new_bid to a BidEvent with price in cents', () => {
    const ev = mapCreatorMessage(creator('auction.new_bid', { '1': '8656', '5': 'Sugarholic Cookies', '7': '$15.00' }))
    expect(ev).toMatchObject({ kind: 'bid', auctionConfigId: '8656', price: { cents: 1500 } })
  })
  it('maps auction.end to an auction_ended AuctionEvent', () => {
    const ev = mapCreatorMessage(creator('auction.end', { '1': '8656', '5': 'Item', '7': '$31.00' }))
    expect(ev).toMatchObject({ kind: 'auction_ended', price: { cents: 3100 } })
  })
  it('maps auction.result_update to a sold SaleEvent with a dedupeKey', () => {
    const ev = mapCreatorMessage(creator('auction.result_update', { '1': '8656', '5': 'Item', '7': '$31.00' }))
    expect(ev).toMatchObject({ kind: 'sale', status: 'sold', source: 'stream', dedupeKey: '8656' })
  })
  it('maps auction.payment_failure to a payment_failed SaleEvent', () => {
    const ev = mapCreatorMessage(creator('auction.payment_failure', { '1': '8656', '5': 'Item', '7': '$31.00' }))
    expect(ev).toMatchObject({ kind: 'sale', status: 'payment_failed' })
  })
  it('returns null for an unknown event name', () => {
    expect(mapCreatorMessage(creator('auction.unknown', { '1': '8656' }))).toBeNull()
  })
})

describe('parseManagerEnrichment', () => {
  it('extracts buyer username and product from a manager payload', () => {
    const payload: PbNode = {
      '11': {
        '1': { '3': 'Brenda', '38': 'brendap2929' },
        '2': { '1': 'Women Contemporary Random Pull', '3': { '1': '$15.00' } },
      },
    }
    expect(parseManagerEnrichment(payload)).toEqual({
      buyer: { username: 'brendap2929', displayName: 'Brenda' },
      productName: 'Women Contemporary Random Pull',
      price: { cents: 1500, formatted: '$15.00' },
    })
  })
})
