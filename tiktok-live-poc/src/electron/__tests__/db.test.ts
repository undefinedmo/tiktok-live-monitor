import { describe, it, expect } from 'vitest'
import { openDb, upsertOrders, getSnapshot, setCost, setTranscript, setPicked, getShows, setShows, getShowNames, setShowNames, importLegacy, isMigrated, rekeyProductTemplates } from '../db'
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

  it('does not persist the address (PII) into sale_json', () => {
    const db = openDb(':memory:')
    upsertOrders(db, [mapTiktokOrder(fixture)], 1000)
    // the address must not be present in the stored blob...
    const row = db.prepare('SELECT sale_json FROM orders').get() as { sale_json: string }
    expect(row.sale_json).not.toContain('Austin')
    // ...but other detail fields survive
    const snap = getSnapshot(db)
    expect(snap.orders[0]!.detail?.address).toBeUndefined()
    expect(snap.orders[0]!.detail?.status).toBeDefined()
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
    setTranscript(db, 'product', 'P1', null, 2)
    expect(getSnapshot(db).productTx.P1).toBeUndefined()
    setPicked(db, 'O9', false, 2)
    expect(getSnapshot(db).picked).not.toContain('O9')
    db.close()
  })
})

describe('db: legacy migration + re-key', () => {
  it('imports localStorage blobs once and is idempotent', () => {
    const db = openDb(':memory:')
    const blob = { cost: { O1: 500 }, productCost: { 'Bin A - Alo Yoga': 2000 }, productTx: { 'Bin A - Alo Yoga': { brand: 'Alo' } }, picked: ['O1'], shows: { a: 1 } }
    expect(isMigrated(db)).toBe(false)
    importLegacy(db, blob, 1)
    importLegacy(db, blob, 2) // second call is a no-op
    expect(isMigrated(db)).toBe(true)
    const snap = getSnapshot(db)
    expect(snap.costs.O1).toBe(500)
    expect(snap.productCosts['Bin A - Alo Yoga']).toBe(2000)
    expect(snap.picked).toEqual(['O1'])
    db.close()
  })

  it('re-keys name-keyed product templates to product_id after a sync', () => {
    const db = openDb(':memory:')
    importLegacy(db, { productCost: { 'Bin A - Alo Yoga': 2000 }, productTx: { 'Bin A - Alo Yoga': { brand: 'Alo' } } }, 1)
    upsertOrders(db, [mapTiktokOrder(fixture)], 1) // order_items now maps "Bin A - Alo Yoga" -> 1729500000000000001
    rekeyProductTemplates(db, 2)
    const snap = getSnapshot(db)
    expect(snap.productCosts['1729500000000000001']).toBe(2000)
    expect(snap.productCosts['Bin A - Alo Yoga']).toBeUndefined()
    expect(snap.productTx['1729500000000000001']!.brand).toBe('Alo')

    // re-key is called after every sync — a repeat run must be a no-op
    rekeyProductTemplates(db, 3)
    const snap2 = getSnapshot(db)
    expect(snap2.productCosts['1729500000000000001']).toBe(2000)
    expect(snap2.productCosts['Bin A - Alo Yoga']).toBeUndefined()
    expect(snap2.productTx['1729500000000000001']!.brand).toBe('Alo')
    db.close()
  })
})

describe('db: roomId', () => {
  it('carries roomId from a mapped order into the snapshot Sale', () => {
    const db = openDb(':memory:')
    const o = mapTiktokOrder(fixture)
    o.roomId = '7653571353936759566'
    upsertOrders(db, [o], 1000)
    expect(getSnapshot(db).orders[0]!.roomId).toBe('7653571353936759566')
    db.close()
  })

  it('overlays the room_id column onto a legacy sale_json that lacks roomId', () => {
    const db = openDb(':memory:')
    // a row synced before roomId existed on Sale: sale_json has no roomId, column is set.
    db.prepare('INSERT INTO orders (order_id, room_id, placed_at, payment_status, sale_json) VALUES (?,?,?,?,?)')
      .run('O1', '7653571353936759566', 100, 'paid', JSON.stringify({
        orderId: 'O1', buyer: { username: 'A' }, productId: 'p', productName: 'X',
        price: { cents: 100, formatted: '$1' }, paymentStatus: 'paid', createdAt: 100,
      }))
    expect(getSnapshot(db).orders[0]!.roomId).toBe('7653571353936759566')
    db.close()
  })
})

describe('show names store', () => {
  it('merges room→name entries across calls and exposes them in the snapshot', () => {
    const db = openDb(':memory:')
    setShowNames(db, { 'room-1': { sessionId: 's1', name: 'Show One', startMs: 1000 } })
    setShowNames(db, { 'room-2': { sessionId: 's2', name: 'Show Two', startMs: 2000 } })
    const names = getShowNames(db)
    expect(names['room-1']!.name).toBe('Show One')
    expect(names['room-2']!.name).toBe('Show Two')
    expect(getSnapshot(db).showNames['room-1']!.sessionId).toBe('s1')
    db.close()
  })
})
