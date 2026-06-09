import { describe, it, expect } from 'vitest'
import { parseMoney } from '../money'

describe('parseMoney', () => {
  it('parses a formatted dollar string to cents', () => {
    expect(parseMoney('$31.00')).toEqual({ cents: 3100, formatted: '$31.00' })
  })
  it('handles missing cents and thousands separators', () => {
    expect(parseMoney('$1,250')).toEqual({ cents: 125000, formatted: '$1,250' })
  })
  it('returns zero cents for empty/garbage', () => {
    expect(parseMoney('')).toEqual({ cents: 0, formatted: '' })
  })
})
