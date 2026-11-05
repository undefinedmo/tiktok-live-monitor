// LANE B — the show store end to end through the REAL journal worker (bundled as the app bundles
// it): records feed the index as they are queued, and a room's earlier files on disk are read
// back when its first record arrives (a restart mid-show).
import { describe, it, expect, afterEach } from 'vitest'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeJournal, initJournal, queryStore, record, setJournalContext } from '../journal'
import { buildJournalLine } from '../../core/journalLine'

const WORKER_SRC = buildSync({
  entryPoints: [fileURLToPath(new URL('../journalWorker.ts', import.meta.url))],
  bundle: true, platform: 'node', target: 'node20', format: 'cjs', write: false,
}).outputFiles[0]!.text

const dirs: string[] = []
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'tts-')); dirs.push(d); return d }
afterEach(async () => {
  await closeJournal()
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }) } catch { /* windows */ } }
})

const old = (type: string, data: object, n: number, id?: string) =>
  buildJournalLine({ runId: 'prev.run', seq: n, nowMs: 1_700_000_000_000 + n, room: '7692', session: 'S', type, data, id })

describe('show store in the journal worker', () => {
  it('answers from live records and from the room files already on disk', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'show-7692.jsonl'), [
      old('sale', { orderId: 'old1', lot: '#3', productName: 'Alo Hoodie', buyer: 'Jane Hague', handle: 'janethague', buyerId: 't1', price: '$40.00', cents: 4000, payment: 'pending', createdAt: 1_700_000_000_000 }, 1),
      old('payment_failed', { orderId: 'old1', lot: '#3', buyer: 'Jane Hague', price: '$40.00' }, 2),
    ].join('\n') + '\n')
    writeFileSync(join(dir, 'show-7692.chat.jsonl'), old('chat', { atMs: 1_700_000_000_500, author: 'Leah', handle: 'leah_b', text: 'ISO black leggings', lot: null }, 0, 'chat.m1') + '\n')

    initJournal(dir, WORKER_SRC)
    setJournalContext({ room: '7692', session: 'S2' })
    record('attach', { version: 't' })
    record('sale', { orderId: 'new1', lot: '#4', productName: 'UGG Tasman', buyer: 'Bob', buyerId: 't2', price: '$60.00', cents: 6000, payment: 'paid', createdAt: 1_700_000_100_000 })

    const all = await queryStore({ kind: 'sales', text: '' })
    expect(all.rows.map((r) => r.orderId)).toEqual(['new1', 'old1'])
    expect((await queryStore({ kind: 'sales', text: 'hoodie' })).rows.map((r) => r.orderId)).toEqual(['old1'])
    const failed = await queryStore({ kind: 'failed' })
    expect(failed.rows.map((r) => r.orderId)).toEqual(['old1'])
    const chat = await queryStore({ kind: 'chat', text: 'leggings' })
    expect(chat.rows.map((r) => (r as { id: string }).id)).toEqual(['chat.m1'])
  })

  it('a new room starts a fresh store', async () => {
    const dir = tmp()
    initJournal(dir, WORKER_SRC)
    setJournalContext({ room: 'A', session: '1' })
    record('sale', { orderId: 'a1', buyer: 'X', createdAt: 1 })
    expect((await queryStore({ kind: 'sales', text: '' })).total).toBe(1)
    setJournalContext({ room: 'B', session: '2' })
    record('sale', { orderId: 'b1', buyer: 'Y', createdAt: 2 })
    expect((await queryStore({ kind: 'sales', text: '' })).rows.map((r) => r.orderId)).toEqual(['b1'])
  })

  it('answers empty (never rejects) with no worker', async () => {
    expect(await queryStore({ kind: 'chat', text: 'x' })).toEqual({ kind: 'chat', rows: [], total: 0 })
  })
})
