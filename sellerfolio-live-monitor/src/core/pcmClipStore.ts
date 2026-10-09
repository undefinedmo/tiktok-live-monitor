// The show-audio ring buffer, as raw samples rather than encoded WebM.
//
// It used to hold MediaRecorder's own output and splice the chosen chunks onto the recording's init
// segment. Measured on the live station 2026-10-09, that cannot work: Chromium's muxer writes
// audio-only Opus as ONE open-ended Cluster, so a 1 s timeslice is an arbitrary byte cut through the
// middle of it. Of nine consecutive chunks, NONE began at a Cluster and only the first contained a
// Cluster ID at all. `init + chunks[k..m]` is therefore valid only when k is 0, and every other lot
// reached the server as a corrupt container: "Length 5 indicated by an EBML number's first byte 0x0b
// at pos 157", "Truncating packet of size 666945", "Error opening input: End of file".
//
// Samples have no container, so there is nothing to splice and nothing to align: a window is a
// subarray, cut to the sample. That also removes the old contract's two concessions -- `leadInSec`
// (a request landing mid-chunk was served from that chunk's start) is now always 0, and the clip's
// own timestamps describe exactly the window that was asked for.
//
// 16 kHz mono: speech is well under the Nyquist limit at that rate, and it is a third of the bytes of
// the 48 kHz capture. A 60 s clip is 1.9 MB of WAV, which ffmpeg reads without a hint.

/** The rate clips are stored and sent at. Speech, at a third of the capture rate's bytes. */
export const CLIP_SAMPLE_RATE = 16000

/** A stall shorter than this is ordinary scheduling jitter, not lost audio. */
const JITTER_SEC = 0.05

const WAV_HEADER_BYTES = 44

/** Mono 16-bit PCM in a WAV container -- the smallest thing ffmpeg will read without being told. */
export function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * 2
  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(out.buffer)
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true) // everything after this field
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM, uncompressed
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  new Int16Array(out.buffer, WAV_HEADER_BYTES, samples.length).set(samples)
  return out
}

export type PcmClip = {
  blob: Blob
  startEpochSec: number
  durationSec: number
  /** Always 0: samples are cut exactly where the window asked. Kept so the clip reads as before. */
  leadInSec: number
  truncated: boolean
  /** Seconds of silence inside this window that stood in for audio that never arrived. */
  gapSec: number
}

/**
 * A fixed-length ring of samples on a LINEAR time axis. A stall is filled with silence rather than
 * closed up: if the axis shifted, every later window would be cut from the wrong moment, which is
 * the one failure this whole path exists to avoid.
 */
export function makePcmClipStore(opts: { sampleRate?: number; capSec: number; now: () => number }) {
  const rate = opts.sampleRate ?? CLIP_SAMPLE_RATE
  const cap = Math.max(1, Math.round(opts.capSec * rate))
  const ring = new Int16Array(cap)
  /** Samples ever written; the ring holds the last `cap` of them. An absolute index is a position
   *  in this sequence, so it survives the ring wrapping. */
  let written = 0
  /** The epoch second at absolute index `written` -- the exclusive end of the newest sample. */
  let endEpochSec = 0
  /** Silence stood in for audio over these absolute index ranges. Rare, so a list is enough. */
  let gaps: { from: number; to: number }[] = []

  const oldest = () => Math.max(0, written - cap)
  const atEpoch = (abs: number) => endEpochSec - (written - abs) / rate
  const atIndex = (sec: number) => Math.round(written - (endEpochSec - sec) * rate)

  const write = (samples: Int16Array) => {
    for (let i = 0; i < samples.length; i++) ring[(written + i) % cap] = samples[i]!
    written += samples.length
  }

  const fill = (count: number) => {
    const from = written
    for (let i = 0; i < count; i++) ring[(written + i) % cap] = 0
    written += count
    gaps.push({ from, to: written })
    // Ranges the ring no longer holds cannot be reported on.
    const keep = oldest()
    gaps = gaps.filter((g) => g.to > keep)
  }

  return {
    /** `samples` END at `now()`, matching the old store: audio is handed over once it is recorded. */
    push(samples: Int16Array): void {
      if (!samples.length) return
      const now = opts.now()
      const startsAt = now - samples.length / rate
      if (written === 0) {
        endEpochSec = startsAt
      } else {
        const stall = startsAt - endEpochSec
        // A negative stall is a clock that stepped back or audio that overlaps: take the audio and
        // leave the axis alone rather than rewriting history.
        if (stall > JITTER_SEC) fill(Math.min(cap, Math.round(stall * rate)))
      }
      write(samples)
      endEpochSec = now
    },

    extract(want: { startEpochSec: number; endEpochSec: number }): PcmClip | null {
      if (written === 0) return null
      const low = oldest()
      const wantedStart = atIndex(want.startEpochSec)
      const from = Math.min(Math.max(wantedStart, low), written)
      const to = Math.min(Math.max(atIndex(want.endEpochSec), low), written)
      if (to <= from) return null // the window does not overlap the audio held
      const samples = new Int16Array(to - from)
      for (let i = 0; i < samples.length; i++) samples[i] = ring[(from + i) % cap]!
      const silence = gaps.reduce(
        (sum, g) => sum + Math.max(0, Math.min(g.to, to) - Math.max(g.from, from)),
        0,
      )
      return {
        blob: new Blob([encodeWav(samples, rate)]),
        startEpochSec: atEpoch(from),
        durationSec: samples.length / rate,
        leadInSec: 0,
        truncated: wantedStart < low,
        gapSec: silence === 0 ? 0 : silence / rate,
      }
    },

    reset(): void {
      written = 0
      endEpochSec = 0
      gaps = []
    },

    /** For the capture lights: is there audio to cut a clip from at all? */
    get hasAudio(): boolean {
      return written > 0
    },
  }
}
