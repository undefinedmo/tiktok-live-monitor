import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import {
  createShowStats, AUTH_PAUSE_MS, HEARTBEAT_MS, STATS_EVERY_MS, TIMELINE_EVERY_MS, UNAVAILABLE_RETRY_MS,
  type ShowStatsDeps, type ShowStatsEnv,
} from '../showStats'

const STATS = { roomId: 'r1', asOf: '2026-11-05T20:05:00.000Z', gmv: '100.00', orders: 4, itemsSold: 5, buyers: 3, aov: '25.00', firstOrderAt: null, lastOrderAt: null, sellingMinutes: null, tiktok: null }
const TIMELINE = { timeline: { hasJournal: true, startMs: 1, endMs: 2, auctions: [], chatBuckets: [], questions: [], flags: [] } }

type Reply = { status: number; body?: unknown } | 'throw'
type ReplyFn = (url: string) => Reply | Promise<Reply>

function harness() {
  let now = 1_000_000
  let timers: { at: number; fn: () => void; id: number }[] = []
  let nextId = 1
  const calls: { url: string; headers: Record<string, string> }[] = []
  const sent: { ch: string; v: { room: string | null; state: string; data: unknown; at: number | null } }[] = []
  const logs: string[] = []
  let show: string | undefined = 'r1'
  let connected = true
  let reply: ReplyFn = (url) => (url.includes('/show-stats') ? { status: 200, body: STATS } : { status: 200, body: TIMELINE })

  const env: ShowStatsEnv = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ at: now + ms, fn, id }); return id },
    clearTimeout: (h) => { timers = timers.filter((t) => t.id !== h) },
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers })
      const r = await reply(url)
      if (r === 'throw') throw new Error('offline')
      return { status: r.status, json: async () => r.body }
    },
  }
  const deps: ShowStatsDeps = {
    url: (p) => (connected ? `https://hq.example${p}` : null),
    headers: () => (connected ? { authorization: 'Bearer sfm_x', 'x-sf-device': 'd1' } : null),
    show: () => show,
    send: (ch, v) => sent.push({ ch, v: v as never }),
    log: (l) => logs.push(l),
  }
  const p = createShowStats(deps, env)
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
  const statsCalls = () => calls.filter((c) => c.url.includes('/show-stats'))
  const tlCalls = () => calls.filter((c) => c.url.includes('/timeline'))
  const last = (ch: string) => [...sent].reverse().find((s) => s.ch === ch)?.v
  return {
    p, calls, sent, logs, advance, statsCalls, tlCalls, last,
    setReply: (f: typeof reply) => { reply = f },
    setShow: (s: string | undefined) => { show = s },
    setConnected: (c: boolean) => { connected = c },
    now: () => now,
  }
}

describe('show stats poller', () => {
  it('polls show-stats every 30 s with the desktop token and the room id', async () => {
    const h = harness()
    await h.advance(0)
    expect(h.statsCalls()).toHaveLength(1)
    expect(h.calls[0]!.url).toBe('https://hq.example/api/desktop/show-stats?roomId=r1')
    expect(h.calls[0]!.headers).toMatchObject({ authorization: 'Bearer sfm_x', 'x-sf-device': 'd1' })
    expect(h.last('show:stats')).toMatchObject({ room: 'r1', state: 'ok', data: { gmvCents: 10000, buyers: 3, itemsSold: 5, aovCents: 2500 } })
    await h.advance(STATS_EVERY_MS - HEARTBEAT_MS)
    expect(h.statsCalls()).toHaveLength(1)
    await h.advance(HEARTBEAT_MS)
    expect(h.statsCalls()).toHaveLength(2)
  })

  it('asks for nothing without a computer token or a room', async () => {
    const h = harness()
    h.setConnected(false)
    await h.advance(60_000)
    expect(h.calls).toHaveLength(0)
    expect(h.last('show:stats')).toMatchObject({ state: 'off', data: null })
    h.setConnected(true)
    h.setShow(undefined)
    await h.advance(60_000)
    expect(h.calls).toHaveLength(0)
    expect(h.last('show:stats')).toMatchObject({ state: 'waiting' })
    h.setShow('r9')
    await h.advance(HEARTBEAT_MS)
    expect(h.statsCalls().map((c) => c.url)).toEqual(['https://hq.example/api/desktop/show-stats?roomId=r9'])
  })

  it('404/501 → unavailable, quiet, asks again in 10 min', async () => {
    const h = harness()
    h.setReply(() => ({ status: 404 }))
    await h.advance(0)
    expect(h.last('show:stats')).toMatchObject({ state: 'unavailable', data: null })
    await h.advance(UNAVAILABLE_RETRY_MS - HEARTBEAT_MS)
    expect(h.statsCalls()).toHaveLength(1)
    h.setReply(() => ({ status: 200, body: STATS }))
    await h.advance(HEARTBEAT_MS)
    expect(h.statsCalls()).toHaveLength(2)
    expect(h.last('show:stats')).toMatchObject({ state: 'ok' })
    expect(h.logs.filter((l) => l.includes('no /api/desktop/show-stats'))).toHaveLength(1)
  })

  it('401 pauses 5 min; a network failure keeps the last figures and backs off', async () => {
    const h = harness()
    await h.advance(0)
    h.setReply(() => 'throw')
    await h.advance(STATS_EVERY_MS)
    expect(h.last('show:stats')).toMatchObject({ state: 'error', data: { gmvCents: 10000 } })
    // back-off: 30 s then 60 s
    await h.advance(STATS_EVERY_MS)
    expect(h.statsCalls()).toHaveLength(3)
    await h.advance(STATS_EVERY_MS)
    expect(h.statsCalls()).toHaveLength(3)
    await h.advance(STATS_EVERY_MS)
    expect(h.statsCalls()).toHaveLength(4)
    h.setReply(() => ({ status: 401 }))
    await h.advance(120_000)
    expect(h.last('show:stats')).toMatchObject({ state: 'auth' })
    const n = h.statsCalls().length
    await h.advance(AUTH_PAUSE_MS - HEARTBEAT_MS)
    expect(h.statsCalls()).toHaveLength(n)
  })

  it('a body that is not show stats counts as a failure, not as zeros', async () => {
    const h = harness()
    h.setReply(() => ({ status: 200, body: { error: 'x' } }))
    await h.advance(0)
    expect(h.last('show:stats')).toMatchObject({ state: 'error', data: null })
  })

  it('timeline only while the panel is open, every 60 s, immediately on open', async () => {
    const h = harness()
    await h.advance(120_000)
    expect(h.tlCalls()).toHaveLength(0)
    h.p.setTimelineOpen(true)
    await h.advance(0)
    expect(h.tlCalls()).toHaveLength(1)
    expect(h.tlCalls()[0]!.url).toBe('https://hq.example/api/desktop/timeline?roomId=r1')
    expect(h.last('show:timeline')).toMatchObject({ state: 'ok', data: { hasJournal: true, auctions: [] } })
    await h.advance(TIMELINE_EVERY_MS)
    expect(h.tlCalls()).toHaveLength(2)
    h.p.setTimelineOpen(false)
    await h.advance(5 * TIMELINE_EVERY_MS)
    expect(h.tlCalls()).toHaveLength(2)
  })

  it('a new room resets both feeds and drops a reply for the old room', async () => {
    const h = harness()
    await h.advance(0)
    h.setReply((url) => {
      if (url.includes('roomId=r1')) return { status: 200, body: STATS }
      return { status: 200, body: { ...STATS, roomId: 'r2', buyers: 9 } }
    })
    h.setShow('r2')
    await h.advance(HEARTBEAT_MS)
    const statsPushes = h.sent.filter((s) => s.ch === 'show:stats').map((s) => s.v)
    expect(statsPushes.some((v) => v.room === 'r2' && v.state === 'waiting' && v.data === null)).toBe(true)
    expect(h.last('show:stats')).toMatchObject({ room: 'r2', state: 'ok', data: { buyers: 9 } })
    expect(h.p.snapshot().stats.room).toBe('r2')
  })

  it('a reply that lands after the room changed is labelled with its own room, then reset', async () => {
    const h = harness()
    let resolve!: (r: Reply) => void
    h.setReply(() => new Promise<Reply>((r) => { resolve = r }))
    await h.advance(0)
    h.setShow('r2')
    h.setReply(() => ({ status: 200, body: { ...STATS, roomId: 'r2', buyers: 9 } }))
    resolve({ status: 200, body: STATS })
    await h.advance(0)
    const pushes = h.sent.filter((s) => s.ch === 'show:stats').map((s) => s.v)
    expect(pushes.filter((v) => v.data && (v.data as { buyers: number }).buyers === 3).every((v) => v.room === 'r1')).toBe(true)
    await h.advance(HEARTBEAT_MS)
    expect(h.last('show:stats')).toMatchObject({ room: 'r2', state: 'ok', data: { buyers: 9 } })
  })
})
