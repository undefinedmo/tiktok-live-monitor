import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { createBuyerHistory, AUTH_PAUSE_MS, BATCH_DELAY_MS, UNAVAILABLE_PAUSE_MS, type BuyerHistoryDeps, type BuyerHistoryEnv } from '../buyerHistory'

interface Call { url: string; body: { buyerIds: string[]; showStartedAtMs?: number }; headers: Record<string, string> }

function harness(opts: { connected?: boolean; startedAt?: number } = {}) {
  let now = 1_000_000
  let timers: { at: number; fn: () => void; id: number }[] = []
  let nextId = 1
  const calls: Call[] = []
  const sent: unknown[] = []
  const logs: string[] = []
  type Reply = { status: number; body?: unknown } | 'throw'
  let reply: (c: Call) => Reply | Promise<Reply> = (c) => ({ status: 200, body: { counts: Object.fromEntries(c.body.buyerIds.map((id) => [id, id.length])), asOf: 'now' } })
  let show: string | undefined = 'room1'
  let connected = opts.connected ?? true

  const env: BuyerHistoryEnv = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ at: now + ms, fn, id }); return id },
    clearTimeout: (h) => { timers = timers.filter((t) => t.id !== h) },
    fetch: async (url, init) => {
      const c: Call = { url, body: JSON.parse(init.body), headers: init.headers }
      calls.push(c)
      const r = await reply(c)
      if (r === 'throw') throw new Error('offline')
      return { status: r.status, json: async () => r.body }
    },
  }
  const deps: BuyerHistoryDeps = {
    url: () => (connected ? 'https://hq.example/api/desktop/buyer-history' : null),
    headers: () => (connected ? { authorization: 'Bearer sfm_x', 'x-sf-device': 'd1' } : null),
    show: () => show,
    showStartedAtMs: opts.startedAt !== undefined ? () => opts.startedAt : undefined,
    send: (ch, p) => { expect(ch).toBe('buyer:counts'); sent.push(p) },
    log: (l) => logs.push(l),
  }
  const bh = createBuyerHistory(deps, env)
  /** Advance the clock, firing due timers and letting the async fetch chain settle. */
  async function advance(ms: number) {
    const end = now + ms
    for (;;) {
      await new Promise((r) => setImmediate(r))
      timers.sort((a, b) => a.at - b.at)
      const t = timers[0]
      if (!t || t.at > end) break
      timers.shift()
      now = Math.max(now, t.at)
      t.fn()
    }
    now = end
    await new Promise((r) => setImmediate(r))
  }
  return {
    bh, calls, sent, logs, advance,
    setReply: (f: typeof reply) => { reply = f },
    setShow: (s: string | undefined) => { show = s },
    setConnected: (c: boolean) => { connected = c },
    now: () => now,
  }
}

describe('buyer history (main)', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => { h = harness() })

  it('batches a burst after ~300 ms, posts with the token, pushes counts, then answers from cache', async () => {
    expect(h.bh.lookup(['a', 'bb', 'a', ''])).toEqual({ counts: {} })
    h.bh.lookup(['ccc'])
    await h.advance(BATCH_DELAY_MS - 1)
    expect(h.calls).toHaveLength(0)
    await h.advance(1)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.body.buyerIds).toEqual(['a', 'bb', 'ccc'])
    expect(h.calls[0]!.headers.authorization).toBe('Bearer sfm_x')
    expect(h.calls[0]!.headers['x-sf-device']).toBe('d1')
    expect(h.sent).toEqual([{ counts: { a: 1, bb: 2, ccc: 3 } }])
    expect(h.bh.lookup(['a', 'ccc', 'zz'])).toEqual({ counts: { a: 1, ccc: 3 } })
    await h.advance(BATCH_DELAY_MS)
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]!.body.buyerIds).toEqual(['zz']) // never refetches a known id
  })

  it('splits more than 200 ids over sequential requests', async () => {
    h.bh.lookup(Array.from({ length: 450 }, (_, i) => `id${i}`))
    await h.advance(BATCH_DELAY_MS + 10)
    expect(h.calls.map((c) => c.body.buyerIds.length)).toEqual([200, 200, 50])
  })

  it('sends the show start: from main when known, else when this show was first seen', async () => {
    h.bh.lookup(['a'])
    const seen = h.now()
    await h.advance(BATCH_DELAY_MS)
    expect(h.calls[0]!.body.showStartedAtMs).toBe(seen)
    const h2 = harness({ startedAt: 12345 })
    h2.bh.lookup(['a'])
    await h2.advance(BATCH_DELAY_MS)
    expect(h2.calls[0]!.body.showStartedAtMs).toBe(12345)
  })

  it('is a no-op when not connected', async () => {
    const n = harness({ connected: false })
    expect(n.bh.lookup(['a'])).toEqual({ counts: {} })
    await n.advance(10_000)
    expect(n.calls).toHaveLength(0)
    expect(n.bh.state().pending).toBe(0)
  })

  it('an hq without the endpoint (404/501) → silent, no badge, asks again after 30 min', async () => {
    h.setReply(() => ({ status: 501 }))
    h.bh.lookup(['a'])
    await h.advance(BATCH_DELAY_MS)
    expect(h.calls).toHaveLength(1)
    expect(h.sent).toEqual([])
    h.bh.lookup(['a', 'b'])
    await h.advance(UNAVAILABLE_PAUSE_MS - 10_000)
    expect(h.calls).toHaveLength(1)
    h.setReply((c) => ({ status: 200, body: { counts: Object.fromEntries(c.body.buyerIds.map((id) => [id, 0])) } }))
    await h.advance(20_000)
    expect(h.calls).toHaveLength(2)
    expect(h.sent).toEqual([{ counts: { a: 0, b: 0 } }])
    expect(h.logs.filter((l) => l.includes('no buyer history'))).toHaveLength(1)
  })

  it('401/403 → pauses 5 min', async () => {
    h.setReply(() => ({ status: 401 }))
    h.bh.lookup(['a'])
    await h.advance(BATCH_DELAY_MS)
    h.bh.lookup(['a'])
    await h.advance(AUTH_PAUSE_MS / 2)
    expect(h.calls).toHaveLength(1)
    await h.advance(AUTH_PAUSE_MS)
    expect(h.calls).toHaveLength(2)
  })

  it('network failures retry with growing backoff and keep the batch', async () => {
    h.setReply(() => 'throw')
    h.bh.lookup(['a', 'b'])
    await h.advance(BATCH_DELAY_MS)
    expect(h.calls).toHaveLength(1)
    await h.advance(4_999)
    expect(h.calls).toHaveLength(1)
    await h.advance(1)
    expect(h.calls).toHaveLength(2)
    await h.advance(10_000)
    expect(h.calls).toHaveLength(3)
    h.setReply((c) => ({ status: 200, body: { counts: Object.fromEntries(c.body.buyerIds.map((id) => [id, 5])) } }))
    await h.advance(20_000)
    expect(h.calls).toHaveLength(4)
    expect(h.calls[3]!.body.buyerIds).toEqual(['a', 'b'])
    expect(h.sent).toEqual([{ counts: { a: 5, b: 5 } }])
    expect(h.bh.state().failures).toBe(0)
  })

  it('a new id during backoff does not pull the retry in early', async () => {
    h.setReply(() => 'throw')
    h.bh.lookup(['a'])
    await h.advance(BATCH_DELAY_MS)
    expect(h.calls).toHaveLength(1) //            failed: retry due in 5 s
    await h.advance(1_000)
    h.bh.lookup(['b']) //                          would schedule a 300 ms batch
    await h.advance(BATCH_DELAY_MS)
    expect(h.calls).toHaveLength(1)
    await h.advance(3_699)
    expect(h.calls).toHaveLength(1)
    await h.advance(1) //                          5 s after the failure
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]!.body.buyerIds).toEqual(['a', 'b'])
    // second failure: 10 s; a new id 1 s in still waits the full 10 s
    await h.advance(1_000)
    h.bh.lookup(['c'])
    await h.advance(8_999)
    expect(h.calls).toHaveLength(2)
    await h.advance(1)
    expect(h.calls).toHaveLength(3)
  })

  it('400 → those ids are not asked again this show', async () => {
    h.setReply(() => ({ status: 400 }))
    h.bh.lookup(['a'])
    await h.advance(BATCH_DELAY_MS)
    h.bh.lookup(['a'])
    await h.advance(60_000)
    expect(h.calls).toHaveLength(1)
  })

  it('a new show clears the cache, tells the viewer to reset, and drops stale answers', async () => {
    h.bh.lookup(['a'])
    await h.advance(BATCH_DELAY_MS)
    expect(h.bh.lookup(['a']).counts).toEqual({ a: 1 })
    h.setShow('room2')
    expect(h.bh.lookup(['a']).counts).toEqual({})
    expect(h.sent.at(-1)).toEqual({ counts: {}, reset: true })
    await h.advance(BATCH_DELAY_MS)
    expect(h.bh.lookup(['a']).counts).toEqual({ a: 1 })
    // an answer that lands after the show changed is thrown away
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    h.setReply(async (c) => { await gate; return { status: 200, body: { counts: Object.fromEntries(c.body.buyerIds.map((id) => [id, 9])) } } })
    h.bh.lookup(['b'])
    await h.advance(BATCH_DELAY_MS) // request for 'b' is in flight
    expect(h.calls.at(-1)!.body.buyerIds).toEqual(['b'])
    h.setShow('room3')
    h.bh.lookup([])
    release()
    await h.advance(10)
    expect(h.bh.lookup(['b']).counts).toEqual({})
    expect(h.sent.some((p) => JSON.stringify(p).includes('"b":9'))).toBe(false)
  })

  it('never throws on junk input', () => {
    expect(h.bh.lookup(null)).toEqual({ counts: {} })
    expect(h.bh.lookup('a')).toEqual({ counts: {} })
    expect(h.bh.lookup([1, {}, null])).toEqual({ counts: {} })
  })
})
