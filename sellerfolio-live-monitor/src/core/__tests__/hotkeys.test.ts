import { describe, it, expect } from 'vitest'
import {
  learnKey, accelOf, keyLabel, parseHotkeys, addKey, removeKey, actionFor, createLockout,
  DEFAULT_HOTKEYS, LOCKOUT_MS, MAX_KEYS_PER_ACTION,
} from '../hotkeys'

describe('learnKey', () => {
  it('takes function keys F1–F24 alone, by key or by code', () => {
    expect(learnKey({ key: 'F14', code: 'F14' })).toEqual({ ok: true, accel: 'F14' })
    expect(learnKey({ key: 'Unidentified', code: 'F13' })).toEqual({ ok: true, accel: 'F13' })
    expect(learnKey({ key: 'F24' })).toEqual({ ok: true, accel: 'F24' })
  })
  it('takes media keys alone, under Electron’s names', () => {
    expect(learnKey({ key: 'MediaPlayPause' })).toEqual({ ok: true, accel: 'MediaPlayPause' })
    expect(learnKey({ key: 'MediaTrackNext' })).toEqual({ ok: true, accel: 'MediaNextTrack' })
    expect(learnKey({ key: 'AudioVolumeUp' })).toEqual({ ok: true, accel: 'VolumeUp' })
  })
  it('refuses typing and scrolling keys alone, accepts them with Ctrl or Alt', () => {
    expect(learnKey({ key: 'p', code: 'KeyP' })).toEqual({ ok: false, reason: 'typing-key' })
    expect(learnKey({ key: 'PageDown', code: 'PageDown' })).toEqual({ ok: false, reason: 'typing-key' })
    expect(learnKey({ key: ' ', code: 'Space' })).toEqual({ ok: false, reason: 'typing-key' })
    expect(learnKey({ key: 'P', code: 'KeyP', shift: true })).toEqual({ ok: false, reason: 'typing-key' })
    expect(learnKey({ key: 'p', code: 'KeyP', control: true, alt: true })).toEqual({ ok: true, accel: 'Control+Alt+P' })
    expect(learnKey({ key: 'PageDown', alt: true })).toEqual({ ok: true, accel: 'Alt+PageDown' })
  })
  it('keeps modifiers in a fixed order, so the same press always gives the same string', () => {
    expect(accelOf({ key: 'F9', shift: true, control: true, meta: true, alt: true })).toBe('Control+Alt+Shift+Super+F9')
  })
  it('waits past a lone modifier and refuses unknown keys', () => {
    expect(learnKey({ key: 'Control', code: 'ControlLeft', control: true })).toEqual({ ok: false, reason: 'modifier-only' })
    expect(learnKey({ key: 'Unidentified', code: '' })).toEqual({ ok: false, reason: 'unsupported' })
    expect(accelOf({ key: 'p' })).toBeNull()
  })
  it('uses the physical key for letters, so Alt combos that produce symbols still bind', () => {
    expect(learnKey({ key: 'π', code: 'KeyP', alt: true })).toEqual({ ok: true, accel: 'Alt+P' })
  })
})

describe('keyLabel', () => {
  it('reads like the keyboard', () => {
    expect(keyLabel('Control+Alt+P')).toBe('Ctrl + Alt + P')
    expect(keyLabel('MediaPlayPause')).toBe('Play/Pause')
    expect(keyLabel('F14')).toBe('F14')
  })
})

describe('parseHotkeys', () => {
  it('defaults to F14 = Print last when there is no file or it is garbage', () => {
    expect(parseHotkeys(null)).toEqual(DEFAULT_HOTKEYS)
    expect(parseHotkeys('{not json')).toEqual(DEFAULT_HOTKEYS)
    expect(parseHotkeys('{}')).toEqual(DEFAULT_HOTKEYS)
  })
  it('keeps an empty list (the user removed every key) instead of bringing F14 back', () => {
    expect(parseHotkeys('{"printLast":[]}')).toEqual({ printLast: [] })
  })
  it('drops hand-edited keys that would steal typing, duplicates, and anything past the cap', () => {
    const raw = JSON.stringify({ printLast: ['F13', 'P', 'Space', 'F13', 'Control+Alt+P', 42, 'Bogus+F1', 'F15', 'F16', 'F17'] })
    expect(parseHotkeys(raw).printLast).toEqual(['F13', 'Control+Alt+P', 'F15', 'F16'].slice(0, MAX_KEYS_PER_ACTION))
  })
})

describe('addKey / removeKey / actionFor', () => {
  it('adds, ignores a repeat, removes', () => {
    let h = addKey(DEFAULT_HOTKEYS, 'printLast', 'F13')
    if ('error' in h) throw new Error(h.error)
    expect(h.printLast).toEqual(['F14', 'F13'])
    const again = addKey(h, 'printLast', 'F13')
    if ('error' in again) throw new Error(again.error)
    expect(again.printLast).toEqual(['F14', 'F13'])
    h = removeKey(h, 'printLast', 'F14')
    expect(h.printLast).toEqual(['F13'])
    expect(actionFor(h, 'F13')).toBe('printLast')
    expect(actionFor(h, 'F14')).toBeNull()
    expect(actionFor(h, null)).toBeNull()
  })
  it('refuses a key that would steal typing and a fifth key', () => {
    expect(addKey(DEFAULT_HOTKEYS, 'printLast', 'P')).toHaveProperty('error')
    const full = { printLast: ['F13', 'F14', 'F15', 'F16'] }
    expect(addKey(full, 'printLast', 'F17')).toHaveProperty('error')
  })
  it('never changes the bindings it was given', () => {
    const before = JSON.stringify(DEFAULT_HOTKEYS)
    addKey(DEFAULT_HOTKEYS, 'printLast', 'F13')
    removeKey(DEFAULT_HOTKEYS, 'printLast', 'F14')
    expect(JSON.stringify(DEFAULT_HOTKEYS)).toBe(before)
  })
})

describe('lockout', () => {
  it('lets the first press through and swallows a second inside 2 seconds, from any clicker', () => {
    const l = createLockout()
    expect(l.press('printLast', 10_000)).toBe(true)
    expect(l.press('printLast', 10_000 + 300)).toBe(false) // the other host, same moment
    expect(l.press('printLast', 10_000 + LOCKOUT_MS - 1)).toBe(false)
    expect(l.press('printLast', 10_000 + LOCKOUT_MS)).toBe(true)
  })
  it('a swallowed press does not extend the lockout', () => {
    const l = createLockout(2000)
    l.press('printLast', 0)
    l.press('printLast', 1500)
    expect(l.press('printLast', 2000)).toBe(true)
  })
  it('a clock that went backwards does not lock the button forever', () => {
    const l = createLockout(2000)
    l.press('printLast', 50_000)
    expect(l.press('printLast', 1_000)).toBe(true)
  })
})
