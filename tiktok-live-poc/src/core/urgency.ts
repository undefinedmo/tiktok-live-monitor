import type { OrderDeadlines, Urgency } from './types'

export interface UrgencyWindows {
  shipSoonMs?: number   // "ship-soon" if the ready-to-ship deadline is within this window (default 24h)
  autoCancelMs?: number // "auto-cancel-risk" if auto-cancel is within this window (default 24h)
}

const DAY = 24 * 60 * 60 * 1000

/**
 * Bucket an order by ship-deadline pressure. Priority: auto-cancel-risk > overdue > ship-soon > ok.
 * Pure — pass `now` (epoch ms). No deadlines → 'ok'.
 */
export function urgency(d: OrderDeadlines | undefined, now: number, w: UrgencyWindows = {}): Urgency {
  if (!d) return 'ok'
  const shipSoonWin = w.shipSoonMs ?? DAY
  const autoCancelWin = w.autoCancelMs ?? DAY
  if (d.autoCancelMs != null && d.autoCancelMs - now <= autoCancelWin) return 'auto-cancel-risk'
  if (d.latestRtsMs != null && now > d.latestRtsMs) return 'overdue'
  if (d.latestRtsMs != null && d.latestRtsMs - now <= shipSoonWin) return 'ship-soon'
  return 'ok'
}
