// Template-driven label HTML generator (printed via webContents.print).
// The user configures which fields print + an optional regex that extracts a
// short bit from the title (e.g. /(Bin [A-Z])/ on "#141 Bin A - Alo Yoga…" → "Bin A").

import { qrModules, QR_QUIET } from '../core/labelCode'

export interface LabelData {
  itemNumber: string
  buyer?: string
  productName?: string
  price?: string
  title?: string // full title for the regex (e.g. "#54 Bin A - Alo Yoga…")
  code?: string // QR payload from core/labelCode ("SF1:T:<sku_id>"); absent on manual prints
}

/** Per-field text-size multipliers (1 = the field's default size). */
export interface LabelScale {
  itemNumber?: number
  custom?: number
  buyer?: number
  productName?: number
  price?: number
}

export interface LabelTemplate {
  labelSize: '1x1' | '1.5x1.5' | '2x1' | '2x2' | '2.25x1.25'
  itemNumber: boolean
  buyer: boolean
  productName: boolean
  price: boolean
  custom: { enabled: boolean; regex: string; flags?: string }
  scale?: LabelScale // per-field text-size multipliers; absent/undefined ⇒ 1×
  qr?: boolean // print the pack-station QR (when the label has a code); absent ⇒ off
}

export const DEFAULT_TEMPLATE: LabelTemplate = {
  labelSize: '2x1',
  itemNumber: true,
  buyer: true,
  productName: true,
  price: false,
  // Off by default: saved templates are merged over this, so turning it on here would
  // silently rearrange every existing user's label (text shifts right to make room).
  qr: false,
  custom: { enabled: false, regex: '', flags: '' },
  scale: { itemNumber: 1, custom: 1, buyer: 1, productName: 1, price: 1 },
}

export const LABEL_SIZES = {
  '1x1': { widthIn: 1, heightIn: 1, widthMicrons: 25400, heightMicrons: 25400, num: 22 },
  '1.5x1.5': { widthIn: 1.5, heightIn: 1.5, widthMicrons: 38100, heightMicrons: 38100, num: 32 },
  '2x1': { widthIn: 2, heightIn: 1, widthMicrons: 50800, heightMicrons: 25400, num: 32 },
  '2x2': { widthIn: 2, heightIn: 2, widthMicrons: 50800, heightMicrons: 50800, num: 40 },
  '2.25x1.25': { widthIn: 2.25, heightIn: 1.25, widthMicrons: 57150, heightMicrons: 31750, num: 36 },
} as const

/** Each field's default ("1×") point size. The item number's default lives on the label
 *  size instead (LABEL_SIZES[...].num) because it scales with the stock. Shared by the
 *  HTML path, the ZPL path, and the settings UI's size readout — one source of truth. */
const FIELD_PT: Record<Exclude<keyof LabelScale, 'itemNumber'>, number> = { custom: 13, buyer: 9, productName: 6.5, price: 9 }

/** The 1× point size of `field` on `labelSize` (before the user's scale multiplier). */
export function basePt(field: keyof LabelScale, labelSize: LabelTemplate['labelSize']): number {
  return field === 'itemNumber' ? (LABEL_SIZES[labelSize] ?? LABEL_SIZES['2x1']).num : FIELD_PT[field]
}

type LabelSize = (typeof LABEL_SIZES)[LabelTemplate['labelSize']]

/** Where the QR goes, shared by the HTML and ZPL paths so both print the same layout:
 *  BESIDE the text (left) on rectangular stock, UNDER it on square stock — square is
 *  treated as a die-cut round label, where the corners of a side-placed QR fall off the
 *  curved edge. */
export const qrBeside = (size: LabelSize): boolean => size.widthIn - size.heightIn >= 0.25

/** The QR's edge in inches, quiet zone included. Beside: nearly the label height. Under:
 *  a share of the height small enough to leave the number and buyer legible above it. */
// 0.44 of the side on 1" stock is 89 dots — exactly room for 3-dot modules on a 29-module
// symbol (25 + quiet zone). At 0.42 the ZPL path fell to 2-dot (0.25 mm) modules, which
// thermal heads blur and scanners start to miss.
export const qrSizeIn = (size: LabelSize): number =>
  qrBeside(size) ? size.heightIn * 0.9 : Math.min(size.widthIn, size.heightIn) * 0.44

/**
 * Whether the QR displaces the product-name line. On square stock under ~1.25" the number,
 * buyer, product name AND a scannable QR cannot all fit (rendered: the stack overflowed a
 * 1" label and the QR shrank to 2-dot modules). The name is the line to give up — the QR
 * already identifies the item, and the number + buyer are what the packer reads by eye.
 */
export const qrHidesProduct = (data: LabelData, template: LabelTemplate): boolean => {
  const size = LABEL_SIZES[template.labelSize] ?? LABEL_SIZES['2x1']
  return wantsQr(data, template) && !qrBeside(size) && Math.min(size.widthIn, size.heightIn) < 1.25
}

/** Gap between a beside-QR and the text column, in inches. */
export const QR_GAP_IN = 0.04

/** Whether this label prints a QR: the template asks for one AND the sale has a code. */
export const wantsQr = (data: LabelData, template: LabelTemplate): boolean => !!template.qr && !!data.code

/** The code as a crisp SVG (one path, quiet zone included) for the HTML path. */
function qrSvg(code: string): string {
  const m = qrModules(code)
  const v = m.length + QR_QUIET * 2
  let d = ''
  m.forEach((row, r) => row.forEach((dark, c) => { if (dark) d += `M${c + QR_QUIET} ${r + QR_QUIET}h1v1h-1z` }))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${v} ${v}" shape-rendering="crispEdges"><rect width="${v}" height="${v}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
}

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

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

export function labelHtml(data: LabelData, template: LabelTemplate = DEFAULT_TEMPLATE): string {
  const size = LABEL_SIZES[template.labelSize] ?? LABEL_SIZES['2x1']
  const sc = template.scale ?? {}
  // each field's point size = its default × the field's multiplier (1× when unset)
  const pt = (k: keyof LabelScale) => +(basePt(k, template.labelSize) * (sc[k] ?? 1)).toFixed(1)
  const rows: string[] = []
  if (template.itemNumber) {
    const n = parseItemNumber(data.itemNumber)
    if (n) rows.push(`<div class="num">#${esc(n)}</div>`)
  }
  if (template.custom.enabled) {
    const v = extractCustom(data.title ?? data.productName, template.custom.regex, template.custom.flags)
    if (v) rows.push(`<div class="custom">${esc(v)}</div>`)
  }
  if (template.buyer && data.buyer) rows.push(`<div class="buyer">${esc(data.buyer)}</div>`)
  if (template.productName && data.productName && !qrHidesProduct(data, template)) rows.push(`<div class="prod">${esc(data.productName)}</div>`)
  if (template.price && data.price) rows.push(`<div class="price">${esc(data.price)}</div>`)

  // Without a QR the markup is unchanged: rows straight in the centered body column.
  let body = rows.join('')
  let qrCss = ''
  if (wantsQr(data, template)) {
    const q = qrSizeIn(size)
    const box = `<div class="qr">${qrSvg(data.code!)}</div>`
    if (qrBeside(size)) {
      body = `${box}<div class="txt">${body}</div>`
      qrCss = `body { flex-direction:row; justify-content:flex-start; padding-left:${((size.heightIn - q) / 2).toFixed(3)}in; box-sizing:border-box; }
  .txt { flex:1; min-width:0; height:100%; margin-left:${QR_GAP_IN}in; display:flex; flex-direction:column; align-items:center; justify-content:center; }`
    } else {
      body += box
    }
    qrCss += `\n  .qr { width:${q.toFixed(3)}in; height:${q.toFixed(3)}in; flex-shrink:0; }
  .qr svg { display:block; width:100%; height:100%; }`
  }

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: ${size.widthIn}in ${size.heightIn}in; margin: 0; }
  html,body { margin:0; padding:0; width:${size.widthIn}in; height:${size.heightIn}in; }
  body { font-family: Arial, sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; overflow:hidden; }
  .num { font-size:${pt('itemNumber')}pt; font-weight:800; line-height:1; }
  .custom { font-size:${pt('custom')}pt; font-weight:700; margin-top:2pt; }
  .buyer { font-size:${pt('buyer')}pt; font-weight:600; margin-top:2pt; max-width:96%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .prod { font-size:${pt('productName')}pt; color:#333; max-width:96%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .price { font-size:${pt('price')}pt; font-weight:700; margin-top:1pt; }${qrCss ? '\n  ' + qrCss : ''}
  </style></head><body>${body}</body></html>`
}
