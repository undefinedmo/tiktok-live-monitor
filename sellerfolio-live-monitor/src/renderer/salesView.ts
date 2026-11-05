// LANE B — the sales side of the Show screen.
//  • Live bid feed: the LAST 10 sales (live rows, incl. provisional closes). The "Search all sales"
//    box searches the live rows at once and the worker's show store (window.storeAPI.searchSales)
//    for the rest of the show, merged by order id — a live row wins, so its payment state is current.
//  • Payment issues: the live failed + lapsed rows (unchanged behaviour), plus the store's
//    payment_failed sales this show (window.storeAPI.failedPayments) that the live list has dropped.
//  • Top buyers.
//  • Past-order badges (lane D's badgeFor / requestCounts) on every SALE row — never on chat.
//    The WHALE tag is gone (BUILD.md decision 8).
// Printing first: nothing here is on the print path. renderer.ts calls onSales() after the prints
// and the repaint; every store call is an async IPC answered by the journal worker, never awaited
// by anything else, and its failure just leaves the live view.

import type { BuyerAgg, Sale, SalesUpdate } from '../core/types'
import { mergeSearch, saleFromStore, type StoreResult, type StoreChat } from '../core/storeIndex'
import { badgeFor, requestCounts, onCountsChanged } from './buyerHistory'

export interface SalesViewDeps {
  /** renderer.ts printSale — the feed / payment-issue row's reprint button. */
  printSale: (s: Sale) => void
}

/** The live state renderer.ts keeps (its sales handler and onAuctionClosed write it). */
export interface SalesState {
  /** Confirmed rows merged with provisional closes, newest first. */
  feedRows: () => Sale[]
  /** All confirmed rows seen this run (ev.recentSales). */
  allSales: () => Sale[]
  /** ev.failedPayments. */
  failedSales: () => Sale[]
}

/** Sales the feed shows when nothing is searched. */
export const FEED_SHOWN = 10
/** Rows a store search asks for. */
const SEARCH_ROWS = 200
const FAILED_SHOWN = 40
const SEARCH_DEBOUNCE_MS = 150
const STORE_FAILED_REFRESH_MS = 30_000

let deps: SalesViewDeps | null = null
let state: SalesState = { feedRows: () => [], allSales: () => [], failedSales: () => [] }
let query = ''
let searchSeq = 0
let searchTimer: ReturnType<typeof setTimeout> | undefined
let storeHits: Sale[] = []
let storeTotal = 0
let storeFailed: Sale[] = []
let lastLiveFailed = -1
let lastTopBuyers: BuyerAgg[] = []
let noteEl: HTMLElement | null = null

// ── small DOM helpers (renderer.ts's are file-local) ─────────────────────────
function el(tag: string, className?: string, text?: string): HTMLElement {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}
function payLeft(s: Sale): number | undefined {
  if (!s.paymentExpiresAt || s.paymentStatus !== 'pending') return undefined
  return Math.max(0, s.paymentExpiresAt - Date.now())
}
function fmtLeft(ms: number): string {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** One sale row (feed / payment issues share it). */
function saleRow(s: Sale, opt: { fresh?: boolean; issue?: boolean; stored?: boolean }): HTMLElement {
  const failed = s.paymentStatus === 'failed'
  const provisional = s.orderId.startsWith('prov:')
  const row = el('div', 'bidrow' + (opt.fresh ? ' fresh' : '') + (failed || opt.issue ? ' failed' : ''))
  const who = el('div', 'bidwho')
  who.appendChild(el('div', 'bidname', s.buyer.username || s.buyer.handle || '—'))
  const sub = el('div', 'bidsub')
  const badge = badgeFor(s.buyer.ttuid)
  if (badge) sub.appendChild(badge)
  if (opt.issue) sub.appendChild(el('span', 'tag failed', failed ? 'FAILED' : 'EXPIRED'))
  else if (failed) sub.appendChild(el('span', 'tag failed', 'FAILED'))
  else if (provisional) sub.appendChild(el('span', 'tag pending', 'CLOSED'))
  else if (s.paymentStatus === 'pending' && !opt.stored) {
    // A stored row's "pending" is as of when it was journaled — likely paid since — so only a live
    // row says PENDING. The real deadline, when TikTok gave one, shows which wins are about to lapse.
    const left = payLeft(s)
    const tag = el('span', 'tag pending', left === undefined ? 'PENDING' : left > 0 ? `PENDING ${fmtLeft(left)}` : 'EXPIRED')
    if (left !== undefined) tag.title = `Payment due by ${new Date(s.paymentExpiresAt!).toLocaleTimeString()}`
    sub.appendChild(tag)
  }
  sub.appendChild(document.createTextNode(`${s.skuDesc ? s.skuDesc + ' · ' : ''}${s.productName}`))
  who.appendChild(sub)
  row.appendChild(who)
  const right = el('div', 'bidright')
  right.appendChild(el('div', 'bidprice' + (failed || opt.issue ? ' failed' : ''), s.price.formatted))
  right.appendChild(el('div', 'bidtime', s.createdAt ? ago(s.createdAt) : ''))
  row.appendChild(right)
  const pb = el('button', 'printmini', '🖨')
  // the label already printed at the gavel — reprinting is the common recovery when the item comes
  // back off the pack bench and gets relisted
  pb.title = 'Reprint this label'
  pb.setAttribute('aria-label', 'Reprint this label')
  pb.addEventListener('click', () => deps?.printSale(s))
  row.appendChild(pb)
  return row
}

function askCounts(rows: readonly { buyer: { ttuid?: string } }[]): void {
  try { requestCounts(rows.map((r) => r.buyer.ttuid)) } catch { /* badges are decoration */ }
}

// ── live bid feed ────────────────────────────────────────────────────────────
export function renderSalesFeed(): void {
  const feed = document.getElementById('bidFeed')
  if (!feed) return
  feed.replaceChildren()
  if (!query) {
    const rows = state.feedRows().slice(0, FEED_SHOWN)
    if (noteEl) noteEl.textContent = rows.length ? `Last ${plural(rows.length, 'sale', 'sales')}. Search finds the rest.` : ''
    if (!rows.length) { feed.appendChild(el('div', 'mono placeholder', 'Waiting for sales…')); return }
    rows.forEach((s, i) => feed.appendChild(saleRow(s, { fresh: i === 0 })))
    askCounts(rows)
    return
  }
  const { rows, found, fromStore } = mergeSearch(state.feedRows(), storeHits, storeTotal, query)
  if (noteEl) noteEl.textContent = plural(found, 'sale found', 'sales found')
  if (!rows.length) { feed.appendChild(el('div', 'mono placeholder', 'No sales match.')); return }
  for (const s of rows) feed.appendChild(saleRow(s, { stored: fromStore.has(s.orderId) }))
  askCounts(rows)
}

function runSearch(): void {
  const q = query
  const seq = ++searchSeq
  const api = window.storeAPI
  if (!q || !api) return
  api.searchSales(q, SEARCH_ROWS).then((r: StoreResult) => {
    if (seq !== searchSeq || r.kind !== 'sales') return
    storeHits = r.rows.map(saleFromStore)
    storeTotal = r.total
    renderSalesFeed()
  }).catch(() => { /* the live matches stay */ })
}

function setupSearch(): void {
  const host = document.getElementById('feedSearch')
  if (!host || host.querySelector('input')) return
  const input = el('input', 'feed-search-in') as HTMLInputElement
  input.type = 'search'
  input.placeholder = 'Search all sales'
  input.setAttribute('aria-label', 'Search all sales')
  input.autocomplete = 'off'
  input.spellcheck = false
  noteEl = el('div', 'feed-note')
  noteEl.setAttribute('aria-live', 'polite')
  host.replaceChildren(input, noteEl)
  input.addEventListener('input', () => {
    const next = input.value.trim()
    if (next === query) return
    query = next
    storeHits = []
    storeTotal = 0
    searchSeq++ // drop any answer still in flight for the old text
    if (searchTimer) clearTimeout(searchTimer)
    if (query) searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS)
    renderSalesFeed() // the live matches show at once; the store's join them when they arrive
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) { input.value = ''; input.dispatchEvent(new Event('input')) }
  })
}

// ── payment issues ───────────────────────────────────────────────────────────
export function renderPaymentIssues(): void {
  const panel = document.getElementById('failedPanel')
  const list = document.getElementById('failedList')
  const count = document.getElementById('failedCount')
  if (!panel || !list) return
  const live = state.failedSales()
  const all = state.allSales()
  // Expired-but-not-yet-flipped rows belong here too: auction_result can take a while to move
  // order_status to 2, and a lapsed deadline is already a decision the room can act on.
  const now = Date.now()
  const byId = new Map<string, Sale>()
  for (const s of live) byId.set(s.orderId, s)
  for (const s of all) if (s.paymentStatus === 'pending' && s.paymentExpiresAt && s.paymentExpiresAt <= now && !byId.has(s.orderId)) byId.set(s.orderId, s)
  // The store's failures this show: the ones the live list no longer carries (capped history, or
  // an app restart). A live row that has since been paid wins over the stored failure.
  const liveState = new Map(all.map((s) => [s.orderId, s.paymentStatus] as const))
  for (const s of storeFailed) if (!byId.has(s.orderId) && liveState.get(s.orderId) !== 'paid' && liveState.get(s.orderId) !== 'pending') byId.set(s.orderId, s)
  const rows = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt)
  panel.style.display = rows.length ? '' : 'none'
  if (count) count.textContent = String(rows.length)
  list.replaceChildren()
  const shown = rows.slice(0, FAILED_SHOWN)
  for (const s of shown) list.appendChild(saleRow(s, { issue: true }))
  askCounts(shown)
}

function refreshStoreFailed(): void {
  const api = window.storeAPI
  if (!api) return
  api.failedPayments(SEARCH_ROWS).then((r: StoreResult) => {
    if (r.kind !== 'failed') return
    const next = r.rows.map(saleFromStore)
    const same = next.length === storeFailed.length && next.every((s, i) => s.orderId === storeFailed[i]!.orderId)
    storeFailed = next
    if (!same) renderPaymentIssues()
  }).catch(() => { /* the live list stays */ })
}

// ── top buyers ───────────────────────────────────────────────────────────────
// Ranked leaderboard for the live session. buyers is ev.topBuyers — already sorted by spend desc
// and recomputed each sales poll — so ranks 2-8 visibly move as sales land.
const TOP_BUYERS_SHOWN = 8
export function renderTopBuyers(buyers: BuyerAgg[]): void {
  lastTopBuyers = buyers
  const list = document.getElementById('topBuyersList')
  if (!list) return
  list.replaceChildren()
  const countEl = document.getElementById('topBuyersCount')
  if (countEl) countEl.textContent = buyers.length ? plural(buyers.length, 'buyer', 'buyers') : ''
  if (!buyers.length) {
    const empty = el('div', 'mono', 'No sales yet')
    empty.style.cssText = 'font-size:11px;color:var(--ink-4);'
    list.appendChild(empty)
    return
  }
  const shown = buyers.slice(0, TOP_BUYERS_SHOWN)
  shown.forEach((b, i) => {
    const lead = i === 0
    const row = el('div', 'topbuyer')
    row.style.cssText = 'display:flex;align-items:center;gap:9px;'
    const rk = el('div', 'mono', String(i + 1))
    rk.style.cssText = `width:15px;text-align:center;font-size:11px;font-weight:${lead ? '700' : '400'};color:${lead ? 'var(--accent)' : 'var(--ink-4)'};`
    const name = el('div', 'topbuyer-name', '@' + (b.handle ?? (b.username || '—')))
    name.style.cssText = `flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:${lead ? '600' : '400'};color:${lead ? 'var(--ink)' : 'var(--ink-2)'};`
    const spend = el('div', 'mono', `$${(b.totalCents / 100).toFixed(0)}`)
    spend.style.cssText = 'margin-left:auto;font-size:12.5px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums;'
    const items = el('div', 'mono', `·${b.itemCount}`)
    items.style.cssText = 'width:26px;text-align:right;font-size:11px;color:var(--ink-4);'
    row.append(rk, name)
    const badge = badgeFor(b.ttuid)
    if (badge) row.appendChild(badge)
    row.append(spend, items)
    list.appendChild(row)
  })
  try { requestCounts(shown.map((b) => b.ttuid)) } catch { /* decoration */ }
}

// ── chat search, for lane C (the store answers it; a missing store answers empty) ────
/** Search this show's whole chat in the worker store. Never rejects. */
export function searchChat(text: string, limit?: number): Promise<{ rows: StoreChat[]; total: number }> {
  const api = window.storeAPI
  if (!api) return Promise.resolve({ rows: [], total: 0 })
  return api.searchChat(text, limit).then(
    (r: StoreResult) => (r.kind === 'chat' ? { rows: r.rows, total: r.total } : { rows: [], total: 0 }),
    () => ({ rows: [], total: 0 }),
  )
}

// ── wiring ───────────────────────────────────────────────────────────────────
/** renderer.ts's lane-B fence hands over the live state it keeps. */
export function bindSalesState(s: SalesState): void {
  state = s
}

/** Called once by renderer.ts at startup. */
export function initSalesView(d: SalesViewDeps): void {
  deps = d
  setupSearch()
  try {
    onCountsChanged(() => {
      try { renderSalesFeed(); renderPaymentIssues(); renderTopBuyers(lastTopBuyers) } catch (e) { console.error('[live-ui] salesView repaint', e) }
    })
  } catch { /* no badges, still a feed */ }
  // The store's failures this show (a restart mid-show must still list them); then now and then,
  // in case one lands while the live list is capped. Async IPC, never on the print path.
  setTimeout(refreshStoreFailed, 3000)
  setInterval(refreshStoreFailed, STORE_FAILED_REFRESH_MS)
}

/**
 * Called once per 'sales' event, AFTER printing and after renderer.ts's own paint. `fresh` are the
 * rows saleSeed judged new this poll. Must not block: no awaits on anything renderer.ts waits for.
 */
export function onSales(ev: SalesUpdate, fresh: Sale[]): void {
  // A search that is open keeps finding: new sales may match it, so ask the store again.
  if (query && fresh.length) {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS)
  }
  if (ev.failedPayments.length !== lastLiveFailed) {
    lastLiveFailed = ev.failedPayments.length
    refreshStoreFailed()
  }
}
