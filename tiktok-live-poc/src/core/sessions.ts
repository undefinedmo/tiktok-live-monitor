// Pure time-gap clustering of orders into LIVE sessions — ported from live-ledger's sessions.ts.
// A new session starts when the gap from the previous order exceeds the threshold. TikTok orders
// without a live_room_id carry no show key, so a "show" is reconstructed from when they were placed.
// Zero electron/DOM deps so it stays unit-testable.

export const SESSION_GAP_MS = 2.5 * 60 * 60 * 1000 // 2.5h — same threshold live-ledger uses

export interface ClusterItem {
  id: string
  t: number // epoch milliseconds
}

export interface Session {
  startMs: number
  endMs: number
  ids: string[]
}

/** Group items into sessions by time gap. Items without a finite timestamp are dropped. */
export function clusterByTime(items: ClusterItem[], gapMs: number = SESSION_GAP_MS): Session[] {
  const sorted = items.filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t)
  const sessions: Session[] = []
  let cur: Session | null = null
  for (const x of sorted) {
    if (!cur || x.t - cur.endMs > gapMs) {
      cur = { startMs: x.t, endMs: x.t, ids: [] }
      sessions.push(cur)
    }
    cur.endMs = x.t
    cur.ids.push(x.id)
  }
  return sessions
}

/** Stable id for a derived (no-room-id) show, keyed on the session start second so re-clustering
 *  the same orders maps to the same show id (idempotent). */
export function derivedShowId(startMs: number): string {
  return `live-${Math.floor(startMs / 1000)}`
}

/** Human title for a derived show when no live-show tag is available. */
export function deriveTitle(startMs: number): string {
  return 'LIVE · ' + new Date(startMs).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}
