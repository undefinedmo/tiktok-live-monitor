import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import {
  openDb,
  upsertOrders,
  getOrdersByFulfillUnit,
  insertLabelBatch,
  insertLabelPages,
  getLabelPages,
  getOrdersForRestack,
} from '../db'
import { tieByGenerateOrder } from '../../core/restack/tie'
import { reorderLabels, pdfPageCount, buildPackingSheet, type SheetRow } from '../label-pdf'
import { orderedOrders } from '../../core/restack/sortlogic'
import { binOf } from '../../core/restack/bins'
import type { MappedOrder } from '../tiktok-orders'

async function makePdf(n: number): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  for (let i = 0; i < n; i++) d.addPage([200, 200])
  return d.save()
}

function makeOrder(overrides: { externalOrderId: string; buyerHandle: string; placedAt: number; fulfillUnitId: string; trackingNo: string }): MappedOrder {
  return {
    externalOrderId: overrides.externalOrderId,
    status: 'To ship',
    statusCode: '111',
    buyerHandle: overrides.buyerHandle,
    buyerName: overrides.buyerHandle,
    subtotalCents: 0,
    shippingCents: 0,
    shippingDiscountCents: 0,
    platformDiscountCents: 0,
    sellerDiscountCents: 0,
    taxCents: 0,
    originSaleCents: 0,
    totalCents: 0,
    address: null,
    carrier: null,
    tracking: overrides.trackingNo,
    liveTag: null,
    isAuction: false,
    isReversed: false,
    placedAt: overrides.placedAt,
    roomId: 'r1',
    videoReceiptTs: null,
    fulfillment: {
      fulfillUnitId: overrides.fulfillUnitId,
      trackingNo: overrides.trackingNo,
      isSplitOrCombined: false,
    },
    items: [],
  }
}

describe('label batch integration', () => {
  it('ties a synthetic 2-page batch to two orders and reorders', async () => {
    const db = openDb(':memory:')

    upsertOrders(
      db,
      [
        makeOrder({ externalOrderId: 'o1', buyerHandle: 'amy', placedAt: 100, fulfillUnitId: 'U1', trackingNo: 'T1' }),
        makeOrder({ externalOrderId: 'o2', buyerHandle: 'bob', placedAt: 200, fulfillUnitId: 'U2', trackingNo: 'T2' }),
      ],
      Date.now(),
    )

    const units = ['U1', 'U2']
    const ties = tieByGenerateOrder(units, getOrdersByFulfillUnit(db))

    // Both units should tie to orders
    expect(ties).toHaveLength(2)
    expect(ties[0]).toMatchObject({ pageIndex: 0, fulfillUnitId: 'U1', orderId: 'o1', matchMethod: 'generate-order' })
    expect(ties[1]).toMatchObject({ pageIndex: 1, fulfillUnitId: 'U2', orderId: 'o2', matchMethod: 'generate-order' })

    // Persist the batch and pages
    insertLabelBatch(db, {
      id: 'b1',
      capturedAt: 1,
      roomId: 'r1',
      docUrl: null,
      pdfPath: null,
      pageCount: 2,
      unitCount: 2,
      status: 'tied',
      requestJson: JSON.stringify(units),
      statsJson: '[]',
    })
    insertLabelPages(db, 'b1', ties)

    // getLabelPages returns one row per page
    expect(getLabelPages(db, 'b1')).toHaveLength(2)

    // Add 1: verify read-back content, not just length
    const persisted = getLabelPages(db, 'b1')
    expect(persisted[0]).toMatchObject({ pageIndex: 0, fulfillUnitId: 'U1', orderId: 'o1', matchMethod: 'generate-order' })
    expect(persisted[1]).toMatchObject({ pageIndex: 1, fulfillUnitId: 'U2', orderId: 'o2', matchMethod: 'generate-order' })

    // reorderLabels over a reversed sequence yields 2 pages
    const pdfBytes = await makePdf(2)
    const reordered = await reorderLabels(pdfBytes, [1, 0])
    expect(await pdfPageCount(reordered)).toBe(2)

    // Add 2: exercise buildPackingSheet in the batch pipeline
    const allOrders = getOrdersForRestack(db)
    const tiedUnitIds = new Set(persisted.map((pg) => pg.fulfillUnitId).filter(Boolean))
    const tiedOrders = allOrders.filter((o) => o.fulfillUnitId && tiedUnitIds.has(o.fulfillUnitId))
    const seq = orderedOrders(tiedOrders.map((o) => ({ orderId: o.orderId, buyer: o.buyer, createdMs: o.placedAt })))
    const byId = new Map(tiedOrders.map((o) => [o.orderId, o]))
    const rows: SheetRow[] = seq.map((o, i) => {
      const ord = byId.get(o.orderId)!
      const items = ord.items.map((it) => `${it.sku ?? '?'} (Bin ${binOf(it.productName)})`).join(', ')
      return { seq: i + 1, buyer: ord.buyer, purchased: ord.placedAt ? new Date(ord.placedAt).toLocaleTimeString() : '', items, multi: ord.items.length > 1 }
    })
    expect(rows.length).toBe(2)
    const sheet = await buildPackingSheet(rows)
    expect(Buffer.from(sheet.slice(0, 5)).toString()).toBe('%PDF-')
    expect(await pdfPageCount(sheet)).toBeGreaterThanOrEqual(1)

    db.close()
  })
})
