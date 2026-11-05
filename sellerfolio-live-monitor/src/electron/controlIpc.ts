// LANE A — main-process side of the shell: window zoom (Text size A−/A+, per computer) and the
// hardware keys (F14 = Print last). Bridge: preload-viewer.ts `controlAPI`.
//
// Channels (fixed by the scaffold — keep the names):
//   invoke 'ctl:zoom-get'            → number   (current zoom factor, 1 = 100%)
//   invoke 'ctl:zoom-set' (factor)   → number   (the factor actually applied)
//   event  'ctl:key'      (key)      main → viewer, e.g. 'F14'
//
// Nothing here is on the print path. The Text size file is read once, asynchronously, at start and
// written asynchronously on change — never a blocking read/write on the main thread.

import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { controlKeyOf, parseSavedZoom, pctToFactor } from '../core/shellControls'

export interface ControlDeps {
  /** The viewer window, or null once it has closed. */
  viewer: () => BrowserWindow | null
  /** main.ts viewerSend — safe after the window is gone. */
  send: (channel: string, ...args: unknown[]) => void
}

let deps: ControlDeps | null = null
/** The saved Text size, as a zoom factor. 1 until the file has been read. */
let zoom = 1
/** Resolves once the saved factor has been read (or failed to read → 1). */
let loaded: Promise<void> = Promise.resolve()

function zoomFile(): string {
  return join(app.getPath('userData'), 'text-size.json')
}

function liveViewer(): BrowserWindow | null {
  const w = deps?.viewer() ?? null
  return w && !w.isDestroyed() && !w.webContents.isDestroyed() ? w : null
}

function applyZoom(w: BrowserWindow | null): void {
  try { if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.setZoomFactor(zoom) } catch { /* cosmetic */ }
}

/** Called once from main.ts (the "live-ui lanes" block). */
export function registerControlIpc(d: ControlDeps): void {
  deps = d
  loaded = readFile(zoomFile(), 'utf8')
    .then((raw) => { zoom = parseSavedZoom(raw) })
    .catch(() => { zoom = 1 }) // no file yet (first run) or unreadable: 100%
    .then(() => applyZoom(liveViewer()))
  ipcMain.handle('ctl:zoom-get', async () => {
    await loaded
    return zoom
  })
  ipcMain.handle('ctl:zoom-set', async (_e, factor: unknown) => {
    await loaded
    const f = Number(factor)
    zoom = Number.isFinite(f) && f > 0 ? pctToFactor(f * 100) : 1
    applyZoom(liveViewer())
    // Best-effort: the size still applies for this session if the write fails.
    writeFile(zoomFile(), JSON.stringify({ factor: zoom }), 'utf8').catch(() => {})
    return zoom
  })
}

/**
 * Called from main.ts createViewer() right after the window is made: forwards F14 (only reaches
 * here while the window has focus — before-input-event is per webContents) and re-applies the
 * saved zoom on every load. Never throws, never delays anything on the print path.
 */
export function attachControlToViewer(win: BrowserWindow): void {
  const wc = win.webContents
  wc.on('before-input-event', (event, input) => {
    try {
      if (controlKeyOf(input) !== 'F14') return
      event.preventDefault()
      deps?.send('ctl:key', 'F14')
    } catch { /* a key is never worth a crash */ }
  })
  // A load resets the zoom; put the saved size back once the page is there.
  wc.on('did-finish-load', () => { void loaded.then(() => applyZoom(win)) })
}
