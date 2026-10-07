import { describe, expect, it } from 'vitest'
import {
  MAX_AGE_SEC,
  MAX_IDENTIFICATIONS,
  STORE_VERSION,
  createIdentifyStore,
  entryFromRow,
  restoreEntries,
  rowFromEntry,
  type IdentificationRow,
  type StoreIO,
} from '../identifyStore'

// An in-memory file with the three operations the real one has. `text === null` is "no file".
function memIO(initial: string | null = null) {
  const io = {
    text: initial as string | null,
    appends: [] as string[],
    replaces: [] as string[],
    failRead: false,
    failAppend: false,
    failReplace: false,
    read(): string | null {
      if (io.failRead) throw new Error('EBUSY')
      return io.text
    },
    append(s: string): void {
      if (io.failAppend) throw new Error('ENOSPC')
      io.appends.push(s)
      io.text = (io.text ?? '') + s
    },
    replace(s: string): void {
      if (io.failReplace) throw new Error('EACCES')
      io.replaces.push(s)
      io.text = s
    },
  }
  return io satisfies StoreIO
}

const NOW_MS = 1_800_000_000_000
const NOW_SEC = NOW_MS / 1000
const row = (orderId: string, atEpochSec = NOW_SEC - 100, over: Partial<IdentificationRow> = {}): IdentificationRow => ({
  orderId,
  roomId: 'room1',
  atEpochSec,
  head: `Item ${orderId} — @buyer`,
  lot: `L${orderId}`,
  price: '$12.00',
  status: 'done',
  text: 'Identified -- saved to SellerFolio',
  live: true,
  ...over,
})
const open = (io: StoreIO, opts: { maxCount?: number; maxAgeSec?: number } = {}) =>
  createIdentifyStore(io, { now: () => NOW_MS, ...opts })
const lines = (t: string | null) => (t ?? '').split('\n').filter(Boolean)

describe('identifyStore: round trip', () => {
  it('loads what was saved, newest sale first, by a new store over the same file', () => {
    const io = memIO()
    const a = open(io)
    a.load()
    a.save(row('1', NOW_SEC - 300))
    a.save(row('2', NOW_SEC - 200))
    a.save(row('3', NOW_SEC - 100))
    const b = open(io).load()
    expect(b.map((r) => r.orderId)).toEqual(['3', '2', '1'])
    expect(b[0]).toMatchObject({ roomId: 'room1', lot: 'L3', price: '$12.00', status: 'done', live: true })
  })

  it('an empty or missing file loads as no rows, without writing anything', () => {
    for (const initial of [null, '']) {
      const io = memIO(initial)
      expect(open(io).load()).toEqual([])
      expect(io.replaces).toEqual([])
    }
  })

  it('the last line for an order wins, and the order appears once', () => {
    const io = memIO()
    const s = open(io)
    s.load()
    s.save(row('1', NOW_SEC - 50, { status: 'transcribing', text: '' }))
    s.save(row('1', NOW_SEC - 50, { status: 'done', fields: { brand: 'Alo', size: 'M' }, edited: true }))
    const rows = open(io).load()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'done', edited: true, fields: { brand: 'Alo', size: 'M' } })
  })

  it('two sales in the same second both survive, the later-saved listed first', () => {
    const io = memIO()
    const s = open(io)
    s.load()
    s.save(row('a', NOW_SEC - 10))
    s.save(row('b', NOW_SEC - 10))
    expect(open(io).load().map((r) => r.orderId)).toEqual(['b', 'a'])
  })

  it('keeps a text with newlines and quotes on one line', () => {
    const io = memIO()
    const s = open(io)
    s.load()
    s.save(row('1', NOW_SEC - 5, { text: 'line one\nline "two"\r\n end', head: 'a\nb' }))
    expect(lines(io.text)).toHaveLength(1)
    expect(open(io).load()[0]).toMatchObject({ text: 'line one\nline "two"\r\n end', head: 'a\nb' })
  })

  it('an identification that was mid-flight when the app closed comes back as not identified, never as "Identifying…"', () => {
    const io = memIO()
    const s = open(io)
    s.load()
    s.save(row('1', NOW_SEC - 5, { status: 'transcribing', text: '' }))
    const [r] = open(io).load()
    expect(r?.status).toBe('abandoned')
    expect(r?.text).toMatch(/closed/i)
  })
})

describe('identifyStore: the cap', () => {
  it('is far above the old 30 and holds a whole show (919 sales measured) without dropping one', () => {
    expect(MAX_IDENTIFICATIONS).toBeGreaterThanOrEqual(1000)
    const io = memIO()
    const s = open(io)
    s.load()
    for (let i = 0; i < 919; i++) s.save(row(String(i), NOW_SEC - 2000 + i))
    expect(open(io).load()).toHaveLength(919)
  })

  it('keeps the newest N by SALE time, not by when the line was written', () => {
    const io = memIO()
    const s = open(io, { maxCount: 3 })
    s.load()
    for (const [id, t] of [['a', 100], ['b', 200], ['c', 300], ['d', 400]] as const) s.save(row(id, NOW_SEC - 1000 + t))
    // A Retry settles an OLD lot last. It must be the one evicted, not a newer sale.
    s.save(row('a', NOW_SEC - 1000 + 100, { text: 'retried' }))
    expect(open(io, { maxCount: 3 }).load().map((r) => r.orderId)).toEqual(['d', 'c', 'b'])
  })

  it('bounds the file on disk during a session, not only at launch', () => {
    const io = memIO()
    const s = open(io, { maxCount: 10 })
    s.load()
    for (let i = 0; i < 200; i++) s.save(row(String(i), NOW_SEC - 1000 + i))
    expect(lines(io.text).length).toBeLessThanOrEqual(10 * 3 + 1)
    expect(open(io, { maxCount: 10 }).load().map((r) => r.orderId)).toEqual(
      Array.from({ length: 10 }, (_, i) => String(199 - i)),
    )
  })

  it('drops rows older than the age cap and keeps ones within it, and rows dated in the future', () => {
    const io = memIO()
    const s = open(io, { maxAgeSec: 1000 })
    s.load()
    s.save(row('old', NOW_SEC - 1001))
    s.save(row('edge', NOW_SEC - 999))
    s.save(row('future', NOW_SEC + 86_400)) // a station clock that was wrong when it was saved
    expect(open(io, { maxAgeSec: 1000 }).load().map((r) => r.orderId).sort()).toEqual(['edge', 'future'])
    expect(MAX_AGE_SEC).toBeGreaterThanOrEqual(7 * 86_400)
  })
})

describe('identifyStore: a bad file never throws and never takes good rows with it', () => {
  const good = (id: string, t = NOW_SEC - 50) => JSON.stringify({ v: STORE_VERSION, ...row(id, t) })

  it.each([
    ['plain garbage', 'not json at all'],
    ['a truncated object', '{"v":1,"orderId":"9","atEpochSec":17'],
    ['a JSON array', '[1,2,3]'],
    ['null', 'null'],
    ['a number', '42'],
    ['an empty object', '{}'],
    ['no orderId', JSON.stringify({ v: 1, atEpochSec: NOW_SEC, status: 'done' })],
    ['an empty orderId', JSON.stringify({ v: 1, orderId: '', atEpochSec: NOW_SEC, status: 'done' })],
    ['a numeric orderId', JSON.stringify({ v: 1, orderId: 7, atEpochSec: NOW_SEC, status: 'done' })],
    ['an unknown status', JSON.stringify({ v: 1, orderId: 'x', atEpochSec: NOW_SEC, status: 'bogus' })],
    ['no time', JSON.stringify({ v: 1, orderId: 'x', status: 'done' })],
    ['a string time', JSON.stringify({ v: 1, orderId: 'x', atEpochSec: 'soon', status: 'done' })],
    ['an infinite time', '{"v":1,"orderId":"x","atEpochSec":1e999,"status":"done"}'],
    ['no version', JSON.stringify({ orderId: 'x', atEpochSec: NOW_SEC, status: 'done' })],
    ['NUL bytes', '\u0000\u0000\u0000\u0000'],
  ])('skips %s and still loads the rows around it', (_name, bad) => {
    const io = memIO([good('1'), bad, good('2', NOW_SEC - 10)].join('\n') + '\n')
    const rows = open(io).load()
    expect(rows.map((r) => r.orderId)).toEqual(['2', '1'])
  })

  it('survives a file that is entirely binary noise', () => {
    const noise = Array.from({ length: 4000 }, (_, i) => String.fromCharCode((i * 7919) % 256)).join('')
    expect(open(memIO(noise)).load()).toEqual([])
  })

  it('returns no rows, and does not rewrite the file, when the file cannot be read at all', () => {
    const io = memIO(good('1') + '\n')
    io.failRead = true
    const s = open(io)
    expect(s.load()).toEqual([])
    expect(io.replaces).toEqual([])
    // ...and a row saved afterwards is appended, so a transient lock does not lose the show's rows.
    s.save(row('2'))
    expect(io.appends).toHaveLength(1)
  })

  it('a power cut mid-line (no trailing newline) loses only that line, and the next save is not glued to it', () => {
    const io = memIO(good('1') + '\n' + '{"v":1,"orderId":"2","atEpo')
    io.failReplace = true // even when it cannot repair the file, an append must start on a fresh line
    const s = open(io)
    expect(s.load().map((r) => r.orderId)).toEqual(['1'])
    s.save(row('3', NOW_SEC - 1))
    expect(open(io).load().map((r) => r.orderId)).toEqual(['3', '1'])
  })

  it('repairs the file on load: rewrites it clean, once', () => {
    const io = memIO([good('1'), 'garbage', good('1'), good('2', NOW_SEC - 5)].join('\n') + '\n{"torn')
    open(io).load()
    expect(io.replaces).toHaveLength(1)
    expect(lines(io.text)).toHaveLength(2)
    expect(io.text?.endsWith('\n')).toBe(true)
    open(io).load()
    expect(io.replaces).toHaveLength(1) // a clean file is left alone
  })

  it('still returns every row when the repair itself fails', () => {
    const io = memIO([good('1'), 'garbage'].join('\n') + '\n')
    io.failReplace = true
    expect(open(io).load().map((r) => r.orderId)).toEqual(['1'])
  })

  it('a failing disk never throws out of save, and the row is written once the disk is back', () => {
    const io = memIO()
    const s = open(io)
    s.load()
    io.failAppend = true
    expect(s.save(row('1', NOW_SEC - 20))).toBe(false)
    expect(s.save(row('2', NOW_SEC - 10))).toBe(false)
    io.failAppend = false
    expect(s.save(row('3', NOW_SEC - 5))).toBe(true)
    expect(open(io).load().map((r) => r.orderId)).toEqual(['3', '2', '1'])
  })

  it('refuses to save a row that is not valid, rather than writing a line load would skip', () => {
    const io = memIO()
    const s = open(io)
    s.load()
    expect(s.save({ ...row('1'), orderId: '' })).toBe(false)
    expect(s.save({ ...row('1'), atEpochSec: Number.NaN })).toBe(false)
    expect(s.save({ ...row('1'), status: 'nope' as never })).toBe(false)
    expect(io.appends).toEqual([])
  })

  it('bounds what one line can carry', () => {
    const io = memIO()
    const s = open(io)
    s.load()
    s.save(row('1', NOW_SEC - 5, { text: 'x'.repeat(50_000), head: 'h'.repeat(50_000), fields: { brand: 'b'.repeat(50_000) } }))
    expect((io.text ?? '').length).toBeLessThan(5_000)
  })

  it('drops field values that are not strings, and keys it does not know', () => {
    const io = memIO(
      JSON.stringify({ v: 1, ...row('1'), fields: { brand: 'Alo', size: 7, nope: 'x', item: null, color: 'Black' } }) + '\n',
    )
    const [r] = open(io).load()
    expect(r?.fields).toEqual({ brand: 'Alo', color: 'Black' })
  })
})

describe('identifyStore: written by a newer version', () => {
  const future = JSON.stringify({ v: STORE_VERSION + 1, orderId: 'F', atEpochSec: NOW_SEC - 5, weird: { shape: true } })
  const good = JSON.stringify({ v: STORE_VERSION, ...row('1') })

  it('does not show a row it cannot read', () => {
    expect(open(memIO([future, good].join('\n') + '\n')).load().map((r) => r.orderId)).toEqual(['1'])
  })

  it('keeps the newer line byte for byte when it rewrites the file, so going back a version does not destroy it', () => {
    const io = memIO([future, good, 'garbage'].join('\n') + '\n')
    open(io).load()
    expect(io.replaces).toHaveLength(1)
    expect(lines(io.text)).toContain(future)
  })

  it('does not count a newer line as damage: a file of only those is left alone', () => {
    const io = memIO(future + '\n')
    open(io).load()
    expect(io.replaces).toEqual([])
  })

  it('writes its own rows at its own version', () => {
    const io = memIO()
    const s = open(io)
    s.load()
    s.save(row('1'))
    expect(JSON.parse(lines(io.text)[0] ?? '{}').v).toBe(STORE_VERSION)
  })
})

describe('identifyStore: nothing secret reaches the file', () => {
  it('writes only the row, whatever else is on the object it is handed', () => {
    const io = memIO()
    const s = open(io)
    s.load()
    s.save({ ...row('1'), token: 'sfc_SECRET', authorization: 'Bearer sfc_SECRET', sale: { buyer: 'x' } } as never)
    expect(io.text).not.toContain('SECRET')
    expect(io.text).not.toContain('Bearer')
    expect(io.text).not.toContain('buyer":"x')
  })
})

describe('rowFromEntry / entryFromRow', () => {
  const entry = {
    head: 'Leggings — @sam', lot: '12', price: '$30.00', status: 'done' as const, live: true, text: 'ok',
    orderId: 'o1', roomId: 'r1', atEpochSec: NOW_SEC - 5, edited: true, fields: { brand: 'Alo' },
    sale: { orderId: 'o1' }, // the in-memory sale is NOT persisted
  }
  it('round trips every persisted field and drops the in-memory sale', () => {
    const r = rowFromEntry(entry)
    expect(r).not.toBeNull()
    expect(r).not.toHaveProperty('sale')
    const back = entryFromRow(r!)
    expect(back).toMatchObject({ head: 'Leggings — @sam', lot: '12', price: '$30.00', status: 'done', live: true, text: 'ok', orderId: 'o1', roomId: 'r1', edited: true, fields: { brand: 'Alo' } })
    expect(back).not.toHaveProperty('sale')
  })
  it('has no row for an entry that has no order or no time (a demo row)', () => {
    expect(rowFromEntry({ ...entry, orderId: undefined })).toBeNull()
    expect(rowFromEntry({ ...entry, atEpochSec: undefined })).toBeNull()
  })
  it('does not invent a live flag', () => {
    expect(rowFromEntry({ ...entry, live: undefined })?.live).toBeUndefined()
  })
})

describe('restoreEntries: bringing last session back into the screen', () => {
  const rows = [row('c', NOW_SEC - 10), row('b', NOW_SEC - 20), row('a', NOW_SEC - 30)]

  it('restores every row as an entry, in the order given (newest first)', () => {
    const r = restoreEntries([], rows, 100)
    expect(r.map((e) => e.orderId)).toEqual(['c', 'b', 'a'])
    expect(r[0]).not.toHaveProperty('sale')
  })
  it('skips an order the screen already has (a sale that arrived before the file was read), and says which it took', () => {
    const r = restoreEntries([{ orderId: 'b' }, { orderId: undefined }], rows, 100)
    expect(r.map((e) => e.orderId)).toEqual(['c', 'a'])
  })
  it('never takes the list past the cap, counting what is already there', () => {
    expect(restoreEntries([{ orderId: 'x' }, { orderId: 'y' }], rows, 3).map((e) => e.orderId)).toEqual(['c'])
    expect(restoreEntries(Array.from({ length: 5 }, (_, i) => ({ orderId: `l${i}` })), rows, 5)).toEqual([])
  })
  it('a duplicate order inside the file is taken once', () => {
    expect(restoreEntries([], [row('a'), row('a')], 100)).toHaveLength(1)
  })
})

describe('identifyStore: saving before loading', () => {
  it('does not forget the rows already in the file: a save that arrives first is added to them, not written over them', () => {
    const lineFor = (id: string, at: number) => JSON.stringify({ v: STORE_VERSION, ...row(id, at) })
    // Three recent rows on disk; the store is never load()ed. Ten OLDER sales are then saved, enough to
    // force a rewrite from memory (more than 3 x maxCount lines). The three recent rows must survive it.
    const io = memIO([lineFor('r1', NOW_SEC - 3), lineFor('r2', NOW_SEC - 2), lineFor('r3', NOW_SEC - 1)].join('\n') + '\n')
    const s = open(io, { maxCount: 4 })
    for (let i = 0; i < 10; i++) s.save(row(`old${i}`, NOW_SEC - 1000 + i))
    expect(io.replaces.length).toBeGreaterThan(0)
    expect(open(io, { maxCount: 4 }).load().map((r) => r.orderId)).toEqual(['r3', 'r2', 'r1', 'old9'])
  })

  it('and when no rewrite is due, just appends to what is there', () => {
    const io = memIO(JSON.stringify({ v: STORE_VERSION, ...row('old', NOW_SEC - 40) }) + '\n')
    open(io).save(row('fresh', NOW_SEC - 5))
    expect(open(io).load().map((r) => r.orderId)).toEqual(['fresh', 'old'])
  })
})

// Added after a mutation sweep: each of these pins something the first tests let a mutant slip past.
describe('identifyStore: sweep additions', () => {
  const lineOf = (over: Record<string, unknown>) => JSON.stringify({ v: STORE_VERSION, ...row('x', NOW_SEC - 5), ...over })

  it.each([[0], [-1], [1.5], ['1'], [null], [true]])('a line whose version is %j is damage, not a row', (v) => {
    const io = memIO(lineOf({ orderId: 'ok' }) + '\n' + lineOf({ orderId: 'weird', v }) + '\n')
    expect(open(io).load().map((r) => r.orderId)).toEqual(['ok'])
  })
  it('a fractional version is not kept as "newer": it is damage and is repaired away', () => {
    const io = memIO(lineOf({ orderId: 'ok' }) + '\n' + lineOf({ orderId: 'f', v: 1.5 }) + '\n')
    open(io).load()
    expect(io.text).not.toContain('"v":1.5')
  })

  it('a row exactly at the age limit is kept', () => {
    const io = memIO(lineOf({ orderId: 'edge', atEpochSec: NOW_SEC - 1000 }) + '\n')
    expect(open(io, { maxAgeSec: 1000 }).load().map((r) => r.orderId)).toEqual(['edge'])
  })

  it('a file that is only superseded lines (nothing damaged) is still rewritten, once', () => {
    const io = memIO([lineOf({ orderId: 'a', text: 'first' }), lineOf({ orderId: 'a', text: 'second' }), lineOf({ orderId: 'a', text: 'third' })].join('\n') + '\n')
    open(io).load()
    expect(io.replaces).toHaveLength(1)
    expect(lines(io.text)).toHaveLength(1)
    expect(io.text).toContain('third')
  })

  it('a complete last row that only lacks its newline is kept, and the file is closed off', () => {
    const io = memIO(lineOf({ orderId: 'a' }) + '\n' + lineOf({ orderId: 'b', atEpochSec: NOW_SEC - 1 }))
    expect(open(io).load().map((r) => r.orderId)).toEqual(['b', 'a'])
    expect(io.text?.endsWith('\n')).toBe(true)
  })

  it('a disk that stays unwritable cannot grow the retry backlog without bound', () => {
    const io = memIO()
    const s = open(io, { maxCount: 5 })
    s.load()
    io.failAppend = true
    for (let i = 0; i < 100; i++) s.save(row(`r${i}`, NOW_SEC - 500 + i))
    io.failAppend = false
    s.save(row('last', NOW_SEC))
    const written = io.appends.at(-1) ?? ''
    expect(lines(written).length).toBeLessThanOrEqual(5)
    expect(written).toContain('last')
  })

  it('an order id of absurd length is damage, on load and on save', () => {
    const long = 'o'.repeat(5000)
    const io = memIO(lineOf({ orderId: long }) + '\n' + lineOf({ orderId: 'ok' }) + '\n')
    const s = open(io)
    expect(s.load().map((r) => r.orderId)).toEqual(['ok'])
    expect(s.save(row(long))).toBe(false)
  })

  it('a room id that is not a string is dropped to null', () => {
    const io = memIO(lineOf({ roomId: 7 }) + '\n' + lineOf({ orderId: 'y', roomId: { a: 1 } }) + '\n')
    for (const r of open(io).load()) expect(r.roomId).toBeNull()
  })

  it('after a failed read, the first append starts on a fresh line (the unreadable file may end mid-line)', () => {
    const io = memIO('{"v":1,"orderId":"torn')
    io.failRead = true
    const s = open(io)
    s.load()
    s.save(row('1'))
    expect(io.appends[0]?.startsWith('\n')).toBe(true)
  })

  it('a row waiting on its answer is written as waiting, and only READ back as abandoned', () => {
    const io = memIO()
    const s = open(io)
    s.load()
    s.save(row('1', NOW_SEC - 5, { status: 'transcribing', text: '' }))
    expect(JSON.parse(lines(io.text)[0] ?? '{}').status).toBe('transcribing')
  })

  it('a rewrite keeps two sales from the same second in the order they were saved', () => {
    const io = memIO()
    const s = open(io, { maxCount: 2 }) // a rewrite after 6 lines
    s.load()
    s.save(row('a', NOW_SEC - 10))
    s.save(row('b', NOW_SEC - 10))
    for (let i = 0; i < 5; i++) s.save(row('b', NOW_SEC - 10, { text: `again ${i}` })) // lines pile up -> rewrite
    expect(io.replaces.length).toBeGreaterThan(0)
    expect(open(io, { maxCount: 2 }).load().map((r) => r.orderId)).toEqual(['b', 'a'])
  })
})
