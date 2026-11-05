// Pure connection logic for the SellerFolio computer token. No I/O: main (Task 6) does the
// fetch and feeds the status + body in here; the UI (Task 7) renders ConnState.

export type ConnState =
  | { kind: 'none' } // no token saved
  | { kind: 'checking'; shop?: string; label?: string }
  | { kind: 'connected'; shop: string; label: string }
  | { kind: 'offline'; shop: string; label: string } // token verified before, hq unreachable now
  | { kind: 'revoked' }
  | { kind: 'other_machine' }

export type Verdict = 'ok' | 'revoked' | 'other_machine' | 'offline' | 'bad'

/** An sfc_ token is a shared CAPTURE token — what the Chrome extension uses, and what SellerFolio's Live Monitor
 *  section made before computer tokens existed (it is still what a SellerFolio without desktop-connect makes, under
 *  the heading "Live Monitor"). So never call it "the extension's": say it is the older kind, name the button that
 *  makes the right one, and say what it means when that button is not there. */
export const TOKEN_IS_EXTENSIONS =
  "That's a capture token (sfc_…), the older kind. This version needs a computer token (sfm_…): in SellerFolio open " +
  'Settings → Capture devices → Live Monitor and click Connect a computer. If you only see "Create a token for this ' +
  'device" there, your SellerFolio is not updated for this version of the app yet.'

export function parseConnectToken(input: string): { token: string } | { error: string } {
  const t = (input ?? '').trim()
  if (!t) return { error: 'Paste the token from SellerFolio.' }
  if (t.startsWith('sfc_')) {
    return { error: TOKEN_IS_EXTENSIONS }
  }
  if (t.startsWith('sfm_') && t.slice(4).trim().length > 0) return { token: t }
  return { error: "That isn't a computer token. Computer tokens start with sfm_ — make one with the steps above." }
}

export function whoamiVerdict(status: number | 'network', body: unknown): Verdict {
  if (status === 'network') return 'offline'
  if (status === 200) return 'ok'
  if (status === 401) return 'revoked'
  if (status === 403) {
    // Only the server's own answer locks this computer out; a 403 from a WAF or proxy is not a verdict.
    const err = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
    return err === 'other_machine' ? 'other_machine' : 'offline'
  }
  if (status >= 500) return 'offline'
  if (status === 408 || status === 429) return 'offline' // transient: a timeout or rate limit is not a verdict on the token
  // 400 (malformed device id) and any unexpected status: never run unconnected.
  return 'bad'
}

function readOk(body: unknown): { shop: string; label: string } | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { workspace?: { name?: unknown }; label?: unknown }
  const shop = b.workspace?.name
  if (typeof shop !== 'string' || !shop || typeof b.label !== 'string') return null
  return { shop, label: b.label }
}

export function nextState(
  _prev: ConnState,
  v: Verdict,
  body: unknown,
  remembered: { shop: string; label: string } | null,
): ConnState {
  // An unclear reply (an unexpected status, or a 200 that is not our JSON — a captive portal or a
  // proxy page) is not a verdict on the token. With a connection remembered it counts as "can't
  // reach SellerFolio", so a running show is never locked out by it; with nothing remembered the
  // app still never runs unconnected.
  const unclear = (): ConnState => remembered ? { kind: 'offline', shop: remembered.shop, label: remembered.label } : { kind: 'none' }
  switch (v) {
    case 'ok': {
      const r = readOk(body)
      return r ? { kind: 'connected', ...r } : unclear()
    }
    case 'revoked':
      return { kind: 'revoked' }
    case 'other_machine':
      return { kind: 'other_machine' }
    default: // 'offline' and 'bad'
      return unclear()
  }
}

/**
 * What the viewer shows for a connection view. The Connect screen covers the app only while the
 * monitor is not running (and never in replay); a running show is never covered, and a confirmed
 * revoke / other machine while it runs shows the red bar instead.
 */
export function connectScreen(v: { conn: { kind: string; shop?: string }; monitorRunning?: boolean; replay?: boolean }): { gated: boolean; lost: boolean } {
  const k = v.conn.kind
  const running = !!v.monitorRunning
  const lost = running && (k === 'revoked' || k === 'other_machine')
  const gated = !v.replay && !running && (k === 'none' || (k === 'checking' && !v.conn.shop) || k === 'revoked' || k === 'other_machine')
  return { gated, lost }
}

export function canRunMonitor(s: ConnState): boolean {
  return s.kind === 'connected' || s.kind === 'offline'
}

export function suggestErrorText(status: number | 'network', error?: string): string {
  if (status === 'network') return "Can't reach SellerFolio."
  if (status === 401 || status === 403) return "This computer isn't connected to SellerFolio."
  if (status === 429) return "Today's limit for pattern suggestions is used up. Try again tomorrow."
  if (status === 501) return "Pattern suggestions aren't available right now."
  if (status === 502 && error === 'bad_pattern') return "The AI didn't return a usable pattern. Try describing it differently."
  if (status === 502 && error === 'too_long') return 'The suggested pattern was too long to trust.'
  return "Couldn't get a suggestion. Try again."
}

// ── main-process decisions (Task 6) ──────────────────────────────────────────
// Kept here, pure and tested, so main.ts only does I/O.

export type Remembered = { shop: string; label: string } | null

/** What kind of token is saved. A `sfc_` token from before the update cannot run the app. */
export function savedTokenKind(token: string): 'none' | 'legacy' | 'computer' {
  if (token.startsWith('sfm_') && token.length > 4) return 'computer'
  if (token.startsWith('sfc_')) return 'legacy'
  return 'none'
}

/** The state before the first `whoami` answer. */
export function startState(token: string, remembered: Remembered): ConnState {
  if (savedTokenKind(token) !== 'computer') return { kind: 'none' }
  return remembered ? { kind: 'checking', shop: remembered.shop, label: remembered.label } : { kind: 'checking' }
}

/**
 * The shop/label to keep in sf-sync.json after a check. A network blip keeps it (so the next
 * offline start still runs); revoked / other machine forgets it (so the next launch is locked
 * even when hq can't be reached).
 */
export function rememberedAfter(s: ConnState, prev: Remembered): Remembered {
  if (s.kind === 'connected') return { shop: s.shop, label: s.label }
  if (s.kind === 'revoked' || s.kind === 'other_machine') return null
  return prev
}

/** Create the monitor window now? Never twice, and never closed by this logic. */
export function shouldCreateMonitor(s: ConnState, created: boolean): boolean {
  return !created && canRunMonitor(s)
}

/**
 * What to do with the journal upload after a state change. `want` is the endpoint+token key the
 * upload should use (null without a computer token), `applied` the one it is using now. An upload
 * the worker halted on `auth` is retried only from the periodic check, so an auth failure that
 * whoami does not confirm cannot turn into a request loop.
 */
export function uploadPlan(a: { state: ConnState; want: string | null; applied: string | null; halted: boolean; periodic: boolean }): 'start' | 'stop' | 'keep' {
  if (a.state.kind === 'checking') return 'keep'
  const want = canRunMonitor(a.state) ? a.want : null
  if (want === null) return a.applied !== null ? 'stop' : 'keep'
  if (want !== a.applied) return 'start'
  if (a.halted && a.periodic) return 'start'
  return 'keep'
}

/** Why a pasted token did not connect. */
export function connectErrorText(v: Verdict): string {
  if (v === 'offline') return "Can't reach SellerFolio. Check the internet connection and try again."
  if (v === 'revoked') return "SellerFolio didn't accept this token — it was revoked or mistyped. Make a new one: Settings → Capture devices → Live Monitor → Connect a computer."
  if (v === 'other_machine') return 'This token is already used on another computer — each computer needs its own. Make a new one: Settings → Capture devices → Live Monitor → Connect a computer.'
  return "Couldn't check the token. Try again."
}

/** A pattern suggestion from `/api/desktop/suggest-pattern`, or null if it is not usable. */
export function readSuggestion(body: unknown): { regex: string; flags: string; explain: string } | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { regex?: unknown; flags?: unknown; explain?: unknown }
  if (typeof b.regex !== 'string' || !b.regex || b.regex.length > 200) return null
  const flags = typeof b.flags === 'string' ? b.flags.replace(/[^gimsuy]/g, '') : ''
  const explain = typeof b.explain === 'string' ? b.explain.slice(0, 200) : ''
  return { regex: b.regex, flags, explain }
}
