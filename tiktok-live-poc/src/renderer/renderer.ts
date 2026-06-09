import type { LiveEvent } from '../core/types'

declare global {
  interface Window {
    ttLive: { onEvent: (cb: (ev: LiveEvent) => void) => void }
  }
}

const $ = (id: string) => document.getElementById(id)!
let derivedSold = 0
let rosterSold = 0

function addFeed(text: string) {
  const div = document.createElement('div')
  div.className = 'row'
  div.textContent = text
  $('events').prepend(div)
}

function refreshTotals() {
  $('derivedSold').textContent = String(derivedSold)
  $('rosterSold').textContent = String(rosterSold)
  const m = $('match')
  const ok = derivedSold === rosterSold
  m.textContent = ok ? 'match' : `MISMATCH (Δ ${derivedSold - rosterSold})`
  m.className = ok ? 'ok' : 'bad'
}

window.ttLive.onEvent((ev: LiveEvent) => {
  switch (ev.kind) {
    case 'status':
      $('status').textContent = `${ev.status}${ev.detail ? ' — ' + ev.detail : ''}`
      break
    case 'auction_started':
      addFeed(`▶ started: ${ev.product.name} ${ev.price?.formatted ?? ''}`)
      break
    case 'auction_ended':
      addFeed(`⏹ ended: ${ev.product.name} ${ev.price?.formatted ?? ''}`)
      break
    case 'bid':
      addFeed(`· bid ${ev.price.formatted} on ${ev.auctionConfigId}`)
      break
    case 'sale':
      derivedSold += ev.status === 'sold' ? 1 : 0
      addFeed(
        `${ev.status === 'sold' ? '✓ SOLD' : '✗ FAILED'} ${ev.product.name} ${ev.price.formatted} ${ev.buyer ? '@' + ev.buyer.username : ''} [${ev.source}]`,
      )
      refreshTotals()
      break
    case 'state':
      rosterSold = ev.totals.sold
      $('failed').textContent = String(ev.totals.failed)
      $('paymentFailed').textContent = String(ev.totals.paymentFailed)
      $('pinned').textContent = ev.pinnedAuction
        ? `${ev.pinnedAuction.productName} — ${ev.pinnedAuction.maxBidPrice ?? ev.pinnedAuction.formattedStartingBid ?? ''} · ${ev.pinnedAuction.numBids ?? 0} bids · win @${ev.pinnedAuction.winUsername ?? '—'}`
        : '—'
      refreshTotals()
      break
  }
})
