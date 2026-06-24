// Pure parser for TikTok's streamer_desktop/live_session/list response. Turns the raw
// signed-endpoint payload into clean ShowListings, and exposes the time window + the
// roomId→name lookup used to title derived shows. Zero electron/DOM deps.

export interface ShowListing {
  sessionId: string        // session id (short, e.g. "4389560838")
  name: string             // the show name shown in the picker
  startTime: number        // unix SECONDS (session start)
  durationSec: number
  description?: string
  eventId: string          // 19-digit
  roomIds: string[]         // live_room_infos[].room_id (0..n) — matches orders' live_room_id
  productCnt?: number
  reservations?: number
}

export type RoomNameMeta = { sessionId: string; name: string; startMs: number }

type Raw = Record<string, unknown>
function get(o: Raw, path: string): unknown {
  try { return path.split('.').reduce<unknown>((a, k) => (a == null ? a : (a as Raw)[k]), o) } catch { return undefined }
}
function intOr(v: unknown, fallback: number): number {
  const n = parseInt(String(v), 10)
  return Number.isNaN(n) ? fallback : n
}

/** Parse a raw live_session/list response body. 19-digit room_id/event_id are quoted
 *  before JSON.parse so V8 doesn't round them. Returns [] on error code / bad text. */
export function parseShowList(rawText: string): ShowListing[] {
  let j: Raw
  try {
    j = JSON.parse(rawText.replace(/"(room_id|event_id)":\s*(\d+)/g, '"$1":"$2"')) as Raw
  } catch {
    return []
  }
  if (j.code !== 0 && j.code != null) return []
  const sessions = (get(j, 'data.live_sessions') as Raw[]) || []
  return sessions.map((s): ShowListing => {
    const rooms = (get(s, 'live_room_infos') as Raw[]) || []
    const desc = get(s, 'description')
    return {
      sessionId: String(get(s, 'id') ?? ''),
      name: String(get(s, 'name') ?? ''),
      startTime: intOr(get(s, 'start_time'), 0),
      durationSec: intOr(get(s, 'during_time'), 0),
      description: typeof desc === 'string' && desc.length ? desc : undefined,
      eventId: String(get(s, 'event_id') ?? ''),
      roomIds: rooms.map((r) => String((r as Raw).room_id)).filter((id) => id && id !== 'undefined'),
      productCnt: get(s, 'session_statistic.product_cnt') != null ? intOr(get(s, 'session_statistic.product_cnt'), 0) : undefined,
      reservations: get(s, 'num_reservations') != null ? intOr(get(s, 'num_reservations'), 0) : undefined,
    }
  })
}

/** The show's [start, end] in unix MS (used to bound the order pull). */
export function showWindowMs(s: ShowListing): { startMs: number; endMs: number } {
  return { startMs: s.startTime * 1000, endMs: (s.startTime + s.durationSec) * 1000 }
}

/** roomId → {sessionId, name, startMs} for every room across all shows. */
export function roomNameMap(shows: ShowListing[]): Map<string, RoomNameMeta> {
  const m = new Map<string, RoomNameMeta>()
  for (const s of shows) {
    for (const roomId of s.roomIds) {
      m.set(roomId, { sessionId: s.sessionId, name: s.name, startMs: s.startTime * 1000 })
    }
  }
  return m
}
