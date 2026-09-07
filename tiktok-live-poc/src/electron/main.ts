import { app, BrowserWindow, clipboard, ipcMain, session, Menu, nativeTheme, shell } from 'electron'
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
import { parseTrend, paceCentsPerHour, formatCents, STATS_GMV, STATS_ORDERS } from '../core/liveTrend'
import { decodeChat } from '../core/chat'
import { evaluateWatchdog } from '../core/watchdog'
import { initFlightLog, flightLogPath, flog, flushFlightLogSync } from './flightlog'
import { decodeAuctionIm, extractMessagePayloads } from '../core/auctionIm'
import { labelHtml, LABEL_SIZES, DEFAULT_TEMPLATE, type LabelData, type LabelTemplate } from './label'
import { labelZpl, labelNeedsHtml } from './zplLabel'
import { sendRawToPrinter, warmRawPrinter, probeRawPrinter, describePrinterStatus, isBlockingStatus } from './rawPrint'
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
// Whole-show aggregates (insights trend/chart + room/status), NOT derived from the sales
// we happened to capture — so they stay right when the app attaches to a show in progress.
let showElapsedSec: number | undefined // room/status data.duration — the show's real runtime
let trendFirstPointMs: number | undefined // anchor of the trend window; must not move
const KNOWN_STATS = new Set([STATS_GMV, STATS_ORDERS, 51, 84]) // the four the dashboard charts
const statsProbeSeen = new Set<number>() // stats_type ids already reported by the discovery sweep
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
// ── Watchdog state (evaluated every 15s; core/watchdog.ts is the pure logic) ──
let wdPollStartedAt: number | undefined
let wdLastPinAt: number | undefined
let wdLastImAt: number | undefined
let wdSalesSinceClose = 0
const wdPrintErrors: number[] = [] // ms timestamps of failed label jobs
// TikTok answers every endpoint with a bare {"code":0} while a verification puzzle waits
// in the monitor window. Track WHEN a body last carried a payload (not a count of empty
// ones): the endpoints poll at different rates and gate independently, so a shared counter
// tripped on empty roster/auction_result bodies while pin was fine, and the alert flapped.
let wdLastRestPayloadAt: number | undefined
let wdFirstRestAt: number | undefined
// Printer state from the last raw dispatch or idle probe. `undefined` = never read
// (HTML print path, or the helper could not read it) — distinct from 0 = ready.
let lastPrinterStatus: number | undefined
let lastPrinterJobs: number | undefined
let wdGateSent = false // last throttle state pushed to the poll loops
let wdLastAlertsJson = ''
let wdLastSentAt = 0
let endPollSig = '' // auctionConfigId|expectedEndMs the timer is armed for
function maybeStartPolling() {
  if (pollSent || !pollRoomId || !pollSessionId || !monitor) return
  pollSent = true
  wdPollStartedAt = Date.now()
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

const debug = (line: string) => { flog(line); if (process.env.TT_DEBUG) console.log(line) }

// ── Label-latency instrumentation (TT_LAT=1 or TT_DEBUG=1) ───────────────────
// Times a live sale from the WS sold-count tick (A) → poll fired/debounced (B) →
// REST auction_result row arrives (C) → label queued/spooled (E), all on one
// process clock. Hop A's upstream (gavel→socket) is TikTok-side and unmeasurable
// here; we anchor at the tick. Zero overhead when the flag is off.
const TIMING = !!(process.env.TT_LAT || process.env.TT_DEBUG)
const lat = (line: string) => { const l = `[lat ${Date.now()}] ${line}`; flog(l); if (TIMING) console.log(l) }
let lastWsTickAt = 0 // ms of the most recent WS sold-count tick
let pinSamples = 0 // pin/get responses seen — proves the 700ms poll is actually feeding us
let lastPinSig = '' // last auctionConfigId|status, so we log edges not every sample
const saleSeenAt = new Map<string, number>() // item# → ms when main first produced the sale row
// DIAG (sudden-death investigation): lots whose auction-mode flags we've already logged,
// so each lot is recorded once. Lets a lot run with sudden death ON be compared to one OFF.
const modeSeen = new Set<string>()

// Send to the dashboard ONLY when it's alive. `viewer?.` guards null but not a
// destroyed window — sending to a closed webContents throws in main (uncaught →
// the native crash dialog), which is what made the app unkillable on close.
function viewerSend(channel: string, ...args: unknown[]) {
  if (viewer && !viewer.isDestroyed() && !viewer.webContents.isDestroyed()) {
    viewer.webContents.send(channel, ...args)
  }
}
function send(ev: LiveEvent) {
  if (ev.kind === 'auction-closed') wdSalesSinceClose = 0
  else if (ev.kind === 'sales' && wdPollStartedAt && Date.now() - wdPollStartedAt > 20000) {
    // skip the connect-time backlog (first ~20s of ingests are history, not gavels)
    wdSalesSinceClose += ev.newSales.length
  }
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
let shoppingSamples = 0
const SHOPPING_SAMPLE_CAP = 20
function ingestAuctionBytes(raw: Uint8Array, now: number, via: 'im' | 'ws') {
  // Self-collecting schema samples: WebcastOecLiveShoppingMessage is one Oec message we
  // still cannot decode. Log a bounded number of raw payloads so the field layout can be
  // reversed straight from a show's flight log.
  // NB: this used to claim "Creator/Manager are extinct per the 2026-07-28 census". They
  // are not — the 2026-09-07 census counted OecLiveCreatorMessage×634 and
  // OecLiveManagerMessage×392 in a single show. That stale note is why the per-bid Manager
  // feed sat decoded-but-unused for weeks while both lot cards showed nothing until the
  // gavel. Re-read a live census before trusting any "extinct" claim here.
  if (shoppingSamples < SHOPPING_SAMPLE_CAP) {
    for (const payload of extractMessagePayloads(raw, 'WebcastOecLiveShoppingMessage')) {
      if (shoppingSamples >= SHOPPING_SAMPLE_CAP) break
      shoppingSamples++
      flog(`[sample] OecLiveShopping via=${via} #${shoppingSamples} b64=${Buffer.from(payload).toString('base64')}`)
    }
  }
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
        // The bid update is ALSO the only real-time feed for the current-lot cards when
        // the host hasn't pinned the card (pin/get answers empty for unpinned lots) —
        // forward it so the overlay/panel track every bid, not just the gavel.
        send({ kind: 'bid', lotNumber: ev.lotNumber, productName: ev.productName, leader: ev.winner, username: ev.username, price: ev.price, ts: now })
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
  censusFrames[channel]++
  const s = Buffer.from(buf).toString('latin1')
  const re = /Webcast\w+Message/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) msgCensus.set(`${channel}:${m[0]}`, (msgCensus.get(`${channel}:${m[0]}`) ?? 0) + 1)
}
setInterval(() => {
  if (!censusFrames.ws && !censusFrames.im && !msgCensus.size) return
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
  wdLastImAt = Date.now()
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
  // A response carrying nothing but `code` is TikTok's verification gate, not a quiet
  // moment: `{"code":0}` is 10 bytes and arrives for EVERY endpoint until the puzzle in the
  // monitor window is solved (2231 of 2300 pin responses in one show). Count the run so the
  // watchdog can say so; any body with real payload clears it.
  wdFirstRestAt ??= now
  if (Object.keys(json as object ?? {}).filter((k) => k !== 'code' && k !== 'message').length > 0) {
    wdLastRestPayloadAt = now
  }
  if (msg?.endpoint === 'roster') {
    const snap = parseRoster(json, now)
    debug(`[tt] roster: ${snap.products.length} products, sold ${snap.totalSold}, pinned @${snap.pinned?.winUsername ?? '—'}`)
    // DIAG (sudden-death investigation): log each lot's auction-mode flags once. Run one
    // lot with sudden death ON and one OFF, then compare — the flag that flips is the one.
    for (const p of snap.products) {
      const k = p.variantDesc ?? p.auctionConfigId
      if (!k || modeSeen.has(k)) continue
      modeSeen.add(k)
      flog(`[diag-mode] lot=${p.variantDesc ?? '?'} auction_mode=${p.auctionMode ?? '?'} card_type=${p.auctionCardType ?? '?'} config_type=${p.auctionConfigType ?? '?'} ext_dur=${p.extendedDurationSec ?? '?'} dur=${p.durationSec ?? '?'}`)
    }
    if (modeSeen.size > 5000) modeSeen.clear() // bound across a long multi-listing show
    send(snap)
  } else if (msg?.endpoint === 'auction_result') {
    const update = auctionResults.ingest(json, now)
    debug(`[tt] sales: +${update.newSales.length} new, ${update.totalSales} total, ${update.uniqueBuyers} buyers, ${update.failedPayments.length} failed`)
    if (update.newSales.length) {
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
    const d = (json as { data?: { live_stream_url?: string; duration?: number } })?.data
    // `duration` is the WHOLE show's elapsed seconds, counted by TikTok from the session
    // start — not from when we attached. It is what makes pace correct on a late join.
    if (typeof d?.duration === 'number' && d.duration > 0) showElapsedSec = d.duration
    if (d?.live_stream_url) {
      debug(`[tt] stream ${d.live_stream_url.slice(0, 70)}`)
      send({ kind: 'stream', url: d.live_stream_url, ts: now })
    }
  } else if (msg?.endpoint === 'trend') {
    const trend = parseTrend(json, now)
    if (trend) {
      // Discovery: log any series OUTSIDE the four the dashboard itself charts that came
      // back with real data — that is how the viewer metric gets identified (see the
      // stats_type sweep in preload). Logged once per id so a show's log stays readable.
      for (const s of trend.series) {
        if (KNOWN_STATS.has(s.statsType) || statsProbeSeen.has(s.statsType)) continue
        if (!s.total && !s.last) continue
        statsProbeSeen.add(s.statsType)
        flog(`[stats-probe] stats_type=${s.statsType} money=${s.isMoney} total=${s.total} last=${s.last} points=${s.points.length} sample=${s.points.slice(-5).map((p) => p.value).join(',')}`)
      }
      // The series is anchored to the session start; if that anchor ever moves, TikTok has
      // capped it and our "whole show" total has quietly become a rolling window.
      if (trendFirstPointMs && trend.firstPointMs && trend.firstPointMs > trendFirstPointMs) {
        flog(`[trend] WINDOW MOVED: first point ${trendFirstPointMs} → ${trend.firstPointMs} — GMV is no longer whole-show`)
      }
      if (trend.firstPointMs && !trendFirstPointMs) trendFirstPointMs = trend.firstPointMs
      // Only the full poll carries the real GMV series; probe chunks include 341 too, so
      // both are valid samples. Ignore a chunk that came back without it.
      const gmv = trend.series.find((s) => s.statsType === STATS_GMV)
      if (gmv) {
        const paceCents = paceCentsPerHour(gmv.total, showElapsedSec)
        send({
          kind: 'show_totals',
          gmv: { cents: gmv.total, formatted: formatCents(gmv.total) },
          ...(trend.orders !== undefined ? { orders: trend.orders } : {}),
          ...(paceCents !== undefined ? { pace: { cents: paceCents, formatted: formatCents(paceCents) } } : {}),
          ...(showElapsedSec ? { elapsedSec: showElapsedSec } : {}),
          ts: now,
        })
      }
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
    wdLastPinAt = now
    // Liveness/edge trace: AuctionWatch can only fire on a 1→3 TRANSITION, so if pin
    // samples are sparse we silently miss closes. Log every status/lot change plus a
    // periodic heartbeat to show the poll is actually feeding us.
    {
      const c = pin.current
      const sig = `${c?.auctionConfigId ?? '-'}|${c?.status ?? '-'}`
      pinSamples++
      if (sig !== lastPinSig) {
        lastPinSig = sig
        lat(`A3.sample lot=${c?.variantDesc ?? '?'} status=${c?.status ?? '?'} winner=${c?.winUsername ?? '-'} cfg=${c?.auctionConfigId ?? '-'} (sample #${pinSamples})`)
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
interface PrinterConfig { printer: string; rawZpl: boolean }
function loadPrinterConfig(): PrinterConfig {
  try { const j = JSON.parse(readFileSync(PRINTER_FILE, 'utf8')); return { printer: j.printer ?? '', rawZpl: !!j.rawZpl } } catch { return { printer: '', rawZpl: false } }
}
function savePrinterConfig(cfg: PrinterConfig) {
  try { writeFileSync(PRINTER_FILE, JSON.stringify(cfg)) } catch { /* ignore */ }
}
// Cached so the print hot-path doesn't read the file per label.
let rawZplEnabled = false

ipcMain.handle('get-printers', async () => {
  const printers = (await viewer?.webContents.getPrintersAsync()) ?? []
  const cfg = loadPrinterConfig()
  return {
    printers: printers.map((p) => ({ name: p.name, displayName: p.displayName, isDefault: p.isDefault })),
    saved: cfg.printer,
    rawZpl: cfg.rawZpl,
  }
})
ipcMain.handle('save-printer', (_e, name: string) => {
  savePrinterConfig({ printer: name, rawZpl: rawZplEnabled })
  if (name && rawZplEnabled) warmRawPrinter(name)
  return true
})
// Opt-in fast printing: raw ZPL straight to the spooler. Only enable for ZPL-capable
// printers (e.g. Arkscan 2054A) — a non-ZPL printer would print the commands as text.
ipcMain.handle('set-raw-zpl', (_e, enabled: boolean) => {
  rawZplEnabled = !!enabled
  const cfg = loadPrinterConfig()
  savePrinterConfig({ printer: cfg.printer, rawZpl: rawZplEnabled })
  if (rawZplEnabled && cfg.printer) warmRawPrinter(cfg.printer)
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
    // Fast path (opt-in): raw ZPL straight to the spooler (~50ms vs ~1s for the HTML
    // render) — except labels whose text ZPL's built-in font can't draw (emoji/non-Latin),
    // which fall back to the HTML path below.
    if (rawZplEnabled && !labelNeedsHtml(args.labelData, template)) {
      const r = await sendRawToPrinter(args.printerName, labelZpl(args.labelData, template))
      lastPrinterStatus = r.status
      lastPrinterJobs = r.jobs
      if (r.ok) {
        // "Committed to the spooler" is NOT "the label came out". Say so when the device
        // reports a blocking state, so a paused/paper-out printer is visible here instead
        // of surfacing later as a burst of labels nobody expected.
        if (isBlockingStatus(r.status)) flog(`[label] spooled while printer is ${describePrinterStatus(r.status!)} — label may not appear until cleared`)
        return { success: true }
      }
      // Fall back ONLY when the spooler provably has nothing. Past StartDocPrinter a job
      // exists even if the write failed, and a helper timeout means we simply do not know —
      // re-printing either through the HTML path puts TWO labels out for one sale.
      if (r.committed) {
        flog(`[label] raw ZPL failed after the job was committed (${r.detail}) — NOT falling back, one label may be lost`)
        return { success: false, error: r.detail }
      }
      flog(`[label] raw ZPL failed before anything was sent (${r.detail}) — falling back to HTML print`)
    }
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
  const seen = saleSeenAt.get(item)
  const queuedAt = Date.now()
  lat(`E print QUEUED #${item}${seen ? ` (Δrest→queue=${queuedAt - seen}ms, Δws-tick=${lastWsTickAt ? queuedAt - lastWsTickAt : '?'}ms)` : ' (no live origin — manual/range)'}`)
  const run = printChain.then(() => printLabelJob(args))
  printChain = run.catch(() => {})
  return run.then((r) => {
    if (!r.success) wdPrintErrors.push(Date.now())
    const done = Date.now()
    lat(`E print DONE #${item} ok=${r.success} spool=${done - queuedAt}ms${seen ? ` · total(rest→label)=${done - seen}ms` : ''}`)
    saleSeenAt.delete(item)
    return r
  })
})

// Idle printer probe: a `--dryrun` opens/closes the printer without printing, so the
// device's own state is readable even when no label has been dispatched for a while. This
// is the only way a paused / paper-out / offline printer becomes visible BEFORE the labels
// it silently swallowed reappear as a burst. ~50ms warm, once per watchdog tick.
async function probePrinterState(): Promise<void> {
  const cfg = loadPrinterConfig()
  if (!cfg.rawZpl || !cfg.printer) return // HTML path gives us no state to read
  const r = await probeRawPrinter(cfg.printer)
  if (r.status !== undefined) lastPrinterStatus = r.status
  if (r.jobs !== undefined) lastPrinterJobs = r.jobs
}

// ── Watchdog loop: alert the dashboard when a signal path degrades ───────────
setInterval(() => {
  void probePrinterState()
  const now = Date.now()
  while (wdPrintErrors.length && now - wdPrintErrors[0]! > 300000) wdPrintErrors.shift()
  const alerts = evaluateWatchdog({
    now,
    connected,
    pollStartedAt: wdPollStartedAt,
    lastPinSampleAt: wdLastPinAt,
    lastImFrameAt: wdLastImAt,
    salesSinceLastClose: wdSalesSinceClose,
    printErrorsRecent: wdPrintErrors.length,
    ...(wdFirstRestAt !== undefined ? { firstRestAt: wdFirstRestAt } : {}),
    ...(wdLastRestPayloadAt !== undefined ? { lastRestPayloadAt: wdLastRestPayloadAt } : {}),
    ...(lastPrinterStatus !== undefined ? { printerStatus: lastPrinterStatus, printerStatusText: describePrinterStatus(lastPrinterStatus) } : {}),
    ...(lastPrinterJobs !== undefined ? { printerJobs: lastPrinterJobs } : {}),
  })
  // Tell the poll loops to back off while TikTok is challenging us. Continuing to poll a
  // gated endpoint ~4×/sec (2231 of 2300 pin responses in one show were the empty
  // {"code":0}) is the surest way to keep the challenge up, and a gated response carries
  // no data, so nothing is lost by waiting.
  const nowGated = alerts.some((a) => a.code === 'verification-gate')
  if (nowGated !== wdGateSent) {
    wdGateSent = nowGated
    flog(`[tt] poll pacing ${nowGated ? 'THROTTLED (verification gate)' : 'restored'}`)
    monitor?.webContents.send('tt-poll-gate', nowGated)
  }
  const codes = alerts.map((a) => a.code).sort().join(',')
  const edge = codes !== wdLastAlertsJson
  if (!edge && (!alerts.length || now - wdLastSentAt < 60000)) return
  wdLastAlertsJson = codes
  wdLastSentAt = now
  if (edge) flog(alerts.length ? `[watchdog] ${alerts.map((a) => a.message).join(' · ')}` : '[watchdog] clear')
  send({ kind: 'watchdog', alerts, ts: now })
}, 15000)

// ── Diagnostics: reveal the flight-recorder log (+ recent lines to clipboard) ──
ipcMain.handle('tt-diag:open', () => {
  flushFlightLogSync()
  const path = flightLogPath()
  if (!path) return { ok: false }
  try {
    const lines = readFileSync(path, 'utf8').split('\n')
    clipboard.writeText(lines.slice(-200).join('\n'))
  } catch { /* clipboard is best-effort */ }
  shell.showItemInFolder(path)
  return { ok: true, path }
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

// ── Single instance ─────────────────────────────────────────────────────────
// A second copy is not a harmless duplicate window: it opens its OWN monitor, polls
// the same session, and auto-prints every close independently. Print dedup (PrintDedup)
// is per-process, so neither copy can see the other's labels — every lot prints twice,
// and the newcomer's first REST sweep reprints the recent order history as a burst.
// Observed live 2026-09-07: two instances 13s apart put out doubles for ~30 lots, and
// read as a printer fault because each process's own log looked perfectly clean.
// Claim the lock BEFORE whenReady so a losing copy exits without creating a run log,
// a monitor window, or a poll loop.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Someone launched the app again (desktop icon, updater restart). Surface the window
  // that already exists — doing nothing visible is what makes people click a third time.
  app.on('second-instance', () => {
    flog('[app] second instance blocked — focusing the existing window')
    if (!viewer || viewer.isDestroyed()) return
    if (viewer.isMinimized()) viewer.restore()
    viewer.show()
    viewer.focus()
  })
  void app.whenReady().then(startApp)
}

function startApp() {
  initFlightLog(join(app.getPath('userData'), 'logs'), `TikTok Live Monitor v${app.getVersion()} · started ${new Date().toISOString()}`)
  app.userAgentFallback = CHROME_UA
  Menu.setApplicationMenu(null) // remove the native File/Edit/View/Window/Help menu bar
  nativeTheme.themeSource = 'dark' // dark native title bar (min/max/close) to match the body
  // Raw-ZPL fast printing (opt-in): load the setting and warm the helper so the first
  // label isn't paying the ~900ms cold .NET start.
  const pcfg = loadPrinterConfig()
  rawZplEnabled = pcfg.rawZpl
  if (pcfg.rawZpl && pcfg.printer) warmRawPrinter(pcfg.printer)
  createViewer()
  if (process.env.TT_REPLAY) {
    setTimeout(replayFixtures, 1200)
  } else {
    createMonitor()
  }
  initAutoUpdate()
}
app.on('window-all-closed', () => app.quit())
// On quit, force-close any window so a page-level beforeunload (TikTok registers
// one) can't veto the exit and strand the process. destroy() skips beforeunload.
app.on('before-quit', () => {
  flog('[app] quit')
  flushFlightLogSync()
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.destroy() } catch { /* ignore */ }
  }
})
// Last-resort net: a stray async throw during teardown must never strand the app
// behind the native "JavaScript error" dialog (which forces a Task Manager kill).
// Log loudly so real bugs are still visible; the guards above are the actual fix.
process.on('uncaughtException', (err) => { console.error('[main] uncaughtException:', err); flog(`[main] uncaughtException: ${err?.stack ?? err}`); flushFlightLogSync() })
process.on('unhandledRejection', (err) => { console.error('[main] unhandledRejection:', err) })
