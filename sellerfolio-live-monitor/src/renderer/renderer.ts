import flvjs from 'flv.js'
import type { LiveEvent, Sale, BuyerAgg, RosterProduct, ProductRollup, PinnedAuction, ChatMessage } from '../core/types'
import { labelHtml, LABEL_SIZES, basePt, parseItemNumber, extractCustom } from '../electron/label' // portable (no electron deps) — renders the real print HTML for the preview
import { labelNeedsHtml } from '../electron/zplLabel' // preview-only: which print path this label would take
import { PrintDedup } from '../core/printDedup'
import { SaleSeed } from '../core/saleSeed'
import { labelCode } from '../core/labelCode'
import { parseConnectToken, connectScreen } from '../core/sfConnect'
import type { StoreResult } from '../core/storeIndex'
import type { HotkeyStatus } from '../core/hotkeys'
import type { RunNextPlan } from '../core/runNext'
import { initHotkeysCard } from './hotkeysCard' // Settings → Clicker & keys
// live-ui lanes (docs/live-ui/LANES.md): each module is owned by one lane; this file only calls them.
import { initShell, onScreen, type Screen } from './shell' // lane A
import { initSalesView, onSales } from './salesView' // lane B
import { initChatDesk, onChat, onChatScreenShown } from './chatDesk' // lane C
import { initBuyerHistory } from './buyerHistory' // lane D
import { initPrintLog, onPrintResult } from './printLog' // lane E
import { initDesigner } from './designer' // lane F
import { initShowStats } from './showStats' // lane G: Sales so far + show timeline
import { setTimelineVisible } from './timelineView' // the Timeline screen

// ┌── lane F: label template types (moves to designer.ts) ─────────────────────
// The print path's own types (the template may carry the designer's `layout`). The template
// itself lives in designer.ts; `labelTemplate` is its live export, read by printLabel.
type LabelData = import('../electron/label').LabelData
type LabelTemplate = import('../electron/label').LabelTemplate
import { labelTemplate, setupDesigner, refreshPrinterButtons } from './designer' // lane F (live binding)
// └── end lane F ────────────────────────────────────────────────────────────────
declare global {
  interface Window {
    ttLive: { onEvent: (cb: (ev: LiveEvent) => void) => void }
    labelAPI: {
      getPrinters: () => Promise<{ printers: { name: string; displayName: string; isDefault: boolean }[]; saved: string; rawZpl: boolean; dry?: boolean }>
      savePrinter: (name: string) => Promise<boolean>
      setRawZpl: (enabled: boolean) => Promise<boolean>
      // spoolMs: queue → spooler, measured in main (lane E's Print log shows it)
      print: (labelData: LabelData, printerName: string, template: LabelTemplate) => Promise<{ success: boolean; error?: string; spoolMs?: number }>
    }
    updateAPI?: {
      onReady: (cb: (info: { version: string }) => void) => void
    }
    recapAPI?: {
      suggestRegex?: (payload: { title: string; want: string }) => Promise<{ regex?: string; flags?: string; explain?: string; error?: string }>
    }
    syncAPI?: {
      connection: () => Promise<{ loggedIn: boolean; hasShow: boolean; polling: boolean }>
      openMonitor: () => Promise<{ ok: boolean }>
    }
    chatAPI?: {
      send: (text: string) => Promise<{ ok: boolean; error?: string }>
      onSent: (cb: (r: { ok: boolean; error?: string }) => void) => void
    }
    diagAPI?: {
      open: () => Promise<{ ok: boolean; path?: string }>
    }
    sfSyncAPI?: {
      get: () => Promise<SfSyncView>
      connect: (token: string) => Promise<SfSyncView & { ok: boolean; error?: string }>
      disconnect: () => Promise<SfSyncView>
      openFolder: () => Promise<{ ok: boolean }>
      openSettings?: () => Promise<{ ok: boolean }>
      onState: (cb: (s: SfSyncView) => void) => void
    }
    // ── live-ui bridges (preload-viewer.ts; handlers in electron/controlIpc.ts, storeIpc.ts, buyerHistory.ts)
    /** lane A: window zoom (1 = 100%) for Text size, and hardware buttons ('printLast' = Print last). */
    controlAPI?: {
      getZoom: () => Promise<number>
      setZoom: (factor: number) => Promise<number>
      onKey: (cb: (action: string) => void) => void
      getHotkeys: () => Promise<HotkeyStatus>
      addHotkey: (action: string, accel: string) => Promise<HotkeyStatus & { error?: string }>
      removeHotkey: (action: string, accel: string) => Promise<HotkeyStatus>
      learnHotkey: (on: boolean) => Promise<void>
    }
    /** electron/runNext.ts: Run next lot. start resolves with TikTok's real answer. */
    runAPI?: {
      start: () => Promise<{ ok: boolean; error?: string }>
      getPlan: () => Promise<RunNextPlan>
      onPlan: (cb: (p: RunNextPlan) => void) => void
    }
    /** lane B: the show store in the journal worker. Resolves empty (never rejects) when there is none. */
    storeAPI?: {
      searchSales: (text: string, limit?: number) => Promise<StoreResult>
      searchChat: (text: string, limit?: number) => Promise<StoreResult>
      failedPayments: (limit?: number) => Promise<StoreResult>
    }
    /** lane D: past-order counts by ttuid. lookup answers from main's cache now; onCounts gets fetched ones later. */
    buyerAPI?: {
      lookup: (ids: string[]) => Promise<{ counts: Record<string, number> }>
      onCounts: (cb: (p: { counts: Record<string, number> }) => void) => void
    }
  }
}

// Injected by esbuild (define) from package.json at build time — the ONLY version source
// for the UI. The old hardcoded badge ('v1.2.7-debug') outlived three releases.
declare const __APP_VERSION__: string

const $ = (id: string) => document.getElementById(id)!
const txt = (s: string) => document.createTextNode(s)
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

// ┌── lane F: the saved label template (moves to designer.ts; printLabel reads labelTemplate) ──
// Moved: designer.ts loads 'tt-label-template' and exports `labelTemplate` (imported above).
// └── end lane F ────────────────────────────────────────────────────────────────

// ── state ───────────────────────────────────────────────────────────────────
let sessionStart: number | undefined // current_session.start_time (scheduled)
let liveStartedAt: number | undefined // room create_timestamp (actual go-live) — drives the elapsed timer
let pinnedEndMs: number | undefined
let lastLotName: string | undefined // most recent lot's product name — fallback title source for fast-path prints
let lotSoldAt = 0 // last auction-closed paint — tickCountdown holds SOLD for 10s
let serverTimeOffsetMs = 0 // from pin/get (resp_server_time − client clock); corrects the auction countdown
// True once GMV comes from TikTok's own numbers (show_totals, or the legacy WS core_stats)
// rather than from summing the sales this app happened to capture.
let gmvAuthoritative = false
// Has a roster/product_stats body actually reported a sold count? While TikTok serves a
// verification puzzle the roster comes back as a bare {"code":0}, which parses to zero
// products and totalSold 0 — and that was being written straight to the SALES card every
// 1.5s, so a show with 68 sales displayed 0. Track whether we have a real number; until
// then the order-row total stands in, the same way locally-summed GMV does below.
let salesAuthoritative = false
let showElapsedSec = 0
// Viewers has no working source right now: it only ever arrived on the dead frontier WS,
// and no REST response carries it. A stats_type discovery sweep runs each session to find
// the insights metric id (see "[stats-probe]" in the flight log). Until one is wired,
// show an honest placeholder instead of a number frozen at whatever last arrived.
let viewersFresh = 0
const VIEWERS_STALE_MS = 60000
function setViewers(n: number | null) {
  const text = n === null ? '—' : String(n)
  $('viewers').textContent = text
  $('chatViewers').textContent = text
}
const saleSeed = new SaleSeed()
const rosterProducts = new Map<string, RosterProduct>()
let lastByProduct: ProductRollup[] = []
const stats = { sales: '0', gmv: '$0.00', pace: '—', buyers: '0', failed: '0', gpm: '—' }

// ── stat tiles ──────────────────────────────────────────────────────────────
function renderStats() {
  const tiles: [string, string, string, boolean][] = [
    ['SALES', stats.sales, '', false],
    ['GMV', stats.gmv, '', false],
    ['PACE', stats.pace, '/ hr', false],
  ]
  const grid = $('statsGrid')
  grid.replaceChildren()
  for (const [l, v, sub, red] of tiles) {
    const tile = el('div', 'stat')
    tile.appendChild(el('div', 'l', l))
    tile.appendChild(el('div', 'v' + (red ? ' red' : ''), v))
    if (sub) tile.appendChild(el('div', 's', sub))
    grid.appendChild(tile)
  }
}

// ┌── lane B: live sales feed (renderFeed + setupFeed move to salesView.ts) ────
// allSales / provisionalSales / feedRows / provKeyOf STAY here: onAuctionClosed and the print
// path use them. Lane B reads what it needs through onSales() / its own deps.
// ── live sales feed (comp "bid feed") — paginated ───────────────────────────
let allSales: Sale[] = []
// Provisional rows from the fast close signals (pin/im), shown the instant an auction
// closes — the confirmed auction_result row replaces them (matched by product+lot key)
// or they expire after 90s. This is what makes the bid history "capture" a sale at
// the gavel instead of 2-6s later.
const provisionalSales: Sale[] = []
const PROV_TTL_MS = 90000
let currentTopSet = new Set<string>() // written by the sales handler; no longer read (the WHALE tag is gone)

const provKeyOf = (s: Sale) => printKey((s.skuDesc ?? '').replace(/^#/, ''), s.buyer.username || s.buyer.handle)

/** Confirmed rows merged with not-yet-confirmed provisional closes; prunes stale/matched. */
function feedRows(): Sale[] {
  const now = Date.now()
  const realKeys = new Set(allSales.map(provKeyOf))
  for (let i = provisionalSales.length - 1; i >= 0; i--) {
    const p = provisionalSales[i]!
    if (realKeys.has(provKeyOf(p)) || now - p.createdAt > PROV_TTL_MS) provisionalSales.splice(i, 1)
  }
  return [...provisionalSales, ...allSales]
}

// The feed itself (last 10 + "Search all sales", past-order badges) lives in salesView.ts; these
// stay as one-line delegates because the sales handler, the 1 s pending tick and onAuctionClosed
// call them by name. The import sits here, not in the imports block (ES imports hoist).
import { bindSalesState, renderSalesFeed, renderPaymentIssues, renderTopBuyers } from './salesView'
bindSalesState({ feedRows: () => feedRows(), allSales: () => allSales, failedSales: () => failedSales })
function renderFeed() { renderSalesFeed() }
/** The old pager is gone (the feed shows the last 10; search finds the rest). Kept for its call site. */
function setupFeed() {}
// └── end lane B (feed)─────────────────────────────────────────────────────────

// ┌── lane C: live chat column (appendChat / appendOwnChat / setupChatInput move to chatDesk.ts)
// The chat column now lives in chatDesk.ts: rows, name colours, the echo of an approved Host reply,
// questions and wishes are all drawn by onChat(), which the 'chat' case calls right after this.
// appendChat stays as a no-op so that call site is unchanged. The free-text composer
// (setupChatInput / appendOwnChat) was already dead — index.html has no #chatInput — and is gone:
// the only way to post is Approve on a question card.
function appendChat(items: ChatMessage[]) { void items }
// └── end lane C ────────────────────────────────────────────────────────────────

// ┌── lane B: top buyers (renderTopBuyer moves to salesView.ts) ────────────────
// ── top buyers (this show) ──────────────────────────────────────────────────
// Ranked leaderboard for the live session. buyers is ev.topBuyers — already sorted
// by spend desc and recomputed each sales poll — so this updates as sales land, and
// ranks 2-8 visibly move even when the #1 whale is stable (the single-name version
// looked "stuck" precisely because it only ever showed #1).
// (Now in salesView.ts renderTopBuyers, with the past-order badge; this delegate keeps the name.)
function renderTopBuyer(buyers: BuyerAgg[]) { renderTopBuyers(buyers) }
// └── end lane B (top buyers) ───────────────────────────────────────────────────

// ── products ────────────────────────────────────────────────────────────────
function renderProductsTable() {
  const tbody = $('products')
  tbody.replaceChildren()
  const counts = new Map(lastByProduct.map((p) => [p.productId, p]))
  const ids = rosterProducts.size ? [...rosterProducts.keys()] : [...counts.keys()]
  const rows = ids
    .map((id) => {
      const r = rosterProducts.get(id)
      const c = counts.get(id)
      return { id, name: r?.name ?? c?.productName ?? id, sold: c?.paid ?? r?.numSold ?? 0, failed: c?.failed ?? 0, pending: c?.pending ?? 0, stock: r?.stockNum }
    })
    .sort((a, b) => b.sold - a.sold)
  for (const row of rows) {
    const tr = el('div', 'prow')
    tr.appendChild(el('div', 'pn', row.name))
    tr.appendChild(el('div', 'pc', String(row.sold)))
    tr.appendChild(el('div', 'pc', String(row.failed)))
    tr.appendChild(el('div', 'pc', String(row.pending)))
    tr.appendChild(el('div', 'pc', row.stock != null ? String(row.stock) : '—'))
    tbody.appendChild(tr)
  }
}

// ── current auction ─────────────────────────────────────────────────────────
// Two sources feed the lot overlay at different speeds: pin/get (700ms) and the
// roster snapshot (3s). Without a guard the slower one lands last and overwrites
// fresh bid state with stale — which is what left the overlay showing an ended lot.
let lastPinRenderAt = 0
const PIN_FRESH_MS = 3000
// Per-bid paints (webcast stream, every bid, works unpinned) are fresher than the 3s
// roster snapshot too — a roster paint must not clobber them either.
let lastBidRenderAt = 0
let lastBidLot = '' // lot the bid feed is currently painting — detects the lot changing under it
const freshestLotRenderAt = () => Math.max(lastPinRenderAt, lastBidRenderAt)

// ── current auction ─────────────────────────────────────────────────────────
function renderAuction(p?: PinnedAuction) {
  // Blank ONLY when there is genuinely no lot. A live lot with no bids yet has an empty
  // win_username, and treating that as "no lot" left both panels stuck on "Waiting for
  // current lot" for the whole bidding window — they only came alive at the gavel, when
  // onAuctionClosed writes the DOM directly. Show the lot as soon as it exists; the buyer
  // and bid fields carry the "no bids yet" state on their own.
  if (!p) {
    pinnedEndMs = undefined
    // keep the overlay visible (it's always over the video); show placeholders until a lot is live
    $('lotNum').textContent = 'CURRENT LOT'
    $('lotName').textContent = 'Waiting for current lot'
    $('lotBuyer').textContent = '—'
    $('lotBid').textContent = '—'
    $('lotBids').textContent = '0'
    return
  }
  pinnedEndMs = p.expectedEndMs
  // Remembered for the fast print path: an im-sourced close can arrive without a product
  // name, and the custom-regex field needs SOME descriptive text to extract a tag from.
  if (p.productName) lastLotName = p.productName
  $('lotOverlay').style.display = 'flex'
  $('lotNum').textContent = p.variantDesc ?? 'CURRENT LOT'
  $('lotName').textContent = p.productName
  $('lotBid').textContent = p.maxBiddingPrice ?? '—'
  $('lotBids').textContent = String(p.numBids ?? 0)
  $('lotBuyer').textContent = p.winUsername ? '@' + p.winUsername : 'no bids yet'
}

function tickCountdown() {
  const ends = document.getElementById('lotEnds')
  if (!ends) return
  // A close was just painted by onAuctionClosed — hold SOLD against this 250ms tick
  // (and the slower roster/pin repaints) until the next lot's state has had time to land.
  if (Date.now() - lotSoldAt < 10000) {
    ends.textContent = 'SOLD'
    return
  }
  if (!pinnedEndMs) { ends.textContent = '--'; return }
  // expectedEndMs is in server time; correct the client clock by the pin/get offset.
  const left = Math.max(0, Math.round((pinnedEndMs - (Date.now() + serverTimeOffsetMs)) / 1000))
  const label = left > 0 ? `${left}s` : 'ended'
  ends.textContent = label
}
setInterval(tickCountdown, 250)

// Pending-payment deadlines tick down in the feed, and a lapse moves the row into
// PAYMENT ISSUES — both need a repaint on the second, not on the next poll.
setInterval(() => {
  if (!allSales.some((s) => s.paymentStatus === 'pending' && s.paymentExpiresAt)) return
  renderFeed()
  renderFailed()
}, 1000)

// Viewers only ever came from the frontier WS. If nothing has arrived for a minute the
// number on screen is a fossil — say so rather than showing a stale count as if live.
setInterval(() => {
  if (viewersFresh && Date.now() - viewersFresh > VIEWERS_STALE_MS) { setViewers(null); viewersFresh = 0 }
}, 5000)

// ── payment expiry ──────────────────────────────────────────────────────────
// An unpaid win carries payment_expire_timestamp — a hard deadline (observed: a flat
// 5 minutes from the order) after which TikTok fails the order and the item is yours
// again. Printing is deliberately NOT gated on this: the label goes out at the gavel as
// always. This only tells the room how long a pending sale has left, and moves it into
// PAYMENT ISSUES once it lapses.
function payLeft(s: Sale): number | undefined {
  if (!s.paymentExpiresAt || s.paymentStatus !== 'pending') return undefined
  return Math.max(0, s.paymentExpiresAt - Date.now())
}
function fmtLeft(ms: number): string {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// ┌── lane B: payment issues (renderFailed moves to salesView.ts; source becomes storeAPI.failedPayments)
// ── failed / expired payments ───────────────────────────────────────────────
// failedSales is ev.failedPayments (the sales handler writes it). The panel — live failures and
// lapsed deadlines, plus the store's failures this show — is salesView.ts renderPaymentIssues.
let failedSales: Sale[] = []
function renderFailed() { renderPaymentIssues() }
// └── end lane B (payment issues) ───────────────────────────────────────────────

// ── session elapsed ─────────────────────────────────────────────────────────
function fmtClock(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
setInterval(() => {
  // count from the ACTUAL go-live (room create_timestamp), not the scheduled session start
  const start = liveStartedAt ?? sessionStart
  if (!start) return
  const s = Math.max(0, Math.floor(Date.now() / 1000 - start))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  $('elapsed').textContent = h ? `${h}h ${m}m` : `${m}m`
}, 1000)

// ── live video (HTTP-FLV via flv.js) ────────────────────────────────────────
let flvPlayer: flvjs.Player | null = null
let lastStreamUrl = ''
let flvCatchup: number | null = null
let liveSeekBound = false
const seekToLiveEdge = (video: HTMLVideoElement, minBehind: number) => {
  const b = video.buffered
  if (b.length && !video.seeking && b.end(b.length - 1) - video.currentTime > minBehind) video.currentTime = b.end(b.length - 1) - 0.4
}
function loadStream(url: string) {
  lastStreamUrl = url
  const video = document.getElementById('live') as HTMLVideoElement | null
  if (!video || !flvjs.isSupported()) return
  if (!liveSeekBound) {
    liveSeekBound = true
    // on every resume after a stall, snap to the live edge (flv.js otherwise resumes behind)
    video.addEventListener('playing', () => seekToLiveEdge(video, 1))
    // The station stays silent: an audible one can feed the show back into the broadcast. The markup
    // carries `muted`, and the player controls have a volume button, so a click is undone here.
    video.muted = true
    video.addEventListener('volumechange', () => { if (!video.muted) video.muted = true })
  }
  if (flvCatchup !== null) { clearInterval(flvCatchup); flvCatchup = null }
  if (flvPlayer) { try { flvPlayer.destroy() } catch { /* ignore */ } flvPlayer = null }
  flvPlayer = flvjs.createPlayer(
    { type: 'flv', url, isLive: true, cors: true },
    { enableStashBuffer: false, autoCleanupSourceBuffer: true }, // low initial latency; drop old buffered data
  )
  flvPlayer.attachMediaElement(video)
  flvPlayer.on(flvjs.Events.ERROR, () => { window.setTimeout(() => loadStream(lastStreamUrl), 2500) })
  flvPlayer.load()
  void video.play().catch(() => {})
  // flv.js (unlike the mpegts.js fork) does NOT chase the live edge, so latency accumulates
  // after any rebuffer. Periodically jump back toward the live edge when too far behind.
  flvCatchup = window.setInterval(() => { if (!video.paused) seekToLiveEdge(video, 2) }, 2000)
}

// (The VIDEO light and its renderStreamState() were removed in the live-ui build, owner decision 8.)

// ── label printing ──────────────────────────────────────────────────────────
let selectedPrinter = ''
let autoPrint = false
let feedWinsSeen = 0 // "won" feed rows observed this session (lets you confirm the observer catches wins even before flipping to feed mode)
let lastPrintedNumber: number | null = null
// ┌── lane E: the Print log head state (the finished jobs are drawn by printLog.ts)
// printLabel() still pushes each job here (bounded at 30) so the head can count in-flight prints;
// the list itself is no longer drawn — the Print log replaced the Thermal print queue.
const printQueue: { label: string; status: 'printing' | 'printed' | 'error' }[] = []

function renderQueue() {
  // Head state that needs renderer-local facts: in-flight prints, and a nudge when no printer is
  // chosen (the chip opens Settings; lane F wires its click).
  const printing = printQueue.filter((i) => i.status === 'printing').length
  const meta = document.getElementById('printLogMeta')
  if (meta) meta.textContent = printing > 0 ? `${printing} printing…` : 'Newest first'
  const badge = document.getElementById('labelSettingsFooter')
  if (badge) badge.hidden = !!selectedPrinter
}
// └── end lane E ────────────────────────────────────────────────────────────────

/**
 * `register: true` records the lot in the print guard as though a source had claimed it.
 *
 * The auto paths claim BEFORE calling here, so they leave it off. The manual lot buttons
 * (Next / Custom / Range) set it: a hand-printed label is a physical label, so the lot's
 * close event must not produce a second one later. Observed live — #76 came out four
 * times, three by hand plus one automatic, because manual prints sat outside the guard.
 *
 * Manual prints still never CONSULT the guard: clicking the button is explicit intent, so
 * reprinting a jammed label always works. The sample-label button leaves this off too —
 * its placeholder item number would otherwise claim a real lot and suppress it.
 */
async function printLabel(data: LabelData, { register = false }: { register?: boolean } = {}) {
  if (!selectedPrinter) return
  if (register) {
    const n = String(data.itemNumber ?? '').trim()
    // lastLotName as the scope fallback, matching the auto paths: during a pin blackout the
    // scope IS the product name, so a manual claim keyed on "|76" would not match the close
    // event key "<product>|76" and #76 would still print twice.
    if (n) printed.claim(n, data.productName ?? lastLotName, Date.now())
  }
  const entry: { label: string; status: 'printing' | 'printed' | 'error' } = { label: `#${data.itemNumber}${data.buyer ? ' ' + data.buyer : ''}`, status: 'printing' }
  printQueue.unshift(entry)
  if (printQueue.length > 30) printQueue.pop()
  renderQueue()
  try {
    const res = await window.labelAPI.print(data, selectedPrinter, labelTemplate)
    entry.status = res.success ? 'printed' : 'error'
    const n = Number(data.itemNumber)
    if (res.success && Number.isFinite(n)) { lastPrintedNumber = n; updatePrintNext() }
    // lane E: the Print log — after the label is out, never before
    try { onPrintResult({ data, ok: res.success, error: res.error, spoolMs: res.spoolMs, at: Date.now() }) } catch { /* UI only */ }
  } catch (e) {
    entry.status = 'error'
    try { onPrintResult({ data, ok: false, error: String((e as Error)?.message ?? e), at: Date.now() }) } catch { /* UI only */ }
  }
  renderQueue()
}

function printSale(s: Sale) {
  const num = (s.skuDesc ?? '').replace(/^#/, '')
  const title = `${s.skuDesc ? s.skuDesc + ' ' : ''}${s.productName}`
  printLabel({ itemNumber: num, buyer: s.buyer.username || s.buyer.handle, productName: s.productName, price: s.price.formatted, title, code: labelCode(s.skuId) })
}

// Lot numbers restart per LISTING (variant #1..#K under each auction product), so a
// bare lot number as the dedupe key silently swallowed EVERY print after the seller
// switched listings mid-show ("printing completely stops") — lot #3 of listing B
// looked like a re-fire of lot #3 of listing A. Scope the key by product name, which
// every print source carries (pin, im-end attribution, im-result, order rows).
// Normalized (case/whitespace) so the SAME sale reported by different sources (pin
// roster name vs im Manager title vs auction_result product_name) still dedupes.
const printKey = (lot: string, winner?: string) =>
  `${(winner ?? '').trim().toLowerCase().replace(/\s+/g, ' ')}|${lot}`

// Which lots already printed — see core/printDedup.ts for the two rules and the two
// regressions they encode. Fed the listing id from pin/roster ONLY; a close event's
// auctionConfigId is per-auction on the im sources and resetting off it deduped nothing.
const printed = new PrintDedup()
/** Called from the pin/roster stream — the only sources carrying a real per-listing id. */
function setPrintListing(listingId?: string): void {
  printed.setListing(listingId, Date.now())
}

// Prefer the CONFIRMED winner: a pin swap-close only knows the last LEADER, which a snipe
// overrides (the pin's leader != the auction_result winner). So a swap-close print is held
// briefly; if a confirmed source (auction_result, or a pin/im close carrying the real
// winner) prints the lot first, the held guess is cancelled. If nothing confirms in the
// window, the guess prints (better than no label). Confirmed sources are never delayed.
// 8s, up from 4s. The hold has to outlast the confirmed row, and 4s did not: the order is
// created 2-3s after the timer and reaches auction_result/get at +2.7-6s (measured on the
// live console and in a dry run, 2026-10-03), so the guess and the truth arrived together and the guess often
// won — after which the correct label was refused as a duplicate of the lot. On a 7s
// auction the last poll can be over a second stale and bids bunch in the final second, so
// "leader at the last poll" is wrong often enough to matter (seen live: 1 bid / leader A at
// the last sample, 2 bids / winner B at the close, timer not extended). Main now asks for
// the row at end + 3.1s and again 3s after the swap, so a healthy session prints the
// confirmed name well inside this window; the guess is only the fallback for a session
// that cannot fetch rows at all.
const SWAP_PRINT_DELAY_MS = 8000
const pendingSwap = new Map<string, ReturnType<typeof setTimeout>>()
function cancelPendingSwap(lot: string) { const t = pendingSwap.get(lot); if (t) { clearTimeout(t); pendingSwap.delete(lot) } }

// Order-data (slow) path: auto-print a genuinely-new sale, de-duped by lot number. This is
// the AUTHORITATIVE winner, so it also cancels/pre-empts any held swap-close guess.
function autoPrintSale(s: Sale) {
  if (!autoPrint || !selectedPrinter) return
  const lot = (s.skuDesc ?? '').replace(/^#/, '')
  if (!lot) { if (printed.seenOrder(s.orderId)) return; printSale(s); return }
  if (!printed.claim(lot, s.productName, Date.now())) return
  cancelPendingSwap(lot)
  printSale(s)
}

// Live-feed (fast) path: a winner painted on-screen the instant an auction closes.
// Always counts the win (verification), but only prints when Live-feed mode is on.
function onWonFeed(ev: Extract<LiveEvent, { kind: 'won-feed' }>) {
  feedWinsSeen++
  updateFeedWinsSeen()
}

// Fast-close path: an auction closed, reported by pin/get (status 1→3, pinned lots
// only) or by the im stream (auction.end for EVERY lot; im-result ~6s later with the
// lot number). De-dup is shared with the other sources via PrintDedup, so the slow
// path re-reporting the same sale later never double-prints.
const priceCentsOf = (formatted?: string): number => {
  const m = /([\d,]+(?:\.\d{1,2})?)/.exec(formatted ?? '')
  return m?.[1] ? Math.round(parseFloat(m[1].replace(/,/g, '')) * 100) : 0
}
// ── the "Item sold" moment on the video ──────────────────────────────────────
// A few seconds of "Item sold / <buyer>" over the picture when an auction closes. It is fed
// only by CONFIRMED winners — a pin-swap close names the last leader, which a late bid can
// overturn, and putting the wrong name on screen is worse than showing it two seconds later
// when the order row lands. Scheduled with setTimeout(0) from its callers so it paints after
// the label for the same sale has been dispatched: nothing here may run ahead of a print.
const SOLD_SHOW_MS = 4200
const SOLD_REPEAT_MS = 90_000 // the same lot reported again by a slower source
const soldShownAt = new Map<string, number>()
let soldTimer: ReturnType<typeof setTimeout> | undefined
function showSold(lot: string, buyer: string | undefined, price?: string) {
  const el = document.getElementById('soldBanner')
  if (!el || !buyer) return
  const now = Date.now()
  const last = soldShownAt.get(lot)
  if (lot && last !== undefined && now - last < SOLD_REPEAT_MS) return
  soldShownAt.set(lot, now)
  if (soldShownAt.size > 300) soldShownAt.delete(soldShownAt.keys().next().value!)
  const name = $('soldName')
  name.textContent = buyer
  name.classList.toggle('long', buyer.length > 16)
  $('soldLot').textContent = lot ? '#' + lot : ''
  $('soldPrice').textContent = price ?? ''
  el.classList.remove('show')
  void el.offsetWidth // restart the entrance when one sale follows another
  el.classList.add('show')
  if (soldTimer) clearTimeout(soldTimer)
  soldTimer = setTimeout(() => el.classList.remove('show'), SOLD_SHOW_MS)
}

function onAuctionClosed(ev: Extract<LiveEvent, { kind: 'auction-closed' }>) {
  const lot = (ev.lotNumber ?? '').replace(/^#/, '')
  if (lot && ev.source !== 'pin-swap') setTimeout(() => showSold(lot, ev.winner, ev.price), 0)
  // Instant UI: paint the close on the lot overlay even when the lot number isn't
  // known yet (unpinned lots) — the sale is real, only its attribution is pending.
  if (lot) $('lotNum').textContent = '#' + lot
  $('lotBuyer').textContent = '@' + ev.winner
  if (ev.price) $('lotBid').textContent = ev.price
  if (ev.productName) $('lotName').textContent = ev.productName
  lotSoldAt = Date.now() // tickCountdown paints SOLD and holds it against repaints
  lastPinRenderAt = Date.now() // hold this against the slower roster paint (PIN_FRESH_MS)
  if (lot) lastPrintedNumber = Number(lot) || lastPrintedNumber
  // Instant bid history: a provisional row at the top of the feed, replaced by the
  // confirmed auction_result row when it lands (feedRows matches on product+lot).
  if (lot) {
    const key = printKey(lot, ev.winner)
    const covered =
      provisionalSales.some((p) => p.orderId === `prov:${key}`) ||
      allSales.some((s) => provKeyOf(s) === key)
    if (!covered) {
      const cents = priceCentsOf(ev.price)
      provisionalSales.unshift({
        orderId: `prov:${key}`,
        buyer: { username: ev.winner, handle: ev.username },
        productId: ev.productName ?? key,
        productName: ev.productName ?? '(item)',
        skuDesc: `#${lot}`,
        price: { cents, formatted: ev.price ?? `$${(cents / 100).toFixed(2)}` },
        paymentStatus: 'pending',
        createdAt: ev.ts,
      })
      renderFeed()
    }
  }
  if (!autoPrint || !selectedPrinter) return
  // No lot number yet (unattributed im auction.end): don't print a numberless label —
  // the im-result event carries the lot ~6s later and prints it then.
  if (!lot) return
  // The custom-regex field extracts from `title` (falling back to productName), so the old
  // title of just "#23" could never match a rule like \b(NWT|RETURN)S?\b — the tag
  // extracted correctly in the settings preview and then never appeared on a live label,
  // because THIS is the path that prints during a show. Carry the lot's real product name
  // through, the way the slower auction_result path (printSale) already does. It doubles as
  // the dedup scope when pin has not given us a listing id, so resolve it ONCE and use the
  // same value for the check and the claim — two different names would be two different keys.
  const name = (ev.productName ?? lastLotName ?? '').trim()
  if (printed.printedAlready(lot, name, Date.now())) return
  const doPrint = () => {
    // Atomic: claim decides AND records. The held swap-close timer below fires up to 4s
    // later, so a confirmed source can land in between — claim() is what makes that race
    // safe without the timer re-checking.
    if (!printed.claim(lot, name, Date.now())) return
    void printLabel({
      itemNumber: lot,
      buyer: ev.winner,
      price: ev.price,
      ...(name ? { productName: name } : {}),
      // roster names already carry their own "#79 " prefix; don't double it
      title: name ? (name.startsWith('#') ? name : `#${lot} ${name}`) : `#${lot}`,
      code: labelCode(ev.skuId),
    })
  }
  if (ev.source === 'pin-swap') {
    // Low-confidence guess (leader while bidding) — hold for a confirmed winner first.
    if (pendingSwap.has(lot)) return
    pendingSwap.set(lot, setTimeout(() => { pendingSwap.delete(lot); doPrint() }, SWAP_PRINT_DELAY_MS))
    return
  }
  // Confirmed source (pin status=3 / im / im-result): print now, pre-empt any held guess.
  cancelPendingSwap(lot)
  doPrint()
}

function updateFeedWinsSeen() {
  const el = document.getElementById('feedWinsSeen')
  if (el) el.textContent = feedWinsSeen ? `${feedWinsSeen} live-feed win${feedWinsSeen === 1 ? '' : 's'} seen` : ''
}

function updatePrintNext() {
  const btn = $('printNext') as HTMLButtonElement
  btn.textContent = lastPrintedNumber !== null ? `Next #${lastPrintedNumber + 1}` : 'Next'
  btn.disabled = lastPrintedNumber === null || !selectedPrinter
}

// ── printer state line (Settings → Printer) ─────────────────────────────────
// One sentence that says whether a label will come out, worst problem first. It only claims
// what the app knows: the device's own status is readable in raw-ZPL mode alone, so the
// all-clear is "no problems reported", not "ready".
let dryRun = false
let printerAlerts: string[] = []
function renderPrinterState() {
  const st = document.getElementById('printerState')
  if (!st) return
  let text = 'No problems reported'
  let cls = 'ok-text'
  if (dryRun) { text = 'Dry run — nothing will print'; cls = 'warn-text' }
  else if (!selectedPrinter) { text = 'No printer selected — labels cannot print'; cls = 'bad-text' }
  else if (printerAlerts.length) { text = printerAlerts.join(' · '); cls = 'bad-text' }
  else if (!autoPrint) { text = 'Printer is set, but automatic printing is off'; cls = 'warn-text' }
  st.className = 'state ' + cls
  st.textContent = text
}

async function setupPrinting() {
  const { printers, saved, rawZpl, dry } = await window.labelAPI.getPrinters()
  dryRun = !!dry
  const banner = document.getElementById('dryBanner')
  if (banner) banner.style.display = dryRun ? 'flex' : 'none'
  const sel = $('printerSel') as HTMLSelectElement
  for (const p of printers) {
    const opt = document.createElement('option')
    opt.value = p.name
    opt.textContent = p.displayName + (p.isDefault ? ' (default)' : '')
    sel.appendChild(opt)
  }
  selectedPrinter = saved || printers.find((p) => p.isDefault)?.name || ''
  sel.value = selectedPrinter
  const printerHint = renderPrinterState
  printerHint()
  updateSampleBtn()
  autoPrint = localStorage.getItem('tt-autoprint') === '1'
  ;($('autoPrint') as HTMLInputElement).checked = autoPrint
  renderPrinterState()
  updateFeedWinsSeen()
  updatePrintNext()
  renderQueue()
  sel.addEventListener('change', () => { selectedPrinter = sel.value; void window.labelAPI.savePrinter(selectedPrinter); updatePrintNext(); renderQueue(); printerHint(); updateSampleBtn() })
  ;($('autoPrint') as HTMLInputElement).addEventListener('change', (e) => { autoPrint = (e.target as HTMLInputElement).checked; localStorage.setItem('tt-autoprint', autoPrint ? '1' : '0'); renderPrinterState() })
  ;($('rawZpl') as HTMLInputElement).checked = rawZpl
  ;($('rawZpl') as HTMLInputElement).addEventListener('change', (e) => { void window.labelAPI.setRawZpl((e.target as HTMLInputElement).checked) })
  $('printNext').addEventListener('click', () => { if (lastPrintedNumber !== null) void printLabel({ itemNumber: String(lastPrintedNumber + 1) }, { register: true }) })
  $('printCustom').addEventListener('click', () => { const v = ($('customNum') as HTMLInputElement).value.replace(/^#/, '').trim(); if (v) void printLabel({ itemNumber: v }, { register: true }) })
  $('printRange').addEventListener('click', async () => {
    const from = parseInt(($('rangeFrom') as HTMLInputElement).value, 10)
    const to = parseInt(($('rangeTo') as HTMLInputElement).value, 10)
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to - from > 500) return
    for (let n = from; n <= to; n++) await printLabel({ itemNumber: String(n) }, { register: true })
  })
}
void setupPrinting()

// Auto-update: main downloads at launch and installs on quit; just surface the
// "Update ready" indicator (next to the version) once the download completes.
window.updateAPI?.onReady((info) => {
  const u = document.getElementById('updateReady')
  if (!u) return
  u.style.display = ''
  u.title = `v${info.version} downloaded — installs when you close the app`
  const about = document.getElementById('aboutUpdate')
  if (about) { about.className = 'ok-text'; about.textContent = `Update v${info.version} is downloaded — it installs when you close the app` }
})

// ┌── lane F: label settings — preview, sample, per-field sizes, saved patterns, setupSettings
//     (moves to designer.ts; the regex tools move into #titleDrawer) ───────────────
// Moved to designer.ts: the label designer, the sample sale, the regex tools and presets. These
// two names stay because code outside this fence calls them.
function updateSampleBtn() {
  refreshPrinterButtons()
}
function setupSettings() {
  setupDesigner({
    print: (data) => printLabel(data), // manual: never registers the lot in the print guard
    printer: () => selectedPrinter,
    openSettings: () => showScreen('settings'),
  })
}
// └── end lane F ────────────────────────────────────────────────────────────────
setupSettings()
setupFeed()
renderStats()
$('feedCount').textContent = 'v' + __APP_VERSION__
{ const v = document.getElementById('aboutVersion'); if (v) v.textContent = __APP_VERSION__ }

// -- screens: Show (monitor), Chat, Settings — behind the Connect gate --------
let wantedScreen: Screen = 'monitor'
// Set by the SellerFolio connection section below: true while this computer is not connected.
// Shut until the first connection view arrives (the preload is there before this script runs), so
// the Live screen never paints before main says whether it may; replay's first view opens it at once.
let connectGate = !!window.sfSyncAPI
function showScreen(want: Screen) {
  wantedScreen = want
  const s: Screen | 'connect' = connectGate ? 'connect' : want
  const show = (id: string, on: boolean) => { const e = document.getElementById(id); if (e) e.style.display = on ? 'flex' : 'none' }
  show('monitorScreen', s === 'monitor')
  show('chatScreen', s === 'chat')
  show('timelineScreen', s === 'timeline')
  show('settingsScreen', s === 'settings')
  show('connectScreen', s === 'connect')
  // The legacy rail icons (lane A replaces the rail; these lookups tolerate their absence).
  document.getElementById('navMonitor')?.classList.toggle('active', s === 'monitor')
  document.getElementById('navMonitor')?.classList.toggle('disabled', connectGate)
  document.getElementById('navSettings2')?.classList.toggle('active', s === 'settings')
  document.getElementById('navSettings2')?.classList.toggle('disabled', connectGate)
  // live status (connecting...) + room/viewers/elapsed only make sense on the Live Monitor
  const meters = document.getElementById('liveMeters')
  if (meters) meters.style.display = s === 'monitor' ? 'flex' : 'none'
  const livePill = document.getElementById('livePill')
  if (livePill) livePill.style.display = s === 'monitor' ? 'flex' : 'none'
  // lanes A + C: paint the rail; repaint the Chat screen when it opens. UI only, never fatal.
  try { onScreen(s, connectGate) } catch (e) { console.error('[live-ui] shell.onScreen', e) }
  if (s === 'chat') { try { onChatScreenShown() } catch (e) { console.error('[live-ui] chatDesk.onChatScreenShown', e) } }
  // The timeline polls hq only while its screen is showing.
  try { setTimelineVisible(s === 'timeline') } catch (e) { console.error('[live-ui] timeline visibility', e) }
}
document.getElementById('navMonitor')?.addEventListener('click', () => { if (!connectGate) showScreen('monitor') })
document.getElementById('navSettings2')?.addEventListener('click', () => { if (!connectGate) showScreen('settings') })

// ── live-ui lanes: start each module (inert stubs until the lane lands) ─────
// Here, not earlier: showScreen and the state it reads exist from this point, so a lane may call
// deps.showScreen() inside its init. Before the first showScreen(), so onScreen() sees an inited
// shell. Each is wrapped: a lane failing to start must never stop this file reaching the event loop.
for (const [name, init] of [
  ['shell', () => initShell({ showScreen: (s) => showScreen(s), print: (d) => void printLabel(d) })],
  ['salesView', () => initSalesView({ printSale })],
  ['chatDesk', () => initChatDesk()],
  ['buyerHistory', () => initBuyerHistory()],
  ['printLog', () => initPrintLog()],
  ['designer', () => initDesigner()],
  ['showStats', () => initShowStats()], // lane G
  ['hotkeysCard', () => initHotkeysCard()],
] as [string, () => void][]) {
  try { init() } catch (e) { console.error(`[live-ui] ${name} failed to start`, e) }
}

// Deep link, so a screen can be opened (and screenshotted) without a click. Accepts the query
// form too, because a fragment does not always survive a headless capture.
{
  const want = location.hash.replace('#', '') || new URLSearchParams(location.search).get('screen')
  showScreen(want === 'settings' || want === 'chat' ? want : 'monitor') // also applies the initial gate
}
document.getElementById('diagBtn')?.addEventListener('click', () => void window.diagAPI?.open())

// ── SellerFolio connection: Connect screen + Settings card ───────────────────
interface SfConn { kind: string; shop?: string; label?: string }
interface SfSyncView { conn: SfConn; baseUrl: string; device: string; canStore: boolean; legacyToken: boolean; upload: { state: string; detail: string }; replay?: boolean; monitorRunning?: boolean }

// Demo mode: open dist/index.html over http WITHOUT the preload and add
// ?conn=none|legacy|checking|revoked|other_machine|connected|offline|revoked-running to see each state.
// Never active when the preload is present (window.sfSyncAPI exists) or without the query.
function installSfDemo(): void {
  const mode = new URLSearchParams(location.search).get('conn')
  if (window.sfSyncAPI || !mode) return
  const shop = { shop: 'Luxesense Edit', label: 'Front desk' }
  const conns: Record<string, SfConn> = {
    none: { kind: 'none' }, legacy: { kind: 'none' }, checking: { kind: 'checking' },
    revoked: { kind: 'revoked' }, other_machine: { kind: 'other_machine' },
    connected: { kind: 'connected', ...shop }, 'revoked-running': { kind: 'connected', ...shop },
    offline: { kind: 'offline', ...shop },
  }
  let conn: SfConn = conns[mode] ?? { kind: 'none' }
  // As in main: the monitor is running once a state that may run was seen, and stays running.
  let running = false
  const view = (): SfSyncView => {
    if (conn.kind === 'connected' || conn.kind === 'offline') running = true
    return {
      conn, baseUrl: 'https://hq.example', device: '38ffb312af16', canStore: true, legacyToken: mode === 'legacy' && conn.kind === 'none',
      upload: { state: conn.kind === 'connected' ? 'synced' : conn.kind === 'offline' ? 'offline' : 'off', detail: '' },
      monitorRunning: running,
    }
  }
  let push: ((s: SfSyncView) => void) | null = null
  const set = (c: SfConn) => { conn = c; push?.(view()) }
  if (mode === 'revoked-running') setTimeout(() => set({ kind: 'revoked' }), 1200)
  window.sfSyncAPI = {
    get: async () => view(),
    connect: async (t: string) => {
      if (t.trim() === 'sfm_demo') { set({ kind: 'connected', ...shop }); return { ...view(), ok: true } }
      return { ...view(), ok: false, error: 'SellerFolio did not recognise that token. Make a new one and try again.' }
    },
    disconnect: async () => { set({ kind: 'none' }); return view() },
    openFolder: async () => ({ ok: true }),
    onState: (cb) => { push = cb },
  }
}
installSfDemo()

const SF_UPLOAD_LABEL: Record<string, [string, string]> = {
  synced: ['Shows are uploading to SellerFolio.', 'ok-text'],
  offline: ['Can’t reach SellerFolio — saving here, will upload when it is back.', 'warn-text'],
  rejected: ['SellerFolio refused an upload — saving here and retrying.', 'warn-text'],
  error: ['Upload error — saving here and retrying.', 'warn-text'],
}
let sfLast: SfSyncView | null = null
let sfBusy = false

function sfShowConfirm(on: boolean): void {
  const c = document.getElementById('sfConfirm'); if (c) c.style.display = on ? '' : 'none'
  const r = document.getElementById('sfRow'); if (r) r.style.display = on ? 'none' : ''
}
function renderSfSync(v: SfSyncView): void {
  sfLast = v
  const k = v.conn.kind
  // Never cover a running show; a confirmed revoke / other machine while it runs is the red bar.
  const { gated, lost } = connectScreen(v)

  // Connect screen
  const banner = document.getElementById('cnBanner')
  if (banner) {
    const msg = k === 'revoked' ? 'This computer was disconnected in SellerFolio. Paste a new token to reconnect.'
      : k === 'other_machine' ? 'This token is already used by another computer. Make a new token for this one in SellerFolio.'
      : k === 'none' && v.legacyToken ? 'This computer was set up with an older extension token. Make a computer token in SellerFolio and paste it here.'
      : ''
    banner.textContent = msg; banner.style.display = msg ? '' : 'none'
  }
  const go = document.getElementById('cnGo') as HTMLButtonElement | null
  const cs = document.getElementById('cnState')
  if (go) go.disabled = k === 'checking' || sfBusy
  if (cs && k === 'checking') { cs.className = 'state muted'; cs.textContent = 'Checking…' }
  else if (cs && cs.textContent === 'Checking…') cs.textContent = ''
  const dev = document.getElementById('cnDevice'); if (dev) dev.textContent = v.device || '—'
  const dev2 = document.getElementById('aboutDevice'); if (dev2) dev2.textContent = v.device || '—'

  // Running, then revoked: red bar on the Live screen
  const bar = document.getElementById('revokedBar'); if (bar) bar.style.display = lost ? 'flex' : 'none'

  // Settings card
  const who = document.getElementById('sfWho')
  if (who) {
    who.textContent = ''
    if (v.conn.shop && (k === 'connected' || k === 'offline' || k === 'checking')) {
      const b1 = document.createElement('b'); b1.textContent = v.conn.shop
      const b2 = document.createElement('b'); b2.textContent = v.conn.label ?? ''
      who.append('Connected to ', b1, ' as ', b2)
    } else if (lost) who.textContent = 'Disconnected in SellerFolio'
    else who.textContent = 'Not connected'
  }
  const st = document.getElementById('sfState')
  if (st) {
    let text = ''; let cls = 'muted'
    if (lost) { text = 'This show keeps printing; uploads have stopped.'; cls = 'bad-text' }
    else if (k === 'offline') { text = 'Can’t reach SellerFolio — the show keeps running and uploads when it’s back.'; cls = 'warn-text' }
    else if (k === 'checking') text = 'Checking…'
    else if (k === 'connected') [text, cls] = SF_UPLOAD_LABEL[v.upload.state] ?? ['', 'muted']
    if (k === 'connected' && !v.canStore) text += ' This computer cannot store the token securely, so it must be re-entered each launch.'
    st.className = 'state ' + cls; st.textContent = text
  }
  const off = document.getElementById('sfOff'); if (off) off.style.display = k === 'none' ? 'none' : ''
  if (k === 'none') sfShowConfirm(false)

  connectGate = gated
  showScreen(wantedScreen)
}
function setupSfSync(): void {
  const api = window.sfSyncAPI
  if (!api) { connectGate = false; showScreen(wantedScreen); return } // a plain page without the app: nothing to gate
  void api.get().then(renderSfSync)
  api.onState(renderSfSync)
  const tok = document.getElementById('cnToken') as HTMLInputElement | null
  const go = document.getElementById('cnGo') as HTMLButtonElement | null
  const cs = document.getElementById('cnState')
  const submit = () => {
    if (!tok || !cs || sfBusy || sfLast?.conn.kind === 'checking') return
    const parsed = parseConnectToken(tok.value)
    if ('error' in parsed) { cs.className = 'state bad-text'; cs.textContent = parsed.error; return }
    sfBusy = true; if (go) go.disabled = true
    cs.className = 'state muted'; cs.textContent = 'Connecting…'
    void api.connect(parsed.token).then((r) => {
      sfBusy = false
      if (r.ok) { tok.value = ''; cs.textContent = '' } else { cs.className = 'state bad-text'; cs.textContent = r.error ?? 'Could not connect.' }
      renderSfSync(r)
    }, () => {
      sfBusy = false; cs.className = 'state bad-text'; cs.textContent = 'Could not connect.'
      if (sfLast) renderSfSync(sfLast)
    })
  }
  go?.addEventListener('click', submit)
  tok?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
  document.getElementById('cnOpen')?.addEventListener('click', () => void api.openSettings?.())
  document.getElementById('sfFolder')?.addEventListener('click', () => void api.openFolder())
  document.getElementById('sfOff')?.addEventListener('click', () => sfShowConfirm(true))
  document.getElementById('sfOffNo')?.addEventListener('click', () => sfShowConfirm(false))
  document.getElementById('sfOffYes')?.addEventListener('click', () => {
    sfShowConfirm(false)
    void api.disconnect().then(renderSfSync)
  })
}
setupSfSync()

// ── watchdog banner: a degraded signal path must be SEEN, not discovered via
// missing labels. Beeps once per newly-raised alert code, not on every re-send.
const wdSeenCodes = new Set<string>()
function wdBeep() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = 660
    gain.gain.value = 0.06
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.18)
    osc.onended = () => void ctx.close()
  } catch { /* audio is best-effort */ }
}
function renderWatchdog(alerts: { code: string; message: string }[]) {
  const bar = document.getElementById('watchdogBar')
  if (!bar) return
  if (!alerts.length) {
    bar.style.display = 'none'
    wdSeenCodes.clear()
    printerAlerts = []
    renderPrinterState()
    return
  }
  bar.style.display = 'flex'
  bar.textContent = '⚠ ' + alerts.map((a) => a.message).join('  ·  ')
  printerAlerts = alerts.filter((a) => a.code.startsWith('printer-')).map((a) => a.message)
  renderPrinterState()
  if (alerts.some((a) => !wdSeenCodes.has(a.code))) wdBeep()
  alerts.forEach((a) => wdSeenCodes.add(a.code))
}

// ── event loop ──────────────────────────────────────────────────────────────
window.ttLive.onEvent((ev: LiveEvent) => {
  switch (ev.kind) {
    case 'status': {
      const label = `${ev.status}${ev.detail ? ' — ' + ev.detail : ''}`
      $('status').textContent = ev.status === 'connected' ? 'LIVE' : ev.status
      $('dot').title = label
      $('dot').style.background = ev.status === 'connected' ? 'var(--gain)' : 'var(--ink-4)'
      $('dot').style.boxShadow = 'none'
      break
    }
    case 'room':
      $('room').textContent = ev.roomId.slice(-8)
      if (ev.createdAt) liveStartedAt = ev.createdAt // actual go-live for the elapsed timer
      break
    case 'session':
      $('sessionName').textContent = ev.name ?? '—'
      if (ev.startTime) sessionStart = ev.startTime
      if (ev.startTime) $('sessionName').title = `started ${fmtClock(ev.startTime)}`
      break
    case 'core_stats':
      // Legacy frontier-WS path. It has not delivered since the WS went quiet, but if it
      // ever comes back it is still the freshest source, so keep honouring it.
      if (ev.viewers !== undefined) { setViewers(ev.viewers); viewersFresh = Date.now() }
      if (ev.gmv) { stats.gmv = ev.gmv.formatted; gmvAuthoritative = true }
      if (ev.sales !== undefined) stats.sales = String(ev.sales)
      if (ev.gmvPerHour) stats.pace = ev.gmvPerHour.formatted
      if (ev.gpm) stats.gpm = ev.gpm.formatted
      renderStats()
      break
    case 'show_totals':
      // TikTok's own whole-session series — correct even when this app attached to a show
      // already in progress, which the locally-summed totals never are.
      stats.gmv = ev.gmv.formatted
      gmvAuthoritative = true
      stats.pace = ev.pace ? ev.pace.formatted : '—'
      if (ev.elapsedSec) showElapsedSec = ev.elapsedSec
      renderStats()
      break
    case 'product_stats':
      stats.sales = String(ev.totalSold)
      salesAuthoritative = true
      renderStats()
      break
    case 'roster':
      rosterProducts.clear()
      for (const p of ev.products) rosterProducts.set(p.productId, p)
      renderProductsTable()
      // Only let the 3s roster paint the lot when pin/get has gone quiet — otherwise
      // it clobbers the 700ms source with a snapshot that is up to 3s older.
      // AND only when this roster body actually carries data: TikTok answers every poll
      // with a bare {"code":0} while a verification puzzle is pending (1157 of 1194 roster
      // responses in one show), which parses to no products and no pinned auction. Passing
      // that through blanked the live lot back to "Waiting for current lot" every 1.5s.
      // An empty body is missing evidence, not evidence there is no lot — hold the paint.
      if (Date.now() - freshestLotRenderAt() > PIN_FRESH_MS && (ev.pinned || ev.products.length)) renderAuction(ev.pinned)
      // Backstop for the print dedup's listing scope when pin/get is quiet: roster's
      // pinned auction carries the same per-listing auction_config_id.
      setPrintListing(ev.pinned?.auctionConfigId)
      // Same missing-evidence rule as the lot paint above: a gated roster reports 0 sold,
      // and writing that to the card is how a 68-sale show displayed 0.
      if (ev.products.length) { stats.sales = String(ev.totalSold); salesAuthoritative = true }
      renderStats()
      break
    case 'pin':
      // pin/get is the lower-latency current-auction source; capture its server-time anchor
      // for an accurate countdown, and refresh the lot's bid state when it carries a winner.
      if (typeof ev.serverTimeOffsetMs === 'number') serverTimeOffsetMs = ev.serverTimeOffsetMs
      // Primary listing-change signal for the print dedup (700ms, and per-LISTING —
      // unlike a close event's auctionConfigId, which is per-auction on the im sources).
      setPrintListing(ev.current?.auctionConfigId)
      // Paint as soon as there IS a lot, not only once it has a leader — that guard is
      // what kept both panels blank through the entire bidding window. An empty pin body
      // parses to no `current` at all, so this still holds the last paint rather than
      // flickering when TikTok answers the poll with a bare {"code":0}.
      if (ev.current) { renderAuction(ev.current); lastPinRenderAt = Date.now() }
      break
    case 'bid':
      // Per-bid feed from the webcast stream (Manager message, EVERY bid, pinned or not) —
      // the only real-time source when the host hasn't pinned the card. Painted straight
      // onto the fast fields; the countdown is left alone (expectedEndMs is pin-only, so
      // it keeps showing 'ended'/'--' until pin/get sees the lot, which is honest).
      if (ev.lotNumber) $('lotNum').textContent = '#' + ev.lotNumber.replace(/^#/, '')
      if (ev.productName) {
        $('lotName').textContent = ev.productName
        lastLotName = ev.productName
      }
      if (ev.price) {
        $('lotBid').textContent = ev.price
      }
      $('lotBuyer').textContent = '@' + ev.leader
      // The bid feed carries no bid COUNT, and the count on screen belongs to whatever lot
      // pin last saw — often a different, already-closed one. A frozen wrong number reads
      // as live data, which is worse than no number; blank it the same way the countdown is
      // left alone. pin fills both back in for real if the host pins the card.
      if (ev.lotNumber && ev.lotNumber !== lastBidLot) {
        lastBidLot = ev.lotNumber
        $('lotBids').textContent = '--'
      }
      $('lotOverlay').style.display = 'flex'
      lastBidRenderAt = Date.now() // hold this against the slower roster paint (PIN_FRESH_MS)
      break
    case 'sales': {
      // ── PRINT FIRST ──────────────────────────────────────────────────────
      // Dispatch labels before any rendering/DB work so a label never waits on
      // UI. printSale is async (IPC) — it fires immediately and the work happens
      // in main; everything below is rendering that can follow.
      // Which rows are genuinely NEW is decided by core/saleSeed.ts — auction_result/get
      // returns history, not a feed, so a waterline has to be set at connect time. It is a
      // core module because getting it wrong reprinted ~20 already-printed labels on every
      // single app restart, and this file has no tests.
      const freshSales = saleSeed.select(ev)
      // EVERY source auto-prints; PrintDedup arbitrates. Single-source modes
      // proved fragile live 2026-07-24: the im auction decode went silent and
      // pin only covers pinned lots, while order rows landed 0.3-3s after
      // creation - so redundancy IS the latency strategy, not a fallback.
      for (const s of freshSales) autoPrintSale(s)
      // The confirmed row is also what announces a sale whose fast close was only a guess
      // (or never arrived). Recent rows only: a backlog row is history, not a moment.
      for (const s of freshSales) {
        if (s.paymentStatus === 'failed' || Date.now() - s.createdAt > 20000) continue
        const lot = (s.skuDesc ?? '').replace(/^#/, '')
        if (lot) setTimeout(() => showSold(lot, s.buyer.username || s.buyer.handle, s.price.formatted), 0)
      }

      // ── THEN UI ──────────────────────────────────────────────────────────
      lastByProduct = ev.byProduct
      renderProductsTable()
      allSales = ev.recentSales
      currentTopSet = new Set(ev.topBuyers.slice(0, 5).map((b) => b.ttuid || b.username))
      renderFeed()
      renderTopBuyer(ev.topBuyers)
      stats.buyers = String(ev.uniqueBuyers)
      stats.failed = String(ev.failedPayments.length)
      failedSales = ev.failedPayments
      renderFailed()
      // Locally-summed GMV is only a stand-in until show_totals lands: it counts nothing
      // that happened before this app attached, so a mid-show start under-reports.
      if (!gmvAuthoritative) stats.gmv = `$${(ev.totalCents / 100).toFixed(2)}`
      // Order rows are the only sold-count source that survives a verification gate: the
      // roster is empty for its whole duration, so without this the card sits at 0.
      if (!salesAuthoritative) stats.sales = String(ev.totalSales)
      renderStats()
      $('feedCount').title = `${ev.totalSales} sales · $${(ev.totalCents / 100).toFixed(0)}`
      // lane B (+ D's badges through it): last, after every print above has been dispatched.
      try { onSales(ev, freshSales) } catch (e) { console.error('[live-ui] salesView.onSales', e) }
      break
    }
    case 'stream':
      if (!flvPlayer) loadStream(ev.url)
      else lastStreamUrl = ev.url
      break
    case 'won-feed':
      onWonFeed(ev)
      break
    case 'auction-closed':
      onAuctionClosed(ev)
      break
    case 'chat':
      appendChat(ev.items)
      // lane C: questions, wishes, the asking panel and the Chat screen
      try { onChat(ev.items) } catch (e) { console.error('[live-ui] chatDesk.onChat', e) }
      break
    case 'watchdog':
      renderWatchdog(ev.alerts)
      break
  }
})
