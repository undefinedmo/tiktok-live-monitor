// The disk under Retry: clips that failed to identify, kept so a retry has the audio after a restart or once
// the 5-minute buffer has moved on. Everything that decides WHAT is kept, how it is named, what is read back
// and what is evicted lives in core/identifyKept (tested); this only does the file operations, and none of it
// may throw into the show -- every method answers false / null / [] instead.
//
// Two files per clip: `<stem>.bin` (the audio) then `<stem>.json` (its meta). Each is written to a temp file
// and renamed, and the meta goes LAST and records the audio's length, so a clip is complete exactly when both
// exist and agree. A crash between the two leaves an orphan or a mismatch, which reads as "not kept".
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  chooseEvictions,
  keptStem,
  metaFromWire,
  parseKeptMeta,
  wireFromKept,
  type KeptMeta,
} from '../core/identifyKept'
import type { IdentifyJob } from '../core/identifyClient'
import type { WireClip } from '../core/identifySend'
import { atomicWrite } from './identifyFiles'

export type ClipKeeper = {
  /** Keep a clip that failed. False when it was refused or could not be written. Never throws. */
  keep(payload: { job: IdentifyJob; clip: WireClip }): boolean
  /** The kept clip for an order, or null (never kept, damaged, or not the order it says). Never throws. */
  load(orderId: string): { job: IdentifyJob; clip: WireClip } | null
  /** Delete an order's kept clip. Never throws. */
  drop(orderId: string): void
  /** The orders that can really be loaded. Never throws. */
  list(): string[]
  /** Delete every kept clip (identification was switched off). Never throws. */
  clear(): void
}

export function createClipKeeper(dir: string, opts: { now: () => number }): ClipKeeper {
  const bin = (stem: string) => join(dir, `${stem}.bin`)
  const json = (stem: string) => join(dir, `${stem}.json`)
  const rmFile = (path: string) => {
    try {
      rmSync(path, { force: true })
    } catch {
      /* nothing to remove, or it cannot be: the next prune tries again */
    }
  }
  const dropStem = (stem: string) => {
    rmFile(bin(stem))
    rmFile(json(stem))
  }

  /** The meta of a stem whose two files are present, agree on the audio's length, and name this stem. */
  function readMeta(stem: string): KeptMeta | null {
    try {
      const meta = parseKeptMeta(JSON.parse(readFileSync(json(stem), 'utf8')))
      if (!meta || keptStem(meta.orderId) !== stem) return null
      if (statSync(bin(stem)).size !== meta.byteLength) return null
      return meta
    } catch {
      return null
    }
  }

  const stems = (): string[] => {
    try {
      return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length))
    } catch {
      return []
    }
  }

  /** Delete what is over a limit, and what is not a whole clip. */
  function prune(): void {
    const valid: Array<{ stem: string; savedAtMs: number; bytes: number }> = []
    for (const stem of stems()) {
      const m = readMeta(stem)
      if (m) valid.push({ stem, savedAtMs: m.savedAtMs, bytes: m.byteLength })
      else dropStem(stem) // a clip that cannot be read is not a clip
    }
    for (const stem of chooseEvictions(valid, opts.now())) dropStem(stem)
    // Audio with no meta: a write that was cut short.
    try {
      const have = new Set(stems())
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.bin') && !have.has(f.slice(0, -'.bin'.length))) rmFile(join(dir, f))
      }
    } catch {
      /* the folder is gone: nothing to tidy */
    }
  }

  return {
    keep(payload) {
      try {
        const meta = metaFromWire(payload, opts.now())
        if (!meta) return false
        const stem = keptStem(meta.orderId)
        try {
          mkdirSync(dir, { recursive: true })
          atomicWrite(bin(stem), payload.clip.bytes)
          atomicWrite(json(stem), JSON.stringify(meta)) // last: the clip exists once this does
        } catch {
          dropStem(stem)
          return false
        }
        prune()
        return true
      } catch {
        return false
      }
    },

    load(orderId) {
      try {
        if (typeof orderId !== 'string' || !orderId) return null
        const stem = keptStem(orderId)
        const meta = readMeta(stem)
        if (!meta || meta.orderId !== orderId) return null
        const bytes = new Uint8Array(readFileSync(bin(stem))) as Uint8Array<ArrayBuffer>
        return wireFromKept(meta, bytes)
      } catch {
        return null
      }
    },

    drop(orderId) {
      try {
        if (typeof orderId === 'string' && orderId) dropStem(keptStem(orderId))
      } catch {
        /* nothing to drop */
      }
    },

    list() {
      const out: string[] = []
      for (const stem of stems()) {
        const m = readMeta(stem)
        if (m) out.push(m.orderId)
      }
      return out
    },

    clear() {
      try {
        if (!existsSync(dir)) return
        for (const f of readdirSync(dir)) {
          if (/\.(json|bin|tmp)$/.test(f)) rmFile(join(dir, f))
        }
      } catch {
        /* nothing to clear */
      }
    },
  }
}
