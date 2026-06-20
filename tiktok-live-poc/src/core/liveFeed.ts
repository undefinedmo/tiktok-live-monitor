// Routes a decoded frontier JSON payload to normalized LiveEvents and derives
// SaleEvents by diffing per-product `sales` counts across frames. Stateful
// (holds previous counts) — one instance per session. Portable: no electron/DOM.

import type {
  CoreStatsEvent,
  LiveEvent,
  Money,
  ProductStat,
  ProductStatsSnapshot,
  RoomEvent,
  SaleEvent,
  SessionEvent,
} from './types'
import { parseMoney } from './money'

type Json = Record<string, unknown>
const obj = (v: unknown): Json | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function money(v: unknown): Money | undefined {
  const m = obj(v)
  const formatted = str(m?.['amount_formatted'])
  return formatted ? parseMoney(formatted) : undefined
}

export class LiveFeed {
  private prev = new Map<string, ProductStat>()

  ingest(payload: unknown, ts: number): LiveEvent[] {
    const events: LiveEvent[] = []
    const root = obj(payload)
    if (!root) return events

    // room — wrapped `live_room_info`, or a bare `{room_id, create_timestamp}`.
    const room = obj(root['live_room_info']) ?? (root['room_id'] && root['create_timestamp'] ? root : undefined)
    const roomId = str(room?.['room_id'])
    if (roomId) events.push({ kind: 'room', roomId, ts } satisfies RoomEvent)

    // core stats — wrapped `live_core_stats`, or a bare top-level stats frame.
    const core = obj(root['live_core_stats']) ?? (root['current_viewers'] !== undefined ? root : undefined)
    if (core) events.push(this.mapCore(core, ts))

    // session
    const session = obj(root['current_session'])
    if (session) {
      events.push({
        kind: 'session',
        id: str(session['id']),
        name: str(session['name']),
        status: num(session['live_session_status']),
        ts,
      } satisfies SessionEvent)
    }

    // product stats — nested `live_product_stats.product_stats` or top-level.
    const ps = obj(obj(root['live_product_stats'])?.['product_stats']) ?? obj(root['product_stats'])
    if (ps) events.push(...this.ingestProductStats(ps, ts))

    return events
  }

  private mapCore(core: Json, ts: number): CoreStatsEvent {
    return {
      kind: 'core_stats',
      viewers: num(core['current_viewers']),
      impressions: num(core['impressions']),
      productClicks: num(core['product_clicks']),
      sales: num(core['sales']),
      gmv: money(core['gmv_local']),
      gpm: money(core['show_gpm_local']),
      ts,
    }
  }

  private ingestProductStats(ps: Json, ts: number): LiveEvent[] {
    const out: LiveEvent[] = []
    const seeded = this.prev.size > 0
    for (const [productId, raw] of Object.entries(ps)) {
      const v = obj(raw)
      const sales = num(v?.['sales']) ?? 0
      const clicks = num(v?.['product_clicks']) ?? 0
      const prevSales = this.prev.get(productId)?.sales ?? 0
      if (seeded && sales > prevSales) {
        out.push({ kind: 'sale', productId, delta: sales - prevSales, totalForProduct: sales, ts } satisfies SaleEvent)
      }
      this.prev.set(productId, { productId, sales, clicks })
    }
    const products = [...this.prev.values()]
    const totalSold = products.reduce((n, p) => n + p.sales, 0)
    out.push({ kind: 'product_stats', products, totalSold, ts } satisfies ProductStatsSnapshot)
    return out
  }
}
