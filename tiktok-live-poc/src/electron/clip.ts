// ffmpeg AUDIO clip builder: ~60s of AAC/ADTS ENDING at the sale moment, from a
// signed Seller-Center .m3u8 video receipt. Returns the raw bytes (or null). ffmpeg is on PATH.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const CLIP_SECONDS = 60

/** Pure half: seek = atEpochSec - streamStartFromPDT - 60, clamped at 0. (Ported from live-ledger.) */
export function parseSeekFromM3u8(m3u8Text: string, atEpochSec: number): number {
  const m = /EXT-X-PROGRAM-DATE-TIME:(\S+)/.exec(m3u8Text)
  if (!m || !m[1]) return 0
  const start = Date.parse(m[1].replace('Z', '+00:00'))
  if (Number.isNaN(start)) return 0
  return Math.max(0, atEpochSec - start / 1000 - CLIP_SECONDS)
}

// Module-scoped counter for unique temp file names (no Math.random/Date.now reliance).
let clipCounter = 0

/** Extract ~60s of AUDIO (AAC/ADTS) ending at the sale moment from the signed m3u8.
 *  Returns the bytes, or null on ffmpeg error / empty output. */
export async function buildAudioClip(m3u8Url: string, atEpochSec: number | null): Promise<Uint8Array | null> {
  let ss = 0
  if (atEpochSec) {
    try {
      const res = await fetch(m3u8Url)
      ss = parseSeekFromM3u8(await res.text(), atEpochSec)
    } catch {
      ss = 0
    }
  }
  const outPath = join(tmpdir(), `tt-clip-${process.pid}-${clipCounter++}.aac`)
  const args = [
    '-nostdin', '-loglevel', 'error', '-y',
    ...(ss > 0 ? ['-ss', String(ss)] : []),
    '-i', m3u8Url,
    '-t', '60', '-vn', '-c:a', 'aac', '-b:a', '96k', '-f', 'adts', outPath,
  ]
  const code = await new Promise<number>((resolve) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    p.on('error', () => resolve(-1))
    p.on('close', (c) => resolve(c ?? -1))
  })
  try {
    if (code !== 0 || !existsSync(outPath) || statSync(outPath).size === 0) {
      if (existsSync(outPath)) unlinkSync(outPath)
      return null
    }
    const bytes = readFileSync(outPath)
    unlinkSync(outPath)
    return new Uint8Array(bytes)
  } catch {
    try { if (existsSync(outPath)) unlinkSync(outPath) } catch { /* ignore */ }
    return null
  }
}
