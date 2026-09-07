// ZPL generator — the fast label path for ZPL-capable thermal printers (e.g. Arkscan
// 2054A). Mirrors label.ts's field logic (item number, custom regex, buyer, product,
// price) and per-field sizing, but emits ZPL the printer's firmware renders itself —
// no Chromium HTML render, no driver rasterization. See rawPrint.ts for the transport.
//
// Tradeoff vs the HTML path: ZPL's built-in font 0 renders Latin text only. Emoji /
// non-Latin glyphs (common in buyer display names) can't be drawn, so callers use
// labelNeedsHtml() to fall back to the HTML path for those labels (hybrid).

import { LABEL_SIZES, DEFAULT_TEMPLATE, basePt, parseItemNumber, extractCustom, type LabelData, type LabelTemplate, type LabelScale } from './label'

const DPI = 203 // Arkscan 2054A (and most direct-thermal label printers) are 203 dpi
const PT_TO_DOTS = DPI / 72 // pt → dots at 203 dpi (matches the HTML path's pt sizes)

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

/** A field that is non-empty but strips to nothing — the whole value was unrenderable. */
const strippedAway = (s: string | undefined): boolean => !!s && s.trim().length > 0 && toZplText(s).length === 0

/**
 * Whether this label must use the HTML path — now only when stripping would erase a
 * printable field entirely (a name that is nothing BUT emoji, e.g. "💯"). Anything with
 * some Latin content left keeps the ZPL path with the un-drawable characters removed.
 */
export function labelNeedsHtml(data: LabelData, template: LabelTemplate = DEFAULT_TEMPLATE): boolean {
  if (template.buyer && strippedAway(data.buyer)) return true
  if (template.productName && strippedAway(data.productName)) return true
  if (template.custom.enabled && strippedAway(extractCustom(data.title ?? data.productName, template.custom.regex, template.custom.flags))) return true
  if (template.price && strippedAway(data.price)) return true
  // item number is digits — never non-ZPL
  return false
}

// Escape ZPL field-data control chars so they're printed literally, not parsed.
const esc = (s: string) => s.replace(/([\^~\\])/g, '\\$1')

// ZPL's scalable font 0 (CG Triumvirate Bold Condensed) is PROPORTIONAL, and in
// `^A0N,height,width` the width parameter *scales* the natural glyph advances — it does
// not set a fixed character cell. So width must equal height to draw the face at its
// natural aspect; anything less squeezes every glyph horizontally.
//
// Glyph advance as a fraction of the font height at that natural aspect. Triumvirate Bold
// Condensed is already a condensed face, so most glyphs sit near half the height; digits
// are tabular (all the same width, so '1' is NOT narrow). Used ONLY to measure a line —
// we center by an explicit ^FO x-offset rather than ^FB justification, because ZPL
// *emulators* (e.g. the Arkscan/4BARCODE) frequently ignore ^FB's centering flag and
// would leave every line left-aligned. Explicit x works everywhere.
const NARROW = new Set([...".,:;'`!|iIlj()[]{}/\\-"])
const WIDE = new Set([...'mwMW@%'])
const advance = (ch: string) => (ch === ' ' ? 0.26 : NARROW.has(ch) ? 0.28 : WIDE.has(ch) ? 0.78 : 0.52)
const textWidth = (s: string, h: number) => Math.max(1, Math.round([...s].reduce((a, c) => a + advance(c), 0) * h))

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
  const dots = (k: keyof LabelScale) => Math.max(10, Math.round(basePt(k, template.labelSize) * (sc[k] ?? 1) * PT_TO_DOTS))

  const raw: { text: string; h: number }[] = []
  if (template.itemNumber) { const n = parseItemNumber(data.itemNumber); if (n) raw.push({ text: `#${n}`, h: dots('itemNumber') }) }
  if (template.custom.enabled) { const v = extractCustom(data.title ?? data.productName, template.custom.regex, template.custom.flags); if (v) raw.push({ text: v, h: dots('custom') }) }
  if (template.buyer && data.buyer) raw.push({ text: data.buyer, h: dots('buyer') })
  if (template.productName && data.productName) raw.push({ text: data.productName, h: dots('productName') })
  if (template.price && data.price) raw.push({ text: data.price, h: dots('price') })

  // Finalize each line: shrink any line whose measured width exceeds the safe zone so it
  // never clips the (round) edge, then compute a centered x for it.
  const lines = raw.map((l) => {
    let h = l.h
    let w = textWidth(l.text, h)
    if (w > safeW) { h = Math.max(10, Math.round((h * safeW) / w)); w = textWidth(l.text, h) }
    return { text: l.text, h, x: Math.max(0, Math.round((W - w) / 2)) }
  })

  // Stack from 0 with leading BETWEEN lines only (trailing leading would bias the block
  // upward), then shift the finished stack down to vertically center it.
  const gap = Math.round(2 * PT_TO_DOTS)
  let stackH = 0
  const placed = lines.map((l, i) => {
    const y = stackH
    stackH += l.h + (i < lines.length - 1 ? Math.round(l.h * 0.15) + gap : 0)
    return { ...l, y }
  })
  const top = Math.max(0, Math.round((H - stackH) / 2))

  // ^MNY: die-cut stock — the printer must sense the label gap and register each print to
  // the physical label. Under ^MNN (continuous) it prints a fixed ^LL run from wherever
  // the last one stopped, so any mismatch between ^LL and the real label pitch accumulates
  // and the artwork walks off the die-cut. ^LH0,0 clears a label-home offset left by an
  // earlier job, which would otherwise shift every label by a constant amount.
  let zpl = `^XA\n^CI28\n^LH0,0\n^PW${W}\n^LL${H}\n^MNY\n`
  for (const l of placed) {
    // width param = height param → natural glyph aspect (see NARROW/WIDE above)
    // toZplText here, not at the call sites: every line funnels through this one emit, so
    // a field added later cannot forget to strip and silently emit glyphs the printer
    // renders as garbage.
    zpl += `^FO${l.x},${top + l.y}^A0N,${l.h},${l.h}^FD${esc(toZplText(l.text))}^FS\n`
  }
  return zpl + '^XZ\n'
}
