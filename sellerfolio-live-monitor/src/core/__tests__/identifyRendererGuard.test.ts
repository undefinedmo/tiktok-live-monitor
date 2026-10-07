import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The renderer cannot be unit-tested (it is the DOM), so the hand-off from a sale to the server is
// assembled in core/identifyWiring and core/identifySend, where it IS tested. This guard keeps it
// there. It is a TEXT check, and says so: it cannot prove the renderer is right, only that the fields
// that decide WHICH AUDIO and WHICH WINDOW the server hears about are not named in it. A reviewer
// injected `clip: { ...wire, startEpochSec: prevBoundary ?? sale - 60 }` into the renderer, sending the
// previous lot's window as the clip's own start, and every test and tsc stayed green.
const renderer = readFileSync(fileURLToPath(new URL('../../renderer/renderer.ts', import.meta.url)), 'utf8')
// The one legitimate use: the local Gemini product capture, unrelated to identification.
const code = renderer
  .split('\n')
  .filter((l) => !l.includes('clipStore.extract({ startEpochSec: end - sec, endEpochSec: end })'))
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n')

describe('renderer hand-off to identification', () => {
  // Naming any of these means the renderer is building or editing what the server is told.
  it.each([
    'startEpochSec',
    'endEpochSec',
    'durationSec',
    'leadInSec',
    'prevBoundaryEpochSec',
    'auctionStartEpochSec',
    'saleEpochSec',
    'clipStartEpochSec',
    'clipDurationSec',
    'boundariesForSale',
    'clipRequestFor',
    'jobForSale',
    'toWireClip',
    'buildIdentifyRequest',
    'new Blob',
  ])('does not name %s', (token) => {
    expect(code).not.toContain(token)
  })

  it('has no spread or literal that could rewrite the payload on its way to the main process', () => {
    expect(code).not.toMatch(/identify\(\s*\{/) // api.identify is handed the whole payload, never a literal
    expect(code).toContain('api.identify(await toWirePayload(job.payload))')
  })

  it('goes through the tested functions', () => {
    expect(code).toContain('identifyPayloadFor(sale, boundaryEvents, clipStore)')
    expect(code).toContain('clipReadyEpochSec(sale.atEpochSec)')
    expect(code).toContain('isRecentSale(s.createdAt, Date.now(), serverTimeOffsetMs)')
  })

  // A second Retry on a lot that is still being identified must not leave its row on "Identifying…".
  it('keeps one job per lot and never strands a row', () => {
    expect(code).toContain("if (existing?.status === 'transcribing') return")
    expect(code).toContain("settleEntry(entry, { status: 'failed', reason: 'already_queued' })")
    expect(code).toContain("b.disabled = r.status === 'transcribing'")
    expect(code).not.toContain("entry.text = 'already being identified'")
  })

  it('no longer compares a local millisecond with a server one', () => {
    expect(code).not.toMatch(/Date\.now\(\)\s*-\s*s\.createdAt\s*<\s*60000/)
  })
})

// ── Persistence and the gate (Task 6). Same kind of check, same honesty: TEXT checks on glue that cannot
// run here. The logic they point at (store, settings, preflight) is tested for real elsewhere; these
// pin that the glue still calls it, in the places that matter. A reviewer found 442 green tests over a
// production bug that lived exactly in glue like this.
const lf = (s: string) => s.replace(/\r\n/g, '\n') // a Windows checkout has CRLF; these checks match across lines
const mainSrc = lf(readFileSync(fileURLToPath(new URL('../../electron/main.ts', import.meta.url)), 'utf8'))
const preloadSrc = lf(readFileSync(fileURLToPath(new URL('../../electron/preload-viewer.ts', import.meta.url)), 'utf8'))
const rendererCode = lf(code)
const noComments = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const mainCode = noComments(mainSrc)

/** The text of `function name(...) {` up to its closing brace at column 0. */
function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(String.raw`(async )?function ${name}\(`))
  expect(start, `function ${name} exists`).toBeGreaterThanOrEqual(0)
  const end = src.indexOf('\n}\n', start)
  return src.slice(start, end < 0 ? undefined : end)
}

describe('renderer persists identifications', () => {
  it('writes a row when the sale is queued, so a lot lost to a closed app is on record', () => {
    const body = fnBody(rendererCode, 'identifySale')
    expect(body).toContain('persistEntry(entry)')
    expect(body).toContain('orderId: sale.orderId')
    expect(body).toContain('atEpochSec: sale.atEpochSec')
  })
  it('writes the row again when it settles', () => {
    expect(fnBody(rendererCode, 'settleEntry')).toContain('persistEntry(entry)')
  })
  it('writes the row again when an operator corrects it', () => {
    expect(fnBody(rendererCode, 'idEditor')).toContain('persistEntry(r)')
  })
  it('persistEntry goes through the tested row builder and can never throw into the show', () => {
    const body = fnBody(rendererCode, 'persistEntry')
    expect(body).toContain('rowFromEntry(e)')
    expect(body).toContain('api.saveRow(row)')
    expect(body).toContain('.catch(')
    expect(body).toContain('try {')
  })
  it('keeps up to the store cap, not the old in-memory 200 (or 30)', () => {
    expect(rendererCode).toContain('recaps.length > MAX_IDENTIFICATIONS')
    expect(rendererCode).not.toMatch(/recaps\.length\s*>\s*(30|200)\b/)
  })
  it('restores last session at launch, tolerates a failing store, and does not identify a restored order again', () => {
    const body = fnBody(rendererCode, 'restoreIdentifications')
    expect(body).toContain('await window.identifyAPI?.rows()')
    expect(body).toMatch(/try \{[^}]*rows\(\)[^}]*\} catch/)
    expect(body).toContain('restoreEntries(recaps, rows, MAX_IDENTIFICATIONS)')
    expect(body).toContain('identifiedOrders.add(e.orderId)')
    const init = fnBody(rendererCode, 'initRecap')
    expect(init.indexOf('await refreshIdentifyState()')).toBeGreaterThanOrEqual(0)
    expect(init.indexOf('await restoreIdentifications()')).toBeGreaterThan(init.indexOf('await refreshIdentifyState()'))
  })
})

describe('renderer gate', () => {
  it('is identifyGate over a saved token and the stored switch, and nothing else', () => {
    const body = fnBody(rendererCode, 'applyIdentifyState')
    expect(body).toContain('identifyGate({ hasToken: identifyReady, enabled: identifyEnabled })')
    expect(body).toContain("recapEnabled = gate === 'on'")
    expect(body).not.toContain('geminiKeyPresent')
  })
  it('takes the answer from main through identifyStateFrom and assigns every field from it', () => {
    const body = fnBody(rendererCode, 'refreshIdentifyState')
    expect(body).toContain('identifyStateFrom(told)')
    for (const f of ['identifyReady = s.ready', 'identifyEnabled = s.enabled', 'identifyDamaged = s.damaged', 'identifyUrl = s.baseUrl', 'identifyDefaultUrl = s.defaultBaseUrl']) expect(body).toContain(f)
    expect(body.indexOf('applyIdentifyState()')).toBeGreaterThan(body.indexOf('identifyDefaultUrl = s.defaultBaseUrl'))
  })
  it('no longer reads the switch from localStorage, where main could not see it', () => {
    expect(rendererCode).not.toContain('tt-ai-transcribe')
    expect(rendererCode).not.toContain('aiTranscribePref')
  })
  it('re-reads the gate when a token is saved or removed, not only at launch', () => {
    const body = fnBody(rendererCode, 'setupSfSync')
    expect(body.split('refreshIdentifyState()').length - 1).toBeGreaterThanOrEqual(2)
  })
  it('turns the switch and the address into saves in main, then re-reads', () => {
    expect(rendererCode).toContain('api.save({ enabled: want })')
    expect(rendererCode).toContain('api.save({ baseUrl: box.value })')
  })
})

describe('main process', () => {
  it('runs the preflight before every POST, with the sync token, and sends to the address it returns', () => {
    const handler = mainCode.slice(mainCode.indexOf("ipcMain.handle('tt-identify'"))
    const pre = handler.indexOf('identifyPreflight(loadSyncSettings().token, loadIdentifySettings(IDENTIFY_FILE))')
    const send = handler.indexOf('sendIdentify(')
    expect(pre).toBeGreaterThanOrEqual(0)
    expect(send).toBeGreaterThan(pre)
    expect(handler).toContain('if (!pre.ok) return identifyFailed(pre.reason)')
    expect(handler).toContain('cfg: { baseUrl: pre.baseUrl, token: pre.token }')
  })
  it('has one token: nothing named for a second one, and identify.json is written only through the two-field writer', () => {
    expect(mainCode).not.toMatch(/identifyToken|IDENTIFY_TOKEN|identify.*tokenEnc/i)
    expect(mainCode.split('saveIdentifySettings(').length - 1).toBe(1) // exactly one writer call
    expect(mainCode).toContain('saveIdentifySettings(IDENTIFY_FILE, u.next)')
    expect(mainCode).not.toContain('identifyBaseUrl()')
  })
  it('never logs a token on the identification path', () => {
    const block = mainCode.slice(mainCode.indexOf("ipcMain.handle('identify:state'"), mainCode.indexOf('// ── Label printing'))
    for (const l of block.split('\n').filter((x) => x.includes('flog('))) expect(l.replace(/\/\/.*$/, '').toLowerCase()).not.toContain('token')
  })
  it('loads the store only when the page asks, never at launch', () => {
    expect(mainCode.split('identifyStore.load()').length - 1).toBe(1)
    expect(mainCode.slice(mainCode.indexOf("ipcMain.handle('identify:rows'"))).toMatch(/^ipcMain\.handle\('identify:rows', \(\) => \{\n\s*try \{ return identifyStore\.load\(\) \} catch \{ return \[\] \}/)
  })
  it('every identification channel the page can call has a handler in main (a typo is a silent no-op)', () => {
    const called = [...preloadSrc.matchAll(/invoke\('((?:identify:|tt-identify)[^']*)'/g)].map((m) => m[1])
    const handled = new Set([...mainSrc.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]))
    expect(called.length).toBeGreaterThanOrEqual(5)
    for (const c of called) expect(handled.has(c!), `no handler for ${c}`).toBe(true)
  })
})

// Added after a mutation sweep over the glue: the earlier checks pinned that a call EXISTS; these pin
// where it sits and that the things it names are really there.
describe('glue: order, wiring and the markup it names', () => {
  const html = lf(readFileSync(fileURLToPath(new URL('../../renderer/index.html', import.meta.url)), 'utf8'))
  const after = (body: string, first: string, then: string) => {
    expect(body, first).toContain(first)
    expect(body.indexOf(then), `${then} comes after ${first}`).toBeGreaterThan(body.indexOf(first))
  }

  it('a row is saved AFTER its status and text are set, never before (or it would persist the old state)', () => {
    after(fnBody(rendererCode, 'settleEntry'), 'entry.text =', 'persistEntry(entry)')
    after(fnBody(rendererCode, 'idEditor'), "r.status = 'done'", 'persistEntry(r)')
    after(fnBody(rendererCode, 'identifySale'), "entry.status = 'transcribing'", 'persistEntry(entry)')
  })
  it('the switch saves the box as ticked, not its opposite', () => {
    expect(rendererCode).toContain('const want = (e.target as HTMLInputElement).checked')
  })
  it('a failed address save keeps what was typed, and only a good one is re-read into the box', () => {
    expect(rendererCode).toContain('if (r.ok) { await refreshIdentifyState(); box.value = r.baseUrl }')
  })
  it('the switch shows the gate, is disabled without a token, and the status line comes from the tested words', () => {
    const body = fnBody(rendererCode, 'applyIdentifyState')
    expect(body).toContain('sw.checked = recapEnabled; sw.disabled = !identifyReady')
    expect(body).toContain('identifyStatus(gate, identifyDamaged)')
  })
  it('main reports a token only when one is really saved, and hands back what save wrote', () => {
    expect(mainCode).toContain('ready: !!loadSyncSettings().token')
    expect(mainCode).toContain('updateIdentifySettings(loadIdentifySettings(IDENTIFY_FILE), a ?? {})')
    expect(mainCode).toContain('const ok = identifyStore.save(row)')
    expect(mainCode).toContain('return ok')
  })
  it('the preload passes each argument through untouched', () => {
    for (const l of [
      "state: () => ipcRenderer.invoke('identify:state')",
      "save: (args: { baseUrl?: string; enabled?: boolean }) => ipcRenderer.invoke('identify:save', args)",
      "rows: () => ipcRenderer.invoke('identify:rows')",
      "saveRow: (row: unknown) => ipcRenderer.invoke('identify:save-row', row)",
      "identify: (payload: unknown) => ipcRenderer.invoke('tt-identify', payload)",
    ]) expect(preloadSrc).toContain(l)
  })
  it('every element the page looks up for these settings exists in the markup (a typo is a silent no-op)', () => {
    for (const id of ['aiTranscribe', 'aiState', 'idUrl', 'idUrlSave', 'idUrlState']) {
      expect(rendererCode, `renderer looks up ${id}`).toContain(`getElementById('${id}')`)
      expect(html, `markup has ${id}`).toContain(`id="${id}"`)
    }
  })
  it('a failing or malformed answer from the store cannot take the page down', () => {
    const body = fnBody(rendererCode, 'restoreIdentifications')
    expect(body).toContain('if (!Array.isArray(rows)) return')
  })
})

describe('glue: turning identification off really stops it (second sweep)', () => {
  const body = () => fnBody(rendererCode, 'applyIdentifyState')
  it('on starts the recorder; going from on to off stops it and abandons what is queued', () => {
    const b = body()
    expect(b).toContain('if (recapEnabled) startAudioCapture()')
    expect(b).toContain("else if (was) { stopAudioCapture(); endIdentifyShow('identification was turned off') }")
    expect(b).toContain('const was = recapEnabled')
  })
  it('flipping the switch re-reads the state, whether the save worked or not', () => {
    expect(rendererCode).toContain('void api.save({ enabled: want }).then(() => refreshIdentifyState(), () => refreshIdentifyState())')
  })
  it('a refused address shows the reason it was refused', () => {
    expect(rendererCode).toContain("r.ok ? 'Saved' : (r.error ?? 'Could not save')")
  })
  it('a failed or empty answer from main is read as "off", never as "keep what you had": no early return', () => {
    const b = fnBody(rendererCode, 'refreshIdentifyState')
    expect(b).not.toMatch(/\breturn\b/)
    expect(b).toContain('catch { told = undefined }')
  })
})
