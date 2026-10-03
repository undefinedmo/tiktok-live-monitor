import { describe, it, expect, afterEach } from 'vitest'
import { buildSync } from 'esbuild'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeJournal, flushJournal, initJournal, journalFile, record, setJournalContext } from '../journal'

// The real worker, bundled the way esbuild.mjs bundles it for the app.
const WORKER_SRC = buildSync({
  entryPoints: [fileURLToPath(new URL('../journalWorker.ts', import.meta.url))],
  bundle: true, platform: 'node', target: 'node20', format: 'cjs', write: false,
}).outputFiles[0]!.text

const dirs: string[] = []
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'ttj-')); dirs.push(d); return d }
const read = (f: string) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)

afterEach(async () => {
  await closeJournal()
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }) } catch { /* windows holds handles briefly */ } }
})

describe('show journal', () => {
  it('writes records to one file per room, in order, with stable ids', async () => {
    const dir = tmp()
    initJournal(dir, WORKER_SRC)
    setJournalContext({ room: '7692', session: '3411' })
    record('auction_start', { lot: '#41', startingBid: '$22.00' })
    record('auction_end', { lot: '#41', outcome: 'unsold' })
    expect(await flushJournal()).toBe(true)

    expect(readdirSync(dir)).toEqual(['show-7692.jsonl'])
    const rows = read(journalFile())
    expect(rows.map((r) => r['type'])).toEqual(['auction_start', 'auction_end'])
    expect(rows[1]).toMatchObject({ v: 1, room: '7692', session: '3411', lot: '#41', outcome: 'unsold' })
    const [a, b] = rows.map((r) => String(r['id']))
    expect(a).toMatch(/^[0-9a-z]+-1$/)
    expect(b).toBe(a!.replace(/-1$/, '-2'))
  })

  it('keeps records made before the room is known, then starts the room file', async () => {
    const dir = tmp()
    initJournal(dir, WORKER_SRC)
    record('session', { note: 'early' })
    setJournalContext({ room: '99' })
    record('sale', { lot: '#1' })
    await flushJournal()
    const files = readdirSync(dir).sort()
    expect(files).toHaveLength(2)
    expect(files[0]).toBe('show-99.jsonl')
    expect(files[1]).toMatch(/^unassigned-\d{4}-\d{2}-\d{2}\.jsonl$/)
  })

  it('costs the calling thread almost nothing: 20,000 records queue in well under a second', async () => {
    const dir = tmp()
    initJournal(dir, WORKER_SRC)
    setJournalContext({ room: 'bench' })
    const t0 = performance.now()
    for (let i = 0; i < 20_000; i++) record('print', { lot: `#${i}`, buyer: 'someone', ok: true, spoolMs: 170 })
    const queuedMs = performance.now() - t0
    // A show prints a label every ~50s. Even at this absurd rate each record is tens of
    // microseconds on the caller — the disk work is all on the worker.
    expect(queuedMs).toBeLessThan(1000)

    expect(await flushJournal(5000)).toBe(true)
    const rows = read(journalFile())
    expect(rows).toHaveLength(20_000)
    expect(rows[0]!['lot']).toBe('#0')
    expect(rows[19_999]!['lot']).toBe('#19999')
  })

  it('an unwritable journal does not throw into the caller and reports once', async () => {
    const dir = tmp()
    const blocker = join(dir, 'not-a-dir')
    writeFileSync(blocker, 'x') // a FILE where the journal directory should be
    const reports: string[] = []
    initJournal(join(blocker, 'journal'), WORKER_SRC, (l) => reports.push(l))
    setJournalContext({ room: '1' })
    expect(() => { for (let i = 0; i < 50; i++) record('print', { lot: '#1' }) }).not.toThrow()
    expect(await flushJournal()).toBe(false)
    await flushJournal()
    expect(reports.filter((r) => r.includes('write failing'))).toHaveLength(1)
  })

  it('is a no-op before init and after close', async () => {
    await closeJournal()
    expect(() => record('print', {})).not.toThrow()
    expect(await flushJournal()).toBe(false)
    expect(journalFile()).toBe('')
  })
})
