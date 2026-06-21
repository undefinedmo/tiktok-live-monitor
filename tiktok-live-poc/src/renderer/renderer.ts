import flvjs from 'flv.js'
import type { LiveEvent, Sale, BuyerAgg, RosterProduct, ProductRollup, PinnedAuction, ChatMessage } from '../core/types'
import { computeKpis, filterRows, sortRows, profitCents, marginPct, statusLabel, applyCost, toCsv, parseRetailCents, groupForPicklist, type LedgerRow, type LedgerFilters, type LedgerTranscript, type SortKey, type CostApply, type PickGroup } from '../core/ledger'
import { loadShows, upsertShow, listShows, salesForShow, type ShowMeta, type ShowStore } from '../core/shows'

interface LabelData { itemNumber: string; buyer?: string; productName?: string; price?: string; title?: string }
interface LabelTemplate {
  labelSize: '1x1' | '2x1' | '2.25x1.25'
  itemNumber: boolean
  buyer: boolean
  productName: boolean
  price: boolean
  custom: { enabled: boolean; regex: string; flags: string }
}
declare global {
  interface Window {
    ttLive: { onEvent: (cb: (ev: LiveEvent) => void) => void }
    labelAPI: {
      getPrinters: () => Promise<{ printers: { name: string; displayName: string; isDefault: boolean }[]; saved: string }>
      savePrinter: (name: string) => Promise<boolean>
      print: (labelData: LabelData, printerName: string, template: LabelTemplate) => Promise<{ success: boolean; error?: string }>
    }
    recapAPI?: {
      enabled: () => Promise<{ enabled: boolean; model: string }>
      transcribe: (payload: { audio: Uint8Array; productName?: string; structured?: boolean }) => Promise<{ text?: string; fields?: LedgerTranscript; error?: string }>
      transcribeOrders: (items: { orderId: string; productName?: string; placedAtMs?: number }[]) => Promise<{ results: { orderId: string; fields: LedgerTranscript }[]; errors: { orderId: string; error: string }[]; error?: string }>
      onTranscribeProgress: (cb: (p: { done: number; total: number; orderId: string; phase: 'start' | 'done'; ok?: boolean }) => void) => void
    }
    syncAPI?: {
      now: () => Promise<{ ok: boolean; reason?: string; count?: number }>
      connection: () => Promise<{ loggedIn: boolean; hasShow: boolean; polling: boolean }>
      openMonitor: () => Promise<{ ok: boolean }>
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
}
let labelTemplate: LabelTemplate = (() => {
  try { return { ...DEFAULT_TEMPLATE, ...JSON.parse(localStorage.getItem('tt-label-template') || '{}') } } catch { return DEFAULT_TEMPLATE }
})()
const saveTemplate = () => localStorage.setItem('tt-label-template', JSON.stringify(labelTemplate))

// ── state ───────────────────────────────────────────────────────────────────
let sessionStart: number | undefined
let pinnedEndMs: number | undefined
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

// ── per-show persistence + show filter ──────────────────────────────────────
let showStore: ShowStore = loadShows(localStorage.getItem('tt-shows'))
let currentShow: ShowMeta | null = null
let selectedShowId = 'live'

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
function appendChat(items: ChatMessage[]) {
  const list = $('chatList')
  let added = false
  for (const m of items) {
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

// ── top buyer intel ─────────────────────────────────────────────────────────
function renderTopBuyer(buyers: BuyerAgg[]) {
  const top = buyers[0]
  $('topBuyerName').textContent = top ? '@' + (top.handle ?? top.username) : '—'
  $('topBuyerSpend').textContent = top ? `$${(top.totalCents / 100).toFixed(0)}` : '—'
  const bars = $('topBuyerBars')
  bars.replaceChildren()
  const top8 = buyers.slice(0, 8)
  const max = Math.max(1, ...top8.map((b) => b.totalCents))
  top8.reverse().forEach((b) => {
    const bar = el('div')
    bar.style.cssText = `flex:1;height:${Math.max(10, (b.totalCents / max) * 100)}%;border-radius:2px;background:linear-gradient(180deg,#8a78ff,#6b56f0);`
    bars.appendChild(bar)
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
  if (!pinnedEndMs) { ends.textContent = '--'; if (panelEnds) panelEnds.textContent = '--'; return }
  const left = Math.max(0, Math.round((pinnedEndMs - Date.now()) / 1000))
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
  if (!sessionStart) return
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sessionStart))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  $('elapsed').textContent = h ? `${h}h ${m}m` : `${m}m`
}, 1000)

// ── live video (HTTP-FLV via flv.js) ────────────────────────────────────────
let flvPlayer: flvjs.Player | null = null
let lastStreamUrl = ''
function loadStream(url: string) {
  lastStreamUrl = url
  const video = document.getElementById('live') as HTMLVideoElement | null
  if (!video || !flvjs.isSupported()) return
  if (flvPlayer) { try { flvPlayer.destroy() } catch { /* ignore */ } flvPlayer = null }
  flvPlayer = flvjs.createPlayer({ type: 'flv', url, isLive: true, cors: true }, { enableStashBuffer: false })
  flvPlayer.attachMediaElement(video)
  flvPlayer.on(flvjs.Events.ERROR, () => { window.setTimeout(() => loadStream(lastStreamUrl), 2500) })
  video.addEventListener('playing', () => startAudioCapture(), { once: true })
  flvPlayer.load()
  void video.play().catch(() => {})
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
  if (!recapEnabled || transcribing || !window.recapAPI) return
  const clip = await grabClip()
  if (!clip || clip.size < 2000) return
  transcribing = true
  const entry: Recap = { head: `${s.skuDesc ?? ''} · ${s.productName.slice(0, 28)} — @${s.buyer.handle ?? s.buyer.username}`, status: 'transcribing', text: '' }
  recaps.unshift(entry)
  if (recaps.length > 30) recaps.pop()
  renderRecap()
  try {
    const audio = new Uint8Array(await clip.arrayBuffer())
    const res = await window.recapAPI.transcribe({ audio, productName: s.productName })
    entry.status = res.text ? 'done' : 'error'
    entry.text = res.text ?? res.error ?? 'failed'
    if (res.text) { transcriptsByOrder.set(s.orderId, res.text); renderLedger() }
  } catch (e) {
    entry.status = 'error'
    entry.text = (e as Error).message
  }
  transcribing = false
  renderRecap()
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
    saveProductTx()
    renderLedger(); renderProductsTable(); renderPicklist()
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
let lastPrintedNumber: number | null = null
const printQueue: { label: string; status: 'printing' | 'printed' | 'error' }[] = []

function renderQueue() {
  const q = $('printQueue')
  q.replaceChildren()
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
  autoPrint = localStorage.getItem('tt-autoprint') === '1'
  ;($('autoPrint') as HTMLInputElement).checked = autoPrint
  updatePrintNext()
  renderQueue()
  sel.addEventListener('change', () => { selectedPrinter = sel.value; void window.labelAPI.savePrinter(selectedPrinter); updatePrintNext() })
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
    saveTemplate(); preview()
  }
  for (const id of ['setSize', 'setItemNumber', 'setBuyer', 'setProductName', 'setPrice', 'setCustom', 'setRegex', 'setFlags']) {
    document.getElementById(id)?.addEventListener('input', apply)
    document.getElementById(id)?.addEventListener('change', apply)
  }
  preview()
  const open = () => showScreen('settings')
  document.getElementById('labelSettings')?.addEventListener('click', open)
  document.getElementById('labelSettingsFooter')?.addEventListener('click', open)
}
setupSettings()
setupFeed()
renderStats()

// ── Order Ledger screen (ported from live-ledger viewmodel) ─────────────────
const loadJson = <T,>(k: string, fb: T): T => { try { return JSON.parse(localStorage.getItem(k) || '') as T } catch { return fb } }
// order-level overrides win; product/bin-level values cascade to every order of that product
const costMap: Record<string, number> = loadJson('tt-cost', {})
const productCostMap: Record<string, number> = loadJson('tt-product-cost', {}) // productId → cents (template, persists across shows)
const transcriptsByOrder = new Map<string, string>()
const productTx: Record<string, LedgerTranscript> = loadJson('tt-product-tx', {}) // productId → structured AI transcript
const orderTx: Record<string, LedgerTranscript> = loadJson('tt-order-tx', {}) // orderId → per-ITEM structured transcript (from its video receipt)
const saveOrderTx = () => localStorage.setItem('tt-order-tx', JSON.stringify(orderTx))
// Synced order book from Seller-Center order/list (decoupled from the live stream). When present
// it is the Ledger/Picklist source; grouped into "shows" by the live-show tag on each order.
let syncedOrders: Sale[] = loadJson<Sale[]>('tt-orders', [])
const saveSyncedOrders = () => localStorage.setItem('tt-orders', JSON.stringify(syncedOrders))
const SHOW_OF = (s: Sale) => s.liveTag || 'Other orders'
// demo seed — these globals only exist in the static-HTML mock, never in the Electron app
const demoSeed = window as unknown as { __demoProductTx?: Record<string, LedgerTranscript>; __demoProductCost?: Record<string, number> }
if (demoSeed.__demoProductCost) Object.assign(productCostMap, demoSeed.__demoProductCost)
if (demoSeed.__demoProductTx) Object.assign(productTx, demoSeed.__demoProductTx)
let ledgerFilters: LedgerFilters = { q: '', status: '', cost: '', profit: '', min: null, max: null }
let ledgerSort: { key: SortKey; dir: 1 | -1 } = { key: 'date', dir: -1 }
let ledgerExpanded: string | null = null
let currentScreen: 'monitor' | 'ledger' | 'picklist' | 'settings' = 'monitor'
const fmtCents = (c: number) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// bulk-selection + cost state
const selected = new Set<string>()
const transcribingOrders = new Set<string>() // orderIds currently being transcribed (row spinner)
let bulkMode: 'flat' | 'percent' | 'retail' = 'percent'
let bulkWholeProduct = false // when on, cost edits cascade to the whole product/bin
let visibleRows: LedgerRow[] = []
const saveCosts = () => localStorage.setItem('tt-cost', JSON.stringify(costMap))
const saveProductCosts = () => localStorage.setItem('tt-product-cost', JSON.stringify(productCostMap))
const saveProductTx = () => localStorage.setItem('tt-product-tx', JSON.stringify(productTx))

function updateBulkBar() {
  const n = selected.size
  $('ledgerBulk').style.display = n > 0 ? 'flex' : 'none'
  if (n > 0) $('ledgerSelCount').textContent = `${n} selected`
  const all = document.getElementById('ledgerSelectAll') as HTMLInputElement | null
  if (!all) return
  const visIds = visibleRows.map((r) => r.orderId)
  const selVis = visIds.filter((id) => selected.has(id)).length
  all.checked = visIds.length > 0 && selVis === visIds.length
  all.indeterminate = selVis > 0 && selVis < visIds.length
}

function applyBulkCost(apply: CostApply) {
  const rows = ledgerRows()
  const byId = new Map(rows.map((r) => [r.orderId, r]))
  if (bulkWholeProduct) {
    // set a product/bin-level cost for every distinct product among the selection;
    // it cascades to ALL orders of that bin and persists as a template across shows.
    const prods = new Map<string, LedgerRow>()
    for (const id of selected) { const r = byId.get(id); if (r) prods.set(r.productId, r) }
    for (const [pid, sample] of prods) {
      const c = applyCost(sample, apply)
      if (c == null) delete productCostMap[pid]
      else productCostMap[pid] = c
      // drop per-order overrides for this bin so the template shows through uniformly
      for (const r of rows) if (r.productId === pid) delete costMap[r.orderId]
    }
    saveProductCosts()
    saveCosts()
  } else {
    for (const id of selected) {
      const r = byId.get(id)
      if (!r) continue
      const c = applyCost(r, apply)
      if (c == null) delete costMap[id]
      else costMap[id] = c
    }
    saveCosts()
  }
  renderLedger()
}

// the ledger/picklist data source respects the show filter. Synced orders (the real order
// book, decoupled from live) take precedence when present; otherwise fall back to the live
// capture / persisted shows.
function sourceSales(): Sale[] {
  if (syncedOrders.length) {
    if (selectedShowId === 'live' || selectedShowId === 'all') return syncedOrders
    return syncedOrders.filter((s) => SHOW_OF(s) === selectedShowId)
  }
  return selectedShowId === 'live' ? allSales : salesForShow(showStore, selectedShowId)
}

// rebuild the Ledger + Picklist show-pickers; keep the current selection
function refreshShowOptions() {
  const fmtShowDate = (sec?: number) =>
    sec ? new Date(sec * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
  // When we have a synced order book, derive shows from the per-order live-show tag,
  // enriched with date · item-count · duration (like live-ledger's ShowSelect).
  const opts: { value: string; label: string }[] = []
  if (syncedOrders.length) {
    const fmtDur = (ms: number) => { if (ms <= 0) return ''; const m = Math.round(ms / 60000); const h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : `${m}m` }
    const agg = new Map<string, { count: number; minT: number; maxT: number }>()
    for (const s of syncedOrders) {
      const tag = SHOW_OF(s)
      const e = agg.get(tag) ?? { count: 0, minT: Infinity, maxT: -Infinity }
      e.count++; if (s.createdAt < e.minT) e.minT = s.createdAt; if (s.createdAt > e.maxT) e.maxT = s.createdAt
      agg.set(tag, e)
    }
    opts.push({ value: 'all', label: `All orders (${syncedOrders.length})` })
    for (const [tag, e] of [...agg.entries()].sort((a, b) => b[1].maxT - a[1].maxT)) {
      const date = Number.isFinite(e.minT) ? new Date(e.minT).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
      const sub = [date, `${e.count} items`, fmtDur(e.maxT - e.minT)].filter(Boolean).join(' · ')
      opts.push({ value: tag, label: sub ? `${tag} · ${sub}` : tag })
    }
  } else {
    opts.push({ value: 'live', label: 'Live (current)' })
    for (const s of listShows(showStore)) {
      const date = fmtShowDate(s.startTime)
      opts.push({ value: s.id, label: date ? `${s.name} — ${date}` : s.name })
    }
    opts.push({ value: 'all', label: 'All shows' })
  }
  for (const id of ['ledgerShow', 'pickShow']) {
    const sel = document.getElementById(id) as HTMLSelectElement | null
    if (!sel) continue
    sel.replaceChildren()
    for (const o of opts) {
      const opt = document.createElement('option')
      opt.value = o.value
      opt.textContent = o.label
      sel.appendChild(opt)
    }
    if (!opts.some((o) => o.value === selectedShowId)) selectedShowId = opts[0]!.value
    sel.value = selectedShowId
  }
}

function ledgerRows(): LedgerRow[] {
  return sourceSales().map((s) => ({
    ...s,
    // order-level cost overrides the product template
    costCents: costMap[s.orderId] ?? productCostMap[s.productId],
    // per-item transcript wins, then the live order-summary, then the per-bin transcript
    transcript:
      orderTx[s.orderId] ??
      (transcriptsByOrder.has(s.orderId) ? { summary: transcriptsByOrder.get(s.orderId) } : productTx[s.productId]),
  }))
}

function editCost(r: LedgerRow, cell: HTMLElement) {
  const input = document.createElement('input')
  input.className = 'lc-cost-input'
  input.value = r.costCents != null ? (r.costCents / 100).toFixed(2) : ''
  cell.replaceChildren(input)
  input.focus()
  let done = false
  const commit = () => {
    if (done) return
    done = true
    const v = parseFloat(input.value)
    if (Number.isFinite(v) && v >= 0) costMap[r.orderId] = Math.round(v * 100)
    else delete costMap[r.orderId]
    saveCosts()
    renderLedger()
  }
  input.addEventListener('blur', commit)
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); else if (e.key === 'Escape') { done = true; renderLedger() } })
}

function ledgerRowEl(r: LedgerRow): HTMLElement {
  const row = el('div', 'ledger-row' + (transcribingOrders.has(r.orderId) ? ' transcribing' : ''))
  row.dataset.oid = r.orderId
  const check = el('div', 'lc-check')
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = selected.has(r.orderId)
  cb.addEventListener('click', (e) => e.stopPropagation())
  cb.addEventListener('change', () => {
    if (cb.checked) selected.add(r.orderId)
    else selected.delete(r.orderId)
    row.classList.toggle('sel', cb.checked)
    updateBulkBar()
  })
  check.appendChild(cb)
  row.appendChild(check)
  if (cb.checked) row.classList.add('sel')
  row.appendChild(el('div', 'lc-id', '…' + r.orderId.slice(-8)))
  row.appendChild(el('div', 'lc-date', new Date(r.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })))
  const b = el('div', 'lc-buyer')
  b.appendChild(el('div', 'n', r.buyer.username || '—'))
  b.appendChild(el('div', 'h', '@' + (r.buyer.handle ?? '')))
  row.appendChild(b)
  const p = el('div', 'lc-prod')
  p.appendChild(txt(r.productName))
  p.appendChild(el('span', 'v', ` · ${r.skuDesc ?? ''}`))
  row.appendChild(p)
  row.appendChild(el('div', 'lc-total r', r.price.formatted))
  const fromTemplate = costMap[r.orderId] == null && productCostMap[r.productId] != null
  const cost = el('div', 'lc-cost r' + (r.costCents == null ? ' empty' : ''), r.costCents == null ? '—' : fmtCents(r.costCents))
  if (fromTemplate) { cost.classList.add('tmpl'); cost.title = 'Cost from product template — click to override this order' }
  cost.addEventListener('click', (e) => { e.stopPropagation(); editCost(r, cost) })
  row.appendChild(cost)
  const pc = profitCents(r)
  const m = marginPct(r)
  const prof = el('div', 'lc-profit r ' + (pc == null ? 'nul' : pc >= 0 ? 'pos' : 'neg'))
  prof.appendChild(txt(pc == null ? '—' : fmtCents(pc)))
  if (m != null) prof.appendChild(el('span', 'm', `${m.toFixed(0)}%`))
  row.appendChild(prof)
  const lbl = statusLabel(r)
  const pill = el('div', 'statuspill' + (/fail|refund|cancel/i.test(lbl) ? ' bad' : ''), lbl)
  if (r.transcript) pill.appendChild(el('span', 'ai', '✦'))
  row.appendChild(pill)
  row.addEventListener('click', () => { ledgerExpanded = ledgerExpanded === r.orderId ? null : r.orderId; renderLedger() })
  return row
}

function ledgerDetailEl(r: LedgerRow): HTMLElement {
  const d = el('div', 'ledger-detail')
  const dt = r.detail
  const col = (title: string, kvs: [string, string | undefined][]) => {
    const c = el('div')
    c.appendChild(el('h5', undefined, title))
    for (const [k, v] of kvs) {
      if (v == null || v === '') continue
      const line = el('div', 'kv')
      line.appendChild(el('b', undefined, k + ': '))
      line.appendChild(txt(v))
      c.appendChild(line)
    }
    return c
  }
  const date = new Date(r.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

  // 1) BUYER & SHIPPING
  d.appendChild(col('BUYER & SHIPPING', [
    ['Name', r.buyer.username || '—'],
    ['Handle', r.buyer.handle ? '@' + r.buyer.handle : undefined],
    ['Ship to', dt?.address],
    ['Order #', r.orderId],
    ['Created', date],
    ['Status', dt?.status ?? statusLabel(r)],
  ]))

  // 2) ITEMS + FULFILLMENT
  const mid = el('div')
  mid.appendChild(el('h5', undefined, 'ITEMS'))
  const itemList = dt?.items?.length ? dt.items : [{ productName: r.productName, variant: r.skuDesc || undefined, quantity: 1 }]
  for (const it of itemList) {
    mid.appendChild(el('div', 'kv', `${it.quantity}× ${it.productName}${it.variant ? ' · ' + it.variant : ''}`))
  }
  if (dt?.carrier || dt?.tracking) {
    mid.appendChild(el('h5', undefined, 'FULFILLMENT'))
    if (dt.carrier) { const l = el('div', 'kv'); l.appendChild(el('b', undefined, 'Carrier: ')); l.appendChild(txt(dt.carrier)); mid.appendChild(l) }
    if (dt.tracking) { const l = el('div', 'kv'); l.appendChild(el('b', undefined, 'Tracking: ')); l.appendChild(txt(dt.tracking)); mid.appendChild(l) }
  }
  d.appendChild(mid)

  // 3) PRICE BREAKDOWN
  const pc = profitCents(r)
  const m = marginPct(r)
  d.appendChild(col('PRICE BREAKDOWN', [
    ['Subtotal', dt?.subtotalCents ? fmtCents(dt.subtotalCents) : undefined],
    ['Shipping', dt?.shippingCents ? fmtCents(dt.shippingCents) : undefined],
    ['Tax', dt?.taxCents ? fmtCents(dt.taxCents) : undefined],
    ['Total', r.price.formatted],
    ['Cost', r.costCents != null ? fmtCents(r.costCents) : '—'],
    ['Profit', pc != null ? fmtCents(pc) + (m != null ? ` · ${m.toFixed(0)}%` : '') : '—'],
  ]))

  // full-width strip: live-show tag + open-on-TikTok
  if (r.liveTag || dt?.orderUrl) {
    const strip = el('div', 'detail-full detail-strip')
    if (r.liveTag) strip.appendChild(el('span', 'detail-livetag', r.liveTag + (dt?.isAuction ? ' · AUCTION' : '')))
    if (dt?.orderUrl) {
      const a = document.createElement('a')
      a.href = dt.orderUrl; a.target = '_blank'; a.rel = 'noopener'; a.className = 'detail-link'; a.textContent = 'Open on TikTok ↗'
      a.addEventListener('click', (e) => e.stopPropagation())
      strip.appendChild(a)
    }
    d.appendChild(strip)
  }

  // AI PRODUCT DETAILS (full width, editable)
  const t = r.transcript
  const tx = el('div', 'detail-full')
  tx.appendChild(el('h5', undefined, '✦ AI PRODUCT DETAILS'))
  // always show every field (incl. Brand); double-click any value to edit it
  const fields: [keyof LedgerTranscript, string][] = [
    ['brand', 'Brand'], ['item', 'Item'], ['color', 'Color'], ['size', 'Size'], ['retailPrice', 'Retail'],
  ]
  for (const [key, label] of fields) {
    const line = el('div', 'kv')
    line.appendChild(el('b', undefined, label + ': '))
    const v = (t?.[key] as string | undefined) ?? ''
    const span = el('span', 'aival' + (v ? '' : ' empty'), v || '—')
    span.title = 'double-click to edit'
    span.addEventListener('dblclick', (e) => { e.stopPropagation(); editAiField(r, key, span) })
    line.appendChild(span)
    tx.appendChild(line)
  }
  const sum = el('div', 'txbox aival' + (t?.summary ? '' : ' empty'), t?.summary || '(double-click to add a summary)')
  sum.title = 'double-click to edit'
  sum.addEventListener('dblclick', (e) => { e.stopPropagation(); editAiField(r, 'summary', sum, true) })
  tx.appendChild(sum)
  d.appendChild(tx)
  return d
}

// double-click an AI field → edit it; the edit is saved per ORDER (overrides the AI/bin value)
function editAiField(r: LedgerRow, key: keyof LedgerTranscript, node: HTMLElement, multiline = false) {
  const input = document.createElement(multiline ? 'textarea' : 'input') as HTMLInputElement
  input.className = 'ai-edit'
  input.value = (r.transcript?.[key] as string | undefined) ?? ''
  if (multiline) (input as unknown as HTMLTextAreaElement).rows = 3
  node.replaceWith(input)
  input.focus()
  input.select?.()
  let done = false
  const commit = () => {
    if (done) return
    done = true
    const v = input.value.trim()
    const next: LedgerTranscript = { ...(orderTx[r.orderId] ?? r.transcript ?? {}) }
    if (v) next[key] = v
    else delete next[key]
    orderTx[r.orderId] = next
    saveOrderTx()
    renderLedger()
  }
  input.addEventListener('blur', commit)
  input.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent
    if (ke.key === 'Enter' && !(multiline && ke.shiftKey)) { e.preventDefault(); input.blur() }
    else if (ke.key === 'Escape') { done = true; renderLedger() }
  })
}

function renderLedger() {
  if (currentScreen !== 'ledger') return
  const all = ledgerRows()
  // KPIs reflect the active filters/show (the visible set), not the whole book
  const filtered = sortRows(filterRows(all, ledgerFilters), ledgerSort.key, ledgerSort.dir)
  const k = computeKpis(filtered)
  const tiles: [string, string, string?, boolean?][] = [
    ['ORDERS', String(k.orders)],
    ['GROSS', fmtCents(k.grossCents)],
    ['UNITS', String(k.units)],
    ['AVG ORDER', fmtCents(k.avgCents)],
    ['REFUNDS', String(k.refunds), `${k.refundPct.toFixed(0)}%`, k.refunds > 0],
    ['PROFIT', fmtCents(k.profitCents), k.marginPct != null ? `${k.marginPct.toFixed(0)}% margin · ${k.uncosted} uncosted` : `${k.uncosted} uncosted`],
  ]
  const kpiEl = $('ledgerKpis')
  kpiEl.replaceChildren()
  for (const [l, v, sub, red] of tiles) {
    const t = el('div', 'stat')
    t.appendChild(el('div', 'l', l))
    t.appendChild(el('div', 'v' + (red ? ' red' : ''), v))
    if (sub) t.appendChild(el('div', 's', sub))
    kpiEl.appendChild(t)
  }
  const rows = filtered
  visibleRows = rows
  $('ledgerCount').textContent = `${rows.length} of ${all.length} orders`
  const body = $('ledgerRows')
  body.replaceChildren()
  if (!rows.length) {
    const e = el('div', 'mono', all.length ? 'no orders match these filters' : 'no orders yet')
    e.style.cssText = 'padding:18px;color:#3a4150;font-size:11px;'
    body.appendChild(e)
    updateBulkBar()
    return
  }
  for (const r of rows) {
    body.appendChild(ledgerRowEl(r))
    if (ledgerExpanded === r.orderId) body.appendChild(ledgerDetailEl(r))
  }
  updateBulkBar()
}

function showScreen(s: 'monitor' | 'ledger' | 'picklist' | 'settings') {
  currentScreen = s
  $('monitorScreen').style.display = s === 'monitor' ? 'flex' : 'none'
  $('ledgerScreen').style.display = s === 'ledger' ? 'flex' : 'none'
  $('picklistScreen').style.display = s === 'picklist' ? 'flex' : 'none'
  const settings = document.getElementById('settingsScreen')
  if (settings) settings.style.display = s === 'settings' ? 'flex' : 'none'
  $('navMonitor').classList.toggle('active', s === 'monitor')
  $('navLedger').classList.toggle('active', s === 'ledger')
  $('navPicklist').classList.toggle('active', s === 'picklist')
  document.getElementById('navSettings2')?.classList.toggle('active', s === 'settings')
  // live status (connecting…) + room/viewers/elapsed only make sense on the Live Monitor
  const meters = document.getElementById('liveMeters')
  if (meters) meters.style.display = s === 'monitor' ? 'flex' : 'none'
  const livePill = document.getElementById('livePill')
  if (livePill) livePill.style.display = s === 'monitor' ? 'flex' : 'none'
  if (s === 'ledger') renderLedger()
  if (s === 'picklist') renderPicklist()
}

// ── Picklist / packlist screen ──────────────────────────────────────────────
let pickBy: 'show' | 'buyer' = 'show'
const pickedOrders = new Set<string>(loadJson<string[]>('tt-picked', []))
const savePicked = () => localStorage.setItem('tt-picked', JSON.stringify([...pickedOrders]))

function renderPicklist() {
  if (currentScreen !== 'picklist') return
  const groups = groupForPicklist(ledgerRows(), pickBy)
  const host = $('pickGroups')
  host.replaceChildren()
  const totalItems = groups.reduce((n, g) => n + g.units, 0)
  const doneItems = groups.reduce((n, g) => n + g.items.filter((r) => pickedOrders.has(r.orderId)).length, 0)
  $('pickProgress').textContent = `${doneItems}/${totalItems} done`
  $('pickHint').textContent = pickBy === 'show' ? 'grouped by show — check items off' : 'pack one box per buyer'
  if (!groups.length) {
    const e = el('div', 'mono', 'no orders to pick yet')
    e.style.cssText = 'padding:18px;color:#3a4150;font-size:11px;'
    host.appendChild(e)
    return
  }
  for (const g of groups) {
    const card = el('div', 'pick-card')
    const doneN = g.items.filter((r) => pickedOrders.has(r.orderId)).length
    if (doneN === g.units) card.classList.add('complete')
    const head = el('div', 'pick-head')
    head.appendChild(el('div', 'pl', g.label))
    head.appendChild(el('div', 'ps', `${g.units} item${g.units > 1 ? 's' : ''} · ${fmtCents(g.totalCents)}`))
    head.appendChild(el('div', 'pct', `${doneN}/${g.units}`))
    if (selectedPrinter) {
      const pbtn = el('button', 'qbtn void', '⎙ Labels') as HTMLButtonElement
      pbtn.style.marginLeft = '8px'
      pbtn.addEventListener('click', () => { for (const r of g.items) void printSale(r) })
      head.appendChild(pbtn)
    }
    card.appendChild(head)
    for (const r of g.items) {
      const item = el('div', 'pick-item' + (pickedOrders.has(r.orderId) ? ' done' : ''))
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = pickedOrders.has(r.orderId)
      cb.addEventListener('change', () => {
        if (cb.checked) pickedOrders.add(r.orderId)
        else pickedOrders.delete(r.orderId)
        savePicked()
        renderPicklist()
      })
      item.appendChild(cb)
      const name = el('div', 'pi-name')
      name.appendChild(el('span', 'pi-sku', (r.skuDesc ?? '') + ' '))
      // by show → show who bought what; by buyer → show the product
      name.appendChild(txt(pickBy === 'show' ? `${r.buyer.username || r.buyer.handle || '—'} · ${r.productName}` : r.productName))
      if (r.paymentStatus === 'pending') name.appendChild(el('span', 'pi-sku', '  · unpaid'))
      item.appendChild(name)
      item.appendChild(el('div', 'pi-price', r.price.formatted))
      card.appendChild(item)
    }
    host.appendChild(card)
  }
}

// ── "Filter by Show" — keep the Ledger + Picklist pickers in sync ────────────
function onShowChange(value: string) {
  selectedShowId = value
  const lSel = document.getElementById('ledgerShow') as HTMLSelectElement | null
  const pSel = document.getElementById('pickShow') as HTMLSelectElement | null
  if (lSel && lSel.value !== value) lSel.value = value
  if (pSel && pSel.value !== value) pSel.value = value
  renderLedger()
  renderPicklist()
}

function setupShowFilter() {
  refreshShowOptions()
  ;(document.getElementById('ledgerShow') as HTMLSelectElement | null)
    ?.addEventListener('change', (e) => onShowChange((e.target as HTMLSelectElement).value))
  ;(document.getElementById('pickShow') as HTMLSelectElement | null)
    ?.addEventListener('change', (e) => onShowChange((e.target as HTMLSelectElement).value))
}

// ── "Sync orders" + TikTok connection state ──────────────────────────────────
let syncing = false

function flashSync(msg: string) {
  const b = document.getElementById('ledgerSync')
  if (!b) return
  const orig = b.dataset.label ?? b.textContent ?? '↻ Sync'
  b.dataset.label = orig
  b.textContent = msg
  window.setTimeout(() => { b.textContent = b.dataset.label ?? orig }, 2600)
}

// Reflect login/live state on the rail dot (cookie-verified via the persisted session).
async function refreshConnection() {
  if (!window.syncAPI) return
  const dot = document.getElementById('dot')
  if (!dot) return
  try {
    const c = await window.syncAPI.connection()
    let color = '#ff5c5c'
    let title = 'Not logged in to TikTok — click Sync to open the login window'
    if (c.loggedIn && c.hasShow) { color = '#36d9a4'; title = 'Connected · live show' }
    else if (c.loggedIn) { color = '#ffc56b'; title = 'Logged in · waiting for a live show' }
    dot.style.background = color
    dot.style.boxShadow = c.loggedIn && c.hasShow ? '0 0 8px #36d9a4' : 'none'
    dot.title = title
  } catch { /* ignore */ }
}

async function runSync() {
  if (syncing) return
  syncing = true
  const navSync = document.getElementById('navSync')
  navSync?.classList.add('syncing')
  try {
    if (window.syncAPI) {
      const res = await window.syncAPI.now()
      if (res.ok) flashSync(`✓ ${res.count ?? ''} orders`.replace('  ', ' '))
      else { flashSync('⚠ ' + (res.reason ?? 'failed')); console.warn('sync:', res.reason) }
      await refreshConnection()
    } else {
      await new Promise((r) => window.setTimeout(r, 900)) // static demo feedback
      flashSync('✓ Synced')
    }
  } finally {
    navSync?.classList.remove('syncing')
    syncing = false
  }
}

function setupSync() {
  document.getElementById('navSync')?.addEventListener('click', () => void runSync())
  document.getElementById('ledgerSync')?.addEventListener('click', () => void runSync())
  void refreshConnection()
  window.setInterval(() => void refreshConnection(), 12000)
}

function setupPicklist() {
  $('navPicklist').addEventListener('click', () => showScreen('picklist'))
  $('pickBySeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    pickBy = ((b as HTMLElement).dataset.by ?? 'show') as 'show' | 'buyer'
    $('pickBySeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b))
    renderPicklist()
  }))
  $('pickReset').addEventListener('click', () => { pickedOrders.clear(); savePicked(); renderPicklist() })
}

function segActive(segId: string, attr: 'cost' | 'profit', val: string) {
  $(segId).querySelectorAll('button').forEach((b) => b.classList.toggle('on', ((b as HTMLElement).dataset[attr] ?? '') === val))
}

function setupLedger() {
  $('navMonitor').addEventListener('click', () => showScreen('monitor'))
  $('navLedger').addEventListener('click', () => showScreen('ledger'))
  document.getElementById('navSettings2')?.addEventListener('click', () => showScreen('settings'))
  ;($('ledgerSearch') as HTMLInputElement).addEventListener('input', (e) => { ledgerFilters = { ...ledgerFilters, q: (e.target as HTMLInputElement).value }; renderLedger() })
  ;($('ledgerStatus') as HTMLSelectElement).addEventListener('change', (e) => { ledgerFilters = { ...ledgerFilters, status: (e.target as HTMLSelectElement).value }; renderLedger() })

  // cost / profit segmented filters
  $('ledgerCostSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const v = ((b as HTMLElement).dataset.cost ?? '') as LedgerFilters['cost']
    ledgerFilters = { ...ledgerFilters, cost: v }
    segActive('ledgerCostSeg', 'cost', v)
    renderLedger()
  }))
  $('ledgerProfitSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const v = ((b as HTMLElement).dataset.profit ?? '') as NonNullable<LedgerFilters['profit']>
    ledgerFilters = { ...ledgerFilters, profit: v }
    segActive('ledgerProfitSeg', 'profit', v)
    renderLedger()
  }))

  // total min / max
  const numOrNull = (s: string) => { const v = parseFloat(s); return Number.isFinite(v) ? v : null }
  ;($('ledgerMin') as HTMLInputElement).addEventListener('input', (e) => { ledgerFilters = { ...ledgerFilters, min: numOrNull((e.target as HTMLInputElement).value) }; renderLedger() })
  ;($('ledgerMax') as HTMLInputElement).addEventListener('input', (e) => { ledgerFilters = { ...ledgerFilters, max: numOrNull((e.target as HTMLInputElement).value) }; renderLedger() })

  // clear all filters
  $('ledgerClearFilters').addEventListener('click', () => {
    ledgerFilters = { q: '', status: '', cost: '', profit: '', min: null, max: null }
    ;($('ledgerSearch') as HTMLInputElement).value = ''
    ;($('ledgerStatus') as HTMLSelectElement).value = ''
    ;($('ledgerMin') as HTMLInputElement).value = ''
    ;($('ledgerMax') as HTMLInputElement).value = ''
    segActive('ledgerCostSeg', 'cost', '')
    segActive('ledgerProfitSeg', 'profit', '')
    renderLedger()
  })

  // CSV export of the current (filtered + sorted) view
  $('ledgerExport').addEventListener('click', () => {
    const rows = sortRows(filterRows(ledgerRows(), ledgerFilters), ledgerSort.key, ledgerSort.dir)
    if (!rows.length) return
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tiktok-ledger-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  })

  // select-all (applies to the currently visible/filtered rows)
  ;(document.getElementById('ledgerSelectAll') as HTMLInputElement).addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked
    for (const r of visibleRows) { if (on) selected.add(r.orderId); else selected.delete(r.orderId) }
    renderLedger()
  })

  // bulk cost bar
  const setMode = (m: 'flat' | 'percent' | 'retail') => {
    bulkMode = m
    $('bulkModeFlat').classList.toggle('on', m === 'flat')
    $('bulkModePct').classList.toggle('on', m === 'percent')
    $('bulkModeRetail').classList.toggle('on', m === 'retail')
    ;($('bulkCostValue') as HTMLInputElement).placeholder = m === 'flat' ? '$ per order' : m === 'retail' ? '% of retail' : '% of total'
  }
  $('bulkModeFlat').addEventListener('click', () => setMode('flat'))
  $('bulkModePct').addEventListener('click', () => setMode('percent'))
  $('bulkModeRetail').addEventListener('click', () => setMode('retail'))
  $('bulkWhole').addEventListener('click', () => { bulkWholeProduct = !bulkWholeProduct; $('bulkWhole').classList.toggle('on', bulkWholeProduct) })
  $('bulkApply').addEventListener('click', () => {
    const v = parseFloat(($('bulkCostValue') as HTMLInputElement).value)
    if (!Number.isFinite(v) || v < 0) return
    applyBulkCost({ mode: bulkMode, value: v })
  })
  ;($('bulkCostValue') as HTMLInputElement).addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') $('bulkApply').click() })
  document.querySelectorAll('.bulk-preset').forEach((b) => b.addEventListener('click', () => {
    applyBulkCost({ mode: 'percent', value: parseFloat((b as HTMLElement).dataset.pct!) })
  }))
  $('bulkClear').addEventListener('click', () => applyBulkCost({ mode: 'clear', value: 0 }))
  // Transcribe the SELECTED ITEMS individually — each order's own video receipt, not the bin.
  $('bulkTranscribe').addEventListener('click', async () => {
    const btn = $('bulkTranscribe') as HTMLButtonElement
    if (!window.recapAPI?.transcribeOrders) { btn.textContent = '✦ AI off'; return }
    const byId = new Map(ledgerRows().map((r) => [r.orderId, r]))
    const items = [...selected]
      .map((oid) => byId.get(oid))
      .filter((r): r is LedgerRow => !!r)
      .map((r) => ({ orderId: r.orderId, productName: r.productName, placedAtMs: r.createdAt }))
    if (!items.length) return
    const orig = btn.textContent
    btn.disabled = true
    btn.textContent = `✦ Transcribing 0/${items.length}…`
    try {
      const res = await window.recapAPI.transcribeOrders(items)
      if (res.error) { btn.textContent = '⚠ ' + res.error.slice(0, 28) }
      else {
        for (const r of res.results) orderTx[r.orderId] = r.fields
        saveOrderTx()
        renderLedger()
        renderPicklist()
        const fail = res.errors?.length ?? 0
        btn.textContent = `✓ ${res.results.length}${fail ? ` · ${fail} failed` : ''}`
      }
    } catch (e) {
      btn.textContent = '⚠ failed'
      console.warn('transcribe-orders:', e)
    } finally {
      btn.disabled = false
      window.setTimeout(() => { btn.textContent = orig }, 3000)
    }
  })
  $('bulkDeselect').addEventListener('click', () => { selected.clear(); renderLedger() })

  $('ledgerHead').querySelectorAll('span[data-sort]').forEach((sp) =>
    sp.addEventListener('click', () => {
      const key = (sp as HTMLElement).dataset.sort as SortKey
      if (ledgerSort.key === key) ledgerSort.dir = (ledgerSort.dir * -1) as 1 | -1
      else ledgerSort = { key, dir: 1 }
      renderLedger()
    }),
  )
}
setupLedger()
setupPicklist()
setupSync()
setupShowFilter()

// live transcription progress → highlight the row being worked + update the button count
function markRowTx(orderId: string, on: boolean) {
  const row = [...document.querySelectorAll('#ledgerRows .ledger-row')].find((e) => (e as HTMLElement).dataset.oid === orderId)
  row?.classList.toggle('transcribing', on)
}
window.recapAPI?.onTranscribeProgress?.((p) => {
  const btn = document.getElementById('bulkTranscribe')
  if (p.phase === 'start') {
    transcribingOrders.add(p.orderId)
    markRowTx(p.orderId, true)
    if (btn) btn.textContent = `✦ Transcribing ${Math.min(p.done + 1, p.total)}/${p.total}…`
  } else {
    transcribingOrders.delete(p.orderId)
    markRowTx(p.orderId, false)
    if (btn && p.total) btn.textContent = `✦ ${p.done}/${p.total}…`
  }
})

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
      break
    case 'session':
      $('sessionName').textContent = ev.name ?? '—'
      if (ev.startTime) sessionStart = ev.startTime
      if (ev.startTime) $('sessionName').title = `started ${fmtClock(ev.startTime)}`
      currentShow = { id: ev.id ?? 'live', name: ev.name ?? 'Live show', startTime: ev.startTime }
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
      renderAuction(ev.pinned)
      stats.sales = String(ev.totalSold)
      renderStats()
      break
    case 'sales': {
      lastByProduct = ev.byProduct
      renderProductsTable()
      allSales = ev.recentSales
      // persist this show's sales so it can be re-selected in the Ledger/Picklist filter later
      if (currentShow) {
        showStore = upsertShow(showStore, currentShow, ev.recentSales, Date.now())
        localStorage.setItem('tt-shows', JSON.stringify(showStore))
        refreshShowOptions()
      }
      currentTopSet = new Set(ev.topBuyers.slice(0, 5).map((b) => b.ttuid || b.username))
      renderFeed()
      renderTopBuyer(ev.topBuyers)
      stats.buyers = String(ev.uniqueBuyers)
      stats.failed = String(ev.failedPayments.length)
      if (!gmvFromWs) stats.gmv = `$${(ev.totalCents / 100).toFixed(2)}`
      renderStats()
      $('feedCount').title = `${ev.totalSales} sales · $${(ev.totalCents / 100).toFixed(0)}`
      $('feedCount').textContent = 'v1.2.4'
      // Skip the initial backfill (seed on first poll), then act on genuinely-new sales.
      const maxCreated = ev.recentSales.reduce((m, s) => Math.max(m, s.createdAt), 0)
      if (seedMaxCreatedAt === null) {
        seedMaxCreatedAt = maxCreated
      } else {
        const fresh = ev.newSales.filter((s) => s.createdAt > seedMaxCreatedAt! && s.paymentStatus !== 'failed')
        if (autoPrint && selectedPrinter) for (const s of fresh) printSale(s)
        const recent = fresh.find((s) => Date.now() - s.createdAt < 60000)
        if (recent) void transcribeSale(recent) // AI transcript for the latest fresh sale
        seedMaxCreatedAt = Math.max(seedMaxCreatedAt, maxCreated)
      }
      renderLedger()
      renderPicklist()
      break
    }
    case 'stream':
      if (!flvPlayer) loadStream(ev.url)
      else lastStreamUrl = ev.url
      break
    case 'chat':
      appendChat(ev.items)
      break
    case 'orders': {
      // Synced order book (Seller-Center) → the Ledger/Picklist source, independent of live.
      syncedOrders = ev.orders
      saveSyncedOrders()
      if (selectedShowId === 'live') selectedShowId = 'all'
      refreshShowOptions()
      renderLedger()
      renderPicklist()
      break
    }
  }
})
