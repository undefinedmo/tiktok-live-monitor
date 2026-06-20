import { describe, it, expect } from 'vitest'
import { parseItemNumber, labelHtml } from '../label'

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

describe('labelHtml', () => {
  it('renders the item number and escapes buyer/product', () => {
    const html = labelHtml({ itemNumber: '#34', buyer: 'A & B', productName: '<x>', price: '$5.00' })
    expect(html).toContain('#34')
    expect(html).toContain('A &amp; B')
    expect(html).toContain('&lt;x&gt;')
    expect(html).toContain('$5.00')
  })
})
