import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mapTiktokOrder, orderToSale, SHOW_SYNC_BUFFER_MS, pageReachedSince, applyOrderDetails, filterOrdersForShow, pullTiktokOrdersSince } from '../tiktok-orders'
import type { MappedOrder, OrderDetail } from '../tiktok-orders'

const raw = {
  main_order_id: '5800000000001',
  order_status_module: [{ main_order_status: 121 }],
  buyer_info_module: { buyer_nickname: 'shopper1', shipping_address: { items: [{ key: 'name', value: 'Jane Doe' }] } },
  price_module: { grand_total: { price_val: '57.00' } },
  sku_module: [{ product_name: 'Bin A - Alo Yoga', sku_name: 'M' }],
  trade_order_module: { create_time: 1700000000 },
  extra_data_map: { sales_source_live_tag: { value: { v_dynamic_express: { items: [{ message_content: 'LIVE 6/20' }] } } } },
}

describe('mapTiktokOrder', () => {
  it('maps a raw Seller-Center order', () => {
    const m = mapTiktokOrder(raw)
    expect(m.externalOrderId).toBe('5800000000001')
    expect(m.status).toBe('Shipped') // status code 121
    expect(m.totalCents).toBe(5700)
    expect(m.buyerName).toBe('Jane Doe')
    expect(m.buyerHandle).toBe('shopper1')
    expect(m.items[0]!.productName).toBe('Bin A - Alo Yoga')
    expect(m.liveTag).toBe('LIVE 6/20')
    expect(m.placedAt).toBe(1700000000 * 1000) // seconds → ms
  })
})

describe('orderToSale', () => {
  it('produces a paid Sale carrying the show tag', () => {
    const s = orderToSale(mapTiktokOrder(raw))
    expect(s.orderId).toBe('5800000000001')
    expect(s.price.cents).toBe(5700)
    expect(s.price.formatted).toBe('$57.00')
    expect(s.paymentStatus).toBe('paid')
    expect(s.productName).toBe('Bin A - Alo Yoga')
    expect(s.liveTag).toBe('LIVE 6/20')
  })
  it('maps unpaid (100) → pending and reversed → failed', () => {
    expect(orderToSale(mapTiktokOrder({ ...raw, order_status_module: [{ main_order_status: 100 }] })).paymentStatus).toBe('pending')
    expect(orderToSale(mapTiktokOrder({ ...raw, reverse_module: [{ reverse_type: 2 }] })).paymentStatus).toBe('failed')
  })
  it('falls back to format_price when price_val is absent', () => {
    const s = orderToSale(mapTiktokOrder({ ...raw, price_module: { grand_total: { format_price: '$1,250.00' } } }))
    expect(s.price.cents).toBe(125000)
  })
})

describe('mapTiktokOrder — enriched fields', () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, '../../../fixtures/order-list-sample.json'), 'utf8'))

  it('parses stable product/sku identity and per-item prices', () => {
    const m = mapTiktokOrder(fixture)
    const it = m.items[0]!
    expect(it.productId).toBe('1729500000000000001')
    expect(it.skuId).toBe('1729500000000099001')
    expect(it.orderLineIds).toEqual(['577000000000000001-1'])
    expect(it.imageUrl).toBe('https://example.invalid/img/a.jpg')
    expect(it.unitPriceCents).toBe(7500)
    expect(it.totalPriceCents).toBe(7500)
  })

  it('parses the price breakdown', () => {
    const m = mapTiktokOrder(fixture)
    expect(m.subtotalCents).toBe(7500)
    expect(m.shippingCents).toBe(600)
    expect(m.taxCents).toBe(100)
    expect(m.sellerDiscountCents).toBe(500)
    expect(m.platformDiscountCents).toBe(0)
    expect(m.originSaleCents).toBe(8000)
  })
})

describe('orderToSale — stable identity + breakdown', () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, '../../../fixtures/order-list-sample.json'), 'utf8'))

  it('uses product_id as Sale.productId, not the name', () => {
    const s = orderToSale(mapTiktokOrder(fixture))
    expect(s.productId).toBe('1729500000000000001')
    expect(s.skuId).toBe('1729500000000099001')
    expect(s.productImageUrl).toBe('https://example.invalid/img/a.jpg')
    expect(s.priceBreakdown?.sellerDiscountCents).toBe(500)
    expect(s.priceBreakdown?.subtotalCents).toBe(7500)
  })

  it('falls back to product name when product_id is absent', () => {
    const noId = { ...fixture, sku_module: [{ product_name: 'Legacy Bin', sku_name: 'M' }] }
    expect(orderToSale(mapTiktokOrder(noId)).productId).toBe('Legacy Bin')
  })
})

describe('orderToSale — order flags (Phase 3 Unit F)', () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, '../../../fixtures/order-list-sample.json'), 'utf8'))

  it('parses note_module flags from fixture', () => {
    const sale = orderToSale(mapTiktokOrder(fixture))
    expect(sale.flags?.hasBuyerNote).toBe(true)
    expect(sale.flags?.hasSellerNote).toBe(false)
    expect(sale.flags?.hasSellerFlag).toBe(true)
  })

  it('parses extra_data_map flags from fixture', () => {
    const sale = orderToSale(mapTiktokOrder(fixture))
    expect(sale.flags?.isRiskOrder).toBe(true)
    expect(sale.flags?.isReplacement).toBe(false) // tag absent in fixture
    expect(sale.flags?.hasInsurance).toBe(true)
  })

  it('returns all-false flags for a stripped order without throwing', () => {
    const bare = { main_order_id: 'X', sku_module: [] }
    const sale = orderToSale(mapTiktokOrder(bare))
    expect(sale.flags?.isRiskOrder).toBe(false)
    expect(sale.flags?.isReplacement).toBe(false)
    expect(sale.flags?.hasInsurance).toBe(false)
    expect(sale.flags?.hasBuyerNote).toBe(false)
    expect(sale.flags?.hasSellerNote).toBe(false)
    expect(sale.flags?.hasSellerFlag).toBe(false)
  })
})

describe('orderToSale — fulfillment + SLA deadlines (Phase 2)', () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, '../../../fixtures/order-list-sample.json'), 'utf8'))

  it('promotes second-timestamps to ms for deadline fields', () => {
    const sale = orderToSale(mapTiktokOrder(fixture))
    expect(sale.deadlines?.latestRtsMs).toBe(1718995000 * 1000)
    expect(sale.deadlines?.autoCancelMs).toBe(1719254200 * 1000)
    expect(sale.deadlines?.deliverySla).toBe('Ship by Jun 21')
  })

  it('parses fulfillment package + warehouse fields', () => {
    const sale = orderToSale(mapTiktokOrder(fixture))
    expect(sale.fulfillment?.packageId).toBe('1152921000000000001')
    expect(sale.fulfillment?.fulfillUnitId).toBe('7301000000000000001')
    expect(sale.fulfillment?.warehouseName).toBe('Main Warehouse')
    expect(sale.fulfillment?.logisticsProviderName).toBe('USPS')
  })

  it('isSplitOrCombined is false when tag=0 and is_smart_combined=false', () => {
    const sale = orderToSale(mapTiktokOrder(fixture))
    expect(sale.fulfillment?.isSplitOrCombined).toBe(false)
  })

  it('isSplitOrCombined is true when split_combined_tag is nonzero', () => {
    const modified = {
      ...fixture,
      trade_order_module: { ...fixture.trade_order_module, split_combined_tag: 1, is_smart_combined: false },
    }
    const sale = orderToSale(mapTiktokOrder(modified))
    expect(sale.fulfillment?.isSplitOrCombined).toBe(true)
  })

  it('isSplitOrCombined is true when is_smart_combined=true', () => {
    const modified = {
      ...fixture,
      trade_order_module: { ...fixture.trade_order_module, split_combined_tag: 0, is_smart_combined: true },
    }
    const sale = orderToSale(mapTiktokOrder(modified))
    expect(sale.fulfillment?.isSplitOrCombined).toBe(true)
  })

  it('deadlines and fulfillment are defined even when optional modules are absent', () => {
    const bare = {
      main_order_id: '9990000000001',
      order_status_module: [{ main_order_status: 101 }],
      price_module: { grand_total: { price_val: '10.00' } },
      sku_module: [],
    }
    const sale = orderToSale(mapTiktokOrder(bare))
    // With no trade_order_module at all, deadlines fields are undefined but object is defined
    expect(sale.deadlines?.latestRtsMs).toBeUndefined()
    expect(sale.deadlines?.deliverySla).toBeUndefined()
    // With no fulfillment_module, all fulfillment fields are undefined
    expect(sale.fulfillment?.packageId).toBeUndefined()
    expect(sale.fulfillment?.isSplitOrCombined).toBe(false)
  })
})

function ord(id: string, placedAt: number | null, roomId: string | null = null): MappedOrder {
  return {
    externalOrderId: id, status: 'To ship', statusCode: '102', buyerHandle: null, buyerName: null,
    subtotalCents: 0, shippingCents: 0, shippingDiscountCents: 0, platformDiscountCents: 0,
    sellerDiscountCents: 0, taxCents: 0, originSaleCents: 0, totalCents: 0, address: null,
    carrier: null, tracking: null, liveTag: null, isAuction: false, isReversed: false,
    placedAt, roomId, videoReceiptTs: null, items: [],
  }
}

describe('SHOW_SYNC_BUFFER_MS', () => {
  it('is 6 hours', () => { expect(SHOW_SYNC_BUFFER_MS).toBe(6 * 60 * 60 * 1000) })
})

describe('pageReachedSince', () => {
  it('true once a page contains an order older than sinceMs', () => {
    expect(pageReachedSince([ord('a', 5000), ord('b', 1000)], 2000)).toBe(true)
  })
  it('false when every order is at or after sinceMs', () => {
    expect(pageReachedSince([ord('a', 5000), ord('b', 3000)], 2000)).toBe(false)
  })
  it('ignores orders with no placedAt', () => {
    expect(pageReachedSince([ord('a', null)], 2000)).toBe(false)
  })
})

describe('applyOrderDetails', () => {
  it('merges roomId + videoReceiptTs from details by order id', () => {
    const details = new Map<string, OrderDetail>([['a', { videoUrl: null, roomId: 'room-9', receiptTsMs: 42 }]])
    const out = applyOrderDetails([ord('a', 1000)], details)
    expect(out[0]!.roomId).toBe('room-9')
    expect(out[0]!.videoReceiptTs).toBe(42)
  })
  it('leaves orders without a detail entry unchanged', () => {
    const input = [ord('a', 1000, 'keep')]
    const out = applyOrderDetails(input, new Map())
    expect(out[0]!.roomId).toBe('keep')
    expect(out[0]).not.toBe(input[0])   // contract: new object, inputs untouched
  })
})

describe('filterOrdersForShow', () => {
  const startMs = 10_000, endMs = 20_000
  it('keeps orders whose roomId is in the show', () => {
    const out = filterOrdersForShow([ord('a', 999999, 'room-1'), ord('b', 999999, 'room-x')], ['room-1'], startMs, endMs)
    expect(out.map((o) => o.externalOrderId)).toEqual(['a'])
  })
  it('keeps room-less orders that fall inside the window', () => {
    const out = filterOrdersForShow([ord('c', 15_000, null)], ['room-1'], startMs, endMs)
    expect(out.map((o) => o.externalOrderId)).toEqual(['c'])
  })
  it('drops room-less orders outside the window', () => {
    const out = filterOrdersForShow([ord('d', 999999, null)], ['room-1'], startMs, endMs)
    expect(out).toEqual([])
  })
  it('treats an empty-string roomId as room-less (kept only inside the window)', () => {
    expect(filterOrdersForShow([ord('e', 15_000, '')], ['room-1'], startMs, endMs).map((o) => o.externalOrderId)).toEqual(['e'])
    expect(filterOrdersForShow([ord('f', 999_999, '')], ['room-1'], startMs, endMs)).toEqual([])
  })
})

describe('pullTiktokOrdersSince', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  function page(orders: { id: string; t: number }[], has_more: boolean) {
    const main_orders = orders.map((o) => ({
      main_order_id: o.id,
      order_status_module: [{ main_order_status: '102' }],
      trade_order_module: { create_time: o.t }, // seconds
      price_module: {}, sku_module: [],
    }))
    return { ok: true, text: async () => JSON.stringify({ code: 0, data: { main_orders, total_count: 99, has_more } }) }
  }

  it('stops paging once a page reaches before sinceMs', async () => {
    const sinceSec = 1_000_000
    const sinceMs = sinceSec * 1000
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page([{ id: 'a', t: sinceSec + 500 }, { id: 'b', t: sinceSec + 400 }], true))
      .mockResolvedValueOnce(page([{ id: 'c', t: sinceSec + 100 }, { id: 'd', t: sinceSec - 100 }], true))
    vi.stubGlobal('fetch', fetchMock)

    const res = await pullTiktokOrdersSince('cookie=1', sinceMs)

    expect(fetchMock).toHaveBeenCalledTimes(2) // stopped after the page containing 'd'
    expect(res.stopped).toBe(true)
    expect(res.orders.map((o) => o.externalOrderId)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('returns stopped:false when pagination exhausts before the time bound', async () => {
    const sinceSec = 1_000_000
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page([{ id: 'a', t: sinceSec + 500 }], true))
      .mockResolvedValueOnce(page([{ id: 'b', t: sinceSec + 400 }], false)) // has_more:false → normal exhaustion
    vi.stubGlobal('fetch', fetchMock)
    const res = await pullTiktokOrdersSince('cookie=1', sinceSec * 1000)
    expect(res.stopped).toBe(false)
    expect(res.orders.map((o) => o.externalOrderId)).toEqual(['a', 'b'])
  })
})
