import { ipcRenderer } from 'electron'

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
  return null
}

const OrigFetch = window.fetch
window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
  let url = ''
  try { url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url } catch { /* ignore */ }
  const ep = endpointOf(url)
  const p = OrigFetch.apply(this as never, arguments as never) as Promise<Response>
  if (ep) p.then((res) => res.clone().text().then((body) => ipcRenderer.send('tt-rest-data', { endpoint: ep, body })).catch(() => {})).catch(() => {})
  return p
} as typeof window.fetch

const OrigOpen = XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  const ep = endpointOf(String(url))
  if (ep) {
    this.addEventListener('load', () => {
      try {
        if (this.responseType === '' || this.responseType === 'text') {
          ipcRenderer.send('tt-rest-data', { endpoint: ep, body: this.responseText })
        }
      } catch { /* ignore */ }
    })
  }
  return (OrigOpen as (...a: unknown[]) => void).call(this, method, url, ...rest)
}

// ── Active polling (production approach) ────────────────────────────────────
// Once main has room_id + session_id (from the WS stream), poll the roster +
// sale-history endpoints ourselves via the page's own fetch — TikTok's SDK wraps
// window.fetch to add the request signing (X-Bogus/msToken/X-Gnarly), and our
// fetch hook above forwards the responses to main like any dashboard-issued poll.
let polling = false
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
  // auction_result/get is paginated (count:100); page through `has_more` so the
  // per-product / per-buyer / failed-payment rollups are complete on long shows.
  // Each page's response is forwarded to main by the fetch hook above; the core
  // dedupes by order_id, so re-fetched pages are harmless.
  const cycle = async () => {
    void window.fetch(`${base}/added_auction_product/list${q}`, post({ room_id: cfg.roomId, session_id: cfg.sessionId, page_scene: 1, offset: 0, count: 100, auction_page_type: 0 })).catch(() => {})
    let offset = 0
    for (let guard = 0; guard < 30; guard++) {
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
  void cycle()
  setInterval(() => void cycle(), 3000)
})

ipcRenderer.send('tt-status', { status: 'connecting' })
