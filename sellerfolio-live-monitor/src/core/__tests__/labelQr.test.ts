import { describe, it, expect } from 'vitest'
import { labelZpl } from '../../electron/zplLabel'
import { labelHtml, DEFAULT_TEMPLATE, type LabelTemplate, type LabelData } from '../../electron/label'
import { labelCode } from '../labelCode'

const code = labelCode('1732451642461557731')
const sale: LabelData = { itemNumber: '35', buyer: 'Headrolock', productName: 'Alo Yoga Sample', code }
const withQr = (labelSize: LabelTemplate['labelSize']): LabelTemplate => ({ ...DEFAULT_TEMPLATE, labelSize, qr: true })

/** [x, y, mag] of the ^BQ field, or null. */
const bq = (z: string) => {
  const m = /\^FO(\d+),(\d+)\^BQN,2,(\d+)\^FD(.*?)\^FS/.exec(z)
  return m ? { x: +m[1]!, y: +m[2]!, mag: +m[3]!, fd: m[4]! } : null
}
const textXs = (z: string) => [...z.matchAll(/\^FO(\d+),\d+\^A0N/g)].map((m) => +m[1]!)

describe('label QR — ZPL path', () => {
  it('prints nothing extra when the template has QR off (existing labels unchanged)', () => {
    expect(labelZpl(sale)).toBe(labelZpl({ ...sale, code: undefined }))
    expect(labelZpl(sale)).not.toContain('^BQ')
  })

  it('prints nothing extra when the sale has no code (manual Next/Custom/Range)', () => {
    expect(labelZpl({ itemNumber: '36' }, withQr('2x1'))).not.toContain('^BQ')
  })

  it('emits a native ^BQ with ECC M + the SF1 code', () => {
    const q = bq(labelZpl(sale, withQr('2x1')))!
    expect(q.fd).toBe(`MA,${code}`)
  })

  it('2x1: QR on the left, every text line to its right', () => {
    const z = labelZpl(sale, withQr('2x1'))
    const q = bq(z)!
    const qrRight = q.x + 25 * q.mag // 25-module symbol
    expect(q.x).toBeLessThan(40)
    expect(Math.min(...textXs(z))).toBeGreaterThan(qrRight)
    // magnification fills ~90% of a 1" (203-dot) height: (25 + 2*2 quiet) * 6 = 174 dots
    expect(q.mag).toBe(6)
  })

  it('1x1 (round): QR centered under the text, inside the label', () => {
    const z = labelZpl(sale, withQr('1x1'))
    const q = bq(z)!
    const side = 25 * q.mag
    expect(Math.abs(q.x + side / 2 - 203 / 2)).toBeLessThanOrEqual(1) // horizontally centered
    expect(q.y + side).toBeLessThanOrEqual(203)
    const lastTextY = Math.max(...[...z.matchAll(/\^FO\d+,(\d+)\^A0N/g)].map((m) => +m[1]!))
    expect(q.y).toBeGreaterThan(lastTextY)
    expect(q.mag).toBe(3) // 3-dot modules — 2 is too fine for a thermal head to scan reliably
  })

  it('1x1: the QR displaces the product-name line (four rows + QR do not fit on 1")', () => {
    expect(labelZpl(sale, withQr('1x1'))).not.toContain('Alo Yoga Sample')
    expect(labelZpl(sale, { ...DEFAULT_TEMPLATE, labelSize: '1x1' })).toContain('Alo Yoga Sample') // QR off: unchanged
    expect(labelZpl(sale, withQr('1.5x1.5'))).toContain('Alo Yoga Sample') // room for both
  })
})

describe('label QR — HTML path', () => {
  it('unchanged markup when QR is off', () => {
    const html = labelHtml(sale)
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('class="qr"')
  })

  it('rectangular: QR box first, text in a column beside it', () => {
    const html = labelHtml(sale, withQr('2x1'))
    expect(html).toMatch(/<body><div class="qr"><svg[^>]*viewBox="0 0 29 29"/) // 25 + 2×2 quiet
    expect(html).toContain('<div class="txt"><div class="num">#35</div>')
  })

  it('square: text first, QR last in the column', () => {
    const html = labelHtml(sale, withQr('1x1'))
    expect(html).toMatch(/<body><div class="num">#35<\/div>.*<div class="qr"><svg/)
    expect(html).not.toContain('class="txt"')
  })
})
