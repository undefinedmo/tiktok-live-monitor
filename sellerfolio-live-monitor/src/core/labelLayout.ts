// LANE F — the free-layout label model behind the label designer, and its two renderers:
// HTML (driver path + the on-screen preview) and ZPL (raw fast path). Pure: no DOM, no Electron,
// so the renderer preview and main's print path share one implementation.
// Tested in src/core/__tests__/labelLayout.test.ts.
//
// One model, two renderers. Every geometric decision (where a line starts, how far it shrinks,
// where the black box of a white-on-black line sits, how big a QR module is) is made ONCE, in
// dots, by placeText / placeQr below, and both renderers draw from that. That is what keeps the
// fast ZPL tag and the driver tag looking like the same tag.
//
// The regex used by 'regex' text elements is NOT part of the layout: it is the template's
// custom.regex / custom.flags, which the existing "Text from the title" tools (presets, AI
// suggest, sample title) already edit. Every regex layer prints that one pattern's match.

import { qrModules, QR_ECC, QR_QUIET } from './labelCode'

// ── sizes, units ──────────────────────────────────────────────────────────────

/** Sizes in inches. '4x6' is new (owner decision 3). */
export type LayoutSize = '1x1' | '1.5x1.5' | '2x1' | '2x2' | '2.25x1.25' | '4x6'

export const LAYOUT_SIZES: Record<LayoutSize, { widthIn: number; heightIn: number }> = {
  '1x1': { widthIn: 1, heightIn: 1 },
  '1.5x1.5': { widthIn: 1.5, heightIn: 1.5 },
  '2x1': { widthIn: 2, heightIn: 1 },
  '2x2': { widthIn: 2, heightIn: 2 },
  '2.25x1.25': { widthIn: 2.25, heightIn: 1.25 },
  '4x6': { widthIn: 4, heightIn: 6 },
}
export const isLayoutSize = (s: unknown): s is LayoutSize => typeof s === 'string' && s in LAYOUT_SIZES

/** Arkscan 2054A and most direct-thermal label printers. */
export const DPI = 203
/** The designer's drag grid. */
export const SNAP_IN = 0.05
export const PT_MIN = 6
export const PT_MAX = 72
/** Smallest ZPL glyph height the shrink-to-fit will go to (matches zplLabel.ts). */
const MIN_DOTS = 10

/** Snap inches to the 0.05 in grid (two decimals, no float dust). */
export const snapIn = (v: number): number => Math.round(Math.round(v / SNAP_IN) * SNAP_IN * 100) / 100
const round2 = (v: number): number => Math.round(v * 100) / 100
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

// ── the model ─────────────────────────────────────────────────────────────────

/** Where a text element's words come from. 'regex' = the "Text from the title" pattern. */
export type TextSource = 'lot' | 'buyer' | 'item' | 'price' | 'regex' | 'fixed'
export const TEXT_SOURCES: readonly TextSource[] = ['regex', 'lot', 'item', 'buyer', 'price', 'fixed']
/** QR modes: pack-station scan code (SF1:T:<sku_id>, the default), a web link, or fixed text. */
export type QrMode = 'pack' | 'link' | 'fixed'
export type TextAlign = 'left' | 'center' | 'right'

/** Fonts offered for the driver path. Under raw ZPL the printer draws its own font. */
export const FONTS = ['Arial', 'Verdana', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Courier New', 'Impact'] as const
/** The on-screen stand-in for ZPL font 0 (CG Triumvirate Bold Condensed). */
// Single quotes: it goes inside a style="…" attribute.
export const ZPL_PREVIEW_FONT = "'Arial Narrow','Roboto Condensed',Arial,sans-serif"

interface ElementBase {
  id: string
  name: string
  /** Box, inches from the label's top-left. The designer snaps these to 0.05 in. */
  x: number
  y: number
  w: number
  /** Text: derived from pt (one line). QR: equals w. Logo: the image box. */
  h: number
}
export interface TextElement extends ElementBase {
  type: 'text'
  src: TextSource
  text?: string // for src 'fixed'
  pt: number // 6–72
  font: string // driver path only; raw ZPL uses the printer font
  bold: boolean // forced on under raw ZPL (font 0 is bold)
  italic: boolean // driver path only
  underline: boolean // driver path only
  inverse: boolean // white on black (ZPL: ^GB + ^FR)
  align: TextAlign // within the box width w
}
export interface QrElement extends ElementBase {
  type: 'qr'
  mode: QrMode
  value?: string // for 'link' / 'fixed'
}
/** A 1-bit image ready for ZPL ^GF: `hex` is h rows of ceil(w/8) bytes, MSB first, 1 = black. */
export interface MonoBitmap {
  dpi: number
  w: number
  h: number
  hex: string
}
export interface LogoElement extends ElementBase {
  type: 'logo'
  /** data: URL of the image (the driver path and the preview draw this). */
  dataUrl?: string
  /** The same image at the box size, 1-bit at `dpi`, made by the designer (ZPL path). */
  mono?: MonoBitmap
}
export type LayoutElement = TextElement | QrElement | LogoElement

export interface LabelLayout {
  version: 1
  size: LayoutSize
  elements: LayoutElement[]
}

/** The values a label is filled from — the same fields as electron/label.ts LabelData. */
export interface LayoutData {
  itemNumber: string
  buyer?: string
  productName?: string
  price?: string
  title?: string
  /** Pack-station code (core/labelCode). Absent on manual tags → a 'pack' QR is omitted. */
  code?: string
}

export interface RegexSpec { regex: string; flags?: string }

// ── field helpers (moved here from electron/label.ts, which re-exports them) ─────

/** Item number from a sku_desc ("#34") / title; strips the leading '#'. */
export function parseItemNumber(skuDescOrTitle: string | undefined): string {
  const s = (skuDescOrTitle ?? '').trim()
  const hash = s.match(/#\s*(\d+)/)
  if (hash) return hash[1]!
  const lead = s.match(/^(\d+)/)
  if (lead) return lead[1]!
  return s.replace(/^#/, '')
}

/** Apply a user regex to the title; returns capture group 1 (or the whole
 *  match), or '' if no match / invalid regex. */
export function extractCustom(title: string | undefined, regex: string, flags = ''): string {
  if (!title || !regex) return ''
  try {
    const m = title.match(new RegExp(regex, flags))
    return m ? (m[1] ?? m[0]) : ''
  } catch {
    return ''
  }
}

// ── what ZPL font 0 can draw (moved here from electron/zplLabel.ts, which re-exports) ─

/** True if any character can't be rendered by ZPL's built-in font (emoji, CJK, symbols,
 *  anything above Latin-1). */
export function hasNonZplText(s: string | undefined): boolean {
  if (!s) return false
  for (const ch of s) if (ch.codePointAt(0)! > 0xff) return true
  return false
}

/**
 * Drop the characters ZPL font 0 cannot draw, keeping the rest.
 *
 * Emoji are extremely common in TikTok display names — "Mercy💕", "Anabelle🌷",
 * "Lisa Marie ⭐️" were 4 of 12 consecutive winners in one show. Treating a single emoji as
 * grounds to abandon ZPL sent a THIRD of all labels down the HTML path: 5x slower (~1030ms
 * vs ~200ms) and rendered by a completely different engine, so a third of the labels in a
 * run did not match the other two thirds. Stripping the glyph keeps the name legible, the
 * label consistent, and the fast path intact — "Mercy💕" prints as "Mercy".
 */
export function toZplText(s: string | undefined): string {
  if (!s) return ''
  let out = ''
  for (const ch of s) if (ch.codePointAt(0)! <= 0xff) out += ch
  return out.replace(/\s+/g, ' ').trim()
}

/** A value that is non-empty but strips to nothing — the whole value was unrenderable. */
export const strippedAway = (s: string | undefined): boolean => !!s && s.trim().length > 0 && toZplText(s).length === 0

// ZPL font 0 is proportional; `^A0N,h,h` draws it at its natural aspect. Glyph advance as a
// fraction of the height — see zplLabel.ts for the measurement notes. Used to centre / shrink
// a line, because ZPL emulators often ignore ^FB justification.
const NARROW = new Set([...".,:;'`!|iIlj()[]{}/\\-"])
const WIDE = new Set([...'mwMW@%'])
const advance = (ch: string): number => (ch === ' ' ? 0.26 : NARROW.has(ch) ? 0.28 : WIDE.has(ch) ? 0.78 : 0.52)
/** Estimated width in dots of `s` drawn in ZPL font 0 at height `h` dots. */
export const zplTextWidth = (s: string, h: number): number => Math.max(1, Math.round([...s].reduce((a, c) => a + advance(c), 0) * h))

// ── element text ──────────────────────────────────────────────────────────────

/** Resolve one text element's string for `data` (regex source uses the template's pattern on the
 *  title, falling back to the product name exactly like the fixed template). Not stripped. */
export function elementText(el: TextElement, data: LayoutData, regex: RegexSpec): string {
  switch (el.src) {
    case 'lot': { const n = parseItemNumber(data.itemNumber); return n ? `#${n}` : '' }
    case 'buyer': return data.buyer ?? ''
    case 'item': return data.productName ?? ''
    case 'price': return data.price ?? ''
    case 'fixed': return el.text ?? ''
    case 'regex': return extractCustom(data.title ?? data.productName, regex.regex, regex.flags ?? '')
  }
}

/** One line's height in inches for a point size (line-height 1, as both renderers draw it). */
export const lineHeightIn = (pt: number): number => round2(pt / 72)

// ── capability checks (what raw ZPL can and cannot do) ───────────────────────────

export interface ZplCapability {
  /** False only when the element prints nothing under raw ZPL. */
  drawable: boolean
  /** The element makes the tag print slower (an image sent as ^GF). */
  slower: boolean
  /** One plain-language line per thing that changes under raw ZPL. */
  notes: string[]
}

/** What happens to this element under raw ZPL: printer font only, bold forced, italic and
 *  underline dropped, white-on-black allowed but not every printer honours it, logos as an
 *  image (slower). */
export function zplCanDraw(el: LayoutElement): ZplCapability {
  if (el.type === 'qr') return { drawable: true, slower: false, notes: [] }
  if (el.type === 'logo') {
    if (!el.dataUrl) return { drawable: false, slower: false, notes: ['Choose an image for this logo.'] }
    if (!el.mono) return { drawable: false, slower: false, notes: ['This logo has no printer image yet. Choose the image again.'] }
    return { drawable: true, slower: true, notes: ['Logos print as an image, so this tag will print slower.'] }
  }
  const notes: string[] = []
  if (el.font && el.font !== 'Arial') notes.push('The printer draws its own font.')
  if (!el.bold) notes.push('The printer font is always bold.')
  if (el.italic) notes.push('Italic is off in fast printing.')
  if (el.underline) notes.push('Underline is off in fast printing.')
  if (el.inverse) notes.push('Print a test tag first. Some ZPL printers ignore this.')
  if (el.src === 'fixed' && hasNonZplText(el.text)) notes.push('Emoji and symbols won’t print in fast printing.')
  const drawable = !(el.src === 'fixed' && strippedAway(el.text))
  return { drawable, slower: false, notes }
}

// ── geometry shared by both renderers ────────────────────────────────────────────

/** A placed line of text, all in dots at `dpi`. (bx,by,bw,bh) is the black box when inverse;
 *  (tx,ty) is where the glyphs start; h is the glyph height after shrink-to-fit. */
export interface PlacedText { text: string; h: number; tw: number; tx: number; ty: number; bx: number; by: number; bw: number; bh: number; padX: number; padY: number }

/** White-on-black padding, as a share of the glyph height (the prototype's .08em / .22em). */
const INV_PAD_X = 0.22
const INV_PAD_Y = 0.08

/** Place one line of (already ZPL-safe) text in its box: shrink it to the box width, then align. */
export function placeText(el: TextElement, text: string, dpi = DPI): PlacedText {
  const boxX = Math.round(el.x * dpi), boxY = Math.round(el.y * dpi), boxW = Math.max(1, Math.round(el.w * dpi))
  const pads = (h: number) => (el.inverse ? { padX: Math.round(h * INV_PAD_X), padY: Math.round(h * INV_PAD_Y) } : { padX: 0, padY: 0 })
  let h = Math.max(MIN_DOTS, Math.round(clamp(el.pt, PT_MIN, PT_MAX) * dpi / 72))
  let tw = zplTextWidth(text, h)
  let { padX, padY } = pads(h)
  if (tw + 2 * padX > boxW) {
    h = Math.max(MIN_DOTS, Math.round((h * boxW) / (tw + 2 * padX)))
    tw = zplTextWidth(text, h)
    ;({ padX, padY } = pads(h))
  }
  const bw = tw + 2 * padX, bh = h + 2 * padY
  const off = el.align === 'center' ? Math.max(0, Math.round((boxW - bw) / 2)) : el.align === 'right' ? Math.max(0, boxW - bw) : 0
  const bx = boxX + off
  return { text, h, tw, tx: bx + padX, ty: boxY + padY, bx, by: boxY, bw, bh, padX, padY }
}

/** What a QR element encodes for this sale; '' = print no QR (a manual tag has no pack code,
 *  an empty link prints nothing rather than a QR of nothing). */
export function qrPayload(el: QrElement, data: LayoutData): string {
  if (el.mode === 'pack') return data.code ?? ''
  return (el.value ?? '').trim()
}

/** A QR symbol's fit in its box: whole-dot modules (^BQ's magnification), quiet zone included. */
export interface QrFit { modules: number; mag: number; box: number }
export function qrFit(payload: string, sizeIn: number, dpi = DPI): QrFit {
  const modules = qrModules(payload).length
  const mag = Math.max(1, Math.min(10, Math.floor((sizeIn * dpi) / (modules + QR_QUIET * 2))))
  return { modules, mag, box: (modules + QR_QUIET * 2) * mag }
}

export type QrAdvice = { level: 'ok' | 'long' | 'too-long' | 'empty'; dots: number }
/** How scannable the QR will be. The prototype's limits are for the 0.46 in QR at 203 dpi: past
 *  42 characters the squares shrink to about 2 dots, past 84 to 1. A bigger QR carries
 *  proportionally more (the limits scale with its area). `dots` is the module size it prints at. */
export function qrAdvice(value: string, sizeIn: number, dpi = DPI): QrAdvice {
  if (!value) return { level: 'empty', dots: 0 }
  const { mag } = qrFit(value, sizeIn, dpi)
  const k = (sizeIn / 0.46) ** 2
  return { level: value.length > 84 * k ? 'too-long' : value.length > 42 * k ? 'long' : 'ok', dots: mag }
}

// ── normalising (anything loaded from storage or sent over IPC goes through here) ─

let idSeq = 0
/** A fresh element id. */
export const newId = (): string => `e${Date.now().toString(36)}${(idSeq++).toString(36)}`

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)

/** Validate + clamp a layout. Never throws; null when it is not a layout at all. Elements are
 *  kept on the label (a size change pulls them back in), pt is held to 6–72, text height follows
 *  pt, a QR stays square. */
export function normalizeLayout(raw: unknown): LabelLayout | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { size?: unknown; elements?: unknown }
  if (!isLayoutSize(r.size) || !Array.isArray(r.elements)) return null
  const L = LAYOUT_SIZES[r.size]
  const elements: LayoutElement[] = []
  for (const e of r.elements as unknown[]) {
    if (!e || typeof e !== 'object') continue
    const o = e as Record<string, unknown>
    const base = { id: str(o.id) || newId(), name: str(o.name, 'Element') }
    const box = (w: number, h: number) => {
      const bw = round2(clamp(w, 0.1, L.widthIn)), bh = round2(clamp(h, 0.05, L.heightIn))
      return { x: round2(clamp(num(o.x, 0), 0, Math.max(0, L.widthIn - Math.min(bw, 0.2)))), y: round2(clamp(num(o.y, 0), 0, Math.max(0, L.heightIn - Math.min(bh, 0.15)))), w: bw, h: bh }
    }
    if (o.type === 'text') {
      const src = (TEXT_SOURCES as readonly string[]).includes(o.src as string) ? (o.src as TextSource) : 'fixed'
      const pt = round2(clamp(num(o.pt, 12), PT_MIN, PT_MAX))
      const align: TextAlign = o.align === 'center' || o.align === 'right' ? o.align : 'left'
      const t: TextElement = { ...base, type: 'text', ...box(num(o.w, L.widthIn - num(o.x, 0)), lineHeightIn(pt)), src, pt, font: str(o.font, 'Arial') || 'Arial', bold: o.bold !== false, italic: o.italic === true, underline: o.underline === true, inverse: o.inverse === true, align }
      if (src === 'fixed') t.text = str(o.text)
      t.w = round2(clamp(t.w, 0.1, L.widthIn - t.x))
      elements.push(t)
    } else if (o.type === 'qr') {
      const mode: QrMode = o.mode === 'link' || o.mode === 'fixed' ? o.mode : 'pack'
      const side = clamp(num(o.w, 0.46), 0.2, Math.min(L.widthIn, L.heightIn))
      const q: QrElement = { ...base, type: 'qr', ...box(side, side), mode }
      q.h = q.w
      if (mode !== 'pack') q.value = str(o.value)
      elements.push(q)
    } else if (o.type === 'logo') {
      const g: LogoElement = { ...base, type: 'logo', ...box(num(o.w, 0.5), num(o.h, 0.5)) }
      if (typeof o.dataUrl === 'string' && o.dataUrl.startsWith('data:image/')) g.dataUrl = o.dataUrl
      const m = o.mono as Record<string, unknown> | undefined
      if (m && typeof m.hex === 'string' && num(m.w, 0) > 0 && num(m.h, 0) > 0 && m.hex.length === Math.ceil(num(m.w, 0) / 8) * 2 * num(m.h, 0)) {
        g.mono = { dpi: num(m.dpi, DPI), w: num(m.w, 0), h: num(m.h, 0), hex: m.hex }
      }
      elements.push(g)
    }
  }
  return { version: 1, size: r.size, elements }
}

// ── element factories (the designer's Add buttons) ─────────────────────────────

export function newText(over: Partial<TextElement> = {}): TextElement {
  const pt = over.pt ?? 12
  return { id: newId(), name: 'Text', type: 'text', x: 0.1, y: 0.1, w: 1, h: lineHeightIn(pt), src: 'fixed', text: 'New text', pt, font: 'Arial', bold: true, italic: false, underline: false, inverse: false, align: 'left', ...over }
}
export function newQr(over: Partial<QrElement> = {}): QrElement {
  return { id: newId(), name: 'QR code', type: 'qr', x: 0.1, y: 0.1, w: 0.46, h: 0.46, mode: 'pack', ...over }
}
export function newLogo(over: Partial<LogoElement> = {}): LogoElement {
  return { id: newId(), name: 'Logo', type: 'logo', x: 0.1, y: 0.1, w: 0.5, h: 0.5, ...over }
}

// ── migration from the fixed template ─────────────────────────────────────────

/** The fixed template electron/label.ts prints today (structural, so core needs no electron import). */
export interface LegacyTemplate {
  labelSize: string
  itemNumber: boolean
  buyer: boolean
  productName: boolean
  price: boolean
  custom: { enabled: boolean; regex: string; flags?: string }
  scale?: Partial<Record<'itemNumber' | 'custom' | 'buyer' | 'productName' | 'price', number>>
  qr?: boolean
}

// The fixed template's 1× point sizes — kept equal to electron/label.ts (LABEL_SIZES[].num and
// FIELD_PT); labelLayout.test.ts asserts they agree.
const LEGACY_NUM_PT: Record<string, number> = { '1x1': 22, '1.5x1.5': 32, '2x1': 32, '2x2': 40, '2.25x1.25': 36, '4x6': 72 }
const LEGACY_FIELD_PT = { custom: 13, buyer: 9, productName: 6.5, price: 9 } as const

/**
 * The free layout that prints like `old` does. The fixed template is a centred stack whose
 * lines collapse when empty; a free layout has fixed positions, so this lays the stack out once
 * — the way zplLabel.labelZpl stacks it with every enabled line present — and gives each line a
 * centred box the width of the text column. Same lines, sizes, order, QR placement (beside on
 * rectangular stock, under on square) and product line dropped on small square stock with a QR.
 */
export function migrateFromTemplate(old: Partial<LegacyTemplate> | null | undefined): LabelLayout {
  const t: LegacyTemplate = { labelSize: '2x1', itemNumber: true, buyer: true, productName: true, price: false, custom: { enabled: false, regex: '', flags: '' }, qr: false, ...(old ?? {}) }
  const size: LayoutSize = isLayoutSize(t.labelSize) ? t.labelSize : '2x1'
  const L = LAYOUT_SIZES[size]
  const sc = t.scale ?? {}
  const pt = (k: 'itemNumber' | 'custom' | 'buyer' | 'productName' | 'price') =>
    round2(clamp((k === 'itemNumber' ? LEGACY_NUM_PT[size]! : LEGACY_FIELD_PT[k]) * (sc[k] ?? 1), PT_MIN, PT_MAX))
  const W = L.widthIn * DPI, H = L.heightIn * DPI

  const beside = !!t.qr && L.widthIn - L.heightIn >= 0.25
  const qIn = !t.qr ? 0 : beside ? L.heightIn * 0.9 : Math.min(L.widthIn, L.heightIn) * 0.44
  const hideProduct = !!t.qr && !beside && Math.min(L.widthIn, L.heightIn) < 1.25
  const qBox = qIn * DPI
  const qrX = beside ? (H - qBox) / 2 : 0
  const textLeft = beside ? qrX + qBox + 0.04 * DPI : 0
  const textW = W - textLeft
  // The fixed ZPL path keeps text inside a safe zone (round die-cut on square stock).
  const safe = beside ? 0.94 : Math.abs(L.widthIn - L.heightIn) < 1 ? 0.82 : 0.94
  const colX = textLeft + (textW * (1 - safe)) / 2, colW = textW * safe

  type Line = { name: string; src: TextSource; pt: number; bold: boolean }
  const lines: Line[] = []
  if (t.itemNumber) lines.push({ name: 'Lot number', src: 'lot', pt: pt('itemNumber'), bold: true })
  if (t.custom?.enabled) lines.push({ name: 'Text from the title', src: 'regex', pt: pt('custom'), bold: true })
  if (t.buyer) lines.push({ name: 'Buyer', src: 'buyer', pt: pt('buyer'), bold: true })
  if (t.productName && !hideProduct) lines.push({ name: 'Item name', src: 'item', pt: pt('productName'), bold: false })
  if (t.price) lines.push({ name: 'Price', src: 'price', pt: pt('price'), bold: true })

  // Stack exactly as labelZpl does: leading between lines only, then centre the block.
  const gap = Math.round(2 * DPI / 72)
  const underQr = !!t.qr && !beside
  let stackH = 0
  const ys = lines.map((l, i) => {
    const h = Math.round(l.pt * DPI / 72), y = stackH
    stackH += h + (i < lines.length - 1 || underQr ? Math.round(h * 0.15) + gap : 0)
    return y
  })
  const qrStackY = stackH
  if (underQr) stackH += qBox
  const top = Math.max(0, (H - stackH) / 2)

  const elements: LayoutElement[] = lines.map((l, i) => ({
    id: `m${i}`, name: l.name, type: 'text', src: l.src, x: round2(colX / DPI), y: round2((top + ys[i]!) / DPI), w: round2(colW / DPI), h: lineHeightIn(l.pt),
    pt: l.pt, font: 'Arial', bold: l.bold, italic: false, underline: false, inverse: false, align: 'center',
  }))
  if (t.qr) {
    const x = beside ? qrX : (W - qBox) / 2
    const y = beside ? (H - qBox) / 2 : top + qrStackY
    elements.push({ id: 'mqr', name: 'QR code', type: 'qr', mode: 'pack', x: round2(x / DPI), y: round2(y / DPI), w: round2(qIn), h: round2(qIn) })
  }
  // A stack taller than the label (big scales on small stock) overflowed the bottom edge on the
  // fixed label too; normalising pulls those lines back onto the label.
  return normalizeLayout({ version: 1, size, elements })!
}

/** The layout the designer opens with when nothing is saved: today's default 2×1 label. */
export function defaultLayout(): LabelLayout {
  return migrateFromTemplate({ labelSize: '2x1', itemNumber: true, buyer: true, productName: true, price: false, custom: { enabled: false, regex: '', flags: '' }, qr: false })
}

// ── 1-bit images for ^GF ─────────────────────────────────────────────────────────

/** RGBA pixels (canvas ImageData) → a 1-bit ^GF bitmap: dark, opaque pixels print. */
export function monoFromRgba(rgba: ArrayLike<number>, w: number, h: number, dpi = DPI, threshold = 140): MonoBitmap {
  const bpr = Math.ceil(w / 8)
  let hex = ''
  for (let y = 0; y < h; y++) {
    for (let b = 0; b < bpr; b++) {
      let byte = 0
      for (let bit = 0; bit < 8; bit++) {
        const x = b * 8 + bit
        if (x >= w) continue
        const i = (y * w + x) * 4
        const a = (rgba[i + 3] ?? 255) / 255
        // composite on white, then luminance
        const lum = (0.299 * (rgba[i] ?? 255) + 0.587 * (rgba[i + 1] ?? 255) + 0.114 * (rgba[i + 2] ?? 255)) * a + 255 * (1 - a)
        if (lum < threshold) byte |= 0x80 >> bit
      }
      hex += byte.toString(16).padStart(2, '0').toUpperCase()
    }
  }
  return { dpi, w, h, hex }
}

/** The pixel box a logo's bitmap is drawn into: the image contained in the element's box. */
export function logoDots(el: LogoElement, imgW: number, imgH: number, dpi = DPI): { w: number; h: number } {
  const bw = Math.max(1, Math.round(el.w * dpi)), bh = Math.max(1, Math.round(el.h * dpi))
  if (!(imgW > 0 && imgH > 0)) return { w: bw, h: bh }
  const s = Math.min(bw / imgW, bh / imgH)
  return { w: Math.max(1, Math.round(imgW * s)), h: Math.max(1, Math.round(imgH * s)) }
}

// ── the HTML renderer ─────────────────────────────────────────────────────────

const escHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
const inch = (dots: number, dpi: number) => `${(dots / dpi).toFixed(3)}in`
// A font name only ever needs letters, digits, spaces and hyphens; anything else could step out
// of the style attribute's declaration.
const fontStack = (f: string) => `'${f.replace(/[^\w \-]/g, '').trim() || 'Arial'}',Arial,sans-serif`

/** The code as a crisp SVG (one path, quiet zone included). */
export function qrSvg(code: string): string {
  const m = qrModules(code)
  const v = m.length + QR_QUIET * 2
  let d = ''
  m.forEach((row, r) => row.forEach((dark, c) => { if (dark) d += `M${c + QR_QUIET} ${r + QR_QUIET}h1v1h-1z` }))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${v} ${v}" shape-rendering="crispEdges"><rect width="${v}" height="${v}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
}

export interface HtmlOptions {
  /** Draw what raw ZPL prints: the printer font (a close condensed stand-in), bold, no italic or
   *  underline, characters it can't draw removed, and the same shrink-to-fit as the ZPL path. */
  printerFont?: boolean
  dpi?: number
}


/** The element rules every rendering of a layout uses — the print document and the designer's
 *  canvas (which prefixes them with its own container), so the canvas IS the print markup. */
export const ELEMENT_CSS: readonly (readonly [string, string])[] = [
  ['.e', 'position:absolute; box-sizing:border-box;'],
  ['.t', 'white-space:nowrap; line-height:1;'],
  ['.t > span', 'display:inline-block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:top; line-height:1; box-sizing:border-box;'],
  ['.q svg', 'display:block; width:100%; height:100%;'],
  ['.g', 'object-fit:contain;'],
]

/** The shrink-to-fit pass's floor and step (FIT_SCRIPT in the print document; the designer canvas
 *  runs the same loop). */
export const FIT_MIN_PT = 5
export const FIT_STEP_PT = 0.5

/** The positioned elements of a label (no document around them). Each carries data-id so the
 *  designer can move it while dragging. `fit` = a line needs the shrink-to-fit pass. */
export function layoutBody(layout: LabelLayout, data: LayoutData, regex: RegexSpec, opts: HtmlOptions = {}): { html: string; fit: boolean } {
  const dpi = opts.dpi ?? DPI
  const zpl = !!opts.printerFont
  const parts: string[] = []
  let fit = false
  const id = (el: LayoutElement) => ` data-id="${escHtml(el.id)}"`
  for (const el of layout.elements) {
    if (el.type === 'text') {
      const raw = elementText(el, data, regex)
      const text = zpl ? toZplText(raw) : raw
      if (!text) continue
      // Printer-font preview: the ZPL path's own shrink-to-fit size. Driver: the chosen size,
      // shrunk by the fit pass with the real font's metrics.
      const ptOut = zpl ? +((placeText(el, text, dpi).h * 72) / dpi).toFixed(2) : clamp(el.pt, PT_MIN, PT_MAX)
      const style = [
        `font-family:${zpl ? ZPL_PREVIEW_FONT : fontStack(el.font)}`,
        `font-size:${ptOut}pt`,
        `font-weight:${zpl || el.bold ? 700 : 400}`,
        !zpl && el.italic ? 'font-style:italic' : '',
        !zpl && el.underline ? 'text-decoration:underline' : '',
        el.inverse ? `padding:${INV_PAD_Y}em ${INV_PAD_X}em;background:#000;color:#fff` : '',
      ].filter(Boolean).join(';')
      if (!zpl) fit = true
      parts.push(`<div class="e t" style="left:${inch(Math.round(el.x * dpi), dpi)};top:${inch(Math.round(el.y * dpi), dpi)};width:${inch(Math.max(1, Math.round(el.w * dpi)), dpi)};text-align:${el.align}"${id(el)}><span style="${style}">${escHtml(text)}</span></div>`)
    } else if (el.type === 'qr') {
      const payload = qrPayload(el, data)
      if (!payload) continue
      // Same whole-dot size the ZPL path prints, so the two tags match to the dot.
      const f = qrFit(payload, el.w, dpi)
      const x = Math.round(el.x * dpi), y = Math.round(el.y * dpi)
      parts.push(`<div class="e q" style="left:${inch(x, dpi)};top:${inch(y, dpi)};width:${inch(f.box, dpi)};height:${inch(f.box, dpi)}"${id(el)}>${qrSvg(payload)}</div>`)
    } else if (el.type === 'logo') {
      if (!el.dataUrl) continue
      parts.push(`<img class="e g" alt="" src="${escHtml(el.dataUrl)}" style="left:${inch(Math.round(el.x * dpi), dpi)};top:${inch(Math.round(el.y * dpi), dpi)};width:${inch(Math.max(1, Math.round(el.w * dpi)), dpi)};height:${inch(Math.max(1, Math.round(el.h * dpi)), dpi)}"${id(el)}>`)
    }
  }
  return { html: parts.join(''), fit }
}

// Driver path: shrink each line to its box with the REAL font metrics (the estimate is ZPL
// font 0's), then let an ellipsis take whatever still does not fit. Runs synchronously while the
// document parses, so it is done before main's print waits on document.fonts.ready.
const FIT_SCRIPT = `<script>document.querySelectorAll('.t>span').forEach(function(s){var p=parseFloat(s.style.fontSize);while(s.scrollWidth>s.clientWidth+0.5&&p>${FIT_MIN_PT}){p-=${FIT_STEP_PT};s.style.fontSize=p+'pt'}})</script>`

/** A complete HTML document for the label (the driver print path). */
export function layoutHtml(layout: LabelLayout, data: LayoutData, regex: RegexSpec, opts: HtmlOptions = {}): string {
  const L = LAYOUT_SIZES[layout.size] ?? LAYOUT_SIZES['2x1']
  const body = layoutBody(layout, data, regex, opts)
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: ${L.widthIn}in ${L.heightIn}in; margin: 0; }
  html,body { margin:0; padding:0; width:${L.widthIn}in; height:${L.heightIn}in; background:#fff; }
  body { position:relative; overflow:hidden; color:#000; }
${ELEMENT_CSS.map(([sel, decl]) => `  ${sel} { ${decl} }`).join('\n')}
  </style></head><body>${body.html}${body.fit ? FIT_SCRIPT : ''}</body></html>`
}

// ── the ZPL renderer ──────────────────────────────────────────────────────────

// Escape ZPL field-data control chars (same rule as zplLabel.ts, so both paths agree).
const escZpl = (s: string) => s.replace(/([\^~\\])/g, '\\$1')

/** ZPL for the raw fast path at `dpi` (203 default). Logos go through ^GF. */
export function layoutZpl(layout: LabelLayout, data: LayoutData, regex: RegexSpec, dpi = DPI): string {
  const L = LAYOUT_SIZES[layout.size] ?? LAYOUT_SIZES['2x1']
  const W = Math.round(L.widthIn * dpi), H = Math.round(L.heightIn * dpi)
  // Same header as labelZpl: UTF-8, label home 0,0, die-cut gap sensing (^MNY).
  let z = `^XA\n^CI28\n^LH0,0\n^PW${W}\n^LL${H}\n^MNY\n`
  for (const el of layout.elements) {
    if (el.type === 'text') {
      const text = toZplText(elementText(el, data, regex))
      if (!text) continue
      const p = placeText(el, text, dpi)
      if (el.inverse) {
        z += `^FO${p.bx},${p.by}^GB${p.bw},${p.bh},${Math.min(p.bw, p.bh)}^FS\n`
        z += `^FO${p.tx},${p.ty}^A0N,${p.h},${p.h}^FR^FD${escZpl(text)}^FS\n`
      } else {
        z += `^FO${p.tx},${p.ty}^A0N,${p.h},${p.h}^FD${escZpl(text)}^FS\n`
      }
    } else if (el.type === 'qr') {
      const payload = qrPayload(el, data)
      if (!payload) continue
      const fit = qrFit(payload, el.w, dpi)
      // ^FO is the symbol's corner, so step in past the quiet zone (^BQ draws none). "MA," = ECC M
      // (QR_ECC, as the HTML symbol) + automatic mode.
      const q = QR_QUIET * fit.mag
      z += `^FO${Math.round(el.x * dpi) + q},${Math.round(el.y * dpi) + q}^BQN,2,${fit.mag}^FD${QR_ECC}A,${escZpl(payload)}^FS\n`
    } else if (el.type === 'logo') {
      const m = el.mono
      if (!m) continue
      const bpr = Math.ceil(m.w / 8), total = bpr * m.h
      const ox = Math.max(0, Math.round((el.w * dpi - m.w) / 2)), oy = Math.max(0, Math.round((el.h * dpi - m.h) / 2))
      z += `^FO${Math.round(el.x * dpi) + ox},${Math.round(el.y * dpi) + oy}^GFA,${total},${total},${bpr},${m.hex}^FS\n`
    }
  }
  return z + '^XZ\n'
}

/** True when this label cannot be drawn by the printer and must take the HTML path — the layout
 *  equivalent of zplLabel.labelNeedsHtml: a printed value that is nothing BUT emoji, or a logo
 *  that has an image but no printer bitmap. */
export function layoutNeedsHtml(layout: LabelLayout, data: LayoutData, regex: RegexSpec): boolean {
  for (const el of layout.elements) {
    if (el.type === 'text' && strippedAway(elementText(el, data, regex))) return true
    if (el.type === 'logo' && el.dataUrl && !el.mono) return true
  }
  return false
}

/** Whether a layout prints anything slower than plain text + QR under raw ZPL. */
export const layoutHasImage = (layout: LabelLayout): boolean => layout.elements.some((e) => e.type === 'logo' && !!e.mono)
