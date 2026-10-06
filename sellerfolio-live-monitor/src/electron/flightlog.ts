// Flight recorder: always-on, buffered, rotating run log so EVERY show is a
// postmortem-ready dataset — no TT_LAT/TT_DEBUG env needed in the packaged app.
// Lines buffer in memory and flush once per second via async appendFile, so the
// main thread (which also dispatches print jobs) never blocks on disk I/O — the
// reason production logging was previously off entirely.

import { appendFile, appendFileSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024 // per-run cap; a full 3h show with census is ~1-2MB
const KEEP_RUNS = 10

let file = ''
let buf: string[] = []
let bytes = 0
let capped = false

/** Create the run log (pruning old runs) and start the 1s flush loop. Returns the path. */
export function initFlightLog(dir: string, header: string): string {
  try {
    mkdirSync(dir, { recursive: true })
    const runs = readdirSync(dir).filter((f) => f.startsWith('run-') && f.endsWith('.log')).sort()
    for (const f of runs.slice(0, Math.max(0, runs.length - (KEEP_RUNS - 1)))) {
      try { unlinkSync(join(dir, f)) } catch { /* ignore */ }
    }
    file = join(dir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
    writeFileSync(file, header + '\n')
    setInterval(() => flush(false), 1000).unref()
  } catch {
    file = '' // recorder must never break the app — degrade to no-op
  }
  return file
}

export function flightLogPath(): string {
  return file
}

/** Queue one line (timestamped). Never throws, never blocks. */
export function flog(line: string): void {
  if (!file || capped) return
  buf.push(`${new Date().toISOString().slice(11, 23)} ${line}`)
}

/** Synchronous flush for quit/crash paths — the buffer must not die with the process. */
export function flushFlightLogSync(): void {
  flush(true)
}

function flush(sync: boolean): void {
  if (!file || capped || !buf.length) return
  const chunk = buf.join('\n') + '\n'
  buf = []
  bytes += Buffer.byteLength(chunk)
  if (bytes > MAX_BYTES) {
    capped = true
    const note = chunk + `--- log capped at ${MAX_BYTES} bytes ---\n`
    try { appendFileSync(file, note) } catch { /* ignore */ }
    return
  }
  if (sync) {
    try { appendFileSync(file, chunk) } catch { /* ignore */ }
  } else {
    appendFile(file, chunk, () => {})
  }
}
