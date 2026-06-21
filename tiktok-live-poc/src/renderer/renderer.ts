import flvjs from 'flv.js'
import type { LiveEvent, Sale, BuyerAgg, RosterProduct, ProductRollup, PinnedAuction, ChatMessage } from '../core/types'
import { computeKpis, filterRows, sortRows, profitCents, marginPct, statusLabel, type LedgerRow, type LedgerFilters, type SortKey } from '../core/ledger'

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
      transcribe: (payload: { audio: Uint8Array; productName?: string }) => Promise<{ text?: string; error?: string }>
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
    ['UNIQUE BUYERS', stats.buyers, '', false],
    ['FAILED', stats.failed, '', stats.failed !== '0'],
    ['GPM', stats.gpm, '', false],
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
      return { name: r?.name ?? c?.productName ?? id, sold: c?.paid ?? r?.numSold ?? 0, failed: c?.failed ?? 0, pending: c?.pending ?? 0, stock: r?.stockNum }
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
function renderAuction(p?: PinnedAuction) {
  if (!p || !p.winUsername) {
    pinnedEndMs = undefined
    $('lotOverlay').style.display = 'none'
    return
  }
  pinnedEndMs = p.expectedEndMs
  $('lotOverlay').style.display = 'flex'
  $('lotName').textContent = p.productName
  $('lotBid').textContent = p.maxBiddingPrice ?? '—'
  $('lotBids').textContent = String(p.numBids ?? 0)
  $('lotBuyer').textContent = '@' + p.winUsername
}

function tickCountdown() {
  const ends = document.getElementById('lotEnds')
  if (!ends) return
  if (!pinnedEndMs) { ends.textContent = '—'; return }
  const left = Math.max(0, Math.round((pinnedEndMs - Date.now()) / 1000))
  ends.textContent = left > 0 ? `${left}s` : 'ended'
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
async function initRecap() {
  try { recapEnabled = (await window.recapAPI?.enabled())?.enabled ?? false } catch { recapEnabled = false }
  const st = document.getElementById('recapStatus')
  if (st) st.textContent = recapEnabled ? 'GEMINI' : 'OFF'
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
  const open = () => document.getElementById('settingsModal')?.classList.remove('hidden')
  document.getElementById('labelSettings')?.addEventListener('click', open)
  document.getElementById('labelSettingsFooter')?.addEventListener('click', open)
  document.getElementById('closeSettings')?.addEventListener('click', () => document.getElementById('settingsModal')?.classList.add('hidden'))
}
setupSettings()
setupFeed()
renderStats()

// ── Order Ledger screen (ported from live-ledger viewmodel) ─────────────────
const costMap: Record<string, number> = (() => { try { return JSON.parse(localStorage.getItem('tt-cost') || '{}') } catch { return {} } })()
const transcriptsByOrder = new Map<string, string>()
let ledgerFilters: LedgerFilters = { q: '', status: '', cost: '' }
let ledgerSort: { key: SortKey; dir: 1 | -1 } = { key: 'date', dir: -1 }
let ledgerExpanded: string | null = null
let currentScreen: 'monitor' | 'ledger' = 'monitor'
const fmtCents = (c: number) => `$${(c / 100).toFixed(2)}`

function ledgerRows(): LedgerRow[] {
  return allSales.map((s) => ({
    ...s,
    costCents: costMap[s.orderId],
    transcript: transcriptsByOrder.has(s.orderId) ? { summary: transcriptsByOrder.get(s.orderId) } : undefined,
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
    localStorage.setItem('tt-cost', JSON.stringify(costMap))
    renderLedger()
  }
  input.addEventListener('blur', commit)
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); else if (e.key === 'Escape') { done = true; renderLedger() } })
}

function ledgerRowEl(r: LedgerRow): HTMLElement {
  const row = el('div', 'ledger-row')
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
  const cost = el('div', 'lc-cost r' + (r.costCents == null ? ' empty' : ''), r.costCents == null ? '—' : fmtCents(r.costCents))
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
  const col = (title: string, kvs: [string, string][]) => {
    const c = el('div')
    c.appendChild(el('h5', undefined, title))
    for (const [k, v] of kvs) { const line = el('div', 'kv'); line.appendChild(el('b', undefined, k + ': ')); line.appendChild(txt(v)); c.appendChild(line) }
    return c
  }
  d.appendChild(col('BUYER', [['Name', r.buyer.username || '—'], ['Handle', '@' + (r.buyer.handle ?? '')], ['Order', r.orderId]]))
  const pc = profitCents(r)
  d.appendChild(col('PRICING', [['Total', r.price.formatted], ['Cost', r.costCents != null ? fmtCents(r.costCents) : '—'], ['Profit', pc != null ? fmtCents(pc) : '—'], ['SKU', r.skuDesc ?? '—']]))
  const tx = el('div')
  tx.appendChild(el('h5', undefined, '✦ GEMINI TRANSCRIPT'))
  tx.appendChild(el('div', 'txbox', r.transcript?.summary ?? '(no transcript — captured live as items sell)'))
  d.appendChild(tx)
  return d
}

function renderLedger() {
  if (currentScreen !== 'ledger') return
  const all = ledgerRows()
  const k = computeKpis(all)
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
  const rows = sortRows(filterRows(all, ledgerFilters), ledgerSort.key, ledgerSort.dir)
  $('ledgerCount').textContent = `${rows.length} of ${all.length} orders`
  const body = $('ledgerRows')
  body.replaceChildren()
  if (!rows.length) {
    const e = el('div', 'mono', 'no orders yet')
    e.style.cssText = 'padding:18px;color:#3a4150;font-size:11px;'
    body.appendChild(e)
    return
  }
  for (const r of rows) {
    body.appendChild(ledgerRowEl(r))
    if (ledgerExpanded === r.orderId) body.appendChild(ledgerDetailEl(r))
  }
}

function showScreen(s: 'monitor' | 'ledger') {
  currentScreen = s
  $('monitorScreen').style.display = s === 'monitor' ? 'flex' : 'none'
  $('ledgerScreen').style.display = s === 'ledger' ? 'flex' : 'none'
  $('navMonitor').classList.toggle('active', s === 'monitor')
  $('navLedger').classList.toggle('active', s === 'ledger')
  if (s === 'ledger') renderLedger()
}

function setupLedger() {
  $('navMonitor').addEventListener('click', () => showScreen('monitor'))
  $('navLedger').addEventListener('click', () => showScreen('ledger'))
  document.getElementById('navSettings2')?.addEventListener('click', () => document.getElementById('settingsModal')?.classList.remove('hidden'))
  ;($('ledgerSearch') as HTMLInputElement).addEventListener('input', (e) => { ledgerFilters = { ...ledgerFilters, q: (e.target as HTMLInputElement).value }; renderLedger() })
  ;($('ledgerStatus') as HTMLSelectElement).addEventListener('change', (e) => { ledgerFilters = { ...ledgerFilters, status: (e.target as HTMLSelectElement).value }; renderLedger() })
  $('ledgerMissingCost').addEventListener('click', () => {
    ledgerFilters = { ...ledgerFilters, cost: ledgerFilters.cost === 'missing' ? '' : 'missing' }
    $('ledgerMissingCost').classList.toggle('on', ledgerFilters.cost === 'missing')
    renderLedger()
  })
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

// ── event loop ──────────────────────────────────────────────────────────────
window.ttLive.onEvent((ev: LiveEvent) => {
  switch (ev.kind) {
    case 'status':
      $('status').textContent = `${ev.status}${ev.detail ? ' — ' + ev.detail : ''}`
      $('dot').style.background = ev.status === 'connected' ? '#36d9a4' : '#5c6473'
      $('dot').style.boxShadow = ev.status === 'connected' ? '0 0 8px #36d9a4' : 'none'
      break
    case 'room':
      $('room').textContent = ev.roomId.slice(-8)
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
      renderAuction(ev.pinned)
      stats.sales = String(ev.totalSold)
      renderStats()
      break
    case 'sales': {
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
      $('feedCount').textContent = `${ev.totalSales} · $${(ev.totalCents / 100).toFixed(0)}`
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
      break
    }
    case 'stream':
      if (!flvPlayer) loadStream(ev.url)
      else lastStreamUrl = ev.url
      break
    case 'chat':
      appendChat(ev.items)
      break
  }
})
