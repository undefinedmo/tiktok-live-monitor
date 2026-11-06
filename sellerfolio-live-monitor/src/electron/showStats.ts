// LANE G — "Sales so far" and the show timeline from SellerFolio hq, polled in main.
//
//   GET {base}/api/desktop/show-stats?roomId=<room>  → ShowStats         every 30 s
//   GET {base}/api/desktop/timeline?roomId=<room>    → { timeline }      every 60 s, ONLY while the
//                                                                         timeline panel is open
// Auth exactly like buyer-history: Bearer sfm_… + X-SF-Device (main's sfHeaders). Only while this
// computer holds a computer token and a room is known. Never on the print path: one request at a
// time, async, timed out, and every failure is swallowed into a feed state the renderer draws.
//   404/405/501 (an hq without the route) → state 'unavailable', ask again in 10 min
//   401/403 → state 'auth', ask again in 5 min (main's whoami owns the connection itself)
//   400 → this room id is not one hq accepts → treated like unavailable for this room
//   network / 5xx / 429 → state 'error', keep the last figures, back off 30 s → 5 min
// A new room (or a new token / base URL) resets everything.
//
// Channels:
//   invoke 'show:get' → { stats: FeedView<HqShowStats>, timeline: FeedView<ShowTimeline> }
//   invoke 'show:timeline-open' (open: boolean) — the renderer's panel opened/closed
//   event  'show:stats'    FeedView<HqShowStats>     main → viewer
//   event  'show:timeline' FeedView<ShowTimeline>    main → viewer

import { ipcMain } from 'electron'
import { backoffMs, classifyStatus } from '../core/buyerTags'
import { parseShowStats, type FeedState, type FeedView, type HqShowStats } from '../core/showStats'
import { parseTimeline, type ShowTimeline } from '../core/timelineLayout'

export const SHOW_STATS_PATH = '/api/desktop/show-stats'
export const TIMELINE_PATH = '/api/desktop/timeline'

export const STATS_EVERY_MS = 30_000
export const TIMELINE_EVERY_MS = 30_000 // only while the Timeline screen is showing
/** How often main re-checks the room / connection without any network (cheap). */
export const HEARTBEAT_MS = 5_000
export const UNAVAILABLE_RETRY_MS = 10 * 60_000
export const AUTH_PAUSE_MS = 5 * 60_000
export const MAX_BACKOFF_MS = 5 * 60_000
export const REQUEST_TIMEOUT_MS = 10_000

export interface ShowStatsDeps {
  /** Full hq URL for a path, or null when the base URL is not one we send a token to. */
  url: (path: string) => string | null
  /** Bearer sfm_… + X-SF-Device, or null when this computer has no computer token. */
  headers: () => Record<string, string> | null
  /** The current room id. */
  show: () => string | undefined
  send: (channel: string, ...args: unknown[]) => void
  log: (line: string) => void
}

export interface ShowStatsEnv {
  fetch: (url: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal; redirect: 'error' }) => Promise<{ status: number; json: () => Promise<unknown> }>
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (h: unknown) => void
}

type Kind = 'stats' | 'timeline'

interface Feed<T> {
  state: FeedState
  data: T | null
  at: number | null
  nextAt: number
  failures: number
  quiet: boolean // logged the current non-ok state already
}

export interface ShowStatsPoller {
  snapshot: () => { stats: FeedView<HqShowStats>; timeline: FeedView<ShowTimeline> }
  setTimelineOpen: (open: unknown) => void
  /** Run a check now (tests; also used on open). */
  tick: () => Promise<void>
  stop: () => void
}

export function createShowStats(d: ShowStatsDeps, env: ShowStatsEnv): ShowStatsPoller {
  const fresh = <T>(state: FeedState): Feed<T> => ({ state, data: null, at: null, nextAt: 0, failures: 0, quiet: false })
  let room: string | undefined
  let targetKey = ''
  let gen = 0
  let stats = fresh<HqShowStats>('off')
  let timeline = fresh<ShowTimeline>('off')
  let timelineOpen = false
  let busy = false
  let timer: unknown = null
  let stopped = false

  const log = (line: string): void => { try { d.log(`[show-stats] ${line}`) } catch { /* never */ } }
  const view = <T>(f: Feed<T>): FeedView<T> => ({ room: room ?? null, state: f.state, data: f.data, at: f.at })
  const push = (k: Kind): void => {
    try { d.send(k === 'stats' ? 'show:stats' : 'show:timeline', k === 'stats' ? view(stats) : view(timeline)) } catch { /* never */ }
  }

  function target(): { headers: Record<string, string>; key: string } | null {
    try {
      const headers = d.headers()
      const probe = d.url(SHOW_STATS_PATH)
      if (!headers || !probe) return null
      return { headers, key: `${probe}\n${headers['authorization'] ?? headers['Authorization'] ?? ''}` }
    } catch {
      return null
    }
  }

  /** Room / connection changes: reset and tell the renderer. Returns the target to use, or null. */
  function sync(): { headers: Record<string, string> } | null {
    let r: string | undefined
    try { r = d.show() || undefined } catch { r = room }
    const t = target()
    const key = t ? t.key : ''
    if (r !== room || key !== targetKey) {
      room = r
      targetKey = key
      gen++
      const st: FeedState = !t ? 'off' : 'waiting'
      stats = fresh(st)
      timeline = fresh(st)
      push('stats'); push('timeline')
    }
    if (!t || !room) {
      const st: FeedState = !t ? 'off' : 'waiting'
      if (stats.state !== st) { stats = fresh(st); push('stats') }
      if (timeline.state !== st) { timeline = fresh(st); push('timeline') }
      return null
    }
    return t
  }

  async function get(k: Kind, path: string, headers: Record<string, string>): Promise<void> {
    const f = (k === 'stats' ? stats : timeline) as Feed<unknown>
    const base = d.url(path)
    if (!base || !room) return
    const myGen = gen
    const every = k === 'stats' ? STATS_EVERY_MS : TIMELINE_EVERY_MS
    let status: number | 'network' = 'network'
    let body: unknown = null
    const ctl = new AbortController()
    const to = env.setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await env.fetch(`${base}?roomId=${encodeURIComponent(room)}`, { method: 'GET', headers: { ...headers, accept: 'application/json' }, signal: ctl.signal, redirect: 'error' })
      status = res.status
      if (status >= 200 && status < 300) { try { body = await res.json() } catch { status = 'network' } }
    } catch {
      status = 'network'
    } finally {
      try { env.clearTimeout(to) } catch { /* ignore */ }
    }
    if (myGen !== gen) return //                     the room or token changed meanwhile: stale
    const now = env.now()
    let outcome = classifyStatus(status)
    let parsed: unknown = null
    if (outcome === 'ok') {
      parsed = k === 'stats' ? parseShowStats(body) : parseTimeline(body)
      if (!parsed) outcome = 'retry'
    }
    if (outcome === 'ok') {
      if (f.state !== 'ok' && f.quiet) log(`${k}: answering again`)
      f.state = 'ok'; f.data = parsed; f.at = now; f.failures = 0; f.quiet = false
      f.nextAt = now + every
    } else if (outcome === 'unavailable' || outcome === 'bad') {
      f.state = 'unavailable'; f.data = null; f.at = null
      f.nextAt = now + UNAVAILABLE_RETRY_MS
      if (!f.quiet) log(`${k}: hq has no ${path} for this room (HTTP ${status}); asking again in 10 min`)
      f.quiet = true
    } else if (outcome === 'auth') {
      f.state = 'auth'
      f.nextAt = now + AUTH_PAUSE_MS
      if (!f.quiet) log(`${k}: hq refused the computer token (HTTP ${status}); paused 5 min`)
      f.quiet = true
    } else {
      f.failures++
      f.state = 'error' //                            keep the last figures; the renderer marks them stale
      f.nextAt = now + backoffMs(f.failures, every, MAX_BACKOFF_MS)
      if (f.failures === 1 || f.failures % 10 === 0) log(`${k}: failed (${status === 'network' ? 'network / bad body' : `HTTP ${status}`}), try ${f.failures}`)
      f.quiet = true
    }
    push(k)
  }

  async function tick(): Promise<void> {
    if (busy || stopped) return
    busy = true
    try {
      const t = sync()
      if (t) {
        if (env.now() >= stats.nextAt) await get('stats', SHOW_STATS_PATH, t.headers)
        const t2 = sync() //                           the first await may have outlived the room
        if (t2 && timelineOpen && env.now() >= timeline.nextAt) await get('timeline', TIMELINE_PATH, t2.headers)
      }
    } catch (e) {
      log(`tick failed: ${String(e)}`)
    } finally {
      busy = false
      schedule(HEARTBEAT_MS)
    }
  }

  function schedule(ms: number): void {
    if (stopped) return
    if (timer !== null) { try { env.clearTimeout(timer) } catch { /* ignore */ } }
    timer = env.setTimeout(() => { timer = null; void tick() }, ms)
  }

  schedule(0)

  return {
    snapshot: () => ({ stats: view(stats), timeline: view(timeline) }),
    setTimelineOpen: (open) => {
      const was = timelineOpen
      timelineOpen = open === true
      if (timelineOpen && !was && !busy) schedule(0) //  first paint as soon as the panel opens
    },
    tick,
    stop: () => { stopped = true; if (timer !== null) { try { env.clearTimeout(timer) } catch { /* ignore */ } timer = null } },
  }
}

let instance: ShowStatsPoller | null = null

/** Called once from main.ts (the lane G block). */
export function registerShowStatsIpc(d: ShowStatsDeps): void {
  instance = createShowStats(d, {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  })
  ipcMain.handle('show:get', () => {
    try { return instance?.snapshot() ?? null } catch { return null }
  })
  ipcMain.handle('show:timeline-open', (_e, open: unknown) => {
    try { instance?.setTimelineOpen(open) } catch { /* never */ }
    return true
  })
}
