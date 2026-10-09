// Reads the show's samples off the audio graph and hands them over as Int16.
//
// The processor itself is deliberately the dumbest thing that works: it batches the frames it is
// given and posts them on. Every decision -- the conversion, the batch size, what happens to a
// batch that arrives while the tap is stopping -- lives out here, where it is tested. A worklet runs
// in its own realm and cannot be unit-tested, so nothing that can be got wrong belongs inside it.

/** Frames per batch. At 16 kHz this is ~256 ms: few enough messages, fine enough timing. */
export const PCM_BATCH_FRAMES = 4096

export const PCM_WORKLET_NAME = 'pcm-tap'

/**
 * The AudioWorkletProcessor source, loaded as a module at run time. It posts Float32 frames; the
 * conversion to Int16 happens in `floatToInt16`, which is tested, rather than being written twice.
 */
export const PCM_WORKLET_SOURCE = [
  'const BATCH = ' + PCM_BATCH_FRAMES,
  'class PcmTap extends AudioWorkletProcessor {',
  '  constructor() { super(); this.buf = new Float32Array(BATCH); this.n = 0 }',
  '  process(inputs) {',
  '    const ch = inputs[0] && inputs[0][0]',
  '    if (ch) {',
  '      for (let i = 0; i < ch.length; i++) {',
  '        this.buf[this.n++] = ch[i]',
  '        if (this.n === BATCH) {',
  '          const out = this.buf.slice(0, BATCH)',
  '          this.port.postMessage(out, [out.buffer])',
  '          this.n = 0',
  '        }',
  '      }',
  '    }',
  '    return true',
  '  }',
  '}',
  "registerProcessor('" + PCM_WORKLET_NAME + "', PcmTap)",
].join('\n')

/**
 * Float samples (-1..1) to signed 16-bit. Out-of-range input is clamped rather than wrapped: a
 * sample above 1 that wrapped would read as loud noise of the opposite sign, which is worse than a
 * clip. The two directions scale by different amounts because the signed range is asymmetric.
 */
export function floatToInt16(frames: Float32Array): Int16Array {
  const out = new Int16Array(frames.length)
  for (let i = 0; i < frames.length; i++) {
    const s = Math.max(-1, Math.min(1, frames[i]!))
    out[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff)
  }
  return out
}

/** Make the module URL for the processor above. Here rather than in the renderer, which may not
 *  build blobs (a guard test enforces that). */
export function pcmWorkletModuleUrl(): string {
  return URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' }))
}

export type TapNode = {
  port: { onmessage: ((e: { data: unknown }) => void) | null }
  connect: (n: unknown) => void
  disconnect: (n?: unknown) => void
}

export type PcmTapDeps = {
  context: { audioWorklet: { addModule: (url: string) => Promise<void> } }
  /** The node carrying the show audio. */
  source: { connect: (n: unknown) => void; disconnect: (n?: unknown) => void }
  /** Something downstream that pulls the graph, so the processor is actually run. NEVER the speakers. */
  sink: unknown
  makeNode: () => TapNode
  onSamples: (samples: Int16Array) => void
  moduleUrl?: () => string
}

/**
 * Start reading samples. Returns null if the graph will not take the processor, so a station that
 * cannot capture carries on printing labels rather than throwing.
 */
export async function openPcmTap(deps: PcmTapDeps): Promise<{ stop: () => void } | null> {
  let node: TapNode
  try {
    await deps.context.audioWorklet.addModule((deps.moduleUrl ?? pcmWorkletModuleUrl)())
    node = deps.makeNode()
  } catch {
    return null
  }
  let live = true
  node.port.onmessage = (e) => {
    // A batch posted before stop() can still be delivered after it; it is not wanted.
    if (!live) return
    const data = e.data
    if (data instanceof Float32Array) deps.onSamples(floatToInt16(data))
  }
  try {
    deps.source.connect(node)
    // The graph only runs what something pulls, so the processor needs a consumer downstream.
    node.connect(deps.sink)
  } catch {
    return null
  }
  return {
    stop: () => {
      live = false
      node.port.onmessage = null
      try {
        deps.source.disconnect(node)
        node.disconnect(deps.sink)
      } catch {
        /* already gone */
      }
    },
  }
}
