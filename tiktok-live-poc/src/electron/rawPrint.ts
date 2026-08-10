// Raw-print transport: pipe ZPL (or any RAW payload) straight to a Windows printer's
// spooler via a tiny bundled helper (rawlabel.exe → winspool WritePrinter, RAW datatype).
// ~50ms warm per job vs ~1s for webContents.print, and no npm native dependency.
// The helper is compiled from scripts/rawlabel.cs (see that file's build line) and shipped
// via electron-builder extraResources.

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'

function helperPath(): string {
  // packaged: alongside the app resources; dev: the compiled exe in scripts/
  return app.isPackaged
    ? join(process.resourcesPath, 'rawlabel.exe')
    : join(__dirname, '..', 'scripts', 'rawlabel.exe')
}

/** Send a RAW payload to `printer`. Resolves { ok } — never rejects, so the caller can
 *  cleanly fall back to the HTML path on any failure. */
export function sendRawToPrinter(printer: string, payload: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(helperPath(), [printer], { windowsHide: true })
    } catch (e) {
      resolve({ ok: false, detail: 'spawn: ' + (e as Error).message })
      return
    }
    const done = (r: { ok: boolean; detail: string }) => resolve(r)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => done({ ok: false, detail: 'spawn: ' + e.message }))
    child.on('close', (code) => done({ ok: code === 0 && out.startsWith('OK'), detail: (out || err).trim() || `exit ${code}` }))
    // Guard against a hung helper so a print never wedges the serialized print chain.
    const t = setTimeout(() => { try { child.kill() } catch { /* ignore */ } done({ ok: false, detail: 'timeout' }) }, 8000)
    child.on('close', () => clearTimeout(t))
    try { child.stdin.write(Buffer.from(payload, 'utf8')); child.stdin.end() } catch { /* close handler resolves */ }
  })
}

/** Fire a no-op open/close so the .NET runtime + winspool are warm before the first real
 *  label (first-ever helper spawn is ~900ms cold, ~50ms after). Best-effort. */
export function warmRawPrinter(printer: string): void {
  try { spawn(helperPath(), [printer, '--dryrun'], { windowsHide: true }).on('error', () => {}) } catch { /* ignore */ }
}
