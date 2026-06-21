import { describe, it, expect } from 'vitest'
import type { Sale } from '../types'
import {
  loadShows,
  upsertShow,
  listShows,
  salesForShow,
  type ShowStore,
} from '../shows'

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

describe('loadShows', () => {
  it('parses valid JSON into a store', () => {
    const store: ShowStore = {
      s1: { id: 's1', name: 'Show 1', startTime: 10, sales: [sale('o1')], updatedAt: 1000 },
    }
    const parsed = loadShows(JSON.stringify(store))
    expect(parsed).toEqual(store)
  })

  it('returns {} for null', () => {
    expect(loadShows(null)).toEqual({})
  })

  it('returns {} for malformed JSON', () => {
    expect(loadShows('not json {')).toEqual({})
  })

  it('returns {} for valid JSON that is not an object (e.g. an array)', () => {
    expect(loadShows('[1,2,3]')).toEqual({})
    expect(loadShows('42')).toEqual({})
    expect(loadShows('null')).toEqual({})
  })
})

describe('upsertShow', () => {
  it('inserts a new show with sales, name, startTime, and updatedAt', () => {
    const store: ShowStore = {}
    const next = upsertShow(store, { id: 's1', name: 'Show 1', startTime: 10 }, [sale('o1')], 5000)
    expect(next.s1).toEqual({
      id: 's1',
      name: 'Show 1',
      startTime: 10,
      sales: [sale('o1')],
      updatedAt: 5000,
    })
  })

  it('REPLACES the sales snapshot on re-upsert (does not append) and updates updatedAt', () => {
    let store: ShowStore = {}
    store = upsertShow(store, { id: 's1', name: 'Show 1', startTime: 10 }, [sale('o1'), sale('o2')], 5000)
    store = upsertShow(store, { id: 's1', name: 'Show 1', startTime: 10 }, [sale('o3')], 6000)
    expect(store.s1!.sales).toEqual([sale('o3')])
    expect(store.s1!.updatedAt).toBe(6000)
  })

  it('updates name and startTime on re-upsert', () => {
    let store: ShowStore = {}
    store = upsertShow(store, { id: 's1', name: 'Old', startTime: 10 }, [], 1)
    store = upsertShow(store, { id: 's1', name: 'New', startTime: 20 }, [], 2)
    expect(store.s1!.name).toBe('New')
    expect(store.s1!.startTime).toBe(20)
  })

  it('does not mutate the input store', () => {
    const store: ShowStore = {}
    const next = upsertShow(store, { id: 's1', name: 'Show 1', startTime: 10 }, [sale('o1')], 5000)
    expect(store).toEqual({})
    expect(next).not.toBe(store)
  })

  it('no-ops (returns equivalent store) when meta.id is empty', () => {
    const store: ShowStore = {
      s1: { id: 's1', name: 'Show 1', startTime: 10, sales: [sale('o1')], updatedAt: 1 },
    }
    const next = upsertShow(store, { id: '', name: 'Nope' }, [sale('x')], 9999)
    expect(next).toEqual(store)
  })
})

describe('listShows', () => {
  it('sorts by startTime desc, undefined startTime last, tie-break by name asc', () => {
    let store: ShowStore = {}
    store = upsertShow(store, { id: 'a', name: 'Alpha', startTime: 100 }, [], 1)
    store = upsertShow(store, { id: 'b', name: 'Bravo', startTime: 300 }, [], 1)
    store = upsertShow(store, { id: 'c', name: 'Charlie', startTime: 200 }, [], 1)
    store = upsertShow(store, { id: 'd', name: 'Zulu' }, [], 1) // no startTime
    store = upsertShow(store, { id: 'e', name: 'Mike' }, [], 1) // no startTime

    const list = listShows(store)
    expect(list.map((s) => s.id)).toEqual(['b', 'c', 'a', 'e', 'd'])
  })

  it('strips sales and updatedAt, returning ShowMeta[]', () => {
    let store: ShowStore = {}
    store = upsertShow(store, { id: 's1', name: 'Show 1', startTime: 10 }, [sale('o1')], 5000)
    const list = listShows(store)
    expect(list).toEqual([{ id: 's1', name: 'Show 1', startTime: 10 }])
  })

  it('returns [] for empty store', () => {
    expect(listShows({})).toEqual([])
  })
})

describe('salesForShow', () => {
  it("returns a single show's sales", () => {
    let store: ShowStore = {}
    store = upsertShow(store, { id: 's1', name: 'Show 1', startTime: 10 }, [sale('o1'), sale('o2')], 1)
    expect(salesForShow(store, 's1')).toEqual([sale('o1'), sale('o2')])
  })

  it("returns [] for an unknown id", () => {
    const store: ShowStore = {}
    expect(salesForShow(store, 'nope')).toEqual([])
  })

  it("'all' concatenates across shows in startTime-desc order", () => {
    let store: ShowStore = {}
    store = upsertShow(store, { id: 'a', name: 'Alpha', startTime: 100 }, [sale('a1'), sale('a2')], 1)
    store = upsertShow(store, { id: 'b', name: 'Bravo', startTime: 300 }, [sale('b1')], 1)
    store = upsertShow(store, { id: 'c', name: 'Charlie', startTime: 200 }, [sale('c1')], 1)

    // order: b (300), c (200), a (100), then sales as stored within each
    expect(salesForShow(store, 'all')).toEqual([sale('b1'), sale('c1'), sale('a1'), sale('a2')])
  })

  it("'all' returns [] for an empty store", () => {
    expect(salesForShow({}, 'all')).toEqual([])
  })
})
