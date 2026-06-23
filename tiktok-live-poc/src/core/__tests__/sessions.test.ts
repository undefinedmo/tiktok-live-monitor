import { describe, it, expect } from 'vitest'
import { clusterByTime, derivedShowId, deriveTitle, SESSION_GAP_MS } from '../sessions'

describe('clusterByTime', () => {
  it('groups items within the gap into one session', () => {
    const s = clusterByTime([{ id: 'a', t: 0 }, { id: 'b', t: 1000 }])
    expect(s).toHaveLength(1)
    expect(s[0]!.ids).toEqual(['a', 'b'])
    expect(s[0]!.startMs).toBe(0)
    expect(s[0]!.endMs).toBe(1000)
  })

  it('splits when the gap from the previous item exceeds the threshold', () => {
    const s = clusterByTime([{ id: 'a', t: 0 }, { id: 'b', t: SESSION_GAP_MS + 1 }])
    expect(s).toHaveLength(2)
  })

  it('keeps items exactly at the threshold in the same session (diff == gap, not > gap)', () => {
    const s = clusterByTime([{ id: 'a', t: 0 }, { id: 'b', t: SESSION_GAP_MS }])
    expect(s).toHaveLength(1)
  })

  it('sorts by time and drops non-finite timestamps', () => {
    const s = clusterByTime([{ id: 'b', t: 1000 }, { id: 'a', t: 0 }, { id: 'x', t: NaN }])
    expect(s).toHaveLength(1)
    expect(s[0]!.ids).toEqual(['a', 'b'])
  })
})

describe('derivedShowId', () => {
  it('is keyed on the start second (stable across sub-second re-runs)', () => {
    expect(derivedShowId(1718900000123)).toBe('live-1718900000')
    expect(derivedShowId(1718900000999)).toBe('live-1718900000')
  })
})

describe('deriveTitle', () => {
  it('renders a "LIVE · <date>" label', () => {
    expect(deriveTitle(1718900000000)).toMatch(/^LIVE · /)
  })
})
