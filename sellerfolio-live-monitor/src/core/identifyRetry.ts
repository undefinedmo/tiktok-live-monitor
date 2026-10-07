// Retry after an outage: which rows a retry can start from, and which of them "Retry all" takes. A ten-minute
// connection blip in the middle of a show leaves 20-30 lots failed; re-arming each by hand, during the show,
// was the only way. Pure: the renderer supplies the rows and the set of orders that have a clip kept on disk.

type RetryRow = { orderId?: string; status: string; sale?: unknown; atEpochSec?: number; edited?: boolean }

/**
 * Is there anything to retry this row FROM? The sale in memory (the clip is cut again from the buffer), or a
 * clip kept on disk (a row restored after a restart has no sale, but its clip may still be there). Never for a
 * row with no order, nor one still being identified.
 */
export function canRetry(r: RetryRow, kept: ReadonlySet<string>): boolean {
  if (!r.orderId || r.status === 'transcribing') return false
  return kept.has(r.orderId) || !!r.sale
}

/**
 * The rows "Retry all failed" takes: failures (`error`) that can be retried, oldest sale first. Not skipped
 * (nothing identifiable in the clip: asking again says the same), not abandoned (the show ended before the lot
 * was reached: it has its own Retry), not one an operator corrected by hand.
 */
export function bulkRetryTargets<R extends RetryRow>(rows: readonly R[], kept: ReadonlySet<string>): R[] {
  return rows
    .filter((r) => r.status === 'error' && !r.edited && canRetry(r, kept))
    .sort((a, b) => (a.atEpochSec ?? Infinity) - (b.atEpochSec ?? Infinity))
}

/** The bulk button's words. Armed, it asks again: every retry can cost a model call on the server. */
export function retryAllLabel(count: number, armed: boolean): string {
  return armed ? `Confirm: retry ${count}` : `Retry ${count} failed`
}
