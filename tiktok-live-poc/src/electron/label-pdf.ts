// SPIKE #1 (run once against the first real captured batch, see Task 7):
//   1. label_batch.page_count === label_batch.unit_count  (one page per fulfill_unit)
//   2. each page has exactly one Code 128 barcode (verify in Task 12 once decode exists)
//   3. page order === fulfill_unit_id_list order (decode page barcodes, compare to the
//      tracking numbers of orders joined by fulfill_unit_id in that list order)
// If (1) or (3) fail: barcode decode (Task 12) becomes the PRIMARY tie path. The runtime
// guard in Task 6 (page_count !== unit_count -> mark batch for barcode tie) is the safety net.

import { PDFDocument } from 'pdf-lib'

/** Number of pages in a PDF byte buffer. */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes)
  return doc.getPageCount()
}
