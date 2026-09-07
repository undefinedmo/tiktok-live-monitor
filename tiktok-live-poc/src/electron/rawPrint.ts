// Raw-print transport: pipe ZPL (or any RAW payload) straight to a Windows printer's
// spooler via a tiny bundled helper (rawlabel.exe → winspool WritePrinter, RAW datatype).
// ~50ms warm per job vs ~1s for webContents.print, and no npm native dependency.
// The helper is compiled from scripts/rawlabel.cs (see that file's build line) and shipped
// via electron-builder extraResources.

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'

/** PRINTER_STATUS_* bits worth naming. The rest are folded into `status` for the log. */
export const PRINTER_STATUS = {
  PAUSED: 0x00000001,
  ERROR: 0x00000002,
  PAPER_JAM: 0x00000008,
  PAPER_OUT: 0x00000010,
  PAPER_PROBLEM: 0x00000040,
  OFFLINE: 0x00000080,
  OUT_OF_MEMORY: 0x00000200,
  DOOR_OPEN: 0x00000400,
  NOT_AVAILABLE: 0x00001000,
  NO_TONER: 0x00040000,
  USER_INTERVENTION: 0x00100000,
} as const

/** Bits that mean a label will NOT come out until a human or the device fixes something. */
const BLOCKING =
  PRINTER_STATUS.PAUSED | PRINTER_STATUS.ERROR | PRINTER_STATUS.PAPER_JAM | PRINTER_STATUS.PAPER_OUT |
  PRINTER_STATUS.PAPER_PROBLEM | PRINTER_STATUS.OFFLINE | PRINTER_STATUS.DOOR_OPEN |
  PRINTER_STATUS.NOT_AVAILABLE | PRINTER_STATUS.NO_TONER | PRINTER_STATUS.USER_INTERVENTION

export function describePrinterStatus(status: number): string {
  if (!status) return 'ready'
  const names = Object.entries(PRINTER_STATUS).filter(([, bit]) => status & bit).map(([n]) => n.toLowerCase())
  return names.length ? names.join('+') : `0x${status.toString(16)}`
}

export const isBlockingStatus = (status: number | undefined): boolean => !!status && (status & BLOCKING) !== 0

export interface RawPrintResult {
  /** The payload was written and the document committed. */
  ok: boolean
  /**
   * A spooler job exists, or MIGHT exist. When true the caller must NOT retry or fall back
   * to the HTML path — doing so prints the label a second time. Only the states where the
   * spooler provably has nothing (helper never spawned, OpenPrinter/StartDoc failed) set
   * this false. A timeout is deliberately `true`: the helper may have committed the job
   * and then hung, and one missing label beats two labels for the same lot.
   */
  committed: boolean
  /** GetPrinter level-2 Status word (PRINTER_STATUS_*), when the helper could read it. */
  status?: number
  /** Jobs queued on the device at dispatch time, when readable. */
  jobs?: number
  detail: string
}

function helperPath(): string {
  // packaged: alongside the app resources; dev: the compiled exe in scripts/
  return app.isPackaged
    ? join(process.resourcesPath, 'rawlabel.exe')
    : join(__dirname, '..', 'scripts', 'rawlabel.exe')
}

/** Parse the helper's single stdout line: "<STATUS> <detail> [status=0xN jobs=N]". */
function parseHelperLine(line: string): { ok: boolean; committed: boolean; status?: number; jobs?: number } {
  const status = /status=0x([0-9a-fA-F]+)/.exec(line)
  const jobs = /jobs=(\d+)/.exec(line)
  const extra = {
    ...(status?.[1] !== undefined ? { status: parseInt(status[1], 16) } : {}),
    ...(jobs?.[1] !== undefined ? { jobs: parseInt(jobs[1], 10) } : {}),
  }
  if (line.startsWith('OK')) return { ok: true, committed: true, ...extra }
  // Nothing reached the spooler in these two — the ONLY states safe to fall back from.
  if (line.startsWith('OPEN_FAILED') || line.startsWith('START_FAILED')) return { ok: false, committed: false, ...extra }
  // WRITE_FAILED (a job was started) and anything unrecognised: assume committed.
  return { ok: false, committed: true, ...extra }
}

/** Send a RAW payload to `printer`. Never rejects, so the caller can decide about fallback
 *  from `committed` rather than from an exception. */
export function sendRawToPrinter(printer: string, payload: string): Promise<RawPrintResult> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(helperPath(), [printer], { windowsHide: true })
    } catch (e) {
      resolve({ ok: false, committed: false, detail: 'spawn: ' + (e as Error).message })
      return
    }
    let settled = false
    const done = (r: RawPrintResult) => { if (!settled) { settled = true; resolve(r) } }
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    // The process never started, so nothing was sent.
    child.on('error', (e) => done({ ok: false, committed: false, detail: 'spawn: ' + e.message }))
    child.on('close', (code) => {
      const line = (out || err).trim()
      const parsed = parseHelperLine(line)
      done({ ...parsed, detail: line || `exit ${code}` })
    })
    // Guard against a hung helper so a print never wedges the serialized print chain. The
    // job may already be committed at this point — a blocked spooler is the likely reason
    // it hung — so `committed: true`. Falling back here is what would double-print.
    const t = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      done({ ok: false, committed: true, detail: 'timeout (job may be spooled)' })
    }, 8000)
    child.on('close', () => clearTimeout(t))
    try { child.stdin.write(Buffer.from(payload, 'utf8')); child.stdin.end() } catch { /* close handler resolves */ }
  })
}

/** Read the printer's state without printing (`--dryrun` opens/closes only). Lets the
 *  watchdog see "paused"/"paper out"/"offline" while the app is idle, instead of only
 *  learning about it from a label that never appears. */
export function probeRawPrinter(printer: string): Promise<{ status?: number; jobs?: number; detail: string }> {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn(helperPath(), [printer, '--dryrun'], { windowsHide: true })
    } catch (e) {
      resolve({ detail: 'spawn: ' + (e as Error).message })
      return
    }
    let settled = false
    const done = (r: { status?: number; jobs?: number; detail: string }) => { if (!settled) { settled = true; resolve(r) } }
    child.stdout.on('data', (d) => (out += d))
    child.on('error', (e) => done({ detail: 'spawn: ' + e.message }))
    child.on('close', () => {
      const line = out.trim()
      const { status, jobs } = parseHelperLine(line)
      done({ ...(status !== undefined ? { status } : {}), ...(jobs !== undefined ? { jobs } : {}), detail: line })
    })
    const t = setTimeout(() => { try { child.kill() } catch { /* ignore */ } done({ detail: 'timeout' }) }, 5000)
    child.on('close', () => clearTimeout(t))
  })
}

/** Fire a no-op open/close so the .NET runtime + winspool are warm before the first real
 *  label (first-ever helper spawn is ~900ms cold, ~50ms after). Best-effort. */
export function warmRawPrinter(printer: string): void {
  try { spawn(helperPath(), [printer, '--dryrun'], { windowsHide: true }).on('error', () => {}) } catch { /* ignore */ }
}
