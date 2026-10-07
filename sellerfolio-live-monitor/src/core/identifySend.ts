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
}): (job: J) => Promise<IdentifyAnswer & { tries: number }> {
  const backstopMs = deps.backstopMs ?? IDENTIFY_TIMEOUT_MS + 10_000
  return (job) =>
    identifyWithRetry(
      (n) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const late = new Promise<IdentifyAnswer>((resolve) => {
          timer = setTimeout(() => resolve(failed('timeout', true)), backstopMs)
        })
        return Promise.race([deps.send(job, n), late]).finally(() => clearTimeout(timer))
      },
      {
        maxAttempts: deps.maxAttempts,
        backoffMs: deps.backoffMs,
        sleep: deps.sleep,
        shouldContinue: () => deps.shouldContinue(job),
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
