// Replays the real HAR's roster + auction_result responses through the new core
// (parseRoster + AuctionResults) to prove the full Live Monitor state is derived
// from real data. Build: esbuild scripts/replay-monitor.ts --bundle --platform=node
import { readFileSync } from 'node:fs'
import { parseRoster } from '../src/core/roster'
import { AuctionResults } from '../src/core/auctionResults'

const harPath = process.argv[2] || 'C:/Users/hammo/Downloads/shop.tiktok.com-v2.har'
const entries = JSON.parse(readFileSync(harPath, 'utf8')).log?.entries ?? []
const bodyOf = (e: any) => {
  const c = e.response?.content
  if (!c) return ''
  let t = c.text ?? ''
  if (c.encoding === 'base64') { try { t = Buffer.from(t, 'base64').toString('utf8') } catch {} }
  return t
}
const bodies = (sub: string) =>
  entries.filter((e: any) => (e.request?.url ?? '').includes(sub)).map((e: any) => { try { return JSON.parse(bodyOf(e)) } catch { return null } }).filter(Boolean)

const ar = new AuctionResults()
let last: any
for (const b of bodies('auction_result/get')) last = ar.ingest(b, 1000)

let roster: any
for (const b of bodies('added_auction_product/list')) roster = parseRoster(b, 1000)

console.log('=== REST core replay (real HAR) ===\n')
if (roster) {
  console.log('ROSTER:')
  for (const p of roster.products) console.log(`  ${p.name}  sold=${p.numSold} failed=${p.numFailed}`)
  console.log(`  totals: sold ${roster.totalSold}, failed ${roster.totalFailed}, paymentFailed ${roster.paymentFailed}`)
  console.log(`  current auction: ${roster.pinned?.productName} — bid ${roster.pinned?.maxBiddingPrice} by @${roster.pinned?.winUsername} (${roster.pinned?.numBids} bids)\n`)
}
if (last) {
  console.log('SALES:')
  console.log(`  items sold (successful): ${last.totalSales}  ·  GMV $${(last.totalCents / 100).toFixed(2)}`)
  console.log(`  unique buyers: ${last.uniqueBuyers}  ·  failed payments: ${last.failedPayments.length}`)
  console.log('  top buyers:')
  for (const b of last.topBuyers.slice(0, 5)) console.log(`    @${b.handle ?? b.username}  ${b.itemCount} items  $${(b.totalCents / 100).toFixed(2)}`)
  console.log('  newest sales:')
  for (const s of last.recentSales.slice(0, 6)) console.log(`    ${s.buyer.username}  ${s.skuDesc} ${s.productName.slice(0, 28)}  ${s.price.formatted}  ${s.paymentStatus}`)
}
