// The show journal: an append-only record of what happened in a show — every auction's
// start and end (sold, unsold or unknown), every close signal, every confirmed order row and
// every label — one JSON object per line, one file per live room.
//
// Why a journal and not a database: the app shed its SQLite layer and every native dependency
// in af0fad9, and nothing here needs a query engine. It needs to survive a restart, be cheap
// to write, and be shippable to SellerFolio later; an append-only file with a stable id per
// line is all three, and the sync can treat it as an outbox.
//
// THE RULE: recording must never cost a label any time. `record()` builds one small string
// and posts it to a worker thread — no disk call, no await, no throw. All I/O is in
// journalWorker.ts. If the worker dies or the disk fails, labels print exactly as before.

import { Worker } from 'node:worker_threads'
import { join } from 'node:path'

interface Context { room?: string; session?: string; sessionName?: string }

let worker: Worker | null = null
let source = ''
let dir = ''
let runId = ''
let seq = 0
let ctx: Context = {}
let file = ''
let restarts = 0
let report: (line: string) => void = () => {}
const waiters = new Map<number, (ok: boolean) => void>()
let flushSeq = 0

const MAX_RESTARTS = 3

function spawn(): void {
  try {
    const w = new Worker(source, { eval: true })
    w.unref() // the journal must never be what keeps the app from quitting
    w.on('message', (m: { kind: string; id?: number; failed?: number; message?: string }) => {
      if (m.kind === 'flushed' && m.id !== undefined) { waiters.get(m.id)?.(!m.failed); waiters.delete(m.id) }
      else if (m.kind === 'error') report(`[journal] ${m.message ?? 'write error'}`)
      else if (m.kind === 'recovered') report('[journal] writes recovered')
    })
    w.on('error', (e) => report(`[journal] worker error: ${String((e as Error)?.message ?? e)}`))
    w.on('exit', (code) => {
      if (worker !== w) return // replaced or closed on purpose
      worker = null
      for (const done of waiters.values()) done(false)
      waiters.clear()
      if (restarts < MAX_RESTARTS) {
        restarts++
        report(`[journal] worker exited (${code}) — restarting (${restarts}/${MAX_RESTARTS})`)
        setTimeout(spawn, 2000).unref()
      } else {
        report(`[journal] worker exited (${code}) — giving up; the show is no longer being recorded`)
      }
    })
    worker = w
  } catch (e) {
    worker = null
    report(`[journal] could not start: ${String((e as Error)?.message ?? e)}`)
  }
}

function currentFile(): string {
  if (!file) {
    // One file per live room. Records that arrive before the room is known (app launched
    // early, or never attached) go to a dated catch-all rather than being lost.
    const name = ctx.room ? `show-${ctx.room}.jsonl` : `unassigned-${new Date().toISOString().slice(0, 10)}.jsonl`
    file = join(dir, name)
  }
  return file
}

/** Start the journal. `workerSource` is the bundled journalWorker as a string. Never throws. */
export function initJournal(directory: string, workerSource: string, onReport?: (line: string) => void): void {
  dir = directory
  source = workerSource
  runId = Date.now().toString(36)
  seq = 0
  restarts = 0
  file = ''
  ctx = {}
  if (onReport) report = onReport
  spawn()
}

/** Which show the following records belong to. Changing the room starts a new file. */
export function setJournalContext(next: Context): void {
  if (next.room !== ctx.room) file = ''
  ctx = { ...ctx, ...next }
}

/** Queue one record. Constant-time on the calling thread; never blocks, never throws. */
export function record(type: string, data: object = {}): void {
  const w = worker
  if (!w) return
  try {
    const line = JSON.stringify({ v: 1, id: `${runId}-${++seq}`, t: Date.now(), room: ctx.room, session: ctx.session, type, ...data })
    w.postMessage({ kind: 'rec', file: currentFile(), line })
  } catch { /* the journal is best-effort by design */ }
}

/** Ask the worker to write what it holds. Resolves false on timeout, failure, or no worker. */
export function flushJournal(timeoutMs = 1500): Promise<boolean> {
  const w = worker
  if (!w) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const id = ++flushSeq
    const timer = setTimeout(() => { waiters.delete(id); resolve(false) }, timeoutMs)
    waiters.set(id, (ok) => { clearTimeout(timer); resolve(ok) })
    try { w.postMessage({ kind: 'flush', id }) } catch { clearTimeout(timer); waiters.delete(id); resolve(false) }
  })
}

/** Flush and stop (tests, and a deliberate shutdown). */
export async function closeJournal(): Promise<void> {
  const w = worker
  if (!w) return
  await flushJournal()
  worker = null
  await w.terminate()
}

export function journalFile(): string {
  return worker ? currentFile() : ''
}
