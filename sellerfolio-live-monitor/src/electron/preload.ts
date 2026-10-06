import { ipcRenderer } from 'electron'
import { webcastState, ecStreamerKey } from '../core/chat'
import { parseWonFeedRow } from '../core/wonFeed'
import { nextPinDelayMs, FINALIZE_LAG_MS } from '../core/pinSchedule'

// Runs in the monitor window (contextIsolation:false, so this shares the page's
// main world and can wrap the page's own WebSocket + XHR/fetch). Forwards three
// data sources to main, where the testable core/ runs:
//   1. frontier WebSocket frames  → aggregate live stats
//   2. added_auction_product/list → product names + auction roster
//   3. auction_result/get         → per-sale/buyer/order history
// No decoding here — raw bytes / response text go to main.

// ── 1. WebSocket (frontier live stats) ──────────────────────────────────────
const OrigWS = window.WebSocket
window.WebSocket = function (this: unknown, url: string | URL, protocols?: string | string[]) {
  const u = String(url)
  const ws = new OrigWS(url, protocols)
  ws.binaryType = 'arraybuffer'
  ws.addEventListener('open', () => ipcRenderer.send('tt-status', { status: 'connecting', detail: 'socket open' }))
  ws.addEventListener('message', (ev: MessageEvent) => {
    try {
      if (ev.data instanceof ArrayBuffer && ev.data.byteLength) {
        ipcRenderer.send('tt-ws-frame', { url: u, data: new Uint8Array(ev.data) })
      }
    } catch {
      /* ignore */
    }
  })
  return ws
} as unknown as typeof WebSocket
;(window.WebSocket as unknown as { prototype: unknown }).prototype = OrigWS.prototype

// ── 2 & 3. REST poll responses (roster + sale history) ──────────────────────
// The dashboard polls these while the live/auction view is open; we observe its
// own (TikTok-signed) requests rather than issuing our own.
function endpointOf(url: string): string | null {
  if (/live_auction\/auction_result\/get/.test(url)) return 'auction_result'
  if (/added_auction_product\/list/.test(url)) return 'roster'
  if (/live\/detail\/room\/status/.test(url)) return 'room_status'
  if (/live\/detail\/trend\/chart/.test(url)) return 'trend'
  if (/pin\/get/.test(url)) return 'pin'
  if (/live_room_info\/get/.test(url)) return 'live_room_info'
  return null
}

const OrigFetch = window.fetch
window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
  let url = ''
  try { url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url } catch { /* ignore */ }
  const ep = endpointOf(url)
  const p = OrigFetch.apply(this as never, arguments as never) as Promise<Response>
  if (ep) p.then((res) => res.clone().text().then((body) => ipcRenderer.send('tt-rest-data', { endpoint: ep, body })).catch(() => {})).catch(() => {})
  // The chat protobuf (webcast/im/fetch) is fetched via window.fetch, not XHR — capture it here
  // too (the XHR hook below only catches the arraybuffer-responseType case).
  else if (/webcast\/im\/fetch/.test(url)) {
    p.then((res) => res.clone().arrayBuffer().then((buf) => { if (buf.byteLength) ipcRenderer.send('tt-im-frame', new Uint8Array(buf)) }).catch(() => {})).catch(() => {})
  }
  return p
} as typeof window.fetch

const OrigOpen = XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  const u = String(url)
  const ep = endpointOf(u)
  if (ep) {
    this.addEventListener('load', () => {
      try {
        if (this.responseType === '' || this.responseType === 'text') {
          ipcRenderer.send('tt-rest-data', { endpoint: ep, body: this.responseText })
        }
      } catch { /* ignore */ }
    })
  } else if (/webcast\/im\/fetch/.test(u)) {
    // viewer comment stream (protobuf). Forward raw bytes to main for decoding.
    this.addEventListener('load', () => {
      try {
        const r = this.response
        if (r instanceof ArrayBuffer && r.byteLength) ipcRenderer.send('tt-im-frame', new Uint8Array(r))
      } catch { /* ignore */ }
    })
  }
  return (OrigOpen as (...a: unknown[]) => void).call(this, method, url, ...rest)
}

// ── 2b. On-screen "won" feed (DOM MutationObserver) ─────────────────────────
// The dashboard paints "<name> won auction item <n> …" the instant an auction
// closes — ~4s before that winner appears in auction_result/get (server-side
// floor). We watch those rows and forward each NEW winner to main; the renderer
// can print off this (opt-in "Live feed" mode) for near-zero label latency.
// Selector/wording per the Winner Capture README — update WON_FEED_SELECTOR here
// if TikTok renames the markup. De-duped by auction#+name so re-renders don't spam.
const WON_FEED_SELECTOR = '[data-tid="m4b_overflow_text_signle"]'
const wonSeen = new Set<string>()
// DEBUG: emit diagnostics so we can see WHERE the feed lives when the observer catches
// nothing (iframe / shadow DOM / wrong selector / wrong view). Was forced ON for the
// 1.2.7-debug prerelease; reverted, since every hit cost a synchronous appendFileSync
// on the main process — the same thread that dispatches labels.
const WON_DEBUG = !!process.env.TT_DEBUG
function reportWin(text: string): void {
  const win = parseWonFeedRow(text)
  if (WON_DEBUG) ipcRenderer.send('tt-won-debug', { kind: 'hit', text: text.slice(0, 100), parsed: win })
  if (!win) return
  const key = `${win.auctionNo}|${win.name}`
  if (wonSeen.has(key)) return
  wonSeen.add(key)
  if (wonSeen.size > 1000) wonSeen.delete(wonSeen.values().next().value as string)
  ipcRenderer.send('tt-won-feed', win)
}
function scanWonNodes(root: Element): void {
  if (root.matches?.(WON_FEED_SELECTOR)) reportWin(root.textContent ?? '')
  const found = root.querySelectorAll?.(WON_FEED_SELECTOR)
  if (found) found.forEach((n) => reportWin(n.textContent ?? ''))
}
const wonObserver = new MutationObserver((records) => {
  for (const rec of records) {
    rec.addedNodes.forEach((node) => {
      if (node.nodeType === 1) scanWonNodes(node as Element)
    })
  }
})
let wonStarted = false
function startWonObserver(): void {
  if (wonStarted) return
  const target = document.documentElement || document.body
  if (!target) return
  wonStarted = true
  wonObserver.observe(target, { childList: true, subtree: true })
}
startWonObserver()
if (!wonStarted) document.addEventListener('DOMContentLoaded', startWonObserver, { once: true })

// DEBUG probe (TT_DEBUG=1): every 5s, report where "won auction item" text lives so we
// can localize the miss — my selector's match count, related data-tids, whether the text
// is in the top light DOM at all, shadow-root hosts, and iframes (same/cross-origin).
if (WON_DEBUG) {
  const wonDiag = (): Record<string, unknown> => {
    const out: Record<string, unknown> = { kind: 'probe', url: location.href, observerStarted: wonStarted }
    try { out.selectorMatches = document.querySelectorAll(WON_FEED_SELECTOR).length } catch { out.selectorMatches = 'err' }
    try { out.lightWonText = /won auction item/i.test(document.body?.innerText || '') } catch { out.lightWonText = 'err' }
    const tids = new Set<string>()
    const samples: unknown[] = []
    let shadowHosts = 0, shadowWon = 0
    try {
      const all = document.querySelectorAll('*')
      for (let i = 0; i < all.length; i++) {
        const el = all[i] as HTMLElement
        const tid = el.getAttribute?.('data-tid')
        if (tid && /overflow|m4b|auction|win|bid/i.test(tid)) tids.add(tid)
        const sr = el.shadowRoot
        if (sr) { shadowHosts++; try { if (/won auction item/i.test(sr.textContent || '')) shadowWon++ } catch { /* ignore */ } }
        if (samples.length < 4) {
          const txt = (el.textContent || '').trim()
          if (txt.length > 0 && txt.length < 120 && /won auction item/i.test(txt) && el.children.length <= 2) {
            samples.push({ tag: el.tagName, tid: tid || null, cls: String(el.className || '').slice(0, 70), text: txt.slice(0, 90) })
          }
        }
      }
    } catch (e) { out.scanErr = String(e) }
    out.relatedTids = [...tids].slice(0, 30)
    out.samples = samples
    out.shadowHosts = shadowHosts
    out.shadowWon = shadowWon
    const iframes = Array.from(document.querySelectorAll('iframe'))
    out.iframeCount = iframes.length
    out.iframes = iframes.slice(0, 10).map((f) => {
      try {
        const d = f.contentDocument
        if (!d) return { crossOrigin: true }
        return { sameOrigin: true, won: /won auction item/i.test(d.body?.innerText || ''), sel: d.querySelectorAll(WON_FEED_SELECTOR).length }
      } catch { return { crossOrigin: true } }
    })
    return out
  }
  setTimeout(() => ipcRenderer.send('tt-won-debug', wonDiag()), 3000)
  setInterval(() => ipcRenderer.send('tt-won-debug', wonDiag()), 5000)
}

// ── Room/session bootstrap fallback (REST) ──────────────────────────────────
// The frontier WS yields room_id+session_id only on the event dashboard, and only
// reliably when the app is open BEFORE go-live. Launched mid-show, the page gets
// redirected to /streamer/live/session and the app never connects (observed live
// 2026-07-24: no room → polls never start → no close signals → no labels). So
// until polling starts, ask live_room_info/get every 5s via the page's signed
// fetch — it returns the CURRENT live room + session directly (verified live:
// room_id + current_session{id, live_session_status:11} while streaming; NOTE
// live_session/list search_type:2 does NOT list the live session — past only).
// The fetch hook above forwards each response to main ('live_room_info').
const bootTimer = setInterval(() => {
  if (polling) { clearInterval(bootTimer); return }
  const q = '?aid=253642&app_name=i18n_ecom_alliance&device_platform=web&user_language=en&locale=en&page_scene=0&carrier_region=us'
  void window.fetch('https://shop.tiktok.com/api/v1/streamer_desktop/live_room_info/get' + q).catch(() => {})
}, 5000)

// ── Active polling (production approach) ────────────────────────────────────
// Once main has room_id + session_id (from the WS stream), poll the roster +
// sale-history endpoints ourselves via the page's own fetch — TikTok's SDK wraps
// window.fetch to add the request signing (X-Bogus/msToken/X-Gnarly), and our
// fetch hook above forwards the responses to main like any dashboard-issued poll.
let polling = false
let runCycle: (() => Promise<void>) | null = null // set once polling starts; lets a manual Sync force a cycle
let kickPin: (() => void) | null = null // set once polling starts; pulls the next pin poll forward
ipcRenderer.on('tt-poll-now', () => { void runCycle?.() })

// ── Request budget ───────────────────────────────────────────────────────────
// Measured over one 23-minute show: 6030 requests, ~4.4/sec sustained, from a single
// authenticated session — a 700ms pin poll, a 1.5s roster+orders cycle (halved from 3s for
// label latency), a ~1s chat poll, and a 30-page order sweep every 15s. TikTok answers a
// challenged session with a bare {"code":0} on EVERY endpoint until a puzzle is solved in
// the monitor window, and we kept hammering at full rate straight through it: 2231 of 2300
// pin responses in that show were empty. Polling a challenged endpoint 4×/sec is the surest
// way to keep the challenge up.
//
// So the loops below are self-scheduling rather than fixed setIntervals, and back off hard
// while gated. Nothing is lost by waiting: a gated response carries no data.
let gated = false
const THROTTLE = 8 // multiplier applied to every interval while a gate is up
const paced = (ms: number) => (gated ? ms * THROTTLE : ms)
/** Main owns the gate detection (it sees every endpoint); it tells us when to back off. */
ipcRenderer.on('tt-poll-gate', (_e, on: boolean) => { gated = !!on })
/** Self-scheduling loop: the delay is re-read every tick, so a gate slows it immediately. */
function everyPaced(fn: () => Promise<void> | void, ms: () => number): void {
  const tick = async () => {
    try { await fn() } catch { /* a failed cycle must not stop the loop */ }
    setTimeout(() => void tick(), paced(ms()))
  }
  setTimeout(() => void tick(), paced(ms()))
}
ipcRenderer.on('tt-poll-config', (_e, cfg: { roomId?: string; sessionId?: string }) => {
  if (polling || !cfg?.roomId || !cfg?.sessionId) return
  polling = true
  const base = 'https://shop.tiktok.com/api/v1/streamer_desktop/live_auction'
  const q =
    `?aid=253642&app_name=i18n_ecom_alliance&device_platform=web&user_language=en&locale=en` +
    `&session_id=${cfg.sessionId}&page_scene=1&carrier_region=us`
  const post = (body: object) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tt-store-region': 'us' },
    body: JSON.stringify(body),
  })
  // auction_result/get is paginated. Rows are NEWEST-FIRST, so the hot path needs only
  // the newest handful: the 1.5s cycle fetches a count:20 page 0 (~26KB), not the old
  // count:100 full-history pagination (131KB×N per tick — measured 128 rows re-downloaded
  // at startup alone). A deep count:100 sweep runs on the first cycle (seeds the backlog)
  // and every 10th (~15s) to reconcile payment-status flips on older rows. Each response
  // is forwarded to main by the fetch hook above; the core dedupes by order_id, so
  // re-fetched pages are harmless.
  // insights/room/status is a DIFFERENT app than the streamer_desktop endpoints
  // (aid=4068 i18n_ecom_shop, vertical=3) — using the alliance aid errors 98001xxx.
  const qStatus = `?user_language=en&locale=en&aid=4068&app_name=i18n_ecom_shop&device_platform=web&cookie_enabled=true&timezone_name=America/Chicago&vertical=3&carrier_region=us`
  const statusUrl = `https://shop.tiktok.com/api/v1/insights/workbench/live/detail/room/status${qStatus}`
  // Whole-show GMV / pace. The frontier WS that used to carry live_core_stats is dead, and
  // summing only the sales WE captured under-reports every show we join late. This series
  // is anchored to the session start, so it stays whole-show however late we attach.
  // ~16KB, and it only moves once a minute — a 30s poll (20 × 1.5s cycles) is plenty.
  const trendUrl = `https://shop.tiktok.com/api/v1/insights/workbench/live/detail/trend/chart${qStatus}`
  const TREND_STATS = [341, 342, 51, 84] // 341 = GMV, 342 = orders; 51/84 unmapped
  const trendBody = (statsTypes: number[]) => ({
    request: { room_filter: { room_id: cfg.roomId, country: 'US' }, stats_types: statsTypes },
  })
  let statusTick = 0
  let trendTick = 0
  let resultSweep = 0
  const cycle = async () => {
    void window.fetch(`${base}/added_auction_product/list${q}`, post({ room_id: cfg.roomId, session_id: cfg.sessionId, page_scene: 1, offset: 0, count: 100, auction_page_type: 0 }))
      .then((r) => r.clone().json())
      .then((j: { pinned_auction_config?: { latest_auction_item?: { status?: unknown } } }) => {
        if (Number(j?.pinned_auction_config?.latest_auction_item?.status) === 1) kickPin?.()
      })
      .catch(() => {})
    // refresh the live video URL every ~10 cycles (~15s) — it is signed/expiring.
    if (statusTick++ % 10 === 0) {
      void window.fetch(statusUrl, post({ request: { room_filter: { room_id: cfg.roomId } } })).catch(() => {})
    }
    if (trendTick++ % 20 === 0) {
      void window.fetch(trendUrl, post(trendBody(TREND_STATS))).catch(() => {})
    }
    const deep = resultSweep++ % 10 === 0 // count:20 page 0 every cycle; full history every ~10th
    const pageSize = deep ? 100 : 20
    let offset = 0
    // 6 pages, not 30. The sweep only exists to reconcile payment-status flips on rows we
    // already have, and 600 rows covers any real show; 30 pages was a burst of up to 30
    // requests every 15s on top of a session already running at ~4/sec. Bursts like that
    // are what a rate limiter notices.
    const DEEP_PAGES = 6
    for (let guard = 0; guard < (deep ? DEEP_PAGES : 1); guard++) {
      let res: Response
      try {
        res = await window.fetch(`${base}/auction_result/get${q}`, post({ room_id: cfg.roomId, session_id: cfg.sessionId, auction_page_type: 0, offset, count: pageSize }))
      } catch {
        break
      }
      let more = false
      try { more = ((await res.clone().json()) as { has_more?: boolean }).has_more === true } catch { /* ignore */ }
      if (!more) break
      offset += pageSize
    }
  }
  runCycle = cycle
  void cycle()
  // 1.5s (was 3s): the order row is the signal that actually fires live (im decode can
  // go silent; pin only covers pinned lots) and it lands 0.3-3s after the sale — a 3s
  // timer added up to 3s of pure wait on every label for no savings that matter.
  // 3s, back up from the 1.5s that halved it for label latency. A challenged session is
  // worth far more than 1.5s: the puzzle stops auto-printing ENTIRELY until a human solves
  // it, and it was firing every minute or so at the old rate. roster+auction_result are
  // ~70% of all requests, so this is the single biggest lever. Order rows still land
  // 0.3-3s after a sale, and the pin/im close paths are unaffected.
  const CYCLE_MS = 3000
  // Paced, so a verification gate stretches it further instead of pounding a dead endpoint.
  everyPaced(cycle, () => CYCLE_MS)

  // ── stats_type discovery sweep — REMOVED 2026-09-07 ────────────────────────
  // It walked stats_type ids 1..120 and 300..400 in chunks of 24 against trend/chart,
  // hunting the live viewer count that vanished when the frontier WS stopped carrying
  // live_core_stats. It ran once per session and never identified a viewer metric in any
  // flight log it produced.
  //
  // Enumerating undocumented API parameters is exactly the signature an abuse detector
  // looks for, and it rode on top of a session already issuing ~4.4 requests/sec. Whatever
  // else provokes TikTok's verification puzzle, this is not worth being on the list for a
  // result we never got. If the viewer count is wanted again, take it from a HAR of the
  // dashboard asking for it — do not brute-force the id space.

  // ── Pin poll (the low-latency close signal) ────────────────────────────────
  // pin/get flips latest_auction_item.status 1→3 within ~0.5s of the gavel, which
  // a HAR capture measured at 6.0s and 7.3s AHEAD of the same sale appearing in
  // auction_result/get. We used to see pin only when the dashboard happened to ask
  // (gaps of 1-13s), so the lot overlay went stale and labels waited on the slow
  // path. Poll it ourselves: it's a GET, ~1.6KB, and page-context fetch gets it
  // signed by TikTok's SDK like every other call here. The fetch hook forwards the
  // response to main, where AuctionWatch turns the 1→3 edge into an auction-closed.
  // Adaptive, because a flat 700ms was 1.43 req/sec on its own — a third of this session's
  // entire request budget, most of it spent watching nothing happen. The 700ms only buys
  // anything while a lot is actually running: that is when the 1→3 status flip we are
  // waiting for can occur. Between lots (no auction card, or one already closed) there is
  // no edge to catch, so poll lazily and step back up the moment a lot goes live. Worst
  // case for detection is unchanged at 700ms; the idle case drops ~4×.
  // The cadence itself now lives in core/pinSchedule (tested): flat while the end is far off,
  // then one poll aimed at expected end + TikTok's ~1s finalize lag, so the ended state is
  // caught when it first exists instead of up to an interval later.
  let pinLotLive = false
  let pinExpectedEndMs: number | undefined // server clock; only while a lot is bidding
  let pinServerOffsetMs: number | undefined // resp_server_time − local receive time
  let pinLateTries = 0
  let pinTimer: ReturnType<typeof setTimeout> | undefined
  const pinUrl =
    `https://shop.tiktok.com/api/v1/streamer_desktop/pin/get` +
    `?room_id=${cfg.roomId}&aid=253642&app_name=i18n_ecom_alliance&device_platform=web` +
    `&user_language=en&locale=en&page_scene=0&carrier_region=us&cookie_enabled=true`
  let pinInFlight = false
  let pinOk = 0
  let pinErr = 0
  const pinCycle = async () => {
    if (pinInFlight) return // a slow response must not stack up requests behind it
    pinInFlight = true
    try {
      const r = await window.fetch(pinUrl)
      // A non-2xx or a TikTok-level error code means our self-issued call is being
      // rejected (signing / params) — report it instead of silently degrading to
      // whatever pin responses the dashboard happens to make on its own.
      if (!r.ok) { pinErr++; ipcRenderer.send('tt-pin-diag', { kind: 'http', status: r.status, n: pinErr }) }
      else {
        const body = await r.clone().text()
        const json = JSON.parse(body)
        const code = Number(json?.code ?? 0)
        if (code !== 0) { pinErr++; ipcRenderer.send('tt-pin-diag', { kind: 'code', code, body: body.slice(0, 300), n: pinErr }) }
        else if (++pinOk % 20 === 1) ipcRenderer.send('tt-pin-diag', { kind: 'ok', n: pinOk })
        // status 1 = bidding. Only then is a close edge possible, so only then is the fast
        // cadence worth its request cost. Anything else (no card, already closed, gated
        // empty body) drops us to the idle rate until a lot goes live again.
        const item = json?.auction_config?.latest_auction_item
        pinLotLive = Number(item?.status) === 1
        const exp = Number(item?.expected_end_time_ms)
        pinExpectedEndMs = pinLotLive && exp > 0 ? exp : undefined
        const srv = Number(json?.resp_meta_data?.resp_server_time)
        if (srv > 0) pinServerOffsetMs = srv - Date.now()
      }
    } catch (e) {
      pinErr++
      ipcRenderer.send('tt-pin-diag', { kind: 'throw', error: String((e as Error)?.message ?? e), n: pinErr })
    } finally { pinInFlight = false }
  }
  // Self-scheduling like everyPaced, but with a handle: a roster response that shows a lot
  // going live can pull the next poll forward (kickPin) instead of waiting out the idle gap.
  const pinLoop = async () => {
    try { await pinCycle() } catch { /* a failed cycle must not stop the loop */ }
    const serverNowMs = pinServerOffsetMs === undefined ? undefined : Date.now() + pinServerOffsetMs
    const delay = nextPinDelayMs({ live: pinLotLive, expectedEndMs: pinExpectedEndMs, serverNowMs, lateTries: pinLateTries })
    const pastDue = pinLotLive && pinExpectedEndMs !== undefined && serverNowMs !== undefined &&
      serverNowMs >= pinExpectedEndMs + FINALIZE_LAG_MS
    pinLateTries = pastDue ? pinLateTries + 1 : 0
    pinTimer = setTimeout(() => void pinLoop(), paced(delay))
  }
  void pinLoop()
  // The roster rides the 3s cycle and carries the pinned lot's status too. When it shows a
  // lot bidding while we still think nothing is live, the idle poll could be up to 6s away —
  // most of a 7s auction. Bring it forward; no request is added, one is moved.
  kickPin = () => {
    if (pinLotLive || pinInFlight || gated) return
    if (pinTimer) clearTimeout(pinTimer)
    void pinLoop()
  }

  // ── Chat poll ──────────────────────────────────────────────────────────────
  // webcast/im/fetch is params-only (no cookies/signing — verified), so we poll it
  // ourselves, threading cursor + internal_ext from each response. The fetch hook above
  // forwards every response to main → decodeChat → render; here we read it only to advance
  // the cursor and honor the server's fetchInterval. The dashboard's own view doesn't fire
  // this endpoint, so without our poll chat never flows.
  // Params mirror the dashboard's own working request (2026-07-21 HAR) — including the
  // SECOND version_code (180800 = the webcast client's; 260000 = the app's). The capture
  // that delivered auction lifecycle messages had both; ours originally sent only 260000,
  // a suspect in the 2026-07-24 show where the im auction decode saw 0 events all night.
  const chatStatic =
    `version_code=180800&device_platform=web&cookie_enabled=true&tz_name=America/Chicago` +
    `&aid=253642&app_name=i18n_ecom_alliance&version_code=260000&app_language=en` +
    `&webcast_language=en&identity=anchor&live_id=12&resp_content_type=protobuf&fetch_rule=1` +
    `&history_comment_count=100&sup_ws_ds_opt=1&did_rule=3`
  let chatCursor = ''
  let chatExt = ''
  let ecKey = '' // per-streamer key (needed to POST chat); arrives in a room-init webcast response
  const chatCycle = async () => {
    const url =
      `https://webcast.us.tiktok.com/webcast/im/fetch/?${chatStatic}&room_id=${cfg.roomId}` +
      `&cursor=${encodeURIComponent(chatCursor)}&internal_ext=${encodeURIComponent(chatExt)}`
    let nextMs = 1000
    try {
      const res = await window.fetch(url)
      const buf = new Uint8Array(await res.clone().arrayBuffer())
      const st = webcastState(buf)
      if (st.cursor) chatCursor = st.cursor
      chatExt = st.internalExt
      if (st.fetchIntervalMs > 0) nextMs = st.fetchIntervalMs
      if (!ecKey) { const k = ecStreamerKey(buf); if (k) ecKey = k }
    } catch { /* ignore — try again next tick */ }
    setTimeout(() => void chatCycle(), Math.min(3000, Math.max(800, nextMs)))
  }
  void chatCycle()

  // ── Post a chat message (streamer) ───────────────────────────────────────────
  // POST /streamer_desktop/message/chat via the page's window.fetch — the TikTok SDK
  // auto-signs all streamer_desktop calls (X-Bogus/msToken), so we don't sign ourselves.
  ipcRenderer.on('tt-chat-send', (_e, req: { id?: number; text?: string }) => {
    const id = req?.id
    const content = String(req?.text ?? '').trim()
    if (!content || !cfg.roomId) { ipcRenderer.send('tt-chat-sent', { id, ok: false, error: 'no text or no room' }); return }
    if (!ecKey) { ipcRenderer.send('tt-chat-sent', { id, ok: false, error: 'streamer key not ready' }); return }
    const url =
      `https://shop.tiktok.com/api/v1/streamer_desktop/message/chat` +
      `?aid=253642&app_name=i18n_ecom_alliance&device_platform=web&user_language=en&locale=en&page_scene=1&carrier_region=us`
    const body = {
      content,
      meta: { source: 2, app_id: 253642, room_id: cfg.roomId, ec_streamer_key: ecKey },
      client_start_time_stamp_millisecond: String(Date.now()),
    }
    void window
      .fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tt-store-region': 'us' }, body: JSON.stringify(body) })
      .then((res) => res.json().catch(() => ({})))
      .then((j: { code?: number; message?: string }) => ipcRenderer.send('tt-chat-sent', { id, ok: j?.code === 0, error: j?.message }))
      .catch((e) => ipcRenderer.send('tt-chat-sent', { id, ok: false, error: String(e) }))
  })
})

ipcRenderer.send('tt-status', { status: 'connecting' })
