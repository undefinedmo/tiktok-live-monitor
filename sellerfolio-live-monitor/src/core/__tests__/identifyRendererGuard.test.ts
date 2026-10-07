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
    expect(code).toContain('identifyPayloadFor(sale, boundaryEvents, clipStore, identifyLatencySec)')
    expect(code).toContain('clipReadyEpochSec(sale.atEpochSec, identifyLatencySec)')
    expect(code).toContain('splitSalesByAge(freshSales, Date.now(), serverTimeOffsetMs)')
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
    expect(body).toContain('newEntryFor(s, sale)')
    const made = fnBody(rendererCode, 'newEntryFor')
    expect(made).toContain('orderId: sale.orderId')
    expect(made).toContain('atEpochSec: sale.atEpochSec')
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
    expect(body).toContain('seenOrders.markRestored(e.orderId)')
    const init = fnBody(rendererCode, 'initRecap')
    expect(init.indexOf('await refreshIdentifyState()')).toBeGreaterThanOrEqual(0)
    expect(init.indexOf('await restoreIdentifications()')).toBeGreaterThan(init.indexOf('await refreshIdentifyState()'))
  })
})

describe('renderer gate', () => {
  it('is identifyGate over a saved token and the stored switch, and nothing else', () => {
    const body = fnBody(rendererCode, 'applyIdentifyState')
    expect(body).toContain('identifyGate({ hasToken: identifyReady, enabled: identifyEnabled, held: identifyHeld })')
    expect(body).toContain("recapEnabled = gate === 'on'")
    expect(body).not.toContain('geminiKeyPresent')
  })
  it('takes the answer from main through identifyStateFrom and assigns every field from it', () => {
    const body = fnBody(rendererCode, 'refreshIdentifyState')
    expect(body).toContain('identifyStateFrom(told)')
    for (const f of ['identifyReady = s.ready', 'identifyEnabled = s.enabled', 'identifyDamaged = s.damaged', 'identifyUrl = s.baseUrl', 'identifyDefaultUrl = s.defaultBaseUrl', 'identifyLatencySec = s.streamLatencySec']) expect(body).toContain(f)
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
    expect(body).toContain('identifyStatus(gate, identifyDamaged, identifyHeld)')
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
      "save: (args: { baseUrl?: string; enabled?: boolean; streamLatencySec?: number }) => ipcRenderer.invoke('identify:save', args)",
      "rows: () => ipcRenderer.invoke('identify:rows')",
      "saveRow: (row: unknown) => ipcRenderer.invoke('identify:save-row', row)",
      "identify: (payload: unknown) => ipcRenderer.invoke('tt-identify', payload)",
    ]) expect(preloadSrc).toContain(l)
  })
  it('every element the page looks up for these settings exists in the markup (a typo is a silent no-op)', () => {
    for (const id of ['aiTranscribe', 'aiState', 'idUrl', 'idUrlSave', 'idUrlState', 'idLatency', 'idLatencySave', 'idLatencyState']) {
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
    expect(b).toContain("else if (was) { stopAudioCapture(); endIdentifyShow('identification was turned off'); keptClips.clear() }")
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

describe('glue: opt-outs and restored orders (follow-up)', () => {
  it('migrates the old localStorage opt-out BEFORE the gate is first read', () => {
    const init = fnBody(rendererCode, 'initRecap')
    const mig = init.indexOf('await migrateLegacyIdentifySwitch()')
    expect(mig).toBeGreaterThanOrEqual(0)
    expect(init.indexOf('await refreshIdentifyState()')).toBeGreaterThan(mig)
    const body = fnBody(rendererCode, 'migrateLegacyIdentifySwitch')
    expect(body).toContain('migrateLegacySwitch(localStorage, async (enabled) => (await api.save({ enabled })).ok === true)')
    expect(body).toContain("=== 'unresolved'")
    expect(body).toContain('catch { identifyHeld = true }')
  })
  it('a show change forgets only the orders sent this show, and the overflow clear no longer lives in the page', () => {
    expect(fnBody(rendererCode, 'endIdentifyShow')).toContain('seenOrders.endShow()')
    expect(rendererCode).not.toContain('identifiedOrders')
    expect(rendererCode).toContain('const seenOrders = createSeenOrders()')
  })
  it('a sale is skipped when it has been seen, and marked sent otherwise', () => {
    const b = fnBody(rendererCode, 'identifySale')
    expect(b).toContain('if (seenOrders.has(s.orderId)) return')
    expect(b.indexOf('seenOrders.markSent(s.orderId)')).toBeGreaterThan(b.indexOf('seenOrders.has(s.orderId)'))
  })
})

describe('glue: an unresolved opt-out holds the gate off (review round)', () => {
  it('the explicit switch is what releases the hold, and it does so before saving', () => {
    const idx = rendererCode.indexOf("const want = (e.target as HTMLInputElement).checked")
    expect(idx).toBeGreaterThanOrEqual(0)
    const after = rendererCode.slice(idx, idx + 250)
    expect(after).toContain('identifyHeld = false')
  })
  it('nothing else ever clears the hold', () => {
    expect(rendererCode.split('identifyHeld = false').length - 1).toBe(2) // the declaration and the switch
  })
})

// ── Stream latency (final fix 1): the setting reaches the two places that use it, and nowhere is it re-derived. ──
describe('glue: the stream latency reaches the window and the wait, and is saved through the tested checks', () => {
  it('identifySale hands the setting to the tested window and to the tail wait, both', () => {
    const b = fnBody(rendererCode, 'identifySale')
    expect(b).toContain('clipReadyEpochSec(sale.atEpochSec, identifyLatencySec)')
    expect(b).toContain('identifyPayloadFor(sale, boundaryEvents, clipStore, identifyLatencySec)')
  })
  it('the page holds one value, defaulting to 0 (uncorrected), and only the refresh from main sets it', () => {
    expect(rendererCode).toContain('let identifyLatencySec = 0')
    expect(rendererCode.split('identifyLatencySec = ').length - 1).toBe(2) // the declaration and refreshIdentifyState
  })
  it('the box is checked by checkLatencyInput, saved by main, then re-read', () => {
    expect(rendererCode).toContain('checkLatencyInput(box.value)')
    expect(rendererCode).toContain('api.save({ streamLatencySec: c.sec })')
    expect(rendererCode).toContain('await refreshIdentifyState()')
  })
  it('the standing note under the box comes from the tested words, so "not measured" is always said at 0', () => {
    expect(fnBody(rendererCode, 'applyIdentifyState')).toContain('latencyNote(identifyLatencySec)')
  })
  it('main reports it with the other settings, and saves it through the one writer', () => {
    expect(mainCode).toContain('streamLatencySec: s.streamLatencySec')
    expect(mainCode).toContain('a: { baseUrl?: unknown; enabled?: unknown; streamLatencySec?: unknown }')
  })
})

// ── Final fix 2 and 3: the clip's own caveats reach the row, and a late sale gets a row instead of silence. ──
describe('glue: clip caveats and late sales', () => {
  it('a settled row carries the tested note for ITS clip (truncated and/or a timeline that disagrees with the audio)', () => {
    expect(rendererCode).toContain('settleEntry(job.entry, outcome, clipNote(job.payload.clip))')
    expect(fnBody(rendererCode, 'settleEntry')).toContain("v.text + (v.status === 'done' ? note : '')")
  })
  it('a sale that arrives too late is recorded with the too_old reason, through settleEntry (so it is also saved)', () => {
    const b = fnBody(rendererCode, 'recordTooOldSale')
    expect(b).toContain("settleEntry(newEntryFor(s, saleOnThisClock(s)), { status: 'failed', reason: 'too_old' })")
    expect(b).toContain('seenOrders.markSent(s.orderId)')
    expect(b.indexOf('seenOrders.has(s.orderId)')).toBeLessThan(b.indexOf('seenOrders.markSent(s.orderId)'))
  })
  it('a too-old sale is not sent on its own: the row has no payload, no clip cut and no queue entry', () => {
    const b = fnBody(rendererCode, 'recordTooOldSale')
    for (const forbidden of ['identifyPayloadFor', 'identifyQueue', 'enqueue', 'identifySale(']) expect(b).not.toContain(forbidden)
  })
  it('every too-old sale of a batch is recorded, after the render and before identification, and nothing filters by age any more', () => {
    const at = rendererCode.indexOf('for (const s of tooOld) recordTooOldSale(s)')
    expect(at).toBeGreaterThan(rendererCode.indexOf("$('feedCount').title"))
    expect(rendererCode.indexOf('for (const s of toIdentify) identifySale(s)')).toBeGreaterThan(at)
    expect(rendererCode).not.toMatch(/\.filter\([^)]*isRecentSale/)
  })
  it('the identification gate applies to the record too: with identification off there is no row', () => {
    expect(fnBody(rendererCode, 'recordTooOldSale')).toContain('if (!recapEnabled || !window.identifyAPI) return')
  })
  it('the identifications table says WHY a row failed, not just "Failed"', () => {
    expect(rendererCode).toContain("r.status === 'error' ? (r.text || 'Failed')")
  })
})

// ── Final fix 5: Retry after an outage. Retry one row, or all, from the clip that failed. ──
describe('glue: retry from a kept clip, one row or all failed', () => {
  const html = lf(readFileSync(fileURLToPath(new URL('../../renderer/index.html', import.meta.url)), 'utf8'))

  it('a failed or abandoned clip is kept after the row settles, a settled one clears an earlier keep, and none of it can throw into the show', () => {
    expect(rendererCode).toContain('settleEntry(job.entry, outcome, clipNote(job.payload.clip))\n    void tidyKeptClip(job, outcome.status)')
    const b = fnBody(rendererCode, 'tidyKeptClip')
    expect(b).toContain('shouldKeepClip(status)')
    expect(b).toContain('await api.clipKeep(await toWirePayload(job.payload))')
    expect(b).toContain('keptClips.add(job.orderId)')
    expect(b).toContain('keptClips.delete(job.orderId)')
    expect(b).toContain('await api.clipDrop(job.orderId)')
    expect(b).toMatch(/try \{[\s\S]*\} catch \{/)
  })

  it('a kept clip is sent as it was kept (the same job, the same clip), on its own row, in the current show', () => {
    const b = fnBody(rendererCode, 'queueKeptClip')
    expect(b).toContain('payload: fromWirePayload(kept)')
    expect(b).toContain('show: showGeneration')
    expect(b).toContain("settleEntry(entry, { status: 'failed', reason: 'already_queued' })")
    expect(b.indexOf("entry.status = 'transcribing'")).toBeLessThan(b.indexOf('persistEntry(entry)'))
  })

  it('retryEntry starts from the kept clip when there is one, else from the sale, and tells the caller when there is neither', () => {
    const b = fnBody(rendererCode, 'retryEntry')
    expect(b).toContain('!canRetry(r, keptClips)')
    expect(b).toContain('await api.clipTake(orderId)')
    expect(b).toContain('identifySale(r.sale, r)')
    expect(b).toContain('if (!recapEnabled || !api || !orderId')
    // a second press while the clip is being read must not queue a second job
    expect(b).toContain('retryLoading.has(orderId)')
    expect(b).toContain("if (r.status === 'transcribing') return true")
    // the kept clip is tried before the buffer
    expect(b.indexOf('api.clipTake(orderId)')).toBeLessThan(b.indexOf('identifySale(r.sale, r)', b.indexOf('api.clipTake(orderId)')))
  })

  it('the per-row Retry works for a restored row: it asks canRetry (a kept clip), not "is there a sale in memory"', () => {
    const b = fnBody(rendererCode, 'idRetryButton')
    expect(b).toContain('!canRetry(r, keptClips)')
    expect(b).toContain('void retryEntry(r)')
    expect(b).not.toContain('!r.sale')
    expect(b).not.toContain('identifySale(')
  })

  it('"Retry all failed" takes the tested target list, one row after another, and is hidden when there is nothing to retry', () => {
    expect(fnBody(rendererCode, 'retryAllFailed')).toContain('for (const r of bulkRetryTargets(recaps, keptClips)) await retryEntry(r)')
    const b = fnBody(rendererCode, 'syncRetryAll')
    expect(b).toContain('bulkRetryTargets(recaps, keptClips).length')
    expect(b).toContain("b.style.display = n && recapEnabled ? '' : 'none'")
    expect(b).toContain('retryAllLabel(n, retryAllArmed)')
    expect(fnBody(rendererCode, 'renderIdentifications').startsWith('function renderIdentifications() {\n  syncRetryAll()')).toBe(true)
    expect(html).toContain('id="idRetryAll"')
  })

  it('it asks twice before it spends model calls: the first press arms, only the second runs', () => {
    const i = rendererCode.indexOf("document.getElementById('idRetryAll')?.addEventListener('click'")
    expect(i).toBeGreaterThan(-1)
    const handler = rendererCode.slice(i, rendererCode.indexOf('\n})\n', i))
    expect(handler.indexOf('if (!retryAllArmed) {')).toBeGreaterThan(-1)
    expect(handler.indexOf('void retryAllFailed()')).toBeGreaterThan(handler.indexOf('return\n  }'))
    expect(handler.split('retryAllFailed()').length - 1).toBe(1)
  })

  it('last session\'s kept clips are listed at launch, tolerating a failing or malformed answer, after the rows are restored', () => {
    const b = fnBody(rendererCode, 'restoreKeptClips')
    expect(b).toContain('await window.identifyAPI?.clipList()')
    expect(b).toMatch(/try \{[^}]*clipList\(\)[^}]*\} catch/)
    expect(b).toContain('if (!Array.isArray(ids)) return')
    expect(b).toContain("typeof id === 'string'")
    const init = fnBody(rendererCode, 'initRecap')
    expect(init.indexOf('await restoreKeptClips()')).toBeGreaterThan(init.indexOf('await restoreIdentifications()'))
  })

  it('the preload passes each clip call through untouched', () => {
    for (const l of [
      "clipKeep: (payload: unknown) => ipcRenderer.invoke('identify:clip-keep', payload)",
      "clipTake: (orderId: string) => ipcRenderer.invoke('identify:clip-take', orderId)",
      "clipDrop: (orderId: string) => ipcRenderer.invoke('identify:clip-drop', orderId)",
      "clipList: () => ipcRenderer.invoke('identify:clip-list')",
    ]) expect(preloadSrc).toContain(l)
  })

  it('main keeps audio only while identification is ON, and empties the folder when it is turned off', () => {
    const keep = mainCode.slice(mainCode.indexOf("ipcMain.handle('identify:clip-keep'"))
    expect(keep).toContain('if (!loadIdentifySettings(IDENTIFY_FILE).enabled) return false\n  return identifyClips.keep(payload)')
    expect(mainCode).toContain("ipcMain.handle('identify:clip-take', (_e, orderId: string) => identifyClips.load(orderId))")
    expect(mainCode).toContain("if (!loadIdentifySettings(IDENTIFY_FILE).enabled) { identifyClips.clear(); return [] }")
    expect(mainCode).toContain('if (!u.next.enabled) identifyClips.clear()')
    // cleared only AFTER the setting is saved
    expect(mainCode.indexOf('if (!u.next.enabled) identifyClips.clear()')).toBeGreaterThan(mainCode.indexOf('saveIdentifySettings(IDENTIFY_FILE, u.next)'))
  })

  it('a failed clip is kept in the user-data folder, through the one keeper', () => {
    expect(mainCode).toContain("createClipKeeper(join(app.getPath('userData'), 'identify-clips'), { now: () => Date.now() })")
    expect(mainCode.split('createClipKeeper(').length - 1).toBe(1)
  })
})
