// Pure time-gap clustering of orders into LIVE sessions — ported from live-ledger's sessions.ts.
// A new session starts when the gap from the previous order exceeds the threshold. TikTok orders
// without a live_room_id carry no show key, so a "show" is reconstructed from when they were placed.
// Zero electron/DOM deps so it stays unit-testable.

import type { Sale } from './types'

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

export interface DerivedShow {
  id: string // roomId, or `live-<sec>` for a fallback (no-room-id) cluster
  title: string // group's liveTag text if present, else deriveTitle(startMs)
  startMs: number // earliest createdAt in the group
  endMs: number // latest createdAt in the group
  count: number // number of orders
}

/** Group synced orders into shows. Orders with a live_room_id group by that room (the authoritative
 *  show key); orders without one are time-gap clustered into derived date-titled shows.
 *  Returns the shows (most recent first) plus an orderId -> showId map for filtering. */
export function deriveShowsFromOrders(sales: Sale[]): {
  shows: DerivedShow[]
  showIdByOrder: Map<string, string>
} {
  const showIdByOrder = new Map<string, string>()
  const groups = new Map<string, Sale[]>() // showId -> sales

  // 1. Orders WITH a room id group by room id.
  const noRoom: Sale[] = []
  for (const s of sales) {
    if (s.roomId) {
      const g = groups.get(s.roomId) ?? []
      g.push(s)
      groups.set(s.roomId, g)
      showIdByOrder.set(s.orderId, s.roomId)
    } else {
      noRoom.push(s)
    }
  }

  // 2. Orders WITHOUT a room id: time-gap cluster into fallback shows.
  const saleById = new Map(noRoom.map((s) => [s.orderId, s] as const))
  for (const session of clusterByTime(noRoom.map((s) => ({ id: s.orderId, t: s.createdAt })))) {
    const id = derivedShowId(session.startMs)
    const g = groups.get(id) ?? []
    for (const oid of session.ids) {
      g.push(saleById.get(oid)!)
      showIdByOrder.set(oid, id)
    }
    groups.set(id, g)
  }

  // 3. Build per-group metadata.
  const shows: DerivedShow[] = []
  for (const [id, g] of groups) {
    let startMs = Infinity
    let endMs = -Infinity
    let title = ''
    for (const s of g) {
      if (s.createdAt < startMs) startMs = s.createdAt
      if (s.createdAt > endMs) endMs = s.createdAt
      // first non-empty liveTag in the group wins (a room's orders share one tag)
      if (!title && s.liveTag) title = s.liveTag
    }
    if (!title) title = deriveTitle(startMs)
    shows.push({ id, title, startMs, endMs, count: g.length })
  }

  shows.sort((a, b) => b.startMs - a.startMs)
  return { shows, showIdByOrder }
}
