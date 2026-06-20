import type { LiveEvent, Sale, BuyerAgg, RosterProduct, ProductRollup, PinnedAuction } from '../core/types'

interface LabelData { itemNumber: string; buyer?: string; productName?: string; price?: string }
declare global {
  interface Window {
    ttLive: { onEvent: (cb: (ev: LiveEvent) => void) => void }
    labelAPI: {
      getPrinters: () => Promise<{ printers: { name: string; displayName: string; isDefault: boolean }[]; saved: string }>
      savePrinter: (name: string) => Promise<boolean>
      print: (labelData: LabelData, printerName: string) => Promise<{ success: boolean; error?: string }>
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
function avatar(url?: string): HTMLImageElement {
  const img = document.createElement('img')
  img.className = 'avatar'
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

let gmvFromWs = false
let sessionName = '—'
let sessionStart: number | undefined // unix seconds
const rosterProducts = new Map<string, RosterProduct>()
let lastByProduct: ProductRollup[] = []
let pinnedEndMs: number | undefined

// ── Session bar (with live-ticking elapsed) ─────────────────────────────────
function fmtClock(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
function elapsedSince(unixSec: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}
function renderSession() {
  const t = sessionStart ? `  ·  started ${fmtClock(sessionStart)}  ·  live ${elapsedSince(sessionStart)}` : ''
  $('session').textContent = `${sessionName}${t}`
}
setInterval(() => { if (sessionStart) renderSession() }, 1000)

// ── Auction countdown ───────────────────────────────────────────────────────
function tickCountdown() {
  const cd = document.getElementById('countdown')
  if (!cd) return
  if (!pinnedEndMs) { cd.textContent = ''; return }
  const left = Math.round((pinnedEndMs - Date.now()) / 1000)
  cd.textContent = left > 0 ? `⏱ ${left}s left` : '⏱ ended'
}
setInterval(tickCountdown, 250)

// ── Renderers ───────────────────────────────────────────────────────────────
function renderFeed(sales: Sale[]) {
  const feed = $('feed')
  feed.replaceChildren()
  if (!sales.length) { feed.appendChild(el('div', 'empty', 'Waiting for sales…')); return }
  for (const s of sales) {
    const row = el('div', 'feed-row' + (s.paymentStatus === 'paid' ? '' : ' ' + s.paymentStatus))
    row.appendChild(avatar(s.buyer.avatarUrl))
    const who = el('div', 'who')
    const name = el('div', 'name')
    name.appendChild(txt(s.buyer.username || s.buyer.handle || '—'))
    if (s.paymentStatus === 'failed') name.appendChild(el('span', 'badge', ' FAILED'))
    else if (s.paymentStatus === 'pending') name.appendChild(el('span', 'badge pending', ' PENDING'))
    who.appendChild(name)
    who.appendChild(el('div', 'item', `${s.skuDesc ? s.skuDesc + ' · ' : ''}${s.productName}`))
    row.appendChild(who)
    row.appendChild(el('div', 'price' + (s.paymentStatus === 'failed' ? ' failed' : ''), s.price.formatted))
    row.appendChild(el('div', 'time', ago(s.createdAt)))
    const pb = el('button', 'printbtn', '🖨') as HTMLButtonElement
    pb.title = 'Print label'
    pb.addEventListener('click', () => printSale(s))
    row.appendChild(pb)
    feed.appendChild(row)
  }
}

function renderTopBuyers(buyers: BuyerAgg[]) {
  const tb = $('topBuyers')
  tb.replaceChildren()
  buyers.slice(0, 8).forEach((b, i) => {
    const tr = document.createElement('tr')
    tr.appendChild(el('td', 'rank', String(i + 1)))
    const td = el('td')
    td.style.display = 'flex'
    td.style.alignItems = 'center'
    td.style.gap = '8px'
    td.appendChild(avatar(b.avatarUrl))
    td.appendChild(txt(b.username || b.handle || '—'))
    tr.appendChild(td)
    tr.appendChild(el('td', 'n', String(b.itemCount)))
    tr.appendChild(el('td', 'n', `$${(b.totalCents / 100).toFixed(2)}`))
    tb.appendChild(tr)
  })
}

// Products table = sale rollup (paid/failed/pending) joined with roster
// (name/stock). Failed here and the Failed-Payments card share one source.
function renderProductsTable() {
  const tbody = $('products')
  tbody.replaceChildren()
  const counts = new Map(lastByProduct.map((p) => [p.productId, p]))
  const ids = rosterProducts.size ? [...rosterProducts.keys()] : [...counts.keys()]
  const rows = ids
    .map((id) => {
      const r = rosterProducts.get(id)
      const c = counts.get(id)
      return {
        name: r?.name ?? c?.productName ?? id,
        sold: c?.paid ?? r?.numSold ?? 0,
        failed: c?.failed ?? 0,
        pending: c?.pending ?? 0,
        stock: r?.stockNum,
      }
    })
    .sort((a, b) => b.sold - a.sold)
  for (const row of rows) {
    const tr = document.createElement('tr')
    const cells = [row.name, String(row.sold), String(row.failed), String(row.pending), row.stock != null ? String(row.stock) : '—']
    cells.forEach((t, i) => {
      const td = el('td', i ? 'n' : undefined, t)
      tr.appendChild(td)
    })
    tbody.appendChild(tr)
  }
}

function renderAuction(p?: PinnedAuction) {
  const box = $('currentAuction')
  box.replaceChildren()
  if (!p || !p.winUsername) {
    pinnedEndMs = undefined
    box.appendChild(el('div', 'empty', 'No active auction'))
    return
  }
  pinnedEndMs = p.expectedEndMs
  box.appendChild(el('div', 'pname', p.productName))
  box.appendChild(el('div', 'bid', p.maxBiddingPrice ?? '—'))
  box.appendChild(el('div', 'meta', `high bidder @${p.winUsername} · ${p.numBids ?? 0} bids`))
  const cd = el('div', 'countdown')
  cd.id = 'countdown'
  box.appendChild(cd)
  tickCountdown()
}

// ── Label printing (mirrors the desktop Live Monitor) ───────────────────────
let selectedPrinter = ''
let autoPrint = false
let lastPrintedNumber: number | null = null
let seedMaxCreatedAt: number | null = null
const printQueue: { label: string; status: 'printing' | 'printed' | 'error' }[] = []

function renderQueue() {
  const q = $('printQueue')
  q.replaceChildren()
  for (const item of printQueue.slice(0, 6)) {
    const icon = item.status === 'printed' ? '✓' : item.status === 'error' ? '✗' : '…'
    q.appendChild(el('span', 'q ' + item.status, `${icon} ${item.label}`))
  }
}

async function printLabel(data: LabelData) {
  if (!selectedPrinter) return
  const entry: { label: string; status: 'printing' | 'printed' | 'error' } = {
    label: `#${data.itemNumber}${data.buyer ? ' ' + data.buyer : ''}`,
    status: 'printing',
  }
  printQueue.unshift(entry)
  if (printQueue.length > 30) printQueue.pop()
  renderQueue()
  try {
    const res = await window.labelAPI.print(data, selectedPrinter)
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
  printLabel({ itemNumber: num, buyer: s.buyer.username || s.buyer.handle, productName: s.productName, price: s.price.formatted })
}

function updatePrintNext() {
  const btn = $('printNext') as HTMLButtonElement
  btn.textContent = lastPrintedNumber !== null ? `Print Next (#${lastPrintedNumber + 1})` : 'Print Next'
  btn.disabled = lastPrintedNumber === null || !selectedPrinter
}

async function setupPrinting() {
  const { printers, saved } = await window.labelAPI.getPrinters()
  console.log(`[render] printers: [${printers.map((p) => p.name).join(', ')}] saved="${saved}"`)
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

  sel.addEventListener('change', () => { selectedPrinter = sel.value; void window.labelAPI.savePrinter(selectedPrinter); updatePrintNext() })
  ;($('autoPrint') as HTMLInputElement).addEventListener('change', (e) => {
    autoPrint = (e.target as HTMLInputElement).checked
    localStorage.setItem('tt-autoprint', autoPrint ? '1' : '0')
  })
  $('printNext').addEventListener('click', () => { if (lastPrintedNumber !== null) void printLabel({ itemNumber: String(lastPrintedNumber + 1) }) })
  $('printCustom').addEventListener('click', () => {
    const v = ($('customNum') as HTMLInputElement).value.replace(/^#/, '').trim()
    if (v) void printLabel({ itemNumber: v })
  })
  $('printRange').addEventListener('click', async () => {
    const from = parseInt(($('rangeFrom') as HTMLInputElement).value, 10)
    const to = parseInt(($('rangeTo') as HTMLInputElement).value, 10)
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to - from > 500) return
    for (let n = from; n <= to; n++) await printLabel({ itemNumber: String(n) })
  })
}
void setupPrinting()

window.ttLive.onEvent((ev: LiveEvent) => {
  switch (ev.kind) {
    case 'status':
      $('status').textContent = `${ev.status}${ev.detail ? ' — ' + ev.detail : ''}`
      $('dot').className = 'dot' + (ev.status === 'connected' ? ' on' : '')
      break
    case 'room':
      $('room').textContent = ev.roomId
      break
    case 'session':
      sessionName = ev.name ?? '—'
      if (ev.startTime) sessionStart = ev.startTime
      renderSession()
      break
    case 'core_stats':
      if (ev.viewers !== undefined) $('viewers').textContent = String(ev.viewers)
      if (ev.gmv) { $('gmv').textContent = ev.gmv.formatted; gmvFromWs = true }
      if (ev.sales !== undefined) $('itemsSold').textContent = String(ev.sales)
      if (ev.gpm) $('gpm').textContent = ev.gpm.formatted
      if (ev.gmvPerHour) $('gmvHr').textContent = ev.gmvPerHour.formatted
      if (ev.impressions !== undefined) $('impr').textContent = ev.impressions.toLocaleString()
      if (ev.productClicks !== undefined) $('clicks').textContent = ev.productClicks.toLocaleString()
      if (ev.avgViewDuration !== undefined) $('avgView').textContent = `${ev.avgViewDuration}s`
      if (ev.enterRoomRate !== undefined) $('enterRate').textContent = `${(ev.enterRoomRate * 100).toFixed(1)}%`
      if (ev.marketCmp !== undefined) {
        const b = $('mktCmp')
        b.textContent = `${ev.marketCmp >= 0 ? '+' : ''}${(ev.marketCmp * 100).toFixed(0)}%`
        b.className = ev.marketCmp >= 0 ? 'up' : 'down'
      }
      break
    case 'roster':
      rosterProducts.clear()
      for (const p of ev.products) rosterProducts.set(p.productId, p)
      renderProductsTable()
      renderAuction(ev.pinned)
      $('itemsSold').textContent = String(ev.totalSold) // REST fallback when no WS
      console.log(`[render] roster: products=${ev.products.length} sold=${ev.totalSold} auction="${$('currentAuction').textContent?.slice(0, 40)}"`)
      break
    case 'sales': {
      lastByProduct = ev.byProduct
      renderProductsTable()
      renderFeed(ev.recentSales)
      renderTopBuyers(ev.topBuyers)
      $('uniqueBuyers').textContent = String(ev.uniqueBuyers)
      $('feedCount').textContent = `${ev.totalSales} sold · $${(ev.totalCents / 100).toFixed(2)}`
      // Failed-Payments card = sum of the per-product failed column (one source).
      $('failed').textContent = String(ev.failedPayments.length)
      if (!gmvFromWs) $('gmv').textContent = `$${(ev.totalCents / 100).toFixed(2)}`
      // Auto-print: skip the initial backfill (seed on the first poll), then
      // print labels for genuinely-new, non-failed sales as they arrive.
      const maxCreated = ev.recentSales.reduce((m, s) => Math.max(m, s.createdAt), 0)
      if (seedMaxCreatedAt === null) {
        seedMaxCreatedAt = maxCreated
      } else if (autoPrint && selectedPrinter) {
        for (const s of ev.newSales) {
          if (s.paymentStatus !== 'failed' && s.createdAt > seedMaxCreatedAt) printSale(s)
        }
        seedMaxCreatedAt = Math.max(seedMaxCreatedAt, maxCreated)
      }
      console.log(`[render] sales: feed=${ev.recentSales.length} buyers=${ev.uniqueBuyers} failed=${ev.failedPayments.length} byProduct=${JSON.stringify(ev.byProduct.map((p) => [p.productName.slice(-6), p.paid, p.failed, p.pending]))}`)
      break
    }
  }
})
