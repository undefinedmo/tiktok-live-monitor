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
  /**
   * How far the clip's TIMELINE (`durationSec`, last end - first start) disagrees with its AUDIO (the
   * sum of the chunks' own durations), in seconds, to the millisecond. 0 for a healthy recording.
   * Positive: the timeline is longer than the audio -- chunks never arrived (a rebuffer sends
   * zero-size chunks, which are dropped), so the seconds are in the timeline and not in the bytes.
   * Negative: there is more audio than timeline -- the clock stood still while chunks kept coming.
   * Either way the server plans a window against a timeline the bytes do not have; see
   * `clipTimingSuspect`. Not `truncated`, which keeps its one meaning (the buffer began late).
   */
  gapSec: number
}

/**
 * How far the timeline and the audio may disagree before the clip's timing is not to be trusted.
 * Chunks arrive a few hundred ms apart rather than exactly 1 s and a recorder's slices are not exactly
 * their nominal length, so a little is normal; a rebuffer loses whole seconds. Two is above the first
 * and below the second.
 */
export const CLIP_TIMING_TOLERANCE_SEC = 2

/** Does the clip's timeline disagree with its audio by more than the tolerance (either way)? */
export function clipTimingSuspect(clip: { gapSec: number }): boolean {
  return Math.abs(clip.gapSec) > CLIP_TIMING_TOLERANCE_SEC
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
 *
 * A first chunk that cannot yield an init (its read throws, or it STARTS at a Cluster so the init
 * would be empty) is logged and leaves the recording broken: no later chunk is promoted to init --
 * a Cluster-only chunk would make an empty header and every clip silently undecodable -- and
 * `extract` returns null until `reset` (a new recording, with a new header).
 */
export function makeClipStore(opts: { capSec: number; now: () => number }) {
  let chunks: StoredChunk[] = []
  let init: Blob | null = null
  let broken = false // the recording's header was lost; see above
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
          if (broken) return // nothing after a lost header can decode
          const fail = (why: string) => {
            if (gen !== generation) return
            broken = true
            console.error(`clipStore: ${why}; no clip can be served until the recorder restarts`)
          }
          let at: number
          try {
            at = findClusterStart(new Uint8Array(await blob.arrayBuffer()))
          } catch (e) {
            fail(`could not read the first chunk (${(e as Error).message})`)
            return
          }
          if (gen !== generation) return
          if (at === 0) { fail('the first chunk starts at a Cluster, so there is no init segment'); return }
          if (at > 0) { init = blob.slice(0, at); media = blob.slice(at) }
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
      const durationSec = last.startEpochSec + last.durationSec - first.startEpochSec
      const audioSec = picked.reduce((sum, c) => sum + c.durationSec, 0)
      return {
        blob: new Blob([init, ...picked.map((c) => c.blob)]),
        startEpochSec: first.startEpochSec,
        durationSec,
        leadInSec: w.startEpochSec - first.startEpochSec,
        truncated: w.truncated,
        gapSec: Math.round((durationSec - audioSec) * 1000) / 1000,
      }
    },

    reset(): void {
      generation++
      chunks = []
      init = null
      broken = false
      tail = Promise.resolve()
    },
  }
}
