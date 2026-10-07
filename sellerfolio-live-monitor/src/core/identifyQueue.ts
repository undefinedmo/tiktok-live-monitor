// The identification queue. It replaces the `transcribing` boolean, which silently discarded any
// sale that arrived while another was being identified -- on a measured show 41% of inter-sale gaps
// were under 20s, so a large share of lots vanished with no log and no record.
//
// The contract: EVERY job that is enqueued gets EXACTLY ONE `onSettled` call --
//   * `run` resolves          -> that outcome
//   * `run` throws / rejects  -> { status: 'failed', reason }
//   * abandonAll() while the job is still WAITING -> { status: 'abandoned', reason }
// A job is never dropped and never settled twice. A job already IN FLIGHT when abandonAll() runs is
// left alone and settles with its true outcome when `run` finishes: a real identification for a lot
// from the show that just ended is worth keeping, so it must not be discarded.

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
   * Returns true when the job was accepted, false when it was ignored as a duplicate.
   */
  enqueue(job: J): boolean
  /** Jobs waiting to start. A job already running is not counted. */
  size(): number
  /** Resolves once nothing is waiting or running. Resolves immediately when already idle. */
  drain(): Promise<void>
  /**
   * Settle every WAITING job as abandoned and empty the wait list (the show ended). Jobs already
   * running are not touched: each settles with its true outcome, exactly once, when `run` finishes.
   * `drain()` therefore still waits for them (and never resolves if a `run` never does).
   */
  abandonAll(reason: string): void
}

export function makeIdentifyQueue<J extends Job, O extends Outcome = Outcome>(
  opts: IdentifyQueueOptions<J, O>,
): IdentifyQueue<J> {
  const concurrency = opts.concurrency ?? 1
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`)
  }

  const waiting: J[] = []
  const running = new Set<J>()
  let idleWaiters: Array<() => void> = []

  const notifyIfIdle = () => {
    if (waiting.length > 0 || running.size > 0) return
    const ws = idleWaiters
    idleWaiters = []
    for (const w of ws) w()
  }

  // The single place a job settles. Each job reaches it once: a waiting job from abandonAll, a
  // running job from its own `run` promise (which settles one way only).
  const settle = (job: J, outcome: O | QueueOutcome) => {
    running.delete(job)
    try {
      opts.onSettled(job, outcome)
    } catch (e) {
      // A throwing consumer must not stall the queue behind it, but it must not vanish either: that
      // outcome would otherwise be lost without a trace.
      console.error(`[identifyQueue] onSettled threw for order ${job.orderId}:`, e)
    }
  }

  const pump = () => {
    while (running.size < concurrency) {
      const job = waiting.shift()
      if (!job) break
      running.add(job)
      start(job)
    }
    notifyIfIdle()
  }

  const start = (job: J) => {
    // `run` may throw synchronously or reject; both become a failed outcome.
    let p: Promise<O>
    try {
      p = Promise.resolve(opts.run(job))
    } catch (e) {
      p = Promise.reject(e)
    }
    p.then(
      (outcome) => settle(job, outcome),
      (e) => settle(job, { status: 'failed', reason: e instanceof Error ? e.message : String(e) }),
    ).then(pump)
  }

  const has = (orderId: string) =>
    waiting.some((j) => j.orderId === orderId) || [...running].some((j) => j.orderId === orderId)

  return {
    enqueue(job) {
      if (has(job.orderId)) return false
      waiting.push(job)
      pump()
      return true
    },
    size: () => waiting.length,
    drain() {
      if (waiting.length === 0 && running.size === 0) return Promise.resolve()
      return new Promise<void>((resolve) => idleWaiters.push(resolve))
    },
    abandonAll(reason) {
      for (const job of waiting.splice(0)) settle(job, { status: 'abandoned', reason })
    },
  }
}
