import { describe, it, expect } from 'vitest'
import { evaluateWatchdog, type WatchdogState } from '../watchdog'

const base: WatchdogState = {
  now: 100000,
  connected: true,
  pollStartedAt: 40000, // 60s in — past startup grace
  lastPinSampleAt: 99500,
  lastImFrameAt: 99000,
  salesSinceLastClose: 0,
  printErrorsRecent: 0,
}

describe('evaluateWatchdog', () => {
  it('is silent when everything is healthy', () => {
    expect(evaluateWatchdog(base)).toEqual([])
  })

  it('stays silent before connect / poll start / during startup grace', () => {
    expect(evaluateWatchdog({ ...base, connected: false, salesSinceLastClose: 9 })).toEqual([])
    expect(evaluateWatchdog({ ...base, pollStartedAt: undefined, salesSinceLastClose: 9 })).toEqual([])
    expect(evaluateWatchdog({ ...base, pollStartedAt: 95000, salesSinceLastClose: 9 })).toEqual([])
  })

  it('flags sales flowing with no fast close signal (the 2026-07-24 failure)', () => {
    const alerts = evaluateWatchdog({ ...base, salesSinceLastClose: 3 })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.code).toBe('fast-signals-quiet')
  })

  it('flags a stalled pin poll after 30s of silence', () => {
    const alerts = evaluateWatchdog({ ...base, lastPinSampleAt: 100000 - 31000 })
    expect(alerts.map((a) => a.code)).toEqual(['pin-stalled'])
  })

  it('does not flag pin before any sample has ever arrived', () => {
    expect(evaluateWatchdog({ ...base, lastPinSampleAt: undefined })).toEqual([])
  })

  it('flags a stalled im stream only after 2 minutes', () => {
    expect(evaluateWatchdog({ ...base, lastImFrameAt: 100000 - 119000 })).toEqual([])
    expect(evaluateWatchdog({ ...base, lastImFrameAt: 100000 - 121000 }).map((a) => a.code)).toEqual(['im-stalled'])
  })

  it('flags repeated print failures', () => {
    expect(evaluateWatchdog({ ...base, printErrorsRecent: 2 }).map((a) => a.code)).toEqual(['printer-errors'])
  })

  it('stacks multiple alerts', () => {
    const alerts = evaluateWatchdog({ ...base, salesSinceLastClose: 5, lastPinSampleAt: 100000 - 60000, printErrorsRecent: 3 })
    expect(alerts.map((a) => a.code)).toEqual(['fast-signals-quiet', 'pin-stalled', 'printer-errors'])
  })
})
