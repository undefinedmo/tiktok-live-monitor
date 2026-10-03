import { describe, it, expect } from 'vitest'
import { labelCode, parseLabelCode, qrModules } from '../labelCode'

const SKU = '1732451642461557731' // lot #35 in fixtures/rest-samples.json

describe('labelCode', () => {
  it('encodes a TikTok sku as SF1:T:<sku>', () => {
    expect(labelCode(SKU)).toBe(`SF1:T:${SKU}`)
  })
  it('is empty when there is no usable sku (manual prints, unattributed closes)', () => {
    expect(labelCode(undefined)).toBe('')
    expect(labelCode('')).toBe('')
    expect(labelCode('im-123')).toBe('') // a synthetic auctionConfigId fallback, not a sku
  })
  it('round-trips through the parser', () => {
    expect(parseLabelCode(labelCode(SKU))).toEqual({ version: 'SF1', platform: 'T', id: SKU })
  })
})

describe('parseLabelCode', () => {
  it('tolerates scanner case-shift and a trailing CR/LF', () => {
    expect(parseLabelCode(`sf1:t:${SKU}\r\n`)).toEqual({ version: 'SF1', platform: 'T', id: SKU })
  })
  it('reads Whatnot codes too', () => {
    expect(parseLabelCode('SF1:W:ABC123')?.platform).toBe('W')
  })
  it('rejects anything that is not an SF1 code', () => {
    expect(parseLabelCode('9f03c1c6|#23 Alo Yoga')).toBeNull() // the old desktop-v2 payload
    expect(parseLabelCode('SF2:T:1')).toBeNull()
    expect(parseLabelCode('SF1:X:1')).toBeNull()
  })
})

describe('qrModules', () => {
  it('fits a 19-digit sku code in a version-2 symbol (25×25) at ECC M', () => {
    const m = qrModules(labelCode(SKU))
    expect(m.length).toBe(25)
    expect(m.every((row) => row.length === 25)).toBe(true)
  })
  it('draws the finder pattern in the top-left corner', () => {
    const m = qrModules(labelCode(SKU))
    expect(m[0]!.slice(0, 7).every(Boolean)).toBe(true) // solid top edge of the finder
    expect(m[1]![1]).toBe(false) // its white ring
    expect(m[3]![3]).toBe(true) // its dark centre
  })
})
