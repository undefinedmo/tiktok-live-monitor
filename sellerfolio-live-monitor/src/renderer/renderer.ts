import flvjs from 'flv.js'
import type { LiveEvent, Sale, BuyerAgg, RosterProduct, ProductRollup, PinnedAuction, ChatMessage } from '../core/types'
import { labelHtml, LABEL_SIZES, basePt, parseItemNumber, extractCustom } from '../electron/label' // portable (no electron deps) — renders the real print HTML for the preview
import { labelNeedsHtml } from '../electron/zplLabel' // preview-only: which print path this label would take
import { PrintDedup } from '../core/printDedup'
import { SaleSeed } from '../core/saleSeed'
import { labelCode } from '../core/labelCode'
import { makeClipStore } from '../core/clipRecorder'
import { AuctionJournal } from '../core/auctionJournal'
import { makeIdentifyQueue } from '../core/identifyQueue'
import { BREAKER_COOLDOWN_MS, BREAKER_THRESHOLD, MAX_IDENTIFY_ATTEMPTS, RETRY_BACKOFF_MS, makeBreaker, makeIdentifyRun, serverToLocalSec, toWirePayload, type IdentifyPayload, type WireClip } from '../core/identifySend'
import type { IdentifyAnswer, IdentifyJob } from '../core/identifyClient'
import { clipNote, clipReadyEpochSec, createSeenOrders, identifyPayloadFor, splitSalesByAge, viewOutcome, type JournalEvent } from '../core/identifyWiring'
import { MAX_IDENTIFICATIONS, restoreEntries, rowFromEntry, type IdentificationRow } from '../core/identifyStore'
import { checkLatencyInput, identifyGate, identifyStateFrom, identifyStatus, latencyNote, migrateLegacySwitch } from '../core/identifySettings'

// Structured AI-transcript fields (was core/ledger's LedgerTranscript; the products
// panel still stores per-product transcripts in memory for the session).
interface LedgerTranscript { brand?: string; item?: string; color?: string; size?: string; retailPrice?: string; summary?: string }

interface LabelData { itemNumber: string; buyer?: string; productName?: string; price?: string; title?: string; code?: string }
type LabelField = 'itemNumber' | 'custom' | 'buyer' | 'productName' | 'price'
interface LabelTemplate {
  labelSize: '1x1' | '1.5x1.5' | '2x1' | '2x2' | '2.25x1.25'
  itemNumber: boolean
  buyer: boolean
  productName: boolean
  price: boolean
  custom: { enabled: boolean; regex: string; flags: string }
  scale?: Partial<Record<LabelField, number>>
  qr?: boolean
}
/** What main knows about identification: the two settings, and whether a capture token is saved. */
interface IdentifyView { baseUrl: string; enabled: boolean; damaged: boolean; defaultBaseUrl: string; ready: boolean; streamLatencySec: number }
declare global {
  interface Window {
    ttLive: { onEvent: (cb: (ev: LiveEvent) => void) => void }
    labelAPI: {
      getPrinters: () => Promise<{ printers: { name: string; displayName: string; isDefault: boolean }[]; saved: string; rawZpl: boolean; dry?: boolean }>
      savePrinter: (name: string) => Promise<boolean>
      setRawZpl: (enabled: boolean) => Promise<boolean>
      print: (labelData: LabelData, printerName: string, template: LabelTemplate) => Promise<{ success: boolean; error?: string }>
    }
    updateAPI?: {
      onReady: (cb: (info: { version: string }) => void) => void
    }
    recapAPI?: {
      enabled: () => Promise<{ enabled: boolean; model: string }>
      transcribe: (payload: { audio: Uint8Array; productName?: string; structured?: boolean }) => Promise<{ text?: string; fields?: LedgerTranscript; error?: string }>
      suggestRegex?: (payload: { title: string; want: string }) => Promise<{ regex?: string; flags?: string; explain?: string; error?: string }>
    }
    identifyAPI?: {
      state: () => Promise<IdentifyView>
      save: (args: { baseUrl?: string; enabled?: boolean; streamLatencySec?: number }) => Promise<IdentifyView & { ok: boolean; error?: string }>
      identify: (payload: { job: IdentifyJob; clip: WireClip }) => Promise<IdentifyAnswer>
      rows: () => Promise<IdentificationRow[]>
      saveRow: (row: IdentificationRow) => Promise<boolean>
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
      save: (args: { baseUrl?: string; token?: string }) => Promise<SfSyncView & { ok: boolean; error?: string }>
      openFolder: () => Promise<{ ok: boolean }>
      onState: (cb: (s: SfSyncView) => void) => void
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

const DEFAULT_TEMPLATE: LabelTemplate = {
  labelSize: '2x1', itemNumber: true, buyer: true, productName: true, price: false,
  custom: { enabled: false, regex: '', flags: '' },
  scale: { itemNumber: 1, custom: 1, buyer: 1, productName: 1, price: 1 },
  qr: false, // off until chosen — see electron/label.ts DEFAULT_TEMPLATE
}
let labelTemplate: LabelTemplate = (() => {
  try { return { ...DEFAULT_TEMPLATE, ...JSON.parse(localStorage.getItem('tt-label-template') || '{}') } } catch { return DEFAULT_TEMPLATE }
})()
const saveTemplate = () => localStorage.setItem('tt-label-template', JSON.stringify(labelTemplate))

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

// ── live sales feed (comp "bid feed") — paginated ───────────────────────────
let allSales: Sale[] = []
// Provisional rows from the fast close signals (pin/im), shown the instant an auction
// closes — the confirmed auction_result row replaces them (matched by product+lot key)
// or they expire after 90s. This is what makes the bid history "capture" a sale at
// the gavel instead of 2-6s later.
const provisionalSales: Sale[] = []
const PROV_TTL_MS = 90000
let currentTopSet = new Set<string>()
let feedPage = 0
let feedSize = Number(localStorage.getItem('tt-feed-size')) || 25

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

function updateFeedNav(totalRows: number, totalPages: number) {
  $('feedPage').textContent = `${totalRows ? feedPage + 1 : 0}/${totalPages}`
  ;($('feedPrev') as HTMLButtonElement).disabled = feedPage <= 0
  ;($('feedNext') as HTMLButtonElement).disabled = feedPage >= totalPages - 1
}

function renderFeed() {
  const feed = $('bidFeed')
  feed.replaceChildren()
  const rows = feedRows()
  if (!rows.length) { feed.appendChild(el('div', 'mono', 'Waiting for sales…')); updateFeedNav(0, 1); return }
  const totalPages = Math.max(1, Math.ceil(rows.length / feedSize))
  feedPage = Math.max(0, Math.min(feedPage, totalPages - 1))
  const start = feedPage * feedSize
  const page = rows.slice(start, start + feedSize)
  const topSet = currentTopSet
  page.forEach((s, idx) => {
    const i = start + idx
    const failed = s.paymentStatus === 'failed'
    const provisional = s.orderId.startsWith('prov:')
    const row = el('div', 'bidrow' + (i === 0 ? ' fresh' : '') + (failed ? ' failed' : ''))
    const who = el('div', 'bidwho')
    who.appendChild(el('div', 'bidname', s.buyer.username || s.buyer.handle || '—'))
    const sub = el('div', 'bidsub')
    if (topSet.has(s.buyer.ttuid || s.buyer.username)) sub.appendChild(el('span', 'tag whale', 'WHALE'))
    if (failed) sub.appendChild(el('span', 'tag failed', 'FAILED'))
    else if (provisional) sub.appendChild(el('span', 'tag pending', 'CLOSED'))
    else if (s.paymentStatus === 'pending') {
      // show the real deadline when TikTok gave us one, so the room can see which
      // pending wins are about to lapse rather than just that they are unpaid
      const left = payLeft(s)
      const tag = el('span', 'tag pending', left === undefined ? 'PENDING' : left > 0 ? `PENDING ${fmtLeft(left)}` : 'EXPIRED')
      if (left !== undefined) tag.title = `Payment due by ${new Date(s.paymentExpiresAt!).toLocaleTimeString()}`
      sub.appendChild(tag)
    }
    sub.appendChild(txt(`${s.skuDesc ? s.skuDesc + ' · ' : ''}${s.productName}`))
    who.appendChild(sub)
    row.appendChild(who)
    const right = el('div', 'bidright')
    right.appendChild(el('div', 'bidprice' + (failed ? ' failed' : ''), s.price.formatted))
    right.appendChild(el('div', 'bidtime', ago(s.createdAt)))
    row.appendChild(right)
    const pb = el('button', 'printmini', '🖨')
    pb.addEventListener('click', () => printSale(s))
    row.appendChild(pb)
    feed.appendChild(row)
  })
  updateFeedNav(rows.length, totalPages)
}

function setupFeed() {
  const sizeSel = $('feedSize') as HTMLSelectElement
  sizeSel.value = String(feedSize)
  sizeSel.addEventListener('change', () => { feedSize = Number(sizeSel.value) || 25; feedPage = 0; localStorage.setItem('tt-feed-size', String(feedSize)); renderFeed() })
  $('feedPrev').addEventListener('click', () => { feedPage = Math.max(0, feedPage - 1); renderFeed() })
  $('feedNext').addEventListener('click', () => { feedPage += 1; renderFeed() })
}

// ── live chat (decoded comments) ────────────────────────────────────────────
const chatSeen = new Set<string>()
// Chat-name hues, picked to hold 4.5:1 on the white chat column (the old set was tuned for a
// dark background and washed out on light). The first is the app accent.
const NAME_COLORS = ['#0a58f0', '#be185d', '#0a6b34', '#9a4708', '#6d28d9', '#0e7490']
function nameColor(n: string): string {
  let h = 0
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0
  return NAME_COLORS[h % NAME_COLORS.length]!
}
// Text we just posted ourselves → timestamp. We render an optimistic "You" row
// immediately on send, then suppress the webcast echo of the same text so it
// isn't shown twice (the echo carries the streamer's real nickname + a later ts).
const pendingSent = new Map<string, number>()

function appendChat(items: ChatMessage[]) {
  const list = $('chatList')
  let added = false
  for (const m of items) {
    const sentAt = pendingSent.get(m.text)
    if (sentAt !== undefined && Date.now() - sentAt < 20000) { pendingSent.delete(m.text); continue }
    const key = `${m.ts}|${m.nickname}|${m.text}`
    if (chatSeen.has(key)) continue
    chatSeen.add(key)
    if (!added && list.querySelector('.mono')) list.replaceChildren() // clear placeholder
    added = true
    const row = el('div', 'chatrow')
    const nm = el('span', 'chatname', m.nickname)
    nm.style.color = nameColor(m.nickname)
    row.appendChild(nm)
    row.appendChild(el('span', 'chattext', ' ' + m.text))
    list.appendChild(row)
  }
  if (!added) return
  while (list.childElementCount > 80) list.firstElementChild?.remove()
  if (chatSeen.size > 600) chatSeen.clear()
  list.scrollTop = list.scrollHeight
}

// Render our own outgoing message immediately (optimistic), styled as "You".
function appendOwnChat(text: string) {
  const list = $('chatList')
  if (list.querySelector('.mono')) list.replaceChildren() // clear placeholder
  const row = el('div', 'chatrow')
  const nm = el('span', 'chatname', 'You')
  nm.style.color = 'var(--accent-2)'
  row.appendChild(nm)
  row.appendChild(el('span', 'chattext', ' ' + text))
  list.appendChild(row)
  while (list.childElementCount > 80) list.firstElementChild?.remove()
  list.scrollTop = list.scrollHeight
}

// ── send-to-chat (streamer posts into the live) ──────────────────────────────
function setupChatInput() {
  const input = document.getElementById('chatInput') as HTMLInputElement | null
  const btn = document.getElementById('chatSend') as HTMLButtonElement | null
  if (!input || !btn) return
  if (!window.chatAPI) { input.disabled = true; btn.disabled = true; input.placeholder = 'Chat unavailable'; return }
  let sending = false
  const send = async () => {
    const text = input.value.trim()
    if (!text || sending) return
    sending = true
    btn.disabled = true
    input.value = ''
    try {
      const r = await window.chatAPI!.send(text)
      if (r?.ok) {
        pendingSent.set(text, Date.now()) // suppress the webcast echo of our own message
        appendOwnChat(text)
      } else {
        input.value = text // restore so the user can retry
        input.placeholder = r?.error ? `Failed: ${r.error}`.slice(0, 60) : 'Send failed — retry'
      }
    } catch {
      input.value = text
      input.placeholder = 'Send failed — retry'
    } finally {
      sending = false
      btn.disabled = false
      input.focus()
    }
  }
  btn.addEventListener('click', () => void send())
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void send() } })
}
setupChatInput()

// ── top buyers (this show) ──────────────────────────────────────────────────
// Ranked leaderboard for the live session. buyers is ev.topBuyers — already sorted
// by spend desc and recomputed each sales poll — so this updates as sales land, and
// ranks 2-8 visibly move even when the #1 whale is stable (the single-name version
// looked "stuck" precisely because it only ever showed #1).
const TOP_BUYERS_SHOWN = 8
function renderTopBuyer(buyers: BuyerAgg[]) {
  const list = $('topBuyersList')
  list.replaceChildren()
  $('topBuyersCount').textContent = buyers.length ? `${buyers.length} buyer${buyers.length === 1 ? '' : 's'}` : ''
  if (!buyers.length) {
    const empty = el('div', 'mono', 'No sales yet')
    empty.style.cssText = 'font-size:11px;color:var(--ink-4);'
    list.appendChild(empty)
    return
  }
  buyers.slice(0, TOP_BUYERS_SHOWN).forEach((b, i) => {
    const rank = i + 1
    const lead = rank === 1
    const row = el('div')
    row.style.cssText = 'display:flex;align-items:center;gap:9px;'
    const rk = el('div', 'mono', String(rank))
    rk.style.cssText = `width:15px;text-align:center;font-size:11px;font-weight:${lead ? '700' : '400'};color:${lead ? 'var(--accent)' : 'var(--ink-4)'};`
    const name = el('div', '', '@' + (b.handle ?? (b.username || '—')))
    name.style.cssText = `flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:${lead ? '600' : '400'};color:${lead ? 'var(--ink)' : 'var(--ink-2)'};`
    const spend = el('div', 'mono', `$${(b.totalCents / 100).toFixed(0)}`)
    spend.style.cssText = 'font-size:12.5px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums;'
    const items = el('div', 'mono', `·${b.itemCount}`)
    items.style.cssText = 'width:26px;text-align:right;font-size:11px;color:var(--ink-4);'
    row.append(rk, name, spend, items)
    list.appendChild(row)
  })
}

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
    const busy = productTxBusy.has(row.id)
    const has = !!productTx[row.id]
    const tx = el('div', 'ptx' + (busy ? ' busy' : has ? ' has' : ''), busy ? '◴' : '✦')
    tx.title = has ? (productTx[row.id]?.summary || 'AI details captured — click to re-transcribe this product') : recapEnabled ? 'Click to AI-transcribe this product' : 'Set GEMINI_API_KEY to enable AI transcription'
    if (recapEnabled && !busy) tx.addEventListener('click', () => void transcribeProduct(row.id, row.name))
    if (!AI_UI) tx.style.display = 'none'
    tr.appendChild(tx)
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

// ── failed / expired payments ───────────────────────────────────────────────
let failedSales: Sale[] = []
function renderFailed() {
  const panel = document.getElementById('failedPanel')
  const list = document.getElementById('failedList')
  const count = document.getElementById('failedCount')
  if (!panel || !list) return
  // Expired-but-not-yet-flipped rows belong here too: auction_result can take a while to
  // move order_status to 2, and a lapsed deadline is already a decision the room can act on.
  const expired = allSales.filter((s) => s.paymentStatus === 'pending' && s.paymentExpiresAt && s.paymentExpiresAt <= Date.now())
  const rows = [...failedSales, ...expired.filter((e) => !failedSales.some((f) => f.orderId === e.orderId))]
    .sort((a, b) => b.createdAt - a.createdAt)
  panel.style.display = rows.length ? '' : 'none'
  if (count) count.textContent = String(rows.length)
  list.replaceChildren()
  for (const s of rows.slice(0, 40)) {
    const row = el('div', 'bidrow failed')
    const who = el('div', 'bidwho')
    who.appendChild(el('div', 'bidname', s.buyer.username || s.buyer.handle || '—'))
    const sub = el('div', 'bidsub')
    sub.appendChild(el('span', 'tag failed', s.paymentStatus === 'failed' ? 'FAILED' : 'EXPIRED'))
    sub.appendChild(txt(`${s.skuDesc ? s.skuDesc + ' · ' : ''}${s.productName}`))
    who.appendChild(sub)
    row.appendChild(who)
    const right = el('div', 'bidright')
    right.appendChild(el('div', 'bidprice failed', s.price.formatted))
    right.appendChild(el('div', 'bidtime', ago(s.createdAt)))
    row.appendChild(right)
    // the label already printed at the gavel — reprinting is the common recovery when the
    // item comes back off the pack bench and gets relisted
    const pb = el('button', 'printmini', '🖨')
    pb.title = 'Reprint this label'
    pb.addEventListener('click', () => printSale(s))
    row.appendChild(pb)
    list.appendChild(row)
  }
}

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
  }
  if (flvCatchup !== null) { clearInterval(flvCatchup); flvCatchup = null }
  if (flvPlayer) { try { flvPlayer.destroy() } catch { /* ignore */ } flvPlayer = null }
  flvPlayer = flvjs.createPlayer(
    { type: 'flv', url, isLive: true, cors: true },
    { enableStashBuffer: false, autoCleanupSourceBuffer: true }, // low initial latency; drop old buffered data
  )
  flvPlayer.attachMediaElement(video)
  flvPlayer.on(flvjs.Events.ERROR, () => { window.setTimeout(() => loadStream(lastStreamUrl), 2500) })
  video.addEventListener('playing', () => startAudioCapture(), { once: true })
  flvPlayer.load()
  void video.play().catch(() => {})
  // flv.js (unlike the mpegts.js fork) does NOT chase the live edge, so latency accumulates
  // after any rebuffer. Periodically jump back toward the live edge when too far behind.
  flvCatchup = window.setInterval(() => { if (!video.paused) seekToLiveEdge(video, 2) }, 2000)
}

// AI extraction is off in the desktop UI for now. The whole pipeline below — clip
// capture, Gemini call, per-product structured transcripts — stays wired and tested;
// only its on-screen affordances are hidden. Flip this to re-surface them.
const AI_UI = false

// ── auction audio → AI transcript (mirrors sellerfolio-live enrichment) ──────
let astream: MediaStream | null = null
let rec: MediaRecorder | null = null
// The last 5 minutes of show audio (sized from the measured p99 inter-sale gap of 219 s), one
// chunk per second. A sale's clip is cut from this on demand; nothing is recorded per sale.
// Epoch seconds from this machine's clock -- the same clock the sale's own timestamp is read against.
const clipStore = makeClipStore({ capSec: 300, now: () => Date.now() / 1000 })
// recapEnabled = core/identifyGate: a capture token is saved AND the Settings switch is on. The switch
// is stored by the main process (identify.json) and is ON by default, so saving a token is what
// turns identification on; it used to need a Gemini key on this machine plus a switch that defaulted
// off, back when the answers had nowhere to go. Nothing is captured or sent while it is off, and
// main refuses to send while it is off whatever this page thinks.
let geminiKeyPresent = false // the old local-Gemini product transcript only; identification does not use it
let recapEnabled = false
let identifyReady = false // a capture token is saved (the SellerFolio sync token: there is no second one)
let identifyEnabled = true // the Settings switch, as main last reported it
let identifyDamaged = false // main could not read the setting and switched identification off
let identifyHeld = false // an earlier opt-out could not be carried over: unknown means OFF for this session
let identifyUrl = ''
let identifyLatencySec = 0 // how far the recorded stream lags the show (core/identifyWiring: STREAM LATENCY); 0 = not measured
let transcribing = false // the capture lock of transcribeProduct (the local Gemini path) only
let watchedRoomId: string | null = null
interface Recap {
  head: string
  lot: string
  price: string
  /** `abandoned` is the queue's third outcome: the show ended with this sale still waiting. */
  status: 'transcribing' | 'done' | 'error' | 'skipped' | 'abandoned'
  /** Identified by the server, which wrote the identity: this row has no fields to show. */
  live?: boolean
  text: string
  /** The five SellerFolio fields. main.ts has always returned these; the old UI threw them away. */
  fields?: LedgerTranscript
  /** An operator corrected this entry by hand — never silently replaced by a later run. */
  edited?: boolean
  /** Kept so Retry can re-run THIS lot rather than whatever is selling now. Memory only: a restored row has none. */
  sale?: Sale
  /** What identifies the row on disk (core/identifyStore). A row without them is never persisted. */
  orderId?: string
  roomId?: string | null
  atEpochSec?: number
}
/** Save a row's current state. Fire and forget: a disk that fails must never reach the show. */
function persistEntry(e: Recap): void {
  const row = rowFromEntry(e)
  const api = window.identifyAPI
  if (!row || !api) return
  try { void Promise.resolve(api.saveRow(row)).catch(() => {}) } catch { /* the page still shows the row */ }
}
const ID_FIELDS: Array<[keyof LedgerTranscript, string, boolean]> = [
  ['brand', 'Brand', false], ['item', 'Item', false], ['color', 'Color', false],
  ['size', 'Size', true], ['retailPrice', 'MSRP', true],
]
/** A model that answers "Not stated" has not answered. Treat it as absent, as the server does. */
function idValue(v: unknown): string | null {
  const t = typeof v === 'string' ? v.trim() : ''
  return !t || /^(not stated|unknown|n\/?a|none|-+)$/i.test(t) ? null : t
}
function idIsWeak(r: Recap): boolean {
  if (r.status !== 'done' || (r.live && !r.fields)) return false
  return ID_FIELDS.some(([k]) => idValue(r.fields?.[k]) === null)
}
/** Anything that ended without an identity: a failure, an empty clip, or a sale the show outlived. */
function idUnresolved(r: Recap): boolean {
  return r.status === 'error' || r.status === 'skipped' || r.status === 'abandoned'
}
const recaps: Recap[] = []

function startRecorder(): void {
  if (!astream) return
  const r = (() => { try { return new MediaRecorder(astream, { mimeType: 'audio/webm' }) } catch { return new MediaRecorder(astream) } })()
  // One continuous recording. The timeslice makes ondataavailable fire every second, and each
  // second lands in the store. Never stop and restart it to cut a clip: the store does that.
  r.ondataavailable = (e) => { if (e.data.size) void clipStore.push(e.data, 1) } // never rejects
  rec = r
  r.start(1000)
}
/** Drop the recorder without letting its final flush reach the store. */
function haltRecorder(): void {
  const r = rec
  rec = null
  if (!r) return
  r.ondataavailable = null
  try { if (r.state !== 'inactive') r.stop() } catch { /* already stopped */ }
}
function startAudioCapture(): void {
  // Off means off: no recorder exists, so there is no clip to send.
  if (astream || !recapEnabled) return
  const video = document.getElementById('live') as (HTMLVideoElement & { captureStream?: () => MediaStream }) | null
  let stream: MediaStream | undefined
  try { stream = video?.captureStream?.() } catch { /* ignore */ }
  const tracks = stream?.getAudioTracks() ?? []
  if (!tracks.length) return
  astream = new MediaStream(tracks)
  startRecorder()
}
function stopAudioCapture(): void {
  astream = null
  haltRecorder()
  clipStore.reset() // a later recorder writes a fresh container header; old chunks must not be spliced to it
}
/** A different show: forget the last one's audio, and restart the recorder so the new buffer begins
 *  at a container header rather than mid-stream. */
function resetClipBuffer(): void {
  haltRecorder()
  clipStore.reset()
  startRecorder()
}
/** The most recent `sec` seconds of buffered audio (whole chunks, so a little more), or null.
 *  NOT the identification window: that is planned per sale by core/clipBuffer + clipRecorder.
 *  This is a "right now" grab kept ONLY for transcribeProduct (the local-Gemini Products-table click).
 *  Do not use it for sales and do not grow it: a second window path is how production drifted before. */
function recentClip(sec: number): Blob | null {
  const end = Date.now() / 1000
  return clipStore.extract({ startEpochSec: end - sec, endEpochSec: end })?.blob ?? null
}

/** The five fields as a label/value grid — same order and labels as the web app's identity card. */
function idFieldGrid(r: Recap): HTMLElement {
  const dl = el('dl', 'id-fields')
  for (const [key, label, mono] of ID_FIELDS) {
    dl.appendChild(el('dt', undefined, label))
    const dd = el('dd', mono ? 'mono' : undefined)
    const v = idValue(r.fields?.[key])
    const span = el('span', v ? 'v' : 'v id-none', v ?? (r.status === 'transcribing' ? 'listening…' : 'not said'))
    dd.appendChild(span)
    dl.appendChild(dd)
  }
  return dl
}

/** Inline correction of the five fields. An operator edit is never overwritten by a later run. */
function idEditor(r: Recap, redraw: () => void): HTMLElement {
  const box = el('div', 'id-edit')
  const row = el('div', 'row')
  const inputs: Partial<Record<keyof LedgerTranscript, HTMLInputElement>> = {}
  for (const [key, label] of ID_FIELDS) {
    const lab = el('label', undefined, label)
    const inp = document.createElement('input')
    inp.value = idValue(r.fields?.[key]) ?? ''
    inp.placeholder = 'not said'
    inputs[key] = inp
    row.appendChild(lab); row.appendChild(inp)
  }
  const acts = el('div', 'acts')
  const cancel = el('button', 'qbtn sm', 'Cancel')
  const save = el('button', 'qbtn sm print', 'Save identity')
  cancel.addEventListener('click', () => { editing.delete(r); redraw() })
  save.addEventListener('click', () => {
    const next: LedgerTranscript = { ...(r.fields ?? {}) }
    for (const [key] of ID_FIELDS) next[key] = inputs[key]!.value.trim()
    r.fields = next
    r.edited = true
    r.status = 'done'
    persistEntry(r)
    editing.delete(r)
    redraw()
  })
  acts.appendChild(cancel); acts.appendChild(save)
  box.appendChild(row); box.appendChild(acts)
  return box
}

/** Retry arms on the first click and runs on the second — the same guard the web app puts on
 *  re-transcribe, so one stray click cannot throw away an identity someone corrected by hand. */
function idRetryButton(r: Recap, redraw: () => void): HTMLElement {
  const b = el('button', 'qbtn sm', 'Retry') as HTMLButtonElement
  b.disabled = r.status === 'transcribing' // one job per lot: wait for its outcome
  let armed = false
  let t: ReturnType<typeof setTimeout> | undefined
  b.addEventListener('click', () => {
    if (!armed) {
      armed = true; b.classList.add('armed'); b.textContent = 'Confirm retry'
      t = setTimeout(() => { armed = false; b.classList.remove('armed'); b.textContent = 'Retry' }, 4000)
      return
    }
    if (t) clearTimeout(t)
    armed = false; b.classList.remove('armed')
    if (!r.sale || !recapEnabled) { b.textContent = recapEnabled ? 'no audio for this lot' : 'audio is off'; setTimeout(() => { b.textContent = 'Retry' }, 1800); return }
    b.textContent = 'Retrying…'
    identifySale(r.sale, r)
    redraw()
  })
  return b
}

/** Which entries are mid-edit. Keyed by object so a re-render cannot lose the open editor. */
const editing = new Set<Recap>()

function idEntry(r: Recap, current: boolean, redraw: () => void): HTMLElement {
  const weak = idIsWeak(r)
  const row = el('div', 'recap-entry' + (current ? ' current' : '') + (weak ? ' review' : ''))
  const head = el('div', 'recap-head')
  head.appendChild(el('span', undefined, [r.lot, r.head].filter(Boolean).join(' · ')))
  if (r.price) head.appendChild(el('span', 'price', r.price))
  row.appendChild(head)

  if (idUnresolved(r)) {
    row.appendChild(el('div', 'recap-text error', '⚠ ' + r.text))
  } else if (r.live && !r.fields) {
    if (r.status !== 'transcribing') row.appendChild(el('div', 'recap-text', r.text))
  } else {
    row.appendChild(idFieldGrid(r))
  }

  if (r.status === 'transcribing') {
    const bar = el('div', 'id-working')
    bar.appendChild(el('i'))
    row.appendChild(bar)
    row.appendChild(el('div', 'id-why', r.live ? 'identifying this lot…' : 'listening to this lot…'))
  } else {
    const acts = el('div', 'id-acts')
    acts.appendChild(el('span', 'id-why',
      r.edited ? 'you corrected this' : r.status === 'error' ? 'identification failed' : r.status === 'abandoned' || r.status === 'skipped' ? 'not identified' : weak ? 'some fields were not said' : 'identified'))
    const override = el('button', 'qbtn sm', 'Override')
    override.addEventListener('click', () => { editing.has(r) ? editing.delete(r) : editing.add(r); redraw() })
    acts.appendChild(override)
    acts.appendChild(idRetryButton(r, redraw))
    row.appendChild(acts)
    if (editing.has(r)) row.appendChild(idEditor(r, redraw))
  }
  return row
}

/** The capture lights report what is ACTUALLY running, not what the app can do.
 *  AUDIO is green only while a MediaRecorder is recording the stream's audio track — which needs
 *  a saved capture token and the Settings switch (on by default). VIDEO is green only
 *  while the player is genuinely playing. Anything less and an operator checking "is this
 *  capturing?" gets a reassuring light over nothing. */
function renderCaptureState() {
  const v = document.getElementById('live') as HTMLVideoElement | null
  const videoLive = !!v && !v.paused && !v.ended && v.readyState >= 2
  const audioLive = !!astream && rec?.state === 'recording'
  const audio = document.getElementById('sigAudio')
  const video = document.getElementById('sigVideo')
  if (audio) {
    audio.classList.toggle('off', !audioLive)
    audio.title = audioLive ? 'Recording the stream’s audio for identification'
      : recapEnabled ? 'Idle — audio is captured when a lot sells' : 'Off — turn on Show audio in Settings'
  }
  if (video) {
    video.classList.toggle('off', !videoLive)
    video.title = videoLive ? 'Playing the live stream' : 'No stream playing'
  }
  const note = document.getElementById('captureNote')
  if (note) note.textContent = audioLive ? 'recording' : recapEnabled ? 'armed' : 'audio off'
}

function renderRecap() {
  const list = document.getElementById('recapList')
  if (!list) return
  list.replaceChildren()
  const count = document.getElementById('idCount')
  if (count) count.textContent = String(recaps.filter((r) => r.status === 'done').length)
  const chip = document.getElementById('idReviewChip')
  if (chip) {
    const n = recaps.filter((r) => idIsWeak(r) || idUnresolved(r)).length
    chip.textContent = `${n} need review`
    chip.style.display = n ? '' : 'none'
  }
  if (!recaps.length) {
    const e = el('div', 'mono', recapEnabled ? 'items are identified as they sell…' : identifyReady ? 'turn on Show audio in Settings to identify items' : 'save a capture token in Settings to enable')
    e.style.cssText = 'padding:14px 16px;color:var(--ink-4);font-size:11px;'
    list.appendChild(e)
    return
  }
  // Two only: the lot selling and the one before it. Everything older is on the Identifications
  // screen — a scrolling backlog here competes with the show for the operator's attention.
  recaps.slice(0, 2).forEach((r, i) => list.appendChild(idEntry(r, i === 0, renderAll)))
  if (recaps.length > 2) {
    const more = el('div', 'recap-entry')
    const link = el('a', undefined, 'Earlier lots are on the Identifications screen')
    link.setAttribute('href', '#')
    link.style.cssText = 'font-size:11px;color:var(--accent);'
    link.addEventListener('click', (e) => { e.preventDefault(); showScreen('identify') })
    more.appendChild(link)
    list.appendChild(more)
  }
}

/** Both views read the same array, so an Override made in one is visible in the other. */
function renderAll() { renderRecap(); renderIdentifications() }

let idFilter: 'all' | 'review' | 'edited' = 'all'
function renderIdentifications() {
  const body = document.getElementById('idRows')
  const empty = document.getElementById('idEmpty')
  if (!body) return
  const q = ((document.getElementById('idSearch') as HTMLInputElement | null)?.value ?? '').trim().toLowerCase()
  const rows = recaps.filter((r) => {
    if (idFilter === 'review' && !(idIsWeak(r) || idUnresolved(r))) return false
    if (idFilter === 'edited' && !r.edited) return false
    if (!q) return true
    return [r.lot, r.head, r.fields?.brand, r.fields?.item].some((v) => (v ?? '').toLowerCase().includes(q))
  })
  body.replaceChildren()
  if (empty) empty.style.display = rows.length ? 'none' : ''
  for (const r of rows) {
    const tr = el('tr', idIsWeak(r) || idUnresolved(r) ? 'flagged' : undefined)
    const cell = (text: string | null, cls?: string) => {
      const td = el('td', cls)
      td.appendChild(el('span', text ? undefined : 'id-none', text ?? 'not said'))
      return td
    }
    tr.appendChild(cell(r.lot || '—', 'mono'))
    // A lot the server identified has its fields on the server, not here: say so rather than "not said".
    const fieldText = (k: keyof LedgerTranscript) => (r.live && !r.fields ? '—' : idValue(r.fields?.[k]))
    tr.appendChild(cell(fieldText('brand')))
    tr.appendChild(cell(fieldText('item')))
    tr.appendChild(cell(fieldText('color')))
    tr.appendChild(cell(fieldText('size'), 'mono'))
    tr.appendChild(cell(fieldText('retailPrice'), 'num mono'))
    tr.appendChild(cell(r.price || null, 'num mono'))
    tr.appendChild(cell(r.edited ? 'You corrected it'
      : r.status === 'error' ? (r.text || 'Failed') : r.status === 'abandoned' ? 'Not identified (show ended or app closed)' : r.status === 'skipped' ? 'Nothing to identify'
      : r.status === 'transcribing' ? 'Identifying…' : 'Identified live'))
    const acts = el('td')
    const wrap = el('div', 'rowacts')
    const ov = el('button', 'qbtn sm', 'Override')
    ov.addEventListener('click', () => { editing.has(r) ? editing.delete(r) : editing.add(r); renderAll() })
    wrap.appendChild(ov)
    wrap.appendChild(idRetryButton(r, renderAll))
    acts.appendChild(wrap)
    tr.appendChild(acts)
    body.appendChild(tr)
    if (editing.has(r)) {
      const erow = el('tr')
      const td = el('td')
      td.setAttribute('colspan', '9')
      td.appendChild(idEditor(r, renderAll))
      erow.appendChild(td)
      body.appendChild(erow)
    }
  }
}
// ── live identification: sale → clip → queue → worker → row ────────────────────────────────────
// Every fresh sale is windowed from the audio buffer, queued, and posted to the identification
// endpoint by the main process. The queue replaces the old `transcribing` boolean, which silently
// discarded any sale that arrived while another was in flight. Pure rules live in core/.
type IdentifyQueueJob = {
  orderId: string
  /** What the server is sent, assembled in core/identifyWiring: the job and the extracted clip itself. */
  payload: IdentifyPayload
  /** The show this sale belongs to: a retry for a show that has ended is not worth a model call. */
  show: number
  entry: Recap
}
const MAX_BOUNDARY_EVENTS = 600
/** Slice time: a chunk is delivered when its second has FINISHED, so the tail lands up to ~1 s late. */
const CHUNK_SETTLE_MS = 1500
/** Never wait longer than this for a sale's tail audio, whatever the clocks say. */
const MAX_TAIL_WAIT_MS = 15_000
/** Concurrent POSTs. Two, so one slow identification (up to the timeout) does not hold every later sale. */
const IDENTIFY_CONCURRENCY = 2
let showGeneration = 0
let boundaryEvents: JournalEvent[] = [] // this show's auction starts/ends and sales, on THIS machine's clock
let boundaryJournal = new AuctionJournal()
const seenOrders = createSeenOrders() // a sale is identified once unless someone presses Retry; restored orders are never forgotten

function noteBoundary(e: JournalEvent): void {
  boundaryEvents.push(e)
  if (boundaryEvents.length > MAX_BOUNDARY_EVENTS) boundaryEvents.splice(0, boundaryEvents.length - MAX_BOUNDARY_EVENTS)
}
/** `note` is what the audio behind an identification should admit to (core/identifyWiring clipNote); it is only said of a success. */
function settleEntry(entry: Recap, outcome: { status: string; reason?: string; tries?: number }, note = ''): void {
  const v = viewOutcome(outcome)
  entry.status = v.status
  entry.text = v.text + (v.status === 'done' ? note : '')
  persistEntry(entry)
  renderAll()
}
// Fails fast while the worker is unreachable, so an outage costs one quick failure per sale, not the whole retry budget.
const identifyBreaker = makeBreaker({ threshold: BREAKER_THRESHOLD, cooldownMs: BREAKER_COOLDOWN_MS, now: () => Date.now() })
const identifyQueue = makeIdentifyQueue<IdentifyQueueJob, IdentifyAnswer & { tries: number }>({
  run: makeIdentifyRun<IdentifyQueueJob>({
    send: async (job) => {
      const api = window.identifyAPI
      if (!api) return { status: 'failed', reason: 'network_error', retryable: false }
      return api.identify(await toWirePayload(job.payload))
    },
    maxAttempts: MAX_IDENTIFY_ATTEMPTS,
    backoffMs: RETRY_BACKOFF_MS,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    shouldContinue: (job) => job.show === showGeneration && recapEnabled,
    breaker: identifyBreaker,
  }),
  onSettled: (job, outcome) => settleEntry(job.entry, outcome, clipNote(job.payload.clip)),
  concurrency: IDENTIFY_CONCURRENCY,
})
/** The show changed or identification was turned off: sales still WAITING settle as abandoned. */
function endIdentifyShow(reason: string): void {
  showGeneration++
  boundaryEvents = []
  boundaryJournal = new AuctionJournal()
  seenOrders.endShow()
  identifyQueue.abandonAll(reason)
}

/** A sale on THIS machine's clock: what the row and the window are built from. */
function saleOnThisClock(s: Sale) {
  return { orderId: s.orderId, roomId: s.roomId ?? watchedRoomId, atEpochSec: serverToLocalSec(s.createdAt, serverTimeOffsetMs) }
}
/** The row for a sale, newest first, kept to the store's cap. Not yet drawn or saved. */
function newEntryFor(s: Sale, sale: { orderId: string; roomId: string | null; atEpochSec: number }): Recap {
  const entry: Recap = {
    head: `${s.productName.slice(0, 30)} — @${s.buyer.handle ?? s.buyer.username}`,
    lot: s.skuDesc ?? '', price: s.price?.formatted ?? '',
    status: 'transcribing', text: '', sale: s, live: true,
    orderId: sale.orderId, roomId: sale.roomId, atEpochSec: sale.atEpochSec,
  }
  recaps.unshift(entry)
  if (recaps.length > MAX_IDENTIFICATIONS) recaps.pop()
  return entry
}
/**
 * A sale that reached the app too late to identify on its own (late-landing order rows are normal) gets a
 * row saying so, not silence. It is not sent: the operator can press Retry, which cuts from whatever the
 * buffer still holds.
 */
function recordTooOldSale(s: Sale): void {
  if (!recapEnabled || !window.identifyAPI) return
  if (seenOrders.has(s.orderId)) return
  seenOrders.markSent(s.orderId)
  settleEntry(newEntryFor(s, saleOnThisClock(s)), { status: 'failed', reason: 'too_old' })
}

/** Identify one sale. `existing` is a row being retried: it is reused, not duplicated. */
function identifySale(s: Sale, existing?: Recap): void {
  if (!recapEnabled || !window.identifyAPI) return
  // A lot already being identified keeps its one in-flight job; a second Retry must not queue another.
  if (existing?.status === 'transcribing') return
  if (!existing) {
    if (seenOrders.has(s.orderId)) return
    seenOrders.markSent(s.orderId)
  }
  // Everything the server is sent is assembled in core/identifyWiring (tested): this only supplies the
  // sale on THIS machine's clock, the show's journal, and the store.
  const sale = saleOnThisClock(s)
  const entry = existing ?? newEntryFor(s, sale)
  entry.status = 'transcribing'
  entry.text = ''
  // Written now, not only when it settles: a lot still waiting when the app closes is then on record
  // as not identified, instead of vanishing.
  persistEntry(entry)
  renderAll()
  const show = showGeneration
  // The clip includes the tail after the sale, so wait for that audio to exist.
  const waitMs = Math.min(MAX_TAIL_WAIT_MS, Math.max(0, (clipReadyEpochSec(sale.atEpochSec, identifyLatencySec) - Date.now() / 1000) * 1000) + CHUNK_SETTLE_MS)
  setTimeout(() => {
    if (show !== showGeneration || !recapEnabled) { settleEntry(entry, { status: 'abandoned', reason: 'identification stopped' }); return }
    const payload = identifyPayloadFor(sale, boundaryEvents, clipStore, identifyLatencySec)
    if (!payload) { settleEntry(entry, { status: 'failed', reason: 'no_audio' }); return }
    // A refusal means this order is already queued or running: say so on the row rather than leave it
    // on "Identifying…" (the job that holds the order settles the same row with its real outcome).
    if (!identifyQueue.enqueue({ orderId: sale.orderId, payload, show, entry })) settleEntry(entry, { status: 'failed', reason: 'already_queued' })
  }, waitMs)
}

// structured per-product (per-bin) transcription — one capture covers every order of that product
const productTxBusy = new Set<string>()
async function transcribeProduct(productId: string, productName: string): Promise<boolean> {
  // `transcribing` is the capture lock: only one local-Gemini clip grab at a time
  if (!recapEnabled || !geminiKeyPresent || !window.recapAPI || transcribing || productTxBusy.has(productId)) return false
  transcribing = true
  productTxBusy.add(productId)
  renderProductsTable()
  try {
    const clip = recentClip(30)
    if (!clip || clip.size < 2000) return false
    const audio = new Uint8Array(await clip.arrayBuffer())
    const res = await window.recapAPI.transcribe({ audio, productName, structured: true })
    if (res.fields && Object.keys(res.fields).length) productTx[productId] = res.fields
    else if (res.text) productTx[productId] = { summary: res.text }
    else return false
    renderProductsTable()
    return true
  } catch { return false } finally {
    transcribing = false
    productTxBusy.delete(productId)
    renderProductsTable()
  }
}

function applyIdentifyState(): void {
  const was = recapEnabled
  const gate = identifyGate({ hasToken: identifyReady, enabled: identifyEnabled, held: identifyHeld })
  recapEnabled = gate === 'on'
  if (recapEnabled) startAudioCapture() // no-op until the video is playing; its own listener covers that
  else if (was) { stopAudioCapture(); endIdentifyShow('identification was turned off') }
  const sw = document.getElementById('aiTranscribe') as HTMLInputElement | null
  const st = document.getElementById('aiState')
  if (sw) { sw.checked = recapEnabled; sw.disabled = !identifyReady }
  if (st) {
    const [text, cls] = identifyStatus(gate, identifyDamaged, identifyHeld)
    st.className = 'state ' + cls
    st.textContent = text
  }
  const url = document.getElementById('idUrl') as HTMLInputElement | null
  if (url) {
    if (document.activeElement !== url) url.value = identifyUrl
    url.placeholder = identifyDefaultUrl
  }
  const lat = document.getElementById('idLatency') as HTMLInputElement | null
  if (lat && document.activeElement !== lat) lat.value = identifyLatencySec ? String(identifyLatencySec) : ''
  const latState = document.getElementById('idLatencyState')
  if (latState && !latStateHeld) {
    const n = latencyNote(identifyLatencySec)
    latState.className = 'state ' + n.cls
    latState.textContent = n.text
  }
  renderAll()
}
let identifyDefaultUrl = ''
let latStateHeld = false // a save result is showing under the delay box; the standing note comes back on the next change
/** Ask main what the settings are now (a token may have just been saved or removed) and apply them. */
async function refreshIdentifyState(): Promise<void> {
  let told: unknown
  try { told = await window.identifyAPI?.state() } catch { told = undefined }
  const s = identifyStateFrom(told) // untrusted over IPC: anything not exactly true is false
  identifyReady = s.ready
  identifyEnabled = s.enabled
  identifyDamaged = s.damaged
  identifyUrl = s.baseUrl
  identifyDefaultUrl = s.defaultBaseUrl
  identifyLatencySec = s.streamLatencySec
  applyIdentifyState()
}
document.getElementById('aiTranscribe')?.addEventListener('change', (e) => {
  const want = (e.target as HTMLInputElement).checked
  identifyHeld = false // an explicit choice here replaces the unknown one
  const api = window.identifyAPI
  if (!api) { applyIdentifyState(); return }
  void api.save({ enabled: want }).then(() => refreshIdentifyState(), () => refreshIdentifyState())
})
document.getElementById('idUrlSave')?.addEventListener('click', () => {
  const api = window.identifyAPI
  const box = document.getElementById('idUrl') as HTMLInputElement | null
  const st = document.getElementById('idUrlState')
  if (!api || !box) return
  void api.save({ baseUrl: box.value }).then(async (r) => {
    // On a refusal the box keeps what was typed, so it can be corrected rather than retyped.
    if (r.ok) { await refreshIdentifyState(); box.value = r.baseUrl }
    if (st) { st.className = 'state ' + (r.ok ? 'ok-text' : 'bad-text'); st.textContent = r.ok ? 'Saved' : (r.error ?? 'Could not save') }
  }, () => { if (st) { st.className = 'state bad-text'; st.textContent = 'Could not save' } })
})

document.getElementById('idLatencySave')?.addEventListener('click', () => {
  const api = window.identifyAPI
  const box = document.getElementById('idLatency') as HTMLInputElement | null
  const st = document.getElementById('idLatencyState')
  if (!api || !box) return
  const c = checkLatencyInput(box.value)
  // A refusal keeps what was typed, so it can be corrected rather than retyped.
  if (!c.ok) { if (st) { st.className = 'state bad-text'; st.textContent = c.error; latStateHeld = true } return }
  latStateHeld = false
  void api.save({ streamLatencySec: c.sec }).then(async (r) => {
    if (r.ok) { await refreshIdentifyState(); box.value = identifyLatencySec ? String(identifyLatencySec) : '' }
    else if (st) { st.className = 'state bad-text'; st.textContent = r.error ?? 'Could not save'; latStateHeld = true }
  }, () => { if (st) { st.className = 'state bad-text'; st.textContent = 'Could not save'; latStateHeld = true } })
})

/** Bring last session's identifications back. Never throws and never blocks the page: no rows is a valid answer. */
async function restoreIdentifications(): Promise<void> {
  let rows: IdentificationRow[] = []
  try { rows = (await window.identifyAPI?.rows()) ?? [] } catch { rows = [] }
  if (!Array.isArray(rows)) return
  for (const e of restoreEntries(recaps, rows, MAX_IDENTIFICATIONS)) {
    recaps.push(e)
    // A sale the app is shown again after a restart is already on record: it is not identified twice.
    seenOrders.markRestored(e.orderId)
  }
}

/** The old switch was in localStorage and defaulted off. An operator who turned it off keeps it off. */
async function migrateLegacyIdentifySwitch(): Promise<void> {
  const api = window.identifyAPI
  if (!api) return
  // Unresolved (the opt-out could not be saved, or the old preference could not be read) holds the gate OFF:
  // falling through to the new default would switch audio on against a choice the operator made.
  try { identifyHeld = (await migrateLegacySwitch(localStorage, async (enabled) => (await api.save({ enabled })).ok === true)) === 'unresolved' } catch { identifyHeld = true }
}

async function initRecap() {
  try { geminiKeyPresent = (await window.recapAPI?.enabled())?.enabled ?? false } catch { geminiKeyPresent = false }
  await migrateLegacyIdentifySwitch() // before the gate is first read, or an opt-out would arm the recorder for a moment
  await refreshIdentifyState()
  await restoreIdentifications()
  // The AI chip lived on the deleted "Current auction item" panel. The Identification section
  // head carries the state now; AI_UI still gates the whole feature without a plumbing rebuild.
  // Opened without the Electron preload (a browser preview), the demo block seeds rows so the
  // layout can be checked without a live show. It supplies DATA; this file owns the markup.
  const seed = (window as unknown as { __demoRecaps?: Recap[] }).__demoRecaps
  if (seed?.length && !recaps.length) recaps.push(...seed)
  renderAll()
}
void initRecap()

// ── label printing ──────────────────────────────────────────────────────────
let selectedPrinter = ''
let autoPrint = false
let feedWinsSeen = 0 // "won" feed rows observed this session (lets you confirm the observer catches wins even before flipping to feed mode)
let lastPrintedNumber: number | null = null
const printQueue: { label: string; status: 'printing' | 'printed' | 'error' }[] = []

function renderQueue() {
  const q = $('printQueue')
  q.replaceChildren()
  // The header badge reflects real state, not a hardcoded count: in-flight prints,
  // else a nudge to pick a printer, else the settings affordance.
  const printing = printQueue.filter((i) => i.status === 'printing').length
  const badge = document.getElementById('labelSettingsFooter')
  if (badge) badge.textContent = printing > 0 ? `${printing} PRINTING` : selectedPrinter ? 'LABEL SETTINGS' : 'SET PRINTER'
  if (!printQueue.length) { q.appendChild(el('div', 'mono', 'No labels yet')); q.firstElementChild!.setAttribute('style', 'padding:14px 16px;color:var(--ink-4);font-size:11px;'); return }
  for (const item of printQueue.slice(0, 8)) {
    const row = el('div', 'qrow')
    const icon = item.status === 'printed' ? '✓' : item.status === 'error' ? '✗' : '…'
    const color = item.status === 'printed' ? 'var(--gain)' : item.status === 'error' ? 'var(--loss)' : 'var(--flag)'
    const who = el('div', 'bidwho')
    who.appendChild(el('div', 'bidname', item.label))
    who.appendChild(el('div', 'bidsub', item.status))
    row.appendChild(who)
    const st = el('div', 'mono', icon)
    st.style.cssText = `font-size:16px;color:${color};`
    row.appendChild(st)
    q.appendChild(row)
  }
}

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
  } catch {
    entry.status = 'error'
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

// ── label print preview ──────────────────────────────────────────────────────
// Renders the REAL print HTML (labelHtml) for a representative sale, scaled up, so the
// user sees exactly how the thermal label will print as they change the template.
// The sample is editable so you can paste a REAL listing title and see, in one place,
// what the custom regex pulls out of it and how the label physically prints. Persisted,
// because the title you want to test against is usually the one you tested last time.
const DEFAULT_SAMPLE_TITLE = '#141 Bin A - Alo Yoga and More, No Cancels'
const DEFAULT_SAMPLE_BUYER = 'Sarah D.'
let sampleTitle = localStorage.getItem('tt-sample-title') ?? DEFAULT_SAMPLE_TITLE
let sampleBuyer = localStorage.getItem('tt-sample-buyer') ?? DEFAULT_SAMPLE_BUYER

/** Build the preview's LabelData the same way a real sale does: the lot number is parsed
 *  out of the title, and the product name is what remains once the "#NN " prefix is gone. */
function sampleLabelData(): LabelData {
  const title = sampleTitle.trim()
  return {
    itemNumber: parseItemNumber(title),
    buyer: sampleBuyer.trim(),
    // '#' optional so this strips exactly what parseItemNumber consumed — otherwise a
    // title like "141 - Plain" prints the lot number twice
    productName: title.replace(/^\s*#?\s*\d+\s*[-–—]?\s*/, '').trim() || title,
    price: '$82.00',
    title,
    code: labelCode('1732451642461557731'), // a real sku_id shape, so the preview QR is full size
  }
}
function renderLabelPreview() {
  const ifr = document.getElementById('labelPreview') as HTMLIFrameElement | null
  if (!ifr) return
  const size = LABEL_SIZES[labelTemplate.labelSize] ?? LABEL_SIZES['2x1']
  const scale = 2.4
  const wPx = Math.round(size.widthIn * 96), hPx = Math.round(size.heightIn * 96)
  ifr.style.width = wPx + 'px'; ifr.style.height = hPx + 'px'
  ifr.style.transformOrigin = 'top left'; ifr.style.transform = `scale(${scale})`
  const wrap = document.getElementById('labelPreviewWrap')
  if (wrap) { wrap.style.width = Math.round(wPx * scale) + 'px'; wrap.style.height = Math.round(hPx * scale) + 'px' }
  ifr.srcdoc = labelHtml(sampleLabelData(), labelTemplate)
  const sz = document.getElementById('labelPreviewSize'); if (sz) sz.textContent = `${size.widthIn}″ × ${size.heightIn}″`
}

// "Print sample" — sends the preview's sample label to the selected printer (a test print).
function updateSampleBtn() {
  // Two doors to the same test print: beside the preview, and beside the printer it tests.
  for (const id of ['printSample', 'printTest']) {
    const b = document.getElementById(id) as HTMLButtonElement | null
    if (!b) continue
    b.disabled = !selectedPrinter
    b.title = selectedPrinter ? `Print a test label to ${selectedPrinter}` : 'Select a printer first'
  }
}

// ── per-field text size (−/+ multipliers, applied by labelHtml + the preview) ──
const SCALE_FIELDS: LabelField[] = ['itemNumber', 'custom', 'buyer', 'productName', 'price']
const scaleOf = (f: LabelField): number => labelTemplate.scale?.[f] ?? 1
// Show the size that actually prints (pt), not the multiplier: "100%" told you nothing
// about how big the text is, and the same 100% is 40pt for the item number and 6.5pt for
// the product name. The multiplier is still what's stored — it's just in the tooltip now.
function updateScaleLabels() {
  for (const f of SCALE_FIELDS) {
    const lbl = document.getElementById('sz-' + f)
    if (!lbl) continue
    const base = basePt(f, labelTemplate.labelSize)
    lbl.textContent = +(base * scaleOf(f)).toFixed(1) + 'pt'
    lbl.title = `${Math.round(scaleOf(f) * 100)}% of the ${base}pt default for this label size`
  }
}
function applyScale(f: LabelField, delta: number) {
  const next = Math.min(3, Math.max(0.4, +(scaleOf(f) + delta).toFixed(2)))
  labelTemplate.scale = { ...(labelTemplate.scale ?? {}), [f]: next }
  saveTemplate(); updateScaleLabels(); renderLabelPreview()
}

// ── saved regex patterns ────────────────────────────────────────────────────
// There is no database behind any of this — the whole label template lives in this
// window's localStorage (see saveTemplate). That already persisted the ONE active regex
// across restarts, but a seller runs different tag schemes on different shows (NWT/RETURN
// on a returns pallet, Bin A/B on a sorted one) and had to retype the pattern each time.
// Presets are the same storage, just a named list, so switching is one dropdown.
interface RegexPreset { name: string; regex: string; flags: string }
const PRESETS_KEY = 'tt-regex-presets'
const SEED_PRESETS: RegexPreset[] = [
  { name: 'NWT / RETURN', regex: '\\b(NWT|RETURN)S?\\b', flags: 'i' },
  { name: 'Bin A / Bin B', regex: '\\b(Bin\\s+[A-Z])\\b', flags: 'i' },
  { name: 'Lot number', regex: '(#\\d+)', flags: '' },
]
function loadPresets(): RegexPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY)
    if (!raw) return [...SEED_PRESETS] // first run: start with the patterns we know work
    const list = JSON.parse(raw) as RegexPreset[]
    return Array.isArray(list) ? list.filter((p) => p && typeof p.name === 'string' && typeof p.regex === 'string') : [...SEED_PRESETS]
  } catch { return [...SEED_PRESETS] }
}
const savePresets = (list: RegexPreset[]) => localStorage.setItem(PRESETS_KEY, JSON.stringify(list))
let regexPresets: RegexPreset[] = loadPresets()

// ── label settings modal ────────────────────────────────────────────────────
function setupSettings() {
  const inp = (id: string) => document.getElementById(id) as HTMLInputElement
  const sel = (id: string) => document.getElementById(id) as HTMLSelectElement
  sel('setSize').value = labelTemplate.labelSize
  inp('setItemNumber').checked = labelTemplate.itemNumber
  inp('setBuyer').checked = labelTemplate.buyer
  inp('setProductName').checked = labelTemplate.productName
  inp('setPrice').checked = labelTemplate.price
  inp('setQr').checked = !!labelTemplate.qr
  inp('setCustom').checked = labelTemplate.custom.enabled
  inp('setRegex').value = labelTemplate.custom.regex
  inp('setFlags').value = labelTemplate.custom.flags
  // Extraction preview runs the SAME extractCustom the printer path uses, against whatever
  // title is currently in the box — so "(no match)" here means "(no match)" on the label.
  const preview = () => {
    const out = document.getElementById('extractPreview')!
    if (!labelTemplate.custom.regex) { out.textContent = '—'; return }
    try {
      new RegExp(labelTemplate.custom.regex, labelTemplate.custom.flags) // throws on a bad pattern
      const v = extractCustom(sampleTitle, labelTemplate.custom.regex, labelTemplate.custom.flags)
      out.textContent = v || '(no match)'
    } catch { out.textContent = '(invalid regex)' }
  }
  // Which print path this sample would take. Emoji / non-Latin in a buyer name can't be
  // drawn by ZPL's built-in font, so those labels fall back to the ~1s HTML render — worth
  // seeing while you are editing the sample rather than discovering it mid-show.
  const pathHint = () => {
    const hint = document.getElementById('samplePathHint')
    if (!hint) return
    const slow = labelNeedsHtml(sampleLabelData(), labelTemplate)
    hint.textContent = slow ? '⚠ falls back to slow HTML path' : ''
    hint.title = slow ? 'This label has glyphs ZPL cannot draw, so it prints via the slower HTML path.' : ''
  }
  const sampleInputs = () => {
    const t = inp('sampleTitle')
    const b = inp('sampleBuyer')
    t.value = sampleTitle
    b.value = sampleBuyer
    const onEdit = () => {
      sampleTitle = t.value
      sampleBuyer = b.value
      localStorage.setItem('tt-sample-title', sampleTitle)
      localStorage.setItem('tt-sample-buyer', sampleBuyer)
      preview(); renderLabelPreview(); pathHint()
    }
    t.addEventListener('input', onEdit)
    b.addEventListener('input', onEdit)
  }
  sampleInputs()

  // ── AI help for the extraction pattern ──────────────────────────────────────
  // The suggestion is shown, never applied. It is run through the SAME extractCustom the printer
  // uses, against the operator's own sample title, so what is on screen is what would print.
  const regexAI = () => {
    const ask = document.getElementById('rxAsk') as HTMLButtonElement | null
    const want = inp('rxWant')
    const box = document.getElementById('rxResult')
    const state = document.getElementById('rxState')
    if (!ask || !box || !state) return
    let proposed: { regex: string; flags: string } | null = null

    const say = (msg: string, bad = false) => {
      state.textContent = msg
      state.className = 'state ' + (bad ? 'bad-text' : 'muted')
    }
    if (!window.recapAPI?.suggestRegex) {
      ask.disabled = true
      say('Needs a Gemini key — set GEMINI_API_KEY to use this.')
    }
    document.getElementById('rxDismiss')?.addEventListener('click', () => { box.hidden = true; proposed = null })
    document.getElementById('rxUse')?.addEventListener('click', () => {
      if (!proposed) return
      inp('setRegex').value = proposed.regex
      inp('setFlags').value = proposed.flags
      inp('setCustom').checked = true          // a pattern nobody prints is not what they asked for
      box.hidden = true
      proposed = null
      apply()
      say('Pattern applied.')
    })
    ask.addEventListener('click', async () => {
      const title = sampleTitle.trim()
      if (!title) return say('Paste a sample listing title above first.', true)
      if (!want.value.trim()) return say('Describe what should print.', true)
      ask.disabled = true
      say('Asking…')
      try {
        const r = await window.recapAPI!.suggestRegex!({ title, want: want.value.trim() })
        if (r.error || !r.regex) return say(r.error ?? 'No pattern came back.', true)
        // Compile it before it is ever shown as usable — a malformed pattern must not reach the field.
        try { new RegExp(r.regex, r.flags ?? '') } catch (e) {
          return say('The suggested pattern was not valid: ' + (e as Error).message, true)
        }
        const prints = extractCustom(title, r.regex, r.flags ?? '')
        proposed = { regex: r.regex, flags: r.flags ?? '' }
        document.getElementById('rxPattern')!.textContent = r.regex + (r.flags ? '  /' + r.flags : '')
        const printsEl = document.getElementById('rxPrints')!
        printsEl.textContent = prints || 'nothing'
        printsEl.style.color = prints ? 'var(--ink)' : 'var(--loss)'
        document.getElementById('rxExplain')!.textContent = r.explain ?? ''
        box.hidden = false
        // Offering a pattern that extracts nothing from the operator's own title would be offering
        // a label that prints blank, so say so rather than letting the empty result pass as a result.
        say(prints ? '' : 'That pattern finds nothing in your sample title — try describing it differently.', !prints)
      } catch (e) {
        say((e as Error).message, true)
      } finally {
        ask.disabled = false
      }
    })
  }
  regexAI()
  const apply = () => {
    labelTemplate = {
      labelSize: sel('setSize').value as LabelTemplate['labelSize'],
      itemNumber: inp('setItemNumber').checked, buyer: inp('setBuyer').checked,
      productName: inp('setProductName').checked, price: inp('setPrice').checked,
      qr: inp('setQr').checked,
      custom: { enabled: inp('setCustom').checked, regex: inp('setRegex').value, flags: inp('setFlags').value },
      scale: labelTemplate.scale, // carry the per-field sizes over — rebuilding without
      // them reset every field to 1× whenever any checkbox/size/regex changed
    }
    // the item number's 1× default is per label size, so the pt readout can move here too
    saveTemplate(); preview(); renderLabelPreview(); updateScaleLabels(); pathHint()
  }
  for (const id of ['setSize', 'setItemNumber', 'setBuyer', 'setProductName', 'setPrice', 'setQr', 'setCustom', 'setRegex', 'setFlags']) {
    document.getElementById(id)?.addEventListener('input', apply)
    document.getElementById(id)?.addEventListener('change', apply)
  }
  document.querySelectorAll<HTMLButtonElement>('.sizestep button').forEach((b) => {
    b.addEventListener('click', () => applyScale(b.dataset.size as LabelField, Number(b.dataset.d) * 0.1))
  })

  // ── saved patterns ────────────────────────────────────────────────────────
  const presetSel = sel('presetSel')
  const presetName = inp('presetName')
  const presetDelete = document.getElementById('presetDelete') as HTMLButtonElement
  // Mark the dropdown when the box matches a saved pattern, so it reads as "you are on
  // this preset" rather than leaving a stale name selected next to an edited regex.
  const syncPresetSel = () => {
    const regex = inp('setRegex').value
    const hit = regexPresets.find((p) => p.regex === regex && p.flags === inp('setFlags').value)
    presetSel.value = hit ? hit.name : ''
    presetDelete.disabled = !hit
    // The first option doubles as the "nothing chosen" line, so it has to say WHY nothing is
    // chosen: a hand-written pattern is in use, or there is simply no choice made yet.
    const first = presetSel.options[0]
    const custom = !hit && regex.trim() !== ''
    if (first) first.textContent = custom ? 'A custom pattern (see Advanced)' : regexPresets.length ? 'Choose what to print…' : 'No saved patterns — add one under Advanced'
    // A custom pattern lives under Advanced; open it so the thing in use is never hidden.
    const adv = document.getElementById('advPattern') as HTMLDetailsElement | null
    if (adv && custom) adv.open = true
  }
  const renderPresets = () => {
    presetSel.replaceChildren()
    const none = document.createElement('option')
    none.value = ''
    none.textContent = 'Choose what to print…' // refined by syncPresetSel below
    presetSel.appendChild(none)
    for (const p of regexPresets) {
      const o = document.createElement('option')
      o.value = p.name
      o.textContent = p.name
      o.title = `/${p.regex}/${p.flags}`
      presetSel.appendChild(o)
    }
    syncPresetSel()
  }
  presetSel.addEventListener('change', () => {
    const p = regexPresets.find((x) => x.name === presetSel.value)
    if (!p) { presetDelete.disabled = true; return }
    inp('setRegex').value = p.regex
    inp('setFlags').value = p.flags
    inp('setCustom').checked = true // picking a pattern implies you want it printed
    presetName.value = p.name
    apply()
    presetDelete.disabled = false
  })
  document.getElementById('presetSave')?.addEventListener('click', () => {
    const regex = inp('setRegex').value.trim()
    if (!regex) return
    // Default the name to the pattern itself rather than refusing — Electron has no
    // window.prompt, and a nameless save that silently does nothing is worse.
    const name = (presetName.value.trim() || regex).slice(0, 40)
    const flags = inp('setFlags').value.trim()
    const at = regexPresets.findIndex((p) => p.name.toLowerCase() === name.toLowerCase())
    if (at >= 0) regexPresets[at] = { name, regex, flags } // same name overwrites, no duplicates
    else regexPresets.push({ name, regex, flags })
    savePresets(regexPresets)
    renderPresets()
    presetSel.value = name
    presetDelete.disabled = false
  })
  presetDelete.addEventListener('click', () => {
    const name = presetSel.value
    if (!name) return
    regexPresets = regexPresets.filter((p) => p.name !== name)
    savePresets(regexPresets)
    presetName.value = ''
    renderPresets()
  })
  for (const id of ['setRegex', 'setFlags']) document.getElementById(id)?.addEventListener('input', syncPresetSel)
  renderPresets()
  document.getElementById('printSample')?.addEventListener('click', () => void printLabel(sampleLabelData()))
  document.getElementById('printTest')?.addEventListener('click', () => void printLabel(sampleLabelData()))
  updateScaleLabels()
  updateSampleBtn()
  preview()
  renderLabelPreview()
  pathHint()
  const open = () => showScreen('settings')
  document.getElementById('labelSettings')?.addEventListener('click', open)
  document.getElementById('labelSettingsFooter')?.addEventListener('click', open)
}
setupSettings()
setupFeed()
renderStats()
$('feedCount').textContent = 'v' + __APP_VERSION__
{ const v = document.getElementById('aboutVersion'); if (v) v.textContent = __APP_VERSION__ }

// -- screens: live monitor + label settings ----------------------------------
// productTx survives the ledger removal: the products panel shows per-product AI
// transcripts captured this session (in-memory only - nothing persists anymore).
const productTx: Record<string, LedgerTranscript> = {}

function showScreen(s: 'monitor' | 'settings' | 'identify') {
  $('monitorScreen').style.display = s === 'monitor' ? 'flex' : 'none'
  const settings = document.getElementById('settingsScreen')
  if (settings) settings.style.display = s === 'settings' ? 'flex' : 'none'
  const identify = document.getElementById('identifyScreen')
  if (identify) identify.style.display = s === 'identify' ? 'flex' : 'none'
  if (s === 'identify') renderIdentifications()
  $('navMonitor').classList.toggle('active', s === 'monitor')
  document.getElementById('navIdentify')?.classList.toggle('active', s === 'identify')
  document.getElementById('navSettings2')?.classList.toggle('active', s === 'settings')
  // live status (connecting...) + room/viewers/elapsed only make sense on the Live Monitor
  const meters = document.getElementById('liveMeters')
  if (meters) meters.style.display = s === 'monitor' ? 'flex' : 'none'
  const livePill = document.getElementById('livePill')
  if (livePill) livePill.style.display = s === 'monitor' ? 'flex' : 'none'
}
$('navMonitor').addEventListener('click', () => showScreen('monitor'))
document.getElementById('navIdentify')?.addEventListener('click', () => showScreen('identify'))
document.getElementById('navSettings2')?.addEventListener('click', () => showScreen('settings'))
// The review count in the Identification head is the route to the flagged lots.
document.getElementById('idReviewChip')?.addEventListener('click', () => { idFilter = 'review'; syncIdFilterButtons(); showScreen('identify') })
document.getElementById('idSearch')?.addEventListener('input', () => renderIdentifications())
function syncIdFilterButtons() {
  for (const b of document.querySelectorAll<HTMLElement>('[data-idfilter]')) {
    b.classList.toggle('on', b.dataset.idfilter === idFilter)
  }
}
for (const b of document.querySelectorAll<HTMLElement>('[data-idfilter]')) {
  b.addEventListener('click', () => {
    idFilter = (b.dataset.idfilter as 'all' | 'review' | 'edited') ?? 'all'
    syncIdFilterButtons()
    renderIdentifications()
  })
}
syncIdFilterButtons()
renderCaptureState()
setInterval(renderCaptureState, 1000)
// Deep link, so a screen can be opened (and screenshotted) without a click. Accepts the query
// form too, because a fragment does not always survive a headless capture.
{
  const want = location.hash.replace('#', '') || new URLSearchParams(location.search).get('screen')
  if (want === 'identify' || want === 'settings') showScreen(want)
}
document.getElementById('diagBtn')?.addEventListener('click', () => void window.diagAPI?.open())

// ── SellerFolio sync card ────────────────────────────────────────────────────
interface SfSyncView { baseUrl: string; hasToken: boolean; lastFour: string; canStore: boolean; device: string; state: string; detail: string }
const SF_SYNC_LABEL: Record<string, [string, string]> = {
  off: ['Off — shows are saved on this computer only', 'muted'],
  synced: ['Connected — shows are uploading to SellerFolio', 'ok-text'],
  offline: ['Can’t reach SellerFolio — saving here, will upload when it is back', 'warn-text'],
  auth: ['SellerFolio rejected this token — paste a new one', 'bad-text'],
  rejected: ['SellerFolio refused an upload — saving here and retrying', 'warn-text'],
  error: ['Upload error — saving here and retrying', 'warn-text'],
}
function renderSfSync(v: SfSyncView) {
  const url = document.getElementById('sfUrl') as HTMLInputElement | null
  const tok = document.getElementById('sfToken') as HTMLInputElement | null
  const st = document.getElementById('sfState')
  if (!url || !tok || !st) return
  if (document.activeElement !== url) url.value = v.baseUrl
  tok.placeholder = v.hasToken ? `saved · ends in ${v.lastFour}` : 'paste a capture token (sfc_…)'
  const [text, cls] = SF_SYNC_LABEL[v.state] ?? [v.state, 'muted']
  st.className = cls
  st.textContent = v.hasToken || v.state !== 'off' ? text : 'Off — add a token to upload shows to SellerFolio'
  if (!v.canStore) st.textContent += ' · this computer cannot store the token securely, so it must be re-entered each launch'
  st.className = 'state ' + cls
  const off = document.getElementById('sfOff')
  if (off) off.style.display = v.hasToken ? '' : 'none'
  const dev = document.getElementById('aboutDevice')
  if (dev) dev.textContent = v.device || '—'
}
function setupSfSync() {
  const api = window.sfSyncAPI
  const save = document.getElementById('sfSave') as HTMLButtonElement | null
  if (!api || !save) return
  void api.get().then(renderSfSync)
  api.onState(renderSfSync)
  save.addEventListener('click', () => {
    const url = (document.getElementById('sfUrl') as HTMLInputElement).value
    const tokEl = document.getElementById('sfToken') as HTMLInputElement
    // An empty token box means "keep what is saved", so the address can be changed alone.
    const args = tokEl.value.trim() ? { baseUrl: url, token: tokEl.value } : { baseUrl: url }
    void api.save(args).then((r) => {
      tokEl.value = ''
      renderSfSync(r)
      void refreshIdentifyState() // a token saved here is what turns identification on
      if (!r.ok && r.error) { const st = document.getElementById('sfState'); if (st) { st.className = 'bad-text'; st.textContent = r.error } }
    })
  })
  document.getElementById('sfFolder')?.addEventListener('click', () => void api.openFolder())
  document.getElementById('sfOff')?.addEventListener('click', () => {
    void api.save({ token: '' }).then((r) => { renderSfSync(r); void refreshIdentifyState() })
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
      if (watchedRoomId !== null && ev.roomId !== watchedRoomId) { resetClipBuffer(); endIdentifyShow('the show ended') } // new show: never inherit the last one's audio or queue
      watchedRoomId = ev.roomId
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
      // Auction starts and ends, kept to window each sale. Server clock -> this machine's clock.
      for (const r of boundaryJournal.ingest(ev)) {
        if (r.type === 'auction_start' && r.startedAtMs) noteBoundary({ type: 'auction_start', atEpochSec: serverToLocalSec(r.startedAtMs, serverTimeOffsetMs) })
        else if (r.type === 'auction_end') noteBoundary({ type: 'auction_end', atEpochSec: serverToLocalSec(r.seenAtMs, serverTimeOffsetMs) })
      }
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
      // EVERY fresh sale is identified, not just the first of a batch: two sales in one second must both get an outcome.
      for (const s of freshSales) noteBoundary({ type: 'sale', atEpochSec: serverToLocalSec(s.createdAt, serverTimeOffsetMs), orderId: s.orderId })
      // A sale that arrives late is recorded (reason too_old), not filtered out: late order rows are normal.
      const { toIdentify, tooOld } = splitSalesByAge(freshSales, Date.now(), serverTimeOffsetMs)

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
      for (const s of tooOld) recordTooOldSale(s)
      for (const s of toIdentify) identifySale(s) // identification — after print + render
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
      break
    case 'watchdog':
      renderWatchdog(ev.alerts)
      break
  }
})
