import type { LiveEvent, Sale, BuyerAgg, RosterProduct, PinnedAuction } from '../core/types'

declare global {
  interface Window {
    ttLive: { onEvent: (cb: (ev: LiveEvent) => void) => void }
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
    td.appendChild(avatar(b.avatarUrl))
    td.style.display = 'flex'
    td.style.alignItems = 'center'
    td.style.gap = '8px'
    td.appendChild(txt(b.username || b.handle || '—'))
    tr.appendChild(td)
    tr.appendChild(el('td', 'n', String(b.itemCount)))
    tr.appendChild(el('td', 'n', `$${(b.totalCents / 100).toFixed(2)}`))
    tb.appendChild(tr)
  })
}

function renderProducts(products: RosterProduct[]) {
  const pt = $('products')
  pt.replaceChildren()
  for (const p of [...products].sort((a, b) => b.numSold - a.numSold)) {
    const tr = document.createElement('tr')
    tr.appendChild(el('td', undefined, p.name))
    tr.appendChild(el('td', 'n', String(p.numSold)))
    tr.appendChild(el('td', 'n', String(p.numFailed)))
    pt.appendChild(tr)
  }
}

function renderAuction(p?: PinnedAuction) {
  const box = $('currentAuction')
  box.replaceChildren()
  if (!p || !p.winUsername) { box.appendChild(el('div', 'empty', 'No active auction')); return }
  box.appendChild(el('div', 'pname', p.productName))
  box.appendChild(el('div', 'bid', p.maxBiddingPrice ?? '—'))
  box.appendChild(el('div', 'meta', `high bidder @${p.winUsername} · ${p.numBids ?? 0} bids`))
  $('topBid').textContent = p.maxBiddingPrice ?? '—'
}

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
      $('session').textContent = `${ev.name ?? '—'}  ·  session ${ev.id ?? '—'}`
      break
    case 'core_stats':
      if (ev.viewers !== undefined) $('viewers').textContent = String(ev.viewers)
      if (ev.gmv) { $('gmv').textContent = ev.gmv.formatted; gmvFromWs = true }
      if (ev.sales !== undefined) $('itemsSold').textContent = String(ev.sales)
      break
    case 'product_stats':
      $('itemsSold').textContent = String(ev.totalSold)
      break
    case 'roster':
      renderProducts(ev.products)
      renderAuction(ev.pinned)
      $('itemsSold').textContent = String(ev.totalSold) // REST fallback when no WS
      // Authoritative payment-failure count (complete; the sale feed is paginated).
      $('failed').textContent = String(ev.paymentFailed)
      console.log(`[render] roster: products=${$('products').childElementCount} itemsSold=${$('itemsSold').textContent} failed=${$('failed').textContent} auction="${$('currentAuction').textContent?.slice(0, 50)}"`)
      break
    case 'sales':
      renderFeed(ev.recentSales)
      renderTopBuyers(ev.topBuyers)
      $('uniqueBuyers').textContent = String(ev.uniqueBuyers)
      $('feedCount').textContent = `${ev.totalSales} sold · $${(ev.totalCents / 100).toFixed(2)}`
      if (!gmvFromWs) $('gmv').textContent = `$${(ev.totalCents / 100).toFixed(2)}` // REST fallback
      console.log(`[render] sales: feed=${$('feed').childElementCount} topBuyers=${$('topBuyers').childElementCount} unique=${$('uniqueBuyers').textContent} gmv=${$('gmv').textContent} failedInWindow=${ev.failedPayments.length}`)
      break
  }
})
