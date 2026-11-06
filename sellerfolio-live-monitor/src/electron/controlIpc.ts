// LANE A — main-process side of the shell: window zoom (Text size A−/A+, per computer) and the
// hardware buttons (a Flic, a Stream Deck or any key bound to Print last). Bridge: preload-viewer.ts
// `controlAPI`.
//
// Channels:
//   invoke 'ctl:zoom-get'                          → number (current zoom factor, 1 = 100%)
//   invoke 'ctl:zoom-set'      (factor)            → number (the factor actually applied)
//   invoke 'ctl:hotkeys-get'                       → HotkeyStatus
//   invoke 'ctl:hotkeys-add'   ({ action, accel }) → HotkeyStatus & { error? }
//   invoke 'ctl:hotkeys-remove'({ action, accel }) → HotkeyStatus
//   invoke 'ctl:hotkeys-learn' (on)                → void (while on, bound keys are released so the
//                                                    press reaches the window and can be learned)
//   event  'ctl:key'           (action)  main → viewer, e.g. 'printLast'
//
// Bound keys are GLOBAL (Electron globalShortcut): a clicker works while TikTok or anything else is
// in front. When another app already owns a key, that key falls back to working only while this
// window is in front, and the Settings card says so. Every press goes through one 2-second lockout
// per action (core/hotkeys createLockout), so two hosts pressing together print once.
//
// Nothing here is on the print path. Files are read once, asynchronously, at start and written
// asynchronously on change — never a blocking read/write on the main thread.

import { app, globalShortcut, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { parseSavedZoom, pctToFactor } from '../core/shellControls'
import {
  HOTKEY_ACTIONS, DEFAULT_HOTKEYS, accelOf, actionFor, addKey, cloneHotkeys, createLockout,
  parseHotkeys, removeKey, type HotkeyAction, type HotkeyStatus, type Hotkeys,
} from '../core/hotkeys'

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
  registerHotkeyIpc()
}

// ── Hardware buttons ─────────────────────────────────────────────────────────

let hotkeys: Hotkeys = cloneHotkeys(DEFAULT_HOTKEYS)
/** Keys globalShortcut accepted. The rest work only while this window is in front. */
const globalKeys = new Set<string>()
/** Keys globalShortcut refused last time we tried (another app owns them). */
const refusedKeys = new Set<string>()
let learning = false
let learnTimer: ReturnType<typeof setTimeout> | null = null
const lockout = createLockout()
let hotkeysLoaded: Promise<void> = Promise.resolve()

function hotkeysFile(): string {
  return join(app.getPath('userData'), 'hotkeys.json')
}

/** A bound key was pressed (from any window, or from this one). One lockout for every source. */
function fire(action: HotkeyAction): void {
  try {
    if (!lockout.press(action, Date.now())) return
    deps?.send('ctl:key', action)
  } catch { /* a key is never worth a crash */ }
}

function releaseAll(): void {
  for (const k of globalKeys) { try { globalShortcut.unregister(k) } catch { /* already gone */ } }
  globalKeys.clear()
}

/** (Re)claim every bound key system-wide. A key another app owns stays window-only. */
function claimAll(): void {
  releaseAll()
  if (learning) return
  refusedKeys.clear()
  for (const a of HOTKEY_ACTIONS) {
    for (const k of hotkeys[a]) {
      let ok = false
      try { ok = globalShortcut.register(k, () => fire(a)) } catch { ok = false }
      if (ok) globalKeys.add(k)
      else refusedKeys.add(k)
    }
  }
}

function status(): HotkeyStatus {
  return {
    keys: HOTKEY_ACTIONS.flatMap((a) => hotkeys[a].map((accel) => ({ action: a, accel, global: !refusedKeys.has(accel) }))),
  }
}

function saveHotkeys(): void {
  // Best-effort: the keys still work this session if the write fails.
  writeFile(hotkeysFile(), JSON.stringify(hotkeys), 'utf8').catch(() => {})
}

function isAction(a: unknown): a is HotkeyAction {
  return typeof a === 'string' && (HOTKEY_ACTIONS as readonly string[]).includes(a)
}

function setLearning(on: boolean): void {
  learning = on
  if (learnTimer) { clearTimeout(learnTimer); learnTimer = null }
  // A card left on "press your clicker" must not leave the keys released for the whole show.
  if (on) learnTimer = setTimeout(() => setLearning(false), 30_000)
  claimAll()
}

function registerHotkeyIpc(): void {
  hotkeysLoaded = readFile(hotkeysFile(), 'utf8')
    .then((raw) => { hotkeys = parseHotkeys(raw) })
    .catch(() => { hotkeys = cloneHotkeys(DEFAULT_HOTKEYS) }) // first run: F14 = Print last
    .then(() => app.whenReady())
    .then(() => claimAll())
    .catch(() => { /* keys stay window-only */ })
  app.on('will-quit', () => { try { globalShortcut.unregisterAll() } catch { /* quitting */ } })

  ipcMain.handle('ctl:hotkeys-get', async () => { await hotkeysLoaded; return status() })
  ipcMain.handle('ctl:hotkeys-add', async (_e, p: { action?: unknown; accel?: unknown }) => {
    await hotkeysLoaded
    if (!isAction(p?.action) || typeof p?.accel !== 'string') return { ...status(), error: 'That key can’t be used.' }
    const next = addKey(hotkeys, p.action, p.accel)
    if ('error' in next) return { ...status(), error: next.error }
    hotkeys = next
    saveHotkeys()
    setLearning(false) // re-claims every key, the new one included
    return status()
  })
  ipcMain.handle('ctl:hotkeys-remove', async (_e, p: { action?: unknown; accel?: unknown }) => {
    await hotkeysLoaded
    if (isAction(p?.action) && typeof p?.accel === 'string') {
      hotkeys = removeKey(hotkeys, p.action, p.accel)
      saveHotkeys()
      claimAll()
    }
    return status()
  })
  ipcMain.handle('ctl:hotkeys-learn', async (_e, on: unknown) => {
    await hotkeysLoaded
    setLearning(on === true)
  })
}

/**
 * Called from main.ts createViewer() right after the window is made. A bound key globalShortcut
 * could not claim (another app owns it) still works here while this window is in front; a key it
 * did claim never reaches this handler. Re-applies the saved zoom on every load. Never throws,
 * never delays anything on the print path.
 */
export function attachControlToViewer(win: BrowserWindow): void {
  const wc = win.webContents
  wc.on('before-input-event', (event, input) => {
    try {
      if (learning || input.type !== 'keyDown' || input.isAutoRepeat) return
      const accel = accelOf({ key: input.key, code: input.code, control: input.control, alt: input.alt, shift: input.shift, meta: input.meta })
      const action = actionFor(hotkeys, accel)
      if (!action) return
      event.preventDefault()
      fire(action)
    } catch { /* a key is never worth a crash */ }
  })
  // A load resets the zoom; put the saved size back once the page is there.
  wc.on('did-finish-load', () => { void loaded.then(() => applyZoom(win)) })
}
