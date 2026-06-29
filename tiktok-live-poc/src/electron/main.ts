import { app, BrowserWindow, dialog, ipcMain, session, Menu, nativeTheme, net } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, rmSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { parsePushFrame } from '../core/pushFrame'
import { LiveFeed } from '../core/liveFeed'
import { parseRoster } from '../core/roster'
import { parsePin } from '../core/pin'
import { AuctionResults } from '../core/auctionResults'
import { decodeChat } from '../core/chat'
import { labelHtml, LABEL_SIZES, DEFAULT_TEMPLATE, type LabelData, type LabelTemplate } from './label'
import { pullTiktokOrders, fetchOrderDetails, pullTiktokOrdersSince, applyOrderDetails, filterOrdersForShow, SHOW_SYNC_BUFFER_MS } from './tiktok-orders'
import { openDb, upsertOrders, getSnapshot, setCost, setTranscript, setPicked, getShows, setShows, importLegacy, rekeyProductTemplates, setShowNames, getOrdersByFulfillUnit, insertLabelBatch, insertLabelPages, getOrdersForRestack, listLabelBatches, getLabelBatch, getLabelPages, clearLabels, setPacked, setBatchStatus, type LegacyBlob } from './db'
import { parseGenerateCapture } from '../core/restack/capture'
import { tieByGenerateOrder } from '../core/restack/tie'
import { orderedOrders, type RestackOrder } from '../core/restack/sortlogic'
import { binOf } from '../core/restack/bins'
import { pdfPageCount, reorderLabels, extractPage, buildPackingSheet, type SheetRow } from './label-pdf'
import { parseShowList, roomNameMap, type ShowListing } from '../core/showList'
import { buildClipMedia } from './clip'
import type { LiveEvent, StatusEvent } from '../core/types'

const DASHBOARD = 'https://shop.tiktok.com/streamer/live/event/dashboard'
// Set TT_START_URL to log in via Seller Center (https://seller-us.tiktok.com/) —
// its TikTok SSO session also covers the streamer dashboard.
const START_URL = process.env.TT_START_URL || DASHBOARD
const LOGIN_RE = /\/(login|passport|account\/login)/
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

let db: ReturnType<typeof openDb> | null = null
let viewer: BrowserWindow | null = null
let monitor: BrowserWindow | null = null
let seller: BrowserWindow | null = null // Seller-Center login window for order Sync (independent of the Live Monitor)
const feed = new LiveFeed()
const auctionResults = new AuctionResults()
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
/** Build the Cookie header the way the browser would send it to Seller Center. */
async function tiktokCookieHeader(): Promise<string> {
  const cookies = await session.fromPartition(TT_PARTITION).cookies.get({ url: 'https://seller-us.tiktok.com' })
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

async function ensureMonitorLoaded(): Promise<boolean> {
  if (!monitor || monitor.isDestroyed()) createMonitor()
  if (!monitor || monitor.isDestroyed()) return false
  const wc = monitor.webContents
  if (!wc.isLoading()) return true
  await new Promise<void>((resolve) => {
    let t: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      clearTimeout(t)
      wc.removeListener('did-finish-load', done)
      resolve()
    }
    wc.once('did-finish-load', done)
    t = setTimeout(done, 10000) // don't hang forever if the page stalls
  })
  return true
}

let showsReqSeq = 0
/** Ask the monitor page (signed streamer context) to fetch live_session/list, parse the
 *  returned pages, persist the roomId→name map, and return the ShowListings. */
async function fetchShowList(): Promise<{ ok: boolean; shows?: ShowListing[]; needsLogin?: boolean; capped?: boolean; reason?: string }> {
  if (!(await tiktokLoggedIn())) { openSellerLogin(); return { ok: false, needsLogin: true } }
  if (!(await ensureMonitorLoaded())) return { ok: false, reason: 'monitor window unavailable' }
  const id = ++showsReqSeq
  const pages: string[] = await new Promise((resolve) => {
    const timer = setTimeout(() => { ipcMain.removeListener('tt-shows-result', onResult); resolve([]) }, 15000)
    const onResult = (_e: unknown, res: { id: number; ok: boolean; pages: string[] }) => {
      if (res.id !== id) return
      clearTimeout(timer); ipcMain.removeListener('tt-shows-result', onResult)
      resolve(res.ok ? res.pages : [])
    }
    ipcMain.on('tt-shows-result', onResult)
    monitor!.webContents.send('tt-shows-fetch', { id })
  })
  if (!pages.length) return { ok: true, shows: [], capped: true }
  const shows = pages.flatMap((p) => parseShowList(p))
  if (db) {
    const names: Record<string, { sessionId: string; name: string; startMs: number }> = {}
    roomNameMap(shows).forEach((v, k) => { names[k] = v })
    setShowNames(db, names)
  }
  return { ok: true, shows }
}

// Once the WS stream yields room_id + session_id, tell the preload to start
// polling the roster + sale-history REST endpoints itself.
let pollRoomId: string | undefined
let pollSessionId: string | undefined
let pollSent = false
let lastSalePollNow = 0 // debounce WS-sale-triggered immediate polls
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
if (process.env.TT_CAPTURE) { try { mkdirSync(CAP_DIR, { recursive: true }) } catch { /* ignore */ } }
function capture(file: string | null, rec: unknown) {
  if (!file) return
  try { appendFileSync(file, JSON.stringify(rec) + '\n') } catch { /* ignore */ }
}

function labelsDir(): string {
  const d = join(app.getPath('userData'), 'labels')
  try { mkdirSync(d, { recursive: true }) } catch { /* ignore */ }
  return d
}
const debug = (line: string) => { if (process.env.TT_DEBUG) console.log(line) }

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

// Open TikTok Seller Center in its own window so the user can log in for order Sync.
// Shares the persisted session (so cookies/auth are reused) but is NOT the Live Monitor.
function openSellerLogin() {
  if (seller && !seller.isDestroyed()) { seller.show(); seller.focus(); return }
  seller = new BrowserWindow({
    width: 1100, height: 820, backgroundColor: '#07080b', autoHideMenuBar: true,
    title: 'TikTok Seller Center — log in for Sync',
    webPreferences: {
      session: session.fromPartition(TT_PARTITION),
      contextIsolation: false,
      sandbox: false,
      preload: join(__dirname, 'preload-seller.cjs'),
    },
  })
  seller.on('closed', () => { seller = null })
  void seller.loadURL('https://seller-us.tiktok.com/order')
}

ipcMain.on('tt-status', (_e, s: { status: StatusEvent['status']; detail?: string }) => {
  send({ kind: 'status', status: s.status, detail: s.detail })
})

ipcMain.on('tt-label-batch', async (_e, msg: { url?: string; reqBody?: string; respBody?: string }) => {
  if (!db) return
  const cap = parseGenerateCapture(msg?.reqBody ?? '', msg?.respBody ?? '')
  if (!cap.fulfillUnitIds.length || !cap.docUrl) { debug('[tt] label batch: missing units or doc_url'); return }
  const batchId = String(Date.now())
  const pdfPath = join(labelsDir(), `${batchId}.pdf`)
  try {
    // doc_url is pre-signed (skipCookie=true); fetch via electron net.
    const res = await net.fetch(cap.docUrl)
    if (!res.ok) throw new Error(`doc_url HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length < 5 || Buffer.from(bytes.slice(0, 5)).toString() !== '%PDF-') throw new Error('not a PDF')
    writeFileSync(pdfPath, bytes)
    const pageCount = await pdfPageCount(bytes)
    const ties = tieByGenerateOrder(cap.fulfillUnitIds, getOrdersByFulfillUnit(db))
    const status = pageCount === cap.fulfillUnitIds.length ? 'tied' : 'page_mismatch' // page/unit mismatch -> barcode-tie fallback (Task 13)
    insertLabelBatch(db, {
      id: batchId, capturedAt: Date.now(), roomId: pollRoomId ?? null, docUrl: cap.docUrl, pdfPath,
      pageCount, unitCount: cap.fulfillUnitIds.length, status,
      requestJson: JSON.stringify(cap.fulfillUnitIds), statsJson: JSON.stringify(cap.statsUnitIds),
    })
    insertLabelPages(db, batchId, ties)
    debug(`[tt] label batch ${batchId}: ${pageCount}p / ${cap.fulfillUnitIds.length}u status=${status}`)
    viewerSend('tt-label-batch-ready', { batchId, pageCount, unitCount: cap.fulfillUnitIds.length, status })
  } catch (e) {
    insertLabelBatch(db, {
      id: batchId, capturedAt: Date.now(), roomId: pollRoomId ?? null, docUrl: cap.docUrl, pdfPath: null,
      pageCount: 0, unitCount: cap.fulfillUnitIds.length, status: 'error',
      requestJson: JSON.stringify(cap.fulfillUnitIds), statsJson: JSON.stringify(cap.statsUnitIds),
    })
    debug(`[tt] label batch ${batchId} failed: ${(e as Error).message}`)
    viewerSend('tt-label-batch-ready', { batchId, status: 'error', error: (e as Error).message })
  }
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

// Source 1: frontier WebSocket → aggregate live stats.
ipcMain.on('tt-ws-frame', (_e, msg: { url?: string; data?: Uint8Array }) => {
  const raw = msg?.data instanceof Uint8Array ? msg.data : new Uint8Array(msg?.data ?? [])
  capture(CAP_WS, { url: msg?.url ?? '', bytes: raw.byteLength, b64: Buffer.from(raw).toString('base64') })
  const frame = parsePushFrame(raw)
  if (!frame) return
  let buf = Buffer.from(frame.payload)
  if (frame.payloadEncoding === 'gzip' || (buf[0] === 0x1f && buf[1] === 0x8b)) {
    try { buf = gunzipSync(buf) } catch { return }
  }
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
      if (t - lastSalePollNow > 600) { lastSalePollNow = t; monitor?.webContents.send('tt-poll-now') }
    }
    send(ev)
  }
})

// Source 4: webcast/im/fetch protobuf → viewer comments.
ipcMain.on('tt-im-frame', (_e, bytes: Uint8Array) => {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const items = decodeChat(raw)
  if (items.length) {
    debug(`[tt] chat +${items.length}`)
    send({ kind: 'chat', items, ts: Date.now() })
  }
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
    send(update)
  } else if (msg?.endpoint === 'room_status') {
    const url = (json as { data?: { live_stream_url?: string } })?.data?.live_stream_url
    if (url) {
      debug(`[tt] stream ${url.slice(0, 70)}`)
      send({ kind: 'stream', url, ts: now })
    }
  } else if (msg?.endpoint === 'pin') {
    send(parsePin(json, now))
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

// ── SQLite DB IPC handlers ────────────────────────────────────────────────────
ipcMain.handle('tt-db:getSnapshot', () => (db ? getSnapshot(db) : { orders: [], costs: {}, productCosts: {}, orderTx: {}, productTx: {}, picked: [], shows: {} }))
ipcMain.handle('tt-db:setCost', (_e, p: { orderId: string; cents: number | null }) => { if (db) setCost(db, 'order', p.orderId, p.cents, Date.now()); return true })
ipcMain.handle('tt-db:setProductCost', (_e, p: { productId: string; cents: number | null }) => { if (db) setCost(db, 'product', p.productId, p.cents, Date.now()); return true })
ipcMain.handle('tt-db:setTranscript', (_e, p: { scope: 'order' | 'product'; key: string; transcript: unknown | null }) => { if (db) setTranscript(db, p.scope, p.key, p.transcript as never, Date.now()); return true })
ipcMain.handle('tt-db:setPicked', (_e, p: { orderId: string; picked: boolean }) => { if (db) setPicked(db, p.orderId, p.picked, Date.now()); return true })
ipcMain.handle('tt-db:getShows', () => (db ? getShows(db) : {}))
ipcMain.handle('tt-db:setShows', (_e, store: unknown) => { if (db) setShows(db, store); return true })
ipcMain.handle('tt-db:importLegacy', (_e, blob: LegacyBlob) => { if (db) importLegacy(db, blob, Date.now()); return true })

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

// "Sync orders" → pull the Seller-Center order book via the persisted session cookies.
// Cookie auth only (no request signing). Entirely independent of the Live Monitor: if the
// user isn't logged in, we open the Seller-Center window (NOT the monitor) to log in.
let orderSyncing = false
ipcMain.handle('tt-sync', async () => {
  if (orderSyncing) return { ok: false, reason: 'Sync already running' }
  if (!(await tiktokLoggedIn())) {
    openSellerLogin()
    return { ok: false, reason: 'Log into TikTok Seller Center (window opened), then Sync again' }
  }
  orderSyncing = true
  try {
    const cookieHeader = await tiktokCookieHeader()
    const { orders, total } = await pullTiktokOrders(cookieHeader)
    const now = Date.now()
    if (db) { upsertOrders(db, orders, now); rekeyProductTemplates(db, now) }
    debug(`[tt] synced ${orders.length}/${total} orders`)
    return { ok: true, count: orders.length }
  } catch (e) {
    const msg = (e as Error).message
    if (/code\s|HTTP 401|session may be expired/i.test(msg)) openSellerLogin()
    return { ok: false, reason: msg.slice(0, 160) }
  } finally {
    orderSyncing = false
  }
})

ipcMain.handle('tt-shows-list', async () => {
  try { return await fetchShowList() }
  catch (e) { return { ok: false, reason: (e as Error).message.slice(0, 160) } }
})

ipcMain.handle('tt-sync-show', async (_e, arg: { roomIds: string[]; startMs: number; endMs: number }) => {
  if (orderSyncing) return { ok: false, reason: 'Sync already running' }
  if (!(await tiktokLoggedIn())) { openSellerLogin(); return { ok: false, reason: 'Log into TikTok Seller Center (window opened), then Sync again' } }
  orderSyncing = true
  try {
    const cookieHeader = await tiktokCookieHeader()
    const since = arg.startMs - SHOW_SYNC_BUFFER_MS
    const { orders } = await pullTiktokOrdersSince(cookieHeader, since)
    const details = await fetchOrderDetails(orders.map((o) => o.externalOrderId), cookieHeader)
    const enriched = applyOrderDetails(orders, details)
    const kept = filterOrdersForShow(enriched, arg.roomIds, arg.startMs - SHOW_SYNC_BUFFER_MS, arg.endMs + SHOW_SYNC_BUFFER_MS)
    const now = Date.now()
    if (db) { upsertOrders(db, kept, now); rekeyProductTemplates(db, now) }
    debug(`[tt] show-sync kept ${kept.length}/${orders.length} orders`)
    return { ok: true, count: kept.length }
  } catch (e) {
    const msg = (e as Error).message
    if (/code\s|HTTP 401|session may be expired/i.test(msg)) openSellerLogin()
    return { ok: false, reason: msg.slice(0, 160) }
  } finally {
    orderSyncing = false
  }
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

// Transcribe INDIVIDUAL ORDERS from their Seller-Center video receipts (not live bins).
// For each order: order/get → per-order video receipt .m3u8 + sale-moment offset → ffmpeg audio
// clip ending at the sale → structured Gemini extraction. Cookie auth (Seller Center) required.
ipcMain.handle('tt-transcribe-orders', async (_e, items: { orderId: string; productName?: string; placedAtMs?: number }[]) => {
  if (!GEMINI_KEY) return { error: 'GEMINI_API_KEY not set' }
  if (!(await tiktokLoggedIn())) return { error: 'Log into TikTok Seller Center (cookies needed for order video receipts)' }
  const cookieHeader = await tiktokCookieHeader()
  const total = items.length
  const progress = (done: number, orderId: string, phase: 'start' | 'done', ok?: boolean) =>
    viewerSend('tt-transcribe-progress', { done, total, orderId, phase, ok })
  const ids = items.map((i) => i.orderId)
  const details = await fetchOrderDetails(ids, cookieHeader)
  const results: { orderId: string; fields: TranscriptFields }[] = []
  const errors: { orderId: string; error: string }[] = []
  let completed = 0

  // process one order: ONE ffmpeg pass (audio + 5 frames) → Gemini
  const processOne = async (it: { orderId: string; productName?: string; placedAtMs?: number }) => {
    progress(completed, it.orderId, 'start')
    let ok = false
    try {
      const d = details.get(it.orderId)
      if (!d?.videoUrl) {
        errors.push({ orderId: it.orderId, error: 'no video receipt' })
      } else {
        // seek by the ORDER's placed-at epoch (the sale moment) — same as live-ledger.
        const atSec = it.placedAtMs != null ? Math.floor(it.placedAtMs / 1000) : null
        const { audio, frames } = await buildClipMedia(d.videoUrl, atSec, 5)
        if (!audio || audio.byteLength < 1000) {
          errors.push({ orderId: it.orderId, error: 'clip failed' })
        } else {
          const media = [...frames.map((f) => ({ mimeType: 'image/jpeg', data: f })), { mimeType: 'audio/aac', data: audio }]
          const r = await geminiStructured(media, it.productName ?? '')
          if (r.fields && Object.keys(r.fields).length) { results.push({ orderId: it.orderId, fields: r.fields }); ok = true }
          else if (r.text) { results.push({ orderId: it.orderId, fields: { summary: r.text } }); ok = true }
          else errors.push({ orderId: it.orderId, error: r.error ?? 'no transcript' })
        }
      }
    } catch (e) {
      errors.push({ orderId: it.orderId, error: String((e as Error).message).slice(0, 120) })
    }
    progress(++completed, it.orderId, 'done', ok)
  }

  // run with bounded concurrency (ffmpeg + Gemini are I/O-bound; keep it modest for rate limits)
  const CONCURRENCY = Math.min(4, items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) { const i = next++; await processOne(items[i]!) }
    }),
  )
  return { results, errors }
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
  printWin = new BrowserWindow({ width: 240, height: 130, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
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
  const run = printChain.then(() => printLabelJob(args))
  printChain = run.catch(() => {})
  return run
})

// ── Picklist / label batch IPC handlers ──────────────────────────────────────
ipcMain.handle('tt-label:list', () => (db ? listLabelBatches(db).map((b) => ({ id: b.id, capturedAt: b.capturedAt, pageCount: b.pageCount, unitCount: b.unitCount, status: b.status })) : []))

ipcMain.handle('tt-label:get', (_e, batchId: string) => {
  if (!db) return null
  const batch = getLabelBatch(db, batchId)
  if (!batch) return null
  const pages = getLabelPages(db, batchId)
  const units = new Set(JSON.parse(batch.requestJson) as string[])
  const orders = getOrdersForRestack(db).filter((o) => o.fulfillUnitId && units.has(o.fulfillUnitId))
  return { batch, pages, orders }
})

ipcMain.handle('tt-label:pagePdf', async (_e, p: { batchId: string; pageIndex: number }) => {
  if (!db) return null
  const batch = getLabelBatch(db, p.batchId)
  if (!batch?.pdfPath) return null
  try { return await extractPage(new Uint8Array(readFileSync(batch.pdfPath)), p.pageIndex) } catch { return null }
})

function restackSequence(orders: ReturnType<typeof getOrdersForRestack>): string[] {
  const ro: RestackOrder[] = orders.map((o) => ({ orderId: o.orderId, buyer: o.buyer, createdMs: o.placedAt }))
  return orderedOrders(ro).map((o) => o.orderId)
}

ipcMain.handle('tt-label:export', async (_e, p: { batchId: string; kind: 'labels' | 'sheet' }) => {
  if (!db) return { ok: false, error: 'no db' }
  const batch = getLabelBatch(db, p.batchId)
  if (!batch?.pdfPath) return { ok: false, error: 'batch has no PDF' }
  const pages = getLabelPages(db, p.batchId)
  const orders = getOrdersForRestack(db).filter((o) => o.fulfillUnitId && pages.some((pg) => pg.fulfillUnitId === o.fulfillUnitId))
  const seq = restackSequence(orders)
  // map order -> the page index of its fulfill_unit
  const pageOfUnit = new Map(pages.map((pg) => [pg.fulfillUnitId, pg.pageIndex]))
  const unitOfOrder = new Map(orders.map((o) => [o.orderId, o.fulfillUnitId!]))
  try {
    let bytes: Uint8Array
    let suggested: string
    if (p.kind === 'labels') {
      const pageSeq = seq.map((oid) => pageOfUnit.get(unitOfOrder.get(oid)!)).filter((i): i is number => i != null)
      bytes = await reorderLabels(new Uint8Array(readFileSync(batch.pdfPath)), [...new Set(pageSeq)])
      suggested = 'Labels_sorted_newest_to_oldest.pdf'
    } else {
      const byId = new Map(orders.map((o) => [o.orderId, o]))
      const rows: SheetRow[] = seq.map((oid, i) => {
        const o = byId.get(oid)!
        const items = o.items.map((it) => `${it.sku ?? '?'} (Bin ${binOf(it.productName)})`).join(', ')
        return { seq: i + 1, buyer: o.buyer, purchased: o.placedAt ? new Date(o.placedAt).toLocaleTimeString() : '', items, multi: o.items.length > 1 }
      })
      bytes = await buildPackingSheet(rows)
      suggested = 'Packing_sheet.pdf'
    }
    const save = await dialog.showSaveDialog({ defaultPath: suggested })
    if (save.canceled || !save.filePath) return { ok: false, error: 'cancelled' }
    writeFileSync(save.filePath, bytes)
    setBatchStatus(db, p.batchId, 'exported')
    return { ok: true, path: save.filePath }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
})

ipcMain.handle('tt-label:clear', () => {
  if (!db) return { ok: false }
  for (const path of clearLabels(db)) { try { unlinkSync(path) } catch { /* ignore */ } }
  try { rmSync(labelsDir(), { recursive: true, force: true }) } catch { /* ignore */ }
  return { ok: true }
})

ipcMain.handle('tt-label:setPacked', (_e, p: { orderId: string; packed: boolean }) => { if (db) setPacked(db, p.orderId, p.packed, Date.now()); return true })

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
  db = openDb(join(app.getPath('userData'), 'tiktok.db'))
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
