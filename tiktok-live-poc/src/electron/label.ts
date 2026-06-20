// Label HTML generator (printed via webContents.print, like the desktop app).
// 2x1 inch thermal label: big item number + buyer + product + price.

export interface LabelData {
  itemNumber: string
  buyer?: string
  productName?: string
  price?: string
}

export const LABEL = { widthIn: 2, heightIn: 1, widthMicrons: 50800, heightMicrons: 25400 }

/** Item number from a TikTok sku_desc ("#34") or a title ("#34 Bin B…"); strips
 *  the leading '#'. Falls back to a trailing run of digits in the text. */
export function parseItemNumber(skuDescOrTitle: string | undefined): string {
  const s = (skuDescOrTitle ?? '').trim()
  const hash = s.match(/#\s*(\d+)/)
  if (hash) return hash[1]!
  const lead = s.match(/^(\d+)/)
  if (lead) return lead[1]!
  return s.replace(/^#/, '')
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

export function labelHtml(d: LabelData): string {
  const num = parseItemNumber(d.itemNumber)
  const rows = [
    `<div class="num">#${esc(num)}</div>`,
    d.buyer ? `<div class="buyer">${esc(d.buyer)}</div>` : '',
    d.productName ? `<div class="prod">${esc(d.productName)}</div>` : '',
    d.price ? `<div class="price">${esc(d.price)}</div>` : '',
  ].join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: ${LABEL.widthIn}in ${LABEL.heightIn}in; margin: 0; }
  html,body { margin:0; padding:0; width:${LABEL.widthIn}in; height:${LABEL.heightIn}in; }
  body { font-family: Arial, sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; overflow:hidden; }
  .num { font-size:34pt; font-weight:800; line-height:1; }
  .buyer { font-size:9pt; font-weight:600; margin-top:2pt; max-width:96%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .prod { font-size:6.5pt; color:#333; max-width:96%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .price { font-size:9pt; font-weight:700; margin-top:1pt; }
  </style></head><body>${rows}</body></html>`
}
