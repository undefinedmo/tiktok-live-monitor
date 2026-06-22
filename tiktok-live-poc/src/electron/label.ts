// Template-driven label HTML generator (printed via webContents.print).
// The user configures which fields print + an optional regex that extracts a
// short bit from the title (e.g. /(Bin [A-Z])/ on "#141 Bin A - Alo Yoga…" → "Bin A").

export interface LabelData {
  itemNumber: string
  buyer?: string
  productName?: string
  price?: string
  title?: string // full title for the regex (e.g. "#54 Bin A - Alo Yoga…")
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
  labelSize: '1x1' | '2x1' | '2.25x1.25'
  itemNumber: boolean
  buyer: boolean
  productName: boolean
  price: boolean
  custom: { enabled: boolean; regex: string; flags?: string }
  scale?: LabelScale // per-field text-size multipliers; absent/undefined ⇒ 1×
}

export const DEFAULT_TEMPLATE: LabelTemplate = {
  labelSize: '2x1',
  itemNumber: true,
  buyer: true,
  productName: true,
  price: false,
  custom: { enabled: false, regex: '', flags: '' },
  scale: { itemNumber: 1, custom: 1, buyer: 1, productName: 1, price: 1 },
}

export const LABEL_SIZES = {
  '1x1': { widthIn: 1, heightIn: 1, widthMicrons: 25400, heightMicrons: 25400, num: 22 },
  '2x1': { widthIn: 2, heightIn: 1, widthMicrons: 50800, heightMicrons: 25400, num: 32 },
  '2.25x1.25': { widthIn: 2.25, heightIn: 1.25, widthMicrons: 57150, heightMicrons: 31750, num: 36 },
} as const

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
  const pt = (k: keyof LabelScale, base: number) => +(base * (sc[k] ?? 1)).toFixed(1)
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
  if (template.productName && data.productName) rows.push(`<div class="prod">${esc(data.productName)}</div>`)
  if (template.price && data.price) rows.push(`<div class="price">${esc(data.price)}</div>`)

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: ${size.widthIn}in ${size.heightIn}in; margin: 0; }
  html,body { margin:0; padding:0; width:${size.widthIn}in; height:${size.heightIn}in; }
  body { font-family: Arial, sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; overflow:hidden; }
  .num { font-size:${pt('itemNumber', size.num)}pt; font-weight:800; line-height:1; }
  .custom { font-size:${pt('custom', 13)}pt; font-weight:700; margin-top:2pt; }
  .buyer { font-size:${pt('buyer', 9)}pt; font-weight:600; margin-top:2pt; max-width:96%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .prod { font-size:${pt('productName', 6.5)}pt; color:#333; max-width:96%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .price { font-size:${pt('price', 9)}pt; font-weight:700; margin-top:1pt; }
  </style></head><body>${rows.join('')}</body></html>`
}
