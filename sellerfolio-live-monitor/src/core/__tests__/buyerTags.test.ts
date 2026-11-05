import { describe, it, expect } from 'vitest'
import { backoffMs, batchBuyerIds, buyerTag, classifyStatus, parseCounts } from '../buyerTags'

describe('buyerTag', () => {
  it('shows no badge for an unknown or unusable count', () => {
    expect(buyerTag(undefined)).toBeNull()
    expect(buyerTag(-1)).toBeNull()
    expect(buyerTag(NaN)).toBeNull()
    expect(buyerTag(Infinity)).toBeNull()
  })
  it('0 → green NEW, "First order"', () => {
    expect(buyerTag(0)).toEqual({ kind: 'new', text: 'NEW', title: 'First order' })
  })
  it('1..99 → the number, singular/plural wording', () => {
    expect(buyerTag(1)).toEqual({ kind: 'count', text: '1', title: '1 past order' })
    expect(buyerTag(14)).toEqual({ kind: 'count', text: '14', title: '14 past orders' })
    expect(buyerTag(99)).toEqual({ kind: 'count', text: '99', title: '99 past orders' })
  })
  it('> 99 → 99+ with the exact count in the title', () => {
    expect(buyerTag(100)).toEqual({ kind: 'count', text: '99+', title: '100 past orders' })
    expect(buyerTag(240)).toEqual({ kind: 'count', text: '99+', title: '240 past orders' })
  })
})

describe('batchBuyerIds', () => {
  it('dedupes, drops empty/invalid and known ids, keeps first-appearance order', () => {
    expect(batchBuyerIds(['b', 'a', undefined, '', 'b', 'c', ' x', 'a'], new Set(['c']))).toEqual([['b', 'a']])
  })
  it('chunks at the cap', () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id${i}`)
    const out = batchBuyerIds(ids, new Set())
    expect(out.map((c) => c.length)).toEqual([200, 200, 50])
    expect(out[2]![49]).toBe('id449')
    expect(batchBuyerIds(['a', 'b', 'c'], new Set(), 2)).toEqual([['a', 'b'], ['c']])
  })
  it('nothing to ask → no chunks', () => {
    expect(batchBuyerIds([], new Set())).toEqual([])
    expect(batchBuyerIds(['a'], new Set(['a']))).toEqual([])
  })
  it('rejects absurdly long ids', () => {
    expect(batchBuyerIds(['x'.repeat(65), 'ok'], new Set())).toEqual([['ok']])
  })
})

describe('parseCounts', () => {
  it('keeps well-formed entries only', () => {
    expect(parseCounts({ counts: { a: 3, b: 0, c: -1, d: '4', e: 2.7 }, asOf: 'x' })).toEqual({ a: 3, b: 0, e: 2 })
  })
  it('tolerates junk', () => {
    expect(parseCounts(null)).toEqual({})
    expect(parseCounts('x')).toEqual({})
    expect(parseCounts({ counts: [1, 2] })).toEqual({})
    expect(parseCounts({})).toEqual({})
  })
})

describe('classifyStatus', () => {
  it('maps hq answers', () => {
    expect(classifyStatus(200)).toBe('ok')
    expect(classifyStatus(404)).toBe('unavailable')
    expect(classifyStatus(501)).toBe('unavailable')
    expect(classifyStatus(401)).toBe('auth')
    expect(classifyStatus(403)).toBe('auth')
    expect(classifyStatus(400)).toBe('bad')
    expect(classifyStatus(429)).toBe('retry')
    expect(classifyStatus(503)).toBe('retry')
    expect(classifyStatus('network')).toBe('retry')
  })
})

describe('backoffMs', () => {
  it('doubles from 5 s and caps at 5 min', () => {
    expect([1, 2, 3, 4].map((f) => backoffMs(f))).toEqual([5_000, 10_000, 20_000, 40_000])
    expect(backoffMs(50)).toBe(300_000)
    expect(backoffMs(0)).toBe(5_000)
  })
})
