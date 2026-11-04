import { describe, it, expect } from 'vitest'
import { parseConnectToken, whoamiVerdict, nextState, canRunMonitor, suggestErrorText, type ConnState } from '../sfConnect'

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
