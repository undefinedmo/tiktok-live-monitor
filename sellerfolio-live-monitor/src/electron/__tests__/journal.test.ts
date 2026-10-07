import { describe, it, expect, afterEach, vi } from 'vitest'
import { buildSync } from 'esbuild'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { statSync } from 'node:fs'
import { closeJournal, flushJournal, initJournal, journalDeviceId, journalFile, record, setJournalContext, setJournalSync } from '../journal'

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

    expect(readdirSync(dir).sort()).toEqual(['device-id', 'show-7692.jsonl'])
    const rows = read(journalFile())
    expect(rows.map((r) => r['type'])).toEqual(['auction_start', 'auction_end'])
    expect(rows[1]).toMatchObject({ v: 1, room: '7692', session: '3411', lot: '#41', outcome: 'unsold' })
    const [a, b] = rows.map((r) => String(r['id']))
    expect(a).toMatch(/^[0-9a-f]{12}\.[0-9a-z]+-1$/)
    expect(b).toBe(a!.replace(/-1$/, '-2'))
  })

  it('writes chat to its own file with the id it was given, leaving the sequence ids of the other records unbroken', async () => {
    const dir = tmp()
    initJournal(dir, WORKER_SRC)
    setJournalContext({ room: '7692' })
    record('sale', { lot: '#1' })
    record('chat', { text: 'is this real?', author: 'Ann' }, 'chat.7653593120676039438')
    record('chat', { text: 'size?', author: 'Bob' }, 'chat.7653593120676039439')
    record('sale', { lot: '#2' })
    expect(await flushJournal()).toBe(true)

    expect(readdirSync(dir).sort()).toEqual(['device-id', 'show-7692.chat.jsonl', 'show-7692.jsonl'])
    const sales = read(join(dir, 'show-7692.jsonl'))
    expect(sales.map((r) => r['type'])).toEqual(['sale', 'sale'])
    expect(String(sales[0]!['id'])).toMatch(/-1$/)
    expect(String(sales[1]!['id'])).toMatch(/-2$/) // the chat lines did not consume 2 and 3
    const chat = read(join(dir, 'show-7692.chat.jsonl'))
    expect(chat.map((r) => r['id'])).toEqual(['chat.7653593120676039438', 'chat.7653593120676039439'])
    expect(chat[0]).toMatchObject({ v: 1, type: 'chat', room: '7692', text: 'is this real?', author: 'Ann' })
    expect(typeof chat[0]!['t']).toBe('number')
  })

  it('moves the chat file along with the room', async () => {
    const dir = tmp()
    initJournal(dir, WORKER_SRC)
    setJournalContext({ room: 'A' })
    record('chat', { text: 'one' }, 'chat.1')
    setJournalContext({ room: 'B' })
    record('chat', { text: 'two' }, 'chat.2')
    await flushJournal()
    expect(readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()).toEqual(['show-A.chat.jsonl', 'show-B.chat.jsonl'])
  })

  it('a fresh run starts its own chat file in its own directory, not the previous run file', async () => {
    const one = tmp()
    initJournal(one, WORKER_SRC)
    record('chat', { text: 'first' }, 'chat.1') // no room yet: the dated catch-all
    await flushJournal()
    await closeJournal()
    const two = tmp()
    initJournal(two, WORKER_SRC)
    record('chat', { text: 'second' }, 'chat.2')
    await flushJournal()
    expect(readdirSync(two).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1)
    expect(readdirSync(one).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1)
    expect(read(join(two, readdirSync(two).find((f) => f.endsWith('.chat.jsonl'))!)).map((r) => r['id'])).toEqual(['chat.2'])
  })

  it('keeps pre-room records of one run in one catch-all file across midnight, chat and the rest alike', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-07T23:59:59Z'))
      const dir = tmp()
      initJournal(dir, WORKER_SRC)
      record('chat', { text: 'a' }, 'chat.1'); record('print', { lot: '#1' })
      vi.setSystemTime(new Date('2026-10-08T00:00:01Z'))
      record('chat', { text: 'b' }, 'chat.2'); record('print', { lot: '#2' })
      await flushJournal()
      expect(readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()).toEqual(['unassigned-2026-10-07.chat.jsonl', 'unassigned-2026-10-07.jsonl'])
      expect(read(join(dir, 'unassigned-2026-10-07.chat.jsonl')).map((r) => r['id'])).toEqual(['chat.1', 'chat.2'])
    } finally { vi.useRealTimers() }
  })

  it('keeps records made before the room is known, then starts the room file', async () => {
    const dir = tmp()
    initJournal(dir, WORKER_SRC)
    record('session', { note: 'early' })
    setJournalContext({ room: '99' })
    record('sale', { lot: '#1' })
    await flushJournal()
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
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

// ── upload ────────────────────────────────────────────────────────────────────
interface Hit { auth: string; body: { device: string; events: Record<string, unknown>[] } }
function server(statusFor: (n: number) => number): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = []
  const srv: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const code = statusFor(hits.length)
      if (code < 300) hits.push({ auth: String(req.headers.authorization), body: JSON.parse(raw) })
      res.writeHead(code, { 'content-type': 'application/json' }).end('{}')
    })
  })
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/ingest`,
    hits,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  })))
}
const until = async (cond: () => boolean, ms = 6000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25)); return cond() }

describe('show journal → SellerFolio upload', () => {
  it('sends journaled records with the token, then advances the cursor to the end of the file', async () => {
    const s = await server(() => 200)
    try {
      const dir = tmp()
      initJournal(dir, WORKER_SRC)
      setJournalContext({ room: '7692' })
      record('auction_end', { lot: '#41', outcome: 'unsold' })
      record('sale', { lot: '#42', buyer: 'Saldaña 🍒' })
      await flushJournal()
      setJournalSync({ endpoint: s.url, token: 'sfc_test' })

      expect(await until(() => s.hits.length >= 1)).toBe(true)
      const hit = s.hits[0]!
      expect(hit.auth).toBe('Bearer sfc_test')
      expect(hit.body.device).toBe(journalDeviceId())
      expect(hit.body.events.map((e) => e['type'])).toEqual(['auction_end', 'sale'])
      expect(hit.body.events[1]).toMatchObject({ room: '7692', buyer: 'Saldaña 🍒' })

      const file = journalFile()
      expect(await until(() => { try { return Number(readFileSync(`${file}.cursor`, 'utf8')) === statSync(file).size } catch { return false } })).toBe(true)
    } finally { await closeJournal(); await s.close() }
  })

  it('uploads the sales before the chat, even though the chat file sorts first by name', async () => {
    const s = await server(() => 200)
    try {
      const dir = tmp()
      initJournal(dir, WORKER_SRC)
      setJournalContext({ room: '7692' })
      for (let i = 0; i < 3; i++) record('chat', { text: `c${i}` }, `chat.${i}`)
      record('sale', { lot: '#1' })
      await flushJournal()
      setJournalSync({ endpoint: s.url, token: 'sfc_test' })
      expect(await until(() => s.hits.length >= 2)).toBe(true)
      expect(s.hits.map((h) => h.body.events.map((e) => e['type']))).toEqual([['sale'], ['chat', 'chat', 'chat']])
      expect(s.hits[1]!.body.events.map((e) => e['id'])).toEqual(['chat.0', 'chat.1', 'chat.2'])
    } finally { await closeJournal(); await s.close() }
  })

  it('does not move the cursor when the server is down, and stops on a rejected token', async () => {
    const s = await server(() => 401)
    try {
      const dir = tmp()
      const states: string[] = []
      initJournal(dir, WORKER_SRC)
      setJournalContext({ room: '1' })
      record('print', { lot: '#1' })
      await flushJournal()
      setJournalSync({ endpoint: s.url, token: 'wrong' }, (state) => states.push(state))
      expect(await until(() => states.includes('auth'))).toBe(true)
      expect(s.hits).toHaveLength(0)
      expect(() => readFileSync(`${journalFile()}.cursor`, 'utf8')).toThrow()
    } finally { await closeJournal(); await s.close() }
  })
})

