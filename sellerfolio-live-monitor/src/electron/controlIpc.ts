// LANE A — main-process side of the shell: window zoom (Text size A−/A+, per computer) and the
// hardware keys (F14 = Print last). Bridge: preload-viewer.ts `controlAPI`.
//
// Channels (fixed by the scaffold — keep the names):
//   invoke 'ctl:zoom-get'            → number   (current zoom factor, 1 = 100%)
//   invoke 'ctl:zoom-set' (factor)   → number   (the factor actually applied)
//   event  'ctl:key'      (key)      main → viewer, e.g. 'F14'
//
// SCAFFOLD STUB: zoom is reported as 1 and never changed; no key is forwarded.

import { ipcMain, type BrowserWindow } from 'electron'

export interface ControlDeps {
  /** The viewer window, or null once it has closed. */
  viewer: () => BrowserWindow | null
  /** main.ts viewerSend — safe after the window is gone. */
  send: (channel: string, ...args: unknown[]) => void
}

let deps: ControlDeps | null = null

/** Called once from main.ts (the "live-ui lanes" block). */
export function registerControlIpc(d: ControlDeps): void {
  deps = d
  ipcMain.handle('ctl:zoom-get', () => 1)
  ipcMain.handle('ctl:zoom-set', (_e, factor: unknown) => { void factor; return 1 })
}

/**
 * Called from main.ts createViewer() right after the window is made. Lane A: listen for
 * `before-input-event` (F14 → send('ctl:key', 'F14')), and re-apply the saved zoom.
 * Must never throw and never delay anything on the print path.
 */
export function attachControlToViewer(win: BrowserWindow): void {
  void win; void deps
}
