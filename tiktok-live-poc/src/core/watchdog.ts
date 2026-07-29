// Signal watchdog: turns silent degradation into a visible alert. The 2026-07-24
// failure mode — order rows flowing while every fast close signal was dead — was
// only noticed by missing physical labels. These checks make that class of failure
// (and stalled polls / printer trouble) announce itself within one check interval.
// Pure function — one instance of state lives in main, evaluated every ~15s.

export interface WatchdogState {
  now: number
  connected: boolean
  pollStartedAt?: number // undefined until the poll config was sent
  lastPinSampleAt?: number // last pin/get response seen (undefined = none yet)
  lastImFrameAt?: number // last webcast/im/fetch frame seen (undefined = none yet)
  salesSinceLastClose: number // NEW order rows since the last fast close signal
  printErrorsRecent: number // failed label jobs in the last ~5 min
}

export interface WatchdogAlert {
  code: 'fast-signals-quiet' | 'pin-stalled' | 'im-stalled' | 'printer-errors'
  message: string
}

const STARTUP_GRACE_MS = 30000
const PIN_STALL_MS = 30000 // pin polls every 700ms — 30s silent means the loop is dead
const IM_STALL_MS = 120000 // chat rides im ~1s; 2min silent means the stream is dead
const SALES_WITHOUT_CLOSE = 3 // labels still print via order rows, but slower — warn

export function evaluateWatchdog(s: WatchdogState): WatchdogAlert[] {
  const out: WatchdogAlert[] = []
  if (!s.connected || !s.pollStartedAt || s.now - s.pollStartedAt < STARTUP_GRACE_MS) return out

  if (s.salesSinceLastClose >= SALES_WITHOUT_CLOSE)
    out.push({
      code: 'fast-signals-quiet',
      message: `${s.salesSinceLastClose} sales without a fast close signal — labels riding the slower order path`,
    })
  if (s.lastPinSampleAt !== undefined && s.now - s.lastPinSampleAt > PIN_STALL_MS)
    out.push({ code: 'pin-stalled', message: `pin poll silent ${Math.round((s.now - s.lastPinSampleAt) / 1000)}s` })
  if (s.lastImFrameAt !== undefined && s.now - s.lastImFrameAt > IM_STALL_MS)
    out.push({ code: 'im-stalled', message: `im stream silent ${Math.round((s.now - s.lastImFrameAt) / 1000)}s` })
  if (s.printErrorsRecent >= 2)
    out.push({ code: 'printer-errors', message: `${s.printErrorsRecent} label print failures in the last 5 min` })
  return out
}
