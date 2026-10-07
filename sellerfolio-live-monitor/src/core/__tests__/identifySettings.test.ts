import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IDENTIFY_URL,
  checkBaseUrlInput,
  identifyGate,
  identifyPreflight,
  identifyStateFrom,
  identifyStatus,
  migrateLegacySwitch,
  parseIdentifySettings,
  serializeIdentifySettings,
  updateIdentifySettings,
} from '../identifySettings'

describe('identification is ON by default once a token exists (defect 5)', () => {
  it('no file at all: the default worker address, enabled', () => {
    expect(parseIdentifySettings(null)).toEqual({ baseUrl: DEFAULT_IDENTIFY_URL, enabled: true, damaged: false })
    expect(DEFAULT_IDENTIFY_URL).toBe('http://100.68.11.76:8099')
  })
  it('a file that says nothing about enabled leaves it on (the address alone was configurable before)', () => {
    expect(parseIdentifySettings('{"baseUrl":"https://worker.example.com"}')).toMatchObject({ enabled: true, baseUrl: 'https://worker.example.com' })
  })
  it('the operator turning it off sticks', () => {
    expect(parseIdentifySettings('{"enabled":false}')).toMatchObject({ enabled: false, damaged: false })
    expect(parseIdentifySettings('{"enabled":true}')).toMatchObject({ enabled: true })
  })
})

describe('the gate: what lets audio leave this machine', () => {
  it('needs BOTH a saved token and the switch', () => {
    expect(identifyGate({ hasToken: true, enabled: true })).toBe('on')
    expect(identifyGate({ hasToken: true, enabled: false })).toBe('off')
    expect(identifyGate({ hasToken: false, enabled: true })).toBe('no_token')
    expect(identifyGate({ hasToken: false, enabled: false })).toBe('no_token')
  })
  it('each state has its own words, and "on" says audio is being sent', () => {
    const on = identifyStatus('on', false)
    const off = identifyStatus('off', false)
    const none = identifyStatus('no_token', false)
    expect(new Set([on[0], off[0], none[0]]).size).toBe(3)
    expect(on[0]).toMatch(/audio/i)
    expect(off[0]).toMatch(/no audio/i)
    expect(none[0]).toMatch(/token/i)
  })
})

describe('a damaged settings file fails CLOSED: it must never switch audio on', () => {
  it.each([
    ['garbage', 'not json'],
    ['a truncated file (power cut mid-write)', '{"baseUrl":"http://100.68.11.76:8099","enab'],
    ['an array', '[]'],
    ['null', 'null'],
    ['an empty file', ''],
  ])('%s: default address, OFF, flagged', (_n, text) => {
    expect(parseIdentifySettings(text)).toEqual({ baseUrl: DEFAULT_IDENTIFY_URL, enabled: false, damaged: true })
  })
  it.each([['"false"'], ['0'], ['null'], ['"yes"'], ['[]']])('enabled=%s is not a boolean: OFF and flagged', (v) => {
    expect(parseIdentifySettings(`{"enabled":${v}}`)).toMatchObject({ enabled: false, damaged: true })
  })
  it('says so in the status text, so the operator can turn it back on knowingly', () => {
    expect(identifyStatus('off', true)[0]).toMatch(/unreadable|damaged|could not be read/i)
  })
})

describe('a saved address that would carry the token somewhere unsafe is not used', () => {
  it.each([
    ['http://evil.example.com:8099'],
    ['http://8.8.8.8:8099'],
    ['ftp://100.68.11.76'],
    ['javascript:alert(1)'],
    ['not a url'],
    [''],
    ['42'],
  ])('%s falls back to the default, keeping the switch', (u) => {
    expect(parseIdentifySettings(JSON.stringify({ baseUrl: u, enabled: false }))).toEqual({ baseUrl: DEFAULT_IDENTIFY_URL, enabled: false, damaged: false })
  })
  it('a saved address with stray spaces is trimmed, not kept as typed', () => {
    expect(parseIdentifySettings('{"baseUrl":"  http://100.68.11.76:8099  "}').baseUrl).toBe('http://100.68.11.76:8099')
  })
  it('a non-string address falls back too', () => {
    expect(parseIdentifySettings('{"baseUrl":7}').baseUrl).toBe(DEFAULT_IDENTIFY_URL)
  })
})

describe('serialize', () => {
  it('round trips through parse', () => {
    const s = { baseUrl: 'https://worker.example.com', enabled: false }
    expect(parseIdentifySettings(serializeIdentifySettings(s))).toEqual({ ...s, damaged: false })
  })
  it('writes only the address and the switch, never a token', () => {
    const text = serializeIdentifySettings({ baseUrl: 'http://100.68.11.76:8099', enabled: true, token: 'sfc_SECRET', tokenEnc: 'abc' } as never)
    expect(text).not.toContain('SECRET')
    expect(text).not.toContain('tokenEnc')
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['baseUrl', 'enabled'])
  })
})

describe('checkBaseUrlInput (what the Settings box accepts)', () => {
  it('an empty box resets to the default', () => {
    expect(checkBaseUrlInput('   ')).toEqual({ ok: true, baseUrl: DEFAULT_IDENTIFY_URL })
  })
  it('trims, drops a trailing slash, and accepts the tailnet, localhost and https', () => {
    expect(checkBaseUrlInput('  http://100.68.11.76:8099/ ')).toEqual({ ok: true, baseUrl: 'http://100.68.11.76:8099' })
    expect(checkBaseUrlInput('http://localhost:8099')).toEqual({ ok: true, baseUrl: 'http://localhost:8099' })
    expect(checkBaseUrlInput('https://worker.example.com')).toEqual({ ok: true, baseUrl: 'https://worker.example.com' })
  })
  it('a bare host:port gets http:// so a tailnet address can be pasted as it is', () => {
    expect(checkBaseUrlInput('100.68.11.76:8099')).toEqual({ ok: true, baseUrl: 'http://100.68.11.76:8099' })
  })
  it.each([
    ['http://example.com'],
    ['http://8.8.8.8'],
    ['ftp://100.68.11.76'],
    ['http://user:pw@100.68.11.76:8099'],
    ['http://100.68.11.76:8099/api/capture'],
    ['http://100.68.11.76:8099/?x=1'],
    ['http://100.68.11.76:8099/#x'],
    ['http://'],
    ['javascript:alert(1)'],
  ])('rejects %s with a reason the operator can act on', (u) => {
    const r = checkBaseUrlInput(u)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.length).toBeGreaterThan(10)
  })
})

// main.ts runs this before every POST. It is the check that makes "off" mean off even if the page
// disagrees (a clip queued before the switch was turned off, a stale renderer).
describe('identifyPreflight: the last check before a clip leaves the machine', () => {
  const on = { baseUrl: 'http://100.68.11.76:8099', enabled: true }
  it('sends with a token and the switch on, to the configured address', () => {
    expect(identifyPreflight('sfc_x', on)).toEqual({ ok: true, baseUrl: 'http://100.68.11.76:8099', token: 'sfc_x' })
    // an address other than the default: the preflight must hand back the CONFIGURED one
    expect(identifyPreflight('sfc_x', { baseUrl: 'https://w.example.com', enabled: true })).toMatchObject({ ok: true, baseUrl: 'https://w.example.com' })
  })
  it('refuses without a token, with the reason the token path already explains', () => {
    expect(identifyPreflight('', on)).toEqual({ ok: false, reason: 'bad_token' })
  })
  it('refuses when switched off, even with a token', () => {
    expect(identifyPreflight('sfc_x', { ...on, enabled: false })).toEqual({ ok: false, reason: 'identification_off' })
  })
  it('never echoes the token into a refusal', () => {
    expect(JSON.stringify(identifyPreflight('sfc_SECRET', { ...on, enabled: false }))).not.toContain('SECRET')
  })
})

describe('updateIdentifySettings (the Settings save)', () => {
  const cur = { baseUrl: 'http://100.68.11.76:8099', enabled: true }
  it('changes only what was sent', () => {
    expect(updateIdentifySettings(cur, { enabled: false })).toEqual({ ok: true, next: { ...cur, enabled: false } })
    expect(updateIdentifySettings(cur, { baseUrl: 'https://w.example.com/' })).toEqual({ ok: true, next: { baseUrl: 'https://w.example.com', enabled: true } })
    expect(updateIdentifySettings(cur, {})).toEqual({ ok: true, next: cur })
  })
  it('a value that is merely truthy does not switch it on: only the boolean true does', () => {
    const off = { baseUrl: 'http://100.68.11.76:8099', enabled: false }
    for (const v of ['yes', 1, {}, [], 'true']) expect(updateIdentifySettings(off, { enabled: v })).toEqual({ ok: true, next: off })
  })
  it('an unsafe address is refused and nothing changes', () => {
    const r = updateIdentifySettings(cur, { baseUrl: 'http://example.com', enabled: false })
    expect(r.ok).toBe(false)
  })
  it('ignores values of the wrong type instead of coercing them (a string "false" must not switch it on or off)', () => {
    expect(updateIdentifySettings(cur, { enabled: 'false' as never })).toEqual({ ok: true, next: cur })
    expect(updateIdentifySettings(cur, { baseUrl: 7 as never })).toEqual({ ok: true, next: cur })
  })
  it('saving the address of a damaged (OFF) setting does not switch it back on', () => {
    const damaged = parseIdentifySettings('garbage')
    const r = updateIdentifySettings(damaged, { baseUrl: 'http://localhost:8099' })
    expect(r).toEqual({ ok: true, next: { baseUrl: 'http://localhost:8099', enabled: false } })
  })
  it('the result carries no damaged flag into the file', () => {
    const damaged = parseIdentifySettings('garbage')
    const r = updateIdentifySettings(damaged, { enabled: true })
    expect(r.ok && Object.keys(r.next).sort()).toEqual(['baseUrl', 'enabled'])
  })
})

describe('identifyStateFrom: what the page believes, from what main told it', () => {
  const view = { baseUrl: 'http://100.68.11.76:8099', enabled: true, damaged: false, defaultBaseUrl: DEFAULT_IDENTIFY_URL, ready: true }
  it('takes every field as reported', () => {
    expect(identifyStateFrom(view)).toEqual({ ready: true, enabled: true, damaged: false, baseUrl: view.baseUrl, defaultBaseUrl: DEFAULT_IDENTIFY_URL })
    expect(identifyStateFrom({ ...view, ready: false, enabled: false, damaged: true, baseUrl: 'https://w.example.com' })).toMatchObject({ ready: false, enabled: false, damaged: true, baseUrl: 'https://w.example.com' })
  })
  it.each([[undefined], [null], ['x'], [42], [[]], [{}]])('fails CLOSED on %s: not ready, not enabled', (v) => {
    expect(identifyStateFrom(v)).toMatchObject({ ready: false, enabled: false })
  })
  it('only the boolean true counts: a truthy string does not switch anything on', () => {
    expect(identifyStateFrom({ ...view, ready: 'yes', enabled: 1 })).toMatchObject({ ready: false, enabled: false })
  })
  it('keeps the default address when main sends a bad one', () => {
    expect(identifyStateFrom({ ...view, baseUrl: 7, defaultBaseUrl: null })).toMatchObject({ baseUrl: DEFAULT_IDENTIFY_URL, defaultBaseUrl: DEFAULT_IDENTIFY_URL })
  })
})

// The old switch lived in the page's localStorage ('tt-ai-transcribe': '1' on, anything else off) and
// defaulted OFF. An operator who turned it off on purpose must not have an update switch it back on.
describe('migrateLegacySwitch: an explicit old opt-out survives the new default', () => {
  const KEY = 'tt-ai-transcribe'
  function fakeStorage(initial: Record<string, string>) {
    const data = { ...initial }
    return {
      data,
      getItem: (k: string) => (k in data ? (data[k] as string) : null),
      removeItem: (k: string) => { delete data[k] },
    }
  }

  it('an explicit "0" turns identification OFF in the new setting, once, and clears the old key', async () => {
    const st = fakeStorage({ [KEY]: '0' })
    const saved: boolean[] = []
    await migrateLegacySwitch(st, async (enabled) => { saved.push(enabled); return true })
    expect(saved).toEqual([false])
    expect(KEY in st.data).toBe(false)
  })
  it('an absent preference is not a choice: nothing is saved, so the new default (on) applies', async () => {
    const st = fakeStorage({})
    const saved: boolean[] = []
    await migrateLegacySwitch(st, async (enabled) => { saved.push(enabled); return true })
    expect(saved).toEqual([])
    expect(parseIdentifySettings(null).enabled).toBe(true)
  })
  it('an old "1" (it was on) saves nothing and is cleared', async () => {
    const st = fakeStorage({ [KEY]: '1' })
    const saved: boolean[] = []
    await migrateLegacySwitch(st, async (enabled) => { saved.push(enabled); return true })
    expect(saved).toEqual([])
    expect(KEY in st.data).toBe(false)
  })
  it.each([['false'], ['off'], [''], ['no'], ['2']])('anything else that was stored (%j) is read as the old code read it: off', async (v) => {
    const st = fakeStorage({ [KEY]: v })
    const saved: boolean[] = []
    await migrateLegacySwitch(st, async (enabled) => { saved.push(enabled); return true })
    expect(saved).toEqual([false])
  })
  it('if the save fails the old key is KEPT, so the opt-out is retried next launch rather than lost', async () => {
    const st = fakeStorage({ [KEY]: '0' })
    await migrateLegacySwitch(st, async () => false)
    expect(st.data[KEY]).toBe('0')
    await migrateLegacySwitch(st, async () => { throw new Error('ipc down') })
    expect(st.data[KEY]).toBe('0')
  })
  it('is one-shot: once migrated, a later launch does not override what the operator chose in the new switch', async () => {
    const st = fakeStorage({ [KEY]: '0' })
    let calls = 0
    const save = async () => { calls++; return true }
    await migrateLegacySwitch(st, save)
    await migrateLegacySwitch(st, save)
    expect(calls).toBe(1)
  })
  it('storage that throws changes nothing and does not throw', async () => {
    const boom = { getItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }
    let calls = 0
    await expect(migrateLegacySwitch(boom, async () => { calls++; return true })).resolves.toBeUndefined()
    expect(calls).toBe(0)
  })
})
