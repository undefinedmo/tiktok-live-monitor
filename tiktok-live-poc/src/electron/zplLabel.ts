// ZPL generator — the fast label path for ZPL-capable thermal printers (e.g. Arkscan
// 2054A). Mirrors label.ts's field logic (item number, custom regex, buyer, product,
// price) and per-field sizing, but emits ZPL the printer's firmware renders itself —
// no Chromium HTML render, no driver rasterization. See rawPrint.ts for the transport.
//
// Tradeoff vs the HTML path: ZPL's built-in font 0 renders Latin text only. Emoji /
// non-Latin glyphs (common in buyer display names) can't be drawn, so callers use
// labelNeedsHtml() to fall back to the HTML path for those labels (hybrid).

import { LABEL_SIZES, DEFAULT_TEMPLATE, parseItemNumber, extractCustom, type LabelData, type LabelTemplate, type LabelScale } from './label'

const DPI = 203 // Arkscan 2054A (and most direct-thermal label printers) are 203 dpi
const PT_TO_DOTS = DPI / 72 // pt → dots at 203 dpi (matches the HTML path's pt sizes)

/** True if any character can't be rendered by ZPL's built-in font (emoji, CJK, symbols,
 *  anything above Latin-1). Callers fall back to the HTML print path when this is true. */
export function hasNonZplText(s: string | undefined): boolean {
  if (!s) return false
  for (const ch of s) if (ch.codePointAt(0)! > 0xff) return true
  return false
}

/** Whether this label must use the HTML path (a printable field has non-ZPL glyphs). */
export function labelNeedsHtml(data: LabelData, template: LabelTemplate = DEFAULT_TEMPLATE): boolean {
  if (template.buyer && hasNonZplText(data.buyer)) return true
  if (template.productName && hasNonZplText(data.productName)) return true
  if (template.custom.enabled && hasNonZplText(extractCustom(data.title ?? data.productName, template.custom.regex, template.custom.flags))) return true
  if (template.price && hasNonZplText(data.price)) return true
  // item number is digits — never non-ZPL
  return false
}

// Escape ZPL field-data control chars so they're printed literally, not parsed.
const esc = (s: string) => s.replace(/([\^~\\])/g, '\\$1')

// Approx glyph aspect for ZPL scalable font 0: character advance ≈ 0.6 × height. Used to
// center each line by an explicit ^FO x-offset rather than ^FB justification — ZPL
// *emulators* (e.g. the Arkscan/4BARCODE) frequently ignore ^FB's centering flag, which
// would leave every line left-aligned. Explicit x works everywhere.
const CHAR_ASPECT = 0.6
// Fraction of the label width text may occupy. Square stock (equal w/h) is treated as a
// die-cut ROUND label, so keep a tighter margin off the curved edge; rectangular gets more.
const safeFrac = (w: number, h: number) => (Math.abs(w - h) < 1 ? 0.82 : 0.94)

/** Build the ZPL for one label. Field order + sizing mirror labelHtml() in label.ts. */
export function labelZpl(data: LabelData, template: LabelTemplate = DEFAULT_TEMPLATE): string {
  const size = LABEL_SIZES[template.labelSize] ?? LABEL_SIZES['2x1']
  const W = Math.round(size.widthIn * DPI)
  const H = Math.round(size.heightIn * DPI)
  const safeW = Math.round(W * safeFrac(size.widthIn, size.heightIn))
  const sc: LabelScale = template.scale ?? {}
  // each field's dot height = its default pt × the field's multiplier (1× when unset)
  const dots = (k: keyof LabelScale, basePt: number) => Math.max(10, Math.round(basePt * (sc[k] ?? 1) * PT_TO_DOTS))

  const raw: { text: string; h: number }[] = []
  if (template.itemNumber) { const n = parseItemNumber(data.itemNumber); if (n) raw.push({ text: `#${n}`, h: dots('itemNumber', size.num) }) }
  if (template.custom.enabled) { const v = extractCustom(data.title ?? data.productName, template.custom.regex, template.custom.flags); if (v) raw.push({ text: v, h: dots('custom', 13) }) }
  if (template.buyer && data.buyer) raw.push({ text: data.buyer, h: dots('buyer', 9) })
  if (template.productName && data.productName) raw.push({ text: data.productName, h: dots('productName', 6.5) })
  if (template.price && data.price) raw.push({ text: data.price, h: dots('price', 9) })

  // Finalize each line: shrink any line whose estimated width exceeds the safe zone so it
  // never clips the (round) edge, then compute width + a centered x for it.
  const lines = raw.map((l) => {
    let h = l.h
    let cw = Math.max(1, Math.round(h * CHAR_ASPECT))
    let w = l.text.length * cw
    if (w > safeW) { h = Math.max(10, Math.round((h * safeW) / w)); cw = Math.max(1, Math.round(h * CHAR_ASPECT)); w = l.text.length * cw }
    return { text: l.text, h, cw, x: Math.max(0, Math.round((W - w) / 2)) }
  })

  const gap = Math.round(2 * PT_TO_DOTS)
  const lineH = (h: number) => Math.round(h * 1.15)
  const blockH = lines.reduce((a, l) => a + lineH(l.h), 0) + gap * Math.max(0, lines.length - 1)
  let y = Math.max(0, Math.round((H - blockH) / 2)) // vertically center the stack

  let zpl = `^XA\n^CI28\n^PW${W}\n^LL${H}\n^MNN\n`
  for (const l of lines) {
    zpl += `^FO${l.x},${y}^A0N,${l.h},${l.cw}^FD${esc(l.text)}^FS\n`
    y += lineH(l.h) + gap
  }
  return zpl + '^XZ\n'
}
