// LANE G — "Sales so far" strip on the Show screen (#salesSoFar), plus the show timeline panel
// (timelineView.ts). Replaces the old three-tile #statsGrid (SALES / GMV / PACE), which it hides
// once it has mounted; renderStats() in renderer.ts keeps running harmlessly behind it.
//
// Sources (see core/showStats.ts): GMV, orders and pace from TikTok's whole-show series
// (`show_totals`), runtime from room/status duration; buyers, items sold and AOV from SellerFolio
// via main's poller (electron/showStats.ts, `show:stats`). hq cells say "as of hh:mm" and vanish when
// hq has no such route. Nothing here is on the print path: the live-event listener is attached a
// tick AFTER renderer.ts's own (so the print handler always runs first), only copies a few numbers,
// and paints on a timer.

import type { LiveEvent } from '../core/types'
import { buildSalesView, runtimeNow, type FeedView, type HqShowStats, type SalesInputs } from '../core/showStats'
import type { ShowTimeline } from '../core/timelineLayout'
import { initTimeline, onTimeline } from './timelineView'

interface ShowBridge {
  get: () => Promise<{ stats: FeedView<HqShowStats>; timeline: FeedView<ShowTimeline> } | null>
  setTimelineOpen: (open: boolean) => Promise<unknown>
  onStats: (cb: (v: FeedView<HqShowStats>) => void) => void
  onTimeline: (cb: (v: FeedView<ShowTimeline>) => void) => void
}

const RUNTIME_REPAINT_MS = 15_000

let panel: HTMLElement | null = null
let grid: HTMLElement | null = null
let meta: HTMLElement | null = null
let room: string | undefined
let liveStartedAtSec: number | undefined
let runtimeBase: { sec: number; atMs: number } | null = null
const tiktok: SalesInputs['tiktok'] = {}
const local: SalesInputs['local'] = {}
let hq: FeedView<HqShowStats> | null = null
let paintQueued = false

function bridge(): ShowBridge | undefined {
  try { return (globalThis as { showAPI?: ShowBridge }).showAPI } catch { return undefined }
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export function initShowStats(): void {
  panel = document.getElementById('salesSoFar')
  const b = bridge()
  try { initTimeline({ setOpen: (open) => { void b?.setTimelineOpen(open).catch(() => {}) } }) } catch (e) { console.error('[live-ui] timeline failed to start', e) }
  if (panel) {
    panel.replaceChildren()
    const head = el('div', 'ssf-head')
    head.append(el('span', 'eyebrow', 'Sales so far'))
    meta = el('span', 'ssf-meta')
    head.append(meta)
    grid = el('div', 'ssf-grid')
    grid.setAttribute('role', 'list')
    panel.append(head, grid)
    panel.hidden = false
    const old = document.getElementById('statsGrid')
    if (old) old.hidden = true //  superseded by this strip (same numbers and more)
  }

  if (b) {
    try {
      b.onStats((v) => { applyHq(v) })
      b.onTimeline((v) => { try { onTimeline(v) } catch (e) { console.error('[live-ui] timeline', e) } })
      void b.get().then((snap) => {
        if (!snap) return
        applyHq(snap.stats)
        try { onTimeline(snap.timeline) } catch { /* drawn on the next push */ }
      }).catch(() => {})
    } catch (e) { console.error('[live-ui] showAPI', e) }
  } else {
    try { onTimeline({ room: null, state: 'off', data: null, at: null }) } catch { /* ignore */ }
  }

  // After renderer.ts has attached its own listener (it does so later in the same module run), so
  // the sales handler — and its print — always sees each event first.
  setTimeout(() => {
    try {
      const live = (globalThis as { ttLive?: { onEvent: (cb: (ev: LiveEvent) => void) => void } }).ttLive
      live?.onEvent((ev) => { try { onLive(ev) } catch { /* never */ } })
    } catch (e) { console.error('[live-ui] showStats listener', e) }
  }, 0)
  setInterval(schedulePaint, RUNTIME_REPAINT_MS)
  schedulePaint()
}

function applyHq(v: FeedView<HqShowStats> | null | undefined): void {
  if (!v || typeof v !== 'object') return
  // A transient failure keeps the last figures (the "as of" time says how old they are).
  hq = v.state === 'error' && !v.data && hq?.data && hq.room === v.room ? { ...v, data: hq.data, at: hq.at } : v
  schedulePaint()
}

function resetShow(): void {
  for (const k of Object.keys(tiktok)) delete (tiktok as Record<string, unknown>)[k]
  for (const k of Object.keys(local)) delete (local as Record<string, unknown>)[k]
  runtimeBase = null
  liveStartedAtSec = undefined
}

function onLive(ev: LiveEvent): void {
  switch (ev.kind) {
    case 'room':
      if (room !== undefined && ev.roomId !== room) resetShow()
      room = ev.roomId
      if (ev.createdAt) liveStartedAtSec = ev.createdAt
      break
    case 'show_totals':
      tiktok.gmvCents = ev.gmv.cents
      if (ev.orders !== undefined) tiktok.orders = ev.orders
      tiktok.paceCents = ev.pace?.cents
      if (ev.elapsedSec) runtimeBase = { sec: ev.elapsedSec, atMs: Date.now() }
      break
    case 'sales':
      local.gmvCents = ev.totalCents
      local.orders = ev.totalSales
      break
    case 'product_stats':
      local.itemsSold = ev.totalSold
      break
    case 'roster':
      if (ev.products.length) local.itemsSold = ev.totalSold //  a gated roster says 0; not evidence
      break
    default:
      return
  }
  schedulePaint()
}

function schedulePaint(): void {
  if (paintQueued) return
  paintQueued = true
  setTimeout(() => { paintQueued = false; try { paint() } catch (e) { console.error('[live-ui] showStats paint', e) } }, 0)
}

function paint(): void {
  if (!grid || !meta) return
  const hqForRoom = hq && (!room || !hq.room || hq.room === room) ? hq : null
  const v = buildSalesView({ tiktok, local, runtimeSec: runtimeNow(runtimeBase, Date.now(), liveStartedAtSec), hq: hqForRoom })
  meta.textContent = v.note ?? ''
  meta.classList.toggle('warn', !!v.note)
  grid.replaceChildren(...v.cells.map((c) => {
    const cell = el('div', `ssf-cell${c.hq ? ' hq' : ''}`)
    cell.setAttribute('role', 'listitem')
    cell.title = c.title
    cell.append(el('div', 'l', c.label), el('div', 'v', c.value))
    if (c.hq && v.asOf) cell.append(el('div', 's', v.asOf))
    return cell
  }))
}
