import { describe, expect, it, vi } from 'vitest'
import { PCM_BATCH_FRAMES, PCM_WORKLET_SOURCE, floatToInt16, openPcmTap, type TapNode } from '../pcmTap'

function fake(opts: { addModuleThrows?: boolean; connectThrows?: boolean } = {}) {
  const connected: unknown[] = []
  const disconnected: unknown[] = []
  const node: TapNode = {
    port: { onmessage: null },
    connect: (n) => { connected.push(n) },
    disconnect: (n) => { disconnected.push(n) },
  }
  const source = {
    connect: (n: unknown) => { if (opts.connectThrows) throw new Error('no'); connected.push(n) },
    disconnect: (n?: unknown) => { disconnected.push(n) },
  }
  const sink = { name: 'sink' }
  const got: Int16Array[] = []
  const deps = {
    context: {
      audioWorklet: {
        addModule: vi.fn(async () => { if (opts.addModuleThrows) throw new Error('refused') }),
      },
    },
    source,
    sink,
    makeNode: () => node,
    onSamples: (s: Int16Array) => { got.push(s) },
    moduleUrl: () => 'blob:fake',
  }
  return { deps, node, source, sink, connected, disconnected, got }
}

describe('floatToInt16', () => {
  it('maps the full range without wrapping', () => {
    expect(Array.from(floatToInt16(Float32Array.from([0, 1, -1])))).toEqual([0, 32767, -32768])
  })

  // A sample over 1 that wrapped would read as loud noise of the opposite sign -- worse than a clip.
  it('clamps rather than wraps a sample outside -1..1', () => {
    expect(Array.from(floatToInt16(Float32Array.from([2, -2, 99])))).toEqual([32767, -32768, 32767])
  })

  it('keeps quiet audio quiet', () => {
    const out = floatToInt16(Float32Array.from([0.5, -0.5]))
    expect(out[0]).toBe(16384)
    expect(out[1]).toBe(-16384)
  })
})

describe('openPcmTap', () => {
  it('routes the audio through the processor to a sink that pulls it', async () => {
    const f = fake()
    const tap = await openPcmTap(f.deps)
    expect(tap).not.toBeNull()
    expect(f.connected).toContain(f.node) // source -> processor
    expect(f.connected).toContain(f.sink) // processor -> something that pulls
  })

  it('converts each posted batch and hands it on', async () => {
    const f = fake()
    await openPcmTap(f.deps)
    f.node.port.onmessage!({ data: Float32Array.from([1, -1, 0]) })
    expect(f.got).toHaveLength(1)
    expect(Array.from(f.got[0]!)).toEqual([32767, -32768, 0])
  })

  it('ignores anything posted that is not a block of frames', async () => {
    const f = fake()
    await openPcmTap(f.deps)
    f.node.port.onmessage!({ data: 'not audio' })
    f.node.port.onmessage!({ data: null })
    expect(f.got).toHaveLength(0)
  })

  // A batch already in flight when the show ends must not land in the next show's buffer.
  it('drops a batch that arrives after it was stopped', async () => {
    const f = fake()
    const tap = await openPcmTap(f.deps)
    const post = f.node.port.onmessage!
    tap!.stop()
    post({ data: Float32Array.from([1]) })
    expect(f.got).toHaveLength(0)
  })

  it('unroutes itself when stopped', async () => {
    const f = fake()
    const tap = await openPcmTap(f.deps)
    tap!.stop()
    expect(f.disconnected).toContain(f.node)
    expect(f.disconnected).toContain(f.sink)
  })

  it('returns null when the graph will not load the processor', async () => {
    const f = fake({ addModuleThrows: true })
    await expect(openPcmTap(f.deps)).resolves.toBeNull()
  })

  it('returns null when the audio cannot be routed into it', async () => {
    const f = fake({ connectThrows: true })
    await expect(openPcmTap(f.deps)).resolves.toBeNull()
  })

  it('batches on a size that keeps message traffic sane', () => {
    expect(PCM_BATCH_FRAMES).toBe(4096)
    expect(PCM_WORKLET_SOURCE).toContain('const BATCH = 4096')
    expect(PCM_WORKLET_SOURCE).toContain("registerProcessor('pcm-tap', PcmTap)")
  })
})
