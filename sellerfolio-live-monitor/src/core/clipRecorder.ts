// The show-audio ring buffer: holds the recorded chunks (the bytes), and reassembles a clip from
// them. Which chunks cover a window is clipBuffer's arithmetic; this adds the blobs and the cap.
// The clock is injected, so nothing here reads one.
import { createClipWindow, pruneChunks, type ChunkMeta } from './clipBuffer'

type StoredChunk = ChunkMeta & { blob: Blob }

export type ExtractedClip = {
  /** WHOLE recorded chunks, concatenated. Never trimmed -- see the contract below. */
  blob: Blob
  /** Epoch seconds at which the FIRST BYTE of `blob` begins. */
  startEpochSec: number
  /** How much audio `blob` holds: the sum of its chunks, so it may run past the requested end. */
  durationSec: number
  /** How much earlier than the request `blob` begins (>= 0): a request landing mid-chunk is
   *  served from that chunk's start. 0 when the buffer did not reach back (`truncated`). */
  leadInSec: number
  /** The buffer did not reach back to the requested start; the clip begins where the buffer does. */
  truncated: boolean
}

/**
 * CONTRACT for whoever sends an extracted clip to the server (Task 5):
 *
 * `extract` does NOT trim bytes. Encoded audio (WebM from MediaRecorder) cannot be cut at an
 * arbitrary second, so the blob always holds whole chunks and `startEpochSec` / `durationSec`
 * describe THOSE BYTES -- not the window that was asked for. A request starting mid-chunk gets
 * that chunk's start (up to one chunk early, `leadInSec`) and the last chunk may run past the
 * requested end. Send `startEpochSec` / `durationSec` as the clip's timestamps; the server plans
 * its window against exactly the audio it receives. Sending the REQUESTED start with these bytes
 * would put the server's window up to one chunk off, on the wrong lot.
 *
 * A chunk pushed at time t covers [t - durationSec, t): ondataavailable fires when a slice has
 * finished recording.
 */
export function makeClipStore(opts: { capSec: number; now: () => number }) {
  let chunks: StoredChunk[] = []
  let seq = 0

  return {
    push(blob: Blob, durationSec: number): void {
      chunks.push({ blob, startEpochSec: opts.now() - durationSec, durationSec, seq: seq++ })
      chunks = pruneChunks(chunks, opts.capSec) as StoredChunk[]
    },

    extract(want: { startEpochSec: number; endEpochSec: number }): ExtractedClip | null {
      const w = createClipWindow(chunks, want)
      if (!w) return null
      const picked = w.chunks as StoredChunk[]
      const first = picked[0]!
      const last = picked[picked.length - 1]!
      return {
        blob: new Blob(picked.map((c) => c.blob)),
        startEpochSec: first.startEpochSec,
        durationSec: last.startEpochSec + last.durationSec - first.startEpochSec,
        leadInSec: w.startEpochSec - first.startEpochSec,
        truncated: w.truncated,
      }
    },

    reset(): void {
      chunks = []
    },
  }
}
