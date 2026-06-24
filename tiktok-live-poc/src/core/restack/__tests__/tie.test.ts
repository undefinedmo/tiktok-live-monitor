import { describe, it, expect } from 'vitest'
import { tieByGenerateOrder } from '../tie'

describe('tieByGenerateOrder', () => {
  it('ties each page to the order(s) for its fulfill_unit_id, in page order', () => {
    const unitIds = ['1156730386024534712', '1156716186041946310', '9999999999999999999']
    const ordersByUnit = new Map<string, string[]>([
      // combined shipment: one unit -> two main orders (real HAR example)
      ['1156730386024534712', ['577445740374037176', '577445688654795448']],
      ['1156716186041946310', ['577445688861364422']],
      // 9999... has no synced order
    ])
    const ties = tieByGenerateOrder(unitIds, ordersByUnit)
    expect(ties).toEqual([
      { pageIndex: 0, fulfillUnitId: '1156730386024534712', orderId: '577445740374037176', matchMethod: 'generate-order' },
      { pageIndex: 1, fulfillUnitId: '1156716186041946310', orderId: '577445688861364422', matchMethod: 'generate-order' },
      { pageIndex: 2, fulfillUnitId: '9999999999999999999', orderId: null, matchMethod: 'unmatched' },
    ])
  })
})
