export interface LabelPageTie {
  pageIndex: number
  fulfillUnitId: string
  orderId: string | null // resolved primary order for the 1:1 case; full fan-out is via orders.fulfill_unit_id
  matchMethod: 'generate-order' | 'barcode' | 'unmatched'
}

/** Page i is fulfill_unit_id_list[i]. Resolve order(s) by joining orders.fulfill_unit_id.
 *  A combined shipment maps one unit to several orders; orderId caches the first. */
export function tieByGenerateOrder(unitIds: string[], ordersByUnit: Map<string, string[]>): LabelPageTie[] {
  return unitIds.map((uid, i) => {
    const orders = ordersByUnit.get(uid) ?? []
    return {
      pageIndex: i,
      fulfillUnitId: uid,
      orderId: orders.length ? orders[0]! : null,
      matchMethod: orders.length ? 'generate-order' : 'unmatched',
    }
  })
}
