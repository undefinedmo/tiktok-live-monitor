// The journal's disk thread. Everything that touches the filesystem for the show journal
// happens here, so a slow, locked or full disk can never delay a label: the main thread's
// whole involvement is one postMessage per record.
//
// Bundled separately and handed to `new Worker(source, { eval: true })` as a string (see
// esbuild.mjs), so there is no worker file to resolve inside the packaged app.asar.

import { parentPort } from 'node:worker_threads'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { JournalWriter } from '../core/journalWriter'

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

parentPort?.on('message', (m: { kind: 'rec'; file: string; line: string } | { kind: 'flush'; id: number }) => {
  if (m.kind === 'rec') {
    writer.add(m.file, m.line)
    if (writer.size >= FLUSH_AT) flush()
  } else if (m.kind === 'flush') {
    const r = flush()
    parentPort?.postMessage({ kind: 'flushed', id: m.id, written: r.written, failed: r.failed })
  }
})
