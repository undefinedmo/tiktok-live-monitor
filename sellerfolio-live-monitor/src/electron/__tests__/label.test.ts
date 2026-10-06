import { describe, it, expect } from 'vitest'
import { parseItemNumber, extractCustom, labelHtml, DEFAULT_TEMPLATE } from '../label'

describe('parseItemNumber', () => {
  it('strips the # from a TikTok sku_desc', () => {
    expect(parseItemNumber('#34')).toBe('34')
  })
  it('pulls the number from a "#NN Title" string', () => {
    expect(parseItemNumber('#35 Bin B - Alo Yoga')).toBe('35')
  })
  it('handles a leading number with no hash', () => {
    expect(parseItemNumber('42 something')).toBe('42')
  })
})

describe('extractCustom', () => {
  it('returns the capture group from a title', () => {
    expect(extractCustom('#141 Bin A - Alo Yoga and More, No Cancels', '(Bin [A-Z])')).toBe('Bin A')
  })
  it('returns the whole match when there is no capture group', () => {
    expect(extractCustom('#141 Bin A - Alo Yoga', 'Bin [A-Z]')).toBe('Bin A')
  })
  it('returns empty string on no match or invalid regex', () => {
    expect(extractCustom('Bin A', 'Zzz')).toBe('')
    expect(extractCustom('Bin A', '(')).toBe('') // invalid regex, no throw
  })
})

describe('labelHtml', () => {
  it('renders only the enabled fields (escaped)', () => {
    const html = labelHtml({ itemNumber: '#34', buyer: 'A & B', productName: '<x>', price: '$5.00' }, {
      ...DEFAULT_TEMPLATE,
      buyer: false,
      productName: false,
      price: true,
    })
    expect(html).toContain('#34')
    expect(html).not.toContain('A &amp; B') // buyer disabled
    expect(html).not.toContain('&lt;x&gt;') // product disabled
    expect(html).toContain('$5.00') // price enabled
  })
  it('prints the regex-extracted custom field', () => {
    const html = labelHtml(
      { itemNumber: '#54', title: '#54 Bin A - Alo Yoga and More, No Cancels' },
      { ...DEFAULT_TEMPLATE, custom: { enabled: true, regex: '(Bin [A-Z])', flags: '' } },
    )
    expect(html).toContain('Bin A')
  })
  it('renders the 1.5 × 1.5 square at its own page + body dimensions', () => {
    const html = labelHtml({ itemNumber: '#196' }, { ...DEFAULT_TEMPLATE, labelSize: '1.5x1.5' })
    expect(html).toContain('size: 1.5in 1.5in')
    expect(html).toContain('width:1.5in')
    expect(html).toContain('height:1.5in')
  })
  it('renders the 2 × 2 square at its own page + body dimensions', () => {
    const html = labelHtml({ itemNumber: '#196' }, { ...DEFAULT_TEMPLATE, labelSize: '2x2' })
    expect(html).toContain('size: 2in 2in')
    expect(html).toContain('width:2in')
    expect(html).toContain('height:2in')
  })
})
