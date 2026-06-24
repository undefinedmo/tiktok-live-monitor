import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { pdfPageCount, reorderLabels, extractPage } from '../label-pdf'

async function makePdf(n: number): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  for (let i = 0; i < n; i++) d.addPage([200, 200])
  return d.save()
}

describe('pdfPageCount', () => {
  it('counts pages of a generated PDF', async () => {
    const bytes = await makePdf(5)
    expect(await pdfPageCount(bytes)).toBe(5)
  })
})

describe('reorderLabels / extractPage', () => {
  it('reorders to the given sequence', async () => {
    const src = await makePdf(3)
    const out = await reorderLabels(src, [2, 0]) // keep only pages 2 and 0
    expect(await pdfPageCount(out)).toBe(2)
  })
  it('extracts a single page', async () => {
    const src = await makePdf(4)
    const out = await extractPage(src, 1)
    expect(await pdfPageCount(out)).toBe(1)
  })
})
