import { app, BrowserWindow, ipcMain, session } from 'electron'
import { join } from 'node:path'
import { decodeFrame } from '../core/decoder'
import { mapCreatorMessage, parseManagerEnrichment } from '../core/mapper'
import { RosterDiffer } from '../core/rosterDiffer'
import { SaleDeduper } from '../core/normalizer'
import type { LiveEvent, StatusEvent } from '../core/types'

const DASHBOARD = 'https://shop.tiktok.com/streamer/live/event/dashboard'
const LOGIN_RE = /\/(login|passport|account\/login)/

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
  void monitor.loadURL(DASHBOARD)
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
  createViewer()
  createMonitor()
})
app.on('window-all-closed', () => app.quit())
