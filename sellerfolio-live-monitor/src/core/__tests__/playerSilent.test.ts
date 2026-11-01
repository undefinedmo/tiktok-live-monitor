import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The renderer cannot be unit-tested (it is the DOM), so this is a TEXT check, and says so. The player
// must stay silent: an audible station can feed the show back into the broadcast, and the app no longer
// reads audio at all, so nothing here has a reason to unmute it or to open the element's audio.
const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const renderer = src('../../renderer/renderer.ts')
const html = src('../../renderer/index.html')

describe('the live player stays silent', () => {
  it('starts muted in the markup', () => {
    expect(html).toMatch(/<video id="live"[^>]*\bmuted\b/)
  })
  it('undoes a click on the volume control', () => {
    expect(renderer).toContain("video.addEventListener('volumechange', () => { if (!video.muted) video.muted = true })")
  })
  it('never unmutes the element', () => {
    expect(renderer).not.toMatch(/\.muted\s*=\s*false/)
  })
  it.each(['createMediaElementSource', 'captureStream', 'MediaRecorder', 'AudioWorklet'])('does not use %s', (token) => {
    expect(renderer).not.toContain(token)
  })
})
