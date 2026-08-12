import { describe, it, expect } from 'vitest'
import { labelZpl, hasNonZplText, labelNeedsHtml } from '../../electron/zplLabel'
import { DEFAULT_TEMPLATE, type LabelTemplate } from '../../electron/label'

describe('hasNonZplText', () => {
  it('passes plain Latin text', () => {
    expect(hasNonZplText('Headrolock')).toBe(false)
    expect(hasNonZplText('Yolanda Quintero')).toBe(false)
    expect(hasNonZplText('$27.00')).toBe(false)
    expect(hasNonZplText(undefined)).toBe(false)
  })
  it('flags emoji and non-Latin glyphs', () => {
    expect(hasNonZplText('Sammy 🦋')).toBe(true)
    expect(hasNonZplText('☆☆☆')).toBe(true)
    expect(hasNonZplText('Yolanda 🇲🇽')).toBe(true)
  })
})

describe('labelNeedsHtml (hybrid fallback)', () => {
  it('false for a clean label → uses fast ZPL path', () => {
    expect(labelNeedsHtml({ itemNumber: '165', buyer: 'Headrolock', productName: 'Alo Yoga Sample', price: '$27.00' })).toBe(false)
  })
  it('true when the buyer name has emoji → falls back to HTML', () => {
    expect(labelNeedsHtml({ itemNumber: '174', buyer: 'Sammy 🦋', productName: 'Alo Yoga Sample' })).toBe(true)
  })
  it('ignores emoji in a field that is turned OFF in the template', () => {
    const noProduct: LabelTemplate = { ...DEFAULT_TEMPLATE, productName: false }
    expect(labelNeedsHtml({ itemNumber: '1', buyer: 'Ann', productName: 'thing 🎁' }, noProduct)).toBe(false)
  })
})

describe('labelZpl', () => {
  const data = { itemNumber: '165', buyer: 'Headrolock', productName: 'Alo Yoga Sample', price: '$27.00' }

  it('emits a well-formed ZPL label with the right dimensions (2x1 @ 203dpi)', () => {
    const z = labelZpl(data)
    expect(z.startsWith('^XA')).toBe(true)
    expect(z.trimEnd().endsWith('^XZ')).toBe(true)
    expect(z).toContain('^PW406') // 2in * 203
    expect(z).toContain('^LL203') // 1in * 203
    expect(z).toContain('^CI28') // UTF-8
  })

  it('includes the enabled fields and strips the # correctly', () => {
    const z = labelZpl(data)
    expect(z).toContain('^FD#165^FS')
    expect(z).toContain('^FDHeadrolock^FS')
    expect(z).toContain('^FDAlo Yoga Sample^FS')
    expect(z).not.toContain('$27.00') // price is off by default
  })

  it('omits fields disabled in the template', () => {
    const onlyNumber: LabelTemplate = { ...DEFAULT_TEMPLATE, buyer: false, productName: false }
    const z = labelZpl(data, onlyNumber)
    expect(z).toContain('^FD#165^FS')
    expect(z).not.toContain('Headrolock')
    expect(z).not.toContain('Alo Yoga Sample')
  })

  it('includes price when enabled', () => {
    const withPrice: LabelTemplate = { ...DEFAULT_TEMPLATE, price: true }
    expect(labelZpl(data, withPrice)).toContain('^FD$27.00^FS')
  })

  it('centers each line with an explicit x-offset (not ^FB, which emulators ignore)', () => {
    const z = labelZpl(data)
    expect(z).not.toContain('^FB')
    const xs = [...z.matchAll(/\^FO(\d+),\d+/g)].map((m) => Number(m[1]))
    expect(xs.length).toBeGreaterThan(0)
    expect(xs.every((x) => x > 0)).toBe(true) // every line pushed right of the edge → centered
  })

  it('draws at the font’s natural aspect (^A0 width = height, never condensed)', () => {
    const z = labelZpl({ ...data, price: undefined }, { ...DEFAULT_TEMPLATE, price: true })
    const fonts = [...z.matchAll(/\^A0N,(\d+),(\d+)/g)]
    expect(fonts.length).toBeGreaterThan(0)
    for (const [, h, w] of fonts) expect(w).toBe(h)
  })

  it('centers a short line further right than a long one (proportional measurement)', () => {
    const x = (z: string) => Number(/\^FO(\d+),/.exec(z)![1])
    const one = labelZpl({ itemNumber: '1' }, { ...DEFAULT_TEMPLATE, buyer: false, productName: false })
    const many = labelZpl({ itemNumber: '888888' }, { ...DEFAULT_TEMPLATE, buyer: false, productName: false })
    expect(x(one)).toBeGreaterThan(x(many))
    // "#1" at the 2x1 default (32pt ≈ 90 dots) is ~2 narrow-ish glyphs, so it lands near
    // the middle of the 406-dot label rather than hugging the left edge
    expect(x(one)).toBeGreaterThan(120)
  })

  it('vertically centers the stack within the label', () => {
    const z = labelZpl(data)
    const ys = [...z.matchAll(/\^FO\d+,(\d+)/g)].map((m) => Number(m[1]))
    const heights = [...z.matchAll(/\^A0N,(\d+),/g)].map((m) => Number(m[1]))
    const topGap = ys[0]!
    const bottomGap = 203 - (ys[ys.length - 1]! + heights[heights.length - 1]!)
    expect(topGap).toBeGreaterThan(0)
    expect(Math.abs(topGap - bottomGap)).toBeLessThanOrEqual(2) // within rounding
  })

  it('tracks the die-cut gap (^MNY) and clears any stale label home', () => {
    const z = labelZpl(data)
    expect(z).toContain('^MNY') // ^MNN = continuous → artwork walks off gapped stock
    expect(z).toContain('^LH0,0')
  })

  it('shrinks a long line so it stays within the round safe zone (2x2)', () => {
    const big: LabelTemplate = { ...DEFAULT_TEMPLATE, labelSize: '2x2', buyer: true }
    const z = labelZpl({ itemNumber: '1', buyer: 'a-really-long-buyer-name-that-would-overflow' }, big)
    // the long line's font height is reduced below its 9pt→~25dot default
    const buyerFont = /\^A0N,(\d+),\d+\^FDa-really/.exec(z)
    expect(buyerFont).toBeTruthy()
    expect(Number(buyerFont![1])).toBeLessThan(25)
  })

  it('extracts the custom tag from the TITLE — a lot-number-only title yields nothing', () => {
    // Contract for the print paths: whatever builds LabelData must put the lot's
    // descriptive text in `title`. The fast close-signal path once passed title:"#23",
    // so a rule like NWT|RETURN matched in the settings preview and never on a real
    // label. Both halves are asserted so a regression is unambiguous.
    const tpl: LabelTemplate = { ...DEFAULT_TEMPLATE, custom: { enabled: true, regex: '\\b(NWT|RETURN)S?\\b', flags: 'i' } }
    const bare = labelZpl({ itemNumber: '23', buyer: 'Sarah D.', title: '#23' }, tpl)
    expect(bare).not.toContain('RETURN')

    const full = labelZpl({ itemNumber: '23', buyer: 'Sarah D.', title: '#23 FIGS CUSTOMER RETURNS - FINAL SALE' }, tpl)
    expect(full).toContain('^FDRETURN^FS') // singular: the S is outside the capture group
  })

  it('escapes ZPL control characters in field data', () => {
    const z = labelZpl({ itemNumber: '9', buyer: 'A^B~C\\D' })
    expect(z).toContain('A\\^B\\~C\\\\D')
  })

  it('honors a different label size', () => {
    const big: LabelTemplate = { ...DEFAULT_TEMPLATE, labelSize: '2x2' }
    const z = labelZpl(data, big)
    expect(z).toContain('^PW406')
    expect(z).toContain('^LL406') // 2in * 203
  })
})
