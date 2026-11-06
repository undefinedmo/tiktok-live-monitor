// LANE G — the show timeline, on its own Timeline screen (#timelineScreen → #showTimeline). It draws
// SellerFolio's timeline for this room — auction runs as bars (sold / unsold / unknown), viewer chat
// per minute, question dots, flag triangles and "Said" diamonds — on one time axis, the same picture
// as the show page in SellerFolio (layout ported to core/timelineLayout.ts). Above it, #tlsMetrics:
// lots / sell-through / chat figures from the same payload (core/timelineMetrics.ts).
//
// Data comes from main (electron/showStats.ts), which polls hq only while the screen is SHOWING
// (renderer.ts showScreen → setTimelineVisible). The tracks grow to fill the screen's height.
// Hover shows details; clicking a bar (or Enter on it) opens a small popover with that run's
// product, price and buyer — from the payload, no hq call.
// Every wire string goes in through textContent, never innerHTML.

import {
  axisTicks, barAria, clockLabel, fitLabel, flagLabel, kindClass, layoutBars, layoutChat, makeScale, MIN_MS, OUTCOME_LABEL,
  placeMarkers, plotWidth, priceOf, productOf, saidRuns, scrollForZoom, followScroll, timeDomain, timelineSummary, topicLabel, ZOOMS,
  type BarLayout, type ShowTimeline, type TimelineAuction,
} from '../core/timelineLayout'
import { clockShort, type FeedView } from '../core/showStats'
import { timelineMetrics } from '../core/timelineMetrics'

const SVG = 'http://www.w3.org/2000/svg'
// Full-screen sizes. The chat track takes whatever height is left (CHAT_MIN at least).
const H_AXIS = 28, H_RUN = 64, H_MARK = 30, CHAT_MIN = 120, CHAT_FALLBACK = 220
const VIEW_FALLBACK = 900
let H_CHAT = CHAT_FALLBACK

interface Deps { setOpen: (open: boolean) => void }

let root: HTMLElement | null = null
let metrics: HTMLElement | null = null
let sum: HTMLElement | null = null
let body: HTMLElement | null = null
let msg: HTMLElement | null = null
let plot: HTMLElement | null = null
let labels: HTMLElement | null = null
let scroller: HTMLElement | null = null
let foot: HTMLElement | null = null
let zoomBtns: { out: HTMLButtonElement; fit: HTMLButtonElement; in: HTMLButtonElement } | null = null
let tip: HTMLElement | null = null
let pop: HTMLElement | null = null

let feed: FeedView<ShowTimeline> = { room: null, state: 'off', data: null, at: null }
let open = false
let zoomIdx = 0
let selKey: string | null = null
let lastPlotW = 0
let bars: BarLayout[] = []
let deps: Deps | null = null

function h(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}
function s(tag: string, attrs: Record<string, string | number>, cls?: string): SVGElement {
  const e = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  if (cls) e.setAttribute('class', cls)
  return e
}
export function initTimeline(d: Deps): void {
  root = document.getElementById('showTimeline')
  if (!root) return
  deps = d
  root.replaceChildren()
  root.hidden = false
  metrics = document.getElementById('tlsMetrics')

  const head = h('div', 'tl-head')
  head.append(h('span', 'eyebrow', 'Auctions & chat'))
  sum = h('span', 'tl-sum')
  head.append(sum)

  body = h('div', 'tl-body')
  body.id = 'tlBody'
  const tools = h('div', 'tl-tools')
  const legend = h('span', 'tl-legend')
  legend.setAttribute('aria-hidden', 'true')
  for (const [k, l] of [['sold', 'Sold'], ['unsold', 'Unsold'], ['unknown', 'Unknown']] as const) {
    const it = h('span')
    it.append(h('i', `tl-sw ${k}`), document.createTextNode(l))
    legend.append(it)
  }
  const hint = h('span', 'tl-hint', 'Click a lot for details')
  const zoom = h('span', 'tl-zoom')
  const zb = (label: string, text: string): HTMLButtonElement => {
    const b = h('button', 'tl-zb', text) as HTMLButtonElement
    b.type = 'button'
    b.setAttribute('aria-label', label)
    return b
  }
  zoomBtns = { out: zb('Zoom out', '−'), fit: zb('Fit the whole show', 'Fit'), in: zb('Zoom in', '+') }
  zoomBtns.out.addEventListener('click', () => setZoom(zoomIdx - 1))
  zoomBtns.fit.addEventListener('click', () => setZoom(0))
  zoomBtns.in.addEventListener('click', () => setZoom(zoomIdx + 1))
  zoom.append(zoomBtns.out, zoomBtns.fit, zoomBtns.in)
  tools.append(legend, hint, zoom)

  msg = h('div', 'tl-msg')
  plot = h('div', 'tl-plot')
  labels = h('div', 'tl-labels')
  labels.setAttribute('aria-hidden', 'true')
  scroller = h('div', 'tl-scroll sf-scroll')
  scroller.addEventListener('scroll', hideTip)
  plot.append(labels, scroller)
  foot = h('div', 'tl-foot')
  body.append(tools, msg, plot, foot)
  root.append(head, body)

  tip = h('div', 'tl-tip')
  tip.setAttribute('role', 'tooltip')
  tip.hidden = true
  pop = h('div', 'tl-pop')
  pop.setAttribute('role', 'dialog')
  pop.setAttribute('aria-label', 'Lot details')
  pop.hidden = true
  document.body.append(tip, pop)

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop?.hidden) closePop(true) })
  document.addEventListener('mousedown', (e) => {
    if (!pop || pop.hidden) return
    const t = e.target as Node
    if (pop.contains(t) || (scroller?.contains(t) && (t as Element).closest?.('[data-run],[data-said]'))) return
    closePop(false)
  })
  if (typeof ResizeObserver !== 'undefined') {
    let lastW = 0, lastH = 0
    const box = body
    new ResizeObserver(() => {
      const w = box.clientWidth, hh = box.clientHeight
      if (open && w > 0 && (Math.abs(w - lastW) > 2 || Math.abs(hh - lastH) > 2)) { lastW = w; lastH = hh; render() }
    }).observe(box)
  }
  // "Last 15 min" moves with the clock, not only with hq's pushes.
  setInterval(() => { if (open) paintMetrics() }, 30_000)
  applyOpen()
}

/** renderer.ts showScreen: the Timeline screen is (or is no longer) on screen. */
export function setTimelineVisible(v: boolean): void {
  if (v === open) return
  open = v
  applyOpen()
}
function applyOpen(): void {
  if (!body || !root) return
  try { deps?.setOpen(open) } catch { /* never */ }
  if (!open) { hideTip(); closePop(false) }
  render()
}

function paintMetrics(): void {
  if (!metrics) return
  const t = feed.data
  if (!t || !t.auctions.length && !t.chatBuckets.length) { metrics.hidden = true; return }
  metrics.hidden = false
  const grid = h('div', 'ssf-grid')
  grid.setAttribute('role', 'list')
  for (const c of timelineMetrics(t, Date.now())) {
    const cell = h('div', 'ssf-cell')
    cell.setAttribute('role', 'listitem')
    cell.title = c.title
    cell.append(h('div', 'l', c.label), h('div', 'v', c.value))
    if (c.sub) cell.append(h('div', 's', c.sub))
    grid.append(cell)
  }
  const head = h('div', 'ssf-head')
  head.append(h('span', 'eyebrow', 'Lots & chat'), h('span', 'ssf-meta', feed.at ? `From SellerFolio · as of ${clockShort(feed.at)}` : ''))
  metrics.replaceChildren(head, grid)
}
function setZoom(i: number): void {
  const next = Math.max(0, Math.min(ZOOMS.length - 1, i))
  if (next === zoomIdx) return
  const el = scroller
  const viewW = el?.clientWidth || VIEW_FALLBACK
  const from = lastPlotW || plotWidth(viewW, ZOOMS[zoomIdx]!)
  const left = el?.scrollLeft ?? 0
  zoomIdx = next
  const to = plotWidth(viewW, ZOOMS[zoomIdx]!)
  render()
  if (el) el.scrollLeft = scrollForZoom(left, viewW, from, to)
}

/** main's push (or the snapshot on start). */
export function onTimeline(v: FeedView<ShowTimeline> | null | undefined): void {
  if (!v || typeof v !== 'object') return
  if (v.room !== feed.room) { selKey = null; closePop(false); zoomIdx = 0 }
  // Transient failure: keep drawing the last timeline we had.
  feed = v.state === 'error' && !v.data && feed.data && v.room === feed.room ? { ...v, data: feed.data, at: feed.at } : v
  render()
}

function message(): string | null {
  const st = feed.state
  if (st === 'off') return 'Connect this computer to SellerFolio to see the timeline.'
  if (st === 'unavailable') return 'Available once SellerFolio is updated.'
  if (st === 'auth' && !feed.data) return 'SellerFolio refused this computer. Check Settings → SellerFolio.'
  if (!feed.room) return 'Waiting for the show…'
  if (!feed.data) return st === 'error' ? 'SellerFolio is not answering. Trying again…' : 'Loading the timeline…'
  return null
}

function render(): void {
  if (!root || !sum || !msg || !plot || !labels || !scroller || !foot || !zoomBtns) return
  const t = feed.data
  sum.textContent = t && t.auctions.length ? timelineSummary(t) : ''
  if (!open) return
  paintMetrics()

  const text = message()
  const domain = t ? timeDomain(t) : null
  const empty = !text && (!t || !domain)
  msg.textContent = text ?? (empty ? 'Nothing from this show has reached SellerFolio yet. The timeline fills in as the show uploads.' : '')
  msg.hidden = !text && !empty
  const drawable = !text && !!t && !!domain
  plot.hidden = !drawable
  zoomBtns.out.disabled = !drawable || zoomIdx === 0
  zoomBtns.fit.disabled = !drawable || zoomIdx === 0
  zoomBtns.in.disabled = !drawable || zoomIdx === ZOOMS.length - 1
  zoomBtns.fit.textContent = ZOOMS[zoomIdx] === 1 ? 'Fit' : `${ZOOMS[zoomIdx]}×`
  foot.textContent = feed.at ? `From SellerFolio · as of ${clockShort(feed.at)}${feed.state === 'error' ? ' · could not refresh, trying again' : ''}` : ''
  foot.hidden = !feed.at || !drawable
  if (!drawable || !t || !domain) { scroller.replaceChildren(); labels.replaceChildren(); bars = []; return }

  const viewW = scroller.clientWidth || VIEW_FALLBACK
  const W = plotWidth(viewW, ZOOMS[zoomIdx]!)
  // Chat fills the height the screen gives the plot, after the fixed tracks (and a scrollbar's room).
  const fixed = H_AXIS + H_RUN + H_MARK * (1 + (t.flags.length ? 1 : 0) + (t.auctions.some((a) => a.outcome === 'sold' && a.item?.summary?.trim()) ? 1 : 0))
  const avail = plot.clientHeight
  H_CHAT = avail > 0 ? Math.max(CHAT_MIN, avail - fixed - 16) : CHAT_FALLBACK
  const prev = { scrollLeft: scroller.scrollLeft, viewW, plotW: lastPlotW || W }
  const sc = makeScale(domain.t0, domain.t1, W)
  bars = layoutBars(t.auctions, sc)
  const said = saidRuns(bars)
  const qs = placeMarkers(t.questions, sc)
  const fl = placeMarkers(t.flags, sc)
  const chat = layoutChat(t.chatBuckets, sc, H_CHAT - 8)
  const tracks: { key: string; label: string; h: number }[] = [
    { key: 'axis', label: '', h: H_AXIS },
    { key: 'runs', label: 'Auctions', h: H_RUN },
    { key: 'chat', label: 'Chat', h: H_CHAT },
    { key: 'qs', label: 'Questions', h: H_MARK },
    ...(fl.length ? [{ key: 'flags', label: 'Flags', h: H_MARK }] : []),
    ...(said.length ? [{ key: 'said', label: 'Said', h: H_MARK }] : []),
  ]
  const top: Record<string, number> = {}
  let acc = 0
  for (const tr of tracks) { top[tr.key] = acc; acc += tr.h }
  const H = acc

  labels.replaceChildren(...tracks.map((tr) => { const l = h('div', 'tl-lab', tr.label); l.style.height = `${tr.h}px`; return l }))

  const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Show timeline' }, 'tl-svg')
  for (const tr of tracks.slice(1)) svg.append(s('line', { x1: 0, x2: W, y1: top[tr.key]!, y2: top[tr.key]! }, 'tl-sep'))
  for (const tk of axisTicks(sc)) {
    svg.append(s('line', { x1: tk.x, x2: tk.x, y1: H_AXIS - 4, y2: H }, 'tl-grid'))
    const tx = s('text', { x: tk.x, y: H_AXIS - 8, 'text-anchor': 'middle' }, 'tl-tick')
    tx.textContent = clockLabel(tk.ms)
    svg.append(tx)
  }
  const selBar = selKey ? bars.find((b) => b.key === selKey) : undefined
  if (selBar) svg.append(s('rect', { x: selBar.x, y: H_AXIS, width: Math.max(2, selBar.w), height: H - H_AXIS }, 'tl-selspan'))

  const runs = s('g', {}, `tl-runs${selBar ? ' has-sel' : ''}`)
  bars.forEach((b, i) => {
    const on = b.key === selKey
    const g = s('g', { 'data-run': i, role: 'button', tabindex: 0, 'aria-label': barAria(b.run), 'aria-pressed': String(on) }, `tl-run ${b.run.outcome}${on ? ' sel' : ''}`)
    const y = top['runs']! + 5, bh = H_RUN - 10
    g.append(s('rect', { x: b.hx, y: top['runs']!, width: b.hw, height: H_RUN }, 'tl-runhit'))
    g.append(s('rect', { x: b.x, y, width: b.w, height: bh, rx: b.w > 4 ? 2 : 0 }, 'tl-runbar'))
    const label = fitLabel(b.run, b.w)
    if (label) { const tx = s('text', { x: b.x + 4, y: y + bh / 2 + 3.5 }, 'tl-runlbl'); tx.textContent = label; g.append(tx) }
    runs.append(g)
  })
  svg.append(runs)

  const cg = s('g', {})
  chat.cols.forEach((c, i) => {
    const base = top['chat']! + H_CHAT - 2
    const g = s('g', { 'data-chat': i })
    g.append(s('rect', { x: c.x, y: top['chat']!, width: Math.max(1, sc.x(c.atMs + MIN_MS) - c.x), height: H_CHAT }, 'tl-chathit'))
    if (c.hLines > 0) g.append(s('rect', { x: c.x, y: base - c.hLines, width: c.w, height: c.hLines }, 'tl-chat'))
    if (c.hQuestions > 0) g.append(s('rect', { x: c.x, y: base - c.hQuestions, width: c.w, height: c.hQuestions }, 'tl-chatq'))
    cg.append(g)
  })
  if (chat.max > 0) { const pk = s('text', { x: 4, y: top['chat']! + 11 }, 'tl-peak'); pk.textContent = `peak ${chat.max}/min`; cg.append(pk) }
  svg.append(cg)

  const qg = s('g', {})
  qs.forEach(({ m, x }, i) => qg.append(s('circle', { 'data-q': i, cx: x, cy: top['qs']! + H_MARK / 2, r: 3.2 }, `tl-q k-${kindClass(m.kind)}`)))
  svg.append(qg)
  if (fl.length) {
    const fg = s('g', {})
    const y = top['flags']! + H_MARK / 2
    fl.forEach(({ x }, i) => fg.append(s('path', { 'data-f': i, d: `M${x},${y - 5} L${x + 5},${y + 4} L${x - 5},${y + 4} Z` }, 'tl-flag')))
    svg.append(fg)
  }
  if (said.length) {
    const sg = s('g', {})
    for (const b of said) {
      const cx = b.x + b.w / 2, cy = top['said']! + H_MARK / 2
      sg.append(s('rect', { 'data-said': bars.indexOf(b), x: cx - 3.5, y: cy - 3.5, width: 7, height: 7, rx: 1.5, transform: `rotate(45 ${cx} ${cy})` }, `tl-said${b.key === selKey ? ' sel' : ''}`))
    }
    svg.append(sg)
  }

  // Hover / click / keyboard, delegated: one listener set per render, on the fresh svg.
  const lines = { qs, fl, chat }
  svg.addEventListener('mousemove', (e) => hoverAt(e, lines))
  svg.addEventListener('mouseleave', hideTip)
  svg.addEventListener('click', (e) => {
    const i = idxOf(e.target, 'data-run') ?? idxOf(e.target, 'data-said')
    if (i !== null && bars[i]) toggle(bars[i]!.run, e.clientX, e.clientY)
  })
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const i = idxOf(e.target, 'data-run')
    if (i === null || !bars[i]) return
    e.preventDefault()
    const r = (e.target as Element).getBoundingClientRect()
    toggle(bars[i]!.run, r.left + r.width / 2, r.bottom)
  })
  svg.addEventListener('focusin', (e) => {
    const i = idxOf(e.target, 'data-run')
    if (i === null || !bars[i]) return
    const r = (e.target as Element).getBoundingClientRect()
    showTip(r.left + r.width / 2, r.top, runTip(bars[i]!.run))
  })
  svg.addEventListener('focusout', hideTip)

  scroller.replaceChildren(svg)
  // A view following the live edge stays on it as the show grows; otherwise keep the position.
  scroller.scrollLeft = lastPlotW ? followScroll(prev, W) : Math.max(0, W - viewW)
  lastPlotW = W
}

function idxOf(target: EventTarget | null, attr: string): number | null {
  const el = (target as Element | null)?.closest?.(`[${attr}]`)
  if (!el) return null
  const n = Number(el.getAttribute(attr))
  return Number.isInteger(n) && n >= 0 ? n : null
}

type Lines = { qs: ReturnType<typeof placeMarkers>; fl: ReturnType<typeof placeMarkers>; chat: ReturnType<typeof layoutChat> }

function hoverAt(e: MouseEvent, l: Lines): void {
  const t = e.target
  let i: number | null
  if ((i = idxOf(t, 'data-run')) !== null && bars[i]) return showTip(e.clientX, e.clientY, runTip(bars[i]!.run))
  if ((i = idxOf(t, 'data-said')) !== null && bars[i]) {
    const r = bars[i]!.run
    return showTip(e.clientX, e.clientY, [[`${r.lot}${productOf(r) ? ` · ${productOf(r)}` : ''}`, 'b'], [r.item?.summary ?? '', 'tx']])
  }
  if ((i = idxOf(t, 'data-q')) !== null && l.qs[i]) {
    const m = l.qs[i]!.m
    return showTip(e.clientX, e.clientY, [[`${topicLabel(m.kind)}${m.lot ? ` · ${m.lot}` : ''} · ${clockLabel(m.atMs)}`, 'b'], [m.text, 'tx']])
  }
  if ((i = idxOf(t, 'data-f')) !== null && l.fl[i]) {
    const m = l.fl[i]!.m
    return showTip(e.clientX, e.clientY, [[`${flagLabel(m.kind)}${m.lot ? ` · ${m.lot}` : ''} · ${clockLabel(m.atMs)}`, 'b'], [m.text, 'tx']])
  }
  if ((i = idxOf(t, 'data-chat')) !== null && l.chat.cols[i]) {
    const c = l.chat.cols[i]!
    return showTip(e.clientX, e.clientY, [[clockLabel(c.atMs), 'b'], [`${c.b.viewerLines} viewer line${c.b.viewerLines === 1 ? '' : 's'} · ${c.b.questions} question${c.b.questions === 1 ? '' : 's'}`, '']])
  }
  hideTip()
}

type TipLine = [string, '' | 'b' | 'tx' | 'mut']

function runTip(a: TimelineAuction): TipLine[] {
  const price = priceOf(a)
  const out: TipLine[] = [[`${a.lot} · ${OUTCOME_LABEL[a.outcome]}${price ? ` · ${price}` : ''}`, 'b']]
  const p = productOf(a)
  if (p) out.push([p, ''])
  if (a.buyerName) out.push([`Buyer: ${a.buyerName}`, ''])
  if (a.bids != null) out.push([`${a.bids} bid${a.bids === 1 ? '' : 's'}`, ''])
  out.push([`ended ${clockLabel(a.endMs, true)}`, 'mut'])
  return out
}

function fill(el: HTMLElement, lines: TipLine[]): void {
  el.replaceChildren(...lines.filter(([t]) => t).map(([t, k]) => h(k === 'b' ? 'b' : 'span', k === 'b' ? '' : `tl-tipln${k ? ` ${k}` : ''}`, t)))
}

function place(el: HTMLElement, x: number, y: number, w: number, hgt: number): void {
  const vw = window.innerWidth, vh = window.innerHeight
  el.style.left = `${Math.max(8, Math.min(x + 14, vw - w - 8))}px`
  if (y > vh - hgt - 20) { el.style.top = ''; el.style.bottom = `${vh - y + 10}px` } else { el.style.bottom = ''; el.style.top = `${y + 16}px` }
}

function showTip(x: number, y: number, lines: TipLine[]): void {
  if (!tip || (pop && !pop.hidden)) return
  fill(tip, lines)
  tip.hidden = false
  place(tip, x, y, 288, 140)
}
function hideTip(): void { if (tip) tip.hidden = true }

function toggle(a: TimelineAuction, x: number, y: number): void {
  const key = `${a.lot}@${a.endMs}`
  if (selKey === key && pop && !pop.hidden) { closePop(true); return }
  selKey = key
  hideTip()
  render()
  openPop(a, x, y)
}

function openPop(a: TimelineAuction, x: number, y: number): void {
  if (!pop) return
  const price = priceOf(a)
  const headRow = h('div', 'tl-pophead')
  headRow.append(h('b', '', `${a.lot}${price ? ` · ${price}` : ''}`), h('span', `tl-pill ${a.outcome}`, OUTCOME_LABEL[a.outcome]))
  const x2 = h('button', 'tl-popx', '✕') as HTMLButtonElement
  x2.type = 'button'
  x2.setAttribute('aria-label', 'Close')
  x2.addEventListener('click', () => closePop(true))
  headRow.append(x2)
  const rows = h('dl', 'tl-popkv')
  const kv = (k: string, v: string | null | undefined) => { if (!v) return; rows.append(h('dt', '', k), h('dd', '', v)) }
  kv('Product', productOf(a))
  if (a.item && (a.item.brand || a.item.item) && a.productName && a.productName !== productOf(a)) kv('Listing', a.productName)
  kv('Size', a.item?.size)
  kv('Color', a.item?.color)
  kv('Buyer', a.buyerName ?? (a.outcome === 'sold' ? 'Not known yet' : null))
  kv('Price', price ?? (a.outcome === 'sold' ? 'Not known yet' : null))
  kv('Bids', a.bids != null ? String(a.bids) : null)
  kv('Ran', a.startMs != null ? `${clockLabel(a.startMs, true)} – ${clockLabel(a.endMs, true)}` : `ended ${clockLabel(a.endMs, true)}`)
  kv('Order', a.orderId)
  pop.replaceChildren(headRow, rows)
  const said = a.item?.summary?.trim()
  if (said) { const sd = h('div', 'tl-popsaid'); sd.append(h('span', 'eyebrow', 'Host said'), h('p', '', said)); pop.append(sd) }
  pop.hidden = false
  place(pop, x, y, 300, 240)
  x2.focus({ preventScroll: true })
}

function closePop(refocus: boolean): void {
  if (!pop || pop.hidden) { if (selKey && !refocus) { selKey = null; render() } return }
  pop.hidden = true
  const key = selKey
  selKey = null
  render()
  if (refocus && key && scroller) {
    const i = bars.findIndex((b) => b.key === key)
    if (i >= 0) (scroller.querySelector(`[data-run="${i}"]`) as SVGElement | null)?.focus({ preventScroll: true })
  }
}
