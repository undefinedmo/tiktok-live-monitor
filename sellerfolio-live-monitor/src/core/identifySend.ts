// Sending a sale's clip to the identification endpoint, and what to do when that goes wrong.
// Pure: fetch, sleep and the clock are injected, so the hung-network and retry-cap behaviour is
// tested rather than hoped for. The main process owns the real fetch; the renderer owns the queue.
//
// THREE RULES this file exists to keep (each was a defect found in review of an earlier task):
//
// 1. EVERY POST ENDS. The queue guarantees one outcome per job only if `run` settles; at the default
//    concurrency a `run` that never does strands every later sale. `postIdentify` enforces its own
//    deadline over the WHOLE exchange (connect, headers AND body) and aborts the request.
// 2. RETRIES ARE CAPPED. Each retry can bill a Gemini call on the server. `isRetryable` says which
//    failures are worth repeating; MAX_IDENTIFY_ATTEMPTS says when to stop.
// 3. THE CLIP TRAVELS WHOLE. The clip store does not trim, so a clip's own `startEpochSec` /
//    `durationSec` describe its bytes and are what the server must be told. The IPC form has the
//    bytes and the clip's own fields and NOTHING ELSE; the ExtractedClip is rebuilt from exactly
//    those before `buildIdentifyRequest` reads it. There is no field a requested window could ride in.
import type { ExtractedClip } from './clipRecorder'
import {
  buildIdentifyRequest,
  isRetryable,
  readIdentifyResponse,
  type IdentifyAnswer,
  type IdentifyConfig,
  type IdentifyFailed,
  type IdentifyJob,
} from './identifyClient'

/**
 * How long ONE POST may take, end to end. The server answers in a few seconds normally; one request
 * may run up to its own three-rung window ladder (a model call per rung), so this is generous on
 * purpose -- a timeout that fires on a slow-but-working server is retried, and a retry can bill.
 */
export const IDENTIFY_TIMEOUT_MS = 45_000
/**
 * Total tries per sale, the first included: one try and two retries. Three because the failures
 * worth repeating (a worker restarting, a 503 before the Gemini key lands, an order row not synced
 * yet) clear in seconds if they clear at all, and each retry can cost a model call.
 */
export const MAX_IDENTIFY_ATTEMPTS = 3
/** Waits before retry 1 and retry 2. Short: the sale's lot is already behind the host. */
export const RETRY_BACKOFF_MS: readonly number[] = [2000, 5000]

/**
 * The circuit breaker: this many CONSECUTIVE transport failures (a timeout, or the worker not being
 * reachable at all) open it. Two, not more: each failure can cost the whole 45 s deadline, so the
 * first sale already pays for one, and a second in a row is not a blip a retry will fix.
 */
export const BREAKER_THRESHOLD = 2
/**
 * How long it stays open before ONE probe is let through. Thirty seconds: long enough that a down
 * worker is not hammered, short enough that a tailscale blip (or a worker restart) does not cost
 * more than a sale or two once it is back. Measured gaps between sales run 20 s and up.
 */
export const BREAKER_COOLDOWN_MS = 30_000

/** An ExtractedClip with the Blob flattened to bytes, which is what survives Electron IPC. */
export type WireClip = Omit<ExtractedClip, 'blob'> & { bytes: Uint8Array<ArrayBuffer> }

export async function toWireClip(clip: ExtractedClip): Promise<WireClip> {
  const { blob, ...own } = clip
  return { ...own, bytes: new Uint8Array(await blob.arrayBuffer()) }
}

export function fromWireClip(wire: WireClip): ExtractedClip {
  const { bytes, ...own } = wire
  return { ...own, blob: new Blob([bytes]) }
}

/** One sale's request: the job (boundaries, no clip window) and the clip EXACTLY as the store extracted it. */
export type IdentifyPayload = { job: IdentifyJob; clip: ExtractedClip }

/**
 * The payload as it crosses IPC. The job is passed through as it is, the clip goes through
 * `toWireClip`; nothing is added, replaced or recomputed here. That is the whole point of keeping it
 * this small and tested: it is the last place a clip's window could be swapped for another.
 */
export async function toWirePayload(p: IdentifyPayload): Promise<{ job: IdentifyJob; clip: WireClip }> {
  return { job: p.job, clip: await toWireClip(p.clip) }
}

/** The payload back from its IPC form (a clip kept on disk and read again): the job as it is, the clip rebuilt. */
export function fromWirePayload(w: { job: IdentifyJob; clip: WireClip }): IdentifyPayload {
  return { job: w.job, clip: fromWireClip(w.clip) }
}

const failed = (reason: string, retryable: boolean, detail?: string): IdentifyFailed =>
  detail === undefined ? { status: 'failed', reason, retryable } : { status: 'failed', reason, retryable, detail }

/** A stable, secret-free description of a thrown error: its class and any system code, never its message. */
function describeError(e: unknown): string {
  const name = e instanceof Error ? e.name : typeof e
  const cause = (e as { cause?: { code?: unknown } } | null)?.cause
  const code = typeof cause?.code === 'string' ? ` ${cause.code}` : ''
  return `${name}${code}`
}

/**
 * POST a built request and read the answer, within `timeoutMs` in total. Never throws, never hangs:
 * an unreachable or stalled worker comes back as a retryable `failed`. The deadline is a race
 * rather than only an AbortSignal, so a fetch that ignores the signal still cannot hold the queue.
 */
export async function postIdentify(
  req: { url: string; headers: Record<string, string>; form: FormData },
  opts: { fetch: typeof fetch; timeoutMs: number },
): Promise<IdentifyAnswer> {
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<IdentifyAnswer>((resolve) => {
    timer = setTimeout(() => {
      abort.abort()
      resolve(failed('timeout', true))
    }, opts.timeoutMs)
  })
  const exchange = (async (): Promise<IdentifyAnswer> => {
    try {
      const res = await opts.fetch(req.url, { method: 'POST', headers: req.headers, body: req.form, signal: abort.signal })
      let body: unknown = null
      try {
        body = await res.json()
      } catch {
        /* not JSON (a proxy's page): the status alone decides */
      }
      return readIdentifyResponse(res.status, body)
    } catch (e) {
      return failed('network_error', true, describeError(e))
    }
  })()
  try {
    return await Promise.race([exchange, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** The main-process side: rebuild the clip, build the request, POST it. */
export async function sendIdentify(args: {
  job: IdentifyJob
  clip: WireClip
  cfg: IdentifyConfig
  fetch: typeof fetch
  timeoutMs: number
}): Promise<IdentifyAnswer> {
  let req: ReturnType<typeof buildIdentifyRequest>
  try {
    req = buildIdentifyRequest(args.job, fromWireClip(args.clip), args.cfg)
  } catch (e) {
    // An epoch that is not in seconds. The same input fails the same way: no retry, no network.
    return failed('bad_request_local', false, e instanceof RangeError ? e.message : undefined)
  }
  return postIdentify(req, { fetch: args.fetch, timeoutMs: args.timeoutMs })
}

/**
 * Did the worker fail to ANSWER? A timeout or an unreachable address. A 4xx or 5xx is an answer from
 * a reachable server and is not a transport failure; neither is a failure raised before any network
 * call, nor the breaker's own fast failure.
 */
export function isTransportFailure(o: { status: string; reason?: string }): boolean {
  return o.status === 'failed' && (o.reason === 'timeout' || o.reason === 'network_error')
}

// Failures that say nothing about whether the worker is reachable. (The breaker's own fast failure
// never gets here: it returns before the call is classified.)
const NEUTRAL_REASONS = new Set(['bad_request_local', 'attempt_threw'])

export type Breaker = {
  /** Open and still cooling down: calls fail fast. False once a probe may go through. */
  isOpen: () => boolean
  /** Run `send` unless the breaker is open, in which case fail at once with `worker_unreachable`. */
  guard: (send: () => Promise<IdentifyAnswer>) => Promise<IdentifyAnswer>
}

/**
 * A circuit breaker around the POST. An outage then costs ONE fast failure per sale instead of the
 * full retry budget (3 x 45 s), which at the measured sale pace backs the queue up without end.
 * `threshold` consecutive transport failures open it; while open every call fails at once without
 * touching the network; after `cooldownMs` exactly one probe is let through while everyone else
 * still fails fast. A real answer of any kind (even a 4xx) from the probe closes it; a transport
 * failure reopens it for another full cooldown. A failure that never reached the network (bad local
 * request) neither counts nor closes. The fast failure is `retryable: false`, so a sale that hits it
 * ends there; Retry on the row sends it again once the worker is back.
 */
export function makeBreaker(opts: { threshold: number; cooldownMs: number; now: () => number }): Breaker {
  let consecutive = 0
  let openUntil: number | null = null // non-null: open (or half open, awaiting the probe)
  let probing = false
  const open = () => { openUntil = opts.now() + opts.cooldownMs }
  return {
    isOpen: () => openUntil !== null && opts.now() < openUntil,
    async guard(send) {
      let probe = false
      if (openUntil !== null) {
        if (opts.now() < openUntil || probing) return failed('worker_unreachable', false)
        probing = true
        probe = true
      }
      let out: IdentifyAnswer
      try {
        out = await send()
      } catch {
        out = failed('network_error', true)
      } finally {
        if (probe) probing = false
      }
      if (isTransportFailure(out)) {
        consecutive++
        if (probe || (openUntil === null && consecutive >= opts.threshold)) open()
      } else if (out.status === 'failed' && out.reason !== undefined && NEUTRAL_REASONS.has(out.reason)) {
        if (probe) open()
      } else {
        consecutive = 0
        openUntil = null
      }
      return out
    },
  }
}

export type RetryOptions = {
  /** Total tries, the first included. A positive integer. */
  maxAttempts: number
  /** Wait before retry n is `backoffMs[n-1]`, the last entry once the list runs out. */
  backoffMs: readonly number[]
  sleep: (ms: number) => Promise<void>
  /** False once nothing is waiting on the answer any more (the show ended): stop spending. */
  shouldContinue: () => boolean
}

/**
 * Try until settled, a failure that cannot be fixed, the cap, or `shouldContinue` says stop.
 * `attempt` should not throw; if it does that is a failed try (the transport was unreachable).
 * The result carries `tries`.
 */
export async function identifyWithRetry(
  attempt: (n: number) => Promise<IdentifyAnswer>,
  opts: RetryOptions,
): Promise<IdentifyAnswer & { tries: number }> {
  if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be a positive integer, got ${opts.maxAttempts}`)
  }
  for (let n = 1; ; n++) {
    let out: IdentifyAnswer
    try {
      out = await attempt(n)
    } catch (e) {
      out = { status: 'failed', reason: 'attempt_threw', detail: describeError(e) }
    }
    if (n >= opts.maxAttempts || !isRetryable(out) || !opts.shouldContinue()) return { ...out, tries: n }
    const wait = opts.backoffMs[Math.min(n - 1, opts.backoffMs.length - 1)] ?? 0
    await opts.sleep(wait)
    if (!opts.shouldContinue()) return { ...out, tries: n }
  }
}

/**
 * The queue's `run`: retry-capped, and each try is held to `backstopMs` in case the `send` itself
 * (an IPC round trip) never answers even though the POST behind it is bounded.
 */
export function makeIdentifyRun<J>(deps: {
  send: (job: J, attempt: number) => Promise<IdentifyAnswer>
  maxAttempts: number
  backoffMs: readonly number[]
  sleep: (ms: number) => Promise<void>
  shouldContinue: (job: J) => boolean
  /** Default: the POST's own deadline plus a margin for the IPC hop. */
  backstopMs?: number
  /** Fails fast while the worker is unreachable, and stops the retries that would only add to it. */
  breaker?: Breaker
}): (job: J) => Promise<IdentifyAnswer & { tries: number }> {
  const backstopMs = deps.backstopMs ?? IDENTIFY_TIMEOUT_MS + 10_000
  return (job) =>
    identifyWithRetry(
      (n) => {
        const attempt = () => {
          let timer: ReturnType<typeof setTimeout> | undefined
          const late = new Promise<IdentifyAnswer>((resolve) => {
            timer = setTimeout(() => resolve(failed('timeout', true)), backstopMs)
          })
          return Promise.race([deps.send(job, n), late]).finally(() => clearTimeout(timer))
        }
        // The breaker sees the raced result, so a hung IPC send counts as a transport failure too.
        return deps.breaker ? deps.breaker.guard(attempt) : attempt()
      },
      {
        maxAttempts: deps.maxAttempts,
        backoffMs: deps.backoffMs,
        sleep: deps.sleep,
        // Once the breaker has opened another try would only fail fast: stop, and spend no sleep.
        shouldContinue: () => deps.shouldContinue(job) && !deps.breaker?.isOpen(),
      },
    )
}

/**
 * A server millisecond timestamp (an order's create time) on THIS machine's clock, in seconds --
 * the clock the clip is stamped with. `offsetMs` is serverNow - clientNow, from pin/get.
 */
export function serverToLocalSec(serverMs: number, offsetMs: number | undefined): number {
  return (serverMs - (offsetMs ?? 0)) / 1000
}

/**
 * Whether a capture token may be sent to this address. https anywhere; cleartext only where a
 * passive observer is not: this machine, or the tailnet (100.64.0.0/10, WireGuard-encrypted), which
 * is where the worker is. The same box's public address is NOT on that list.
 */
export function identifyBaseUrlOk(baseUrl: string): boolean {
  let u: URL
  try {
    u = new URL(baseUrl)
  } catch {
    return false
  }
  if (u.protocol === 'https:') return true
  if (u.protocol !== 'http:') return false
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true
  const q = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(u.hostname)
  if (!q) return false
  const [a, b] = [Number(q[1]), Number(q[2])]
  return a === 100 && b >= 64 && b <= 127
}
