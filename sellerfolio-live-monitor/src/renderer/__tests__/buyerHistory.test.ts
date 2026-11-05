import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { _resetForTests, badgeFor, initBuyerHistory, onCountsChanged, pastOrdersOf, requestCounts, REASK_MS } from '../buyerHistory'

// A tiny stand-in for document.createElement — the app's tests run in node.
class FakeEl {
  className = ''; textContent = ''; title = ''
  attrs: Record<string, string> = {}
  setAttribute(k: string, v: string) { this.attrs[k] = v }
}

const g = globalThis as Record<string, unknown>
const tick = () => new Promise((r) => setImmediate(r))

describe('buyer history (renderer)', () => {
  let push: ((p: unknown) => void) | undefined
  let lookups: string[][]
  let answer: (ids: string[]) => Record<string, number>

  beforeEach(() => {
    _resetForTests()
    lookups = []
    answer = () => ({})
    push = undefined
    g.document = { createElement: () => new FakeEl() }
    g.buyerAPI = {
      lookup: async (ids: string[]) => { lookups.push(ids); return { counts: answer(ids) } },
      onCounts: (cb: (p: unknown) => void) => { push = cb },
    }
    initBuyerHistory()
  })
  afterEach(() => { delete g.buyerAPI; delete g.document; vi.useRealTimers() })

  it('no badge while unknown', () => {
    expect(badgeFor('a')).toBeNull()
    expect(badgeFor(undefined)).toBeNull()
  })

  it('coalesces requests into one lookup and skips ids already asked', async () => {
    requestCounts(['a', 'b', undefined, ''])
    requestCounts(['b', 'c'])
    await tick()
    expect(lookups).toEqual([['a', 'b', 'c']])
    requestCounts(['a'])
    await tick()
    expect(lookups).toHaveLength(1)
  })

  it('cached answers from lookup and pushed counts both notify and render badges', async () => {
    const cb = vi.fn()
    onCountsChanged(cb)
    answer = () => ({ a: 0 })
    requestCounts(['a', 'b'])
    await tick(); await tick()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(pastOrdersOf('a')).toBe(0)
    const nb = badgeFor('a') as unknown as FakeEl
    expect(nb.className).toBe('tag buyer-new')
    expect(nb.textContent).toBe('NEW')
    expect(nb.attrs['aria-label']).toBe('First order')

    push!({ counts: { b: 240 } })
    expect(cb).toHaveBeenCalledTimes(2)
    const ob = badgeFor('b') as unknown as FakeEl
    expect(ob.className).toBe('tag buyer-ord')
    expect(ob.textContent).toBe('99+')
    expect(ob.title).toBe('240 past orders')
    expect(ob.attrs['aria-label']).toBe('240 past orders')

    push!({ counts: { b: 240 } }) // nothing new → no repaint
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('a reset (new show) forgets every count', () => {
    push!({ counts: { a: 3 } })
    expect(pastOrdersOf('a')).toBe(3)
    push!({ counts: {}, reset: true })
    expect(pastOrdersOf('a')).toBeUndefined()
    expect(badgeFor('a')).toBeNull()
  })

  it('asks main again about a still-unknown id after a while', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    requestCounts(['z'])
    await tick()
    vi.setSystemTime(Date.now() + REASK_MS + 1)
    requestCounts(['z'])
    await tick()
    expect(lookups).toEqual([['z'], ['z']])
  })

  it('a new room (the top bar) drops every cached count and asks main again', async () => {
    let roomText = 'room1'
    g.document = { createElement: () => new FakeEl(), getElementById: (id: string) => (id === 'room' ? { textContent: roomText } : null) }
    const cb = vi.fn()
    onCountsChanged(cb)
    answer = (ids) => Object.fromEntries(ids.map((id) => [id, 4]))
    requestCounts(['a'])
    await tick(); await tick()
    expect(pastOrdersOf('a')).toBe(4)
    expect(cb).toHaveBeenCalledTimes(1)
    requestCounts(['a']) // known: not asked again in the same room
    await tick()
    expect(lookups).toEqual([['a']])

    roomText = '—' // between shows: not a room, keep what we have
    expect(pastOrdersOf('a')).toBe(4)

    roomText = 'room2'
    expect(badgeFor('a')).toBeNull() // stale count gone at once
    await tick()
    expect(cb).toHaveBeenCalledTimes(2) // listeners repaint (deferred, not inside the painter)
    answer = (ids) => Object.fromEntries(ids.map((id) => [id, 7]))
    requestCounts(['a'])
    await tick(); await tick()
    expect(lookups).toEqual([['a'], ['a']])
    expect(pastOrdersOf('a')).toBe(7)
  })

  it('survives a missing bridge and a failing lookup', async () => {
    g.buyerAPI = { lookup: async () => { throw new Error('x') }, onCounts: () => {} }
    expect(() => requestCounts(['q'])).not.toThrow()
    await tick()
    delete g.buyerAPI
    expect(() => requestCounts(['r'])).not.toThrow()
    await tick()
  })
})
