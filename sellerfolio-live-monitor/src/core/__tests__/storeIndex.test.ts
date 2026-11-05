import { describe, it, expect } from 'vitest'
import { buildJournalLine } from '../journalLine'
import {
  StoreIndex, MAX_CHAT, MAX_SALES, MAX_ROWS, DEFAULT_ROWS, emptyStoreResult, mergeSearch, roomOfJournalFile,
  saleFromStore, searchTokens, type StoreChat, type StoreSale,
} from '../storeIndex'
import type { Sale } from '../types'

let seq = 0
const line = (type: string, data: object, opts: { room?: string; t?: number; id?: string } = {}) =>
  buildJournalLine({ runId: 'abc.run', seq: ++seq, nowMs: opts.t ?? 1_700_000_000_000 + seq, room: 'room' in opts ? opts.room : 'R1', session: 'S', type, data, id: opts.id })

const sale = (orderId: string, extra: Partial<Record<string, unknown>> = {}) =>
  line('sale', { orderId, lot: '#42', skuId: 'sku1', productId: 'p1', productName: 'Alo Yoga Leggings', buyer: 'Jane Hague', handle: 'janethague', buyerId: '7000000000000000001', price: '$25.00', cents: 2500, payment: 'pending', createdAt: 1_700_000_000_000, ...extra })

const chat = (id: string, text: string, extra: Partial<Record<string, unknown>> = {}) =>
  line('chat', { atMs: 1_700_000_000_000 + Number(id.replace(/\D/g, '') || 0), author: 'Cristina', authorId: 'u1', handle: 'cris', text, lot: '#3', ...extra }, { id })

describe('StoreIndex — sales', () => {
  it('indexes a sale and finds it by buyer, @handle, lot and product (AND of words, any case)', () => {
    const s = new StoreIndex()
    s.ingest(sale('o1'))
    s.ingest(sale('o2', { lot: '#7', buyer: 'Leah', handle: 'leah_b', productName: 'UGG Tasman', price: '$60.00', createdAt: 1_700_000_100_000 }))
    const q = (text: string) => s.query({ kind: 'sales', text }).rows.map((r) => r.orderId)
    expect(q('jane')).toEqual(['o1'])
    expect(q('@janethague')).toEqual(['o1'])
    expect(q('#7')).toEqual(['o2'])
    expect(q('ugg tasman')).toEqual(['o2'])
    expect(q('ugg jane')).toEqual([])
    expect(q('$60')).toEqual(['o2'])
    expect(q('')).toEqual(['o2', 'o1']) // empty → newest first
  })

  it('keeps every field of the sale record', () => {
    const s = new StoreIndex()
    s.ingest(sale('o1'))
    const row = s.query({ kind: 'sales', text: 'jane' }).rows[0]!
    expect(row).toMatchObject({ orderId: 'o1', lot: '#42', skuId: 'sku1', productName: 'Alo Yoga Leggings', buyer: 'Jane Hague', handle: 'janethague', buyerId: '7000000000000000001', price: '$25.00', cents: 2500, payment: 'pending', createdAt: 1_700_000_000_000 })
  })

  it('upserts on orderId: the same line twice is one sale (live + read back from disk)', () => {
    const s = new StoreIndex()
    const l = sale('o1')
    s.ingest(l); s.ingest(l)
    expect(s.query({ kind: 'sales', text: '' }).total).toBe(1)
  })

  it('payment_failed marks the sale failed without wiping its product, and lists it in failed', () => {
    const s = new StoreIndex()
    s.ingest(sale('o1'))
    s.ingest(sale('o2', { createdAt: 1_700_000_000_500 }))
    s.ingest(line('payment_failed', { orderId: 'o1', lot: '#42', skuId: 'sku1', buyer: 'Jane Hague', price: '$25.00' }))
    const f = s.query({ kind: 'failed' })
    expect(f.total).toBe(1)
    expect(f.rows[0]).toMatchObject({ orderId: 'o1', payment: 'failed', productName: 'Alo Yoga Leggings' })
    // a later sale line for the same order (a restart re-journals nothing, but be safe) keeps it failed
    s.ingest(sale('o1', { payment: 'paid' }))
    expect(s.query({ kind: 'failed' }).total).toBe(1)
  })

  it('a payment_failed with no sale before it still lands, timed by the envelope', () => {
    const s = new StoreIndex()
    s.ingest(line('payment_failed', { orderId: 'o9', lot: '#1', buyer: 'Jo', price: '$5.00' }, { t: 1_700_000_999_000 }))
    expect(s.query({ kind: 'failed' }).rows[0]).toMatchObject({ orderId: 'o9', createdAt: 1_700_000_999_000, payment: 'failed' })
  })

  it('a print mark (which usually precedes the order row) decorates the sale', () => {
    const s = new StoreIndex()
    s.ingest(line('print', { lot: '#42', buyer: 'Jane Hague', ok: true }, { t: 1_700_000_000_100 }))
    s.ingest(sale('o1'))
    expect(s.query({ kind: 'sales', text: '' }).rows[0]!.printedAt).toBe(1_700_000_000_100)
    s.ingest(line('print', { lot: '#42', buyer: 'jane hague', ok: true }, { t: 1_700_000_000_900 }))
    expect(s.query({ kind: 'sales', text: '' }).rows[0]!.printedAt).toBe(1_700_000_000_900)
    s.ingest(line('print', { lot: '#42', buyer: 'Jane Hague', ok: false }, { t: 1_700_000_009_000 }))
    expect(s.query({ kind: 'sales', text: '' }).rows[0]!.printedAt).toBe(1_700_000_000_900)
  })

  it('caps sales at MAX_SALES, dropping the oldest', () => {
    const s = new StoreIndex()
    for (let i = 0; i < MAX_SALES + 5; i++) s.ingest(sale(`o${i}`, { createdAt: 1_700_000_000_000 + i }))
    expect(s.saleCount).toBe(MAX_SALES)
    const all = s.query({ kind: 'sales', text: 'o', limit: MAX_ROWS })
    expect(all.rows[0]!.orderId).toBe(`o${MAX_SALES + 4}`)
    expect(s.query({ kind: 'sales', text: '' }).total).toBe(MAX_SALES)
  })

  it('limit: default, clamp to MAX_ROWS, total counts every match', () => {
    const s = new StoreIndex()
    for (let i = 0; i < 700; i++) s.ingest(sale(`o${i}`, { createdAt: 1_700_000_000_000 + i }))
    expect(s.query({ kind: 'sales', text: '' }).rows).toHaveLength(DEFAULT_ROWS)
    expect(s.query({ kind: 'sales', text: '', limit: 10_000 }).rows).toHaveLength(MAX_ROWS)
    expect(s.query({ kind: 'sales', text: 'jane', limit: 3 })).toMatchObject({ total: 700 })
  })
})

describe('StoreIndex — chat', () => {
  it('finds chat by nickname, handle and text; newest first; dedupes on id', () => {
    const s = new StoreIndex()
    s.ingest(chat('chat.1', 'do you have size 8?'))
    s.ingest(chat('chat.2', 'ISO black leggings', { author: 'Leah', handle: 'leah_b', authorId: 'u2' }))
    s.ingest(chat('chat.2', 'ISO black leggings', { author: 'Leah', handle: 'leah_b', authorId: 'u2' }))
    expect(s.chatCount).toBe(2)
    expect(s.query({ kind: 'chat', text: 'size' }).rows.map((r) => r.id)).toEqual(['chat.1'])
    expect(s.query({ kind: 'chat', text: '@leah_b' }).rows.map((r) => r.id)).toEqual(['chat.2'])
    expect(s.query({ kind: 'chat', text: 'cristina' }).rows.map((r) => r.id)).toEqual(['chat.1'])
    expect(s.query({ kind: 'chat', text: '' }).rows.map((r) => r.id)).toEqual(['chat.2', 'chat.1'])
    const row: StoreChat = s.query({ kind: 'chat', text: 'leggings' }).rows[0] as StoreChat
    expect(row).toEqual({ id: 'chat.2', nickname: 'Leah', handle: 'leah_b', userId: 'u2', text: 'ISO black leggings', ts: 1_700_000_000_002, lot: '#3' })
  })

  it('a chat line with no atMs is timed by the envelope; lot null survives', () => {
    const s = new StoreIndex()
    s.ingest(line('chat', { author: 'A', text: 'hi', lot: null }, { id: 'chatx.1', t: 1_700_000_123_000 }))
    expect(s.query({ kind: 'chat', text: 'hi' }).rows[0]).toMatchObject({ ts: 1_700_000_123_000, lot: null })
  })

  it('caps chat at MAX_CHAT, dropping the oldest', () => {
    const s = new StoreIndex()
    for (let i = 0; i < MAX_CHAT + 3; i++) s.ingest(chat(`chat.${i}`, 'x'))
    expect(s.chatCount).toBe(MAX_CHAT)
    expect(s.query({ kind: 'chat', text: '', limit: 1 }).rows[0]!.id).toBe(`chat.${MAX_CHAT + 2}`)
  })
})

describe('StoreIndex — rooms, bad input, rebuild', () => {
  it('a line for another room starts a fresh index; a line with no room joins the current one', () => {
    const s = new StoreIndex()
    s.ingest(sale('o1'))
    s.ingest(sale('o2', {}, ))
    expect(s.currentRoom).toBe('R1')
    s.ingest(line('sale', { orderId: 'x1', buyer: 'B' }, { room: undefined }))
    expect(s.query({ kind: 'sales', text: '' }).total).toBe(3)
    s.ingest(line('sale', { orderId: 'n1', buyer: 'New' }, { room: 'R2' }))
    expect(s.currentRoom).toBe('R2')
    expect(s.query({ kind: 'sales', text: '' }).rows.map((r) => r.orderId)).toEqual(['n1'])
  })

  it('skips junk without throwing', () => {
    const s = new StoreIndex()
    for (const bad of ['', 'not json', '{"type":"sale"}', 'null', '[1,2]', '{"type":"chat","id":"c"}', 'x'.repeat(20_000), undefined as unknown as string]) s.ingest(bad)
    expect(s.saleCount).toBe(0)
    expect(s.chatCount).toBe(0)
  })

  it('ingestText rebuilds from a file body, ignoring a partial last line and blank lines', () => {
    const s = new StoreIndex()
    const body = [line('attach', { version: '1' }), sale('o1'), '', sale('o2', { createdAt: 1_700_000_000_001 }), '{"v":1,"type":"sa'].join('\n')
    s.ingestText(body)
    expect(s.query({ kind: 'sales', text: '' }).rows.map((r) => r.orderId)).toEqual(['o2', 'o1'])
  })

  it('reset clears everything', () => {
    const s = new StoreIndex()
    s.ingest(sale('o1')); s.ingest(chat('chat.1', 'hey'))
    s.reset('R9')
    expect([s.saleCount, s.chatCount, s.currentRoom]).toEqual([0, 0, 'R9'])
  })

  it('roomOfJournalFile reads the room from both file names, and not from a catch-all', () => {
    expect(roomOfJournalFile('C:\\x\\journal\\show-7312.jsonl')).toBe('7312')
    expect(roomOfJournalFile('/x/journal/show-7312.chat.jsonl')).toBe('7312')
    expect(roomOfJournalFile('/x/unassigned-2026-11-05.jsonl')).toBe('')
    expect(roomOfJournalFile('/x/show-7312.jsonl.cursor')).toBe('')
  })

  it('emptyStoreResult answers the right kind', () => {
    expect(emptyStoreResult({ kind: 'failed' })).toEqual({ kind: 'failed', rows: [], total: 0 })
    expect(new StoreIndex().query({ kind: 'chat', text: 'x' })).toEqual({ kind: 'chat', rows: [], total: 0 })
  })

  it('searchTokens lower-cases, splits and drops a leading @', () => {
    expect(searchTokens('  @Jane   #42 ')).toEqual(['jane', '#42'])
    expect(searchTokens('')).toEqual([])
  })
})

describe('mergeSearch / saleFromStore (the feed search)', () => {
  const live = (orderId: string, buyer: string, createdAt: number, pay: Sale['paymentStatus'] = 'paid'): Sale =>
    ({ orderId, buyer: { username: buyer, ttuid: `t-${buyer}` }, productId: 'p', productName: 'Tee', skuDesc: '#1', price: { cents: 100, formatted: '$1.00' }, paymentStatus: pay, createdAt })
  const stored = (r: StoreSale) => saleFromStore(r)

  it('live matches show; stored rows join; a live row wins over its stored copy', () => {
    const l = [live('o3', 'Jane', 300), live('o2', 'Bob', 200)]
    const st = [stored({ orderId: 'o3', buyer: 'Jane', payment: 'pending', createdAt: 300 }), stored({ orderId: 'o1', buyer: 'Jane', createdAt: 100, lot: '#9', productName: 'Hat' })]
    const r = mergeSearch(l, st, 2, 'jane')
    expect(r.rows.map((s) => s.orderId)).toEqual(['o3', 'o1'])
    expect(r.rows[0]!.paymentStatus).toBe('paid') // the live one
    expect([...r.fromStore]).toEqual(['o1'])
    expect(r.found).toBe(2)
  })

  it('found counts store matches beyond the rows returned', () => {
    const st = [stored({ orderId: 'a', buyer: 'Jane', createdAt: 2 }), stored({ orderId: 'b', buyer: 'Jane', createdAt: 1 })]
    expect(mergeSearch([], st, 250, 'jane').found).toBe(250)
  })

  it('saleFromStore fills the Sale shape printSale needs', () => {
    expect(saleFromStore({ orderId: 'o1', lot: '#4', skuId: 's', buyer: 'Jo', handle: 'jo', buyerId: 't1', productName: 'Cap', price: '$3.00', cents: 300, payment: 'failed', createdAt: 5 }))
      .toEqual({ orderId: 'o1', skuDesc: '#4', skuId: 's', buyer: { username: 'Jo', handle: 'jo', ttuid: 't1' }, productId: '', productName: 'Cap', price: { cents: 300, formatted: '$3.00' }, paymentStatus: 'failed', createdAt: 5 })
  })
})
