// The identification feature's settings, and the one rule for whether audio may leave this machine.
// Three values live in `identify.json` beside the journal: where the worker is, whether the
// feature is on, and how far the captured stream lags the show (`streamLatencySec`: see the STREAM
// LATENCY note in identifyWiring, which says what it is and how to measure it). The capture token is NOT here -- it is the existing SellerFolio sync token, kept
// encrypted in sf-sync.json, and this file has no field it could ride in.
// Pure: the file is read and written by main.ts, which passes the text through these.
import { identifyBaseUrlOk } from './identifySend'
import { MAX_STREAM_LATENCY_SEC, safeLatencySec } from './identifyWiring'

/** The Linux worker over the tailnet. Never hq. */
export const DEFAULT_IDENTIFY_URL = 'http://100.68.11.76:8099'

export type IdentifySettings = { baseUrl: string; enabled: boolean; streamLatencySec: number }
export type IdentifySettingsRead = IdentifySettings & {
  /** The file existed but could not be trusted. It is read as OFF, and the Settings screen says why. */
  damaged: boolean
}

/**
 * Read `identify.json`'s text.
 *
 * - No file: the defaults, and `enabled` is TRUE. Identification used to be off unless a Gemini key
 *   was on the machine and a switch had been found and flipped, "because the answers had nowhere to
 *   go" (spec defect 5). They go to SellerFolio now, so the feature follows the token: saving one
 *   turns it on, and the switch exists to turn it off.
 * - A file that cannot be trusted (unparseable, not an object, `enabled` not a boolean) is read as
 *   OFF. This is the setting that decides whether show audio leaves the building, so a power cut
 *   that truncated the file must not be able to answer "the operator switched it off" with "on".
 * - An address that would send the token somewhere unsafe falls back to the default (the same
 *   check the send path makes; the file is not trusted to have been written by this app).
 */
export function parseIdentifySettings(text: string | null): IdentifySettingsRead {
  if (text === null) return { baseUrl: DEFAULT_IDENTIFY_URL, enabled: true, damaged: false, streamLatencySec: 0 }
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return { baseUrl: DEFAULT_IDENTIFY_URL, enabled: false, damaged: true, streamLatencySec: 0 }
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { baseUrl: DEFAULT_IDENTIFY_URL, enabled: false, damaged: true, streamLatencySec: 0 }
  const o = j as { baseUrl?: unknown; enabled?: unknown; streamLatencySec?: unknown }
  const baseUrl = typeof o.baseUrl === 'string' && identifyBaseUrlOk(o.baseUrl.trim()) ? o.baseUrl.trim() : DEFAULT_IDENTIFY_URL
  // A latency that makes no sense is "no correction" (0), and does NOT make the file damaged: it is not
  // what decides whether audio leaves this machine, so it must not be able to switch anything off.
  const streamLatencySec = safeLatencySec(o.streamLatencySec)
  if (o.enabled === undefined) return { baseUrl, enabled: true, damaged: false, streamLatencySec }
  if (typeof o.enabled !== 'boolean') return { baseUrl, enabled: false, damaged: true, streamLatencySec }
  return { baseUrl, enabled: o.enabled, damaged: false, streamLatencySec }
}

/** The text to write. Exactly the three settings: whatever else the object holds is not written. */
export function serializeIdentifySettings(s: IdentifySettings): string {
  return JSON.stringify({ baseUrl: s.baseUrl, enabled: s.enabled, streamLatencySec: safeLatencySec(s.streamLatencySec) })
}

export type LatencyCheck = { ok: true; sec: number } | { ok: false; error: string }

/** What the Settings box accepts for the stream latency: seconds, whole or fractional, 0 to the maximum. Empty means 0. */
export function checkLatencyInput(raw: string): LatencyCheck {
  const typed = raw.trim().replace(/\s*s$/i, '')
  if (!typed) return { ok: true, sec: 0 }
  if (!/^\d+(\.\d+)?$/.test(typed)) return { ok: false, error: 'Enter the delay in seconds, for example 8 or 6.5.' }
  const sec = Number(typed)
  if (!Number.isFinite(sec) || sec > MAX_STREAM_LATENCY_SEC) return { ok: false, error: `Enter a delay between 0 and ${MAX_STREAM_LATENCY_SEC} seconds.` }
  return { ok: true, sec }
}

/**
 * What the Settings screen says under the latency box. At 0 it says what is true: nobody has measured the
 * delay, so every clip is cut L seconds early and identifications are not trustworthy. A value says what
 * it is correcting for.
 */
export function latencyNote(sec: number): { text: string; cls: string } {
  const v = safeLatencySec(sec)
  if (v === 0) {
    return {
      cls: 'warn-text',
      text: 'The stream delay has not been measured. The audio the app records lags the show, so until this is set, clips are cut from the wrong moment and identifications are not trustworthy. To measure it, see the note beside it.',
    }
  }
  return { cls: 'ok-text', text: `Correcting for a stream delay of ${v} s: each clip is cut ${v} s later in the recording than the sale time.` }
}

export type BaseUrlCheck = { ok: true; baseUrl: string } | { ok: false; error: string }

/** What the Settings box accepts. Empty means "the default". Returns the address the app will store. */
export function checkBaseUrlInput(raw: string): BaseUrlCheck {
  const typed = raw.trim()
  if (!typed) return { ok: true, baseUrl: DEFAULT_IDENTIFY_URL }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `http://${typed}`
  const bad = (error: string): BaseUrlCheck => ({ ok: false, error })
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    return bad('That is not an address. Try http://100.68.11.76:8099')
  }
  if (u.username || u.password) return bad('Leave the user name and password out of the address.')
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return bad('Enter just the server address, with nothing after the port.')
  if (!identifyBaseUrlOk(u.origin)) {
    return bad('Use https://, or http:// to this computer or a tailnet (100.x) address. The token goes with every clip.')
  }
  return { ok: true, baseUrl: u.origin }
}

export type IdentifyGate = 'on' | 'off' | 'no_token'

/**
 * May audio be captured and sent? Only with a saved capture token AND the switch on. It no longer
 * depends on anything else on this machine (it used to need a Gemini key: the model now runs on
 * the server, and this machine only supplies audio and times).
 */
export function identifyGate(s: { hasToken: boolean; enabled: boolean; held?: boolean }): IdentifyGate {
  if (!s.hasToken) return 'no_token'
  // `held`: an earlier opt-out could not be carried over. Unknown means off, not the new default.
  if (s.held) return 'off'
  return s.enabled ? 'on' : 'off'
}

/** [text, css class] for the Settings state line. */
export function identifyStatus(gate: IdentifyGate, damaged: boolean, held = false): [string, string] {
  if (gate === 'no_token') return ['No capture token saved — nothing can be sent', 'muted']
  if (gate === 'on') return ['On — a clip of the show’s audio goes to SellerFolio each time an item sells', 'warn-text']
  if (held) return ['Off — your earlier setting could not be carried over, so it is off until you turn it on here', 'warn-text']
  return damaged
    ? ['Off — this setting could not be read, so it was switched off. Turn it on again if you want it', 'warn-text']
    : ['Off — no audio is captured and none leaves this computer', 'ok-text']
}

export type Preflight = { ok: true; baseUrl: string; token: string } | { ok: false; reason: 'bad_token' | 'identification_off' }

/**
 * The last check before a clip leaves this machine, run by the main process on every POST. "Off" has
 * to mean off even if the page disagrees: a clip queued before the switch was turned off, or a
 * renderer that has not caught up. A refusal names the reason only; it never carries the token.
 */
export function identifyPreflight(token: string, settings: IdentifySettings): Preflight {
  const gate = identifyGate({ hasToken: !!token, enabled: settings.enabled })
  if (gate === 'no_token') return { ok: false, reason: 'bad_token' }
  if (gate === 'off') return { ok: false, reason: 'identification_off' }
  return { ok: true, baseUrl: settings.baseUrl, token }
}

export type SettingsUpdate = { ok: true; next: IdentifySettings } | { ok: false; error: string }

/**
 * The Settings save. Only what was sent, and only when it is the right type, changes. A `damaged`
 * setting reads as OFF, and saving just its address keeps it OFF: a field that was not touched is
 * not switched on by the save.
 */
export function updateIdentifySettings(
  cur: IdentifySettings,
  a: { baseUrl?: unknown; enabled?: unknown; streamLatencySec?: unknown },
): SettingsUpdate {
  let baseUrl = cur.baseUrl
  if (typeof a.baseUrl === 'string') {
    const c = checkBaseUrlInput(a.baseUrl)
    if (!c.ok) return { ok: false, error: c.error }
    baseUrl = c.baseUrl
  }
  // A number is validated, not clamped: 61 is a typo for something, and saving 60 would hide it. Any other
  // type is ignored, like the other fields.
  let streamLatencySec = cur.streamLatencySec
  if (typeof a.streamLatencySec === 'number') {
    if (!Number.isFinite(a.streamLatencySec) || a.streamLatencySec < 0 || a.streamLatencySec > MAX_STREAM_LATENCY_SEC) {
      return { ok: false, error: `Enter a delay between 0 and ${MAX_STREAM_LATENCY_SEC} seconds.` }
    }
    streamLatencySec = a.streamLatencySec
  }
  return { ok: true, next: { baseUrl, enabled: typeof a.enabled === 'boolean' ? a.enabled : cur.enabled, streamLatencySec } }
}

/** What the Settings page knows about identification, as the main process last reported it. */
export type IdentifyState = {
  ready: boolean
  enabled: boolean
  damaged: boolean
  baseUrl: string
  defaultBaseUrl: string
  /** Seconds the captured stream lags the show; 0 = uncorrected / not measured. */
  streamLatencySec: number
}

/**
 * Read main's answer to "what are the settings?". The answer crosses IPC, so it is untrusted: anything
 * that is not exactly the boolean `true` is false, and a missing or malformed answer is "not ready,
 * not enabled" -- the page never records audio on a guess.
 */
export function identifyStateFrom(v: unknown): IdentifyState {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  return {
    ready: o.ready === true,
    enabled: o.enabled === true,
    damaged: o.damaged === true,
    baseUrl: typeof o.baseUrl === 'string' && o.baseUrl ? o.baseUrl : DEFAULT_IDENTIFY_URL,
    defaultBaseUrl: typeof o.defaultBaseUrl === 'string' && o.defaultBaseUrl ? o.defaultBaseUrl : DEFAULT_IDENTIFY_URL,
    streamLatencySec: safeLatencySec(o.streamLatencySec),
  }
}

/** Where the old switch lived: the page's localStorage. '1' meant on; anything else (a '0') was an explicit off. */
export const LEGACY_SWITCH_KEY = 'tt-ai-transcribe'

/**
 * Carry an operator's explicit opt-out across the move of the switch to the main process, where the
 * default is now ON. The old switch defaulted OFF, so a stored value that is not '1' is a deliberate
 * choice to keep audio off; an absent one is no choice at all and takes the new default.
 * One-shot: the old key is cleared once the opt-out is saved, so it cannot override a later choice
 * made on the new switch. If the save fails the key stays and the opt-out is retried next launch.
 * Never throws (storage can be unavailable; the page must still start). It reports whether the choice is
 * settled: 'unresolved' (could not read the old preference, or could not save the opt-out) must be treated
 * as OFF for the session by the caller, or the failure path would switch audio on against the operator's choice.
 */
export async function migrateLegacySwitch(
  storage: { getItem(k: string): string | null; removeItem(k: string): void },
  saveEnabled: (enabled: boolean) => Promise<boolean>,
): Promise<'resolved' | 'unresolved'> {
  let stored: string | null
  try {
    stored = storage.getItem(LEGACY_SWITCH_KEY)
  } catch {
    return 'unresolved' // cannot tell whether there was an opt-out
  }
  if (stored === null) return 'resolved'
  if (stored !== '1') {
    let saved = false
    try {
      saved = await saveEnabled(false)
    } catch {
      saved = false
    }
    if (!saved) return 'unresolved' // the key stays, and it is retried next launch
  }
  try {
    storage.removeItem(LEGACY_SWITCH_KEY)
  } catch {
    /* the opt-out is applied; at worst it is applied again next launch */
  }
  return 'resolved'
}
