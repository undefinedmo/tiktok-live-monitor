import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { pdfPageCount } from '../label-pdf'

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
