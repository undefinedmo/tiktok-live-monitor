// SPIKE #1 (run once against the first real captured batch, see Task 7):
//   1. label_batch.page_count === label_batch.unit_count  (one page per fulfill_unit)
//   2. each page has exactly one Code 128 barcode (verify in Task 12 once decode exists)
//   3. page order === fulfill_unit_id_list order (decode page barcodes, compare to the
//      tracking numbers of orders joined by fulfill_unit_id in that list order)
// If (1) or (3) fail: barcode decode (Task 12) becomes the PRIMARY tie path. The runtime
// guard in Task 6 (page_count !== unit_count -> mark batch for barcode tie) is the safety net.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

/** Number of pages in a PDF byte buffer. */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes)
  return doc.getPageCount()
}

export async function reorderLabels(srcBytes: Uint8Array, sequence: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(srcBytes)
  const out = await PDFDocument.create()
  const valid = sequence.filter((i) => i >= 0 && i < src.getPageCount())
  const pages = await out.copyPages(src, valid)
  pages.forEach((p) => out.addPage(p))
  return out.save()
}

export async function extractPage(srcBytes: Uint8Array, pageIndex: number): Promise<Uint8Array> {
  const src = await PDFDocument.load(srcBytes)
  const out = await PDFDocument.create()
  const [p] = await out.copyPages(src, [pageIndex])
  out.addPage(p)
  return out.save()
}

export interface SheetRow {
  seq: number
  buyer: string
  purchased: string
  items: string
  multi: boolean
}

const ROWS_PER_PAGE = 38
const PAGE_W = 612 // US Letter pt
const PAGE_H = 792

export async function buildPackingSheet(rows: SheetRow[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const flag = rgb(0.9, 0.2, 0.1)
  const ink = rgb(0.09, 0.07, 0.06)
  const cols = [{ x: 40, label: '#' }, { x: 80, label: 'Buyer' }, { x: 250, label: 'Purchased' }, { x: 340, label: 'Items (SKU / Bin)' }, { x: 560, label: 'Pick' }]

  for (let start = 0; start < Math.max(rows.length, 1); start += ROWS_PER_PAGE) {
    const page = doc.addPage([PAGE_W, PAGE_H])
    let y = PAGE_H - 50
    for (const c of cols) page.drawText(c.label, { x: c.x, y, size: 10, font: bold, color: ink })
    y -= 6
    page.drawLine({ start: { x: 40, y }, end: { x: 575, y }, thickness: 1, color: ink })
    y -= 18
    for (const r of rows.slice(start, start + ROWS_PER_PAGE)) {
      page.drawText(String(r.seq), { x: cols[0]!.x, y, size: 9, font, color: ink })
      page.drawText(r.buyer.slice(0, 28), { x: cols[1]!.x, y, size: 9, font, color: ink })
      page.drawText(r.purchased, { x: cols[2]!.x, y, size: 9, font, color: ink })
      page.drawText(r.items.slice(0, 40), { x: cols[3]!.x, y, size: 9, font, color: r.multi ? flag : ink })
      page.drawText('[ ]', { x: cols[4]!.x, y, size: 9, font, color: ink })
      y -= 18
    }
  }
  return doc.save()
}
