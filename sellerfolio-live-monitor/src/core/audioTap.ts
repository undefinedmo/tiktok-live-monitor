// The show's audio, tapped for identification while the station stays silent.
//
// Measured on the live station 2026-10-09: the player carries `muted` (Chromium autoplays only
// muted media, and an audible station can feed the show back into the broadcast), and a muted
// element is captured as DIGITAL SILENCE. `video.captureStream()` was worse than quiet: it handed
// back a track reporting `enabled`, `muted: false`, `readyState: "live"` and then delivered no
// chunks at all, so the ring buffer never received a container header and EVERY lot settled
// `no_audio`. The same stream through this graph, unmuted, measured RMS 0.003-0.066 -- speech.
//
// `createMediaElementSource` diverts the element's output into the graph, so once the tap exists
// the element no longer reaches the output device and unmuting costs no sound in the room. That is
// why this module may unmute at all, and why the graph is NEVER connected to `context.destination`:
// that one connection is what would put the show on the station's speakers and risk feeding it back
// into the stream. A test asserts its absence.

export type TapElement = { muted: boolean }
export type TapStream = { getAudioTracks: () => unknown[] }
export type TapSourceNode = { connect: (n: unknown) => void; disconnect: (n?: unknown) => void }
export type TapDestinationNode = { stream: TapStream }
export type TapContext = {
  state: string
  /** The output device. Present so this module can be read as never connecting to it. */
  destination: unknown
  resume: () => Promise<void>
  createMediaElementSource: (el: TapElement) => TapSourceNode
  createMediaStreamDestination: () => TapDestinationNode
}
export type AudioTap = {
  stream: TapStream
  /** The node carrying the show audio, for a sample tap to read from. */
  source: TapSourceNode
  /** A node that pulls the graph without reaching the speakers; a processor needs one downstream. */
  sink: TapDestinationNode
  stop: () => void
}

// `createMediaElementSource` throws if it is called twice for one element, and the diversion it sets
// up lasts as long as the context. So the node is made once and kept.
const taps = new WeakMap<TapElement, { source: TapSourceNode; dest: TapDestinationNode }>()

/**
 * Open (or re-open) the capture tap on a media element. Returns null if the graph cannot be built,
 * so a caller that cannot capture carries on without audio rather than throwing.
 */
export async function openAudioTap(opts: {
  element: TapElement
  context: TapContext
}): Promise<AudioTap | null> {
  const { element, context } = opts
  let held = taps.get(element)
  if (!held) {
    try {
      const source = context.createMediaElementSource(element)
      held = { source, dest: context.createMediaStreamDestination() }
    } catch {
      return null
    }
    taps.set(element, held)
  }
  // Connected on every open, not only the first: a stopped tap disconnects, and re-opening must
  // restore the route. Connecting an already-connected pair is a no-op.
  try {
    held.source.connect(held.dest)
  } catch {
    return null
  }
  // A context created before any user gesture starts suspended, and a suspended context delivers
  // no audio whatsoever -- the failure this module exists to end.
  if (context.state === 'suspended') {
    try {
      await context.resume()
    } catch {
      /* best effort: a context that will not resume still yields a stream, just a silent one */
    }
  }
  // Un-zero the audio. Safe only because the element's output is diverted into the graph above.
  element.muted = false
  const { source, dest } = held
  return {
    stream: dest.stream,
    source,
    sink: dest,
    stop: () => {
      // Quiet again, and the element left as the markup had it.
      element.muted = true
      try {
        source.disconnect(dest)
      } catch {
        /* already disconnected */
      }
    },
  }
}
