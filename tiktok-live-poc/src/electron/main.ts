import { app, BrowserWindow, ipcMain, session, Menu, nativeTheme } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { parsePushFrame } from '../core/pushFrame'
import { LiveFeed } from '../core/liveFeed'
import { parseRoster } from '../core/roster'
import { parsePin } from '../core/pin'
import { AuctionResults } from '../core/auctionResults'
import { AuctionWatch } from '../core/auctionWatch'
import { decodeChat } from '../core/chat'
import { decodeAuctionIm } from '../core/auctionIm'
import { labelHtml, LABEL_SIZES, DEFAULT_TEMPLATE, type LabelData, type LabelTemplate } from './label'
import type { LiveEvent, StatusEvent, PinState } from '../core/types'

const DASHBOARD = 'https://shop.tiktok.com/streamer/live/event/dashboard'
// Set TT_START_URL to log in via Seller Center (https://seller-us.tiktok.com/) —
// its TikTok SSO session also covers the streamer dashboard.
const START_URL = process.env.TT_START_URL || DASHBOARD
const LOGIN_RE = /\/(login|passport|account\/login)/
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

let viewer: BrowserWindow | null = null
let monitor: BrowserWindow | null = null
const feed = new LiveFeed()
const auctionResults = new AuctionResults()
const auctionWatch = new AuctionWatch()
let lastPin: PinState | null = null // latest pin/get — attributes im auction.end closes to a lot number
const imSeen = new Set<string>() // dedupe im auction events across cursor replays/reconnects
// The lot currently being bid, from im Manager bid messages (leader + lot# per bid).
// auction.end carries no lot number — this attributes it without depending on pin/get.
let imCurrent: { lotNumber?: string; productName?: string; leader: string; ts: number } | null = null
let connected = false

// The monitor window uses a persisted session (persist:tiktok), so TikTok's auth
// cookies live in Electron directly — no browser extension bridge needed. We read
// them to verify login. NB: this confirms an authenticated session, but TikTok signs
// its API requests in-page (X-Bogus/msToken/…), so the actual order pulls still ride
// the monitor page's window.fetch — cookies alone can't drive the data sync.
const TT_PARTITION = 'persist:tiktok'
const AUTH_COOKIE_RE = /^(sessionid|sessionid_ss|sid_tt|sid_guard|uid_tt|store-idc|odin_tt)$/i
async function tiktokLoggedIn(): Promise<boolean> {
  try {
    const cookies = await session.fromPartition(TT_PARTITION).cookies.get({})
    return cookies.some((c) => AUTH_COOKIE_RE.test(c.name) && !!c.value)
  } catch {
    return false
  }
}
// Once the WS stream yields room_id + session_id, tell the preload to start
// polling the roster + sale-history REST endpoints itself.
let pollRoomId: string | undefined
let pollSessionId: string | undefined
let pollSent = false
let lastSalePollNow = 0 // debounce WS-sale-triggered immediate polls
let endPollTimer: ReturnType<typeof setTimeout> | undefined // one-shot poll at the lot's expected end
let endPollSig = '' // auctionConfigId|expectedEndMs the timer is armed for
function maybeStartPolling() {
  if (pollSent || !pollRoomId || !pollSessionId || !monitor) return
  pollSent = true
  debug(`[tt] start polling room=${pollRoomId} session=${pollSessionId}`)
  monitor.webContents.send('tt-poll-config', { roomId: pollRoomId, sessionId: pollSessionId })
}

// Optional raw capture for offline analysis (TT_CAPTURE=1).
const CAP_DIR = join(__dirname, '..', 'capture')
const CAP_WS = process.env.TT_CAPTURE ? join(CAP_DIR, 'ws-raw.ndjson') : null
const CAP_REST = process.env.TT_CAPTURE ? join(CAP_DIR, 'rest.ndjson') : null
const CAP_IM = process.env.TT_CAPTURE ? join(CAP_DIR, 'im-raw.ndjson') : null
if (process.env.TT_CAPTURE) { try { mkdirSync(CAP_DIR, { recursive: true }) } catch { /* ignore */ } }
function capture(file: string | null, rec: unknown) {
  if (!file) return
  try { appendFileSync(file, JSON.stringify(rec) + '\n') } catch { /* ignore */ }
}

const debug = (line: string) => { if (process.env.TT_DEBUG) console.log(line) }

// ── Label-latency instrumentation (TT_LAT=1 or TT_DEBUG=1) ───────────────────
// Times a live sale from the WS sold-count tick (A) → poll fired/debounced (B) →
// REST auction_result row arrives (C) → label queued/spooled (E), all on one
// process clock. Hop A's upstream (gavel→socket) is TikTok-side and unmeasurable
// here; we anchor at the tick. Zero overhead when the flag is off.
const TIMING = !!(process.env.TT_LAT || process.env.TT_DEBUG)
const lat = (line: string) => { if (TIMING) console.log(`[lat ${Date.now()}] ${line}`) }
let lastWsTickAt = 0 // ms of the most recent WS sold-count tick
let pinSamples = 0 // pin/get responses seen — proves the 700ms poll is actually feeding us
let lastPinSig = '' // last auctionConfigId|status, so we log edges not every sample
const saleSeenAt = new Map<string, number>() // item# → ms when main first produced the sale row

// Send to the dashboard ONLY when it's alive. `viewer?.` guards null but not a
// destroyed window — sending to a closed webContents throws in main (uncaught →
// the native crash dialog), which is what made the app unkillable on close.
function viewerSend(channel: string, ...args: unknown[]) {
  if (viewer && !viewer.isDestroyed() && !viewer.webContents.isDestroyed()) {
    viewer.webContents.send(channel, ...args)
  }
}
function send(ev: LiveEvent) {
  viewerSend('tt-live-event', ev)
}

function createViewer() {
  viewer = new BrowserWindow({
    width: 1200,
    height: 900,
    backgroundColor: '#07080b', // match the body so the frame/title bar reads dark
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload-viewer.cjs'),
      // Lets flv.js fetch the cross-origin, http:// live FLV from the file://
      // viewer page. PoC-only — a production app would proxy the stream.
      webSecurity: false,
    },
  })
  if (process.env.TT_DEBUG) {
    viewer.webContents.on('console-message', (_e, _level, message) => {
      if (message.startsWith('[render]')) console.log('[viewer]', message)
    })
  }
  void viewer.loadFile(join(__dirname, 'index.html'))
  // The dashboard IS the app. When it closes: clear the ref (so late WS/poll
  // events stop firing at a destroyed webContents) and quit so the hidden
  // monitor/seller windows go too and the process actually exits.
  viewer.on('closed', () => { viewer = null; app.quit() })
}

function createMonitor() {
  const part = session.fromPartition(TT_PARTITION)
  monitor = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#07080b',
    autoHideMenuBar: true,
    webPreferences: {
      session: part,
      // Preload must share the page's main world to wrap its WebSocket + XHR/fetch.
      contextIsolation: false,
      sandbox: false,
      preload: join(__dirname, 'preload.cjs'),
      // The im/pin/roster poll loops are page timers, and Chromium clamps timers in
      // hidden/occluded windows (chained setTimeouts down to 1/min after 5 backgrounded
      // minutes) — minimizing this window would stretch the ~1s close signal to seconds.
      // TikTok's own dashboard dodges the same clamp in-browser via worker-timer.js.
      backgroundThrottling: false,
    },
  })
  monitor.webContents.setWindowOpenHandler(({ url }) => {
    let host = ''
    try { host = new URL(url).hostname.toLowerCase() } catch { return { action: 'deny' } }
    const allowed =
      host === 'tiktok.com' || host.endsWith('.tiktok.com') ||
      host === 'tiktokv.com' || host.endsWith('.tiktokv.com')
    if (!allowed) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: { session: part, contextIsolation: true, sandbox: true, nodeIntegration: false },
      },
    }
  })
  void monitor.loadURL(START_URL)
  monitor.webContents.on('did-navigate', (_e, url) => {
    debug(`[tt] nav ${url}`)
    if (LOGIN_RE.test(url)) {
      connected = false
      send({ kind: 'status', status: 'needs-login', detail: 'Log in to TikTok in the monitor window' })
    }
  })
  monitor.webContents.on('did-navigate-in-page', (_e, url) => debug(`[tt] nav-in-page ${url}`))
  monitor.webContents.on('did-finish-load', () => debug(`[tt] loaded ${monitor?.webContents.getURL() ?? ''}`))
  monitor.on('closed', () => { monitor = null })
}

ipcMain.on('tt-status', (_e, s: { status: StatusEvent['status']; detail?: string }) => {
  send({ kind: 'status', status: s.status, detail: s.detail })
})

// Viewer → monitor: post a chat message (only the monitor window has the SDK-signed fetch).
// The post is async in the monitor; correlate the reply by id so the invoke resolves with
// the REAL TikTok post result, not just "forwarded to monitor".
let chatSendSeq = 0
const pendingChatSends = new Map<number, (r: { ok: boolean; error?: string }) => void>()
ipcMain.handle('tt-chat-send', (_e, text: string) => {
  if (!monitor) return { ok: false, error: 'monitor not open' }
  const id = ++chatSendSeq
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const timer = setTimeout(() => { pendingChatSends.delete(id); resolve({ ok: false, error: 'timeout' }) }, 8000)
    pendingChatSends.set(id, (r) => { clearTimeout(timer); resolve(r) })
    monitor!.webContents.send('tt-chat-send', { id, text })
  })
})
// Monitor → main: post result. Resolve the matching invoke (and broadcast to viewer).
ipcMain.on('tt-chat-sent', (_e, result: { id?: number; ok: boolean; error?: string }) => {
  if (result?.id != null) {
    pendingChatSends.get(result.id)?.(result)
    pendingChatSends.delete(result.id)
  }
  viewerSend('tt-chat-sent', result)
})

// ── Auction lifecycle events (shared by the im/fetch stream AND the frontier WS) ──
// The 2026-07-24 show proved im/fetch alone is not enough: the decode went silent all
// night (0 events) while the HAR captured from a plain browser shows the messages.
// When the frontier WS connects (it does in the app; the HAR browser had NO WS and
// used im/fetch instead), TikTok likely pushes the same webcast messages down the WS —
// so BOTH channels feed the same handler, deduped via imSeen.
function ingestAuctionBytes(raw: Uint8Array, now: number, via: 'im' | 'ws') {
  for (const ev of decodeAuctionIm(raw)) {
    if (ev.type === 'end') {
      const key = `end|${ev.auctionId}|${ev.endMs ?? ''}`
      if (imSeen.has(key)) continue
      imSeen.add(key)
      // auction.end has winner+price but NO lot number. Attribute it from the lot
      // currently being bid (im Manager bid messages — universal, works unpinned);
      // fall back to the pin state when it tracks the same winner (pinned lots).
      // Anything still unattributed gets its lot from the im-result companion ~6s on.
      const cur = imCurrent && now - imCurrent.ts < 60000 && imCurrent.leader === ev.winner ? imCurrent : null
      const c = lastPin?.current
      const pinMatch =
        !cur && !!lastPin && now - lastPin.ts < 15000 && !!c?.winUsername && c.winUsername === ev.winner &&
        (c.status === 1 || c.status === 3)
      const lotNumber = cur?.lotNumber ?? (pinMatch ? c?.variantDesc : undefined)
      const productName = cur?.productName ?? (pinMatch ? c?.productName : undefined)
      lat(`A4 ${via}-end ${lotNumber ? `#${lotNumber} ` : ''}${ev.winner} ${ev.price ?? ''}${lotNumber ? '' : ' (lot unattributed)'}`)
      send({
        kind: 'auction-closed',
        auctionConfigId: ev.auctionId || `${via}-${ev.endMs ?? now}`,
        lotNumber,
        productName,
        winner: ev.winner,
        price: ev.price,
        source: 'im',
        ts: now,
      })
    } else {
      // Manager messages fire on EVERY BID (leader + price + lot number), not just at
      // result_update. Only the confirmed result carries orderCreateMs — printing off
      // anything else would label every bid. Bid updates DO give us the lot currently
      // being auctioned, which is how auction.end (no lot number) gets attributed
      // without depending on pin/get.
      if (ev.orderCreateMs == null) {
        imCurrent = { lotNumber: ev.lotNumber, productName: ev.productName, leader: ev.winner, ts: now }
        continue
      }
      const key = `result|${ev.lotNumber ?? ''}|${ev.winner}|${ev.orderCreateMs}`
      if (imSeen.has(key)) continue
      imSeen.add(key)
      lat(`A4 ${via}-result #${ev.lotNumber ?? '?'} ${ev.winner} ${ev.price ?? ''}`)
      send({
        kind: 'auction-closed',
        auctionConfigId: ev.skuId || `${via}r-${ev.orderCreateMs ?? now}`,
        lotNumber: ev.lotNumber,
        productName: ev.productName,
        winner: ev.winner,
        price: ev.price,
        username: ev.username,
        source: 'im-result',
        ts: now,
      })
      // The order row exists NOW — the dashboard itself fetches auction_result/get
      // ~250ms after this push. Don't wait for the poll cycle to backfill.
      monitor?.webContents.send('tt-poll-now')
    }
    if (imSeen.size > 500) imSeen.delete(imSeen.keys().next().value!) // bound the set
  }
}

// ── Message census (TT_LAT/TT_DEBUG): which channel carries which Webcast messages ──
// Diagnoses "the im decode went silent" — shows whether auction messages arrive over
// the WS instead of im/fetch, or don't arrive at all. Zero cost when TIMING is off.
const msgCensus = new Map<string, number>()
const censusFrames = { ws: 0, im: 0 }
function census(buf: Uint8Array, channel: 'ws' | 'im') {
  if (!TIMING) return
  censusFrames[channel]++
  const s = Buffer.from(buf).toString('latin1')
  const re = /Webcast\w+Message/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) msgCensus.set(`${channel}:${m[0]}`, (msgCensus.get(`${channel}:${m[0]}`) ?? 0) + 1)
}
setInterval(() => {
  if (!TIMING || (!censusFrames.ws && !censusFrames.im && !msgCensus.size)) return
  const tops = [...msgCensus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}×${v}`).join(' ')
  lat(`census frames ws=${censusFrames.ws} im=${censusFrames.im} · ${tops || '(no Webcast markers)'}`)
}, 60000)

// Source 1: frontier WebSocket → aggregate live stats + (possibly) auction messages.
ipcMain.on('tt-ws-frame', (_e, msg: { url?: string; data?: Uint8Array }) => {
  const raw = msg?.data instanceof Uint8Array ? msg.data : new Uint8Array(msg?.data ?? [])
  capture(CAP_WS, { url: msg?.url ?? '', bytes: raw.byteLength, b64: Buffer.from(raw).toString('base64') })
  const frame = parsePushFrame(raw)
  if (!frame) return
  let buf = Buffer.from(frame.payload)
  if (frame.payloadEncoding === 'gzip' || (buf[0] === 0x1f && buf[1] === 0x8b)) {
    try { buf = gunzipSync(buf) } catch { return }
  }
  // Webcast push payloads are protobuf (not JSON) — scan for auction messages BEFORE
  // the JSON path drops them. When the WS carries them this is the fast sale signal.
  census(buf, 'ws')
  ingestAuctionBytes(new Uint8Array(buf), Date.now(), 'ws')
  let payload: unknown
  try { payload = JSON.parse(buf.toString('utf8')) } catch { return }
  for (const ev of feed.ingest(payload, Date.now())) {
    if (ev.kind === 'room') {
      pollRoomId = ev.roomId
      if (!connected) {
        connected = true
        send({ kind: 'status', status: 'connected', detail: `room ${ev.roomId}` })
      }
      maybeStartPolling()
    } else if (ev.kind === 'session' && ev.id) {
      pollSessionId = ev.id
      maybeStartPolling()
    } else if (ev.kind === 'sale' && pollSent) {
      // a product's sold-count just ticked up on the WS → fetch the new sale immediately
      // (don't wait for the 3s poll cycle) so the label prints right away. Debounced.
      const t = Date.now()
      lastWsTickAt = t
      lat(`A ws-tick product=${ev.productId} +${ev.delta}`)
      if (t - lastSalePollNow > 600) {
        lastSalePollNow = t
        lat('B poll-now FIRED')
        monitor?.webContents.send('tt-poll-now')
      } else {
        lat(`B poll-now DEBOUNCED (${Math.round(600 - (t - lastSalePollNow))}ms until next allowed)`)
      }
    }
    send(ev)
  }
})

// Source 4: webcast/im/fetch protobuf → viewer comments + auction lifecycle events.
// The im stream carries auction.end ~0.3-1.2s after the gavel — 6-7s before the sale
// exists in auction_result/get — for EVERY auction (pinned or not), making it the
// universal fast close signal the dead WS sold-tick and the drifted DOM feed never were.
ipcMain.on('tt-im-frame', (_e, bytes: Uint8Array) => {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  capture(CAP_IM, { bytes: raw.byteLength, b64: Buffer.from(raw).toString('base64') })
  const now = Date.now()
  census(raw, 'im')
  const items = decodeChat(raw)
  if (items.length) {
    debug(`[tt] chat +${items.length}`)
    send({ kind: 'chat', items, ts: now })
  }
  ingestAuctionBytes(raw, now, 'im')
})

// Source 2b: on-screen "won" feed (DOM observer in preload) → instant winner,
// ~4s before auction_result/get. Drives the opt-in "Live feed" fast-print mode.
// Δws-tick lets us compare its latency against the REST path in the timing log.
ipcMain.on('tt-won-feed', (_e, win: { name?: string; auctionNo?: string; price?: string }) => {
  const auctionNo = String(win?.auctionNo ?? '').trim()
  const name = String(win?.name ?? '').trim()
  if (!auctionNo || !name) return
  const now = Date.now()
  lat(`A2 won-feed #${auctionNo} ${name} (Δws-tick=${lastWsTickAt ? now - lastWsTickAt : '?'}ms)`)
  send({ kind: 'won-feed', name, auctionNo, ...(win?.price ? { price: String(win.price) } : {}), ts: now })
})

// DEBUG (TT_DEBUG=1): won-feed observer diagnostics from the monitor window → terminal
// + a retrievable log file, so we can localize why the feed observer sees nothing.
// Diagnostic for the self-issued pin/get poll: is it succeeding, or being rejected?
ipcMain.on('tt-pin-diag', (_e, d: unknown) => {
  lat(`A3.diag ${JSON.stringify(d)}`)
})

ipcMain.on('tt-won-debug', (_e, d: unknown) => {
  // Diagnostics only. appendFileSync BLOCKS the main process, which is also what
  // dispatches print jobs — so this must never run in a normal session.
  if (!process.env.TT_DEBUG) return
  const line = `[wonfeed-debug ${new Date().toISOString()}] ${JSON.stringify(d)}`
  console.log(line)
  try { appendFileSync(join(app.getPath('userData'), 'wonfeed-debug.log'), line + '\n') } catch { /* ignore */ }
})

// Sources 2 & 3: REST poll responses → roster + per-sale history.
ipcMain.on('tt-rest-data', (_e, msg: { endpoint?: string; body?: string }) => {
  capture(CAP_REST, { endpoint: msg?.endpoint, body: msg?.body })
  let json: unknown
  try { json = JSON.parse(msg?.body ?? '') } catch { return }
  const now = Date.now()
  debug(`[tt] rest ${msg?.endpoint} code=${(json as { code?: unknown })?.code} len=${msg?.body?.length ?? 0}`)
  if (msg?.endpoint === 'roster') {
    const snap = parseRoster(json, now)
    debug(`[tt] roster: ${snap.products.length} products, sold ${snap.totalSold}, pinned @${snap.pinned?.winUsername ?? '—'}`)
    send(snap)
  } else if (msg?.endpoint === 'auction_result') {
    const update = auctionResults.ingest(json, now)
    debug(`[tt] sales: +${update.newSales.length} new, ${update.totalSales} total, ${update.uniqueBuyers} buyers, ${update.failedPayments.length} failed`)
    if (TIMING && update.newSales.length) {
      lat(`C rest auction_result +${update.newSales.length} new (Δws-tick=${lastWsTickAt ? now - lastWsTickAt : '?'}ms)`)
      for (const s of update.newSales) {
        const item = (s.skuDesc ?? '').replace(/^#/, '')
        if (item) {
          saleSeenAt.set(item, now)
          if (saleSeenAt.size > 500) saleSeenAt.delete(saleSeenAt.keys().next().value!) // bound the debug map
        }
        lat(`  C.row #${item} created=${now - s.createdAt}ms-ago paid=${s.paymentStatus}`)
      }
    }
    send(update)
  } else if (msg?.endpoint === 'room_status') {
    const url = (json as { data?: { live_stream_url?: string } })?.data?.live_stream_url
    if (url) {
      debug(`[tt] stream ${url.slice(0, 70)}`)
      send({ kind: 'stream', url, ts: now })
    }
  } else if (msg?.endpoint === 'live_room_info') {
    // Bootstrap fallback: live_room_info/get returns the CURRENT live room directly
    // (room_id + current_session while streaming; live_session_status 11 = live,
    // 20 = ended). pollSent latches, so only adopt a genuinely-live session.
    if (pollSent) return
    const d = (json as { data?: { room_id?: string; current_session?: { id?: string; name?: string; live_session_status?: number } } })?.data
    const sess = d?.current_session
    if (!d?.room_id || !sess?.id || sess.live_session_status !== 11) return
    debug(`[tt] live_room_info bootstrap: room=${d.room_id} session=${sess.id} (${sess.name ?? ''})`)
    pollRoomId = d.room_id
    pollSessionId = sess.id
    if (!connected) { connected = true; send({ kind: 'status', status: 'connected', detail: `room ${d.room_id} (live_room_info)` }) }
    send({ kind: 'session', name: sess.name, id: sess.id, ts: now })
    maybeStartPolling()
  } else if (msg?.endpoint === 'pin') {
    const pin = parsePin(json, now)
    lastPin = pin
    // Liveness/edge trace: AuctionWatch can only fire on a 1→3 TRANSITION, so if pin
    // samples are sparse we silently miss closes. Log every status/lot change plus a
    // periodic heartbeat to show the poll is actually feeding us.
    if (TIMING) {
      const c = pin.current
      const sig = `${c?.auctionConfigId ?? '-'}|${c?.status ?? '-'}`
      pinSamples++
      if (sig !== lastPinSig) {
        lastPinSig = sig
        lat(`A3.sample lot=${c?.variantDesc ?? '?'} status=${c?.status ?? '?'} winner=${c?.winUsername ?? '-'} (sample #${pinSamples})`)
      } else if (pinSamples % 30 === 0) {
        lat(`A3.heartbeat ${pinSamples} pin samples, current lot=${c?.variantDesc ?? '?'} status=${c?.status ?? '?'}`)
      }
    }
    send(pin)
    // pin/get flips status 1→3 within ~0.5s of the gavel — measured 6.0s and 7.3s
    // AHEAD of the same sale landing in auction_result/get. This is what drives the
    // label now; auction_result stays authoritative and backfills order/payment.
    for (const closed of auctionWatch.ingest(pin)) {
      lat(`A3 ${closed.source} ${closed.lotNumber ?? '?'} ${closed.winner} ${closed.price ?? ''}`)
      send(closed)
    }
    // The order row is born ~at the gavel but our order poll only looks every 1.5s.
    // We KNOW when the gavel will fall (expectedEndMs, server clock) — schedule one
    // extra poll right after it so the confirmed row is fetched the moment it exists,
    // instead of up to a poll-interval later. Re-armed whenever the end time moves
    // (anti-snipe extensions) or the lot changes; skipped for absurd delays.
    const cur = pin.current
    if (cur?.status === 1 && cur.expectedEndMs && cur.auctionConfigId) {
      const sig = `${cur.auctionConfigId}|${cur.expectedEndMs}`
      if (sig !== endPollSig) {
        endPollSig = sig
        if (endPollTimer) clearTimeout(endPollTimer)
        const delay = cur.expectedEndMs - (Date.now() + (pin.serverTimeOffsetMs ?? 0)) + 600
        if (delay > 0 && delay < 600000) {
          endPollTimer = setTimeout(() => {
            lat(`B poll-now AT-EXPECTED-END lot=${cur.variantDesc ?? '?'}`)
            monitor?.webContents.send('tt-poll-now')
          }, delay)
        }
      }
    }
  }
})

// TT_REPLAY=1 — feed the bundled real fixtures into the viewer (no live needed),
// to see/verify the full Live Monitor render without a running show.
function replayFixtures() {
  try {
    const rest = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'rest-samples.json'), 'utf8'))
    send({ kind: 'status', status: 'connected', detail: 'REPLAY (HAR fixture)' })
    send({ kind: 'session', name: 'Alo Yoga & More — No Cancels (replay)', id: '4384835334', ts: Date.now() })
    send(parseRoster(rest.roster, Date.now()))
    send(auctionResults.ingest({ auction_result_data: rest.auctionResultRows }, Date.now()))
  } catch (e) {
    console.error('replay failed:', (e as Error).message)
  }
}

// ── Label printing (mirrors the desktop app: webContents.print of HTML) ──────
const PRINTER_FILE = join(app.getPath('userData'), 'tt-printer.json')
function loadPrinter(): string {
  try { return JSON.parse(readFileSync(PRINTER_FILE, 'utf8')).printer ?? '' } catch { return '' }
}

ipcMain.handle('get-printers', async () => {
  const printers = (await viewer?.webContents.getPrintersAsync()) ?? []
  return {
    printers: printers.map((p) => ({ name: p.name, displayName: p.displayName, isDefault: p.isDefault })),
    saved: loadPrinter(),
  }
})
ipcMain.handle('save-printer', (_e, name: string) => {
  try { writeFileSync(PRINTER_FILE, JSON.stringify({ printer: name })) } catch { /* ignore */ }
  return true
})

// ── AI transcription (Gemini, mirrors sellerfolio-live's enrichment) ─────────
// Key resolution: env var wins, else a local gitignored `gemini.key` file in the PoC root
// (same convention as live-ledger). __dirname is dist/, so '..' is the project root.
function readGeminiKey(): string {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY
  const f = join(__dirname, '..', 'gemini.key')
  try { return existsSync(f) ? readFileSync(f, 'utf8').trim() : '' } catch { return '' }
}
const GEMINI_KEY = readGeminiKey()
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

// Connection state for the UI: are we logged in, is a live show captured, are we polling?
ipcMain.handle('tt-connection', async () => ({
  loggedIn: await tiktokLoggedIn(),
  hasShow: !!pollRoomId && !!pollSessionId,
  polling: pollSent,
}))

// Bring the TikTok monitor window forward (e.g. so the user can log in).
ipcMain.handle('tt-open-monitor', () => {
  if (!monitor) return { ok: false }
  monitor.show()
  monitor.focus()
  return { ok: true }
})

ipcMain.handle('recap-enabled', () => ({ enabled: !!GEMINI_KEY, model: GEMINI_MODEL }))

interface TranscriptFields { brand?: string; item?: string; color?: string; size?: string; retailPrice?: string; summary?: string }

// Structured Gemini call: from an audio clip, extract product attributes (brand/size/retail…)
// for costing + the ledger. Reused by both tt-transcribe (mimeType audio/webm) and
// tt-transcribe-orders (mimeType audio/aac, the ffmpeg ADTS clip).
// Prompt ported verbatim from live-ledger (server/src/media/gemini.ts transcribePrompt).
function transcribePrompt(hints: string | null): string {
  const b = hints ? `\nKNOWN BRANDS being sold: ${hints}` : ''
  return (
    'You are analyzing a short video clip from a TikTok Shop LIVE auction. ' +
    "The clip ENDS at the exact moment this item's auction closed / the order was placed, " +
    'so the SOLD item is the one being auctioned and won at the END of the clip.\n' + b +
    '\n\nTASK: Watch the whole clip and listen to the audio. Identify the item that was SOLD ' +
    "(the one being auctioned/won right at the end — listen for 'sold', 'congrats', a winning " +
    "username, 'going once/twice').\n" +
    'IMPORTANT: If the host shows or discusses TWO different items in the clip, focus ONLY on the ' +
    'LAST one — the earlier item likely belongs to a PREVIOUS sale that already closed before this ' +
    'order. Always describe the item being auctioned/won at the very END.\n' +
    'Then extract:\n' +
    '- brand: brand name' + (hints ? " (MUST be one of the known brands above; if not, 'Other: <name>')" : " or 'Not stated'") + '\n' +
    "- item: product type or name (e.g. 'Random Premium Pull', 'Leggings', 'Handbag')\n" +
    "- color, size: if visible/called out, else 'Not stated'\n" +
    "- retail_price_mentioned: any retail/MSRP price SPOKEN, formatted '$XX', else 'Not stated'\n" +
    '- retail_price_estimated: your best estimate of typical retail for this brand+item (always give one)\n' +
    '- transcript_summary: a brief summary of what was said about the sold item\n\n' +
    'Return ONLY a JSON object with keys: brand, item, color, size, ' +
    'retail_price_mentioned, retail_price_estimated, transcript_summary.'
  )
}

// Parse live-ledger's JSON (fence-strip, price-normalize, drop "Not stated") → our fields.
function parseLiveLedgerResult(raw: string): TranscriptFields {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse((m && m[1] ? m[1] : raw).trim()) as Record<string, unknown> } catch { parsed = {} }
  const price = (v: unknown): string | undefined => {
    if (!v || String(v).toLowerCase() === 'not stated') return undefined
    const mm = /\$?(\d+(?:\.\d{1,2})?)/.exec(String(v))
    return mm ? `$${mm[1]}` : undefined
  }
  const str = (v: unknown): string | undefined => {
    const s = v == null ? '' : String(v).trim()
    return s && s.toLowerCase() !== 'not stated' ? s : undefined
  }
  const f: TranscriptFields = {}
  const brand = str(parsed.brand); if (brand) f.brand = brand
  const item = str(parsed.item); if (item) f.item = item
  const color = str(parsed.color); if (color) f.color = color
  const size = str(parsed.size); if (size) f.size = size
  const retail = price(parsed.retail_price_mentioned) ?? price(parsed.retail_price_estimated); if (retail) f.retailPrice = retail
  const summary = str(parsed.transcript_summary); if (summary) f.summary = summary
  return f
}

async function geminiStructured(
  media: { mimeType: string; data: Uint8Array }[],
  _label = '',
): Promise<{ fields?: TranscriptFields; text?: string; error?: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`
  const parts: unknown[] = [{ text: transcribePrompt(null) }]
  for (const m of media) parts.push({ inlineData: { mimeType: m.mimeType, data: Buffer.from(m.data).toString('base64') } })
  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 1024 },
    },
  }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } }
    if (!res.ok) return { error: `gemini ${res.status}: ${json?.error?.message ?? ''}`.slice(0, 200) }
    const raw = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim()
    const fields = parseLiveLedgerResult(raw)
    debug(`[tt] structured fields: ${Object.keys(fields).join(',')}`)
    return { text: fields.summary || raw, fields }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

ipcMain.handle('tt-transcribe', async (_e, payload: { audio?: Uint8Array; productName?: string; structured?: boolean }) => {
  if (!GEMINI_KEY) return { error: 'GEMINI_API_KEY not set' }
  const audio = payload?.audio instanceof Uint8Array ? payload.audio : new Uint8Array(payload?.audio ?? [])
  if (!audio.byteLength) return { error: 'no audio captured' }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`
  const label = payload?.productName ?? ''
  const clip = { inlineData: { mimeType: 'audio/webm', data: Buffer.from(audio).toString('base64') } }

  // Structured mode: extract product attributes (brand/size/retail…) for costing + the ledger.
  if (payload?.structured) {
    return geminiStructured([{ mimeType: 'audio/webm', data: audio }], label)
  }

  const prompt =
    `This is a short audio clip from a live-shopping auction that just sold an item labeled "${label}". ` +
    `Transcribe the seller's speech verbatim. Return ONLY the transcript text — no labels, no commentary.`
  const body = {
    contents: [{ parts: [{ text: prompt }, clip] }],
    generationConfig: { temperature: 0.1 },
  }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } }
    if (!res.ok) return { error: `gemini ${res.status}: ${json?.error?.message ?? ''}`.slice(0, 200) }
    const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim()
    debug(`[tt] transcript ${text.length} chars`)
    return { text }
  } catch (e) {
    return { error: (e as Error).message }
  }
})

// ── Label printing ───────────────────────────────────────────────────────────
// Re-creating a hidden BrowserWindow per label + a fixed 350ms render sleep added
// ~½–1s of latency to EVERY label (and auto-print fired several at once, spawning
// N windows). Instead: keep ONE reusable hidden window, wait only on a real
// readiness signal (DOM loaded via loadURL + fonts settled) rather than a blind
// timer, and serialize jobs since one window can only render+print one at a time.
let printWin: BrowserWindow | null = null
let printChain: Promise<unknown> = Promise.resolve()

function getPrintWindow(): BrowserWindow {
  if (printWin && !printWin.isDestroyed()) return printWin
  // backgroundThrottling: this window is never shown, so Chromium would otherwise
  // throttle its rendering/timers from birth — slowing every label's render step.
  printWin = new BrowserWindow({ width: 240, height: 130, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  printWin.on('closed', () => { printWin = null })
  return printWin
}

async function printLabelJob(args: { labelData: LabelData; printerName: string; template?: LabelTemplate }): Promise<{ success: boolean; error?: string }> {
  try {
    const template = args.template ?? DEFAULT_TEMPLATE
    const size = LABEL_SIZES[template.labelSize] ?? LABEL_SIZES['2x1']
    const wc = getPrintWindow().webContents
    await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(labelHtml(args.labelData, template)))
    // Condition-based readiness, not a fixed sleep: loadURL already resolved after
    // the DOM parsed; document.fonts.ready settles layout. For the label's system
    // font this is ~instant — the 200ms race is only a guard against a stuck render.
    await Promise.race([
      wc.executeJavaScript('document.fonts.ready.then(() => true)').catch(() => true),
      new Promise((r) => setTimeout(r, 200)),
    ])
    await new Promise<void>((resolve, reject) => {
      wc.print(
        {
          silent: true,
          printBackground: true,
          deviceName: args.printerName,
          margins: { marginType: 'none' },
          pageSize: { width: size.widthMicrons, height: size.heightMicrons },
        },
        (ok, reason) => (ok ? resolve() : reject(new Error(reason || 'print failed'))),
      )
    })
    return { success: true }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
}

ipcMain.handle('print-label', (_e, args: { labelData: LabelData; printerName: string; template?: LabelTemplate }) => {
  // Serialize: the single hidden window renders+prints one label at a time, and
  // auto-print can fire several fresh sales at once. Chain so they queue in order.
  const item = String(args?.labelData?.itemNumber ?? '')
  const seen = TIMING ? saleSeenAt.get(item) : undefined
  const queuedAt = Date.now()
  lat(`E print QUEUED #${item}${seen ? ` (Δrest→queue=${queuedAt - seen}ms, Δws-tick=${lastWsTickAt ? queuedAt - lastWsTickAt : '?'}ms)` : ' (no live origin — manual/range)'}`)
  const run = printChain.then(() => printLabelJob(args))
  printChain = run.catch(() => {})
  return run.then((r) => {
    if (TIMING) {
      const done = Date.now()
      lat(`E print DONE #${item} ok=${r.success} spool=${done - queuedAt}ms${seen ? ` · total(rest→label)=${done - seen}ms` : ''}`)
      saleSeenAt.delete(item)
    }
    return r
  })
})

// ── Auto-update (launch-time, GitHub Releases) ───────────────────────────────
// Packaged builds only: ONE check ~3s after launch (no recurring poll). Download
// silently, install on the next quit, and tell the dashboard once an update is
// staged so it can show the "Update ready" indicator. Every path is log-only — a
// failed/blocked update must never disrupt a live show or pop a dialog.
function initAutoUpdate() {
  if (!app.isPackaged || process.env.TT_REPLAY) return
  autoUpdater.autoDownload = true // pull the update in the background at launch
  autoUpdater.autoInstallOnAppQuit = true // apply it on the next clean quit
  autoUpdater.on('update-available', (info) => debug(`[update] available ${info.version}`))
  autoUpdater.on('update-not-available', () => debug('[update] up to date'))
  autoUpdater.on('error', (err) => console.error('[update] error:', err?.message ?? err))
  autoUpdater.on('update-downloaded', (info) => {
    debug(`[update] downloaded ${info.version} — installs on quit`)
    viewerSend('tt-update-ready', { version: info.version })
  })
  setTimeout(() => { autoUpdater.checkForUpdates().catch((e) => debug(`[update] ${e}`)) }, 3000)
}

app.whenReady().then(() => {
  app.userAgentFallback = CHROME_UA
  Menu.setApplicationMenu(null) // remove the native File/Edit/View/Window/Help menu bar
  nativeTheme.themeSource = 'dark' // dark native title bar (min/max/close) to match the body
  createViewer()
  if (process.env.TT_REPLAY) {
    setTimeout(replayFixtures, 1200)
  } else {
    createMonitor()
  }
  initAutoUpdate()
})
app.on('window-all-closed', () => app.quit())
// On quit, force-close any window so a page-level beforeunload (TikTok registers
// one) can't veto the exit and strand the process. destroy() skips beforeunload.
app.on('before-quit', () => {
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.destroy() } catch { /* ignore */ }
  }
})
// Last-resort net: a stray async throw during teardown must never strand the app
// behind the native "JavaScript error" dialog (which forces a Task Manager kill).
// Log loudly so real bugs are still visible; the guards above are the actual fix.
process.on('uncaughtException', (err) => { console.error('[main] uncaughtException:', err) })
process.on('unhandledRejection', (err) => { console.error('[main] unhandledRejection:', err) })
