import { describe, it, expect } from 'vitest'
import {
  parseConnectToken, whoamiVerdict, nextState, canRunMonitor, suggestErrorText, type ConnState,
  savedTokenKind, startState, rememberedAfter, shouldCreateMonitor, uploadPlan, connectErrorText, readSuggestion,
} from '../sfConnect'

describe('parseConnectToken', () => {
  it('trims a sfm_ token', () => {
    expect(parseConnectToken('  sfm_abc123\n')).toEqual({ token: 'sfm_abc123' })
  })
  it('rejects empty', () => {
    expect(parseConnectToken('   ')).toEqual({ error: 'Paste the token from SellerFolio.' })
    expect(parseConnectToken('')).toEqual({ error: 'Paste the token from SellerFolio.' })
  })
  it('rejects an extension token', () => {
    expect(parseConnectToken('sfc_abc')).toEqual({
      error: 'This is an extension token. Make a computer token in SellerFolio → Settings → Capture devices.',
    })
  })
  it('rejects anything else, including a bare prefix', () => {
    const e = { error: "That doesn't look like a SellerFolio computer token." }
    expect(parseConnectToken('hello')).toEqual(e)
    expect(parseConnectToken('sfm_')).toEqual(e)
    expect(parseConnectToken(' sfm_  ')).toEqual(e)
  })
})

describe('whoamiVerdict', () => {
  it('maps statuses', () => {
    expect(whoamiVerdict(200, {})).toBe('ok')
    expect(whoamiVerdict(401, { error: 'unauthorized' })).toBe('revoked')
    expect(whoamiVerdict(403, { error: 'other_machine' })).toBe('other_machine')
    expect(whoamiVerdict(403, null)).toBe('other_machine')
    expect(whoamiVerdict('network', null)).toBe('offline')
    expect(whoamiVerdict(502, null)).toBe('offline')
    expect(whoamiVerdict(503, null)).toBe('offline')
    expect(whoamiVerdict(400, { error: 'missing_device' })).toBe('bad')
  })
  it('treats a request timeout as offline (transient)', () => {
    expect(whoamiVerdict(408, null)).toBe('offline')
  })
  it('treats rate limiting as offline (transient)', () => {
    expect(whoamiVerdict(429, { error: 'too_many' })).toBe('offline')
  })
  it('treats unexpected statuses as bad (never run unconnected)', () => {
    expect(whoamiVerdict(404, null)).toBe('bad')
    expect(whoamiVerdict(204, null)).toBe('bad')
    expect(whoamiVerdict(302, null)).toBe('bad')
  })
})

describe('nextState', () => {
  const connected: ConnState = { kind: 'connected', shop: 'Luxesense', label: 'Table 1' }
  it('ok reads shop and label from the body', () => {
    expect(nextState({ kind: 'checking' }, 'ok', { workspace: { id: 'w', name: 'Luxesense' }, label: 'Table 1' }, null)).toEqual(connected)
  })
  it('ok with a malformed body is treated as bad', () => {
    expect(nextState({ kind: 'checking' }, 'ok', null, null)).toEqual({ kind: 'none' })
    expect(nextState({ kind: 'checking' }, 'ok', { workspace: {}, label: 'x' }, null)).toEqual({ kind: 'none' })
  })
  it('bad becomes none', () => {
    expect(nextState(connected, 'bad', null, null)).toEqual({ kind: 'none' })
  })
  it('offline with a remembered connection stays usable', () => {
    const s = nextState({ kind: 'checking' }, 'offline', null, { shop: 'Luxesense', label: 'Table 1' })
    expect(s).toEqual({ kind: 'offline', shop: 'Luxesense', label: 'Table 1' })
    expect(canRunMonitor(s)).toBe(true)
  })
  it('offline with nothing remembered is none', () => {
    const s = nextState({ kind: 'checking' }, 'offline', null, null)
    expect(s).toEqual({ kind: 'none' })
    expect(canRunMonitor(s)).toBe(false)
  })
  it('revoked and other_machine block starting', () => {
    const r = nextState(connected, 'revoked', null, null)
    expect(r).toEqual({ kind: 'revoked' })
    expect(canRunMonitor(r)).toBe(false)
    const o = nextState(connected, 'other_machine', null, null)
    expect(o).toEqual({ kind: 'other_machine' })
    expect(canRunMonitor(o)).toBe(false)
  })
})

describe('canRunMonitor', () => {
  it('only connected and offline', () => {
    expect(canRunMonitor({ kind: 'connected', shop: 'a', label: 'b' })).toBe(true)
    expect(canRunMonitor({ kind: 'offline', shop: 'a', label: 'b' })).toBe(true)
    expect(canRunMonitor({ kind: 'none' })).toBe(false)
    expect(canRunMonitor({ kind: 'checking' })).toBe(false)
  })
})

describe('suggestErrorText', () => {
  it('maps known failures', () => {
    expect(suggestErrorText(429)).toBe("Today's limit for pattern suggestions is used up. Try again tomorrow.")
    expect(suggestErrorText(501)).toBe("Pattern suggestions aren't available right now.")
    expect(suggestErrorText(502, 'bad_pattern')).toBe("The AI didn't return a usable pattern. Try describing it differently.")
    expect(suggestErrorText(502, 'too_long')).toBe('The suggested pattern was too long to trust.')
    expect(suggestErrorText(401)).toBe("This computer isn't connected to SellerFolio.")
    expect(suggestErrorText(403)).toBe("This computer isn't connected to SellerFolio.")
    expect(suggestErrorText('network')).toBe("Can't reach SellerFolio.")
  })
  it('falls back for everything else', () => {
    const f = "Couldn't get a suggestion. Try again."
    expect(suggestErrorText(400, 'missing_title')).toBe(f)
    expect(suggestErrorText(502, 'ai_unavailable')).toBe(f)
    expect(suggestErrorText(500)).toBe(f)
  })
})

// ── main-process decisions (Task 6) ──────────────────────────────────────────
describe('savedTokenKind', () => {
  it('tells a computer token from an old extension token and from nothing', () => {
    expect(savedTokenKind('sfm_abc')).toBe('computer')
    expect(savedTokenKind('sfc_abc')).toBe('legacy')
    expect(savedTokenKind('')).toBe('none')
    expect(savedTokenKind('sfm_')).toBe('none')
    expect(savedTokenKind('something')).toBe('none')
  })
})

describe('startState', () => {
  const rem = { shop: 'Luxesense', label: 'Table 1' }
  it('a computer token starts in checking, carrying what was remembered', () => {
    expect(startState('sfm_abc', rem)).toEqual({ kind: 'checking', shop: 'Luxesense', label: 'Table 1' })
    expect(startState('sfm_abc', null)).toEqual({ kind: 'checking' })
  })
  it('no token, or an old sfc_ token after the update, is none (the monitor does not start)', () => {
    expect(startState('', rem)).toEqual({ kind: 'none' })
    expect(startState('sfc_old', rem)).toEqual({ kind: 'none' })
    expect(canRunMonitor(startState('sfc_old', rem))).toBe(false)
  })
})

describe('rememberedAfter', () => {
  const rem = { shop: 'Old shop', label: 'Old label' }
  it('a successful check remembers the shop and label', () => {
    expect(rememberedAfter({ kind: 'connected', shop: 'S', label: 'L' }, rem)).toEqual({ shop: 'S', label: 'L' })
    expect(rememberedAfter({ kind: 'connected', shop: 'S', label: 'L' }, null)).toEqual({ shop: 'S', label: 'L' })
  })
  it('a network blip keeps what was remembered', () => {
    expect(rememberedAfter({ kind: 'offline', shop: 'Old shop', label: 'Old label' }, rem)).toEqual(rem)
    expect(rememberedAfter({ kind: 'checking' }, rem)).toEqual(rem)
    expect(rememberedAfter({ kind: 'none' }, rem)).toEqual(rem)
  })
  it('revoked or other machine forgets it, so an offline next launch is locked', () => {
    expect(rememberedAfter({ kind: 'revoked' }, rem)).toBeNull()
    expect(rememberedAfter({ kind: 'other_machine' }, rem)).toBeNull()
    // and the next offline start then has nothing to fall back on
    expect(nextState({ kind: 'checking' }, 'offline', null, rememberedAfter({ kind: 'revoked' }, rem))).toEqual({ kind: 'none' })
  })
})

describe('shouldCreateMonitor', () => {
  it('creates once, only for a state that may run', () => {
    expect(shouldCreateMonitor({ kind: 'connected', shop: 'a', label: 'b' }, false)).toBe(true)
    expect(shouldCreateMonitor({ kind: 'offline', shop: 'a', label: 'b' }, false)).toBe(true)
    expect(shouldCreateMonitor({ kind: 'connected', shop: 'a', label: 'b' }, true)).toBe(false)
    expect(shouldCreateMonitor({ kind: 'checking' }, false)).toBe(false)
    expect(shouldCreateMonitor({ kind: 'none' }, false)).toBe(false)
  })
  it('revoked while running does not ask to create or close anything', () => {
    expect(shouldCreateMonitor({ kind: 'revoked' }, true)).toBe(false)
    expect(shouldCreateMonitor({ kind: 'other_machine' }, true)).toBe(false)
  })
})

describe('uploadPlan', () => {
  const key = 'https://hq/api|sfm_x'
  const base = { state: { kind: 'connected', shop: 'a', label: 'b' } as ConnState, want: key, applied: null as string | null, halted: false, periodic: false }
  it('starts the upload when connected or offline with a computer token', () => {
    expect(uploadPlan(base)).toBe('start')
    expect(uploadPlan({ ...base, state: { kind: 'offline', shop: 'a', label: 'b' } })).toBe('start')
  })
  it('keeps a running upload as it is', () => {
    expect(uploadPlan({ ...base, applied: key })).toBe('keep')
  })
  it('stops uploads when revoked or used on another computer (the monitor stays open)', () => {
    expect(uploadPlan({ ...base, applied: key, state: { kind: 'revoked' } })).toBe('stop')
    expect(uploadPlan({ ...base, applied: key, state: { kind: 'other_machine' } })).toBe('stop')
    expect(uploadPlan({ ...base, applied: key, state: { kind: 'none' } })).toBe('stop')
  })
  it('never uploads without a computer token', () => {
    expect(uploadPlan({ ...base, want: null })).toBe('keep')
    expect(uploadPlan({ ...base, want: null, applied: key })).toBe('stop')
  })
  it('does not stop or start anything while still checking', () => {
    expect(uploadPlan({ ...base, state: { kind: 'checking' } })).toBe('keep')
    expect(uploadPlan({ ...base, applied: key, state: { kind: 'checking' } })).toBe('keep')
  })
  it('restarts after a token change', () => {
    expect(uploadPlan({ ...base, applied: 'https://hq/api|sfm_old' })).toBe('start')
  })
  it('retries an upload halted on auth only on the periodic check, never in a loop', () => {
    expect(uploadPlan({ ...base, applied: key, halted: true })).toBe('keep')
    expect(uploadPlan({ ...base, applied: key, halted: true, periodic: true })).toBe('start')
  })
})

describe('connectErrorText', () => {
  it('says what went wrong in plain English', () => {
    expect(connectErrorText('offline')).toBe("Can't reach SellerFolio. Check the internet connection and try again.")
    expect(connectErrorText('revoked')).toBe("SellerFolio didn't accept this token. Make a new one in SellerFolio → Settings → Capture devices.")
    expect(connectErrorText('other_machine')).toBe('This token is already used on another computer. Make a new one for this computer in SellerFolio.')
    expect(connectErrorText('bad')).toBe("Couldn't check the token. Try again.")
  })
})

describe('readSuggestion', () => {
  it('reads a pattern from the server reply', () => {
    expect(readSuggestion({ regex: '#(\\d+)', flags: 'i', explain: 'The lot number.' })).toEqual({ regex: '#(\\d+)', flags: 'i', explain: 'The lot number.' })
  })
  it('keeps only valid flags and defaults the rest', () => {
    expect(readSuggestion({ regex: 'a(b)', flags: 'ix;' })).toEqual({ regex: 'a(b)', flags: 'i', explain: '' })
  })
  it('refuses a reply without a pattern', () => {
    expect(readSuggestion({ regex: '' })).toBeNull()
    expect(readSuggestion(null)).toBeNull()
    expect(readSuggestion({ regex: 5 })).toBeNull()
  })
  it('refuses a pattern too long to trust', () => {
    expect(readSuggestion({ regex: 'a'.repeat(201) })).toBeNull()
  })
})
