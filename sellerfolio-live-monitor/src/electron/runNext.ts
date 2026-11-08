// Run next lot — main-process side. The viewer's button (or a clicker key) asks 'run:next'; this
// re-checks the rules against the latest TikTok state (core/runNext.ts planRunNext), sends the
// start to the TikTok window (preload.ts 'tt-auction-start', the page's own signed fetch), and
// resolves with TikTok's answer. It also pushes the current plan to the viewer ('run:plan') so the
// button can say what a press would start, or why it won't.
//
// Arm is checked in the viewer (renderer/shell.ts) — it is the host's switch. Everything that
// decides WHETHER and WHAT to start is here, against main's own fresh pin/roster state, never
// against whatever the viewer last painted.
//
// Channels:
//   invoke 'run:next'          → { ok, error? }   (the real TikTok result)
//   invoke 'run:plan-get'      → RunNextPlan
//   event  'run:plan'  (plan)  main → viewer, sent when it changes

import { ipcMain, type BrowserWindow } from 'electron'
import { planRunNext, START_SETTLE_MS, type RunNextPlan } from '../core/runNext'
import type { PinState, RosterSnapshot } from '../core/types'

export interface RunNextDeps {
  monitor: () => BrowserWindow | null
  pin: () => PinState | null
  roster: () => RosterSnapshot | null
  roomId: () => string | undefined
  sessionId: () => string | undefined
  /** main.ts viewerSend */
  send: (channel: string, ...args: unknown[]) => void
  log: (line: string) => void
}

let deps: RunNextDeps | null = null
let lastStart: { atMs: number; pinTs: number } | null = null
let inFlight = false
let seq = 0
const pending = new Map<number, (r: { ok: boolean; error?: string }) => void>()
let lastPlanSig = ''
let settleTimer: ReturnType<typeof setTimeout> | null = null

function plan(now = Date.now()): RunNextPlan {
  if (!deps) return { ok: false, reason: 'Not ready.' }
  if (inFlight) return { ok: false, reason: 'Starting…' }
  return planRunNext({
    pin: deps.pin(), roster: deps.roster(), roomId: deps.roomId(), sessionId: deps.sessionId(), lastStart, nowMs: now,
  })
}

/** Push the plan to the viewer when it changes. Called after every pin/roster update. */
export function runNextStateChanged(): void {
  try {
    const p = plan()
    const sig = JSON.stringify(p)
    if (sig === lastPlanSig) return
    lastPlanSig = sig
    deps?.send('run:plan', p)
  } catch { /* the button text is never worth a crash */ }
}

function startOnTikTok(auctionConfigId: string): Promise<{ ok: boolean; error?: string }> {
  const mon = deps?.monitor()
  if (!mon || mon.isDestroyed()) return Promise.resolve({ ok: false, error: 'The TikTok window is not open.' })
  const id = ++seq
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'TikTok did not answer in time. Check TikTok before pressing again.' }) }, 8000)
    pending.set(id, (r) => { clearTimeout(timer); resolve(r) })
    mon.webContents.send('tt-auction-start', { id, auctionConfigId })
  })
}

/** Called once from main.ts. */
export function registerRunNext(d: RunNextDeps): void {
  deps = d
  // pin/get samples arrive about once a second; this catches the cases no sample announces
  // (the poll going quiet, the settle window running out).
  setInterval(runNextStateChanged, 3000).unref?.()
  ipcMain.handle('run:plan-get', () => plan())
  ipcMain.on('tt-auction-started', (_e, r: { id?: number; ok: boolean; error?: string }) => {
    if (r?.id == null) return
    pending.get(r.id)?.({ ok: !!r.ok, error: r.error })
    pending.delete(r.id)
  })
  ipcMain.handle('run:next', async () => {
    const now = Date.now()
    const p = plan(now)
    if (!p.ok) return { ok: false, error: p.reason }
    inFlight = true
    lastStart = { atMs: now, pinTs: deps?.pin()?.ts ?? now }
    runNextStateChanged()
    d.log(`[run-next] start ${p.listing} cfg=${p.auctionConfigId} after=${p.after ?? '-'}`)
    let r: { ok: boolean; error?: string }
    try { r = await startOnTikTok(p.auctionConfigId) } catch (e) { r = { ok: false, error: String(e) } }
    inFlight = false
    d.log(`[run-next] ${r.ok ? 'started' : 'FAILED ' + (r.error ?? '')}`)
    // A refused start can be retried at once. A timeout keeps the settle guard: it may have
    // started on TikTok's side, and pin/get will say so within a second or two.
    if (!r.ok && !/did not answer/.test(r.error ?? '')) lastStart = null
    runNextStateChanged()
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(runNextStateChanged, START_SETTLE_MS + 50)
    return r
  })
}
