// LANE G — "Sales so far": the hq show-stats contract, its parser, and the strip's view model.
//
// Two sources, on purpose (measured 2026-11-05):
//   - TikTok's own whole-show series (insights trend/chart, parsed by liveTrend.ts and pushed by main
//     as `show_totals` every ~30 s) — GMV, orders and pace; ≤ 60 s fresh and right even when the app
//     attached mid-show. Runtime is insights room/status `duration`.
//   - SellerFolio hq `GET /api/desktop/show-stats?roomId=` — buyers, items sold, AOV (and hq's own GMV
//     as a cross-check). hq's order rows lag the show by 0.5–2 min, so its cells carry "as of hh:mm".
// When hq has no such route (404/501 — older hq) its cells are simply not drawn.
//
// Portable: no electron/DOM.

/** The wire shape of GET /api/desktop/show-stats (hq src/desktop/show-stats.ts ShowStats). */
export interface HqShowStatsWire {
  roomId: string
  asOf: string
  gmv: string
  orders: number
  itemsSold: number
  buyers: number
  aov: string | null
  firstOrderAt: string | null
  lastOrderAt: string | null
  sellingMinutes: number | null
  tiktok: unknown
}

/** Parsed and normalised: money in integer cents, times in epoch ms. */
export interface HqShowStats {
  roomId: string
  asOfMs: number
  gmvCents: number
  orders: number
  itemsSold: number
  buyers: number
  aovCents: number | null
  firstOrderAtMs: number | null
  lastOrderAtMs: number | null
  sellingMinutes: number | null
}

/** Where one of main's hq feeds stands. `off` = no computer token; `waiting` = no room yet / first ask
 *  pending; `unavailable` = hq without the route (404/501); `auth` = token refused; `error` = transient. */
export type FeedState = 'off' | 'waiting' | 'ok' | 'unavailable' | 'auth' | 'error'

/** What main pushes on `show:stats` / `show:timeline` (and returns from `show:get`). */
export interface FeedView<T> {
  room: string | null
  state: FeedState
  data: T | null
  /** When `data` was received (epoch ms), null without data. */
  at: number | null
}

/** "1234.50" → 123450. Null for anything that is not a plain decimal (never a fabricated zero). */
export function decimalToCents(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null)
const isoMs = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** Validate an hq reply. Null when it is not a show-stats body (the caller treats that as an error). */
export function parseShowStats(raw: unknown): HqShowStats | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const gmvCents = decimalToCents(r['gmv'])
  const orders = count(r['orders'])
  const itemsSold = count(r['itemsSold'])
  const buyers = count(r['buyers'])
  if (gmvCents === null || orders === null || itemsSold === null || buyers === null) return null
  const sm = r['sellingMinutes']
  return {
    roomId: typeof r['roomId'] === 'string' ? r['roomId'] : '',
    asOfMs: isoMs(r['asOf']) ?? 0,
    gmvCents,
    orders,
    itemsSold,
    buyers,
    aovCents: r['aov'] === null || r['aov'] === undefined ? null : decimalToCents(r['aov']),
    firstOrderAtMs: isoMs(r['firstOrderAt']),
    lastOrderAtMs: isoMs(r['lastOrderAt']),
    sellingMinutes: typeof sm === 'number' && Number.isFinite(sm) && sm >= 0 ? Math.floor(sm) : null,
  }
}

// ── formatting ────────────────────────────────────────────────────────────────────────────────

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

/** 123456 → "$1,234.56"; negatives keep their sign in front of the symbol. */
export function fmtCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  return `${sign}$${money.format(Math.abs(cents) / 100)}`
}
/** Whole dollars for a pace tile: 1234567 → "$12,346". */
export function fmtCentsWhole(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  return `${sign}$${whole.format(Math.round(Math.abs(cents) / 100))}`
}
export const fmtInt = (n: number): string => whole.format(n)

/** Runtime: "45m", "2h 05m"; under a minute "0m". */
export function fmtRuntime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

/** "2:05 PM" in this computer's zone. */
export function clockShort(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/** room/status `duration` is a snapshot; carry it forward on the local clock between polls. */
export function runtimeNow(base: { sec: number; atMs: number } | null, nowMs: number, liveStartedAtSec?: number): number | undefined {
  if (base && base.sec > 0) return base.sec + Math.max(0, (nowMs - base.atMs) / 1000)
  if (liveStartedAtSec && liveStartedAtSec > 0) {
    const s = nowMs / 1000 - liveStartedAtSec
    return s > 0 ? s : undefined
  }
  return undefined
}

// ── the strip's view model ────────────────────────────────────────────────────────────────────

export interface SalesInputs {
  /** From `show_totals` (TikTok's whole-show series). */
  tiktok: { gmvCents?: number; orders?: number; paceCents?: number }
  /** Stand-ins until show_totals lands / when hq is absent: what this app captured itself. */
  local: { gmvCents?: number; orders?: number; itemsSold?: number }
  runtimeSec?: number
  hq: FeedView<HqShowStats> | null
}

export interface SalesCell {
  key: 'gmv' | 'orders' | 'items' | 'buyers' | 'aov' | 'runtime' | 'pace'
  label: string
  value: string
  /** Hover text: where the number comes from (and hq's cross-check for GMV). */
  title: string
  /** Drawn from hq (SellerFolio) — gets the subtle "as of" treatment. */
  hq: boolean
}

export interface SalesView {
  cells: SalesCell[]
  /** "as of 2:05 PM" when any hq cell is drawn, else null. */
  asOf: string | null
  /** A short note for the head when hq is not answering, else null. */
  note: string | null
}

const HQ_LAG = 'SellerFolio receives orders 0.5–2 min after TikTok'

/** Cells in display order. hq cells are omitted when hq has no data (never a dash that looks like zero). */
export function buildSalesView(i: SalesInputs): SalesView {
  const hq = i.hq?.data ?? null
  const asOfMs = hq ? (hq.asOfMs || i.hq?.at || 0) : 0
  const asOf = hq && asOfMs ? `as of ${clockShort(asOfMs)}` : null
  const cells: SalesCell[] = []

  const ttGmv = i.tiktok.gmvCents
  const gmv = ttGmv ?? i.local.gmvCents
  const gmvSrc = ttGmv !== undefined
    ? "TikTok's whole-show GMV (updates about once a minute)"
    : 'Sales this app has seen so far (TikTok’s whole-show figure has not arrived yet)'
  const cross = hq ? ` · SellerFolio: ${fmtCents(hq.gmvCents)} ${asOf ?? ''} (${HQ_LAG})` : ''
  cells.push({ key: 'gmv', label: 'GMV', value: gmv !== undefined ? fmtCents(gmv) : '—', title: gmvSrc + cross, hq: false })

  const ttOrders = i.tiktok.orders
  const orders = ttOrders ?? i.local.orders
  cells.push({
    key: 'orders', label: 'Orders', value: orders !== undefined ? fmtInt(orders) : '—', hq: false,
    title: ttOrders !== undefined ? "TikTok's whole-show order count" + (hq ? ` · SellerFolio: ${fmtInt(hq.orders)} ${asOf ?? ''}` : '') : 'Orders this app has seen so far',
  })

  if (hq) {
    cells.push({ key: 'items', label: 'Items sold', value: fmtInt(hq.itemsSold), title: `Items sold, from SellerFolio ${asOf ?? ''} (${HQ_LAG})`, hq: true })
  } else if (i.local.itemsSold !== undefined) {
    cells.push({ key: 'items', label: 'Items sold', value: fmtInt(i.local.itemsSold), title: "TikTok's sold count for this show", hq: false })
  }
  if (hq) {
    cells.push({ key: 'buyers', label: 'Buyers', value: fmtInt(hq.buyers), title: `Different buyers, from SellerFolio ${asOf ?? ''}`, hq: true })
    cells.push({ key: 'aov', label: 'AOV', value: hq.aovCents !== null ? fmtCents(hq.aovCents) : '—', title: `Average order value (GMV ÷ orders), from SellerFolio ${asOf ?? ''}`, hq: true })
  }

  const rt = i.runtimeSec
  cells.push({ key: 'runtime', label: 'Runtime', value: rt !== undefined ? fmtRuntime(rt) : '—', title: 'How long the show has been live (TikTok’s count)', hq: false })

  let pace = i.tiktok.paceCents
  if (pace === undefined && gmv !== undefined && rt !== undefined && rt >= 60) pace = Math.round((gmv * 3600) / rt)
  cells.push({ key: 'pace', label: 'GMV / hr', value: pace !== undefined ? fmtCentsWhole(pace) : '—', title: 'GMV per hour over the whole show so far', hq: false })

  let note: string | null = null
  const st = i.hq?.state
  if (!hq && st === 'auth') note = 'SellerFolio refused this computer'
  else if (hq && st === 'error') note = 'SellerFolio not answering — last figures shown'
  return { cells, asOf, note }
}
