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

export function parseConnectToken(input: string): { token: string } | { error: string } {
  const t = (input ?? '').trim()
  if (!t) return { error: 'Paste the token from SellerFolio.' }
  if (t.startsWith('sfc_')) {
    return { error: 'This is an extension token. Make a computer token in SellerFolio → Settings → Capture devices.' }
  }
  if (t.startsWith('sfm_') && t.slice(4).trim().length > 0) return { token: t }
  return { error: "That doesn't look like a SellerFolio computer token." }
}

export function whoamiVerdict(status: number | 'network', _body: unknown): Verdict {
  if (status === 'network') return 'offline'
  if (status === 200) return 'ok'
  if (status === 401) return 'revoked'
  if (status === 403) return 'other_machine' // the server only sends 403 for other_machine
  if (status >= 500) return 'offline'
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
  switch (v) {
    case 'ok': {
      const r = readOk(body)
      return r ? { kind: 'connected', ...r } : { kind: 'none' }
    }
    case 'revoked':
      return { kind: 'revoked' }
    case 'other_machine':
      return { kind: 'other_machine' }
    case 'offline':
      return remembered ? { kind: 'offline', shop: remembered.shop, label: remembered.label } : { kind: 'none' }
    default:
      return { kind: 'none' }
  }
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
