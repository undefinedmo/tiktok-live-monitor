// The Timeline screen's metrics strip, derived from SellerFolio's show timeline (the same payload the
// chart draws). Pure: no DOM, no clock — `nowMs` is passed in so the "last 15 min" cells are testable.
//
// Counting follows hq's chat insights: a run that closed with no sale seen ("unknown") counts as
// unsold — TikTok rarely reports unsold, so treating unknown as "maybe sold" would flatter every show.

import { fmtCents } from './showStats'
import type { ShowTimeline } from './timelineLayout'

export interface MetricCell {
  key: string
  label: string
  value: string
  /** Hover text: what the number means. */
  title: string
  /** Optional second line under the value. */
  sub?: string
}

export const RECENT_MS = 15 * 60_000

const int = (n: number): string => n.toLocaleString('en-US')
const pct = (num: number, den: number): string => (den > 0 ? `${Math.round((num / den) * 100)}%` : '—')

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** "1:05" for 65 s, "12:00" for 720 s. */
export function fmtLotTime(sec: number): string {
  const t = Math.max(0, Math.round(sec))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

export function timelineMetrics(t: ShowTimeline, nowMs: number): MetricCell[] {
  const runs = t.auctions
  const sold = runs.filter((a) => a.outcome === 'sold')
  const notSold = runs.length - sold.length
  const prices = sold.map((a) => a.priceCents).filter((c): c is number => c != null)
  const durations = runs.filter((a) => a.startMs != null && a.endMs > a.startMs!).map((a) => (a.endMs - a.startMs!) / 1000)
  const lot = median(durations)

  const first = runs.reduce<number | null>((m, a) => { const s = a.startMs ?? a.endMs; return m == null || s < m ? s : m }, null)
  const last = runs.reduce<number | null>((m, a) => (m == null || a.endMs > m ? a.endMs : m), null)
  const spanH = first != null && last != null ? (last - first) / 3_600_000 : 0

  const chatLines = t.chatBuckets.reduce((n, b) => n + b.viewerLines, 0)
  const peak = t.chatBuckets.reduce((m, b) => Math.max(m, b.viewerLines), 0)

  const recent = runs.filter((a) => a.endMs > nowMs - RECENT_MS && a.endMs <= nowMs)
  const recentSold = recent.filter((a) => a.outcome === 'sold').length

  const cells: MetricCell[] = [
    { key: 'runs', label: 'Lots run', value: int(runs.length), title: 'Auction runs this show (a lot re-run counts again)' },
    { key: 'sold', label: 'Sold', value: int(sold.length), title: 'Runs that ended in a sale' },
    { key: 'unsold', label: 'Not sold', value: int(notSold), title: 'Runs that closed with no sale seen' },
    { key: 'st', label: 'Sell-through', value: pct(sold.length, runs.length), title: 'Sold ÷ lots run' },
    {
      key: 'recent', label: 'Last 15 min', value: pct(recentSold, recent.length),
      sub: `${int(recentSold)} of ${int(recent.length)} sold`, title: 'Sell-through over the last 15 minutes',
    },
    { key: 'avg', label: 'Avg sale', value: prices.length ? fmtCents(Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)) : '—', title: 'Average price of the sold runs with a known price' },
    { key: 'top', label: 'Top sale', value: prices.length ? fmtCents(Math.max(...prices)) : '—', title: 'Highest single sale this show' },
    { key: 'lot', label: 'Typical lot', value: lot != null ? fmtLotTime(lot) : '—', title: 'Median time from auction start to close' },
    { key: 'pace', label: 'Lots / hr', value: spanH >= 0.1 ? int(Math.round(runs.length / spanH)) : '—', title: 'Lots run per hour, first run to latest' },
    { key: 'chat', label: 'Chat lines', value: int(chatLines), title: 'Viewer chat lines (your own and staff lines left out)' },
    { key: 'peak', label: 'Peak chat', value: peak ? `${int(peak)}/min` : '—', title: 'Busiest minute of chat' },
    { key: 'qs', label: 'Questions', value: int(t.questions.length), title: 'Viewer questions SellerFolio picked out of chat' },
    { key: 'flags', label: 'Flags', value: int(t.flags.length), title: 'Complaints or problems mentioned in chat' },
  ]
  return cells
}
