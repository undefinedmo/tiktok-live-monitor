import { describe, expect, it } from 'vitest'
import { makeIdentifyQueue } from '../identifyQueue'

// A promise the test settles by hand, so concurrency is observed rather than timed.
function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('makeIdentifyQueue', () => {
  // Production change that makes this fail: a `transcribing`-style guard that refuses enqueue
  // while a job is in flight (the original defect) -- b and c would never settle.
  it('runs every job even when they arrive together, and settles each exactly once', async () => {
    const settled: string[] = []
    const q = makeIdentifyQueue({
      run: async () => {
        await new Promise((r) => setTimeout(r, 5))
        return { status: 'identified' as const }
      },
      onSettled: (j) => settled.push(j.orderId),
    })
    q.enqueue({ orderId: 'a' })
    q.enqueue({ orderId: 'b' })
    q.enqueue({ orderId: 'c' })
    await q.drain()
    expect(settled.sort()).toEqual(['a', 'b', 'c']) // the old boolean dropped b and c
  })

  // Production change: no try/catch around run -- the rejection escapes, onSettled never fires.
  it('settles a job whose run throws, rather than losing it', async () => {
    const settled: Array<[string, string, string | undefined]> = []
    const q = makeIdentifyQueue({
      run: async () => {
        throw new Error('endpoint unreachable')
      },
      onSettled: (j, o) => settled.push([j.orderId, o.status, o.reason]),
    })
    q.enqueue({ orderId: 'a' })
    await q.drain()
    expect(settled).toEqual([['a', 'failed', 'endpoint unreachable']])
  })

  // Production change: abandonAll clears the arrays without calling onSettled.
  it('abandons what is queued or in flight when a show ends, settling each', async () => {
    const settled: Array<[string, string, string | undefined]> = []
    const q = makeIdentifyQueue({
      run: () => new Promise<{ status: string }>(() => {}),
      onSettled: (j, o) => settled.push([j.orderId, o.status, o.reason]),
    })
    q.enqueue({ orderId: 'a' }) // in flight, never finishes
    q.enqueue({ orderId: 'b' }) // still waiting behind it
    q.abandonAll('show ended')
    expect(q.size()).toBe(0)
    expect(settled).toEqual([
      ['a', 'abandoned', 'show ended'],
      ['b', 'abandoned', 'show ended'],
    ])
  })

  // Production change: enqueue starts a job only when nothing is running and otherwise returns
  // without queueing -- the same defect, written as an explicit in-flight scenario.
  it('holds a sale that arrives mid-flight and runs it once the first finishes', async () => {
    const gate = deferred<{ status: string }>()
    const started: string[] = []
    const settled: string[] = []
    const q = makeIdentifyQueue({
      run: (j) => {
        started.push(j.orderId)
        return j.orderId === 'a' ? gate.promise : Promise.resolve({ status: 'identified' })
      },
      onSettled: (j) => settled.push(j.orderId),
    })
    q.enqueue({ orderId: 'a' })
    q.enqueue({ orderId: 'b' }) // arrives while `a` is in flight
    expect(q.size()).toBe(2)
    expect(started).toEqual(['a'])
    gate.resolve({ status: 'identified' })
    await q.drain()
    expect(started).toEqual(['a', 'b'])
    expect(settled).toEqual(['a', 'b']) // FIFO
  })

  // Production change: waiting.shift() becomes pop() -- the newest sale would jump the line.
  it('runs waiting jobs in the order they were enqueued', async () => {
    const gate = deferred<{ status: string }>()
    const started: string[] = []
    const q = makeIdentifyQueue({
      run: (j) => {
        started.push(j.orderId)
        return j.orderId === 'a' ? gate.promise : Promise.resolve({ status: 'identified' })
      },
      onSettled: () => {},
    })
    for (const id of ['a', 'b', 'c', 'd']) q.enqueue({ orderId: id })
    gate.resolve({ status: 'identified' })
    await q.drain()
    expect(started).toEqual(['a', 'b', 'c', 'd'])
  })

  // Production change: pump ignores `concurrency` (starts everything), or drops the running check.
  it('never runs two jobs at once with the default concurrency of 1', async () => {
    let live = 0
    let peak = 0
    const q = makeIdentifyQueue({
      run: async () => {
        peak = Math.max(peak, ++live)
        await tick()
        live--
        return { status: 'identified' }
      },
      onSettled: () => {},
    })
    for (const id of ['a', 'b', 'c', 'd']) q.enqueue({ orderId: id })
    await q.drain()
    expect(peak).toBe(1)
  })

  // Production change: the limit is hard-coded to 1.
  it('runs up to `concurrency` jobs at once, and no more', async () => {
    let live = 0
    let peak = 0
    const gates = [deferred(), deferred(), deferred()]
    let n = 0
    const q = makeIdentifyQueue({
      concurrency: 2,
      run: async () => {
        const g = gates[n++]!
        peak = Math.max(peak, ++live)
        await g.promise
        live--
        return { status: 'identified' }
      },
      onSettled: () => {},
    })
    for (const id of ['a', 'b', 'c']) q.enqueue({ orderId: id })
    expect(n).toBe(2) // c waits
    gates[0]!.resolve()
    await tick()
    expect(n).toBe(3) // a freed a slot
    gates[1]!.resolve()
    gates[2]!.resolve()
    await q.drain()
    expect(peak).toBe(2)
  })

  it('rejects a concurrency that is not a positive integer', () => {
    const mk = (concurrency: number) =>
      makeIdentifyQueue({ run: async () => ({ status: 'x' }), onSettled: () => {}, concurrency })
    expect(() => mk(0)).toThrow(RangeError)
    expect(() => mk(1.5)).toThrow(RangeError)
    expect(() => mk(NaN)).toThrow(RangeError)
  })

  // Production change: drain resolves as soon as the waiting array is empty (ignores running), or
  // resolves immediately.
  it('drain does not resolve while a job is still running', async () => {
    const gate = deferred<{ status: string }>()
    const q = makeIdentifyQueue({ run: () => gate.promise, onSettled: () => {} })
    q.enqueue({ orderId: 'a' })
    let drained = false
    void q.drain().then(() => (drained = true))
    await tick()
    await tick()
    expect(drained).toBe(false)
    gate.resolve({ status: 'identified' })
    await tick()
    expect(drained).toBe(true)
  })

  // Production change: drain resolves before the LAST job's onSettled has run.
  it('drain resolves only after the last job has been settled', async () => {
    const settled: string[] = []
    const q = makeIdentifyQueue({
      run: async () => ({ status: 'identified' }),
      onSettled: (j) => settled.push(j.orderId),
    })
    q.enqueue({ orderId: 'a' })
    q.enqueue({ orderId: 'b' })
    await q.drain()
    expect(settled).toEqual(['a', 'b'])
    expect(q.size()).toBe(0)
  })

  it('drain resolves at once on an idle queue, and for every concurrent waiter', async () => {
    const gate = deferred<{ status: string }>()
    const q = makeIdentifyQueue({ run: () => gate.promise, onSettled: () => {} })
    await q.drain() // idle: must not hang
    q.enqueue({ orderId: 'a' })
    const both = Promise.all([q.drain(), q.drain()])
    gate.resolve({ status: 'identified' })
    await both
  })

  // Production change: abandonAll forgets to notify drain waiters, so a show-end hangs a drain().
  it('abandonAll releases a pending drain', async () => {
    const q = makeIdentifyQueue({ run: () => new Promise<{ status: string }>(() => {}), onSettled: () => {} })
    q.enqueue({ orderId: 'a' })
    const drained = q.drain()
    q.abandonAll('show ended')
    await drained
  })

  // Production change: settle() has no `settled` guard, so a late run result settles twice.
  it('settles an abandoned in-flight job once, even if its run finishes or fails later', async () => {
    const ok = deferred<{ status: string }>()
    const bad = deferred<{ status: string }>()
    const settled: Array<[string, string]> = []
    const q = makeIdentifyQueue({
      concurrency: 2,
      run: (j) => (j.orderId === 'ok' ? ok.promise : bad.promise),
      onSettled: (j, o) => settled.push([j.orderId, o.status]),
    })
    q.enqueue({ orderId: 'ok' })
    q.enqueue({ orderId: 'bad' })
    q.abandonAll('show ended')
    ok.resolve({ status: 'identified' }) // too late
    bad.reject(new Error('too late'))
    await tick()
    await tick()
    expect(settled).toEqual([
      ['ok', 'abandoned'],
      ['bad', 'abandoned'],
    ])
  })

  it('settles a job once when abandonAll is called after it has already settled', async () => {
    const settled: string[] = []
    const q = makeIdentifyQueue({
      run: async () => ({ status: 'identified' }),
      onSettled: (j) => settled.push(j.orderId),
    })
    q.enqueue({ orderId: 'a' })
    await q.drain()
    q.abandonAll('show ended')
    expect(settled).toEqual(['a'])
  })

  // Production change: abandonAll does not free the running slots, so a hung job from the last
  // show blocks the next show's first sale forever.
  it('does not leak into the next show: a new job runs after abandonAll and gets its own outcome', async () => {
    const hung = deferred<{ status: string }>()
    const settled: Array<[string, string]> = []
    const q = makeIdentifyQueue({
      run: (j) => (j.orderId === 'old' ? hung.promise : Promise.resolve({ status: 'identified' })),
      onSettled: (j, o) => settled.push([j.orderId, o.status]),
    })
    q.enqueue({ orderId: 'old' })
    q.abandonAll('show ended')
    q.enqueue({ orderId: 'new' })
    hung.resolve({ status: 'identified' }) // the old job's late answer must not touch `new`
    await q.drain()
    expect(settled).toEqual([
      ['old', 'abandoned'],
      ['new', 'identified'],
    ])
  })

  it('keeps going after a failure: later jobs still run', async () => {
    const settled: Array<[string, string]> = []
    const q = makeIdentifyQueue({
      run: async (j) => {
        if (j.orderId === 'a') throw new Error('boom')
        return { status: 'identified' }
      },
      onSettled: (j, o) => settled.push([j.orderId, o.status]),
    })
    q.enqueue({ orderId: 'a' })
    q.enqueue({ orderId: 'b' })
    await q.drain()
    expect(settled).toEqual([
      ['a', 'failed'],
      ['b', 'identified'],
    ])
  })

  it('maps a synchronous throw and a non-Error rejection to failed with a reason', async () => {
    const settled: Array<[string, string, string | undefined]> = []
    const q = makeIdentifyQueue({
      run: (j) => {
        if (j.orderId === 'sync') throw new Error('threw before returning a promise')
        return Promise.reject('plain string')
      },
      onSettled: (j, o) => settled.push([j.orderId, o.status, o.reason]),
    })
    q.enqueue({ orderId: 'sync' })
    q.enqueue({ orderId: 'str' })
    await q.drain()
    expect(settled).toEqual([
      ['sync', 'failed', 'threw before returning a promise'],
      ['str', 'failed', 'plain string'],
    ])
  })

  it('hands the outcome from run to onSettled untouched', async () => {
    const seen: unknown[] = []
    const outcome = { status: 'identified' as const, brand: 'Alo', confidence: 0.9 }
    const q = makeIdentifyQueue({ run: async () => outcome, onSettled: (_j, o) => seen.push(o) })
    q.enqueue({ orderId: 'a' })
    await q.drain()
    expect(seen[0]).toBe(outcome)
  })

  // Production change: no try/catch around onSettled, so one consumer bug wedges every later sale.
  it('survives an onSettled that throws', async () => {
    const settled: string[] = []
    const q = makeIdentifyQueue({
      run: async () => ({ status: 'identified' }),
      onSettled: (j) => {
        settled.push(j.orderId)
        if (j.orderId === 'a') throw new Error('consumer bug')
      },
    })
    q.enqueue({ orderId: 'a' })
    q.enqueue({ orderId: 'b' })
    await q.drain()
    expect(settled).toEqual(['a', 'b'])
  })

  // Duplicate-orderId decision: a duplicate of a queued or running job is ignored (one outcome per
  // order); once settled, the id may be enqueued again (a retry).
  it('ignores a duplicate orderId that is already running or already waiting', async () => {
    const gate = deferred<{ status: string }>()
    const started: string[] = []
    const settled: string[] = []
    const q = makeIdentifyQueue({
      run: (j) => {
        started.push(j.orderId)
        return gate.promise
      },
      onSettled: (j) => settled.push(j.orderId),
    })
    q.enqueue({ orderId: 'a' })
    q.enqueue({ orderId: 'a' }) // duplicate of the running job
    q.enqueue({ orderId: 'b' })
    q.enqueue({ orderId: 'b' }) // duplicate of a waiting job
    expect(q.size()).toBe(2)
    gate.resolve({ status: 'identified' })
    await q.drain()
    expect(started).toEqual(['a', 'b'])
    expect(settled).toEqual(['a', 'b'])
  })

  it('accepts an orderId again once its earlier job has settled (a retry, not a duplicate)', async () => {
    const settled: Array<[string, string]> = []
    let attempt = 0
    const q = makeIdentifyQueue({
      run: async () => {
        if (attempt++ === 0) throw new Error('endpoint unreachable')
        return { status: 'identified' }
      },
      onSettled: (j, o) => settled.push([j.orderId, o.status]),
    })
    q.enqueue({ orderId: 'a' })
    await q.drain()
    q.enqueue({ orderId: 'a' })
    await q.drain()
    expect(settled).toEqual([
      ['a', 'failed'],
      ['a', 'identified'],
    ])
  })
})
