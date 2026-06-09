import { app, BrowserWindow, ipcMain, session } from 'electron'
import { join } from 'node:path'
import { decodeFrame } from '../core/decoder'
import { mapCreatorMessage, parseManagerEnrichment } from '../core/mapper'
import { RosterDiffer } from '../core/rosterDiffer'
import { SaleDeduper } from '../core/normalizer'
import type { LiveEvent, StatusEvent } from '../core/types'

const DASHBOARD = 'https://shop.tiktok.com/streamer/live/event/dashboard'
// Where the monitor window first opens. Set TT_START_URL to log in via Seller
// Center (https://seller-us.tiktok.com/) — its TikTok SSO session also covers the
// streamer dashboard, so a later launch onto DASHBOARD is already authenticated.
const START_URL = process.env.TT_START_URL || DASHBOARD
const LOGIN_RE = /\/(login|passport|account\/login)/

// TikTok's login/anti-bot keys off the User-Agent; the default Electron UA
// (which contains "Electron/…") triggers ticket-expired/refusal flows. Present
// as a normal Chrome-on-Windows browser (matches what real captures showed).
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

let viewer: BrowserWindow | null = null
let monitor: BrowserWindow | null = null
const differ = new RosterDiffer()
const deduper = new SaleDeduper()

function send(ev: LiveEvent) {
  viewer?.webContents.send('tt-live-event', ev)
}

function createViewer() {
  viewer = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: { preload: join(__dirname, 'preload-viewer.cjs') },
  })
  void viewer.loadFile(join(__dirname, 'index.html'))
}

function createMonitor() {
  const part = session.fromPartition('persist:tiktok')
  monitor = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      session: part,
      // The preload must share the page's main world to observe the page's own
      // XMLHttpRequest (signed by TikTok's SDK). Production should instead inject
      // a main-world script (like desktop/electron/whatnot-monitor-preload.ts).
      contextIsolation: false,
      sandbox: false,
      preload: join(__dirname, 'preload.cjs'),
    },
  })
  // Let TikTok's login/captcha popups open as child windows that share this
  // partition (so the auth ticket round-trips in the same session). Restrict to
  // TikTok origins and keep popups at secure defaults — only the main monitor
  // window needs the relaxed isolation (for the XHR hook).
  monitor.webContents.setWindowOpenHandler(({ url }) => {
    let host = ''
    try {
      host = new URL(url).hostname.toLowerCase()
    } catch {
      return { action: 'deny' }
    }
    const allowed =
      host === 'tiktok.com' ||
      host.endsWith('.tiktok.com') ||
      host === 'tiktokv.com' ||
      host.endsWith('.tiktokv.com')
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
    if (LOGIN_RE.test(url)) {
      send({ kind: 'status', status: 'needs-login', detail: 'Log in to TikTok in the monitor window' })
    }
  })
}

ipcMain.on('tt-status', (_e, s: { status: StatusEvent['status']; detail?: string }) => {
  send({ kind: 'status', status: s.status, detail: s.detail })
})

ipcMain.on('tt-stream-frame', (_e, bytes: Uint8Array) => {
  for (const msg of decodeFrame(bytes)) {
    if (msg.method === 'WebcastOecLiveCreatorMessage') {
      const ev = mapCreatorMessage(msg.payload)
      if (ev) {
        if (ev.kind === 'sale' && !deduper.accept(ev)) continue
        send(ev)
      }
    } else if (msg.method === 'WebcastOecLiveManagerMessage') {
      const enrich = parseManagerEnrichment(msg.payload)
      if (enrich.buyer) {
        send({ kind: 'status', status: 'connected', detail: `high bidder: @${enrich.buyer.username}` })
      }
    }
  }
})

ipcMain.on('tt-roster', (_e, raw: unknown) => {
  const { snapshot, sales } = differ.ingest(raw as Parameters<RosterDiffer['ingest']>[0], Date.now())
  send(snapshot)
  for (const s of sales) if (deduper.accept(s)) send(s)
})

app.whenReady().then(() => {
  app.userAgentFallback = CHROME_UA
  createViewer()
  createMonitor()
})
app.on('window-all-closed', () => app.quit())
