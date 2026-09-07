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
  // Stripping every non-digit turned a refund into income: "-$5.00" parsed to +500 cents
  // and ADDED to the show total instead of subtracting.
  it('keeps a leading minus sign', () => {
    expect(parseMoney('-$5.00').cents).toBe(-500)
    expect(parseMoney('-$1,250').cents).toBe(-125000)
  })
  it('only treats a LEADING minus as negation', () => {
    expect(parseMoney('$5.00').cents).toBe(500)
    // a '-' inside an id/range is not a sign
    expect(parseMoney('$12.00 (order 7-9)').cents).toBeGreaterThan(0)
  })
})
