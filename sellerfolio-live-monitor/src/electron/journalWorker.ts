// The journal's disk-and-network thread. Everything that touches the filesystem for the show
// journal, and the upload of it to SellerFolio, happens here — so a slow, locked or full
// disk, or a dead network, can never delay a label: the main thread's whole involvement is
// one postMessage per record.
//
// Bundled separately and handed to `new Worker(source, { eval: true })` as a string (see
// esbuild.mjs), so there is no worker file to resolve inside the packaged app.asar.

import { parentPort } from 'node:worker_threads'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { JournalWriter } from '../core/journalWriter'
import { backoffMs, batchBody, takeLines, verdictFor } from '../core/journalSync'

const FLUSH_MS = 250 // the most a crash can lose
const FLUSH_AT = 200 // ...or sooner, in a burst

const madeDirs = new Set<string>()
const writer = new JournalWriter((file, data) => {
  const dir = dirname(file)
  if (!madeDirs.has(dir)) { mkdirSync(dir, { recursive: true }); madeDirs.add(dir) }
  appendFileSync(file, data)
})

let lastReportedFailed = 0
function flush(): { written: number; failed: number } {
  const r = writer.flush()
  // Report a failure once when it starts and once when it clears, not on every 250ms tick.
  if (r.failed && !lastReportedFailed) parentPort?.postMessage({ kind: 'error', message: `journal write failing: ${r.failed} lines waiting, ${writer.dropped} dropped` })
  if (!r.failed && lastReportedFailed) parentPort?.postMessage({ kind: 'recovered' })
  lastReportedFailed = r.failed
  return r
}

setInterval(flush, FLUSH_MS)

// ── upload to SellerFolio ─────────────────────────────────────────────────────
// Local first: the journal file is the truth and the outbox. Each file has a sidecar
// `<file>.cursor` holding the byte offset the server has acknowledged; it only moves after a
// 2xx. Re-sending is safe because the server upserts on each line's id.

interface SyncConfig { endpoint: string; token: string; dir: string; deviceId: string }
const IDLE_MS = 10_000 // how often to look for new lines when caught up
const READ_BYTES = 512 * 1024
const BATCH_LINES = 500
const REQUEST_TIMEOUT_MS = 20_000

let sync: SyncConfig | null = null
let syncTimer: ReturnType<typeof setTimeout> | undefined
let syncing = false
let failures = 0
let halted: '' | 'auth' = ''
let lastStatus = ''

function status(state: string, detail = ''): void {
  const line = detail ? `${state}: ${detail}` : state
  if (line === lastStatus) return // only changes are worth a message
  lastStatus = line
  parentPort?.postMessage({ kind: 'sync', state, detail })
}

const cursorPath = (file: string) => `${file}.cursor`
function readCursor(file: string): number {
  try { const n = Number(readFileSync(cursorPath(file), 'utf8').trim()); return Number.isFinite(n) && n >= 0 ? n : 0 } catch { return 0 }
}

function readFrom(file: string, offset: number, size: number): Uint8Array {
  const len = Math.min(READ_BYTES, size - offset)
  const buf = Buffer.allocUnsafe(len)
  const fd = openSync(file, 'r')
  try { return buf.subarray(0, readSync(fd, buf, 0, len, offset)) } finally { closeSync(fd) }
}

/** Upload everything outstanding. Returns true when caught up, false when it had to stop. */
async function syncAll(cfg: SyncConfig): Promise<boolean> {
  if (!existsSync(cfg.dir)) return true
  const files = readdirSync(cfg.dir).filter((f) => f.endsWith('.jsonl')).sort()
  let sent = 0
  for (const name of files) {
    const file = join(cfg.dir, name)
    for (;;) {
      const size = statSync(file).size
      let offset = readCursor(file)
      if (offset > size) offset = 0 // the file was replaced; ids make a full re-send harmless
      if (offset >= size) break
      const batch = takeLines(readFrom(file, offset, size), BATCH_LINES)
      if (!batch.consumed) break // only a partial line so far; the writer is mid-append
      if (batch.lines.length) {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
        let code = 0
        try {
          const res = await fetch(cfg.endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
            body: batchBody(cfg.deviceId, batch.lines),
            signal: ctl.signal,
          })
          code = res.status
        } catch { code = 0 } finally { clearTimeout(timer) }
        const verdict = code === 0 ? 'retry' : verdictFor(code)
        if (verdict !== 'ok') {
          failures++
          if (verdict === 'auth') { halted = 'auth'; status('auth', `SellerFolio rejected the token (HTTP ${code})`) }
          else if (verdict === 'rejected') status('rejected', `SellerFolio refused a batch (HTTP ${code}) — it will be retried`)
          else status('offline', code ? `HTTP ${code}` : 'no connection')
          return false
        }
        sent += batch.lines.length
      }
      writeFileSync(cursorPath(file), String(offset + batch.consumed))
    }
  }
  failures = 0
  status('synced', sent ? `${sent} sent` : '')
  if (sent) lastStatus = '' // let the next quiet "synced" through as its own update
  return true
}

function schedule(ms: number): void {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => void tick(), ms)
}

async function tick(): Promise<void> {
  const cfg = sync
  if (!cfg || syncing || halted) return
  syncing = true
  let ok = false
  try { flush(); ok = await syncAll(cfg) } catch (e) { failures++; status('error', String((e as Error)?.message ?? e)) } finally { syncing = false }
  if (sync === cfg && !halted) schedule(ok ? IDLE_MS : backoffMs(failures))
}

type Msg =
  | { kind: 'rec'; file: string; line: string }
  | { kind: 'flush'; id: number }
  | { kind: 'sync-config'; config: SyncConfig | null }
  | { kind: 'sync-now' }

parentPort?.on('message', (m: Msg) => {
  if (m.kind === 'rec') {
    writer.add(m.file, m.line)
    if (writer.size >= FLUSH_AT) flush()
  } else if (m.kind === 'flush') {
    const r = flush()
    parentPort?.postMessage({ kind: 'flushed', id: m.id, written: r.written, failed: r.failed })
  } else if (m.kind === 'sync-config') {
    sync = m.config
    halted = ''
    failures = 0
    lastStatus = ''
    if (syncTimer) clearTimeout(syncTimer)
    if (sync) schedule(1000)
    else status('off')
  } else if (m.kind === 'sync-now') {
    if (sync && !halted) schedule(0)
  }
})
