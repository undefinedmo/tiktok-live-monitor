// The identification queue. It replaces the `transcribing` boolean, which silently discarded any
// sale that arrived while another was being identified -- on a measured show 41% of inter-sale gaps
// were under 20s, so a large share of lots vanished with no log and no record.
//
// The contract: EVERY job that is enqueued gets EXACTLY ONE `onSettled` call --
//   * `run` resolves          -> that outcome
//   * `run` throws / rejects  -> { status: 'failed', reason }
//   * abandonAll() while the job is queued or in flight -> { status: 'abandoned', reason }
// A job is never dropped, never settled twice, and a late result from an abandoned job is ignored.

export type Job = { orderId: string }

/** What `run` reports. Extra fields ride along untouched. */
export type Outcome = { status: string; reason?: string }

/** The two outcomes the queue itself manufactures, when `run` cannot. */
export type QueueOutcome = { status: 'failed' | 'abandoned'; reason: string }

export type IdentifyQueueOptions<J extends Job, O extends Outcome> = {
  run: (job: J) => Promise<O>
  onSettled: (job: J, outcome: Outcome & (O | QueueOutcome)) => void
  /** How many jobs may run at once. Default 1; must be a positive integer. */
  concurrency?: number
}

export type IdentifyQueue<J extends Job> = {
  /**
   * Queue a job. A job whose `orderId` is already queued or running is IGNORED -- a duplicate sale
   * event is the same sale, and settling it a second time would hand downstream two outcomes for one
   * order (the later one could overwrite the real result). Once a job has settled, the same
   * `orderId` may be enqueued again: that is a deliberate retry, not a duplicate.
   */
  enqueue(job: J): void
  /** Jobs not yet settled: waiting plus running. */
  size(): number
  /** Resolves once nothing is waiting or running. Resolves immediately when already idle. */
  drain(): Promise<void>
  /** Settle everything waiting or running as abandoned and empty the queue (the show ended). */
  abandonAll(reason: string): void
}

type Entry<J extends Job> = { job: J; settled: boolean }

export function makeIdentifyQueue<J extends Job, O extends Outcome = Outcome>(
  opts: IdentifyQueueOptions<J, O>,
): IdentifyQueue<J> {
  const concurrency = opts.concurrency ?? 1
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`)
  }

  const waiting: Entry<J>[] = []
  const running = new Set<Entry<J>>()
  let idleWaiters: Array<() => void> = []

  const notifyIfIdle = () => {
    if (waiting.length > 0 || running.size > 0) return
    const ws = idleWaiters
    idleWaiters = []
    for (const w of ws) w()
  }

  // The single place a job settles. The `settled` flag is what makes "exactly once" hold when an
  // abandoned job's `run` finally resolves or rejects after the fact.
  const settle = (entry: Entry<J>, outcome: O | QueueOutcome) => {
    if (entry.settled) return
    entry.settled = true
    running.delete(entry)
    try {
      opts.onSettled(entry.job, outcome)
    } catch {
      // A throwing consumer must not stall the queue behind it; the job has settled regardless.
    }
  }

  const pump = () => {
    while (running.size < concurrency) {
      const entry = waiting.shift()
      if (!entry) break
      running.add(entry)
      start(entry)
    }
    notifyIfIdle()
  }

  const start = (entry: Entry<J>) => {
    // `run` may throw synchronously or reject; both become a failed outcome.
    let p: Promise<O>
    try {
      p = Promise.resolve(opts.run(entry.job))
    } catch (e) {
      p = Promise.reject(e)
    }
    p.then(
      (outcome) => settle(entry, outcome),
      (e) => settle(entry, { status: 'failed', reason: e instanceof Error ? e.message : String(e) }),
    ).then(pump)
  }

  const has = (orderId: string) =>
    waiting.some((e) => e.job.orderId === orderId) ||
    [...running].some((e) => e.job.orderId === orderId)

  return {
    enqueue(job) {
      if (has(job.orderId)) return
      waiting.push({ job, settled: false })
      pump()
    },
    size: () => waiting.length + running.size,
    drain() {
      if (waiting.length === 0 && running.size === 0) return Promise.resolve()
      return new Promise<void>((resolve) => idleWaiters.push(resolve))
    },
    abandonAll(reason) {
      const doomed = [...running, ...waiting.splice(0)]
      for (const entry of doomed) settle(entry, { status: 'abandoned', reason })
      notifyIfIdle()
    },
  }
}
