import { describe, it, expect } from 'vitest'
import {
  LAYOUT_SIZES, DPI, snapIn, elementText, placeText, qrPayload, qrFit, qrAdvice, normalizeLayout, migrateFromTemplate,
  defaultLayout, zplCanDraw, layoutHtml, layoutZpl, layoutNeedsHtml, monoFromRgba, logoDots, newText, newQr, newLogo,
  fitMono, monoIsCurrent, fitImageBytes, MAX_LOGO_DATAURL_BYTES, MIN_LOGO_PX, type MonoBitmap,
  type LabelLayout, type LayoutData, type TextElement, type QrElement, type LogoElement,
} from '../labelLayout'
import { LABEL_SIZES, DEFAULT_TEMPLATE, basePt, labelHtml, type LabelTemplate } from '../../electron/label'
import { labelZpl, labelNeedsHtml } from '../../electron/zplLabel'
import { labelCode } from '../labelCode'

const sale: LayoutData = {
  itemNumber: '80', buyer: 'Janet Hague', productName: 'Alo Yoga and More', price: '$20.00',
  title: '#80 Bin A - Alo Yoga and More, No Cancels', code: labelCode('1732451642461557731'),
}
const rx = { regex: '(Bin [A-Z])', flags: 'i' }
const text = (o: Partial<TextElement>): TextElement => newText({ id: 't', ...o })

/** Every ^FO…^FD…^FS field: position, glyph height, and data. */
function zplFields(z: string) {
  const out: { x: number; y: number; h?: number; kind: 'text' | 'qr' | 'box' | 'img'; data?: string; reverse?: boolean }[] = []
  for (const line of z.split('\n')) {
    const fo = /^\^FO(\d+),(\d+)/.exec(line)
    if (!fo) continue
    const x = +fo[1]!, y = +fo[2]!
    if (line.includes('^BQN')) out.push({ x, y, kind: 'qr', data: /\^FDMA,(.*)\^FS/.exec(line)?.[1] })
    else if (line.includes('^GB')) out.push({ x, y, kind: 'box' })
    else if (line.includes('^GFA')) out.push({ x, y, kind: 'img' })
    else out.push({ x, y, kind: 'text', h: +/\^A0N,(\d+)/.exec(line)![1]!, data: /\^FD(.*)\^FS/.exec(line)?.[1], reverse: line.includes('^FR') })
  }
  return out
}
/** Every positioned element in the HTML: left/top in dots, and its text. */
function htmlEls(html: string) {
  const out: { x: number; y: number; kind: string; text: string; w?: number }[] = []
  const re = /<(div|img) class="e (t|q|g)" (?:alt="" src="[^"]*" )?style="left:([\d.]+)in;top:([\d.]+)in;width:([\d.]+)in[^"]*"[^>]*>(?:<span[^>]*>([^<]*)<\/span>)?/g
  for (let m; (m = re.exec(html));) out.push({ kind: m[2]!, x: Math.round(+m[3]! * DPI), y: Math.round(+m[4]! * DPI), w: Math.round(+m[5]! * DPI), text: m[6] ?? '' })
  return out
}

describe('sizes', () => {
  it('offers every stock size incl. 1×1 and 4×6', () => {
    expect(Object.keys(LAYOUT_SIZES)).toEqual(['1x1', '1.5x1.5', '2x1', '2x2', '2.25x1.25', '4x6'])
    expect(LAYOUT_SIZES['4x6']).toEqual({ widthIn: 4, heightIn: 6 })
  })
  it('the print path knows 4×6 too (main sizes the page from LABEL_SIZES)', () => {
    expect(LABEL_SIZES['4x6']).toMatchObject({ widthIn: 4, heightIn: 6, widthMicrons: 101600, heightMicrons: 152400 })
  })
  it('snaps to 0.05 in without float dust', () => {
    expect(snapIn(0.123)).toBe(0.1)
    expect(snapIn(0.126)).toBe(0.15)
    expect(snapIn(1.3749)).toBe(1.35)
    expect(snapIn(0.3)).toBe(0.3)
  })
})

describe('elementText', () => {
  it('resolves each source', () => {
    expect(elementText(text({ src: 'lot' }), sale, rx)).toBe('#80')
    expect(elementText(text({ src: 'lot' }), { ...sale, itemNumber: '#141' }, rx)).toBe('#141')
    expect(elementText(text({ src: 'lot' }), { itemNumber: '' }, rx)).toBe('')
    expect(elementText(text({ src: 'buyer' }), sale, rx)).toBe('Janet Hague')
    expect(elementText(text({ src: 'item' }), sale, rx)).toBe('Alo Yoga and More')
    expect(elementText(text({ src: 'price' }), sale, rx)).toBe('$20.00')
    expect(elementText(text({ src: 'fixed', text: 'THANK YOU' }), sale, rx)).toBe('THANK YOU')
    expect(elementText(text({ src: 'regex' }), sale, rx)).toBe('Bin A')
  })
  it('regex keeps extractCustom semantics: group 1, else the match; title, else product name', () => {
    expect(elementText(text({ src: 'regex' }), sale, { regex: 'Bin [A-Z]' })).toBe('Bin A')
    expect(elementText(text({ src: 'regex' }), { itemNumber: '1', productName: 'NWT Bin C' }, rx)).toBe('Bin C')
    expect(elementText(text({ src: 'regex' }), sale, { regex: '(' })).toBe('') // invalid → nothing, never throws
    expect(elementText(text({ src: 'regex' }), sale, { regex: '' })).toBe('')
  })
})

describe('placeText (the one geometry both renderers draw from)', () => {
  it('left-aligned text starts at the box, at the pt height in dots', () => {
    const p = placeText(text({ x: 0.1, y: 0.2, w: 1.5, pt: 12, align: 'left' }), 'Bin A')
    expect(p.tx).toBe(Math.round(0.1 * DPI))
    expect(p.ty).toBe(Math.round(0.2 * DPI))
    expect(p.h).toBe(Math.round((12 * DPI) / 72))
  })
  it('centres and right-aligns inside the box', () => {
    const el = text({ x: 0, y: 0, w: 2, pt: 12 })
    const l = placeText({ ...el, align: 'left' }, 'AB'), c = placeText({ ...el, align: 'center' }, 'AB'), r = placeText({ ...el, align: 'right' }, 'AB')
    expect(c.tx - l.tx).toBe(Math.round((2 * DPI - l.tw) / 2))
    expect(r.tx + r.tw).toBe(Math.round(2 * DPI))
  })
  it('shrinks a line that does not fit its box, never below 10 dots', () => {
    const p = placeText(text({ w: 0.5, pt: 30 }), 'A very long buyer name')
    expect(p.h).toBeLessThan(Math.round((30 * DPI) / 72))
    expect(p.tw).toBeLessThanOrEqual(Math.round(0.5 * DPI) + 2)
    expect(placeText(text({ w: 0.1, pt: 30 }), 'x'.repeat(80)).h).toBe(10)
  })
  it('white on black pads the box around the glyphs', () => {
    const p = placeText(text({ x: 0.1, y: 0.1, w: 1.8, pt: 15, inverse: true }), 'Bin A')
    expect(p.bx).toBe(Math.round(0.1 * DPI))
    expect(p.tx - p.bx).toBe(p.padX)
    expect(p.padX).toBeGreaterThan(0)
    expect(p.bw).toBe(p.tw + 2 * p.padX)
    expect(p.bh).toBe(p.h + 2 * p.padY)
  })
})

describe('QR', () => {
  const pack = newQr({ id: 'q' })
  it('pack mode prints the sale code; a manual tag (no code) prints no QR', () => {
    expect(qrPayload(pack, sale)).toBe(sale.code)
    expect(qrPayload(pack, { itemNumber: '5' })).toBe('')
  })
  it('link / fixed print their value; empty prints nothing', () => {
    expect(qrPayload(newQr({ mode: 'link', value: ' https://x.co/a ' }), sale)).toBe('https://x.co/a')
    expect(qrPayload(newQr({ mode: 'fixed', value: '' }), sale)).toBe('')
  })
  it('fits whole-dot modules inside the box', () => {
    const f = qrFit(sale.code!, 0.46)
    expect(f.box).toBeLessThanOrEqual(Math.round(0.46 * DPI))
    expect(f.mag).toBe(3) // the pack code on the default QR: 3-dot modules
  })
  it('scan advice follows the module size: ~42 / ~84 characters on the default 0.46 in QR', () => {
    const link = (n: number) => 'https://' + 'a'.repeat(n - 8)
    expect(qrAdvice('', 0.46).level).toBe('empty')
    expect(qrAdvice(link(42), 0.46).level).toBe('ok')
    expect(qrAdvice(link(43), 0.46).level).toBe('long')
    expect(qrAdvice(link(84), 0.46).level).toBe('long')
    expect(qrAdvice(link(85), 0.46).level).toBe('too-long')
    expect(qrAdvice(link(120), 1.5).level).toBe('ok') // a bigger QR carries more
  })
})

describe('zplCanDraw', () => {
  it('QR always draws', () => expect(zplCanDraw(newQr())).toEqual({ drawable: true, slower: false, notes: [] }))
  it('text: printer font, bold forced, italic/underline dropped, inverse warned, emoji flagged', () => {
    const c = zplCanDraw(text({ font: 'Georgia', bold: false, italic: true, underline: true, inverse: true, src: 'fixed', text: 'Hi ⭐' }))
    expect(c.drawable).toBe(true)
    expect(c.notes.join(' ')).toMatch(/own font/)
    expect(c.notes.join(' ')).toMatch(/always bold/)
    expect(c.notes.join(' ')).toMatch(/Italic/)
    expect(c.notes.join(' ')).toMatch(/Underline/)
    expect(c.notes.join(' ')).toMatch(/test tag/)
    expect(c.notes.join(' ')).toMatch(/Emoji/)
    expect(zplCanDraw(text({ src: 'fixed', text: '⭐⭐' })).drawable).toBe(false)
  })
  it('logo: an image (slower); without a bitmap it cannot draw', () => {
    expect(zplCanDraw(newLogo()).drawable).toBe(false)
    expect(zplCanDraw(newLogo({ dataUrl: 'data:image/png;base64,AA' })).drawable).toBe(false)
    const ok = zplCanDraw(newLogo({ dataUrl: 'data:image/png;base64,AA', mono: { dpi: 203, w: 8, h: 1, hex: 'FF' } }))
    expect(ok).toMatchObject({ drawable: true, slower: true })
  })
})

describe('normalizeLayout', () => {
  it('rejects non-layouts', () => {
    expect(normalizeLayout(null)).toBeNull()
    expect(normalizeLayout({ size: '9x9', elements: [] })).toBeNull()
    expect(normalizeLayout({ size: '2x1' })).toBeNull()
  })
  it('clamps pt to 6–72, keeps elements on the label, keeps a QR square, drops junk', () => {
    const l = normalizeLayout({ size: '1x1', elements: [
      { type: 'text', src: 'lot', pt: 200, x: 5, y: -3, w: 9 },
      { type: 'text', src: 'nope', pt: 1 },
      { type: 'qr', w: 0.5, h: 0.9, x: 0.6 },
      { type: 'logo', dataUrl: 'javascript:alert(1)', mono: { w: 8, h: 2, hex: 'FF' } },
      { type: 'circle' }, 'junk',
    ] })!
    expect(l.elements).toHaveLength(4)
    const [a, b, q, g] = l.elements as [TextElement, TextElement, QrElement, LogoElement]
    expect(a.pt).toBe(72)
    expect(a.x).toBeLessThan(1)
    expect(a.y).toBe(0)
    expect(a.x + a.w).toBeLessThanOrEqual(1.0001)
    expect(b.pt).toBe(6)
    expect(b.src).toBe('fixed')
    expect(q.h).toBe(q.w)
    expect(g.dataUrl).toBeUndefined() // only data:image/ URLs
    expect(g.mono).toBeUndefined() // hex length must match w×h
  })
  it('round-trips a designer layout through JSON unchanged', () => {
    const l = migrateFromTemplate({ ...DEFAULT_TEMPLATE, qr: true, custom: { enabled: true, regex: '(Bin [A-Z])', flags: 'i' } })
    expect(normalizeLayout(JSON.parse(JSON.stringify(l)))).toEqual(l)
  })
})

describe('migrateFromTemplate', () => {
  it('the legacy point sizes match electron/label.ts', () => {
    for (const s of ['1x1', '1.5x1.5', '2x1', '2x2', '2.25x1.25'] as const) {
      const l = migrateFromTemplate({ ...DEFAULT_TEMPLATE, labelSize: s })
      expect((l.elements[0] as TextElement).pt).toBe(basePt('itemNumber', s))
    }
    const l = migrateFromTemplate({ ...DEFAULT_TEMPLATE, price: true, custom: { enabled: true, regex: 'x' } })
    const pt = Object.fromEntries((l.elements as TextElement[]).map((e) => [e.src, e.pt]))
    expect(pt).toEqual({ lot: basePt('itemNumber', '2x1'), regex: basePt('custom', '2x1'), buyer: basePt('buyer', '2x1'), item: basePt('productName', '2x1'), price: basePt('price', '2x1') })
  })
  it('keeps the enabled lines, in order, centred, with the per-field scale', () => {
    const l = migrateFromTemplate({ ...DEFAULT_TEMPLATE, buyer: false, scale: { itemNumber: 1.5 } })
    expect(l.size).toBe('2x1')
    expect(l.elements.map((e) => (e as TextElement).src)).toEqual(['lot', 'item'])
    expect((l.elements[0] as TextElement).pt).toBe(48)
    expect(l.elements.every((e) => e.type === 'text' && e.align === 'center')).toBe(true)
  })
  it('QR beside the text on rectangular stock, under it on square', () => {
    const r = migrateFromTemplate({ ...DEFAULT_TEMPLATE, qr: true })
    const rq = r.elements.find((e) => e.type === 'qr')!
    const rt = r.elements.find((e) => e.type === 'text')!
    expect(rq.x + rq.w).toBeLessThanOrEqual(rt.x)
    const s = migrateFromTemplate({ ...DEFAULT_TEMPLATE, labelSize: '2x2', qr: true })
    const sq = s.elements.find((e) => e.type === 'qr')!
    for (const t of s.elements.filter((e) => e.type === 'text')) expect(t.y + t.h).toBeLessThanOrEqual(sq.y)
  })
  it('drops the product line on small square stock with a QR (as the fixed label does)', () => {
    const l = migrateFromTemplate({ ...DEFAULT_TEMPLATE, labelSize: '1x1', qr: true })
    expect(l.elements.some((e) => e.type === 'text' && e.src === 'item')).toBe(false)
  })
  it('prints the same lines as the fixed template for a sale', () => {
    for (const s of ['1x1', '2x1', '2.25x1.25', '2x2'] as const) {
      const t: LabelTemplate = { ...DEFAULT_TEMPLATE, labelSize: s, price: true, qr: true, custom: { enabled: true, regex: '(Bin [A-Z])', flags: 'i' } }
      const lines = (z: string) => zplFields(z).filter((f) => f.kind !== 'box').map((f) => f.data).sort()
      expect(lines(layoutZpl(migrateFromTemplate(t), sale, rx))).toEqual(lines(labelZpl(sale, t)))
    }
  })
  it('lands each line within a few dots of where the fixed ZPL label puts it', () => {
    const t: LabelTemplate = { ...DEFAULT_TEMPLATE, labelSize: '2x2', price: true, custom: { enabled: true, regex: '(Bin [A-Z])', flags: 'i' } }
    const a = zplFields(labelZpl(sale, t)), b = zplFields(layoutZpl(migrateFromTemplate(t), sale, rx))
    expect(b.length).toBe(a.length)
    a.forEach((f, i) => { expect(Math.abs(f.y - b[i]!.y)).toBeLessThanOrEqual(3); expect(Math.abs(f.x - b[i]!.x)).toBeLessThanOrEqual(8) })
  })
  it('defaultLayout is today\'s default 2×1 label', () => {
    expect(defaultLayout()).toEqual(migrateFromTemplate(DEFAULT_TEMPLATE))
  })
})

describe('one model, two renderers', () => {
  const layout: LabelLayout = {
    version: 1, size: '2x1', elements: [
      text({ id: 'lot', src: 'lot', x: 0.1, y: 0.05, w: 1.1, pt: 28 }),
      text({ id: 'bin', src: 'regex', x: 1.3, y: 0.1, w: 0.65, pt: 15, inverse: true }),
      text({ id: 'buyer', src: 'buyer', x: 0.1, y: 0.7, w: 1.3, pt: 11, align: 'left' }),
      newQr({ id: 'qr', x: 1.5, y: 0.5, w: 0.46, h: 0.46 }),
    ],
  }
  it('print the same content', () => {
    const z = zplFields(layoutZpl(layout, sale, rx)), h = htmlEls(layoutHtml(layout, sale, rx))
    expect(z.filter((f) => f.kind === 'text').map((f) => f.data)).toEqual(h.filter((e) => e.kind === 't').map((e) => e.text))
    expect(z.find((f) => f.kind === 'qr')!.data).toBe(sale.code)
    expect(layoutHtml(layout, sale, rx)).toContain('<svg')
  })
  it('put each element at the same position (left-aligned text, QR corner)', () => {
    const z = zplFields(layoutZpl(layout, sale, rx)), h = htmlEls(layoutHtml(layout, sale, rx))
    const ht = h.filter((e) => e.kind === 't')
    // lot (left), buyer (left): glyph origin = box origin on both paths
    expect([z[0]!.x, z[0]!.y]).toEqual([ht[0]!.x, ht[0]!.y])
    const buyerZ = z.find((f) => f.data === 'Janet Hague')!
    expect([buyerZ.x, buyerZ.y]).toEqual([ht[2]!.x, ht[2]!.y])
    // inverse: the black box starts at the element origin, glyphs inset by the padding
    const box = z.find((f) => f.kind === 'box')!
    expect([box.x, box.y]).toEqual([ht[1]!.x, ht[1]!.y])
    expect(z.find((f) => f.data === 'Bin A')!.reverse).toBe(true)
    // QR: ^FO steps past the quiet zone the HTML svg draws
    const q = h.find((e) => e.kind === 'q')!, fit = qrFit(sale.code!, 0.46)
    const zq = z.find((f) => f.kind === 'qr')!
    expect([zq.x - 2 * fit.mag, zq.y - 2 * fit.mag]).toEqual([q.x, q.y])
    expect(q.w).toBe(fit.box) // same whole-dot size on both paths
  })
  it('both size the page from the layout (4×6 included)', () => {
    const big = { ...layout, size: '4x6' as const }
    expect(layoutZpl(big, sale, rx)).toMatch(/\^PW812\n\^LL1218\n/)
    expect(layoutHtml(big, sale, rx)).toContain('@page { size: 4in 6in; margin: 0; }')
  })
  it('ZPL strips glyphs the printer font cannot draw; the driver path keeps them', () => {
    const d = { ...sale, buyer: 'Mercy💕' }
    expect(zplFields(layoutZpl(layout, d, rx)).some((f) => f.data === 'Mercy')).toBe(true)
    expect(layoutHtml(layout, d, rx)).toContain('Mercy💕')
    expect(layoutHtml(layout, d, rx, { printerFont: true })).not.toContain('💕')
  })
  it('a manual tag (no code) prints without the pack QR on both paths', () => {
    const d = { ...sale, code: undefined }
    expect(layoutZpl(layout, d, rx)).not.toContain('^BQN')
    expect(layoutHtml(layout, d, rx)).not.toContain('<svg')
  })
  it('empty values print nothing (no blank black box)', () => {
    const z = layoutZpl(layout, sale, { regex: '(Bin [Q-Z])' })
    expect(z).not.toContain('^GB')
    expect(z).not.toContain('^FR')
  })
  it('driver styles: font, italic, underline, weight; printer-font preview drops them', () => {
    const l: LabelLayout = { version: 1, size: '2x1', elements: [text({ src: 'buyer', font: 'Georgia', italic: true, underline: true, bold: false })] }
    const d = layoutHtml(l, sale, rx)
    expect(d).toContain("'Georgia'")
    // every style attribute stays one attribute (a double quote inside would end it early)
    for (const m of d.matchAll(/<span style="([^"]*)"/g)) expect(m[1]).toMatch(/font-size:[\d.]+pt/)
    expect(layoutHtml(l, sale, rx, { printerFont: true })).toMatch(/<span style="[^"]*font-size:[\d.]+pt[^"]*"/)
    expect(d).toContain('font-style:italic')
    expect(d).toContain('text-decoration:underline')
    expect(d).toContain('font-weight:400')
    expect(d).toContain('<script>') // fit-to-box with real metrics
    const p = layoutHtml(l, sale, rx, { printerFont: true })
    expect(p).not.toContain('Georgia')
    expect(p).not.toContain('italic')
    expect(p).not.toContain('underline')
    expect(p).toContain('font-weight:700')
    expect(p).not.toContain('<script>')
  })
  it('escapes markup and ZPL control characters', () => {
    const l: LabelLayout = { version: 1, size: '2x1', elements: [text({ src: 'fixed', text: '<b>^XZ' })] }
    expect(layoutHtml(l, sale, rx)).toContain('&lt;b&gt;^XZ')
    expect(layoutZpl(l, sale, rx)).toContain('^FD<b>\\^XZ^FS')
  })
})

describe('logos', () => {
  it('packs RGBA into ^GF hex, MSB first, transparent = white', () => {
    // 10×1: black, white, black, transparent-black, then 6 black
    const px = [0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 0, ...Array(6).fill([0, 0, 0, 255]).flat()]
    const m = monoFromRgba(px, 10, 1)
    expect(m).toEqual({ dpi: 203, w: 10, h: 1, hex: 'AFC0' }) // 1010 1111 | 11 000000
  })
  it('contains the image in the box', () => {
    const el = newLogo({ w: 1, h: 0.5 })
    expect(logoDots(el, 400, 100)).toEqual({ w: 203, h: 51 })
    expect(logoDots(el, 100, 100)).toEqual({ w: 102, h: 102 })
  })
  it('ZPL draws the bitmap with ^GFA, centred in the box; HTML draws the image', () => {
    const g = newLogo({ x: 0.5, y: 0.1, w: 0.5, h: 0.5, dataUrl: 'data:image/png;base64,AA', mono: { dpi: 203, w: 16, h: 2, hex: 'FFFF0000' } })
    const l: LabelLayout = { version: 1, size: '2x1', elements: [g] }
    const z = layoutZpl(l, sale, rx)
    expect(z).toContain(`^GFA,4,4,2,FFFF0000^FS`)
    const fo = /\^FO(\d+),(\d+)\^GFA/.exec(z)!
    expect(+fo[1]!).toBe(Math.round(0.5 * DPI) + Math.round((0.5 * DPI - 16) / 2))
    expect(layoutHtml(l, sale, rx)).toContain('src="data:image/png;base64,AA"')
  })
})

/** A w×h bitmap, black where `dark(x, y)`. */
const bitmap = (w: number, h: number, dark: (x: number, y: number) => boolean = () => true): MonoBitmap => {
  const px: number[] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.push(...(dark(x, y) ? [0, 0, 0, 255] : [255, 255, 255, 255]))
  return monoFromRgba(px, w, h)
}
/** The ^GF fields of a ZPL string: where, and the bitmap's size in dots. */
const gfs = (z: string) => [...z.matchAll(/\^FO(\d+),(\d+)\^GFA,(\d+),\d+,(\d+),([0-9A-F]*)\^FS/g)].map((m) => {
  const bpr = +m[4]!, total = +m[3]!
  return { x: +m[1]!, y: +m[2]!, bpr, rows: total / bpr, hex: m[5]! }
})

describe('logo bitmap never outgrows its box (size change / resize)', () => {
  it('fitMono returns a bitmap that fits unchanged (same object ⇒ byte-identical ZPL)', () => {
    const m = bitmap(16, 2)
    expect(fitMono(m, 16, 2)).toBe(m)
    expect(fitMono(m, 100, 100)).toBe(m)
  })
  it('fitMono scales a too-big bitmap down, aspect kept, pixels sampled', () => {
    const m = bitmap(16, 16, (x) => x < 8) // left half black
    const f = fitMono(m, 8, 100)!
    expect([f.w, f.h, f.dpi]).toEqual([8, 8, 203])
    expect(f.hex).toBe('F0'.repeat(8))
    expect(f.hex.length).toBe(Math.ceil(f.w / 8) * 2 * f.h)
    expect(fitMono(m, 0, 10)).toBeNull()
  })
  it('a 4×6 logo printed after switching to 2×1 stays inside its clamped box (the review case)', () => {
    // 2 in square logo on 4x6: a 406-dot bitmap. Switching to 2x1 clamps the box to 2 × 1 in.
    const big = newLogo({ id: 'g', x: 0, y: 0, w: 2, h: 2, dataUrl: 'data:image/png;base64,AA', mono: bitmap(406, 406) })
    const l = normalizeLayout({ version: 1, size: '2x1', elements: [big, text({ id: 't', src: 'lot', x: 0, y: 0.5, w: 2, pt: 20 })] })!
    const g = l.elements[0] as LogoElement
    expect([g.w, g.h]).toEqual([2, 1])
    expect(g.mono!.w).toBe(406) // the stale bitmap survives normalising…
    expect(monoIsCurrent(g)).toBe(false) // …and the designer sees it must rebuild it
    const [gf] = gfs(layoutZpl(l, sale, rx))
    expect(gf).toBeDefined()
    // …but ZPL never prints it bigger than the box (203 dots tall on 1 in stock).
    expect(gf!.rows).toBeLessThanOrEqual(Math.round(1 * DPI))
    expect(gf!.bpr * 8).toBeLessThanOrEqual(Math.ceil((2 * DPI) / 8) * 8)
    expect(gf!.y + gf!.rows).toBeLessThanOrEqual(Math.round(1 * DPI))
    expect(gf!.hex.length).toBe(gf!.bpr * 2 * gf!.rows)
  })
  it('a bitmap that cannot fit at all is left off rather than overflowing', () => {
    // A hand-edited box below one dot: nothing to draw into.
    const g = newLogo({ id: 'g', w: 0.001, h: 0.001, dataUrl: 'data:image/png;base64,AA', mono: bitmap(8, 8) })
    const z = layoutZpl({ version: 1, size: '2x1', elements: [g] }, sale, rx)
    for (const gf of gfs(z)) expect(gf.rows).toBeLessThanOrEqual(1)
  })
  it('monoIsCurrent: fresh contain-fit bitmaps are current; stale, oversize or other-dpi ones are not', () => {
    const el = newLogo({ w: 1, h: 0.5 }) // 203 × 102 dots
    expect(monoIsCurrent({ ...el, mono: bitmap(...(Object.values(logoDots(el, 400, 100)) as [number, number])) })).toBe(true)
    expect(monoIsCurrent({ ...el, mono: bitmap(102, 102) })).toBe(true) // fills the height
    expect(monoIsCurrent({ ...el, mono: bitmap(50, 50) })).toBe(false) // made for a smaller box
    expect(monoIsCurrent({ ...el, mono: bitmap(406, 102) })).toBe(false) // wider than the box
    expect(monoIsCurrent({ ...el, mono: { ...bitmap(203, 51), dpi: 300 } })).toBe(false)
    expect(monoIsCurrent(el)).toBe(false)
  })
})

describe('logo image byte cap (driver path loads the label as a data: URL)', () => {
  // A fake encoder: one byte per pixel, so weight follows area like a noisy PNG.
  const enc = (w: number, h: number) => 'x'.repeat(w * h)
  it('an image under the cap is kept as is', () => {
    const r = fitImageBytes(300, 200, enc)
    expect(r).toMatchObject({ w: 300, h: 200, shrunk: false, fits: true })
  })
  it('a heavy image steps down until it fits, aspect kept', () => {
    const r = fitImageBytes(600, 600, enc) // 360 KB
    expect(r.fits).toBe(true)
    expect(r.shrunk).toBe(true)
    expect(r.dataUrl.length).toBeLessThanOrEqual(MAX_LOGO_DATAURL_BYTES)
    expect(r.w).toBe(r.h)
    expect(r.w).toBeLessThan(600)
  })
  it('stops at the floor and says it does not fit (the caller then tries JPEG / refuses)', () => {
    const r = fitImageBytes(600, 300, () => 'x'.repeat(MAX_LOGO_DATAURL_BYTES + 1))
    expect(r.fits).toBe(false)
    expect(Math.max(r.w, r.h)).toBe(MIN_LOGO_PX)
  })
  it('the cap leaves the driver URL well under Chromium’s 2 MB even percent-encoded, with four logos', () => {
    const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const head = 'data:image/png;base64,'
    const b64 = head + ABC.repeat(Math.floor((MAX_LOGO_DATAURL_BYTES - head.length) / 64))
    expect(4 * encodeURIComponent(b64).length).toBeLessThan(2 * 1024 * 1024)
    // Even a pathological image of nothing but '+' and '/' (×3 encoded) fits on its own.
    expect(encodeURIComponent(head + '+/'.repeat(MAX_LOGO_DATAURL_BYTES / 2 - 12)).length).toBeLessThan(2 * 1024 * 1024)
  })
})

describe('layoutNeedsHtml', () => {
  const l: LabelLayout = { version: 1, size: '2x1', elements: [text({ src: 'buyer' }), text({ src: 'lot' })] }
  it('false for a normal sale, and for emoji next to readable text', () => {
    expect(layoutNeedsHtml(l, sale, rx)).toBe(false)
    expect(layoutNeedsHtml(l, { ...sale, buyer: 'Sammy 🦋' }, rx)).toBe(false)
  })
  it('true when a printed value is nothing but emoji', () => {
    expect(layoutNeedsHtml(l, { ...sale, buyer: '💯' }, rx)).toBe(true)
  })
  it('ignores fields the layout does not print', () => {
    expect(layoutNeedsHtml(l, { ...sale, productName: '🎁' }, rx)).toBe(false)
  })
  it('true for a logo with an image but no printer bitmap', () => {
    expect(layoutNeedsHtml({ ...l, elements: [newLogo({ dataUrl: 'data:image/png;base64,AA' })] }, sale, rx)).toBe(true)
  })
})

describe('the print path routes a template that carries a layout', () => {
  const layout = migrateFromTemplate({ ...DEFAULT_TEMPLATE, qr: true })
  layout.elements.push(newText({ id: 'thanks', src: 'fixed', text: 'THANKS', x: 0.1, y: 0.8, w: 1 }))
  const t: LabelTemplate = { ...DEFAULT_TEMPLATE, custom: { enabled: false, regex: '(Bin [A-Z])', flags: 'i' }, layout }
  it('labelZpl / labelHtml / labelNeedsHtml print the layout', () => {
    expect(labelZpl(sale, t)).toBe(layoutZpl(layout, sale, rx))
    expect(labelHtml(sale, t)).toBe(layoutHtml(layout, sale, rx))
    expect(labelNeedsHtml({ ...sale, buyer: '💯' }, t)).toBe(true)
  })
  it('a template without a layout prints the fixed label exactly as before', () => {
    const { layout: _, ...fixed } = t
    expect(labelZpl(sale, fixed)).not.toBe(layoutZpl(layout, sale, rx))
    expect(labelZpl(sale, fixed)).toBe(labelZpl(sale, { ...fixed, layout: undefined }))
  })
  it('a corrupt layout falls back to the fixed label instead of failing the print', () => {
    const bad = { ...t, layout: { size: 'nope' } as unknown as LabelLayout }
    expect(labelZpl(sale, bad)).toBe(labelZpl(sale, { ...t, layout: undefined }))
  })
  it('the regex every layer prints is the template pattern (custom.enabled does not gate it)', () => {
    const l: LabelLayout = { version: 1, size: '2x1', elements: [newText({ src: 'regex' })] }
    expect(labelZpl(sale, { ...t, layout: l })).toContain('^FDBin A^FS')
  })
  it('stays fast: about as quick as the fixed label (both well under the ~50 ms spool)', () => {
    const { layout: _, ...rest } = t
    const fixed: LabelTemplate = { ...rest, qr: true } // both draw the pack QR
    const time = (tp: LabelTemplate) => { const t0 = performance.now(); for (let i = 0; i < 200; i++) labelZpl({ ...sale, itemNumber: String(i) }, tp); return (performance.now() - t0) / 200 }
    time(t); time(fixed) // warm
    const perLayout = time(t), perFixed = time(fixed)
    expect(perLayout).toBeLessThan(5)
    expect(perLayout).toBeLessThan(perFixed * 3 + 0.5)
  })
})
