// LANE F — the free-layout label model behind the label designer, and its two renderers:
// HTML (driver path + the on-screen preview) and ZPL (raw fast path). Pure: no DOM, no Electron,
// so the renderer preview and main's print path share one implementation. Unit-test in
// src/core/__tests__/labelLayout.test.ts.
//
// SCAFFOLD STUB: the renderers throw — nothing calls them yet. The existing fixed-template
// printing (electron/label.ts labelHtml, electron/zplLabel.ts labelZpl) is untouched until lane F
// routes a template that carries a `layout` through these.

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

/** Where an element's text comes from. 'regex' = the "Text from the title" pattern. */
export type TextSource = 'lot' | 'buyer' | 'item' | 'price' | 'regex' | 'fixed'
/** QR modes: pack-station scan code (SF1:T:<sku_id>), a web link, or fixed text. */
export type QrMode = 'pack' | 'link' | 'fixed'

interface ElementBase {
  id: string
  name: string
  /** Top-left, inches from the label's top-left. Snapped to 0.05 in by the designer. */
  x: number
  y: number
}
export interface TextElement extends ElementBase {
  type: 'text'
  src: TextSource
  text?: string // for src 'fixed'
  pt: number
  font: string // ignored on the ZPL path (printer font)
  bold: boolean
  italic: boolean // HTML only
  underline: boolean // HTML only
  inverse: boolean // white on black
}
export interface QrElement extends ElementBase {
  type: 'qr'
  mode: QrMode
  value?: string // for 'link' / 'fixed'
  sizeIn: number
}
export interface LogoElement extends ElementBase {
  type: 'logo'
  /** data: URL of the image (kept in the template, per computer). */
  dataUrl?: string
  widthIn: number
  heightIn: number
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

/** The layout the designer opens with when nothing is saved: matches today's default 2×1 label. */
export function defaultLayout(): LabelLayout {
  throw new Error('labelLayout.defaultLayout: not implemented (lane F)')
}

/** Resolve one text element's string for `data` (regex source uses `regex`/`flags` on the title). */
export function elementText(el: TextElement, data: LayoutData, regex: { regex: string; flags: string }): string {
  void el; void data; void regex
  throw new Error('labelLayout.elementText: not implemented (lane F)')
}

/** A complete HTML document for the label (driver print path and the preview iframe). */
export function layoutHtml(layout: LabelLayout, data: LayoutData, regex: { regex: string; flags: string }): string {
  void layout; void data; void regex
  throw new Error('labelLayout.layoutHtml: not implemented (lane F)')
}

/** ZPL for the raw fast path at `dpi` (203 default). Logos go through ^GF. */
export function layoutZpl(layout: LabelLayout, data: LayoutData, regex: { regex: string; flags: string }, dpi = 203): string {
  void layout; void data; void regex; void dpi
  throw new Error('labelLayout.layoutZpl: not implemented (lane F)')
}

/** True when this label cannot be drawn by the printer font (emoji / non-Latin-1 text) and must
 *  take the HTML path — the layout equivalent of zplLabel.labelNeedsHtml. */
export function layoutNeedsHtml(layout: LabelLayout, data: LayoutData, regex: { regex: string; flags: string }): boolean {
  void layout; void data; void regex
  throw new Error('labelLayout.layoutNeedsHtml: not implemented (lane F)')
}
