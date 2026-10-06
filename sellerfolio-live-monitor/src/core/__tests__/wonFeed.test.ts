import { describe, it, expect } from 'vitest'
import { parseWonFeedRow } from '../wonFeed'

// The on-screen "won" feed paints "<name> won auction item <n> …" the instant an
// auction closes — sub-second, well before the ~4s auction_result/get order row.
// parseWonFeedRow turns one feed row's text into the fields our packing label needs.
// Format documented in the Auction Winner Capture README; verify wording live.
describe('parseWonFeedRow', () => {
  it('extracts display name + auction number from the core phrase', () => {
    expect(parseWonFeedRow('3rd of July won auction item 196')).toEqual({
      name: '3rd of July',
      auctionNo: '196',
    })
  })

  it('handles a # before the auction number', () => {
    expect(parseWonFeedRow('Jane Doe won auction item #42')).toEqual({
      name: 'Jane Doe',
      auctionNo: '42',
    })
  })

  it('captures a trailing price when the feed row includes one', () => {
    expect(parseWonFeedRow('3rd of July won auction item 196 for $9.00')).toEqual({
      name: '3rd of July',
      auctionNo: '196',
      price: '$9.00',
    })
  })

  it('trims surrounding whitespace/newlines from name and number', () => {
    expect(parseWonFeedRow('  Bob   won auction item 7  ')).toEqual({
      name: 'Bob',
      auctionNo: '7',
    })
  })

  it('returns null for a feed row that is not an auction win', () => {
    expect(parseWonFeedRow('someone is now following the host')).toBeNull()
  })

  it('returns null for empty/garbage text', () => {
    expect(parseWonFeedRow('')).toBeNull()
    expect(parseWonFeedRow('   ')).toBeNull()
  })
})
