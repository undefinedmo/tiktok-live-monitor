// Parses `insights/workbench/live/detail/trend/chart` — TikTok's own per-minute series
// for the CURRENT live session.
//
// Why this exists: GMV/pace used to come from `live_core_stats` on the frontier
// WebSocket, which no longer delivers (see main.ts "the dead WS sold-tick"). Falling back
// to summing the sales we captured ourselves under-reports any show where the app was
// started mid-stream — it can only see orders from the moment it attached.
//
// The chart's window is anchored to the SESSION START and grows (measured: 30 points at
// 18:24 → 31 points at 18:25, first key pinned at the show's 17:54 start), so summing it
// yields whole-show totals no matter when we attached. `firstPointMs` is exported so the
// caller can assert that anchor still holds on long shows — if TikTok ever caps the
// series, the first key will start moving and the total silently becomes a window.
//
// Portable: no electron/DOM.

import type { Money } from './types'

/** stats_type IDs. 341/342 confirmed by value shape (money / integer counts). The other
 *  two the dashboard requests are still unmapped — 51 counts something per minute
 *  (16,14,17,19…) and 84 is a rate near 0.04. Probe with `probeStatsTypes()`. */
export const STATS_GMV = 341
export const STATS_ORDERS = 342

export interface TrendPoint {
  atMs: number
  /** money series → cents; scalar series → the raw number */
  value: number
}

export interface TrendSeries {
  statsType: number
  points: TrendPoint[]
  /** sum across every point — the whole-session total for additive series */
  total: number
  /** the most recent non-empty bucket, for "right now" readouts */
  last: number
  isMoney: boolean
}

export interface TrendSnapshot {
  kind: 'trend'
  series: TrendSeries[]
  /** whole-show GMV (stats_type 341), summed across the session */
  gmv?: Money
  /** whole-show order count (stats_type 342) */
  orders?: number
  firstPointMs?: number
  lastPointMs?: number
  ts: number
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const numOf = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(typeof v === 'string' ? v : NaN)
  return Number.isFinite(n) ? n : 0
}

/** Sum cents per-point rather than summing floats then converting — 30+ buckets of
 *  "12.20"-style decimals otherwise drift by a cent or two across a long show. */
function pointValue(p: Json): { value: number; isMoney: boolean; symbol?: string } {
  const amount = obj(p['amount'])
  if (amount) {
    return {
      value: Math.round(numOf(amount['amount']) * 100),
      isMoney: true,
      symbol: typeof amount['currency_symbol'] === 'string' ? amount['currency_symbol'] : undefined,
    }
  }
  return { value: numOf(p['value']), isMoney: false }
}

export function parseTrend(raw: unknown, ts: number): TrendSnapshot | null {
  const data = obj(obj(raw)?.['data'])
  const trend = arr(data?.['trend_data'])
  if (!trend.length) return null

  let symbol = '$'
  const series: TrendSeries[] = []
  for (const t of trend) {
    const row = obj(t)
    if (!row) continue
    const statsType = numOf(row['stats_type'])
    const points: TrendPoint[] = []
    let isMoney = false
    let total = 0
    let last = 0
    for (const raw of arr(row['data'])) {
      const p = obj(raw)
      if (!p) continue
      const { value, isMoney: money, symbol: sym } = pointValue(p)
      if (money) { isMoney = true; if (sym) symbol = sym }
      // key is unix SECONDS as a string
      points.push({ atMs: numOf(p['key']) * 1000, value })
      total += value
      if (value) last = value
    }
    series.push({ statsType, points, total, last, isMoney })
  }
  if (!series.length) return null

  const gmvSeries = series.find((s) => s.statsType === STATS_GMV)
  const orderSeries = series.find((s) => s.statsType === STATS_ORDERS)
  const allPoints = series.flatMap((s) => s.points.map((p) => p.atMs)).filter((n) => n > 0)

  return {
    kind: 'trend',
    series,
    ...(gmvSeries ? { gmv: { cents: gmvSeries.total, formatted: formatCents(gmvSeries.total, symbol) } } : {}),
    ...(orderSeries ? { orders: orderSeries.total } : {}),
    ...(allPoints.length ? { firstPointMs: Math.min(...allPoints), lastPointMs: Math.max(...allPoints) } : {}),
    ts,
  }
}

export function formatCents(cents: number, symbol = '$'): string {
  return symbol + (cents / 100).toFixed(2)
}

/** GMV per hour over the session's real elapsed time — the "pace" tile.
 *  `elapsedSec` comes from insights room/status `data.duration`, which counts the whole
 *  show, so pace stays correct when the app attaches late. Returns undefined below a
 *  minute of runtime, where dividing by a near-zero window produces a nonsense rate. */
export function paceCentsPerHour(gmvCents: number, elapsedSec: number | undefined): number | undefined {
  if (!elapsedSec || elapsedSec < 60) return undefined
  return Math.round((gmvCents * 3600) / elapsedSec)
}
