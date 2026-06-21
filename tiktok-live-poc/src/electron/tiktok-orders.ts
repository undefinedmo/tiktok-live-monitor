// TikTok Shop order pull — ported from live-ledger/server/src/tiktok.ts.
// The Seller-Center fulfillment endpoints authenticate with the session COOKIES alone
// (no X-Bogus/msToken signing — verified empirically by live-ledger), so we can pull the
// real order book headlessly from Electron's main process. This is independent of any
// live stream: it's the seller's order history, the source for the Order Ledger.

import type { Sale } from '../core/types'

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
  totalCents: number
  liveTag: string | null
  isAuction: boolean
  isReversed: boolean
  placedAt: number | null
  items: { productName: string | null; variant: string | null; quantity: number }[]
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
    productName: (get(s, 'product_name') ?? null) as string | null,
    variant: (get(s, 'sku_name') ?? get(s, 'seller_sku_name') ?? null) as string | null,
    quantity: num(get(s, 'quantity')) ?? 0,
  }))

  return {
    externalOrderId: String(get(o, 'main_order_id') ?? get(o, 'note_module.main_order_id') ?? ''),
    status,
    statusCode: code || null,
    buyerHandle: (get(o, 'buyer_info_module.buyer_nickname') as string) || null,
    buyerName: addr.name || (get(o, 'buyer_info_module.actual_buyer_nickname') as string) || null,
    totalCents: cents(get(o, 'price_module.grand_total')),
    liveTag: liveTagText(o),
    isAuction: !!get(o, 'extra_data_map.auction_tag'),
    isReversed: !!rev,
    placedAt: ts(get(o, 'trade_order_module.create_time') ?? get(o, 'fulfillment_module.0.create_time')),
    items,
  }
}

/** Map a Seller-Center order → the PoC's Sale shape used by the Ledger/Picklist. */
export function orderToSale(o: MappedOrder): Sale {
  const item = o.items[0]
  const productName = item?.productName ?? '(item)'
  const paymentStatus: Sale['paymentStatus'] =
    o.isReversed ? 'failed' : o.status === 'Unpaid' ? 'pending' : 'paid'
  return {
    orderId: o.externalOrderId,
    buyer: { username: o.buyerName || o.buyerHandle || '—', handle: o.buyerHandle ?? undefined },
    productId: productName, // no stable product id in order/list; group bins by name
    productName,
    skuDesc: item?.variant ?? (o.items.length > 1 ? `${o.items.length} items` : ''),
    price: { cents: o.totalCents, formatted: '$' + (o.totalCents / 100).toFixed(2) },
    paymentStatus,
    createdAt: o.placedAt ?? Date.now(),
    liveTag: o.liveTag ?? undefined,
  }
}

export const ORDER_LIST_URL =
  'https://seller-us.tiktok.com/api/fulfillment/na/order/list?aid=4068&app_name=i18n_ecom_shop&device_platform=web'

const TT_ORDER_EXTRA_DATA = [
  '48_hours_dispatch_tag', 'split_combine_tag_v1', 'free_sample_tag_v1', 'hazmat_order_tag',
  'made_to_order_tag', 'pre_order_tag', 'pre_sell_tag', 'zero_lottery_tag', 'gift_insurance_tag',
  'internal_purchase_tag', 'risk_order_tag_v1', 'combo_sku_tag', 'refundable_sample_tag',
  'split_package_type_tag',
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
    const j = (await res.json()) as Raw
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
