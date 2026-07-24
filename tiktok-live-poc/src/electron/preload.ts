import { ipcRenderer } from 'electron'
import { webcastState, ecStreamerKey } from '../core/chat'
import { parseWonFeedRow } from '../core/wonFeed'

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
  if (/pin\/get/.test(url)) return 'pin'
  if (/live_session\/list/.test(url)) return 'session_list'
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
// until polling starts, ask live_session/list every 5s via the page's signed
// fetch. The fetch hook above forwards each response to main ('session_list'),
// where the newest LIVE room (start+during ≈ now) starts the poll config.
const bootTimer = setInterval(() => {
  if (polling) { clearInterval(bootTimer); return }
  const q = '?aid=253642&app_name=i18n_ecom_alliance&device_platform=web&user_language=en&locale=en&page_scene=0&carrier_region=us'
  void window
    .fetch('https://shop.tiktok.com/api/v1/streamer_desktop/live_session/list' + q, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tt-store-region': 'us' },
      body: JSON.stringify({ page_size: 5, cur_page: 1, search_type: 2, search_order: 2, with_reservations: false }),
    })
    .catch(() => {})
}, 5000)

// ── Active polling (production approach) ────────────────────────────────────
// Once main has room_id + session_id (from the WS stream), poll the roster +
// sale-history endpoints ourselves via the page's own fetch — TikTok's SDK wraps
// window.fetch to add the request signing (X-Bogus/msToken/X-Gnarly), and our
// fetch hook above forwards the responses to main like any dashboard-issued poll.
let polling = false
let runCycle: (() => Promise<void>) | null = null // set once polling starts; lets a manual Sync force a cycle
ipcRenderer.on('tt-poll-now', () => { void runCycle?.() })
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
  // auction_result/get is paginated (count:100). New sales land on PAGE 0 (rows are
  // newest-first), so the 3s hot path fetches page 0 only — paging the ENTIRE show
  // history every cycle re-downloaded 131KB×N per 3s tick (measured live: 128 rows
  // across multiple pages at startup alone) and put the big parse on the critical
  // path. A deep sweep runs on the first cycle (seeds the backlog) and then every
  // 10th cycle (~30s) to reconcile payment-status flips on older rows. Each page's
  // response is forwarded to main by the fetch hook above; the core dedupes by
  // order_id, so re-fetched pages are harmless.
  // insights/room/status is a DIFFERENT app than the streamer_desktop endpoints
  // (aid=4068 i18n_ecom_shop, vertical=3) — using the alliance aid errors 98001xxx.
  const qStatus = `?user_language=en&locale=en&aid=4068&app_name=i18n_ecom_shop&device_platform=web&cookie_enabled=true&timezone_name=America/Chicago&vertical=3&carrier_region=us`
  const statusUrl = `https://shop.tiktok.com/api/v1/insights/workbench/live/detail/room/status${qStatus}`
  let statusTick = 0
  let resultSweep = 0
  const cycle = async () => {
    void window.fetch(`${base}/added_auction_product/list${q}`, post({ room_id: cfg.roomId, session_id: cfg.sessionId, page_scene: 1, offset: 0, count: 100, auction_page_type: 0 })).catch(() => {})
    // refresh the live video URL every ~5 cycles (~15s) — it is signed/expiring.
    if (statusTick++ % 5 === 0) {
      void window.fetch(statusUrl, post({ request: { room_filter: { room_id: cfg.roomId } } })).catch(() => {})
    }
    const deep = resultSweep++ % 10 === 0 // page 0 every cycle; full history every ~10th
    let offset = 0
    for (let guard = 0; guard < (deep ? 30 : 1); guard++) {
      let res: Response
      try {
        res = await window.fetch(`${base}/auction_result/get${q}`, post({ room_id: cfg.roomId, session_id: cfg.sessionId, auction_page_type: 0, offset, count: 100 }))
      } catch {
        break
      }
      let more = false
      try { more = ((await res.clone().json()) as { has_more?: boolean }).has_more === true } catch { /* ignore */ }
      if (!more) break
      offset += 100
    }
  }
  runCycle = cycle
  void cycle()
  setInterval(() => void cycle(), 3000)

  // ── Pin poll (the low-latency close signal) ────────────────────────────────
  // pin/get flips latest_auction_item.status 1→3 within ~0.5s of the gavel, which
  // a HAR capture measured at 6.0s and 7.3s AHEAD of the same sale appearing in
  // auction_result/get. We used to see pin only when the dashboard happened to ask
  // (gaps of 1-13s), so the lot overlay went stale and labels waited on the slow
  // path. Poll it ourselves: it's a GET, ~1.6KB, and page-context fetch gets it
  // signed by TikTok's SDK like every other call here. The fetch hook forwards the
  // response to main, where AuctionWatch turns the 1→3 edge into an auction-closed.
  const PIN_MS = 700 // worst-case detection lag; ~1.6KB/req is cheap next to the 131KB result pages
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
        const code = Number(JSON.parse(body)?.code ?? 0)
        if (code !== 0) { pinErr++; ipcRenderer.send('tt-pin-diag', { kind: 'code', code, body: body.slice(0, 300), n: pinErr }) }
        else if (++pinOk % 20 === 1) ipcRenderer.send('tt-pin-diag', { kind: 'ok', n: pinOk })
      }
    } catch (e) {
      pinErr++
      ipcRenderer.send('tt-pin-diag', { kind: 'throw', error: String((e as Error)?.message ?? e), n: pinErr })
    } finally { pinInFlight = false }
  }
  void pinCycle()
  setInterval(() => void pinCycle(), PIN_MS)

  // ── Chat poll ──────────────────────────────────────────────────────────────
  // webcast/im/fetch is params-only (no cookies/signing — verified), so we poll it
  // ourselves, threading cursor + internal_ext from each response. The fetch hook above
  // forwards every response to main → decodeChat → render; here we read it only to advance
  // the cursor and honor the server's fetchInterval. The dashboard's own view doesn't fire
  // this endpoint, so without our poll chat never flows.
  const chatStatic =
    `aid=253642&app_name=i18n_ecom_alliance&version_code=260000&device_platform=web&app_language=en` +
    `&webcast_language=en&identity=anchor&live_id=12&resp_content_type=protobuf&fetch_rule=1` +
    `&history_comment_count=100&sup_ws_ds_opt=1&did_rule=3&cookie_enabled=true`
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
