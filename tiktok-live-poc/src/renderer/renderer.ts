import flvjs from 'flv.js'
import type { LiveEvent, Sale, BuyerAgg, RosterProduct, ProductRollup, PinnedAuction, ChatMessage } from '../core/types'
import { labelHtml, LABEL_SIZES } from '../electron/label' // portable (no electron deps) — renders the real print HTML for the preview

// Structured AI-transcript fields (was core/ledger's LedgerTranscript; the products
// panel still stores per-product transcripts in memory for the session).
interface LedgerTranscript { brand?: string; item?: string; color?: string; size?: string; retailPrice?: string; summary?: string }

interface LabelData { itemNumber: string; buyer?: string; productName?: string; price?: string; title?: string }
type LabelField = 'itemNumber' | 'custom' | 'buyer' | 'productName' | 'price'
interface LabelTemplate {
  labelSize: '1x1' | '1.5x1.5' | '2x1' | '2x2' | '2.25x1.25'
  itemNumber: boolean
  buyer: boolean
  productName: boolean
  price: boolean
  custom: { enabled: boolean; regex: string; flags: string }
  scale?: Partial<Record<LabelField, number>>
}
declare global {
  interface Window {
    ttLive: { onEvent: (cb: (ev: LiveEvent) => void) => void }
    labelAPI: {
      getPrinters: () => Promise<{ printers: { name: string; displayName: string; isDefault: boolean }[]; saved: string }>
      savePrinter: (name: string) => Promise<boolean>
      print: (labelData: LabelData, printerName: string, template: LabelTemplate) => Promise<{ success: boolean; error?: string }>
    }
    updateAPI?: {
      onReady: (cb: (info: { version: string }) => void) => void
    }
    recapAPI?: {
      enabled: () => Promise<{ enabled: boolean; model: string }>
      transcribe: (payload: { audio: Uint8Array; productName?: string; structured?: boolean }) => Promise<{ text?: string; fields?: LedgerTranscript; error?: string }>
    }
    syncAPI?: {
      connection: () => Promise<{ loggedIn: boolean; hasShow: boolean; polling: boolean }>
      openMonitor: () => Promise<{ ok: boolean }>
    }
    chatAPI?: {
      send: (text: string) => Promise<{ ok: boolean; error?: string }>
      onSent: (cb: (r: { ok: boolean; error?: string }) => void) => void
    }
  }
}

const $ = (id: string) => document.getElementById(id)!
const txt = (s: string) => document.createTextNode(s)
function el(tag: string, className?: string, text?: string): HTMLElement {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}
function avatar(url: string | undefined, cls = 'bidav'): HTMLElement {
  const img = document.createElement('img')
  img.className = cls
  img.referrerPolicy = 'no-referrer'
  if (url) img.src = url
  img.addEventListener('error', () => { img.style.visibility = 'hidden' })
  return img
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
}
let labelTemplate: LabelTemplate = (() => {
  try { return { ...DEFAULT_TEMPLATE, ...JSON.parse(localStorage.getItem('tt-label-template') || '{}') } } catch { return DEFAULT_TEMPLATE }
})()
const saveTemplate = () => localStorage.setItem('tt-label-template', JSON.stringify(labelTemplate))

// ── state ───────────────────────────────────────────────────────────────────
let sessionStart: number | undefined // current_session.start_time (scheduled)
let liveStartedAt: number | undefined // room create_timestamp (actual go-live) — drives the elapsed timer
let pinnedEndMs: number | undefined
let lotSoldAt = 0 // last auction-closed paint — tickCountdown holds SOLD for 10s
let serverTimeOffsetMs = 0 // from pin/get (resp_server_time − client clock); corrects the auction countdown
let gmvFromWs = false
let seedMaxCreatedAt: number | null = null
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
let currentTopSet = new Set<string>()
let feedPage = 0
let feedSize = Number(localStorage.getItem('tt-feed-size')) || 25

function updateFeedNav(totalPages: number) {
  $('feedPage').textContent = `${allSales.length ? feedPage + 1 : 0}/${totalPages}`
  ;($('feedPrev') as HTMLButtonElement).disabled = feedPage <= 0
  ;($('feedNext') as HTMLButtonElement).disabled = feedPage >= totalPages - 1
}

function renderFeed() {
  const feed = $('bidFeed')
  feed.replaceChildren()
  if (!allSales.length) { feed.appendChild(el('div', 'mono', 'Waiting for sales…')); updateFeedNav(1); return }
  const totalPages = Math.max(1, Math.ceil(allSales.length / feedSize))
  feedPage = Math.max(0, Math.min(feedPage, totalPages - 1))
  const start = feedPage * feedSize
  const page = allSales.slice(start, start + feedSize)
  const topSet = currentTopSet
  page.forEach((s, idx) => {
    const i = start + idx
    const failed = s.paymentStatus === 'failed'
    const row = el('div', 'bidrow' + (i === 0 ? ' fresh' : '') + (failed ? ' failed' : ''))
    row.appendChild(avatar(s.buyer.avatarUrl))
    const who = el('div', 'bidwho')
    who.appendChild(el('div', 'bidname', s.buyer.username || s.buyer.handle || '—'))
    const sub = el('div', 'bidsub')
    if (topSet.has(s.buyer.ttuid || s.buyer.username)) sub.appendChild(el('span', 'tag whale', 'WHALE'))
    if (failed) sub.appendChild(el('span', 'tag failed', 'FAILED'))
    else if (s.paymentStatus === 'pending') sub.appendChild(el('span', 'tag pending', 'PENDING'))
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
  updateFeedNav(totalPages)
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
const NAME_COLORS = ['#7da8ff', '#8a78ff', '#36d9a4', '#ffb23e', '#9b6cf6', '#5fe3bb']
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
  nm.style.color = '#8a5cf6'
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
    empty.style.cssText = 'font-size:11px;color:#5c6473;'
    list.appendChild(empty)
    return
  }
  buyers.slice(0, TOP_BUYERS_SHOWN).forEach((b, i) => {
    const rank = i + 1
    const lead = rank === 1
    const row = el('div')
    row.style.cssText = 'display:flex;align-items:center;gap:9px;'
    const rk = el('div', 'mono', String(rank))
    rk.style.cssText = `width:15px;text-align:center;font-size:11px;font-weight:${lead ? '700' : '400'};color:${lead ? '#9b6cf6' : '#5c6473'};`
    const name = el('div', '', '@' + (b.handle ?? (b.username || '—')))
    name.style.cssText = `flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:${lead ? '600' : '400'};color:${lead ? '#fff' : '#c4ccd9'};`
    const spend = el('div', 'mono', `$${(b.totalCents / 100).toFixed(0)}`)
    spend.style.cssText = 'font-size:12.5px;font-weight:600;color:#9b6cf6;'
    const items = el('div', 'mono', `·${b.itemCount}`)
    items.style.cssText = 'width:26px;text-align:right;font-size:11px;color:#5c6473;'
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

// ── current auction ─────────────────────────────────────────────────────────
function renderAuction(p?: PinnedAuction) {
  if (!p || !p.winUsername) {
    pinnedEndMs = undefined
    // keep the overlay visible (it's always over the video); show placeholders until a lot is live
    $('lotName').textContent = 'Waiting for current lot'
    $('lotBuyer').textContent = '—'
    $('lotBid').textContent = '—'
    $('lotBids').textContent = '0'
    document.getElementById('auctionPanelName')!.textContent = 'Waiting for current lot'
    document.getElementById('auctionPanelBid')!.textContent = '--'
    document.getElementById('auctionPanelBids')!.textContent = '0'
    document.getElementById('auctionPanelEnds')!.textContent = '--'
    return
  }
  pinnedEndMs = p.expectedEndMs
  $('lotOverlay').style.display = 'flex'
  $('lotName').textContent = p.productName
  $('lotBid').textContent = p.maxBiddingPrice ?? '—'
  $('lotBids').textContent = String(p.numBids ?? 0)
  $('lotBuyer').textContent = '@' + p.winUsername
  document.getElementById('auctionPanelName')!.textContent = p.productName
  document.getElementById('auctionPanelBid')!.textContent = p.maxBiddingPrice ?? '--'
  document.getElementById('auctionPanelBids')!.textContent = String(p.numBids ?? 0)
}

function tickCountdown() {
  const ends = document.getElementById('lotEnds')
  if (!ends) return
  const panelEnds = document.getElementById('auctionPanelEnds')
  // A close was just painted by onAuctionClosed — hold SOLD against this 250ms tick
  // (and the slower roster/pin repaints) until the next lot's state has had time to land.
  if (Date.now() - lotSoldAt < 10000) {
    ends.textContent = 'SOLD'
    if (panelEnds) panelEnds.textContent = 'SOLD'
    return
  }
  if (!pinnedEndMs) { ends.textContent = '--'; if (panelEnds) panelEnds.textContent = '--'; return }
  // expectedEndMs is in server time; correct the client clock by the pin/get offset.
  const left = Math.max(0, Math.round((pinnedEndMs - (Date.now() + serverTimeOffsetMs)) / 1000))
  const label = left > 0 ? `${left}s` : 'ended'
  ends.textContent = label
  if (panelEnds) panelEnds.textContent = label
}
setInterval(tickCountdown, 250)

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

// ── auction audio → AI transcript (mirrors sellerfolio-live enrichment) ──────
let astream: MediaStream | null = null
let rec: MediaRecorder | null = null
let recChunks: Blob[] = []
let onStopResolve: ((b: Blob) => void) | null = null
let recapEnabled = false
let transcribing = false
interface Recap { head: string; status: 'transcribing' | 'done' | 'error'; text: string }
const recaps: Recap[] = []

function cycleRecorder() {
  if (!astream) return
  recChunks = []
  try { rec = new MediaRecorder(astream, { mimeType: 'audio/webm' }) } catch { rec = new MediaRecorder(astream) }
  rec.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data) }
  rec.onstop = () => {
    const blob = new Blob(recChunks, { type: 'audio/webm' })
    const r = onStopResolve
    onStopResolve = null
    cycleRecorder()
    if (r) r(blob)
  }
  rec.start(1000)
}
function startAudioCapture(): void {
  if (astream) return
  const video = document.getElementById('live') as (HTMLVideoElement & { captureStream?: () => MediaStream }) | null
  let stream: MediaStream | undefined
  try { stream = video?.captureStream?.() } catch { /* ignore */ }
  const tracks = stream?.getAudioTracks() ?? []
  if (!tracks.length) return
  astream = new MediaStream(tracks)
  cycleRecorder()
  setInterval(() => { if (rec?.state === 'recording' && !onStopResolve) rec.stop() }, 30000) // rolling ≤30s segments
}
function grabClip(): Promise<Blob | null> {
  if (!rec || rec.state !== 'recording') return Promise.resolve(null)
  return new Promise((resolve) => { onStopResolve = resolve; rec!.stop() })
}

function renderRecap() {
  const list = document.getElementById('recapList')
  if (!list) return
  list.replaceChildren()
  if (!recaps.length) {
    const e = el('div', 'mono', recapEnabled ? 'transcripts appear as items sell…' : 'set GEMINI_API_KEY to enable')
    e.style.cssText = 'padding:14px;color:#3a4150;font-size:11px;'
    list.appendChild(e)
    return
  }
  for (const r of recaps.slice(0, 6)) {
    const row = el('div', 'recap-entry')
    row.appendChild(el('div', 'recap-head', r.head))
    row.appendChild(el('div', 'recap-text ' + r.status, r.status === 'transcribing' ? 'transcribing…' : r.status === 'error' ? '⚠ ' + r.text : r.text))
    list.appendChild(row)
  }
}
async function transcribeSale(s: Sale) {
  // Acquire the capture lock BEFORE the first await. grabClip() is slow, so checking
  // the flag here but only setting it after that await let a burst of sales (e.g. the
  // connect-time backfill firing several 'sales' events in one tick) all pass the guard
  // and fire concurrent Gemini calls. Set-before-await serializes them; the extras drop.
  if (!recapEnabled || transcribing || !window.recapAPI) return
  transcribing = true
  let entry: Recap | undefined
  try {
    const clip = await grabClip()
    if (!clip || clip.size < 2000) return
    entry = { head: `${s.skuDesc ?? ''} · ${s.productName.slice(0, 28)} — @${s.buyer.handle ?? s.buyer.username}`, status: 'transcribing', text: '' }
    recaps.unshift(entry)
    if (recaps.length > 30) recaps.pop()
    renderRecap()
    const audio = new Uint8Array(await clip.arrayBuffer())
    const res = await window.recapAPI.transcribe({ audio, productName: s.productName })
    entry.status = res.text ? 'done' : 'error'
    entry.text = res.text ?? res.error ?? 'failed'
  } catch (e) {
    if (entry) { entry.status = 'error'; entry.text = (e as Error).message }
  } finally {
    transcribing = false
    renderRecap()
  }
}
// structured per-product (per-bin) transcription — one capture covers every order of that product
const productTxBusy = new Set<string>()
async function transcribeProduct(productId: string, productName: string): Promise<boolean> {
  // `transcribing` is the shared audio-capture lock (also used by transcribeSale) — only one clip grab at a time
  if (!recapEnabled || !window.recapAPI || transcribing || productTxBusy.has(productId)) return false
  transcribing = true
  productTxBusy.add(productId)
  renderProductsTable()
  try {
    const clip = await grabClip()
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

async function initRecap() {
  try { recapEnabled = (await window.recapAPI?.enabled())?.enabled ?? false } catch { recapEnabled = false }
  const st = document.getElementById('recapStatus')
  if (st) st.textContent = recapEnabled ? 'AI EXTRACTION · 99%' : 'AI EXTRACTION'
  renderRecap()
}
void initRecap()

// ── label printing ──────────────────────────────────────────────────────────
let selectedPrinter = ''
let autoPrint = false
// Which signal drives auto-print:
//   'pin'   = pin/get status 1→3 (DEFAULT). Structured server field, measured 6.0-7.3s
//             ahead of auction_result/get, polled at 700ms.
//   'order' = auction_result/get newSales — authoritative but 6-7s late; kept as fallback.
//   'feed'  = the on-screen "won" feed (DOM scrape). Caught nothing in a TT_LAT run —
//             the selector has drifted; retained only for A/B while pin is proven.
let printSource: 'pin' | 'order' | 'feed' = 'pin'
// Auction/item numbers already auto-printed. SHARED across both sources so flipping
// the switch mid-show (or an observer re-fire) never prints the same win twice.
const printedKeys = new Set<string>()
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
  if (!printQueue.length) { q.appendChild(el('div', 'mono', 'No labels yet')); q.firstElementChild!.setAttribute('style', 'padding:14px;color:#3a4150;font-size:11px;'); return }
  for (const item of printQueue.slice(0, 8)) {
    const row = el('div', 'qrow')
    const icon = item.status === 'printed' ? '✓' : item.status === 'error' ? '✗' : '…'
    const color = item.status === 'printed' ? '#5fe3bb' : item.status === 'error' ? '#ff5c5c' : '#ffc56b'
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

async function printLabel(data: LabelData) {
  if (!selectedPrinter) return
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
  printLabel({ itemNumber: num, buyer: s.buyer.username || s.buyer.handle, productName: s.productName, price: s.price.formatted, title })
}

// Order-data (slow) path: auto-print a genuinely-new sale, de-duped by item number.
function autoPrintSale(s: Sale) {
  if (!autoPrint || !selectedPrinter) return
  const key = (s.skuDesc ?? '').replace(/^#/, '') || s.orderId
  if (printedKeys.has(key)) return
  printedKeys.add(key)
  printSale(s)
}

// Live-feed (fast) path: a winner painted on-screen the instant an auction closes.
// Always counts the win (verification), but only prints when Live-feed mode is on.
function onWonFeed(ev: Extract<LiveEvent, { kind: 'won-feed' }>) {
  feedWinsSeen++
  updateFeedWinsSeen()
  if (printSource !== 'feed' || !autoPrint || !selectedPrinter) return
  const key = ev.auctionNo
  if (printedKeys.has(key)) return
  printedKeys.add(key)
  void printLabel({ itemNumber: ev.auctionNo, buyer: ev.name, price: ev.price, title: `#${ev.auctionNo}` })
}

// Fast-close path: an auction closed, reported by pin/get (status 1→3, pinned lots
// only) or by the im stream (auction.end for EVERY lot; im-result ~6s later with the
// lot number). De-dup is shared with the other sources via printedKeys, so the slow
// path re-reporting the same sale later never double-prints.
function onAuctionClosed(ev: Extract<LiveEvent, { kind: 'auction-closed' }>) {
  const lot = (ev.lotNumber ?? '').replace(/^#/, '')
  // Instant UI: paint the close on the lot overlay even when the lot number isn't
  // known yet (unpinned lots) — the sale is real, only its attribution is pending.
  $('lotBuyer').textContent = '@' + ev.winner
  if (ev.price) $('lotBid').textContent = ev.price
  if (ev.productName) $('lotName').textContent = ev.productName
  lotSoldAt = Date.now() // tickCountdown paints SOLD and holds it against repaints
  lastPinRenderAt = Date.now() // hold this against the slower roster paint (PIN_FRESH_MS)
  if (lot) lastPrintedNumber = Number(lot) || lastPrintedNumber
  if (printSource !== 'pin' || !autoPrint || !selectedPrinter) return
  // No lot number yet (unattributed im auction.end): don't print a numberless label —
  // the im-result event carries the lot ~6s later and prints it then.
  if (!lot) return
  const key = lot
  if (printedKeys.has(key)) return
  printedKeys.add(key)
  void printLabel({ itemNumber: lot, buyer: ev.winner, price: ev.price, title: `#${lot}` })
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

async function setupPrinting() {
  const { printers, saved } = await window.labelAPI.getPrinters()
  const sel = $('printerSel') as HTMLSelectElement
  for (const p of printers) {
    const opt = document.createElement('option')
    opt.value = p.name
    opt.textContent = p.displayName + (p.isDefault ? ' (default)' : '')
    sel.appendChild(opt)
  }
  selectedPrinter = saved || printers.find((p) => p.isDefault)?.name || ''
  sel.value = selectedPrinter
  const printerHint = () => { const h = document.getElementById('printerSaved'); if (h) h.textContent = selectedPrinter ? '· current: ' + selectedPrinter : '· none selected yet' }
  printerHint()
  updateSampleBtn()
  autoPrint = localStorage.getItem('tt-autoprint') === '1'
  ;($('autoPrint') as HTMLInputElement).checked = autoPrint
  // 'pin' is the fast live-signal mode (im auction.end / pin close) and the default.
  // A stored 'feed' is the retired DOM-observer option — migrate it to 'pin', which
  // superseded it. Only an explicit 'order' opts into the slow authoritative path.
  printSource = localStorage.getItem('tt-print-source') === 'order' ? 'order' : 'pin'
  document.querySelectorAll<HTMLInputElement>('input[name="printSource"]').forEach((r) => {
    r.checked = r.value === printSource
    r.addEventListener('change', () => {
      if (!r.checked) return
      printSource = r.value === 'order' ? 'order' : 'pin'
      localStorage.setItem('tt-print-source', printSource)
    })
  })
  updateFeedWinsSeen()
  updatePrintNext()
  renderQueue()
  sel.addEventListener('change', () => { selectedPrinter = sel.value; void window.labelAPI.savePrinter(selectedPrinter); updatePrintNext(); renderQueue(); printerHint(); updateSampleBtn() })
  ;($('autoPrint') as HTMLInputElement).addEventListener('change', (e) => { autoPrint = (e.target as HTMLInputElement).checked; localStorage.setItem('tt-autoprint', autoPrint ? '1' : '0') })
  $('printNext').addEventListener('click', () => { if (lastPrintedNumber !== null) void printLabel({ itemNumber: String(lastPrintedNumber + 1) }) })
  $('printCustom').addEventListener('click', () => { const v = ($('customNum') as HTMLInputElement).value.replace(/^#/, '').trim(); if (v) void printLabel({ itemNumber: v }) })
  $('printRange').addEventListener('click', async () => {
    const from = parseInt(($('rangeFrom') as HTMLInputElement).value, 10)
    const to = parseInt(($('rangeTo') as HTMLInputElement).value, 10)
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to - from > 500) return
    for (let n = from; n <= to; n++) await printLabel({ itemNumber: String(n) })
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
})

// ── label print preview ──────────────────────────────────────────────────────
// Renders the REAL print HTML (labelHtml) for a representative sale, scaled up, so the
// user sees exactly how the thermal label will print as they change the template.
const sampleLabel: LabelData = { itemNumber: '141', buyer: 'Sarah D.', productName: 'Alo Yoga & More — No Cancels', price: '$82.00', title: '#141 Bin A - Alo Yoga and More, No Cancels' }
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
  ifr.srcdoc = labelHtml(sampleLabel, labelTemplate)
  const sz = document.getElementById('labelPreviewSize'); if (sz) sz.textContent = `${size.widthIn}″ × ${size.heightIn}″`
}

// "Print sample" — sends the preview's sample label to the selected printer (a test print).
function updateSampleBtn() {
  const b = document.getElementById('printSample') as HTMLButtonElement | null
  if (!b) return
  b.disabled = !selectedPrinter
  b.title = selectedPrinter ? `Print a test label to ${selectedPrinter}` : 'Select a printer first'
}

// ── per-field text size (−/+ multipliers, applied by labelHtml + the preview) ──
const SCALE_FIELDS: LabelField[] = ['itemNumber', 'custom', 'buyer', 'productName', 'price']
const scaleOf = (f: LabelField): number => labelTemplate.scale?.[f] ?? 1
function updateScaleLabels() {
  for (const f of SCALE_FIELDS) {
    const lbl = document.getElementById('sz-' + f)
    if (lbl) lbl.textContent = Math.round(scaleOf(f) * 100) + '%'
  }
}
function applyScale(f: LabelField, delta: number) {
  const next = Math.min(3, Math.max(0.4, +(scaleOf(f) + delta).toFixed(2)))
  labelTemplate.scale = { ...(labelTemplate.scale ?? {}), [f]: next }
  saveTemplate(); updateScaleLabels(); renderLabelPreview()
}

// ── label settings modal ────────────────────────────────────────────────────
function setupSettings() {
  const inp = (id: string) => document.getElementById(id) as HTMLInputElement
  const sel = (id: string) => document.getElementById(id) as HTMLSelectElement
  const sample = '#141 Bin A - Alo Yoga and More, No Cancels'
  const sampleEl = document.getElementById('sampleTitle')
  if (sampleEl) sampleEl.textContent = `"${sample}"`
  sel('setSize').value = labelTemplate.labelSize
  inp('setItemNumber').checked = labelTemplate.itemNumber
  inp('setBuyer').checked = labelTemplate.buyer
  inp('setProductName').checked = labelTemplate.productName
  inp('setPrice').checked = labelTemplate.price
  inp('setCustom').checked = labelTemplate.custom.enabled
  inp('setRegex').value = labelTemplate.custom.regex
  inp('setFlags').value = labelTemplate.custom.flags
  const preview = () => {
    const out = document.getElementById('extractPreview')!
    if (!labelTemplate.custom.regex) { out.textContent = '—'; return }
    try {
      const m = sample.match(new RegExp(labelTemplate.custom.regex, labelTemplate.custom.flags))
      out.textContent = m ? (m[1] ?? m[0]) || '(empty)' : '(no match)'
    } catch { out.textContent = '(invalid regex)' }
  }
  const apply = () => {
    labelTemplate = {
      labelSize: sel('setSize').value as LabelTemplate['labelSize'],
      itemNumber: inp('setItemNumber').checked, buyer: inp('setBuyer').checked,
      productName: inp('setProductName').checked, price: inp('setPrice').checked,
      custom: { enabled: inp('setCustom').checked, regex: inp('setRegex').value, flags: inp('setFlags').value },
    }
    saveTemplate(); preview(); renderLabelPreview()
  }
  for (const id of ['setSize', 'setItemNumber', 'setBuyer', 'setProductName', 'setPrice', 'setCustom', 'setRegex', 'setFlags']) {
    document.getElementById(id)?.addEventListener('input', apply)
    document.getElementById(id)?.addEventListener('change', apply)
  }
  document.querySelectorAll<HTMLButtonElement>('.sizestep button').forEach((b) => {
    b.addEventListener('click', () => applyScale(b.dataset.size as LabelField, Number(b.dataset.d) * 0.1))
  })
  document.getElementById('printSample')?.addEventListener('click', () => void printLabel(sampleLabel))
  updateScaleLabels()
  updateSampleBtn()
  preview()
  renderLabelPreview()
  const open = () => showScreen('settings')
  document.getElementById('labelSettings')?.addEventListener('click', open)
  document.getElementById('labelSettingsFooter')?.addEventListener('click', open)
}
setupSettings()
setupFeed()
renderStats()

// -- screens: live monitor + label settings ----------------------------------
// productTx survives the ledger removal: the products panel shows per-product AI
// transcripts captured this session (in-memory only - nothing persists anymore).
const productTx: Record<string, LedgerTranscript> = {}

function showScreen(s: 'monitor' | 'settings') {
  $('monitorScreen').style.display = s === 'monitor' ? 'flex' : 'none'
  const settings = document.getElementById('settingsScreen')
  if (settings) settings.style.display = s === 'settings' ? 'flex' : 'none'
  $('navMonitor').classList.toggle('active', s === 'monitor')
  document.getElementById('navSettings2')?.classList.toggle('active', s === 'settings')
  // live status (connecting...) + room/viewers/elapsed only make sense on the Live Monitor
  const meters = document.getElementById('liveMeters')
  if (meters) meters.style.display = s === 'monitor' ? 'flex' : 'none'
  const livePill = document.getElementById('livePill')
  if (livePill) livePill.style.display = s === 'monitor' ? 'flex' : 'none'
}
$('navMonitor').addEventListener('click', () => showScreen('monitor'))
document.getElementById('navSettings2')?.addEventListener('click', () => showScreen('settings'))

// ── event loop ──────────────────────────────────────────────────────────────
window.ttLive.onEvent((ev: LiveEvent) => {
  switch (ev.kind) {
    case 'status': {
      const label = `${ev.status}${ev.detail ? ' — ' + ev.detail : ''}`
      $('status').textContent = ev.status === 'connected' ? 'LIVE' : ev.status
      $('dot').title = label
      $('dot').style.background = ev.status === 'connected' ? '#36d9a4' : '#5c6473'
      $('dot').style.boxShadow = ev.status === 'connected' ? '0 0 8px #36d9a4' : 'none'
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
      if (ev.viewers !== undefined) { $('viewers').textContent = String(ev.viewers); $('chatViewers').textContent = String(ev.viewers) }
      if (ev.gmv) { stats.gmv = ev.gmv.formatted; gmvFromWs = true }
      if (ev.sales !== undefined) stats.sales = String(ev.sales)
      if (ev.gmvPerHour) stats.pace = ev.gmvPerHour.formatted
      if (ev.gpm) stats.gpm = ev.gpm.formatted
      renderStats()
      break
    case 'product_stats':
      stats.sales = String(ev.totalSold)
      renderStats()
      break
    case 'roster':
      rosterProducts.clear()
      for (const p of ev.products) rosterProducts.set(p.productId, p)
      renderProductsTable()
      // Only let the 3s roster paint the lot when pin/get has gone quiet — otherwise
      // it clobbers the 700ms source with a snapshot that is up to 3s older.
      if (Date.now() - lastPinRenderAt > PIN_FRESH_MS) renderAuction(ev.pinned)
      stats.sales = String(ev.totalSold)
      renderStats()
      break
    case 'pin':
      // pin/get is the lower-latency current-auction source; capture its server-time anchor
      // for an accurate countdown, and refresh the lot's bid state when it carries a winner.
      if (typeof ev.serverTimeOffsetMs === 'number') serverTimeOffsetMs = ev.serverTimeOffsetMs
      if (ev.current?.winUsername) { renderAuction(ev.current); lastPinRenderAt = Date.now() }
      break
    case 'sales': {
      // ── PRINT FIRST ──────────────────────────────────────────────────────
      // Dispatch labels before any rendering/DB work so a label never waits on
      // UI. printSale is async (IPC) — it fires immediately and the work happens
      // in main; everything below is rendering that can follow.
      // Skip the initial backfill (seed on first poll), then act on genuinely-new sales.
      const maxCreated = ev.recentSales.reduce((m, s) => Math.max(m, s.createdAt), 0)
      let recentForRecap: Sale | undefined
      if (seedMaxCreatedAt === null) {
        seedMaxCreatedAt = maxCreated
      } else {
        // Auto-print every genuinely-new sale (skip the connect-time backlog). Print
        // regardless of payment — label at the win, even if payment later fails. The roster's
        // pinned card does NOT advance per lot, so auction_result newSales is the reliable
        // per-sale signal (verified live: it emits +1 per sale; the pinned stays put).
        const freshSales = ev.newSales.filter((s) => s.createdAt > seedMaxCreatedAt!)
        // Order-data mode drives auto-print here; Live-feed mode prints from the
        // 'won-feed' event instead (see below). Either way de-dup is shared.
        if (printSource === 'order') for (const s of freshSales) autoPrintSale(s)
        recentForRecap = freshSales.find((s) => s.paymentStatus !== 'failed' && Date.now() - s.createdAt < 60000)
        seedMaxCreatedAt = Math.max(seedMaxCreatedAt, maxCreated)
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
      if (!gmvFromWs) stats.gmv = `$${(ev.totalCents / 100).toFixed(2)}`
      renderStats()
      $('feedCount').title = `${ev.totalSales} sales · $${(ev.totalCents / 100).toFixed(0)}`
      $('feedCount').textContent = 'v1.2.7-debug'
      if (recentForRecap) void transcribeSale(recentForRecap) // AI transcript — after print + render
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
  }
})
