import { describe, it, expect } from 'vitest'
import { openDb, upsertOrders, getSnapshot, setCost, setTranscript, setPicked, getShows, setShows } from '../db'
import { mapTiktokOrder } from '../tiktok-orders'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const fixture = JSON.parse(readFileSync(join(__dirname, '../../../fixtures/order-list-sample.json'), 'utf8'))

describe('db: orders', () => {
  it('upserts an order and returns it in the snapshot as a Sale', () => {
    const db = openDb(':memory:')
    upsertOrders(db, [mapTiktokOrder(fixture)], 1000)
    const snap = getSnapshot(db)
    expect(snap.orders).toHaveLength(1)
    expect(snap.orders[0]!.orderId).toBe('577000000000000001')
    expect(snap.orders[0]!.productId).toBe('1729500000000000001')
    db.close()
  })

  it('upsert is idempotent (re-sync updates, never duplicates)', () => {
    const db = openDb(':memory:')
    upsertOrders(db, [mapTiktokOrder(fixture)], 1000)
    upsertOrders(db, [mapTiktokOrder(fixture)], 2000)
    const snap = getSnapshot(db)
    expect(snap.orders).toHaveLength(1)
    const items = db.prepare('SELECT COUNT(*) c FROM order_items').get() as { c: number }
    expect(items.c).toBe(1) // not duplicated
    db.close()
  })
})

describe('db: user-owned data', () => {
  it('sets and clears an order-level cost', () => {
    const db = openDb(':memory:')
    setCost(db, 'order', 'O1', 1234, 1)
    expect(getSnapshot(db).costs.O1).toBe(1234)
    setCost(db, 'order', 'O1', null, 2)
    expect(getSnapshot(db).costs.O1).toBeUndefined()
    db.close()
  })

  it('stores a product transcript and a pick and shows blob', () => {
    const db = openDb(':memory:')
    setTranscript(db, 'product', 'P1', { brand: 'Alo', item: 'Leggings' }, 1)
    setPicked(db, 'O9', true, 1)
    setShows(db, { s1: { name: 'Show 1' } })
    const snap = getSnapshot(db)
    expect(snap.productTx.P1!.brand).toBe('Alo')
    expect(snap.picked).toContain('O9')
    expect(getShows(db)).toEqual({ s1: { name: 'Show 1' } })
    db.close()
  })
})
