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

  // This used to assert the opposite — that a never-arrived signal is not worth flagging.
  // That made the watchdog blind to the worst case: a feed dead from the moment we
  // connected raised nothing, while one that worked and then stopped raised an alert. The
  // startup grace already covers the legitimate "not yet" window; past it, silence since
  // connect IS the failure.
  it('flags pin that has never returned data, once past the startup grace', () => {
    const alerts = evaluateWatchdog({ ...base, lastPinSampleAt: undefined })
    expect(alerts.map((a) => a.code)).toEqual(['pin-stalled'])
    expect(alerts[0]!.message).toMatch(/never/)
  })

  it('still says nothing about a never-arrived signal inside the startup grace', () => {
    // pollStartedAt 10s ago — the poll may simply not have answered yet.
    expect(evaluateWatchdog({ ...base, pollStartedAt: base.now - 10000, lastPinSampleAt: undefined, lastImFrameAt: undefined })).toEqual([])
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

  // ── verification gate ─────────────────────────────────────────────────────
  // A run of bare {"code":0} bodies is TikTok asking for a puzzle. Cost a whole show's
  // diagnosis once: pin/roster/auction_result all returned empty, the lot cards sat blank,
  // the SALES card read 0, and nothing anywhere said why.
  describe('verification gate', () => {
    const gated = { firstRestAt: base.now - 600000, lastRestPayloadAt: base.now - 60000 }
    const healthy = { firstRestAt: base.now - 600000, lastRestPayloadAt: base.now - 2000 }

    it('flags REST bodies carrying no payload for 45s', () => {
      const alerts = evaluateWatchdog({ ...base, ...gated })
      expect(alerts.map((a) => a.code)).toEqual(['verification-gate'])
      expect(alerts[0]!.message).toMatch(/monitor window/)
    })

    it('tolerates a shorter lull', () => {
      expect(evaluateWatchdog({ ...base, firstRestAt: base.now - 600000, lastRestPayloadAt: base.now - 44000 })).toEqual([])
    })

    // Regression: a consecutive-empty COUNTER lumped every endpoint together, so a run of
    // empty roster/auction_result bodies crossed the threshold while pin was healthily
    // returning 2KB — the alert flapped fire/clear/fire every 15s against a live app.
    // If any endpoint is still delivering, we are not gated.
    it('does not fire while some endpoint is still returning data', () => {
      expect(evaluateWatchdog({ ...base, ...healthy })).toEqual([])
    })

    it('does not fire before any REST response has arrived', () => {
      expect(evaluateWatchdog({ ...base, firstRestAt: undefined, lastRestPayloadAt: undefined })).toEqual([])
    })

    // The gate usually bites at BOOTSTRAP: live_room_info returns {"code":0}, so room and
    // session never arrive, so polling never starts. A check sitting behind the
    // connected/pollStartedAt guard could never fire in the case it was written for —
    // confirmed against a live app that sat gated with the watchdog silent.
    it('fires before connect and before polling has started', () => {
      const alerts = evaluateWatchdog({
        ...base,
        connected: false,
        pollStartedAt: undefined,
        lastPinSampleAt: undefined,
        lastImFrameAt: undefined,
        lastRestPayloadAt: base.now - 60000, firstRestAt: base.now - 600000,
      })
      expect(alerts.map((a) => a.code)).toEqual(['verification-gate'])
    })

    it('still says nothing pre-connect when bodies are not empty', () => {
      expect(evaluateWatchdog({ ...base, connected: false, pollStartedAt: undefined, lastRestPayloadAt: base.now, firstRestAt: base.now - 600000 })).toEqual([])
    })

    it('suppresses the stall alerts it would otherwise cause', () => {
      // Every poll is empty during a gate, so pin/im look stalled too. One actionable
      // message beats three symptoms of the same cause.
      const alerts = evaluateWatchdog({
        ...base,
        lastRestPayloadAt: base.now - 60000, firstRestAt: base.now - 600000,
        lastPinSampleAt: base.now - 120000,
        lastImFrameAt: base.now - 300000,
        salesSinceLastClose: 9,
      })
      expect(alerts.map((a) => a.code)).toEqual(['verification-gate'])
    })
  })

  // ── printer state ─────────────────────────────────────────────────────────
  // "The spooler accepted the bytes" is not "the label came out". printErrorsRecent only
  // counts dispatch failures, which a paused-but-accepting printer never produces — so a
  // device swallowing labels and flushing them later was completely invisible.
  describe('printer state', () => {
    it('flags a blocking printer status', () => {
      const alerts = evaluateWatchdog({ ...base, printerBlocked: true, printerStatusText: 'paused' })
      expect(alerts.map((a) => a.code)).toEqual(['printer-blocked'])
      expect(alerts[0]!.message).toMatch(/paused/)
    })

    it('says nothing when the printer is ready', () => {
      expect(evaluateWatchdog({ ...base, printerBlocked: false, printerJobs: 0 })).toEqual([])
    })

    // A printer mid-job sets BUSY/PRINTING/PROCESSING in its status word. Alerting on
    // "status != 0" reported those as faults — and because two constants were transcribed
    // wrong (0x200/0x400 are BUSY and PRINTING, not OUT_OF_MEMORY and DOOR_OPEN), a
    // printing printer announced "door_open — labels are queueing". The caller now decides
    // via an explicit blocking mask.
    it('says nothing while the printer is merely busy or printing', () => {
      expect(evaluateWatchdog({ ...base, printerBlocked: false, printerStatusText: 'busy+printing' })).toEqual([])
    })

    it('flags a queue only once it has failed to drain across ticks', () => {
      // A burst of three sales legitimately queues three jobs for a moment.
      expect(evaluateWatchdog({ ...base, printerJobs: 3, printerBacklogTicks: 1 })).toEqual([])
      expect(evaluateWatchdog({ ...base, printerJobs: 3, printerBacklogTicks: 2 })).toEqual([])
      expect(evaluateWatchdog({ ...base, printerJobs: 3, printerBacklogTicks: 3 }).map((a) => a.code)).toEqual(['printer-backlog'])
      expect(evaluateWatchdog({ ...base, printerJobs: 2, printerBacklogTicks: 9 })).toEqual([])
    })
  })
})
