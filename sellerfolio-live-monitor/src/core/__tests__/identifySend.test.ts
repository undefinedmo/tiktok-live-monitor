import { describe, expect, it, vi } from 'vitest'
import {
  BREAKER_COOLDOWN_MS,
  BREAKER_THRESHOLD,
  IDENTIFY_TIMEOUT_MS,
  MAX_IDENTIFY_ATTEMPTS,
  RETRY_BACKOFF_MS,
  fromWireClip,
  identifyBaseUrlOk,
  identifyWithRetry,
  isTransportFailure,
  makeBreaker,
  makeIdentifyRun,
  postIdentify,
  sendIdentify,
  serverToLocalSec,
  toWireClip,
} from '../identifySend'
import { buildIdentifyRequest, type IdentifyAnswer } from '../identifyClient'
import { makeIdentifyQueue } from '../identifyQueue'
import type { ExtractedClip } from '../clipRecorder'

const cfg = { baseUrl: 'http://100.68.11.76:8099', token: 'secret-token' }
const job = { orderId: 'o1', roomId: 'r1', saleEpochSec: 1700000000, auctionStartEpochSec: 1699999970, prevBoundaryEpochSec: 1699999900 }
// Exactly what extract() returns for a request that landed mid-chunk: the bytes start 2 s BEFORE the
// requested start, and run past the requested end. These are NOT the window that was asked for.
const clip: ExtractedClip = { blob: new Blob(['audio-bytes']), startEpochSec: 1699999958, durationSec: 47, leadInSec: 2, truncated: false }
const REQUESTED = { startEpochSec: 1699999960, endEpochSec: 1700000003 }

const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const metaOf = (form: FormData) => JSON.parse(form.get('meta') as string) as Record<string, unknown>
const never = () => new Promise<never>(() => {})
const failedWith = (reason: string, retryable = true): IdentifyAnswer => ({ status: 'failed', reason, retryable })

describe('constants', () => {
  // Named, small numbers: these decide cost (attempts) and how long one sale can stall the queue.
  it('caps attempts at 3, backs off between them, and bounds each POST', () => {
    expect(MAX_IDENTIFY_ATTEMPTS).toBe(3)
    expect(RETRY_BACKOFF_MS).toEqual([2000, 5000])
    expect(RETRY_BACKOFF_MS.length).toBe(MAX_IDENTIFY_ATTEMPTS - 1)
    expect(IDENTIFY_TIMEOUT_MS).toBe(45_000)
  })
})

describe('the clip crosses IPC whole', () => {
  it('round-trips the bytes AND every field the clip carries about them', async () => {
    const wire = await toWireClip(clip)
    expect(wire.bytes).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(wire.bytes)).toBe('audio-bytes')
    const back = fromWireClip(wire)
    expect(back.startEpochSec).toBe(1699999958)
    expect(back.durationSec).toBe(47)
    expect(back.leadInSec).toBe(2)
    expect(back.truncated).toBe(false)
    expect(await back.blob.text()).toBe('audio-bytes')
  })

  it('keeps truncated true', async () => {
    expect(fromWireClip(await toWireClip({ ...clip, truncated: true, leadInSec: 0 })).truncated).toBe(true)
  })

  // The signature failure of this project: a confident answer about the wrong lot, from the requested
  // window sent over the clip's own bytes. Follow a clip all the way to the wire.
  it("sends the CLIP's own start and duration, never the requested window", async () => {
    const seen: FormData[] = []
    const fetchFake = (async (_u: string, init: { body: FormData }) => {
      seen.push(init.body)
      return jsonRes(200, { status: 'identified' })
    }) as unknown as typeof fetch
    const out = await sendIdentify({ job, clip: await toWireClip(clip), cfg, fetch: fetchFake, timeoutMs: 1000 })
    expect(out.status).toBe('identified')
    const meta = metaOf(seen[0]!)
    expect(meta.clipStartEpochSec).toBe(clip.startEpochSec)
    expect(meta.clipDurationSec).toBe(clip.durationSec)
    expect(meta.clipStartEpochSec).not.toBe(REQUESTED.startEpochSec)
    expect(meta.clipDurationSec).not.toBe(REQUESTED.endEpochSec - REQUESTED.startEpochSec)
    // and it is exactly what buildIdentifyRequest makes of the original clip
    expect(meta).toEqual(metaOf(buildIdentifyRequest(job, clip, cfg).form))
  })

  // A millisecond epoch would plan a window in the far future. It is refused before any network call
  // and is terminal: the same input fails the same way.
  it('refuses an epoch that is not in seconds without calling the network', async () => {
    const f = vi.fn()
    const out = await sendIdentify({ job: { ...job, saleEpochSec: 1_700_000_000_000 }, clip: await toWireClip(clip), cfg, fetch: f as unknown as typeof fetch, timeoutMs: 1000 })
    expect(out).toMatchObject({ status: 'failed', reason: 'bad_request_local', retryable: false })
    expect(f).not.toHaveBeenCalled()
  })

  it('sendIdentify holds the whole exchange to the timeout it is given', async () => {
    vi.useFakeTimers()
    try {
      let settled = false
      const f = (() => never()) as unknown as typeof fetch
      const p = sendIdentify({ job, clip: await toWireClip(clip), cfg, fetch: f, timeoutMs: 1000 }).then((o) => { settled = true; return o })
      await vi.advanceTimersByTimeAsync(999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      expect(await p).toMatchObject({ status: 'failed', reason: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('the wire type has no field a requested window could ride in', async () => {
    expect(Object.keys(await toWireClip(clip)).sort()).toEqual(['bytes', 'durationSec', 'leadInSec', 'startEpochSec', 'truncated'])
  })
})

describe('postIdentify', () => {
  const req = () => buildIdentifyRequest(job, clip, cfg)

  it('hands fetch a live signal: a real fetch refuses one that is already aborted', async () => {
    const f = (async (_u: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return jsonRes(200, { status: 'identified' })
    }) as unknown as typeof fetch
    expect((await postIdentify(req(), { fetch: f, timeoutMs: 1000 })).status).toBe('identified')
  })

  it('reads the server answer', async () => {
    const f = (async () => jsonRes(200, { status: 'identified', attempts: 2 })) as unknown as typeof fetch
    expect(await postIdentify(req(), { fetch: f, timeoutMs: 1000 })).toEqual({ status: 'identified', attempts: 2 })
  })

  it('sends the request exactly as built: POST, the form, the Bearer header', async () => {
    const calls: Array<[string, RequestInit]> = []
    const f = (async (u: string, init: RequestInit) => { calls.push([u, init]); return jsonRes(200, { status: 'identified' }) }) as unknown as typeof fetch
    const r = req()
    await postIdentify(r, { fetch: f, timeoutMs: 1000 })
    expect(calls[0]![0]).toBe(r.url)
    expect(calls[0]![1].method).toBe('POST')
    expect(calls[0]![1].body).toBe(r.form)
    expect(calls[0]![1].headers).toEqual({ Authorization: 'Bearer secret-token' })
  })

  // HARD REQUIREMENT 1. A hung network call must FAIL, not strand the queue behind it.
  it('fails with a retryable timeout when the server never answers, and aborts the request', async () => {
    let signal: AbortSignal | undefined
    const f = ((_u: string, init: RequestInit) => { signal = init.signal as AbortSignal; return never() }) as unknown as typeof fetch
    const t0 = Date.now()
    const out = await postIdentify(req(), { fetch: f, timeoutMs: 30 })
    expect(out).toEqual({ status: 'failed', reason: 'timeout', retryable: true })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25)
    expect(signal?.aborted).toBe(true)
  })

  // The deadline is EXACTLY timeoutMs: not later (a stretched bound strands the queue longer) and
  // not earlier (a slow-but-working server would be cut off and retried, and a retry can bill).
  it('fires at the timeout and not before', async () => {
    vi.useFakeTimers()
    try {
      const f = (() => never()) as unknown as typeof fetch
      let settled = false
      const p = postIdentify(req(), { fetch: f, timeoutMs: 1000 }).then((o) => { settled = true; return o })
      await vi.advanceTimersByTimeAsync(999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      expect((await p).status).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('still times out when fetch ignores the abort signal entirely', async () => {
    const f = (() => never()) as unknown as typeof fetch
    expect((await postIdentify(req(), { fetch: f, timeoutMs: 20 })).status).toBe('failed')
  })

  it('times out a server that sends headers and then stalls the body', async () => {
    const stalled = { status: 200, json: () => never() } as unknown as Response
    const f = (async () => stalled) as unknown as typeof fetch
    expect(await postIdentify(req(), { fetch: f, timeoutMs: 20 })).toMatchObject({ status: 'failed', reason: 'timeout' })
  })

  it('does not time out an answer that arrives in time, and leaves no timer behind', async () => {
    vi.useFakeTimers()
    try {
      const f = (async () => jsonRes(200, { status: 'identified' })) as unknown as typeof fetch
      const p = postIdentify(req(), { fetch: f, timeoutMs: 1000 })
      await vi.advanceTimersByTimeAsync(0)
      expect((await p).status).toBe('identified')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('turns an unreachable worker into a retryable failure instead of a throw', async () => {
    const f = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const out = await postIdentify(req(), { fetch: f, timeoutMs: 1000 })
    expect(out).toMatchObject({ status: 'failed', reason: 'network_error', retryable: true })
    expect(out).toHaveProperty('detail', 'TypeError') // class only, so an operator can tell what broke
  })

  it('reports a system error code from the cause, never its message', async () => {
    const f = (async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED', message: 'to 100.68.11.76' } }) }) as unknown as typeof fetch
    expect(await postIdentify(req(), { fetch: f, timeoutMs: 1000 })).toHaveProperty('detail', 'TypeError ECONNREFUSED')
  })

  it('treats a non-JSON body (a proxy page) as the HTTP status alone', async () => {
    const f = (async () => new Response('<html>bad gateway</html>', { status: 502 })) as unknown as typeof fetch
    expect(await postIdentify(req(), { fetch: f, timeoutMs: 1000 })).toMatchObject({ status: 'failed', reason: 'identification_failed' })
    const g = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    expect(await postIdentify(req(), { fetch: g, timeoutMs: 1000 })).toMatchObject({ status: 'failed', reason: 'bad_token', retryable: false })
  })

  it('never lets the token into a failure it reports', async () => {
    // A thrown message that echoes the header must not be handed on as-is.
    const f = (async () => { throw new Error('boom Bearer secret-token') }) as unknown as typeof fetch
    const out = await postIdentify(req(), { fetch: f, timeoutMs: 1000 })
    expect(JSON.stringify(out)).not.toContain('secret-token')
  })
})

describe('identifyWithRetry', () => {
  const run = (attempt: () => Promise<IdentifyAnswer>, over: Partial<Parameters<typeof identifyWithRetry>[1]> = {}) => {
    const sleeps: number[] = []
    const p = identifyWithRetry(attempt, {
      maxAttempts: 3,
      backoffMs: [10, 20],
      sleep: async (ms) => { sleeps.push(ms) },
      shouldContinue: () => true,
      ...over,
    })
    return { p, sleeps }
  }

  // HARD REQUIREMENT 2. Each retry can bill a Gemini call.
  it('stops after the cap even though every failure is retryable', async () => {
    const attempt = vi.fn(async () => failedWith('http_503'))
    const { p, sleeps } = run(attempt)
    const out = await p
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(out).toMatchObject({ status: 'failed', reason: 'http_503', tries: 3 })
    expect(sleeps).toEqual([10, 20]) // between attempts, never after the last
  })

  it('does not repeat a failure that repeating cannot fix', async () => {
    const attempt = vi.fn(async () => failedWith('bad_token', false))
    const out = await run(attempt).p
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(out.tries).toBe(1)
  })

  it('does not repeat a settled answer', async () => {
    for (const answer of [{ status: 'identified' }, { status: 'skipped', reason: 'no_speech' }] as IdentifyAnswer[]) {
      const attempt = vi.fn(async () => answer)
      const { p, sleeps } = run(attempt)
      expect((await p).status).toBe(answer.status)
      expect(attempt).toHaveBeenCalledTimes(1)
      expect(sleeps).toEqual([])
    }
  })

  it('returns the first success without using the rest of the budget', async () => {
    const answers: IdentifyAnswer[] = [failedWith('timeout'), { status: 'identified' }, failedWith('x')]
    let i = 0
    const attempt = vi.fn(async () => answers[i++]!)
    const out = await run(attempt).p
    expect(out).toMatchObject({ status: 'identified', tries: 2 })
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('retries a thrown attempt (the network was unreachable) and reports it as failed', async () => {
    const attempt = vi.fn(async (): Promise<IdentifyAnswer> => { throw new Error('ipc closed') })
    const out = await run(attempt).p
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(out).toMatchObject({ status: 'failed', tries: 3 })
  })

  it('stops retrying when the show has ended, and does not sleep first', async () => {
    const attempt = vi.fn(async () => failedWith('timeout'))
    const { p, sleeps } = run(attempt, { shouldContinue: () => false })
    const out = await p
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(sleeps).toEqual([])
    expect(out).toMatchObject({ status: 'failed', tries: 1 })
  })

  it('re-checks after the backoff, because the show can end while it sleeps', async () => {
    let live = true
    const attempt = vi.fn(async () => failedWith('timeout'))
    const { p } = run(attempt, { sleep: async () => { live = false }, shouldContinue: () => live })
    await p
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('reuses the last backoff when the list is shorter than the retries', async () => {
    const { p, sleeps } = run(async () => failedWith('t'), { maxAttempts: 4, backoffMs: [7] })
    await p
    expect(sleeps).toEqual([7, 7, 7])
  })

  it.each([0, -1, 1.5, NaN])('refuses a cap of %s', async (n) => {
    await expect(
      identifyWithRetry(async () => ({ status: 'identified' }), { maxAttempts: n, backoffMs: [], sleep: async () => {}, shouldContinue: () => true }),
    ).rejects.toThrow(RangeError)
  })

  it('waits nothing when no backoff is configured', async () => {
    const { p, sleeps } = run(async () => failedWith('t'), { backoffMs: [] })
    await p
    expect(sleeps).toEqual([0, 0])
  })

  it('tells the attempt which try it is', async () => {
    const seen: number[] = []
    await run(async (n?: number) => { seen.push(n ?? -1); return failedWith('t') }).p
    expect(seen).toEqual([1, 2, 3])
  })

  it('a cap of 1 means no retry at all', async () => {
    const attempt = vi.fn(async () => failedWith('t'))
    await run(attempt, { maxAttempts: 1 }).p
    expect(attempt).toHaveBeenCalledTimes(1)
  })
})

describe('makeIdentifyRun in a queue', () => {
  type J = { orderId: string }
  const sleep = async () => {}

  // The reason requirement 1 exists: at concurrency 1 a run that never resolves strands every later sale.
  it('an unreachable worker fails each sale and the queue keeps moving', async () => {
    const hang = (() => never()) as unknown as typeof fetch
    const send = (j: J) => postIdentify(buildIdentifyRequest({ ...job, orderId: j.orderId }, clip, cfg), { fetch: hang, timeoutMs: 5 })
    const settled: Array<[string, string, string | undefined]> = []
    const q = makeIdentifyQueue<J, IdentifyAnswer>({
      run: makeIdentifyRun<J>({ send, maxAttempts: 3, backoffMs: [1, 1], sleep, shouldContinue: () => true }),
      onSettled: (j, o) => settled.push([j.orderId, o.status, o.reason]),
    })
    q.enqueue({ orderId: 'a' })
    q.enqueue({ orderId: 'b' })
    await q.drain()
    expect(settled).toEqual([['a', 'failed', 'timeout'], ['b', 'failed', 'timeout']])
  })

  it('calls the send exactly the cap per failing sale', async () => {
    const send = vi.fn(async () => failedWith('http_503'))
    const q = makeIdentifyQueue<J, IdentifyAnswer>({
      run: makeIdentifyRun<J>({ send, maxAttempts: 3, backoffMs: [1, 1], sleep, shouldContinue: () => true }),
      onSettled: () => {},
    })
    q.enqueue({ orderId: 'a' })
    await q.drain()
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('backstops a send that itself never settles (an IPC that never answers)', async () => {
    const send = vi.fn(() => never())
    const settled: string[] = []
    const q = makeIdentifyQueue<J, IdentifyAnswer>({
      run: makeIdentifyRun<J>({ send, maxAttempts: 2, backoffMs: [1], sleep, shouldContinue: () => true, backstopMs: 10 }),
      onSettled: (_j, o) => settled.push(`${o.status}:${o.reason}`),
    })
    q.enqueue({ orderId: 'a' })
    await q.drain()
    expect(settled).toEqual(['failed:timeout'])
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('sleeps the configured backoff between sends', async () => {
    const sleeps: number[] = []
    await makeIdentifyRun<J>({
      send: async () => failedWith('t'), maxAttempts: 3, backoffMs: [11, 22],
      sleep: async (ms) => { sleeps.push(ms) }, shouldContinue: () => true,
    })({ orderId: 'a' })
    expect(sleeps).toEqual([11, 22])
  })

  it('numbers each send 1, 2, 3', async () => {
    const send = vi.fn(async () => failedWith('t'))
    await makeIdentifyRun<J>({ send, maxAttempts: 3, backoffMs: [], sleep, shouldContinue: () => true })({ orderId: 'a' })
    expect(send.mock.calls.map((c) => (c as unknown[])[1])).toEqual([1, 2, 3])
  })

  // The default backstop is the POST's own deadline plus a margin for the IPC hop: neither a hair
  // past the deadline (it would cut off a slow-but-working POST) nor so long it protects nothing.
  it('by default gives a send the POST deadline plus ten seconds', async () => {
    vi.useFakeTimers()
    try {
      let settled = false
      const run = makeIdentifyRun<J>({ send: () => never(), maxAttempts: 1, backoffMs: [], sleep, shouldContinue: () => true })
      const p = run({ orderId: 'a' }).then((o) => { settled = true; return o })
      await vi.advanceTimersByTimeAsync(IDENTIFY_TIMEOUT_MS + 9_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      expect(await p).toMatchObject({ status: 'failed', reason: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves no backstop timer behind once a send answers', async () => {
    vi.useFakeTimers()
    try {
      const run = makeIdentifyRun<J>({ send: async () => ({ status: 'identified' }), maxAttempts: 1, backoffMs: [], sleep, shouldContinue: () => true })
      await run({ orderId: 'a' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes the job and the attempt number to send', async () => {
    const send = vi.fn(async (_j: J, _n: number) => ({ status: 'identified' }) as IdentifyAnswer)
    await makeIdentifyRun<J>({ send, maxAttempts: 3, backoffMs: [], sleep, shouldContinue: () => true })({ orderId: 'zz' })
    expect(send).toHaveBeenCalledWith({ orderId: 'zz' }, 1)
  })

  it('hands the job to shouldContinue, so one show ending does not stop another show retries', async () => {
    const send = vi.fn(async () => failedWith('t'))
    const seen: string[] = []
    await makeIdentifyRun<J>({
      send, maxAttempts: 3, backoffMs: [1, 1], sleep,
      shouldContinue: (j) => { seen.push(j.orderId); return false },
    })({ orderId: 'q' })
    expect(seen).toEqual(['q'])
  })
})

describe('serverToLocalSec', () => {
  // order_create_time is the SERVER's clock; the clip is stamped by this machine's. serverNow = clientNow + offset.
  it('moves a server millisecond time onto the local clock, in seconds', () => {
    expect(serverToLocalSec(1_700_000_000_000, 0)).toBe(1_700_000_000)
    expect(serverToLocalSec(1_700_000_005_000, 5000)).toBe(1_700_000_000)
    expect(serverToLocalSec(1_700_000_000_000, -2500)).toBe(1_700_000_002.5)
  })
  it('treats a missing offset as none', () => {
    expect(serverToLocalSec(1_700_000_000_000, undefined)).toBe(1_700_000_000)
  })
})

describe('identifyBaseUrlOk', () => {
  // A capture token goes to this address, so cleartext is only for places a passive observer is not.
  it.each([
    'http://100.68.11.76:8099', // the worker, over the tailnet (WireGuard)
    'http://100.64.0.1', 'http://100.127.255.254:1',
    'http://localhost:8099', 'http://127.0.0.1:8099',
    'https://hq.luxesenseedit.com',
  ])('accepts %s', (u) => expect(identifyBaseUrlOk(u)).toBe(true))
  it.each([
    'http://157.173.194.111:8099', // the same box on its PUBLIC address: cleartext over the internet
    'http://100.128.0.1', 'http://100.63.255.255', 'http://101.100.0.1', 'http://example.com',
    'http://a100.68.11.76', // text before the address
    'ftp://100.68.11.76', 'not a url', '', 'http://100.68.11.76.evil.com',
  ])('refuses %s', (u) => expect(identifyBaseUrlOk(u)).toBe(false))
})

describe('isTransportFailure', () => {
  it('is true for the worker being unreachable or not answering', () => {
    expect(isTransportFailure(failedWith('timeout'))).toBe(true)
    expect(isTransportFailure(failedWith('network_error'))).toBe(true)
  })
  // A 4xx / 5xx is a real answer from a reachable server: it must not open the breaker.
  it.each(['bad_token', 'http_503', 'live_identify_unavailable', 'identification_failed', 'audio_too_large', 'bad_request_local', 'worker_unreachable'])(
    'is false for the answer %s',
    (reason) => expect(isTransportFailure(failedWith(reason))).toBe(false),
  )
  it('is false for an answer that is not a failure', () => {
    expect(isTransportFailure({ status: 'identified' })).toBe(false)
    expect(isTransportFailure({ status: 'skipped', reason: 'timeout' })).toBe(false)
  })
})

describe('makeBreaker', () => {
  it('names its constants: two transport failures in a row, thirty seconds', () => {
    expect(BREAKER_THRESHOLD).toBe(2)
    expect(BREAKER_COOLDOWN_MS).toBe(30_000)
  })

  const setup = (over: { threshold?: number; cooldownMs?: number } = {}) => {
    let t = 1_000_000
    const breaker = makeBreaker({ threshold: 3, cooldownMs: 1000, now: () => t, ...over })
    return { breaker, advance: (ms: number) => { t += ms } }
  }
  const call = (b: ReturnType<typeof makeBreaker>, answer: IdentifyAnswer | (() => Promise<IdentifyAnswer>)) => {
    const send = vi.fn(typeof answer === 'function' ? answer : async () => answer)
    return { send, result: b.guard(send) }
  }

  it('passes calls through while closed', async () => {
    const { breaker } = setup()
    const { send, result } = call(breaker, { status: 'identified' })
    expect(await result).toEqual({ status: 'identified' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(breaker.isOpen()).toBe(false)
  })

  it('opens after the threshold of consecutive transport failures, and then fails fast without calling', async () => {
    const { breaker } = setup()
    for (let i = 0; i < 3; i++) {
      expect(breaker.isOpen()).toBe(false)
      expect(await call(breaker, failedWith('timeout')).result).toMatchObject({ reason: 'timeout' })
    }
    expect(breaker.isOpen()).toBe(true)
    const { send, result } = call(breaker, { status: 'identified' })
    expect(await result).toEqual({ status: 'failed', reason: 'worker_unreachable', retryable: false })
    expect(send).not.toHaveBeenCalled()
  })

  it('one fewer than the threshold does not open it', async () => {
    const { breaker } = setup()
    await call(breaker, failedWith('timeout')).result
    await call(breaker, failedWith('network_error')).result
    expect(breaker.isOpen()).toBe(false)
  })

  it('does not count a real answer, and a real answer resets the run', async () => {
    const { breaker } = setup({ threshold: 2 })
    await call(breaker, failedWith('timeout')).result
    await call(breaker, failedWith('http_503')).result // reachable: resets
    await call(breaker, failedWith('timeout')).result
    expect(breaker.isOpen()).toBe(false)
    await call(breaker, failedWith('network_error')).result
    expect(breaker.isOpen()).toBe(true)
  })

  it('a success resets the run', async () => {
    const { breaker } = setup({ threshold: 2 })
    await call(breaker, failedWith('timeout')).result
    await call(breaker, { status: 'identified' }).result
    await call(breaker, failedWith('timeout')).result
    expect(breaker.isOpen()).toBe(false)
  })

  it('does not let a failure that never reached the network reset or count', async () => {
    const { breaker } = setup({ threshold: 2 })
    await call(breaker, failedWith('timeout')).result
    await call(breaker, failedWith('bad_request_local', false)).result // neutral
    await call(breaker, failedWith('timeout')).result
    expect(breaker.isOpen()).toBe(true)
  })

  it('counts a send that throws as a transport failure', async () => {
    const { breaker } = setup({ threshold: 2 })
    const boom = async (): Promise<IdentifyAnswer> => { throw new Error('ipc closed') }
    expect(await call(breaker, boom).result).toMatchObject({ status: 'failed', reason: 'network_error' })
    await call(breaker, boom).result
    expect(breaker.isOpen()).toBe(true)
  })

  it('stays open until the cooldown has fully elapsed, then lets exactly one probe through', async () => {
    const { breaker, advance } = setup({ threshold: 1, cooldownMs: 1000 })
    await call(breaker, failedWith('timeout')).result
    advance(999)
    expect(breaker.isOpen()).toBe(true)
    expect((await call(breaker, { status: 'identified' }).result)).toMatchObject({ reason: 'worker_unreachable' })
    advance(1)
    let release!: (a: IdentifyAnswer) => void
    const probe = call(breaker, () => new Promise<IdentifyAnswer>((r) => { release = r }))
    expect(probe.send).toHaveBeenCalledTimes(1)
    // while the probe is in flight everyone else still fails fast
    const other = call(breaker, { status: 'identified' })
    expect(await other.result).toMatchObject({ reason: 'worker_unreachable' })
    expect(other.send).not.toHaveBeenCalled()
    release({ status: 'identified' })
    expect(await probe.result).toEqual({ status: 'identified' })
    expect(breaker.isOpen()).toBe(false)
    expect((await call(breaker, { status: 'identified' }).result).status).toBe('identified') // closed again
  })

  it('a probe that fails reopens it for a full cooldown', async () => {
    const { breaker, advance } = setup({ threshold: 1, cooldownMs: 1000 })
    await call(breaker, failedWith('timeout')).result
    advance(1000)
    await call(breaker, failedWith('timeout')).result // the probe fails
    expect(breaker.isOpen()).toBe(true)
    advance(999)
    expect(breaker.isOpen()).toBe(true)
    const again = call(breaker, { status: 'identified' })
    expect(await again.result).toMatchObject({ reason: 'worker_unreachable' })
    expect(again.send).not.toHaveBeenCalled()
    advance(1)
    expect((await call(breaker, { status: 'identified' }).result).status).toBe('identified')
  })

  it('a probe that gets a real answer (even a 4xx) closes it: the worker is reachable', async () => {
    const { breaker, advance } = setup({ threshold: 1, cooldownMs: 1000 })
    await call(breaker, failedWith('timeout')).result
    advance(1000)
    await call(breaker, failedWith('bad_token', false)).result
    expect(breaker.isOpen()).toBe(false)
  })

  it('a probe that never reached the network does not close it', async () => {
    const { breaker, advance } = setup({ threshold: 1, cooldownMs: 1000 })
    await call(breaker, failedWith('timeout')).result
    advance(1000)
    await call(breaker, failedWith('bad_request_local', false)).result
    expect(breaker.isOpen()).toBe(true)
  })

  it('reports closed to the retry loop as soon as the cooldown has elapsed, so a probe may go', async () => {
    const { breaker, advance } = setup({ threshold: 1, cooldownMs: 1000 })
    await call(breaker, failedWith('timeout')).result
    advance(1000)
    expect(breaker.isOpen()).toBe(false)
  })

  it('a call already in flight when the breaker opens does not push the cooldown back when it fails', async () => {
    const { breaker, advance } = setup({ threshold: 1, cooldownMs: 1000 })
    let failLate!: (a: IdentifyAnswer) => void
    const slow = call(breaker, () => new Promise<IdentifyAnswer>((r) => { failLate = r }))
    await call(breaker, failedWith('timeout')).result // opens it
    advance(500)
    failLate(failedWith('timeout'))
    await slow.result
    advance(500) // the cooldown is measured from the failure that opened it
    const probe = call(breaker, { status: 'identified' })
    expect((await probe.result).status).toBe('identified')
    expect(probe.send).toHaveBeenCalledTimes(1)
  })

  it('once a probe has closed it, calls behind it go through together rather than one at a time', async () => {
    const { breaker, advance } = setup({ threshold: 1, cooldownMs: 1000 })
    await call(breaker, failedWith('timeout')).result
    advance(1000)
    await call(breaker, { status: 'identified' }).result // the probe succeeds
    const releases: Array<(a: IdentifyAnswer) => void> = []
    const first = call(breaker, () => new Promise<IdentifyAnswer>((r) => releases.push(r)))
    const second = call(breaker, () => new Promise<IdentifyAnswer>((r) => releases.push(r)))
    expect(first.send).toHaveBeenCalledTimes(1)
    expect(second.send).toHaveBeenCalledTimes(1)
    releases.forEach((r) => r({ status: 'identified' }))
    await Promise.all([first.result, second.result])
  })

  it('a fast failure is not itself counted, and does not push the cooldown back', async () => {
    const { breaker, advance } = setup({ threshold: 1, cooldownMs: 1000 })
    await call(breaker, failedWith('timeout')).result
    advance(500)
    await call(breaker, { status: 'identified' }).result // fast-failed, not called
    advance(500) // cooldown measured from the failure, not from the fast failure
    expect((await call(breaker, { status: 'identified' }).result).status).toBe('identified')
  })
})

describe('an outage costs one fast failure per sale', () => {
  type J = { orderId: string }
  const sleep = async () => {}
  const outage = () => {
    let t = 0
    const breaker = makeBreaker({ threshold: 2, cooldownMs: 30_000, now: () => t })
    const send = vi.fn(async (): Promise<IdentifyAnswer> => failedWith('timeout'))
    const run = makeIdentifyRun<J>({ send, maxAttempts: 3, backoffMs: [1, 1], sleep, shouldContinue: () => true, breaker })
    return { breaker, send, run, advance: (ms: number) => { t += ms } }
  }

  it('after the breaker opens, every later sale fails without touching the network', async () => {
    const { send, run } = outage()
    const settled: Array<[string, string | undefined, number]> = []
    const q = makeIdentifyQueue<J, IdentifyAnswer & { tries: number }>({ run, onSettled: (j, o) => settled.push([j.orderId, o.reason, (o as { tries?: number }).tries ?? 0]) })
    for (const id of ['a', 'b', 'c', 'd', 'e']) q.enqueue({ orderId: id })
    await q.drain()
    // the first sale spends the threshold (2 sends) finding out; it does NOT burn its third try
    expect(send).toHaveBeenCalledTimes(2)
    expect(settled).toEqual([
      ['a', 'timeout', 2],
      ['b', 'worker_unreachable', 1],
      ['c', 'worker_unreachable', 1],
      ['d', 'worker_unreachable', 1],
      ['e', 'worker_unreachable', 1],
    ])
  })

  it('recovers: after the cooldown one sale probes, and the sales behind it go through', async () => {
    const { send, run, advance } = outage()
    const settled: string[] = []
    const q = makeIdentifyQueue<J, IdentifyAnswer & { tries: number }>({ run, onSettled: (j, o) => settled.push(`${j.orderId}:${o.status}`) })
    q.enqueue({ orderId: 'a' })
    await q.drain()
    send.mockImplementation(async () => ({ status: 'identified' }) as IdentifyAnswer) // the worker is back
    q.enqueue({ orderId: 'b' })
    await q.drain()
    expect(settled).toEqual(['a:failed', 'b:failed']) // still inside the cooldown: fast failure
    advance(30_000)
    q.enqueue({ orderId: 'c' })
    q.enqueue({ orderId: 'd' })
    await q.drain()
    expect(settled).toEqual(['a:failed', 'b:failed', 'c:identified', 'd:identified'])
  })

  it('counts a hung IPC send (the backstop) as a transport failure', async () => {
    const breaker = makeBreaker({ threshold: 2, cooldownMs: 30_000, now: () => 0 })
    const send = vi.fn(() => never())
    const run = makeIdentifyRun<J>({ send, maxAttempts: 3, backoffMs: [1, 1], sleep, shouldContinue: () => true, backstopMs: 5, breaker })
    const out = await run({ orderId: 'a' })
    expect(out).toMatchObject({ status: 'failed', reason: 'timeout', tries: 2 })
    expect(breaker.isOpen()).toBe(true)
  })

  it('does not spend a retry sleep once the breaker has opened', async () => {
    const sleeps: number[] = []
    const breaker = makeBreaker({ threshold: 1, cooldownMs: 30_000, now: () => 0 })
    const run = makeIdentifyRun<J>({
      send: async () => failedWith('timeout'), maxAttempts: 3, backoffMs: [1000, 1000],
      sleep: async (ms) => { sleeps.push(ms) }, shouldContinue: () => true, breaker,
    })
    expect(await run({ orderId: 'a' })).toMatchObject({ reason: 'timeout', tries: 1 })
    expect(sleeps).toEqual([])
  })
})
