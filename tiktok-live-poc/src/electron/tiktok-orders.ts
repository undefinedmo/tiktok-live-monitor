// TikTok Shop order pull — ported from live-ledger/server/src/tiktok.ts.
// The Seller-Center fulfillment endpoints authenticate with the session COOKIES alone
// (no X-Bogus/msToken signing — verified empirically by live-ledger), so we can pull the
// real order book headlessly from Electron's main process. This is independent of any
// live stream: it's the seller's order history, the source for the Order Ledger.

import type { Sale, OrderDeadlines, FulfillmentInfo, OrderFlags } from '../core/types'

type Raw = Record<string, unknown>

const STATUS_LABELS: Record<string, string> = {
  '100': 'Unpaid', '101': 'To ship', '102': 'To ship', '103': 'To ship', '105': 'To ship', '111': 'To ship',
  '112': 'To collect', '114': 'Part. shipped', '121': 'Shipped', '122': 'In transit', '125': 'In transit',
  '130': 'Delivered', '140': 'Completed', '150': 'Completed',
}

function get(o: Raw, path: string): unknown {
  try { return path.split('.').reduce<unknown>((a, k) => (a == null ? a : (a as Raw)[k]), o) } catch { return undefined }
}
function num(v: unknown): number | null {
  const n = parseFloat(String(v))
  return Number.isNaN(n) ? null : n
}
function ts(v: unknown): number | null {
  if (v == null) return null
  let n = Number(v)
  if (Number.isNaN(n)) return null
  if (n < 1e12) n *= 1000
  return n
}
function cents(node: unknown): number {
  const n = node as Raw | undefined
  if (!n) return 0
  const v = num(n.price_val)
  if (v != null) return Math.round(v * 100)
  const m = /([\d,]+(?:\.\d{1,2})?)/.exec(String(n.format_price ?? ''))
  return m && m[1] ? Math.round(parseFloat(m[1].replace(/,/g, '')) * 100) : 0
}
function liveTagText(o: Raw): string | null {
  const a = (get(o, 'extra_data_map.sales_source_live_tag.value.v_dynamic_express.items') ||
    get(o, 'order_label_module.0.label_express_map.sales_source_live_tag.value.v_dynamic_express.items')) as Raw[] | undefined
  if (Array.isArray(a)) {
    const texts = a.map((x) => x && (x as Raw).message_content).filter(Boolean) as string[]
    return texts.find((t) => /LIVE/i.test(t) || /:/.test(t)) || texts[0] || null
  }
  return null
}

export interface MappedOrder {
  externalOrderId: string
  status: string
  statusCode: string | null
  buyerHandle: string | null
  buyerName: string | null
  subtotalCents: number
  shippingCents: number
  shippingDiscountCents: number
  platformDiscountCents: number
  sellerDiscountCents: number
  taxCents: number
  originSaleCents: number
  totalCents: number
  address: string | null
  carrier: string | null
  tracking: string | null
  liveTag: string | null
  isAuction: boolean
  isReversed: boolean
  placedAt: number | null
  roomId: string | null
  videoReceiptTs: number | null
  deadlines?: OrderDeadlines
  fulfillment?: FulfillmentInfo
  flags?: OrderFlags
  items: {
    productId: string | null
    skuId: string | null
    productName: string | null
    variant: string | null
    quantity: number
    unitPriceCents: number
    totalPriceCents: number
    imageUrl: string | null
    orderLineIds: string[]
  }[]
}

export function mapTiktokOrder(o: Raw): MappedOrder {
  const rev = Array.isArray(o.reverse_module) && o.reverse_module.length ? (o.reverse_module as Raw[])[0] : null
  const addrItems = (get(o, 'buyer_info_module.shipping_address.items') as Raw[]) || []
  const addr: Record<string, string> = {}
  for (const it of addrItems) if (it && it.key) addr[String(it.key)] = String(it.value)

  const codeVal = get(o, 'order_status_module.0.main_order_status')
  const code = codeVal == null ? '' : String(codeVal)
  const status = rev
    ? ((rev as Raw).reverse_type === 2 ? 'Refunded' : 'Cancelled')
    : (STATUS_LABELS[code] || (code ? `Code ${code}` : '—'))

  const skus = (Array.isArray(o.sku_module) ? o.sku_module : []) as Raw[]
  const items = skus.map((s) => ({
    productId: (get(s, 'product_id') ?? null) as string | null,
    skuId: (get(s, 'sku_id') ?? null) as string | null,
    productName: (get(s, 'product_name') ?? null) as string | null,
    variant: (get(s, 'sku_name') ?? get(s, 'seller_sku_name') ?? null) as string | null,
    quantity: num(get(s, 'quantity')) ?? 0,
    unitPriceCents: cents(get(s, 'sku_unit_price')),
    totalPriceCents: cents(get(s, 'sku_total_price')),
    imageUrl: (get(s, 'product_image.url_list.0') ?? null) as string | null,
    orderLineIds: Array.isArray(get(s, 'order_line_ids')) ? (get(s, 'order_line_ids') as unknown[]).map(String) : [],
  }))
  // assemble a one-line ship-to from the address parts we have (city/state/region, postal)
  const region = [addr.city, addr.state || addr.region, addr.zipcode || addr.postal_code].filter(Boolean).join(', ') || null
  const fm = (get(o, 'fulfillment_module.0') as Raw) || {}

  const deadlines: OrderDeadlines = {
    latestRtsMs: ts(get(o, 'trade_order_module.latest_rts_time')) ?? undefined,
    latestTtsMs: ts(get(o, 'trade_order_module.latest_tts_time')) ?? undefined,
    autoCancelMs: ts(get(o, 'trade_order_module.ship_cancellation_plan_time')) ?? undefined,
    deliverySla: (get(o, 'trade_order_module.delivery_sla') as string | undefined) ?? undefined,
    processingDueMs: ts(get(o, 'processing_time_info_module.processing_time_info.latest_processing_timestamp')) ?? undefined,
  }

  const splitTag = num(get(o, 'trade_order_module.split_combined_tag'))
  const isSplitOrCombined: boolean =
    !!get(o, 'trade_order_module.is_smart_combined') || (splitTag !== null && splitTag !== 0)

  const fulfillment: FulfillmentInfo = {
    packageId: (fm.package_id as string | undefined) ?? undefined,
    fulfillUnitId: (fm.fulfill_unit_id as string | undefined) ?? undefined,
    trackingNo: (fm.tracking_number as string | undefined) ?? undefined,
    warehouseId: (fm.warehouse_id as string | undefined) ?? undefined,
    warehouseName: (fm.warehouse_name as string | undefined) ?? undefined,
    logisticsProviderName: (fm.shipping_provider_name as string | undefined) ?? undefined,
    shippingServiceName: (fm.shipping_service_name as string | undefined) ?? undefined,
    packageStatus: num(fm.package_status) ?? undefined,
    labelStatus: num(fm.label_status) ?? undefined,
    pickingListStatus: num(fm.picking_list_status) ?? undefined,
    packingListStatus: num(fm.packing_list_status) ?? undefined,
    isSplitOrCombined,
  }

  return {
    externalOrderId: String(get(o, 'main_order_id') ?? get(o, 'note_module.main_order_id') ?? ''),
    status,
    statusCode: code || null,
    buyerHandle: (get(o, 'buyer_info_module.buyer_nickname') as string) || null,
    buyerName: addr.name || (get(o, 'buyer_info_module.actual_buyer_nickname') as string) || null,
    subtotalCents: cents(get(o, 'price_module.sub_total')),
    shippingCents: cents(get(o, 'price_module.shipping_fee')),
    shippingDiscountCents: cents(get(o, 'price_module.shipping_discount')),
    platformDiscountCents: cents(get(o, 'price_module.platform_discount')),
    sellerDiscountCents: cents(get(o, 'price_module.seller_discount')),
    taxCents: cents(get(o, 'price_module.taxes')),
    originSaleCents: cents(get(o, 'price_module.origin_sale_price')),
    totalCents: cents(get(o, 'price_module.grand_total')),
    address: region,
    carrier: (fm.shipping_provider_name as string) || (get(o, 'logistics_module.0.shipping_provider_name') as string) || null,
    tracking: (fm.tracking_number as string) || (get(o, 'logistics_module.0.tracking_number') as string) || null,
    liveTag: liveTagText(o),
    isAuction: !!get(o, 'extra_data_map.auction_tag'),
    isReversed: !!rev,
    placedAt: ts(get(o, 'trade_order_module.create_time') ?? get(o, 'fulfillment_module.0.create_time')),
    roomId: get(o, 'auction_module.live_room_id') != null ? String(get(o, 'auction_module.live_room_id')) : null,
    videoReceiptTs: num(get(o, 'auction_module.video_receipt_timestamp')) != null ? Math.round(num(get(o, 'auction_module.video_receipt_timestamp'))!) : null,
    deadlines,
    fulfillment,
    flags: {
      isRiskOrder: !!get(o, 'extra_data_map.risk_order_tag_v1'),
      isReplacement: !!get(o, 'extra_data_map.replacement_order_tag_v1'),
      hasInsurance: !!get(o, 'extra_data_map.gift_insurance_tag'),
      hasBuyerNote: !!get(o, 'note_module.has_buyer_note'),
      hasSellerNote: !!get(o, 'note_module.has_seller_note'),
      hasSellerFlag: !!get(o, 'note_module.has_seller_flag'),
    },
    items,
  }
}

/** Map a Seller-Center order → the PoC's Sale shape used by the Ledger/Picklist. */
export function orderToSale(o: MappedOrder): Sale {
  const item = o.items[0]
  const productName = item?.productName ?? '(item)'
  const productId = item?.productId || productName // stable id when present; name only as fallback
  const paymentStatus: Sale['paymentStatus'] =
    o.isReversed ? 'failed' : o.status === 'Unpaid' ? 'pending' : 'paid'
  return {
    orderId: o.externalOrderId,
    buyer: { username: o.buyerName || o.buyerHandle || '—', handle: o.buyerHandle ?? undefined },
    productId,
    productName,
    productImageUrl: item?.imageUrl ?? undefined,
    skuId: item?.skuId ?? undefined,
    skuDesc: item?.variant ?? (o.items.length > 1 ? `${o.items.length} items` : ''),
    price: { cents: o.totalCents, formatted: '$' + (o.totalCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
    priceBreakdown: {
      grandTotalCents: o.totalCents,
      subtotalCents: o.subtotalCents,
      originSaleCents: o.originSaleCents,
      sellerDiscountCents: o.sellerDiscountCents,
      platformDiscountCents: o.platformDiscountCents,
      shippingFeeCents: o.shippingCents,
      shippingDiscountCents: o.shippingDiscountCents,
      taxCents: o.taxCents,
    },
    paymentStatus,
    createdAt: o.placedAt ?? Date.now(),
    liveTag: o.liveTag ?? undefined,
    roomId: o.roomId ?? undefined,
    deadlines: o.deadlines,
    fulfillment: o.fulfillment,
    flags: o.flags,
    detail: {
      status: o.status,
      subtotalCents: o.subtotalCents,
      shippingCents: o.shippingCents,
      taxCents: o.taxCents,
      address: o.address ?? undefined,
      carrier: o.carrier ?? undefined,
      tracking: o.tracking ?? undefined,
      items: o.items.map((it) => ({ productName: it.productName ?? '(item)', variant: it.variant ?? undefined, quantity: it.quantity })),
      isAuction: o.isAuction,
      orderUrl: `https://seller-us.tiktok.com/order/detail?order_no=${o.externalOrderId}`,
    },
  }
}

export const ORDER_LIST_URL =
  'https://seller-us.tiktok.com/api/fulfillment/na/order/list?aid=4068&app_name=i18n_ecom_shop&device_platform=web'

const TT_ORDER_EXTRA_DATA = [
  '48_hours_dispatch_tag', 'split_combine_tag_v1', 'free_sample_tag_v1', 'hazmat_order_tag',
  'made_to_order_tag', 'pre_order_tag', 'pre_sell_tag', 'zero_lottery_tag', 'gift_insurance_tag',
  'internal_purchase_tag', 'risk_order_tag_v1', 'combo_sku_tag', 'refundable_sample_tag',
  'split_package_type_tag', 'replacement_order_tag_v1',
]

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

/** Pull all Seller-Center orders (paginated). Cookie auth only — no request signing. */
export async function pullTiktokOrders(
  cookieHeader: string,
  onPage?: (pulled: number, total: number) => void,
): Promise<{ orders: MappedOrder[]; total: number }> {
  const all: MappedOrder[] = []
  let offset = 0, total = 0, guard = 0
  const count = 50
  while (guard < 400) {
    guard++
    const res = await fetch(ORDER_LIST_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        origin: 'https://seller-us.tiktok.com',
        referer: 'https://seller-us.tiktok.com/order',
        'user-agent': UA,
        cookie: cookieHeader,
      },
      body: JSON.stringify({
        sort_info: '6', search_condition: { condition_list: {} },
        count, pagination_type: 0, offset, extra_data_list: TT_ORDER_EXTRA_DATA,
      }),
    })
    if (!res.ok) throw new Error(`order/list HTTP ${res.status}`)
    const text = await res.text()
    const j = JSON.parse(text.replace(/"live_room_id":\s*(\d+)/g, '"live_room_id":"$1"')) as Raw
    if (j.code !== 0 && j.code != null) {
      throw new Error(`order/list code ${j.code} — ${String(j.message ?? 'rejected')} (session may be expired — re-open the monitor and log in)`)
    }
    const data = (j.data as Raw) || {}
    const batch = (data.main_orders as Raw[]) || []
    all.push(...batch.map(mapTiktokOrder))
    total = Number(data.total_count || 0)
    onPage?.(all.length, total)
    offset += count
    if (!(data.has_more && batch.length && offset < total + count)) break
  }
  return { orders: all, total }
}

// ── Order-detail pull (signed replay .m3u8 + LIVE room id) ───────────────────
// The Seller-Center order/get call returns, for LIVE/auction orders, the auction_module with:
//   • auction_video_receipt_url — signed HLS replay (per-order video receipt)
//   • live_room_id              — the real TikTok LIVE room the order belongs to
//   • video_receipt_timestamp   — the replay offset for this order's sale moment
// Same cookie auth as the order list. Batched in main_order_id chunks of 20.
export const ORDER_GET_URL =
  'https://seller-us.tiktok.com/api/fulfillment/na/order/get?aid=4068&app_name=i18n_ecom_shop&device_platform=web'

export interface OrderDetail {
  videoUrl: string | null   // signed .m3u8 receipt, when present
  roomId: string | null     // live_room_id — group orders into real shows
  receiptTsMs: number | null // video_receipt_timestamp (replay offset)
}

/** Fetch per-order detail (video receipt + LIVE room id), keyed by main_order_id. Cookie auth only. */
export async function fetchOrderDetails(
  orderIds: string[],
  cookieHeader: string,
): Promise<Map<string, OrderDetail>> {
  const out = new Map<string, OrderDetail>()
  const BATCH = 20
  for (let i = 0; i < orderIds.length; i += BATCH) {
    const ids = orderIds.slice(i, i + BATCH)
    const res = await fetch(ORDER_GET_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        origin: 'https://seller-us.tiktok.com',
        referer: 'https://seller-us.tiktok.com/order',
        'user-agent': UA,
        cookie: cookieHeader,
      },
      body: JSON.stringify({ main_order_id: ids }),
    })
    if (!res.ok) throw new Error(`order/get HTTP ${res.status}`)
    // live_room_id is a bare 19-digit JSON number (> 2^53) — quote it before parsing so V8
    // doesn't round it; we need the exact room id.
    const text = await res.text()
    const j = JSON.parse(text.replace(/"live_room_id":\s*(\d+)/g, '"live_room_id":"$1"')) as Raw
    if (j.code !== 0 && j.code != null) {
      throw new Error(`order/get code ${j.code} — ${String(j.message ?? 'rejected')} (session may be expired — re-open the monitor and log in)`)
    }
    const mains = ((j.data as Raw)?.main_order as Raw[]) || []
    for (const m of mains) {
      const id = String(get(m, 'main_order_id') ?? get(m, 'trade_order_module.main_order_id') ?? get(m, 'note_module.main_order_id') ?? '')
      if (!id) continue
      const am = (get(m, 'auction_module') as Raw) || {}
      const url = am.auction_video_receipt_url
      const tsRaw = num(am.video_receipt_timestamp)
      out.set(id, {
        videoUrl: typeof url === 'string' && url.length > 0 ? url : null,
        roomId: am.live_room_id != null ? String(am.live_room_id) : null,
        receiptTsMs: tsRaw != null ? Math.round(tsRaw) : null,
      })
    }
  }
  return out
}

// ── Scoped (per-show) sync helpers ───────────────────────────────────────────
// order/list carries no room id and no room filter, so a show's orders are isolated
// by time-bounding the pull then matching room ids resolved via order/get. This buffer
// pads the show window for late payments / unpaid→paid lag.
export const SHOW_SYNC_BUFFER_MS = 6 * 60 * 60 * 1000

/** True once a (newest-first) page contains an order placed before sinceMs — the signal
 *  to stop paging order/list for a time-bounded pull. */
export function pageReachedSince(orders: MappedOrder[], sinceMs: number): boolean {
  return orders.some((o) => o.placedAt != null && o.placedAt < sinceMs)
}

/** Merge order/get detail (roomId + video receipt ts) into the list-derived orders, keyed
 *  by externalOrderId. Returns new objects; inputs untouched. */
export function applyOrderDetails(orders: MappedOrder[], details: Map<string, OrderDetail>): MappedOrder[] {
  return orders.map((o) => {
    const d = details.get(o.externalOrderId)
    if (!d) return { ...o }
    return {
      ...o,
      roomId: d.roomId ?? o.roomId,
      videoReceiptTs: d.receiptTsMs ?? o.videoReceiptTs,
    }
  })
}

/** Keep orders belonging to a show: room id in `roomIds`, OR room-less orders placed inside
 *  the [startMs, endMs] window (cancelled / non-auction orders carry no room id). */
export function filterOrdersForShow(
  orders: MappedOrder[],
  roomIds: string[],
  startMs: number,
  endMs: number,
): MappedOrder[] {
  const rooms = new Set(roomIds)
  return orders.filter((o) => {
    if (o.roomId && rooms.has(o.roomId)) return true
    if (!o.roomId && o.placedAt != null && o.placedAt >= startMs && o.placedAt <= endMs) return true
    return false
  })
}

/** Time-bounded order pull: pages order/list newest-first (sort_info '6') and stops once a
 *  page contains an order placed before `sinceMs`. Cookie auth only — same as pullTiktokOrders.
 *  Returns every order pulled up to (and including) the boundary page; caller filters/enriches. */
export async function pullTiktokOrdersSince(
  cookieHeader: string,
  sinceMs: number,
  onPage?: (pulled: number, total: number) => void,
): Promise<{ orders: MappedOrder[]; total: number; stopped: boolean }> {
  const all: MappedOrder[] = []
  let offset = 0, total = 0, guard = 0, stopped = false
  const count = 50
  while (guard < 400) {
    guard++
    const res = await fetch(ORDER_LIST_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json',
        origin: 'https://seller-us.tiktok.com', referer: 'https://seller-us.tiktok.com/order',
        'user-agent': UA, cookie: cookieHeader,
      },
      body: JSON.stringify({
        sort_info: '6', search_condition: { condition_list: {} },
        count, pagination_type: 0, offset, extra_data_list: TT_ORDER_EXTRA_DATA,
      }),
    })
    if (!res.ok) throw new Error(`order/list HTTP ${res.status}`)
    const text = await res.text()
    const j = JSON.parse(text.replace(/"live_room_id":\s*(\d+)/g, '"live_room_id":"$1"')) as Raw
    if (j.code !== 0 && j.code != null) {
      throw new Error(`order/list code ${j.code} — ${String(j.message ?? 'rejected')} (session may be expired — re-open the monitor and log in)`)
    }
    const data = (j.data as Raw) || {}
    const batch = ((data.main_orders as Raw[]) || []).map(mapTiktokOrder)
    all.push(...batch)
    total = Number(data.total_count || 0)
    onPage?.(all.length, total)
    if (pageReachedSince(batch, sinceMs)) { stopped = true; break }
    offset += count
    if (!(data.has_more && batch.length && offset < total + count)) break
  }
  return { orders: all, total, stopped }
}
