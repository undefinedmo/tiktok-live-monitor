import { app, BrowserWindow, ipcMain, session, Menu, nativeTheme } from 'electron'
import { join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { parsePushFrame } from '../core/pushFrame'
import { LiveFeed } from '../core/liveFeed'
import { parseRoster } from '../core/roster'
import { AuctionResults } from '../core/auctionResults'
import { decodeChat } from '../core/chat'
import { labelHtml, LABEL_SIZES, DEFAULT_TEMPLATE, type LabelData, type LabelTemplate } from './label'
import { pullTiktokOrders, orderToSale, fetchOrderDetails } from './tiktok-orders'
import { buildAudioClip } from './clip'
import type { LiveEvent, StatusEvent } from '../core/types'

const DASHBOARD = 'https://shop.tiktok.com/streamer/live/event/dashboard'
// Set TT_START_URL to log in via Seller Center (https://seller-us.tiktok.com/) —
// its TikTok SSO session also covers the streamer dashboard.
const START_URL = process.env.TT_START_URL || DASHBOARD
const LOGIN_RE = /\/(login|passport|account\/login)/
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

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

// Once the WS stream yields room_id + session_id, tell the preload to start
// polling the roster + sale-history REST endpoints itself.
let pollRoomId: string | undefined
let pollSessionId: string | undefined
let pollSent = false
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
const debug = (line: string) => { if (process.env.TT_DEBUG) console.log(line) }

function send(ev: LiveEvent) {
  viewer?.webContents.send('tt-live-event', ev)
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
}

// Open TikTok Seller Center in its own window so the user can log in for order Sync.
// Shares the persisted session (so cookies/auth are reused) but is NOT the Live Monitor.
function openSellerLogin() {
  if (seller && !seller.isDestroyed()) { seller.show(); seller.focus(); return }
  seller = new BrowserWindow({
    width: 1100, height: 820, backgroundColor: '#07080b', autoHideMenuBar: true,
    title: 'TikTok Seller Center — log in for Sync',
    webPreferences: { session: session.fromPartition(TT_PARTITION) },
  })
  seller.on('closed', () => { seller = null })
  void seller.loadURL('https://seller-us.tiktok.com/order')
}

ipcMain.on('tt-status', (_e, s: { status: StatusEvent['status']; detail?: string }) => {
  send({ kind: 'status', status: s.status, detail: s.detail })
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
    const sales = orders.map(orderToSale)
    send({ kind: 'orders', orders: sales, total, ts: Date.now() })
    debug(`[tt] synced ${sales.length}/${total} orders`)
    return { ok: true, count: sales.length }
  } catch (e) {
    const msg = (e as Error).message
    // an auth/session failure on the order endpoint → prompt a Seller-Center re-login
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
  audio: Uint8Array,
  mimeType: string,
  _label: string,
): Promise<{ fields?: TranscriptFields; text?: string; error?: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`
  const clip = { inlineData: { mimeType, data: Buffer.from(audio).toString('base64') } }
  const body = {
    contents: [{ parts: [{ text: transcribePrompt(null) }, clip] }],
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
    return geminiStructured(audio, 'audio/webm', label)
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
ipcMain.handle('tt-transcribe-orders', async (_e, items: { orderId: string; productName?: string }[]) => {
  if (!GEMINI_KEY) return { error: 'GEMINI_API_KEY not set' }
  if (!(await tiktokLoggedIn())) return { error: 'Log into TikTok Seller Center (cookies needed for order video receipts)' }
  const cookieHeader = await tiktokCookieHeader()
  const ids = items.map((i) => i.orderId)
  const details = await fetchOrderDetails(ids, cookieHeader)
  const results: { orderId: string; fields: TranscriptFields }[] = []
  const errors: { orderId: string; error: string }[] = []
  for (const it of items) {
    const d = details.get(it.orderId)
    if (!d?.videoUrl) { errors.push({ orderId: it.orderId, error: 'no video receipt' }); continue }
    try {
      const audio = await buildAudioClip(d.videoUrl, d.receiptTsMs != null ? Math.round(d.receiptTsMs / 1000) : null)
      if (!audio || audio.byteLength < 1000) { errors.push({ orderId: it.orderId, error: 'clip failed' }); continue }
      const r = await geminiStructured(audio, 'audio/aac', it.productName ?? '')
      if (r.fields && Object.keys(r.fields).length) results.push({ orderId: it.orderId, fields: r.fields })
      else if (r.text) results.push({ orderId: it.orderId, fields: { summary: r.text } })
      else errors.push({ orderId: it.orderId, error: r.error ?? 'no transcript' })
    } catch (e) { errors.push({ orderId: it.orderId, error: String((e as Error).message).slice(0, 120) }) }
  }
  return { results, errors }
})

ipcMain.handle('print-label', async (_e, args: { labelData: LabelData; printerName: string; template?: LabelTemplate }) => {
  let win: BrowserWindow | null = null
  try {
    const template = args.template ?? DEFAULT_TEMPLATE
    const size = LABEL_SIZES[template.labelSize] ?? LABEL_SIZES['2x1']
    win = new BrowserWindow({ width: 240, height: 130, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(labelHtml(args.labelData, template)))
    await new Promise((r) => setTimeout(r, 350))
    await new Promise<void>((resolve, reject) => {
      win!.webContents.print(
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
  } finally {
    win?.close()
  }
})

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
})
app.on('window-all-closed', () => app.quit())
