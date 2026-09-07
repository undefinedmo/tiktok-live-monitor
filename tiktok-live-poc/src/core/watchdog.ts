// Signal watchdog: turns silent degradation into a visible alert. The 2026-07-24
// failure mode — order rows flowing while every fast close signal was dead — was
// only noticed by missing physical labels. These checks make that class of failure
// (and stalled polls / printer trouble) announce itself within one check interval.
// Pure function — one instance of state lives in main, evaluated every ~15s.

export interface WatchdogState {
  now: number
  connected: boolean
  pollStartedAt?: number // undefined until the poll config was sent
  // Last pin/get RESPONSE (empty ones included — this measures the poll loop being alive,
  // not whether it carried a lot; an empty run is the verification gate, flagged below).
  lastPinSampleAt?: number
  lastImFrameAt?: number // last webcast/im/fetch frame seen (undefined = none yet)
  salesSinceLastClose: number // NEW order rows since the last fast close signal
  printErrorsRecent: number // failed label jobs in the last ~5 min
  /**
   * When a REST body last carried an actual payload (undefined = none ever). Deliberately
   * a timestamp of the last GOOD body rather than a count of consecutive empty ones: the
   * endpoints are polled at different rates and gate independently, so a counter that
   * lumped them together crossed its threshold on a run of empty roster/auction_result
   * bodies while pin was healthily returning 2KB — and the alert flapped fire/clear/fire
   * every 15s. If ANY endpoint is still returning data, we are not gated.
   */
  lastRestPayloadAt?: number
  /** When the first REST response of any kind arrived — the gate check needs a start line. */
  firstRestAt?: number
  /** GetPrinter Status word from the last dispatch/probe; 0 = ready, undefined = unknown. */
  printerStatus?: number
  /** Human-readable form of printerStatus, supplied by the caller. */
  printerStatusText?: string
  /** Jobs sitting on the device. */
  printerJobs?: number
}

export interface WatchdogAlert {
  code: 'fast-signals-quiet' | 'pin-stalled' | 'im-stalled' | 'printer-errors' | 'verification-gate' | 'printer-blocked' | 'printer-backlog'
  message: string
}

const STARTUP_GRACE_MS = 30000
const PIN_STALL_MS = 30000 // pin polls every 700ms — 30s silent means the loop is dead
const IM_STALL_MS = 120000 // chat rides im ~1s; 2min silent means the stream is dead
const SALES_WITHOUT_CLOSE = 3 // labels still print via order rows, but slower — warn
// TikTok answers EVERY endpoint with a bare {"code":0} while a verification puzzle waits
// in the monitor window. pin polls at 700ms and roster at 1.5s, so in a healthy show
// something carries a payload every couple of seconds; 45s with nothing from any endpoint
// is the gate, and is long enough to ride out an ordinary between-listings lull.
const REST_GATE_MS = 45000
const PRINTER_BACKLOG = 3 // labels dispatch one at a time; 3+ queued means the device is not draining

export function evaluateWatchdog(s: WatchdogState): WatchdogAlert[] {
  const out: WatchdogAlert[] = []

  // FIRST, and deliberately outside the connected/poll-started gate below. The verification
  // gate most often bites at bootstrap: live_room_info returns {"code":0}, so room/session
  // never arrive, so polling never starts — and a check that required pollStartedAt could
  // never fire in the one case it exists for. The streak only accumulates from real REST
  // responses, so a run of them already proves the monitor page is loaded and fetching.
  // Needs a start line: firstRestAt proves the monitor page is loaded and fetching, so a
  // silent app pre-load never trips this.
  if (s.firstRestAt !== undefined && s.now - (s.lastRestPayloadAt ?? s.firstRestAt) > REST_GATE_MS) {
    out.push({
      code: 'verification-gate',
      message: 'TikTok is asking for verification — solve the puzzle in the monitor window; no data or labels until you do',
    })
    // Everything else is a symptom of this one cause: while the gate is up EVERY poll
    // returns empty, so the stall rules fire too and bury the actionable message.
    return out
  }

  if (!s.connected || !s.pollStartedAt || s.now - s.pollStartedAt < STARTUP_GRACE_MS) return out

  if (s.salesSinceLastClose >= SALES_WITHOUT_CLOSE)
    out.push({
      code: 'fast-signals-quiet',
      message: `${s.salesSinceLastClose} sales without a fast close signal — labels riding the slower order path`,
    })
  // `undefined` means the signal has NEVER arrived, which used to be treated as healthy —
  // so a feed that was dead from the moment we connected never raised anything, and only a
  // feed that went quiet later did. Past the startup grace, never-arrived is the worse case.
  if (s.now - (s.lastPinSampleAt ?? s.pollStartedAt) > PIN_STALL_MS)
    out.push({
      code: 'pin-stalled',
      message: s.lastPinSampleAt === undefined
        ? 'pin poll has never returned data since connecting'
        : `pin poll silent ${Math.round((s.now - s.lastPinSampleAt) / 1000)}s`,
    })
  if (s.now - (s.lastImFrameAt ?? s.pollStartedAt) > IM_STALL_MS)
    out.push({
      code: 'im-stalled',
      message: s.lastImFrameAt === undefined
        ? 'im stream has never delivered a frame since connecting'
        : `im stream silent ${Math.round((s.now - s.lastImFrameAt) / 1000)}s`,
    })
  if (s.printErrorsRecent >= 2)
    out.push({ code: 'printer-errors', message: `${s.printErrorsRecent} label print failures in the last 5 min` })
  // The spooler accepting bytes is not the label appearing. These two are the difference:
  // a paused/paper-out device, or jobs stacking up on it, means labels are being swallowed
  // and will surface later in a burst. Previously invisible — printErrorsRecent only counts
  // outright dispatch failures, which a blocked-but-accepting printer never produces.
  if (s.printerStatus)
    out.push({ code: 'printer-blocked', message: `printer reports ${s.printerStatusText ?? `0x${s.printerStatus.toString(16)}`} — labels are queueing, not printing` })
  if ((s.printerJobs ?? 0) >= PRINTER_BACKLOG)
    out.push({ code: 'printer-backlog', message: `${s.printerJobs} labels queued on the printer — it is not keeping up` })
  return out
}
