import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// main.ts is the electron entry and cannot be imported here. The journalling of chat is logic in
// core/chatJournal (tested with a real captured frame) and the hand-off is ONE line in main.ts. A
// reviewer's lesson from this project: 442 tests stayed green against a bug that lived in untested
// glue. So this is a TEXT check, and says so: it cannot prove main.ts is right, only that the line
// that makes chat reach the journal exists, runs on every decoded frame, and is not guarded away.
const main = readFileSync(fileURLToPath(new URL('../../electron/main.ts', import.meta.url)), 'utf8')
const lines = main.split('\n')

describe('main.ts journals every decoded chat frame', () => {
  const handlerAt = lines.findIndex((l) => l.includes("ipcMain.on('tt-im-frame'"))
  const handler = lines.slice(handlerAt, handlerAt + 20).join('\n')

  it('has the im-frame handler', () => {
    expect(handlerAt).toBeGreaterThan(-1)
  })

  it('calls journalChat with the decoded items, the local arrival time, record and the lot in progress', () => {
    expect(handler).toContain('journalChat(chatJournal, items, now, record, lotInProgress(imCurrent, lastPin, now))')
  })

  // The lot is read AFTER the auction path has taken this frame's bids into imCurrent, and inside the fence
  // that keeps a failure here from reaching the labels.
  it('reads the lot after the frame has updated the current lot, and inside the try', () => {
    expect(handler.indexOf("ingestAuctionBytes(raw, now, 'im')")).toBeLessThan(handler.indexOf('lotInProgress(imCurrent, lastPin, now)'))
    const fenced = handler.slice(handler.indexOf('try { journalChat('))
    expect(fenced.indexOf('lotInProgress(imCurrent, lastPin, now)')).toBeGreaterThan(0)
    expect(fenced.indexOf('lotInProgress(imCurrent, lastPin, now)')).toBeLessThan(fenced.indexOf('} catch {'))
  })

  it('does so for every frame, after the auction path that prints labels, and fenced so it cannot break it', () => {
    const decode = handler.indexOf('decodeChat(raw)')
    const auction = handler.indexOf("ingestAuctionBytes(raw, now, 'im')")
    const call = handler.indexOf('try { journalChat(')
    expect(decode).toBeGreaterThan(-1)
    expect(auction).toBeGreaterThan(decode)
    expect(call).toBeGreaterThan(auction)
    // at the handler's own indent: not inside the `if (items.length)` render branch
    expect(handler.slice(handler.lastIndexOf(String.fromCharCode(10), call) + 1, call)).toBe('  ')
    expect(handler.slice(call)).toContain('catch {')
  })

  it('builds the journal once, at module scope', () => {
    expect(main).toMatch(/^const chatJournal = new ChatJournal\(\)/m)
    expect(main.match(/new ChatJournal\(/g)).toHaveLength(1)
  })
})
