// The show-audio ring buffer: holds the recorded chunks (the bytes), and reassembles a clip from
// them. Which chunks cover a window is clipBuffer's arithmetic; this adds the blobs and the cap.
// The clock is injected, so nothing here reads one.
import { createClipWindow, pruneChunks, type ChunkMeta } from './clipBuffer'

type StoredChunk = ChunkMeta & { blob: Blob }

// The EBML id of a WebM Cluster: the first Cluster is where the init segment (EBML header, Segment,
// Info, Tracks) ends and audio begins.
const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75]

/** Index of the first WebM Cluster id in `bytes`, or -1. */
export function findClusterStart(bytes: Uint8Array): number {
  for (let i = 0; i + CLUSTER_ID.length <= bytes.length; i++) {
    if (CLUSTER_ID.every((b, k) => bytes[i + k] === b)) return i
  }
  return -1
}

export type ExtractedClip = {
  /** The init segment, then WHOLE recorded chunks. Never trimmed -- see the contract below. */
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
 *
 * INIT SEGMENT. Only a recorder's FIRST chunk carries the container header; later chunks are raw
 * slices of the stream, so a ring buffer that has pruned the first chunk holds nothing decodable.
 * The store therefore keeps the header apart from the chunks -- outside the cap, for the life of the
 * recording -- and `extract` puts it in front: blob = [init, ...chunks]. The init is the first
 * chunk's bytes BEFORE its first Cluster id; the Cluster onward stays a normal chunk, so it is not
 * heard twice. If the first chunk holds no Cluster id it is kept whole as the init (a slightly long
 * clip beats none) and contributes no chunk of its own.
 * The header's duration field is stale: ffprobe reports the recording's original length, not the
 * clip's. Harmless -- the server trusts the clip's `durationSec` (meta.clipDurationSec).
 *
 * `push` is async because reading the first chunk is; it never rejects, and chunks are inserted in
 * push order. Until the first chunk has been read there is no init, so `extract` returns null.
 */
export function makeClipStore(opts: { capSec: number; now: () => number }) {
  let chunks: StoredChunk[] = []
  let init: Blob | null = null
  let seq = 0
  let generation = 0 // bumped by reset(): a push still reading its blob must not land in the next show
  let tail: Promise<void> = Promise.resolve()

  return {
    push(blob: Blob, durationSec: number): Promise<void> {
      const startEpochSec = opts.now() - durationSec
      const mySeq = seq++
      const gen = generation
      const job = tail.then(async () => {
        if (gen !== generation) return
        let media: Blob | null = blob
        if (init === null) {
          const at = findClusterStart(new Uint8Array(await blob.arrayBuffer()))
          if (gen !== generation) return
          if (at >= 0) { init = blob.slice(0, at); media = blob.slice(at) }
          else { init = blob; media = null }
        }
        if (media) {
          chunks.push({ blob: media, startEpochSec, durationSec, seq: mySeq })
          chunks = pruneChunks(chunks, opts.capSec) as StoredChunk[]
        }
      }).catch(() => { /* an unreadable chunk is a gap, not a crash */ })
      tail = job
      return job
    },

    extract(want: { startEpochSec: number; endEpochSec: number }): ExtractedClip | null {
      if (init === null) return null
      const w = createClipWindow(chunks, want)
      if (!w) return null
      const picked = w.chunks as StoredChunk[]
      const first = picked[0]!
      const last = picked[picked.length - 1]!
      return {
        blob: new Blob([init, ...picked.map((c) => c.blob)]),
        startEpochSec: first.startEpochSec,
        durationSec: last.startEpochSec + last.durationSec - first.startEpochSec,
        leadInSec: w.startEpochSec - first.startEpochSec,
        truncated: w.truncated,
      }
    },

    reset(): void {
      generation++
      chunks = []
      init = null
      tail = Promise.resolve()
    },
  }
}
