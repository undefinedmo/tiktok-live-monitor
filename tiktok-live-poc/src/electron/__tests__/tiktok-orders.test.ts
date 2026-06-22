import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mapTiktokOrder, orderToSale } from '../tiktok-orders'

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
