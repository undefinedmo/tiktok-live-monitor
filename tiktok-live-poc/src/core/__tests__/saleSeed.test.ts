import { describe, expect, it } from 'vitest'
import { SaleSeed } from '../saleSeed'

const sale = (createdAt: number) => ({ createdAt })
/** What ingest() returns for a gated / empty body: no rows at all. */
const EMPTY = { newSales: [], recentSales: [] }

describe('SaleSeed', () => {
  it('prints nothing from the first batch — that is history, not live sales', () => {
    const s = new SaleSeed()
    const backlog = [sale(500), sale(400), sale(300)]
    expect(s.select({ newSales: backlog, recentSales: backlog })).toEqual([])
    expect(s.seeded).toBe(true)
  })

  it('prints only rows created after the waterline', () => {
    const s = new SaleSeed()
    const backlog = [sale(500), sale(400)]
    s.select({ newSales: backlog, recentSales: backlog })
    const next = [sale(600), sale(450)] // 450 predates the waterline: a backfilled old row
    expect(s.select({ newSales: next, recentSales: [sale(600), ...backlog] })).toEqual([sale(600)])
  })

  // ── the restart burst ─────────────────────────────────────────────────────
  // The waterline used to be taken from the first response of ANY kind. A gated or
  // first-poll-empty body reduces to a max createdAt of 0, and seeding 0 marks the whole
  // order history as newer than the waterline — so the next real response reprinted every
  // recent lot. Measured live: ~20 labels re-queued 14s after launch, 16 already printed
  // by the previous run. It fired on EVERY restart and read as a printer fault.
  describe('empty first response (verification gate / cold start)', () => {
    it('does not seed from an empty body', () => {
      const s = new SaleSeed()
      expect(s.select(EMPTY)).toEqual([])
      expect(s.seeded).toBe(false)
    })

    it('does not reprint the backlog when real data arrives after an empty body', () => {
      const s = new SaleSeed()
      s.select(EMPTY)
      s.select(EMPTY)
      s.select(EMPTY)
      const backlog = [sale(900), sale(800), sale(700)]
      // This is the batch that used to come out of the printer in one burst.
      expect(s.select({ newSales: backlog, recentSales: backlog })).toEqual([])
      expect(s.seeded).toBe(true)
    })

    it('still prints genuinely new sales once seeded that way', () => {
      const s = new SaleSeed()
      s.select(EMPTY)
      const backlog = [sale(900)]
      s.select({ newSales: backlog, recentSales: backlog })
      const fresh = [sale(1000)]
      expect(s.select({ newSales: fresh, recentSales: [sale(1000), sale(900)] })).toEqual(fresh)
    })

    it('survives a gate that arrives mid-session without re-seeding', () => {
      const s = new SaleSeed()
      const backlog = [sale(500)]
      s.select({ newSales: backlog, recentSales: backlog })
      s.select(EMPTY) // gate goes up; empty bodies for a while
      s.select(EMPTY)
      // Gate clears. Rows we already had must not reprint; only the genuinely new one does.
      const after = [sale(600)]
      expect(s.select({ newSales: after, recentSales: [sale(600), sale(500)] })).toEqual(after)
    })
  })

  it('ignores rows created exactly at the waterline', () => {
    const s = new SaleSeed()
    s.select({ newSales: [sale(500)], recentSales: [sale(500)] })
    expect(s.select({ newSales: [sale(500)], recentSales: [sale(500)] })).toEqual([])
  })
})
