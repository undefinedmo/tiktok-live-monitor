import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The renderer cannot be unit-tested (it is the DOM), so the hand-off from a sale to the server is
// assembled in core/identifyWiring and core/identifySend, where it IS tested. This guard keeps it
// there. It is a TEXT check, and says so: it cannot prove the renderer is right, only that the fields
// that decide WHICH AUDIO and WHICH WINDOW the server hears about are not named in it. A reviewer
// injected `clip: { ...wire, startEpochSec: prevBoundary ?? sale - 60 }` into the renderer, sending the
// previous lot's window as the clip's own start, and every test and tsc stayed green.
const renderer = readFileSync(fileURLToPath(new URL('../../renderer/renderer.ts', import.meta.url)), 'utf8')
// The one legitimate use: the local Gemini product capture, unrelated to identification.
const code = renderer
  .split('\n')
  .filter((l) => !l.includes('clipStore.extract({ startEpochSec: end - sec, endEpochSec: end })'))
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n')

describe('renderer hand-off to identification', () => {
  // Naming any of these means the renderer is building or editing what the server is told.
  it.each([
    'startEpochSec',
    'endEpochSec',
    'durationSec',
    'leadInSec',
    'prevBoundaryEpochSec',
    'auctionStartEpochSec',
    'saleEpochSec',
    'clipStartEpochSec',
    'clipDurationSec',
    'boundariesForSale',
    'clipRequestFor',
    'jobForSale',
    'toWireClip',
    'buildIdentifyRequest',
    'new Blob',
  ])('does not name %s', (token) => {
    expect(code).not.toContain(token)
  })

  it('has no spread or literal that could rewrite the payload on its way to the main process', () => {
    expect(code).not.toMatch(/identify\(\s*\{/) // api.identify is handed the whole payload, never a literal
    expect(code).toContain('api.identify(await toWirePayload(job.payload))')
  })

  it('goes through the tested functions', () => {
    expect(code).toContain('identifyPayloadFor(sale, boundaryEvents, clipStore)')
    expect(code).toContain('clipReadyEpochSec(sale.atEpochSec)')
    expect(code).toContain('isRecentSale(s.createdAt, Date.now(), serverTimeOffsetMs)')
  })

  // A second Retry on a lot that is still being identified must not leave its row on "Identifying…".
  it('keeps one job per lot and never strands a row', () => {
    expect(code).toContain("if (existing?.status === 'transcribing') return")
    expect(code).toContain("settleEntry(entry, { status: 'failed', reason: 'already_queued' })")
    expect(code).toContain("b.disabled = r.status === 'transcribing'")
    expect(code).not.toContain("entry.text = 'already being identified'")
  })

  it('no longer compares a local millisecond with a server one', () => {
    expect(code).not.toMatch(/Date\.now\(\)\s*-\s*s\.createdAt\s*<\s*60000/)
  })
})
