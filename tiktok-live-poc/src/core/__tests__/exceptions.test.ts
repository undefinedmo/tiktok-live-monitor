import { describe, it, expect } from 'vitest'
import { classifyException } from '../exceptions'

describe('classifyException', () => {
  it('returns no reasons for undefined flags and paid status', () => {
    const result = classifyException(undefined, 'paid')
    expect(result).toEqual({ reasons: [], needsAttention: false })
  })

  it('returns no reasons for empty flags and paid status', () => {
    const result = classifyException({}, 'paid')
    expect(result).toEqual({ reasons: [], needsAttention: false })
  })

  it('flags failed payment alone', () => {
    const result = classifyException({}, 'failed')
    expect(result.reasons).toEqual(['payment-failed'])
    expect(result.needsAttention).toBe(true)
  })

  it('flags risk order', () => {
    const result = classifyException({ isRiskOrder: true }, 'paid')
    expect(result.reasons).toEqual(['risk'])
    expect(result.needsAttention).toBe(true)
  })

  it('flags buyer note', () => {
    const result = classifyException({ hasBuyerNote: true }, 'paid')
    expect(result.reasons).toEqual(['buyer-note'])
    expect(result.needsAttention).toBe(true)
  })

  it('does NOT flag informational-only signals (hasSellerNote, hasInsurance)', () => {
    const result = classifyException({ hasSellerNote: true, hasInsurance: true }, 'paid')
    expect(result.reasons).toEqual([])
    expect(result.needsAttention).toBe(false)
  })

  it('produces combined reasons in exact stable order: payment-failed, risk, replacement, buyer-note', () => {
    const result = classifyException(
      { isReplacement: true, hasBuyerNote: true, isRiskOrder: true },
      'failed'
    )
    expect(result.reasons).toEqual(['payment-failed', 'risk', 'replacement', 'buyer-note'])
    expect(result.needsAttention).toBe(true)
  })

  it('flags seller-flag', () => {
    const result = classifyException({ hasSellerFlag: true }, 'paid')
    expect(result.reasons).toEqual(['seller-flag'])
    expect(result.needsAttention).toBe(true)
  })

  it('flags replacement alone', () => {
    const result = classifyException({ isReplacement: true }, 'paid')
    expect(result.reasons).toEqual(['replacement'])
    expect(result.needsAttention).toBe(true)
  })

  it('works with undefined paymentStatus and no flags', () => {
    const result = classifyException(undefined, undefined)
    expect(result).toEqual({ reasons: [], needsAttention: false })
  })
})
