import { app, BrowserWindow, ipcMain, session } from 'electron'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { parsePushFrame } from '../core/pushFrame'
import { LiveFeed } from '../core/liveFeed'
import { parseRoster } from '../core/roster'
import { AuctionResults } from '../core/auctionResults'
import { decodeChat } from '../core/chat'
import { labelHtml, LABEL_SIZES, DEFAULT_TEMPLATE, type LabelData, type LabelTemplate } from './label'
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
const feed = new LiveFeed()
const auctionResults = new AuctionResults()
let connected = false

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
  const part = session.fromPartition('persist:tiktok')
  monitor = new BrowserWindow({
    width: 1280,
    height: 860,
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
const GEMINI_KEY = process.env.GEMINI_API_KEY || ''
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

// Manual "Sync orders" from the UI → force an immediate REST poll cycle.
ipcMain.handle('tt-sync', () => {
  if (!pollRoomId || !pollSessionId) return { ok: false, reason: 'Not connected to a live show yet' }
  if (!monitor) return { ok: false, reason: 'Monitor window unavailable' }
  if (!pollSent) maybeStartPolling()
  else monitor.webContents.send('tt-poll-now')
  return { ok: true }
})

ipcMain.handle('recap-enabled', () => ({ enabled: !!GEMINI_KEY, model: GEMINI_MODEL }))

interface TranscriptFields { brand?: string; item?: string; color?: string; size?: string; retailPrice?: string; summary?: string }

ipcMain.handle('tt-transcribe', async (_e, payload: { audio?: Uint8Array; productName?: string; structured?: boolean }) => {
  if (!GEMINI_KEY) return { error: 'GEMINI_API_KEY not set' }
  const audio = payload?.audio instanceof Uint8Array ? payload.audio : new Uint8Array(payload?.audio ?? [])
  if (!audio.byteLength) return { error: 'no audio captured' }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`
  const label = payload?.productName ?? ''
  const clip = { inlineData: { mimeType: 'audio/webm', data: Buffer.from(audio).toString('base64') } }

  // Structured mode: extract product attributes (brand/size/retail…) for costing + the ledger.
  if (payload?.structured) {
    const prompt =
      `This is a short audio clip from a live-shopping auction selling an item labeled "${label}". ` +
      `From the seller's speech, extract the product attributes. Use an empty string for anything not stated. ` +
      `retailPrice is the stated retail/MSRP if mentioned (e.g. "$120"). summary is a one-line plain-English description.`
    const body = {
      contents: [{ parts: [{ text: prompt }, clip] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            brand: { type: 'string' }, item: { type: 'string' }, color: { type: 'string' },
            size: { type: 'string' }, retailPrice: { type: 'string' }, summary: { type: 'string' },
          },
        },
      },
    }
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } }
      if (!res.ok) return { error: `gemini ${res.status}: ${json?.error?.message ?? ''}`.slice(0, 200) }
      const raw = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim()
      let fields: TranscriptFields = {}
      try { fields = JSON.parse(raw) as TranscriptFields } catch { /* fall back to summary text below */ }
      // drop empties so the renderer can tell what was actually captured
      fields = Object.fromEntries(Object.entries(fields).filter(([, v]) => v && String(v).trim())) as TranscriptFields
      const text = fields.summary || raw
      debug(`[tt] structured fields: ${Object.keys(fields).join(',')}`)
      return { text, fields }
    } catch (e) {
      return { error: (e as Error).message }
    }
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
  createViewer()
  if (process.env.TT_REPLAY) {
    setTimeout(replayFixtures, 1200)
  } else {
    createMonitor()
  }
})
app.on('window-all-closed', () => app.quit())
