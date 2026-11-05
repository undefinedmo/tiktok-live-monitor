// LANE D — buyer past-order counts from SellerFolio hq (BUILD.md "hq endpoint").
// The renderer asks for ttuids (buyerAPI.lookup); this batches them (core/buyerTags.batchBuyerIds,
// ≤ 200 per request, ~300 ms after the first new id), POSTs `{ buyerIds, showStartedAtMs }` to
// /api/desktop/buyer-history with the computer token, caches the answers PER SHOW (a new room
// clears the cache — counts are "orders before this show started"), and pushes new counts to the
// viewer. Never on the print path: every request is async and best-effort, one at a time; a
// failure leaves ids unknown (no badge) and is retried with backoff. Not connected (no sfm_
// token), or an hq without the endpoint (404/501) → nothing is sent and no badge shows.
//
// Channels (fixed by the scaffold — keep the names):
//   invoke 'buyer:lookup' (ids: string[]) → { counts: Record<ttuid, number> }  (cached ones, now)
//   event  'buyer:counts' ({ counts, reset? }) main → viewer — new counts; `reset: true` = a new
//          show started, forget every count you hold first.

import { ipcMain } from 'electron'
import { backoffMs, batchBuyerIds, BUYER_HISTORY_MAX_IDS, classifyStatus, isBuyerId, parseCounts } from '../core/buyerTags'

export const BUYER_HISTORY_PATH = '/api/desktop/buyer-history'

/** Wait after the first unseen id so a burst of sales goes in one request. */
export const BATCH_DELAY_MS = 300
/** Per-request timeout. */
export const REQUEST_TIMEOUT_MS = 8_000
/** An hq without the endpoint (404/501): ask again after this long (it may be deployed mid-show). */
export const UNAVAILABLE_PAUSE_MS = 30 * 60_000
/** 401/403: the connection logic owns that; we just stay quiet at least this long. */
export const AUTH_PAUSE_MS = 5 * 60_000
/** Bound on ids waiting to be asked about (a runaway caller cannot grow memory). */
export const MAX_PENDING = 5_000

export interface BuyerHistoryDeps {
  /** Full hq URL for BUYER_HISTORY_PATH, or null when the base URL is not one we send a token to. */
  url: () => string | null
  /** Auth headers (Bearer sfm_… + X-SF-Device), or null when this computer has no computer token. */
  headers: () => Record<string, string> | null
  /** The current show's key (room id). A change empties the cache. */
  show: () => string | undefined
  /**
   * When the current show started (epoch ms), if main knows it. Optional: without it the first
   * moment this module saw the show's key is sent instead (a slight over-count when the app
   * was started mid-show: that show's earlier orders then count as "past").
   */
  showStartedAtMs?: () => number | undefined
  /** main.ts viewerSend. */
  send: (channel: string, ...args: unknown[]) => void
  /** Flight log line. */
  log: (line: string) => void
}

/** The outside world, injectable for tests. */
export interface BuyerHistoryEnv {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' }) => Promise<{ status: number; json: () => Promise<unknown> }>
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (h: unknown) => void
}

export interface BuyerHistory {
  /** Cached counts for these ids now; unknown ones are queued for hq. Never throws. */
  lookup: (ids: unknown) => { counts: Record<string, number> }
  /** For tests / diagnostics. */
  state: () => { show: string | undefined; known: number; pending: number; inFlight: number; pausedUntil: number; failures: number }
}

export function createBuyerHistory(d: BuyerHistoryDeps, env: BuyerHistoryEnv): BuyerHistory {
  let showKey: string | undefined
  let showSeenAt = env.now()
  let gen = 0
  const counts = new Map<string, number>()
  const skip = new Set<string>() //       ids hq would not answer this show (400 batch / missing in reply)
  const pending = new Set<string>() //    insertion-ordered queue
  const inFlight = new Set<string>()
  let busy = false
  let timer: unknown = null
  let timerDue = 0
  let failures = 0
  let retryAt = 0 //                      while failures > 0: no request before this (the backoff)
  let pausedUntil = 0
  let pauseKey = '' //                    url+auth the pause applies to; a new token/url lifts it
  let quietLogged = false

  const log = (line: string): void => { try { d.log(`[buyer-history] ${line}`) } catch { /* never */ } }
  const send = (payload: { counts: Record<string, number>; reset?: boolean }): void => {
    try { d.send('buyer:counts', payload) } catch { /* never */ }
  }

  function syncShow(): void {
    let k: string | undefined
    try { k = d.show() } catch { k = showKey }
    if (k === showKey) return
    const hadAny = counts.size > 0
    showKey = k
    showSeenAt = env.now()
    gen++
    counts.clear(); skip.clear(); pending.clear(); inFlight.clear()
    failures = 0
    if (hadAny) send({ counts: {}, reset: true })
  }

  function target(): { url: string; headers: Record<string, string>; key: string } | null {
    try {
      const url = d.url()
      const headers = d.headers()
      if (!url || !headers) return null
      return { url, headers, key: `${url}\n${headers['authorization'] ?? headers['Authorization'] ?? ''}` }
    } catch {
      return null
    }
  }

  function schedule(delayMs: number): void {
    // While retrying, nothing (e.g. a new id's 300 ms batch delay) may pull the request in ahead of
    // the backoff: the later due time wins.
    const backoff = failures > 0 ? retryAt : 0
    const due = Math.max(env.now() + delayMs, pausedUntil, backoff)
    if (timer !== null) {
      if (timerDue <= due && timerDue >= backoff) return
      try { env.clearTimeout(timer) } catch { /* ignore */ }
    }
    timerDue = due
    timer = env.setTimeout(() => { timer = null; void flush() }, Math.max(0, due - env.now()))
  }

  function startedAt(): number | undefined {
    let t: number | undefined
    try { t = d.showStartedAtMs?.() } catch { t = undefined }
    if (typeof t === 'number' && Number.isFinite(t) && t > 0) return t
    return showKey !== undefined ? showSeenAt : undefined
  }

  async function flush(): Promise<void> {
    if (busy) return
    syncShow()
    if (pending.size === 0) return
    const t = target()
    if (!t) { pending.clear(); return } //   not connected: nothing to do; the renderer asks again later
    if (pauseKey && pauseKey !== t.key) { pausedUntil = 0; pauseKey = '' }
    if (env.now() < pausedUntil) { schedule(0); return }
    if (failures > 0 && env.now() < retryAt) { schedule(0); return }

    const [batch = []] = batchBuyerIds([...pending], new Set([...counts.keys(), ...skip, ...inFlight]), BUYER_HISTORY_MAX_IDS)
    for (const id of batch) pending.delete(id)
    if (batch.length === 0) { pending.clear(); return }
    for (const id of batch) inFlight.add(id)
    busy = true
    const myGen = gen
    const body: { buyerIds: string[]; showStartedAtMs?: number } = { buyerIds: batch }
    const since = startedAt()
    if (since !== undefined) body.showStartedAtMs = since

    let status: number | 'network' = 'network'
    let reply: unknown = null
    const ctl = new AbortController()
    const to = env.setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await env.fetch(t.url, {
        method: 'POST',
        headers: { ...t.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
        redirect: 'error',
      })
      status = res.status
      if (status >= 200 && status < 300) { try { reply = await res.json() } catch { status = 'network' } }
    } catch {
      status = 'network'
    } finally {
      try { env.clearTimeout(to) } catch { /* ignore */ }
    }

    busy = false
    if (myGen !== gen) { if (pending.size) schedule(0); return } //   the show changed meanwhile: these answers are stale
    for (const id of batch) inFlight.delete(id)

    const outcome = classifyStatus(status)
    if (outcome === 'ok') {
      const got = parseCounts(reply)
      const fresh: Record<string, number> = {}
      for (const id of batch) {
        const n = got[id]
        if (n === undefined) { skip.add(id); continue }
        counts.set(id, n)
        fresh[id] = n
      }
      if (failures > 0 || quietLogged) log(`answering again (${batch.length} ids)`)
      failures = 0; quietLogged = false; pausedUntil = 0; pauseKey = ''
      if (Object.keys(fresh).length) send({ counts: fresh })
      if (pending.size) schedule(0)
      return
    }
    if (outcome === 'bad') {
      for (const id of batch) skip.add(id)
      log(`hq refused a batch of ${batch.length} ids (HTTP ${status}); not asking for them again this show`)
      if (pending.size) schedule(0)
      return
    }
    if (outcome === 'unavailable' || outcome === 'auth') {
      pausedUntil = env.now() + (outcome === 'unavailable' ? UNAVAILABLE_PAUSE_MS : AUTH_PAUSE_MS)
      pauseKey = t.key
      pending.clear() //                    the renderer asks again; nothing piles up meanwhile
      if (!quietLogged) log(outcome === 'unavailable'
        ? `hq has no buyer history (HTTP ${status}); badges off, asking again in 30 min`
        : `hq refused the computer token (HTTP ${status}); badges paused 5 min`)
      quietLogged = true
      return
    }
    // retry: put the batch back at the front, wait longer each time.
    failures++
    const rest = [...pending]
    pending.clear()
    for (const id of [...batch, ...rest].slice(0, MAX_PENDING)) pending.add(id)
    if (failures === 1 || failures % 10 === 0) log(`lookup failed (${status === 'network' ? 'network' : `HTTP ${status}`}), try ${failures}; retrying in ${Math.round(backoffMs(failures) / 1000)} s`)
    retryAt = env.now() + backoffMs(failures)
    schedule(backoffMs(failures))
  }

  function lookup(ids: unknown): { counts: Record<string, number> } {
    const out: Record<string, number> = {}
    try {
      syncShow()
      if (!Array.isArray(ids)) return { counts: out }
      let added = false
      for (const id of ids.slice(0, MAX_PENDING)) {
        if (!isBuyerId(id)) continue
        const n = counts.get(id)
        if (n !== undefined) { out[id] = n; continue }
        if (skip.has(id) || inFlight.has(id) || pending.has(id) || pending.size >= MAX_PENDING) continue
        pending.add(id)
        added = true
      }
      if (added && target()) schedule(BATCH_DELAY_MS)
      else if (added) pending.clear()
    } catch {
      /* never throw into the caller */
    }
    return { counts: out }
  }

  return {
    lookup,
    state: () => ({ show: showKey, known: counts.size, pending: pending.size, inFlight: inFlight.size, pausedUntil, failures }),
  }
}

let instance: BuyerHistory | null = null

/** Called once from main.ts (the "live-ui lanes" block). */
export function registerBuyerHistoryIpc(d: BuyerHistoryDeps): void {
  instance = createBuyerHistory(d, {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  })
  ipcMain.handle('buyer:lookup', (_e, ids: unknown) => {
    try { return instance ? instance.lookup(ids) : { counts: {} } } catch { return { counts: {} } }
  })
}
