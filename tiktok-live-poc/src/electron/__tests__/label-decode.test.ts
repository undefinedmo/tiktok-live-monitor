import { describe, it, expect } from 'vitest'
import { normalizeDigits, matchTracking } from '../label-decode'

describe('barcode matching (restack §9)', () => {
  it('strips non-digits', () => expect(normalizeDigits('9400 1111 2233')).toBe('940011112233'))
  it('matches a CSV tracking that is a substring of the Impb-prefixed decode', () => {
    // decoded Impb string is longer than the human tracking number
    expect(matchTracking('420900409400111122233456', ['9400111122233'])).toBe('9400111122233')
  })
  it('returns null when nothing matches', () => expect(matchTracking('123', ['999'])).toBeNull())
})
