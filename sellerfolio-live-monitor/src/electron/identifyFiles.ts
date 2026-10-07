// The disk under the identification store and settings. Kept apart from main.ts so it can be
// tested against a real directory; everything that decides WHAT to write lives in core/.
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { StoreIO } from '../core/identifyStore'
import { parseIdentifySettings, serializeIdentifySettings, type IdentifySettings, type IdentifySettingsRead } from '../core/identifySettings'

/** Write via a temp file and a rename, so a power cut leaves the old file or the new one, never half of either. */
export function atomicWrite(path: string, text: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, text)
    renameSync(tmp, path)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* nothing to clean */ }
    throw e
  }
}

/** A file this large is not an identifications log: ~2000 rows is about 1 MB. Past it, only the tail is read. */
export const MAX_READ_BYTES = 8 * 1024 * 1024

export function nodeStoreIO(path: string, maxReadBytes = MAX_READ_BYTES): StoreIO {
  return {
    read() {
      let size: number
      try {
        size = statSync(path).size
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
      if (size <= maxReadBytes) return readFileSync(path, 'utf8')
      // Runaway or corrupt: read the newest part only. It starts mid-line; the store skips that line.
      const fd = openSync(path, 'r')
      try {
        const buf = Buffer.alloc(maxReadBytes)
        const n = readSync(fd, buf, 0, maxReadBytes, size - maxReadBytes)
        return buf.subarray(0, n).toString('utf8')
      } finally {
        closeSync(fd)
      }
    },
    append(text) {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, text)
    },
    replace(text) {
      atomicWrite(path, text)
    },
  }
}

/** identify.json: absent is "defaults"; present but unreadable is "damaged", which reads as OFF. */
export function loadIdentifySettings(path: string): IdentifySettingsRead {
  try {
    return parseIdentifySettings(readFileSync(path, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return parseIdentifySettings(null)
    return { ...parseIdentifySettings(''), damaged: true }
  }
}

export function saveIdentifySettings(path: string, s: IdentifySettings): boolean {
  try {
    atomicWrite(path, serializeIdentifySettings(s))
    return true
  } catch {
    return false
  }
}
