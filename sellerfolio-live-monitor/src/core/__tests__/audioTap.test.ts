import { describe, expect, it, vi } from 'vitest'
import { openAudioTap, type TapContext, type TapElement } from '../audioTap'

/** A fake audio graph that records every connection, so a test can prove where the audio went. */
function fakeGraph(opts: { state?: 'running' | 'suspended'; sourceThrows?: boolean } = {}) {
  const connected: unknown[] = []
  const disconnected: unknown[] = []
  const source = {
    connect: (n: unknown) => { connected.push(n) },
    disconnect: (n?: unknown) => { disconnected.push(n) },
  }
  const speakers = { name: 'speakers' }
  const dest = { stream: { getAudioTracks: () => [{ kind: 'audio' }] } }
  const createMediaElementSource = vi.fn(() => {
    if (opts.sourceThrows) throw new Error('already connected')
    return source
  })
  const resume = vi.fn(async () => { ctx.state = 'running' })
  const ctx: TapContext = {
    state: opts.state ?? 'running',
    destination: speakers,
    resume,
    createMediaElementSource,
    createMediaStreamDestination: () => dest,
  }
  return { ctx, source, speakers, dest, connected, disconnected, createMediaElementSource, resume }
}

const element = (): TapElement => ({ muted: true })

describe('openAudioTap', () => {
  it('hands back the stream a MediaStreamDestination carries', async () => {
    const g = fakeGraph()
    const tap = await openAudioTap({ element: element(), context: g.ctx })
    expect(tap?.stream).toBe(g.dest.stream)
  })

  // The station watches a live broadcast. Routing the show to its speakers can feed straight back
  // into the stream, so the capture graph must never reach the output device.
  it('never connects the show audio to the speakers', async () => {
    const g = fakeGraph()
    await openAudioTap({ element: element(), context: g.ctx })
    expect(g.connected).toContain(g.dest)
    expect(g.connected).not.toContain(g.speakers)
  })

  // Measured on the live station: while the element was muted the captured audio was digital silence
  // (RMS exactly 0); unmuted it was speech. createMediaElementSource diverts the element's output into
  // the graph, so unmuting costs no sound in the room.
  it('unmutes the element, because a muted element is captured as digital silence', async () => {
    const g = fakeGraph()
    const el = element()
    await openAudioTap({ element: el, context: g.ctx })
    expect(el.muted).toBe(false)
  })

  it('creates one element source per element, however often it is opened', async () => {
    const g = fakeGraph()
    const el = element()
    const first = await openAudioTap({ element: el, context: g.ctx })
    const second = await openAudioTap({ element: el, context: g.ctx })
    expect(g.createMediaElementSource).toHaveBeenCalledTimes(1)
    expect(second?.stream).toBe(first?.stream)
  })

  it('resumes a context the browser left suspended, or no audio flows', async () => {
    const g = fakeGraph({ state: 'suspended' })
    await openAudioTap({ element: element(), context: g.ctx })
    expect(g.resume).toHaveBeenCalled()
  })

  it('returns null when the graph cannot be built, rather than throwing into the caller', async () => {
    const g = fakeGraph({ sourceThrows: true })
    await expect(openAudioTap({ element: element(), context: g.ctx })).resolves.toBeNull()
  })

  // A sample tap has to read from the same node and end at the same non-speaker sink.
  it('exposes the source node and a sink that is not the speakers', async () => {
    const g = fakeGraph()
    const tap = await openAudioTap({ element: element(), context: g.ctx })
    expect(tap?.source).toBe(g.source)
    expect(tap?.sink).toBe(g.dest)
    expect(tap?.sink).not.toBe(g.speakers)
  })

  it('re-mutes the element when the tap is stopped', async () => {
    const g = fakeGraph()
    const el = element()
    const tap = await openAudioTap({ element: el, context: g.ctx })
    tap?.stop()
    expect(el.muted).toBe(true)
    expect(g.disconnected.length).toBeGreaterThan(0)
  })
})
