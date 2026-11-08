// Hardware buttons (Flic, Stream Deck, a keyboard key): which key does what, and the press filter.
// No DOM, no Electron: shared by electron/controlIpc.ts (global keys) and renderer/hotkeysCard.ts
// (the "press your clicker" card), tested in vitest.
//
// A button is bound to an action by the key it sends. Keys are stored as Electron accelerator
// strings ("F14", "Control+Alt+P", "MediaPlayPause") because that is what globalShortcut takes,
// and both the main-process input and the renderer's KeyboardEvent are turned into the same string,
// so "is this a bound key?" is one string compare everywhere.

/** What a button can do. */
export type HotkeyAction = 'runNext' | 'printLast'
export const HOTKEY_ACTIONS: readonly HotkeyAction[] = ['runNext', 'printLast']

/** Saved bindings: action → its keys (several buttons may share an action). */
export type Hotkeys = Record<HotkeyAction, string[]>

/** What the Settings card shows: each bound key and whether it works from any window. */
export interface HotkeyStatus {
  keys: { action: HotkeyAction; accel: string; global: boolean }[]
}

/** F13 = Run next lot and F14 = Print last, as the top-bar badges have always said. */
export const DEFAULT_HOTKEYS: Hotkeys = { runNext: ['F13'], printLast: ['F14'] }
/** Enough for a Stream Deck plus two hosts' clickers sending different keys. */
export const MAX_KEYS_PER_ACTION = 4
/**
 * Two presses of the same action this close together count once. Two hosts reaching for their
 * clickers at the same moment, or a button that bounces, must not print the label twice.
 */
export const LOCKOUT_MS = 2000

/** The parts of a key press this file needs: Electron's `input` and a DOM KeyboardEvent both fit. */
export interface KeyPress {
  key: string
  code?: string
  control?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}

export type Learned = { ok: true; accel: string } | { ok: false; reason: 'modifier-only' | 'unsupported' | 'typing-key' }

const MEDIA: Record<string, string> = {
  MediaPlayPause: 'MediaPlayPause',
  MediaTrackNext: 'MediaNextTrack',
  MediaNextTrack: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
  MediaPreviousTrack: 'MediaPreviousTrack',
  MediaStop: 'MediaStop',
  AudioVolumeUp: 'VolumeUp',
  AudioVolumeDown: 'VolumeDown',
  AudioVolumeMute: 'VolumeMute',
}
const NAMED: Record<string, string> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End',
  Insert: 'Insert', Delete: 'Delete', Backspace: 'Backspace', Enter: 'Enter',
  Space: 'Space', Tab: 'Tab', Escape: 'Escape',
}
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS', 'CapsLock'])

/** The base key's accelerator name, or null when it is not one we can bind. */
function baseKey(p: KeyPress): string | null {
  const key = p.key ?? ''
  const code = p.code ?? ''
  const f = /^F([1-9]|1[0-9]|2[0-4])$/
  if (f.test(key)) return key
  if (f.test(code)) return code
  if (MEDIA[key]) return MEDIA[key]
  if (MEDIA[code]) return MEDIA[code]
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^[a-zA-Z0-9]$/.test(key)) return key.toUpperCase()
  if (key === ' ') return 'Space'
  if (NAMED[key]) return NAMED[key]
  if (NAMED[code]) return NAMED[code]
  return null
}

/** Keys that work alone, everywhere, without stealing anything people type or scroll with. */
function safeAlone(base: string): boolean {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(base) || Object.values(MEDIA).includes(base)
}

/**
 * A key press → the accelerator to bind. A key that people type or scroll with (a letter, Space,
 * Page Down…) is refused unless Ctrl or Alt is held, because a global key is taken from EVERY app:
 * binding plain Page Down would stop it scrolling anywhere on the computer.
 */
export function learnKey(p: KeyPress): Learned {
  if (MODIFIER_KEYS.has(p.key)) return { ok: false, reason: 'modifier-only' }
  const base = baseKey(p)
  if (!base) return { ok: false, reason: 'unsupported' }
  if (!safeAlone(base) && !p.control && !p.alt) return { ok: false, reason: 'typing-key' }
  const mods: string[] = []
  if (p.control) mods.push('Control')
  if (p.alt) mods.push('Alt')
  if (p.shift) mods.push('Shift')
  if (p.meta) mods.push('Super')
  return { ok: true, accel: [...mods, base].join('+') }
}

/** The accelerator a press would bind, or null — used to match a press against the bound keys. */
export function accelOf(p: KeyPress): string | null {
  const r = learnKey(p)
  return r.ok ? r.accel : null
}

/** Plain words for a refused key, shown in the card. */
export function learnError(reason: Exclude<Learned, { ok: true }>['reason']): string {
  if (reason === 'unsupported') return 'That key can’t be used. Set your clicker to send F13–F24, or a key with Ctrl or Alt.'
  if (reason === 'typing-key') return 'That key is used for typing or scrolling, so it would stop working in every other app. Set your clicker to send F13–F24, or add Ctrl or Alt.'
  return ''
}

/** "Control+Alt+P" → "Ctrl + Alt + P"; "MediaPlayPause" → "Play/Pause". */
export function keyLabel(accel: string): string {
  const words: Record<string, string> = {
    Control: 'Ctrl', Super: 'Win', MediaPlayPause: 'Play/Pause', MediaNextTrack: 'Next track',
    MediaPreviousTrack: 'Previous track', MediaStop: 'Stop', VolumeUp: 'Volume up',
    VolumeDown: 'Volume down', VolumeMute: 'Mute', PageUp: 'Page Up', PageDown: 'Page Down',
  }
  return accel.split('+').map((k) => words[k] ?? k).join(' + ')
}

/** Is this a string learnKey could have produced? Guards the saved file against hand edits. */
function validAccel(s: unknown): s is string {
  if (typeof s !== 'string' || !s || s.length > 60) return false
  const parts = s.split('+')
  const base = parts.pop() as string
  const mods = new Set(['Control', 'Alt', 'Shift', 'Super'])
  if (!parts.every((m) => mods.has(m)) || new Set(parts).size !== parts.length) return false
  const hasCtrlAlt = parts.includes('Control') || parts.includes('Alt')
  const known = safeAlone(base) || /^[A-Z0-9]$/.test(base) || Object.values(NAMED).includes(base)
  return known && (safeAlone(base) || hasCtrlAlt)
}

/** The saved file → bindings. Missing or unreadable → the defaults; bad entries are dropped. */
export function parseHotkeys(raw: string | null | undefined): Hotkeys {
  if (!raw) return cloneHotkeys(DEFAULT_HOTKEYS)
  let v: unknown
  try { v = JSON.parse(raw) } catch { return cloneHotkeys(DEFAULT_HOTKEYS) }
  const out = cloneHotkeys(DEFAULT_HOTKEYS)
  const obj = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  for (const a of HOTKEY_ACTIONS) {
    const list = obj[a]
    if (!Array.isArray(list)) continue // absent → keep the default for this action
    out[a] = [...new Set(list.filter(validAccel))].slice(0, MAX_KEYS_PER_ACTION)
  }
  return out
}

export function cloneHotkeys(h: Hotkeys): Hotkeys {
  return { runNext: [...h.runNext], printLast: [...h.printLast] }
}

/** Add a key to an action. A key belongs to one action only: it is taken off any other first. */
export function addKey(h: Hotkeys, action: HotkeyAction, accel: string): Hotkeys | { error: string } {
  if (!validAccel(accel)) return { error: 'That key can’t be used.' }
  const out = cloneHotkeys(h)
  for (const a of HOTKEY_ACTIONS) out[a] = out[a].filter((k) => k !== accel)
  if (out[action].length >= MAX_KEYS_PER_ACTION) return { error: `Up to ${MAX_KEYS_PER_ACTION} keys per button. Remove one first.` }
  out[action].push(accel)
  return out
}

export function removeKey(h: Hotkeys, action: HotkeyAction, accel: string): Hotkeys {
  const out = cloneHotkeys(h)
  out[action] = out[action].filter((k) => k !== accel)
  return out
}

/** Which action a key is bound to, if any. */
export function actionFor(h: Hotkeys, accel: string | null): HotkeyAction | null {
  if (!accel) return null
  for (const a of HOTKEY_ACTIONS) if (h[a].includes(accel)) return a
  return null
}

/**
 * The shared lockout: one clock per action, across every key and clicker bound to it.
 * `press` returns true when the action should run, false when it is inside the lockout.
 */
export function createLockout(gapMs = LOCKOUT_MS): { press: (a: HotkeyAction, now: number) => boolean } {
  const last = new Map<HotkeyAction, number>()
  return {
    press(a, now) {
      const prev = last.get(a)
      if (prev !== undefined && now - prev < gapMs && now >= prev) return false
      last.set(a, now)
      return true
    },
  }
}
