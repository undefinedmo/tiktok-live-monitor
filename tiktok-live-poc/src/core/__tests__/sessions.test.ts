import { describe, it, expect } from 'vitest'
import { clusterByTime, derivedShowId, deriveTitle, SESSION_GAP_MS, deriveShowsFromOrders } from '../sessions'
import type { Sale } from '../types'

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

function sale(orderId: string, overrides: Partial<Sale> = {}): Sale {
  return {
    orderId,
    buyer: { username: 'A' },
    productId: 'p',
    productName: 'X',
    skuDesc: '#1',
    price: { cents: 100, formatted: '$1' },
    paymentStatus: 'paid',
    createdAt: 1,
    ...overrides,
  }
}

describe('deriveShowsFromOrders', () => {
  it('groups orders by roomId and sorts shows by startMs desc', () => {
    const { shows, showIdByOrder } = deriveShowsFromOrders([
      sale('o1', { roomId: 'R1', createdAt: 100 }),
      sale('o2', { roomId: 'R1', createdAt: 200 }),
      sale('o3', { roomId: 'R2', createdAt: 300 }),
    ])
    expect(shows.map((s) => s.id)).toEqual(['R2', 'R1']) // R2 startMs 300, R1 startMs 100
    expect(shows.find((s) => s.id === 'R1')!.count).toBe(2)
    expect(showIdByOrder.get('o1')).toBe('R1')
    expect(showIdByOrder.get('o3')).toBe('R2')
  })

  it('time-gap clusters orders with no roomId into live-<sec> shows', () => {
    const { shows, showIdByOrder } = deriveShowsFromOrders([
      sale('a', { createdAt: 0 }),
      sale('b', { createdAt: 1000 }), // same session as a
      sale('c', { createdAt: SESSION_GAP_MS + 2000 }), // new session
    ])
    expect(shows).toHaveLength(2)
    expect(showIdByOrder.get('a')).toBe(showIdByOrder.get('b'))
    expect(showIdByOrder.get('a')).not.toBe(showIdByOrder.get('c'))
    expect(shows.every((s) => s.id.startsWith('live-'))).toBe(true)
  })

  it('handles a mix of room-id and no-room-id orders', () => {
    const { shows, showIdByOrder } = deriveShowsFromOrders([
      sale('o1', { roomId: 'R1', createdAt: 500 }),
      sale('o2', { createdAt: 100 }),
    ])
    expect(shows).toHaveLength(2)
    expect(showIdByOrder.get('o1')).toBe('R1')
    expect(showIdByOrder.get('o2')).toMatch(/^live-/)
  })

  it('titles every show by its derived date (the real liveTag is boilerplate, so it is ignored)', () => {
    const { shows } = deriveShowsFromOrders([
      sale('o1', { roomId: 'R1', liveTag: 'Order contains one or more items from LIVE streams by …', createdAt: 100 }),
      sale('o2', { roomId: 'R2', createdAt: 200 }),
    ])
    // liveTag must NOT leak into the title — both shows are titled "LIVE · <date>"
    expect(shows.find((s) => s.id === 'R1')!.title).toMatch(/^LIVE · /)
    expect(shows.find((s) => s.id === 'R2')!.title).toMatch(/^LIVE · /)
  })

  it('maps every order in showIdByOrder', () => {
    const { showIdByOrder } = deriveShowsFromOrders([
      sale('o1', { roomId: 'R1' }),
      sale('o2', { createdAt: 5 }),
    ])
    expect([...showIdByOrder.keys()].sort()).toEqual(['o1', 'o2'])
  })

  it('returns empty results for no orders', () => {
    expect(deriveShowsFromOrders([])).toEqual({ shows: [], showIdByOrder: new Map() })
  })
})
