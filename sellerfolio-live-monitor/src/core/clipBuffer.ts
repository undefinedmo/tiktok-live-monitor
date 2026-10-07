// Bookkeeping for the show-audio ring buffer: which recorded chunks cover an absolute-time
// window. Pure arithmetic over chunk metadata -- the bytes live in the renderer, and nothing
// here reads a clock or touches a recorder.

export type ChunkMeta = { startEpochSec: number; durationSec: number; seq: number }

export type ClipWindow = {
  chunks: ChunkMeta[]
  startEpochSec: number
  durationSec: number
  /** The buffer did not reach back to the requested start, so the clip begins later than asked. */
  truncated: boolean
}

export function createClipWindow(
  chunks: ChunkMeta[],
  want: { startEpochSec: number; endEpochSec: number },
  _capSec: number,
): ClipWindow | null {
  const covering = chunks.filter(
    (c) => c.startEpochSec < want.endEpochSec && c.startEpochSec + c.durationSec > want.startEpochSec,
  )
  const first = covering[0]
  if (!first) return null
  const truncated = first.startEpochSec > want.startEpochSec
  const startEpochSec = truncated ? first.startEpochSec : want.startEpochSec
  const last = covering[covering.length - 1]!
  // Never claim audio past what the buffer holds (a request ending at the live edge).
  const endEpochSec = Math.min(want.endEpochSec, last.startEpochSec + last.durationSec)
  return { chunks: covering, startEpochSec, durationSec: endEpochSec - startEpochSec, truncated }
}

/** The newest chunks that fit in capSec of audio; the oldest are dropped first. */
export function pruneChunks(chunks: ChunkMeta[], capSec: number): ChunkMeta[] {
  let total = 0
  let keepFrom = chunks.length
  while (keepFrom > 0) {
    const c = chunks[keepFrom - 1]!
    if (total + c.durationSec > capSec) break
    total += c.durationSec
    keepFrom--
  }
  return chunks.slice(keepFrom)
}
